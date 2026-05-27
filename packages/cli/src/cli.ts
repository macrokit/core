import { resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  analyzeSession,
  findSessionLogs,
  loadSessionLog,
  type GateViolation,
} from "./gate.js";
import { lintPackage, lintProject } from "./lint.js";
import { initProject } from "./init.js";

const HELP = `macrokit — the Macrokit CLI

Usage:
  macrokit init <name> [--dir <path>] [--provider ollama|openai-compatible] [--force]
      Scaffold a new project.

  macrokit lint [<path>]
      Static checks on macro source files (defaults to ./src).

  macrokit lint --pkg <path>
      Validate a standalone community macro package against the
      community spec (peer dep on @macrokit/authoring, Macro-shape
      export, tests, README). See core/CONTRIBUTING_MACROS.md.

  macrokit gate [<path>] [--threshold N] [--json]
      Distillation gate: flag sessions whose user turns dispatched
      N+ distinct macros (default 3) — those sequences are candidates
      for being a single composite macro. Exits non-zero on violations.

  macrokit --help
      This message.

See https://macrokit.dev/#pattern for what the gate is enforcing.
`;

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  switch (cmd) {
    case "init":
      return runInit(args.slice(1));
    case "lint":
      return runLint(args.slice(1));
    case "gate":
      return runGate(args.slice(1));
    default:
      process.stderr.write(`macrokit: unknown command "${cmd}"\n\n${HELP}`);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

function runInit(args: string[]): number {
  const name = args.find((a) => !a.startsWith("--"));
  if (!name) {
    process.stderr.write("macrokit init: project name required\n");
    return 2;
  }
  const dir = flagValue(args, "--dir") ?? resolve(process.cwd(), name);
  const providerFlag = flagValue(args, "--provider") as
    | "ollama"
    | "openai-compatible"
    | undefined;
  const force = args.includes("--force");

  const result = initProject({
    dir,
    name,
    provider: providerFlag ?? "ollama",
    force,
  });

  process.stdout.write(`Wrote ${result.filesWritten.length} files to ${dir}:\n`);
  for (const f of result.filesWritten) process.stdout.write(`  + ${f}\n`);
  if (result.skipped.length > 0) {
    process.stdout.write(`Skipped (already exist; use --force to overwrite):\n`);
    for (const f of result.skipped) process.stdout.write(`  - ${f}\n`);
  }
  process.stdout.write(`\nNext steps:\n  cd ${name}\n  npm install\n  npm start\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// lint
// ---------------------------------------------------------------------------

function runLint(args: string[]): number {
  const pkgPath = flagValue(args, "--pkg");
  if (pkgPath !== undefined) {
    return runLintPackage(resolve(pkgPath));
  }

  const root = resolve(args.find((a) => !a.startsWith("--")) ?? "./src");
  if (!existsSync(root)) {
    process.stderr.write(`macrokit lint: ${root} does not exist\n`);
    return 2;
  }
  const findings = lintProject(root);
  if (findings.length === 0) {
    process.stdout.write(`macrokit lint: clean (${root})\n`);
    return 0;
  }
  for (const f of findings) {
    process.stdout.write(`${f.file}:${f.line}: ${f.rule}: ${f.message}\n`);
  }
  process.stdout.write(`\n${findings.length} finding(s).\n`);
  return 1;
}

function runLintPackage(pkgPath: string): number {
  if (!existsSync(pkgPath)) {
    process.stderr.write(`macrokit lint --pkg: ${pkgPath} does not exist\n`);
    return 2;
  }
  const result = lintPackage(pkgPath);
  const passed = result.checks.filter((c) => c.ok).length;
  const total = result.checks.length;

  process.stdout.write(`Linting community macro package: ${pkgPath}\n\n`);
  for (const c of result.checks) {
    const mark = c.ok ? "✓" : "✗";
    process.stdout.write(`  ${mark} ${c.rule}\n    ${c.message}\n\n`);
  }

  if (result.findings.length === 0) {
    process.stdout.write(
      `macrokit lint --pkg: PASS — ${passed}/${total} checks green.\n` +
        `Package is eligible for registry listing once it has 5+ benchmark ` +
        `tasks and follows the README/license rules in CONTRIBUTING_MACROS.md.\n`,
    );
    return 0;
  }

  process.stdout.write(
    `macrokit lint --pkg: FAIL — ${result.findings.length} of ${total} checks failed.\n` +
      `Fix the failing checks above before opening a registry PR.\n`,
  );
  return 1;
}

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

function runGate(args: string[]): number {
  const root = resolve(args.find((a) => !a.startsWith("--")) ?? ".macrokit/sessions");
  const threshold = Number(flagValue(args, "--threshold") ?? 3);
  const json = args.includes("--json");

  if (!existsSync(root)) {
    process.stderr.write(
      `macrokit gate: ${root} does not exist. ` +
        `Run something that writes session logs first (Runtime.chat with sessionLogPath set).\n`,
    );
    return 2;
  }

  const sessionFiles = findSessionLogs(root);
  const allViolations: GateViolation[] = [];
  for (const file of sessionFiles) {
    const entries = loadSessionLog(file);
    allViolations.push(...analyzeSession(file, entries, { threshold }));
  }

  if (json) {
    process.stdout.write(JSON.stringify({ violations: allViolations }, null, 2) + "\n");
    return allViolations.length === 0 ? 0 : 1;
  }

  if (allViolations.length === 0) {
    process.stdout.write(
      `macrokit gate: clean — no violations across ${sessionFiles.length} session(s).\n`,
    );
    return 0;
  }

  process.stdout.write(formatViolations(allViolations));
  return 1;
}

function formatViolations(vs: ReadonlyArray<GateViolation>): string {
  const out: string[] = [];
  out.push(
    `macrokit gate: ${vs.length} violation(s). Each user turn below composed ${
      ""
    }multiple macros — candidates for a single composite macro.\n`,
  );
  for (const v of vs) {
    out.push("");
    out.push(`Session: ${v.sessionPath}`);
    out.push(`Turn ${v.turnIndex} — user: ${truncate(v.userText, 80)}`);
    out.push(`Dispatched ${v.toolCalls.length} macros:`);
    for (const tc of v.toolCalls) {
      out.push(`    - ${tc.name}`);
    }
    out.push(`Suggested macro: ${v.suggestion.name}`);
    out.push("```ts");
    out.push(v.suggestion.stub);
    out.push("```");
  }
  out.push("");
  out.push(
    "Encode each suggested macro and register it in your MacroRegistry before merging. " +
      "See https://macrokit.dev/#pattern.",
  );
  return out.join("\n") + "\n";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args[i + 1];
}

main(process.argv).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`macrokit: unexpected error: ${err?.stack ?? err}\n`);
    process.exit(1);
  },
);
