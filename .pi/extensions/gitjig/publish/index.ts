/**
 * The egress publish instrument — the `gitjig_publish` tool (SPEC §3.3
 * "egress publish-boundary semantics"; the class row's tier-1 home;
 * issue #83). Registration only: the factory-legal surface, called from
 * the extension entry at load.
 *
 * Flow per call: destination admission → secret scan → on clean,
 * neutralization → the bounded executor. Every refusal lands exactly one
 * `category:"egress"` audit record and a tool result carrying validity
 * alone — disposition, pattern IDs, line locators — never the matched
 * text and never the body (§3.8's refusal-record rule; §4.9's measured
 * ground: a registered tool's result enters the run's transcript, so a
 * result a composer may relay stays content-free about what the refusal
 * withheld). A scan machinery failure (`PatternSourceError`) refuses
 * fail-closed on its own content-free cause (§3.9
 * `egress-publish-patterns`) — never the out-of-domain disposition, and
 * never a publish. The audit sink itself fails open (§3.9
 * `audit-append`): a refusal stands whether or not its record landed.
 *
 * The published URL crosses onto the result THROUGH `quoted()` (issue
 * #97). It is validated whole against the comment-URL shape, which is
 * anchored at both ends and excludes whitespace from its body class — that
 * closes line-forging outright, and with it the five C0 members JS `\s`
 * covers (tab, LF, VT, FF, CR) and the line/paragraph separators. What it
 * leaves open is the rest of the class: `[^\s]` admits the NON-whitespace
 * C0 controls, DEL and the C1 range, the ESC byte among them, and the
 * value is the `gh` child's own stdout. §3.10 asks for this class's
 * mitigation UNIFORMLY with an empty exemption set, so the surface where
 * a child's bytes reach the operator is escaped on the same terms as the
 * dispatcher's delegate summary rather than left as the one exception.
 * Enumerated in place (§3.11): the escape covers the RESULT TEXT only.
 * The structured `details.url` stays raw, deliberately — it is the
 * machine's copy of the locator, and escaping it would hand a programmatic
 * consumer a string that no longer denotes the comment it names. That
 * boundary is stated on its own terms rather than under the empty-
 * exemption-set clause above, because the raw field rides the SAME result
 * object this header's refusal rule is grounded on: a registered tool's
 * result enters the run's transcript. What the escape buys is that the
 * operator-read text carries no control byte; a renderer that displays
 * `details.url` instead is choosing a surface this module does not
 * escape, and that choice is the renderer's boundary, not this one's.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PUBLISH_DESTINATION_KINDS } from "./executor.ts";
import { performPublish } from "./service.ts";

/** The tool name §3.3's egress row records, verbatim. */
export const PUBLISH_TOOL_NAME = "gitjig_publish";

const PublishParams = Type.Object({
	body: Type.String({ description: "The exact text to publish; scanned and neutralized before any send." }),
	destination: Type.Object({
		kind: Type.Union(PUBLISH_DESTINATION_KINDS.map((kind) => Type.Literal(kind))),
		number: Type.Optional(
			Type.Number({
				description: "The issue or pull request number acted on. Required for the comment and body kinds.",
			}),
		),
		title: Type.Optional(
			Type.String({
				description:
					"The title of the issue or pull request being created. Required for the create kinds, and " +
					"scanned as published text in its own right.",
			}),
		),
	}),
});

export function registerPublishTool(pi: ExtensionAPI, repoRoot: string, stateRoot: string): void {
	pi.registerTool({
		name: PUBLISH_TOOL_NAME,
		label: "Publish",
		description:
			"Publish repository-derived text to the platform: comment on an issue or PR, edit an issue or " +
			"PR body, or create an issue or PR. The body — and, for the create kinds, the title — is scanned " +
			"against the committed secret patterns and refused on a match; relayed mentions and actionable " +
			"references are neutralized to inert spellings before the send.",
		parameters: PublishParams,
		async execute(_toolCallId, params) {
			return performPublish({ body: params.body, destination: params.destination }, repoRoot, stateRoot);
		},
	});
}
