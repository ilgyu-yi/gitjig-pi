#!/usr/bin/env bash
# authoring_pass.sh — the pre-commit authoring pass (issue #218).
#
# Exposes ONE delegated function:
#   authoring_pass_layout <message-file>
#
# WHAT IT IS, AND WHAT IT IS NOT. The step it serves has two halves, and only
# one of them is mechanizable:
#
#   LAYING OUT the staged diff and the prepared commit message together is a
#   machine act, and this function performs it. It runs at the tier-2
#   commit-msg surface.
#
#   READING them as a reviewer would, and deleting what does not survive, is
#   a judgement. No gate class homes a decidable check for it (§2.5), so it
#   stays a discipline and this function only states it.
#
# So this is a REPORT-ONLY surface (§3.11): it establishes that the layout
# was produced, and it establishes nothing whatever about the truth of the
# message or of the diff. It never refuses; its caller never reads a status
# from it. A green commit is not a vouched commit.
#
# FAIL POLICY (§3.9): every step is best-effort and degrades to a printed
# line naming what was not laid out. A layout that cannot run must never
# stand between an operator and a commit — the guarded act here is reading,
# and a refusal cannot make anyone read.
#
# SINGLE SOURCE (§3.11). The prose reader is NOT reimplemented here. This is
# the second CALL SITE of the one predicate that CI's check-provenance job
# also calls. The reader is advisory by construction and exits 0 on every
# input.

# Where the committed reader stands, relative to the repository top the tier
# already derived. Named once so a move is one edit.
AUTHORING_PASS_READER_REL=".github/workflows/check-provenance.sh"

# The reader's wall-clock budget, in seconds, and its closed range. The arm
# cannot refuse a commit, but an unbounded shell-out can take one away by not
# returning: a reader that never exits leaves `git commit` parked with
# nothing to reap it, which is neither the fail-open §3.9 requires of this
# tier nor the no-op §3.2 describes.
#
# THE BUDGET IS COMPILED IN AND THE ENVIRONMENT CANNOT REACH IT. How long a
# commit is held is not the committing environment's to choose.
#
# The only seam is `authoring_pass_layout`'s optional second argument, which
# the adapter never passes and which clamps to the range below, defaulting
# outside it — all-digit values included.
#
# WHY 20. The reader's cost is linear in the staged diff's added lines, at
# roughly 0.3ms each on the authoring host:
#
#     $ git diff --cached --unified=0 | check-provenance.sh   # timed
#       1,000 lines      309ms
#      10,000 lines    2,991ms
#      40,000 lines   11,839ms
#
# so 20s clears a 40,000-line staged diff by a factor of 1.7. Expiry costs a
# layout and nothing else, which is why the margin is that and not more.
AUTHORING_PASS_BUDGET_S=20
AUTHORING_PASS_BUDGET_MAX_S=120

# _authoring_pass_signal_tree <pid> — TERM the direct children of <pid>.
# `pgrep -P` is used where it exists and the function is a no-op where it does
# not: a missing tool costs the reap, never the layout. Always returns 0.
_authoring_pass_signal_tree() {
  local parent="$1" child
  command -v pgrep >/dev/null 2>&1 || return 0
  for child in $(pgrep -P "$parent" 2>/dev/null); do
    kill -TERM "$child" 2>/dev/null
  done
  return 0
}

# _authoring_pass_read <reader> — run the reader over the staged diff under
# the budget above. Sets AUTHORING_PASS_REPORT and AUTHORING_PASS_STATUS,
# where the status is the reader's own exit code, `timeout`, or `no-scratch`.
# It is read rather than discarded: a crashed reader prints nothing, and
# empty output read as a verdict reports a run that never happened as a
# clean one. Always returns 0.
_authoring_pass_read() {
  local reader="$1" budget="$2" scratch tick waited=0 pid
  AUTHORING_PASS_REPORT=""
  AUTHORING_PASS_STATUS=""

  scratch="$(mktemp -d 2>/dev/null)" || scratch=""
  if [ -z "$scratch" ]; then
    AUTHORING_PASS_STATUS="no-scratch"
    return 0
  fi

  # A sub-second tick where the platform's sleep takes one, so an ordinary
  # fast reader is not charged a whole second on every commit. Probed once
  # rather than assumed: POSIX sleep takes an integer.
  tick=0.1
  sleep "$tick" 2>/dev/null || tick=1

  (
    git diff --cached --unified=0 </dev/null 2>/dev/null |
      bash "$reader" >"$scratch/out" 2>/dev/null
    printf '%s' "$?" >"$scratch/rc"
  ) &
  pid=$!

  while kill -0 "$pid" 2>/dev/null; do
    # Compared in tenths so the loop needs no floating-point arithmetic.
    [ "$waited" -ge "$((budget * 10))" ] && break
    sleep "$tick" 2>/dev/null || sleep 1
    case "$tick" in
      1) waited=$((waited + 10)) ;;
      *) waited=$((waited + 1)) ;;
    esac
  done

  if kill -0 "$pid" 2>/dev/null; then
    # The subshell's own children — `git diff` and the reader — are signalled
    # too, and the subshell is reaped before the scratch is removed: TERM to
    # the subshell alone leaves the pipeline running, and `rm -rf` would then
    # race a live descriptor on an unlinked inode.
    #
    # Enumerated in place (§3.11) and NOT closed: a child that ignores TERM,
    # or one that has already forked a grandchild, survives this. Those
    # processes hold no descriptor of the hook — stdout is the scratch file
    # and stderr is /dev/null — so they neither hold the commit nor reach the
    # operator; the residual is wasted work, not a wedged git.
    _authoring_pass_signal_tree "$pid"
    kill -TERM "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    AUTHORING_PASS_STATUS="timeout"
  else
    wait "$pid" 2>/dev/null
    AUTHORING_PASS_STATUS="$(cat "$scratch/rc" 2>/dev/null)"
    AUTHORING_PASS_REPORT="$(cat "$scratch/out" 2>/dev/null)"
    [ -n "$AUTHORING_PASS_STATUS" ] || AUTHORING_PASS_STATUS="no-status"
  fi

  rm -rf "$scratch" 2>/dev/null
  return 0
}

# §2.5's "Deletion is the default repair" paragraph is the rule source. What
# this function prints is the working form of it, at the step it governs;
# §2.8 forbids a digest that drops a clause's qualifiers, so the clause's own
# repair case is the last line of the list and the pointer is on the first.
# The text is pinned whole-string by an arm, so the copy cannot drift from
# the clause silently.
authoring_pass_rule() {
  cat <<'RULE'
  THE DISPOSITION (SPEC §2.5, "Deletion is the default repair")
  A flagged prose sentence is DELETED. It is not replaced, re-tensed, or
  re-derived: a rewrite is a fresh claim carrying the same burden the
  deleted one failed.

  Exceptions:
    1. A Judge's verbatim NIT remedy — the text is the Judge's, not yours.
    2. A wrong literal — a number, an identifier, a path — may be corrected
       in place. The sentence EXPLAINING it is deleted, not re-derived.
    3. Code, assertions and arm titles are not prose.
    4. A claim an acceptance criterion or a live contract depends on is
       REPAIRED, not deleted, and the repair carries a render or a pointer.
RULE
}

# authoring_pass_layout <message-file> [budget-seconds] — print the layout.
# Always returns 0.
#
# The second argument is the reader's budget and the adapter never passes it;
# it exists so an arm can drive the expiry path without waiting out the
# compiled-in budget. An argument is not an environment variable: a caller
# who can pass it is already running this function. It clamps to
# 1..AUTHORING_PASS_BUDGET_MAX_S, and anything else — empty, non-digit, zero,
# or an all-digit value above the ceiling — takes the compiled-in default.
authoring_pass_layout() {
  local msgfile="${1:-}"
  local budget="${2:-}"
  local top="${_gh_top:-}"

  case "$budget" in
    '' | 0 | *[!0-9]*) budget="$AUTHORING_PASS_BUDGET_S" ;;
    *) [ "$budget" -gt "$AUTHORING_PASS_BUDGET_MAX_S" ] && budget="$AUTHORING_PASS_BUDGET_S" ;;
  esac

  printf '\n───────── authoring pass (SPEC §2.4, §2.5) — advisory, blocks nothing\n'

  printf '───────── the diff this message is about\n'
  if [ -n "$(git diff --cached --name-only </dev/null 2>/dev/null)" ]; then
    git diff --cached --stat </dev/null 2>/dev/null | sed 's/^/  /'
  else
    printf '  (nothing staged — the message below claims something about an empty diff)\n'
  fi

  printf '───────── the message you are about to write\n'
  if [ -n "$msgfile" ] && [ -f "$msgfile" ]; then
    sed 's/^/  /' "$msgfile"
  else
    printf '  (not laid out: no regular message file was supplied)\n'
  fi

  printf '───────── prose the diff ADDS\n'
  if [ -z "$top" ]; then
    printf '  (not laid out: the repository top was not resolved, so %s was not located)\n' \
      "$AUTHORING_PASS_READER_REL"
  elif [ ! -f "$top/$AUTHORING_PASS_READER_REL" ]; then
    printf '  (not laid out: %s is absent, so the reader ran on nothing)\n' \
      "$AUTHORING_PASS_READER_REL"
  else
    _authoring_pass_read "$top/$AUTHORING_PASS_READER_REL" "$budget"
    case "$AUTHORING_PASS_STATUS" in
      0)
        if [ -n "$AUTHORING_PASS_REPORT" ]; then
          printf '%s\n' "$AUTHORING_PASS_REPORT" | sed 's/^/  /'
        else
          printf '  (no row matched. The rows are an enumeration and never a class, so a clean run is not clean prose — the read below is the check.)\n'
        fi
        ;;
      timeout)
        printf '  (not laid out: the reader did not finish within %ss and was stopped, so nothing here is a clean run)\n' \
          "$budget"
        ;;
      no-status)
        printf '  (not laid out: the reader was stopped before it recorded a status, so nothing here is a clean run)\n'
        ;;
      no-scratch)
        printf '  (not laid out: no scratch directory could be made, so the reader was not run)\n'
        ;;
      *)
        printf '  (not laid out: the reader exited %s, so nothing here is a clean run)\n' \
          "$AUTHORING_PASS_STATUS"
        ;;
    esac
  fi

  printf '───────── read the two together, then\n'
  authoring_pass_rule
  # The layout's own closing marker. It bounds the block for any reader that
  # must separate this arm's emission from the rest of the chain's: an
  # opening banner alone bounds the block only while nothing is emitted
  # after it, which is a property of today's adapter and not of the layout.
  printf '───────── end authoring pass\n\n'
  return 0
}
