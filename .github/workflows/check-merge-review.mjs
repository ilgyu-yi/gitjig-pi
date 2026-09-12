// The platform half of SPEC §3.3's `merge-review` gate (issue #190,
// Directive #28). DEVELOPMENT AND CI ONLY, the same class suite.yml and
// source-checks.yml declare: this is not substrate, and an adopting
// repository is not meant to receive it. That classification is what
// licenses the imports below — a handed-over asset must pass #134's
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
// Every raw error is wrapped through the shell's own `quoted` helper
// before it reaches a rendered line (§3.10's uniform mitigation; issue
// #190, round-1 finding E-F4). The warning-surface structural lock walks
// `.pi/extensions/` only, so this file sits outside its domain and the
// wrapping here is held by this module's own arms instead — which is why
// those arms exist rather than being optional.
//
// Advisory by decision, not by omission (§3.6's born-advisory → measure
// → harden, recorded on issue #190's decision 6): it reports and exits 0
// on refusal. Hardening is server configuration and the operator's act;
// its decidable trigger and named owner are issue #192.
//
// Residual, enumerated rather than left implicit (issue #190, round-1
// finding E-F6): the every-failure-is-a-value rule above is scoped to
// the platform I/O this file performs. The two static imports are
// outside it — an absent predicate module exits non-zero with a
// resolution error rather than an advisory notice. That is the decided
// posture, not an oversight: the predicate and this call site land in
// one commit and are checked out together, so an absent module is a
// broken checkout rather than §3.9's absent-substrate limb, and a
// checkout that cannot supply the gate should be loud.

import { pathToFileURL } from "node:url";
import { mergeReviewGate } from "../../.pi/extensions/gitjig/review/merge-gate.ts";
import { quoted } from "../../.pi/extensions/gitjig/quote.ts";

/** Pages of 100 this reader walks before it refuses rather than guessing. */
export const PAGE_BUDGET = 10;
const PER_PAGE = 100;

const API = "https://api.github.com";

/**
 * Redact the credential from anything rendered.
 *
 * A platform error's message is not ours to trust: a redirect, a proxy
 * diagnostic, or a URL echoed back can carry the Authorization value
 * into text this job prints to the run log. The platform masks its own
 * secrets there, but this job also renders causes the platform never
 * saw, so the redaction is performed here rather than relied upon.
 */
function redact(text, token) {
	return token ? text.split(token).join("[redacted]") : text;
}

function headers(token) {
	return {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${token}`,
		"x-github-api-version": "2022-11-28",
	};
}

/**
 * One platform read. Every failure is a returned VALUE, never a throw —
 * §3.7(c) makes lookup failure a refusal the gate reports, and a thrown
 * error would hand the posture to whatever catches it.
 */
async function readJson(url, token, fetchImpl) {
	// Redact BEFORE escaping, never after: `quoted` rewrites control and
	// separator characters, so a token containing one is no longer present
	// as its own bytes when a later `split(token)` runs — it would survive
	// into the log as a trivially reversible encoding of the credential.
	const wrap = (error) => quoted(redact(error instanceof Error ? error.message : String(error), token));
	let response;
	try {
		response = await fetchImpl(url, { headers: headers(token) });
	} catch (error) {
		return { ok: false, cause: `the platform read threw: ${wrap(error)}` };
	}
	if (!response.ok) {
		return { ok: false, cause: `the platform answered HTTP ${response.status}` };
	}
	try {
		return { ok: true, value: await response.json() };
	} catch (error) {
		return { ok: false, cause: `the platform's answer was not JSON: ${wrap(error)}` };
	}
}

/**
 * Resolve the head under review. On a `pull_request` run the platform
 * hands it to us; on an `issue_comment` run the payload carries no head,
 * so it is read from the PR. A failed read is a value, like every other.
 */
export async function resolveHead({ repo, pr, head, token, fetchImpl = fetch }) {
	if (head) {
		return { ok: true, head };
	}
	const read = await readJson(`${API}/repos/${repo}/pulls/${pr}`, token, fetchImpl);
	if (!read.ok) {
		return { ok: false, cause: `the head under review could not be resolved — ${read.cause}` };
	}
	const resolved = read.value?.head?.sha;
	if (typeof resolved !== "string" || resolved.length === 0) {
		return { ok: false, cause: "the pull request carried no head sha" };
	}
	return { ok: true, head: resolved };
}

/**
 * Fetch the PR's issue comments, following pagination, oldest first.
 *
 * The returned order is the platform's own ascending order, and the
 * predicate's last-record-wins collapse rests on it — stated here
 * because the predicate cannot see this call site.
 */
export async function fetchComments({ repo, pr, token, fetchImpl = fetch }) {
	const bodies = [];
	for (let page = 1; page <= PAGE_BUDGET; page += 1) {
		const read = await readJson(
			`${API}/repos/${repo}/issues/${pr}/comments?per_page=${PER_PAGE}&page=${page}`,
			token,
			fetchImpl,
		);
		if (!read.ok) {
			return { ok: false, cause: `${read.cause} for page ${page}` };
		}
		if (!Array.isArray(read.value)) {
			return { ok: false, cause: `page ${page} was not a comment array` };
		}
		for (const comment of read.value) {
			bodies.push(typeof comment?.body === "string" ? comment.body : "");
		}
		if (read.value.length < PER_PAGE) {
			return { ok: true, bodies };
		}
	}
	// The budget is exhausted without a short page: the list is longer
	// than this reader walks, so it is a lookup that did not complete.
	// Refusing is the fail-closed direction; gating on a truncated list
	// would be the wrong-allow this gate exists to prevent.
	return { ok: false, cause: `the comment list exceeded the ${PAGE_BUDGET} pages this reader walks` };
}

/** The whole run, as a value. Returns the lines to print and the exit code. */
export async function run(env, fetchImpl = fetch) {
	const token = env.GITHUB_TOKEN;
	const repo = env.GITJIG_REPO;
	const pr = env.GITJIG_PR;
	if (!token || !repo || !pr) {
		return {
			code: 1,
			lines: ["::error::check-merge-review: GITHUB_TOKEN, GITJIG_REPO and GITJIG_PR must all be set."],
		};
	}

	const resolved = await resolveHead({ repo, pr, head: env.GITJIG_HEAD, token, fetchImpl });
	if (!resolved.ok) {
		return { code: 0, lines: advisory("lookup-failed", resolved.cause) };
	}

	const verdict = mergeReviewGate(await fetchComments({ repo, pr, token, fetchImpl }), resolved.head);
	if (verdict.pass) {
		return { code: 0, lines: [`merge-review: PASS — a complete, adjudicated review is pinned at ${resolved.head}.`] };
	}
	return { code: 0, lines: advisory(verdict.reason, verdict.detail) };
}

// Advisory posture: a notice, not an error, and exit 0. When this gate
// hardens (issue #192), this is the one branch that changes.
function advisory(reason, detail) {
	return [
		`::notice::merge-review (ADVISORY): ${reason} — ${detail}`,
		"merge-review is advisory today (§3.6 born-advisory → measure → harden; issue #190 decision 6). " +
			"It reports and does not block. Hardening it into a required check is the operator's act (issue #192).",
	];
}

// Run only when invoked as the entry point, so the arms can import the
// pieces above without driving a platform read.
// `pathToFileURL` rather than a hand-built `file://` prefix: a path
// needing percent-encoding makes the two spellings differ, the guard
// reads false, and the script exits 0 having evaluated nothing — §3.7(b)'s
// silent skip in its quiet form, in a file every other limb of which is loud.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	const { code, lines } = await run(process.env);
	for (const line of lines) {
		console.log(line);
	}
	process.exit(code);
}
