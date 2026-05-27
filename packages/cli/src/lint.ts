import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * Static checks on a project's macro source files. Resists becoming a
 * generic linter — it only catches things specific to macro authoring that
 * the type system can't.
 *
 * Current rule set:
 *   - macro_name_invalid: defineMacro names must match /^[a-z][a-z0-9_]*$/
 *   - intent_empty: defineMacro must have a non-empty intent string
 *   - handler_recurses_into_chat: a macro handler that calls runtime.chat()
 *     is almost always a sign of premature abstraction (the LLM should not
 *     be in the inner loop).
 *
 * Returns a list of findings; CLI prints them and exits non-zero on any.
 */

export interface LintFinding {
  rule: string;
  file: string;
  line: number;
  message: string;
}

export function lintProject(root: string): LintFinding[] {
  const files = findSourceFiles(root);
  const findings: LintFinding[] = [];
  for (const f of files) {
    findings.push(...lintFile(f));
  }
  return findings;
}

export function lintFile(file: string): LintFinding[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  const findings: LintFinding[] = [];

  lines.forEach((line, i) => {
    const lineNumber = i + 1;

    // Match: name: "..."  inside what looks like a defineMacro({ ... })
    // Lookback for nearest "defineMacro(" — cheap heuristic.
    const nameMatch = line.match(/^\s*name\s*:\s*["']([^"']+)["']/);
    if (nameMatch && isInsideDefineMacro(lines, i)) {
      const name = nameMatch[1]!;
      if (!name.match(/^[a-z][a-z0-9_]*$/)) {
        findings.push({
          rule: "macro_name_invalid",
          file,
          line: lineNumber,
          message:
            `Macro name "${name}" does not match /^[a-z][a-z0-9_]*$/. ` +
            `Use lowercase letters, digits, and underscores.`,
        });
      }
    }

    const intentMatch = line.match(/^\s*intent\s*:\s*["']\s*["']/);
    if (intentMatch && isInsideDefineMacro(lines, i)) {
      findings.push({
        rule: "intent_empty",
        file,
        line: lineNumber,
        message:
          "Empty intent string. The router classifies user requests against " +
          "this — it must be descriptive.",
      });
    }

    if (line.match(/\.chat\s*\(/) && isInsideHandler(lines, i)) {
      findings.push({
        rule: "handler_recurses_into_chat",
        file,
        line: lineNumber,
        message:
          "Macro handler calls runtime.chat() — that puts the LLM back in " +
          "the inner loop. Encode the sub-workflow as another macro and call " +
          "its handler directly, or call the tool surface (HTTP, browser, …) " +
          "from this handler instead.",
      });
    }
  });

  return findings;
}

function isInsideDefineMacro(lines: string[], idx: number): boolean {
  // Walk backwards up to 30 lines looking for a defineMacro( without a closing ).
  let depth = 0;
  for (let i = idx; i >= Math.max(0, idx - 30); i--) {
    const line = lines[i]!;
    for (let j = line.length - 1; j >= 0; j--) {
      const c = line[j];
      if (c === ")") depth += 1;
      if (c === "(") {
        if (depth === 0 && line.slice(0, j).match(/defineMacro\s*$/)) return true;
        depth = Math.max(0, depth - 1);
      }
    }
  }
  return false;
}

function isInsideHandler(lines: string[], idx: number): boolean {
  // Walk backwards within 50 lines looking for "handler:" before a closing brace.
  for (let i = idx; i >= Math.max(0, idx - 50); i--) {
    if (lines[i]!.match(/handler\s*:\s*async/)) return true;
  }
  return false;
}

function findSourceFiles(root: string): string[] {
  const out: string[] = [];
  walk(root, out);
  return out;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(p, out);
    else if (s.isFile() && (extname(name) === ".ts" || extname(name) === ".tsx")) {
      out.push(p);
    }
  }
}

// ---------------------------------------------------------------------------
// Package linter (--pkg)
//
// Validates a standalone community macro package against the structural bar
// documented in core/CONTRIBUTING_MACROS.md. Each check has a stable rule
// code so registry-PR reviewers can quote the failing check.
//
// These are STRUCTURAL checks only — they do not run the package's code,
// install dependencies, or execute its handlers. The point is to make
// "does this thing follow the convention" answerable without trusting
// arbitrary npm code.
// ---------------------------------------------------------------------------

export interface PackageLintCheck {
  rule: string;
  ok: boolean;
  message: string;
}

export interface PackageLintResult {
  pkgPath: string;
  checks: PackageLintCheck[];
  findings: LintFinding[]; // failures, expressed as LintFinding for CLI uniformity
}

/**
 * Run the community-package conformance checks against a package directory.
 * Returns both the per-check results (for human/JSON output) and a findings
 * list (subset of checks that failed) for CLI uniformity with lintProject().
 */
export function lintPackage(pkgPath: string): PackageLintResult {
  const checks: PackageLintCheck[] = [];

  const pkgJsonCheck = checkPackageJson(pkgPath);
  checks.push(pkgJsonCheck.peerDep);

  checks.push(checkReadme(pkgPath));
  checks.push(checkMacroExport(pkgPath));
  checks.push(checkTests(pkgPath));

  const findings: LintFinding[] = checks
    .filter((c) => !c.ok)
    .map((c) => ({ rule: c.rule, file: pkgPath, line: 0, message: c.message }));

  return { pkgPath, checks, findings };
}

interface PkgJsonChecks {
  peerDep: PackageLintCheck;
}

function checkPackageJson(pkgPath: string): PkgJsonChecks {
  const pkgJsonPath = join(pkgPath, "package.json");
  if (!existsSync(pkgJsonPath)) {
    return {
      peerDep: {
        rule: "pkg_no_peer_dep_authoring",
        ok: false,
        message:
          `No package.json found at ${pkgJsonPath}. ` +
          `A community macro package must be a valid npm package.`,
      },
    };
  }

  let pkgJson: { peerDependencies?: Record<string, string> };
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  } catch (err) {
    return {
      peerDep: {
        rule: "pkg_no_peer_dep_authoring",
        ok: false,
        message:
          `package.json is not valid JSON: ${(err as Error).message}.`,
      },
    };
  }

  const peers = pkgJson.peerDependencies ?? {};
  if (typeof peers["@macrokit/authoring"] !== "string") {
    return {
      peerDep: {
        rule: "pkg_no_peer_dep_authoring",
        ok: false,
        message:
          `@macrokit/authoring is not declared as a peerDependency. ` +
          `Add it to peerDependencies (NOT dependencies) so adopters don't ` +
          `get two copies of the registry in memory. See ` +
          `core/CONTRIBUTING_MACROS.md#peer-dependency.`,
      },
    };
  }

  return {
    peerDep: {
      rule: "pkg_no_peer_dep_authoring",
      ok: true,
      message: `@macrokit/authoring declared as peerDependency: "${peers["@macrokit/authoring"]}"`,
    },
  };
}

function checkReadme(pkgPath: string): PackageLintCheck {
  // Accept README.md, README.MD, readme.md — npm and GitHub are forgiving.
  let entries: string[];
  try {
    entries = readdirSync(pkgPath);
  } catch {
    return {
      rule: "pkg_no_readme",
      ok: false,
      message: `Package directory ${pkgPath} is not readable.`,
    };
  }
  const hasReadme = entries.some((n) => n.toLowerCase() === "readme.md");
  return hasReadme
    ? { rule: "pkg_no_readme", ok: true, message: "README.md present at package root." }
    : {
        rule: "pkg_no_readme",
        ok: false,
        message:
          `No README.md found at the package root. Adopters of community ` +
          `macros need to know the vertical, the surfaces driven, the ` +
          `credential requirements, and the macro list. See ` +
          `core/CONTRIBUTING_MACROS.md#readmemd.`,
      };
}

/**
 * Scan all .ts/.tsx files in the package for a defineMacro({...}) call that
 * has all four required fields: name, intent, schema, handler. Returns OK
 * iff at least one complete macro definition is found.
 */
function checkMacroExport(pkgPath: string): PackageLintCheck {
  const sources = findSourceFiles(pkgPath);
  if (sources.length === 0) {
    return {
      rule: "pkg_no_macro_export",
      ok: false,
      message:
        `No .ts/.tsx source files found under ${pkgPath}. Community macro ` +
        `packages must export at least one defineMacro() value.`,
    };
  }

  for (const file of sources) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (hasCompleteDefineMacro(text)) {
      return {
        rule: "pkg_no_macro_export",
        ok: true,
        message: `Found a defineMacro() with name/intent/schema/handler in ${file}.`,
      };
    }
  }

  return {
    rule: "pkg_no_macro_export",
    ok: false,
    message:
      `No exported defineMacro() with all four required fields ` +
      `(name, intent, schema, handler) found in any .ts/.tsx file. ` +
      `See core/CONTRIBUTING_MACROS.md#exports.`,
  };
}

/**
 * Heuristic: locate each `defineMacro(` call and check that the four required
 * field names appear before the matching close-paren. We don't fully parse —
 * we balance parens/braces while scanning, which is enough for typical macro
 * definitions (no comments-with-parens edge case yet seen in the wild).
 */
function hasCompleteDefineMacro(source: string): boolean {
  let idx = 0;
  while (idx < source.length) {
    const m = source.slice(idx).match(/defineMacro\s*\(/);
    if (!m) return false;
    const start = idx + (m.index ?? 0) + m[0].length;
    const end = matchingCloseParen(source, start - 1);
    if (end === -1) return false;
    const body = source.slice(start, end);
    if (
      /\bname\s*:/.test(body) &&
      /\bintent\s*:/.test(body) &&
      /\bschema\s*:/.test(body) &&
      /\bhandler\s*:/.test(body)
    ) {
      return true;
    }
    idx = end + 1;
  }
  return false;
}

function matchingCloseParen(source: string, openIdx: number): number {
  let depth = 0;
  let inStr: '"' | "'" | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i]!;
    const next = source[i + 1];
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Acceptable test artifacts: any *.test.ts(x) file OR any *.fixtures.json
 * file anywhere under the package (excluding node_modules/dist/.dot-dirs).
 */
function checkTests(pkgPath: string): PackageLintCheck {
  const matches: string[] = [];
  walkAll(pkgPath, (p, name) => {
    if (
      name.endsWith(".test.ts") ||
      name.endsWith(".test.tsx") ||
      name.endsWith(".fixtures.json")
    ) {
      matches.push(p);
    }
  });
  return matches.length > 0
    ? {
        rule: "pkg_no_tests",
        ok: true,
        message: `Found ${matches.length} test/fixture file(s).`,
      }
    : {
        rule: "pkg_no_tests",
        ok: false,
        message:
          `No *.test.ts(x) or *.fixtures.json files found under ${pkgPath}. ` +
          `Each macro must have at least one test fixture pinning its workflow. ` +
          `See core/CONTRIBUTING_MACROS.md#tests.`,
      };
}

function walkAll(dir: string, visit: (path: string, name: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) walkAll(p, visit);
    else if (s.isFile()) visit(p, name);
  }
}
