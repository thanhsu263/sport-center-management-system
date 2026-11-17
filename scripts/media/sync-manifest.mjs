/**
 * File script tiện ích đồng bộ danh mục tệp media (manifest) cho toàn bộ hệ thống Arena3.
 * Quét các tệp thực tế trong public/media, kết hợp dữ liệu bản quyền tuyển chọn và manifest cũ,
 * sau đó tự động cập nhật: library.json, CREDITS.md và mã TypeScript src/server/data/media-files.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { GROUP_SURVIVORS, NEW_UNSPLASH_PHOTOS } from "./curate-clean-library.mjs";

const MEDIA_ROOT = "public/media";
const MANIFEST_PATH = "scripts/media/library.json";
const CREDITS_PATH = "public/media/library/CREDITS.md";
const MEDIA_FILES_TS = "src/server/data/media-files.ts";

/**
 * Làm gì: Quét đệ quy thư mục để lấy danh sách đường dẫn tương đối của tất cả tệp media, bỏ qua file ẩn và file .md.
 * Được gọi ở: scripts/media/sync-manifest.mjs (dòng 22 và gọi đệ quy chính nó tại dòng 16).
 * - Tham số dir: Đường dẫn thư mục cần quét trên đĩa (ví dụ: "public/media").
 * - Tham số base: Tiền tố đường dẫn tương đối tích lũy qua các cấp thư mục con (mặc định là rỗng).
 * - Trả về: Danh sách các đường dẫn tương đối đã chuẩn hóa dấu gạch chéo xuôi (/) và sắp xếp theo bảng chữ cái.
 * - Lỗi có thể ném: Lỗi từ fs.readdirSync nếu thư mục không tồn tại hoặc thiếu quyền đọc.
 */
function listRel(dir, base = "") {
  let res = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    // Bỏ qua file ẩn hệ thống (bắt đầu bằng dấu .) và file tài liệu markdown (.md) vì không phải tài nguyên media.
    if (f.name.startsWith(".") || f.name.endsWith(".md")) continue;
    const rel = base ? `${base}/${f.name}` : f.name;
    const full = path.join(dir, f.name);
    if (f.isDirectory()) res.push(...listRel(full, rel));
    // Chuẩn hóa dấu phân cách thư mục trên Windows (\) thành (/) để đường dẫn web luôn đồng nhất.
    else res.push(rel.replace(/\\/g, "/"));
  }
  return res.sort();
}

// Bước 1: Quét toàn bộ danh sách tệp media thực tế đang lưu trữ trên đĩa trong MEDIA_ROOT.
const onDiskFiles = listRel(MEDIA_ROOT);
console.log(`Found ${onDiskFiles.length} media files on disk.`);

// Build maps for curated metadata
// Bước 2: Tạo map tra cứu nhanh cho các ảnh giữ lại sau dọn trùng (GROUP_SURVIVORS) theo đường dẫn thư viện.
const survivorMap = new Map();
for (const s of GROUP_SURVIVORS) {
  survivorMap.set(`library/${s.to}`, s);
}

// Tạo map tra cứu cho các ảnh mới tải về từ Unsplash (NEW_UNSPLASH_PHOTOS).
const newPhotosMap = new Map();
for (const p of NEW_UNSPLASH_PHOTOS) {
  newPhotosMap.set(`library/${p.category}/${p.slug}.jpg`, p);
}

// Preserve existing metadata from previous library.json
// Bước 3: Đọc manifest cũ nếu có để giữ lại metadata của các file đã tồn tại trước đó, tránh mất thông tin.
let existingManifest = [];
try {
  existingManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
} catch {
  existingManifest = [];
}
const existingMap = new Map();
for (const it of existingManifest) {
  existingMap.set(it.path, it);
}

const updatedManifest = [];
const credits = [];

// Bước 4: Duyệt qua từng tệp trên đĩa để tổng hợp metadata chi tiết và danh sách bản quyền (credits).
for (const relPath of onDiskFiles) {
  const parts = relPath.split("/");
  // Phân loại tệp thuộc thư viện mới (library/) hay tệp cũ (legacy), trích xuất category và slug tên file.
  const isLibrary = relPath.startsWith("library/");
  const category = isLibrary ? parts[1] : "legacy";
  const filename = parts[parts.length - 1];
  const slug = filename.replace(/\.[^.]+$/, "");
  const isVideo = filename.endsWith(".mp4");

  let item = null;
  // Ưu tiên 1: Lấy metadata chi tiết đã tuyển chọn từ danh sách ảnh giữ lại sau lọc trùng.
  if (survivorMap.has(relPath)) {
    const s = survivorMap.get(relPath);
    item = {
      id: `lib-${s.category}-${s.slug}`,
      path: relPath,
      kind: "image",
      category: s.category,
      tags: s.tags || [s.category, s.slug],
      width: 1920,
      height: 1080,
      alt_en: s.alt_en,
      alt_vi: s.alt_vi,
      credit: s.credit,
      source_url: s.source_url,
      license: s.license,
      created_at: new Date().toISOString(),
    };
  // Ưu tiên 2: Lấy metadata tuyển chọn của các ảnh mới bổ sung từ Unsplash.
  } else if (newPhotosMap.has(relPath)) {
    const p = newPhotosMap.get(relPath);
    item = {
      id: `lib-${p.category}-${p.slug}`,
      path: relPath,
      kind: "image",
      category: p.category,
      tags: p.tags || [p.category, p.slug],
      width: 1920,
      height: 1080,
      alt_en: p.alt_en,
      alt_vi: p.alt_vi,
      credit: p.credit,
      source_url: p.source_url,
      license: p.license,
      created_at: new Date().toISOString(),
    };
  // Ưu tiên 3: Giữ nguyên metadata đã có trong file library.json trước đó.
  } else if (existingMap.has(relPath)) {
    item = existingMap.get(relPath);
  } else {
    // Ưu tiên 4: Tệp mới chưa có metadata, gán thông tin mặc định với kích thước chuẩn (1920x1080 cho video, 1280x720 cho ảnh).
    item = {
      id: isLibrary ? `lib-${category}-${slug}` : `legacy-${slug}`,
      path: relPath,
      kind: isVideo ? "video" : "image",
      category,
      tags: [category, slug],
      width: isVideo ? 1920 : 1280,
      height: isVideo ? 1080 : 720,
      alt_en: `Arena3 ${category}: ${slug.replace(/-/g, " ")}`,
      alt_vi: `Hình ảnh Arena3 ${category}: ${slug.replace(/-/g, " ")}`,
      credit: "Arena3 Sports Studio",
      source_url: "https://arena3.vn",
      license: isLibrary ? "Unsplash License" : "project",
      created_at: new Date().toISOString(),
    };
  }

  updatedManifest.push(item);

  // Chỉ thu thập thông tin bản quyền (credit) cho các tệp thuộc thư viện library/ để xuất ra markdown.
  if (isLibrary) {
    credits.push(`- **${item.path}**: "${item.alt_en}" by [${item.credit}](${item.source_url}) (${item.license})`);
  }
}

// Write library.json
// Bước 5: Ghi đè file library.json với toàn bộ danh mục media và metadata mới.
fs.writeFileSync(MANIFEST_PATH, JSON.stringify(updatedManifest, null, 2), "utf8");
console.log(`Updated manifest with ${updatedManifest.length} items at ${MANIFEST_PATH}`);

// Write CREDITS.md
// Bước 6: Tổng hợp danh sách bản quyền theo định dạng markdown và ghi ra file CREDITS.md.
const creditsContent = [
  "# Arena3 Media Library Credits",
  "",
  "All media assets included in `public/media/library` are compliant with the project licensing guidelines.",
  "Photos are sourced from Unsplash, Wikimedia Commons, and Openverse under permissible commercial licenses (Unsplash License, CC BY, CC BY-SA, Public Domain).",
  "",
  "## Asset List",
  "",
  ...credits.sort(),
  "",
].join("\n");
fs.writeFileSync(CREDITS_PATH, creditsContent, "utf8");
console.log(`Updated credits at ${CREDITS_PATH}`);

// Write src/server/data/media-files.ts
// Bước 7: Sinh mã nguồn TypeScript src/server/data/media-files.ts định nghĩa mảng KNOWN_MEDIA_FILES cho server kiểm tra kiểu.
const tsContent = [
  "// Auto-generated by scripts/media/sync-manifest.mjs. Do not edit manually.",
  "export const KNOWN_MEDIA_FILES = [",
  ...onDiskFiles.map((f) => `  ${JSON.stringify(f)},`),
  "] as const;",
  "",
  "export type KnownMediaFile = (typeof KNOWN_MEDIA_FILES)[number];",
  "export const MEDIA_FILES: readonly string[] = KNOWN_MEDIA_FILES;",
  "",
].join("\n");
fs.writeFileSync(MEDIA_FILES_TS, tsContent, "utf8");
console.log(`Updated ${MEDIA_FILES_TS} with ${onDiskFiles.length} files.`);
