#!/usr/bin/env node
// Capture a 1280x800 preview PNG of the dev server (argv[2] -> argv[3]).
// Contract with SandboxInternal.CapturePreviewThumbnail: exit 0 only after the
// PNG is written; the service treats any non-zero exit as a gated skip and does
// not download the file.
import { chromium } from "playwright";
import { checkedOutputPath, checkedUrl } from "./browser-guard.mjs";

// Bước 1: Đọc và xác thực các tham số đầu vào (URL dev server, đường dẫn lưu ảnh PNG và thời gian timeout).
// The service always passes a loopback URL and a /tmp path; the checks keep that
// true when the script is invoked by hand.
const url = checkedUrl(process.argv[2] || "http://127.0.0.1:8080/");
const outPng = checkedOutputPath(process.argv[3] || "/tmp/preview-thumbnail.png", [
  "/tmp",
  "/workspace",
]);
// Mặc định timeout 45 giây (45000ms) để đảm bảo đủ thời gian chờ trang tải xong trong container.
const timeoutMs = Number(process.env.PREVIEW_THUMBNAIL_TIMEOUT_MS || 45000);

// Bước 2: Khởi chạy trình duyệt Chromium ở chế độ headless.
// Cần --no-sandbox và --disable-dev-shm-usage để chạy an toàn với quyền root và tránh lỗi tràn bộ nhớ chia sẻ /dev/shm trong Linux container.
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  // Bước 3: Tạo một trang mới với kích thước viewport 1280x800 theo chuẩn tỷ lệ 16:10 cho ảnh preview.
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  // `domcontentloaded`, not `networkidle`: Vite keeps an HMR websocket open, so
  // networkidle never settles and would burn the whole timeout.
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  const status = resp?.status() ?? 0;
  // Bước 4: Chờ thêm 1 giây (1000ms) để các animation, font chữ và giao diện React/Vite kịp render ổn định sau khi tải xong DOM.
  await page.waitForTimeout(1000);

  // Bước 5: Chụp ảnh màn hình khung nhìn hiện tại và lưu vào file PNG.
  // Dùng fullPage: false để chỉ lấy đúng khung nhìn 1280x800 thay vì cuộn chụp toàn bộ trang dài.
  await page.screenshot({ path: outPng, fullPage: false });

  console.log(JSON.stringify({ url, status, screenshot: outPng }, null, 2));
} catch (err) {
  console.error(JSON.stringify({ ok: false, url, error: String(err?.message || err) }, null, 2));
  // Set the code rather than process.exit() so the `finally` browser teardown
  // always runs (avoids leaking Chromium across repeated capture calls).
  process.exitCode = 1;
} finally {
  // Bước 6: Luôn đóng trình duyệt Chromium trong khối finally để giải phóng tài nguyên và tránh rò rỉ tiến trình chạy ngầm.
  await browser.close();
}
