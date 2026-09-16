/** Shared egress-publish predicate used by the registered tool and review-round. */
import { appendAuditRecord } from "../audit.ts";
import { quoted } from "../quote.ts";
import {
	ghPublishArgv,
	isPublishDestination,
	isPublishRepository,
	kindCarriesTitle,
	type PublishRepository,
	runPublishChild,
	specForKind,
} from "./executor.ts";
import { neutralizeForDestination, neutralizeOperand } from "./neutralize.ts";
import { type MergedScan, mergeScanOutcomes, PatternSourceError, scanBody } from "./scan.ts";

export interface PublishResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

function result(text: string, details: Record<string, unknown>): PublishResult {
	return { content: [{ type: "text", text }], details };
}

export type PublishRequest = { body: string; destination: unknown };

/** The one egress-publish predicate and act, shared by every caller. */
export async function performPublish(
	params: PublishRequest,
	repoRoot: string,
	stateRoot: string,
	repository?: PublishRepository,
): Promise<PublishResult> {
	const record = (action: string, text: string): void => {
		appendAuditRecord(stateRoot, { category: "egress", action, text });
	};
	if (repository !== undefined && !isPublishRepository(repository)) {
		const text = "publish refused: the explicit repository is not admissible";
		record("refuse-repository", text);
		return result(text, { disposition: "refuse-repository" });
	}
	// The destination is the actor's explicit structured target; an
	// inadmissible one refuses content-free, never publishes (§3.3).
	const destination: unknown = params.destination;
	if (!isPublishDestination(destination)) {
		const text = "publish refused: the destination is not an admissible structured target";
		record("refuse-destination", text);
		return result(text, { disposition: "refuse-destination" });
	}

	// The scanned domain is this KIND's own published operands, never
	// whatever the caller happened to pass: a title on a comment kind is
	// dropped by the argv builder and never publishes, so scanning it
	// would refuse a send over text that was never going anywhere.
	const publishedTitle = kindCarriesTitle(destination.kind) ? destination.title : undefined;

	let merged: MergedScan;
	try {
		// Every byte this call publishes is scanned — a create kind's
		// title lands on the same public surface and a secret in it leaks
		// exactly as far. The operands are scanned SEPARATELY, as two call
		// sites of the one predicate (§3.11 forbids a second
		// implementation, not a second call), and combined by the one
		// exported merge rule rather than by logic living here — a rule
		// inside this closure is a rule no arm can bind to.
		merged = mergeScanOutcomes(
			scanBody(params.body),
			publishedTitle === undefined ? undefined : scanBody(publishedTitle),
		);
	} catch (error) {
		// Fail closed on scan machinery (§3.9 egress-publish-patterns):
		// PatternSourceError messages are fixed content-free literals;
		// any other throw is refused on a fixed cause of this module's
		// own — a raw message could embed paths or content.
		const cause = error instanceof PatternSourceError ? error.message : "the scan machinery failed before a verdict";
		const text = `publish refused (fail closed): ${cause}`;
		record("refuse-machinery", text);
		return result(text, { disposition: "refuse-machinery" });
	}

	const scan = merged.scan;
	if (scan.disposition === "refuse-out-of-domain") {
		const text =
			"publish refused: disposition refuse-out-of-domain; " +
			`in ${merged.operands.join(" and ")}; outside the line-and-pattern measurement ` +
			"domain; no pattern was consulted — recompose and call again";
		record("refuse-out-of-domain", text);
		return result(text, { disposition: "refuse-out-of-domain" });
	}

	if (scan.disposition === "refuse-match") {
		// Pattern IDs are format-checked lowercase-hyphen tokens and the
		// locators are numbers, so this composition carries no body byte.
		// Per-operand attribution: a flat locator list cannot say which
		// line belongs to which operand, and a title is always line 1, so
		// a body match on its own first line would otherwise read
		// "lines 1, 1". Every token here is a fixed literal or a
		// format-checked pattern id or a number — no operand byte.
		const located = merged.matches
			.map((m) => `${m.operand} patterns ${m.patternIds.join(", ")} lines ${m.lines.join(", ")}`)
			.join("; ");
		const text =
			"publish refused: disposition refuse-match; " +
			`${located} — ` +
			"respell or remove the located spans and call again";
		record("refuse-match", text);
		return result(text, {
			disposition: "refuse-match",
			operands: merged.operands,
			matches: merged.matches,
			patternIds: scan.patternIds,
			lines: scan.lines,
		});
	}

	// Both published operands cross through the neutralizer: the title
	// carries mentions as readily as the body, and it rides argv where
	// the body rides stdin, so neither can be neutralized by the other's
	// treatment. They take DIFFERENT faces of the one predicate: the body
	// goes through the destination-aware boundary, which admits §1.1's
	// linkage line on a pull request description alone; the title takes
	// the unexempted face, because §1.1 fixes a grammar for a
	// description's first line and for no other field (§3.3, issue #129).
	const neutralizedTitle = publishedTitle === undefined ? undefined : neutralizeOperand(publishedTitle);
	const neutralizedBody = neutralizeForDestination(params.body, destination.kind);
	const sendDestination =
		neutralizedTitle !== undefined ? { ...destination, title: neutralizedTitle.text } : destination;
	// The success shape is this kind's own: only the comment verbs print
	// a comment url, so validating every kind against that shape made a
	// successful create or body edit report outcome-unverified — which
	// invites a retry, and a retried create mints a SECOND public
	// surface (§3.10's output-validity rule, §5.6's direction).
	const spec = specForKind(destination.kind);
	if (spec === undefined) {
		const text = "publish refused: the destination is not an admissible structured target";
		record("refuse-destination", text);
		return result(text, { disposition: "refuse-destination" });
	}
	const outcome = await runPublishChild(
		ghPublishArgv(sendDestination, repository),
		neutralizedBody.text,
		repoRoot,
		spec.successShape,
	);
	if (outcome.outcome === "published") {
		// Neutralization is never silent ON A CONFIRMED PUBLISH (§3.3's
		// reporting rule, whose subject is "the published result"). The
		// scope is stated because it is narrower than "never silent" reads:
		// the `outcome-unverified` branch below carries no count, so a body
		// that was rewritten and may well have reached the platform is
		// reported without one. That is a RESIDUAL, not an oversight —
		// §5.6's direction is toward claiming less where the outcome is
		// unknown — but it is a real gap in the caller's information and it
		// is written here rather than left for a reader to discover.
		//
		// A send that reported success while having removed the effect the
		// caller composed for is an unmeasured allow at this gate's own surface:
		// without this report the loss is discoverable only by reading the
		// published surface afterwards. The report is a COUNT over both
		// operands and never the text it counted (§3.8's refusal-record
		// rule); it is present at zero as well, so a caller can tell a
		// clean send from one this field says nothing about.
		// WRAPS APPLIED, not distinct references — the number says what this
		// module can know. Two grounds make the two differ: a span that was
		// already inert is wrapped again, because telling it from a live one
		// needs a markdown parser this module must not grow; and any narrower
		// pattern matching inside an already-wrapped span draws its own pass,
		// so one URL form carrying a mention AND a GH-N draws three. Both are
		// pinned by arms, and the wording below keeps the report true of the
		// number rather than of an enumeration of the shapes that produce it.
		const neutralized = neutralizedBody.neutralized + (neutralizedTitle?.neutralized ?? 0);
		const note =
			neutralized === 0
				? ""
				: `; ${neutralized} span${neutralized === 1 ? "" : "s"} rewritten to an inert spelling before the send`;
		// The one surface child bytes may cross: the URL validated whole
		// against the comment-URL shape (§3.10's output validity), and
		// escaped on the way out because that shape admits control bytes.
		return result(`published: ${quoted(outcome.url)}${note}`, {
			disposition: "published",
			url: outcome.url,
			neutralized,
		});
	}
	if (outcome.outcome === "outcome-unverified") {
		const text =
			"outcome-unverified: the send left the process and no valid outcome shape arrived on stdout; " +
			"neither publication nor withholding is claimed";
		record("outcome-unverified", text);
		return result(text, { disposition: "outcome-unverified" });
	}
	const text = `publish refused: ${outcome.cause}`;
	record("refuse-delegated", text);
	return result(text, { disposition: "refuse-delegated" });
}
