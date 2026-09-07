#!/usr/bin/env bash
# check-provenance.sh — development-provenance reader (issue #70).
#
# Reads a unified diff on stdin and reports development provenance (SPEC
# §2.4) on the ADDED lines of living-set files: text a reader does not need
# in order to understand the current contract, because it describes how the
# repository got here.
#
# Usage:
#   git diff --unified=0 <base>...HEAD | check-provenance.sh
#
# ADVISORY BY CONSTRUCTION. It exits 0 on every input, including one that
# reports hits. §2.5 states that no gate class homes a decidable check for
# the authoring doctrine, and §3.6's cost asymmetry puts a reversible
# stale-prose miss far below a false block over ordinary documentation. The
# output is an instruction to re-read a sentence, never a verdict — the
# remedy on every hit is §2.5's erasure test, which a human applies.
#
# DOMAIN. Living-set files only: source, config and *.md. Record-purpose
# paths are excluded BY PATH and never by how the line reads — a changelog
# fragment's whole purpose is to record how the repository got here, and its
# TEMPLATE.md mandates the `(#N)` a narration rule would flag. Removed lines
# are never scanned: deletion is §2.5's prescribed repair, so reporting it
# would report the fix as the defect. Issue bodies, pull request bodies and
# commit messages are outside the domain structurally rather than by a rule
# — none of them is a file, so none can reach this input.
#
# RESIDUALS, stated because a clean run must not be read as clean prose.
#
#   FALSE NEGATIVES, deliberately. `now`, `no longer`, `still` and a bare
#   `#N` pointer are NOT matched. Each is ordinary current-state prose and
#   §5.1 commits every durable artifact to the bare pointer idiom, so
#   matching them would turn §2.5's erasure test into a word filter and
#   produce exactly the false block §3.6 rejects. The cost is real and is
#   the accepted side: narration spelled with those words passes unreported.
#
#   FALSE POSITIVES. `previously`, `used to` and `formerly` also spell a
#   legitimate compatibility fact ("v1 messages remain accepted"). §2.4
#   draws that line at fact-versus-provenance and no pattern decides it, so
#   these are reported for a human to judge — which is why this reader
#   cannot become a gate without first solving a problem it does not solve.
#
#   USE VERSUS MENTION, and this one is unavoidable rather than merely
#   accepted. A line that quotes a provenance shape in order to DEFINE,
#   TEST or FORBID it is reported exactly like one that commits it. This
#   file's own pattern list, SPEC §2.4's defining example, and the reader's
#   test fixtures are all reported, and correctly so under any rule this
#   reader could carry: the alternative is a path allowlist, which would
#   silence genuine hits in exactly the files most likely to grow them. The
#   measured population on the change that introduced this reader was 13,
#   every one a mention. An arm pins that number's shape so it is a known
#   quantity rather than a surprise.
#
#   NOT A PARSER. Matching is per line, so a sentence wrapped across two
#   lines is seen as two fragments and may be missed.
#
# Pure bash. No third-party Actions; runs under check-provenance.yml.

set -uo pipefail

# The shapes this reader claims to cover. The suite reads this list off this
# file and requires a case for each, so a shape named here and unmeasured
# fails rather than being believed.
#
# SHAPE: schedule
# SHAPE: review-archaeology
# SHAPE: change-narration
# SHAPE: issue-narration

# One extended-regex per shape, applied to the added line's text.
SCHEDULE_RE='red until|until Phase|does not exist yet|not yet (implemented|landed|written)|(once|after) [^,]{1,40} lands|will be (added|implemented|landed|removed)'
ARCHAEOLOGY_RE='[Rr]eview round|round [0-9]+ (found|caught|raised)|the reviewer (found|caught|noted)|a (previous|prior|earlier) review'
NARRATION_RE='[Ww]e (added|removed|changed|renamed|introduced|dropped)|(this|it) was (added|introduced|renamed|removed)|used to (be|have|carry|call)|was previously|previously called|formerly (called|named)'
ISSUE_NARRATION_RE='[Aa]dded in #[0-9]+|[Ii]ntroduced in #[0-9]+|[Ff]ixed in #[0-9]+|[Rr]emoved in #[0-9]+|[Ll]anded in #[0-9]+'

# Living-set extensions. A path whose extension is absent here is not read.
LIVING_RE='\.(ts|tsx|js|mjs|sh|md|yml|yaml|json|jsonc)$'
# Record-purpose paths (§2.5's carve-out (d)) — excluded by path.
RECORD_RE='^changelog_unreleased/'

hits=0
path=""
lineno=0

emit() {
  local shape="$1" file="$2" line="$3" text="$4"
  hits=$((hits + 1))
  printf '%s:%s: [%s] %s\n' "$file" "$line" "$shape" "$text"
  printf '    remedy: apply the erasure test (SPEC §2.5) — with the repository'"'"'s history erased, does this sentence still read as documentation of the current HEAD? If not, delete it or move it to the surface that owns it (issue, PR, or commit message).\n'
}

while IFS= read -r raw; do
  case "$raw" in
    '+++ b/'*)
      path="${raw#+++ b/}"
      lineno=0
      continue
      ;;
    '+++ '*)
      # /dev/null and any other spelling: nothing to attribute a hit to.
      path=""
      continue
      ;;
    '@@'*)
      # @@ -a,b +c,d @@ — c is the first added line number of this hunk.
      hunk="${raw#*+}"
      hunk="${hunk%% *}"
      lineno="${hunk%%,*}"
      # The counter is pre-incremented per added line, so start one below.
      lineno=$((lineno - 1))
      continue
      ;;
    '+'*)
      [ -n "$path" ] || continue
      lineno=$((lineno + 1))
      # Domain: living set, excluding record-purpose paths.
      printf '%s' "$path" | grep -qE "$LIVING_RE" || continue
      printf '%s' "$path" | grep -qE "$RECORD_RE" && continue
      text="${raw#+}"
      # Trim leading whitespace and comment markers so the report carries the
      # sentence rather than the syntax around it.
      sentence="$(printf '%s' "$text" | sed -E 's/^[[:space:]]*//; s@^(//|#|\*|--)[[:space:]]*@@; s/^[[:space:]]*//')"
      [ -n "$sentence" ] || continue
      if printf '%s' "$sentence" | grep -qE "$SCHEDULE_RE"; then
        emit schedule "$path" "$lineno" "$sentence"
      elif printf '%s' "$sentence" | grep -qE "$ARCHAEOLOGY_RE"; then
        emit review-archaeology "$path" "$lineno" "$sentence"
      elif printf '%s' "$sentence" | grep -qE "$ISSUE_NARRATION_RE"; then
        emit issue-narration "$path" "$lineno" "$sentence"
      elif printf '%s' "$sentence" | grep -qE "$NARRATION_RE"; then
        emit change-narration "$path" "$lineno" "$sentence"
      fi
      ;;
    ' '*)
      [ -n "$path" ] && lineno=$((lineno + 1))
      ;;
    *)
      continue
      ;;
  esac
done

if [ "$hits" -gt 0 ]; then
  printf '\ncheck-provenance: %s sentence(s) to re-read. This is advisory (SPEC §2.5) and blocks nothing.\n' "$hits"
fi

# Always zero. Refusing is out of contract for this reader.
exit 0
