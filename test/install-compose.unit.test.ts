import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { composeAdopter, encodePin, type Occupant } from "../.pi/extensions/gitjig/install/compose.ts";

let root: string;
before(() => {
	root = mkdtempSync(join(tmpdir(), "gitjig-compose-"));
});
after(() => {
	rmSync(root, { recursive: true, force: true });
});
function put(rel: string, body: string): void {
	const path = join(root, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
}

describe("#250 one composition owner", () => {
	it("derives snapshot, payload pin, and whole initial plan from one classification", () => {
		put(".pi/extensions/gitjig.ts", "runtime\n");
		put(".github/source.yml", "# gitjig: source-only\nname: dev\n");
		put(".githooks/adopter", "hook\n");
		put("changelog_unreleased/TEMPLATE.md", "template\n");
		put("changelog_unreleased/added/local.md", "local\n");
		const occupants = new Map<string, Occupant>([
			[".pi/extensions/gitjig.ts", { kind: "absent" }],
			[".githooks/adopter", { kind: "absent" }],
			["changelog_unreleased/TEMPLATE.md", { kind: "absent" }],
			[".pi/gitjig.pin.json", { kind: "absent" }],
		]);
		const result = composeAdopter({
			sourceRoot: root,
			source: { provider: "github", host: "github.com", owner: "o", repository: "r" },
			revision: "a".repeat(40),
			priorPinBytes: null,
			occupants,
		});
		assert.equal(result.candidates.length, 5);
		assert.deepEqual(
			JSON.parse(result.membershipSnapshot).members,
			result.candidates.map(({ path, disposition }) => ({ path, disposition })),
		);
		assert.deepEqual(
			result.pin.manifest.map(({ path, class: memberClass }) => [path, memberClass]),
			[
				[".githooks/adopter", "handed-over"],
				[".pi/extensions/gitjig.ts", "carried"],
				["changelog_unreleased/TEMPLATE.md", "handed-over"],
			],
		);
		assert.equal(result.plan.outcome, "planned");
		assert.equal(result.pinBytes.toString(), encodePin(result.pin));
		assert.match(result.membershipSnapshot, /instance-state/);
		assert.match(result.membershipSnapshot, /source-only/);
	});

	it("refuses a populated source policy before a projection plan exists", () => {
		put(
			".github/landing-policy.json",
			JSON.stringify({ schemaVersion: 1, appProducer: { installationId: 7, nodeId: "I_node" } }),
		);
		assert.throws(
			() =>
				composeAdopter({
					sourceRoot: root,
					source: { provider: "github", host: "github.com", owner: "o", repository: "r" },
					revision: "a".repeat(40),
					priorPinBytes: null,
					occupants: new Map(),
				}),
			/source landing policy is not the null-disabled scaffold/,
		);
	});
});
