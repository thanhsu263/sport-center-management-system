/**
 * Mục đích file:
 * File kiểm thử đơn vị (unit test) cho module scripts/preview.mjs.
 * Kiểm tra các hàm logic cốt lõi quản lý vòng đời preview server cổng 8081:
 * phân tích tham số CLI, đọc PID/PGID từ Linux /proc, quét socket inode trong /proc/net/tcp,
 * nhận diện tiến trình preview, truy tìm process sở hữu cổng, gửi tín hiệu dừng (SIGTERM/SIGKILL)
 * và tổng hợp kết quả giải phóng cổng 8081.
 *
 * Vị trí trong hệ thống:
 * Được thực thi bởi test runner (node --test) trong quy trình QA tự động trước khi chạy browser-smoke,
 * đảm bảo preview server phục vụ đúng bản build mới nhất mà không bị kẹt bởi tiến trình cũ.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  looksLikePreviewProcess,
  parseListenerInodes,
  parsePgid,
  parsePid,
  parsePreviewArgs,
  previewOwners,
  stopOutcome,
  terminatePids,
} from "./preview.mjs";

/**
 * Làm gì: Kiểm tra hàm parsePreviewArgs chấp nhận hai action hợp lệ là "stop" và "restart".
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("parsePreviewArgs accepts the two actions", () => {
  // Duyệt qua từng action hợp lệ ("stop", "restart") và xác minh trả về đúng đối tượng { action }
  for (const action of ["stop", "restart"]) {
    assert.deepEqual(parsePreviewArgs([action]), { action });
  }
});

/**
 * Làm gì: Kiểm tra hàm parsePreviewArgs từ chối các tham số không hợp lệ (mảng rỗng, action lạ, hoặc thừa cờ tùy chọn).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("parsePreviewArgs rejects missing, unknown and extra arguments", () => {
  // Bước 1: Không truyền tham số -> trả về lỗi hướng dẫn cú pháp (usage)
  assert.match(parsePreviewArgs([]).error, /usage:/);
  // Bước 2: Action không được hỗ trợ ("reload", "start") -> báo lỗi unknown action
  assert.match(parsePreviewArgs(["reload"]).error, /unknown action: reload/);
  assert.match(parsePreviewArgs(["start"]).error, /unknown action: start/);
  // Bước 3: Thừa tham số phụ ("--force") -> báo lỗi unexpected argument
  assert.match(parsePreviewArgs(["restart", "--force"]).error, /unexpected argument: --force/);
});

/**
 * Làm gì: Kiểm tra hàm parsePid phân tích đúng số PID từ nội dung file PID và lọc bỏ chuỗi rác, số âm hoặc PID 1.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("parsePid reads a pidfile and rejects junk", () => {
  // Bước 1: Chuỗi số nguyên dương kèm khoảng trắng hoặc ký tự xuống dòng -> phân tích thành số nguyên hợp lệ
  assert.equal(parsePid("4321\n"), 4321);
  assert.equal(parsePid("  99  "), 99);
  // Bước 2: Chuỗi rỗng, chữ không phải số hoặc số âm -> trả về null để tránh thao tác nhầm process
  assert.equal(parsePid(""), null);
  assert.equal(parsePid("not-a-pid"), null);
  assert.equal(parsePid("-7"), null);
  // pid 1 is the sandbox init, never a preview server.
  assert.equal(parsePid("1"), null);
});

/**
 * Làm gì: Kiểm tra hàm parsePgid đọc đúng trường pgrp (process group ID) từ chuỗi /proc/<pid>/stat, kể cả khi tên lệnh (comm) chứa dấu cách hoặc dấu ngoặc.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("parsePgid reads the pgrp field past a comm containing spaces", () => {
  // Bước 1: Trích xuất PGID sau phần tên lệnh nằm trong ngoặc đơn (cột pgrp là vị trí thứ 3 sau dấu ngoặc đóng cuối cùng)
  assert.equal(parsePgid("4321 (node) S 4300 4321 4321 0 -1 4194304 1234"), 4321);
  assert.equal(parsePgid("4321 (npm run preview) S 4300 4200 4200 0 -1 0 0"), 4200);
  assert.equal(parsePgid("4321 (weird ) name) S 4300 4200 4200 0"), 4200);
  // Bước 2: Dữ liệu rác, chuỗi rỗng hoặc undefined -> trả về null an toàn
  assert.equal(parsePgid("garbage"), null);
  assert.equal(parsePgid(""), null);
  assert.equal(parsePgid(undefined), null);
});

// One /proc/net/tcp row; the socket inode is column 10.
/**
 * Làm gì: Tạo chuỗi giả lập một dòng dữ liệu trong bảng /proc/net/tcp của Linux kernel để phục vụ test.
 * Được gọi ở: scripts/preview.test.mjs (khởi tạo hằng số PROC_NET_TCP và ca kiểm thử test)
 * - Tham số sl: Số thứ tự dòng (slot index)
 * - Tham số local: Địa chỉ IP và port cục bộ dưới dạng hex (IP:Port)
 * - Tham số state: Mã trạng thái kết nối TCP dưới dạng hex ("0A" là LISTEN, "01" là ESTABLISHED)
 * - Tham số inode: Số định danh socket inode (cột thứ 10 trong bảng /proc/net/tcp)
 * @returns {string} Chuỗi mô phỏng một dòng hoàn chỉnh trong file /proc/net/tcp
 */
const tcpRow = (sl, local, state, inode) =>
  [
    `  ${sl}:`,
    local,
    "00000000:0000",
    state,
    "00000000:00000000",
    "00:00000000",
    "00000000",
    "1000",
    "0",
    inode,
    "1",
    "0000",
    "100",
  ].join(" ");

// Bảng dữ liệu /proc/net/tcp giả lập gồm 3 dòng socket: port 8081 (LISTEN), port 8080 (LISTEN) và port 8081 (ESTABLISHED)
const PROC_NET_TCP = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode",
  tcpRow(0, "0100007F:1F91", "0A", 5551),
  tcpRow(1, "0100007F:1F90", "0A", 5552),
  tcpRow(2, "0100007F:1F91", "01", 5553),
  "",
].join("\n");

/**
 * Làm gì: Kiểm tra hàm parseListenerInodes chỉ trích xuất đúng các socket inode ở trạng thái LISTEN trên đúng port yêu cầu.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("parseListenerInodes picks LISTEN sockets on the wanted port only", () => {
  // 0x1F91 = 8081 (LISTEN), 0x1F90 = 8080, and the third row is ESTABLISHED.
  // Bước 1: Lọc đúng socket inode ở trạng thái LISTEN ("0A") trên port 8081 (0x1F91) và port 8080 (0x1F90)
  assert.deepEqual(parseListenerInodes(PROC_NET_TCP, 8081), ["5551"]);
  assert.deepEqual(parseListenerInodes(PROC_NET_TCP, 8080), ["5552"]);
  // Bước 2: Port không lắng nghe (9999), dữ liệu rỗng hoặc undefined phải trả về mảng rỗng []
  assert.deepEqual(parseListenerInodes(PROC_NET_TCP, 9999), []);
  assert.deepEqual(parseListenerInodes("", 8081), []);
  assert.deepEqual(parseListenerInodes(undefined, 8081), []);
});

/**
 * Làm gì: Kiểm tra hàm parseListenerInodes xử lý chính xác định dạng IPv6 trong file /proc/net/tcp6 tương tự IPv4.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("parseListenerInodes reads the tcp6 dump the same way", () => {
  // Địa chỉ IPv6 có tiền tố 32 ký tự hex 0 và kết thúc bằng port 8081 dạng hex (1F91)
  const v6 = "00000000000000000000000000000000:1F91";
  assert.deepEqual(parseListenerInodes(tcpRow(0, v6, "0A", 7777), 8081), ["7777"]);
});

// /proc/<pid>/cmdline is NUL-separated.
/**
 * Làm gì: Nối các tham số dòng lệnh bằng ký tự null byte (\0) để giả lập định dạng /proc/<pid>/cmdline của Linux.
 * Được gọi ở: scripts/preview.test.mjs (các ca kiểm thử looksLikePreviewProcess và previewOwners)
 * - Tham số argv: Danh sách các tham số dòng lệnh cần nối
 * @returns {string} Chuỗi các tham số phân tách nhau bằng ký tự null byte
 */
const cmdline = (...argv) => argv.join("\u0000");

/**
 * Làm gì: Kiểm tra hàm looksLikePreviewProcess nhận diện chính xác tiến trình preview (bao gồm lệnh npm run preview và tiến trình con vite preview).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("looksLikePreviewProcess matches the npm wrapper and its vite child", () => {
  // Bước 1: Khớp tiến trình npm run preview thông qua đường dẫn đầy đủ npm-cli.js hoặc lệnh npm rút gọn
  const npmRun = cmdline("node", "/usr/lib/node_modules/npm/bin/npm-cli.js", "run", "preview");
  assert.equal(looksLikePreviewProcess(npmRun), true);
  assert.equal(looksLikePreviewProcess(cmdline("npm", "run", "preview")), true);
  // Bước 2: Khớp tiến trình con vite preview với tham số phân tách bằng null byte
  assert.equal(
    looksLikePreviewProcess(cmdline("node", "/ws/node_modules/.bin/vite", "preview")),
    true,
  );
  // `ps -o command=` output is space-separated.
  assert.equal(looksLikePreviewProcess("node /ws/node_modules/.bin/vite preview"), true);
});

/**
 * Làm gì: Kiểm tra hàm looksLikePreviewProcess bỏ qua các script phụ trợ, script dừng/khởi động lại và các tiến trình tái sử dụng PID khác.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("looksLikePreviewProcess spares the sibling scripts and re-used pids", () => {
  // The sandbox service runs this one in the same box (CapturePreviewThumbnail).
  const thumbnail = cmdline(
    "node",
    "/opt/app-template/scripts/preview-thumbnail.mjs",
    "http://127.0.0.1:8080/",
    "/tmp/preview-thumbnail.png",
  );
  assert.equal(looksLikePreviewProcess(thumbnail), false);
  // Bước 1: Không nhận nhầm script dừng chính nó (scripts/preview.mjs stop)
  assert.equal(looksLikePreviewProcess(cmdline("node", "scripts/preview.mjs", "stop")), false);
  // This tooling's own npm wrappers, which carry no `.mjs` in their cmdline.
  const npmCli = "/usr/lib/node_modules/npm/bin/npm-cli.js";
  assert.equal(looksLikePreviewProcess(cmdline("node", npmCli, "run", "preview:stop")), false);
  assert.equal(looksLikePreviewProcess(cmdline("node", npmCli, "run", "preview:restart")), false);
  assert.equal(looksLikePreviewProcess(cmdline("npm", "run", "preview:stop")), false);
  // Bước 2: Không nhận nhầm lệnh build (vite build) hoặc các lệnh tiện ích khác (sleep, server.mjs, rỗng)
  const viteBuild = cmdline("vite", "build", "--outDir", "preview-dist");
  assert.equal(looksLikePreviewProcess(viteBuild), false);
  assert.equal(looksLikePreviewProcess(cmdline("/usr/bin/preview-tool", "--x")), false);
  assert.equal(looksLikePreviewProcess(cmdline("sleep", "300")), false);
  assert.equal(looksLikePreviewProcess(cmdline("node", "server.mjs")), false);
  assert.equal(looksLikePreviewProcess(""), false);
});

/**
 * Làm gì: Kiểm tra hàm previewOwners tin cậy danh sách PID thực sự chiếm giữ port và tự động khử trùng lặp nếu PID trong pidfile đã tồn tại trong portPids.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("previewOwners trusts port owners and dedupes the pidfile pid", () => {
  // PID 50 vừa giữ port vừa nằm trong pidfile -> không gọi cmdlineOf để đối soát và khử trùng trong kết quả
  const owners = previewOwners({
    portPids: [50, 51],
    pidFilePid: 50,
    cmdlineOf: () => assert.fail("a port owner needs no corroboration"),
  });
  assert.deepEqual(owners, [50, 51]);
});

/**
 * Làm gì: Kiểm tra hàm previewOwners bổ sung PID từ pidfile vào danh sách nếu tiến trình đó vẫn đang chạy lệnh preview hợp lệ.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("previewOwners adds a pidfile pid whose command line is still the preview", () => {
  // PID 50 trong pidfile được xác nhận đúng là preview qua cmdlineOf -> bổ sung vào danh sách owners cần dừng
  const owners = previewOwners({
    portPids: [51],
    pidFilePid: 50,
    cmdlineOf: (pid) => (pid === 50 ? cmdline("node", "npm-cli.js", "run", "preview") : ""),
  });
  assert.deepEqual(owners, [51, 50]);
});

/**
 * Làm gì: Kiểm tra hàm previewOwners loại bỏ PID cũ trong pidfile nếu PID đó đã bị tiến trình khác (không phải preview) tái sử dụng.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("previewOwners drops a stale pidfile pid re-used by another process", () => {
  // PID 50 đã bị tiến trình khác sử dụng (lệnh "sleep 300") -> không đưa vào danh sách dừng để tránh kill nhầm tiến trình
  const owners = previewOwners({
    portPids: [],
    pidFilePid: 50,
    cmdlineOf: () => cmdline("sleep", "300"),
  });
  assert.deepEqual(owners, []);
});

/**
 * Làm gì: Kiểm tra hàm previewOwners loại bỏ PID trong pidfile khi tiến trình đó đã chết (cmdlineOf trả về chuỗi rỗng).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("previewOwners drops a pidfile pid that no longer exists", () => {
  // Tiến trình không còn tồn tại -> cmdlineOf trả về rỗng và bị loại khỏi danh sách owners
  const owners = previewOwners({ portPids: [], pidFilePid: 50, cmdlineOf: () => "" });
  assert.deepEqual(owners, []);
});

/**
 * Làm gì: Kiểm tra hàm previewOwners trả về mảng rỗng khi cổng 8081 đang rảnh và không có file PID.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("previewOwners on a free port with no pidfile signals nothing", () => {
  // Không có tiến trình giữ port và không có pidfile -> trả về mảng rỗng, không cần gửi tín hiệu dừng
  const owners = previewOwners({ portPids: [], pidFilePid: null, cmdlineOf: () => "" });
  assert.deepEqual(owners, []);
});

/**
 * Làm gì: Kiểm tra hàm stopOutcome báo lỗi thất bại (ok: false) khi có PID ngoan cố không chịu tắt hoặc port vẫn bị chiếm giữ.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("stopOutcome fails when a pid survives or the port is still held", () => {
  // Bước 1: PID 50 sống sót sau SIGKILL (thuộc mảng stubborn) -> báo lỗi cổng vẫn bị chiếm giữ bởi PID 50
  const stubbornOnly = stopOutcome({
    signalled: [50],
    stubborn: [50],
    after: { pids: [] },
  });
  assert.equal(stubbornOnly.ok, false);
  assert.match(stubbornOnly.error, /still held by pid\(s\) 50/);

  // Bước 2: PID cũ đã tắt nhưng sau đó xuất hiện PID mới (77) chiếm port -> báo lỗi cổng vẫn bị chiếm giữ bởi PID 77
  const newOwner = stopOutcome({
    signalled: [50],
    stubborn: [],
    after: { pids: [77] },
  });
  assert.equal(newOwner.ok, false);
  assert.match(newOwner.error, /still held by pid\(s\) 77/);
});

/**
 * Làm gì: Kiểm tra hàm stopOutcome trả về kết quả thành công (ok: true) khi cổng 8081 đã được giải phóng hoàn toàn.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("stopOutcome reports a verified free port", () => {
  // Bước 1: Đã dừng thành công PID 50 và cổng được giải phóng hoàn toàn -> thông báo stopped pid(s) 50
  const stopped = stopOutcome({
    signalled: [50],
    stubborn: [],
    after: { pids: [] },
  });
  assert.equal(stopped.ok, true);
  assert.match(stopped.message, /stopped pid\(s\) 50 — port 8081 is free/);

  // Bước 2: Không có tiến trình nào chiếm cổng từ trước -> thông báo nothing was listening
  const idle = stopOutcome({ signalled: [], stubborn: [], after: { pids: [] } });
  assert.equal(idle.ok, true);
  assert.match(idle.message, /nothing was listening on 8081/);
});

/**
 * Làm gì: Kiểm tra hàm stopOutcome báo lỗi khi phát hiện có socket đang lắng nghe nhưng không thể xác định tiến trình sở hữu (unattributed).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("stopOutcome fails on a listener whose owner cannot be attributed", () => {
  // Có listener trên port nhưng không phân giải được PID -> báo lỗi process ngoài tầm nhìn của script (unattributed)
  const outcome = stopOutcome({
    signalled: [],
    stubborn: [],
    after: { pids: [], unattributed: true },
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /port 8081 is held by a process this script cannot see/);
});

/**
 * Làm gì: Tạo đối tượng quản lý tiến trình giả lập (mock) để kiểm tra logic gửi tín hiệu dừng của hàm terminatePids.
 * Được gọi ở: scripts/preview.test.mjs (các ca kiểm thử terminatePids)
 * - Tham số options: Cấu hình giả lập gồm danh sách PID đang sống và danh sách PID phớt lờ SIGTERM
 * - Tham số options.pids: Mảng các PID ban đầu được coi là đang hoạt động (alive)
 * - Tham số options.ignoresTerm: Mảng các PID sẽ bỏ qua tín hiệu SIGTERM (chỉ chết khi nhận SIGKILL)
 * @returns {Object} Đối tượng mock chứa mảng signals đã gửi, hàm isAlive, kill và sleep
 */
function fakeProcesses({ pids, ignoresTerm = [] }) {
  // Bước 1: Khởi tạo Set lưu trạng thái sống của các PID và mảng ghi nhận lịch sử các tín hiệu đã phát
  const alive = new Set(pids);
  const signals = [];
  // Bước 2: Trả về các hàm giả lập tương thích giao diện I/O hệ thống mà terminatePids yêu cầu
  return {
    signals,
    isAlive: (pid) => alive.has(pid),
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      // Tiến trình chết ngay nếu nhận SIGKILL hoặc không nằm trong danh sách phớt lờ SIGTERM
      if (signal === "SIGKILL" || !ignoresTerm.includes(pid)) alive.delete(pid);
    },
    sleep: async () => {},
  };
}

/**
 * Làm gì: Kiểm tra hàm terminatePids gửi tín hiệu SIGTERM tới các tiến trình đang sống và bỏ qua các PID đã chết.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("terminatePids SIGTERMs live pids and skips dead ones", async () => {
  // Bước 1: Giả lập PID 11, 12 đang sống; PID 13 đã chết từ trước
  const fake = fakeProcesses({ pids: [11, 12] });
  // Bước 2: Gọi terminatePids và xác nhận chỉ gửi SIGTERM tới PID 11 và 12
  const result = await terminatePids([11, 12, 13], fake);
  assert.deepEqual(result, { signalled: [11, 12], killed: [], stubborn: [] });
  assert.deepEqual(fake.signals, [
    [11, "SIGTERM"],
    [12, "SIGTERM"],
  ]);
});

/**
 * Làm gì: Kiểm tra hàm terminatePids tự động leo thang gửi SIGKILL khi tiến trình phớt lờ tín hiệu SIGTERM ban đầu.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("terminatePids escalates to SIGKILL when SIGTERM is ignored", async () => {
  // Bước 1: Giả lập PID 12 bỏ qua SIGTERM (không tự thoát trong thời gian chờ grace period)
  const fake = fakeProcesses({ pids: [11, 12], ignoresTerm: [12] });
  // Bước 2: Xác nhận terminatePids leo thang gửi tiếp SIGKILL cho PID 12 và đưa PID 12 vào danh sách killed
  const result = await terminatePids([11, 12], fake);
  assert.deepEqual(result, { signalled: [11, 12], killed: [12], stubborn: [] });
  assert.deepEqual(fake.signals, [
    [11, "SIGTERM"],
    [12, "SIGTERM"],
    [12, "SIGKILL"],
  ]);
});

/**
 * Làm gì: Kiểm tra hàm terminatePids ghi nhận tiến trình vào danh sách ngoan cố (stubborn) nếu nó vẫn sống sau cả tín hiệu SIGKILL.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("terminatePids reports a pid that survives SIGKILL as stubborn", async () => {
  const signals = [];
  // Giả lập PID 11 luôn luôn sống (isAlive luôn true) sau cả 2 lần gửi SIGTERM và SIGKILL
  const result = await terminatePids([11], {
    isAlive: () => true,
    kill: (pid, signal) => signals.push([pid, signal]),
    sleep: async () => {},
  });
  assert.deepEqual(result, { signalled: [11], killed: [11], stubborn: [11] });
  assert.deepEqual(signals, [
    [11, "SIGTERM"],
    [11, "SIGKILL"],
  ]);
});

/**
 * Làm gì: Kiểm tra hàm terminatePids không gửi bất kỳ tín hiệu nào khi danh sách PID đầu vào rỗng (cổng đã rảnh).
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("terminatePids on a free port signals nothing", async () => {
  // Danh sách PID rỗng -> hàm kết thúc ngay và không phát bất kỳ tín hiệu kill nào
  const fake = fakeProcesses({ pids: [] });
  const result = await terminatePids([], fake);
  assert.deepEqual(result, { signalled: [], killed: [], stubborn: [] });
  assert.deepEqual(fake.signals, []);
});
