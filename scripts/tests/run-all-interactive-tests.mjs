import { createBrowser } from "./test-helper.mjs";
import { runPublicAuthTests } from "./test-public-auth.mjs";
import { runMemberFlowTests } from "./test-member-flows.mjs";
import { runDeskFlowTests } from "./test-desk-flows.mjs";
import { runCoachFlowTests } from "./test-coach-flows.mjs";
import { runManagerFlowTests } from "./test-manager-flows.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

console.log("===============================================================");
console.log("  ARENA 3 — COMPREHENSIVE INTERACTIVE ELEMENTS TEST SUITE      ");
console.log("===============================================================\n");

const startTime = Date.now();
const browser = await createBrowser();
const suiteSummaries = [];

try {
  // 1. Public & Auth
  const s1 = await runPublicAuthTests(browser);
  suiteSummaries.push(s1);

  // 2. Member Flows
  const s2 = await runMemberFlowTests(browser);
  suiteSummaries.push(s2);

  // 3. Desk Flows
  const s3 = await runDeskFlowTests(browser);
  suiteSummaries.push(s3);

  // 4. Coach Flows
  const s4 = await runCoachFlowTests(browser);
  suiteSummaries.push(s4);

  // 5. Manager Flows
  const s5 = await runManagerFlowTests(browser);
  suiteSummaries.push(s5);
} finally {
  await browser.close();
}

const totalDurationMs = Date.now() - startTime;
const allResults = suiteSummaries.flatMap((s) => s.results);
const totalTests = allResults.length;
const passedTests = allResults.filter((r) => r.status === "PASS").length;
const failedTests = allResults.filter((r) => r.status === "FAIL").length;

const finalReport = {
  timestamp: new Date().toISOString(),
  totalDurationMs,
  summary: {
    total: totalTests,
    passed: passedTests,
    failed: failedTests,
    passRate: `${((passedTests / Math.max(1, totalTests)) * 100).toFixed(1)}%`,
  },
  suites: suiteSummaries,
};

mkdirSync("docs", { recursive: true });
writeFileSync("docs/interactive-tests-report.json", JSON.stringify(finalReport, null, 2));

console.log("\n===============================================================");
console.log("  TEST EXECUTION SUMMARY                                      ");
console.log("===============================================================");
console.log(`Total Interactive Elements Tested : ${totalTests}`);
console.log(`Passed                            : ${passedTests} ✅`);
console.log(`Failed / Bugs Detected            : ${failedTests} ❌`);
console.log(`Execution Time                    : ${(totalDurationMs / 1000).toFixed(2)}s`);
console.log("===============================================================\n");

console.table(
  suiteSummaries.map((s) => ({
    Suite: s.suiteName,
    Total: s.total,
    Passed: s.passed,
    Failed: s.failed,
  }))
);

if (failedTests > 0) {
  console.log("\n❌ FAILED TESTS & DETECTED BUGS:");
  allResults
    .filter((r) => r.status === "FAIL")
    .forEach((r, i) => {
      console.log(`  ${i + 1}. [${r.id}] ${r.screen} - ${r.element}`);
      console.log(`     Action: ${r.action}`);
      console.log(`     Error : ${r.error}`);
    });
}
