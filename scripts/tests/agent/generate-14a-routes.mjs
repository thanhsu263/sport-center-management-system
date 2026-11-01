import { readFileSync, writeFileSync } from "node:fs";

const content = readFileSync("src/lib/arena3/router.ts", "utf8");
const lines = content.split("\n");

function reconstructPath(cond) {
  // Extract parts from cond
  // Examples:
  // p0 === "auth" && p1 === "login"
  // p0 === "bookings" && p1 && p2 === "confirm"
  // p0 === "classes" && p1 && p2 === "plans" && parts[3] === "duplicate-week"
  const getPart = (name) => {
    const m = cond.match(new RegExp(`${name}\\s*===\\s*["']([^"']+)["']`));
    return m ? m[1] : null;
  };
  const hasWildcard = (name) => {
    // e.g. p1 && !p2, or p1 && p2 === ...
    const m = cond.match(new RegExp(`${name}\\s*(&&|\\))`));
    const eq = cond.match(new RegExp(`${name}\\s*===`));
    const notEq = cond.match(new RegExp(`!${name}`));
    return m && !eq && !notEq;
  };

  const p0 = getPart("p0");
  const p1Val = getPart("p1");
  const p1Wild = !p1Val && hasWildcard("p1");
  const p1 = p1Val ?? (p1Wild ? ":id" : null);

  const p2Val = getPart("p2");
  const p2Wild = !p2Val && hasWildcard("p2");
  const p2 = p2Val ?? (p2Wild ? ":subId" : null);

  const p3Match = cond.match(/parts\[3\]\s*===\s*["']([^"']+)["']/);
  const p3 = p3Match ? p3Match[1] : null;

  let path = "/" + (p0 ?? "");
  if (p1) path += "/" + p1;
  if (p2) path += "/" + p2;
  if (p3) path += "/" + p3;
  return path;
}

const writeRoutes = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const m = line.match(/if\s*\(\s*method\s*===\s*["'](POST|PATCH|PUT)["']/);
  if (!m) continue;
  const method = m[1];
  let fullCond = line;
  let j = i;
  while (!fullCond.includes("{") && j < lines.length - 1) {
    j++;
    fullCond += " " + lines[j].trim();
  }
  let handler = "";
  for (let k = j; k < Math.min(lines.length, j + 5); k++) {
    if (lines[k].includes("return ")) {
      handler = lines[k].trim();
      break;
    }
  }
  const path = reconstructPath(fullCond);
  writeRoutes.push({
    line: i + 1,
    method,
    path,
    condition: fullCond.replace(/\s+/g, " "),
    handler: handler.replace(/return\s+(authed|authedRead)\s*\(\s*\(sql,\s*user\)\s*=>\s*/, "").replace(/\);?$/, "")
  });
}

console.log(`Extracted ${writeRoutes.length} write routes.`);
let md = `# TOÀN BỘ ROUTE POST/PATCH/PUT TRONG ROUTER.TS (TỔNG SỐ: ${writeRoutes.length})\n\n`;
md += `Trích xuất trực tiếp từ \`src/lib/arena3/router.ts\` vào lúc ${new Date().toISOString()}.\n\n`;
md += `| STT | Dòng | Method | Đường dẫn route | Handler xử lý |\n`;
md += `|:---:|:---:|:---:|---|---|\n`;

writeRoutes.forEach((r, idx) => {
  md += `| ${idx + 1} | L${r.line} | \`${r.method}\` | \`${r.path}\` | \`${r.handler}\` |\n`;
});

writeFileSync("test-output/round3/14a-routes.md", md, "utf8");
console.log("Wrote test-output/round3/14a-routes.md successfully.");
