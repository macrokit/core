#!/usr/bin/env bash
# check-leakage.sh — Sacred Rule #1 enforcer
#
# Scans for terms that would leak the private reference deployment's
# domain context into Macrokit's public repo. Two modes:
#
#   DIFF MODE (default): scan only the lines added by a diff.
#   FULL-TREE MODE (--all): scan every tracked file in the repo.
#
# Usage:
#   check-leakage.sh                          # diff against $BASE_REF (default origin/main)
#   check-leakage.sh path/to/diff.patch       # scan a file containing a unified diff
#   git diff main..HEAD | check-leakage.sh -  # scan stdin
#   check-leakage.sh --all                    # full-tree scan of all tracked files
#
# Exit codes:
#   0  clean
#   1  hard-fail leakage detected (banned terms)
#   2  manual-review warning only (suspicious context terms present)
#   3  invocation error (bad args, missing tools)
#
# CI usage: env var BASE_REF defaults to "origin/main" (diff mode). The
# workflow that calls this script is responsible for fetching the base ref
# with enough depth that `git diff $BASE_REF..HEAD` works. Full-tree mode
# needs no base ref — it scans the working tree's tracked files.
#
# The script intentionally excludes its own files from the scan so the
# deny-list does not self-trigger. If you add new files that legitimately
# need to mention deny-listed terms, add them to SELF_EXCLUDE below.

set -euo pipefail

# -----------------------------------------------------------------------------
# Mode parsing. --all / --full-tree switches to full-tree scan.
# -----------------------------------------------------------------------------
MODE="diff"
INPUT_ARG=""
for arg in "$@"; do
  case "${arg}" in
    --all|--full-tree) MODE="full-tree" ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *) INPUT_ARG="${arg}" ;;
  esac
done

# -----------------------------------------------------------------------------
# Self-exclusion: files that legitimately contain deny-listed terms because
# they ARE the deny-list (the scanner and its tests).
# -----------------------------------------------------------------------------
# These files describe, prohibit, or test the deny-list, so they
# legitimately contain banned terms. Keep this in sync with
# SELF_EXCLUDE_PATHS below (used by the stdin/file code path).
SELF_EXCLUDE=(
  ":(exclude)scripts/check-leakage.sh"
  ":(exclude)scripts/check-leakage.test.sh"
  ":(exclude).github/workflows/leakage-scan.yml"
  # Frozen pre-registered benchmark artifacts (append-only data, not authored
  # prose). The corpus + recorded run outputs are immutable, so they're
  # excluded by explicit decision rather than edited.
  ":(exclude)bench/runs/*"
  ":(exclude)bench/tasks/*"
)
SELF_EXCLUDE_PATHS="scripts/check-leakage.sh scripts/check-leakage.test.sh .github/workflows/leakage-scan.yml bench/runs/ bench/tasks/"

# -----------------------------------------------------------------------------
# Line-content allowlist. Unlike SELF_EXCLUDE (whole-file), this exempts
# INDIVIDUAL lines that contain an allowed fixed substring, anywhere in the
# tree. Use sparingly — only for content that legitimately must mention a
# deny-listed token (e.g. the author's real company affiliation in a byline).
# Matched as fixed strings (grep -F).
# -----------------------------------------------------------------------------
ALLOWLIST_SUBSTRINGS=(
  "Deakee Technology"                        # PREPRINT.md author affiliation (byline)
  "founder, [Deakee](https://deakee.com)"    # LAUNCH_ESSAY.md author byline
  "Apple Silicon"                            # hardware platform, not a brand-list leak
)

# Drop any line (from stdin) that contains an allowlisted fixed substring.
drop_allowlisted() {
  local input
  input="$(cat -)"
  local alw
  for alw in "${ALLOWLIST_SUBSTRINGS[@]}"; do
    input="$(printf '%s\n' "${input}" | grep -vF -- "${alw}" || true)"
  done
  printf '%s\n' "${input}"
}

# -----------------------------------------------------------------------------
# Deny-lists. Two tiers:
#   HARD_FAIL_TERMS  → matched line in diff = job fails (exit 1)
#   SOFT_WARN_TERMS  → matched line = manual-review marker (exit 2),
#                      but does NOT auto-fail. These are common English words
#                      that can legitimately appear; a human should glance.
#
# Hard-fail terms are anchored at word boundaries and case-insensitive.
# The script also runs entropy/regex checks for secret-shaped strings.
# -----------------------------------------------------------------------------

# Hard-fail: private-deployment domain content that must NEVER appear in Macrokit.
# (Sacred Rule #1, CLAUDE.md.)
HARD_FAIL_TERMS=(
  # Platforms
  "1688"
  "aliexpress"
  "ebay"
  "etsy"
  "amazon"
  "shopify"
  "taobao"
  "pinduoduo"
  "wangwang"
  # Domain shape
  "ecommerce"
  "e-commerce"
  "cross-border"
  "seller"
  "marketplace"
  "supplier"
  "dropship"
)

# Private deny-terms (the Sacred Rule #1 product/personal-handle identifiers) are
# deliberately NOT stored in this public repo. They load at runtime from an
# optional gitignored local file (scripts/.leakage-terms.local); in CI the
# workflow materializes that file from a repository secret. If the file is
# absent, the scanner still enforces the generic terms + secret patterns above.
LEAKAGE_TERMS_FILE="${LEAKAGE_TERMS_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.leakage-terms.local}"
if [[ -f "${LEAKAGE_TERMS_FILE}" ]]; then
  while IFS= read -r _term || [[ -n "${_term}" ]]; do
    if [[ -z "${_term}" || "${_term}" == \#* ]]; then continue; fi
    HARD_FAIL_TERMS+=("${_term}")
  done < "${LEAKAGE_TERMS_FILE}"
fi

# Soft-warn: words that often appear in normal English ("apple pie",
# "nike air") but that, in a Macrokit diff, may indicate a leaked brand
# list. Reviewer should eyeball before merging. Matched CASE-SENSITIVELY
# and only when they look like brand mentions (capitalized standalone).
SOFT_WARN_TERMS=(
  "Apple"
  "Nike"
  "Adidas"
  "Gucci"
  "Louis Vuitton"
  "Prada"
  "Chanel"
  "Hermes"
  "Rolex"
)

# Secret-shaped strings. Patterns are conservative — collisions with
# legitimate code (e.g. base64-encoded test fixtures) are possible, so
# secrets are treated as HARD-FAIL when the prefix is unambiguous and
# SOFT-WARN otherwise.
SECRET_HARD_PATTERNS=(
  'AKIA[0-9A-Z]{16}'                  # AWS access key ID
  'ASIA[0-9A-Z]{16}'                  # AWS temporary access key ID
  '(sk|pk)-[A-Za-z0-9]{32,}'          # OpenAI / Stripe-style
  'ghp_[A-Za-z0-9]{36,}'              # GitHub PAT
  'gho_[A-Za-z0-9]{36,}'              # GitHub OAuth token
  'ghs_[A-Za-z0-9]{36,}'              # GitHub server token
  'ghu_[A-Za-z0-9]{36,}'              # GitHub user token
  'xox[abprs]-[A-Za-z0-9-]{10,}'      # Slack token
  '-----BEGIN ((RSA|EC|OPENSSH|PGP) )?PRIVATE KEY-----'
)

HARD_HITS=""
SOFT_HITS=""

if [[ "${MODE}" == "full-tree" ]]; then
  # ---------------------------------------------------------------------------
  # FULL-TREE MODE: scan every tracked file with `git grep`. git grep only
  # searches tracked files and honors the self-exclusion pathspecs, giving
  # real path:lineno:content references.
  # ---------------------------------------------------------------------------
  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    echo "check-leakage: --all requires a git repo" >&2
    exit 3
  fi

  for term in "${HARD_FAIL_TERMS[@]}"; do
    pattern="(^|[^A-Za-z0-9])${term}([^A-Za-z0-9]|$)"
    hits="$(git grep -inE -e "${pattern}" -- . "${SELF_EXCLUDE[@]}" 2>/dev/null | drop_allowlisted | grep -E '.' || true)"
    if [[ -n "${hits}" ]]; then
      HARD_HITS+="HARD-FAIL term \"${term}\":"$'\n'"${hits}"$'\n\n'
    fi
  done

  for pat in "${SECRET_HARD_PATTERNS[@]}"; do
    hits="$(git grep -nE -e "${pat}" -- . "${SELF_EXCLUDE[@]}" 2>/dev/null | drop_allowlisted | grep -E '.' || true)"
    if [[ -n "${hits}" ]]; then
      HARD_HITS+="HARD-FAIL secret-shaped pattern \"${pat}\":"$'\n'"${hits}"$'\n\n'
    fi
  done

  for term in "${SOFT_WARN_TERMS[@]}"; do
    pattern="(^|[^A-Za-z0-9])${term}([^A-Za-z0-9]|$)"
    hits="$(git grep -nE -e "${pattern}" -- . "${SELF_EXCLUDE[@]}" 2>/dev/null | drop_allowlisted | grep -E '.' || true)"
    if [[ -n "${hits}" ]]; then
      SOFT_HITS+="SOFT-WARN term \"${term}\":"$'\n'"${hits}"$'\n\n'
    fi
  done
else
  # ---------------------------------------------------------------------------
  # DIFF MODE: resolve the diff to scan (stdin, file, or git diff vs BASE_REF).
  # ---------------------------------------------------------------------------
  DIFF_SRC=""
  if [[ -n "${INPUT_ARG}" ]]; then
    if [[ "${INPUT_ARG}" == "-" ]]; then
      DIFF_SRC="$(cat -)"
    elif [[ -f "${INPUT_ARG}" ]]; then
      DIFF_SRC="$(cat -- "${INPUT_ARG}")"
    else
      echo "check-leakage: input file not found: ${INPUT_ARG}" >&2
      exit 3
    fi
  else
    BASE_REF="${BASE_REF:-origin/main}"
    if ! git rev-parse --git-dir >/dev/null 2>&1; then
      echo "check-leakage: not in a git repo and no diff file given" >&2
      exit 3
    fi
    # Use `git diff` with self-exclusion pathspecs.
    DIFF_SRC="$(git diff --no-color "${BASE_REF}"...HEAD -- . "${SELF_EXCLUDE[@]}" 2>/dev/null || true)"
  fi

  if [[ -z "${DIFF_SRC}" ]]; then
    echo "check-leakage: no diff content to scan (clean)"
    exit 0
  fi

  # When scanning a diff file passed directly (test harness or stdin), we
  # manually drop hunks that target self-excluded paths.
  filter_self_excluded() {
    awk -v excludes="${SELF_EXCLUDE_PATHS}" '
      BEGIN {
        n = split(excludes, arr, " ")
        for (i = 1; i <= n; i++) ex[arr[i]] = 1
        skip = 0
      }
      /^diff --git / {
        # path is after "b/" in the second filename
        match($0, /b\/[^ ]+$/)
        path = substr($0, RSTART+2, RLENGTH-2)
        skip = (path in ex) ? 1 : 0
      }
      { if (!skip) print }
    '
  }

  FILTERED_DIFF="$(printf '%s\n' "${DIFF_SRC}" | filter_self_excluded)"

  # Only look at lines that are additions (start with +, not ++). This is
  # what would land on main if merged. Allowlisted lines are dropped.
  ADDED_LINES="$(printf '%s\n' "${FILTERED_DIFF}" | grep -E '^\+[^+]' | drop_allowlisted | grep -E '.' || true)"

  if [[ -z "${ADDED_LINES}" ]]; then
    echo "check-leakage: no added lines to scan (clean)"
    exit 0
  fi

  # Hard-fail term scan. Word-boundary, case-insensitive.
  for term in "${HARD_FAIL_TERMS[@]}"; do
    # \b doesn't work inside POSIX bracket expressions for "1688"; anchor instead.
    pattern="(^|[^A-Za-z0-9])${term}([^A-Za-z0-9]|$)"
    hits="$(printf '%s\n' "${ADDED_LINES}" | grep -inE "${pattern}" || true)"
    if [[ -n "${hits}" ]]; then
      HARD_HITS+="HARD-FAIL term \"${term}\":"$'\n'"${hits}"$'\n\n'
    fi
  done

  # Hard-fail secret pattern scan.
  for pat in "${SECRET_HARD_PATTERNS[@]}"; do
    # -e guards against patterns that begin with '-' (e.g. the PEM header)
    # being parsed as a grep option.
    hits="$(printf '%s\n' "${ADDED_LINES}" | grep -nE -e "${pat}" || true)"
    if [[ -n "${hits}" ]]; then
      HARD_HITS+="HARD-FAIL secret-shaped pattern \"${pat}\":"$'\n'"${hits}"$'\n\n'
    fi
  done

  # Soft-warn term scan. Case-sensitive, must be capitalized standalone.
  for term in "${SOFT_WARN_TERMS[@]}"; do
    pattern="(^|[^A-Za-z0-9])${term}([^A-Za-z0-9]|$)"
    hits="$(printf '%s\n' "${ADDED_LINES}" | grep -nE "${pattern}" || true)"
    if [[ -n "${hits}" ]]; then
      SOFT_HITS+="SOFT-WARN term \"${term}\":"$'\n'"${hits}"$'\n\n'
    fi
  done
fi

# -----------------------------------------------------------------------------
# Report and exit.
# -----------------------------------------------------------------------------
if [[ -n "${HARD_HITS}" ]]; then
  printf '%s\n' "===== Leakage scan: HARD FAIL ====="
  printf '%s\n' "${HARD_HITS}"
  if [[ -n "${SOFT_HITS}" ]]; then
    printf '%s\n' "----- Additionally flagged for manual review -----"
    printf '%s\n' "${SOFT_HITS}"
  fi
  printf '%s\n' "See CLAUDE.md (Sacred Rule #1) for how to handle false positives."
  exit 1
fi

if [[ -n "${SOFT_HITS}" ]]; then
  printf '%s\n' "===== Leakage scan: manual review marker ====="
  printf '%s\n' "${SOFT_HITS}"
  printf '%s\n' "(Soft-warn terms detected. Job does NOT fail; reviewer should eyeball.)"
  exit 2
fi

echo "check-leakage: clean"
exit 0
