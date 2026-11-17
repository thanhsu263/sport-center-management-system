#!/usr/bin/env node
/**
 * Run a command with `.grok/app-env.json` merged into its environment.
 *
 * `dev`, `build` and `preview` all route through this wrapper, so the dev
 * server, the built bundle and the preview server can never disagree about
 * `VITE_AUTH_ENABLED` — a divergence that only shows up as a built-output
 * mismatch long after the fact. Anything that starts Vite directly bypasses it.
 *
 * Only `VITE_`-prefixed keys are honored: the file is a build flag carrier, not
 * a secret store, and only `VITE_` vars reach the browser anyway. A real
 * `process.env` entry always wins, so an explicit override still works.
 *
 * That precedence also means the file governs this workspace only. A deployed
 * build runs with the provider's project env, where the deployer sets
 * `VITE_AUTH_ENABLED` itself (today unconditionally `"true"`), so the deployed
 * flag is the platform's, not this file's.
 *
 * Vite picks the values up because `loadEnv` prefix-matches entries already in
 * `process.env`, which is why the merge has to happen before Vite starts.
 */
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Làm gì: Đường dẫn tương đối từ thư mục gốc dự án đến file cấu hình môi trường (.grok/app-env.json).
 * Được gọi ở: scripts/with-app-env.mjs (readAppEnv), scripts/with-app-env.test.mjs (makeWorkspace, test runner (node --test)).
 */
export const APP_ENV_REL_PATH = ".grok/app-env.json";

// Tiền tố bắt buộc của biến môi trường phía client trong Vite; chỉ các biến có tiền tố VITE_ mới được nhúng vào bundle trình duyệt.
const VITE_PREFIX = "VITE_";

/**
 * Parse an app-env document, keeping only `VITE_`-prefixed string entries.
 * Anything unparseable is an empty environment — a workspace without the file
 * must behave exactly like today (auth on, no overrides).
 */
/*
 * Làm gì: Phân tích nội dung JSON của file app-env, chỉ lọc và giữ lại các biến môi trường có tiền tố VITE_ với giá trị kiểu chuỗi (string).
 * Được gọi ở: scripts/with-app-env.mjs (readAppEnv), scripts/with-app-env.test.mjs (test runner (node --test)).
 * - Tham số text: Chuỗi văn bản thô định dạng JSON đọc từ file cấu hình app-env.
 * - Trả về: Đối tượng chứa các cặp biến môi trường VITE_ hợp lệ, hoặc {} nếu nội dung rỗng, sai cú pháp JSON hoặc sai cấu trúc object.
 */
export function parseAppEnv(text) {
  let parsed;
  // Bước 1: Thử parse chuỗi JSON; nếu nội dung không hợp lệ hoặc rỗng thì trả về object rỗng {}.
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  // Bước 2: Kiểm tra dữ liệu sau khi parse phải là plain object hợp lệ (không phải null, kiểu nguyên thủy hay mảng array).
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  // Bước 3: Duyệt từng cặp key-value, chỉ giữ lại các biến có tiền tố VITE_ và giá trị là kiểu string để tránh lộ bí mật server.
  const env = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!key.startsWith(VITE_PREFIX)) continue;
    if (typeof value !== "string") continue;
    env[key] = value;
  }
  return env;
}

/** The app env recorded under `root`, or `{}` when the file is absent. */
/*
 * Làm gì: Đọc file .grok/app-env.json từ thư mục gốc chỉ định và parse các biến môi trường VITE_.
 * Được gọi ở: scripts/with-app-env.mjs (main), scripts/check-auth-invariant.mjs (buildAuthEnabled), scripts/with-app-env.test.mjs (test runner (node --test)).
 * - Tham số root: Đường dẫn tuyệt đối đến thư mục gốc dự án.
 * - Trả về: Đối tượng chứa các biến môi trường VITE_ đã lưu, hoặc {} nếu file không tồn tại hoặc không thể đọc.
 */
export function readAppEnv(root) {
  // Bước 1: Đọc nội dung file .grok/app-env.json dưới dạng UTF-8 rồi parse; nếu file không tồn tại hoặc lỗi đọc thì trả về {} an toàn.
  try {
    return parseAppEnv(readFileSync(join(root, APP_ENV_REL_PATH), "utf8"));
  } catch {
    return {};
  }
}

/** File values under the process environment: an explicit override wins. */
/*
 * Làm gì: Hợp nhất biến môi trường từ file app-env vào biến môi trường hệ thống (process.env), trong đó process.env luôn có quyền ưu tiên cao hơn.
 * Được gọi ở: scripts/with-app-env.mjs (main), scripts/check-auth-invariant.mjs (buildAuthEnabled), scripts/with-app-env.test.mjs (test runner (node --test)).
 * - Tham số appEnv: Đối tượng biến môi trường đọc từ file .grok/app-env.json.
 * - Tham số processEnv: Đối tượng biến môi trường hiện tại của hệ thống (thường là process.env).
 * - Trả về: Đối tượng biến môi trường đã gộp, ưu tiên giá trị được truyền trực tiếp từ process.env.
 */
export function mergeAppEnv(appEnv, processEnv) {
  // Gộp hai đối tượng; các giá trị trong processEnv đặt sau sẽ ghi đè giá trị trùng lặp từ appEnv.
  return { ...appEnv, ...processEnv };
}

/**
 * Translate a child's `exit` `(code, signal)` into this process's exit status.
 *
 * Do not re-raise the signal with `process.kill(process.pid, signal)`: under
 * qemu-user (amd64 image builds on an arm host) a self-directed signal is
 * routinely delivered as SIGSEGV to the wrong process, which takes down the
 * test worker and fails the image build. `128 + signo` is what a shell reports
 * for a signal-killed command, so a cancelled `vite build` is still a failure.
 */
/*
 * Làm gì: Chuyển đổi mã thoát (code) hoặc tín hiệu kết thúc (signal) của tiến trình con thành mã thoát thích hợp cho tiến trình cha theo quy ước shell (128 + signo).
 * Được gọi ở: scripts/with-app-env.mjs (main, sự kiện child exit), scripts/with-app-env.test.mjs (test runner (node --test)).
 * - Tham số code: Mã thoát số nguyên từ tiến trình con (hoặc null nếu bị dừng bởi signal).
 * - Tham số signal: Tên tín hiệu OS kết thúc tiến trình (ví dụ: 'SIGINT', 'SIGTERM'), hoặc null nếu thoát bình thường.
 * - Trả về: Mã thoát dạng số nguyên (0-255) phản ánh trạng thái kết thúc để trả về hệ điều hành.
 */
export function exitStatusFromChild(code, signal) {
  // Bước 1: Nếu tiến trình con bị dừng bởi signal (như Ctrl+C hoặc SIGTERM), tính mã thoát theo quy ước Unix shell (128 + số hiệu signal).
  if (signal) {
    const signo = osConstants.signals[signal];
    return 128 + (typeof signo === "number" ? signo : 1);
  }
  // Bước 2: Nếu thoát tự nhiên, trả về exit code của tiến trình con (hoặc mặc định 1 nếu code là null/undefined).
  return code ?? 1;
}

/** The workspace root (this file lives in `<root>/scripts/`). */
/*
 * Làm gì: Xác định đường dẫn tuyệt đối đến thư mục gốc của dự án dựa trên vị trí tệp with-app-env.mjs.
 * Được gọi ở: scripts/with-app-env.mjs (main), scripts/check-auth-invariant.mjs (buildAuthEnabled), scripts/check-auth-invariant.test.mjs, scripts/migration-plan.test.mjs, scripts/with-app-env.test.mjs (test runner (node --test)).
 * - Trả về: Đường dẫn tuyệt đối đến thư mục gốc dự án.
 */
export function projectRoot() {
  // Đi lên 2 cấp thư mục từ scripts/with-app-env.mjs để lấy thư mục gốc của workspace.
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * Whether `moduleUrl` is the script node was asked to run.
 *
 * Both sides are resolved through symlinks: node realpaths `import.meta.url`
 * but leaves `process.argv[1]` as typed, so comparing them raw makes a CLI
 * launched through a symlinked path (`/tmp` on macOS) a silent no-op.
 */
/*
 * Làm gì: Kiểm tra xem file script hiện tại có phải là điểm vào (entrypoint) được Node.js thực thi trực tiếp từ dòng lệnh hay không (xử lý chính xác cả symlink).
 * Được gọi ở: scripts/with-app-env.mjs (dòng 162), scripts/check-auth-invariant.mjs (dòng 107), scripts/seed-lively.mjs, scripts/with-app-env.test.mjs (test runner (node --test)).
 * - Tham số moduleUrl: Chuỗi URL của module cần kiểm tra (thường là import.meta.url).
 * - Trả về: true nếu file được chạy trực tiếp qua lệnh node, false nếu được import từ module khác hoặc không thể phân giải.
 */
export function isMainModule(moduleUrl) {
  // Bước 1: Lấy đường dẫn file entrypoint từ process.argv[1]; nếu không có thì script không được chạy trực tiếp.
  const entry = process.argv[1];
  if (!entry) return false;
  // Bước 2: Giải quyết đường dẫn thực qua realpathSync để so sánh chính xác kể cả khi khởi chạy thông qua đường dẫn symlink.
  try {
    return realpathSync(entry) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

/**
 * Merge a `.env` at the project root into this process's environment.
 *
 * `.grok/app-env.json` above only carries `VITE_`-prefixed build flags, and
 * nothing else in the workspace read `.env` at all — so a server-side secret
 * (`GEMINI_API_KEY`, and anything a payment or mail provider needs later) had
 * no way in on a developer machine except exporting it in the shell by hand.
 * The one fallback that did exist, `/workspace/.secrets/`, is a path from the
 * Linux build sandbox that does not exist on a Windows or macOS checkout.
 *
 * `process.loadEnvFile` is built into Node 22, so this costs no dependency. It
 * throws when the file is absent, which is the normal case and not an error.
 * Values already in the real environment win, matching `mergeAppEnv` below and
 * letting a deploy platform's own configuration override the file.
 */
/*
 * Làm gì: Nạp các biến môi trường và bí mật server từ file .env ở thư mục gốc vào process.env bằng tính năng gốc process.loadEnvFile của Node 22.
 * Được gọi ở: scripts/with-app-env.mjs (main, dòng 136).
 * - Tham số root: Đường dẫn tuyệt đối đến thư mục gốc dự án chứa file .env.
 * - Trả về: void
 */
function loadDotEnv(root) {
  // Sử dụng API process.loadEnvFile có sẵn của Node 22 để nạp file .env mà không cần cài thêm thư viện dotenv ngoài.
  try {
    process.loadEnvFile(join(root, ".env"));
  } catch {
    // No .env, or unreadable — the app runs on real environment variables.
  }
}

/**
 * Làm gì: Điểm vào chính của wrapper CLI; nạp cấu hình .env và app-env, chuẩn hóa tham số --port, khởi chạy lệnh con và chuyển tiếp các tín hiệu dừng.
 * Được gọi ở: scripts/with-app-env.mjs (dòng 163 khi chạy CLI), các script trong package.json ("npm run dev", "npm run build", "npm run preview").
 * - Tham số argv: Danh sách tham số dòng lệnh truyền vào (tên lệnh command và các tham số args đi kèm).
 * - Trả về: void
 * - Lỗi có thể ném: Thoát tiến trình qua process.exit: mã 2 nếu thiếu command, mã 127 nếu lỗi khởi chạy lệnh con, hoặc mã thoát từ lệnh con.
 */
function main(argv) {
  // Bước 1: Trích xuất lệnh cần chạy (command) và danh sách tham số (args); báo lỗi và thoát mã 2 nếu thiếu command.
  const [command, ...args] = argv;
  if (!command) {
    console.error("usage: node scripts/with-app-env.mjs <command> [args…]");
    process.exit(2);
  }
  // Bước 2: Nạp biến môi trường từ file .env và hợp nhất cấu hình từ .grok/app-env.json vào process.env.
  loadDotEnv(projectRoot());
  const env = mergeAppEnv(readAppEnv(projectRoot()), process.env);
  // When an override like `--port 8090` is appended, remove earlier `--port` arguments
  // so Vite's CLI parser doesn't turn `port` into an array [8080, 8090].
  // Bước 3: Lọc bỏ cờ --port phía trước nếu có cờ --port ghi đè ở phía sau, tránh việc Vite parse thành mảng cổng.
  const cleanedArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args.slice(i + 1).includes("--port")) {
      i++; // skip the flag and its value
      continue;
    }
    cleanedArgs.push(args[i]);
  }
  // Bước 4: Khởi chạy tiến trình con với biến môi trường đã gộp và gắn trực tiếp luồng I/O (stdio: inherit) vào terminal hiện tại.
  const child = spawn(command, cleanedArgs, { stdio: "inherit", env, shell: true });
  // The dev server is long-running and is stopped by signalling this wrapper.
  // Bước 5: Chuyển tiếp các tín hiệu ngắt (SIGINT, SIGTERM, SIGHUP) từ tiến trình cha sang tiến trình con để dọn dẹp sạch sẽ.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  // Bước 6: Xử lý lỗi khi không thể khởi chạy tiến trình con (lệnh không tồn tại hoặc thiếu quyền) và thoát với mã 127.
  child.on("error", (err) => {
    console.error(`[with-app-env] failed to run ${command}:`, err?.message || err);
    process.exit(127);
  });
  // Bước 7: Khi tiến trình con kết thúc, quy đổi exit code tương ứng và thoát tiến trình cha.
  child.on("exit", (code, signal) => {
    process.exit(exitStatusFromChild(code, signal));
  });
}

// Khởi chạy hàm main khi file được thực thi trực tiếp từ dòng lệnh CLI (không chạy khi được import từ file khác).
if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
