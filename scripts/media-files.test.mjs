/**
 * Mục đích file:
 * File kiểm thử đơn vị (unit test) cho hệ thống tài nguyên media của dự án.
 * Đảm bảo danh sách khai báo trong src/server/data/media-files.ts đồng bộ với các tệp thực tế trong public/media/,
 * đồng thời kiểm tra và ngăn chặn các ảnh trùng lặp nội dung (theo MD5 hash) trong thư viện public/media/library/.
 *
 * Vị trí trong hệ thống:
 * Được thực thi bởi test runner (node --test) khi chạy `npm test` hoặc trong quy trình kiểm thử tự động (QA/CI),
 * giúp tránh lỗi liên kết tài nguyên hỏng (404) và tối ưu dung lượng lưu trữ của ứng dụng.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Làm gì: Quét đệ quy một thư mục để lấy toàn bộ đường dẫn tương đối của các tệp tin,
 * bỏ qua các tệp ẩn và tệp tài liệu markdown (.md), chuẩn hóa phân cách đường dẫn sang '/' và sắp xếp bảng chữ cái.
 * Được gọi ở: scripts/media-files.test.mjs (gọi đệ quy trong chính hàm và được gọi trong hai test case bên dưới)
 * - Tham số dir: Đường dẫn thư mục cần quét trên đĩa
 * - Tham số base: Tiền tố đường dẫn tương đối tích lũy qua các tầng thư mục đệ quy (mặc định là chuỗi rỗng)
 * @returns {string[]} Danh sách đường dẫn tương đối của các tệp tin đã được chuẩn hóa và sắp xếp tăng dần
 */
function listRel(dir, base = "") {
  let res = [];
  // Bước 1: Đọc tất cả các mục trong thư mục kèm thông tin phân loại (tệp tin hay thư mục con)
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    // Bỏ qua tệp ẩn hệ thống (bắt đầu bằng dấu '.') và tệp tài liệu Markdown (.md) vì không phải tài nguyên media dùng ở runtime
    if (f.name.startsWith(".") || f.name.endsWith(".md")) continue;
    const rel = base ? `${base}/${f.name}` : f.name;
    const full = path.join(dir, f.name);
    // Bước 2: Đệ quy quét tiếp nếu là thư mục con; nếu là tệp thì chuẩn hóa dấu phân cách '\\' sang '/' để đồng nhất trên mọi hệ điều hành
    if (f.isDirectory()) res.push(...listRel(full, rel));
    else res.push(rel.replace(/\\/g, "/"));
  }
  // Bước 3: Sắp xếp danh sách tệp theo thứ tự bảng chữ cái để đảm bảo kết quả so sánh luôn nhất quán
  return res.sort();
}

/**
 * Làm gì: Kiểm tra mảng KNOWN_MEDIA_FILES trong src/server/data/media-files.ts khớp hoàn toàn với các tệp thực tế trong public/media.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("MEDIA_FILES matches public/media", () => {
  // Bước 1: Đọc nội dung tệp mã nguồn manifest media-files.ts
  const source = fs.readFileSync("src/server/data/media-files.ts", "utf8");
  // Trích xuất toàn bộ tên tệp được khai báo trong mảng hằng số bằng biểu thức chính quy (regex) rồi sắp xếp
  const listed = [...source.matchAll(/^\s*"([^"]+)",$/gm)].map((m) => m[1]).sort();
  // Bước 2: Quét toàn bộ tệp tài nguyên thực tế hiện có trong thư mục public/media trên đĩa
  const onDisk = listRel("public/media");
  // Bước 3: So sánh sâu hai danh sách; báo lỗi nếu danh sách khai báo bị lệch so với tệp thực tế trên đĩa
  assert.deepEqual(listed, onDisk);
});

/**
 * Làm gì: Quét thư viện ảnh public/media/library và kiểm tra trùng lặp nội dung bằng mã băm MD5 để tối ưu dung lượng lưu trữ.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("No duplicate images by content hash in public/media/library", () => {
  // Bước 1: Lấy danh sách toàn bộ tệp trong thư viện ảnh public/media/library
  const libraryFiles = listRel("public/media/library");
  const hashes = new Map();
  const duplicates = [];

  // Bước 2: Duyệt qua từng tệp, tạo mã băm MD5 từ dữ liệu nhị phân để kiểm tra trùng lặp nội dung
  for (const rel of libraryFiles) {
    // Bỏ qua metadata JSON và tài liệu Markdown, chỉ kiểm tra nội dung của các tệp hình ảnh
    if (rel.endsWith(".json") || rel.endsWith(".md")) continue;
    const fullPath = path.join("public/media/library", rel);
    const buf = fs.readFileSync(fullPath);
    const hash = crypto.createHash("md5").update(buf).digest("hex");
    // Nếu mã băm MD5 đã tồn tại thì ghi nhận tệp này bị trùng nội dung với tệp đã duyệt trước đó
    if (hashes.has(hash)) {
      duplicates.push({ file: rel, duplicateOf: hashes.get(hash), hash });
    } else {
      hashes.set(hash, rel);
    }
  }

  // Bước 3: Xác minh không có ảnh nào bị trùng; in danh sách chi tiết các tệp trùng nếu kiểm tra thất bại
  assert.equal(
    duplicates.length,
    0,
    `Found duplicate images:\n${duplicates.map((d) => `  ${d.file} duplicate of ${d.duplicateOf} (hash: ${d.hash})`).join("\n")}`
  );
});

