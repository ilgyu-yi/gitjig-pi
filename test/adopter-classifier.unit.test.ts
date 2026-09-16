import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	classifyCandidate,
	classifyMarker,
	decodeCandidatePath,
	type Membership,
	observeCandidates,
	renderMembershipSnapshot,
} from "../.pi/extensions/gitjig/install/classifier.ts";

let root: string;
before(() => {
	root = mkdtempSync(join(tmpdir(), "gitjig-classifier-"));
});
after(() => {
	rmSync(root, { recursive: true, force: true });
});
function put(rel: string, bytes: string | Buffer): void {
	const path = join(root, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, bytes);
}

describe("#250 exact source-only marker and ordered classifier", () => {
	it("accepts only the two terminated declarations in their eligible positions", () => {
		for (const body of [
			"# gitjig: source-only\n",
			"# gitjig: source-only\r\n",
			"// gitjig: source-only\n",
			"#!/bin/sh\n# gitjig: source-only\n",
			"#!/bin/sh\n// gitjig: source-only\n",
			"#!/bin/sh\r\n# gitjig: source-only\r\n",
			"#!/bin/sh\r\n// gitjig: source-only\r\n",
		])
			assert.equal(classifyMarker(Buffer.from(body)), "source-only");
		for (const body of [
			"# gitjig: source-only",
			" # gitjig: source-only\n",
			"# gitjig: source-only extra\n",
			"#!/bin/sh\n# gitjig: source only\n",
			"\ufeff# gitjig: source-only\n",
		])
			assert.equal(classifyMarker(Buffer.from(body)), "refuse");
		assert.throws(() =>
			classifyMarker(Buffer.from([0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e, 0x2f, 0x73, 0x68, 0x0a, 0xff, 0x0a])),
		);
		assert.equal(classifyMarker(Buffer.from("name: x\n# gitjig: source-only\n")), "absent");
		assert.equal(classifyMarker(Buffer.from("#!/usr/bin/env gitjig:")), "absent");
	});

	it("classifies every settled path branch in order", () => {
		assert.equal(classifyCandidate(".pi/extensions/gitjig.ts", Buffer.from("x\n")), "carried");
		assert.equal(classifyCandidate(".pi/extensions/gitjig/a.ts", Buffer.from("x\n")), "carried");
		assert.equal(classifyCandidate(".pi/prompts/x.md", Buffer.from("x\n")), "carried");
		assert.equal(classifyCandidate(".pi/unknown.txt", Buffer.from("x\n")), "refuse");
		assert.equal(classifyCandidate(".github/workflows/x.yml", Buffer.from("x\n")), "handed-over");
		assert.equal(classifyCandidate(".githooks/pre-commit", Buffer.from("x\n")), "handed-over");
		assert.equal(classifyCandidate("changelog_unreleased/TEMPLATE.md", Buffer.from("x\n")), "handed-over");
		assert.equal(classifyCandidate("changelog_unreleased/added/x.md", Buffer.from("x\n")), "instance-state");
		assert.equal(classifyCandidate(".github/x", Buffer.from("# gitjig: source-only\n")), "source-only");
	});

	it("refuses invalid canonical path components", () => {
		for (const path of [
			"/x",
			".github//x",
			".github/./x",
			".github/../x",
			".github\\x",
			".github/x\0y",
			".github/e\u0301",
			".github/\ud800",
			".github/\udc00",
			"outside/file",
		])
			assert.throws(() => classifyCandidate(path, Buffer.from("x\n")));
	});
});

describe("#250 candidate observation and checked snapshot", () => {
	it("refuses a symlink reached before filtering", () => {
		put(".pi/extensions/gitjig.ts", "x\n");
		mkdirSync(join(root, ".github"), { recursive: true });
		symlinkSync(join(root, ".pi/extensions/gitjig.ts"), join(root, ".github/link"));
		assert.throws(() => observeCandidates(root), /symlink|non-regular/);
	});

	it("refuses a regular file exchanged for a symlink after lstat", () => {
		const fixture = mkdtempSync(join(tmpdir(), "gitjig-race-"));
		const candidate = join(fixture, ".github/race");
		const outside = join(fixture, "outside");
		mkdirSync(dirname(candidate), { recursive: true });
		writeFileSync(candidate, "inside");
		writeFileSync(outside, "outside");
		try {
			assert.throws(
				() =>
					observeCandidates(fixture, {
						afterLstat(path) {
							if (path === ".github/race") {
								rmSync(candidate);
								symlinkSync(outside, candidate);
							}
						},
					}),
				/replaced|changed|unreadable/,
			);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("refuses post-read pathname and post-walk directory identity or membership changes", () => {
		for (const phase of ["file", "pathname", "directory", "membership"] as const) {
			const fixture = mkdtempSync(join(tmpdir(), `gitjig-post-${phase}-`));
			const directory = join(fixture, ".github");
			const candidate = join(directory, "a");
			mkdirSync(directory);
			writeFileSync(candidate, "x");
			try {
				assert.throws(
					() =>
						observeCandidates(
							fixture,
							phase === "file" || phase === "pathname"
								? {
										afterRead(path) {
											if (path !== ".github/a") return;
											if (phase === "file") chmodSync(candidate, 0o600);
											else {
												renameSync(candidate, join(fixture, "old"));
												writeFileSync(candidate, "new");
											}
										},
									}
								: {
										afterDirectoryRead(path) {
											if (path !== ".github") return;
											if (phase === "directory") {
												renameSync(directory, `${directory}-old`);
												mkdirSync(directory);
												writeFileSync(candidate, "x");
											} else writeFileSync(join(directory, "added"), "new");
										},
									},
						),
					/identity|membership/,
				);
			} finally {
				rmSync(fixture, { recursive: true, force: true });
			}
		}
	});

	it("refuses non-regular, unreadable, and non-UTF-8 candidates", () => {
		assert.throws(() => decodeCandidatePath(Buffer.concat([Buffer.from(".github/"), Buffer.from([0xff])])), /UTF-8/);
		for (const shape of ["non-regular", "unreadable"] as const) {
			const fixture = mkdtempSync(join(tmpdir(), `gitjig-${shape}-`));
			mkdirSync(join(fixture, ".github"), { recursive: true });
			try {
				if (shape === "non-regular") {
					assert.equal(spawnSync("mkfifo", [join(fixture, ".github", "pipe")]).status, 0);
				} else {
					writeFileSync(join(fixture, ".github", "closed"), "x");
					chmodSync(join(fixture, ".github", "closed"), 0);
				}
				assert.throws(() => observeCandidates(fixture), /refused/);
			} finally {
				rmSync(fixture, { recursive: true, force: true });
			}
		}
	});

	it("renders the closed sorted snapshot", () => {
		const rendered = renderMembershipSnapshot([
			{ path: ".pi/prompts/z.md", disposition: "carried" },
			{ path: ".github/a", disposition: "source-only" },
		]);
		assert.throws(() => renderMembershipSnapshot([{ path: "../outside", disposition: "carried" }]));
		assert.throws(() =>
			renderMembershipSnapshot([{ path: ".github/a", disposition: "invalid" as Membership["disposition"] }]),
		);
		assert.throws(() =>
			renderMembershipSnapshot([{ path: ".github/a", disposition: "handed-over", extra: true } as Membership]),
		);
		const byteOrdered = JSON.parse(
			renderMembershipSnapshot([
				{ path: ".github/\u{10000}", disposition: "handed-over" },
				{ path: ".github/\ue000", disposition: "handed-over" },
			]),
		) as { members: Membership[] };
		assert.deepEqual(
			byteOrdered.members.map((member) => member.path),
			[".github/\ue000", ".github/\u{10000}"],
		);
		assert.deepEqual(JSON.parse(rendered), {
			schemaVersion: 1,
			members: [
				{ path: ".github/a", disposition: "source-only" },
				{ path: ".pi/prompts/z.md", disposition: "carried" },
			],
		});
	});

	it("reconstructs the committed all-disposition snapshot byte-for-byte", () => {
		const repository = fileURLToPath(new URL("..", import.meta.url));
		const actual = renderMembershipSnapshot(
			observeCandidates(repository).map(({ path, disposition }) => ({ path, disposition })),
		);
		assert.equal(actual, readFileSync(join(repository, "test/fixtures/adopter-membership.snapshot.json"), "utf8"));
	});
});
