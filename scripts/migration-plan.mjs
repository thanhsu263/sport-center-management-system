// @ts-check
/**
 * Migration bookkeeping shared by the two appliers — `scripts/migrate.mjs`
 * (deploy, `readdir`) and `src/server/data/db.ts` (PGLite preview, `import.meta.glob`).
 *
 * Applied files are keyed by BASENAME, so the same file applies once no matter
 * which directory it is globbed from. That is what makes the auth schema safe to
 * copy from `migrations/auth/` into `migrations/` when an app turns sign-in on:
 * a database that already has `0001_auth.sql` will not re-run it.
 *
 * Neither applier descends into subdirectories, so `migrations/auth/*.sql` is
 * out of scope for both until it is copied up.
 */

/**
 * The `_migrations` key for a migration path (or bare filename).
 * @param {string} path
 * @returns {string}
 */
/*
 * Làm gì: Trích xuất tên tệp cơ sở (basename) từ đường dẫn file migration; dùng làm khóa định danh duy nhất trong bảng _migrations để đảm bảo mỗi migration chỉ chạy một lần duy nhất.
 * Được gọi ở: scripts/migration-plan.mjs (trong pendingMigrations), scripts/migration-plan.test.mjs ("test runner (node --test)").
 * - Tham số path: Đường dẫn đầy đủ, đường dẫn tương đối hoặc tên tệp migration cần chuẩn hóa.
 * - Trả về: Tên tệp cơ sở (basename) của migration (ví dụ: "0001_auth.sql").
 */
export function migrationName(path) {
  // Cắt chuỗi theo ký tự '/' và lấy phần tử cuối cùng để lấy basename; nếu không có dấu '/' thì giữ nguyên chuỗi path ban đầu.
  return path.split("/").pop() ?? path;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
/*
 * Làm gì: Kiểm tra một đường dẫn hoặc tên tệp có phải là file migration hợp lệ hay không (phải có phần mở rộng .sql).
 * Được gọi ở: scripts/migration-plan.mjs (trong pendingMigrations), scripts/migration-plan.test.mjs ("test runner (node --test)").
 * - Tham số path: Đường dẫn hoặc tên tệp cần kiểm tra.
 * - Trả về: true nếu tệp có đuôi .sql, ngược lại trả về false.
 */
export function isMigrationFile(path) {
  // Chỉ chấp nhận tệp kết thúc bằng đuôi .sql, bỏ qua các thư mục con (như migrations/auth/) và tệp không phải SQL.
  return path.endsWith(".sql");
}

/**
 * Migrations in `paths` that are not yet in `applied`, in apply order.
 * Non-`.sql` entries (a `readdir` also yields `migrations/auth/`) are dropped.
 * @param {Iterable<string>} paths
 * @param {Iterable<string>} applied
 * @returns {Array<{ name: string, path: string }>}
 */
/*
 * Làm gì: Lọc và trả về danh sách các migration .sql chưa từng được áp dụng, sắp xếp tăng dần theo tên tệp để đảm bảo thứ tự thực thi chuẩn xác.
 * Được gọi ở: scripts/migrate.mjs (hàm main khi deploy), src/server/data/db.ts (hàm applyMigrations cho PGLite preview), scripts/seed-lively.mjs, scripts/migration-plan.test.mjs ("test runner (node --test)").
 * - Tham số paths: Tập hợp các đường dẫn tệp migration quét được từ thư mục migrations/.
 * - Tham số applied: Tập hợp tên các migration đã chạy thành công trước đó (lấy từ bảng _migrations).
 * - Trả về: Mảng các object chứa name (basename) và path (đường dẫn nguồn), đã sắp xếp theo thứ tự cần áp dụng.
 */
export function pendingMigrations(paths, applied) {
  // Bước 1: Lưu danh sách migration đã chạy vào Set để tối ưu hóa việc tra cứu tồn tại với độ phức tạp O(1).
  const done = new Set(applied);
  // Bước 2: Chuyển đổi danh sách đường dẫn thành mảng để xử lý qua chuỗi thao tác lọc, ánh xạ và sắp xếp.
  return [...paths]
    .filter(isMigrationFile)
    .map((path) => ({ name: migrationName(path), path }))
    // Sắp xếp tăng dần theo tên file (localeCompare) để các migration luôn chạy đúng thứ tự tuần tự (ví dụ: 0001 trước 0002).
    .sort((a, b) => a.name.localeCompare(b.name))
    // Loại bỏ các migration đã có trong cơ sở dữ liệu để đảm bảo tính idempotent (không bao giờ chạy lại file đã áp dụng).
    .filter(({ name }) => !done.has(name));
}
