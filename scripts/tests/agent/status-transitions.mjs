/**
 * status-transitions.mjs — So sánh biến động trạng thái giữa 2 thư mục JSONL
 * Cách dùng: node status-transitions.mjs <dirTruoc> <dirSau>
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const VERDICTS = ["PASS", "FAIL", "WARN", "BLOCKED"];

function verdictOf(row) {
  if (row.verdict && VERDICTS.includes(String(row.verdict).toUpperCase())) {
    return String(row.verdict).toUpperCase();
  }
  if (row.result && VERDICTS.includes(String(row.result).toUpperCase())) {
    return String(row.result).toUpperCase();
  }
  const v = Object.values(row).find((x) => typeof x === "string" && VERDICTS.includes(x.toUpperCase()));
  return v ? v.toUpperCase() : "NO_VERDICT";
}

function loadDir(dir) {
  const map = new Map(); // id -> { suite, verdict, raw }
  if (!existsSync(dir)) return map;
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  for (const f of files) {
    const suite = basename(f, ".jsonl");
    const content = readFileSync(join(dir, f), "utf8");
    const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (const l of lines) {
      try {
        const obj = JSON.parse(l);
        if (obj.id) {
          const key = `${suite}:${obj.id}`;
          map.set(key, { suite, id: obj.id, verdict: verdictOf(obj), raw: obj });
        }
      } catch {}
    }
  }
  return map;
}

const dirBefore = resolve(process.argv[2] ?? "test-output/baseline-v2.4");
const dirAfter = resolve(process.argv[3] ?? "test-output/results");

console.log(`===============================================================`);
console.log(`  ĐỐI SOÁT BIẾN ĐỘNG TRẠNG THÁI (STATUS TRANSITIONS)`);
console.log(`  Trước: ${dirBefore}`);
console.log(`  Sau:   ${dirAfter}`);
console.log(`===============================================================\n`);

const beforeMap = loadDir(dirBefore);
const afterMap = loadDir(dirAfter);

console.log(`Tổng số unique cases trước: ${beforeMap.size}`);
console.log(`Tổng số unique cases sau:   ${afterMap.size}\n`);

// 1. IDs chỉ có ở trước
const onlyBefore = [];
for (const [id, val] of beforeMap.entries()) {
  if (!afterMap.has(id)) {
    onlyBefore.push({ id, ...val });
  }
}

// 2. IDs chỉ có ở sau
const onlyAfter = [];
for (const [id, val] of afterMap.entries()) {
  if (!beforeMap.has(id)) {
    onlyAfter.push({ id, ...val });
  }
}

// 3. IDs đổi trạng thái
const transitions = [];
for (const [id, beforeVal] of beforeMap.entries()) {
  const afterVal = afterMap.get(id);
  if (afterVal && afterVal.verdict !== beforeVal.verdict) {
    transitions.push({
      id,
      suiteBefore: beforeVal.suite,
      suiteAfter: afterVal.suite,
      from: beforeVal.verdict,
      to: afterVal.verdict,
    });
  }
}

console.log(`--- 1. Các case chỉ có ở thư mục TRƯỚC (${onlyBefore.length}) ---`);
if (onlyBefore.length === 0) {
  console.log("  (Không có)");
} else {
  for (const c of onlyBefore) {
    console.log(`  - [${c.suite}] ${c.id} (${c.verdict})`);
  }
}

console.log(`\n--- 2. Các case chỉ có ở thư mục SAU (${onlyAfter.length}) ---`);
if (onlyAfter.length === 0) {
  console.log("  (Không có)");
} else {
  for (const c of onlyAfter) {
    console.log(`  - [${c.suite}] ${c.id} (${c.verdict})`);
  }
}

console.log(`\n--- 3. Các case đổi trạng thái (${transitions.length}) ---`);
if (transitions.length === 0) {
  console.log("  (Không có case nào đổi trạng thái)");
} else {
  for (const t of transitions) {
    console.log(`  - [${t.suiteAfter}] ${t.id}: ${t.from} -> ${t.to}`);
  }
}

// 4. Bảng đếm tổng hợp
function countVerdicts(map) {
  const counts = { PASS: 0, FAIL: 0, WARN: 0, BLOCKED: 0, NO_VERDICT: 0 };
  for (const v of map.values()) {
    counts[v.verdict] = (counts[v.verdict] || 0) + 1;
  }
  return counts;
}

const cBefore = countVerdicts(beforeMap);
const cAfter = countVerdicts(afterMap);

console.log(`\n--- 4. Bảng đếm tổng hợp ---`);
console.log(`| Trạng thái | Trước | Sau | Biến động |`);
console.log(`| :--- | :---: | :---: | :---: |`);
for (const v of [...VERDICTS, "NO_VERDICT"]) {
  const diff = cAfter[v] - cBefore[v];
  const diffStr = diff > 0 ? `+${diff}` : diff < 0 ? `${diff}` : `0`;
  console.log(`| ${v.padEnd(10)} | ${String(cBefore[v]).padStart(5)} | ${String(cAfter[v]).padStart(5)} | ${diffStr.padStart(9)} |`);
}
const totDiff = afterMap.size - beforeMap.size;
const totDiffStr = totDiff > 0 ? `+${totDiff}` : totDiff < 0 ? `${totDiff}` : `0`;
console.log(`| TỔNG CỘNG  | ${String(beforeMap.size).padStart(5)} | ${String(afterMap.size).padStart(5)} | ${totDiffStr.padStart(9)} |`);
