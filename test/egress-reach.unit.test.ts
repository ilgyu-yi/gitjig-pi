/**
 * Egress reach — every publication kind goes through the one gate
 * (issue #120; SPEC §3.3's `egress` row, §3.11's predicate-ownership rule).
 *
 * The gate's destination union covered COMMENTS only, while the shell also
 * creates issues, creates pull requests, and edits both their bodies. Those
 * are the same guarded act — repository-derived text reaching a public,
 * unretractable surface — and they had no reach, so they published
 * unscanned. §3.3 homes this class at tier 1 with `backstop: none
 * (structurally unavailable)`, so nothing catches what the home misses.
 *
 * Subject under test: the destination admission predicate and the argv
 * spelling, driven directly. The end-to-end registration path is the
 * sibling integration suite's; this one exists so every KIND is exercised
 * against the admission and argv rules rather than one kind being exercised
 * and the rest inferred from it.
 *
 * The population is enumerated from the exported kind list rather than
 * written out here, so a kind added tomorrow is scored the day it lands and
 * cannot be added without an argv spelling and an admission rule.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ghPublishArgv,
	isPublishDestination,
	kindCarriesTitle,
	PUBLISH_DESTINATION_KINDS,
	type PublishDestination,
	specForKind,
} from "../.pi/extensions/gitjig/publish/executor.ts";

/** A minimal admissible destination for each kind — the population, derived. */
function sampleFor(kind: string): Record<string, unknown> {
	if (kind === "issue-create" || kind === "pr-create") {
		return { kind, title: "a title" };
	}
	return { kind, number: 7 };
}

describe("every publication kind is reachable by the gate (issue #120)", () => {
	it("the kind list covers creation and body edits, not comments alone", () => {
		assert.deepEqual(
			[...PUBLISH_DESTINATION_KINDS].sort(),
			["issue-body", "issue-comment", "issue-create", "pr-body", "pr-comment", "pr-create"].sort(),
		);
	});

	it("every kind in the list is admitted with its own required fields", () => {
		for (const kind of PUBLISH_DESTINATION_KINDS) {
			assert.ok(
				isPublishDestination(sampleFor(kind)),
				`${kind} is in the kind list but its own sample is not admissible — a kind with no admission rule publishes nothing or publishes unchecked`,
			);
		}
	});

	it("every kind in the list has an argv spelling that names its surface and reads the body from stdin", () => {
		for (const kind of PUBLISH_DESTINATION_KINDS) {
			const argv = ghPublishArgv(sampleFor(kind) as unknown as PublishDestination);
			assert.ok(argv.length > 0, `${kind} produced no argv`);
			assert.ok(
				argv[0] === "issue" || argv[0] === "pr",
				`${kind}: argv does not name a gh surface: ${JSON.stringify(argv)}`,
			);
			assert.deepEqual(
				argv.slice(-2),
				["--body-file", "-"],
				`${kind}: the body must reach gh on stdin, never as an argument — an argv-borne body is visible in the process table and can exceed the argument limit: ${JSON.stringify(argv)}`,
			);
		}
	});

	it("each kind's argv names its own ACT, not merely its own surface", () => {
		// The axis the arm above holds fixed. Checking the surface and the
		// `--body-file -` tail leaves the VERB unpinned, and the verb is the
		// act: a body-edit spelling `comment` posts a comment instead of
		// editing the body — a different publication, silently. A mutant
		// that made every numbered kind spell `comment` survived until this
		// arm existed.
		assert.deepEqual(ghPublishArgv({ kind: "issue-comment", number: 7 }), [
			"issue",
			"comment",
			"7",
			"--body-file",
			"-",
		]);
		assert.deepEqual(ghPublishArgv({ kind: "pr-comment", number: 7 }), ["pr", "comment", "7", "--body-file", "-"]);
		assert.deepEqual(ghPublishArgv({ kind: "issue-body", number: 7 }), ["issue", "edit", "7", "--body-file", "-"]);
		assert.deepEqual(ghPublishArgv({ kind: "pr-body", number: 7 }), ["pr", "edit", "7", "--body-file", "-"]);
		assert.deepEqual(ghPublishArgv({ kind: "issue-create", title: "t" }), [
			"issue",
			"create",
			"--title",
			"t",
			"--body-file",
			"-",
		]);
		assert.deepEqual(ghPublishArgv({ kind: "pr-create", title: "t" }), [
			"pr",
			"create",
			"--title",
			"t",
			"--body-file",
			"-",
		]);
	});

	it("every kind's argv is distinct — no two kinds perform the same act", () => {
		// A weaker, population-derived companion to the pinned table above:
		// if two kinds ever produced the same argv, one of them would be
		// publishing somewhere the actor did not name.
		const spellings = PUBLISH_DESTINATION_KINDS.map((kind) =>
			JSON.stringify(ghPublishArgv(sampleFor(kind) as unknown as PublishDestination)),
		);
		assert.equal(new Set(spellings).size, spellings.length, `two kinds share an argv: ${spellings.join(" | ")}`);
	});

	it("a create kind carries its title in the argv, since the title is published text too", () => {
		for (const kind of ["issue-create", "pr-create"]) {
			const argv = ghPublishArgv({ kind, title: "zqtitlezq" } as unknown as PublishDestination);
			assert.ok(argv.includes("--title"), `${kind}: no --title in ${JSON.stringify(argv)}`);
			assert.ok(argv.includes("zqtitlezq"), `${kind}: the title did not reach the argv`);
		}
	});
});

describe("success is recognized for every kind, not just the comment kinds (issue #120)", () => {
	// Review round 1, finding 1. Widening the INPUT union without widening
	// the OUTPUT contract left four of six kinds unable to report success:
	// only the comment verbs print a comment url, and every kind was
	// validated against that one shape. A successful create then reported
	// outcome-unverified — "neither publication nor withholding is claimed"
	// — which invites a retry, and a retried create mints a SECOND public
	// issue or pull request. That is the unretractable-publication hazard
	// this gate exists to prevent, arriving through the outcome path.
	//
	// These arms drive the shape predicate directly rather than spawning a
	// child: the property is which output each kind ACCEPTS as success.
	const COMMENT_URL = "https://github.com/o/r/issues/5#issuecomment-123456";
	const ISSUE_URL = "https://github.com/o/r/issues/5";
	const PR_URL = "https://github.com/o/r/pull/5";

	it("every kind accepts the url its own gh verb actually prints", () => {
		const printed: Record<string, string> = {
			"issue-comment": COMMENT_URL,
			"pr-comment": COMMENT_URL,
			"issue-body": ISSUE_URL,
			"pr-body": PR_URL,
			"issue-create": ISSUE_URL,
			"pr-create": PR_URL,
		};
		for (const kind of PUBLISH_DESTINATION_KINDS) {
			const spec = specForKind(kind);
			assert.ok(spec !== undefined, `${kind} has no spec`);
			assert.ok(
				spec.successShape.test(printed[kind]),
				`${kind}: a SUCCESSFUL run's own output is not recognized as success, so the actor is told neither ` +
					`publication nor withholding and has every reason to retry: ${printed[kind]}`,
			);
		}
	});

	it("a comment kind does not accept a bare surface url as success", () => {
		// The widening must not become a loosening: a comment that printed an
		// issue url did not land where the actor asked.
		for (const kind of ["issue-comment", "pr-comment"]) {
			assert.equal(specForKind(kind)?.successShape.test(ISSUE_URL), false, `${kind} accepted a bare issue url`);
		}
	});

	it("no kind accepts junk, an empty line, or a url-shaped prefix with trailing content", () => {
		for (const kind of PUBLISH_DESTINATION_KINDS) {
			const shape = specForKind(kind)?.successShape;
			assert.ok(shape !== undefined);
			for (const junk of ["", "ok", "error: something", `${ISSUE_URL} and more`, `x ${COMMENT_URL}`]) {
				assert.equal(shape.test(junk), false, `${kind} accepted junk as success: ${JSON.stringify(junk)}`);
			}
		}
	});
});

describe("the scanned domain is the kind's own published operands (issue #120)", () => {
	it("only the create kinds carry a title", () => {
		for (const kind of PUBLISH_DESTINATION_KINDS) {
			assert.equal(
				kindCarriesTitle(kind),
				kind.endsWith("-create"),
				`${kind}: a title is scanned for a kind that never sends one, or not scanned for one that does`,
			);
		}
	});

	it("an unmapped kind has no spec and no argv", () => {
		// The argv builder must stay NON-total: a future `issue-close` that
		// fell through to the `comment` verb would silently post a comment.
		assert.equal(specForKind("issue-close"), undefined);
		assert.throws(() => ghPublishArgv({ kind: "issue-close", number: 1 } as unknown as PublishDestination));
	});
});

describe("admission refuses what it cannot vouch for (issue #120, §3.3)", () => {
	it("refuses an unknown kind", () => {
		assert.equal(isPublishDestination({ kind: "issue-delete", number: 1 }), false);
		assert.equal(isPublishDestination({ kind: "release-create", title: "x" }), false);
	});

	it("refuses a numbered kind with no usable number", () => {
		for (const kind of ["issue-comment", "pr-comment", "issue-body", "pr-body"]) {
			assert.equal(isPublishDestination({ kind }), false, `${kind} admitted with no number`);
			assert.equal(isPublishDestination({ kind, number: 0 }), false, `${kind} admitted number 0`);
			assert.equal(isPublishDestination({ kind, number: -3 }), false, `${kind} admitted a negative number`);
			assert.equal(isPublishDestination({ kind, number: 1.5 }), false, `${kind} admitted a non-integer`);
		}
	});

	it("refuses a create kind with no usable title", () => {
		for (const kind of ["issue-create", "pr-create"]) {
			assert.equal(isPublishDestination({ kind }), false, `${kind} admitted with no title`);
			assert.equal(isPublishDestination({ kind, title: "" }), false, `${kind} admitted an empty title`);
			assert.equal(isPublishDestination({ kind, title: "   " }), false, `${kind} admitted a blank title`);
			assert.equal(isPublishDestination({ kind, title: 5 }), false, `${kind} admitted a non-string title`);
		}
	});

	it("refuses a title that could be read as an option rather than a value", () => {
		// The title reaches gh in ARGUMENT position, unlike the body. A title
		// beginning with `-` would be parsed as a flag; refusing is the safe
		// direction and costs a title spelling nobody needs.
		for (const kind of ["issue-create", "pr-create"]) {
			assert.equal(isPublishDestination({ kind, title: "--repo" }), false, `${kind} admitted an option-shaped title`);
			assert.equal(isPublishDestination({ kind, title: "-x" }), false, `${kind} admitted a dash-leading title`);
		}
	});

	it("refuses a title carrying a newline or a NUL", () => {
		// A newline in argument position is not a shell hazard here (there is
		// no shell), but a multi-line title is not a title, and a NUL cannot
		// cross the exec boundary intact.
		for (const bad of ["a\nb", "a\0b"]) {
			assert.equal(isPublishDestination({ kind: "issue-create", title: bad }), false);
		}
	});
});
