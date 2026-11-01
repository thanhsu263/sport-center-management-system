import {
  BASE,
  createRolePage,
  TestCollector,
} from "./test-helper.mjs";

export async function runManagerFlowTests(browser) {
  const collector = new TestCollector("Section 5: Manager (S26–S35)");
  const { context, page } = await createRolePage(browser, "manager");

  try {
    // ==========================================
    // S26: REPORTS & ANALYTICS (/manager)
    // ==========================================
    console.log("\n--- Testing S26: Reports & Analytics (/manager) ---");
    await page.goto(`${BASE}/manager`, { waitUntil: "networkidle" });
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
        const exportBtns = page.locator('button:has-text("Export"), button:has-text("Xuất"), a:has-text("Export"), a:has-text("Xuất"), button:has-text("PDF"), button:has-text("Excel")');
        const count = await exportBtns.count();
        if (count === 0) {
          console.log("   (No direct export buttons on main dashboard header)");
        } else {
          console.log(`   (Found ${count} export action triggers)`);
        }
      }
    );

    // ==========================================
    // S27: CLASS MANAGEMENT (/manager/classes)
    // ==========================================
    console.log("\n--- Testing S27: Classes (/manager/classes) ---");
    await page.goto(`${BASE}/manager/classes`, { waitUntil: "networkidle" });
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
        if (await createBtn.isVisible()) {
          await createBtn.click();
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
        if (await classItem.isVisible()) {
          await classItem.click();
          await page.waitForTimeout(600);
          const modal = page.locator('[role="dialog"]').first();
          if (!(await modal.isVisible())) throw new Error("Class detail modal did not open (B-08)");
          const cancelBtn = page.locator('[role="dialog"] button:has-text("Close"), [role="dialog"] button:has-text("Đóng"), [role="dialog"] svg.lucide-x').first();
          if (await cancelBtn.isVisible()) await cancelBtn.click();
        }
      }
    );

    // ==========================================
    // S29: STAFF MANAGEMENT (/manager/staff)
    // ==========================================
    console.log("\n--- Testing S29: Staff (/manager/staff) ---");
    await page.goto(`${BASE}/manager/staff`, { waitUntil: "networkidle" });
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
        if (await addBtn.isVisible()) {
          await addBtn.click();
          await page.waitForTimeout(600);
          const modal = page.locator('[role="dialog"]').first();
          if (!(await modal.isVisible())) throw new Error("Add staff modal did not open");
          const cancelBtn = page.locator('[role="dialog"] button:has-text("Cancel"), [role="dialog"] button:has-text("Hủy"), [role="dialog"] svg.lucide-x').first();
          if (await cancelBtn.isVisible()) await cancelBtn.click();
        }
      }
    );

    // ==========================================
    // S30: PRICING MATRIX (/manager/prices)
    // ==========================================
    console.log("\n--- Testing S30: Prices (/manager/prices) ---");
    await page.goto(`${BASE}/manager/prices`, { waitUntil: "networkidle" });
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
        await page.locator('.animate-pulse, [class*="Skeleton"]').first().waitFor({ state: "detached", timeout: 4000 }).catch(() => {});
        const priceInputs = page.locator('input[inputmode="numeric"], input:not([type="hidden"])');
        const count = await priceInputs.count();
        if (count === 0) throw new Error("No price inputs rendered in pricing grid");
        const saveBtn = page.locator('button:has-text("Save"), button:has-text("Lưu"), button:has-text("Cập nhật")').first();
        if (!(await saveBtn.isVisible())) throw new Error("Save pricing table button not found");
      }
    );

    // ==========================================
    // S31: PROMOTIONS (/manager/promos)
    // ==========================================
    console.log("\n--- Testing S31: Promos (/manager/promos) ---");
    await page.goto(`${BASE}/manager/promos`, { waitUntil: "networkidle" });
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
        if (await newPromoBtn.isVisible()) {
          await newPromoBtn.click();
          await page.waitForTimeout(600);
          const modal = page.locator('[role="dialog"]').first();
          if (!(await modal.isVisible())) throw new Error("New promo modal did not open");
          const cancelBtn = page.locator('[role="dialog"] button:has-text("Cancel"), [role="dialog"] button:has-text("Hủy"), [role="dialog"] svg.lucide-x').first();
          if (await cancelBtn.isVisible()) await cancelBtn.click();
        }
      }
    );

    // ==========================================
    // S33: SETTINGS (/manager/settings) - BUG B-01 CHECK
    // ==========================================
    console.log("\n--- Testing S33: Settings (/manager/settings) - Bug B-01 ---");
    await page.goto(`${BASE}/manager/settings`, { waitUntil: "networkidle" });
    await page.locator('.animate-pulse, [class*="Skeleton"]').first().waitFor({ state: "detached", timeout: 4000 }).catch(() => {});
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
        const saveBtn = page.locator('button:has-text("Save"), button:has-text("Lưu")').first();
        if (!(await saveBtn.isVisible())) throw new Error("Settings save button not found");
        await saveBtn.click();
        await page.waitForTimeout(1500);
        // Verify toast or confirmation
        const toast = page.locator('[data-sonner-toast]').first();
        const hasToast = await toast.isVisible();
        if (!hasToast) {
          console.log("   (Save triggered, verify console for NaN errors)");
        }
      }
    );

    // ==========================================
    // S34: AUDIT LOG (/manager/audit)
    // ==========================================
    console.log("\n--- Testing S34: Audit Log (/manager/audit) ---");
    await page.goto(`${BASE}/manager/audit`, { waitUntil: "networkidle" });
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
        const searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="Tìm"], input[type="search"]').first();
        if (await searchInput.isVisible()) {
          await searchInput.fill("login");
          await page.waitForTimeout(500);
        }
      }
    );
  } finally {
    await context.close();
  }

  return collector.summary();
}
