/**
 * The command-spine registration seam (SPEC §4.8's worked cases on their
 * ruled surfaces). One export in the runtime entry's register* idiom
 * (`registerDispatchTool`/`registerPublishTool`): the entry resolves
 * `repoRoot`/`stateRoot` once and every command surface consumes those
 * seams rather than re-resolving them. Registration is load-legal — every
 * act runs inside a handler.
 *
 * The two rung-1 worked cases register here (`review`, `ship`). The
 * composed `review-round` remains dark until its attested subject exists.
 * The third worked case, `work-on`,
 * answers no-no-yes and homes on the prompt-template
 * surface at `.pi/prompts/work-on.md`, registered by the substrate's own
 * discovery — no call for it belongs in any extension.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReviewCommand } from "./review.ts";
import { registerShipCommand } from "./ship.ts";

export function registerSpineCommands(pi: ExtensionAPI, repoRoot: string, stateRoot: string): void {
	registerReviewCommand(pi, repoRoot, stateRoot);
	registerShipCommand(pi, repoRoot);
}
