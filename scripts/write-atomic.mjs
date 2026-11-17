#!/usr/bin/env node
/**
 * Hand a staged file over to a path another agent reads, in one step.
 *
 *   node scripts/write-atomic.mjs /workspace/.grok/og.jpg.tmp public/og.jpg
 *
 * The brand-asset task writes public/og.jpg and src/server/og/site.json while the
 * parent may be mid-`npm run build`, so an in-place write can be read
 * half-finished. rename(2) is atomic within one filesystem: a reader sees the
 * old bytes or the new ones. /workspace is one filesystem, so a staged file
 * from anywhere else (/tmp is a separate mount) is refused rather than copied:
 * copying would have to land its temp in the target's directory, which is the
 * one thing a staged path is not allowed to do.
 */
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Thư mục gốc của repository (thư mục cha của scripts/), dùng làm mốc chuẩn hóa các đường dẫn tương đối.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Làm gì: Phân tích các đối số dòng lệnh khi chạy script bàn giao file nguyên tử. Bắt buộc phải có đủ đường dẫn file tạm (staged) và file đích (target), không cho phép dư thừa đối số.
 * Được gọi ở: scripts/write-atomic.mjs (khối thực thi CLI ở dòng 72), scripts/write-atomic.test.mjs (test runner (node --test)).
 * - Tham số argv: Mảng các đối số dòng lệnh (thường lấy từ process.argv.slice(2)).
 * - Trả về: Đối tượng { staged, target } nếu hợp lệ, hoặc { error } chứa thông báo hướng dẫn sử dụng nếu thiếu hoặc thừa đối số.
 */
export function parseWriteAtomicArgs(argv) {
  // Bước 1: Bóc tách đường dẫn file tạm (staged), file đích (target) và các tham số dư thừa (rest).
  const [staged, target, ...rest] = argv;
  // Bước 2: Bắt buộc phải có đủ cả file tạm và file đích; thiếu một trong hai sẽ trả về thông báo usage.
  if (!staged || !target) {
    return { error: "usage: node scripts/write-atomic.mjs <staged-file> <target>" };
  }
  // Bước 3: Kiểm tra nếu có tham số dư thừa ngoài dự kiến thì báo lỗi cú pháp.
  if (rest.length > 0) return { error: `unexpected argument: ${rest[0]}` };
  // Bước 4: Trả về cặp đường dẫn hợp lệ sau khi xác thực đối số thành công.
  return { staged, target };
}

/**
 * Làm gì: Kiểm tra xem một đường dẫn file có nằm hoàn toàn bên trong thư mục dir hay không.
 * Được gọi ở: scripts/write-atomic.mjs (trong hàm stagingError ở dòng 42).
 * - Tham số dir: Đường dẫn thư mục cha cần kiểm tra (ví dụ: publicDir).
 * - Tham số file: Đường dẫn file cần kiểm tra xem có nằm bên trong dir hay không.
 * - Trả về: boolean True nếu file nằm trong thư mục dir, ngược lại là false.
 */
function isInside(dir, file) {
  // Bước 1: Tính đường dẫn tương đối từ thư mục dir đến file.
  const rel = relative(dir, file);
  // Bước 2: Nếu đường dẫn tương đối không rỗng, không bắt đầu bằng '..' (đi ra ngoài) và không phải tuyệt đối thì file nằm trong dir.
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Why a staged path can be refused: `vite build` copies public/ verbatim into
 * the deployed app, so a temp that lands there ships (and an interrupted run
 * leaves it behind).
 */
/*
 * Làm gì: Kiểm tra tính hợp lệ của đường dẫn file tạm trước khi bàn giao: từ chối nếu file tạm trùng file đích, hoặc file tạm nằm trong thư mục public/ (vì Vite sẽ copy nguyên thư mục public vào bản build làm lộ file rác).
 * Được gọi ở: scripts/write-atomic.mjs (khối thực thi CLI ở dòng 82), scripts/write-atomic.test.mjs (test runner (node --test)).
 * - Tham số staged: Đường dẫn file tạm (đã resolve).
 * - Tham số target: Đường dẫn file đích cần ghi đè (đã resolve).
 * - Tham số publicDir: Đường dẫn thư mục public của dự án.
 * - Trả về: Chuỗi thông báo lỗi nếu đường dẫn không hợp lệ, hoặc null nếu an toàn.
 */
export function stagingError({ staged, target, publicDir }) {
  // Bước 1: Không cho phép file tạm trùng với file đích vì thao tác ghi đè lên chính nó vô nghĩa và có thể làm hỏng file.
  if (staged === target) return `staged file and target are the same path: ${target}`;
  // Bước 2: Từ chối nếu file tạm nằm trong public/ vì Vite build sẽ copy nguyên thư mục này vào bản build làm lộ file rác ra môi trường production.
  if (isInside(publicDir, staged)) {
    return `stage outside ${publicDir} (vite build ships that directory verbatim): ${staged}`;
  }
  return null;
}

/**
 * Moves `staged` onto `target`, leaving `target` untouched if anything fails.
 * `rename` is injectable because EXDEV — the refusal the "stage under
 * /workspace/.grok/" contract rests on — cannot be provoked portably.
 */
/*
 * Làm gì: Bàn giao file tạm sang file đích theo cơ chế nguyên tử (atomic rename qua renameSync). Giúp các tiến trình khác (như build/test) chỉ đọc được file cũ hoặc file mới hoàn chỉnh, không bao giờ đọc phải file dở dang.
 * Được gọi ở: scripts/write-atomic.mjs (khối thực thi CLI ở dòng 88), scripts/write-atomic.test.mjs (test runner (node --test)).
 * - Tham số staged: Đường dẫn file tạm đang chứa dữ liệu hoàn chỉnh.
 * - Tham số target: Đường dẫn file đích cần ghi nội dung mới vào.
 * - Tham số rename: Hàm thực hiện đổi tên file (mặc định renameSync từ node:fs, cho phép truyền mock để test lỗi cross-device EXDEV).
 * - Trả về: void Không trả về giá trị nếu thành công.
 * - Lỗi có thể ném: Error (mã ENOENT) nếu file tạm không tồn tại, hoặc Error cảnh báo nếu hai file nằm trên hai filesystem khác nhau (mã EXDEV).
 */
export function handOver(staged, target, { rename = renameSync } = {}) {
  // Bước 1: Kiểm tra file tạm phải tồn tại trước khi thao tác để tránh xóa nhầm hoặc làm mất file target cũ.
  if (!existsSync(staged)) {
    throw Object.assign(new Error(`staged file is missing: ${staged}`), { code: "ENOENT" });
  }
  // Bước 2: Đảm bảo thư mục cha của file đích tồn tại trước khi di chuyển file.
  mkdirSync(dirname(target), { recursive: true });
  // Bước 3: Đổi tên file tạm thành file đích bằng renameSync (thao tác atomic trong cùng một filesystem).
  try {
    rename(staged, target);
  } catch (err) {
    // Lỗi EXDEV xảy ra khi rename giữa 2 filesystem/mount khác nhau (như /tmp sang /workspace), yêu cầu tạo file tạm trong /workspace/.grok/ để rename nguyên tử.
    if (err?.code === "EXDEV") {
      throw new Error(
        `${staged} is on another filesystem than ${target}, so the hand-over cannot be a `
          + "rename — stage under /workspace/.grok/ instead",
      );
    }
    throw err;
  }
}

// Khối điều khiển thực thi khi script được gọi trực tiếp từ dòng lệnh Node.js.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Bước 1: Phân tích đối số dòng lệnh; dừng script và xuất mã lỗi 1 nếu đối số không hợp lệ.
  const args = parseWriteAtomicArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`[write-atomic] ${args.error}`);
    process.exit(1);
  }
  // Relative paths follow this script's root, not the caller's cwd: the brand
  // pass runs from wherever its sub-shell left it, and the public/ refusal
  // below is defined against that same root.
  // Bước 2: Chuẩn hóa đường dẫn tương đối theo thư mục ROOT của repo để đảm bảo nhất quán bất kể caller đứng ở thư mục nào.
  const staged = resolve(ROOT, args.staged);
  const target = resolve(ROOT, args.target);
  // Bước 3: Kiểm tra các quy tắc an toàn của đường dẫn file tạm (trùng target hoặc nằm trong public/).
  const problem = stagingError({ staged, target, publicDir: join(ROOT, "public") });
  if (problem) {
    console.error(`[write-atomic] ${problem}`);
    process.exit(1);
  }
  // Bước 4: Thực hiện bàn giao file tạm đè lên file đích một cách an toàn (atomic rename).
  try {
    handOver(staged, target);
  } catch (err) {
    console.error(`[write-atomic] ${staged} → ${target} failed: ${err?.message || err}`);
    process.exit(1);
  }
  // Bước 5: Ghi log xác nhận đã ghi file đích thành công.
  console.log(`[write-atomic] wrote ${target}`);
}
