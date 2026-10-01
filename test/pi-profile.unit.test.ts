import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesConsumerPolicy, matchesProfile } from "../.pi/extensions/gitjig/dispatch/pi-submit-extension.ts";
import { acceptsRecoveryPiPayload } from "../.pi/extensions/gitjig/recovery/coordinator.ts";
import { recoveryPiProfile } from "../.pi/extensions/gitjig/recovery/pi-profile.ts";
import { admitDiagnosis } from "../.pi/extensions/gitjig/review/history.ts";
import { reviewerReturnFromPayload } from "../.pi/extensions/gitjig/review/join.ts";
import { REVIEW_PI_PROFILES } from "../.pi/extensions/gitjig/review/pi-profile.ts";
import { adjudicationFromPayload } from "../.pi/extensions/gitjig/review/resolve.ts";

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
		{ token: "APPROVED", findings: [1] },
		{ token: "APPROVED" },
	];
	for (const value of values) {
		assert.equal(
			matchesProfile(REVIEW_PI_PROFILES.reviewer.schema, value),
			!("failure" in reviewerReturnFromPayload(JSON.stringify(value))),
		);
	}
});

test("Judge Pi profile and owning parser agree on optional ruling keys, slot and domain", () => {
	const ruling = { finding: "F", provenance: [{ lens: "L", surface: "S" }], validity: "CONFIRMED", evidence: "E" };
	const values = [
		{ dedupAttested: true, rulings: [] },
		{ dedupAttested: false, rulings: [{ ...ruling, severity: "SUBSTANTIVE", onCriterion: false }] },
		{ dedupAttested: true, rulings: [{ ...ruling, validity: "INVALID" }] },
		{ dedupAttested: true, rulings: [{ ...ruling, provenance: [{ lens: "L", surface: "S", extra: true }] }] },
		{ dedupAttested: true, rulings: [{ ...ruling, unknown: true }] },
		{ dedupAttested: true },
	];
	for (const value of values) {
		assert.equal(
			matchesProfile(REVIEW_PI_PROFILES.judge.schema, value),
			adjudicationFromPayload(JSON.stringify(value)) !== undefined,
		);
	}
});

test("history diagnosis Pi profile agrees with current consumer domain and nonempty evidence", () => {
	for (const value of [
		{ value: "NONE", invalidation: "nothing", evidence: "E" },
		{ value: "STAGNATION", invalidation: "plan", evidence: "E" },
		{ value: "OSCILLATION", invalidation: "authorization", evidence: "E" },
		{ value: "INDETERMINATE", invalidation: "nothing", evidence: "E" },
		{ value: "OTHER", invalidation: "nothing", evidence: "E" },
		{ value: "NONE", invalidation: "nothing", evidence: "" },
		{ value: "NONE", invalidation: "else", evidence: "E" },
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
	for (const [role, cases] of Object.entries(examples)) {
		const profile = recoveryPiProfile(role as keyof typeof examples, role === "measurement" ? digest : undefined);
		assert.ok(profile);
		for (const args of cases) {
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
