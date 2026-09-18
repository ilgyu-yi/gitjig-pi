/**
 * Bounded, explicit-repository platform mutation seam for lifecycle transitions.
 * Warning-surface roster: EXEMPT — child streams are discarded and this module
 * emits no operator-facing text; callers return their own fixed refusal cause.
 */
import { spawn } from "node:child_process";
import { withoutPlatformRetargetingEnv } from "../dispatch/provision.ts";
import { runPlatformRead } from "./read.ts";

const TIMEOUT_MS = 10_000;
const GRACE_MS = 2_000;

/** Bounded output-bearing mutation transport; callers own a closed argv grammar and parse the acknowledgement. */
export function runPlatformMutation(argv: string[], repoRoot: string): Promise<string | undefined> {
	return runPlatformRead(argv, repoRoot);
}

/** Add one lifecycle label through a closed, explicit-host mutation spelling. */
export function addPlatformIssueLabel(
	host: string,
	repository: string,
	issue: number,
	label: string,
	repoRoot: string,
): Promise<boolean> {
	if (
		!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host) ||
		!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
		!Number.isSafeInteger(issue) ||
		issue <= 0 ||
		label !== "awaiting-author"
	)
		return Promise.resolve(false);
	const argv = [
		"api",
		"--hostname",
		host,
		"--method",
		"POST",
		`repos/${repository}/issues/${issue}/labels`,
		"-f",
		`labels[]=${label}`,
	];
	return new Promise((resolve) => {
		let settled = false;
		let terminating = false;
		const child = spawn("gh", argv, {
			cwd: repoRoot,
			detached: true,
			env: withoutPlatformRetargetingEnv(process.env),
			stdio: ["ignore", "ignore", "ignore"],
		});
		let grace: ReturnType<typeof setTimeout> | undefined;
		const finish = (value: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (grace !== undefined) clearTimeout(grace);
			child.unref();
			resolve(value);
		};
		const terminate = (): void => {
			if (settled || terminating) return;
			terminating = true;
			if (typeof child.pid === "number") {
				try {
					process.kill(-child.pid, "SIGTERM");
				} catch {
					child.kill("SIGTERM");
				}
			}
			grace = setTimeout(() => {
				if (typeof child.pid === "number") {
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch {
						child.kill("SIGKILL");
					}
				}
				finish(false);
			}, GRACE_MS);
			grace.unref();
		};
		const timer = setTimeout(terminate, TIMEOUT_MS);
		timer.unref();
		child.once("error", () => finish(false));
		child.once("close", (code) => finish(!terminating && code === 0));
	});
}
