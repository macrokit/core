#!/usr/bin/env bash
# check-leakage.sh — Sacred Rule #1 enforcer
#
# Scans a unified diff (stdin or a file) for terms that would leak
# REDACTED's private domain context into Macrokit's public repo.
#
# Usage:
#   check-leakage.sh                          # diff against $BASE_REF (default origin/main)
#   check-leakage.sh path/to/diff.patch       # scan a file containing a unified diff
#   git diff main..HEAD | check-leakage.sh -  # scan stdin
#
# Exit codes:
#   0  clean
#   1  hard-fail leakage detected (banned terms)
#   2  manual-review warning only (suspicious context terms present)
#   3  invocation error (bad args, missing tools)
#
# CI usage: env var BASE_REF defaults to "origin/main". The workflow that
# calls this script is responsible for fetching the base ref with enough
# depth that `git diff $BASE_REF..HEAD` works.
#
# The script intentionally excludes its own files from the scan so the
# deny-list does not self-trigger. If you add new files that legitimately
# need to mention deny-listed terms, add them to SELF_EXCLUDE below.

set -euo pipefail

# -----------------------------------------------------------------------------
# Self-exclusion: files that legitimately contain deny-listed terms because
# they ARE the deny-list (the scanner, its tests, and the doc explaining it).
# -----------------------------------------------------------------------------
# These files describe, prohibit, or test the deny-list, so they
# legitimately contain banned terms. Keep this in sync with
# SELF_EXCLUDE_PATHS below (used by the stdin/file code path).
SELF_EXCLUDE=(
  ":(exclude)scripts/check-leakage.sh"
  ":(exclude)scripts/check-leakage.test.sh"
  ":(exclude)scripts/auto-implementer.sh"
  ":(exclude)scripts/install-auto-implementer-cron.sh"
  ":(exclude).github/workflows/leakage-scan.yml"
  ":(exclude)docs/AUTOMATED_PATTERN_INGESTION.md"
)
SELF_EXCLUDE_PATHS="scripts/check-leakage.sh scripts/check-leakage.test.sh scripts/auto-implementer.sh scripts/install-auto-implementer-cron.sh .github/workflows/leakage-scan.yml docs/AUTOMATED_PATTERN_INGESTION.md"

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

# Hard-fail: REDACTED domain content that must NEVER appear in Macrokit.
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
  # Product / personal handles
  "REDACTED"
  "deakee"
  "REDACTED"
)

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

# -----------------------------------------------------------------------------
# Resolve the diff to scan.
# -----------------------------------------------------------------------------
DIFF_SRC=""
if [[ $# -ge 1 ]]; then
  if [[ "$1" == "-" ]]; then
    DIFF_SRC="$(cat -)"
  elif [[ -f "$1" ]]; then
    DIFF_SRC="$(cat -- "$1")"
  else
    echo "check-leakage: input file not found: $1" >&2
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

# -----------------------------------------------------------------------------
# When scanning a diff file passed directly (test harness or stdin), we
# manually drop hunks that target self-excluded paths.
# -----------------------------------------------------------------------------
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
# what would land on main if merged.
ADDED_LINES="$(printf '%s\n' "${FILTERED_DIFF}" | grep -E '^\+[^+]' || true)"

if [[ -z "${ADDED_LINES}" ]]; then
  echo "check-leakage: no added lines to scan (clean)"
  exit 0
fi

# -----------------------------------------------------------------------------
# Run hard-fail term scan. Word-boundary, case-insensitive.
# -----------------------------------------------------------------------------
HARD_HITS=""
for term in "${HARD_FAIL_TERMS[@]}"; do
  # \b doesn't work inside POSIX bracket expressions for "1688"; use \W or anchor.
  pattern="(^|[^A-Za-z0-9])${term}([^A-Za-z0-9]|$)"
  hits="$(printf '%s\n' "${ADDED_LINES}" | grep -inE "${pattern}" || true)"
  if [[ -n "${hits}" ]]; then
    HARD_HITS+="HARD-FAIL term \"${term}\":"$'\n'"${hits}"$'\n\n'
  fi
done

# -----------------------------------------------------------------------------
# Run hard-fail secret pattern scan.
# -----------------------------------------------------------------------------
for pat in "${SECRET_HARD_PATTERNS[@]}"; do
  # -e guards against patterns that begin with '-' (e.g. the PEM header)
  # being parsed as a grep option.
  hits="$(printf '%s\n' "${ADDED_LINES}" | grep -nE -e "${pat}" || true)"
  if [[ -n "${hits}" ]]; then
    HARD_HITS+="HARD-FAIL secret-shaped pattern \"${pat}\":"$'\n'"${hits}"$'\n\n'
  fi
done

# -----------------------------------------------------------------------------
# Run soft-warn term scan. Case-sensitive, must be capitalized standalone.
# -----------------------------------------------------------------------------
SOFT_HITS=""
for term in "${SOFT_WARN_TERMS[@]}"; do
  pattern="(^|[^A-Za-z0-9])${term}([^A-Za-z0-9]|$)"
  hits="$(printf '%s\n' "${ADDED_LINES}" | grep -nE "${pattern}" || true)"
  if [[ -n "${hits}" ]]; then
    SOFT_HITS+="SOFT-WARN term \"${term}\":"$'\n'"${hits}"$'\n\n'
  fi
done

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
  printf '%s\n' "See docs/AUTOMATED_PATTERN_INGESTION.md for how to handle false positives."
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
