#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
	CAPABILITIES,
	canonicalJson,
	parseGovernanceConfig,
	validateGovernanceConfig,
} from "../workflows/gitjig-governance.mjs";
import { createGovernancePlatform } from "../workflows/gitjig-governance-platform.mjs";
import {
	admitConfirmation,
	confirmationPresentation,
	createGovernanceService,
} from "../workflows/gitjig-governance-service.mjs";

const FIXED = ".github/gitjig-governance.json";

/** @param {string[]} argv */
function argumentsOf(argv) {
	const command = argv[0];
	if (!["configure", "plan", "apply", "audit"].includes(command)) throw new Error("subcommand");
	const flags = new Map();
	for (let index = 1; index < argv.length; index++) {
		const name = argv[index];
		if (!name.startsWith("--") || flags.has(name)) throw new Error("arguments");
		if (name === "--non-interactive") flags.set(name, true);
		else {
			const value = argv[++index];
			if (!value || value.startsWith("--")) throw new Error("arguments");
			flags.set(name, value);
		}
	}
	const allowed = /** @type {Record<string,string[]>} */ ({
		configure: ["--config", "--candidate", "--non-interactive", "--confirm-config-hash", "--confirm-prior-config-hash"],
		plan: ["--config", "--non-interactive"],
		audit: ["--config", "--non-interactive"],
		apply: ["--config", "--plan", "--non-interactive", "--confirm-plan-hash"],
	})[command];
	if ([...flags.keys()].some((key) => !allowed.includes(key))) throw new Error("arguments");
	return { command, flags };
}
/** @param {string} path */
function readRegular(path) {
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stats = fstatSync(descriptor);
		if (!stats.isFile()) throw new Error("non-regular");
		if (stats.size > 4 * 1024 * 1024) throw new Error("local-input-bound");
		return { bytes: readFileSync(descriptor), stats };
	} finally {
		closeSync(descriptor);
	}
}
/** @param {string} root @param {unknown} input */
function configPath(root, input) {
	if (typeof input !== "string") throw new Error("config-path");
	const expected = join(root, FIXED);
	if (resolve(root, input) !== expected || lstatSync(join(root, ".github")).isSymbolicLink())
		throw new Error("config-path");
	return expected;
}
/** @param {string} path */
/** @param {string} path */
export function readGovernanceConfig(path) {
	return parseGovernanceConfig(readRegular(path).bytes);
}

/** @param {string} path */
export function readGovernancePlan(path) {
	try {
		return JSON.parse(readRegular(path).bytes.toString("utf8"));
	} catch {
		throw new Error("plan-input");
	}
}

/** @param {Buffer} currentBytes @param {Buffer} candidateBytes */
function configurePresentation(currentBytes, candidateBytes) {
	const current = parseGovernanceConfig(currentBytes);
	const candidate = validateGovernanceConfig(candidateBytes, current.repository);
	const digest = (/** @type {Buffer} */ value) => createHash("sha256").update(value).digest("hex");
	const priorConfigHash = digest(currentBytes);
	const candidateConfigHash = digest(candidateBytes);
	return {
		repository: current.repository.nameWithOwner,
		priorConfigHash,
		candidateConfigHash,
		changes: CAPABILITIES.flatMap((capability) =>
			canonicalJson(current.capabilities[capability]) === canonicalJson(candidate.capabilities[capability])
				? []
				: [{ capability, current: current.capabilities[capability], desired: candidate.capabilities[capability] }],
		),
		tradeoffs: {
			selected: "enforce the declared value",
			disabled: "enforce the capability's disabled value",
			unmanaged: "preserve and report measured state without an operation",
		},
		confirmation: `CONFIGURE ${current.repository.nameWithOwner} ${priorConfigHash} ${candidateConfigHash}`,
	};
}

/** Atomic fixed-path replacement; the supplied confirmation is exact candidate SHA-256.
 * @param {string} root @param {unknown} pathInput @param {string} candidatePath @param {unknown} confirmation @param {unknown} priorConfirmation
 */
export function configureGovernance(root, pathInput, candidatePath, confirmation, priorConfirmation) {
	const path = configPath(root, pathInput);
	const parent = lstatSync(dirname(path));
	if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("config-parent");
	const prior = readRegular(path);
	const priorConfig = parseGovernanceConfig(prior.bytes);
	const candidate = readRegular(candidatePath).bytes;
	validateGovernanceConfig(candidate, priorConfig.repository);
	const digest = createHash("sha256").update(candidate).digest("hex");
	const priorDigest = createHash("sha256").update(prior.bytes).digest("hex");
	if (confirmation !== digest || priorConfirmation !== priorDigest) throw new Error("config-confirmation");
	const temp = join(dirname(path), `.gitjig-governance.${process.pid}.${randomUUID()}.tmp`);
	let stagedStats;
	try {
		const descriptor = openSync(
			temp,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			writeFileSync(descriptor, candidate);
			fsyncSync(descriptor);
			stagedStats = fstatSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		const currentParent = lstatSync(dirname(path));
		const current = lstatSync(path);
		const observed = readRegular(path);
		if (
			currentParent.dev !== parent.dev ||
			currentParent.ino !== parent.ino ||
			current.dev !== prior.stats.dev ||
			current.ino !== prior.stats.ino ||
			observed.stats.dev !== current.dev ||
			observed.stats.ino !== current.ino ||
			!observed.bytes.equals(prior.bytes)
		)
			throw new Error("config-drift");
		renameSync(temp, path);
		chmodSync(path, prior.stats.mode & 0o777);
		const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
		const reread = readRegular(path);
		if (
			!stagedStats ||
			reread.stats.dev !== stagedStats.dev ||
			reread.stats.ino !== stagedStats.ino ||
			!reread.bytes.equals(candidate)
		)
			throw new Error("config-reread");
		return { outcome: "configured", path: FIXED, configHash: digest };
	} finally {
		rmSync(temp, { force: true });
	}
}

/** @param {string} host @param {string} repoRoot */
function requester(host, repoRoot) {
	return async (/** @type {string} */ method, /** @type {string} */ path, /** @type {unknown} */ body) => {
		const args = ["api", "--hostname", host, "--method", method, path];
		if (body !== undefined) args.push("--input", "-");
		const result = spawnSync("gh", args, {
			cwd: repoRoot,
			input: body === undefined ? undefined : JSON.stringify(body),
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 4 * 1024 * 1024,
			env: { PATH: process.env.PATH, HOME: process.env.HOME, GH_TOKEN: process.env.GH_TOKEN },
		});
		if (result.status !== 0 || result.error || result.signal) throw new Error("platform");
		try {
			return JSON.parse(result.stdout);
		} catch {
			throw new Error("platform-json");
		}
	};
}
/** @param {unknown} config @param {string} root @param {NodeJS.ProcessEnv} [environment] */
export function createCliPlatform(config, root, environment = process.env) {
	return createGovernancePlatform(config, requester(environment.GITHUB_HOST ?? "github.com", root));
}

/** @param {string} prompt */
async function promptLine(prompt) {
	const terminal = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
	try {
		return await terminal.question(`${prompt}\n> `);
	} catch {
		throw new Error("prompt-input");
	} finally {
		terminal.close();
	}
}

export async function runGovernanceCli(argv = process.argv.slice(2), environment = process.env) {
	const { command, flags } = argumentsOf(argv);
	const root = environment.GOVERNANCE_REPOSITORY_ROOT ? resolve(environment.GOVERNANCE_REPOSITORY_ROOT) : process.cwd();
	const path = configPath(root, flags.get("--config"));
	const nonInteractive = flags.has("--non-interactive");
	if (nonInteractive && !process.stdin.isTTY && !fstatSync(0).isCharacterDevice()) throw new Error("unexpected-stdin");
	if (!nonInteractive && !process.stdin.isTTY) throw new Error("interactive-tty");
	if (
		!nonInteractive &&
		(flags.has("--confirm-config-hash") || flags.has("--confirm-prior-config-hash") || flags.has("--confirm-plan-hash"))
	)
		throw new Error("conflicting-confirmation");
	if (command === "configure") {
		const candidate = flags.get("--candidate");
		if (typeof candidate !== "string") throw new Error("candidate");
		const candidateBytes = readRegular(candidate).bytes;
		const presentation = configurePresentation(readRegular(path).bytes, candidateBytes);
		let confirmation = flags.get("--confirm-config-hash");
		let priorConfirmation = flags.get("--confirm-prior-config-hash");
		if (!nonInteractive) {
			process.stderr.write(`${JSON.stringify(presentation)}\n`);
			const supplied = await promptLine(`Enter '${presentation.confirmation}'`);
			if (supplied !== presentation.confirmation) throw new Error("config-confirmation");
			confirmation = presentation.candidateConfigHash;
			priorConfirmation = presentation.priorConfigHash;
		}
		return configureGovernance(root, path, candidate, confirmation, priorConfirmation);
	}
	const config = readGovernanceConfig(path);
	const platform = createCliPlatform(config, root, environment);
	const service = createGovernanceService();
	if (command === "plan") return { outcome: "planned", plan: await service.plan(config, platform) };
	if (command === "audit") return { outcome: "audited", audit: await service.audit(config, platform) };
	const planPath = flags.get("--plan");
	if (typeof planPath !== "string") throw new Error("plan-path");
	const plan = readGovernancePlan(planPath);
	const presentation = confirmationPresentation(config.repository.nameWithOwner, plan);
	const invocationId = randomUUID();
	if (!nonInteractive) process.stderr.write(`${JSON.stringify(presentation)}\n`);
	const supplied = nonInteractive
		? flags.get("--confirm-plan-hash")
		: await promptLine(`Enter '${presentation.confirmation}'`);
	const confirmation = admitConfirmation(
		nonInteractive ? "non-interactive" : "interactive",
		supplied,
		config.repository.nameWithOwner,
		plan,
		invocationId,
	);
	return service.apply(
		{
			config,
			plan,
			confirmation,
		},
		platform,
	);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	try {
		const result = await runGovernanceCli();
		process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: true, result })}\n`);
	} catch (error) {
		process.stderr.write(`governance refused: ${error instanceof Error ? error.message : "unknown"}\n`);
		process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: false, error: "refused" })}\n`);
		process.exitCode = 1;
	}
}
