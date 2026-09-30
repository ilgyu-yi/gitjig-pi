/**
 * Issue #378 — complete Judge adjudication and one bounded whole-bundle
 * re-request (SPEC §§1.7/1.9, settled by #379). The fixtures drive the
 * real round driver, admission, record parser and history projection; only
 * the dispatch seam is faked.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import type { DispatchOutcome, RunDispatchOptions } from "../.pi/extensions/gitjig/dispatch/index.ts";
import { deriveRepairBasis, repairHistory } from "../.pi/extensions/gitjig/review/history.ts";
import { makeDispatcher, reviewRound } from "../.pi/extensions/gitjig/review/orchestrate.ts";
import type { IndexedBundleEntry } from "../.pi/extensions/gitjig/review/panel.ts";
import {
	composeReviewRecord,
	type JudgeAttempt,
	judgeAttempt,
	parseReviewRecord,
	type ReviewRecord,
} from "../.pi/extensions/gitjig/review/record.ts";
import {
	admitIndexedAdjudication,
	type IndexedRuling,
	indexedAdjudicationFromPayload,
	type Manifest,
	resolve,
} from "../.pi/extensions/gitjig/review/resolve.ts";

const RUNTIME = { lens: "runtime", surface: "the shell's runtime extensions" };
const SUITE = { lens: "suite", surface: "the test suite" };
const FENCES = { outOfScope: [], forbiddenRemedies: [], deferralHomes: [], priorFindings: [] };
const MANIFEST: Manifest = { state: "present", criteria: ["#378: a criterion"] };
/** The two different same-slot findings PR #376's suite slot returned. */
const MISSING_TEST = "missing Pi no-provisional-file test";
const README_POINTER = "untested README contract pointer";

const scratch: string[] = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.invalid",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.invalid",
};
function git(dir: string, ...argv: string[]): string {
	return execFileSync("git", ["-C", dir, ...argv], { encoding: "utf8", env: gitEnv }).trim();
}
/** A repository whose last commit changes `files`, routed under the committed lens policy. */
function repo(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "gitjig-378-"));
	scratch.push(dir);
	git(dir, "init", "-q");
	git(dir, "config", "commit.gpgsign", "false");
	writeFileSync(join(dir, "seed.txt"), "seed\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "seed");
	for (const [name, body] of Object.entries(files)) {
		execFileSync("mkdir", ["-p", dirname(join(dir, name))]);
		writeFileSync(join(dir, name), body);
	}
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "change");
	return dir;
}

const diagnostic = (
	status: "admitted" | "refused",
	exitCode = status === "admitted" ? 0 : 1,
): DispatchOutcome["diagnostic"] =>
	({
		schemaVersion: 1,
		status,
		phase: status === "admitted" ? "serialize" : "return",
		run: { class: "exited", exitCode, signal: null },
		return: { class: status === "admitted" ? "admitted" : "missing" },
		compare: { class: status === "admitted" ? "confirmed" : "not-reached" },
		durationMs: 1,
		code: status === "admitted" ? "ADMITTED" : "RETURN_MISSING",
		message: "m",
	}) as unknown as DispatchOutcome["diagnostic"];

function admitted(
	payload: string | undefined,
	options: { ok?: boolean; compare?: "confirmed" | "invalid"; exitCode?: number; summary?: string } = {},
): DispatchOutcome {
	return {
		disposition: "admitted",
		ok: options.ok ?? true,
		summary: options.summary ?? "RESULT",
		...(payload === undefined ? {} : { payload }),
		compare: options.compare ?? "confirmed",
		diagnostic: diagnostic("admitted", options.exitCode ?? 0),
	};
}
const refused = (): DispatchOutcome => ({ disposition: "refused", cause: "c", diagnostic: diagnostic("refused") });
const findings = (...texts: string[]) => admitted(JSON.stringify({ token: "FINDINGS", findings: texts }));
const approvedSlot = () => admitted(JSON.stringify({ token: "APPROVED", findings: [] }));

type RulingSpec = Partial<IndexedRuling> & { rawOrdinals: number[]; provenance: IndexedRuling["provenance"] };
const ruling = (spec: RulingSpec): IndexedRuling => ({
	finding: `effective ${spec.rawOrdinals.join("+")}`,
	validity: "CONFIRMED",
	severity: "SUBSTANTIVE",
	direction: "live-harm",
	onCriterion: true,
	evidence: "the command ran and printed the defect",
	...spec,
});
const judgeReturn = (rulings: IndexedRuling[], dedupAttested = true) =>
	admitted(JSON.stringify({ dedupAttested, rulings }));

/** A dispatch seam answering reviewer slots by lens and Judge calls from a queue. */
function seam(slots: Record<string, () => DispatchOutcome>, judges: Array<() => DispatchOutcome>) {
	const judgeBriefs: string[] = [];
	const pins: string[] = [];
	const dispatch = async (brief: string, head: string): Promise<DispatchOutcome> => {
		pins.push(head);
		if (brief.includes("You are the JUDGE")) {
			judgeBriefs.push(brief);
			const next = judges.shift();
			if (next === undefined) throw new Error(`Judge call ${judgeBriefs.length} was not seeded`);
			return next();
		}
		for (const [lens, answer] of Object.entries(slots)) if (brief.includes(`lens "${lens}"`)) return answer();
		return approvedSlot();
	};
	return { dispatch, judgeBriefs, pins };
}

async function round(files: Record<string, string>, s: ReturnType<typeof seam>, manifest: Manifest = MANIFEST) {
	const dir = repo(files);
	const result = await reviewRound({
		repoRoot: dir,
		baseRef: "HEAD~1",
		headRef: "HEAD",
		manifest,
		fences: FENCES,
		changeDescription: "the change",
		dispatch: s.dispatch,
	});
	return { ...result, head: git(dir, "rev-parse", "HEAD") };
}

const SUITE_ONLY = { "test/y.test.ts": "y\n" };

/** Remove the re-request block, which is the only difference a second brief may carry. */
function withoutReRequest(brief: string): string {
	const lines = brief.split("\n");
	const start = lines.indexOf(
		"COMPLETENESS RE-REQUEST — an earlier independent Judge's adjudication of this same round was",
	);
	assert.ok(start >= 0, "the second brief carries no re-request block");
	const end = lines.indexOf("", start);
	return [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n");
}

describe("#378 one bounded whole-bundle Judge re-request", () => {
	it("PR #376's two different same-slot findings: a one-ruling first adjudication draws exactly one whole-bundle re-request that resolves", async () => {
		const s = seam({ suite: () => findings(MISSING_TEST, README_POINTER) }, [
			() => judgeReturn([ruling({ finding: MISSING_TEST, rawOrdinals: [0], provenance: [SUITE] })]),
			() =>
				judgeReturn([
					ruling({ finding: MISSING_TEST, rawOrdinals: [0], provenance: [SUITE] }),
					ruling({ finding: README_POINTER, rawOrdinals: [1], provenance: [SUITE] }),
				]),
		]);
		const result = await round(SUITE_ONLY, s);
		assert.equal(s.judgeBriefs.length, 2, "an incomplete first adjudication must draw exactly one re-request");
		assert.ok(
			s.pins.every((pin) => pin === result.head),
			"every dispatch rides the round's one resolved head",
		);
		for (const text of [MISSING_TEST, README_POINTER, "Raw ordinal 0", "Raw ordinal 1"])
			assert.ok(s.judgeBriefs[1].includes(text), `the re-request lacks the whole bundle: ${text}`);
		assert.ok(
			s.judgeBriefs[1].includes("- raw ordinal 1 is ruled by no effective finding (§1.9)"),
			"the re-request does not carry the caller's deterministic gap",
		);
		assert.equal(withoutReRequest(s.judgeBriefs[1]), s.judgeBriefs[0], "the re-request changed more than the gaps");
		assert.ok(result.review.state === "resolved" && result.review.resolution.outcome === "repair");
		assert.deepEqual(result.review.state === "resolved" && result.review.resolution.dispositions, [
			{ rulingIndex: 0, finding: MISSING_TEST, disposition: "repair" },
			{ rulingIndex: 1, finding: README_POINTER, disposition: "repair" },
		]);
		assert.deepEqual(
			result.record.judgeAttempts?.map((attempt) => attempt.attempt),
			[1, 2],
			"both semantic attempts are retained in order",
		);
		assert.deepEqual(parseReviewRecord(result.recordBody), JSON.parse(JSON.stringify(result.record)));
	});

	it("a genuine dedup of two raw ordinals keeps both raw texts and the slot multiplicity, with one Judge call", async () => {
		const s = seam({ suite: () => findings("same defect", "same defect") }, [
			() => judgeReturn([ruling({ finding: "same defect", rawOrdinals: [0, 1], provenance: [SUITE, SUITE] })]),
		]);
		const result = await round(SUITE_ONLY, s);
		assert.equal(s.judgeBriefs.length, 1);
		assert.deepEqual(
			result.record.bundle.map((entry) => [entry.rawOrdinal, entry.finding]),
			[
				[0, "same defect"],
				[1, "same defect"],
			],
		);
		assert.equal(result.record.adjudication?.rulings[0].provenance.length, 2);
		assert.ok(result.review.state === "resolved");
		assert.ok(parseReviewRecord(result.recordBody) !== undefined);
	});

	it("a numeric nonzero exit with a valid admitted return is still an adjudication", async () => {
		const s = seam({ suite: () => findings(MISSING_TEST) }, [
			() =>
				admitted(
					JSON.stringify({
						dedupAttested: true,
						rulings: [ruling({ finding: MISSING_TEST, rawOrdinals: [0], provenance: [SUITE] })],
					}),
					{ exitCode: 3 },
				),
		]);
		const result = await round(SUITE_ONLY, s);
		assert.equal(result.review.state, "resolved");
		assert.equal(s.judgeBriefs.length, 1);
	});

	it("fake same-slot coverage is not occurrence identity: it is refused, re-requested once, and stays INCOMPLETE", async () => {
		const fake = () => judgeReturn([ruling({ finding: MISSING_TEST, rawOrdinals: [0], provenance: [SUITE, SUITE] })]);
		const s = seam({ suite: () => findings(MISSING_TEST, README_POINTER) }, [fake, fake]);
		const result = await round(SUITE_ONLY, s);
		assert.equal(s.judgeBriefs.length, 2);
		assert.equal(result.review.state, "incomplete");
		assert.equal(result.record.adjudication, null, "an incomplete version-2 review carries no adjudication");
		assert.ok(parseReviewRecord(result.recordBody) !== undefined, "the incomplete record is still admitted");
	});

	it("an invalid, unavailable or unconfirmed first return earns no semantic re-request", async () => {
		const complete = () => judgeReturn([ruling({ finding: MISSING_TEST, rawOrdinals: [0], provenance: [SUITE] })]);
		const payload = JSON.stringify({
			dedupAttested: true,
			rulings: [ruling({ finding: MISSING_TEST, rawOrdinals: [0], provenance: [SUITE] })],
		});
		const cases: Array<[string, () => DispatchOutcome]> = [
			["refused", refused],
			["compare invalid", () => admitted(payload, { compare: "invalid" })],
			["delegate not ok", () => admitted(payload, { ok: false })],
			["no payload", () => admitted(undefined)],
			[
				"payload without raw ordinals",
				() =>
					admitted(
						JSON.stringify({
							dedupAttested: true,
							rulings: [{ ...ruling({ rawOrdinals: [0], provenance: [SUITE] }), rawOrdinals: undefined }],
						}),
					),
			],
		];
		for (const [name, first] of cases) {
			const s = seam({ suite: () => findings(MISSING_TEST) }, [first, complete]);
			const result = await round(SUITE_ONLY, s);
			assert.equal(s.judgeBriefs.length, 1, `${name}: a re-request was made`);
			assert.deepEqual(result.review, { state: "incomplete", cause: "adjudication-missing" }, name);
			assert.equal(result.record.judgeAttempts?.length, 1, name);
			assert.ok(parseReviewRecord(result.recordBody) !== undefined, name);
		}
	});

	it("a second incomplete, invalid or unavailable return stops INCOMPLETE with no third semantic call", async () => {
		const incomplete = () => judgeReturn([ruling({ finding: MISSING_TEST, rawOrdinals: [0], provenance: [SUITE] })]);
		const cases: Array<[string, () => DispatchOutcome, string]> = [
			["incomplete again", incomplete, "adjudication-incomplete"],
			["refused", refused, "adjudication-missing"],
			["compare invalid", () => admitted("{}", { compare: "invalid" }), "adjudication-missing"],
		];
		for (const [name, second, cause] of cases) {
			const s = seam({ suite: () => findings(MISSING_TEST, README_POINTER) }, [incomplete, second, incomplete]);
			const result = await round(SUITE_ONLY, s);
			assert.equal(s.judgeBriefs.length, 2, `${name}: a third semantic call was made`);
			assert.ok(result.review.state === "incomplete" && result.review.cause === cause, name);
			assert.equal(result.record.adjudication, null, name);
			assert.deepEqual(
				result.record.judgeAttempts?.map((attempt) => attempt.attempt),
				[1, 2],
				name,
			);
			assert.ok(parseReviewRecord(result.recordBody) !== undefined, name);
		}
	});

	it("an absent manifest dispatches no Judge and records no attempt", async () => {
		const s = seam({ suite: () => findings(MISSING_TEST) }, []);
		const result = await round(SUITE_ONLY, s, { state: "absent" });
		assert.equal(s.judgeBriefs.length, 0);
		assert.deepEqual(result.record.judgeAttempts, []);
		assert.deepEqual(result.review, { state: "incomplete", cause: "adjudication-missing" });
		assert.ok(parseReviewRecord(result.recordBody) !== undefined);
	});

	it("each semantic call keeps its own one transport retry, which never replenishes the re-request", async () => {
		const sends: string[] = [];
		const incompletePayload = JSON.stringify({
			dedupAttested: true,
			rulings: [ruling({ finding: MISSING_TEST, rawOrdinals: [0], provenance: [SUITE] })],
		});
		const completePayload = JSON.stringify({
			dedupAttested: true,
			rulings: [
				ruling({ finding: MISSING_TEST, rawOrdinals: [0], provenance: [SUITE] }),
				ruling({ finding: README_POINTER, rawOrdinals: [1], provenance: [SUITE] }),
			],
		});
		const judgeSends: DispatchOutcome[] = [
			refused(),
			admitted(incompletePayload),
			refused(),
			admitted(completePayload),
		];
		const missing = (): DispatchOutcome => ({
			disposition: "refused",
			cause: "c",
			diagnostic: { ...diagnostic("refused"), run: { class: "exited", exitCode: 0, signal: null } },
		});
		const run = async (options: RunDispatchOptions): Promise<DispatchOutcome> => {
			sends.push(options.brief);
			if (!options.brief.includes("You are the JUDGE")) {
				return options.brief.includes('lens "suite"') ? findings(MISSING_TEST, README_POINTER) : approvedSlot();
			}
			const next = judgeSends.shift();
			if (next === undefined) throw new Error("an unseeded Judge send");
			return next.disposition === "refused" ? missing() : next;
		};
		const dispatch = makeDispatcher({ callerRepoRoot: "/r", stateRoot: "/s", delegateArgv: ["x"] }, run);
		const result = await round(SUITE_ONLY, { dispatch, judgeBriefs: [], pins: [] });
		const judgeSent = sends.filter((brief) => brief.includes("You are the JUDGE"));
		assert.equal(judgeSent.length, 4, "two semantic calls, each with its own one transport retry");
		assert.equal(judgeSent.filter((brief) => brief.includes("COMPLETENESS RE-REQUEST")).length, 2);
		assert.equal(result.review.state, "resolved");
	});
});

describe("#378 indexed admission", () => {
	const bundle: IndexedBundleEntry[] = [
		{ rawOrdinal: 0, finding: "a", slot: SUITE },
		{ rawOrdinal: 1, finding: "b", slot: SUITE },
		{ rawOrdinal: 2, finding: "c", slot: RUNTIME },
	];
	const admit = (rulings: IndexedRuling[], manifest: Manifest = MANIFEST, dedup = true) =>
		admitIndexedAdjudication({ dedupAttested: dedup, rulings }, manifest, bundle);
	const complete = [
		ruling({ rawOrdinals: [0, 1], provenance: [SUITE, SUITE] }),
		ruling({ rawOrdinals: [2], provenance: [RUNTIME] }),
	];

	it("admits an exact disjoint partition whose provenance is each ruling's raw-slot multiset", () => {
		const admission = admit(complete);
		assert.equal(admission.complete, true);
	});

	it("names a deterministic gap for every refused identity, provenance and axis shape", () => {
		const cases: Array<[string, IndexedRuling[], string, Manifest?, boolean?]> = [
			["empty ordinals", [ruling({ rawOrdinals: [], provenance: [] }), ...complete], "rawOrdinals is empty"],
			[
				"descending ordinals",
				[ruling({ rawOrdinals: [1, 0], provenance: [SUITE, SUITE] }), complete[1]],
				"not strictly ascending",
			],
			[
				"repeated ordinal in one ruling",
				[ruling({ rawOrdinals: [0, 0, 1], provenance: [SUITE, SUITE, SUITE] }), complete[1]],
				"not strictly ascending",
			],
			[
				"ordinal ruled twice",
				[...complete, ruling({ rawOrdinals: [2], provenance: [RUNTIME] })],
				"raw ordinal 2 is ruled by both ruling 1 and ruling 2",
			],
			[
				"unknown ordinal",
				[ruling({ rawOrdinals: [0, 1, 3], provenance: [SUITE, SUITE] }), complete[1]],
				"raw ordinal 3 is not in the bundle",
			],
			[
				"negative ordinal",
				[ruling({ rawOrdinals: [-1, 0, 1], provenance: [SUITE, SUITE] }), complete[1]],
				"raw ordinal -1 is not in the bundle",
			],
			["sparse partition", [complete[0]], "raw ordinal 2 is ruled by no effective finding"],
			[
				"slot name standing in for occurrence",
				[ruling({ rawOrdinals: [0], provenance: [SUITE, SUITE] }), complete[1]],
				"raw ordinal 1 is ruled by no effective finding",
			],
			[
				"provenance of the wrong slot",
				[ruling({ rawOrdinals: [0, 1], provenance: [SUITE, RUNTIME] }), complete[1]],
				"provenance is not the multiset",
			],
			["weakened axis", [{ ...complete[0], severity: undefined }, complete[1]], "severity is unruled"],
			["blank evidence", [{ ...complete[0], evidence: "" }, complete[1]], "validity evidence is empty"],
			["absent manifest", complete, "the criterion manifest is absent", { state: "absent" }],
			["dedup not attested", complete, "dedup is not attested", MANIFEST, false],
		];
		for (const [name, rulings, gap, manifest, dedup] of cases) {
			const admission = admit(rulings, manifest ?? MANIFEST, dedup ?? true);
			assert.ok(!admission.complete, `${name}: admitted`);
			assert.ok(
				!admission.complete && admission.gaps.some((entry) => entry.includes(gap)),
				`${name}: missing gap ${gap}: ${JSON.stringify(!admission.complete && admission.gaps)}`,
			);
		}
	});

	it("carries the ruling index on every one of the five dispositions", () => {
		const one = (spec: Partial<IndexedRuling>, ordinal: number) =>
			ruling({ rawOrdinals: [ordinal], provenance: [ordinal === 2 ? RUNTIME : SUITE], ...spec });
		const rulings = [
			one({ validity: "REFUTED" }, 0),
			one({ validity: "INDETERMINATE" }, 1),
			one({ severity: "NIT", remedy: "replace `a` with `b`" }, 2),
		];
		const admission = admit(rulings);
		assert.ok(admission.complete);
		assert.deepEqual(
			resolve(admission.adjudication).dispositions.map((entry) => [entry.rulingIndex, entry.disposition]),
			[
				[0, "none"],
				[1, "measure-escalate"],
				[2, "remedy"],
			],
		);
		const deferring = admit([
			one({ direction: "fail-closed", onCriterion: false }, 0),
			one({ direction: "fail-closed", onCriterion: false }, 1),
			one({}, 2),
		]);
		assert.ok(deferring.complete);
		assert.deepEqual(
			resolve(deferring.adjudication).dispositions.map((entry) => [entry.rulingIndex, entry.disposition]),
			[
				[0, "defer"],
				[1, "defer"],
				[2, "repair"],
			],
		);
	});

	it("parses raw ordinals as safe integers on a closed ruling shape", () => {
		const base = { dedupAttested: true, rulings: [ruling({ rawOrdinals: [0], provenance: [SUITE] })] };
		assert.ok(indexedAdjudicationFromPayload(JSON.stringify(base)) !== undefined);
		for (const rawOrdinals of [undefined, [0.5], ["0"], 0]) {
			const payload = JSON.stringify({ ...base, rulings: [{ ...base.rulings[0], rawOrdinals }] });
			assert.equal(indexedAdjudicationFromPayload(payload), undefined, JSON.stringify(rawOrdinals));
		}
		const extra = JSON.stringify({ ...base, rulings: [{ ...base.rulings[0], rawOrdinal: 0 }] });
		assert.equal(indexedAdjudicationFromPayload(extra), undefined);
	});
});

describe("#378 version-2 review record", () => {
	async function resolvedTwoAttempt() {
		const s = seam({ suite: () => findings(MISSING_TEST, README_POINTER) }, [
			() => judgeReturn([ruling({ finding: MISSING_TEST, rawOrdinals: [0], provenance: [SUITE] })]),
			() =>
				judgeReturn([
					ruling({ finding: MISSING_TEST, rawOrdinals: [0], provenance: [SUITE] }),
					ruling({ finding: README_POINTER, rawOrdinals: [1], provenance: [SUITE] }),
				]),
		]);
		return (await round(SUITE_ONLY, s)).record;
	}
	/** Rebuild an attempt through the production evidence path, so only the named field differs. */
	function reissue(
		attempt: JudgeAttempt,
		change: { attempt?: 1 | 2; head?: string; manifest?: Manifest; bundle?: IndexedBundleEntry[] },
		record: ReviewRecord,
	): JudgeAttempt {
		const outcome =
			attempt.disposition === "admitted"
				? admitted(attempt.payload ?? undefined, {
						ok: attempt.ok === true,
						compare: attempt.compare as "confirmed",
					})
				: refused();
		return judgeAttempt(
			outcome,
			change.attempt ?? attempt.attempt,
			change.head ?? attempt.head,
			change.manifest ?? (record.manifest as Manifest),
			change.bundle ?? (record.bundle as IndexedBundleEntry[]),
		);
	}
	const clone = (record: ReviewRecord): ReviewRecord => JSON.parse(JSON.stringify(record));
	/** Replace a record's second attempt. */
	const second = (record: ReviewRecord, attempt: JudgeAttempt): void => {
		(record.judgeAttempts as JudgeAttempt[])[1] = attempt;
	};

	it("round-trips a resolved two-attempt record and refuses every tampered variant", async () => {
		const record = await resolvedTwoAttempt();
		assert.ok(parseReviewRecord(composeReviewRecord(record)) !== undefined, "the untampered record must parse");
		const attempts = () => record.judgeAttempts as JudgeAttempt[];
		const cases: Array<[string, (r: ReviewRecord) => void]> = [
			["schema version 3", (r) => Object.assign(r, { schemaVersion: 3 })],
			["extra key", (r) => Object.assign(r, { note: "x" })],
			["missing summaries", (r) => delete (r as { summaries?: unknown }).summaries],
			["missing manifest", (r) => delete (r as { manifest?: unknown }).manifest],
			["a bundle entry without its raw ordinal", (r) => delete r.bundle[1].rawOrdinal],
			["renumbered raw ordinals", (r) => Object.assign(r.bundle[1], { rawOrdinal: 5 })],
			["the retained first attempt dropped", (r) => r.judgeAttempts?.splice(0, 1)],
			["a third attempt", (r) => r.judgeAttempts?.push(reissue(attempts()[1], {}, record))],
			[
				"a mismatched result digest",
				(r) => Object.assign((r.judgeAttempts as JudgeAttempt[])[1], { resultDigest: "0".repeat(64) }),
			],
			["an attempt pinned to another head", (r) => second(r, reissue(attempts()[1], { head: "f".repeat(40) }, record))],
			[
				"an attempt sent another manifest",
				(r) => second(r, reissue(attempts()[1], { manifest: { state: "present", criteria: ["another"] } }, record)),
			],
			["a changed manifest", (r) => Object.assign(r, { manifest: { state: "present", criteria: ["another"] } })],
			[
				"an attempt sent another bundle",
				(r) =>
					second(r, reissue(attempts()[1], { bundle: (record.bundle as IndexedBundleEntry[]).slice(0, 1) }, record)),
			],
			[
				"attempts out of order",
				(r) => {
					const [first, second] = r.judgeAttempts as JudgeAttempt[];
					r.judgeAttempts = [reissue(second, { attempt: 1 }, record), reissue(first, { attempt: 2 }, record)];
				},
			],
			[
				"a wrong ruling index",
				(r) => {
					if (r.review.state !== "resolved") throw new Error("fixture");
					r.review.resolution.dispositions[1].rulingIndex = 0;
				},
			],
			[
				"a wrong indexed disposition",
				(r) => {
					if (r.review.state !== "resolved") throw new Error("fixture");
					r.review.resolution.dispositions[1].disposition = "defer";
				},
			],
			["a dropped effective ruling", (r) => r.adjudication?.rulings.splice(1, 1)],
			[
				"an incomplete terminal over a complete adjudication",
				(r) => Object.assign(r, { review: { state: "incomplete", cause: "adjudication-missing" }, adjudication: null }),
			],
		];
		for (const [name, tamper] of cases) {
			const copy = clone(record);
			tamper(copy);
			assert.equal(parseReviewRecord(composeReviewRecord(copy)), undefined, `${name} was admitted`);
		}
	});

	it("refuses a second attempt after a complete first one, and a missing one after an incomplete first", async () => {
		const s = seam({ suite: () => findings(MISSING_TEST) }, [
			() => judgeReturn([ruling({ finding: MISSING_TEST, rawOrdinals: [0], provenance: [SUITE] })]),
		]);
		const single = (await round(SUITE_ONLY, s)).record;
		assert.ok(parseReviewRecord(composeReviewRecord(single)) !== undefined);
		const doubled = clone(single);
		doubled.judgeAttempts?.push(reissue((single.judgeAttempts as JudgeAttempt[])[0], { attempt: 2 }, single));
		assert.equal(parseReviewRecord(composeReviewRecord(doubled)), undefined, "a second attempt after a complete first");

		const resolved = await resolvedTwoAttempt();
		const truncated = clone(resolved);
		truncated.judgeAttempts = truncated.judgeAttempts?.slice(0, 1);
		Object.assign(truncated, {
			review: {
				state: "incomplete",
				cause: "adjudication-incomplete",
				gaps: ["raw ordinal 1 is ruled by no effective finding (§1.9)"],
			},
			adjudication: null,
		});
		assert.equal(
			parseReviewRecord(composeReviewRecord(truncated)),
			undefined,
			"an admitted-incomplete first attempt without its re-request",
		);
	});

	it("refuses renumbered raw ordinals on a record where no Judge ran", async () => {
		const s = seam({ suite: () => findings(MISSING_TEST, README_POINTER) }, []);
		const record = (await round(SUITE_ONLY, s, { state: "absent" })).record;
		assert.ok(parseReviewRecord(composeReviewRecord(record)) !== undefined);
		const copy = clone(record);
		copy.bundle.reverse();
		assert.equal(parseReviewRecord(composeReviewRecord(copy)), undefined, "a reordered indexed bundle was admitted");
	});

	it("keeps historical unversioned records on their own unchanged shape", async () => {
		const record = await resolvedTwoAttempt();
		const historical = clone(record) as Partial<ReviewRecord>;
		delete historical.schemaVersion;
		delete historical.manifest;
		delete historical.judgeAttempts;
		assert.equal(
			parseReviewRecord(composeReviewRecord(historical as ReviewRecord)),
			undefined,
			"indexed fields are never admitted on the unversioned shape",
		);
	});
});

describe("#378 history over version-2 records", () => {
	function commitRepo(): { dir: string; heads: string[] } {
		const dir = mkdtempSync(join(tmpdir(), "gitjig-378-history-"));
		scratch.push(dir);
		git(dir, "init", "-q");
		git(dir, "config", "commit.gpgsign", "false");
		const heads: string[] = [];
		for (const text of ["one", "two"]) {
			writeFileSync(join(dir, "f"), text);
			git(dir, "add", "f");
			git(dir, "commit", "-qm", text);
			heads.push(git(dir, "rev-parse", "HEAD"));
		}
		return { dir, heads };
	}
	/** A version-2 repair record at `head` whose two rulings repeat one wording. */
	function repeatedWording(head: string): ReviewRecord {
		const rulings = [
			ruling({ finding: "same wording", rawOrdinals: [0], provenance: [SUITE] }),
			ruling({ finding: "same wording", rawOrdinals: [1], provenance: [SUITE] }),
		];
		return {
			schemaVersion: 2,
			head,
			slots: [],
			bundle: [
				{ rawOrdinal: 0, finding: "a", slot: SUITE },
				{ rawOrdinal: 1, finding: "b", slot: SUITE },
			],
			manifest: MANIFEST,
			judgeAttempts: [],
			adjudication: { dedupAttested: true, rulings },
			review: {
				state: "resolved",
				resolution: {
					outcome: "repair",
					dispositions: rulings.map((entry, rulingIndex) => ({
						rulingIndex,
						finding: entry.finding,
						disposition: "repair" as const,
					})),
				},
			},
			summaries: [],
		};
	}

	it("joins a version-2 repair basis by ruling index, where repeated wording is legitimate", async () => {
		const { dir, heads } = commitRepo();
		const basis = await deriveRepairBasis(dir, repairHistory(heads.map(repeatedWording)));
		assert.ok(basis !== undefined, "a version-2 repair with repeated wording must project");
		assert.deepEqual(
			basis.states.map((state) => state.findings.length),
			[2, 2],
		);
	});

	it("refuses a version-2 disposition whose ruling index does not join", async () => {
		const { dir, heads } = commitRepo();
		const records = heads.map(repeatedWording);
		const second = records[1];
		if (second.review.state !== "resolved") throw new Error("fixture");
		second.review.resolution.dispositions[1].rulingIndex = 0;
		assert.equal(await deriveRepairBasis(dir, repairHistory(records)), undefined);
	});

	it("refuses a version-2 disposition population longer than its rulings", async () => {
		const { dir, heads } = commitRepo();
		const records = heads.map(repeatedWording);
		const second = records[1];
		if (second.review.state !== "resolved") throw new Error("fixture");
		second.review.resolution.dispositions.push({ rulingIndex: 2, finding: "extra", disposition: "repair" });
		assert.equal(await deriveRepairBasis(dir, repairHistory(records)), undefined);
	});

	it("keeps PR #376's historical one-ruling repair ambiguous and handing off", async () => {
		const { dir, heads } = commitRepo();
		const historical = (head: string): ReviewRecord => ({
			head,
			slots: [],
			bundle: [
				{ finding: MISSING_TEST, slot: SUITE },
				{ finding: README_POINTER, slot: SUITE },
			],
			adjudication: {
				dedupAttested: true,
				rulings: [
					{
						finding: MISSING_TEST,
						provenance: [SUITE],
						validity: "CONFIRMED",
						severity: "SUBSTANTIVE",
						direction: "live-harm",
						onCriterion: true,
						evidence: "e",
					},
				],
			},
			review: {
				state: "resolved",
				resolution: { outcome: "repair", dispositions: [{ finding: MISSING_TEST, disposition: "repair" }] },
			},
		});
		assert.equal(await deriveRepairBasis(dir, repairHistory(heads.map(historical))), undefined);
	});

	it("never counts an incomplete version-2 review as a review state", () => {
		const incomplete: ReviewRecord = {
			schemaVersion: 2,
			head: "a".repeat(40),
			slots: [],
			bundle: [{ rawOrdinal: 0, finding: "a", slot: SUITE }],
			manifest: MANIFEST,
			judgeAttempts: [],
			adjudication: null,
			review: { state: "incomplete", cause: "adjudication-incomplete", gaps: ["g"] },
			summaries: [],
		};
		assert.deepEqual(repairHistory([incomplete]), []);
	});
});
