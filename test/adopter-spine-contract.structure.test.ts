import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
		"closed four-disposition membership snapshot",
		"All four dispositions remain in the path-sorted committed snapshot `test/fixtures/adopter-membership.snapshot.json`. Its closed v1 JSON has exactly `schemaVersion: 1` and `members`; `members` contains every valid source candidate exactly once as `{path,disposition}`, ordered by unsigned UTF-8 path bytes, and `disposition` is exactly `source-only`, `instance-state`, `handed-over`, or `carried`.",
	],
	[
		"snapshot check ownership",
		"The snapshot is development evidence outside the candidate universe, never payload or pin input. This settlement defines but does not create it; #250 materializes it and adds the check that reconstructs it from the classifier, so candidate add, remove, rename, declaration, or disposition change then fails until the snapshot changes in the same reviewed commit.",
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
		"provision and freshness digest reuse",
		"Provisioning and freshness reconstruct the carried records with this same grammar.",
	],
	[
		"pin-version non-reinterpretation",
		"Another provider or algorithm requires a new version, never reinterpretation of v1.",
	],
	[
		"reviewed PR payload boundary",
		"The PR atomically carries all admitted handed-over actions plus exactly one pin and no carried member.",
	],
	[
		"handed-over hook runtime boundary",
		"The adapters and the `_lib.sh`/`helpers/` runtime they invoke are one **handed-over** hook layer committed in an adopter; tier 2 has no carried execution seam.",
	],
	[
		"source-bound assets wait for excision",
		"Existing source-bound candidates declare source-only until #251 removes that declaration together with the dependency that required it; no asset is admitted to handed-over first and remediated later.",
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
	[
		"closed terminal results and final verification",
		"Terminal results are `verified`, `converged`, or `refused`, with fixed phase/member causes, and success requires final verification.",
	],
	[
		"prior-attestation ownership limit and occupant precedence",
		"Prior attestation plus current byte equality proves ownership of exact old bytes; it is not a general overwrite license. Foreign or locally customized bytes win and are never overwritten.",
	],
	[
		"idempotence and exclusion at creation",
		"Install and registration are idempotent. Carried files and shell-created state are excluded at creation.",
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

function filesBelow(root: string): string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		return entry.isDirectory() ? filesBelow(path) : [path];
	});
}

test("#249 keeps current source-bound candidates out of handoff until #251", () => {
	const root = fileURLToPath(new URL("..", import.meta.url));
	const paths = [
		...filesBelow(join(root, ".github")),
		...filesBelow(join(root, ".githooks")),
		join(root, "changelog_unreleased/TEMPLATE.md"),
	];
	for (const path of paths) {
		assert.equal(classifyMarker(readFileSync(path, "utf8")), "source-only", path);
	}
});
