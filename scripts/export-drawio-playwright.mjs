import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

async function main() {
  console.log("=== EXPORTING DRAW.IO DIAGRAMS VIA PLAYWRIGHT (ZERO MERMAID) ===");
  const links = JSON.parse(readFileSync("docs/drawio/drawio-links.json", "utf8"));

  const browser = await chromium.launch();
  
  const diagrams = [
    {
      id: "useCase",
      name: "Use Case Diagram (UML 2.0)",
      url: links.useCase.openInDrawioUrl,
      width: 1760,
      height: 1260,
      outPng: ["docs/diagram-usecase.png", "docs/drawio/Arena3-UseCase-UML2.png"],
      outSvg: "docs/drawio/Arena3-UseCase-UML2.svg",
    },
    {
      id: "contextDfd",
      name: "Context Diagram (DFD Level 0)",
      url: links.contextDfd.openInDrawioUrl,
      width: 1680,
      height: 1180,
      outPng: ["docs/diagram-context.png", "docs/drawio/Arena3-Context-DFD0.png"],
      outSvg: "docs/drawio/Arena3-Context-DFD0.svg",
    },
    {
      id: "swimlaneRegister",
      name: "Swimlane Activity Diagram (UML 2.0)",
      url: links.swimlaneRegister.openInDrawioUrl,
      width: 1760,
      height: 1360,
      outPng: ["docs/diagram-swimlane.png", "docs/drawio/Arena3-Swimlane-Register-OTP.png"],
      outSvg: "docs/drawio/Arena3-Swimlane-Register-OTP.svg",
    },
  ];

  for (const diag of diagrams) {
    console.log(`\nRendering [${diag.name}] via Draw.io engine in Playwright...`);
    const page = await browser.newPage({
      viewport: { width: diag.width, height: diag.height },
      deviceScaleFactor: 2,
    });

    const targetUrl = diag.url.replace("?grid=1&pv=0", "?lightbox=1&target=blank&highlight=0000ff&edit=_blank&layers=1&nav=1");
    await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(3500);

    // Hide any lightbox toolbar overlay elements if present
    await page.evaluate(() => {
      const toolbars = document.querySelectorAll(".geToolbarContainer, .geFooterContainer, .geSidebarContainer, .geMenubarContainer, div[style*='z-index: 2']");
      toolbars.forEach(el => el.style.display = "none");
    });

    const svgLocator = page.locator("svg").first();
    await svgLocator.waitFor({ state: "visible", timeout: 15000 });

    // Save SVG markup
    const svgHtml = await svgLocator.evaluate(el => el.outerHTML);
    writeFileSync(diag.outSvg, svgHtml, "utf8");
    console.log(`Saved native vector SVG to: ${diag.outSvg}`);

    // Take high-resolution screenshot
    for (const pngPath of diag.outPng) {
      await svgLocator.screenshot({ path: pngPath });
      console.log(`Saved high-res PNG to: ${pngPath}`);
    }

    await page.close();
  }

  await browser.close();
  console.log("\n=== ALL DRAW.IO DIAGRAMS EXPORTED VIA PLAYWRIGHT SUCCESSFULLY ===");
}

main().catch(err => {
  console.error("Export error:", err);
  process.exit(1);
});
