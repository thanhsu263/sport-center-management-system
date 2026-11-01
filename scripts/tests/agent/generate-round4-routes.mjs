import { readFileSync, writeFileSync } from "node:fs";

const content = readFileSync("src/lib/arena3/router.ts", "utf8");
const lines = content.split("\n");

function reconstructPath(cond) {
  // Extract parts from cond
  // Examples:
  // p0 === "auth" && p1 === "login"
  // p0 === "bookings" && p1 && p2 === "confirm"
  // p0 === "classes" && p1 && p2 === "plans" && parts[3] === "duplicate-week"
  // p0 === "invoices" && p1?.endsWith(".xml")
  // p0 === "payments" && p1 === "online" && p2 && parts[3] === "verify"

  const getLiteral = (param) => {
    const m = cond.match(new RegExp(`${param}\\s*===\\s*["']([^"']+)["']`));
    return m ? m[1] : null;
  };

  const p0 = getLiteral("p0");
  const p1Val = getLiteral("p1");
  const p2Val = getLiteral("p2");

  const p3Match = cond.match(/parts\[3\]\s*===\s*["']([^"']+)["']/);
  const p3Val = p3Match ? p3Match[1] : null;

  // Check wildcards
  let p1 = p1Val;
  if (!p1) {
    if (cond.includes("p1?.endsWith(\".xml\")")) {
      p1 = ":id.xml";
    } else if (cond.includes("p1?.endsWith(\".pdf\")")) {
      p1 = ":id.pdf";
    } else if (cond.match(/\bp1\b/) && !cond.includes("!p1")) {
      p1 = ":id";
    }
  }

  let p2 = p2Val;
  if (!p2) {
    if (cond.match(/\bp2\b/) && !cond.includes("!p2") && !cond.includes("p2 ===")) {
      p2 = ":subId";
    } else if (p3Val) {
      p2 = ":id";
    }
  }

  let p3 = p3Val;

  let path = "/" + (p0 ?? "");
  if (p1) path += "/" + p1;
  if (p2) path += "/" + p2;
  if (p3) path += "/" + p3;
  return path;
}

const allRoutes = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const m = line.match(/if\s*\(\s*method\s*===\s*["'](GET|POST|PATCH|PUT|DELETE)["']/);
  if (!m) continue;

  const method = m[1];
  let fullCond = line;
  let j = i;
  while (!fullCond.includes("{") && j < lines.length - 1) {
    j++;
    fullCond += " " + lines[j].trim();
  }

  // Find handler
  let handler = "";
  for (let k = j; k < Math.min(lines.length, j + 8); k++) {
    const l = lines[k].trim();
    if (l.startsWith("return ") || l.startsWith("throw ")) {
      handler = l;
      break;
    }
  }

  const path = reconstructPath(fullCond);
  const cleanCond = fullCond.trim().replace(/\s*\{\s*$/, "").replace(/^if\s*\(/, "").replace(/\)$/, "").trim();
  const cleanHandler = handler
    .replace(/^return\s+(authed|authedRead)\s*\(\s*\(sql(?:,\s*user)?\)\s*=>\s*/, "")
    .replace(/^return\s+withTx\s*\(\s*\(sql\)\s*=>\s*/, "")
    .replace(/^return\s+/, "")
    .replace(/\);?$/, "")
    .replace(/;$/, "");

  allRoutes.push({
    index: allRoutes.length + 1,
    line: i + 1,
    method,
    path,
    isWrite: ["POST", "PATCH", "PUT", "DELETE"].includes(method),
    isWriteP3: ["POST", "PATCH", "PUT"].includes(method),
    condition: cleanCond,
    rawHandler: handler,
    handler: cleanHandler
  });
}

const byMethod = {};
for (const r of allRoutes) {
  byMethod[r.method] = (byMethod[r.method] || 0) + 1;
}

const writeP3 = allRoutes.filter(r => r.isWriteP3);
const writeAll = allRoutes.filter(r => r.isWrite);

console.log(`Parsed total ${allRoutes.length} routes.`);
console.log("By Method:", byMethod);
console.log(`Write routes (POST/PATCH/PUT): ${writeP3.length}`);
console.log(`Write routes (POST/PATCH/PUT/DELETE): ${writeAll.length}`);

// Generate Markdown
let md = `# DANH MỤC THỐNG NHẤT TOÀN BỘ ROUTE TRONG ROUTER.TS (VÒNG 4)

Trích xuất trực tiếp từ \`src/lib/arena3/router.ts\` bằng script duy nhất \`scripts/tests/agent/generate-round4-routes.mjs\`.
Thời điểm tạo: ${new Date().toISOString()}

---

## 1. Tổng quan số lượng Route

| Phân loại | Số lượng | Ghi chú |
|---|:---:|---|
| **Tổng số route hệ thống** | **${allRoutes.length}** | Tất cả các endpoint được định tuyến trong \`router.ts\` |
| • GET (Read routes) | **${byMethod.GET || 0}** | Các truy vấn đọc dữ liệu |
| • POST (Create / Action) | **${byMethod.POST || 0}** | Các hành động tạo mới, cập nhật trạng thái, xác thực |
| • PATCH (Partial Update) | **${byMethod.PATCH || 0}** | Cập nhật một phần thực thể |
| • PUT (Idempotent Update) | **${byMethod.PUT || 0}** | Thay thế hoặc cập nhật toàn bộ |
| • DELETE (Delete) | **${byMethod.DELETE || 0}** | Route xoá (\`/enrollments/:id\` và \`/payments\`) |
| **Tổng số route ghi (POST, PATCH, PUT)** | **${writeP3.length}** | Phạm vi fuzzing Suite 14a |
| **Tổng số route ghi (kèm DELETE)** | **${writeAll.length}** | Tất cả các mutation routes |

---

## 2. Bảng kê chi tiết 161 Routes trong hệ thống

| STT | Dòng | Method | Đường dẫn Route | Loại | Handler xử lý | Điều kiện Router |
|:---:|:---:|:---:|---|:---:|---|---|
`;

allRoutes.forEach((r) => {
  const typeBadge = r.isWrite ? "**WRITE**" : "READ";
  md += `| ${r.index} | L${r.line} | \`${r.method}\` | \`${r.path}\` | ${typeBadge} | \`${r.handler}\` | \`${r.condition}\` |\n`;
});

writeFileSync("test-output/round4/ROUTES.md", md, "utf8");
writeFileSync("test-output/round4/routes-all.json", JSON.stringify(allRoutes, null, 2), "utf8");
writeFileSync("test-output/round4/routes-write.json", JSON.stringify(writeP3, null, 2), "utf8");
console.log("Wrote test-output/round4/ROUTES.md, routes-all.json, routes-write.json successfully.");
