# .githooks/helpers/branch_guard.sh — the protected-branch class's
# delegated predicate. Its interface is stated by `.githooks/_lib.sh` and the
# complete protected-identity derivation is stated below. Sourced
# by adapters, never executed; defines:
#   current_branch
#   is_protected_branch <target-refname-with-refs/heads/-stripped>
#
# Rule source: ONE derived identity P, derived in two stages and
# cached per hook invocation so a multi-ref push pays one derivation.
# Stage 1 reads the local pointer (`git symbolic-ref -q
# refs/remotes/origin/HEAD`, prefix stripped). Stage 2 — only where stage 1
# fails — measures the remote's advertised default (`git ls-remote --symref
# origin HEAD`, terminal prompts disabled), a measurement, never a guess
#. Stage 2 is keyed on the executing script's own
# name (`$0` basename `pre-push`) — a name, not the installed hook — so a
# caller whose basename is anything else, the commit surface included,
# never opens a network connection, while a caller named `pre-push` gains
# stage 2. Renaming away loses that read; naming another caller into it gains
# only a read that caller could run directly. Stage-2 failure is keyed by outcome:
# non-zero exit, or empty/unparseable output — a dangling remote HEAD
# yields empty output with exit 0.
#
# Where both stages fail, P is underivable: the gate is DISARMED for the
# run and says so plainly — exactly one audit warn record stating the gate
# is not enforced, then every call answers
# "not protected" so the adapter allows. Machinery degradation, never a
# refusal of the actor's input.
#
# With P in hand the boundary is total: byte-equal to P refuses;
# ASCII-case-fold-equal but byte-unequal also refuses as an unverifiable
# destination with its own distinct cause; anything else allows. Folding is
# ASCII-only under byte semantics (LC_ALL=C tr).
#
# Causes are content-free constants: the arm name only, never the target
# refname's bytes on stderr or in an audit record. This file emits the cause
# only; each calling surface appends its own recovery.
#
# Fail direction bookkeeping: the two refusals below are the LIVE predicate
# refusing the actor's own input. Degradation of
# the chain around this file — binding, helper file, delegated function,
# derivation — warns and allows as stated by the adapters that source it.
# Every git call reads stdin from /dev/null: the pre-push
# adapter's while-read loop over stdin is load-bearing, and a child that
# gulps stdin would silently starve it.

# The derivation cache is process state, never inherited state: git hands
# the pusher's environment to hooks, so an exported _PROJECT_BG_* pair could
# otherwise pre-seed the verdict (a traceless disarm, a decoy identity, or
# a set -u abort). Sourcing precedes every call, so discarding inherited
# values here preserves the per-invocation cache while closing the seed.
unset -v _PROJECT_BG_STATE _PROJECT_BG_P

# current_branch — total function: prints the branch's own name, or
# prints nothing and fails — no consumer reads an unvalidated value.
#
# The FULL refname is read and one `refs/heads/` prefix stripped, never
# `--short`. `--short` prints the shortest UNAMBIGUOUS spelling, which is a
# property of what else lives under `refs/` rather than of the branch: one
# `git tag <P>` makes it print `heads/<P>`, which compares unequal to P on
# both the byte-equal and the ASCII-fold arm and answers not-P — a traceless
# disarm of this arm, one innocuous command away. A HEAD resolving outside
# `refs/heads/` has no branch name and fails here rather than being reported
# under a spelling that is not its identity. This mirrors how the identity P
# itself is derived below: full refname, one prefix stripped.
current_branch() {
	local _bg_ref
	_bg_ref="$(git symbolic-ref -q HEAD 2>/dev/null </dev/null)" || return 1
	[ -n "$_bg_ref" ] || return 1
	case "$_bg_ref" in
	refs/heads/?*) ;;
	*) return 1 ;;
	esac
	printf '%s\n' "${_bg_ref#refs/heads/}"
	return 0
}

# _project_bg_fold <bytes> — ASCII-only case fold under byte semantics.
_project_bg_fold() {
	printf '%s' "$1" | LC_ALL=C tr 'A-Z' 'a-z'
}

# _project_bg_derive — derive and cache P. Returns 0 with _PROJECT_BG_P set
# (armed), or non-zero (disarmed; the one warn record already emitted).
_project_bg_derive() {
	case "${_PROJECT_BG_STATE:-}" in
	armed) return 0 ;;
	disarmed) return 1 ;;
	esac

	local _bg_ref
	if _bg_ref="$(git symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null </dev/null)" &&
		[ -n "$_bg_ref" ] && [ "$_bg_ref" != "${_bg_ref#refs/remotes/origin/}" ]; then
		_PROJECT_BG_P="${_bg_ref#refs/remotes/origin/}"
		_PROJECT_BG_STATE=armed
		return 0
	fi

	# Stage 2 — push surface only (the $0 keying stated above).
	if [ "${0##*/}" = "pre-push" ]; then
		local _bg_out _bg_line _bg_p
		if _bg_out="$(GIT_TERMINAL_PROMPT=0 git ls-remote --symref origin HEAD 2>/dev/null </dev/null)"; then
			_bg_line="${_bg_out%%$'\n'*}"
			case "$_bg_line" in
			"ref: refs/heads/"*$'\t'HEAD)
				_bg_p="${_bg_line#ref: refs/heads/}"
				_bg_p="${_bg_p%$'\t'HEAD}"
				case "$_bg_p" in
				'' | *$'\t'*) ;; # unparseable — fall through to disarmed
				*)
					_PROJECT_BG_P="$_bg_p"
					_PROJECT_BG_STATE=armed
					return 0
					;;
				esac
				;;
			esac
		fi
	fi

	_PROJECT_BG_STATE=disarmed
	if command -v audit_log >/dev/null 2>&1; then
		( audit_log warn branch not-enforced 'protected-branch gate not enforced: protected identity underivable (both derivation stages failed)' ) </dev/null >/dev/null 2>&1 || true
	fi
	return 1
}

# is_protected_branch <name> — 0 iff the caller must refuse the target.
is_protected_branch() {
	local _bg_target="${1-}"
	_project_bg_derive || return 1

	if [ "$_bg_target" = "$_PROJECT_BG_P" ]; then
		printf '%s\n' 'protected-branch: the target is the derived protected identity — refusing' >&2
		return 0
	fi
	if [ "$(_project_bg_fold "$_bg_target")" = "$(_project_bg_fold "$_PROJECT_BG_P")" ]; then
		printf '%s\n' 'protected-branch: the target is ASCII-case-fold-equal to the derived protected identity and the destination ref cannot be verified client-side — ambiguous, refusing' >&2
		return 0
	fi
	return 1
}
