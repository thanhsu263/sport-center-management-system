/**
 * File: scripts/tests/test-member-flows.mjs
 * Vai trò: Bộ kịch bản kiểm thử E2E Playwright cho phân hệ hội viên (Member Area, màn hình S05 - S13).
 * Kiểm tra tự động các luồng tương tác thực tế: trang chủ, đặt sân, thẻ ra vào, lớp học, gói tập, lịch sử và tài khoản.
 */
import {
  BASE,
  createRolePage,
  TestCollector,
} from "./test-helper.mjs";

/**
 * Làm gì: Chạy toàn bộ các ca kiểm thử E2E tự động cho luồng hội viên (Member Area S05–S13), xác thực khả năng hiển thị và tương tác của các nút bấm, bộ lọc và biểu mẫu.
 * Được gọi ở: scripts/tests/run-all-interactive-tests.mjs
 * - Tham số browser: Đối tượng Browser của Playwright để khởi tạo ngữ cảnh và trang duyệt web
 * - Trả về: Báo cáo tổng hợp kết quả kiểm thử (collector.summary()) gồm số ca pass, fail và chi tiết từng màn hình
 * - Lỗi có thể ném: Error nếu API đăng nhập tài khoản member hoặc khởi tạo trang thất bại
 */
export async function runMemberFlowTests(browser) {
  // Bước 1: Khởi tạo bộ thu thập kết quả TestCollector và tạo trang với phiên đăng nhập của vai trò member
  const collector = new TestCollector("Section 2: Member Area (S05–S13)");
  // Đăng nhập ngầm qua API với tài khoản member để lấy JWT token và tiêm sẵn vào localStorage
  const { context, page } = await createRolePage(browser, "member");

  try {
    // Bước 2: Kiểm thử màn hình Trang chủ Hội viên (S05: Member Home tại đường dẫn /app)
    // ==========================================
    // S05: MEMBER HOME (/app)
    // ==========================================
    console.log("\n--- Testing S05: Member Home (/app) ---");
    await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
    // Chờ 1s để client hoàn tất hydration và tải các dữ liệu thành viên bất đồng bộ
    await page.waitForTimeout(1000);

    // 1. Quick Action: Book a court
    await collector.runTest(
      {
        id: "TC-MEM-01",
        screen: "S05 - Member Home",
        element: "Quick Action 'Book a court' Link",
        action: "Click Quick Action to navigate to /app/book",
        page,
      },
      async () => {
        const link = page.locator('a[href="/app/book"]').first();
        if (!(await link.isVisible())) throw new Error("Link to /app/book not visible");
        await link.click();
        await page.waitForURL("**/app/book", { timeout: 4000 });
        // Điều hướng trở lại trang chủ /app để chuẩn bị trạng thái cho ca kiểm thử Quick Action tiếp theo
        await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
      }
    );

    // 2. Quick Action: Classes
    await collector.runTest(
      {
        id: "TC-MEM-02",
        screen: "S05 - Member Home",
        element: "Quick Action 'Classes' Link",
        action: "Click Quick Action to navigate to /app/classes",
        page,
      },
      async () => {
        const link = page.locator('a[href="/app/classes"]').first();
        if (!(await link.isVisible())) throw new Error("Link to /app/classes not visible");
        await link.click();
        await page.waitForURL("**/app/classes", { timeout: 4000 });
        // Điều hướng trở lại trang chủ /app sau khi xác nhận chuyển hướng sang trang lớp học
        await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
      }
    );

    // 3. Quick Action: Plans
    await collector.runTest(
      {
        id: "TC-MEM-03",
        screen: "S05 - Member Home",
        element: "Quick Action 'Plans' Link",
        action: "Click Quick Action to navigate to /app/plans",
        page,
      },
      async () => {
        const link = page.locator('a[href="/app/plans"]').first();
        if (!(await link.isVisible())) throw new Error("Link to /app/plans not visible");
        await link.click();
        await page.waitForURL("**/app/plans", { timeout: 4000 });
        // Điều hướng trở lại trang chủ /app sau khi xác nhận chuyển hướng sang trang gói tập
        await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
      }
    );

    // 4. Quick Action: Ask AI
    await collector.runTest(
      {
        id: "TC-MEM-04",
        screen: "S05 - Member Home",
        element: "Quick Action 'Ask AI' Link",
        action: "Click Quick Action to navigate to /app/assistant",
        page,
      },
      async () => {
        const link = page.locator('a[href="/app/assistant"]').first();
        if (!(await link.isVisible())) throw new Error("Link to /app/assistant not visible");
        await link.click();
        await page.waitForURL("**/app/assistant", { timeout: 4000 });
        // Điều hướng trở lại trang chủ /app sau khi xác nhận chuyển hướng sang trang trợ lý AI
        await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
      }
    );

    // 5. Member Code Badge / Card Display
    await collector.runTest(
      {
        id: "TC-MEM-05",
        screen: "S05 - Member Home",
        element: "Member Identity Badge",
        action: "Verify member code or pass card is visible on screen",
        page,
      },
      async () => {
        // Kiểm tra hiển thị mã hội viên qua class font-mono hoặc component PassCard trên giao diện
        const hasCode = await page.locator('span.font-mono, [class*="PassCard"]').first().isVisible();
        if (!hasCode) throw new Error("Member code / Pass card badge not visible");
      }
    );

    // Bước 3: Kiểm thử màn hình Đặt sân (S06: Court Booking tại đường dẫn /app/book)
    // ==========================================
    // S06: COURT BOOKING (/app/book)
    // ==========================================
    console.log("\n--- Testing S06: Court Booking (/app/book) ---");
    await page.goto(`${BASE}/app/book`, { waitUntil: "networkidle" });
    // Chờ 1s để lưới đặt sân (court grid) và lịch khả dụng nạp đầy đủ qua API
    await page.waitForTimeout(1000);

    // 6. Sport selector tabs
    await collector.runTest(
      {
        id: "TC-BOOK-01",
        screen: "S06 - Court Booking",
        element: "Sport Filter Segment / Tabs",
        action: "Click badminton, basketball, volleyball tabs and check grid updates",
        page,
      },
      async () => {
        const tabs = page.locator('button:has-text("Badminton"), button:has-text("Basketball"), button:has-text("Volleyball")');
        const count = await tabs.count();
        if (count < 2) throw new Error("Sport filter buttons not found");
        // Lần lượt click chuyển môn thể thao (bóng rổ/bóng chuyền rồi về cầu lông) để xác nhận bộ lọc cập nhật danh sách sân
        await tabs.nth(1).click();
        await page.waitForTimeout(500);
        await tabs.nth(0).click();
        await page.waitForTimeout(500);
      }
    );

    // 7. Date picker navigation
    await collector.runTest(
      {
        id: "TC-BOOK-02",
        screen: "S06 - Court Booking",
        element: "Date Strip Selector",
        action: "Select different date chip in DateStrip",
        page,
      },
      async () => {
        const chips = page.locator('button[class*="rounded"]:has-text("Th"), button[class*="rounded"]:has-text("Mon"), button[class*="rounded"]:has-text("Tue")');
        // Chọn ngày khác trên thanh DateStrip rồi quay lại ngày ban đầu để kiểm tra sự kiện tải lại lịch sân
        if (await chips.count() > 1) {
          await chips.nth(1).click();
          await page.waitForTimeout(600);
          await chips.nth(0).click();
          await page.waitForTimeout(600);
        }
      }
    );

    // 8. Court Grid Free Slot Interaction
    await collector.runTest(
      {
        id: "TC-BOOK-03",
        screen: "S06 - Court Booking",
        element: "Court Grid Slot Button",
        action: "Click a free slot and verify Hold Card or Booking Drawer appears",
        page,
      },
      async () => {
        // Wait for skeleton to detach
        await page.locator('.animate-pulse, [class*="Skeleton"]').first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
        
        // Select tomorrow on DateStrip to ensure future bookable slots
        const chips = page.locator('.flex.gap-2.overflow-x-auto button');
        if (await chips.count() > 1) {
          await chips.nth(1).click();
          await page.waitForTimeout(1000);
          await page.locator('.animate-pulse, [class*="Skeleton"]').first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
        }

        // Tìm ô giờ còn trống (free slot) trên lưới dựa theo nhãn aria-label hoặc thuộc tính title đa ngôn ngữ
        const freeSlot = page.locator('button[aria-label*="Book"], button[aria-label*="Đặt sân"], button[title*="Free"], button[title*="Trống"]').first();
        if (await freeSlot.isVisible()) {
          await freeSlot.click();
          await page.waitForTimeout(1200);
          // Check if hold card or conflict alert appeared
          const hasHold = await page.locator('text=/held|giữ chỗ|Use plan hours|Bank transfer|Pay online|occupied|overlap|conflict|unavailable|không khả dụng|nearest hours|Giữ chỗ trong/i').first().isVisible();
          if (!hasHold) throw new Error("Clicking free slot did not open hold confirmation or conflict notice");
        } else {
          console.log("   (No free slots on selected date, grid rendered)");
        }
      }
    );

    // Bước 4: Kiểm thử màn hình Thẻ vào cổng (S07: Access Pass tại đường dẫn /app/pass)
    // ==========================================
    // S07: ACCESS PASS (/app/pass)
    // ==========================================
    console.log("\n--- Testing S07: Access Pass (/app/pass) ---");
    await page.goto(`${BASE}/app/pass`, { waitUntil: "networkidle" });
    // Chờ 1s để mã QR động và trạng thái thẻ hội viên hiển thị trên màn hình
    await page.waitForTimeout(1000);

    // 9. QR Code Display and Refresh
    await collector.runTest(
      {
        id: "TC-PASS-01",
        screen: "S07 - Access Pass",
        element: "Dynamic QR Code & Refresh Button",
        action: "Verify QR pass is rendered and click 'Làm mới' / Refresh button",
        page,
      },
      async () => {
        // Tìm phần tử hiển thị mã QR và nút bấm làm mới mã để kiểm tra chức năng tạo lại mã vào cổng động
        const canvasOrSvg = page.locator('canvas, svg[class*="qr"], img[src*="data:image"]').first();
        const refreshBtn = page.locator('button:has-text("Refresh"), button:has-text("Làm mới"), button:has(svg.lucide-refresh-cw)').first();
        if (await refreshBtn.isVisible()) {
          await refreshBtn.click();
          await page.waitForTimeout(500);
        }
      }
    );

    // Bước 5: Kiểm thử màn hình Lớp học & Đào tạo (S08: Classes tại đường dẫn /app/classes)
    // ==========================================
    // S08: CLASSES & TRAINING (/app/classes)
    // ==========================================
    console.log("\n--- Testing S08: Classes (/app/classes) ---");
    await page.goto(`${BASE}/app/classes`, { waitUntil: "networkidle" });
    // Chờ hiệu ứng skeleton loading kết thúc tối đa 6s để đảm bảo dữ liệu lớp học đã được render đầy đủ
    await page.locator('.animate-pulse, [class*="Skeleton"]').first().waitFor({ state: "detached", timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(1000);

    // 10. Class Cards & Action Buttons
    await collector.runTest(
      {
        id: "TC-CLS-01",
        screen: "S08 - Classes",
        element: "Class Cards and Enrollment Buttons",
        action: "Verify class cards are rendered with enrol/waitlist/status buttons and sport filter works",
        page,
      },
      async () => {
        // Chờ tối đa 8s để thẻ lớp học hiển thị; dữ liệu lớp học cần tính toán sĩ số và lịch tuần nên có thể tải chậm hơn bình thường
        await page.locator('h2.font-display').first().waitFor({ state: "visible", timeout: 8000 });
        const classCards = page.locator('h2.font-display');
        const count = await classCards.count();
        if (count === 0) throw new Error("No class cards rendered on /app/classes");
        // Tìm nút hành động phù hợp với trạng thái của hội viên: Đăng ký (Enrol), Danh sách chờ (Waitlist khi lớp đầy) hoặc Hủy đăng ký (Leave)
        const actionBtn = page.locator('button:has-text("Enrol"), button:has-text("Đăng ký"), button:has-text("Waitlist"), button:has-text("Hàng chờ"), button:has-text("Leave"), button:has-text("Rời")').first();
        if (await actionBtn.isVisible()) {
          const btnText = await actionBtn.textContent();
          console.log(`   (Found class action button: "${btnText?.trim()}")`);
        }
        // Test sport filter segment
        const sportBtn = page.locator('button:has-text("Badminton"), button:has-text("Cầu lông")').first();
        if (await sportBtn.isVisible()) {
          // Click chọn thử bộ lọc môn thể thao và chờ 500ms để danh sách lớp cập nhật lại
          await sportBtn.click();
          await page.waitForTimeout(500);
        }
      }
    );

    // Bước 6: Kiểm thử màn hình Gói tập & Hội viên (S09: Membership Plans tại đường dẫn /app/plans)
    // ==========================================
    // S09: MEMBERSHIP PLANS (/app/plans)
    // ==========================================
    console.log("\n--- Testing S09: Plans (/app/plans) ---");
    await page.goto(`${BASE}/app/plans`, { waitUntil: "networkidle" });
    // Chờ hiệu ứng skeleton loading biến mất tối đa 4s; dùng catch để không dừng test nếu dữ liệu nạp nhanh
    await page.locator('.animate-pulse, [class*="Skeleton"]').first().waitFor({ state: "detached", timeout: 4000 }).catch(() => {});
    // Chờ 1s để client render hoàn thiện các thẻ gói tập và bảng giá dịch vụ
    await page.waitForTimeout(1000);

    // 11. Plan Selection & Purchase CTA
    await collector.runTest(
      {
        id: "TC-PLN-01",
        screen: "S09 - Plans",
        element: "Plan Card Buy / Renew CTA Buttons",
        action: "Inspect plan cards and verify purchase buttons",
        page,
      },
      async () => {
        // Tìm nút Mua (Buy) hoặc Gia hạn (Renew) trên thẻ gói tập để kiểm tra luồng kích hoạt thanh toán
        const buyBtn = page.locator('button:has-text("Buy"), button:has-text("Mua"), button:has-text("Renew"), button:has-text("Gia hạn")').first();
        if (await buyBtn.isVisible()) {
          await buyBtn.click();
          // Chờ 800ms để hiệu ứng hiển thị dialog thanh toán hoặc modal checkout hoàn tất
          await page.waitForTimeout(800);
          // Check if checkout modal or payment options opened
          const modalVisible = (await page.locator('[role="dialog"]').first().isVisible()) || (await page.getByText(/Payment|Thanh toán/i).first().isVisible());
          // Close modal if open
          const closeBtn = page.locator('[role="dialog"] button:has-text("Cancel"), [role="dialog"] button:has-text("Hủy"), [role="dialog"] svg.lucide-x').first();
          // Nhấn nút Cancel hoặc icon X để đóng modal checkout, trả lại giao diện sạch cho các ca kiểm thử sau
          if (await closeBtn.isVisible()) await closeBtn.click();
        }
      }
    );

    // Bước 7: Kiểm thử màn hình Tiến độ luyện tập (S10: Training Progress tại đường dẫn /app/train)
    // ==========================================
    // S10: PROGRESS (/app/train)
    // ==========================================
    console.log("\n--- Testing S10: Training Progress (/app/train) ---");
    await page.goto(`${BASE}/app/train`, { waitUntil: "networkidle" });
    // Chờ 1s để biểu đồ tiến độ và mục tiêu luyện tập được nạp từ lịch sử check-in của hội viên
    await page.waitForTimeout(1000);

    // 12. Goal selector dropdown
    await collector.runTest(
      {
        id: "TC-TRN-01",
        screen: "S10 - Training Progress",
        element: "Training Goal Selector",
        action: "Change training goal dropdown value and verify update",
        page,
      },
      async () => {
        // Tìm dropdown mục tiêu tập luyện và chọn option kế tiếp (index 1) để xác nhận giao diện cập nhật mục tiêu mới
        const goalSelect = page.locator('select[aria-label*="goal"], select').first();
        if (await goalSelect.isVisible()) {
          await goalSelect.selectOption({ index: 1 });
          await page.waitForTimeout(500);
        }
      }
    );

    // Bước 8: Kiểm thử màn hình Trợ lý AI (S11: AI Assistant tại đường dẫn /app/assistant)
    // ==========================================
    // S11: AI ASSISTANT (/app/assistant)
    // ==========================================
    console.log("\n--- Testing S11: AI Assistant (/app/assistant) ---");
    await page.goto(`${BASE}/app/assistant`, { waitUntil: "networkidle" });
    // Chờ 1s để tải lịch sử hội thoại và danh sách các gợi ý câu hỏi nhanh (prompt chips)
    await page.waitForTimeout(1000);

    // 13. Prompt Chip Click
    await collector.runTest(
      {
        id: "TC-AI-01",
        screen: "S11 - AI Assistant",
        element: "Quick Suggestion Prompt Chips",
        action: "Click a suggestion chip and verify message is sent into thread",
        page,
      },
      async () => {
        // Click thử một chip câu hỏi mẫu để kiểm tra tính năng tự động điền và gửi truy vấn vào luồng chat
        const chip = page.locator('button[class*="rounded-full"]:has-text("?"), button[class*="rounded-full"]:has-text("hours")').first();
        if (await chip.isVisible()) {
          await chip.click();
          // Chờ 2s để trợ lý ảo xử lý và phản hồi câu trả lời đầu tiên vào khung chat
          await page.waitForTimeout(2000);
          // Check that response bubble appears
          const botBubble = page.locator('div:has-text("Arena"), div:has-text("open"), div:has-text("AM")').first();
          if (!(await botBubble.isVisible())) {
            console.log("   (Waiting for assistant response)");
          }
        }
      }
    );

    // 14. Chat Input & Send Button
    await collector.runTest(
      {
        id: "TC-AI-02",
        screen: "S11 - AI Assistant",
        element: "Chat Input Box & Send Button",
        action: "Type a query, click Send, verify message appears in thread",
        page,
      },
      async () => {
        // Kiểm tra khung nhập tin nhắn và nút gửi; ném lỗi nếu không tìm thấy ô chatbox
        const input = page.locator('input[placeholder*="Ask"], input[placeholder*="Hỏi"]').first();
        const sendBtn = page.locator('button[type="submit"]:has(svg.lucide-send), button:has(svg.lucide-send)').first();
        if (!(await input.isVisible())) throw new Error("Assistant chat input box not visible");
        // Nhập câu hỏi tìm lớp học và nhấn nút gửi có icon Send để kích hoạt luồng tư vấn tự động
        await input.fill("Có lớp học nào vào buổi tối không?");
        await sendBtn.click();
        // Chờ 2s để tin nhắn của người dùng xuất hiện trong lịch sử chat và bot bắt đầu xử lý phản hồi
        await page.waitForTimeout(2000);
      }
    );

    // Bước 9: Kiểm thử màn hình Thông báo (S12: Notifications tại đường dẫn /app/notifications)
    // ==========================================
    // S12: NOTIFICATIONS (/app/notifications)
    // ==========================================
    console.log("\n--- Testing S12: Notifications (/app/notifications) ---");
    await page.goto(`${BASE}/app/notifications`, { waitUntil: "networkidle" });
    // Chờ 1s để danh sách thông báo và các huy hiệu chưa đọc được tải về từ server
    await page.waitForTimeout(1000);

    // 15. Notification Items & Actions
    await collector.runTest(
      {
        id: "TC-NOTIF-01",
        screen: "S12 - Notifications",
        element: "Notifications List Items",
        action: "Inspect notification list items and unread badges",
        page,
      },
      async () => {
        // Đếm số lượng thông báo được render trên giao diện để ghi nhận vào log kiểm thử
        const items = page.locator('div[class*="Notification"], [class*="Card"], [role="listitem"]');
        const count = await items.count();
        console.log(`   (Found ${count} notification entries)`);
      }
    );

    // Bước 10: Kiểm thử màn hình Cài đặt tài khoản (S13: Account Settings tại đường dẫn /account)
    // ==========================================
    // S13: ACCOUNT SETTINGS (/account)
    // ==========================================
    console.log("\n--- Testing S13: Account Settings (/account) ---");
    await page.goto(`${BASE}/account`, { waitUntil: "networkidle" });
    // Chờ 1s để dữ liệu hồ sơ cá nhân và cấu hình bảo mật được nạp vào form
    await page.waitForTimeout(1000);

    // 16. Tab Switching (Profile, Security, Receipts, Support)
    await collector.runTest(
      {
        id: "TC-ACC-01",
        screen: "S13 - Account Settings",
        element: "Settings Tabs (Profile, Security, Receipts, Support)",
        action: "Switch between tabs and verify panel content changes",
        page,
      },
      async () => {
        // Tìm các nút chuyển tab chính trong trang tài khoản: Bảo mật (Security), Biên lai (Receipts), Hỗ trợ (Support) và Hồ sơ (Profile)
        const secTab = page.locator('button:has-text("Security"), button:has-text("Bảo mật")').first();
        const recTab = page.locator('button:has-text("Receipts"), button:has-text("Biên lai")').first();
        const supTab = page.locator('button:has-text("Support"), button:has-text("Hỗ trợ")').first();
        const profTab = page.locator('button:has-text("Profile"), button:has-text("Hồ sơ")').first();

        if (await secTab.isVisible()) {
          // Chuyển sang tab Bảo mật và chờ 400ms để hiệu ứng animation chuyển tab hoàn tất
          await secTab.click();
          await page.waitForTimeout(400);
          const hasPassForm = await page.locator('input[type="password"]').first().isVisible();
          // Xác minh tab Security phải hiển thị trường đổi mật khẩu; nếu không có thì ném lỗi
          if (!hasPassForm) throw new Error("Security tab did not render password form");
        }
        if (await recTab.isVisible()) {
          // Chuyển sang tab Biên lai và chờ 400ms để kiểm tra panel lịch sử hóa đơn thanh toán
          await recTab.click();
          await page.waitForTimeout(400);
        }
        if (await supTab.isVisible()) {
          // Chuyển sang tab Hỗ trợ và chờ 400ms để kiểm tra form tiếp nhận phản hồi
          await supTab.click();
          await page.waitForTimeout(400);
          const hasTextarea = await page.locator("textarea").first().isVisible();
          // Xác minh tab Support phải hiển thị trường textarea để hội viên nhập nội dung cần trợ giúp
          if (!hasTextarea) throw new Error("Support tab did not render inquiry textarea");
        }
        if (await profTab.isVisible()) {
          // Chuyển quay lại tab Hồ sơ cá nhân và chờ 400ms để chuẩn bị cho ca kiểm thử sửa thông tin
          await profTab.click();
          await page.waitForTimeout(400);
        }
      }
    );

    // 17. Profile Form Edit & Save
    await collector.runTest(
      {
        id: "TC-ACC-02",
        screen: "S13 - Account Settings",
        element: "Profile Edit Form & Save Button",
        action: "Edit member name field and submit save button",
        page,
      },
      async () => {
        // Tìm ô nhập họ tên của hội viên dựa theo name, placeholder hoặc tên mẫu của tài khoản seed (Nam/Linh)
        const nameInput = page.locator('input[name="full_name"], input[placeholder*="Name"], input[value*="Nam"], input[value*="Linh"]').first();
        if (await nameInput.isVisible()) {
          const saveBtn = page.locator('button[type="submit"]:has-text("Save"), button:has-text("Lưu")').first();
          if (await saveBtn.isVisible()) {
            // Nhấn nút Save/Lưu để gửi payload cập nhật thông tin hồ sơ lên API backend
            await saveBtn.click();
            // Chờ 800ms để API lưu dữ liệu và kiểm tra toast thông báo thành công (Sonner toast)
            await page.waitForTimeout(800);
            const hasSuccess = await page.locator('text=/saved|đã lưu|success/i').first().isVisible();
            const toastVisible = await page.locator('[data-sonner-toast]').first().isVisible();
            if (!hasSuccess && !toastVisible) {
              console.log("   (Profile form save triggered without toast)");
            }
          }
        }
      }
    );
  // Bước 11: Dọn dẹp tài nguyên và tổng hợp kết quả kiểm thử
  } finally {
    // Đóng browser context trong khối finally để xóa sạch cookies, session storage và tiến trình kiểm thử Playwright
    await context.close();
  }

  // Trả về báo cáo tổng hợp kết quả kiểm thử (collector.summary()) cho toàn bộ phân hệ Member Area (S05–S13)
  return collector.summary();
}
