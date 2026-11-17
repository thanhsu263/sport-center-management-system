/**
 * Tệp kiểm thử E2E tương tác cho phân hệ Public & Xác thực (S01–S04).
 * Sử dụng Playwright để tự động hóa kiểm tra các màn hình và tính năng công khai:
 * - S01: Trang chủ (Landing Page /) - menu điều hướng, đổi ngôn ngữ, CTA đặt sân, bộ lọc thể thao, modal HLV.
 * - S02: Trang đăng nhập (/login) - form nhập liệu, ẩn/hiện mật khẩu, validation, đăng nhập tài khoản demo.
 * - S03: Trang đăng ký (/register) - form đăng ký, kiểm tra xác nhận mật khẩu không khớp.
 * - S04: Trang quên mật khẩu (/forgot) - gửi yêu cầu cấp lại mật khẩu qua OTP.
 * Tệp này đóng vai trò là chặng kiểm thử đầu tiên trong bộ kiểm thử toàn diện của Arena 3.
 */
import {
  BASE,
  createBrowser,
  createGuestPage,
  TestCollector,
} from "./test-helper.mjs";

/**
 * Làm gì: Chạy toàn bộ các ca kiểm thử E2E tương tác cho phân hệ Public & Xác thực (S01–S04).
 * Được gọi ở: scripts/tests/run-all-interactive-tests.mjs (hàm main, bước kiểm thử đầu tiên).
 * - Tham số browser: Đối tượng Browser của Playwright để tạo ngữ cảnh ẩn danh (guest page).
 * @returns {Promise<Object>} Báo cáo tổng kết kiểm thử (suiteName, total, passed, failed, results).
 * - Lỗi có thể ném: Không ném lỗi ra ngoài; mọi lỗi trong test case được TestCollector bắt lại và ghi nhận.
 */
export async function runPublicAuthTests(browser) {
  // Bước 1: Khởi tạo bộ thu thập kết quả kiểm thử và mở trang ẩn danh (guest page) chưa đăng nhập.
  const collector = new TestCollector("Section 1: Public & Authentication (S01–S04)");
  const { context, page } = await createGuestPage(browser);

  try {
    // Bước 2: Kiểm thử màn hình S01 - Trang chủ (Landing Page /) với các thành phần giao diện công khai.
    // ==========================================
    // S01: LANDING PAGE (/)
    // ==========================================
    console.log("\n--- Testing S01: Landing Page (/) ---");
    // Điều hướng đến trang chủ và chờ mạng yên lặng (networkidle) để tải đầy đủ dữ liệu ban đầu.
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // 1. Header Navigation "Sign in"
    await collector.runTest(
      {
        id: "TC-PUB-01",
        screen: "S01 - Landing Page",
        element: "Header Sign In Button",
        action: "Click header link to /login",
        page,
      },
      async () => {
        const link = page.locator('header a[href="/login"], nav a[href="/login"]').first();
        if (!(await link.isVisible())) throw new Error("Header Sign In link not visible");
        await link.click();
        await page.waitForURL("**/login", { timeout: 4000 });
        // Điều hướng quay lại trang chủ để chuẩn bị trạng thái cho ca kiểm thử kế tiếp.
        await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
      }
    );

    // 2. Header Navigation "Register"
    await collector.runTest(
      {
        id: "TC-PUB-02",
        screen: "S01 - Landing Page",
        element: "Header Register Button",
        action: "Click header link to /register",
        page,
      },
      async () => {
        const link = page.locator('header a[href="/register"], nav a[href="/register"]').first();
        if (!(await link.isVisible())) throw new Error("Header Register link not visible");
        await link.click();
        await page.waitForURL("**/register", { timeout: 4000 });
        // Điều hướng quay lại trang chủ sau khi xác nhận chuyển hướng đến /register thành công.
        await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
      }
    );

    // 3. Language Switcher
    await collector.runTest(
      {
        id: "TC-PUB-03",
        screen: "S01 - Landing Page",
        element: "Language Switcher Button",
        action: "Toggle language switch en <-> vi",
        page,
      },
      async () => {
        const viBtn = page.locator('button[aria-label="Tiếng Việt"], button:has-text("VI")').first();
        const enBtn = page.locator('button[aria-label="English"], button:has-text("EN")').first();
        if (await viBtn.isVisible() && await enBtn.isVisible()) {
          await viBtn.click();
          await page.waitForTimeout(500);
          // Kiểm tra aria-pressed="true" để đảm bảo nút ngôn ngữ tiếng Việt đã được kích hoạt thành công.
          const isViPressed = await viBtn.getAttribute("aria-pressed");
          if (isViPressed !== "true") throw new Error("Language switch to VI did not activate");
          // Toggle back to EN
          await enBtn.click();
          await page.waitForTimeout(500);
        }
      }
    );

    // 4. Hero CTA "Book a court" anchor
    await collector.runTest(
      {
        id: "TC-PUB-04",
        screen: "S01 - Landing Page",
        element: "Hero 'Book a court' Anchor CTA",
        action: "Click hero CTA to scroll to #schedule",
        page,
      },
      async () => {
        // Nút CTA là anchor link dẫn tới phần lịch sân #schedule, kiểm tra cuộn trang mà không đổi route.
        const cta = page.locator('a[href="#schedule"]').first();
        if (!(await cta.isVisible())) throw new Error("Book a court CTA button not visible");
        await cta.click();
        await page.waitForTimeout(500);
      }
    );

    // 5. Schedule Sport Filter Tabs
    await collector.runTest(
      {
        id: "TC-PUB-05",
        screen: "S01 - Landing Page",
        element: "Schedule Sport Tabs",
        action: "Click badminton, basketball, volleyball filter tabs",
        page,
      },
      async () => {
        const sportTabs = page.locator('#schedule button, [role="tab"]');
        const count = await sportTabs.count();
        if (count < 2) throw new Error("Less than 2 sport tabs found in schedule section");
        // Chuyển sang tab môn thể thao thứ 2 rồi chuyển lại tab đầu tiên để kiểm tra sự kiện lọc danh sách.
        await sportTabs.nth(1).click();
        await page.waitForTimeout(500);
        await sportTabs.nth(0).click();
        await page.waitForTimeout(500);
      }
    );

    // 6. Coach Modal Trigger & Close
    await collector.runTest(
      {
        id: "TC-PUB-06",
        screen: "S01 - Landing Page",
        element: "Coach Card Detail Modal",
        action: "Click coach card to open bio modal, then click close",
        page,
      },
      async () => {
        // Nhấp vào thẻ HLV để mở modal tiểu sử, sau đó tìm nút đóng hoặc biểu tượng X để đóng lại.
        const coachBtn = page.locator('button:has-text("Coach"), button:has-text("HLV")').first();
        if (await coachBtn.isVisible()) {
          await coachBtn.click();
          await page.waitForTimeout(500);
          const closeBtn = page.locator('[role="dialog"] button:has-text("Close"), [role="dialog"] button:has-text("Đóng"), [role="dialog"] svg.lucide-x').first();
          if (await closeBtn.isVisible()) {
            await closeBtn.click();
            await page.waitForTimeout(300);
          }
        }
      }
    );

    // Bước 3: Kiểm thử màn hình S02 - Đăng nhập (/login) và các kịch bản kiểm tra form.
    // ==========================================
    // S02: LOGIN SCREEN (/login)
    // ==========================================
    console.log("\n--- Testing S02: Login Screen (/login) ---");
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // 7. Phone & Password input elements existence
    await collector.runTest(
      {
        id: "TC-LOGIN-01",
        screen: "S02 - Login Screen",
        element: "Phone and Password Inputs",
        action: "Inspect visibility of phone and password input fields",
        page,
      },
      async () => {
        // Sử dụng các selector dự phòng phổ biến để tìm trường nhập số điện thoại và mật khẩu.
        const phoneInput = page.locator('input[type="tel"], input[name="phone"], input[placeholder*="09"], input[autocomplete="username"]').first();
        const passInput = page.locator('input[type="password"]').first();
        if (!(await phoneInput.isVisible())) throw new Error("Phone input field not visible");
        if (!(await passInput.isVisible())) throw new Error("Password input field not visible");
      }
    );

    // 8. Password Visibility Toggle (Show/Hide)
    await collector.runTest(
      {
        id: "TC-LOGIN-02",
        screen: "S02 - Login Screen",
        element: "Password Eye Toggle Button",
        action: "Click eye icon to toggle password input type between password and text",
        page,
      },
      async () => {
        const passInput = page.locator('input[type="password"]').first();
        await passInput.fill("Secret123!");
        const toggleBtn = page.locator('button:has(svg.lucide-eye), button:has(svg.lucide-eye-off)').first();
        if (!(await toggleBtn.isVisible())) throw new Error("Password visibility toggle button not found");
        // Nhấp vào nút con mắt để chuyển input type từ password sang text nhằm xem mật khẩu.
        await toggleBtn.click();
        await page.waitForTimeout(200);
        const inputType = await page.locator('input[value="Secret123!"]').getAttribute("type");
        if (inputType !== "text") throw new Error(`Expected input type 'text' after toggle, got '${inputType}'`);
        // Nhấp lại lần nữa để chuyển input type trở về password nhằm ẩn mật khẩu.
        await toggleBtn.click();
        await page.waitForTimeout(200);
      }
    );

    // 9. Validation on Empty Submit
    await collector.runTest(
      {
        id: "TC-LOGIN-03",
        screen: "S02 - Login Screen",
        element: "Sign In Form Submit Validation",
        action: "Submit empty form and verify error message or blocked submission",
        page,
      },
      async () => {
        const phoneInput = page.locator('input[type="tel"], input[name="phone"], input[placeholder*="09"], input[autocomplete="username"]').first();
        const passInput = page.locator('input[type="password"]').first();
        // Xóa trắng cả 2 trường để kiểm tra validation phía client ngăn chặn gửi form rỗng.
        await phoneInput.fill("");
        await passInput.fill("");
        const submitBtn = page.locator('button[type="submit"]:has-text("Sign in"), button[type="submit"]:has-text("Đăng nhập")').first();
        await submitBtn.click();
        await page.waitForTimeout(500);
        // Verify URL stayed at /login
        if (!page.url().includes("/login")) throw new Error("Form submitted without phone/password!");
      }
    );

    // 10. Invalid Credentials Error Handling
    await collector.runTest(
      {
        id: "TC-LOGIN-04",
        screen: "S02 - Login Screen",
        element: "Invalid Credentials Error Toast/Message",
        action: "Submit incorrect credentials and verify error notification",
        page,
      },
      async () => {
        const phoneInput = page.locator('input[type="tel"], input[name="phone"], input[placeholder*="09"], input[autocomplete="username"]').first();
        const passInput = page.locator('input[type="password"]').first();
        // Nhập thông tin tài khoản không tồn tại để kiểm tra thông báo lỗi hiển thị cho người dùng.
        await phoneInput.fill("0999999999");
        await passInput.fill("WrongPassword999!");
        const submitBtn = page.locator('button[type="submit"]:has-text("Sign in"), button[type="submit"]:has-text("Đăng nhập")').first();
        await submitBtn.click();
        await page.waitForTimeout(1000);
        
        // Chấp nhận thông báo lỗi qua thông điệp văn bản, toast thông báo Sonner hoặc thẻ lỗi inline.
        const hasError = await page.locator('text=/wrong|sai|không đúng|not right|failed|error/i').first().isVisible();
        const toastVisible = await page.locator('[data-sonner-toast]').first().isVisible();
        const inlineError = await page.locator('#login-error').first().isVisible();
        if (!hasError && !toastVisible && !inlineError) {
          throw new Error("No error message or toast shown for invalid credentials");
        }
      }
    );

    // 11. Links to /forgot and /register
    await collector.runTest(
      {
        id: "TC-LOGIN-05",
        screen: "S02 - Login Screen",
        element: "Forgot Password and Register Navigation Links",
        action: "Verify presence and targets of helper navigation links",
        page,
      },
      async () => {
        // Đảm bảo người dùng có đường dẫn chuyển đến trang quên mật khẩu và trang đăng ký tài khoản.
        const forgotLink = page.locator('a[href="/forgot"]').first();
        const registerLink = page.locator('a[href="/register"]').first();
        if (!(await forgotLink.isVisible())) throw new Error("Forgot password link not visible");
        if (!(await registerLink.isVisible())) throw new Error("Register link not visible");
      }
    );

    // 12. Quick Demo Login Button (Manager)
    await collector.runTest(
      {
        id: "TC-LOGIN-06",
        screen: "S02 - Login Screen",
        element: "Quick Demo Login Buttons",
        action: "Click demo manager login chip and verify redirect to /manager",
        page,
      },
      async () => {
        // Sử dụng chip đăng nhập nhanh dành cho môi trường demo để vào thẳng phân hệ Quản lý (/manager).
        const demoMgrBtn = page.locator('button:has-text("Manager"), button:has-text("Quản lý")').first();
        if (!(await demoMgrBtn.isVisible())) throw new Error("Demo login chip not visible on login screen");
        await demoMgrBtn.click();
        await page.waitForURL("**/manager", { timeout: 6000 });
        if (!page.url().includes("/manager")) throw new Error("Demo manager login failed to navigate to /manager");
      }
    );

    // Bước 4: Kiểm thử màn hình S03 - Đăng ký (/register) và kiểm tra xác thực dữ liệu đầu vào.
    // ==========================================
    // S03: REGISTER SCREEN (/register)
    // ==========================================
    console.log("\n--- Testing S03: Register Screen (/register) ---");
    await page.goto(`${BASE}/register`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // 13. Register Form Inputs
    await collector.runTest(
      {
        id: "TC-REG-01",
        screen: "S03 - Register Screen",
        element: "Registration Form Inputs",
        action: "Check inputs for Full Name, Phone, Password, Confirm Password",
        page,
      },
      async () => {
        // Kiểm tra sự hiện diện của các trường nhập thông tin bắt buộc: Họ tên, Số điện thoại, Mật khẩu.
        const nameInput = page.locator('input[autocomplete="name"]').first();
        const phoneInput = page.locator('input[inputmode="tel"], input[autocomplete="tel"]').first();
        const passInput = page.locator('input[type="password"]').first();
        if (!(await nameInput.isVisible())) throw new Error("Full name input not visible");
        if (!(await phoneInput.isVisible())) throw new Error("Phone input not visible");
        if (!(await passInput.isVisible())) throw new Error("Password input not visible");
      }
    );

    // 14. Password Mismatch Validation
    await collector.runTest(
      {
        id: "TC-REG-02",
        screen: "S03 - Register Screen",
        element: "Password Confirmation Validation",
        action: "Enter mismatched passwords and check submit is disabled or error display",
        page,
      },
      async () => {
        const nameInput = page.locator('input[autocomplete="name"]').first();
        const emailInput = page.locator('input[type="email"], input[autocomplete="email"]').first();
        const phoneInput = page.locator('input[inputmode="tel"], input[autocomplete="tel"]').first();
        const passInputs = page.locator('input[type="password"]');
        
        // Điền thông tin hợp lệ nhưng nhập mật khẩu xác nhận khác nhau để kiểm tra validation.
        await nameInput.fill("Test User");
        if (await emailInput.isVisible()) await emailInput.fill("test@example.com");
        await phoneInput.fill("0912345678");
        await passInputs.nth(0).fill("Password123!");
        // Nhập mật khẩu xác nhận không khớp để kiểm tra hệ thống có vô hiệu hóa nút submit hoặc hiển thị cảnh báo.
        if (await passInputs.count() > 1) {
          await passInputs.nth(1).fill("DifferentPassword456!");
          await page.waitForTimeout(300);
          const submitBtn = page.locator('button[type="submit"]').first();
          const isDisabled = await submitBtn.isDisabled();
          const mismatchHint = await page.locator('text=/match|trùng|không khớp/i').first().isVisible();
          if (!isDisabled && !mismatchHint) {
            throw new Error("Mismatched passwords allowed form submission without warning!");
          }
        }
      }
    );

    // Bước 5: Kiểm thử màn hình S04 - Quên mật khẩu (/forgot) và luồng gửi mã xác thực.
    // ==========================================
    // S04: FORGOT PASSWORD (/forgot)
    // ==========================================
    console.log("\n--- Testing S04: Forgot Password (/forgot) ---");
    await page.goto(`${BASE}/forgot`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // 15. Forgot Password Input & Submit
    await collector.runTest(
      {
        id: "TC-FORGOT-01",
        screen: "S04 - Forgot Password",
        element: "Phone Input and Request OTP Button",
        action: "Enter valid phone number and submit password reset request",
        page,
      },
      async () => {
        const phoneInput = page.locator('input[inputmode="tel"], input[autocomplete="tel"], input[placeholder*="09"]').first();
        if (!(await phoneInput.isVisible())) throw new Error("Phone input not visible on /forgot");
        // Nhập số điện thoại của hội viên mẫu (member) để gửi yêu cầu đặt lại mật khẩu.
        await phoneInput.fill("0901230107");
        const submitBtn = page.locator('button[type="submit"]').first();
        if (!(await submitBtn.isVisible())) throw new Error("Submit button not visible on /forgot");
        await submitBtn.click();
        
        // Wait for OTP step or demo code to render
        // Chờ tối đa 8s để trường nhập mã OTP xuất hiện, chứng minh đã chuyển bước thành công.
        const otpInput = page.locator('input[autocomplete="one-time-code"]').first();
        await otpInput.waitFor({ state: "visible", timeout: 8000 });
        const hasOtp = await otpInput.isVisible();
        if (!hasOtp) {
          throw new Error("Failed to transition to OTP reset step after phone submission");
        }
      }
    );
  } finally {
    // Bước 6: Đóng ngữ cảnh trình duyệt (BrowserContext) để dọn dẹp cookies, localStorage và giải phóng RAM.
    await context.close();
  }

  // Bước 7: Trả về kết quả tổng hợp của toàn bộ suite kiểm thử Public & Authentication.
  return collector.summary();
}
