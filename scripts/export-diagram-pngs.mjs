import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

async function main() {
  const htmlPath = resolve("docs/srs-diagrams-pdf.html");
  if (!existsSync(htmlPath)) {
    console.error("HTML file not found:", htmlPath);
    process.exit(1);
  }

  let browser;
  try {
    browser = await chromium.launch({ channel: "chrome" });
  } catch {
    browser = await chromium.launch();
  }

  const page = await browser.newPage({
    viewport: { width: 1400, height: 2000 },
    deviceScaleFactor: 2,
  });

  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle" });

  await page.waitForFunction(() => {
    const svgs = document.querySelectorAll(".mermaid svg");
    return svgs.length >= 3;
  }, { timeout: 20000 });

  await page.waitForTimeout(2000);

  const mermaidLocators = page.locator(".mermaid");
  const count = await mermaidLocators.count();
  console.log(`Found ${count} mermaid diagrams`);

  // Diagram 1: Use Case (on page 2)
  if (count > 0) {
    const p1 = resolve("docs/diagram-usecase.png");
    await mermaidLocators.nth(0).screenshot({ path: p1 });
    console.log("Saved Use Case diagram to:", p1);
  }

  // Diagram 2: Context Diagram (on page 3)
  if (count > 1) {
    const p2 = resolve("docs/diagram-context.png");
    await mermaidLocators.nth(1).screenshot({ path: p2 });
    console.log("Saved Context diagram to:", p2);
  }

  // Diagram 3: Swimlane Diagram (on page 4)
  if (count > 2) {
    const p3 = resolve("docs/diagram-swimlane.png");
    await mermaidLocators.nth(2).screenshot({ path: p3 });
    console.log("Saved Swimlane diagram to:", p3);
  }

  await browser.close();
  console.log("Diagram export complete!");
}

main().catch((err) => {
  console.error("Error exporting diagrams:", err);
  process.exit(1);
});
