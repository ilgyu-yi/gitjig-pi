// The platform half of SPEC §3.3's `merge-review` gate (issue #190,
// Directive #28). DEVELOPMENT AND CI ONLY, the same class suite.yml and
// source-checks.yml declare: this is not substrate, and an adopting
// repository is not meant to receive it. That classification is what
// licenses the import below — a handed-over asset must pass #134's
// excision test, and a merge-review gate is meaningless with the shell
// gone, because the shell is what produces the record it reads.
//
// The predicate is NOT here. §3.11 gives it one home, and this file is a
// call site of it: the shape rule lives in review/record.ts and the gate
// rule in review/merge-gate.ts. What this file owns is exactly the part
// the platform supplies — the comment list and the head under review —
// and the rendering of the verdict. Everything it can get wrong is
// therefore an I/O mistake, not a policy mistake.
//
// Advisory by decision, not by omission (§3.6's born-advisory → measure
// → harden, recorded on issue #190's decision 6): it reports and exits 0
// on refusal. Hardening it into a blocking required check is server
// configuration and the operator's act, and the evidence for that
// decision is the firing record this job starts accumulating.

import { mergeReviewGate } from "../../.pi/extensions/gitjig/review/merge-gate.ts";

const [, , prNumber, head, token, repo] = process.argv;

if (!prNumber || !head || !token || !repo) {
	console.error("::error::check-merge-review: missing one of <pr> <head> <token> <repo>.");
	process.exit(1);
}

/**
 * Fetch the PR's issue comments, following pagination. Every failure is
 * a VALUE, never a throw — §3.7(c) makes lookup failure a refusal the
 * gate reports, and a thrown error would hand the posture to whatever
 * catches it.
 */
async function fetchComments() {
	const bodies = [];
	for (let page = 1; page <= 10; page += 1) {
		const url = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`;
		let response;
		try {
			response = await fetch(url, {
				headers: {
					accept: "application/vnd.github+json",
					authorization: `Bearer ${token}`,
					"x-github-api-version": "2022-11-28",
				},
			});
		} catch (error) {
			return { ok: false, cause: `the comment fetch threw: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (!response.ok) {
			return { ok: false, cause: `the platform answered HTTP ${response.status} for page ${page}` };
		}
		let batch;
		try {
			batch = await response.json();
		} catch (error) {
			return { ok: false, cause: `page ${page} was not JSON: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (!Array.isArray(batch)) {
			return { ok: false, cause: `page ${page} was not a comment array` };
		}
		for (const comment of batch) {
			bodies.push(typeof comment?.body === "string" ? comment.body : "");
		}
		if (batch.length < 100) {
			return { ok: true, bodies };
		}
	}
	// Ten pages exhausted without a short page: the list is longer than
	// this reader walks, so it is a lookup that did not complete. Refusing
	// is the fail-closed direction; silently gating on a truncated list
	// would be the wrong-allow this gate exists to prevent.
	return { ok: false, cause: "the comment list exceeded the pages this reader walks" };
}

const verdict = mergeReviewGate(await fetchComments(), head);

if (verdict.pass) {
	console.log(`merge-review: PASS — a complete, adjudicated review is pinned at ${head}.`);
	process.exit(0);
}

// Advisory posture: a notice, not an error, and exit 0. When this gate
// hardens, this is the one branch that changes.
console.log(`::notice::merge-review (ADVISORY): ${verdict.reason} — ${verdict.detail}`);
console.log(
	"merge-review is advisory today (§3.6 born-advisory → measure → harden; issue #190 decision 6). " +
		"It reports and does not block. Hardening it into a required check is the operator's act.",
);
process.exit(0);
