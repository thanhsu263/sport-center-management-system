// Every t("…") / tk("…") literal in src must have a Vietnamese entry.
//   node scripts/i18n-check.mjs            -> lists missing keys (exit 1 if any)
//   node scripts/i18n-check.mjs --unused   -> also lists dictionary keys no code uses
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const walk = (d) =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
  });

const BS = String.fromCharCode(92);
const q = (c) => `${c}(?:[^${c}${BS}${BS}${BS}n]|${BS}${BS}.)*${c}`;
const parseLit = (lit) => {
  const body = lit.slice(1, -1);
  return body.replace(new RegExp(`${BS}${BS}(.)`, "g"), (_, c) => (c === "n" ? "\n" : c));
};

const dictKeys = new Map();
const keyRe = new RegExp(`^${BS}s*(${q('"')}|${q("'")})${BS}s*:${BS}s*`, "gm");
for (const f of readdirSync("src/lib/i18n").filter((f) => /^vi.(core|pub|public|member|desk|manager|ops|srv|redesign).ts$/.test(f))) {
  const src = readFileSync(join("src/lib/i18n", f), "utf8");
  for (const m of src.matchAll(keyRe)) dictKeys.set(parseLit(m[1]), f);
}

const used = new Map();
const callRe = new RegExp(`(?<![${BS}w.])(?:t|tk)${BS}(${BS}s*(${q('"')}|${q("'")})`, "g");
for (const file of walk("src").filter((f) => !f.includes("i18n"))) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(callRe)) {
    const key = parseLit(m[1]);
    if (!used.has(key)) used.set(key, file);
  }
}

const missing = [...used].filter(([k]) => !dictKeys.has(k));
console.log(`${used.size} keys used, ${dictKeys.size} in dictionary, ${missing.length} missing`);
for (const [k, f] of missing) console.log(`  MISSING [${f}] ${JSON.stringify(k)}`);
if (process.argv.includes("--unused")) {
  const unused = [...dictKeys].filter(([k]) => !used.has(k));
  console.log(`${unused.length} unused dictionary keys`);
  for (const [k, f] of unused.slice(0, 80)) console.log(`  UNUSED [${f}] ${JSON.stringify(k)}`);
}
process.exit(missing.length ? 1 : 0);
