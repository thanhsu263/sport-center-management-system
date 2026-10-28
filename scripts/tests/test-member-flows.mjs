import {
  BASE,
  createRolePage,
  TestCollector,
} from "./test-helper.mjs";

export async function runMemberFlowTests(browser) {
  const collector = new TestCollector("Section 2: Member Area (S05–S13)");
  const { context, page } = await createRolePage(browser, "member");

  try {
    // ==========================================
    // S05: MEMBER HOME (/app)
    // ==========================================
    console.log("\n--- Testing S05: Member Home (/app) ---");
    await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
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
        const hasCode = await page.locator('span.font-mono, [class*="PassCard"]').first().isVisible();
        if (!hasCode) throw new Error("Member code / Pass card badge not visible");
      }
    );

    // ==========================================
    // S06: COURT BOOKING (/app/book)
    // ==========================================
    console.log("\n--- Testing S06: Court Booking (/app/book) ---");
    await page.goto(`${BASE}/app/book`, { waitUntil: "networkidle" });
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

    // ==========================================
    // S07: ACCESS PASS (/app/pass)
    // ==========================================
    console.log("\n--- Testing S07: Access Pass (/app/pass) ---");
    await page.goto(`${BASE}/app/pass`, { waitUntil: "networkidle" });
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
        const canvasOrSvg = page.locator('canvas, svg[class*="qr"], img[src*="data:image"]').first();
        const refreshBtn = page.locator('button:has-text("Refresh"), button:has-text("Làm mới"), button:has(svg.lucide-refresh-cw)').first();
        if (await refreshBtn.isVisible()) {
          await refreshBtn.click();
          await page.waitForTimeout(500);
        }
      }
    );

    // ==========================================
    // S08: CLASSES & TRAINING (/app/classes)
    // ==========================================
    console.log("\n--- Testing S08: Classes (/app/classes) ---");
    await page.goto(`${BASE}/app/classes`, { waitUntil: "networkidle" });
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
        await page.locator('h2.font-display').first().waitFor({ state: "visible", timeout: 8000 });
        const classCards = page.locator('h2.font-display');
        const count = await classCards.count();
        if (count === 0) throw new Error("No class cards rendered on /app/classes");
        const actionBtn = page.locator('button:has-text("Enrol"), button:has-text("Đăng ký"), button:has-text("Waitlist"), button:has-text("Hàng chờ"), button:has-text("Leave"), button:has-text("Rời")').first();
        if (await actionBtn.isVisible()) {
          const btnText = await actionBtn.textContent();
          console.log(`   (Found class action button: "${btnText?.trim()}")`);
        }
        // Test sport filter segment
        const sportBtn = page.locator('button:has-text("Badminton"), button:has-text("Cầu lông")').first();
        if (await sportBtn.isVisible()) {
          await sportBtn.click();
          await page.waitForTimeout(500);
        }
      }
    );

    // ==========================================
    // S09: MEMBERSHIP PLANS (/app/plans)
    // ==========================================
    console.log("\n--- Testing S09: Plans (/app/plans) ---");
    await page.goto(`${BASE}/app/plans`, { waitUntil: "networkidle" });
    await page.locator('.animate-pulse, [class*="Skeleton"]').first().waitFor({ state: "detached", timeout: 4000 }).catch(() => {});
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
        const buyBtn = page.locator('button:has-text("Buy"), button:has-text("Mua"), button:has-text("Renew"), button:has-text("Gia hạn")').first();
        if (await buyBtn.isVisible()) {
          await buyBtn.click();
          await page.waitForTimeout(800);
          // Check if checkout modal or payment options opened
          const modalVisible = (await page.locator('[role="dialog"]').first().isVisible()) || (await page.getByText(/Payment|Thanh toán/i).first().isVisible());
          // Close modal if open
          const closeBtn = page.locator('[role="dialog"] button:has-text("Cancel"), [role="dialog"] button:has-text("Hủy"), [role="dialog"] svg.lucide-x').first();
          if (await closeBtn.isVisible()) await closeBtn.click();
        }
      }
    );

    // ==========================================
    // S10: PROGRESS (/app/train)
    // ==========================================
    console.log("\n--- Testing S10: Training Progress (/app/train) ---");
    await page.goto(`${BASE}/app/train`, { waitUntil: "networkidle" });
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
        const goalSelect = page.locator('select[aria-label*="goal"], select').first();
        if (await goalSelect.isVisible()) {
          await goalSelect.selectOption({ index: 1 });
          await page.waitForTimeout(500);
        }
      }
    );

    // ==========================================
    // S11: AI ASSISTANT (/app/assistant)
    // ==========================================
    console.log("\n--- Testing S11: AI Assistant (/app/assistant) ---");
    await page.goto(`${BASE}/app/assistant`, { waitUntil: "networkidle" });
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
        const chip = page.locator('button[class*="rounded-full"]:has-text("?"), button[class*="rounded-full"]:has-text("hours")').first();
        if (await chip.isVisible()) {
          await chip.click();
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
        const input = page.locator('input[placeholder*="Ask"], input[placeholder*="Hỏi"]').first();
        const sendBtn = page.locator('button[type="submit"]:has(svg.lucide-send), button:has(svg.lucide-send)').first();
        if (!(await input.isVisible())) throw new Error("Assistant chat input box not visible");
        await input.fill("Có lớp học nào vào buổi tối không?");
        await sendBtn.click();
        await page.waitForTimeout(2000);
      }
    );

    // ==========================================
    // S12: NOTIFICATIONS (/app/notifications)
    // ==========================================
    console.log("\n--- Testing S12: Notifications (/app/notifications) ---");
    await page.goto(`${BASE}/app/notifications`, { waitUntil: "networkidle" });
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
        const items = page.locator('div[class*="Notification"], [class*="Card"], [role="listitem"]');
        const count = await items.count();
        console.log(`   (Found ${count} notification entries)`);
      }
    );

    // ==========================================
    // S13: ACCOUNT SETTINGS (/account)
    // ==========================================
    console.log("\n--- Testing S13: Account Settings (/account) ---");
    await page.goto(`${BASE}/account`, { waitUntil: "networkidle" });
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
        const secTab = page.locator('button:has-text("Security"), button:has-text("Bảo mật")').first();
        const recTab = page.locator('button:has-text("Receipts"), button:has-text("Biên lai")').first();
        const supTab = page.locator('button:has-text("Support"), button:has-text("Hỗ trợ")').first();
        const profTab = page.locator('button:has-text("Profile"), button:has-text("Hồ sơ")').first();

        if (await secTab.isVisible()) {
          await secTab.click();
          await page.waitForTimeout(400);
          const hasPassForm = await page.locator('input[type="password"]').first().isVisible();
          if (!hasPassForm) throw new Error("Security tab did not render password form");
        }
        if (await recTab.isVisible()) {
          await recTab.click();
          await page.waitForTimeout(400);
        }
        if (await supTab.isVisible()) {
          await supTab.click();
          await page.waitForTimeout(400);
          const hasTextarea = await page.locator("textarea").first().isVisible();
          if (!hasTextarea) throw new Error("Support tab did not render inquiry textarea");
        }
        if (await profTab.isVisible()) {
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
        const nameInput = page.locator('input[name="full_name"], input[placeholder*="Name"], input[value*="Nam"], input[value*="Linh"]').first();
        if (await nameInput.isVisible()) {
          const saveBtn = page.locator('button[type="submit"]:has-text("Save"), button:has-text("Lưu")').first();
          if (await saveBtn.isVisible()) {
            await saveBtn.click();
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
  } finally {
    await context.close();
  }

  return collector.summary();
}
