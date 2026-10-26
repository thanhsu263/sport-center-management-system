import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import pako from "pako";

const DIAGRAMS_DIR = resolve("docs/diagrams");
if (!existsSync(DIAGRAMS_DIR)) mkdirSync(DIAGRAMS_DIR, { recursive: true });

function compressData(data) {
  const encoded = encodeURIComponent(data);
  const compressed = pako.deflateRaw(encoded);
  return Buffer.from(compressed).toString("base64");
}

function generateDrawioUrl(xmlContent) {
  const compressed = compressData(xmlContent);
  const createObj = {
    type: "xml",
    compressed: true,
    data: compressed,
  };
  return "https://app.diagrams.net/?lightbox=1&target=blank&highlight=0000ff&edit=_blank&layers=1&nav=1#create=" + encodeURIComponent(JSON.stringify(createObj));
}

const DIAGRAM_CONFIGS = [
  {
    file: "class-diagram.drawio",
    name: "Class Diagram (UML 2.0)",
    width: 1800,
    height: 1200,
  },
  {
    file: "sequence-diagram.drawio",
    name: "Sequence Diagram (UML 2.0)",
    width: 1800,
    height: 1300,
  },
  {
    file: "use-case-diagram.drawio",
    name: "Use Case Diagram (UML 2.0)",
    width: 1800,
    height: 1250,
  },
  {
    file: "activity-diagram.drawio",
    name: "Activity Diagram (UML 2.0 Swimlane)",
    width: 1800,
    height: 1250,
  },
  {
    file: "context-diagram.drawio",
    name: "Context Diagram (DFD Level 0)",
    width: 1800,
    height: 1150,
  },
];

async function main() {
  console.log("=== EXPORTING ALL DRAW.IO DIAGRAMS VIA PLAYWRIGHT (ZERO MERMAID) ===");
  const browser = await chromium.launch();

  for (const cfg of DIAGRAM_CONFIGS) {
    const filePath = join(DIAGRAMS_DIR, cfg.file);
    if (!existsSync(filePath)) {
      console.warn(`File not found: ${filePath}`);
      continue;
    }

    const xml = readFileSync(filePath, "utf8");
    const targetUrl = generateDrawioUrl(xml);
    const baseName = cfg.file.replace(/\.drawio$/, "");
    const outPng = join(DIAGRAMS_DIR, `${baseName}.png`);
    const outSvg = join(DIAGRAMS_DIR, `${baseName}.svg`);

    console.log(`\n[${cfg.name}] Rendering via Draw.io engine in Playwright...`);
    const page = await browser.newPage({
      viewport: { width: cfg.width, height: cfg.height },
      deviceScaleFactor: 2,
    });

    try {
      await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 45000 });
      await page.waitForTimeout(3000);

      // Hide any lightbox toolbar overlay elements
      await page.evaluate(() => {
        const toolbars = document.querySelectorAll(
          ".geToolbarContainer, .geFooterContainer, .geSidebarContainer, .geMenubarContainer, div[style*='z-index: 2']"
        );
        toolbars.forEach(el => el.style.display = "none");
      });

      const svgLocator = page.locator("svg").first();
      await svgLocator.waitFor({ state: "visible", timeout: 15000 });

      // Save vector SVG
      const svgHtml = await svgLocator.evaluate(el => el.outerHTML);
      writeFileSync(outSvg, svgHtml, "utf8");
      console.log(`✓ Vector SVG: ${outSvg}`);

      // Save high-resolution PNG
      await svgLocator.screenshot({ path: outPng });
      console.log(`✓ High-Res PNG: ${outPng}`);

      // Sync root docs diagrams if matching
      if (baseName === "use-case-diagram") {
        await svgLocator.screenshot({ path: "docs/diagram-usecase.png" });
        console.log(`✓ Synced: docs/diagram-usecase.png`);
      } else if (baseName === "context-diagram") {
        await svgLocator.screenshot({ path: "docs/diagram-context.png" });
        console.log(`✓ Synced: docs/diagram-context.png`);
      } else if (baseName === "activity-diagram") {
        await svgLocator.screenshot({ path: "docs/diagram-swimlane.png" });
        console.log(`✓ Synced: docs/diagram-swimlane.png`);
      }
    } catch (e) {
      console.error(`Error rendering ${cfg.name}:`, e.message);
    } finally {
      await page.close();
    }
  }

  await browser.close();
  console.log("\n=== ALL DIAGRAMS EXPORTED SUCCESSFULLY ===");
}

main().catch(err => {
  console.error("Export process failed:", err);
  process.exit(1);
});
