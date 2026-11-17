/**
 * Mục đích file:
 * File kiểm thử đơn vị (unit test) cho module scripts/check-auth-invariant.mjs.
 * Kiểm tra tính nhất quán của cờ xác thực VITE_AUTH_ENABLED giữa dev server và bản build,
 * đảm bảo phát hiện kịp thời sự bất đồng bộ trạng thái sign-in (bật/tắt) và xử lý đúng khi dev server không phản hồi.
 *
 * Vị trí trong hệ thống:
 * Được thực thi bởi test runner (node --test) trong lệnh `npm test` hoặc quy trình CI/QA,
 * bảo vệ tính bất biến (auth invariant) trước khi chạy smoke test trình duyệt và deploy ứng dụng.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  authEnabledFromEnvValue,
  authInvariantWarnings,
  buildAuthEnabled,
  compareAuthInvariant,
  probeDevAuthEnabled,
} from "./check-auth-invariant.mjs";
import { projectRoot } from "./with-app-env.mjs";

/**
 * The JSON body `/__app-env` would serve. Do not start a real Vite server —
 * `import { createServer } from "vite"` loads rolldown native bindings that
 * SIGSEGV the test worker under qemu-user (amd64 image builds).
 */
function appEnvFetch(env) {
  return async () => ({
    ok: true,
    text: async () => JSON.stringify(env),
  });
}

/**
 * Làm gì: Kiểm tra hàm authEnabledFromEnvValue ánh xạ giá trị biến môi trường VITE_AUTH_ENABLED đồng nhất với logic của src/server/auth (chỉ "false" là tắt, còn lại mặc định bật).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("the flag predicate matches src/server/auth", () => {
  // Chỉ chuỗi "false" mới tắt sign-in; chuỗi "true" hoặc undefined (chưa cấu hình) đều mặc định bật
  assert.equal(authEnabledFromEnvValue("false"), false);
  assert.equal(authEnabledFromEnvValue("true"), true);
  assert.equal(authEnabledFromEnvValue(undefined), true);
});

/**
 * Làm gì: Kiểm tra hàm probeDevAuthEnabled đọc chính xác giá trị VITE_AUTH_ENABLED="false" từ endpoint /__app-env của dev server đang chạy.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("reads the value a live dev server resolved", async () => {
  // Giả lập dev server trả về VITE_AUTH_ENABLED="false" và xác minh hàm probe đọc ra kết quả boolean false
  assert.equal(
    await probeDevAuthEnabled("http://127.0.0.1:8080", appEnvFetch({ VITE_AUTH_ENABLED: "false" })),
    false,
  );
});

/**
 * Làm gì: Kiểm tra dev server khi khởi động không có cờ môi trường (object rỗng) sẽ được nhận diện là bật sign-in (mặc định an toàn).
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("a server started without the flag reads as sign-in on", async () => {
  // Khi dev server không cấu hình cờ env ({}), authEnabledFromEnvValue(undefined) sẽ nhận định sign-in đang bật (true)
  assert.equal(await probeDevAuthEnabled("http://127.0.0.1:8080", appEnvFetch({})), true);
});

/**
 * Làm gì: Kiểm tra hàm compareAuthInvariant trả về trạng thái "ok" khi cả dev server và cấu hình build đều thống nhất giá trị bật/tắt đăng nhập.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("agreement passes", () => {
  // Cả dev và build đều cùng tắt (hoặc cùng bật) sign-in -> trạng thái đạt yêu cầu ("ok")
  assert.equal(
    compareAuthInvariant({ devAuthEnabled: false, buildAuthEnabled: false }).status,
    "ok",
  );
});

/**
 * Làm gì: Kiểm tra compareAuthInvariant trả về trạng thái "diverged" (lệch pha) và thông báo lỗi khi dev server và bản build có cấu hình sign-in trái ngược nhau.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("divergence fails in either direction", () => {
  // Bước 1: Kiểm tra trường hợp dev bật nhưng build tắt -> cảnh báo dev on / build off và trạng thái diverged
  const devOn = compareAuthInvariant({ devAuthEnabled: true, buildAuthEnabled: false });
  assert.equal(devOn.status, "diverged");
  assert.match(devOn.message, /dev server has sign-in on but the next build has it off/);
  // Bước 2: Kiểm tra trường hợp đảo ngược (dev tắt nhưng build bật) -> trạng thái vẫn phải là diverged
  assert.equal(
    compareAuthInvariant({ devAuthEnabled: false, buildAuthEnabled: true }).status,
    "diverged",
  );
});

/**
 * Làm gì: Kiểm tra khi dev server không phản hồi giá trị (devAuthEnabled là null), hệ thống phải trả về trạng thái "indeterminate" chứ không được coi là đồng nhất ("ok").
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("an unobservable dev server is indeterminate, not agreement", () => {
  // Không đọc được trạng thái dev (null) phải trả về "indeterminate" để tránh ngộ nhận là hợp lệ
  assert.equal(
    compareAuthInvariant({ devAuthEnabled: null, buildAuthEnabled: false }).status,
    "indeterminate",
  );
});

/**
 * Làm gì: Kiểm tra hàm probeDevAuthEnabled xử lý an toàn lỗi kết nối mạng (ECONNREFUSED) và trả về null thay vì gây crash.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("a dev server that cannot be reached probes as null", async () => {
  // Giả lập dev server không thể kết nối (ECONNREFUSED) và xác nhận hàm probe bắt lỗi rồi trả về null
  const unreachable = () => Promise.reject(new Error("ECONNREFUSED"));
  assert.equal(await probeDevAuthEnabled("http://127.0.0.1:1", unreachable), null);
});

/**
 * Làm gì: Kiểm tra probeDevAuthEnabled trả về null khi dev server trả về lỗi HTTP 404 hoặc trả về HTML thay vì chuỗi JSON mong đợi.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("a server without the endpoint probes as null, not as agreement", async () => {
  // Bước 1: Server trả về response không thành công (ok = false, ví dụ 404 Not Found) -> trả về null
  const notFound = async () => ({ ok: false, text: async () => "Not Found" });
  assert.equal(await probeDevAuthEnabled("http://127.0.0.1:8081", notFound), null);
  // Bước 2: Server trả về HTTP 200 nhưng nội dung là tài liệu HTML thay vì JSON (thường gặp ở bản preview) -> trả về null
  const html = async () => ({ ok: true, text: async () => "<!doctype html>" });
  assert.equal(await probeDevAuthEnabled("http://127.0.0.1:8081", html), null);
});

/**
 * Làm gì: Kiểm tra hàm authInvariantWarnings chỉ tạo mảng cảnh báo cho smoke test khi có sự lệch pha ("diverged"), bỏ qua khi trạng thái "ok" hoặc "indeterminate".
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("only a divergence warns the smoke verdict", () => {
  // Bước 1: Khi trạng thái là diverged, trả về mảng chứa nội dung thông báo lỗi để hiển thị cảnh báo
  const diverged = compareAuthInvariant({ devAuthEnabled: true, buildAuthEnabled: false });
  assert.deepEqual(authInvariantWarnings(diverged), [diverged.message]);
  // Bước 2: Khi trạng thái là ok hoặc indeterminate, mảng cảnh báo trả về phải rỗng (không chặn smoke test)
  for (const result of [
    compareAuthInvariant({ devAuthEnabled: false, buildAuthEnabled: false }),
    compareAuthInvariant({ devAuthEnabled: null, buildAuthEnabled: false }),
  ]) {
    assert.deepEqual(authInvariantWarnings(result), []);
  }
});

/**
 * Làm gì: Kiểm tra hàm buildAuthEnabled phân giải cấu hình mặc định từ file .grok/app-env.json của template và hỗ trợ biến môi trường processEnv ghi đè.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("the build side resolves the template's shipped app-env", () => {
  // Mặc định template dự án tắt auth ("false"); khi truyền biến môi trường ghi đè sẽ nhận giá trị mới
  assert.equal(buildAuthEnabled(projectRoot(), {}), false);
  assert.equal(buildAuthEnabled(projectRoot(), { VITE_AUTH_ENABLED: "true" }), true);
});

/**
 * Làm gì: Kiểm tra CLI check-auth-invariant.mjs khi được gọi thông qua đường dẫn symlink vẫn hoạt động chính xác và thoát mã lỗi 2, không bị kết thúc âm thầm (exit code 0).
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("the CLI reports rather than silently passing when run via a symlink", async () => {
  // A check whose exit code is the whole signal must never no-op to 0 because
  // process.argv[1] came in through a symlinked path.
  // Bước 1: Tạo thư mục tạm thời và tạo một symlink trỏ đến thư mục scripts của dự án
  const link = join(mkdtempSync(join(tmpdir(), "auth-invariant-link-")), "scripts");
  symlinkSync(join(projectRoot(), "scripts"), link);
  // Bước 2: Gọi CLI thông qua đường dẫn symlink kèm tham số trỏ tới cổng dev không tồn tại (127.0.0.1:1)
  const error = await promisify(execFile)(process.execPath, [
    join(link, "check-auth-invariant.mjs"),
    "--dev-url",
    "http://127.0.0.1:1",
  ]).catch((err) => err);
  // Bước 3: Xác minh CLI thoát với mã lỗi 2 (indeterminate) và xuất thông báo lỗi phù hợp ra stderr
  assert.equal(error.code, 2);
  assert.match(error.stderr, /could not read the dev server's resolved VITE_AUTH_ENABLED/);
});
