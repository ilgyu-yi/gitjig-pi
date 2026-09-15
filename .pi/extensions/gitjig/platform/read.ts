/**
 * Bounded stdout reader for platform CLI queries.
 *
 * Warning-surface roster: EXEMPT — child streams are discarded or returned
 * only to closed parsers; this module emits no warning or operator-facing text.
 */
import { spawn } from "node:child_process";
import { withoutPlatformRetargetingEnv } from "../dispatch/provision.ts";

const PLATFORM_READ_TIMEOUT_MS = 10_000;
const PLATFORM_READ_GRACE_MS = 2_000;
const PLATFORM_READ_MAX_BYTES = 4 * 1024 * 1024;

export interface PlatformReadBounds {
	timeoutMs: number;
	graceMs: number;
	maxBytes: number;
}

function killGroup(child: ReturnType<typeof spawn>): void {
	if (typeof child.pid === "number") {
		try {
			process.kill(-child.pid, "SIGKILL");
			return;
		} catch {
			// Fall through when no detached process group was formed.
		}
	}
	child.kill("SIGKILL");
}

/** Hard-bound the process group and the admitted stdout population. */
export function runPlatformRead(
	argv: string[],
	repoRoot: string,
	bounds: PlatformReadBounds = {
		timeoutMs: PLATFORM_READ_TIMEOUT_MS,
		graceMs: PLATFORM_READ_GRACE_MS,
		maxBytes: PLATFORM_READ_MAX_BYTES,
	},
): Promise<string | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		let terminating = false;
		let output = "";
		let bytes = 0;
		const child = spawn("gh", argv, {
			cwd: repoRoot,
			detached: true,
			env: withoutPlatformRetargetingEnv(process.env),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const settle = (value: string | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(runTimer);
			if (graceTimer !== undefined) clearTimeout(graceTimer);
			child.stdout.destroy();
			child.stderr.destroy();
			child.unref();
			resolve(value);
		};
		const terminate = (): void => {
			if (terminating || settled) return;
			terminating = true;
			killGroup(child);
			graceTimer = setTimeout(() => settle(undefined), bounds.graceMs);
		};
		const runTimer = setTimeout(terminate, bounds.timeoutMs);
		child.on("error", () => settle(undefined));
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > bounds.maxBytes) {
				terminate();
				return;
			}
			output += chunk.toString("utf8");
		});
		child.stderr.resume();
		child.on("exit", (code) => {
			clearTimeout(runTimer);
			if (settled || terminating) return;
			graceTimer = setTimeout(() => settle(code === 0 ? output : undefined), bounds.graceMs);
		});
		child.on("close", (code) => settle(!terminating && code === 0 ? output : undefined));
	});
}
