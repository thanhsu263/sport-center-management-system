import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

export const BASE = process.env.BASE ?? "http://127.0.0.1:8080";
export const DEMO_PASS = "ChangeMe!a3";

export const ROLES = {
  manager: { phone: "0900000001", password: DEMO_PASS, home: "/manager" },
  receptionist: { phone: "0900000002", password: DEMO_PASS, home: "/desk" },
  coach: { phone: "0901110011", password: DEMO_PASS, home: "/coach" },
  member: { phone: "0901230107", password: DEMO_PASS, home: "/app" },
  member2: { phone: "0901230101", password: DEMO_PASS, home: "/app" },
};

export const VP_DESKTOP = { width: 1366, height: 820 };
export const VP_MOBILE = { width: 390, height: 844 };

mkdirSync("screenshots/test-failures", { recursive: true });

export async function loginApi(phone, password = DEMO_PASS) {
  const res = await fetch(`${BASE}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, password }),
  });
  if (!res.ok) {
    throw new Error(`Login API failed for ${phone}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function createBrowser() {
  return await chromium.launch({ channel: "chrome", headless: true });
}

export async function createRolePage(browser, roleKey = "member", vp = VP_DESKTOP) {
  const session = await loginApi(ROLES[roleKey].phone, ROLES[roleKey].password);
  const context = await browser.newContext({ viewport: vp });
  
  await context.addInitScript(([token, user]) => {
    localStorage.setItem("arena3.lang", "en");
    localStorage.setItem("arena3.token", token);
    localStorage.setItem("arena3.user", JSON.stringify(user));
  }, [session.token, session.user]);

  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(25000);
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  return { context, page, session, consoleErrors };
}

export async function createGuestPage(browser, vp = VP_DESKTOP) {
  const context = await browser.newContext({ viewport: vp });
  await context.addInitScript(() => {
    localStorage.setItem("arena3.lang", "en");
    localStorage.removeItem("arena3.token");
    localStorage.removeItem("arena3.user");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(25000);
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  return { context, page, consoleErrors };
}

export class TestCollector {
  constructor(suiteName) {
    this.suiteName = suiteName;
    this.results = [];
  }

  async runTest(item, fn) {
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

    try {
      await fn();
      entry.status = "PASS";
      entry.actual = item.successActual || "Operated successfully as expected";
    } catch (err) {
      entry.status = "FAIL";
      entry.error = err.message || String(err);
      entry.actual = `Error: ${err.message}`;
      if (item.page) {
        const shotPath = `screenshots/test-failures/${entry.id}.png`;
        try {
          await item.page.screenshot({ path: shotPath, fullPage: false });
          entry.screenshot = shotPath;
        } catch {
          // ignore screenshot error
        }
      }
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

  summary() {
    const total = this.results.length;
    const passed = this.results.filter((r) => r.status === "PASS").length;
    const failed = this.results.filter((r) => r.status === "FAIL").length;
    return { suiteName: this.suiteName, total, passed, failed, results: this.results };
  }
}
