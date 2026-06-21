import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  analyzeSession,
  findSessionLogs,
  loadSessionLog,
  type GateViolation,
} from "./gate.js";
import { lintPackage, lintProject } from "./lint.js";
import { initProject, isVertical, type Vertical } from "./init.js";
import { launchMcp, launchStudio } from "./studio.js";
import { buildPack, PackError } from "./pack.js";
import {
  DEFAULT_REGISTRY,
  installPack,
  publishPack,
  RegistryError,
  type CapabilityDisclosure,
} from "./registry.js";

const HELP = `macrokit — the Macrokit CLI

Usage:
  macrokit init <name> [--vertical github|starter] [--dir <path>]
                       [--provider ollama|openai-compatible] [--force]
      Scaffold a new project. --vertical github seeds a real by-product
      project (macrokit.json, macros/, primitives/, fixtures/) that
      \`macrokit studio\` can open and run.

  macrokit studio [<path>] [--port <n>] [--no-open]
      Open a project in Macrokit Studio — a local server + browser GUI that
      lists the project's on-disk macros and runs a task against them on a
      local/weak model. Defaults to the current directory.

  macrokit mcp [<path>]
      Start the Macrokit Studio MCP server over stdio (Phase-2 authoring):
      exposes the project's domain primitives as MCP tools + an author tool, so
      your agent (Claude Code / Cursor) authors a macro by calling them.
      Add to an agent, e.g.:  claude mcp add macrokit -- macrokit mcp <path>

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

  macrokit pack <macro-dir> [--out <path>]
      Bundle a macro package into a versioned, source-available pack
      (a single .mkpack.json carrying the manifest + verbatim source).
      Runs lint --pkg and the leakage scan first; refuses on either.

  macrokit publish <pack> [--registry <path>]
      Write a pack to a personal/local registry (a resolvable dir; may
      be git-backed). Immutable per (name, version) — never overwrites,
      never pushes to a network location. Defaults to ~/.macrokit/registry.

  macrokit install <name>[@<range>] [--registry <path>] [--dir <path>] [--yes]
      Resolve a pack from a registry (semver range, e.g. @^1), DISPLAY its
      declared capabilities for approval, then vendor the readable source
      and record macrokit.lock.json. --yes approves non-interactively.

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
    case "studio":
      return runStudio(args.slice(1));
    case "mcp":
      return runMcp(args.slice(1));
    case "lint":
      return runLint(args.slice(1));
    case "gate":
      return runGate(args.slice(1));
    case "pack":
      return runPack(args.slice(1));
    case "publish":
      return runPublish(args.slice(1));
    case "install":
      return runInstall(args.slice(1));
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
  const verticalFlag = flagValue(args, "--vertical");
  let vertical: Vertical = "starter";
  if (verticalFlag !== undefined) {
    if (!isVertical(verticalFlag)) {
      process.stderr.write(
        `macrokit init: unknown vertical "${verticalFlag}". Known: github, starter.\n`,
      );
      return 2;
    }
    vertical = verticalFlag;
  }
  const force = args.includes("--force");

  const result = initProject({
    dir,
    name,
    vertical,
    provider: providerFlag ?? "ollama",
    force,
  });

  process.stdout.write(
    `Wrote ${result.filesWritten.length} files to ${dir} (vertical: ${result.vertical}):\n`,
  );
  for (const f of result.filesWritten) process.stdout.write(`  + ${f}\n`);
  if (result.skipped.length > 0) {
    process.stdout.write(`Skipped (already exist; use --force to overwrite):\n`);
    for (const f of result.skipped) process.stdout.write(`  - ${f}\n`);
  }
  const next =
    result.vertical === "github"
      ? `\nNext steps:\n  cd ${name}\n  # wire it into your agent (Claude Code / Cursor):\n  claude mcp add macrokit -- macrokit mcp .\n  # then, after a session, flag un-encoded workflows:\n  macrokit gate .macrokit/sessions --macros macros\n`
      : `\nNext steps:\n  cd ${name}\n  npm install\n  npm start\n`;
  process.stdout.write(next);
  return 0;
}

// ---------------------------------------------------------------------------
// studio
// ---------------------------------------------------------------------------

async function runStudio(args: string[]): Promise<number> {
  const path = resolve(args.find((a) => !a.startsWith("--")) ?? ".");
  const portStr = flagValue(args, "--port");
  const port = portStr ? Number(portStr) : undefined;
  const open = !args.includes("--no-open");
  return launchStudio({ projectDir: path, port, open });
}

async function runMcp(args: string[]): Promise<number> {
  const path = resolve(args.find((a) => !a.startsWith("--")) ?? ".");
  return launchMcp({ projectDir: path });
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

/**
 * Best-effort discovery of the project's encoded-macro names from its `macros/`
 * dir, via the one-macro-per-file `defineMacro({ name: "..." })` convention.
 * Lets the gate flag only UN-encoded (raw-primitive) sequences — the documented
 * distillation-gate semantics — instead of any 3+ tool-call turn.
 */
function loadEncodedMacroNames(macrosDir: string): Set<string> {
  const names = new Set<string>();
  if (!existsSync(macrosDir)) return names;
  for (const f of readdirSync(macrosDir)) {
    if (!/\.(ts|js|mjs)$/.test(f)) continue;
    let src = "";
    try { src = readFileSync(join(macrosDir, f), "utf8"); } catch { continue; }
    const re = /defineMacro\s*(?:<[^>]*>)?\s*\(\s*\{[\s\S]*?name\s*:\s*["'`]([^"'`]+)["'`]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) names.add(m[1]!);
  }
  return names;
}

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

  // Discover encoded macros so the gate flags only un-encoded (raw-primitive)
  // sequences. --macros <dir> overrides; defaults to ./macros.
  const macrosDir = resolve(flagValue(args, "--macros") ?? "macros");
  const encoded = loadEncodedMacroNames(macrosDir);
  const gateOpts = encoded.size > 0
    ? { threshold, isEncoded: (name: string) => encoded.has(name) }
    : { threshold };
  if (encoded.size === 0 && !json) {
    process.stderr.write(
      `macrokit gate: no macros found at ${macrosDir} — running in count mode ` +
        `(flags any ${threshold}+ tool-call turn). Pass --macros <dir> to flag only un-encoded workflows.\n`,
    );
  }

  const sessionFiles = findSessionLogs(root);
  const allViolations: GateViolation[] = [];
  for (const file of sessionFiles) {
    const entries = loadSessionLog(file);
    allViolations.push(...analyzeSession(file, entries, gateOpts));
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

  process.stdout.write(formatViolations(allViolations, encoded));
  return 1;
}

function formatViolations(vs: ReadonlyArray<GateViolation>, encoded?: Set<string>): string {
  const haveMacros = encoded !== undefined && encoded.size > 0;
  const isEnc = (n: string): boolean => (encoded ? encoded.has(n) : false);
  const out: string[] = [];
  out.push(
    `macrokit gate: ${vs.length} turn(s) ran a multi-step workflow ${
      haveMacros ? "without a macro" : "no single macro covers"
    } — encode each as one macro before merging.\n`,
  );
  for (const v of vs) {
    out.push("");
    out.push(`Session: ${v.sessionPath}`);
    out.push(`Turn ${v.turnIndex} — user: ${truncate(v.userText, 80)}`);
    const rawCount = v.toolCalls.filter((tc) => !isEnc(tc.name)).length;
    out.push(
      haveMacros
        ? `${v.toolCalls.length} tool call(s) — ${rawCount} un-encoded:`
        : `${v.toolCalls.length} tool call(s):`,
    );
    for (const tc of v.toolCalls) {
      out.push(`    - ${tc.name}${haveMacros && isEnc(tc.name) ? "  (already a macro)" : ""}`);
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

// ---------------------------------------------------------------------------
// pack / publish / install (personal-registry packaging pipeline)
// ---------------------------------------------------------------------------

function runPack(args: string[]): number {
  const macroDir = args.find((a) => !a.startsWith("--"));
  if (!macroDir) {
    process.stderr.write("macrokit pack: <macro-dir> required\n");
    return 2;
  }
  const dir = resolve(macroDir);
  if (!existsSync(dir)) {
    process.stderr.write(`macrokit pack: ${dir} does not exist\n`);
    return 2;
  }
  let result;
  try {
    result = buildPack(dir);
  } catch (err) {
    if (err instanceof PackError) {
      process.stderr.write(`macrokit pack: ${err.message}\n`);
      if (err.detail.lintFailures) {
        for (const f of err.detail.lintFailures) process.stderr.write(`  ✗ ${f}\n`);
      }
      if (err.detail.leakage) {
        for (const h of err.detail.leakage.hard) {
          process.stderr.write(`  ✗ leakage [${h.term}] ${h.file}:${h.line}  ${h.text}\n`);
        }
      }
      return 1;
    }
    throw err;
  }

  const outFlag = flagValue(args, "--out");
  const outPath = outFlag ? resolve(outFlag) : resolve(process.cwd(), result.filename);
  writeFileSync(outPath, result.json);

  const m = result.manifest;
  process.stdout.write(`Packed ${m.name}@${m.version} → ${outPath}\n`);
  process.stdout.write(`  macros: ${m.macros.map((x) => x.name).join(", ")}\n`);
  process.stdout.write(
    `  capabilities: ${m.capabilities.length ? m.capabilities.join(", ") : "(none declared)"}` +
      `${m.hasUndeclaredCapabilities ? "  ⚠ some macros declared no capabilities (full access)" : ""}\n`,
  );
  process.stdout.write(`  integrity: ${m.integrity}\n`);
  return 0;
}

function runPublish(args: string[]): number {
  const packFile = args.find((a) => !a.startsWith("--"));
  if (!packFile) {
    process.stderr.write("macrokit publish: <pack> required\n");
    return 2;
  }
  const registry = flagValue(args, "--registry");
  try {
    const res = publishPack(resolve(packFile), registry ? { registry } : {});
    process.stdout.write(
      `Published ${res.name}@${res.version} → ${res.path}\n` +
        `Registry: ${res.registry} (personal/local — not pushed anywhere).\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof RegistryError) {
      process.stderr.write(`macrokit publish: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

async function runInstall(args: string[]): Promise<number> {
  const spec = args.find((a) => !a.startsWith("--"));
  if (!spec) {
    process.stderr.write("macrokit install: <name>[@<range>] required\n");
    return 2;
  }
  const registry = flagValue(args, "--registry") ?? DEFAULT_REGISTRY;
  const projectDir = flagValue(args, "--dir") ?? process.cwd();
  const autoYes = args.includes("--yes") || args.includes("-y");

  const approve = async (d: CapabilityDisclosure): Promise<boolean> => {
    process.stdout.write(`\nInstalling ${d.name}@${d.version} from ${resolve(registry)}\n`);
    process.stdout.write(`This pack declares the following capabilities (tool surfaces it may access):\n`);
    if (d.capabilities.length === 0) {
      process.stdout.write(`  (no capabilities declared at the pack level)\n`);
    } else {
      for (const c of d.capabilities) process.stdout.write(`  • ${c}\n`);
    }
    process.stdout.write(`Macros:\n`);
    for (const m of d.macros) {
      const caps =
        m.capabilities === null
          ? "⚠ undeclared (full access)"
          : m.capabilities.length === 0
            ? "no tool surfaces"
            : m.capabilities.join(", ");
      process.stdout.write(`  • ${m.name} — ${caps}\n`);
    }
    if (d.hasUndeclaredCapabilities) {
      process.stdout.write(
        `\n⚠ One or more macros declared NO capabilities and may access any tool surface.\n`,
      );
    }
    if (autoYes) {
      process.stdout.write(`Approved via --yes.\n`);
      return true;
    }
    return promptYesNo(`Approve and install ${d.name}@${d.version}? [y/N] `);
  };

  try {
    const res = await installPack(spec, { registry, projectDir, approve });
    if (!res.approved) {
      process.stdout.write(`\nInstall aborted: capabilities not approved. Nothing was written.\n`);
      return 1;
    }
    process.stdout.write(
      `\nInstalled ${res.name}@${res.version}.\n` +
        `  source: ${res.vendorDir}\n` +
        `  entry:  ${res.entryPath}\n` +
        `  macros: ${res.macros.join(", ")}\n` +
        `  recorded in macrokit.lock.json (reproducible installs).\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof RegistryError) {
      process.stderr.write(`macrokit install: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    process.stdout.write(
      `${question}\n(no TTY — pass --yes to approve non-interactively; declining.)\n`,
    );
    return Promise.resolve(false);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveAnswer) => {
    rl.question(question, (answer) => {
      rl.close();
      resolveAnswer(/^y(es)?$/i.test(answer.trim()));
    });
  });
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
