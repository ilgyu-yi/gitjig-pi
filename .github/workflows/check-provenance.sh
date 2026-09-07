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
in_domain=0
# Whether a hunk has been seen inside the CURRENT `diff --git` entry. A
# `+++ ` line is a file header only BEFORE the first hunk of its entry —
# looking one line back at `--- ` is not enough, because a REMOVED line
# whose own text begins `-- ` has exactly that spelling, so content could
# still steal the file and the line number. Entry state is what content
# cannot forge.
seen_hunk=0

# The longest line this reader will match against. A sentence is not 200 KB,
# and bash's matcher is quadratic in the subject's length: one minified .json
# or .js line costs minutes, and an advisory job killed by a timeout is a red
# X on a check designed never to fail a pull request. Beyond the cap the line
# is not read, which is a disclosed miss rather than a stall.
MAX_LINE=4000

# A well-formed unified hunk header. Anything else is not one, and the
# arithmetic below never runs on an unvalidated capture: a `@@`-leading line
# whose range does not parse once aborted the whole scan through an
# arithmetic-expansion error, and bash makes that fatal to the enclosing
# loop — so the remaining files were dropped and the run printed nothing,
# which is a stopped scan wearing a clean result.
# An ordinary unified hunk header, and a COMBINED one (`@@@ … @@@`, which
# merges produce and which carries one extra range). The merge-result range
# is always the LAST one, so each spelling names its own capture group.
HUNK_RE='^@@ -[0-9]+(,[0-9]+)? \+([0-9]+)(,[0-9]+)? @@'
COMBINED_HUNK_RE='^@@@+ (-[0-9]+(,[0-9]+)? )+\+([0-9]+)(,[0-9]+)? @@@'

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
  raw="${raw%$'\r'}"
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
  printf '    remedy: apply the erasure test (SPEC §2.5) — with the repository'"'"'s history AND its plans erased, does this sentence still read as documentation of the current HEAD? A forward-looking sentence that carries its own condition is a contract and stays; one whose truth depends on a plan recorded elsewhere is a schedule and goes. If not, DELETE it (§2.5 makes deletion the default repair), restate it as the invariant it is really about, or move it to the surface that owns it: issue (problem, intent, decision), PR (implementation and review), commit message (the atomic change), SPEC/README (the current contract), or a comment (current invariants, rationale, API semantics).\n'
}

# `|| [ -n "$raw" ]` so a final line with no trailing newline is still read.
while IFS= read -r raw || [ -n "$raw" ]; do
  # A new entry resets everything. Without this, a missed or spoofed header
  # leaves the PREVIOUS file's attribution in place and every downstream hit
  # navigates somewhere wrong; resetting turns that class into silence,
  # which is the cheaper failure.
  if [[ $raw == 'diff --git '* || $raw == 'diff --cc '* || $raw == 'diff --combined '* ]]; then
    path=""
    in_domain=0
    seen_hunk=0
    continue
  fi

  # A file header, admitted only before the first hunk of its entry.
  if [[ $seen_hunk == 0 && $raw == '+++ '* ]]; then
    path="$(header_path "${raw#+++ }")"
    lineno=0
    if [ "$path" = "/dev/null" ] || ! enters_domain "$path"; then
      in_domain=0
    else
      in_domain=1
    fi
    continue
  fi

  if [[ $raw =~ $HUNK_RE ]]; then
    seen_hunk=1
    lineno=$((BASH_REMATCH[2] - 1))
    continue
  fi
  if [[ $raw =~ $COMBINED_HUNK_RE ]]; then
    # The merge-result range is the last one, and a combined entry carries
    # one leading column per parent — so an added line's own text starts
    # after those columns, not after a single `+`.
    seen_hunk=1
    lineno=$((BASH_REMATCH[3] - 1))
    continue
  fi

  case "$raw" in
    '+'*)
      if [ -n "$path" ]; then
        lineno=$((lineno + 1))
        if [ "$in_domain" = 1 ] && [ "${#raw}" -le "$MAX_LINE" ]; then
          text="${raw#+}"
          # A combined entry's remaining `+` columns are diff syntax, not the
          # author's bytes.
          while [[ $text == '+'* ]]; do
            text="${text#+}"
          done
          # Trim a trailing CR, leading whitespace, and one comment marker, so
          # the report carries the sentence rather than the syntax around it.
          sentence="${text%$'\r'}"
          sentence="${sentence#"${sentence%%[![:space:]]*}"}"
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
done

if [ "$hits" -gt 0 ]; then
  printf '\ncheck-provenance: %s sentence(s) to re-read. This is advisory (SPEC §2.5) and blocks nothing.\n' "$hits"
fi

# Always zero. Refusing is out of contract for this reader.
exit 0
