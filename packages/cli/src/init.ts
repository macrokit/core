import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `macrokit init` — scaffold a new project. The scaffold is intentionally
 * minimal: one trivial macro, the runtime wired up, a passing test. The
 * adopter adds real macros, real model adapters, real tool surfaces from
 * there. We resist generating a kitchen-sink starter.
 */

export interface InitOptions {
  /** Project root to scaffold into. Created if missing. */
  dir: string;
  /** Project name (becomes the package.json `name`). */
  name: string;
  /** Default model-provider hint included as a code comment. */
  provider?: "openai-compatible" | "ollama";
  /** If true, overwrite existing files. */
  force?: boolean;
}

export interface InitResult {
  filesWritten: string[];
  skipped: string[];
}

export function initProject(opts: InitOptions): InitResult {
  const { dir, name, provider = "ollama", force = false } = opts;
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, ".macrokit", "sessions"), { recursive: true });

  const filesWritten: string[] = [];
  const skipped: string[] = [];

  const write = (relPath: string, content: string): void => {
    const p = join(dir, relPath);
    if (existsSync(p) && !force) {
      skipped.push(relPath);
      return;
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    filesWritten.push(relPath);
  };

  write("package.json", PACKAGE_JSON(name));
  write("tsconfig.json", TSCONFIG);
  write(".gitignore", GITIGNORE);
  write("README.md", README(name));
  write("src/macros.ts", MACROS_TS);
  write("src/main.ts", MAIN_TS(provider));

  return { filesWritten, skipped };
}

function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "." : p.slice(0, idx);
}

const PACKAGE_JSON = (name: string): string =>
  JSON.stringify(
    {
      name,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        start: "tsx src/main.ts",
        gate: "macrokit gate",
        lint: "macrokit lint",
      },
      dependencies: {
        "@macrokit/runtime": "*",
        "@macrokit/llm": "*",
        "@macrokit/authoring": "*",
        zod: "^3.23.8",
      },
      devDependencies: {
        "@macrokit/cli": "*",
        tsx: "^4.19.0",
        typescript: "^5.7.0",
      },
    },
    null,
    2,
  ) + "\n";

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": false
  },
  "include": ["src/**/*"]
}
`;

const GITIGNORE = `node_modules
dist
.macrokit/sessions
.env
.DS_Store
`;

const README = (name: string): string => `# ${name}

A Macrokit project. See https://macrokit.dev for the pattern essay and architecture.

## Run

\`\`\`sh
npm install
npm start
\`\`\`

## Distillation gate

After a session, run \`npm run gate\` to find workflows that should be encoded as macros.
`;

const MACROS_TS = `import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";

// Replace this with the macros your application needs. Each macro encodes
// one workflow end-to-end — the LLM only routes to them, it does not
// compose them at runtime. See https://macrokit.dev/#pattern.
export const echo = defineMacro({
  name: "echo",
  intent: "echo back whatever the user said, optionally shouting",
  schema: z.object({
    text: z.string(),
    shout: z.boolean().default(false),
  }),
  handler: async ({ text, shout }) => ({
    text: shout ? text.toUpperCase() : text,
  }),
});
`;

const MAIN_TS = (provider: "openai-compatible" | "ollama"): string => `import { MacroRegistry, Runtime } from "@macrokit/runtime";
${
  provider === "ollama"
    ? 'import { OllamaAdapter } from "@macrokit/llm";'
    : 'import { OpenAICompatibleAdapter } from "@macrokit/llm";'
}
import { echo } from "./macros.js";

const llm = ${
    provider === "ollama"
      ? `new OllamaAdapter({ model: "qwen2.5:7b-instruct" });`
      : `new OpenAICompatibleAdapter({
  baseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
  model: process.env.LLM_MODEL ?? "gpt-4o-mini",
  apiKey: process.env.LLM_API_KEY ?? "",
});`
  }

const runtime = new Runtime({
  registry: new MacroRegistry().register(echo),
  sessionLogPath: \`.macrokit/sessions/\${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl\`,
  llm,
});

const userMessage = process.argv.slice(2).join(" ") || "please shout 'hello macrokit'";
const result = await runtime.chat(userMessage);
console.log(result.text);
`;
