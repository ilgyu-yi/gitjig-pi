/**
 * The one adapter rule for which lifecycle marker comments are attested
 * (#276, #347). The handed-over engine owns every record and terminal
 * predicate; this module only decides, per carrying comment, whether its
 * platform author may carry that marker, then hands the population back to
 * the engine's inspectors.
 *
 * Warning-surface roster: EXEMPT — this module returns attestation flags and
 * emits no warning, record, or operator-facing text.
 */
type Engine = typeof import("../../../.github/workflows/gitjig-lifecycle.mjs");

export interface LifecycleComment {
	id: number;
	authorId: string;
	authorLogin?: string;
	authorType?: string;
	body: string;
}

export type AttestedLifecycleComment = LifecycleComment & { attested: boolean };

/** Live same-repository permission for one author, or undefined when unreadable. */
export type PermissionOf = (comment: LifecycleComment) => Promise<string | undefined>;

/** The workflow's first-party producer identity for awaiting-author human reviews and terminals. */
function firstPartyBot(comment: LifecycleComment): boolean {
	return comment.authorLogin === "github-actions[bot]" && comment.authorType === "Bot";
}

async function authorizedUser(
	engine: Engine,
	comment: LifecycleComment,
	repositoryId: string,
	permissionOf: PermissionOf,
): Promise<boolean> {
	// The engine's predicate owns the User-only gate; a Bot reaches it and fails there.
	if (typeof comment.authorLogin !== "string") return false;
	const permission = await permissionOf(comment);
	return engine.authorizedResolver({
		actorId: comment.authorId,
		actorType: comment.authorType,
		repositoryId,
		addressedRepositoryId: repositoryId,
		permission: permission?.toUpperCase(),
	});
}

/**
 * Attest the awaiting-author marker comments exactly as #276's publication
 * adapter always has: a terminal or a human-review record needs the
 * first-party workflow bot; a Resolver record needs its own producer as the
 * carrying User with live resolver permission. A bot's author identity is its
 * login, matching the terminal's `clearerId`.
 */
export async function attestAwaitingAuthorComments(
	engine: Engine,
	comments: readonly LifecycleComment[],
	repositoryId: string,
	permissionOf: PermissionOf,
): Promise<AttestedLifecycleComment[]> {
	const trusted: AttestedLifecycleComment[] = [];
	for (const comment of comments) {
		const terminal = comment.body.startsWith(engine.RECORD_MARKERS.awaitingAuthorTerminal);
		const awaiting = comment.body.startsWith(engine.RECORD_MARKERS.awaitingAuthor);
		if (!terminal && !awaiting) continue;
		const bot = firstPartyBot(comment);
		let attested = terminal ? bot : false;
		if (awaiting) {
			const record = engine.parseMarkedRecord(comment.body, engine.RECORD_MARKERS.awaitingAuthor);
			if (record?.producerKind === "human-changes-requested") attested = bot;
			if (record?.producerKind === "resolver-repair" && record.producer === comment.authorId)
				attested = await authorizedUser(engine, comment, repositoryId, permissionOf);
		}
		trusted.push({
			...comment,
			authorId: bot ? (comment.authorLogin ?? comment.authorId) : comment.authorId,
			attested,
		});
	}
	return trusted;
}

/**
 * Attest blocked and handoff records and their terminals (SPEC §5.9, #347).
 * They carry no producer or clearer field, so each carrying comment's own
 * platform author must be a User passing the existing `authorizedResolver`
 * predicate for this repository. A Bot has no independent first-party
 * producer proof for these markers, so it is never attested.
 */
export async function attestTransitionComments(
	engine: Engine,
	comments: readonly LifecycleComment[],
	repositoryId: string,
	permissionOf: PermissionOf,
): Promise<AttestedLifecycleComment[]> {
	const markers = [
		engine.RECORD_MARKERS.blocked,
		engine.RECORD_MARKERS.blockedTerminal,
		engine.RECORD_MARKERS.handoff,
		engine.RECORD_MARKERS.handoffTerminal,
	];
	const attested: AttestedLifecycleComment[] = [];
	for (const comment of comments) {
		if (!markers.some((marker) => comment.body.startsWith(marker))) continue;
		attested.push({ ...comment, attested: await authorizedUser(engine, comment, repositoryId, permissionOf) });
	}
	return attested;
}
