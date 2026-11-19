#!/usr/bin/env node
// Capture the real local UI. Use only a fresh, synthetic seed database.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

if (!process.argv.includes("--seed-demo")) {
  throw new Error(
    "Confirm that the running local app contains only seed/demo data: npm run screenshots -- --seed-demo",
  );
}

const base = new URL(process.env.SCREENSHOT_BASE_URL || "http://127.0.0.1:8080");
assert(
  ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname),
  "Screenshots must use a local seed app, never a live site.",
);
assert(
  base.protocol === "http:" && !base.username && !base.password,
  "Use an ordinary local HTTP address.",
);
const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "docs", "screenshots");
const audit = path.join(root, "artifacts", "screenshots");
await mkdir(output, { recursive: true });
await mkdir(audit, { recursive: true });
const maxImageBytes = 300_000;
const maxTotalBytes = 3_000_000;
const landingIndex = process.argv.indexOf("--landing-image");
const landingImage = landingIndex < 0 ? null : process.argv[landingIndex + 1];
assert(
  landingIndex < 0 || (landingImage && !landingImage.startsWith("--")),
  "--landing-image requires a screenshot path.",
);
const onlyIndex = process.argv.indexOf("--only");
const onlyNames = onlyIndex < 0 ? null : process.argv[onlyIndex + 1]?.split(",");
assert(
  onlyIndex < 0 || onlyNames?.every((name) => /^[a-z0-9-]+\.png$/.test(name)),
  "--only requires screenshot filenames separated by commas.",
);

async function launch() {
  const channels = process.env.SCREENSHOT_BROWSER_CHANNEL
    ? [process.env.SCREENSHOT_BROWSER_CHANNEL]
    : [undefined, "chrome", "msedge"];
  for (const channel of channels) {
    try {
      return await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    } catch {
      // An installed Chrome/Edge also works when bundled Chromium is absent.
    }
  }
  throw new Error(
    "No browser available. Run npx playwright install chromium, or set SCREENSHOT_BROWSER_CHANNEL to an installed chrome/msedge.",
  );
}

async function compress(png) {
  for (const quality of [100, 90, 80, 70, 65, 60, 50, 40]) {
    const buffer = await sharp(png)
      .png({ palette: true, quality, compressionLevel: 9, effort: 10, dither: 0.5 })
      .toBuffer();
    if (buffer.length <= maxImageBytes) return buffer;
  }
  throw new Error("PNG exceeds 300 KB; review the screen before changing the capture limits.");
}

let browser;
const entries = [];
const failures = [];
try {
  const sets = [
    {
      role: "guest",
      shots: [{ name: "01-landing.png", route: "/", heading: /learn with a coach/i }],
    },
    {
      role: "receptionist",
      login: /^Front desk/,
      shots: [
        { name: "02-cashier-shift.png", route: "/desk", heading: "Front desk" },
        { name: "03-payments-refunds.png", route: "/desk/payments", heading: "Payments & refunds" },
      ],
    },
    {
      role: "manager",
      login: /^Manager/,
      shots: [
        { name: "04-vat-invoices.png", route: "/manager/invoices", heading: "E-invoice export" },
        { name: "06-reports.png", route: "/manager", heading: "Reports" },
      ],
    },
    {
      role: "coach",
      login: /^Coach/,
      shots: [{ name: "05-attendance.png", route: "/coach/attendance", heading: "Attendance" }],
    },
    {
      role: "member",
      login: /^Member Nam$/,
      shots: [{ name: "07-booking.png", route: "/app/book", heading: "Book a court" }],
    },
    {
      role: "guest",
      shots: [{ name: "08-swagger.png", route: "/swagger/index.html", heading: /Arena3 API/ }],
    },
    {
      role: "member",
      login: /^Member Nam$/,
      mobile: true,
      shots: [
        { name: "mobile-member.png", route: "/app", heading: /Welcome back, Nam/ },
        { name: "mobile-booking.png", route: "/app/book", heading: "Book a court" },
      ],
    },
  ];
  const knownNames = new Set(sets.flatMap((set) => set.shots.map((shot) => shot.name)));
  assert(
    !onlyNames || onlyNames.every((name) => knownNames.has(name)),
    "Unknown screenshot filename in --only.",
  );
  for (const set of sets) {
    const shots = set.shots.filter((shot) => !onlyNames || onlyNames.includes(shot.name));
    if (!shots.length) continue;
    // Release GPU/video resources between roles, including the mobile captures.
    browser = await launch();
    const viewport = set.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 };
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      reducedMotion: shots.some((shot) => shot.route === "/") ? "no-preference" : "reduce",
      timezoneId: "Asia/Ho_Chi_Minh",
    });
    const page = await context.newPage();
    const errors = [];
    const warnings = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const location = message.location().url;
      const branding = location === "https://grok.com/grok-app-builder/extensions.js";
      const optionalIcon =
        location === new URL("/favicon.ico", base).href && /404/.test(message.text());
      if (branding || optionalIcon) warnings.push({ url: location, message: message.text() });
      else errors.push({ url: location, message: message.text() });
    });
    page.setDefaultTimeout(30_000);
    if (set.login) {
      await page.goto(new URL("/login", base).href, { waitUntil: "domcontentloaded" });
      // SSR buttons are visible before their React click handlers are hydrated.
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: set.login }).click();
      await page.waitForURL((url) => url.pathname !== "/login");
    }
    for (const shot of shots) {
      errors.length = 0;
      warnings.length = 0;
      const response = await page.goto(new URL(shot.route, base).href, {
        waitUntil: "domcontentloaded",
      });
      assert(response?.ok(), `${shot.route}: navigation failed`);
      await page.getByRole("heading", { name: shot.heading }).first().waitFor({ state: "visible" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() =>
        [...document.images]
          .filter((image) => {
            const box = image.getBoundingClientRect();
            return box.width > 0 && box.height > 0 && box.top < innerHeight && box.bottom > 0;
          })
          .every((image) => image.complete && image.naturalWidth > 0),
      );
      // Let route transitions, data reads and numeric counters finish naturally.
      await page.waitForTimeout(5_000);
      if (shot.route === "/") {
        // The boot cover can lift after the first render. Check the final visible
        // hero, not just the existence of SSR text behind that cover.
        await page.locator('[aria-busy="true"]').waitFor({ state: "detached" });
        await page.waitForFunction(() => {
          const hero = document.querySelector("[data-landing-hero]");
          if (!hero) return false;
          const selectors = [
            "h1",
            "[data-status]",
            "[data-sub]",
            "[data-cta]",
            "[data-free-big]",
            "[data-free]",
          ];
          return selectors.every((selector) => {
            const element = hero.querySelector(selector);
            if (!element || !element.textContent.trim()) return false;
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            return (
              style.visibility === "visible" &&
              Number(style.opacity) > 0.98 &&
              box.width > 0 &&
              box.height > 0 &&
              box.bottom <= innerHeight
            );
          });
        });
        const hero = page.locator("[data-landing-hero]");
        let previous = "";
        let steady = 0;
        for (let attempt = 0; attempt < 40 && steady < 6; attempt++) {
          const current = await hero.innerText();
          steady = current === previous ? steady + 1 : 0;
          previous = current;
          await page.waitForTimeout(500);
        }
        assert(steady === 6, "Landing content has not finished loading or animating.");
        await page.waitForFunction(() =>
          [...document.querySelectorAll("[data-landing-hero] video")].every(
            (video) => !video.currentSrc || video.readyState >= 2,
          ),
        );
      }
      const availability = page.getByText("Free hours today:", { exact: true });
      if (await availability.count()) {
        // Wait for the actual displayed counter to settle after availability loads.
        const region = availability.locator("../..");
        let previous = "";
        let steady = 0;
        for (let attempt = 0; attempt < 30 && steady < 4; attempt++) {
          const current = await region.innerText();
          steady = current === previous ? steady + 1 : 0;
          previous = current;
          await page.waitForTimeout(500);
        }
        assert(steady === 4, `${shot.route}: availability counter is still changing`);
      }
      if (shot.name === "03-payments-refunds.png") {
        await page
          .getByRole("heading", { name: "Receipts", exact: true })
          .evaluate((heading) => heading.scrollIntoView({ block: "start" }));
        await page.mouse.move(900, 450);
        await page.mouse.wheel(0, -80);
        await page.waitForTimeout(300);
      }
      await page.evaluate(() => {
        for (const video of document.querySelectorAll("video")) video.pause();
      });
      const text = await page.locator("body").innerText();
      assert(
        !/Something went wrong|Internal Server Error|The page could not be loaded/i.test(text),
        `${shot.route}: error screen`,
      );
      assert(text.length > 100, `${shot.route}: empty screen`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      );
      assert(!overflow, `${shot.route}: horizontal page overflow`);
      const supplied = shot.name === "01-landing.png" && landingImage;
      const png = supplied
        ? await sharp(await readFile(landingImage))
            .resize({ width: 1440, withoutEnlargement: true })
            .png()
            .toBuffer()
        : await page.screenshot({ animations: "disabled", caret: "hide" });
      const buffer = await compress(png);
      await writeFile(path.join(output, shot.name), buffer);
      const dimensions = await sharp(buffer).metadata();
      const entry = {
        file: shot.name,
        route: shot.route,
        role: set.role,
        viewport,
        width: dimensions.width,
        height: dimensions.height,
        suppliedCapture: Boolean(supplied),
        bytes: buffer.length,
        errors: [...errors],
        warnings: [...warnings],
      };
      entries.push(entry);
      if (entry.errors.length) failures.push(entry);
      console.log(
        `${shot.name}: ${buffer.length} bytes (${dimensions.width}x${dimensions.height})`,
      );
    }
    await context.close();
    await browser.close();
    browser = null;
  }
  let captured = entries;
  if (onlyNames) {
    const prior = await readFile(path.join(audit, "manifest.json"), "utf8")
      .then(JSON.parse)
      .catch(() => ({ entries: [] }));
    captured = [...prior.entries.filter((entry) => !onlyNames.includes(entry.file)), ...entries];
  }
  const total = captured.reduce((sum, entry) => sum + entry.bytes, 0);
  await writeFile(
    path.join(audit, "manifest.json"),
    JSON.stringify(
      {
        source: base.origin,
        data: "local seed/demo only",
        reducedMotion: "landing uses normal motion; other screens reduce motion",
        entries: captured,
        total,
      },
      null,
      2,
    ) + "\n",
  );
  assert(total <= maxTotalBytes, "Screenshot set exceeds 3 MB.");
  assert(
    failures.length === 0,
    "Browser errors detected; review artifacts/screenshots/manifest.json before publishing.",
  );
  console.log(
    `Captured ${entries.length} real screens; total ${total} bytes. Inspect every image before committing.`,
  );
} finally {
  await browser?.close();
}
