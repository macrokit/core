import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";

export const greet = defineMacro({
  name: "greet",
  intent: "Greet someone by name.",
  schema: z.object({ name: z.string() }),
  handler: async ({ name }) => ({ greeting: `hello ${name}` }),
});
