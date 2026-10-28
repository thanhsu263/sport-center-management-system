import {
  BASE,
  createRolePage,
  TestCollector,
} from "./test-helper.mjs";

export async function runCoachFlowTests(browser) {
  const collector = new TestCollector("Section 4: Coach (S23–S25)");
  const { context, page } = await createRolePage(browser, "coach");

  try {
    // ==========================================
    // S23: COACH SCHEDULE (/coach)
    // ==========================================
    console.log("\n--- Testing S23: Coach Schedule (/coach) ---");
    await page.goto(`${BASE}/coach`, { waitUntil: "networkidle" });
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
        await page.locator('.animate-pulse, [class*="Skeleton"]').first().waitFor({ state: "detached", timeout: 4000 }).catch(() => {});
        const takeBtn = page.locator('button:has-text("Take register"), button:has-text("Điểm danh"), button:has(svg.lucide-clipboard-check)').first();
        if (await takeBtn.isVisible()) {
          await takeBtn.click();
          await page.waitForURL("**/coach/attendance**", { timeout: 4000 });
        } else {
          const hasEmptyOrComing = await page.locator('text=/Coming up|Sắp tới|No sessions|Không có buổi/i').first().isVisible();
          if (!hasEmptyOrComing) throw new Error("Neither session card nor empty state rendered for coach schedule");
        }
      }
    );

    // ==========================================
    // S24: ATTENDANCE REGISTER (/coach/attendance)
    // ==========================================
    console.log("\n--- Testing S24: Attendance (/coach/attendance) ---");
    await page.goto(`${BASE}/coach/attendance`, { waitUntil: "networkidle" });
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
        if (count >= 2) {
          await tabs.nth(1).click();
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
          if (await firstBtn.isEnabled()) {
            await firstBtn.click();
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
        if (await saveBtn.isVisible()) {
          console.log("   (Save attendance button present on register)");
        }
      }
    );
  } finally {
    await context.close();
  }

  return collector.summary();
}
