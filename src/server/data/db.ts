/**
 * Tệp này làm gì: Khởi tạo và quản lý kết nối cơ sở dữ liệu PostgreSQL cho toàn bộ server.
 * Tự động chọn giữa Neon (Postgres đám mây khi deploy production) và PGLite (Postgres nhúng WASM chạy local dev/preview).
 * Tự động quét và áp dụng các file migration trong migrations/*.sql trước khi xử lý truy vấn đầu tiên.
 */
import { pendingMigrations } from "../../../scripts/migration-plan.mjs";

/** Which database backend is active. */
export type DbSource = "neon" | "pglite";

// An empty/whitespace DATABASE_URL (an easy misconfig in deploy UIs) must mean
// "unset" — otherwise production would silently run on the PGLite fallback.
const rawDatabaseUrl =
  typeof process !== "undefined" ? process.env.DATABASE_URL : undefined;
const databaseUrl =
  rawDatabaseUrl && rawDatabaseUrl.trim() ? rawDatabaseUrl : undefined;

/**
 * Active backend: real **Neon** when `DATABASE_URL` is set (deployed / configured
 * sandbox), otherwise a local embedded **PGLite** (Postgres compiled to WASM) so
 * the app has a working database even with nothing configured — the live preview
 * included. Swap in Neon later by just setting `DATABASE_URL`; no code changes.
 */
const isDeploy = typeof process !== "undefined" && (Boolean(process.env.VERCEL) || process.env.NODE_ENV === "production");
/**
 * Làm gì: Xác định backend cơ sở dữ liệu đang hoạt động ("neon" khi đã deploy và có DATABASE_URL, hoặc "pglite" khi chạy preview/local).
 * Được gọi ở: src/server/controllers/tx.ts (hàm runInTransaction), nội bộ src/server/data/db.ts (trong createSql, getPglite, ensureDbReady).
 * @returns Tên backend cơ sở dữ liệu ("neon" | "pglite").
 */
export const dbSource: DbSource = databaseUrl && isDeploy ? "neon" : "pglite";

/**
 * Minimal shared SQL surface, satisfied by both Neon and PGLite. Both the
 * tagged-template and `.query()` forms resolve to an array of row objects:
 *
 *   const sql = await getSql();
 *   const rows = await sql`select * from todos where id = ${id}`; // parameterized
 *   const rows2 = await sql.query("select * from todos where id = $1", [id]);
 */
export interface Sql {
  <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
}

/**
 * Init state lives on globalThis as promises: dev HMR creates new instances of
 * this module, and two instances racing module-level state would open a second
 * pool or run two concurrent PGLite migration passes (whose duplicate
 * `_migrations` insert rejects — and would get memoized, poisoning every later
 * `getSql()`). A failed init clears its slot so the next call retries.
 */
const globalRef = globalThis as typeof globalThis & {
  __pgSqlPromise__?: Promise<Sql>;
  __pgliteInstance__?: Promise<import("@electric-sql/pglite").PGlite>;
  __pgliteMigrateChain__?: Promise<void>;
};

/**
 * Result-type parity: Postgres sends every value as text plus a type OID — the
 * JS value is the DRIVER's parsing choice, and pg and PGLite disagree (pg:
 * int8 -> string, date -> local-midnight Date; PGLite: int8 -> BigInt, which
 * JSON.stringify rejects, date -> UTC Date). Normalize both so preview and
 * production return identical, JSON-safe shapes:
 *   int8/bigint (incl. count(*)) -> number (past 2^53 loses precision — cast
 *                                   `::text` if you ever need huge integers)
 *   date                         -> 'YYYY-MM-DD' string
 *   interval                     -> Postgres interval text
 * numeric already comes back as a string on both (arbitrary precision).
 */
const OID_INT8 = 20;
const OID_DATE = 1082;
const OID_INTERVAL = 1186;
/**
 * Làm gì: Hàm định danh giữ nguyên chuỗi text từ Postgres mà không ép kiểu qua Date hoặc đối tượng khác.
 * Được gọi ở: createNeonSql và createPgliteSql (đăng ký type parser cho OID_DATE và OID_INTERVAL).
 * @param v Chuỗi giá trị gốc từ database driver.
 * @returns Đúng chuỗi giá trị đầu vào.
 */
const identity = (v: string) => v;

type Run = <T>(text: string, params: unknown[]) => Promise<T[]>;

/** Wrap a query runner in the tagged-template + `.query()` `Sql` surface. */
/**
 * Làm gì: Đóng gói một hàm thực thi query cấp thấp thành đối tượng Sql hỗ trợ cả tagged template (sql`...`) và method query().
 * Được gọi ở: createNeonSql (dòng 101) và createPgliteSql (dòng 205) trong tệp này.
 * @param run Hàm nhận câu lệnh SQL và mảng tham số, trả về Promise chứa danh sách bản ghi kết quả.
 * @returns Đối tượng Sql thống nhất để thực thi truy vấn an toàn với prepared statement.
 */
function toSql(run: Run): Sql {
  // Bước 1: Tạo hàm thực thi truy vấn dạng tagged template sql`...`, tự động chuyển các biến nội suy thành $1, $2 để chống SQL Injection.
  const sql = (async <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> => {
    // Rebuild with $1, $2, … placeholders so values stay parameterized.
    let text = strings[0];
    for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
    return run<T>(text, values);
  }) as unknown as Sql;
  // Bước 2: Bổ sung phương thức .query() truyền thống để thực thi câu lệnh SQL dạng chuỗi kèm mảng tham số.
  sql.query = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    run<T>(text, params);
  // Bước 3: Trả về đối tượng Sql đã được đóng gói hoàn chỉnh.
  return sql;
}

/**
 * Làm gì: Khởi tạo kết nối Neon PostgreSQL qua node-postgres (pg), cấu hình chuẩn hóa kiểu dữ liệu và bọc trong interface Sql.
 * Được gọi ở: createSql (dòng 220) trong tệp này khi dbSource là "neon".
 * @returns Promise chứa client Sql kết nối tới pool Neon PostgreSQL.
 * @throws Error nếu kết nối tới database thất bại hoặc URL cấu hình sai.
 */
function createNeonSql(): Promise<Sql> {
  // Bước 1: Khởi tạo promise singleton trên globalThis để tránh mở nhiều pool khi Vite HMR reload module.
  globalRef.__pgSqlPromise__ ??= (async () => {
    // Regular Postgres driver: node-postgres (`pg`) — works directly with Neon's
    // pooled endpoint. One pool per process; warm serverless instances reuse it.
    // Bước 2: Nạp động module 'pg' và cấu hình parser để chuẩn hóa kiểu dữ liệu đồng nhất với PGLite.
    const { Pool, types } = await import("pg");
    // Chuyển kiểu int8 (bigint, count(*)) sang number trong JS để tránh lỗi khi JSON.stringify().
    types.setTypeParser(OID_INT8, Number);
    // Giữ nguyên chuỗi ngày (YYYY-MM-DD) và khoảng thời gian (interval) thay vì parse sang Date để tránh lệch múi giờ.
    types.setTypeParser(OID_DATE, identity);
    types.setTypeParser(OID_INTERVAL, identity);
    // Bước 3: Tạo connection pool tới Neon dùng chung cho toàn bộ tiến trình.
    const pool = new Pool({ connectionString: databaseUrl });
    // Bắt lỗi kết nối đột ngột của client trong pool ở chế độ nền để không làm sập tiến trình Node.js.
    pool.on("error", (err) => {
      console.error("[db pool error]", err.message);
    });
    // Bước 4: Đóng gói hàm query của pool vào interface Sql qua helper toSql.
    return toSql(async <T>(text: string, params: unknown[]) => {
      const res = await pool.query(text, params);
      return res.rows as T[];
    });
  })().catch((err) => {
    // Xóa slot promise đã lưu trên globalThis khi khởi tạo thất bại để lần gọi getSql tiếp theo có thể thử lại.
    globalRef.__pgSqlPromise__ = undefined;
    throw err;
  });
  return globalRef.__pgSqlPromise__;
}

/**
 * Where the embedded database keeps itself between runs.
 *
 * Empty means in memory, which is what this used to be unconditionally — and
 * it meant every dev-server restart threw away every booking, payment, receipt
 * and account anybody had made. That is tolerable while the app is a sketch
 * and expensive once it is being demonstrated.
 *
 * It also broke online payment outright. Document codes come from a counter in
 * this database; payOS remembers the order codes it has seen forever. Wiping
 * the counter sent the sequence back over ground payOS had already covered, and
 * it rejected every link with "order already exists".
 *
 * `PGLITE_DATA_DIR=memory` restores the old behaviour for a throwaway run.
 */
const PGLITE_DIR = (() => {
  const configured = process.env.PGLITE_DATA_DIR?.trim();
  if (configured === "memory") return undefined;
  return configured || ".pglite";
})();

/**
 * Làm gì: Khởi tạo database PGLite nhúng (WASM), nạp và thực thi tuần tự các file migration chưa áp dụng trong migrations/*.sql.
 * Được gọi ở: createSql (dòng 220) khi dbSource là "pglite" (môi trường dev local hoặc preview).
 * @returns Promise chứa client Sql kết nối tới instance PGLite.
 * @throws Error nếu khởi tạo PGLite thất bại hoặc quá trình chạy file migration bị lỗi.
 */
async function createPgliteSql(): Promise<Sql> {
  // Embedded Postgres, imported on demand so it never loads on the Neon path.
  // One instance per process, shared across HMR module instances.
  // Bước 1: Khởi tạo instance PGLite singleton và lưu vào globalThis để tránh tạo nhiều bản sao khi dev HMR.
  globalRef.__pgliteInstance__ ??= (async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    if (PGLITE_DIR) console.info(`[db] PGLite persisting to ${PGLITE_DIR}`);
    else console.info("[db] PGLite running in memory — data resets on restart");
    // Cấu hình thư mục lưu dữ liệu và bộ parser kiểu dữ liệu tương thích JSON tương tự như Neon.
    const pg = new PGlite({
      ...(PGLITE_DIR ? { dataDir: PGLITE_DIR } : {}),
      parsers: {
        [OID_INT8]: Number,
        [OID_DATE]: identity,
        [OID_INTERVAL]: identity,
      },
    });
    // Đợi engine WASM của Postgres sẵn sàng và khởi tạo bảng _migrations để lưu lịch sử migration.
    await pg.waitReady;
    await pg.exec(
      "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    return pg;
  })().catch((err) => {
    // Xóa instance cache nếu khởi tạo thất bại để cho phép thử lại ở lần gọi sau.
    globalRef.__pgliteInstance__ = undefined;
    throw err;
  });
  // Lấy instance PGLite đã sẵn sàng từ promise singleton.
  const pg = await globalRef.__pgliteInstance__;

  // Apply migrations/ (the single schema source) so preview matches production.
  // SQL is inlined by the bundler via import.meta.glob (no runtime fs); applied
  // files are tracked in _migrations. The glob does not descend, so the opt-in
  // auth schema under migrations/auth/ stays out. Runs once per module instance
  // — so an HMR reload after adding a migration file applies it live — with
  // passes serialized on a global chain so concurrent callers never
  // double-apply.
  /**
   * Làm gì: Quét thư mục migrations/, đối chiếu với bảng _migrations và chạy các migration còn thiếu trong database transaction.
   * Được gọi ở: Nội bộ createPgliteSql (dòng 201) thông qua chuỗi promise globalRef.__pgliteMigrateChain__.
   * @returns Promise hoàn thành sau khi tất cả migration mới đã được áp dụng thành công.
   * @throws Error nếu có bất kỳ file migration nào thực thi câu lệnh SQL thất bại.
   */
  const migrate = async (): Promise<void> => {
    // Bước 2.1: Thu thập nội dung tất cả các file migration *.sql.
    let migrations: Record<string, string> = {};
    // Trên môi trường bundler (Vite), dùng import.meta.glob để nạp sẵn file SQL vào bộ nhớ mà không cần đọc fs khi runtime.
    if (typeof (import.meta as any).glob === "function") {
      migrations = (import.meta as any).glob("/migrations/*.sql", {
        query: "?raw",
        import: "default",
        eager: true,
      }) as Record<string, string>;
    } else {
      // Trên môi trường Node.js thuần (không có Vite bundler), đọc trực tiếp các file .sql từ thư mục migrations.
      const fs = await import("node:fs");
      const path = await import("node:path");
      const migDir = path.resolve(process.cwd(), "migrations");
      if (fs.existsSync(migDir)) {
        for (const file of fs.readdirSync(migDir)) {
          if (file.endsWith(".sql")) {
            migrations[`/migrations/${file}`] = fs.readFileSync(path.join(migDir, file), "utf-8");
          }
        }
      }
    }
    // Bước 2.2: Lấy danh sách tên các file migration đã thực thi thành công từ bảng _migrations.
    const doneRows = await pg.query<{ name: string }>(
      "select name from _migrations",
    );
    const done = doneRows.rows.map((r) => r.name);
    // Bước 2.3: Lọc danh sách migration chưa chạy theo thứ tự và thực thi từng file trong một database transaction.
    for (const { name, path } of pendingMigrations(Object.keys(migrations), done)) {
      // Apply + record atomically (parity with scripts/migrate.mjs) so a failed
      // statement can't leave a file half-applied but untracked.
      // Đảm bảo tính nguyên tử: thực thi nội dung SQL và ghi nhận vào _migrations cùng nhau, lỗi sẽ rollback toàn bộ.
      await pg.transaction(async (tx) => {
        await tx.exec(migrations[path]);
        await tx.query("insert into _migrations (name) values ($1)", [name]);
      });
    }
  };
  // Bước 3: Nối hàm migrate vào chuỗi promise toàn cục để đảm bảo các tiến trình gọi đồng thời chạy tuần tự, không bị trùng lặp.
  const pass = (globalRef.__pgliteMigrateChain__ ?? Promise.resolve())
    .catch(() => undefined) // an earlier failed pass must not wedge the chain
    .then(migrate);
  globalRef.__pgliteMigrateChain__ = pass;
  await pass;

  // Bước 4: Đóng gói instance PGLite vào interface Sql chuẩn dùng chung thông qua toSql.
  return toSql(async <T>(text: string, params: unknown[]) => {
    const result = await pg.query<T>(text, params);
    return result.rows;
  });
}

let sqlPromise: Promise<Sql> | null = null;

/**
 * Làm gì: Bộ điều phối trung tâm kiểm tra tính hợp lệ của môi trường chạy (server-only) và điều hướng tạo kết nối Neon hoặc PGLite.
 * Được gọi ở: getSql (dòng 231) trong file này.
 * @returns Promise chứa client Sql tương ứng với backend đang hoạt động.
 * @throws Error nếu hàm bị gọi từ mã phía client (trình duyệt).
 */
async function createSql(): Promise<Sql> {
  // Bước 1: Chặn tuyệt đối việc gọi từ trình duyệt để tránh rò rỉ credential và lỗi runtime.
  if (typeof window !== "undefined") {
    throw new Error(
      "@/server/data/db is server-only — call getSql() from a createServerFn handler " +
        "or a server route loader, never from client code.",
    );
  }
  // Bước 2: Khởi tạo kết nối tương ứng dựa theo backend đã xác định trong dbSource.
  return dbSource === "neon" ? createNeonSql() : createPgliteSql();
}

/**
 * Get the shared, **server-only** SQL client. Neon when `DATABASE_URL` is set,
 * otherwise the local PGLite fallback. Memoized — safe to call per request.
 *
 * Schema comes from `migrations/*.sql` (0006–0008 ops: waitlist, F4–F6, equipment), auto-applied
 * before the first query — define tables there, never inline in server functions.
 */
/**
 * Làm gì: Cung cấp client Sql dùng chung (singleton) cho toàn bộ ứng dụng ở phía server, tự động ghi nhớ (memoize) kết quả khởi tạo.
 * Được gọi ở: Các server function và service trong app (src/server/controllers/router.ts, src/server/data/jobs.ts, src/server/services/catalog.ts, src/server/auth/middleware.ts, src/routes/__root.tsx).
 * @returns Promise chứa client Sql hỗ trợ template tag sql`...` và phương thức query().
 * @throws Error nếu khởi tạo kết nối database thất bại hoặc bị gọi nhầm từ phía client.
 */
export function getSql(): Promise<Sql> {
  // Bước 1: Khởi tạo singleton promise một lần duy nhất; nếu thất bại thì xóa memoize để cho phép thử lại ở request kế tiếp.
  sqlPromise ??= createSql().catch((err) => {
    sqlPromise = null; // don't memoize failures — let the next call retry
    throw err;
  });
  // Bước 2: Trả về promise kết nối cơ sở dữ liệu đã memoize.
  return sqlPromise;
}

/**
 * The shared PGLite instance (preview only), with `migrations/*.sql` applied.
 * Lets Better Auth persist to the SAME embedded DB as app data in preview (via a
 * Kysely dialect). Throws when `DATABASE_URL` is set (that path uses Neon).
 */
/**
 * Làm gì: Lấy trực tiếp instance PGLite đã hoàn tất migration để dùng cho adapter cấp thấp (như Kysely dialect của Better Auth hoặc database transaction).
 * Được gọi ở: src/server/auth/server.ts (cấu hình Better Auth trong preview) và src/server/controllers/tx.ts (hàm runInTransaction).
 * @returns Promise chứa instance PGlite đã sẵn sàng và đã chạy đủ migration.
 * @throws Error nếu gọi khi đang dùng Neon (dbSource !== "pglite") hoặc PGLite khởi tạo thất bại.
 */
export async function getPglite(): Promise<import("@electric-sql/pglite").PGlite> {
  // Bước 1: Kiểm tra backend, chỉ cho phép truy cập instance PGLite ở môi trường preview/fallback.
  if (dbSource !== "pglite") {
    throw new Error("getPglite() is only available on the PGLite fallback (no DATABASE_URL)");
  }
  // Bước 2: Chờ getSql hoàn thành để đảm bảo instance PGLite và toàn bộ migration đã sẵn sàng.
  await getSql();
  // Bước 3: Lấy instance PGLite từ globalThis và kiểm tra tính hợp lệ trước khi trả về.
  const pg = await globalRef.__pgliteInstance__;
  if (!pg) throw new Error("PGLite instance failed to initialize");
  return pg;
}

/**
 * Finish DB bootstrap before the server handles traffic.
 *
 * - **PGLite** (preview / no `DATABASE_URL`): open the in-memory DB and apply
 *   `migrations/*.sql`. Idempotent — concurrent callers share one promise.
 * - **Neon**: no-op (pool is created lazily on first query).
 *
 * Vite `configureServer` awaits this at dev startup; production imports of this
 * module kick it off immediately (see bottom of file).
 */
/**
 * Làm gì: Kích hoạt khởi động và chạy migration cho database PGLite trước khi server bắt đầu nhận traffic của người dùng.
 * Được gọi ở: vite.config.ts (hook configureServer khi dev), src/server/auth/server.ts (khởi động auth) và tự chạy khi file db.ts được import ở server Node.js.
 * @returns Promise giải quyết khi database PGLite đã sẵn sàng; trả về Promise.resolve() ngay lập tức nếu dùng Neon.
 */
export function ensureDbReady(): Promise<void> {
  // Bước 1: Nếu dùng Neon thì không cần chạy trước (Neon dùng pool kết nối lười - lazy pool).
  if (dbSource !== "pglite") return Promise.resolve();
  // Bước 2: Với PGLite, gọi getSql() để ép nạp WASM và chạy hết migration trước khi tiếp nhận request.
  return getSql().then(() => undefined);
}

// Server-only eager start: kick PGLite bootstrap as soon as this module loads in
// Node. Client bundles never hit this path (`getSql` throws in the browser).
const globalBoot = globalThis as typeof globalThis & {
  __pgBootstrapPromise__?: Promise<void>;
};
// The test runner imports this module through the handlers. An eager PGLite here
// outlives the runner and rejects as an unhandledRejection, so `npm test` exits 1
// after the tests themselves have passed. `NODE_TEST_CONTEXT` is set on the
// worker before the file loads (`child-v8`). Tests open their own database.
const startedAsTestRunner =
  typeof process !== "undefined" && Boolean(process.env.NODE_TEST_CONTEXT);
// Tự động kích hoạt bootstrap database PGLite ngay khi nạp module trên môi trường server Node.js (ngoại trừ khi chạy test runner).
if (typeof window === "undefined" && dbSource === "pglite" && !startedAsTestRunner) {
  globalBoot.__pgBootstrapPromise__ ??= ensureDbReady().catch((err) => {
    globalBoot.__pgBootstrapPromise__ = undefined;
    console.error("[db] PGLite bootstrap failed:", err);
    throw err;
  });
}
