const { chromium } = require('playwright');
const path = require('path');

// node print.js <in.html> <out.pdf> [--plain]
const [inHtml, outPdf, flag] = process.argv.slice(2);
const plain = flag === '--plain';

const FONT = 'font-family:"Times New Roman",Times,serif;font-size:8.5pt;color:#475569;';
const header = `<div style="${FONT}width:100%;padding:0 2cm 0 2.5cm;display:flex;justify-content:space-between;">
<span>Arena 3 — Software Requirement Specification</span><span>Version 2.2</span></div>`;
const footer = `<div style="${FONT}width:100%;text-align:center;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file:///' + path.resolve(inHtml).replace(/\\/g, '/'), { waitUntil: 'load' });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((i) => i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; })));
  });
  const broken = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.src));
  if (broken.length) console.log('broken images:', broken);
  await page.pdf({
    path: outPdf,
    preferCSSPageSize: true,
    printBackground: true,
    displayHeaderFooter: !plain,
    headerTemplate: plain ? '<span></span>' : header,
    footerTemplate: plain ? '<span></span>' : footer,
  });
  await browser.close();
  console.log('wrote', outPdf);
})();
