// ESM module-customization hook for loading a Macrokit project's on-disk
// TypeScript macros/primitives (the layout `macrokit init` scaffolds).
//
// Two jobs, both pure infrastructure (no domain content):
//   1. Alias the bare `@macrokit/*` + `zod` specifiers to THIS package's own
//      installed copies (paths computed via import.meta.resolve and handed in
//      as data.aliases), so a project's macros load even if the project has no
//      node_modules of its own.
//   2. Remap TS-convention relative `./x.js` import specifiers to the `./x.ts`
//      source on disk (Node strips types natively; the `.js` file never exists).
//
// Registered via module.register before any project import. Copied verbatim to
// dist/ by the package build.
let aliases = {};

export async function initialize(data) {
  aliases = (data && data.aliases) || {};
}

export async function resolve(specifier, context, nextResolve) {
  if (Object.prototype.hasOwnProperty.call(aliases, specifier)) {
    return { url: aliases[specifier], shortCircuit: true };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
      return nextResolve(specifier.slice(0, -3) + ".ts", context);
    }
    throw err;
  }
}
