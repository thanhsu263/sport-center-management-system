import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { writeFileSync, existsSync } from "node:fs";
import { PDFDocument } from "pdf-lib";

async function main() {
  const htmlPath = resolve("docs/srs-diagrams-pdf.html");
  const pdfPath = resolve("docs/Arena3-SRS-Diagrams.pdf");

  console.log("Checking HTML file:", htmlPath);
  if (!existsSync(htmlPath)) {
    console.error("HTML file not found:", htmlPath);
    process.exit(1);
  }

  console.log("Launching Chromium with Playwright (Zero Mermaid)...");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 1600 }, deviceScaleFactor: 2 });

  console.log("Navigating to HTML file:", pathToFileURL(htmlPath).href);
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);

  // Ensure all images are fully loaded
  await page.waitForFunction(() => {
    const imgs = Array.from(document.querySelectorAll("img"));
    return imgs.every(img => img.complete && img.naturalWidth > 0);
  }, { timeout: 15000 });

  console.log("Generating clean A4 PDF...");
  const pdfBuffer = await page.pdf({
    format: "A4",
    printBackground: true,
    preferCSSPageSize: true,
  });

  const pdfDoc = await PDFDocument.load(pdfBuffer);
  console.log("Verified PDF page count:", pdfDoc.getPageCount());

  writeFileSync(pdfPath, pdfBuffer);
  await browser.close();

  console.log("SUCCESS! Generated Draw.io native PDF:", pdfPath, "with", pdfDoc.getPageCount(), "pages.");
}

main().catch((e) => {
  console.error("Failed to render PDF:", e);
  process.exit(1);
});
