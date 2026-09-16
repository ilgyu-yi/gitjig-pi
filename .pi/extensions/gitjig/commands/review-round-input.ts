/**
 * Repository-file capability for `/review-round` input.
 *
 * Warning-surface roster: EXEMPT — this module returns file text or undefined;
 * it emits no warning, record, or thrown operator-facing text.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const MAX_REVIEW_ROUND_SPEC_BYTES = 1024 * 1024;

/**
 * Read one repository-owned command input through a single file capability.
 * The supplied spelling is walked in order, so a symlink cannot disappear
 * merely because a later `..` component cancels its lexical name.
 */
export function readRepositoryInput(
	repoRoot: string,
	name: string,
	afterWalk: () => void = () => {},
): string | undefined {
	if (name.length === 0 || isAbsolute(name)) return undefined;
	try {
		const root = realpathSync(repoRoot);
		const rootStat = lstatSync(root);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return undefined;
		const components = name.split(/[\\/]+/);
		const stack: string[] = [];
		const walked: { path: string; dev: number; ino: number; directory: boolean }[] = [];
		let leafPath: string | undefined;
		for (let index = 0; index < components.length; index += 1) {
			const component = components[index];
			if (component === "" || component === ".") continue;
			if (component === "..") {
				if (stack.length === 0) return undefined;
				stack.pop();
				leafPath = stack.length === 0 ? undefined : join(root, ...stack);
				continue;
			}
			stack.push(component);
			const candidate = join(root, ...stack);
			const stat = lstatSync(candidate);
			if (stat.isSymbolicLink()) return undefined;
			const hasLaterComponent = components.slice(index + 1).some((entry) => entry !== "" && entry !== ".");
			if (hasLaterComponent && !stat.isDirectory()) return undefined;
			walked.push({ path: candidate, dev: stat.dev, ino: stat.ino, directory: stat.isDirectory() });
			leafPath = candidate;
		}
		if (leafPath === undefined) return undefined;
		const leaf = lstatSync(leafPath);
		if (!leaf.isFile() || leaf.isSymbolicLink()) return undefined;
		afterWalk();

		// O_NOFOLLOW refuses a replacement symlink; O_NONBLOCK prevents a
		// replacement FIFO/device from wedging before descriptor validation.
		// Portable Node has no openat-style ancestor descriptor walk, so the
		// opened descriptor is also matched to the checked leaf identity.
		const fd = openSync(leafPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const opened = fstatSync(fd);
			if (
				!opened.isFile() ||
				opened.dev !== leaf.dev ||
				opened.ino !== leaf.ino ||
				opened.size > MAX_REVIEW_ROUND_SPEC_BYTES
			)
				return undefined;
			const currentRoot = lstatSync(root);
			if (
				!currentRoot.isDirectory() ||
				currentRoot.isSymbolicLink() ||
				currentRoot.dev !== rootStat.dev ||
				currentRoot.ino !== rootStat.ino
			)
				return undefined;
			for (const expected of walked) {
				const current = lstatSync(expected.path);
				if (
					current.isSymbolicLink() ||
					current.dev !== expected.dev ||
					current.ino !== expected.ino ||
					current.isDirectory() !== expected.directory
				)
					return undefined;
			}
			if (realpathSync(leafPath) !== leafPath) return undefined;
			// Read at most one byte beyond the cap. The descriptor may be written
			// after fstat, so its earlier size is only a fast refusal, never the
			// bound itself.
			const bytes = Buffer.allocUnsafe(MAX_REVIEW_ROUND_SPEC_BYTES + 1);
			let length = 0;
			while (length < bytes.length) {
				const count = readSync(fd, bytes, length, bytes.length - length, null);
				if (count === 0) break;
				length += count;
			}
			if (length > MAX_REVIEW_ROUND_SPEC_BYTES) return undefined;
			return bytes.toString("utf8", 0, length);
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
}
