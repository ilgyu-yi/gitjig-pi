/*
 * Bounded LF-framed Pi RPC reader. A bad stream becomes terminally invalid,
 * but the owner MUST keep reading both OS pipes until process cleanup. This
 * reducer retains no child text in its outcome and never turns an event into
 * a delegate result. Command correlation and result admission belong above it.
 */
export const RPC_MAX_RECORD_BYTES = 262_144;
export const RPC_MAX_STREAM_BYTES = 16_777_216;
export const RPC_MAX_RECORDS = 65_536;

export type RpcFrameState = "reading" | "invalid" | "complete";

export class BoundedRpcJsonl {
	private pending = Buffer.alloc(0);
	private total = 0;
	private count = 0;
	private state: RpcFrameState = "reading";
	private receiving = false;
	// `ignoreBOM: true` keeps a U+FEFF as text instead of silently stripping it,
	// so a BOM-prefixed record — at the stream's start or a later record's —
	// reaches JSON.parse intact and is refused there, never rewritten into a
	// record the child did not send (the precedent runPlatformRead sets).
	private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	private readonly receive: (record: Record<string, unknown>) => void;

	constructor(receive: (record: Record<string, unknown>) => void) {
		this.receive = receive;
	}

	get status(): RpcFrameState {
		return this.state;
	}

	get recordCount(): number {
		return this.count;
	}

	/** Caller keeps draining after invalid; no child bytes escape in the status. */
	push(bytes: Buffer): RpcFrameState {
		// A consumer pushing into the reader that is delivering to it would
		// interleave its bytes with the outer scan's; refuse it, terminally.
		if (this.receiving) return this.invalidate();
		if (this.state !== "reading") return this.state;
		this.total += bytes.length;
		if (this.total > RPC_MAX_STREAM_BYTES) return this.invalidate();
		let start = 0;
		for (let i = 0; i < bytes.length; i++) {
			if (bytes[i] !== 10) continue;
			const segment = bytes.subarray(start, i);
			const length = this.pending.length + segment.length;
			if (length > RPC_MAX_RECORD_BYTES) return this.invalidate();
			const line = Buffer.concat([this.pending, segment], length);
			this.pending = Buffer.alloc(0);
			if (!this.acceptLine(line)) return this.invalidate();
			// The consumer ran in between: whatever it did to this reader is
			// final, so a later record in this same buffer is never delivered.
			if (this.state !== "reading") return this.state;
			start = i + 1;
		}
		const suffix = bytes.subarray(start);
		if (this.pending.length + suffix.length > RPC_MAX_RECORD_BYTES) return this.invalidate();
		if (suffix.length > 0) this.pending = Buffer.concat([this.pending, suffix]);
		return this.state;
	}

	finish(): RpcFrameState {
		if (this.state === "reading") {
			this.state = this.pending.length === 0 ? "complete" : "invalid";
			this.pending = Buffer.alloc(0);
		}
		return this.state;
	}

	private acceptLine(bytes: Buffer): boolean {
		if (this.count >= RPC_MAX_RECORDS) return false;
		const final = bytes.at(-1) === 13 ? bytes.subarray(0, -1) : bytes;
		try {
			const record: unknown = JSON.parse(this.decoder.decode(final));
			if (record === null || typeof record !== "object" || Array.isArray(record)) return false;
			this.count++;
			this.receiving = true;
			try {
				this.receive(record as Record<string, unknown>);
			} finally {
				this.receiving = false;
			}
			return true;
		} catch {
			return false;
		}
	}

	private invalidate(): "invalid" {
		this.state = "invalid";
		this.pending = Buffer.alloc(0);
		return this.state;
	}
}
