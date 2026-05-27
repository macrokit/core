import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "./types.js";

/**
 * Load all .jsonl files from bench/tasks/ in alphabetical order. Each non-
 * empty line is parsed as a Task. Order is deterministic so harness runs
 * are reproducible.
 */
export function loadAllTasks(tasksDir: string): Task[] {
  const out: Task[] = [];
  const ids = new Set<string>();
  for (const file of readdirSync(tasksDir).sort()) {
    if (!file.endsWith(".jsonl")) continue;
    const text = readFileSync(join(tasksDir, file), "utf8");
    let lineNo = 0;
    for (const line of text.split("\n")) {
      lineNo += 1;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) continue;
      let task: Task;
      try {
        task = JSON.parse(trimmed) as Task;
      } catch (err) {
        throw new Error(`${file}:${lineNo}: invalid JSON: ${(err as Error).message}`);
      }
      if (!task.id || !task.bucket || !task.prompt || !task.expected) {
        throw new Error(`${file}:${lineNo}: task missing required field`);
      }
      if (ids.has(task.id)) {
        throw new Error(`${file}:${lineNo}: duplicate task id "${task.id}"`);
      }
      ids.add(task.id);
      out.push(task);
    }
  }
  return out;
}
