import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesConsumerPolicy, matchesProfile } from "../.pi/extensions/gitjig/dispatch/pi-submit-extension.ts";
import { acceptsRecoveryPiPayload } from "../.pi/extensions/gitjig/recovery/coordinator.ts";
import { recoveryPiProfile } from "../.pi/extensions/gitjig/recovery/pi-profile.ts";
import { admitDiagnosis } from "../.pi/extensions/gitjig/review/history.ts";
import { reviewerReturnFromPayload } from "../.pi/extensions/gitjig/review/join.ts";
import { REVIEW_PI_PROFILES } from "../.pi/extensions/gitjig/review/pi-profile.ts";
import { indexedAdjudicationFromPayload } from "../.pi/extensions/gitjig/review/resolve.ts";

const diagnosis = (value: unknown) =>
	admitDiagnosis({
		disposition: "admitted",
		ok: true,
		compare: "confirmed",
		summary: "history-result",
		payload: JSON.stringify(value),
		diagnostic: {} as never,
	});

test("reviewer Pi profile and owning parser agree on closed structural shapes", () => {
	const values = [
		{ token: "APPROVED", findings: [] },
		{ token: "FINDINGS", findings: ["candidate"] },
		{ token: "APPROVED", findings: ["contradiction belongs to panel"] },
		{ token: "BAD", findings: [] },
		{ token: "APPROVED", findings: [], role: "judge" },
		// Above any plausible producer cap and accepted by the consumer, which
		// bounds the whole return rather than each string: a profile that capped a
		// review string would reject this while the consumer takes it.
		{ token: "FINDINGS", findings: ["f".repeat(5000)] },
		{ token: "APPROVED", findings: [1] },
		{ token: "APPROVED" },
		{ findings: [] },
		{},
	];
	for (const value of values) {
		assert.equal(
			matchesProfile(REVIEW_PI_PROFILES.reviewer.schema, value),
			!("failure" in reviewerReturnFromPayload(JSON.stringify(value))),
		);
	}
});

test("Judge Pi profile and the indexed owning parser agree on ruling keys, ordinals, slot and domain", () => {
	// The round's consumer is the INDEXED parser (§1.7's version-2 bundle), so
	// the tool must accept a ruling carrying rawOrdinals and refuse nothing that
	// parser takes. Nonemptiness, ascent and in-range identity are the envelope
	// check's at admission, not this schema's.
	const ruling = {
		finding: "F",
		rawOrdinals: [1],
		provenance: [{ lens: "L", surface: "S" }],
		validity: "CONFIRMED",
		evidence: "E",
	};
	const values = [
		{ dedupAttested: true, rulings: [] },
		{ dedupAttested: true, rulings: [ruling] },
		// Evidence the consumer accepts at ordinary and long lengths: a producer
		// that restricted its length would reject consumer-valid rulings, and a
		// one-character example alone could never show it.
		{ dedupAttested: true, rulings: [{ ...ruling, evidence: "measured by running the arm twice" }] },
		{ dedupAttested: true, rulings: [{ ...ruling, evidence: "e".repeat(4096) }] },
		{ dedupAttested: true, rulings: [{ ...ruling, evidence: "e".repeat(5000) }] },
		{ dedupAttested: true, rulings: [{ ...ruling, finding: "f".repeat(5000) }] },
		{ dedupAttested: true, rulings: [{ ...ruling, finding: "f".repeat(2048), remedy: "r".repeat(2048) }] },
		{ dedupAttested: true, rulings: [{ ...ruling, rawOrdinals: [0, 2, 5] }] },
		{ dedupAttested: false, rulings: [{ ...ruling, severity: "SUBSTANTIVE", onCriterion: false }] },
		// Every optional ruling field, valid: a profile that becomes stricter than
		// the consumer for any of them makes a lawful ruling unsubmittable.
		{
			dedupAttested: false,
			rulings: [
				{
					...ruling,
					severity: "NIT",
					remedy: "exact remedy prose",
					direction: "fail-closed",
					onCriterion: true,
				},
			],
		},
		{ dedupAttested: true, rulings: [{ ...ruling, remedy: "" }] },
		{ dedupAttested: true, rulings: [{ ...ruling, direction: "live-harm" }] },
		{ dedupAttested: true, rulings: [{ ...ruling, direction: "fail-open" }] },
		{ dedupAttested: true, rulings: [{ ...ruling, severity: "MINOR" }] },
		{ dedupAttested: true, rulings: [{ ...ruling, remedy: 1 }] },
		{ dedupAttested: true, rulings: [{ ...ruling, onCriterion: "yes" }] },
		{ dedupAttested: true, rulings: [{ ...ruling, rawOrdinals: [] }] },
		{ dedupAttested: true, rulings: [{ ...ruling, rawOrdinals: [1.5] }] },
		// The safe-integer boundary: the consumer admits exactly the safe
		// integers, so a validator loosened to every integer must fail parity.
		{ dedupAttested: true, rulings: [{ ...ruling, rawOrdinals: [Number.MAX_SAFE_INTEGER] }] },
		{ dedupAttested: true, rulings: [{ ...ruling, rawOrdinals: [Number.MAX_SAFE_INTEGER + 2] }] },
		{ dedupAttested: true, rulings: [{ ...ruling, rawOrdinals: [-(Number.MAX_SAFE_INTEGER + 2)] }] },
		{ dedupAttested: true, rulings: [{ ...ruling, rawOrdinals: ["1"] }] },
		{ dedupAttested: true, rulings: [{ ...ruling, rawOrdinals: 1 }] },
		{ dedupAttested: true, rulings: [{ finding: "F", provenance: [], validity: "CONFIRMED", evidence: "E" }] },
		// Each required ruling key omitted alone: the consumer rejects every one,
		// so a profile that stopped requiring it would accept a payload the
		// consumer refuses, which is the drift this parity claim is about.
		...(["finding", "rawOrdinals", "provenance", "validity", "evidence"] as const).map((key) => {
			const { [key]: _omitted, ...rest } = ruling;
			return { dedupAttested: true, rulings: [rest] };
		}),
		{ dedupAttested: true, rulings: [{ ...ruling, validity: "INVALID" }] },
		{ dedupAttested: true, rulings: [{ ...ruling, provenance: [{ lens: "L", surface: "S", extra: true }] }] },
		// The nested slot's own required keys: a profile that stopped requiring
		// one would accept provenance the consumer rejects.
		{ dedupAttested: true, rulings: [{ ...ruling, provenance: [{ surface: "S" }] }] },
		{ dedupAttested: true, rulings: [{ ...ruling, provenance: [{ lens: "L" }] }] },
		{ dedupAttested: true, rulings: [{ ...ruling, provenance: [{}] }] },
		{ dedupAttested: true, rulings: [{ ...ruling, provenance: [{ lens: 1, surface: "S" }] }] },
		{ dedupAttested: true, rulings: [{ ...ruling, unknown: true }] },
		{ dedupAttested: true },
		{ rulings: [ruling] },
		{ rulings: [] },
		{},
	];
	for (const value of values) {
		assert.equal(
			matchesProfile(REVIEW_PI_PROFILES.judge.schema, value),
			indexedAdjudicationFromPayload(JSON.stringify(value)) !== undefined,
			`profile and indexed parser disagree on ${JSON.stringify(value)}`,
		);
	}
	// The one that regressed: an indexed ruling the consumer accepts must be
	// submittable through the tool.
	assert.equal(matchesProfile(REVIEW_PI_PROFILES.judge.schema, { dedupAttested: true, rulings: [ruling] }), true);
});

test("history diagnosis Pi profile agrees with current consumer domain and nonempty evidence", () => {
	for (const value of [
		{ value: "NONE", invalidation: "nothing", evidence: "E" },
		{ value: "STAGNATION", invalidation: "plan", evidence: "E" },
		{ value: "OSCILLATION", invalidation: "authorization", evidence: "E" },
		{ value: "INDETERMINATE", invalidation: "nothing", evidence: "E" },
		{ value: "OTHER", invalidation: "nothing", evidence: "E" },
		{ value: "NONE", invalidation: "nothing", evidence: "e".repeat(5000) },
		{ value: "NONE", invalidation: "nothing", evidence: "" },
		{ value: "NONE", invalidation: "else", evidence: "E" },
		{ invalidation: "nothing", evidence: "E" },
		{ value: "NONE", evidence: "E" },
		{ value: "NONE", invalidation: "nothing" },
		{},
	]) {
		assert.equal(matchesProfile(REVIEW_PI_PROFILES.history.schema, value), diagnosis(value).available);
	}
});

test("recovery Pi profiles agree with owning consumer on normalization, bounds and role conditions", () => {
	const digest = "0".repeat(64);
	const examples = {
		challenger: [
			{ outcome: "ALTERNATIVE", method: "new method", evidence: "reason" },
			{ outcome: "BASE_STANDS", method: "", evidence: "reason" },
			{ outcome: "ALTERNATIVE", method: "", evidence: "reason" },
			{ outcome: "BASE_STANDS", method: "unexpected", evidence: "reason" },
			{ outcome: "ALTERNATIVE", method: "way", evidence: "bad\u0000text" },
			{ outcome: "ALTERNATIVE", method: "way", evidence: "é".repeat(4096) },
			{ outcome: "ALTERNATIVE", method: "way", evidence: "e\u0301" },
		],
		"selector-contest": [
			{ selected: "root", materiallyDifferent: true, evidence: "yes" },
			{ selected: "none", materiallyDifferent: false, evidence: "" },
		],
		"selector-measurement": [
			{ question: "what", method: "read", expectedDiscriminator: "outcome", evidence: "why" },
			{ question: "", method: "read", expectedDiscriminator: "outcome", evidence: "why" },
		],
		measurement: [
			{ result: "observed", evidence: "why" },
			{ result: "observed", evidence: "" },
		],
		diagnosis: [
			{ value: "NONE", invalidation: "nothing", evidence: "fact" },
			{ value: "UNKNOWN", invalidation: "nothing", evidence: "fact" },
		],
	} as const;
	// A field long enough to catch a producer cap below the consumer's own bound:
	// recoveryText admits up to 4096 bytes per field, so 1000 ASCII characters is
	// valid for every role and stays inside each role's total-bytes rule.
	const long = "e".repeat(1000);
	const longer: Record<string, readonly Record<string, unknown>[]> = {
		challenger: [{ outcome: "ALTERNATIVE", method: "way", evidence: long }],
		"selector-contest": [{ selected: "root", materiallyDifferent: true, evidence: long }],
		"selector-measurement": [{ question: "what", method: "read", expectedDiscriminator: "outcome", evidence: long }],
		measurement: [{ result: "observed", evidence: long }],
		diagnosis: [{ value: "NONE", invalidation: "nothing", evidence: long }],
	};
	for (const [role, cases] of Object.entries(examples)) {
		const profile = recoveryPiProfile(role as keyof typeof examples, role === "measurement" ? digest : undefined);
		assert.ok(profile);
		// Each role's first example with one required key absent, so a profile
		// that stopped requiring that key — accepting what its consumer rejects —
		// fails here rather than passing on complete payloads alone.
		const complete = cases[0] as Record<string, unknown>;
		const absent = Object.keys(complete).map((key) => {
			const { [key]: _omitted, ...rest } = complete;
			return rest;
		});
		for (const args of [...cases, ...(longer[role] ?? []), ...absent, {}]) {
			const candidate: Record<string, unknown> = { ...profile.fixed, ...args };
			const producerAccepts: boolean =
				matchesProfile(profile.schema, args) && matchesConsumerPolicy(profile, candidate);
			assert.equal(
				producerAccepts,
				acceptsRecoveryPiPayload(role as keyof typeof examples, candidate, digest),
				`${role}: ${JSON.stringify(args)}`,
			);
		}
	}
});

test("recovery profiles never delegate the role or caller's measurement digest", () => {
	assert.equal(recoveryPiProfile("measurement"), undefined);
	assert.equal(recoveryPiProfile("measurement", "0".repeat(64))?.fixed.specDigest, "0".repeat(64));
	for (const role of ["challenger", "selector-contest", "selector-measurement", "measurement", "diagnosis"] as const) {
		const profile = recoveryPiProfile(role, role === "measurement" ? "0".repeat(64) : undefined);
		assert.ok(profile);
		assert.equal(profile.summary, "recovery-result");
		assert.equal("role" in (profile.schema.properties ?? {}), false);
		assert.equal("expectedRef" in (profile.schema.properties ?? {}), false);
	}
});
