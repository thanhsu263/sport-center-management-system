/**
 * Target checks shared by the Playwright capture scripts.
 *
 * Both run Chromium with `--no-sandbox` as root and take their URL and output
 * path from argv, so unchecked they will render `file:///root/.grok/auth.json`
 * into a PNG the agent can read, and write it anywhere.
 */
import { resolve, sep } from "node:path";

// Tập hợp các hostname loopback hợp lệ (cả IPv4 và IPv6) để giới hạn Chromium chỉ truy cập server cục bộ.
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** http/https loopback only, else exit 1. `BROWSER_ALLOW_EXTERNAL_HOST=1` opts out. */
/*
 * Làm gì: Kiểm tra tính hợp lệ và độ an toàn của URL trước khi Playwright tải trang.
 *   Chỉ cho phép giao thức http/https và trỏ về host loopback nội bộ (trừ khi có biến ghi đè),
 *   nhằm ngăn Chromium chạy quyền root đọc trộm file hệ thống hoặc gửi request ra ngoài (SSRF).
 * Được gọi ở:
 *   - scripts/browser-smoke.mjs: kiểm tra tham số URL cần smoke test.
 *   - scripts/preview-thumbnail.mjs: kiểm tra URL dev server cần chụp ảnh thumbnail.
 * - Tham số url: Chuỗi URL cần kiểm tra trước khi truyền vào Playwright.
 * - Trả về: Chuỗi url ban đầu nếu vượt qua tất cả kiểm tra an toàn.
 * - Lỗi có thể ném: Thoát tiến trình (exit 1) qua fail() khi URL sai cú pháp, sai giao thức hoặc không thuộc loopback host.
 */
export function checkedUrl(url) {
  // Bước 1: Parse URL thành object URL để bóc tách protocol và hostname; dừng ngay nếu URL sai định dạng.
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(`not a valid URL: ${url}`);
  }
  // Bước 2: Kiểm tra giao thức (protocol), chỉ chấp nhận http: hoặc https:.
  // Rules out file:, data:, chrome:, view-source:.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(`only http/https URLs are allowed, got ${parsed.protocol} in ${url}`);
  }
  // Bước 3: Đảm bảo hostname là loopback (máy cục bộ) để tránh SSRF, trừ khi có cờ BROWSER_ALLOW_EXTERNAL_HOST=1.
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname) && process.env.BROWSER_ALLOW_EXTERNAL_HOST !== "1") {
    fail(
      `${parsed.hostname} is not a loopback host; these scripts screenshot the ` +
        `local dev server. Set BROWSER_ALLOW_EXTERNAL_HOST=1 to override.`,
    );
  }
  return url;
}

/** Absolute `target` if it is strictly inside `allowedDirs`, else exit 1. */
/*
 * Làm gì: Chuẩn hóa đường dẫn file đầu ra thành đường dẫn tuyệt đối và xác thực
 *   đường dẫn phải nằm trong các thư mục cho phép (allowedDirs) để chống tấn công path traversal.
 * Được gọi ở:
 *   - scripts/browser-smoke.mjs: kiểm tra các đường dẫn outPng, mobilePng, outJson (verdict) và baseline.
 *   - scripts/preview-thumbnail.mjs: kiểm tra đường dẫn file outPng chụp thumbnail preview.
 * - Tham số target: Đường dẫn file đầu ra cần kiểm tra (tương đối hoặc tuyệt đối).
 * - Tham số allowedDirs: Danh sách các thư mục an toàn được phép ghi file (ví dụ: ["/workspace"], ["/tmp"]).
 * - Tham số label: Tên nhãn mô tả loại file để hiển thị khi báo lỗi (mặc định là "screenshot").
 * - Trả về: Đường dẫn tuyệt đối an toàn của file đầu ra.
 * - Lỗi có thể ném: Thoát tiến trình (exit 1) qua fail() nếu đường dẫn nằm ngoài các thư mục cho phép.
 */
export function checkedOutputPath(target, allowedDirs, label = "screenshot") {
  // Bước 1: Chuẩn hóa target thành đường dẫn tuyệt đối để loại bỏ các đoạn điều hướng tương đối (như "..").
  // Resolve first so `..` cannot slip past the prefix check.
  const abs = resolve(target);
  // Bước 2: Kiểm tra đường dẫn nằm trong allowedDirs. Thêm sep ở cuối để tránh khớp nhầm thư mục có tên cùng tiền tố (ví dụ: "/workspace-leak" khớp nhầm "/workspace").
  const allowed = allowedDirs.some((dir) => abs.startsWith(dir.endsWith(sep) ? dir : dir + sep));
  // Bước 3: Thoát tiến trình và ghi log lỗi nếu đường dẫn ghi file nằm ngoài danh sách thư mục cho phép.
  if (!allowed) {
    fail(`${label} path must be under ${allowedDirs.join(" or ")}, got ${abs}`);
  }
  return abs;
}

/**
 * Làm gì: Ghi thông báo lỗi dạng JSON ra console.error và dừng ngay tiến trình với mã lỗi 1.
 * Được gọi ở: Nội bộ scripts/browser-guard.mjs trong checkedUrl và checkedOutputPath khi phát hiện vi phạm kiểm tra an toàn.
 * - Tham số message: Thông điệp mô tả chi tiết lỗi phát sinh.
 * - Lỗi có thể ném: Luôn thoát tiến trình bằng process.exit(1).
 */
function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
}
