/**
 * Canonical §1.4 correction intervals for the repair-basis projection: a
 * linear pair's tree delta, or a rewrite marker for every other pair (#437).
 * Warning-surface roster: EXEMPT — every Git diagnostic is piped and
 * reduced to an unavailable value; this module authors no warned,
 * thrown, or printed message.
 */
import { execFile, spawn } from "node:child_process";
import { withoutRepoLocatingGitEnv } from "../dispatch/provision.ts";

const OID = /^[0-9a-f]{40}$/;
const MODES = new Map([
	["100644", "blob"],
	["100755", "blob"],
	["120000", "blob"],
	["160000", "commit"],
]);
const RUN_MS = 30_000;
const BYTE_CAP = 16 * 1024 * 1024;
const COMMIT_CAP = 100_000;

export type DeltaSide = { mode: string; type: "blob" | "commit"; oid: string; bytesBase64: string | null };
export type DeltaEntry = { pathBase64: string; before: DeltaSide | null; after: DeltaSide | null };
export type TreeDelta = { earlierHead: string; laterHead: string; entries: DeltaEntry[] };
/** §1.4: a pair that is not linear carries no delta; its correction is not measured. */
export type RewriteMarker = { kind: "rewrite-marker"; earlierHead: string; laterHead: string };
export type CorrectionInterval = TreeDelta | RewriteMarker;

export function isRewriteMarker(interval: CorrectionInterval): interval is RewriteMarker {
	return "kind" in interval && interval.kind === "rewrite-marker";
}

type TreeEntry = { path: Buffer; mode: string; type: "blob" | "commit"; oid: string };
type Budget = { deadline: number; bytes: number; commits: number; commitCap: number };
/** Per-pair bounds; production passes none, so §1.4's settled values apply. */
export type IntervalLimits = { readonly runMs: number; readonly commitCap: number };
const LIMITS: IntervalLimits = { runMs: RUN_MS, commitCap: COMMIT_CAP };

function gitEnv(): NodeJS.ProcessEnv {
	return { ...withoutRepoLocatingGitEnv(process.env), GIT_ADVICE: "0", GIT_NO_REPLACE_OBJECTS: "1", LC_ALL: "C" };
}

async function run(repoRoot: string, args: string[], budget: Budget): Promise<Buffer | undefined> {
	const timeout = budget.deadline - Date.now();
	const remaining = BYTE_CAP - budget.bytes;
	if (timeout <= 0 || remaining <= 0) return undefined;
	return new Promise((resolve) => {
		execFile(
			"git",
			["-C", repoRoot, ...args],
			{ encoding: "buffer", env: gitEnv(), timeout, maxBuffer: remaining },
			(error, stdout, stderr) => {
				if (error || stderr.length !== 0 || stdout.length > remaining) return resolve(undefined);
				budget.bytes += stdout.length;
				resolve(stdout);
			},
		);
	});
}

function commitParents(raw: Buffer): string[] | undefined {
	const end = raw.indexOf(Buffer.from("\n\n"));
	if (end < 0) return undefined;
	const lines: Buffer[] = [];
	let start = 0;
	while (start <= end) {
		const next = raw.indexOf(10, start);
		if (next < 0 || next > end) break;
		lines.push(raw.subarray(start, next));
		start = next + 1;
	}
	if (lines.length === 0 || !/^tree [0-9a-f]{40}$/.test(lines[0].toString("ascii"))) return undefined;
	const parents: string[] = [];
	let index = 1;
	while (index < lines.length && lines[index].subarray(0, 7).equals(Buffer.from("parent "))) {
		const line = lines[index];
		if (!/^parent [0-9a-f]{40}$/.test(line.toString("ascii"))) return undefined;
		const parent = line.subarray(7).toString("ascii");
		if (parents.includes(parent)) return undefined;
		parents.push(parent);
		index += 1;
	}
	for (; index < lines.length; index += 1) {
		if (
			lines[index].subarray(0, 5).equals(Buffer.from("tree ")) ||
			lines[index].subarray(0, 7).equals(Buffer.from("parent "))
		)
			return undefined;
	}
	return parents;
}

/**
 * Decide a pair by a walk from its later head over raw commit objects, in one
 * `cat-file --batch` process (§1.4, #437). The pair is linear when the
 * single-parent chain from the later head reaches the earlier head; otherwise
 * the walk runs to completion, reaching the earlier head or exhausting every
 * parent, and the pair gets a rewrite marker. A missing, unreadable or
 * malformed commit, a cap or the deadline leaves the walk incomplete, which
 * withholds the projection and decides nothing.
 */
async function walkPair(
	repoRoot: string,
	earlier: string,
	later: string,
	budget: Budget,
): Promise<"linear" | "rewrite" | undefined> {
	const timeout = budget.deadline - Date.now();
	if (timeout <= 0 || budget.bytes >= BYTE_CAP) return undefined;
	const child = spawn("git", ["-C", repoRoot, "cat-file", "--batch"], {
		env: gitEnv(),
		stdio: ["pipe", "pipe", "pipe"],
	});
	let failed = false;
	let closed = false;
	let buffered = Buffer.alloc(0);
	let wake: (() => void) | undefined;
	const fail = () => {
		failed = true;
		child.kill("SIGKILL");
		wake?.();
	};
	const timer = setTimeout(fail, timeout);
	child.stdout.on("data", (chunk: Buffer) => {
		budget.bytes += chunk.length;
		if (budget.bytes > BYTE_CAP) return fail();
		buffered = Buffer.concat([buffered, chunk]);
		wake?.();
	});
	child.stderr.on("data", fail);
	child.stdin.on("error", fail);
	child.on("error", fail);
	child.on("close", () => {
		closed = true;
		wake?.();
	});
	const until = async (ready: () => boolean): Promise<boolean> => {
		while (!ready() && !failed && !closed)
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		wake = undefined;
		return !failed && ready();
	};
	const known = new Map<string, string[]>();
	const parentsOf = async (oid: string): Promise<string[] | undefined> => {
		const cached = known.get(oid);
		if (cached !== undefined) return cached;
		budget.commits += 1;
		if (budget.commits > budget.commitCap || failed || closed) return undefined;
		child.stdin.write(`${oid}\n`);
		if (!(await until(() => buffered.indexOf(10) >= 0))) return undefined;
		const newline = buffered.indexOf(10);
		const header = /^([0-9a-f]{40}) commit (\d+)$/.exec(buffered.subarray(0, newline).toString("ascii"));
		if (header === null || header[1] !== oid) return undefined;
		const end = newline + 1 + Number(header[2]);
		if (!(await until(() => buffered.length > end)) || buffered[end] !== 10) return undefined;
		const parents = commitParents(Buffer.from(buffered.subarray(newline + 1, end)));
		buffered = buffered.subarray(end + 1);
		if (parents === undefined || parents.includes(oid)) return undefined;
		known.set(oid, parents);
		return parents;
	};
	try {
		let cursor = later;
		for (;;) {
			// The earlier head is measured as a tree, so it must read as a commit.
			if (cursor === earlier) return (await parentsOf(earlier)) === undefined ? undefined : "linear";
			const parents = await parentsOf(cursor);
			if (parents === undefined) return undefined;
			if (parents.length !== 1) break;
			cursor = parents[0];
		}
		const pending = [later];
		const seen = new Set<string>();
		while (pending.length > 0) {
			// A cached read never yields to the deadline timer, so the loop checks it.
			if (failed || Date.now() >= budget.deadline) return undefined;
			const oid = pending.pop() as string;
			if (oid === earlier) return "rewrite";
			if (seen.has(oid)) continue;
			seen.add(oid);
			const parents = await parentsOf(oid);
			if (parents === undefined) return undefined;
			// First parent popped first, so an earlier head on the first-parent
			// line is met before a merged-in base history is walked.
			pending.push(...parents.toReversed());
		}
		return "rewrite";
	} finally {
		clearTimeout(timer);
		child.stdin.end();
		if (!closed) child.kill("SIGKILL");
	}
}

function parseTree(raw: Buffer): TreeEntry[] | undefined {
	if (raw.length === 0) return [];
	if (raw.at(-1) !== 0) return undefined;
	const entries: TreeEntry[] = [];
	let start = 0;
	while (start < raw.length) {
		const end = raw.indexOf(0, start);
		if (end < 0) return undefined;
		const record = raw.subarray(start, end);
		const tab = record.indexOf(9);
		if (tab < 0) return undefined;
		const header = record.subarray(0, tab).toString("ascii");
		const match = /^(\d{6}) (blob|commit) ([0-9a-f]{40})$/.exec(header);
		const path = record.subarray(tab + 1);
		if (!match || path.length === 0 || MODES.get(match[1]) !== match[2]) return undefined;
		if (entries.length > 0 && Buffer.compare(entries.at(-1)?.path as Buffer, path) >= 0) return undefined;
		entries.push({ path: Buffer.from(path), mode: match[1], type: match[2] as "blob" | "commit", oid: match[3] });
		start = end + 1;
	}
	return entries;
}

async function side(repoRoot: string, entry: TreeEntry, budget: Budget): Promise<DeltaSide | undefined> {
	if (entry.type === "commit") return { mode: entry.mode, type: entry.type, oid: entry.oid, bytesBase64: null };
	const bytes = await run(repoRoot, ["cat-file", "blob", entry.oid], budget);
	if (bytes === undefined) return undefined;
	return { mode: entry.mode, type: entry.type, oid: entry.oid, bytesBase64: bytes.toString("base64") };
}

async function readWithBudget(
	repoRoot: string,
	earlierHead: string,
	laterHead: string,
	budget: Budget,
): Promise<CorrectionInterval | undefined> {
	if (earlierHead === laterHead || !OID.test(earlierHead) || !OID.test(laterHead)) return undefined;
	const shape = await walkPair(repoRoot, earlierHead, laterHead, budget);
	if (shape === undefined) return undefined;
	if (shape === "rewrite") return { kind: "rewrite-marker", earlierHead, laterHead };
	const earlierRaw = await run(
		repoRoot,
		["ls-tree", "-r", "-z", "--full-tree", "--end-of-options", earlierHead],
		budget,
	);
	const laterRaw = await run(repoRoot, ["ls-tree", "-r", "-z", "--full-tree", "--end-of-options", laterHead], budget);
	if (earlierRaw === undefined || laterRaw === undefined) return undefined;
	const before = parseTree(earlierRaw);
	const after = parseTree(laterRaw);
	if (before === undefined || after === undefined) return undefined;
	const entries: DeltaEntry[] = [];
	let left = 0;
	let right = 0;
	while (left < before.length || right < after.length) {
		const a = before[left];
		const b = after[right];
		const order = a === undefined ? 1 : b === undefined ? -1 : Buffer.compare(a.path, b.path);
		if (order === 0 && a.mode === b.mode && a.type === b.type && a.oid === b.oid) {
			left += 1;
			right += 1;
			continue;
		}
		const oldEntry = order <= 0 ? a : undefined;
		const newEntry = order >= 0 ? b : undefined;
		const oldSide = oldEntry === undefined ? null : await side(repoRoot, oldEntry, budget);
		const newSide = newEntry === undefined ? null : await side(repoRoot, newEntry, budget);
		if ((oldEntry !== undefined && oldSide === undefined) || (newEntry !== undefined && newSide === undefined))
			return undefined;
		entries.push({
			pathBase64: (oldEntry ?? newEntry)?.path.toString("base64") as string,
			before: oldSide as DeltaSide | null,
			after: newSide as DeltaSide | null,
		});
		if (order <= 0) left += 1;
		if (order >= 0) right += 1;
	}
	return { earlierHead, laterHead, entries };
}

export async function readCorrectionIntervals(
	repoRoot: string,
	pairs: readonly { earlierHead: string; laterHead: string }[],
	limits: IntervalLimits = LIMITS,
): Promise<CorrectionInterval[] | undefined> {
	const intervals: CorrectionInterval[] = [];
	for (const pair of pairs) {
		const budget: Budget = { deadline: Date.now() + limits.runMs, bytes: 0, commits: 0, commitCap: limits.commitCap };
		const interval = await readWithBudget(repoRoot, pair.earlierHead, pair.laterHead, budget);
		if (interval === undefined) return undefined;
		intervals.push(interval);
	}
	return intervals;
}

export async function readCorrectionInterval(
	repoRoot: string,
	earlierHead: string,
	laterHead: string,
): Promise<CorrectionInterval | undefined> {
	return (await readCorrectionIntervals(repoRoot, [{ earlierHead, laterHead }]))?.[0];
}
