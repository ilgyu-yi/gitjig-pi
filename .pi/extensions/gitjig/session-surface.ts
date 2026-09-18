import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MergeMode, ModeSource } from "./modes.ts";

export type TerminalClass = "success" | "failure" | "refusal";

type StatusUI = Pick<ExtensionContext["ui"], "setStatus" | "theme">;

/**
 * The minimal persistent session projection (§5.9). It deliberately does not
 * infer issue, PR, workflow phase, or merge mode without an owning runtime,
 * and it does not copy bind degradation out of its owning advisory surface.
 */
export class SessionSurface {
	private ui: StatusUI | undefined;
	private activeDispatches = 0;
	private lastTerminal: TerminalClass | undefined;
	private mergeMode: MergeMode = "off";
	private mergeSource: ModeSource = "default";

	attach(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
		// A resumed/reloaded session starts with no act owned by this instance.
		this.activeDispatches = 0;
		this.lastTerminal = undefined;
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
			this.ui.setStatus("gitjig-session", `${delegate} · ${mode}`);
		} catch {
			// This is an aid (§5.2): a missing or throwing UI degrades to silence
			// and never changes the dispatch or session-start act it decorates.
		}
	}
}
