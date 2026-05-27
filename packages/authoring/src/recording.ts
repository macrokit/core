import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Recording mode: capture (args, result) pairs as a macro runs against a
 * real model + real tool surfaces, then replay them later as offline
 * test fixtures. See docs/ARCHITECTURE.md §2.4.
 */

export interface RecordedCall {
  ts: string;
  args: unknown;
  result?: unknown;
  error?: { message: string; name?: string };
}

export class FixtureRecorder {
  private readonly path: string;
  private readonly calls: RecordedCall[];

  constructor(path: string) {
    this.path = path;
    this.calls = existsSync(path) ? readJsonl(path) : [];
  }

  record(call: RecordedCall): void {
    this.calls.push(call);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, this.calls.map((c) => JSON.stringify(c)).join("\n") + "\n");
  }

  load(): ReadonlyArray<RecordedCall> {
    return this.calls;
  }
}

function readJsonl(path: string): RecordedCall[] {
  const out: RecordedCall[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as RecordedCall);
    } catch {
      // Skip malformed lines silently — recording is best-effort.
    }
  }
  return out;
}
