#!/usr/bin/env node
/**
 * Fail loudly when the running dev server and the next build disagree about
 * `VITE_AUTH_ENABLED`.
 *
 * `npm run dev`, `npm run build` and `npm run preview` all get the flag from
 * `scripts/with-app-env.mjs`, so they agree by construction — but a dev server
 * started outside npm (`npx vite dev`) does not, and the result is sign-in
 * visible in the live preview and absent from the built output, or the reverse.
 *
 * The two sides compared:
 *  - **dev**: what the running server resolved, read from the `/__app-env`
 *    endpoint the template's dev-only `appEnvPlugin` serves.
 *  - **build**: what the wrapper hands `vite build` / `vite preview`.
 *
 * The built bundle is not read: Vite inlines the flag and the minifier folds
 * `"false" !== "false"` away, so the built client JS carries no marker to
 * compare against unless the app is made to emit one.
 *
 * `scripts/browser-smoke.mjs` runs the comparison on every smoke; run it
 * standalone against a live dev server with `npm run check:auth` (exit 0 agree,
 * 1 diverged, 2 could not observe). Callers comparing the flag should use
 * `compareAuthInvariant()` rather than re-deriving it.
 */
import { APP_ENV_ROUTE } from "./app-env-plugin.mjs";
import { isMainModule, mergeAppEnv, projectRoot, readAppEnv } from "./with-app-env.mjs";

// URL mặc định của dev server cục bộ trong sandbox container (cổng 8080).
const DEFAULT_DEV_URL = "http://127.0.0.1:8080";

/** The predicate `src/server/auth/{client,server}.ts` apply to the flag. */
/*
 * Làm gì: Xác định trạng thái bật/tắt xác thực (sign-in) từ giá trị chuỗi của biến môi trường VITE_AUTH_ENABLED.
 * Được gọi ở: scripts/check-auth-invariant.mjs (probeDevAuthEnabled, buildAuthEnabled), scripts/check-auth-invariant.test.mjs ("test runner (node --test)").
 * - Tham số value: Giá trị biến môi trường VITE_AUTH_ENABLED (chuỗi hoặc undefined).
 * - Trả về: true nếu xác thực được bật (bất kỳ giá trị nào khác "false"), false nếu giá trị bằng "false".
 */
export function authEnabledFromEnvValue(value) {
  // Mặc định bật sign-in; chỉ tắt khi biến môi trường được đặt tường minh thành chuỗi "false"
  return value !== "false";
}

/**
 * Compare the two resolved values. `null` means "could not observe" — reported
 * as indeterminate rather than as agreement.
 */
/*
 * Làm gì: So sánh cờ xác thực VITE_AUTH_ENABLED giữa dev server đang chạy và bản build kế tiếp để đảm bảo tính nhất quán.
 * Được gọi ở: scripts/browser-smoke.mjs (smoke test), scripts/check-auth-invariant.mjs (main), scripts/check-auth-invariant.test.mjs ("test runner (node --test)").
 * - Tham số opts: Object chứa cờ xác thực của dev server (devAuthEnabled) và của cấu hình build (buildAuthEnabled).
 * - Trả về: Object chứa status ("ok" | "diverged" | "indeterminate") và message giải thích chi tiết kết quả.
 */
export function compareAuthInvariant({ devAuthEnabled, buildAuthEnabled }) {
  const label = (value) => (value ? "on" : "off");
  // Bước 1: Nếu không đọc được trạng thái từ dev server (null hoặc undefined), trả về indeterminate thay vì ngộ nhận là trùng khớp.
  if (devAuthEnabled === null || devAuthEnabled === undefined) {
    return {
      status: "indeterminate",
      message: "[auth-invariant] could not read the dev server's resolved VITE_AUTH_ENABLED",
    };
  }
  // Bước 2: Cả dev server và bản build đều có cùng trạng thái bật/tắt sign-in -> đạt yêu cầu nhất quán ("ok").
  if (devAuthEnabled === buildAuthEnabled) {
    return {
      status: "ok",
      message: `[auth-invariant] dev and build agree: sign-in ${label(devAuthEnabled)}`,
    };
  }
  // Bước 3: Lệch pha cấu hình (một bên bật, một bên tắt) -> trả về diverged và hướng dẫn chạy app bằng `npm run dev` để nạp wrapper with-app-env.mjs.
  return {
    status: "diverged",
    message:
      `[auth-invariant] dev server has sign-in ${label(devAuthEnabled)} but the next ` +
      `build has it ${label(buildAuthEnabled)}. Start the app with \`npm run dev\` — ` +
      "invoking vite directly skips scripts/with-app-env.mjs, so the dev server and " +
      "the built output resolve .grok/app-env.json differently.",
  };
}

/**
 * Ask the dev server which env it resolved. Anything but a JSON object from
 * `/__app-env` (no server, a built-output preview, an older workspace without
 * the plugin) is "could not observe".
 */
/*
 * Làm gì: Gửi HTTP request đến endpoint /__app-env của dev server để đọc giá trị biến môi trường VITE_AUTH_ENABLED thực tế đang chạy.
 * Được gọi ở: scripts/browser-smoke.mjs (kiểm tra URL smoke test), scripts/check-auth-invariant.mjs (main), scripts/check-auth-invariant.test.mjs ("test runner (node --test)").
 * - Tham số devUrl: URL gốc của dev server cần kiểm tra (mặc định trỏ về DEFAULT_DEV_URL).
 * - Tham số fetchImpl: Hàm fetch HTTP (mặc định dùng fetch toàn cục, có thể truyền mock khi test).
 * - Trả về: Promise chứa boolean biểu thị trạng thái bật/tắt sign-in, hoặc null nếu không đọc được (lỗi mạng, HTTP không 200, hoặc phản hồi không phải JSON).
 */
export async function probeDevAuthEnabled(devUrl, fetchImpl = fetch) {
  let env;
  // Bước 1: Gửi request đến endpoint /__app-env và parse JSON phản hồi; trả về null nếu HTTP lỗi hoặc mất kết nối.
  try {
    const response = await fetchImpl(new URL(APP_ENV_ROUTE, devUrl).href);
    if (!response.ok) return null;
    env = JSON.parse(await response.text());
  } catch {
    return null;
  }
  // Bước 2: Xác thực dữ liệu trả về phải là một object JSON hợp lệ, tránh lỗi khi server trả về trang HTML preview.
  if (env === null || typeof env !== "object") return null;
  // Bước 3: Đọc cờ VITE_AUTH_ENABLED từ dữ liệu môi trường và quy đổi thành boolean.
  return authEnabledFromEnvValue(env.VITE_AUTH_ENABLED);
}

/** The smoke-verdict warnings for a comparison: a real divergence only. */
/*
 * Làm gì: Trích xuất danh sách cảnh báo cho báo cáo smoke test từ kết quả so sánh auth invariant; chỉ cảnh báo khi có sự lệch pha ("diverged").
 * Được gọi ở: scripts/browser-smoke.mjs (tổng hợp warnings cho verdict), scripts/check-auth-invariant.test.mjs ("test runner (node --test)").
 * - Tham số result: Kết quả trả về từ hàm compareAuthInvariant.
 * - Trả về: Mảng chứa chuỗi thông điệp cảnh báo nếu trạng thái là "diverged", ngược lại trả về mảng rỗng.
 */
export function authInvariantWarnings(result) {
  // Chỉ ghi nhận cảnh báo khi trạng thái thực sự lệch pha (diverged); bỏ qua khi ok hoặc indeterminate
  return result.status === "diverged" ? [result.message] : [];
}

/** What `vite build` / `vite preview` will resolve, via the same wrapper. */
/*
 * Làm gì: Xác định trạng thái bật/tắt xác thực mà các lệnh build/preview (vite build, vite preview) sẽ nhận được từ cấu hình file và biến môi trường.
 * Được gọi ở: scripts/browser-smoke.mjs (thu thập cấu hình build), scripts/check-auth-invariant.mjs (main), scripts/check-auth-invariant.test.mjs ("test runner (node --test)").
 * - Tham số root: Đường dẫn thư mục gốc của dự án (mặc định lấy từ projectRoot()).
 * - Tham số processEnv: Đối tượng biến môi trường hiện tại (mặc định lấy từ process.env).
 * - Trả về: true nếu bản build bật xác thực, ngược lại false.
 */
export function buildAuthEnabled(root = projectRoot(), processEnv = process.env) {
  // Bước 1: Đọc cấu hình từ .grok/app-env.json và gộp đè với processEnv thông qua wrapper with-app-env.mjs.
  const env = mergeAppEnv(readAppEnv(root), processEnv);
  // Bước 2: Chuyển đổi cờ VITE_AUTH_ENABLED đã hợp nhất sang giá trị boolean.
  return authEnabledFromEnvValue(env.VITE_AUTH_ENABLED);
}

/**
 * Làm gì: Điểm vào chính khi chạy CLI; kiểm tra tính nhất quán của cờ auth giữa dev server và bản build, in kết quả và thoát tiến trình với exit code tương ứng.
 * Được gọi ở: scripts/check-auth-invariant.mjs (dòng 108 khi chạy trực tiếp), scripts/auto-grade.mjs (chạy CLI qua shell), npm run check:auth.
 * - Tham số argv: Danh sách đối số dòng lệnh truyền vào (process.argv.slice(2)).
 * - Trả về: Promise<void>
 * - Lỗi có thể ném: Thoát tiến trình qua process.exit: mã 0 nếu đồng nhất ("ok"), mã 1 nếu lệch pha ("diverged"), mã 2 nếu không thể quan sát ("indeterminate").
 */
async function main(argv) {
  // Bước 1: Trích xuất tham số --dev-url từ dòng lệnh; nếu không truyền thì sử dụng URL mặc định (DEFAULT_DEV_URL).
  const devUrlFlag = argv.indexOf("--dev-url");
  const devUrl = devUrlFlag === -1 ? DEFAULT_DEV_URL : argv[devUrlFlag + 1];
  // Bước 2: Thăm dò cờ auth từ dev server đang chạy và so sánh với cấu hình dự kiến của bản build.
  const result = compareAuthInvariant({
    devAuthEnabled: await probeDevAuthEnabled(devUrl),
    buildAuthEnabled: buildAuthEnabled(),
  });
  // Bước 3: Nếu dev server và bản build thống nhất cấu hình ("ok"), in thông báo thành công và thoát tiến trình với mã 0.
  if (result.status === "ok") {
    console.log(result.message);
    process.exit(0);
  }
  // Bước 4: Nếu cấu hình bị lệch hoặc không thể quan sát, in thông báo lỗi ra stderr và thoát với mã 1 (diverged) hoặc mã 2 (indeterminate).
  console.error(result.message);
  process.exit(result.status === "diverged" ? 1 : 2);
}

// Chỉ thực thi hàm main khi file được chạy trực tiếp từ dòng lệnh (CLI), bỏ qua khi được module khác import.
if (isMainModule(import.meta.url)) {
  await main(process.argv.slice(2));
}
