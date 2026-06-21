import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pack-time leakage gate.
 *
 * `macrokit pack` must never package secrets or an adopter's own private terms
 * into a source-available artifact. This module scans a macro directory's source
 * before a pack is written and refuses on a hard hit.
 *
 * IMPORTANT: the SHIPPED CLI carries ZERO project-specific domain terms. The
 * gate is built from three layers, and the deny-list content lives OUTSIDE the
 * published source:
 *
 *  1. SECRET_PATTERNS — generic, vendor-neutral credential shapes (API keys,
 *     tokens, private keys). Always on. Safe to ship: matches no domain.
 *
 *  2. Adopter deny terms — loaded at pack time from the adopter's OWN config
 *     (`.macrokitignore` next to / above the macro dir, or MACROKIT_PACK_DENYLIST).
 *     Each adopter scans for THEIR terms; Macrokit ships none of them.
 *
 *  3. `scripts/check-leakage.sh` when locatable (env MACROKIT_LEAKAGE_SCRIPT, or
 *     walking up from this module / cwd) — the DEV-ONLY scanner that holds
 *     Macrokit's own deny-list (scripts/.leakage-terms.local, gitignored). We
 *     feed it a synthetic all-additions diff so it scans the pack content in its
 *     normal diff mode. Absent in a standalone npm install, present in this repo.
 */

export interface LeakageHit {
  file: string;
  line: number;
  term: string;
  text: string;
}

export interface LeakageResult {
  ok: boolean;
  /** Hard-fail hits — pack must refuse. */
  hard: LeakageHit[];
  /** Soft-warn hits — pack proceeds but the CLI surfaces them. */
  soft: LeakageHit[];
  /** Which scanners actually ran. */
  scanners: string[];
}

export interface ScanOptions {
  /**
   * Adopter deny terms to scan for, overriding config discovery. Pass `[]` to
   * scan for no terms (secrets only). When omitted, terms are loaded from the
   * adopter's `.macrokitignore` / MACROKIT_PACK_DENYLIST (see loadDenyTerms).
   */
  denyTerms?: string[];
}

// Generic, vendor-neutral credential shapes. These match NO domain — they are
// safe to ship in the public CLI. Adopter/Macrokit domain terms are NOT here.
const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /AKIA[0-9A-Z]{16}/, label: "aws-access-key" },
  { re: /ASIA[0-9A-Z]{16}/, label: "aws-temp-key" },
  { re: /ghp_[A-Za-z0-9]{36,}/, label: "github-pat" },
  { re: /gh[opsu]_[A-Za-z0-9]{36,}/, label: "github-token" },
  { re: /xox[abprs]-[A-Za-z0-9-]{10,}/, label: "slack-token" },
  { re: /-----BEGIN (?:(?:RSA|EC|OPENSSH|PGP) )?PRIVATE KEY-----/, label: "private-key" },
];

/** The adopter deny-list config filename, looked up next to / above the macro dir. */
export const DENYLIST_FILENAME = ".macrokitignore";

/**
 * Load the adopter's pack-time deny terms. Precedence:
 *   1. MACROKIT_PACK_DENYLIST (a file path), if set and readable.
 *   2. The nearest `.macrokitignore` walking up from the macro dir (so a
 *      project-level config covers every pack underneath it).
 * One term per line; blank lines and `#` comments ignored. Returns [] when no
 * config exists — the shipped CLI has no built-in domain terms by design.
 */
export function loadDenyTerms(macroDir: string): string[] {
  const fromEnv = process.env.MACROKIT_PACK_DENYLIST;
  if (fromEnv && existsSync(fromEnv)) return parseDenylist(readSafe(fromEnv));

  let dir = resolve(macroDir);
  for (let i = 0; i < 8; i++) {
    const cand = join(dir, DENYLIST_FILENAME);
    if (existsSync(cand)) return parseDenylist(readSafe(cand));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [];
}

function parseDenylist(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

function readSafe(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Collect text files under a macro dir (skip node_modules/dist/dot-dirs). */
function collectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
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
      if (s.isDirectory()) walk(p);
      else if (s.isFile()) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** Best-effort skip of obvious binaries by extension. */
function isProbablyText(file: string): boolean {
  return !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|wasm|woff2?|ttf|eot|mp4|mov)$/i.test(file);
}

function localScan(root: string, denyTerms: string[]): { hard: LeakageHit[]; soft: LeakageHit[] } {
  const hard: LeakageHit[] = [];
  const soft: LeakageHit[] = [];
  for (const file of collectFiles(root)) {
    if (!isProbablyText(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = relative(root, file);
    text.split("\n").forEach((line, i) => {
      const lower = line.toLowerCase();
      for (const term of denyTerms) {
        // word-ish boundary so plain words don't false-positive on a substring
        const re = new RegExp(`(^|[^a-z0-9])${escapeRe(term.toLowerCase())}([^a-z0-9]|$)`, "i");
        if (re.test(lower)) {
          hard.push({ file: rel, line: i + 1, term, text: line.trim().slice(0, 160) });
        }
      }
      for (const { re, label } of SECRET_PATTERNS) {
        if (re.test(line)) {
          hard.push({ file: rel, line: i + 1, term: `secret:${label}`, text: "<redacted secret-shaped string>" });
        }
      }
    });
  }
  return { hard, soft };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Locate scripts/check-leakage.sh without a hard dependency on its presence. */
function resolveScript(): string | undefined {
  const env = process.env.MACROKIT_LEAKAGE_SCRIPT;
  if (env && existsSync(env)) return env;
  const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const start of starts) {
    let dir = resolve(start);
    for (let i = 0; i < 8; i++) {
      const cand = join(dir, "scripts", "check-leakage.sh");
      if (existsSync(cand)) return cand;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

/**
 * Build a synthetic unified diff where every source line is an addition, so the
 * shell scanner's diff mode (which only inspects added lines) scans the whole
 * pack content.
 */
function synthDiff(root: string): string {
  const parts: string[] = [];
  for (const file of collectFiles(root)) {
    if (!isProbablyText(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = relative(root, file);
    parts.push(`diff --git a/${rel} b/${rel}`);
    parts.push(`--- /dev/null`);
    parts.push(`+++ b/${rel}`);
    for (const line of text.split("\n")) parts.push(`+${line}`);
  }
  return parts.join("\n") + "\n";
}

function shellScan(scriptPath: string, root: string): { ran: boolean; hard: boolean; soft: boolean; output: string } {
  const diff = synthDiff(root);
  const res = spawnSync("bash", [scriptPath, "-"], {
    input: diff,
    encoding: "utf8",
  });
  if (res.error || res.status === null) {
    return { ran: false, hard: false, soft: false, output: res.stderr ?? "" };
  }
  // Exit codes: 0 clean, 1 hard-fail, 2 manual-review (soft), 3 invocation error.
  if (res.status === 3) return { ran: false, hard: false, soft: false, output: res.stdout + res.stderr };
  return {
    ran: true,
    hard: res.status === 1,
    soft: res.status === 2,
    output: res.stdout + res.stderr,
  };
}

export function scanLeakage(macroDir: string, opts: ScanOptions = {}): LeakageResult {
  const scanners: string[] = [];
  const denyTerms = opts.denyTerms ?? loadDenyTerms(macroDir);

  const { hard, soft } = localScan(macroDir, denyTerms);
  scanners.push(denyTerms.length > 0 ? "secrets+denylist" : "secrets");

  const script = resolveScript();
  if (script) {
    const r = shellScan(script, macroDir);
    if (r.ran) {
      scanners.push("check-leakage.sh");
      if (r.hard) {
        // The dev scanner found something the generic layers don't carry (the
        // project's own terms). Record one synthetic hit so pack refuses with context.
        hard.push({
          file: "<scripts/check-leakage.sh>",
          line: 0,
          term: "leakage-scan",
          text: firstHardLine(r.output),
        });
      }
      // soft hits from the shell scanner are advisory; surface a marker.
      if (r.soft) {
        soft.push({
          file: "<scripts/check-leakage.sh>",
          line: 0,
          term: "manual-review",
          text: firstHardLine(r.output),
        });
      }
    }
  }

  return { ok: hard.length === 0, hard, soft, scanners };
}

function firstHardLine(output: string): string {
  const line = output
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("="));
  return line ?? "see check-leakage.sh output";
}
