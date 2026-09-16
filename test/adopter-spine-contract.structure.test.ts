import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const spec = readFileSync(new URL("../SPEC.md", import.meta.url), "utf8");

const CONTRACT_CLAUSES = [
	[
		"candidate universe and invalid candidates",
		"The **candidate universe** is every regular file reached before filtering under `.pi/`, `.github/`, `.githooks/`, and `changelog_unreleased/`; unreadable, non-regular, symlink, or invalid-path candidates refuse the whole plan.",
	],
	[
		"canonical path grammar",
		"Paths are UTF-8 NFC, `/`-separated repository-relative values with no empty, dot, dot-dot, NUL, backslash, or absolute component.",
	],
	[
		"marker spelling, termination, and position",
		"A source-only declaration is exactly `# gitjig: source-only` or `// gitjig: source-only`, LF- or CRLF-terminated on byte line 1, or line 2 when line 1 is a `#!` interpreter line.",
	],
	[
		"invalid eligible marker refusal",
		"A BOM or another spelling is not a declaration; an eligible line containing `gitjig:` but not matching exactly refuses.",
	],
	[
		"ordered total classifier",
		"Classification is ordered and total: valid marker → **source-only**; `changelog_unreleased/TEMPLATE.md` → **handed-over**; other `changelog_unreleased/**` → **instance-state**; `.pi/extensions/gitjig.ts`, `.pi/extensions/gitjig/**`, and `.pi/prompts/**` → **carried**; another `.pi/**` → refuse until settled; `.github/**` and `.githooks/**` → **handed-over**.",
	],
	[
		"membership snapshot",
		"All four dispositions remain in one path-sorted committed membership snapshot, so add, remove, rename, declaration, and disposition change fail its check until reviewed.",
	],
	[
		"path-stable ownership",
		"Handed/carried ownership is path-stable: a same-path transition is invalid; moving a capability is retire-old plus add-new at distinct paths.",
	],
	[
		"closed pin identity domain",
		'The pin\'s closed v1 JSON contains exactly `schemaVersion: 1`; platform-attested `source` (`provider: "github"`, `host: "github.com"`, and the platform-returned canonical spelling of non-empty NFC owner/repository names with no slash, control, or percent encoding); a 40-lowercase-hex immutable `revision`; `digest: "sha256-v1"`; a path-sorted manifest of `{path,class,size,digest}` entries; and `payloadDigest` plus `carriedDigest`.',
	],
	["closed manifest class domain", "`class` is exactly `handed-over` or `carried`."],
	[
		"closed manifest size domain",
		"`size` is the unsigned file-byte length in the JSON integer domain, written as canonical base-10 digits with no sign, fraction, exponent, or leading zero except the value `0`, and no greater than uint64 max.",
	],
	[
		"closed digest spelling",
		"Every member and aggregate digest is exactly 64 lowercase hexadecimal characters and represents SHA-256.",
	],
	[
		"manifest order and record framing",
		"Manifest order is unsigned UTF-8 path-byte order. Each digest record is one class byte (`0x48` handed, `0x43` carried), uint32-big-endian path-byte length, path bytes, uint64-big-endian file-byte length, and the raw 32-byte member digest.",
	],
	[
		"aggregate digest projections",
		"`payloadDigest` hashes all concatenated records; `carriedDigest` hashes only carried records; an empty projection hashes the empty byte string.",
	],
	[
		"pre-write acquisition verification",
		"Acquisition obtains bytes from the platform-attested source at exactly `revision`, reconstructs the complete manifest and both aggregate digests, and refuses before any target mutation on any mismatch.",
	],
	[
		"reviewed PR payload boundary",
		"The PR atomically carries all admitted handed-over actions plus exactly one pin and no carried member.",
	],
	["first-provision occupant rule", "First provision admits carried destinations only when absent or exact-next."],
	[
		"later-provision transition matrix",
		"Later provision validates its schema/source/revision/digests, then plans over old and new manifests: shared paths admit exact-old or exact-next; next-only paths admit absent or exact-next; prior-only paths admit exact-old or absent.",
	],
	[
		"transition action mapping",
		"Those states mean replace/converge, land/converge, and retire/converged-retirement; every other occupant refuses.",
	],
	[
		"crash rerun and skipped revisions",
		"A clone may skip revisions and a crash prefix may rerun without trusting a success claim.",
	],
	[
		"installed authority advancement",
		"The installed record advances atomically only after every carried action, exclusion, binding, final carried-manifest comparison, and effective-binding verification succeeds.",
	],
	[
		"closed composition actions and no-prior state",
		"Composition plans over the **old and new manifests** with closed actions `land`, `replace`, `retire`, `converged`, and `refuse`. Without a prior pin, only absent or exact-next destinations admit.",
	],
	[
		"prior-pin and foreign-occupant refusal",
		"The pin replaces only when its bytes exactly equal the admitted prior pin. Malformed/changed-source pins, missing ownership entries, foreign occupants, and bytes matching neither old nor new refuse.",
	],
	[
		"whole-phase pre-mutation refusal",
		"The **whole phase refuses before mutation** if any member refuses; no partial-success pin exists.",
	],
] as const;

function assertSpine(doc: string): void {
	for (const [name, clause] of CONTRACT_CLAUSES) {
		assert.ok(doc.includes(clause), `missing canonical ${name} clause`);
	}
	for (const [start, end] of [
		["**Tier 2 — the local git-hook tier.**", "**Tier 3 — CI gates and the server-side ruleset.**"],
		["### 5.1 Self-contained artifacts", "### 5.2 Graceful degradation"],
		["## 6. Self-governance milestone", "### 6.1 Substrate posture"],
	] as const) {
		const body = doc.slice(doc.indexOf(start), doc.indexOf(end, doc.indexOf(start) + start.length));
		assert.match(body, /handed-over[\s\S]+carried/);
	}
}

type MarkerResult = "source-only" | "absent" | "refuse";

function classifyMarker(raw: string): MarkerResult {
	const firstEnd = raw.indexOf("\n");
	const first = firstEnd < 0 ? raw : raw.slice(0, firstEnd).replace(/\r$/, "");
	const eligibleStart = first.startsWith("#!") ? firstEnd + 1 : 0;
	if (eligibleStart <= 0 && first.startsWith("#!")) return "absent";
	const eligibleEnd = raw.indexOf("\n", eligibleStart);
	const eligible = (eligibleEnd < 0 ? raw.slice(eligibleStart) : raw.slice(eligibleStart, eligibleEnd)).replace(
		/\r$/,
		"",
	);
	const terminated = eligibleEnd >= 0;
	if (terminated && (eligible === "# gitjig: source-only" || eligible === "// gitjig: source-only"))
		return "source-only";
	return eligible.includes("gitjig:") ? "refuse" : "absent";
}

test("#249 pins every closed adopter-spine branch and transition", () => assertSpine(spec));

test("#249's contract lock reds removal of every canonical branch", () => {
	for (const [name, clause] of CONTRACT_CLAUSES) {
		assert.throws(() => assertSpine(spec.replace(clause, "")), name);
	}
});

test("#249's marker model distinguishes declaration, absence, and refusal", () => {
	for (const raw of ["# gitjig: source-only\nname: x\n", "# gitjig: source-only\r\n", "// gitjig: source-only\n"])
		assert.equal(classifyMarker(raw), "source-only");
	assert.equal(classifyMarker("#!/bin/sh\n# gitjig: source-only\n"), "source-only");
	for (const [raw, expected] of [
		["# gitjig: source-only", "refuse"],
		["name: x\n# gitjig: source-only\n", "absent"],
		["# GITJIG: source-only\n", "absent"],
		["# gitjig: source only\n", "refuse"],
		["\uFEFF# gitjig: source-only\n", "refuse"],
		["name: x\n", "absent"],
	] as const)
		assert.equal(classifyMarker(raw), expected);
});

test("#249 marks every currently declared development-only substrate file at its legal head", () => {
	for (const path of [
		"../.github/workflows/source-checks.yml",
		"../.github/workflows/suite.yml",
		"../.github/workflows/check-merge-review.yml",
		"../.github/workflows/check-merge-review.mjs",
	]) {
		assert.equal(classifyMarker(readFileSync(new URL(path, import.meta.url), "utf8")), "source-only", path);
	}
});
