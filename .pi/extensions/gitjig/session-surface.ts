import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MergeMode, ModeSource } from "./modes.ts";

export type TerminalClass = "success" | "failure" | "refusal";

/** One lifecycle state the #347 projection may display; nothing else is projected. */
export type LifecycleState = "awaiting-author" | "blocked" | "handoff";

/** An admitted projection for one explicitly addressed subject (SPEC §5.9). */
export interface LifecycleSegment {
	subject: "issue" | "pull";
	number: number;
	/** The attested PR head's first seven hex digits; null for an Issue. */
	shortHead: string | null;
	states: readonly LifecycleState[];
}

type StatusUI = Pick<ExtensionContext["ui"], "setStatus" | "theme">;

/**
 * The minimal persistent session projection (§5.9). It deliberately does not
 * infer issue, PR, workflow phase, or merge mode without an owning runtime,
 * and it does not copy bind degradation out of its owning advisory surface.
 * The #347 lifecycle segment appears only for a subject an operator act
 * explicitly addressed; with no segment the status text is unchanged.
 */
export class SessionSurface {
	private ui: StatusUI | undefined;
	private activeDispatches = 0;
	private lastTerminal: TerminalClass | undefined;
	private mergeMode: MergeMode = "off";
	private mergeSource: ModeSource = "default";
	private lifecycle: LifecycleSegment | undefined;
	private attachments = 0;

	attach(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
		// A resumed/reloaded session starts with no act owned by this instance.
		this.activeDispatches = 0;
		this.lastTerminal = undefined;
		this.lifecycle = undefined;
		this.attachments += 1;
		this.ui = undefined;
		// Pi's JSON/print implementations are no-ops, but the explicit guard is
		// the aid-direction contract: a headless run never depends on a UI call.
		try {
			if (!ctx.hasUI) return;
			this.ui = ctx.ui;
		} catch {
			// A malformed host UI context is an unavailable aid, never a session
			// dependency. Leave the projection detached and continue startup.
			return;
		}
		this.refresh();
	}

	/** Increments on every attach, so work begun for an earlier session can tell it is stale. */
	get epoch(): number {
		return this.attachments;
	}

	/** Whether a status call can happen at all; a UI-less session makes none. */
	get visible(): boolean {
		return this.ui !== undefined;
	}

	/** Replace (or, with undefined, remove) the one addressed subject's lifecycle segment. */
	setLifecycle(segment: LifecycleSegment | undefined): void {
		this.lifecycle = segment;
		this.refresh();
	}

	setMergeMode(value: MergeMode, source: ModeSource): void {
		this.mergeMode = value;
		this.mergeSource = source;
		this.refresh();
	}

	dispatchStarted(): void {
		this.activeDispatches += 1;
		this.refresh();
	}

	dispatchFinished(terminal: TerminalClass): void {
		this.activeDispatches = Math.max(0, this.activeDispatches - 1);
		this.lastTerminal = terminal;
		this.refresh();
	}

	private refresh(): void {
		if (this.ui === undefined) return;
		try {
			const { theme } = this.ui;
			const delegate =
				this.activeDispatches > 0
					? theme.fg("accent", `delegate active (${this.activeDispatches})`)
					: this.lastTerminal === undefined
						? theme.fg("dim", "delegate idle")
						: theme.fg(
								this.lastTerminal === "success" ? "success" : this.lastTerminal === "refusal" ? "warning" : "error",
								`delegate ${this.lastTerminal}`,
							);
			const mode = theme.fg(
				this.mergeMode === "on" ? "warning" : "dim",
				`merge ${this.mergeMode} (${this.mergeSource})`,
			);
			const lifecycle = this.lifecycle === undefined ? "" : ` · ${lifecycleText(this.lifecycle, theme)}`;
			this.ui.setStatus("gitjig-session", `${delegate} · ${mode}${lifecycle}`);
		} catch {
			// This is an aid (§5.2): a missing or throwing UI degrades to silence
			// and never changes the dispatch or session-start act it decorates.
		}
	}
}

/** Closed rendering: a subject noun, an integer, a hex prefix and fixed state names only. */
function lifecycleText(segment: LifecycleSegment, theme: StatusUI["theme"]): string {
	const subject =
		segment.subject === "issue"
			? `issue #${String(segment.number)}`
			: `PR #${String(segment.number)}@${segment.shortHead ?? ""}`;
	return segment.states.length === 0
		? theme.fg("dim", `${subject} no active lifecycle state`)
		: theme.fg("warning", `${subject} ${segment.states.join(", ")}`);
}
