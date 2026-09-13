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
#   machine act, and this function performs it. It is forced at the tier-2
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

# The rule, recorded HERE and in no second home (§3.11): this function is
# where the step happens, so this is where its disposition lives.
authoring_pass_rule() {
  cat <<'RULE'
  THE DISPOSITION — a flagged prose sentence is DELETED.
  It is never replaced, re-tensed, or re-derived. A rewrite is a fresh
  claim carrying the same burden the deleted one failed, and §2.5 makes
  deletion the default repair.

  Exceptions, and only these three:
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
  local reader=""
  [ -n "$top" ] && reader="$top/$AUTHORING_PASS_READER_REL"
  if [ -n "$reader" ] && [ -f "$reader" ]; then
    local report
    report="$(git diff --cached --unified=0 </dev/null 2>/dev/null | bash "$reader" 2>/dev/null)"
    if [ -n "$report" ]; then
      printf '%s\n' "$report" | sed 's/^/  /'
    else
      printf '  (no row matched. The rows are an enumeration and never a class, so a clean run is not clean prose — the read below is the check.)\n'
    fi
  else
    printf '  (not laid out: %s is absent, so the reader ran on nothing)\n' \
      "$AUTHORING_PASS_READER_REL"
  fi

  printf '───────── read the two together, then\n'
  authoring_pass_rule
  printf '\n'
  return 0
}
