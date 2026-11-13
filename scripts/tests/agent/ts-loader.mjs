import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const target = specifier.startsWith("@/") ? pathToFileURL(resolve("src", specifier.slice(2))).href : specifier;
    try {
      return nextResolve(target, context);
    } catch (error) {
      if (target.startsWith(".") || target.startsWith("file:")) {
        const url = new URL(target, context.parentURL);
        for (const suffix of [".ts", ".tsx", "/index.ts"]) {
          if (existsSync(fileURLToPath(url) + suffix)) return nextResolve(url.href + suffix, context);
        }
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (url.includes(".ttf")) return { format: "module", source: 'export default "";', shortCircuit: true };
    if (/\.tsx?$/.test(url) && !url.includes("/node_modules/")) return {
      format: "module",
      source: ts.transpileModule(readFileSync(new URL(url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: fileURLToPath(url) }).outputText,
      shortCircuit: true,
    };
    return nextLoad(url, context);
  },
});
