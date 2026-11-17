#!/usr/bin/env node
/**
 * Deploy-time database migrator (node-postgres, `pg`).
 *
 * Runs during `npm run build` — on every Vercel deploy — applying pending files
 * in ../migrations to DATABASE_URL. Each file is applied in one transaction and
 * recorded in a `_migrations` table, so it runs once and is safe to re-run.
 *
 * The read is non-recursive, so the opt-in auth schema under migrations/auth/
 * is not applied to an app that never asked for sign-in.
 *
 * No DATABASE_URL (local / preview builds) -> skip; the PGLite fallback applies
 * the same files at startup instead (see src/server/data/db.ts).
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { pendingMigrations } from "./migration-plan.mjs";

const databaseUrl = process.env.DATABASE_URL;
// Nếu không có DATABASE_URL (môi trường local hoặc preview), bỏ qua và thoát 0 vì PGLite sẽ tự chạy migration khi khởi động app.
if (!databaseUrl) {
  console.log(
    "[migrate] DATABASE_URL not set — skipping (the PGLite fallback migrates itself).",
  );
  process.exit(0);
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * Làm gì: Quét thư mục migrations/, đối chiếu với bảng _migrations và thực thi tuần tự các file .sql mới vào PostgreSQL qua transaction.
 * Được gọi ở: scripts/migrate.mjs (dòng 83, khi chạy npm run db:migrate hoặc trong build step npm run build trên Vercel).
 * @returns {Promise<void>} Không trả về giá trị.
 * @throws {Error} Ném lỗi khi quá trình đọc file SQL hoặc thực thi truy vấn database thất bại.
 */
async function main() {
  // Bước 1: Quét thư mục migrations/ để lấy danh sách các file migration (nếu chưa có thư mục thì dừng sớm).
  let entries;
  try {
    entries = await readdir(migrationsDir);
  } catch {
    console.log("[migrate] no migrations/ directory — nothing to do.");
    return;
  }
  // Bước 2: Kiểm tra nhanh xem có file .sql nào không; nếu không có thì dừng ngay để tránh tốn tài nguyên mở kết nối database.
  // An app with no schema of its own must not pay for a database connection.
  if (pendingMigrations(entries, []).length === 0) {
    console.log("[migrate] no migrations — nothing to do.");
    return;
  }

  // Bước 3: Khởi tạo connection pool tới PostgreSQL với max = 1 kết nối vì migration chỉ chạy tuần tự.
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    // Bước 4: Tạo bảng _migrations nếu chưa có để theo dõi lịch sử, sau đó lấy danh sách các migration đã được áp dụng.
    await client.query(
      "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const applied = (await client.query("SELECT name FROM _migrations")).rows.map(
      (r) => r.name,
    );

    // Bước 5: Lặp qua từng migration chưa được chạy (sắp xếp theo tên) và thực thi lần lượt.
    let count = 0;
    for (const { name } of pendingMigrations(entries, applied)) {
      const text = await readFile(join(migrationsDir, name), "utf8");
      try {
        // Thực thi nội dung file SQL trong một transaction: nếu lỗi sẽ rollback toàn bộ file để đảm bảo tính toàn vẹn (atomicity).
        await client.query("BEGIN");
        // pg's simple-query protocol runs a whole multi-statement file at once.
        await client.query(text);
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
      } catch (err) {
        console.error(`[migrate] error applying ${name}`);
        try {
          await client.query("ROLLBACK");
        } catch {
          // ROLLBACK fails when the connection died — keep the original error.
        }
        throw err;
      }
      console.log(`[migrate] applied ${name}`);
      count += 1;
    }
    console.log(count ? `[migrate] done — ${count} migration(s) applied.` : "[migrate] up to date.");
  } finally {
    // Bước 6: Đảm bảo giải phóng client về pool và đóng pool kết nối sau khi hoàn thành hoặc khi gặp lỗi.
    client.release();
    await pool.end();
  }
}

// Kích hoạt chạy migration và bắt lỗi toàn cục: in chi tiết lỗi từ PostgreSQL và thoát với mã lỗi 1 để dừng tiến trình build.
main().catch((err) => {
  console.error("[migrate] failed:", err?.message || err);
  // pg errors carry the context needed to debug a bad SQL file.
  for (const key of ["code", "detail", "hint", "position", "where"]) {
    if (err?.[key] != null) console.error(`[migrate]   ${key}: ${err[key]}`);
  }
  process.exit(1);
});
