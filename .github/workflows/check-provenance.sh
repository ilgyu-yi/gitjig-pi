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
#   silence genuine hits in exactly the files most likely to grow them. An
#   arm pins the behaviour — a mention is reported like a use — so it is a
#   known quantity rather than a surprise. No count is stated here: §2.4
#   forbids a roster a future commit can silently falsify, and this reader's
#   own hit count moves with every commit that touches its fixtures.
#
#   NOT A PARSER. Matching is per line, so a sentence wrapped across two
#   lines is seen as two fragments and may be missed.
#
# Pure bash. No third-party Actions; runs under check-provenance.yml.

set -uo pipefail

# The rules this reader applies: ONE ROW PER ALTERNATIVE, each with the
# shape it belongs to. The suite reads THIS table and requires a case for
# every row, so an alternative that matches nothing — deleted, typo'd, or
# broken by a stray metacharacter — fails rather than being believed.
#
# Rows and not four fat regexes, because a rule pinned at the granularity
# of the shape name leaves its alternatives unmeasured: at four regexes,
# thirteen of twenty-one alternatives could be deleted with the whole suite
# still green. The table is the population and the suite binds it.
SHAPES=()
PATTERNS=()
RULE() {
  SHAPES+=("$1")
  PATTERNS+=("$2")
}

RULE schedule 'red until'
RULE schedule 'until Phase'
RULE schedule 'does not exist yet'
RULE schedule 'not yet (implemented|landed|written)'
RULE schedule '(once|after) [^,]{1,40} lands'
RULE schedule 'will be (added|implemented|landed|removed)'
RULE review-archaeology '[Rr]eview round'
RULE review-archaeology '[Rr]ound [0-9]+ (found|caught|raised)'
RULE review-archaeology '[Tt]he reviewer (found|caught|noted)'
RULE review-archaeology '[Aa]n? (previous|prior|earlier) review'
RULE issue-narration '[Aa]dded in #[0-9]+'
RULE issue-narration '[Ii]ntroduced in #[0-9]+'
RULE issue-narration '[Ff]ixed in #[0-9]+'
RULE issue-narration '[Rr]emoved in #[0-9]+'
RULE issue-narration '[Ll]anded in #[0-9]+'
RULE change-narration '[Ww]e (added|removed|changed|renamed|introduced|dropped)'
RULE change-narration '([Tt]his|[Ii]t) was (added|introduced|renamed|removed)'
RULE change-narration 'used to (be|have|carry|call)'
RULE change-narration 'was previously'
RULE change-narration 'previously called'
RULE change-narration 'formerly (called|named)'

# Living-set extensions. A path whose extension is absent here is not read.
LIVING_RE='\.(ts|tsx|js|mjs|sh|md|yml|yaml|json|jsonc)$'
# Record-purpose paths (§2.5's carve-out (d)) — excluded by path.
RECORD_RE='^changelog_unreleased/'

hits=0
path=""
lineno=0
prev=""
in_domain=0

# A well-formed unified hunk header. Anything else is not one, and the
# arithmetic below never runs on an unvalidated capture: a `@@`-leading line
# whose range does not parse once aborted the whole scan through an
# arithmetic-expansion error, and bash makes that fatal to the enclosing
# loop — so the remaining files were dropped and the run printed nothing,
# which is a stopped scan wearing a clean result.
HUNK_RE='^@@+ -[0-9]+(,[0-9]+)? \+([0-9]+)(,[0-9]+)? @@'

# Whether this path is read at all. Decided ONCE per file rather than per
# line: the domain is a property of the surface, not of the sentence.
enters_domain() {
  local p="$1"
  [[ $p =~ $LIVING_RE ]] || return 1
  [[ $p =~ $RECORD_RE ]] && return 1
  return 0
}

# git's own header spellings. A path carrying whitespace gets a trailing tab
# and metadata; a path carrying non-ASCII or a control byte arrives
# C-quoted. Both were silently skipped whole before they were handled here,
# which is a fail-open miss on exactly the files least likely to be noticed.
header_path() {
  local raw="$1"
  raw="${raw%%$'\t'*}"
  if [[ $raw == '"'*'"' ]]; then
    raw="${raw#\"}"
    raw="${raw%\"}"
  fi
  printf '%s' "${raw#b/}"
}

emit() {
  local shape="$1" file="$2" line="$3" text="$4"
  hits=$((hits + 1))
  printf '%s:%s: [%s] %s\n' "$file" "$line" "$shape" "$text"
  printf '    remedy: apply the erasure test (SPEC §2.5) — with the repository'"'"'s history erased, does this sentence still read as documentation of the current HEAD? If not, DELETE it (§2.5 makes deletion the default repair), restate it as the invariant it is really about, or move it to the surface that owns it: issue (problem, intent, decision), PR (implementation and review), commit message (the atomic change), SPEC/README (the current contract), or a comment (current invariants, rationale, API semantics).\n'
}

while IFS= read -r raw; do
  # A `+++ ` line is a FILE HEADER only where one can appear: immediately
  # after the matching `--- ` line. Without that guard an added line whose
  # own text begins with `++ ` reads as a header, and the reader then
  # attributes every following hit to a file that is not in the diff — a
  # report that navigates to the wrong place is worse than no report.
  if [[ $raw == '+++ '* && $prev == '--- '* ]]; then
    path="$(header_path "${raw#+++ }")"
    lineno=0
    if [ "$path" = "/dev/null" ] || ! enters_domain "$path"; then
      in_domain=0
    else
      in_domain=1
    fi
    prev="$raw"
    continue
  fi

  if [[ $raw =~ $HUNK_RE ]]; then
    # The capture is validated by the match itself, so the arithmetic below
    # cannot be handed a non-number. Pre-incremented per added line, so it
    # starts one below the hunk's first added line.
    lineno=$((BASH_REMATCH[2] - 1))
    prev="$raw"
    continue
  fi

  case "$raw" in
    '+'*)
      if [ -n "$path" ]; then
        lineno=$((lineno + 1))
        if [ "$in_domain" = 1 ]; then
          text="${raw#+}"
          # Trim leading whitespace and comment markers so the report carries
          # the sentence rather than the syntax around it. A trailing CR from
          # a CRLF input goes too, so it cannot ride into the report.
          sentence="${text%$'\r'}"
          sentence="${sentence#"${sentence%%[![:space:]]*}"}"
          sentence="${sentence###+([[:space:]])}"
          case "$sentence" in
            '//'*) sentence="${sentence#//}" ;;
            '#'*) sentence="${sentence#\#}" ;;
            '*'*) sentence="${sentence#\*}" ;;
            '--'*) sentence="${sentence#--}" ;;
          esac
          sentence="${sentence#"${sentence%%[![:space:]]*}"}"
          if [ -n "$sentence" ]; then
            # First matching rule wins, so one sentence draws one hit however
            # many rules it satisfies — the report counts sentences to
            # re-read, not rules that fired.
            for i in "${!PATTERNS[@]}"; do
              if [[ $sentence =~ ${PATTERNS[$i]} ]]; then
                emit "${SHAPES[$i]}" "$path" "$lineno" "$sentence"
                break
              fi
            done
          fi
        fi
      fi
      ;;
    ' '*)
      [ -n "$path" ] && lineno=$((lineno + 1))
      ;;
  esac
  prev="$raw"
done

if [ "$hits" -gt 0 ]; then
  printf '\ncheck-provenance: %s sentence(s) to re-read. This is advisory (SPEC §2.5) and blocks nothing.\n' "$hits"
fi

# Always zero. Refusing is out of contract for this reader.
exit 0
