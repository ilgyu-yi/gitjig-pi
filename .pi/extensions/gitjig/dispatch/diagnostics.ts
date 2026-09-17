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

export function makeDiagnostic(input: DiagnosticInput): DispatcherDiagnostic {
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
	return JSON.stringify(value);
}
