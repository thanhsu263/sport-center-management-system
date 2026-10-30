import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

function getGrep(pattern, targets = ["src", "docs", "scripts", "migrations"]) {
  try {
    const res = execSync(`git grep -n -i -E "${pattern}" -- ${targets.join(" ")}`, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return res.split(/\r?\n/).filter(Boolean);
  } catch (err) {
    if (err.status === 1) return [];
    throw err;
  }
}

const daypassLines = getGrep("day.?pass|daypass|vé ngày|/day-passes");
const debtLines = getGrep("debt|công nợ|còn nợ|owed|debt_limit|v_subscription_debt");

console.log("=== EXACT GREP RESULTS ===");
console.log(`Daypass hits: ${daypassLines.length}`);
console.log(`Debt hits: ${debtLines.length}`);

writeFileSync("test-output/cleanup/daypass-grep.txt", daypassLines.join("\n"));
writeFileSync("test-output/cleanup/debt-grep.txt", debtLines.join("\n"));
console.log("Wrote raw grep hits to test-output/cleanup/*-grep.txt");
