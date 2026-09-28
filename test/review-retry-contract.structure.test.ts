import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../SPEC.md", import.meta.url)), "utf8");
const generic = String.raw`\n\nReturn protocol reminder: write a complete provisional ../return.json early and overwrite it with the final closed-schema return.`;
const pi = String.raw`\n\nPi return protocol reminder: use only submit_result to send your final typed fields; do not write ../return.json directly.`;

function settled(text: string): boolean {
	const begin = text.indexOf("**The automatic return-protocol redispatch.**");
	const end = text.indexOf("Immediately before the second send", begin);
	if (begin < 0 || end <= begin) return false;
	const section = text.slice(begin, end);
	return [
		"when the dispatcher's first result records a numeric exit and a missing return, the review orchestrator retries exactly once",
		"changes it to `spent` before its one retry",
		"For generic argv calls, the standing brief contract instructs",
		"For explicitly selected Pi RPC calls only, the standing brief instead instructs",
		"the invocation-bound `submit_result` tool, not to write `../return.json` directly",
		"no provisional file is required from that child",
		"appending exactly one transport-selected suffix",
		`Generic argv retains exactly this suffix: \`${generic}\``,
		`Explicitly selected Pi RPC uses exactly this suffix instead: \`${pi}\``,
		"the selected suffix is the only brief change",
		"The Pi subprocess itself adds no second missing-submission continuation",
		"no third send occurs for that call",
	].every((term) => section.includes(term));
}

test("settled §1.7 selects exact generic and Pi retry contracts without another retry", () => {
	assert.equal(settled(source), true);
	assert.equal(generic.replaceAll(String.raw`\n`, "\n").startsWith("\n\nReturn protocol reminder:"), true);
	assert.equal(pi.replaceAll(String.raw`\n`, "\n").startsWith("\n\nPi return protocol reminder:"), true);
});

test("baseline-first isolated SPEC mutations kill either branch and retry-bound drift", () => {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-375-retry-contract-"));
	try {
		const path = join(scratch, "SPEC.md");
		writeFileSync(path, source);
		assert.equal(settled(readFileSync(path, "utf8")), true, "baseline must be green in the same copy");
		for (const [from, to] of [
			[`Generic argv retains exactly this suffix: \`${generic}\``, "Generic argv uses an unspecified reminder"],
			[
				`Explicitly selected Pi RPC uses exactly this suffix instead: \`${pi}\``,
				"Pi RPC uses generic direct-file retry",
			],
			["no provisional file is required from that child", "a provisional file is also required from that child"],
			["appending exactly one transport-selected suffix", "appending an arbitrary delegate-selected suffix"],
			[
				"The Pi subprocess itself adds no second missing-submission continuation",
				"The Pi subprocess adds another missing-submission continuation",
			],
			["no third send occurs for that call", "unbounded sends occur for that call"],
		] as const) {
			assert.ok(source.indexOf(from) >= 0 && source.indexOf(from) === source.lastIndexOf(from), `unique: ${from}`);
			writeFileSync(path, source.replace(from, to));
			assert.equal(settled(readFileSync(path, "utf8")), false, `surviving mutant: ${from}`);
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});
