/**
 * Mục đích file:
 * File kiểm thử đơn vị (unit test) cho module scripts/migration-plan.mjs.
 * Kiểm tra các cơ chế lập kế hoạch migration cơ sở dữ liệu: định danh theo tên file (basename),
 * đảm bảo không chạy lặp lại migration, sắp xếp thứ tự thực thi theo tên file,
 * loại bỏ các file/thư mục không phải .sql, và bảo vệ tính bất biến của schema Better Auth.
 *
 * Vị trí trong hệ thống:
 * Được thực thi bởi test runner (node --test) trong lệnh `npm test` hoặc quy trình CI/QA,
 * đảm bảo quá trình đồng bộ schema (trên Neon Postgres khi deploy hoặc PGLite khi chạy preview) diễn ra an toàn.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isMigrationFile, migrationName, pendingMigrations } from "./migration-plan.mjs";
import { projectRoot } from "./with-app-env.mjs";

/**
 * Làm gì: Tên file migration SQL chuẩn dùng để khởi tạo schema các bảng tài khoản và phiên đăng nhập của Better Auth.
 * Được gọi ở: scripts/migration-plan.test.mjs (trong hàm authSchemaCopy và các ca kiểm thử liên quan).
 */
const AUTH_MIGRATION = "0001_auth.sql";

/**
 * The auth-on copy of the Better Auth schema and its source, or null when the
 * app has not turned sign-in on (the shipped state).
 */
function authSchemaCopy(root) {
  const copy = join(root, "migrations", AUTH_MIGRATION);
  const source = join(root, "migrations/auth", AUTH_MIGRATION);
  // Nếu thiếu 1 trong 2 file (ứng dụng chưa kích hoạt tính năng auth hoặc thiếu file gốc mẫu), trả về null
  if (!existsSync(copy) || !existsSync(source)) return null;
  // Đọc nội dung cả hai file dưới dạng chuỗi UTF-8 để phục vụ so sánh tính toàn vẹn
  return { copy: readFileSync(copy, "utf8"), source: readFileSync(source, "utf8") };
}

/**
 * Làm gì: Kiểm tra migrationName trích xuất đúng tên file (basename) từ đường dẫn để làm khóa định danh trong bảng _migrations.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("_migrations keys on basename, not path", () => {
  // Xác minh migrationName luôn lấy tên file cuối cùng, bất kể đường dẫn tuyệt đối, tương đối hay chỉ có tên file
  assert.equal(migrationName("/migrations/0002_todos.sql"), "0002_todos.sql");
  assert.equal(migrationName("migrations/auth/0001_auth.sql"), "0001_auth.sql");
  assert.equal(migrationName("0001_auth.sql"), "0001_auth.sql");
});

/**
 * Làm gì: Kiểm tra migration đã áp dụng vào database sẽ không bị thực thi lại dù quét được từ đường dẫn thư mục khác.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("a file already applied from another directory does not re-apply", () => {
  // The auth-on path copies migrations/auth/0001_auth.sql into the globbed
  // directory; a database that already has it must not run it twice.
  assert.deepEqual(pendingMigrations(["/migrations/0001_auth.sql"], ["0001_auth.sql"]), []);
});

/**
 * Làm gì: Kiểm tra pendingMigrations sắp xếp các migration chưa áp dụng theo thứ tự bảng chữ cái và lọc bỏ các file đã chạy.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("pending migrations are returned in name order", () => {
  // Danh sách truyền vào bị xáo trộn thứ tự và chứa 0001_a.sql đã chạy; kết quả phải sắp xếp tăng dần và chỉ giữ lại các file chưa chạy
  assert.deepEqual(
    pendingMigrations(
      ["/migrations/0003_c.sql", "/migrations/0001_a.sql", "/migrations/0002_b.sql"],
      ["0001_a.sql"],
    ),
    [
      { name: "0002_b.sql", path: "/migrations/0002_b.sql" },
      { name: "0003_c.sql", path: "/migrations/0003_c.sql" },
    ],
  );
});

/**
 * Làm gì: Kiểm tra hệ thống bỏ qua các mục không có đuôi .sql (như thư mục con auth/ hoặc file README.md) khi lập danh sách migration.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("non-.sql entries are dropped (readdir also yields the auth/ directory)", () => {
  // Bước 1: Xác nhận isMigrationFile trả về false cho tên thư mục (auth không kết thúc bằng .sql)
  assert.equal(isMigrationFile("auth"), false);
  // Bước 2: Xác nhận pendingMigrations lọc bỏ thư mục và file tài liệu, trả về danh sách rỗng
  assert.deepEqual(pendingMigrations(["auth", "README.md"], []), []);
});

/**
 * Làm gì: Kiểm tra file schema auth (0001_auth.sql) mặc định nằm riêng trong migrations/auth/ và không nằm trong migrations/ khi chưa bật auth.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("the auth schema ships outside the globbed directory", () => {
  // Bước 1: Lấy đường dẫn thư mục migrations của dự án đang làm việc
  const migrationsDir = join(projectRoot(), "migrations");
  // Bước 2: Khi chưa bật auth, thư mục migrations/ không chứa bất kỳ file migration nào sẵn sàng chạy
  assert.deepEqual(pendingMigrations(readdirSync(migrationsDir), []), []);
  // Bước 3: Đảm bảo file 0001_auth.sql luôn có sẵn trong migrations/auth/ để chuẩn bị cho việc kích hoạt auth khi cần
  assert.ok(readdirSync(join(migrationsDir, "auth")).includes("0001_auth.sql"));
});

/**
 * Làm gì: Kiểm tra bản sao migrations/0001_auth.sql (nếu có) phải trùng khớp từng byte với file nguồn migrations/auth/0001_auth.sql.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("this workspace's auth schema copy is byte-identical to its source", () => {
  // An edited copy diverges silently: basename keying skips it on a database
  // that already ran the original, and applies it on a fresh PGLite preview.
  const pair = authSchemaCopy(projectRoot());
  if (pair === null) return; // sign-in off — nothing has been copied up
  // So sánh nội dung hai file; nếu bị chỉnh sửa lệch pha sẽ gây sai lệch schema giữa các môi trường
  assert.equal(
    pair.copy,
    pair.source,
    "migrations/0001_auth.sql has been edited — it must stay a verbatim copy of migrations/auth/0001_auth.sql",
  );
});

/**
 * Làm gì: Kiểm tra hàm authSchemaCopy phát hiện chính xác các trạng thái: thiếu file (null), file giống nhau và file bị sửa đổi nội dung.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("the copy check reads both files and catches an edit", () => {
  // Bước 1: Tạo workspace tạm thời với file nguồn trong migrations/auth/, thiếu file copy trong migrations/ -> kết quả là null
  const root = mkdtempSync(join(tmpdir(), "auth-schema-"));
  mkdirSync(join(root, "migrations/auth"), { recursive: true });
  writeFileSync(join(root, "migrations/auth", AUTH_MIGRATION), "create table t ();\n");
  assert.equal(authSchemaCopy(root), null);

  // Bước 2: Tạo thêm file copy trong migrations/ với nội dung giống hệt file nguồn -> kết quả so sánh bằng nhau
  writeFileSync(join(root, "migrations", AUTH_MIGRATION), "create table t ();\n");
  const same = authSchemaCopy(root);
  assert.equal(same.copy, same.source);

  // Bước 3: Thay đổi nội dung file copy (thêm cột x int) -> kết quả so sánh không bằng nhau (phát hiện sai lệch)
  writeFileSync(join(root, "migrations", AUTH_MIGRATION), "create table t (x int);\n");
  const drifted = authSchemaCopy(root);
  assert.notEqual(drifted.copy, drifted.source);
});
