/**
 * #412 (part 2 of #370): the opt-in Pi dispatch clause in SPEC §4.9, pinned as
 * contract text before any of its runtime lands. Both paragraphs are pinned
 * byte-for-byte inside §4.9, and the sentence that denies this transport any
 * missing-submission continuation of its own is pinned by literal, because
 * #375's landed §1.7 makes the shared one-retry state the only automatic second
 * send. The runtime suffix-bytes lock lands with its constant in part 7.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../SPEC.md", import.meta.url)), "utf8");

const OPT_IN =
	"**Opt-in Pi operator-attached dispatch.** An internal consumer may explicitly choose a Pi RPC subprocess instead of the generic argv executor; the generic tool and its direct return writer keep their existing contract. The Pi child runs in the same pinned, route-severed clone with the same scrubbed environment, state seam, deadline and process-group abort/timeout/finite-flush bounds. Its only loaded submission extension is provisioned by the caller outside the reviewed tree; project extension discovery is disabled. RPC stdout is continuously drained as bounded LF-framed JSONL, stderr is continuously drained without model-visible content, and malformed or unfinished framing refuses the run. A settled agent or successful RPC response is not a return.";
const PLANES =
	"Observation, control and result are distinct planes. Bounded assistant/tool events and an in-memory attachable view are operator-only, never model context, session transcript, final dispatch content/details, audit text, compare input or submitted payload. Explicit steer, follow-up, queue-clear, detach/reattach and abort operate on the child without pausing its deadline or changing the caller's session. Detach does not interrupt draining; abort takes precedence over a submitted slot until the process has settled. No artifact asserts that the delegate was unsteered. The caller selects one closed `submit_result` profile for reviewer, Judge, history diagnosis, or a recovery phase; the delegate neither chooses its role nor receives the held compare operand. The trusted tool validates its typed fields, resolves clone HEAD independently, preflights operand leakage and byte bounds, and installs the existing return slot atomically. A missing submission receives no continuation from this transport and is never a result by inference: §1.7's shared one-retry state is the only automatic second send, and this layer neither adds to it nor replenishes it. Final return admission, validity-only held-head comparison and the consuming role's parser remain authoritative. The trusted tool is the intended producer, not a filesystem-confinement claim: a same-domain child can directly write a valid return slot, which the existing output-validity rule admits and the consumer still parses. No Pi RPC event proves exclusive tool authorship. Preventing that residual requires a separately authorized isolation/provenance boundary, not an invented claim from the current subprocess. Operator UI is an additional opt-in project command subject to §4.8's governed home; it does not reinterpret §5.9's existing partial-result boundary. This clause activates only with its implementing derivation, never from this contract text alone (§5.3).";
const NO_CONTINUATION =
	"A missing submission receives no continuation from this transport and is never a result by inference";
const ACTIVATION =
	"This clause activates only with its implementing derivation, never from this contract text alone (§5.3).";

/** Section 4.9, from its heading to the next heading of the same or higher level. */
function delegationLayer(text: string): string {
	const begin = text.indexOf("### 4.9 The delegation layer");
	if (begin < 0) return "";
	const next = text.slice(begin + 1).search(/\n##?#? /);
	return next < 0 ? text.slice(begin) : text.slice(begin, begin + 1 + next);
}

function settled(text: string): string[] {
	const found: string[] = [];
	const section = delegationLayer(text);
	const paragraphs = section.split("\n");
	for (const [name, paragraph] of [
		["opt-in paragraph", OPT_IN],
		["planes paragraph", PLANES],
	] as const) {
		const inSection = paragraphs.filter((line) => line === paragraph).length;
		const inDocument = text.split("\n").filter((line) => line === paragraph).length;
		if (inSection !== 1 || inDocument !== 1) found.push(`${name} is not exactly once, byte-identical, in §4.9`);
	}
	const shape = section.indexOf("**The delegate's shape, measured.**");
	const optIn = section.indexOf(OPT_IN);
	const planes = section.indexOf(PLANES);
	const drift = section.indexOf("**Drift.**");
	if (!(shape >= 0 && shape < optIn && optIn < planes && planes < drift))
		found.push("the clause does not sit after the measured shape and before Drift, in order");
	if (!PLANES.includes(NO_CONTINUATION)) found.push("the no-continuation sentence is not in the planes paragraph");
	if (!PLANES.endsWith(ACTIVATION)) found.push("the activation sentence does not close the clause");
	return found;
}

test("SPEC §4.9 carries the opt-in Pi dispatch clause exactly, in place", () => {
	assert.deepEqual(settled(source), []);
});

test("baseline-first isolated SPEC mutants kill each named weakening of the clause", () => {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-412-pi-clause-"));
	try {
		const path = join(scratch, "SPEC.md");
		writeFileSync(path, source);
		assert.deepEqual(settled(readFileSync(path, "utf8")), [], "baseline must be green in the same copy");
		const outsideSection = source
			.replace(`${OPT_IN}\n\n`, () => "")
			.replace("## 5. Cross-cutting contracts", () => `${OPT_IN}\n\n## 5. Cross-cutting contracts`);
		const mutants: ReadonlyArray<readonly [string, string]> = [
			["opt-in paragraph deleted", source.replace(`${OPT_IN}\n\n`, () => "")],
			["planes paragraph deleted", source.replace(`${PLANES}\n\n`, () => "")],
			["opt-in paragraph moved out of §4.9", outsideSection],
			[
				"no-continuation sentence inverted",
				source.replace(NO_CONTINUATION, () => "A missing submission may receive one bounded continuation"),
			],
			["activation sentence dropped", source.replace(` ${ACTIVATION}`, () => "")],
		];
		for (const [label, mutated] of mutants) {
			assert.notEqual(mutated, source, `${label}: the mutant must change the text`);
			writeFileSync(path, mutated);
			assert.notDeepEqual(settled(readFileSync(path, "utf8")), [], `surviving mutant: ${label}`);
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});
