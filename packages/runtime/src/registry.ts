import type { Macro } from "./types.js";

/**
 * In-memory macro registry. Pluggable storage is a post-launch concern; for
 * the launch cut, in-process registration covers every realistic deployment
 * (macro counts in the low hundreds, registered at process boot).
 */
export class MacroRegistry {
  private macros = new Map<string, Macro>();

  register<I, O>(macro: Macro<I, O>): this {
    if (this.macros.has(macro.name)) {
      throw new Error(
        `Macro already registered: "${macro.name}". Macro names must be unique within a registry.`,
      );
    }
    if (!macro.name.match(/^[a-z][a-z0-9_]*$/)) {
      throw new Error(
        `Invalid macro name "${macro.name}". Macro names must match /^[a-z][a-z0-9_]*$/ ` +
          `so they are unambiguous across LLM tool-call schemas.`,
      );
    }
    this.macros.set(macro.name, macro as Macro);
    return this;
  }

  lookup(name: string): Macro | undefined {
    return this.macros.get(name);
  }

  has(name: string): boolean {
    return this.macros.has(name);
  }

  list(): ReadonlyArray<Macro> {
    return [...this.macros.values()];
  }

  get size(): number {
    return this.macros.size;
  }
}
