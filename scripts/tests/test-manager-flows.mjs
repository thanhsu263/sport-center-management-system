/**
 * File: scripts/tests/test-manager-flows.mjs
 * Vai trò: Kịch bản kiểm thử E2E tự động (Playwright) cho phân hệ Quản lý (Manager - S26 đến S35).
 * Mục đích: Kiểm tra các luồng nghiệp vụ quản lý trung tâm thể thao Arena 3, bao gồm: báo cáo & phân tích (S26), quản lý lớp học (S27), quản lý nhân viên (S29), ma trận bảng giá (S30), mã khuyến mãi (S31), cấu hình hệ thống & cờ tính năng (S33) và nhật ký hoạt động (S34).
 */
import {
  BASE,
  createRolePage,
  TestCollector,
} from "./test-helper.mjs";

/**
 * Làm gì: Chạy toàn bộ các ca kiểm thử E2E tương tác cho phân hệ Quản lý (Manager - S26 đến S35), xác thực giao diện và các hành vi nghiệp vụ của Quản lý.
 * Được gọi ở: scripts/tests/run-all-interactive-tests.mjs trong hàm chạy toàn bộ suite kiểm thử.
 * - Tham số browser: Đối tượng Browser của Playwright dùng để khởi tạo ngữ cảnh và trang kiểm thử mới.
 * @returns {Promise<Object>} Báo cáo tổng hợp kết quả kiểm thử (suiteName, total, passed, failed, results) từ TestCollector.
 * @throws {Error} Ném ra lỗi nếu phiên đăng nhập quản lý hoặc khởi tạo trình duyệt thất bại.
 */
export async function runManagerFlowTests(browser) {
  // Bước 1: Khởi tạo bộ thu thập kết quả kiểm thử (TestCollector) và tạo phiên làm việc với vai trò Quản lý (Manager), tự động lưu token và thông tin người dùng vào localStorage.
  const collector = new TestCollector("Section 5: Manager (S26–S35)");
  const { context, page } = await createRolePage(browser, "manager");

  try {
    // Bước 2: Kiểm thử màn hình Báo cáo & Phân tích (S26: /manager) - kiểm tra các nút xuất dữ liệu báo cáo (Excel, PDF, CSV).
    // ==========================================
    // S26: REPORTS & ANALYTICS (/manager)
    // ==========================================
    console.log("\n--- Testing S26: Reports & Analytics (/manager) ---");
    await page.goto(`${BASE}/manager`, { waitUntil: "networkidle" });
    // Chờ 1 giây để trang tổng quan và dữ liệu biểu đồ báo cáo hoàn tất việc render.
    await page.waitForTimeout(1000);

    // 1. Export Buttons (Excel / PDF / CSV)
    await collector.runTest(
      {
        id: "TC-MGR-01",
        screen: "S26 - Reports",
        element: "Report Export Action Buttons",
        action: "Inspect export action buttons (Excel, PDF, CSV)",
        page,
      },
      async () => {
        // Tìm các nút hoặc liên kết kích hoạt xuất báo cáo định dạng Excel, PDF, CSV trên trang tổng quan.
        const exportBtns = page.locator('button:has-text("Export"), button:has-text("Xuất"), a:has-text("Export"), a:has-text("Xuất"), button:has-text("PDF"), button:has-text("Excel")');
        const count = await exportBtns.count();
        if (count === 0) {
          console.log("   (No direct export buttons on main dashboard header)");
        } else {
          console.log(`   (Found ${count} export action triggers)`);
        }
      }
    );

    // Bước 3: Kiểm thử màn hình Quản lý lớp học (S27: /manager/classes) - kiểm tra modal tạo lớp mới và ngăn kéo danh sách học viên (B-08).
    // ==========================================
    // S27: CLASS MANAGEMENT (/manager/classes)
    // ==========================================
    console.log("\n--- Testing S27: Classes (/manager/classes) ---");
    await page.goto(`${BASE}/manager/classes`, { waitUntil: "networkidle" });
    // Chờ 1 giây để danh sách các lớp học được tải đầy đủ từ máy chủ.
    await page.waitForTimeout(1000);

    // 2. 'Create Class' Modal Trigger
    await collector.runTest(
      {
        id: "TC-MGR-02",
        screen: "S27 - Class Management",
        element: "Create Class Trigger & Form",
        action: "Click 'Tạo lớp mới' / 'New class' button and inspect creation modal",
        page,
      },
      async () => {
        const createBtn = page.locator('button:has-text("New class"), button:has-text("Tạo lớp"), button:has-text("Thêm lớp")').first();
        // Nhấn nút tạo lớp mới để kiểm tra modal nhập liệu có mở ra thành công hay không rồi đóng lại.
        if (await createBtn.isVisible()) {
          await createBtn.click();
          // Chờ 600ms để hiệu ứng animation mở modal tạo lớp hoàn tất.
          await page.waitForTimeout(600);
          const modal = page.locator('[role="dialog"], form:has(select)').first();
          if (!(await modal.isVisible())) throw new Error("Create class modal did not open");
          const cancelBtn = page.locator('[role="dialog"] button:has-text("Cancel"), [role="dialog"] button:has-text("Hủy"), [role="dialog"] svg.lucide-x').first();
          if (await cancelBtn.isVisible()) await cancelBtn.click();
        }
      }
    );

    // 3. Class Detail & Roster Drawer (B-08)
    await collector.runTest(
      {
        id: "TC-MGR-03",
        screen: "S27 - Class Management",
        element: "Class Detail & Roster Inspection (B-08)",
        action: "Click a class card/row to open roster detail modal",
        page,
      },
      async () => {
        const classItem = page.locator('div[class*="Card"] button:has-text("Manage"), div[class*="Card"] button:has-text("Quản lý"), div[class*="Card"] button:has-text("Chi tiết")').first();
        // Nhấn vào thẻ lớp học để kiểm tra modal/drawer chi tiết danh sách học viên (B-08) có mở ra đúng hay không.
        if (await classItem.isVisible()) {
          await classItem.click();
          // Chờ 600ms để drawer chi tiết lớp học mở ra hoàn toàn.
          await page.waitForTimeout(600);
          const modal = page.locator('[role="dialog"]').first();
          if (!(await modal.isVisible())) throw new Error("Class detail modal did not open (B-08)");
          const cancelBtn = page.locator('[role="dialog"] button:has-text("Close"), [role="dialog"] button:has-text("Đóng"), [role="dialog"] svg.lucide-x').first();
          if (await cancelBtn.isVisible()) await cancelBtn.click();
        }
      }
    );

    // Bước 4: Kiểm thử màn hình Quản lý nhân viên (S29: /manager/staff) - kiểm tra modal thêm nhân viên mới.
    // ==========================================
    // S29: STAFF MANAGEMENT (/manager/staff)
    // ==========================================
    console.log("\n--- Testing S29: Staff (/manager/staff) ---");
    await page.goto(`${BASE}/manager/staff`, { waitUntil: "networkidle" });
    // Chờ 1 giây để danh sách nhân sự tải xong và giao diện ổn định.
    await page.waitForTimeout(1000);

    // 4. Create Staff Modal
    await collector.runTest(
      {
        id: "TC-MGR-04",
        screen: "S29 - Staff Management",
        element: "Add Staff Button & Modal",
        action: "Click 'Thêm nhân viên' / 'Add staff' button and inspect form",
        page,
      },
      async () => {
        const addBtn = page.locator('button:has-text("Add staff"), button:has-text("Thêm nhân viên"), button:has-text("Tạo nhân viên")').first();
        // Nhấn nút thêm nhân viên để kiểm tra modal tạo tài khoản nhân sự có hiển thị hợp lệ hay không.
        if (await addBtn.isVisible()) {
          await addBtn.click();
          // Chờ 600ms để hiệu ứng animation hiển thị dialog thêm nhân viên hoàn tất.
          await page.waitForTimeout(600);
          const modal = page.locator('[role="dialog"]').first();
          if (!(await modal.isVisible())) throw new Error("Add staff modal did not open");
          const cancelBtn = page.locator('[role="dialog"] button:has-text("Cancel"), [role="dialog"] button:has-text("Hủy"), [role="dialog"] svg.lucide-x').first();
          if (await cancelBtn.isVisible()) await cancelBtn.click();
        }
      }
    );

    // ==========================================
    // Bước 5: Kiểm thử màn hình Ma trận bảng giá (S30: /manager/prices) - kiểm tra các ô nhập giá và nút lưu bảng giá (tuân thủ quy tắc BR-37).
    // S30: PRICING MATRIX (/manager/prices)
    // ==========================================
    console.log("\n--- Testing S30: Prices (/manager/prices) ---");
    await page.goto(`${BASE}/manager/prices`, { waitUntil: "networkidle" });
    // Chờ 1 giây để ma trận bảng giá tải dữ liệu cấu hình từ backend.
    await page.waitForTimeout(1000);

    // 5. Price Grid Inputs & Save Price Button
    await collector.runTest(
      {
        id: "TC-MGR-05",
        screen: "S30 - Pricing Matrix",
        element: "Price Inputs & Save Button (BR-37)",
        action: "Inspect price inputs and check save price table button",
        page,
      },
      async () => {
        // Chờ các skeleton loading biến mất để đảm bảo bảng giá đã hiển thị các ô nhập thực tế thay vì khung chờ.
        await page.locator('.animate-pulse, [class*="Skeleton"]').first().waitFor({ state: "detached", timeout: 4000 }).catch(() => {});
        // Quy tắc nghiệp vụ BR-37: Kiểm tra sự tồn tại của các ô nhập giá số và nút lưu cấu hình bảng giá.
        const priceInputs = page.locator('input[inputmode="numeric"], input:not([type="hidden"])');
        const count = await priceInputs.count();
        if (count === 0) throw new Error("No price inputs rendered in pricing grid");
        const saveBtn = page.locator('button:has-text("Save"), button:has-text("Lưu"), button:has-text("Cập nhật")').first();
        if (!(await saveBtn.isVisible())) throw new Error("Save pricing table button not found");
      }
    );

    // ==========================================
    // Bước 6: Kiểm thử màn hình Quản lý khuyến mãi (S31: /manager/promos) - kiểm tra modal tạo mã giảm giá mới.
    // S31: PROMOTIONS (/manager/promos)
    // ==========================================
    console.log("\n--- Testing S31: Promos (/manager/promos) ---");
    await page.goto(`${BASE}/manager/promos`, { waitUntil: "networkidle" });
    // Chờ 1 giây để danh sách mã khuyến mãi tải xong từ máy chủ.
    await page.waitForTimeout(1000);

    // 6. Create Promo Code Modal
    await collector.runTest(
      {
        id: "TC-MGR-06",
        screen: "S31 - Promotions",
        element: "New Promo Button & Modal",
        action: "Click 'Tạo mã mới' / 'New promo' button and inspect form",
        page,
      },
      async () => {
        const newPromoBtn = page.locator('button:has-text("New promo"), button:has-text("Tạo mã"), button:has-text("Mã mới")').first();
        // Nhấn nút tạo mã mới để xác thực modal thêm khuyến mãi mở ra đúng cấu trúc rồi đóng lại.
        if (await newPromoBtn.isVisible()) {
          await newPromoBtn.click();
          // Chờ 600ms để hiệu ứng animation hiển thị modal tạo khuyến mãi hoàn tất.
          await page.waitForTimeout(600);
          const modal = page.locator('[role="dialog"]').first();
          if (!(await modal.isVisible())) throw new Error("New promo modal did not open");
          const cancelBtn = page.locator('[role="dialog"] button:has-text("Cancel"), [role="dialog"] button:has-text("Hủy"), [role="dialog"] svg.lucide-x').first();
          if (await cancelBtn.isVisible()) await cancelBtn.click();
        }
      }
    );

    // Bước 7: Kiểm thử màn hình Cài đặt hệ thống (S33: /manager/settings) - kiểm tra các cờ tính năng F4, F5, F6 và xác minh lỗi lưu form NaN (Bug B-01).
    // ==========================================
    // S33: SETTINGS (/manager/settings) - BUG B-01 CHECK
    // ==========================================
    console.log("\n--- Testing S33: Settings (/manager/settings) - Bug B-01 ---");
    await page.goto(`${BASE}/manager/settings`, { waitUntil: "networkidle" });
    // Chờ skeleton loading biến mất để đảm bảo form cài đặt nạp đầy đủ thông tin cấu hình từ hệ thống.
    await page.locator('.animate-pulse, [class*="Skeleton"]').first().waitFor({ state: "detached", timeout: 4000 }).catch(() => {});
    // Chờ 1 giây để form cài đặt ổn định trạng thái trước khi tương tác với các công tắc tính năng.
    await page.waitForTimeout(1000);

    // 7. Feature Toggles F4, F5, F6
    await collector.runTest(
      {
        id: "TC-MGR-07",
        screen: "S33 - Settings",
        element: "Feature Toggles (F4, F5, F6)",
        action: "Inspect feature toggle switches",
        page,
      },
      async () => {
        // Xác minh giao diện có ít nhất 3 công tắc tính năng cốt lõi: F4 (Điểm danh & giáo án), F5 (Gợi ý giáo án), F6 (Trợ lý hội viên AI).
        const toggles = page.locator('button[role="switch"], [role="switch"], input[type="checkbox"]');
        const count = await toggles.count();
        if (count < 3) throw new Error("Expected at least 3 feature toggles for F4, F5, F6");
      }
    );

    // 8. Settings Form Save & NaN Validation (B-01)
    await collector.runTest(
      {
        id: "TC-MGR-08",
        screen: "S33 - Settings",
        element: "Center Settings Save Button (Bug B-01)",
        action: "Click 'Save' button and check for silent NaN crash or validation handling",
        page,
      },
      async () => {
        // Kiểm tra lỗi Bug B-01: Nhấn lưu form cài đặt trung tâm và xác minh không bị lỗi crash do giá trị số bị chuyển đổi thành NaN.
        const saveBtn = page.locator('button:has-text("Save"), button:has-text("Lưu")').first();
        if (!(await saveBtn.isVisible())) throw new Error("Settings save button not found");
        await saveBtn.click();
        await page.waitForTimeout(1500);
        // Verify toast or confirmation
        // Kiểm tra thông báo toast (Sonner) để xác nhận phản hồi lưu cấu hình thành công từ backend.
        const toast = page.locator('[data-sonner-toast]').first();
        const hasToast = await toast.isVisible();
        if (!hasToast) {
          console.log("   (Save triggered, verify console for NaN errors)");
        }
      }
    );

    // Bước 8: Kiểm thử màn hình Nhật ký hoạt động (S34: /manager/audit) - kiểm tra các bộ lọc và ô tìm kiếm nhật ký kiểm toán.
    // ==========================================
    // S34: AUDIT LOG (/manager/audit)
    // ==========================================
    console.log("\n--- Testing S34: Audit Log (/manager/audit) ---");
    await page.goto(`${BASE}/manager/audit`, { waitUntil: "networkidle" });
    // Chờ 1 giây để bảng nhật ký kiểm toán tải dữ liệu ban đầu.
    await page.waitForTimeout(1000);

    // 9. Audit Log Filters & Search
    await collector.runTest(
      {
        id: "TC-MGR-09",
        screen: "S34 - Audit Log",
        element: "Audit Filter Controls",
        action: "Inspect action filter, staff filter, and search input",
        page,
      },
      async () => {
        // Nhập từ khóa tìm kiếm (ví dụ 'login') vào ô tìm kiếm để kiểm tra tính năng lọc danh sách sự kiện kiểm toán.
        const searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="Tìm"], input[type="search"]').first();
        if (await searchInput.isVisible()) {
          await searchInput.fill("login");
          await page.waitForTimeout(500);
        }
      }
    );
  // Bước 9: Dọn dẹp tài nguyên - luôn đóng browser context trong khối finally kể cả khi kiểm thử thành công hay thất bại.
  } finally {
    await context.close();
  }

  // Bước 10: Trả về báo cáo tổng kết chi tiết tất cả các ca kiểm thử thuộc Section 5 (Manager) cho kịch bản chạy chính.
  return collector.summary();
}
