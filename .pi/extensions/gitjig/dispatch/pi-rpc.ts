/*
 * Pi-only RPC subprocess supervisor. Independent of the generic argv
 * executor: stdin is writable, stdout is protocol (never a raw trace), and
 * stderr is drained without retention. No event or operator input is returned
 * to a caller; an operator-only observer may subscribe to bounded records.
 * The return slot is still admitted by dispatch/admit.ts, not by RPC.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { type DispatchContext, withoutRepoLocatingGitEnv } from "./provision.ts";
import { BoundedRpcJsonl } from "./rpc-jsonl.ts";

export type PiRpcOutcome =
	| "settled"
	| "abort"
	| "timeout"
	| "protocol-invalid"
	| "spawn-failed"
	| "exited"
	| "signaled";
export type PiRpcEvent = Readonly<Record<string, unknown>>;
export interface PiRpcOptions {
	context: DispatchContext;
	/** The trusted scratch-local extension prepared by the caller, not by the clone. */
	extensionPath: string;
	/** Optional caller-owned provider extension, used by hermetic scripted sessions. */
	providerExtensionPath?: string;
	/** Resolved by the caller, not selected by the delegate. */
	piExecutable: string;
	provider: string;
	model: string;
	prompt: string;
	timeoutMs: number;
	signal?: AbortSignal;
	/** An operator-only sink; never pass its records to a model-facing result. */
	onOperatorEvent?: (event: PiRpcEvent) => void;
}
export interface PiRpcSession {
	readonly done: Promise<PiRpcOutcome>;
	/** Numeric process exit remains decision-neutral for final slot admission. */
	readonly exitCode: number | null;
	readonly exitSignal: NodeJS.Signals | null;
	command(type: "steer" | "follow_up", message: string): Promise<boolean>;
	/** Explicit missing-submission continuation, never inferred from agent_settled. */
	prompt(message: string): Promise<boolean>;
	waitForSettle(after: number): Promise<number | undefined>;
	readonly settleCount: number;
	clearQueue(): Promise<boolean>;
	close(): void;
	abort(): void;
	attach(sink: (event: PiRpcEvent) => void): void;
	detach(): void;
}

const STDERR_LIMIT = 8192;
const FLUSH_GRACE_MS = 2000;
const COMMAND_WAIT_MS = 5000;

/**
 * `extensionPath` must be an existing regular file in scratch, not clone data.
 * It returns the resolved spelling, which is what the child is given: this
 * function resolves from the supervisor's own working directory, while the
 * child runs in the clone, so handing on the caller's spelling would let a
 * relative path be checked against one file and loaded from another. A
 * relative spelling is refused outright for the same reason; the parameters
 * here are caller-owned and never delegate-supplied.
 */
function trustedExtension(context: DispatchContext, path: string): string | undefined {
	try {
		if (!isAbsolute(path)) return undefined;
		const scratch = realpathSync(context.scratchRoot);
		const extension = realpathSync(path);
		const inside = relative(scratch, extension);
		const clone = relative(realpathSync(context.treeDir), extension);
		return inside.length > 0 &&
			inside !== ".." &&
			!inside.startsWith(`..${sep}`) &&
			!(clone === "" || (clone !== ".." && !clone.startsWith(`..${sep}`))) &&
			lstatSync(path).isFile()
			? extension
			: undefined;
	} catch {
		return undefined;
	}
}

export function startPiRpc(options: PiRpcOptions): PiRpcSession {
	const extension = trustedExtension(options.context, options.extensionPath);
	const providerExtension =
		options.providerExtensionPath === undefined
			? undefined
			: trustedExtension(options.context, options.providerExtensionPath);
	if (
		extension === undefined ||
		(options.providerExtensionPath !== undefined && providerExtension === undefined) ||
		!Number.isFinite(options.timeoutMs) ||
		options.timeoutMs <= 0 ||
		options.timeoutMs > 2_147_483_647 ||
		options.prompt.length === 0 ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.provider) ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.model)
	)
		throw Error("Pi RPC parameters refused");
	const env = withoutRepoLocatingGitEnv(process.env);
	env.GITJIG_TEST_STATE_ROOT = options.context.stateDir;
	let child: ChildProcessWithoutNullStreams | undefined;
	let observer = options.onOperatorEvent;
	let terminal: PiRpcOutcome | undefined;
	let stopping: PiRpcOutcome | undefined;
	let closed = false;
	let settleCount = 0;
	const settleWaiters = new Set<{ after: number; resolve: (count: number | undefined) => void }>();
	let exited = false;
	let exitedCode: number | null = null;
	let exitedSignal: NodeJS.Signals | null = null;
	let stdoutClosed = false;
	let stderrClosed = false;
	let stderrCount = 0;
	let sequence = 0;
	const pending = new Map<string, { resolve: (value: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let flush: ReturnType<typeof setTimeout> | undefined;
	let escalate: ReturnType<typeof setTimeout> | undefined;
	let finish!: (outcome: PiRpcOutcome) => void;
	const done = new Promise<PiRpcOutcome>((resolve) => {
		finish = resolve;
	});
	const end = (outcome: PiRpcOutcome) => {
		if (terminal !== undefined) return;
		terminal = outcome;
		for (const timer of [timeout, flush, escalate]) if (timer !== undefined) clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.resolve(false);
		}
		pending.clear();
		for (const waiter of settleWaiters) waiter.resolve(undefined);
		settleWaiters.clear();
		observer = undefined;
		try {
			child?.stdin.destroy();
			child?.stdout.destroy();
			child?.stderr.destroy();
			child?.unref();
		} catch {}
		finish(outcome);
	};
	const group = (signal: NodeJS.Signals) => {
		try {
			if (child?.pid !== undefined) process.kill(-child.pid, signal);
		} catch {
			try {
				child?.kill(signal);
			} catch {}
		}
	};
	const stop = (outcome: PiRpcOutcome) => {
		if (terminal !== undefined || stopping !== undefined) return;
		stopping = outcome;
		group(outcome === "abort" ? "SIGTERM" : "SIGKILL");
		escalate = setTimeout(() => group("SIGKILL"), FLUSH_GRACE_MS);
		flush = setTimeout(() => end(outcome), FLUSH_GRACE_MS * 2);
	};
	// A deliberate stop keeps its own cause. Otherwise framing validity is read
	// first: §4.9 refuses malformed OR UNFINISHED framing, and malformed data
	// already refuses as it is read, so an unfinished tail discovered here must
	// reach the same outcome rather than being reported as the signal that
	// truncated it. Only a stream that finished complete can be classified by
	// how the child ended.
	const completed = (): PiRpcOutcome => {
		const valid = parser.finish() === "complete";
		return (
			stopping ??
			(!valid
				? "protocol-invalid"
				: exitedSignal !== null
					? "signaled"
					: exitedCode !== null
						? settleCount > 0
							? "settled"
							: "exited"
						: "protocol-invalid")
		);
	};
	// The first observed numeric/signal exit owns the lifecycle. Later
	// operator aborts during pipe-flush grace cannot replace it.
	const abort = () => {
		if (!exited) stop("abort");
	};
	const write = (type: string, data: Record<string, unknown> = {}): Promise<boolean> => {
		if (
			terminal !== undefined ||
			stopping !== undefined ||
			closed ||
			child === undefined ||
			child.stdin.destroyed ||
			pending.size >= 16 ||
			child.stdin.writableLength > 65_536
		)
			return Promise.resolve(false);
		const id = `rpc-${++sequence}`;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				resolve(false);
			}, COMMAND_WAIT_MS);
			pending.set(id, { resolve, timer });
			try {
				// Node buffers a bounded command while respecting the OS pipe. A command
				// cannot be trusted to be delivered until its correlated response.
				child?.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
			} catch {
				clearTimeout(timer);
				pending.delete(id);
				resolve(false);
			}
		});
	};
	const parser = new BoundedRpcJsonl((record) => {
		if (record.type === "response" && typeof record.id === "string") {
			const request = pending.get(record.id);
			if (request !== undefined) {
				pending.delete(record.id);
				clearTimeout(request.timer);
				request.resolve(record.success === true);
			}
		} else if (record.type === "agent_settled") {
			settleCount++;
			// Settled does not authorize a result or stop the long-lived child.
			for (const waiter of settleWaiters) {
				if (settleCount <= waiter.after) continue;
				settleWaiters.delete(waiter);
				waiter.resolve(settleCount);
			}
		}
		try {
			observer?.(record);
		} catch {
			observer = undefined;
		}
	});
	try {
		child = spawn(
			options.piExecutable,
			[
				"--mode",
				"rpc",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-context-files",
				"--no-approve",
				// The resolved spellings, not the caller's: the child resolves a
				// relative path against the clone, where this gate never looked.
				"--extension",
				extension,
				...(providerExtension === undefined ? [] : ["--extension", providerExtension]),
				"--provider",
				options.provider,
				"--model",
				options.model,
			],
			{ cwd: options.context.treeDir, detached: true, env, stdio: ["pipe", "pipe", "pipe"] },
		);
	} catch {
		end("spawn-failed");
	}
	if (child !== undefined) {
		child.on("error", () => end(stopping ?? "spawn-failed"));
		// A pipe write may succeed synchronously and emit EPIPE later. The
		// listener must be present before the initial prompt or any operator
		// command; an already-closing stdin cannot be used as a result channel.
		child.stdin.on("error", () => {
			const wasClosed = closed;
			closed = true;
			if (!wasClosed && !exited) stop("protocol-invalid");
		});
		child.stdout.on("data", (bytes: Buffer) => {
			if (parser.push(bytes) === "invalid") stop("protocol-invalid");
		});
		child.stdout.on("end", () => {
			stdoutClosed = true;
			if (exited && stderrClosed) end(completed());
		});
		child.stderr.on("data", (bytes: Buffer) => {
			stderrCount = Math.min(STDERR_LIMIT, stderrCount + bytes.length);
		});
		child.stderr.on("end", () => {
			stderrClosed = true;
			if (exited && stdoutClosed) end(completed());
		});
		child.on("exit", (code, signal) => {
			exited = true;
			exitedCode = code;
			exitedSignal = signal;
			// A bound governs the child's run, not descendants holding a pipe.
			// Only the finite stream grace remains after an observed exit.
			if (stopping === undefined) {
				if (timeout !== undefined) clearTimeout(timeout);
				timeout = undefined;
				options.signal?.removeEventListener("abort", abort);
			}
			group("SIGKILL");
			if (stdoutClosed && stderrClosed) end(completed());
			else flush ??= setTimeout(() => end(completed()), FLUSH_GRACE_MS);
		});
		options.signal?.addEventListener("abort", abort, { once: true });
		timeout = setTimeout(() => {
			if (!exited) stop("timeout");
		}, options.timeoutMs);
		if (options.signal?.aborted) abort();
		else
			void write("prompt", { message: options.prompt }).then((accepted) => {
				if (!accepted) stop("protocol-invalid");
			});
	}
	return {
		done,
		get exitCode() {
			return exitedCode;
		},
		get exitSignal() {
			return exitedSignal;
		},
		get settleCount() {
			return settleCount;
		},
		waitForSettle: (after) =>
			settleCount > after
				? Promise.resolve(settleCount)
				: terminal !== undefined
					? Promise.resolve(undefined)
					: new Promise((resolve) => {
							settleWaiters.add({ after, resolve });
						}),
		prompt: (message) =>
			typeof message === "string" && message.length > 0 && message.length <= 8192
				? write("prompt", { message })
				: Promise.resolve(false),
		command: (type, message) =>
			typeof message === "string" && message.length > 0 && message.length <= 8192
				? write(type, { message })
				: Promise.resolve(false),
		clearQueue: () => write("clear_queue"),
		close: () => {
			if (terminal !== undefined || closed) return;
			// Closing wins against any later operator command; do not queue a
			// write on a half-closed stdin and call its failure a delivered steer.
			closed = true;
			child?.stdin.end();
		},
		abort,
		attach: (sink) => {
			if (terminal === undefined) observer = sink;
		},
		detach: () => {
			observer = undefined;
		},
	};
}
