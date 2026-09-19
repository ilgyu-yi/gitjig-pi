/**
 * The command-spine registration seam (SPEC §4.8's worked cases on their
 * ruled surfaces). One export in the runtime entry's register* idiom
 * (`registerDispatchTool`/`registerPublishTool`): the entry resolves
 * `repoRoot`/`stateRoot` once and every command surface consumes those
 * seams rather than re-resolving them. Registration is load-legal — every
 * act runs inside a handler.
 *
 * Six command implementations register here (`authoring-brief`, `review`,
 * `review-round`, `ship`, `land`, `source-split`). The `work-on` case answers no-no-yes and homes on the prompt-template
 * surface at `.pi/prompts/work-on.md`, registered by the substrate's own
 * discovery — no call for it belongs in any extension.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedModes } from "../modes.ts";
import type { SessionSurface } from "../session-surface.ts";
import { registerAuthoringBriefCommand } from "./authoring-brief.ts";
import { registerLandCommand } from "./land.ts";
import { registerReviewCommand } from "./review.ts";
import { registerReviewRoundCommand } from "./review-round.ts";
import { registerShipCommand } from "./ship.ts";
import { registerSourceSplitCommand } from "./source-split.ts";

export function registerSpineCommands(
	pi: ExtensionAPI,
	repoRoot: string,
	stateRoot: string,
	surface: SessionSurface | undefined,
	modes: ResolvedModes,
): void {
	registerAuthoringBriefCommand(pi, repoRoot);
	registerReviewCommand(pi, repoRoot, stateRoot, surface);
	registerReviewRoundCommand(pi, repoRoot, stateRoot, {}, surface);
	registerShipCommand(pi, repoRoot);
	registerLandCommand(pi, repoRoot, modes);
	registerSourceSplitCommand(pi, repoRoot);
}
