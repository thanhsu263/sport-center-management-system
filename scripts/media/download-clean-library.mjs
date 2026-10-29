import fs from "node:fs";
import path from "node:path";
import { CLEAN_LIBRARY_CATALOG } from "./curate-clean-library.mjs";

const BASE_DIR = "public/media/library";

async function downloadPhoto(item, cat) {
  const destDir = path.join(BASE_DIR, cat);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  const destFile = path.join(destDir, `${item.slug}.jpg`);

  const res = await fetch(item.url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${item.slug} (${res.status} ${res.statusText})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  // Check magic bytes for JPEG
  if (buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new Error(`Invalid JPEG magic bytes for ${item.slug}`);
  }

  fs.writeFileSync(destFile, buf);
  console.log(`Downloaded ${cat}/${item.slug}.jpg (${(buf.length / 1024).toFixed(1)} KB)`);
}

async function main() {
  console.log("=== Downloading Clean Curated Library Photos ===");
  for (const [cat, items] of Object.entries(CLEAN_LIBRARY_CATALOG)) {
    console.log(`\nProcessing category: ${cat} (${items.length} items)...`);
    for (const item of items) {
      await downloadPhoto(item, cat);
    }
  }
  console.log("\nALL CATEGORIES DOWNLOADED SUCCESSFULLY!");
}

main().catch((err) => {
  console.error("FATAL DOWNLOAD ERROR:", err);
  process.exit(1);
});
