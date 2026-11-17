/**
 * Module xử lý phán quyết kiểm thử giao diện (browser smoke test verdict).
 * Cung cấp các hàm tiện ích thuần túy (pure logic) cho scripts/browser-smoke.mjs:
 * chuẩn hóa văn bản, băm SHA-256, parse tham số CLI, suy diễn đường dẫn file,
 * so sánh kết quả hiện tại với baseline và xác định mã thoát (exit code).
 */
import { createHash } from "node:crypto";
/**
 * Làm gì: Chuẩn hóa chuỗi văn bản từ body bằng cách gộp các khoảng trắng liên tiếp thành một dấu cách và cắt khoảng trắng hai đầu.
 * Được gọi ở: scripts/browser-smoke.mjs (thu thập viewport data), scripts/browser-smoke-verdict.mjs (normalizedBodyTextHash, bodyTextPrefix), scripts/browser-smoke-verdict.test.mjs ("test runner (node --test)")
 * - Tham số text: Chuỗi văn bản thô trích xuất từ body của trang web
 * - Trả về: Chuỗi văn bản đã được chuẩn hóa khoảng trắng
 */
export function normalizeBodyText(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Làm gì: Tính mã băm SHA-256 của văn bản body sau khi đã chuẩn hóa để phát hiện nhanh thay đổi nội dung trang.
 * Được gọi ở: scripts/browser-smoke.mjs (thu thập viewport data), scripts/browser-smoke-verdict.test.mjs ("test runner (node --test)")
 * - Tham số text: Chuỗi văn bản thô trích xuất từ body của trang web
 * - Trả về: Chuỗi mã băm SHA-256 dạng hex
 */
export function normalizedBodyTextHash(text) {
  return createHash("sha256").update(normalizeBodyText(text)).digest("hex");
}

// Độ dài tiền tố tối đa (64 ký tự) dùng để nhận diện và so sánh đoạn mở đầu của trang web
const IDENTITY_PREFIX_LEN = 64;

/**
 * Làm gì: Trích xuất đoạn tiền tố ngắn (tối đa 64 ký tự) của văn bản body đã chuẩn hóa để kiểm tra xem phần đầu trang có bị thay thế không.
 * Được gọi ở: scripts/browser-smoke.mjs (thu thập viewport data), scripts/browser-smoke-verdict.test.mjs ("test runner (node --test)")
 * - Tham số text: Chuỗi văn bản thô từ body của trang web
 * - Trả về: Chuỗi tiền tố tối đa 64 ký tự
 */
export function bodyTextPrefix(text) {
  return normalizeBodyText(text).slice(0, IDENTITY_PREFIX_LEN);
}
/**
 * Làm gì: Phân tích các đối số dòng lệnh và biến môi trường cho script chạy smoke test.
 * Được gọi ở: scripts/browser-smoke.mjs (khởi tạo cấu hình chạy), scripts/browser-smoke-verdict.test.mjs ("test runner (node --test)")
 * - Tham số argv: Mảng danh sách các tham số dòng lệnh truyền vào (process.argv.slice(2))
 * - Tham số env: Đối tượng biến môi trường (mặc định lấy từ process.env)
 * - Trả về: Đối tượng cấu hình gồm { url, outPng, baseline } hoặc đối tượng lỗi { error: string }
 */
export function parseSmokeArgs(argv, env = {}) {
  // Bước 1: Khởi tạo mảng chứa tham số vị trí và đọc baseline mặc định từ biến môi trường BROWSER_SMOKE_BASELINE.
  const positional = [];
  let baseline = env.BROWSER_SMOKE_BASELINE || "";
  // Bước 2: Duyệt từng tham số dòng lệnh để xử lý cờ --baseline hoặc phát hiện cờ lạ.
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--baseline") {
      // Lấy giá trị đường dẫn file baseline từ đối số liền sau (dạng: --baseline <path>)
      const value = argv[++i];
      if (!value) return { error: "--baseline requires a path to a prior verdict JSON" };
      baseline = value;
    } else if (arg.startsWith("--baseline=")) {
      // Trích xuất giá trị đường dẫn file baseline sau dấu bằng (dạng: --baseline=<path>)
      const value = arg.slice("--baseline=".length);
      if (!value) return { error: "--baseline requires a path to a prior verdict JSON" };
      baseline = value;
    } else if (arg.startsWith("--")) {
      // Chặn mọi cờ bắt đầu bằng '--' không được hỗ trợ để tránh chạy sai cấu hình ngoài ý muốn
      return { error: `unknown flag: ${arg}` };
    } else {
      // Thu thập các tham số vị trí (positional arguments: URL trang web hoặc đường dẫn ảnh chụp màn hình)
      positional.push(arg);
    }
  }
  // Bước 3: Trả về đối tượng cấu hình với giá trị fallback mặc định cho URL (cổng 8080) và ảnh chụp desktop.
  return {
    url: positional[0] || "http://127.0.0.1:8080/",
    outPng: positional[1] || "/workspace/screenshots/app-builder-preview.png",
    baseline,
  };
}
/**
 * Làm gì: Suy diễn đường dẫn file ảnh mobile (-mobile.png) và file JSON phán quyết (.json) từ đường dẫn ảnh desktop.
 * Được gọi ở: scripts/browser-smoke.mjs (xác định đường dẫn lưu kết quả), scripts/browser-smoke-verdict.test.mjs ("test runner (node --test)")
 * - Tham số outPng: Đường dẫn file ảnh chụp desktop (.png)
 * - Trả về: Đối tượng chứa mobilePng và verdictJson tương ứng
 */
export function derivedPaths(outPng) {
  // Cắt phần mở rộng .png để tạo tiền tố chung cho ảnh mobile và file verdict JSON
  const base = outPng.replace(/\.png$/i, "");
  return { mobilePng: `${base}-mobile.png`, verdictJson: `${base}.json` };
}

// Các ngưỡng quy ước dùng để phát hiện sự thay đổi bất thường của nội dung văn bản trang:
// TRIVIAL_LEN_DELTA: Số ký tự chênh lệch tối thiểu (20 ký tự) để coi là có sự thay đổi đáng kể
// TRIVIAL_LEN_RATIO: Tỷ lệ thay đổi độ dài (10%) ngưỡng nhận biết văn bản bị sửa đổi
// COLLAPSE_RATIO: Ngưỡng sụp đổ (50%), nếu độ dài giảm quá nửa so với baseline thì tính là lỗi mất nội dung
const TRIVIAL_LEN_DELTA = 20;
const TRIVIAL_LEN_RATIO = 0.1;
const COLLAPSE_RATIO = 0.5;
/**
 * Làm gì: So sánh chi tiết kết quả kiểm tra (verdict) hiện tại với baseline đã parse để phát hiện lỗi hồi quy hoặc giao diện vỡ.
 * Được gọi ở: scripts/browser-smoke-verdict.mjs (baselineComparison), scripts/browser-smoke-verdict.test.mjs ("test runner (node --test)")
 * - Tham số current: Đối tượng verdict kiểm tra hiện tại (chứa viewports)
 * - Tham số baseline: Đối tượng verdict mốc chuẩn trước đó để đối chiếu
 * - Trả về: Đối tượng { divergesFromBaseline: boolean, reasons: string[] } gồm cờ báo lệch và danh sách lý do
 */
export function compareToBaseline(current, baseline) {
  // Bước 1: Kiểm tra dữ liệu viewport hiện tại; nếu rỗng thì báo lệch ngay lập tức.
  const entries = Object.entries(current?.viewports ?? {});
  if (entries.length === 0) {
    return {
      divergesFromBaseline: true,
      reasons: ["current verdict has no viewport data"],
    };
  }
  // Bước 2: Duyệt từng viewport (desktop, mobile) để đối chiếu chi tiết các chỉ số với baseline.
  const reasons = [];
  const baseViewports = baseline?.viewports ?? {};
  for (const [name, cur] of entries) {
    const base = baseViewports[name];
    // Báo lỗi nếu baseline không có dữ liệu cho viewport đang xét
    if (!base) {
      reasons.push(`${name}: no baseline data for this viewport`);
      continue;
    }
    // Phát hiện thay đổi mã trạng thái HTTP (ví dụ từ 200 thành 404 hoặc 500)
    if (cur.status !== base.status) {
      reasons.push(`${name}: HTTP status changed ${base.status} -> ${cur.status}`);
    }
    // Phát hiện tiêu đề trang (title) bị thay đổi so với mốc chuẩn
    if (base.title !== undefined && cur.title !== undefined && cur.title !== base.title) {
      reasons.push(`${name}: title changed ("${base.title}" -> "${cur.title}")`);
    }
    // Phát hiện canvas bị biến mất (rất quan trọng với ứng dụng game hoặc đồ họa canvas)
    if (base.hasCanvas && !cur.hasCanvas) {
      reasons.push(`${name}: canvas disappeared`);
    }
    // Phát hiện thanh cuộn ngang ngoài ý muốn xuất hiện (lỗi vỡ layout)
    if (cur.horizontalOverflow && !base.horizontalOverflow) {
      reasons.push(`${name}: horizontal overflow appeared`);
    }
    // Kiểm tra xem có phát sinh lỗi console hoặc page error mới so với baseline không
    const baseErrs = (base.consoleErrors?.length ?? 0) + (base.pageErrors?.length ?? 0);
    const curErrs = (cur.consoleErrors?.length ?? 0) + (cur.pageErrors?.length ?? 0);
    if (curErrs > 0 && baseErrs === 0) {
      reasons.push(`${name}: console/page errors appeared (${curErrs})`);
    }
    // So sánh độ dài văn bản để phát hiện lỗi sụp đổ giao diện (mất hơn 50% chữ) hoặc thay đổi nội dung
    const baseLen = base.bodyTextLen ?? 0;
    const curLen = cur.bodyTextLen ?? 0;
    if (baseLen > 0 && curLen < baseLen * COLLAPSE_RATIO) {
      reasons.push(`${name}: body text collapsed (${baseLen} -> ${curLen} chars)`);
    } else if (cur.bodyTextHash !== base.bodyTextHash) {
      // Sai khác mã băm kèm chênh lệch độ dài đáng kể (> 20 ký tự và > 10% độ dài baseline)
      if (Math.abs(curLen - baseLen) > Math.max(TRIVIAL_LEN_DELTA, baseLen * TRIVIAL_LEN_RATIO)) {
        reasons.push(`${name}: body text changed (${baseLen} -> ${curLen} chars, hash mismatch)`);
      } else if (
        base.bodyTextPrefix !== undefined &&
        cur.bodyTextPrefix !== undefined &&
        cur.bodyTextPrefix !== base.bodyTextPrefix
      ) {
        // Độ dài tương đương nhưng tiền tố (prefix) khác nhau nghĩa là nội dung trang đã bị thay thế hoàn toàn
        reasons.push(`${name}: body text replaced (similar length, page start changed)`);
      }
    }
  }
  // Bước 3: Tổng hợp kết quả đối chiếu; bị coi là lệch nếu có ít nhất một lý do vi phạm.
  return { divergesFromBaseline: reasons.length > 0, reasons };
}
/**
 * Làm gì: Parse chuỗi JSON thô của file baseline và chuyển sang so sánh với verdict hiện tại, xử lý an toàn lỗi JSON không hợp lệ.
 * Được gọi ở: scripts/browser-smoke.mjs (hàm compareAgainstBaseline), scripts/browser-smoke-verdict.test.mjs ("test runner (node --test)")
 * - Tham số current: Đối tượng verdict kiểm tra hiện tại
 * - Tham số rawText: Chuỗi JSON thô đọc từ file baseline verdict trước đó
 * - Trả về: Đối tượng { divergesFromBaseline: boolean, reasons: string[] }
 */
export function baselineComparison(current, rawText) {
  // Bước 1: Thử phân tích cú pháp (parse) chuỗi JSON của baseline; nếu JSON hỏng thì báo lệch.
  let baseline;
  try {
    baseline = JSON.parse(rawText);
  } catch {
    return { divergesFromBaseline: true, reasons: ["baseline unreadable: invalid JSON"] };
  }
  // Bước 2: Kiểm tra tính hợp lệ của cấu trúc baseline (phải là object và chứa thuộc tính viewports dạng object).
  if (
    baseline === null ||
    typeof baseline !== "object" ||
    Array.isArray(baseline) ||
    baseline.viewports === null ||
    typeof baseline.viewports !== "object" ||
    Array.isArray(baseline.viewports)
  ) {
    return { divergesFromBaseline: true, reasons: ["baseline unreadable: not a verdict object"] };
  }
  // Bước 3: Thực hiện đối chiếu verdict hiện tại với baseline đã được parse và xác thực.
  return compareToBaseline(current, baseline);
}
/**
 * Làm gì: Xác định mã thoát (exit code) cho tiến trình smoke test dựa trên HTTP status và lỗi console của các viewport.
 * Được gọi ở: scripts/browser-smoke.mjs (gán vào process.exitCode), scripts/browser-smoke-verdict.test.mjs ("test runner (node --test)")
 * - Tham số viewports: Đối tượng chứa dữ liệu kiểm tra của các viewport (desktop, mobile...)
 * - Trả về: Mã thoát tiến trình (0: thành công/sạch lỗi, 1: lỗi HTTP status hoặc thiếu viewport, 2: có lỗi JavaScript console/page)
 */
export function exitCodeFor(viewports) {
  // Bước 1: Trích xuất danh sách các viewport cần đánh giá.
  const list = Object.values(viewports ?? {});
  // Bước 2: Trả về mã lỗi 1 nếu danh sách viewport rỗng hoặc có viewport gặp mã lỗi HTTP (>= 400 hoặc 0 do mất kết nối).
  if (list.length === 0) return 1;
  if (list.some((v) => (v.status ?? 0) >= 400 || (v.status ?? 0) === 0)) return 1;
  // Bước 3: Trả về mã lỗi 2 nếu phát hiện có bất kỳ lỗi JavaScript nào trên console hoặc unhandled page error.
  if (list.some((v) => (v.consoleErrors?.length ?? 0) > 0 || (v.pageErrors?.length ?? 0) > 0)) {
    return 2;
  }
  // Bước 4: Trả về 0 (thành công) khi tất cả viewport đều phản hồi tốt (HTTP < 400) và không có lỗi console.
  return 0;
}
