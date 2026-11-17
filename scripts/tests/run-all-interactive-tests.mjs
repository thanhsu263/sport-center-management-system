/**
 * File: scripts/tests/run-all-interactive-tests.mjs
 * Vai trò: Kịch bản điều phối (orchestrator) toàn bộ bài test E2E UI tương tác cho Arena 3.
 * Chức năng: Khởi tạo Playwright Chromium, chạy tuần tự 5 bộ test flow (Public/Auth, Member, Desk, Coach, Manager),
 * tổng hợp số liệu pass/fail, xuất báo cáo ra docs/interactive-tests-report.json và in kết quả ra terminal.
 * Được gọi ở: Kịch bản chấm điểm scripts/auto-grade.mjs hoặc chạy trực tiếp bằng lệnh: node scripts/tests/run-all-interactive-tests.mjs
 */
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

// Bước 1: Khởi tạo môi trường đo kiểm: ghi nhận thời gian bắt đầu, mở trình duyệt Chromium và chuẩn bị mảng lưu kết quả các bộ test
const startTime = Date.now();
const browser = await createBrowser();
const suiteSummaries = [];

// Bước 2: Thực thi tuần tự 5 bộ test flow cho các vai trò trong hệ thống.
// Đặt trong khối try...finally để đảm bảo trình duyệt luôn được đóng giải phóng tài nguyên kể cả khi có lỗi xảy ra.
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
  // Đóng phiên trình duyệt Chromium sau khi kiểm thử xong (hoặc khi gặp lỗi) để tránh rò rỉ tiến trình chạy ngầm
  await browser.close();
}

// Bước 3: Thu thập và thống kê số liệu tổng hợp (tổng thời gian, số test PASS và FAIL)
const totalDurationMs = Date.now() - startTime;
// Gộp toàn bộ mảng kết quả chi tiết từ từng bộ test thành một mảng phẳng duy nhất để tiện tính toán
const allResults = suiteSummaries.flatMap((s) => s.results);
const totalTests = allResults.length;
const passedTests = allResults.filter((r) => r.status === "PASS").length;
const failedTests = allResults.filter((r) => r.status === "FAIL").length;

// Bước 4: Tạo object báo cáo tổng kết (finalReport) chuẩn hóa chứa metadata, tỷ lệ passRate và kết quả chi tiết từng bộ test
const finalReport = {
  timestamp: new Date().toISOString(),
  totalDurationMs,
  summary: {
    total: totalTests,
    passed: passedTests,
    failed: failedTests,
    // Dùng Math.max(1, totalTests) để tránh lỗi chia cho 0 (NaN) nếu danh sách test rỗng
    passRate: `${((passedTests / Math.max(1, totalTests)) * 100).toFixed(1)}%`,
  },
  suites: suiteSummaries,
};

// Bước 5: Tạo thư mục docs (nếu chưa tồn tại) và lưu báo cáo kết quả kiểm thử dạng JSON để phục vụ lưu trữ artifact và chấm điểm
mkdirSync("docs", { recursive: true });
writeFileSync("docs/interactive-tests-report.json", JSON.stringify(finalReport, null, 2));

// Bước 6: In thông tin tổng kết (thời gian thực thi, số lượng test PASS/FAIL) và bảng tóm tắt từng suite lên màn hình terminal
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

// Bước 7: Nếu phát hiện test thất bại, lọc và in danh sách chi tiết các lỗi (mã test, màn hình, element, hành động và lỗi gặp phải) để debug
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
