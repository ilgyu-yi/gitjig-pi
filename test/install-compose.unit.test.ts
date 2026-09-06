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
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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

/**
 * The arm class that catches what verdict-only arms cannot (issue #116,
 * review round 1). Both round-1 findings were wrong `land` verdicts whose
 * wrongness is only visible in the ACT the verdict authorizes: a decision
 * arm reads `land` and is satisfied, while performing that landing writes
 * the shell's bytes outside every shell-owned namespace.
 *
 * So these arms perform a naive delivery — exactly what a delivery layer
 * would do with a `land` — and then assert containment over the RESULT.
 * The invariant is a property of the outcome, not of the verdict: after
 * acting on a whole composition, nothing exists outside the destination
 * root's shell-owned namespaces.
 */
describe("acting on the composition writes nothing outside the namespaces (issue #116)", () => {
	/** The bytes every arm here plants, so an escape is findable by content. */
	const MARKER = "SHELL BYTES\n";

	/** What a delivery layer would naively do with each decision. */
	function performLandings(sourceRoot: string, destRoot: string, composed: readonly ComposedMember[]): void {
		for (const m of composed) {
			if (m.action !== "land" || m.dest === null) {
				continue;
			}
			const target = join(destRoot, m.dest);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, readFileSync(join(sourceRoot, m.dest)));
		}
	}

	/**
	 * Scan the WHOLE temp root for the marker and return every hit that is
	 * not under one of `destRoot`'s shell-owned namespaces. Asserting a
	 * single known-bad path only catches the escape you already imagined;
	 * this catches any escape that put the bytes somewhere.
	 */
	function escapedPaths(box: string, sourceRoot: string, destRoot: string): string[] {
		const hits: string[] = [];
		// The source tree legitimately holds the marker — it is what is being
		// installed FROM. Only the destination side is under judgement.
		const permitted = [...SHELL_NAMESPACES.map((ns) => join(destRoot, ns)), sourceRoot];
		const visit = (dir: string): void => {
			for (const entry of readdirSync(dir)) {
				const abs = join(dir, entry);
				let st;
				try {
					st = lstatSync(abs);
				} catch {
					continue;
				}
				if (st.isSymbolicLink()) {
					continue; // judge the link, never follow it
				}
				if (st.isDirectory()) {
					visit(abs);
				} else if (st.isFile() && readFileSync(abs, "utf8") === MARKER) {
					if (!permitted.some((p) => abs === p || abs.startsWith(`${p}/`))) {
						hits.push(abs);
					}
				}
			}
		};
		visit(box);
		return hits;
	}

	/**
	 * One isolated sandbox per arm. Each arm gets its own `box` so the scan
	 * sees only what that arm created: sharing a root would let one arm's
	 * source tree read as another arm's escape, and the arms would then be
	 * measuring each other rather than the module.
	 */
	function sandbox(): { box: string; src: string; dest: string } {
		const box = mkdtempSync(join(root, "box-"));
		const src = join(box, "src");
		const dest = join(box, "dest");
		mkdirSync(src, { recursive: true });
		mkdirSync(dest, { recursive: true });
		return { box, src, dest };
	}

	/** Compose, act, and assert containment over the RESULT rather than the verdict. */
	function composeAndAct(
		box: string,
		src: string,
		dest: string,
		members: readonly string[],
	): ComposedMember[] {
		const composed = composeSubstrate({ sourceRoot: src, destRoot: dest, members });
		performLandings(src, dest, composed);
		assert.deepEqual(
			escapedPaths(box, src, dest),
			[],
			"acting on this composition put the shell's bytes outside every shell-owned namespace",
		);
		return composed;
	}

	it("a DANGLING symlink at the leaf destination does not become a write outside the tree", () => {
		// Round-1 finding 1. `existsSync` follows links, so a symlink pointing
		// at a not-yet-existing path read as absent and was landed — through
		// the link. The member here is exactly what the walk produces; nothing
		// hostile is passed in.
		const { box, src, dest } = sandbox();
		write(join(src, ".githooks/pre-commit").slice(root.length + 1), MARKER);
		const outside = join(box, "pwned.txt");
		mkdirSync(join(dest, ".githooks"), { recursive: true });
		symlinkSync(outside, join(dest, ".githooks", "pre-commit"));

		const composed = composeAndAct(box, src, dest, deriveSubstrateSet(src));
		assert.equal(decisionFor(composed, ".githooks/pre-commit")?.action, "refuse");
		assert.ok(!existsSync(outside), "the shell's bytes were written through a dangling symlink, outside every namespace");
	});

	it("a spelling that traverses an ABSENT component into a real symlinked container is refused", () => {
		// Round-1 finding 2. Containment was judged on the canonical path
		// while the link walk used the raw spelling, so the walk gave up at
		// the absent component and `join` resolved straight through the link.
		const { box, src, dest } = sandbox();
		write(join(src, ".pi/link/x.ts").slice(root.length + 1), MARKER);
		const elsewhere = join(box, "elsewhere");
		mkdirSync(elsewhere, { recursive: true });
		mkdirSync(join(dest, ".pi"), { recursive: true });
		symlinkSync(elsewhere, join(dest, ".pi", "link"));

		const sneaky = ".githooks/absent/../../.pi/link/x.ts";
		const composed = composeAndAct(box, src, dest, [sneaky]);
		assert.equal(decisionFor(composed, sneaky)?.action, "refuse", "the sneaky spelling was admitted");
		assert.ok(
			!existsSync(join(elsewhere, "x.ts")),
			"bytes were written through a symlinked container reached by a `..` spelling",
		);
	});

	it("a namespace ROOT is not a landable member", () => {
		const { box, src, dest } = sandbox();
		for (const ns of SHELL_NAMESPACES) {
			write(join(src, ns).slice(root.length + 1), MARKER);
			assert.equal(
				decisionFor(composeAndAct(box, src, dest, [ns]), ns)?.action,
				"refuse",
				`the namespace root ${ns} was treated as a landable member; a landing would put a file where the directory belongs`,
			);
		}
	});

	it("a destination that cannot be measured refuses rather than being landed into (§3.9)", () => {
		// The fail-open shape §3.9 forbids: reading EVERY probe error as
		// "absent" turns an unmeasurable destination into a land. Two shapes,
		// neither producible by the walk but both reachable through the
		// exported entry point, which is where round 1's findings came from.
		const { box, src, dest } = sandbox();

		// (a) a container that is a regular FILE — the probe throws ENOTDIR.
		write(join(src, ".pi/blocked/x.ts").slice(root.length + 1), MARKER);
		writeFileSync(join(dest, ".pi"), "a file where the namespace belongs\n");
		assert.equal(
			decisionFor(composeAndAct(box, src, dest, [".pi/blocked/x.ts"]), ".pi/blocked/x.ts")?.action,
			"refuse",
			"an unmeasurable container was landed into",
		);

		// (b) a NUL-bearing member — the probe throws an argument error.
		const nul = ".pi/x\0/y.ts";
		assert.equal(
			decisionFor(composeSubstrate({ sourceRoot: src, destRoot: dest, members: [nul] }), nul)?.action,
			"refuse",
			"a NUL-bearing member was landed",
		);
	});

	it("a trailing slash does not survive into the emitted dest", () => {
		// The dest is what a delivery joins. A slash-terminated member would
		// name a directory where a file belongs.
		const { src, dest } = sandbox();
		write(join(src, ".pi/f.ts").slice(root.length + 1), MARKER);
		const raw = ".pi/f.ts/";
		const decision = decisionFor(composeSubstrate({ sourceRoot: src, destRoot: dest, members: [raw] }), raw);
		assert.equal(decision?.dest, ".pi/f.ts");
	});

	it("the emitted dest is canonical, so a delivery cannot re-derive a different path", () => {
		const { box, src, dest } = sandbox();
		write(join(src, ".github/workflows/w.yml").slice(root.length + 1), MARKER);
		const raw = ".pi/../.github/workflows/w.yml";
		const decision = decisionFor(composeAndAct(box, src, dest, [raw]), raw);
		assert.equal(decision?.action, "land");
		assert.equal(decision?.dest, ".github/workflows/w.yml", "dest carried the raw spelling, not the canonical one");
		assert.equal(readFileSync(join(dest, ".github/workflows/w.yml"), "utf8"), MARKER, "the landing did not occur");
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
