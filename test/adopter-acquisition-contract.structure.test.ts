import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const spec = readFileSync(join(root, "SPEC.md"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");

const anchors = [
	"The first-clone acquisition launcher is the self-standing handed-over `.github/bin/gitjig-bootstrap.mjs`",
	"The former carried `.pi/extensions/gitjig/install/bootstrap.ts` retires when that launcher lands, with no redirect or shim.",
	"Exact invocation is `node .github/bin/gitjig-bootstrap.mjs` with no following argument. Any argument is `invalid-input`.",
	"This projection selects acquisition only. After snapshot confirmation, the acquired existing canonical codec and verifier reread the complete target pin and remain the sole integrity admission before mutation.",
	"The complete HEAD and working populations at `.pi/extensions/gitjig.ts` plus `.pi/extensions/gitjig/**` are equal",
	"every working byte equals its HEAD blob",
	"Every Git child receives EOF on stdin, a 120-second timeout, and independent 1 MiB stdout and stderr caps.",
	"The provision Node child receives EOF, a 300-second timeout, and the same per-stream caps.",
	"they clear inherited `GIT_*`, `NODE_OPTIONS`, `NODE_PATH`, and loader injection",
	"its own regular non-link handed path derives the target top, and no ambient or caller-supplied target can redirect it.",
	"creates exactly one `gitjig-acquire-*` child",
	"Cleanup responsibility begins with that first artifact, is attempted on every controlled terminal, and confirms all owned artifacts absent before success.",
	"abrupt termination is outside the controlled terminal guarantee",
	"`invalid-input`/`64`",
	"`snapshot-identity-mismatch`/`65`",
	"`source-unavailable`/`69`",
	"`provision-refused`/`70`",
	"`temporary-storage-unavailable`/`73`",
	"`cleanup-failed`/`74`",
	"Cleanup failure overrides every simultaneous post-creation cause and makes success impossible.",
] as const;

function contractHolds(text: string): boolean {
	return anchors.every((anchor) => text.includes(anchor));
}

it("#363 settles the complete first-clone trust transition without runtime smuggling", () => {
	assert.equal(contractHolds(spec), true);
	assert.match(readme, /SPEC §§4\.1–4\.2 and 4\.6–4\.7/u);
	assert.equal(existsSync(join(root, ".github/bin/gitjig-bootstrap.mjs")), false);
	assert.equal(existsSync(join(root, ".pi/extensions/gitjig/install/bootstrap.ts")), true);
});

it("#363's representative contract mutants independently break the owner", () => {
	const mutations = [
		"Any argument is `invalid-input`.",
		"This projection selects acquisition only.",
		"every working byte equals its HEAD blob",
		"a 120-second timeout",
		"`NODE_OPTIONS`, `NODE_PATH`",
		"Cleanup responsibility begins with that first artifact",
		"`source-unavailable`/`69`",
		"Cleanup failure overrides every simultaneous post-creation cause",
	] as const;
	for (const mutation of mutations) {
		assert.equal(spec.split(mutation).length, 2, `mutation site must be unique: ${mutation}`);
		assert.equal(contractHolds(spec.replace(mutation, "")), false, `mutant survived: ${mutation}`);
	}
});

after(() => {
	assert.equal(contractHolds(spec), true);
});
