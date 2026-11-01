import { readFileSync, writeFileSync } from "node:fs";

const errs = JSON.parse(readFileSync("test-output/round3/14a-500-errors.json", "utf8"));
const groups = {};
for (const e of errs) {
  const key = `${e.handler} :: ${e.mutation}`;
  if (!groups[key]) groups[key] = { count: 0, items: [] };
  groups[key].count++;
  groups[key].items.push(`${e.route} (field: ${e.field})`);
}

console.log("=== GROUPED 500 ERRORS (14a) ===");
for (const [k, v] of Object.entries(groups)) {
  console.log(`\n[${v.count}x] ${k}`);
  for (const item of v.items) console.log(`   - ${item}`);
}

console.log(`\nTotal 500 errors: ${errs.length}`);
