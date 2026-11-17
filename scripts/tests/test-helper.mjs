/**
 * File: scripts/tests/test-helper.mjs
 * Vai trò trong dự án: Bộ công cụ tiện ích (test helper) phục vụ kiểm thử giao diện E2E tự động bằng Playwright cho Arena 3.
 * Cung cấp: Cấu hình URL/viewport, danh sách tài khoản mẫu theo vai trò, hàm khởi tạo browser/page kèm session đăng nhập tự động, và TestCollector để thu thập kết quả kiểm thử.
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

/**
 * Làm gì: Địa chỉ URL gốc của server web phục vụ kiểm thử E2E, mặc định trỏ về localhost cổng 8080.
 * Được gọi ở: scripts/tests/ (test-helper.mjs -> loginApi, test-public-auth.mjs, test-member-flows.mjs, test-desk-flows.mjs, test-coach-flows.mjs, test-manager-flows.mjs).
 */
export const BASE = process.env.BASE ?? "http://127.0.0.1:8080";
/**
 * Làm gì: Mật khẩu mặc định dùng chung cho tất cả tài khoản mẫu (seed data) trong quá trình chạy kịch bản kiểm thử.
 * Được gọi ở: scripts/tests/test-helper.mjs (ROLES, loginApi).
 */
export const DEMO_PASS = "ChangeMe!a3";

/**
 * Làm gì: Danh sách tài khoản mẫu (số điện thoại, mật khẩu, trang chủ) theo từng vai trò (manager, receptionist, coach, member) để đăng nhập tự động.
 * Được gọi ở: scripts/tests/test-helper.mjs -> createRolePage.
 */
export const ROLES = {
  manager: { phone: "0900000001", password: DEMO_PASS, home: "/manager" },
  receptionist: { phone: "0900000002", password: DEMO_PASS, home: "/desk" },
  coach: { phone: "0901110011", password: DEMO_PASS, home: "/coach" },
  member: { phone: "0901230107", password: DEMO_PASS, home: "/app" },
  member2: { phone: "0901230101", password: DEMO_PASS, home: "/app" },
};

/**
 * Làm gì: Kích thước viewport màn hình máy tính tiêu chuẩn (1366x820) cho các ca kiểm thử giao diện Desktop.
 * Được gọi ở: scripts/tests/test-helper.mjs (default param của createRolePage, createGuestPage).
 */
export const VP_DESKTOP = { width: 1366, height: 820 };
/**
 * Làm gì: Kích thước viewport điện thoại tiêu chuẩn (390x844 - iPhone 12/13/14) cho các ca kiểm thử giao diện Responsive di động.
 * Được gọi ở: scripts/tests/test-helper.mjs, các file test khi truyền viewport mobile.
 */
export const VP_MOBILE = { width: 390, height: 844 };

// Tạo sẵn thư mục lưu ảnh chụp màn hình khi test case thất bại để phục vụ tra cứu và debug
mkdirSync("screenshots/test-failures", { recursive: true });

/**
 * Làm gì: Gọi trực tiếp API endpoint /v1/auth/login để lấy token xác thực và thông tin user thay vì thao tác qua form login UI.
 * Được gọi ở: scripts/tests/test-helper.mjs -> createRolePage.
 * - Tham số phone: Số điện thoại của tài khoản cần đăng nhập
 * - Tham số password: Mật khẩu đăng nhập, mặc định lấy từ DEMO_PASS
 * @returns {Promise<Object>} Dữ liệu JSON phản hồi từ API chứa token và thông tin user
 * @throws {Error} Ném lỗi nếu request HTTP trả về mã trạng thái không thành công (res.ok là false)
 */
export async function loginApi(phone, password = DEMO_PASS) {
  // Bước 1: Gửi POST request đăng nhập đến endpoint /v1/auth/login với payload JSON
  const res = await fetch(`${BASE}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, password }),
  });
  // Bước 2: Kiểm tra kết quả phản hồi; nếu thất bại thì ném lỗi kèm mã HTTP và nội dung response
  if (!res.ok) {
    throw new Error(`Login API failed for ${phone}: ${res.status} ${await res.text()}`);
  }
  // Bước 3: Parse và trả về dữ liệu session từ payload JSON
  return res.json();
}

/**
 * Làm gì: Khởi tạo và mở instance trình duyệt Chromium ở chế độ không giao diện (headless) để chạy tự động hóa kiểm thử.
 * Được gọi ở: scripts/tests/run-all-interactive-tests.mjs -> dòng 14.
 * @returns {Promise<import("playwright").Browser>} Instance trình duyệt Chromium vừa được khởi chạy
 */
export async function createBrowser() {
  return await chromium.launch({ channel: "chrome", headless: true });
}

/**
 * Làm gì: Tạo browser context và trang mới cho một vai trò xác định, tiêm sẵn token và user vào localStorage để giả lập trạng thái đã đăng nhập.
 * Được gọi ở: scripts/tests/ (test-member-flows.mjs, test-desk-flows.mjs, test-coach-flows.mjs, test-manager-flows.mjs).
 * - Tham số browser: Instance trình duyệt Chromium đang hoạt động
 * - Tham số roleKey: Khóa định danh vai trò trong hằng số ROLES (mặc định "member")
 * - Tham số vp: Kích thước khung nhìn trình duyệt (mặc định VP_DESKTOP)
 * @returns {Promise<{ context: import("playwright").BrowserContext, page: import("playwright").Page, session: Object, consoleErrors: string[] }>} Đối tượng chứa context, page, session đăng nhập và danh sách lỗi console đã ghi nhận
 */
export async function createRolePage(browser, roleKey = "member", vp = VP_DESKTOP) {
  // Bước 1: Gọi API đăng nhập để lấy token và thông tin người dùng theo roleKey
  const session = await loginApi(ROLES[roleKey].phone, ROLES[roleKey].password);
  // Bước 2: Tạo BrowserContext mới với kích thước màn hình theo viewport chỉ định
  const context = await browser.newContext({ viewport: vp });
  
  // Bước 3: Tiêm token và dữ liệu user vào localStorage trước khi load trang để hệ thống tự nhận diện phiên đăng nhập
  await context.addInitScript(([token, user]) => {
    localStorage.setItem("arena3.lang", "en");
    localStorage.setItem("arena3.token", token);
    localStorage.setItem("arena3.user", JSON.stringify(user));
  }, [session.token, session.user]);

  // Bước 4: Mở một trang mới trong context vừa tạo
  const page = await context.newPage();
  // Cài đặt timeout tối đa cho thao tác (15s) và điều hướng (25s) để tránh treo kịch bản khi mạng chậm
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(25000);
  // Bước 5: Lắng nghe và gom lại các lỗi runtime hoặc console.error phát sinh trên trang
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  // Bước 6: Trả về trang cùng context, thông tin session và mảng gom lỗi console
  return { context, page, session, consoleErrors };
}

/**
 * Làm gì: Tạo browser context và trang mới ở trạng thái khách chưa đăng nhập, đảm bảo xóa sạch token và user trong localStorage.
 * Được gọi ở: scripts/tests/test-public-auth.mjs -> runPublicAuthTests.
 * - Tham số browser: Instance trình duyệt Chromium đang hoạt động
 * - Tham số vp: Kích thước khung nhìn trình duyệt (mặc định VP_DESKTOP)
 * @returns {Promise<{ context: import("playwright").BrowserContext, page: import("playwright").Page, consoleErrors: string[] }>} Đối tượng chứa context, page và mảng gom lỗi console
 */
export async function createGuestPage(browser, vp = VP_DESKTOP) {
  // Bước 1: Tạo BrowserContext mới với kích thước viewport chỉ định
  const context = await browser.newContext({ viewport: vp });
  // Bước 2: Xóa sạch token và dữ liệu phiên trong localStorage để đảm bảo ở trạng thái khách vãng lai
  await context.addInitScript(() => {
    localStorage.setItem("arena3.lang", "en");
    localStorage.removeItem("arena3.token");
    localStorage.removeItem("arena3.user");
  });
  // Bước 3: Khởi tạo một trang mới trong context
  const page = await context.newPage();
  // Thiết lập timeout giới hạn cho thao tác và điều hướng trang
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(25000);
  // Bước 4: Đăng ký bắt lỗi runtime của trang và lỗi console.error
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  // Bước 5: Trả về context, page và mảng lưu trữ lỗi console
  return { context, page, consoleErrors };
}

/**
 * Làm gì: Quản lý việc thực thi, đo lường thời gian, bắt lỗi, chụp ảnh màn hình khi thất bại và tổng hợp kết quả của các test case trong một test suite.
 * Được gọi ở: scripts/tests/ (test-public-auth.mjs, test-member-flows.mjs, test-desk-flows.mjs, test-coach-flows.mjs, test-manager-flows.mjs).
 */
export class TestCollector {
  /**
   * Làm gì: Khởi tạo bộ thu thập kết quả kiểm thử với tên suite và danh sách kết quả rỗng.
   * Được gọi ở: Khi khởi tạo instance mới của TestCollector trong các file test suite.
   * - Tham số suiteName: Tên phân hệ hoặc nhóm kịch bản kiểm thử
   */
  constructor(suiteName) {
    this.suiteName = suiteName;
    this.results = [];
  }

  /**
   * Làm gì: Chạy một test case cụ thể, ghi nhận thời gian thực thi, bắt lỗi, tự động chụp ảnh màn hình nếu thất bại và in log kết quả ra console.
   * Được gọi ở: Các bước kiểm thử chi tiết trong scripts/tests/ (test-public-auth.mjs, test-member-flows.mjs, test-desk-flows.mjs, test-coach-flows.mjs, test-manager-flows.mjs).
   * - Tham số item: Metadata mô tả test case (id, section, screen, element, action, expected, page)
   * - Tham số fn: Hàm bất đồng bộ thực hiện các thao tác và kiểm tra assertion của test case
   * @returns {Promise<void>}
   */
  async runTest(item, fn) {
    // Bước 1: Ghi nhận thời điểm bắt đầu và khởi tạo đối tượng lưu trữ thông tin test case với trạng thái RUNNING
    const start = Date.now();
    const entry = {
      id: item.id || `T-${this.results.length + 1}`,
      section: item.section || this.suiteName,
      screen: item.screen,
      element: item.element,
      action: item.action,
      expected: item.expected,
      status: "RUNNING",
      durationMs: 0,
    };

    // Bước 2: Thực thi hàm kiểm thử; nếu hoàn thành không có ngoại lệ thì đánh dấu PASS
    try {
      await fn();
      entry.status = "PASS";
      entry.actual = item.successActual || "Operated successfully as expected";
    // Bước 3: Xử lý khi có lỗi xảy ra: đổi trạng thái sang FAIL, lưu thông báo lỗi và chụp ảnh màn hình nếu có page
    } catch (err) {
      entry.status = "FAIL";
      entry.error = err.message || String(err);
      entry.actual = `Error: ${err.message}`;
      if (item.page) {
        // Chụp ảnh màn hình tại thời điểm bị lỗi để lưu vào thư mục test-failures phục vụ kiểm tra sau này
        const shotPath = `screenshots/test-failures/${entry.id}.png`;
        try {
          await item.page.screenshot({ path: shotPath, fullPage: false });
          entry.screenshot = shotPath;
        } catch {
          // ignore screenshot error
        }
      }
    // Bước 4: Tính thời gian thực thi (durationMs), lưu kết quả vào mảng results và in log ra console kèm icon trạng thái
    } finally {
      entry.durationMs = Date.now() - start;
      this.results.push(entry);
      const icon = entry.status === "PASS" ? "✅" : "❌";
      console.log(`${icon} [${entry.id}] ${entry.screen} | ${entry.element}: ${entry.status} (${entry.durationMs}ms)`);
      if (entry.status === "FAIL") {
        console.log(`   -> Error: ${entry.error}`);
      }
    }
  }

  /**
   * Làm gì: Thống kê tổng số test case đã chạy, số lượng PASS, số lượng FAIL và trả về báo cáo tổng kết của toàn bộ suite.
   * Được gọi ở: Cuối các hàm test suite để trả về cho scripts/tests/run-all-interactive-tests.mjs tổng hợp kết quả chung.
   * @returns {{ suiteName: string, total: number, passed: number, failed: number, results: Object[] }} Object báo cáo tổng hợp kết quả của test suite
   */
  summary() {
    // Đếm tổng số test case, số test đạt (PASS) và số test thất bại (FAIL) để tạo báo cáo tổng kết
    const total = this.results.length;
    const passed = this.results.filter((r) => r.status === "PASS").length;
    const failed = this.results.filter((r) => r.status === "FAIL").length;
    return { suiteName: this.suiteName, total, passed, failed, results: this.results };
  }
}
