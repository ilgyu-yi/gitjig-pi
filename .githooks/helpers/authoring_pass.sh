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
#   commit-msg surface, which is the one moment at which both the diff and
#   the message exist and the commit has not been made.
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

# The reader's wall-clock budget, in seconds. The arm cannot refuse a commit,
# but an unbounded shell-out can take one away by not returning: a reader
# that never exits leaves `git commit` parked with nothing to reap it, which
# is neither the fail-open §3.9 requires of this tier nor the no-op §3.2
# describes. The budget is generous because expiry costs a layout: a reader
# stopped early reports nothing, and reporting nothing on an ordinary large
# diff is the failure this arm is least able to notice.
#
# Overridable from the environment so an arm can drive the timeout path
# without waiting out the real budget. It is a knob on a REPORT's patience
# and on nothing else: no value of it refuses a commit, allows one, or
# reaches any predicate, so it is not an escape (§3.8) and owes no record.
# A value that is not a positive integer is ignored rather than trusted.
case "${AUTHORING_PASS_BUDGET_S:-}" in
  '' | 0 | *[!0-9]*) AUTHORING_PASS_BUDGET_S=30 ;;
esac

# _authoring_pass_read <reader> — run the reader over the staged diff under
# the budget above. Sets AUTHORING_PASS_REPORT and AUTHORING_PASS_STATUS,
# where the status is the reader's own exit code, `timeout`, or `no-scratch`.
# It is read rather than discarded: a crashed reader prints nothing, and
# empty output read as a verdict reports a run that never happened as a
# clean one. Always returns 0.
_authoring_pass_read() {
  local reader="$1" scratch tick waited=0 pid
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
    [ "$waited" -ge "$((AUTHORING_PASS_BUDGET_S * 10))" ] && break
    sleep "$tick" 2>/dev/null || sleep 1
    case "$tick" in
      1) waited=$((waited + 10)) ;;
      *) waited=$((waited + 1)) ;;
    esac
  done

  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null
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

# The disposition §2.5 owns, restated at the step it governs.
authoring_pass_rule() {
  cat <<'RULE'
  THE DISPOSITION — a flagged prose sentence is DELETED.
  It is never replaced, re-tensed, or re-derived. A rewrite is a fresh
  claim carrying the same burden the deleted one failed, and §2.5 makes
  deletion the default repair.

  Exceptions:
    1. A Judge's verbatim NIT remedy — the text is the Judge's, not yours.
    2. A wrong literal — a number, an identifier, a path — may be corrected
       in place. The sentence EXPLAINING it is deleted, not re-derived.
    3. Code, assertions and arm titles are not prose.
RULE
}

# authoring_pass_layout <message-file> — print the layout. Always returns 0.
authoring_pass_layout() {
  local msgfile="${1:-}"
  local top="${_gh_top:-}"

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
    _authoring_pass_read "$top/$AUTHORING_PASS_READER_REL"
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
          "$AUTHORING_PASS_BUDGET_S"
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
