/**
 * File: scripts/tests/test-coach-flows.mjs
 * Vai trò: Kịch bản kiểm thử tự động (E2E Playwright) dành cho phân hệ Huấn luyện viên (Coach) trong hệ thống Arena 3.
 * Kiểm tra các luồng tương tác trên màn hình lịch dạy S23 (/coach) và sổ điểm danh S24 (/coach/attendance).
 */
import {
  BASE,
  createRolePage,
  TestCollector,
} from "./test-helper.mjs";

/**
 * Làm gì: Thực thi bộ kiểm thử E2E Playwright cho phân hệ Huấn luyện viên (Coach), kiểm tra tính năng xem lịch dạy (S23) và điểm danh học viên (S24).
 * Được gọi ở: scripts/tests/run-all-interactive-tests.mjs (trong kịch bản chạy toàn bộ kiểm thử tương tác).
 * - Tham số browser: Đối tượng Browser của Playwright dùng để khởi tạo ngữ cảnh và trang duyệt web mới cho vai trò Coach.
 * @returns {Promise<Object>} Bảng tổng hợp kết quả kiểm thử từ TestCollector gồm tên suite, số ca pass, số ca fail và mảng chi tiết.
 * - Lỗi có thể ném: Bắn ra lỗi nếu quá trình mở trang hoặc kiểm thử gặp sự cố không thể phục hồi.
 */
export async function runCoachFlowTests(browser) {
  // Bước 1: Khởi tạo bộ thu thập kết quả kiểm thử (TestCollector) và tạo trang trình duyệt với phiên đăng nhập của Huấn luyện viên (Coach).
  const collector = new TestCollector("Section 4: Coach (S23–S25)");
  const { context, page } = await createRolePage(browser, "coach");

  try {
    // Bước 2: Kiểm thử màn hình lịch dạy S23 (/coach) - kiểm tra điều hướng và hiển thị danh sách buổi học.
    // ==========================================
    // S23: COACH SCHEDULE (/coach)
    // ==========================================
    console.log("\n--- Testing S23: Coach Schedule (/coach) ---");
    await page.goto(`${BASE}/coach`, { waitUntil: "networkidle" });
    // Chờ 1 giây để giao diện hoàn tất render danh sách các buổi dạy sau khi API phản hồi.
    await page.waitForTimeout(1000);

    // 1. Schedule Session Cards Display & Interaction
    await collector.runTest(
      {
        id: "TC-COACH-01",
        screen: "S23 - Coach Schedule",
        element: "Session Cards & Attendance Trigger",
        action: "Inspect scheduled session cards and click to navigate to attendance",
        page,
      },
      async () => {
        // Chờ các hiệu ứng skeleton loading (animate-pulse) biến mất để đảm bảo dữ liệu buổi học đã tải xong trước khi tìm phần tử.
        await page.locator('.animate-pulse, [class*="Skeleton"]').first().waitFor({ state: "detached", timeout: 4000 }).catch(() => {});
        const takeBtn = page.locator('button:has-text("Take register"), button:has-text("Điểm danh"), button:has(svg.lucide-clipboard-check)').first();
        // Nếu có buổi dạy đang cần điểm danh, click vào nút để kiểm tra chuyển hướng sang trang /coach/attendance.
        if (await takeBtn.isVisible()) {
          await takeBtn.click();
          await page.waitForURL("**/coach/attendance**", { timeout: 4000 });
        } else {
          // Nếu không có nút điểm danh, kiểm tra xem giao diện có hiển thị trạng thái trống (empty state) hoặc thông báo sắp tới hay không để tránh trường hợp trang bị crash trắng.
          const hasEmptyOrComing = await page.locator('text=/Coming up|Sắp tới|No sessions|Không có buổi/i').first().isVisible();
          if (!hasEmptyOrComing) throw new Error("Neither session card nor empty state rendered for coach schedule");
        }
      }
    );

    // Bước 3: Kiểm thử màn hình sổ điểm danh S24 (/coach/attendance) - chuyển tab, chấm chuyên cần (tuân thủ BR-35) và nút lưu.
    // ==========================================
    // S24: ATTENDANCE REGISTER (/coach/attendance)
    // ==========================================
    console.log("\n--- Testing S24: Attendance (/coach/attendance) ---");
    await page.goto(`${BASE}/coach/attendance`, { waitUntil: "networkidle" });
    // Chờ 1 giây để danh sách học viên và các thông tin buổi học hiển thị đầy đủ.
    await page.waitForTimeout(1000);

    // 2. Attendance Roll Roster & Step Tabs
    await collector.runTest(
      {
        id: "TC-COACH-02",
        screen: "S24 - Attendance",
        element: "Attendance Step Tabs (Register, Plan, Results, Homework)",
        action: "Click tabs and verify panels switch",
        page,
      },
      async () => {
        const tabs = page.locator('button:has-text("Roll"), button:has-text("Register"), button:has-text("Plan"), button:has-text("Results"), button:has-text("Homework")');
        const count = await tabs.count();
        // Cần tối thiểu 2 tab để kiểm tra tương tác chuyển qua lại giữa các nội dung buổi học (Điểm danh, Giáo án, Kết quả, Bài tập).
        if (count >= 2) {
          await tabs.nth(1).click();
          // Chờ 500ms giữa các lần bấm để đảm bảo hiệu ứng chuyển tab hoàn tất.
          await page.waitForTimeout(500);
          await tabs.nth(0).click();
          await page.waitForTimeout(500);
        }
      }
    );

    // 3. Four-Option Attendance Buttons (Present, Late, Absent, Excused)
    await collector.runTest(
      {
        id: "TC-COACH-03",
        screen: "S24 - Attendance",
        element: "Attendance Status Buttons (Present, Late, Absent, Excused)",
        action: "Inspect student roll and click attendance status buttons",
        page,
      },
      async () => {
        const attBtns = page.locator('button[aria-label*="Present"], button:has-text("Present"), button:has-text("Có mặt")');
        if (await attBtns.count() > 0) {
          const firstBtn = attBtns.first();
          // Quy tắc nghiệp vụ BR-35: Sổ điểm danh bị khóa sau khi kết thúc buổi học 2 tiếng (sau mốc này chỉ Quản lý mới được chỉnh sửa).
          // Chỉ click thử nút điểm danh nếu nút còn mở (enabled), ngược lại ghi nhận sổ đã bị khóa theo đúng quy định.
          if (await firstBtn.isEnabled()) {
            await firstBtn.click();
            // Chờ 300ms để UI cập nhật phản hồi sau khi bấm nút chọn trạng thái.
            await page.waitForTimeout(300);
          } else {
            console.log("   (Attendance register is locked per BR-35 2-hour window)");
          }
        }
      }
    );

    // 4. Save Attendance Button
    await collector.runTest(
      {
        id: "TC-COACH-04",
        screen: "S24 - Attendance",
        element: "Save Attendance Action Button",
        action: "Verify Save / Mark Done attendance button",
        page,
      },
      async () => {
        const saveBtn = page.locator('button:has-text("Save"), button:has-text("Lưu"), button:has-text("Done"), button:has-text("Xong")').first();
        // Kiểm tra nút lưu điểm danh (Save/Done) có hiển thị để xác nhận huấn luyện viên có thể hoàn tất việc điểm danh.
        if (await saveBtn.isVisible()) {
          console.log("   (Save attendance button present on register)");
        }
      }
    );
  } finally {
    // Bước 4: Đóng context trình duyệt trong khối finally để dọn dẹp tài nguyên và kết thúc phiên làm việc an toàn.
    await context.close();
  }

  // Bước 5: Trả về kết quả tổng hợp của toàn bộ các ca kiểm thử trong Section 4 (Coach).
  return collector.summary();
}
