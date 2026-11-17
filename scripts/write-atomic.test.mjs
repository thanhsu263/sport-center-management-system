/**
 * Mục đích file:
 * File kiểm thử đơn vị (unit test) cho module scripts/write-atomic.mjs.
 * Kiểm tra cơ chế di chuyển nguyên tử (atomic hand-over) cho các asset thương hiệu (og.jpg, site.json);
 * từ chối lưu file tạm trong public/ để tránh bị Vite đóng gói vào bản build, và bảo toàn file đích khi gặp sự cố.
 *
 * Vị trí trong hệ thống:
 * Được thực thi bởi test runner (node --test) trong quy trình kiểm thử tự động của dự án.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { handOver, parseWriteAtomicArgs, stagingError } from "./write-atomic.mjs";

const TEMPLATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(TEMPLATE_ROOT, "scripts/write-atomic.mjs");

/**
 * Làm gì: Tạo thư mục workspace tạm thời trong hệ thống kèm các thư mục con public/ và .grok/ để cô lập môi trường test.
 * Được gọi ở: scripts/write-atomic.test.mjs (trong các ca kiểm thử bên dưới)
 * @returns {string} Đường dẫn tuyệt đối đến thư mục workspace tạm vừa tạo
 */
function makeWorkspace() {
  // Bước 1: Tạo thư mục tạm thời độc lập bằng mkdtempSync để không ảnh hưởng dữ liệu thật
  const root = mkdtempSync(join(tmpdir(), "write-atomic-"));
  // Bước 2: Tạo sẵn các thư mục con public/ và .grok/ theo cấu trúc workspace chuẩn
  mkdirSync(join(root, "public"), { recursive: true });
  mkdirSync(join(root, ".grok"), { recursive: true });
  // Bước 3: Trả về đường dẫn gốc của workspace tạm thời
  return root;
}

/**
 * Làm gì: Kiểm tra hàm parseWriteAtomicArgs phân tích đúng 2 đối số (file tạm và file đích) và báo lỗi khi thiếu hoặc thừa đối số.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("parseWriteAtomicArgs needs exactly a staged file and a target", () => {
  // Bước 1: Kiểm tra trường hợp truyền đủ 2 đối số hợp lệ (staged và target)
  assert.deepEqual(parseWriteAtomicArgs([".grok/og.tmp", "public/og.jpg"]), {
    staged: ".grok/og.tmp",
    target: "public/og.jpg",
  });
  // Bước 2: Báo lỗi cú pháp sử dụng khi không truyền đối số hoặc chỉ truyền 1 đối số
  assert.match(parseWriteAtomicArgs([]).error, /usage:/);
  assert.match(parseWriteAtomicArgs([".grok/og.tmp"]).error, /usage:/);
  // Bước 3: Báo lỗi khi truyền thừa đối số thứ 3 trở lên
  assert.match(parseWriteAtomicArgs(["a", "b", "c"]).error, /unexpected argument: c/);
});

/**
 * Làm gì: Kiểm tra hàm stagingError từ chối file tạm nằm trong public/ (tránh bị Vite đóng gói) và từ chối khi file nguồn trùng file đích.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("stagingError refuses a temp inside public/ and a no-op move", () => {
  const publicDir = "/workspace/public";
  // Bước 1: Xác nhận không có lỗi khi file tạm nằm ngoài public/ (được phép lưu trong .grok/)
  assert.equal(
    stagingError({
      staged: "/workspace/.grok/og.jpg.tmp",
      target: "/workspace/public/og.jpg",
      publicDir,
    }),
    null,
  );
  // Bước 2: Từ chối nếu file tạm nằm trong public/ vì Vite build sẽ đóng gói toàn bộ thư mục public/ vào bản phát hành
  assert.match(
    stagingError({
      staged: "/workspace/public/og.jpg.tmp",
      target: "/workspace/public/og.jpg",
      publicDir,
    }),
    /vite build ships that directory verbatim/,
  );
  // Bước 3: Từ chối nếu đường dẫn file tạm và file đích giống hệt nhau (thao tác vô nghĩa)
  assert.match(
    stagingError({
      staged: "/workspace/public/og.jpg",
      target: "/workspace/public/og.jpg",
      publicDir,
    }),
    /same path/,
  );
});

/**
 * Làm gì: Kiểm tra hàm handOver ghi đè nội dung file đích thành công và xóa sạch file tạm nguồn sau khi hoàn tất.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("handOver replaces the target and clears the staged file", () => {
  // Bước 1: Tạo workspace tạm và chuẩn bị file đích mang nội dung cũ cùng file tạm mang nội dung mới
  const root = makeWorkspace();
  const staged = join(root, ".grok/og.jpg.tmp");
  const target = join(root, "public/og.jpg");
  writeFileSync(target, "old card");
  writeFileSync(staged, "new card");

  // Bước 2: Thực hiện di chuyển nguyên tử file tạm sang file đích bằng handOver
  handOver(staged, target);

  // Bước 3: Xác minh file đích đã nhận nội dung mới và file tạm đã được dọn dẹp sạch sẽ
  assert.equal(readFileSync(target, "utf8"), "new card");
  assert.equal(existsSync(staged), false);
});

/**
 * Làm gì: Kiểm tra hàm handOver tự động tạo các thư mục cha còn thiếu nếu đường dẫn đích chưa tồn tại.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("handOver creates a missing target directory", () => {
  // Bước 1: Tạo workspace và file tạm chứa nội dung cấu hình JSON
  const root = makeWorkspace();
  const staged = join(root, ".grok/site.json.tmp");
  writeFileSync(staged, '{"title":"Sky Strike"}');

  // Bước 2: Chuyển giao sang đường dẫn đích có cấu trúc thư mục cha chưa tồn tại (src/server/og/)
  handOver(staged, join(root, "src/server/og/site.json"));

  // Bước 3: Xác minh thư mục cha được tạo tự động và file đích được ghi đầy đủ nội dung
  assert.equal(readFileSync(join(root, "src/server/og/site.json"), "utf8"), '{"title":"Sky Strike"}');
});

/**
 * Làm gì: Kiểm tra tính nguyên tử: nếu tiến trình bị gián đoạn giữa chừng, file đích vẫn giữ nguyên dữ liệu cũ và không để lại file rác.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("an interrupted pass leaves the target on its old bytes, temp-free", () => {
  // Bước 1: Tạo file đích và mô phỏng file tạm dở dang khi tiến trình ngoài (như ffmpeg) bị tắt đột ngột
  const root = makeWorkspace();
  const target = join(root, "public/og.jpg");
  writeFileSync(target, "old card");
  // The staged file a killed ffmpeg leaves behind: never handed over.
  writeFileSync(join(root, ".grok/og.jpg.tmp"), "half a JPEG");

  // Bước 2: Xác nhận file đích chưa bị thay đổi và handOver ném lỗi ENOENT khi thiếu file tạm nguồn
  assert.equal(readFileSync(target, "utf8"), "old card");
  assert.throws(() => handOver(join(root, ".grok/absent.tmp"), target), { code: "ENOENT" });
  // Bước 3: Kiểm tra chắc chắn file đích giữ nguyên nội dung cũ và không sót lại file tạm thời
  assert.equal(readFileSync(target, "utf8"), "old card");
  assert.equal(existsSync(`${target}.tmp-${process.pid}`), false);
});

/**
 * Làm gì: Kiểm tra khi handOver thất bại (do thiếu file tạm nguồn) thì không tạo trước các thư mục đích rỗng.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("a failed hand-over creates no directory for the target it never wrote", () => {
  // Bước 1: Chuẩn bị đường dẫn file tạm nguồn không tồn tại
  const root = makeWorkspace();
  const missing = join(root, ".grok/absent.tmp");
  // Bước 2: Kiểm tra handOver ném lỗi ENOENT trước khi thực hiện thao tác tạo thư mục đích
  assert.throws(() => handOver(missing, join(root, "src/server/og/site.json")), { code: "ENOENT" });
  // Bước 3: Xác minh thư mục đích (src/) không bị tạo thừa thãi khi gặp lỗi
  assert.equal(existsSync(join(root, "src")), false);
});

/**
 * Làm gì: Kiểm tra trường hợp file tạm nằm trên filesystem khác (lỗi EXDEV): script từ chối thay vì copy để tránh ghi đè không nguyên tử.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("a staged file on another filesystem is refused, not copied", () => {
  // Bước 1: Chuẩn bị file tạm và file đích trong workspace
  const root = makeWorkspace();
  const staged = join(root, ".grok/og.jpg.tmp");
  const target = join(root, "public/og.jpg");
  writeFileSync(staged, "new card");
  writeFileSync(target, "old card");
  /**
   * Làm gì: Mock hàm rename ném mã lỗi EXDEV để mô phỏng tình huống di chuyển file xuyên ổ đĩa/hệ thống file.
   * Được gọi ở: handOver (thông qua options.rename trong ca test này)
   * @throws {Error} Lỗi EXDEV khi đổi tên file giữa hai filesystem khác nhau
   */
  const crossDevice = () => {
    throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
  };

  // Bước 2: Kiểm tra handOver ném lỗi yêu cầu phải lưu file tạm trong cùng filesystem (/workspace/.grok/)
  assert.throws(() => handOver(staged, target, { rename: crossDevice }), {
    message: /stage under \/workspace\/\.grok\//,
  });
  // Copying would have had to stage its own temp inside public/, which is the
  // one place stagingError refuses.
  // Bước 3: Xác minh thư mục public/ không sinh file rác và file đích vẫn giữ nguyên dữ liệu ban đầu
  assert.deepEqual(readdirSync(join(root, "public")), ["og.jpg"]);
  assert.equal(readFileSync(target, "utf8"), "old card");
});

/**
 * Làm gì: Kiểm tra giao diện dòng lệnh (CLI): hoàn tất chuyển file khi tham số hợp lệ và từ chối khi file tạm đặt trong public/.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("cli: hands the file over, and refuses a temp staged in public/", () => {
  // Bước 1: Kiểm tra chạy CLI thành công (exit code 0) với file tạm hợp lệ nằm trong .grok/
  const root = makeWorkspace();
  writeFileSync(join(root, ".grok/og.jpg.tmp"), "new card");
  const ok = spawnSync(
    process.execPath,
    [SCRIPT, join(root, ".grok/og.jpg.tmp"), join(root, "public/og.jpg")],
    { encoding: "utf8" },
  );
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(readFileSync(join(root, "public/og.jpg"), "utf8"), "new card");

  // publicDir comes from the script's own root, so refusal is checked there.
  // Bước 2: Kiểm tra CLI từ chối và thoát với mã lỗi 1 khi file tạm nằm trong thư mục public/ của dự án
  const templateRoot = join(dirname(SCRIPT), "..");
  const staged = join(templateRoot, "public/og.jpg.tmp");
  const refused = spawnSync(
    process.execPath,
    [SCRIPT, staged, join(templateRoot, "public/og.jpg")],
    { encoding: "utf8" },
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /stage outside/);
  assert.equal(existsSync(staged), false);
});

/**
 * Làm gì: Kiểm tra CLI phân giải đường dẫn tương đối theo thư mục gốc của script thay vì thư mục làm việc hiện tại (cwd) của tiến trình gọi.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("cli: relative paths follow the script's root, not the caller's cwd", () => {
  // Same relative pair the skill documents, run from a workspace that has its
  // own public/: resolving against cwd would take the staged temp out of the
  // directory the refusal is defined against and move it.
  // Bước 1: Tạo workspace và file tạm với đường dẫn tương đối nằm trong public/
  const root = makeWorkspace();
  writeFileSync(join(root, "public/og.jpg.tmp"), "half a JPEG");
  // Bước 2: Chạy CLI với cwd là workspace; kiểm tra script phân giải đường dẫn tương đối theo ROOT của script
  const run = spawnSync(process.execPath, [SCRIPT, "public/og.jpg.tmp", "public/og.jpg"], {
    cwd: root,
    encoding: "utf8",
  });
  // Bước 3: Xác nhận CLI từ chối thực thi (exit code 1), giữ nguyên file tạm và không tạo file đích
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /stage outside/);
  assert.equal(readFileSync(join(root, "public/og.jpg.tmp"), "utf8"), "half a JPEG");
  assert.equal(existsSync(join(root, "public/og.jpg")), false);
});

/**
 * Làm gì: Kiểm tra tính nhất quán với tài liệu: mọi lệnh write-atomic.mjs mẫu trong tài liệu skill og đều hợp lệ với script này.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("every hand-over the og skill prints is one this script accepts", () => {
  // The card and banner recipes live in the skill's references/, not SKILL.md.
  // Bước 1: Đọc danh sách tài liệu hướng dẫn trong thư mục skill og
  const skillDir = join(TEMPLATE_ROOT, ".grok/skills/og");
  const docs = [
    join(skillDir, "SKILL.md"),
    ...readdirSync(join(skillDir, "references")).map((f) => join(skillDir, "references", f)),
  ];
  // Bước 2: Trích xuất các câu lệnh gọi write-atomic.mjs xuất hiện trong tài liệu bằng biểu thức chính quy
  const invocations = docs.flatMap(
    (path) => readFileSync(path, "utf8").match(/node scripts\/write-atomic\.mjs[^\n`]*/g) ?? [],
  );
  // Bước 3: Đảm bảo tài liệu có ít nhất 3 lệnh mẫu (og.jpg, x-banner.jpg và site.json)
  assert.ok(invocations.length >= 3, "og.jpg, x-banner.jpg and site.json each hand over");
  // Bước 4: Lặp qua từng câu lệnh và xác thực tham số hợp lệ theo hàm parseWriteAtomicArgs và stagingError
  for (const line of invocations) {
    const argv = line.replace("node scripts/write-atomic.mjs", "").trim().split(/\s+/);
    const args = parseWriteAtomicArgs(argv);
    assert.equal(args.error, undefined, line);
    assert.equal(
      stagingError({ staged: args.staged, target: args.target, publicDir: "/workspace/public" }),
      null,
      line,
    );
  }
});

/**
 * Làm gì: Kiểm tra CLI khi file tạm nguồn bị thiếu: lệnh thất bại với mã lỗi 1 và không làm ảnh hưởng đến file đích.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("cli: a missing staged file fails without touching the target", () => {
  // Bước 1: Khởi tạo file đích mang dữ liệu cũ
  const root = makeWorkspace();
  writeFileSync(join(root, "public/og.jpg"), "old card");
  // Bước 2: Gọi CLI với đường dẫn file tạm không tồn tại (.grok/absent.tmp)
  const run = spawnSync(
    process.execPath,
    [SCRIPT, join(root, ".grok/absent.tmp"), join(root, "public/og.jpg")],
    { encoding: "utf8" },
  );
  // Bước 3: Xác minh CLI trả về mã lỗi 1 và file đích vẫn giữ nguyên dữ liệu ban đầu
  assert.equal(run.status, 1);
  assert.match(run.stderr, /\[write-atomic\]/);
  assert.equal(readFileSync(join(root, "public/og.jpg"), "utf8"), "old card");
});
