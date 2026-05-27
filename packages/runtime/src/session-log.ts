import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  SessionLogEntry,
  SessionLogEntryInput,
  SessionLogLike,
} from "./types.js";

export interface SessionLogOptions {
  /**
   * Path to a JSONL file. If absent, the log is in-memory only — appropriate
   * for tests, library callers who want to manage persistence themselves, or
   * environments without a writable filesystem.
   */
  path?: string;
}

/**
 * Append-only session log. The distillation gate (`macrokit gate`) reads
 * the file written here to flag sessions that performed multi-step work
 * without dispatching a macro.
 */
export class SessionLog implements SessionLogLike {
  private readonly _entries: SessionLogEntry[] = [];
  private readonly path?: string;

  constructor(opts: SessionLogOptions = {}) {
    this.path = opts.path;
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      if (!existsSync(this.path)) writeFileSync(this.path, "");
    }
  }

  get entries(): ReadonlyArray<SessionLogEntry> {
    return this._entries;
  }

  append(entry: SessionLogEntryInput): void {
    const full = {
      ...entry,
      ts: entry.ts ?? new Date().toISOString(),
    } as SessionLogEntry;
    this._entries.push(full);
    if (this.path) {
      appendFileSync(this.path, JSON.stringify(full) + "\n");
    }
  }
}
