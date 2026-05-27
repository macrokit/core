import { readdirSync, readFileSync, statSync } from "node:fs";
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
