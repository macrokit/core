#!/usr/bin/env bash
# check-leakage.test.sh — fixture-driven tests for check-leakage.sh
#
# Plain bash, no bats dependency. Each test pipes a synthetic unified
# diff into check-leakage.sh and asserts the exit code. Run with:
#
#   bash scripts/check-leakage.test.sh
#
# Exits 0 if all tests pass, 1 otherwise. CI does not invoke this file;
# it's developer-facing.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCANNER="${SCRIPT_DIR}/check-leakage.sh"

if [[ ! -x "${SCANNER}" ]]; then
  echo "FATAL: ${SCANNER} not executable. Run: chmod +x ${SCANNER}" >&2
  exit 1
fi

PASS=0
FAIL=0

# Run the scanner with stdin set to $2; assert exit code equals $1.
# $3 is a human description.
run_case() {
  local expected="$1"
  local diff="$2"
  local desc="$3"
  local actual
  set +e
  printf '%s' "${diff}" | "${SCANNER}" - >/dev/null 2>&1
  actual=$?
  set -e
  if [[ "${actual}" == "${expected}" ]]; then
    printf '  ok  %s (exit %s)\n' "${desc}" "${actual}"
    PASS=$((PASS + 1))
  else
    printf '  FAIL %s — expected exit %s, got %s\n' "${desc}" "${expected}" "${actual}"
    FAIL=$((FAIL + 1))
  fi
}

# A clean diff fixture.
CLEAN_DIFF='diff --git a/packages/runtime/src/registry.ts b/packages/runtime/src/registry.ts
index 1234..5678 100644
--- a/packages/runtime/src/registry.ts
+++ b/packages/runtime/src/registry.ts
@@ -1,3 +1,4 @@
 export class MacroRegistry {
+  // added a comment
 }
'

run_case 0 "${CLEAN_DIFF}" "clean diff passes"

# Every hard-fail term should trigger exit 1.
HARD_TERMS=(
  "1688" "aliexpress" "ebay" "etsy" "amazon" "shopify"
  "taobao" "pinduoduo" "wangwang"
  "ecommerce" "e-commerce" "cross-border" "seller"
  "marketplace" "supplier" "dropship"
  "REDACTED" "deakee" "REDACTED"
)

for term in "${HARD_TERMS[@]}"; do
  DIRTY_DIFF="diff --git a/docs/EXAMPLE.md b/docs/EXAMPLE.md
index 1111..2222 100644
--- a/docs/EXAMPLE.md
+++ b/docs/EXAMPLE.md
@@ -1,1 +1,2 @@
 line one
+this mentions ${term} in a phrase
"
  run_case 1 "${DIRTY_DIFF}" "term '${term}' triggers hard fail"
done

# Case-insensitivity: REDACTED in caps must also fail.
CAPS_DIFF='diff --git a/docs/foo.md b/docs/foo.md
index 1111..2222 100644
--- a/docs/foo.md
+++ b/docs/foo.md
@@ -1,1 +1,2 @@
 line one
+the REDACTED product is great
'
run_case 1 "${CAPS_DIFF}" "uppercase REDACTED triggers hard fail"

# Word-boundary: "amazonia" should NOT trigger (no word break inside "amazon"
# match — well actually "amazon" appears as a substring at the start of
# "amazonia". The word-boundary regex requires non-alphanumeric on BOTH
# sides, so amazonia does not match.)
SUBSTRING_DIFF='diff --git a/docs/foo.md b/docs/foo.md
index 1111..2222 100644
--- a/docs/foo.md
+++ b/docs/foo.md
@@ -1,1 +1,2 @@
 line one
+the amazonian rainforest is large
'
run_case 0 "${SUBSTRING_DIFF}" "substring 'amazonian' does NOT trigger (word-boundary)"

# Self-exclusion: a change to check-leakage.sh that lists banned terms
# should NOT trigger.
SELF_DIFF='diff --git a/scripts/check-leakage.sh b/scripts/check-leakage.sh
index 1111..2222 100644
--- a/scripts/check-leakage.sh
+++ b/scripts/check-leakage.sh
@@ -1,3 +1,4 @@
 some line
+  "REDACTED"
+  "aliexpress"
'
run_case 0 "${SELF_DIFF}" "self-exclusion: scanner file itself does not trigger"

# Soft-warn: a capitalized "Apple" in a non-suspicious context should
# return exit 2 (manual review marker), not fail the build.
APPLE_DIFF='diff --git a/docs/architecture.md b/docs/architecture.md
index 1111..2222 100644
--- a/docs/architecture.md
+++ b/docs/architecture.md
@@ -1,1 +1,2 @@
 line one
+Macrokit runs on Apple Silicon and Linux
'
run_case 2 "${APPLE_DIFF}" "soft-warn 'Apple' returns exit 2"

# Secret detection: an AWS access key shape should hard-fail.
SECRET_DIFF='diff --git a/.env.example b/.env.example
index 1111..2222 100644
--- a/.env.example
+++ b/.env.example
@@ -1,1 +1,2 @@
 KEY=value
+AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
'
run_case 1 "${SECRET_DIFF}" "AWS access key shape triggers hard fail"

# Secret detection: GitHub PAT shape should hard-fail.
GH_PAT_DIFF='diff --git a/.env.example b/.env.example
index 1111..2222 100644
--- a/.env.example
+++ b/.env.example
@@ -1,1 +1,2 @@
 line
+GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789
'
run_case 1 "${GH_PAT_DIFF}" "GitHub PAT shape triggers hard fail"

# Secret detection: a private-key PEM header should hard-fail. (Regression
# guard: the pattern begins with "-" and must not be parsed as a grep flag.)
PEM_DIFF='diff --git a/key.pem b/key.pem
index 1111..2222 100644
--- a/key.pem
+++ b/key.pem
@@ -1,1 +1,2 @@
 line
+-----BEGIN OPENSSH PRIVATE KEY-----
'
run_case 1 "${PEM_DIFF}" "PEM private-key header triggers hard fail"

# Empty diff: scanner should pass.
run_case 0 "" "empty input passes"

# Diff with deletions only: should not flag content removed from a file.
DELETION_DIFF='diff --git a/docs/foo.md b/docs/foo.md
index 1111..2222 100644
--- a/docs/foo.md
+++ b/docs/foo.md
@@ -1,2 +1,1 @@
 line one
-this used to mention REDACTED but is being removed
'
run_case 0 "${DELETION_DIFF}" "deletions of banned terms do not trigger"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ "${FAIL}" -eq 0 ]]
