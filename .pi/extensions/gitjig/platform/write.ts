/**
 * Bounded, explicit-repository platform mutation seam for lifecycle transitions.
 * Warning-surface roster: EXEMPT — child streams are discarded and this module
 * emits no operator-facing text; callers return their own fixed refusal cause.
 */
import { spawn } from "node:child_process";
import { withoutPlatformRetargetingEnv } from "../dispatch/provision.ts";

const TIMEOUT_MS = 10_000;
const GRACE_MS = 2_000;

/** Success means the bounded child exited zero; no output is admitted. */
export function runPlatformMutation(argv: string[], repoRoot: string): Promise<boolean> {
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
