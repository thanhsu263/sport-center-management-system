import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = "test-output/results";
const files = readdirSync(dir).filter(f => f.endsWith(".jsonl")).sort();

let totalPass = 0;
let totalFail = 0;
let totalWarn = 0;
let totalBlocked = 0;

console.log("=== TẤT CẢ KẾT QUẢ TỪ TEST-OUTPUT/RESULTS/ ===");

const suiteStats = [];
const allFails = [];

for (const f of files) {
  const content = readFileSync(join(dir, f), "utf8").trim();
  if (!content) continue;
  const lines = content.split("\n");
  let p = 0, fl = 0, w = 0, b = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const v = obj.result ?? obj.verdict;
      if (v === "PASS") p++;
      else if (v === "FAIL") {
        fl++;
        allFails.push({
          suite: f,
          id: obj.id,
          title: obj.title,
          actual: obj.actual?.status ?? obj.actual,
          expected: obj.expected,
          problems: obj.problems,
          why: obj.why
        });
      }
      else if (v === "WARN") w++;
      else if (v === "BLOCKED") b++;
    } catch {}
  }
  totalPass += p;
  totalFail += fl;
  totalWarn += w;
  totalBlocked += b;
  suiteStats.push({ file: f, pass: p, fail: fl, warn: w, blocked: b, total: p + fl + w + b });
}

console.log("\nBẢNG KẾT QUẢ THEO TỪNG SUITE:");
console.table(suiteStats);

console.log(`\nTỔNG CỘNG: PASS=${totalPass}, FAIL=${totalFail}, WARN=${totalWarn}, BLOCKED=${totalBlocked}, TỔNG=${totalPass + totalFail + totalWarn + totalBlocked}`);

console.log(`\nDANH SÁCH TOÀN BỘ ${allFails.length} CA FAIL:`);
allFails.forEach((fl, idx) => {
  console.log(`${idx + 1}. [${fl.suite}] ${fl.id} | actual: ${JSON.stringify(fl.actual)} | exp: ${JSON.stringify(fl.expected)} | probs: ${JSON.stringify(fl.problems)}`);
});
