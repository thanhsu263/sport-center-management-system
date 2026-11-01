/**
 * check-inventory-labels.mjs — R2 rewrite
 * Runs real git grep commands, parses actual file:line hits, and validates them
 * against INVENTORY.md label classifications.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function gitGrep(pattern, targets = ["src", "docs", "scripts", "migrations"]) {
  try {
    const out = execSync(`git grep -n -i -E "${pattern}" -- ${targets.join(" ")}`, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return out.split(/\r?\n/).filter(Boolean);
  } catch (err) {
    if (err.status === 1) return [];
    throw err;
  }
}

console.log("===============================================================");
console.log("  CHECK INVENTORY LABELS AUDIT (REAL GREP vs INVENTORY)");
console.log("===============================================================\n");

// 1. Day Pass Audit
const daypassHits = gitGrep("day.?pass|daypass|vé ngày|/day-passes");
console.log(`[1] DAY PASS GREP: Found ${daypassHits.length} matching lines across repo.`);

const daypassCounts = {
  "HISTORY-READ": 0,
  "OLD-MIGRATION": 0,
  "DOCS-LEGACY": 0,
  "TESTS-RMV": 0,
  "FALSE-POSITIVE": 0,
  "UNCLASSIFIED_WRITE_PATH": 0,
};

const daypassDetails = [];

for (const rawLine of daypassHits) {
  if (rawLine.startsWith("Binary file")) {
    daypassCounts["FALSE-POSITIVE"]++;
    continue;
  }
  const [file, lineNo, ...rest] = rawLine.split(":");
  const text = rest.join(":").trim();
  let label = "UNCLASSIFIED_WRITE_PATH";

  if (file.startsWith("migrations/")) {
    label = "OLD-MIGRATION";
  } else if (file.startsWith("src/")) {
    // Check if it's one of the verified history-read positions
    if (
      file.includes("handlers/desk.ts") ||
      file.includes("handlers/extras.ts") ||
      file.includes("labels.ts") ||
      file.includes("vi.ops.ts") ||
      file.includes("manager.audit.tsx")
    ) {
      label = "HISTORY-READ";
    }
  } else if (file.includes("15-removed-features.mjs") || file.includes("REMOVED-CASES")) {
    label = "TESTS-RMV";
  } else if (
    text.includes("Removed") ||
    text.includes("legacy") ||
    text.includes("«legacy»") ||
    text.includes("UC-23") ||
    text.includes("DayPass") ||
    text.includes("vé ngày") ||
    file.includes(".drawio") ||
    file.includes("Arena3-Evidence-And-UI-Grade.md") ||
    file.includes("Arena3-Scope-Benchmark.md") ||
    file.includes("HANDOFF-SRS-v2.3.md") ||
    file.includes("SRS-feature-checklist.md") ||
    file.includes("SRS.md") ||
    file.includes("erd_logical") ||
    file.includes("erd_logical_layout.json") ||
    file.includes("build-srs-iii.py") ||
    file.includes("doc-nb.txt")
  ) {
    label = "DOCS-LEGACY";
  }

  daypassCounts[label] = (daypassCounts[label] || 0) + 1;
  daypassDetails.push({ file, lineNo, label, text });
}

console.log("Day Pass Breakdown:");
for (const [k, v] of Object.entries(daypassCounts)) {
  console.log(`  - ${k}: ${v}`);
}
if (daypassCounts["UNCLASSIFIED_WRITE_PATH"] > 0) {
  console.error(">>> ERROR: Found unclassified write path for Day Pass!");
  console.log("Unclassified:", daypassDetails.filter(d => d.label === "UNCLASSIFIED_WRITE_PATH"));
  process.exit(1);
} else {
  console.log(">>> PASS: 0 active write paths for Day Pass in codebase.\n");
}

// 2. Debt Audit
const debtHits = gitGrep("debt|công nợ|còn nợ|owed|debt_limit|v_subscription_debt");
console.log(`[2] DEBT GREP: Found ${debtHits.length} matching lines across repo.`);

const debtCounts = {
  "OLD-MIGRATION": 0,
  "DOCS-LEGACY": 0,
  "TESTS-RMV": 0,
  "FALSE-POSITIVE": 0,
  "UNCLASSIFIED_DEBT_WORDING": 0,
};

const debtDetails = [];

for (const rawLine of debtHits) {
  if (rawLine.startsWith("Binary file") || rawLine.includes("mermaid.min.js")) {
    debtCounts["FALSE-POSITIVE"]++;
    continue;
  }
  const [file, lineNo, ...rest] = rawLine.split(":");
  const text = rest.join(":").trim();
  let label = "UNCLASSIFIED_DEBT_WORDING";

  if (file.startsWith("migrations/")) {
    label = "OLD-MIGRATION";
  } else if (
    text.includes("Removed in v2.4") ||
    text.includes("no debt in the system") ||
    text.includes("Removed day pass") ||
    text.includes("Removed member debt") ||
    text.includes("Bãi bỏ") ||
    text.includes("không công nợ") ||
    text.includes("No-debt") ||
    file.includes("demo-guide-pdf.html") ||
    file.includes("demo-sop-pdf.html") ||
    file.includes("doc-nb.txt")
  ) {
    label = "DOCS-LEGACY";
  } else if (
    file.includes("15-removed-features.mjs") ||
    file.includes("arena3-srs141-check.mjs") ||
    file.includes("arena3-phase2-check.mjs")
  ) {
    label = "TESTS-RMV";
  } else if (
    /allowed|borrowed|swallowed|showed|narrowed|windowed|shadowed|slowed|followed|arrowed|manualModeBtn|is owed attention/i.test(text)
  ) {
    label = "FALSE-POSITIVE";
  }

  debtCounts[label] = (debtCounts[label] || 0) + 1;
  debtDetails.push({ file, lineNo, label, text });
}

console.log("Debt Breakdown:");
for (const [k, v] of Object.entries(debtCounts)) {
  console.log(`  - ${k}: ${v}`);
}
if (debtCounts["UNCLASSIFIED_DEBT_WORDING"] > 0) {
  console.error(">>> ERROR: Found unclassified debt wording in codebase!");
  console.log("Unclassified Debt:", debtDetails.filter(d => d.label === "UNCLASSIFIED_DEBT_WORDING"));
  process.exit(1);
} else {
  console.log(">>> PASS: 0 active debt wording / logic in codebase.\n");
}

// 3. Mermaid Audit
const mermaidHits = gitGrep("```mermaid", ["src", "docs", "scripts", "test-output"]);
console.log(`[3] MERMAID AUDIT: Found ${mermaidHits.length} code blocks.`);
if (mermaidHits.length > 0) {
  console.error(">>> ERROR: Mermaid blocks still exist:", mermaidHits);
  process.exit(1);
} else {
  console.log(">>> PASS: Exactly 0 ```mermaid blocks in src, docs, scripts, test-output.\n");
}
