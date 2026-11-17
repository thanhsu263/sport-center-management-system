#!/usr/bin/env node
/**
 * Owns :8081, the built-output QA preview.
 *
 * `vite preview` is strictPort, so a preview left over from an earlier turn
 * both fails the next start and keeps serving the previous build's output.
 * Every restart therefore kills the current port owner first, whoever started
 * it. Owners come from /proc, so this runs only inside the Linux sandbox.
 *
 *   node scripts/preview.mjs stop|restart
 */
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Cổng HTTP dành riêng cho preview bản build production (Vite preview chạy strictPort trên cổng 8081).
const PREVIEW_PORT = 8081;
// URL loopback cục bộ dùng để kiểm tra tính sẵn sàng (health check) của preview server.
const PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}/`;

// Đường dẫn tới thư mục gốc của dự án (đi lên một cấp từ thư mục scripts/).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// File lưu PID của tiến trình preview đang chạy ngầm (.grok/preview.pid) để dọn dẹp khi khởi động lại.
const PID_FILE = join(ROOT, ".grok/preview.pid");
// File ghi toàn bộ stdout và stderr của tiến trình preview (.grok/preview.log) phục vụ tra cứu lỗi.
const LOG_FILE = join(ROOT, ".grok/preview.log");
// Thời gian chờ tối đa (mặc định 60 giây) để preview server khởi động và phản hồi request HTTP.
const READY_TIMEOUT_MS = Number(process.env.PREVIEW_READY_TIMEOUT_MS || 60000);
// Thời gian chờ ân hạn (3 giây) sau khi gửi SIGTERM trước khi buộc phải dùng SIGKILL.
const GRACE_MS = 3000;
// Khoảng thời gian giãn cách (100ms) giữa các lần kiểm tra tiến trình đã thoát hay chưa.
const POLL_MS = 100;

/**
 * Làm gì: Phân tích các đối số dòng lệnh CLI; chỉ chấp nhận đúng một hành động là "stop" hoặc "restart".
 * Được gọi ở: scripts/preview.mjs (dòng 343 khi thực thi qua CLI), scripts/preview.test.mjs ("test runner (node --test)").
 * - Tham số argv: Mảng tham số dòng lệnh truyền vào (thường là process.argv.slice(2)).
 * - Trả về: Object chứa { action } nếu tham số hợp lệ, hoặc { error } nếu thiếu/sai tham số.
 */
export function parsePreviewArgs(argv) {
  // Bước 1: Tách tham số hành động đầu tiên và các tham số còn lại trong mảng argv.
  const [action, ...rest] = argv;
  // Bước 2: Kiểm tra tính hợp lệ: bắt buộc có action, không nhận tham số thừa, và action phải là stop hoặc restart.
  if (!action) return { error: "usage: node scripts/preview.mjs stop|restart" };
  if (rest.length > 0) return { error: `unexpected argument: ${rest[0]}` };
  if (!["stop", "restart"].includes(action)) {
    return { error: `unknown action: ${action} (expected stop or restart)` };
  }
  return { action };
}

/**
 * Làm gì: Chuyển đổi chuỗi văn bản thành mã PID dạng số nguyên; loại trừ PID 1 vì là tiến trình init của sandbox.
 * Được gọi ở: scripts/preview.mjs (trong readPidFile và pidsForSocketInodes), scripts/preview.test.mjs ("test runner (node --test)").
 * - Tham số text: Chuỗi văn bản hoặc giá trị cần chuyển đổi sang số nguyên PID.
 * - Trả về: Mã PID hợp lệ (> 1) dạng số nguyên, hoặc null nếu không hợp lệ.
 */
export function parsePid(text) {
  const pid = Number.parseInt(String(text ?? "").trim(), 10);
  // pid 1 is the sandbox init — never the preview, and dangerous to signal.
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

/** pgid of a process from its /proc/<pid>/stat line. */
export function parsePgid(stat) {
  const line = String(stat ?? "");
  // The comm field is parenthesised and may itself contain spaces; state, ppid
  // and pgrp are the three fields after it.
  // Bước 1: Tìm vị trí dấu đóng ngoặc ") " cuối cùng của trường comm (tên tiến trình) để định vị các trường phía sau.
  const end = line.lastIndexOf(") ");
  if (end === -1) return null;
  // Bước 2: Trích xuất trường thứ 3 sau tên tiến trình (chính là pgrp/pgid) và chuyển thành số nguyên dương.
  const pgid = Number.parseInt(line.slice(end + 2).split(/\s+/)[2], 10);
  return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
}

// Mã trạng thái kết nối TCP LISTEN ("0A" ở dạng hex) trong file /proc/net/tcp và tcp6.
const TCP_LISTEN = "0A";

/** Socket inodes of the LISTEN sockets on `port` in a /proc/net/tcp{,6} dump. */
export function parseListenerInodes(procNetTcp, port) {
  // Bước 1: Chuyển đổi số cổng sang chuỗi hex 4 ký tự viết hoa (ví dụ 8081 -> ":1F91") để so khớp với địa chỉ local_address.
  const wanted = `:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  const inodes = [];
  // Bước 2: Duyệt từng dòng trong dump /proc/net/tcp, lọc các socket có trạng thái LISTEN (0A) trên đúng cổng cần tìm.
  for (const line of String(procNetTcp ?? "").split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10 || cols[3] !== TCP_LISTEN || !cols[1].endsWith(wanted)) continue;
    // Cột thứ 10 (chỉ số 9) trong bảng socket là mã inode của socket đang lắng nghe.
    if (/^\d+$/.test(cols[9])) inodes.push(cols[9]);
  }
  return inodes;
}

/**
 * Làm gì: Kiểm tra chuỗi dòng lệnh của tiến trình xem có phải là tiến trình preview server (npm run preview hoặc vite preview) hay không.
 * Được gọi ở: scripts/preview.mjs (trong previewOwners), scripts/preview.test.mjs ("test runner (node --test)").
 * - Tham số cmdline: Chuỗi dòng lệnh đọc từ /proc/<pid>/cmdline (các tham số ngăn cách bởi ký tự NUL \0).
 * - Trả về: boolean True nếu là tiến trình npm run preview hoặc vite preview, ngược lại false.
 */
export function looksLikePreviewProcess(cmdline) {
  // /proc/<pid>/cmdline is NUL-separated.
  // Bước 1: Tách các đối số được phân tách bằng ký tự NUL (\0) và nối lại thành chuỗi dòng lệnh hoàn chỉnh.
  const argv = String(cmdline ?? "")
    .split("\0")
    .filter(Boolean)
    .join(" ");
  // The sandbox service runs scripts/preview-thumbnail.mjs in this box, and
  // this script can be running concurrently: neither is ever a target.
  // Bỏ qua các script công cụ (preview.mjs, preview-thumbnail.mjs) để tránh dừng nhầm chính mình hoặc script đang chạy song song.
  if (/\bpreview[\w-]*\.mjs\b/.test(argv)) return false;
  // The `npm run preview` wrapper (`npm-cli.js run preview`) and its vite child.
  // `preview` must be the whole script name: `run preview:stop`/`preview:restart`
  // are this tooling's own wrappers, and `vite build --outDir preview-dist` is
  // not a server.
  // Bước 2: Nhận diện tiến trình phục vụ preview dựa vào mẫu lệnh "run preview" hoặc "vite preview".
  return /\brun\s+preview(?:\s|$)/.test(argv) || /\bvite\b\s+preview\b/.test(argv);
}

/**
 * Pids to signal. Port owners are owners by definition; the pidfile pid is only
 * a claim left by an earlier run — pids are re-used across hibernate/revive, so
 * signal it only when its command line still looks like the preview.
 */
export function previewOwners({ portPids, pidFilePid, cmdlineOf }) {
  // Bước 1: Tập hợp tất cả các PID đang thực sự mở socket lắng nghe trên cổng 8081.
  const owners = new Set(portPids);
  // Bước 2: Kiểm tra thêm PID lưu trong file pidfile; nếu chưa có trong danh sách nhưng cmdline khớp với preview thì bổ sung vào.
  if (
    pidFilePid !== null &&
    !owners.has(pidFilePid) &&
    looksLikePreviewProcess(cmdlineOf(pidFilePid))
  ) {
    owners.add(pidFilePid);
  }
  return [...owners];
}

/**
 * Làm gì: Chờ đợi danh sách tiến trình (PID) thoát hoàn toàn trong khoảng thời gian timeout định trước.
 * Được gọi ở: scripts/preview.mjs (trong terminatePids).
 * - Tham số pids: Mảng các mã tiến trình (PID) cần chờ thoát.
 * - Tham số options: Object chứa hàm kiểm tra isAlive, hàm sleep, thời gian timeout (timeoutMs) và chu kỳ thăm dò (pollMs).
 * - Trả về: Promise chứa mảng các PID vẫn còn sống sau khi hết thời gian chờ.
 */
async function waitForExit(pids, { isAlive, sleep, timeoutMs, pollMs }) {
  // Bước 1: Lọc ra các tiến trình hiện vẫn còn đang chạy.
  let remaining = pids.filter((pid) => isAlive(pid));
  // Bước 2: Thăm dò định kỳ sau mỗi pollMs cho đến khi tất cả tiến trình đã thoát hoặc vượt quá timeoutMs.
  for (let waited = 0; remaining.length > 0 && waited < timeoutMs; waited += pollMs) {
    await sleep(pollMs);
    remaining = remaining.filter((pid) => isAlive(pid));
  }
  return remaining;
}

/**
 * SIGTERM every live pid, then SIGKILL whatever outlives the grace period.
 * Returns `{ signalled, killed, stubborn }` — `stubborn` is still alive after
 * the SIGKILL wait, which means the port is not reliably free.
 */
export async function terminatePids(
  pids,
  { kill, isAlive, sleep, graceMs = GRACE_MS, pollMs = POLL_MS },
) {
  // Bước 1: Gửi tín hiệu SIGTERM yêu cầu dừng an toàn tới toàn bộ các tiến trình đang sống.
  const signalled = pids.filter((pid) => isAlive(pid));
  for (const pid of signalled) kill(pid, "SIGTERM");
  // Bước 2: Chờ trong thời gian ân hạn graceMs; nếu tiến trình nào chưa thoát thì gửi tiếp SIGKILL để buộc dừng ngay lập tức.
  const killed = await waitForExit(signalled, { isAlive, sleep, timeoutMs: graceMs, pollMs });
  for (const pid of killed) kill(pid, "SIGKILL");
  // Bước 3: Chờ tiếp một khoảng thời gian ân hạn nữa để phát hiện những tiến trình ngoan cố không thể tắt.
  const stubborn = await waitForExit(killed, { isAlive, sleep, timeoutMs: graceMs, pollMs });
  return { signalled, killed, stubborn };
}

/**
 * What `stop` reports. `after` is the post-kill port check: `unattributed: true`
 * means a listener exists whose pid could not be resolved, so it may not claim
 * the port is free.
 */
export function stopOutcome({ signalled, stubborn, after }) {
  // Bước 1: Gộp các PID không thể tắt và các PID mới xuất hiện đang giữ cổng.
  const held = [...new Set([...stubborn, ...after.pids])];
  if (held.length > 0) {
    return { ok: false, error: `port ${PREVIEW_PORT} is still held by pid(s) ${held.join(", ")}` };
  }
  // Bước 2: Cảnh báo nếu cổng vẫn bị chiếm bởi tiến trình không thể phân giải PID (do giới hạn quyền đọc /proc/<pid>/fd).
  if (after.unattributed) {
    return {
      ok: false,
      error: `port ${PREVIEW_PORT} is held by a process this script cannot see`,
    };
  }
  // Bước 3: Trả về kết quả thành công kèm thông điệp chi tiết nếu cổng đã hoàn toàn được giải phóng.
  const message =
    signalled.length > 0
      ? `stopped pid(s) ${signalled.join(", ")} — port ${PREVIEW_PORT} is free`
      : `nothing was listening on ${PREVIEW_PORT}`;
  return { ok: true, message };
}

/**
 * Làm gì: Tạm dừng thực thi luồng bất đồng bộ trong một khoảng thời gian nhất định (Promise wrapper cho setTimeout).
 * Được gọi ở: scripts/preview.mjs (trong terminatePids, waitForExit, waitForReady).
 * - Tham số ms: Thời gian cần tạm dừng tính bằng millisecond.
 * - Trả về: Promise giải quyết sau khoảng thời gian ms.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Làm gì: Kiểm tra xem một tiến trình có còn sống hay không bằng cách gửi tín hiệu signal 0.
 * Được gọi ở: scripts/preview.mjs (trong terminatePids, waitForExit, và stop).
 * - Tham số pid: Mã tiến trình cần kiểm tra sự tồn tại.
 * - Trả về: boolean True nếu tiến trình còn hoạt động (kể cả lỗi EPERM do không đủ quyền gửi tín hiệu), false nếu không tồn tại.
 */
function isAlive(pid) {
  try {
    // Signal 0 không kết thúc tiến trình mà chỉ kiểm tra tính hợp lệ; lỗi EPERM nghĩa là tiến trình vẫn sống nhưng thuộc quyền user khác.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Làm gì: Lấy process group ID (PGID) của một tiến trình từ nội dung file /proc/<pid>/stat.
 * Được gọi ở: scripts/preview.mjs (trong killPid).
 * - Tham số pid: Mã tiến trình cần tra cứu PGID.
 * - Trả về: Số nguyên PGID nếu đọc thành công, hoặc null nếu tiến trình đã chết hoặc không đọc được file.
 */
function pgidOf(pid) {
  try {
    return parsePgid(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Làm gì: Gửi tín hiệu dừng (SIGTERM/SIGKILL) tới process group nếu PID là nhóm trưởng, hoặc gửi tới chính PID đó.
 * Được gọi ở: scripts/preview.mjs (trong stop, truyền vào terminatePids).
 * - Tham số pid: Mã tiến trình cần dừng.
 * - Tham số signal: Tên tín hiệu cần gửi ("SIGTERM" hoặc "SIGKILL").
 * - Trả về: Không trả về giá trị (void).
 */
function killPid(pid, signal) {
  // restart() detaches the server into its own process group, so signal the
  // group to reach `vite` under the `npm` wrapper. Only for a leader: `-pid` on
  // a pid that leads no group still reaches any unrelated group numbered pid.
  // Bước 1: Nếu PID là process group leader (pgid === pid), gửi tín hiệu âm (-pid) để dừng cả npm và tiến trình con vite bên dưới.
  if (pgidOf(pid) === pid) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The group exited between the pgid read and the signal.
    }
  }
  // Bước 2: Nếu không phải trưởng nhóm hoặc gửi theo nhóm thất bại, gửi tín hiệu trực tiếp tới PID đơn lẻ.
  try {
    process.kill(pid, signal);
  } catch {
    // Exited between the liveness check and the signal.
  }
}

/**
 * Làm gì: Đọc toàn bộ chuỗi dòng lệnh khởi chạy của tiến trình từ file /proc/<pid>/cmdline.
 * Được gọi ở: scripts/preview.mjs (trong stop, truyền vào previewOwners).
 * - Tham số pid: Mã tiến trình cần đọc dòng lệnh.
 * - Trả về: Chuỗi dòng lệnh của tiến trình, hoặc chuỗi rỗng nếu tiến trình không tồn tại/đã kết thúc.
 */
function cmdlineOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    // Usually a dead pid — the stale pidfile this corroboration exists for.
    return "";
  }
}

/**
 * Làm gì: Đọc và parse mã PID của preview server từ file .grok/preview.pid do lần chạy trước ghi lại.
 * Được gọi ở: scripts/preview.mjs (trong stop).
 * - Trả về: Mã PID hợp lệ dạng số nguyên nếu đọc thành công, ngược lại trả về null.
 */
function readPidFile() {
  try {
    return parsePid(readFileSync(PID_FILE, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Làm gì: Quét thư mục /proc/<pid>/fd để tìm tất cả các PID của tiến trình đang mở socket có inode nằm trong danh sách cần tìm.
 * Được gọi ở: scripts/preview.mjs (trong portOwners).
 * - Tham số inodes: Danh sách hoặc Set chứa các chuỗi mã inode của socket.
 * - Trả về: Mảng các mã PID đang sở hữu ít nhất một socket trong danh sách inodes.
 */
function pidsForSocketInodes(inodes) {
  // Bước 1: Định dạng các inode mục tiêu thành dạng chuỗi "socket:[<inode>]" để so khớp với kết quả readlink.
  const targets = new Set([...inodes].map((inode) => `socket:[${inode}]`));
  const pids = [];
  // Bước 2: Quét qua tất cả thư mục PID trong /proc (loại trừ chính PID của script hiện tại).
  for (const entry of readdirSync("/proc")) {
    const pid = parsePid(entry);
    if (pid === null || pid === process.pid) continue;
    let fds;
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      // Exited mid-scan, or owned by another user.
      continue;
    }
    // Bước 3: Đọc liên kết tượng trưng (symlink) của từng file descriptor trong /proc/<pid>/fd để kiểm tra socket.
    for (const fd of fds) {
      try {
        if (targets.has(readlinkSync(`/proc/${pid}/fd/${fd}`))) {
          pids.push(pid);
          break;
        }
      } catch {
        // fd closed mid-scan.
      }
    }
  }
  return pids;
}

/**
 * `{ pids, unattributed }` — `unattributed: true` when the port has a listener
 * whose owning pid could not be resolved (an fd dir we may not read).
 */
function portOwners() {
  // Bước 1: Thu thập tất cả các socket inode đang mở cổng PREVIEW_PORT từ cả hai bảng IPv4 (/proc/net/tcp) và IPv6 (/proc/net/tcp6).
  const inodes = new Set();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let dump;
    try {
      dump = readFileSync(file, "utf8");
    } catch {
      // tcp6 is absent when the box has no IPv6.
      continue;
    }
    for (const inode of parseListenerInodes(dump, PREVIEW_PORT)) inodes.add(inode);
  // Bước 2: Tìm các PID sở hữu các socket inode đó; đánh dấu unattributed nếu có socket nhưng không tìm được PID tương ứng.
  }
  const pids = inodes.size > 0 ? pidsForSocketInodes(inodes) : [];
  return { pids, unattributed: inodes.size > 0 && pids.length === 0 };
}

/**
 * Làm gì: Tìm và dừng toàn bộ các tiến trình đang chiếm cổng preview 8081, sau đó xoá file PID để giải phóng cổng.
 * Được gọi ở: scripts/preview.mjs (trong restart, và khi gọi CLI với tham số "stop" ở dòng 352).
 * - Tham số announce: Cờ cho phép in thông điệp kết quả ra console (mặc định true).
 * - Trả về: Promise giải quyết thành boolean: true nếu cổng đã được giải phóng thành công, false nếu vẫn còn tiến trình giữ cổng.
 */
async function stop(announce = true) {
  // Bước 1: Xác định danh sách các tiến trình cần dừng kết hợp từ người giữ cổng thực tế và PID lưu trong file.
  const owners = previewOwners({
    portPids: portOwners().pids,
    pidFilePid: readPidFile(),
    cmdlineOf,
  });
  // Bước 2: Gửi tín hiệu dừng (SIGTERM trước, SIGKILL sau) đến tất cả các tiến trình mục tiêu.
  const { signalled, stubborn } = await terminatePids(owners, { kill: killPid, isAlive, sleep });

  // Bước 3: Đánh giá kết quả sau khi dừng; nếu cổng đã giải phóng thì xoá file PID và in thông báo.
  const outcome = stopOutcome({ signalled, stubborn, after: portOwners() });
  if (!outcome.ok) {
    // Keep the pidfile: a survivor the port scan cannot attribute leaves it as
    // the only record a retry could use.
    console.error(`[preview] ${outcome.error}`);
    return false;
  }
  rmSync(PID_FILE, { force: true });
  if (announce) console.log(`[preview] ${outcome.message}`);
  return true;
}

/**
 * Làm gì: Thăm dò gửi request HTTP đến PREVIEW_URL cho đến khi server phản hồi hoặc hết thời gian timeout.
 * Được gọi ở: scripts/preview.mjs (trong restart ở dòng 326).
 * - Tham số failure: Hàm kiểm tra trả về thông điệp lỗi nếu tiến trình con gặp lỗi spawn hoặc thoát sớm.
 * - Trả về: Promise giải quyết thành boolean: true nếu server đã phản hồi HTTP, false nếu quá thời gian chờ hoặc tiến trình bị lỗi.
 */
async function waitForReady(failure) {
  // Bước 1: Thiết lập thời điểm hết hạn (deadline) dựa vào cấu hình READY_TIMEOUT_MS (mặc định 60 giây).
  const deadline = Date.now() + READY_TIMEOUT_MS;
  // Bước 2: Thăm dò HTTP mỗi 250ms; bất kỳ phản hồi HTTP nào (kể cả 404) đều chứng minh server đã bind thành công vào cổng.
  while (Date.now() < deadline && failure() === null) {
    try {
      // Any HTTP response means the server is bound; a 404 is still ready.
      await fetch(PREVIEW_URL, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      await sleep(250);
    }
  }
  return false;
}

/**
 * Làm gì: Khởi động lại preview server: dừng server cũ, đồng bộ file nhị phân pglite nếu có, spawn tiến trình "npm run preview" ngầm và chờ server sẵn sàng.
 * Được gọi ở: scripts/preview.mjs (khi chạy CLI với tham số "restart" ở dòng 352, lệnh npm run preview:restart).
 * - Trả về: Promise giải quyết thành exit code số nguyên (0 nếu thành công, 1 nếu thất bại).
 */
async function restart() {
  // Bước 1: Dừng tiến trình preview cũ đang chiếm cổng; nếu không thể giải phóng cổng thì dừng ngay.
  if (!(await stop())) return 1;

  // Bước 2: Đồng bộ các file nhị phân WebAssembly của PGlite (.data, .wasm) vào thư mục build serverless của Vercel nếu có.
  const pgliteDest = join(ROOT, ".vercel/output/functions/__server.func/_libs");
  const pgliteSrc = join(ROOT, "node_modules/@electric-sql/pglite/dist");
  if (existsSync(pgliteDest)) {
    for (const f of ["pglite.data", "pglite.wasm", "initdb.wasm"]) {
      const from = join(pgliteSrc, f);
      if (existsSync(from)) copyFileSync(from, join(pgliteDest, f));
    }
  }

  // Bước 3: Tạo thư mục log nếu chưa có, mở file log và spawn tiến trình độc lập (detached) chạy "npm run preview".
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  const log = openSync(LOG_FILE, "a");
  const child = spawn("npm", ["run", "preview"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  writeFileSync(PID_FILE, `${child.pid}\n`);

  // Bước 4: Đăng ký các bộ lắng nghe sự kiện lỗi spawn và thoát sớm để bắt kịp nguyên nhân thất bại.
  let failure = null;
  child.on("error", (err) => {
    failure = `npm run preview could not be spawned: ${err.message}`;
  });
  child.on("exit", (code, signal) => {
    failure = `npm run preview exited early (${signal ?? `code ${code}`})`;
  });

  // Bước 5: Chờ preview server phản hồi HTTP; nếu quá thời gian chờ mà chưa sẵn sàng thì dọn dẹp tắt tiến trình và thoát với mã lỗi 1.
  if (!(await waitForReady(() => failure))) {
    const secs = Math.round(READY_TIMEOUT_MS / 1000);
    const why =
      failure ??
      `nothing answered on ${PREVIEW_URL} within ${secs}s — check that vite.config.ts ` +
        `still sets preview.port ${PREVIEW_PORT}`;
    console.error(`[preview] ${why} — see ${LOG_FILE}`);
    // A server that binds a few seconds later would serve a build the agent has
    // already been told to distrust.
    await stop(false);
    return 1;
  }
  console.log(`[preview] serving ${PREVIEW_URL} (pid ${child.pid}, log ${LOG_FILE})`);
  return 0;
}

// Khối thực thi chính khi script được chạy trực tiếp từ dòng lệnh CLI (node scripts/preview.mjs stop|restart).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Bước 1: Phân tích tham số dòng lệnh CLI và kiểm tra lỗi cú pháp.
  const args = parsePreviewArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`[preview] ${args.error}`);
    process.exit(1);
  }
  // Bước 2: Kiểm tra hệ thống file /proc; script chỉ hoạt động trên môi trường Linux sandbox có /proc.
  if (!existsSync("/proc/self")) {
    console.error("[preview] no /proc — this script only runs inside the sandbox");
    process.exit(1);
  }
  // Bước 3: Điều hướng thực thi hành động tương ứng: gọi stop() hoặc restart(), và thiết lập mã thoát (exit code).
  process.exitCode = args.action === "stop" ? ((await stop()) ? 0 : 1) : await restart();
}
