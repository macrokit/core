import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";

// A low-level primitive (category: "utility") — exposed by the MCP server as
// its own tool. Calling it 3+ times without a macro is what `macrokit gate` flags.
export const ping = defineMacro({
  name: "ping",
  intent: "Return pong (a raw primitive).",
  category: "utility",
  schema: z.object({ value: z.string().optional() }),
  handler: async ({ value }) => ({ pong: value ?? "pong" }),
});
