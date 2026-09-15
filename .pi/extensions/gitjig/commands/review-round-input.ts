/**
 * Repository-file capability for `/review-round` input.
 *
 * Warning-surface roster: EXEMPT — this module returns file text or undefined;
 * it emits no warning, record, or thrown operator-facing text.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Read one repository-owned command input through a single file capability.
 * The supplied spelling is walked in order, so a symlink cannot disappear
 * merely because a later `..` component cancels its lexical name.
 */
export function readRepositoryInput(repoRoot: string, name: string): string | undefined {
	if (name.length === 0 || isAbsolute(name)) return undefined;
	try {
		const root = realpathSync(repoRoot);
		const components = name.split(/[\\/]+/);
		const stack: string[] = [];
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
			leafPath = candidate;
		}
		if (leafPath === undefined) return undefined;
		const leaf = lstatSync(leafPath);
		if (!leaf.isFile() || leaf.isSymbolicLink()) return undefined;

		// O_NOFOLLOW closes leaf replacement. Portable Node has no openat-style
		// ancestor descriptor walk, so an ancestor swap between the checks and
		// this open remains the explicitly bounded residual.
		const fd = openSync(leafPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			if (!fstatSync(fd).isFile()) return undefined;
			return readFileSync(fd, "utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
}
