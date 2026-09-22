/** Warning-surface roster: EXEMPT — this module emits no operator-facing warning text. */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const OWNER_DIRECTORY_MODE = 0o700;

function uid(): number | undefined {
	return typeof process.geteuid === "function" ? process.geteuid() : undefined;
}

function identityEqual(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function safeDirectory(path: string, exactMode: boolean): { fd: number; stat: Stats } | undefined {
	let before: Stats;
	let fd: number | undefined;
	try {
		before = lstatSync(path);
		if (!before.isDirectory() || before.isSymbolicLink()) return undefined;
		fd = openSync(path, DIRECTORY_FLAGS);
		const after = fstatSync(fd);
		const effectiveUid = uid();
		if (
			!after.isDirectory() ||
			!identityEqual(before, after) ||
			before.mode !== after.mode ||
			before.uid !== after.uid ||
			(effectiveUid !== undefined && after.uid !== effectiveUid) ||
			(exactMode ? (after.mode & 0o777) !== OWNER_DIRECTORY_MODE : (after.mode & 0o022) !== 0)
		) {
			closeSync(fd);
			return undefined;
		}
		return { fd, stat: after };
	} catch {
		if (fd !== undefined)
			try {
				closeSync(fd);
			} catch {}
		return undefined;
	}
}

function existsByLstat(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		return (error as { code?: string }).code !== "ENOENT";
	}
}

function repositoryExcluded(path: string): boolean {
	let current = resolve(path);
	const root = parse(current).root;
	for (;;) {
		if (existsByLstat(join(current, ".git"))) return true;
		if (["HEAD", "objects", "refs"].every((name) => existsByLstat(join(current, name)))) return true;
		if (current === root) return false;
		current = dirname(current);
	}
}

function traverse(root: string, names: readonly { name: string; exact: boolean }[]): string | undefined {
	let current = root;
	for (const component of names) {
		const parent = safeDirectory(current, current.endsWith("/gitjig") || current.endsWith("/recovery"));
		if (parent === undefined) return undefined;
		const child = join(current, component.name);
		try {
			let missing = false;
			try {
				lstatSync(child);
			} catch (error) {
				if ((error as { code?: string }).code !== "ENOENT") return undefined;
				missing = true;
			}
			if (missing) {
				if (repositoryExcluded(current)) return undefined;
				const parentBefore = fstatSync(parent.fd);
				if (!identityEqual(parent.stat, parentBefore)) return undefined;
				try {
					mkdirSync(child, { mode: OWNER_DIRECTORY_MODE });
				} catch (error) {
					if ((error as { code?: string }).code !== "EEXIST") return undefined;
				}
				const parentAfter = fstatSync(parent.fd);
				if (!identityEqual(parentBefore, parentAfter)) return undefined;
			}
			const opened = safeDirectory(child, component.exact || missing);
			if (opened === undefined) return undefined;
			try {
				fsyncSync(parent.fd);
			} catch {
				return undefined;
			} finally {
				closeSync(opened.fd);
			}
			current = child;
			if (repositoryExcluded(current)) return undefined;
		} finally {
			closeSync(parent.fd);
		}
	}
	return current;
}

/** The sole production recovery placement resolver. */
export function resolveRecoveryStateDomain(): string | undefined {
	if (Object.hasOwn(process.env, "GITJIG_TEST_STATE_ROOT")) return undefined;
	const hasXdg = Object.hasOwn(process.env, "XDG_STATE_HOME");
	const selected = hasXdg ? process.env.XDG_STATE_HOME : process.env.HOME;
	if (typeof selected !== "string" || selected.length === 0 || !isAbsolute(selected)) return undefined;
	const root = safeDirectory(selected, hasXdg);
	if (root === undefined) return undefined;
	closeSync(root.fd);
	if (repositoryExcluded(selected)) return undefined;
	const components = hasXdg
		? [
				{ name: "gitjig", exact: true },
				{ name: "recovery", exact: true },
			]
		: [
				{ name: ".local", exact: false },
				{ name: "state", exact: false },
				{ name: "gitjig", exact: true },
				{ name: "recovery", exact: true },
			];
	return traverse(selected, components);
}
