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
	"The first-clone architecture has exactly that one launcher address",
	"`.pi/extensions/gitjig/install/bootstrap.ts` is not a launcher address, and no redirect or shim address is admitted.",
	'Exact invocation is `env -i PATH="$PATH" HOME="$HOME" LC_ALL=C node .github/bin/gitjig-bootstrap.mjs` with no following argument',
	"the empty environment plus explicit allowlist is part of the invocation and prevents every inherited `NODE_*`, `GIT_*`, loader, coverage, config, and other startup input from acting before the handed launcher can run",
	"Any argument is `invalid-input`.",
	"must be a HEAD-tracked regular blob reached through non-link ancestors, opened no-follow as one-link current-user-owned bytes, no larger than 1 MiB, and byte-equal to the target HEAD blob under pre/post pathname and descriptor identity checks",
	"own `source` object with exactly `provider`, `host`, `owner`, and `repository` and no other own key",
	'`provider: "github"`; `host: "github.com"`',
	"This projection selects acquisition only. After snapshot confirmation, the acquired existing canonical codec and verifier reread the complete target pin and remain the sole integrity admission before mutation.",
	"every HEAD entry is a regular blob mode",
	"every ancestor and working entry is non-link and confined",
	"The complete HEAD and working populations at `.pi/extensions/gitjig.ts` plus `.pi/extensions/gitjig/**` are equal",
	"every working byte equals its HEAD blob",
	"The initial handed process admits only the exact empty-environment invocation above; its first executable step replaces its three admitted startup values with the narrower child allowlist below before any acquisition operation",
	"Every Git child receives EOF on stdin, a 120-second timeout, and independent 1 MiB stdout and stderr caps.",
	"The provision Node child receives EOF, a 300-second timeout, and the same per-stream caps.",
	"they clear inherited `GIT_*`, `NODE_OPTIONS`, `NODE_PATH`, and loader injection",
	"set `GIT_CONFIG_NOSYSTEM=1`, point global config at an owned empty file",
	"its own regular non-link handed path derives the target top, and no ambient or caller-supplied target can redirect it.",
	"creates exactly one `gitjig-acquire-*` child",
	"every artifact from the first successfully created child onward is non-link and current-user-owned where uid exists",
	"every created directory has exact mode `0700`, and every created regular file has exact mode `0600`",
	"Cleanup responsibility begins with that first artifact, is attempted on every controlled terminal, and confirms all owned artifacts absent before success.",
	"abrupt termination is outside the controlled terminal guarantee",
	"Cleanup failure overrides every simultaneous post-creation cause and makes success impossible.",
	"Git errors to `69`",
] as const;

const causes = [
	["invalid-input", "64"],
	["snapshot-identity-mismatch", "65"],
	["source-unavailable", "69"],
	["provision-refused", "70"],
	["temporary-storage-unavailable", "73"],
	["cleanup-failed", "74"],
] as const;
const contradictions = [
	"the carried bootstrap remains the scheduled first-clone launcher",
	"additional source routing keys are accepted",
	"an unexpected cause exits 75",
] as const;

function contractHolds(text: string): boolean {
	if (!anchors.every((anchor) => text.includes(anchor))) return false;
	if (contradictions.some((contradiction) => text.includes(contradiction))) return false;
	const terminal = text.match(/\*\*First-clone terminal algebra\.\*\*([\s\S]*?)\n\nComposition plans/u)?.[1] ?? "";
	const observed = [...terminal.matchAll(/`([a-z-]+)`\/`([0-9]+)`/gu)].map((match) => [match[1], match[2]]);
	return JSON.stringify(observed) === JSON.stringify(causes);
}

it("#363 pins the named first-clone settlement clauses without runtime smuggling", () => {
	assert.equal(contractHolds(spec), true);
	assert.match(readme, /SPEC §§4\.1–4\.2 and 4\.6–4\.7/u);
	assert.equal(existsSync(join(root, ".github/bin/gitjig-bootstrap.mjs")), false);
	assert.equal(existsSync(join(root, ".pi/extensions/gitjig/install/bootstrap.ts")), true);
});

it("#363's representative contract mutants independently break the owner", () => {
	const replacements = [
		[
			"the empty environment plus explicit allowlist is part of the invocation and prevents every inherited `NODE_*`, `GIT_*`, loader, coverage, config, and other startup input from acting before the handed launcher can run",
			"the inherited Node startup environment is accepted",
		],
		["before any acquisition operation", "after acquisition begins"],
		["Any argument is `invalid-input`.", "Arguments may select another source."],
		["and no other own key", "and optional routing keys"],
		['`provider: "github"`; `host: "github.com"`', '`provider: "gitlab"`; `host: "gitlab.com"`'],
		["every HEAD entry is a regular blob mode", "every HEAD entry may be a blob, symlink, or submodule"],
		["every ancestor and working entry is non-link and confined", "ancestors may be linked or escaping"],
		["set `GIT_CONFIG_NOSYSTEM=1`", "permit system Git configuration"],
		["every working byte equals its HEAD blob", "working bytes need only exist"],
		[
			"every artifact from the first successfully created child onward is non-link and current-user-owned where uid exists",
			"created artifacts may be linked or foreign-owned",
		],
		[
			"every created directory has exact mode `0700`, and every created regular file has exact mode `0600`",
			"created directories may use mode `0755` and files mode `0644`",
		],
		["Cleanup responsibility begins with that first artifact", "Cleanup begins after identity confirmation"],
		["Cleanup failure overrides every simultaneous post-creation cause", "The primary cause overrides cleanup failure"],
		["Git errors to `69`", "Git errors to `70`"],
	] as const;
	for (const [needle, replacement] of replacements) {
		assert.equal(spec.split(needle).length, 2, `mutation site must be unique: ${needle}`);
		assert.equal(contractHolds(spec.replace(needle, replacement)), false, `mutant survived: ${needle}`);
	}
	const insertAt = "\n\nComposition plans over the **old and new manifests**";
	for (const contradiction of contradictions) {
		assert.equal(
			contractHolds(spec.replace(insertAt, ` ${contradiction}.${insertAt}`)),
			false,
			`contradictory prose survived: ${contradiction}`,
		);
	}
	const extraCause = spec.replace(
		"`cleanup-failed`/`74` whenever controlled cleanup",
		"`unexpected`/`75` for another cause; and `cleanup-failed`/`74` whenever controlled cleanup",
	);
	assert.equal(contractHolds(extraCause), false, "a seventh terminal cause survived");
});

after(() => {
	assert.equal(contractHolds(spec), true);
});
