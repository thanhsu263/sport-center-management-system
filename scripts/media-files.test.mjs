import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function listRel(dir, base = "") {
  let res = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.name.startsWith(".") || f.name.endsWith(".md")) continue;
    const rel = base ? `${base}/${f.name}` : f.name;
    const full = path.join(dir, f.name);
    if (f.isDirectory()) res.push(...listRel(full, rel));
    else res.push(rel.replace(/\\/g, "/"));
  }
  return res.sort();
}

test("MEDIA_FILES matches public/media", () => {
  const source = fs.readFileSync("src/lib/arena3/media-files.ts", "utf8");
  const listed = [...source.matchAll(/^\s*"([^"]+)",$/gm)].map((m) => m[1]).sort();
  const onDisk = listRel("public/media");
  assert.deepEqual(listed, onDisk);
});

test("No duplicate images by content hash in public/media/library", () => {
  const libraryFiles = listRel("public/media/library");
  const hashes = new Map();
  const duplicates = [];

  for (const rel of libraryFiles) {
    if (rel.endsWith(".json") || rel.endsWith(".md")) continue;
    const fullPath = path.join("public/media/library", rel);
    const buf = fs.readFileSync(fullPath);
    const hash = crypto.createHash("md5").update(buf).digest("hex");
    if (hashes.has(hash)) {
      duplicates.push({ file: rel, duplicateOf: hashes.get(hash), hash });
    } else {
      hashes.set(hash, rel);
    }
  }

  assert.equal(
    duplicates.length,
    0,
    `Found duplicate images:\n${duplicates.map((d) => `  ${d.file} duplicate of ${d.duplicateOf} (hash: ${d.hash})`).join("\n")}`
  );
});

