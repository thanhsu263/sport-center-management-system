/**
 * Mục đích file:
 * File kiểm thử đơn vị (unit test) cho module scripts/with-app-env.mjs.
 * Kiểm tra các tính năng: parse và đọc file cấu hình .grok/app-env.json (chỉ giữ biến có tiền tố VITE_),
 * cơ chế merge biến môi trường ưu tiên process.env, và hành vi bọc lệnh con (forward exit code, signal, symlink).
 *
 * Vị trí trong hệ thống:
 * Được thực thi bởi test runner (node --test) khi chạy kiểm thử tự động,
 * đảm bảo dev server, bản build và preview server luôn đồng bộ biến môi trường VITE_AUTH_ENABLED.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  APP_ENV_REL_PATH,
  mergeAppEnv,
  parseAppEnv,
  projectRoot,
  readAppEnv,
} from "./with-app-env.mjs";

const execFileAsync = promisify(execFile);
const WRAPPER = join(projectRoot(), "scripts/with-app-env.mjs");
const PRINT_FLAG = "process.stdout.write(String(process.env.VITE_AUTH_ENABLED));";

/**
 * Làm gì: Tạo thư mục workspace tạm thời và ghi file .grok/app-env.json giả lập để phục vụ kiểm thử.
 * Được gọi ở: scripts/with-app-env.test.mjs (trong các ca kiểm thử đọc cấu hình môi trường)
 * - Tham số appEnvJson: Nội dung JSON của file .grok/app-env.json (undefined nếu muốn test trường hợp không có file)
 * @returns {string} Đường dẫn tuyệt đối đến thư mục workspace tạm thời vừa tạo
 */
function makeWorkspace(appEnvJson) {
  // Bước 1: Tạo thư mục tạm thời độc lập để không ảnh hưởng đến cấu hình thật của dự án
  const root = mkdtempSync(join(tmpdir(), "app-env-"));
  // Bước 2: Nếu có nội dung cấu hình truyền vào, tạo thư mục con .grok và ghi file app-env.json
  if (appEnvJson !== undefined) {
    mkdirSync(join(root, ".grok"), { recursive: true });
    writeFileSync(join(root, APP_ENV_REL_PATH), appEnvJson);
  }
  // Bước 3: Trả về đường dẫn gốc của workspace tạm thời
  return root;
}

/**
 * Làm gì: Kiểm tra hàm parseAppEnv giữ lại đúng các biến môi trường dạng chuỗi có tiền tố VITE_.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("keeps VITE_-prefixed string entries", () => {
  // Xác minh chỉ các cặp key-value hợp lệ có tiền tố VITE_ mới được giữ lại
  assert.deepEqual(parseAppEnv('{"VITE_AUTH_ENABLED":"false"}'), {
    VITE_AUTH_ENABLED: "false",
  });
});

/**
 * Làm gì: Kiểm tra hàm parseAppEnv lọc bỏ các key không có tiền tố VITE_, các giá trị không phải chuỗi, và xử lý an toàn tài liệu JSON sai định dạng.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("drops non-VITE keys, non-string values and malformed documents", () => {
  // Bước 1: Lọc bỏ các key không có tiền tố VITE_ (như secret DATABASE_URL) và giá trị không phải chuỗi (số nguyên)
  assert.deepEqual(parseAppEnv('{"DATABASE_URL":"postgres://x","VITE_N":1,"VITE_OK":"y"}'), {
    VITE_OK: "y",
  });
  // Bước 2: Trả về object rỗng nếu nội dung không phải JSON hợp lệ, dạng mảng hoặc giá trị null
  assert.deepEqual(parseAppEnv("not json"), {});
  assert.deepEqual(parseAppEnv('["VITE_AUTH_ENABLED"]'), {});
  assert.deepEqual(parseAppEnv("null"), {});
});

/**
 * Làm gì: Kiểm tra hàm readAppEnv trả về object rỗng an toàn khi file .grok/app-env.json không tồn tại.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("a missing app-env.json is a clean no-op", () => {
  // Khi không tìm thấy file cấu hình trong workspace, trả về object rỗng mà không ném lỗi
  assert.deepEqual(readAppEnv(makeWorkspace()), {});
});

/**
 * Làm gì: Kiểm tra hàm readAppEnv đọc và phân giải chính xác dữ liệu từ file .grok/app-env.json trong workspace.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("reads the app env from a workspace", () => {
  // Tạo workspace tạm có file cấu hình và xác minh readAppEnv trích xuất chính xác cặp key-value
  const root = makeWorkspace('{"VITE_AUTH_ENABLED":"false"}');
  assert.deepEqual(readAppEnv(root), { VITE_AUTH_ENABLED: "false" });
});

/**
 * Làm gì: Kiểm tra hàm mergeAppEnv cho phép biến môi trường thực tế (process.env) ghi đè lên cấu hình trong file.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("an explicit process-env override wins over the file", () => {
  // Hợp nhất cấu hình từ file và process.env; biến từ process.env luôn có độ ưu tiên cao nhất khi trùng key
  const merged = mergeAppEnv(
    { VITE_AUTH_ENABLED: "false" },
    { VITE_AUTH_ENABLED: "true", PATH: "/usr/bin" },
  );
  assert.equal(merged.VITE_AUTH_ENABLED, "true");
  assert.equal(merged.PATH, "/usr/bin");
});

/**
 * Làm gì: Kiểm tra file cấu hình mặc định của template repository luôn đặt trạng thái tắt xác thực (VITE_AUTH_ENABLED="false").
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("the template ships auth off", () => {
  // Mặc định template dự án tắt auth để tránh áp đặt cơ chế đăng nhập khi chưa cần thiết
  assert.deepEqual(readAppEnv(projectRoot()), { VITE_AUTH_ENABLED: "false" });
});

/**
 * Làm gì: Kiểm tra cơ chế giải quyết biến của Vite loadEnv đối với các giá trị được gộp trước khi Vite khởi chạy.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("vite loadEnv resolves the wrapped value", () => {
  // What `import.meta.env.VITE_AUTH_ENABLED` becomes: loadEnv prefix-matches
  // process.env, so the wrapper's merge has to land before Vite starts.
  // Do not `import { loadEnv } from "vite"` here — Vite 8 loads rolldown
  // native bindings that SIGSEGV the test worker under qemu-user.
  // Mô phỏng việc hợp nhất biến cấu hình vào môi trường tiến trình trước khi Vite nạp env
  const root = makeWorkspace('{"VITE_AUTH_ENABLED":"false"}');
  const merged = mergeAppEnv(readAppEnv(root), { PATH: "/usr/bin" });
  assert.equal(merged.VITE_AUTH_ENABLED, "false");
});

/**
 * Làm gì: Kiểm tra lệnh con được bọc bởi scripts/with-app-env.mjs nhận đầy đủ các biến môi trường từ file cấu hình.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("the wrapped command runs with the app env applied", async () => {
  // Khởi chạy tiến trình node con qua script wrapper và kiểm tra giá trị process.env nhận được
  const { stdout } = await execFileAsync(process.execPath, [
    WRAPPER,
    process.execPath,
    "-e",
    PRINT_FLAG,
  ]);
  assert.equal(stdout, "false");
});

/**
 * Làm gì: Kiểm tra lệnh con bọc bởi wrapper ưu tiên nhận biến môi trường truyền trực tiếp thay vì giá trị từ file cấu hình.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("the wrapped command sees an explicit override, not the file value", async () => {
  // Truyền biến môi trường ghi đè khi gọi wrapper và kiểm tra tiến trình con nhận giá trị mới nhất
  const { stdout } = await execFileAsync(
    process.execPath,
    [WRAPPER, process.execPath, "-e", PRINT_FLAG],
    { env: { ...process.env, VITE_AUTH_ENABLED: "true" } },
  );
  assert.equal(stdout, "true");
});

/**
 * Làm gì: Kiểm tra script wrapper chuyển tiếp nguyên vẹn mã thoát (exit code) của lệnh con ra tiến trình ngoài khi có lỗi.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("the wrapper propagates the command's exit code", async () => {
  // Lệnh con chủ động thoát với exit code 3, xác minh wrapper chuyển tiếp chính xác mã lỗi 3 này
  await assert.rejects(
    execFileAsync(process.execPath, [WRAPPER, process.execPath, "-e", "process.exit(3)"]),
    (err) => err.code === 3,
  );
});

/**
 * Làm gì: Kiểm tra lệnh con bị dừng bởi signal (như SIGTERM) không bao giờ bị báo thành công (exit code 0), đảm bảo build bị hủy sẽ bị chặn lại.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("a signal-killed command is never reported as success", async () => {
  // The wrapper's own SIGTERM handler must not swallow the re-raised signal:
  // a cancelled build reporting exit 0 is a silently passing gate.
  // Giả lập tiến trình con nhận signal SIGTERM và kiểm tra wrapper báo lỗi thay vì coi là thành công
  await assert.rejects(
    execFileAsync(process.execPath, [
      WRAPPER,
      process.execPath,
      "-e",
      "process.kill(process.pid, 'SIGTERM');setTimeout(() => {}, 1000);",
    ]),
    (err) => err.signal === "SIGTERM" || err.code !== 0,
  );
});

/**
 * Làm gì: Kiểm tra CLI with-app-env.mjs vẫn nhận diện đúng file chính và hoạt động chính xác khi được gọi thông qua đường dẫn symlink.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("the CLI still runs when invoked through a symlinked path", async () => {
  // node realpaths import.meta.url but not process.argv[1], so a raw comparison
  // turns the wrapper into a no-op that exits 0 without starting anything.
  // Bước 1: Tạo symlink trỏ đến thư mục scripts trong một thư mục tạm thời
  const link = join(mkdtempSync(join(tmpdir(), "app-env-link-")), "scripts");
  symlinkSync(join(projectRoot(), "scripts"), link);
  // Bước 2: Thực thi script qua đường dẫn symlink và kiểm tra lệnh con vẫn chạy và in kết quả chính xác
  const { stdout } = await execFileAsync(process.execPath, [
    join(link, "with-app-env.mjs"),
    process.execPath,
    "-e",
    PRINT_FLAG,
  ]);
  assert.equal(stdout, "false");
});
