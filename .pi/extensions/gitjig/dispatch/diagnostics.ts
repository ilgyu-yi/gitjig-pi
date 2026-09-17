/** Warning-surface roster: EXEMPT — fixed dispatcher-owned literals and typed constructors compose no actor-influenced warning text. */
export const DIAGNOSTIC_MESSAGES = {
	PARAMETER_REFUSED: "dispatch refused: dispatcher parameters were invalid; nothing started",
	PROVISION_FAILED: "dispatch refused: the isolated execution context could not be provisioned; nothing started",
	SPAWN_FAILED: "dispatch refused: the delegate could not be started; no return was inspected",
	SIGNAL_TERMINATED: "dispatch refused: the delegate terminated by signal; no return was inspected",
	TIMED_OUT: "dispatch refused: the delegate exceeded its run bound; no return was inspected",
	ABORTED: "dispatch refused: the delegate run was aborted; no return was inspected",
	RETURN_MISSING: "dispatch refused: no return file was present after the delegate exited",
	RETURN_NOT_REGULAR: "dispatch refused: the return slot was not a regular file",
	RETURN_OVERSIZE: "dispatch refused: the return exceeded the 65536-byte bound",
	RETURN_UNREADABLE: "dispatch refused: the return could not be read exactly",
	RETURN_JSON_INVALID: "dispatch refused: the return was not valid UTF-8 JSON",
	RETURN_SCHEMA_INVALID: "dispatch refused: the return did not match the closed schema",
	RETURN_OPERAND_REJECTED: "dispatch refused: the return named a caller-held operand",
	INTERNAL_FAILED: "dispatch refused: the dispatcher encountered an internal failure",
	ADMITTED: "dispatch admitted",
} as const;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_MESSAGES;
export type DiagnosticPhase = "preflight" | "provision" | "spawn" | "run" | "return" | "compare" | "serialize";
export type RunClass = "not-started" | "exited" | "signaled" | "timed-out" | "aborted" | "internal-failed";
export type ReturnClass =
	| "not-inspected"
	| "missing"
	| "not-regular"
	| "oversize"
	| "unreadable"
	| "json-invalid"
	| "schema-invalid"
	| "operand-rejected"
	| "admitted";
export type CompareClass = "not-reached" | "not-requested" | "confirmed" | "invalid";

export interface DispatcherDiagnostic {
	schemaVersion: 1;
	status: "admitted" | "refused";
	phase: DiagnosticPhase;
	run: { class: RunClass; exitCode: number | null; signal: string | null };
	return: { class: ReturnClass };
	compare: { class: CompareClass };
	durationMs: number;
	code: DiagnosticCode;
	message: (typeof DIAGNOSTIC_MESSAGES)[DiagnosticCode];
}

export interface DiagnosticInput {
	status: "admitted" | "refused";
	phase: DiagnosticPhase;
	run: DispatcherDiagnostic["run"];
	return: DispatcherDiagnostic["return"];
	compare: DispatcherDiagnostic["compare"];
	durationMs: number;
	code: DiagnosticCode;
}

function boundedDuration(value: number): number {
	if (!Number.isFinite(value) || value < 0) return 0;
	return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function coherent(input: DiagnosticInput): boolean {
	const admitted = input.code === "ADMITTED";
	if ((input.status === "admitted") !== admitted) return false;
	if (input.run.class === "exited") {
		if (
			input.run.exitCode === null ||
			!Number.isInteger(input.run.exitCode) ||
			input.run.exitCode < -2_147_483_648 ||
			input.run.exitCode > 2_147_483_647 ||
			input.run.signal !== null
		)
			return false;
	} else if (input.run.class === "signaled") {
		if (input.run.exitCode !== null || input.run.signal === null || !/^SIG[A-Z0-9]{1,12}$/.test(input.run.signal))
			return false;
	} else if (input.run.exitCode !== null || input.run.signal !== null) return false;
	if (input.return.class !== "admitted" && input.compare.class !== "not-reached") return false;
	if (input.compare.class === "not-requested" && input.return.class !== "admitted") return false;
	if (
		(input.compare.class === "confirmed" || input.compare.class === "invalid") &&
		input.phase !== "compare" &&
		!(input.code === "INTERNAL_FAILED" && input.phase === "serialize")
	)
		return false;
	const ordinary: Partial<Record<DiagnosticCode, readonly [DiagnosticPhase, RunClass, ReturnClass]>> = {
		PARAMETER_REFUSED: ["preflight", "not-started", "not-inspected"],
		PROVISION_FAILED: ["provision", "not-started", "not-inspected"],
		SPAWN_FAILED: ["spawn", "not-started", "not-inspected"],
		SIGNAL_TERMINATED: ["run", "signaled", "not-inspected"],
		TIMED_OUT: ["run", "timed-out", "not-inspected"],
		ABORTED: ["run", "aborted", "not-inspected"],
		RETURN_MISSING: ["return", "exited", "missing"],
		RETURN_NOT_REGULAR: ["return", "exited", "not-regular"],
		RETURN_OVERSIZE: ["return", "exited", "oversize"],
		RETURN_UNREADABLE: ["return", "exited", "unreadable"],
		RETURN_JSON_INVALID: ["return", "exited", "json-invalid"],
		RETURN_SCHEMA_INVALID: ["return", "exited", "schema-invalid"],
		RETURN_OPERAND_REJECTED: ["return", "exited", "operand-rejected"],
	};
	const expected = ordinary[input.code];
	if (expected !== undefined)
		return input.phase === expected[0] && input.run.class === expected[1] && input.return.class === expected[2];
	if (input.code === "ADMITTED")
		return (
			input.run.class === "exited" &&
			input.return.class === "admitted" &&
			(input.compare.class === "not-requested" ? input.phase === "return" : input.phase === "compare")
		);
	return input.code === "INTERNAL_FAILED" && input.status === "refused";
}

function internalDiagnostic(durationMs: number): DispatcherDiagnostic {
	return {
		schemaVersion: 1,
		status: "refused",
		phase: "serialize",
		run: { class: "internal-failed", exitCode: null, signal: null },
		return: { class: "not-inspected" },
		compare: { class: "not-reached" },
		durationMs: boundedDuration(durationMs),
		code: "INTERNAL_FAILED",
		message: DIAGNOSTIC_MESSAGES.INTERNAL_FAILED,
	};
}

export function makeDiagnostic(input: DiagnosticInput): DispatcherDiagnostic {
	if (!coherent(input)) return internalDiagnostic(input.durationMs);
	return {
		schemaVersion: 1,
		status: input.status,
		phase: input.phase,
		run: { class: input.run.class, exitCode: input.run.exitCode, signal: input.run.signal },
		return: { class: input.return.class },
		compare: { class: input.compare.class },
		durationMs: boundedDuration(input.durationMs),
		code: input.code,
		message: DIAGNOSTIC_MESSAGES[input.code],
	};
}

export function serializeDiagnostic(value: DispatcherDiagnostic): string {
	const serialized = JSON.stringify(value);
	if (Buffer.byteLength(serialized, "utf8") <= 1_536) return serialized;
	return JSON.stringify(internalDiagnostic(value.durationMs));
}
