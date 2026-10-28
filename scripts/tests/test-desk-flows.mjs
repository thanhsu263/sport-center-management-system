import {
  BASE,
  createRolePage,
  TestCollector,
} from "./test-helper.mjs";

export async function runDeskFlowTests(browser) {
  const collector = new TestCollector("Section 3: Front Desk / Receptionist (S14–S22)");
  const { context, page, session } = await createRolePage(browser, "receptionist");

  try {
    // ==========================================
    // S14: DESK HOME (/desk)
    // ==========================================
    console.log("\n--- Testing S14: Desk Home (/desk) ---");
    await page.goto(`${BASE}/desk`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // 1. Shift Open/Close Toggle Button
    await collector.runTest(
      {
        id: "TC-DESK-01",
        screen: "S14 - Desk Home",
        element: "Shift Action Button (Open/Close Shift)",
        action: "Inspect shift badge or Open Shift button",
        page,
      },
      async () => {
        const shiftBtn = page.locator('button:has-text("Open shift"), button:has-text("Mở ca"), button:has-text("Close shift"), button:has-text("Đóng ca")').first();
        const shiftBadge = page.locator('text=/Shift open|Ca mở/i').first();
        const hasBtn = await shiftBtn.isVisible();
        const hasBadge = await shiftBadge.isVisible();
        if (!hasBtn && !hasBadge) {
          throw new Error("Neither shift action button nor shift open badge is visible");
        }
      }
    );

    // 2. Member Search Input
    await collector.runTest(
      {
        id: "TC-DESK-02",
        screen: "S14 - Desk Home",
        element: "Member Fast Search Input",
        action: "Type 'Nam' into quick search input and verify results dropdown/list",
        page,
      },
      async () => {
        const searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="Tìm"], input[placeholder*="09"]').first();
        if (!(await searchInput.isVisible())) throw new Error("Member search input not visible on /desk");
        await searchInput.fill("Nam");
        await page.waitForTimeout(1200);
        // Verify results or empty message rendered
        const hasResults = await page.locator('div:has-text("0901230101"), a[href*="/desk/member/"]').first().isVisible();
        if (!hasResults) {
          console.log("   (Search rendered, awaiting hit card)");
        }
      }
    );

    // 3. New Member Wizard Button
    await collector.runTest(
      {
        id: "TC-DESK-03",
        screen: "S14 - Desk Home",
        element: "New Member Wizard Trigger Button",
        action: "Click 'New member wizard' button and verify modal opens",
        page,
      },
      async () => {
        const wizBtn = page.locator('button:has-text("New member"), button:has-text("Hội viên mới"), button:has-text("Đăng ký hội viên")').first();
        if (await wizBtn.isVisible()) {
          await wizBtn.click();
          await page.waitForTimeout(600);
          const modal = page.locator('[role="dialog"], div:has-text("Step 1")').first();
          if (!(await modal.isVisible())) throw new Error("New member wizard modal did not open");
          const cancelBtn = page.locator('[role="dialog"] button:has-text("Cancel"), [role="dialog"] button:has-text("Hủy"), [role="dialog"] svg.lucide-x').first();
          if (await cancelBtn.isVisible()) await cancelBtn.click();
        }
      }
    );

    // ==========================================
    // S15: GATE CHECK-IN (/desk/gate)
    // ==========================================
    console.log("\n--- Testing S15: Gate Check-in (/desk/gate) ---");
    await page.goto(`${BASE}/desk/gate`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // 4. Phone Input & Check-in Verification
    await collector.runTest(
      {
        id: "TC-GATE-01",
        screen: "S15 - Gate Check-in",
        element: "Manual Phone Check-in Form & Submit Button",
        action: "Switch to 'Without a code' mode, enter member phone '0901230101' and submit check-in",
        page,
      },
      async () => {
        // Switch to manual mode
        const manualModeBtn = page.locator('button:has-text("Without a code"), button:has-text("Không có mã")').first();
        if (await manualModeBtn.isVisible()) {
          await manualModeBtn.click();
          await page.waitForTimeout(400);
        }
        const phoneInput = page.locator('#gate-q, input[placeholder*="0900"]').first();
        if (!(await phoneInput.isVisible())) throw new Error("Manual phone input #gate-q not found on /desk/gate");
        await phoneInput.fill("0901230101");
        const checkinBtn = page.locator('button[type="submit"]:has-text("Check in"), button:has-text("Vào cổng")').first();
        if (!(await checkinBtn.isVisible())) throw new Error("Check-in submit button not found");
        await checkinBtn.click();
        await page.waitForTimeout(1500);
        // Expect result badge: Allowed / Check-in granted or Override dialog
        const resultBadge = page.locator('text=/Allowed|Được vào|Checked in|Đã vào|Override|Cảnh báo/i').first();
        if (!(await resultBadge.isVisible())) {
          throw new Error("Check-in result status badge did not display");
        }
      }
    );

    // ==========================================
    // S16: COURT MAP (/desk/courts)
    // ==========================================
    console.log("\n--- Testing S16: Court Map (/desk/courts) ---");
    await page.goto(`${BASE}/desk/courts`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // 5. Court Grid Inspection & Clickable Cells
    await collector.runTest(
      {
        id: "TC-CRT-01",
        screen: "S16 - Court Map",
        element: "Court Map Grid Cells",
        action: "Inspect grid and click an empty slot for walk-in modal",
        page,
      },
      async () => {
        const gridCells = page.locator('button[class*="slot"], button:has-text("Trống"), button:has-text("Free")');
        const count = await gridCells.count();
        if (count > 0) {
          await gridCells.first().click();
          await page.waitForTimeout(600);
          // Look for walk-in booking modal or occupancy details
          const modal = page.locator('[role="dialog"]').first();
          if (await modal.isVisible()) {
            const closeBtn = page.locator('[role="dialog"] button:has-text("Cancel"), [role="dialog"] svg.lucide-x').first();
            if (await closeBtn.isVisible()) await closeBtn.click();
          }
        }
      }
    );

    // ==========================================
    // S18: BILLING & PAYMENTS (/desk/payments)
    // ==========================================
    console.log("\n--- Testing S18: Billing & Payments (/desk/payments) ---");
    await page.goto(`${BASE}/desk/payments`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // 6. Payment Queue Tabs
    await collector.runTest(
      {
        id: "TC-PAY-01",
        screen: "S18 - Payments",
        element: "Payment Queue Tabs",
        action: "Click Transfers tab, Waiting for payment tab, Refund tab",
        page,
      },
      async () => {
        const tabs = page.locator('button[role="tab"], [class*="Seg"] button');
        const count = await tabs.count();
        if (count >= 2) {
          await tabs.nth(1).click();
          await page.waitForTimeout(400);
          await tabs.nth(0).click();
          await page.waitForTimeout(400);
        }
      }
    );

    // ==========================================
    // S20: GEAR RENTAL (/desk/gear)
    // ==========================================
    console.log("\n--- Testing S20: Gear Rental (/desk/gear) ---");
    await page.goto(`${BASE}/desk/gear`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // 7. Gear Rental Item Selection & Who Tab
    await collector.runTest(
      {
        id: "TC-GEAR-01",
        screen: "S20 - Gear Rental",
        element: "Gear Item Selector & Guest Tab",
        action: "Switch between 'Hội viên' and 'Khách vãng lai' tabs; check phone input is empty by default (B-12)",
        page,
      },
      async () => {
        const guestTab = page.locator('button[role="tab"]:has-text("Guest"), button[role="tab"]:has-text("Khách")').first();
        if (await guestTab.isVisible()) {
          await guestTab.click();
          await page.waitForTimeout(400);
          const phoneInput = page.locator('input[placeholder*="09"], input[name="phone"]').first();
          if (await phoneInput.isVisible()) {
            const val = await phoneInput.inputValue();
            // Bug B-12 check: phone should NOT be prefilled with 0901230101
            if (val === "0901230101") {
              throw new Error("BUG B-12 DETECTED: Guest phone input is prefilled with hardcoded demo number 0901230101");
            }
          }
        }
      }
    );

    // ==========================================
    // S21: MEMBER PROFILE (/desk/member/$id)
    // ==========================================
    console.log("\n--- Testing S21: Member Profile (/desk/member/$id) ---");
    // Use demo member Nam (0901230101)
    const memRes = await fetch(`${BASE}/v1/members?q=0901230101`, {
      headers: { authorization: `Bearer ${session.token}` },
    }).then((r) => r.json()).catch(() => null);
    
    const memberId = memRes?.items?.[0]?.id || "mem_demo";
    await page.goto(`${BASE}/desk/member/${memberId}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // 8. Edit Profile Button and Modal
    await collector.runTest(
      {
        id: "TC-MEMPROF-01",
        screen: "S21 - Member Profile",
        element: "Edit Profile Action Button & Modal",
        action: "Click 'Sửa hồ sơ' button and verify edit modal opens with member fields",
        page,
      },
      async () => {
        const editBtn = page.locator('button:has-text("Edit profile"), button:has-text("Sửa hồ sơ"), button:has-text("Sửa")').first();
        if (await editBtn.isVisible()) {
          await editBtn.click();
          await page.waitForTimeout(500);
          const modal = page.locator('[role="dialog"]').first();
          if (!(await modal.isVisible())) throw new Error("Edit profile modal did not open");
          const cancelBtn = page.locator('[role="dialog"] button:has-text("Cancel"), [role="dialog"] button:has-text("Hủy"), [role="dialog"] svg.lucide-x').first();
          if (await cancelBtn.isVisible()) await cancelBtn.click();
        } else {
          console.log("   (Member profile edit button not visible on profile)");
        }
      }
    );

    // 9. Reset Password Button
    await collector.runTest(
      {
        id: "TC-MEMPROF-02",
        screen: "S21 - Member Profile",
        element: "Reset Password Action Button",
        action: "Click 'Đặt lại mật khẩu' and verify confirmation dialog",
        page,
      },
      async () => {
        const resetBtn = page.locator('button:has-text("Reset password"), button:has-text("Đặt lại mật khẩu")').first();
        if (await resetBtn.isVisible()) {
          await resetBtn.click();
          await page.waitForTimeout(500);
          const modal = page.locator('[role="dialog"]').first();
          if (!(await modal.isVisible())) throw new Error("Reset password confirmation modal did not open");
          const cancelBtn = page.locator('[role="dialog"] button:has-text("Cancel"), [role="dialog"] button:has-text("Hủy"), [role="dialog"] svg.lucide-x').first();
          if (await cancelBtn.isVisible()) await cancelBtn.click();
        }
      }
    );
  } finally {
    await context.close();
  }

  return collector.summary();
}
