import fs from "node:fs";
import path from "node:path";

const beforeDir = "test-output/bugfix/G-1/final";
const afterDir = "test-output/results";

function loadDir(dir) {
  const map = new Map();
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
  for (const f of files) {
    const suite = f.replace(".jsonl", "");
    const lines = fs.readFileSync(path.join(dir, f), "utf8").trim().split(/\r?\n/);
    for (const l of lines) {
      if (!l.trim()) continue;
      const c = JSON.parse(l);
      const verdict = c.verdict || c.result;
      map.set(`${suite}:${c.id}`, { suite, id: c.id, verdict });
    }
  }
  return map;
}

const beforeMap = loadDir(beforeDir);
const afterMap = loadDir(afterDir);

// Build expected set
// 1. Cases in regression map for F-05, F-22, F-27, F-28
// F-05: BK-04, WI-09
// F-22: PS-20 (which is FZ-11 in suite 05)
// F-27: SEC-85, and any FZ-*-nul_byte in FAIL
// F-28: SEC-92, and any FZ-*-body_null in FAIL
const expectedIds = new Set();
for (const [key, val] of beforeMap.entries()) {
  const { suite, id, verdict } = val;
  if (id === "BK-04" || id === "WI-09") {
    if (verdict === "FAIL") expectedIds.add(key);
  } else if (suite === "05-plans-subscriptions" && id === "FZ-11") {
    if (verdict === "WARN" || verdict === "FAIL") expectedIds.add(key);
  } else if (id === "SEC-85" || id === "SEC-92") {
    if (verdict === "FAIL") expectedIds.add(key);
  } else if (/^FZ-.*-nul_byte$/.test(id) || /^FZ-.*-body_null$/.test(id)) {
    if (verdict === "FAIL") expectedIds.add(key);
  }
}

// Find actual transitions
const actualTransitions = [];
for (const [key, beforeVal] of beforeMap.entries()) {
  const afterVal = afterMap.get(key);
  if (afterVal && afterVal.verdict !== beforeVal.verdict) {
    actualTransitions.push({
      key,
      id: beforeVal.id,
      suite: beforeVal.suite,
      from: beforeVal.verdict,
      to: afterVal.verdict
    });
  }
}

console.log("===============================================================");
console.log("  ĐỐI CHIẾU DANH SÁCH CASE KỲ VỌNG VÒNG 2 (SECTION 4.7)");
console.log("===============================================================");
console.log(`Số case kỳ vọng đổi trạng thái: ${expectedIds.size}`);
console.log(`Số case thực tế đổi trạng thái: ${actualTransitions.length}`);

const actualKeys = new Set(actualTransitions.map(t => t.key));

// IDs kỳ vọng mà không đổi
const notChanged = [...expectedIds].filter(k => !actualKeys.has(k));
console.log(`Số case kỳ vọng mà không đổi:   ${notChanged.length}`);
if (notChanged.length > 0) {
  console.log("Chi tiết:", notChanged);
} else {
  console.log("Chi tiết: Không có (tất cả 36 case kỳ vọng đều đã đổi sang PASS).");
}

// IDs đổi ngoài danh sách
const unexpected = actualTransitions.filter(t => !expectedIds.has(t.key));
console.log(`Số case đổi ngoài danh sách:    ${unexpected.length} (phải bằng 0)`);
if (unexpected.length > 0) {
  console.log("Chi tiết:", unexpected);
} else {
  console.log("Chi tiết: Không có (0 case đổi ngoài danh sách).");
}

console.log("\nPhân rã 36 case thực tế theo Bug ID:");
const f05 = actualTransitions.filter(t => t.id === "BK-04" || t.id === "WI-09");
const f22 = actualTransitions.filter(t => t.id === "FZ-11" || t.id === "PS-20");
const f27 = actualTransitions.filter(t => t.id === "SEC-85" || t.id.endsWith("-nul_byte"));
const f28 = actualTransitions.filter(t => t.id === "SEC-92" || t.id.endsWith("-body_null"));

console.log(`- F-05 (Invalid start_at):    ${f05.length} cases (${f05.map(t => t.id).join(", ")})`);
console.log(`- F-22 (Freeze days 'abc'):   ${f22.length} cases (${f22.map(t => t.id).join(", ")})`);
console.log(`- F-27 (NUL byte):            ${f27.length} cases (${f27.map(t => t.id).join(", ")})`);
console.log(`- F-28 (Body null):           ${f28.length} cases (${f28.map(t => t.id).join(", ")})`);
console.log(`Tổng cộng: ${f05.length + f22.length + f27.length + f28.length} cases.`);
