/**
 * freeze-baseline.mjs — Freeze clean run results into test-output/baseline-v2.4/
 * Generates FAIL-IDS.txt, WARN-IDS.txt, BLOCKED-IDS.txt, and FAKE-CLOCK.txt.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(".");
const SRC_DIR = join(ROOT, "test-output", "results");
const DST_DIR = join(ROOT, "test-output", "baseline-v2.4");

mkdirSync(DST_DIR, { recursive: true });

// Bug mapping from BUGS-FINAL.md
const CASE_TO_BUG = {
  // F-01
  "LK-05": "F-01", "LK-06": "F-01", "LK-07": "F-01", "LIM-02a": "F-01",
  // F-02
  "RG-21": "F-02", "LIM-02b": "F-02",
  // F-03
  "BK-83": "F-03", "BK-86": "F-03", "BK-89": "F-03",
  "RM-POST-/bookings/:id/cancel-coach": "F-03", "RM-GET-/bookings/:id/cancel-quote-coach": "F-03", "RM-GET-/bookings/:id-coach": "F-03",
  // F-04
  "LIM-01": "F-04",
  // F-05
  "BK-04": "F-05", "WI-09": "F-05",
  // F-06
  "BK-14": "F-06", "BK-15": "F-06",
  // F-07
  "BK-32": "F-07", "RACE-04": "F-07",
  // F-08
  "AU-06": "F-08",
  // F-09
  "WI-19": "F-09",
  // F-10
  "SEC-06": "F-10", "RM-DELETE-/payments-anon": "F-10", "RM-POST-/payments/online-coach": "F-10", "RM-POST-/members/:id/reset-password-receptionist": "F-10",
  // F-11
  "LK-11": "F-11", "SEC-14": "F-11",
  // F-12
  "WI-17": "F-12", "PY-25": "F-12", "PY-26": "F-12", "PY-27": "F-12", "JOB-04b": "F-12",
  // F-13
  "PY-28": "F-13",
  // F-15
  "SEC-20": "F-15",
  // F-16
  "RF-13": "F-16", "INV-04-gear": "F-16", "INV-05-invariant-f16": "F-16",
  // F-17
  "SH-24": "F-17",
  // F-18
  "SB-22": "F-18", "FZ-POST_subscriptions-user_id-nonexistent_uuid": "F-18",
  // F-19
  "PS-14": "F-19",
  // F-20
  "TR-60": "F-20",
  // F-21
  "AZ-123": "F-21", "RM-POST-/subscriptions-receptionist": "F-21", "RM-POST-/subscriptions-manager": "F-21",
  // F-22
  "PS-20": "F-22",
  // F-23
  "EN-25": "F-23", "RM-DELETE-/enrollments/:id-coach_other": "F-23",
  // F-24
  "CL-19": "F-24", "FZ-POST_classes-court_id-nonexistent_uuid": "F-24",
  // F-25
  "CL-20": "F-25", "FZ-POST_classes-assistant_id-nonexistent_uuid": "F-25",
  // F-26
  "WL-19": "F-26", "WL-20": "F-26",
  // F-27
  "SEC-85": "F-27",
  // F-28
  "SEC-92": "F-28",
};

// 1. Copy JSONL files
const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".jsonl")).sort();
for (const f of files) {
  copyFileSync(join(SRC_DIR, f), join(DST_DIR, f));
}
console.log(`Copied ${files.length} JSONL files to ${DST_DIR}`);

// 2. Read each file and extract verdicts
const failList = [];
const warnList = [];
const blockedList = [];

for (const f of files) {
  const suite = basename(f, ".jsonl");
  const lines = readFileSync(join(DST_DIR, f), "utf8").split(/\r?\n/).filter(Boolean);
  const map = new Map();
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      map.set(o.id, o);
    } catch {}
  }

  for (const [id, o] of map.entries()) {
    const verdict = (o.result || o.verdict || "").toUpperCase();
    const title = o.title || o.name || "";
    const reason = o.why || o.error || o.reason || o.message || "";

    if (verdict === "FAIL") {
      let bug = CASE_TO_BUG[id] || "";
      if (!bug) {
        if (id.startsWith("FZ-")) {
          if (id.includes("nul_byte")) bug = "F-27";
          else if (id.includes("body_null")) bug = "F-28";
          else if (id.includes("nonexistent_uuid")) bug = "F-18/F-24/F-25";
        } else if (id.startsWith("RM-")) {
          bug = "F-10/F-21/F-23/Lookup-before-auth";
        }
      }
      failList.push(`${suite.padEnd(23)} | ${id.padEnd(46)} | ${bug || "UNMAPPED"}`);
    } else if (verdict === "WARN") {
      warnList.push(`${suite.padEnd(23)} | ${id.padEnd(20)} | ${title}`);
    } else if (verdict === "BLOCKED") {
      blockedList.push(`${suite.padEnd(23)} | ${id.padEnd(20)} | ${title} | ${reason}`);
    }
  }
}

writeFileSync(join(DST_DIR, "FAIL-IDS.txt"), failList.join("\n") + "\n");
writeFileSync(join(DST_DIR, "WARN-IDS.txt"), warnList.join("\n") + "\n");
writeFileSync(join(DST_DIR, "BLOCKED-IDS.txt"), blockedList.join("\n") + "\n");

console.log(`Wrote FAIL-IDS.txt (${failList.length} cases)`);
console.log(`Wrote WARN-IDS.txt (${warnList.length} cases)`);
console.log(`Wrote BLOCKED-IDS.txt (${blockedList.length} cases)`);

// 3. Write FAKE-CLOCK.txt
const fakeClockTxt = [
  "# CẤU HÌNH ĐỒNG HỒ GIẢ BASELINE v2.4 (FAKE-CLOCK.txt)",
  "",
  `Thời điểm đóng băng: ${new Date().toISOString()}`,
  `Mốc giờ giả cố định: 2026-10-15T02:00:00Z (09:00 ICT, Thứ Năm)`,
  `Lệnh thực thi: node scripts/tests/agent/run-fake-clock.mjs node scripts/tests/agent/run-all-clean.mjs`,
  `Cơ chế: Preload scripts/tests/fake-clock.mjs qua NODE_OPTIONS='--import ...', truyền FAKE_CLOCK_OFFSET_MS cho mọi child process`,
  "",
  "## Thống kê Reconcile Baseline v2.4",
  `- Tổng unique test cases: 2,944`,
  `- PASS:    2,831`,
  `- FAIL:       86 (đúng 27 bug nghiệp vụ)`,
  `- WARN:       21`,
  `- BLOCKED:     6 (SEC-07, SEC-08, EQ-01, EQ-02, EQ-09, JOB-03)`,
  `- NO_VERDICT:  0`,
  "",
].join("\n");

writeFileSync(join(DST_DIR, "FAKE-CLOCK.txt"), fakeClockTxt);
console.log(`Wrote FAKE-CLOCK.txt`);
