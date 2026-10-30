/**
 * Summarise every test-output/results/*.jsonl into test-output/RESULTS-SUMMARY.md.
 *
 *   node scripts/tests/agent/summarize-results.mjs
 *
 * Reads each JSONL row written by check()/blocked() in agent-lib.mjs. The verdict
 * is whichever string field equals PASS / FAIL / WARN / BLOCKED (any case). When
 * a case id appears twice in one file, the last row wins.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RESULTS = join(ROOT, "test-output", "results");
const OUT = join(ROOT, "test-output", "RESULTS-SUMMARY.md");
const VERDICTS = ["PASS", "FAIL", "WARN", "BLOCKED"];

const verdictOf = (row) => {
  const v = Object.values(row).find((x) => typeof x === "string" && VERDICTS.includes(x.toUpperCase()));
  return v ? v.toUpperCase() : "UNKNOWN";
};

const detailOf = (row) =>
  Object.entries(row)
    .filter(([k, v]) => !["id", "title"].includes(k) && v != null && typeof v !== "object" && !VERDICTS.includes(String(v).toUpperCase()))
    .map(([k, v]) => `${k}=${String(v).replace(/\s+/g, " ").slice(0, 200)}`)
    .join("; ");

mkdirSync(RESULTS, { recursive: true });
const files = existsSync(RESULTS) ? readdirSync(RESULTS).filter((f) => f.endsWith(".jsonl")).sort() : [];
const lines = ["# Results summary", "", `Generated ${new Date().toISOString()} from test-output/results/*.jsonl`, ""];
lines.push("| Suite | PASS | FAIL | WARN | BLOCKED | UNKNOWN | bad lines |", "| --- | --- | --- | --- | --- | --- | --- |");
const sections = [];
const total = { PASS: 0, FAIL: 0, WARN: 0, BLOCKED: 0, UNKNOWN: 0, bad: 0 };

for (const f of files) {
  const byId = new Map();
  let bad = 0;
  for (const line of readFileSync(join(RESULTS, f), "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      byId.set(row.id ?? `#${byId.size}`, row);
    } catch {
      bad++;
    }
  }
  const counts = { PASS: 0, FAIL: 0, WARN: 0, BLOCKED: 0, UNKNOWN: 0 };
  const notPass = [];
  for (const row of byId.values()) {
    const v = verdictOf(row);
    counts[v]++;
    if (v !== "PASS") notPass.push(`- **${v}** \`${row.id ?? "?"}\` ${row.title ?? ""}${detailOf(row) ? ` — ${detailOf(row)}` : ""}`);
  }
  for (const k of Object.keys(counts)) total[k] += counts[k];
  total.bad += bad;
  const suite = f.replace(/\.jsonl$/, "");
  lines.push(`| ${suite} | ${counts.PASS} | ${counts.FAIL} | ${counts.WARN} | ${counts.BLOCKED} | ${counts.UNKNOWN} | ${bad} |`);
  if (notPass.length) sections.push(`## ${suite}`, "", ...notPass, "");
}
lines.push(`| **total** | ${total.PASS} | ${total.FAIL} | ${total.WARN} | ${total.BLOCKED} | ${total.UNKNOWN} | ${total.bad} |`, "");
lines.push(sections.length ? "# Everything that is not PASS" : "# Everything passed", "", ...sections);
writeFileSync(OUT, lines.join("\n"));
console.log(lines.slice(0, 6 + files.length + 1).join("\n"));
console.log(`\nwritten: test-output/RESULTS-SUMMARY.md (${files.length} result files)`);
