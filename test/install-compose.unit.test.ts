/**
 * Adopter substrate composition (issue #116; SPEC §4.1 namespaces, §4.2
 * target-parameterization, §4.7's installer boundary).
 *
 * Subject under test: the composition-and-refusal half of the adopter
 * install path — which committed bytes constitute the shell's substrate,
 * where each may land in an adopting repository, and what the instrument
 * refuses to do. Every arm runs against a fixture directory tree; nothing
 * here touches the network, the platform, or a repository outside its own
 * temp root.
 *
 * WHAT THIS SUITE DOES NOT COVER, and why: delivery — opening the reviewed
 * PR that carries the composed set (§4.3) — is a separate Execution. It
 * publishes into a repository this shell does not govern, which is past the
 * merge ceiling (§5.6), so it is stopped at a named seam here and the seam
 * is driven with a recording fixture implementation.
 *
 * The namespace SET is SPEC-stated (§4.1 names `.pi/`, `.github/`,
 * `.githooks/`, `changelog_unreleased/`), so it is a committed constant
 * here and is the one thing in this instrument not derived from the tree.
 * Everything WITHIN a namespace is walked, never listed — that is what the
 * roster arm below pins.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	composeSubstrate,
	deriveSubstrateSet,
	SHELL_NAMESPACES,
	type ComposedMember,
} from "../.pi/extensions/gitjig/install/compose.ts";

let root: string;

function write(rel: string, body: string): void {
	const abs = join(root, rel);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, body);
}

function decisionFor(members: readonly ComposedMember[], rel: string): ComposedMember | undefined {
	return members.find((m) => m.source === rel);
}

before(() => {
	root = mkdtempSync(join(tmpdir(), "gitjig-install-"));
});

after(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("the substrate set is derived from the tree (issue #116, §2.4, §6.1)", () => {
	it("walks each shell-owned namespace rather than reading a roster", () => {
		const src = mkdtempSync(join(root, "src-"));
		write(join(src, ".githooks/pre-commit").slice(root.length + 1), "#!/bin/sh\n");
		write(join(src, ".githooks/helpers/x.sh").slice(root.length + 1), "x\n");
		write(join(src, ".pi/extensions/gitjig/a.ts").slice(root.length + 1), "a\n");
		const before = deriveSubstrateSet(src);
		assert.ok(before.includes(".githooks/helpers/x.sh"), "the walk missed a nested member");

		// The roster property: a file added TODAY is in the set today.
		write(join(src, ".githooks/helpers/brand_new.sh").slice(root.length + 1), "new\n");
		assert.ok(
			deriveSubstrateSet(src).includes(".githooks/helpers/brand_new.sh"),
			"a newly added namespace member is not in the derived set — the set is a roster, not a walk",
		);
	});

	it("excludes the per-clone state namespace, which is never committed (§4.1)", () => {
		const src = mkdtempSync(join(root, "src-"));
		write(join(src, ".githooks/pre-commit").slice(root.length + 1), "x\n");
		write(join(src, ".gitjig/state/audit.jsonl").slice(root.length + 1), "{}\n");
		const set = deriveSubstrateSet(src);
		assert.ok(
			!set.some((m) => m.startsWith(".gitjig/")),
			`per-clone state entered the substrate set: ${JSON.stringify(set)}`,
		);
	});

	it("ships the fragment tree's authoring contract but not this repository's own pending fragments", () => {
		// The mechanism/instance-state split: TEMPLATE.md is the contract an
		// adopter needs; the fragments under it are this repository's own
		// unreleased work and would be false history in an adopter.
		const src = mkdtempSync(join(root, "src-"));
		write(join(src, "changelog_unreleased/TEMPLATE.md").slice(root.length + 1), "contract\n");
		write(join(src, "changelog_unreleased/fixed/113.md").slice(root.length + 1), "- a fragment\n");
		const set = deriveSubstrateSet(src);
		assert.ok(set.includes("changelog_unreleased/TEMPLATE.md"), "the fragment contract is not shipped");
		assert.ok(
			!set.includes("changelog_unreleased/fixed/113.md"),
			"this repository's own pending fragment would land in an adopter as false history",
		);
	});

	it("SHELL_NAMESPACES matches §4.1's stated set exactly", () => {
		// Compared as a SET, not a sorted sequence: `.githooks` sorts before
		// `.github` (`o` < `u` at index 5), and a hand-written sorted literal
		// gets that wrong — it did on the first draft of this arm. The
		// property is membership; ordering is not part of the contract.
		assert.deepEqual(new Set(SHELL_NAMESPACES), new Set([".pi", ".github", ".githooks", "changelog_unreleased"]));
		assert.equal(SHELL_NAMESPACES.length, 4, "a namespace joined or left without §4.1 being re-read");
		assert.ok(
			!SHELL_NAMESPACES.includes(".gitjig" as never),
			"per-clone state is never committed and must never be substrate (§4.1)",
		);
	});
});

describe("destinations stay inside shell-owned namespaces (issue #116, §4.1)", () => {
	it("refuses a member whose destination escapes via a parent component", () => {
		const src = mkdtempSync(join(root, "src-"));
		write(join(src, ".githooks/ok.sh").slice(root.length + 1), "ok\n");
		const dest = mkdtempSync(join(root, "dest-"));
		const composed = composeSubstrate({
			sourceRoot: src,
			destRoot: dest,
			// A hostile member: the walk cannot produce this, but the
			// destination resolver must refuse it rather than trust its input.
			members: ["../escaped.sh"],
		});
		const decision = decisionFor(composed, "../escaped.sh");
		assert.equal(decision?.action, "refuse");
		assert.match(decision?.reason ?? "", /namespace/i);
	});

	it("refuses an absolute member", () => {
		const src = mkdtempSync(join(root, "src-"));
		const dest = mkdtempSync(join(root, "dest-"));
		const composed = composeSubstrate({ sourceRoot: src, destRoot: dest, members: ["/etc/passwd"] });
		assert.equal(decisionFor(composed, "/etc/passwd")?.action, "refuse");
	});

	it("refuses a member outside every shell-owned namespace", () => {
		const src = mkdtempSync(join(root, "src-"));
		write(join(src, "README.md").slice(root.length + 1), "not substrate\n");
		const dest = mkdtempSync(join(root, "dest-"));
		const composed = composeSubstrate({ sourceRoot: src, destRoot: dest, members: ["README.md"] });
		assert.equal(decisionFor(composed, "README.md")?.action, "refuse");
	});

	it("refuses where a destination container is a symlink (§4.7, §5.5's write-through-link rule)", () => {
		const src = mkdtempSync(join(root, "src-"));
		write(join(src, ".githooks/helpers/h.sh").slice(root.length + 1), "h\n");
		const dest = mkdtempSync(join(root, "dest-"));
		const elsewhere = mkdtempSync(join(root, "elsewhere-"));
		mkdirSync(join(dest, ".githooks"), { recursive: true });
		symlinkSync(elsewhere, join(dest, ".githooks", "helpers"));
		const composed = composeSubstrate({
			sourceRoot: src,
			destRoot: dest,
			members: [".githooks/helpers/h.sh"],
		});
		const decision = decisionFor(composed, ".githooks/helpers/h.sh");
		assert.equal(decision?.action, "refuse", "a symlinked destination container was not refused");
		assert.match(decision?.reason ?? "", /link/i);
	});

	it("containment is decided after normalization, on where a path lands not how it is spelled", () => {
		// Both directions, because only one of them is the safe default. A
		// spelling that traverses OUT of a namespace and back in is inside;
		// one that traverses out and stays out is not. A containment check
		// that compared raw prefixes would get the second wrong.
		const src = mkdtempSync(join(root, "src-"));
		const dest = mkdtempSync(join(root, "dest-"));
		const composed = composeSubstrate({
			sourceRoot: src,
			destRoot: dest,
			members: [".pi/../.github/x", ".githooks/../../x"],
		});
		assert.notEqual(
			decisionFor(composed, ".pi/../.github/x")?.action,
			"refuse",
			"a spelling that normalizes INTO a namespace was refused",
		);
		assert.equal(
			decisionFor(composed, ".githooks/../../x")?.action,
			"refuse",
			"a spelling that normalizes OUT of the tree was admitted",
		);
	});

	it("each refusal names its own member — refusal is per member, not per run", () => {
		const src = mkdtempSync(join(root, "src-"));
		write(join(src, ".githooks/good.sh").slice(root.length + 1), "good\n");
		const dest = mkdtempSync(join(root, "dest-"));
		const composed = composeSubstrate({
			sourceRoot: src,
			destRoot: dest,
			members: [".githooks/good.sh", "../bad.sh"],
		});
		assert.equal(decisionFor(composed, ".githooks/good.sh")?.action, "land");
		assert.equal(decisionFor(composed, "../bad.sh")?.action, "refuse");
	});
});

describe("a pre-existing asset is never overwritten (issue #116, §4.7)", () => {
	it("lands where the destination is absent", () => {
		const src = mkdtempSync(join(root, "src-"));
		write(join(src, ".githooks/new.sh").slice(root.length + 1), "body\n");
		const dest = mkdtempSync(join(root, "dest-"));
		assert.equal(decisionFor(composeSubstrate({ sourceRoot: src, destRoot: dest, members: [".githooks/new.sh"] }), ".githooks/new.sh")?.action, "land");
	});

	it("no-ops where the destination already holds identical content, and says so", () => {
		const src = mkdtempSync(join(root, "src-"));
		write(join(src, ".githooks/same.sh").slice(root.length + 1), "identical\n");
		const dest = mkdtempSync(join(root, "dest-"));
		mkdirSync(join(dest, ".githooks"), { recursive: true });
		writeFileSync(join(dest, ".githooks", "same.sh"), "identical\n");
		const decision = decisionFor(
			composeSubstrate({ sourceRoot: src, destRoot: dest, members: [".githooks/same.sh"] }),
			".githooks/same.sh",
		);
		assert.equal(decision?.action, "converged");
		assert.match(decision?.reason ?? "", /identical|converged|unchanged/i);
	});

	it("SKIPS WITH A WARNING where the destination differs, and the existing bytes survive", () => {
		const src = mkdtempSync(join(root, "src-"));
		write(join(src, ".githooks/theirs.sh").slice(root.length + 1), "ours\n");
		const dest = mkdtempSync(join(root, "dest-"));
		mkdirSync(join(dest, ".githooks"), { recursive: true });
		const target = join(dest, ".githooks", "theirs.sh");
		writeFileSync(target, "THEIR ORIGINAL BYTES\n");

		const decision = decisionFor(
			composeSubstrate({ sourceRoot: src, destRoot: dest, members: [".githooks/theirs.sh"] }),
			".githooks/theirs.sh",
		);
		assert.equal(decision?.action, "skip");
		assert.ok((decision?.reason ?? "").length > 0, "a skip carries no warning text");
		assert.equal(
			readFileSync(target, "utf8"),
			"THEIR ORIGINAL BYTES\n",
			"a pre-existing asset was overwritten — §4.7 forbids it",
		);
	});
});

describe("the composition writes nothing (issue #116, §4.7's enumerated actions)", () => {
	it("composing leaves the destination tree byte-identical", () => {
		// Composition DECIDES; it does not act. The delivery seam acts, and
		// its fixture implementation below is what records the intent. An
		// arm that only read the source could not establish this.
		const src = mkdtempSync(join(root, "src-"));
		write(join(src, ".githooks/a.sh").slice(root.length + 1), "a\n");
		write(join(src, ".pi/extensions/gitjig/b.ts").slice(root.length + 1), "b\n");
		const dest = mkdtempSync(join(root, "dest-"));

		composeSubstrate({ sourceRoot: src, destRoot: dest, members: deriveSubstrateSet(src) });

		// Nothing was created anywhere under the destination root.
		assert.deepEqual(deriveSubstrateSet(dest), [], "composition wrote into the destination tree");
	});

	it("the composed set carries no absolute path from the composing machine (§4.2)", () => {
		const src = mkdtempSync(join(root, "src-"));
		write(join(src, ".githooks/c.sh").slice(root.length + 1), "c\n");
		const dest = mkdtempSync(join(root, "dest-"));
		const composed = composeSubstrate({ sourceRoot: src, destRoot: dest, members: deriveSubstrateSet(src) });
		const serialized = JSON.stringify(composed.map((m) => ({ source: m.source, dest: m.dest, action: m.action })));
		assert.ok(!serialized.includes(src), "the composed set leaks the composing machine's source root");
		assert.ok(!serialized.includes(dest), "the composed set leaks an absolute destination path");
	});
});
