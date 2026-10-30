import { readFileSync } from "node:fs";

const content = readFileSync("src/lib/arena3/router.ts", "utf8");
const lines = content.split("\n");

const routes = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const m = line.match(/if\s*\(\s*method\s*===\s*["'](POST|PATCH|PUT|DELETE|GET)["']/);
  if (!m) continue;
  const method = m[1];
  // Look for route path parts p0, p1, p2, p3 in this line or subsequent lines up to {
  let fullCond = line;
  let j = i;
  while (!fullCond.includes("{") && j < lines.length - 1) {
    j++;
    fullCond += " " + lines[j].trim();
  }
  // Also look for handler called
  let handler = "";
  for (let k = j; k < Math.min(lines.length, j + 5); k++) {
    if (lines[k].includes("return ")) {
      handler = lines[k].trim();
      break;
    }
  }
  routes.push({ line: i + 1, method, condition: fullCond.trim(), handler });
}

console.log(`Total routes found in router.ts: ${routes.length}`);
const writes = routes.filter((r) => ["POST", "PATCH", "PUT"].includes(r.method));
console.log(`Total write routes (POST, PATCH, PUT): ${writes.length}`);

for (const w of writes) {
  console.log(`[L${w.line}] ${w.method} -> ${w.condition} ==> ${w.handler}`);
}
