import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const spec = readFileSync(fileURLToPath(new URL("../SPEC.md", import.meta.url)), "utf8");

function authorCapableActivation(text: string): boolean {
	return (
		text.includes(
			"The Issue author may perform the activation review when their platform-attested authority satisfies the gate; author/activator separation is not required.",
		) &&
		text.includes(
			"The Issue author may also perform the activation review when their platform-attested authority satisfies the gate.",
		) &&
		text.includes("the authenticated comment writer passed as its `writerId`") &&
		!text.includes("cannot be the Issue author for that activation") &&
		!text.includes("repository-configured automation account") &&
		!text.includes("the derivation's input out of the author's hands alone") &&
		text.includes("exactly `<!-- activation-verdict: pass -->` or `<!-- activation-verdict: reject -->`") &&
		text.includes("No label event, project-field edit, or untrusted comment substitutes for the verdict")
	);
}

test("§1.2/§2.2 permit an authorized Issue author without weakening verdict provenance", () => {
	assert.equal(authorCapableActivation(spec), true);
});

test("private-copy baseline mutant restoring author exclusion fails the contract check", () => {
	assert.equal(
		authorCapableActivation(
			spec.replace("author/activator separation is not required.", "cannot be the Issue author for that activation"),
		),
		false,
	);
});
