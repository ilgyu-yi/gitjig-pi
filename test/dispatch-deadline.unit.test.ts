import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DispatchOutcome, RunDispatchOptions } from "../.pi/extensions/gitjig/dispatch/index.ts";
import { createRecoveryAttemptLedger, makeDispatcher } from "../.pi/extensions/gitjig/review/orchestrate.ts";

function outcome(kind: "admitted" | "missing"): DispatchOutcome {
	if (kind === "admitted")
		return {
			disposition: "admitted",
			ok: true,
			summary: "ok",
			compare: "confirmed",
			diagnostic: {
				schemaVersion: 1,
				status: "admitted",
				phase: "compare",
				run: { class: "exited", exitCode: 0, signal: null },
				return: { class: "admitted" },
				compare: { class: "confirmed" },
				durationMs: 1,
				code: "ADMITTED",
				message: "dispatch admitted",
			},
		};
	return {
		disposition: "refused",
		cause: "missing",
		diagnostic: {
			schemaVersion: 1,
			status: "refused",
			phase: "return",
			run: { class: "exited", exitCode: 0, signal: null },
			return: { class: "missing" },
			compare: { class: "not-reached" },
			durationMs: 1,
			code: "RETURN_MISSING",
			message: "dispatch refused: no return file was present after the delegate exited",
		},
	};
}

const options: Omit<RunDispatchOptions, "brief" | "expectedRef"> = {
	callerRepoRoot: "/repo",
	stateRoot: "/state",
	delegateArgv: ["pi"],
	timeoutMs: 600_000,
	operationDeadline: performance.now() + 1_200_000,
};

describe("recovery optional dispatch deadline and attempt ledger", () => {
	it("allocates one global sequence across parallel fresh dispatchers", async () => {
		const ledger = createRecoveryAttemptLedger(performance.now());
		const run = async (): Promise<DispatchOutcome> => outcome("admitted");
		const one = makeDispatcher(options, run, { attemptPolicy: { ledger, beforeRetry: () => true } });
		const two = makeDispatcher(options, run, { attemptPolicy: { ledger, beforeRetry: () => true } });
		const results = await Promise.all([one("one", "a".repeat(40)), two("two", "a".repeat(40))]);
		assert.deepEqual(
			results
				.flatMap((result) => result.attempts)
				.map((event) => event.sequence)
				.sort((a, b) => a - b),
			[1, 2],
		);
	});

	it("spends but does not execute the hidden retry when the absolute guard refuses", async () => {
		const ledger = createRecoveryAttemptLedger(performance.now());
		let calls = 0;
		const dispatch = makeDispatcher(
			options,
			async () => {
				calls += 1;
				return outcome("missing");
			},
			{
				attemptPolicy: { ledger, beforeRetry: () => false },
			},
		);
		const result = await dispatch("brief", "a".repeat(40));
		assert.equal(calls, 1);
		assert.equal(result.retryState, "spent");
		assert.equal(result.attempts.length, 1);
	});

	it("keeps omitted attemptPolicy on the original DispatchOutcome surface", async () => {
		const expected = outcome("admitted");
		const dispatch = makeDispatcher({ ...options, operationDeadline: undefined }, async () => expected);
		assert.equal(await dispatch("brief", "a".repeat(40)), expected);
	});
});
