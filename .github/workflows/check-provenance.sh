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
#   Also missed, and named because narrowing a rule opens a gap that owes a
#   disclosure: the archaeology rules want a NUMBERED round or the plural, so
#   a spelled ordinal — "Review round three asked for this" — is unreported.
#   The narrowing was the price of not matching "the review round trip", a
#   live feature name, and the miss is the cheaper side of that trade.
#
#   The possessive and verb rules are narrowed the same way and owe the same
#   disclosure. UNREPORTED, measured: a round bound to a verb outside the
#   listed set ("round 2 adjudicated the global shape"); a possessive whose
#   label begins with a digit ("round 3's 2nd limb"); and a finding label
#   whose prefix is outside the roster the label rule carries. Each is the
#   price of not reporting ordinary prose, and each is a real miss.
#
#   FALSE POSITIVES, in four measured classes. `previously`, `used to`,
#   `formerly` and `(first|earlier|previous|original) (draft|wording|version)
#   of` also spell a legitimate compatibility fact ("v1 messages remain
#   accepted", "the previous version of the payload is still accepted");
#   §2.4 draws that line at fact-versus-provenance and no pattern decides it.
#   The fourth is listed with the other three rather than narrowed, because
#   what separates the two readings is the sentence's claim and not its
#   words. `(once|after) X lands` also spells a CONTRACT whose
#   condition resolves from the living set — "these arms hold while the
#   helper is absent AND after it lands" is present-tense prose about a
#   chain, which §2.5 explicitly acquits and this rule reports anyway;
#   deciding it needs the resolvability test, which is a human's to apply.
#   And a shape name can appear inside a feature name — a `[Rr]eview round`
#   token matches "the review round trip", the name of a live command flow,
#   which is why that rule requires a number or the plural. The same shape
#   reaches further than a feature name: `[Rr]ound` with no left boundary
#   matches inside `background`, which is why every rule added for the
#   possessive and verb spellings carries `(^|[^A-Za-z])`.
#
#   All three are reported for a human to judge, which is why this reader
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
#   GIT'S SPELLING, not every unified diff. File headers are admitted only
#   before the first hunk of a `diff --git` / `diff --cc` entry, which is
#   what stops content shaped like a header from stealing the attribution.
#   Concatenated plain `diff -u` output carries no entry markers, so after
#   the first hunk its later file headers are ignored. The usage line above
#   is the documented domain.
#
# Pure bash. No third-party Actions; runs under check-provenance.yml.

set -uo pipefail

# The rules this reader applies: ONE ROW PER ALTERNATIVE, each with the
# shape it belongs to. The suite reads THIS table and requires a case for
# every row, so an alternative that matches nothing — deleted, typo'd, or
# broken by a stray metacharacter — fails rather than being believed.
#
# Rows and not one fat regex per shape, because a rule pinned at the
# granularity of the shape NAME leaves its alternatives unmeasured: under
# that spelling most alternatives can be deleted with the whole suite still
# green, since one fixture satisfies its shape through a different
# alternative. The table is the population and the suite binds it. No count
# is stated: a count here is exactly what the next widening falsifies.
SHAPES=()
PATTERNS=()
RULE() {
  SHAPES+=("$1")
  PATTERNS+=("$2")
}

RULE schedule 'red until'
RULE schedule 'until Phase'
RULE schedule 'until #[0-9]+'
RULE schedule 'does not exist yet'
RULE schedule 'not yet (implemented|landed|written)'
RULE schedule '(once|after) [^,]{1,40} lands'
RULE schedule 'will be (added|implemented|landed|removed)'
RULE review-archaeology '[Rr]eview round [0-9]'
RULE review-archaeology '[Rr]eview rounds'
RULE review-archaeology '[Rr]ound [0-9]+ (found|caught|raised)'
RULE review-archaeology '[Tt]he reviewer (found|caught|noted)'
RULE review-archaeology '[Aa]n? (previous|prior|earlier) review'
# The spellings that actually carry this class, which the five rows above do
# not reach. Each carries its own LEFT boundary, because `[Rr]ound` with none
# matches inside `background` and `foreground`.
#
# The possessive is written `[^0-9[:space:]]s` rather than `.s`: a RULE
# pattern is single-quoted, so it cannot carry an apostrophe, and a bare `.`
# there also matches a digit — which reports `a round 30s budget` as
# archaeology. The class excludes digits and space for exactly that reason.
RULE review-archaeology '(^|[^A-Za-z])(ROUND|Round|round) [0-9]+[^0-9[:space:]]s [A-Za-z]'
RULE review-archaeology '(^|[^A-Za-z])(ROUND|Round|round)-[0-9]+ (finding|nit|[A-Z])'
RULE review-archaeology '(^|[^A-Za-z])(ROUND|Round|round) [0-9]+ (measured|showed|named|derived|condemned|trimmed)'
# A finding label owned by anything, or by nothing: the attribution survives
# the round numeral being dropped, so the label is the shape.
RULE review-archaeology '(^|[^A-Za-z])(EF|E-F|S-F|F-R|F)-?[0-9]'
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
# A prior authoring pass named as such — the same genus as a prior review,
# on the author's side rather than the reviewer's.
RULE change-narration '(first|earlier|previous|original) (draft|wording|version) of'

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
# How many leading COLUMNS the current entry's body lines carry: 1 for an
# ordinary diff, one per parent for a combined one. A combined line is in the
# merge result only when none of its columns is `-`, and its own text starts
# after the columns — counting it as context whenever it merely begins with a
# space puts every later added line in the hunk one line too high, once per
# such line.
columns=1

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
  printf '    remedy: apply the erasure test (SPEC §2.5) — with the repository'"'"'s history AND its plans erased, does this sentence still read as documentation of the current HEAD? A forward-looking sentence whose condition RESOLVES from the living set is a contract and stays; one whose condition resolves only to a plan the tree does not carry is a schedule and goes. If not, DELETE it (§2.5 makes deletion the default repair), restate it as the invariant it is really about, or move it to the surface that owns it: issue (problem, intent, decision), PR (implementation and review), commit message (the atomic change), SPEC/README (the current contract), or a comment (current invariants, rationale, API semantics).\n'
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
    columns=1
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
    columns=1
    lineno=$((BASH_REMATCH[2] - 1))
    continue
  fi
  if [[ $raw =~ $COMBINED_HUNK_RE ]]; then
    # The merge-result range is the LAST one, and the column count is the
    # number of leading `@` minus one — the parent count.
    seen_hunk=1
    lineno=$((BASH_REMATCH[3] - 1))
    marker="${raw%%[^@]*}"
    columns=$((${#marker} - 1))
    [ "$columns" -lt 1 ] && columns=1
    continue
  fi

  # A body line's leading COLUMNS decide whether it exists in the merge result
  # and where its own text starts. `-` in any column means the line is absent
  # from the result: it is neither counted nor read.
  cols="${raw:0:columns}"
  rest="${raw:columns}"
  case "$cols" in
    *-*)
      # Deleted relative to some parent, so not present in the result.
      continue
      ;;
  esac
  case "$cols" in
    *+*)
      if [ -n "$path" ]; then
        lineno=$((lineno + 1))
        if [ "$in_domain" = 1 ] && [ "${#raw}" -le "$MAX_LINE" ]; then
          text="$rest"
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
    *)
      # All columns blank: a context line, present in the result.
      case "$cols" in
        *[![:space:]]*) ;;
        *) [ -n "$path" ] && lineno=$((lineno + 1)) ;;
      esac
      ;;
  esac
done

if [ "$hits" -gt 0 ]; then
  printf '\ncheck-provenance: %s sentence(s) to re-read. This is advisory (SPEC §2.5) and blocks nothing.\n' "$hits"
fi

# Always zero. Refusing is out of contract for this reader.
exit 0
