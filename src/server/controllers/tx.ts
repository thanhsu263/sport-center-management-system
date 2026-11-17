/**
 * File: src/server/controllers/tx.ts
 * Vai trò: Quản lý transaction cơ sở dữ liệu và các hàm tiện ích thực thi SQL trong hệ thống Arena 3.
 * Vị trí trong app: Chạy ở tầng server, bọc logic xử lý của các API handlers (src/server/controllers/router.ts, handlers/*)
 * nhằm đảm bảo tính toàn vẹn dữ liệu (ACID), tự động COMMIT/ROLLBACK trên cả hai môi trường: PGlite (local/test) và Neon PostgreSQL (production).
 */
import { dbSource, getPglite, type Sql } from "@/server/data/db";
import type { Pool, PoolClient } from "pg";

// Định nghĩa chữ ký hàm thực thi truy vấn SQL thô: nhận câu lệnh text và mảng tham số, trả về mảng bản ghi.
type Run = <T>(text: string, params: unknown[]) => Promise<T[]>;

/**
 * Làm gì: Bọc hàm thực thi câu lệnh SQL thô (run) thành đối tượng Sql, hỗ trợ cả tagged template literal (sql`...`) và phương thức sql.query().
 * Được gọi ở: Nội bộ src/server/controllers/tx.ts trong hàm withTx khi tạo đối tượng sql truyền vào callback nghiệp vụ.
 * @param run Hàm thực thi SQL nhận câu lệnh text và mảng tham số, trả về danh sách bản ghi.
 * @returns Đối tượng Sql tương thích với chuẩn giao tiếp cơ sở dữ liệu chung của toàn hệ thống.
 */
function wrap(run: Run): Sql {
  // Bước 1: Tạo tagged template function, tự động chuyển đổi các biến nội suy thành cú pháp tham số hóa $1, $2... nhằm chống lỗi SQL Injection.
  const sql = (async <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> => {
    let text = strings[0] ?? "";
    for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
    return run<T>(text, values);
  }) as unknown as Sql;
  // Bước 2: Bổ sung phương thức .query() truyền thống để thực thi câu lệnh với tham số truyền qua mảng.
  sql.query = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    run<T>(text, params);
  return sql;
}

// Lưu trữ connection pool trên globalThis để không bị tạo mới sau mỗi lần HMR (Hot Module Replacement) khi phát triển.
const globalRef = globalThis as typeof globalThis & { __arena3NeonPool__?: Pool };

/**
 * Làm gì: Khởi tạo và trả về đối tượng connection pool singleton kết nối tới Neon PostgreSQL, cấu hình sẵn type parser cho các kiểu dữ liệu đặc thù.
 * Được gọi ở: Nội bộ src/server/controllers/tx.ts trong hàm withTx khi chạy với database Neon ở môi trường production.
 * @returns Thể hiện Pool của thư viện pg đã kết nối tới DATABASE_URL.
 */
async function neonPool(): Promise<Pool> {
  // Bước 1: Kiểm tra singleton trên globalThis, nếu chưa có thì tiến hành khởi tạo.
  if (!globalRef.__arena3NeonPool__) {
    const { Pool: PgPool, types } = await import("pg");
    // Bước 2: Chuẩn hóa type parser: ép kiểu OID 20 (int8/BIGINT) sang Number tránh lỗi JSON; giữ OID 1082 (DATE) và 1186 (INTERVAL) dạng string tránh lệch múi giờ.
    types.setTypeParser(20, Number);
    types.setTypeParser(1082, (v: string) => v);
    types.setTypeParser(1186, (v: string) => v);
    // Bước 3: Tạo connection pool mới từ DATABASE_URL và lắng nghe sự kiện lỗi nền để tránh dừng tiến trình.
    const pool = new PgPool({ connectionString: process.env.DATABASE_URL });
    pool.on("error", (err) => {
      console.error("[arena3 neon pool error]", err.message);
    });
    globalRef.__arena3NeonPool__ = pool;
  }
  return globalRef.__arena3NeonPool__;
}

/**
 * Throw this when the writes made so far must survive the error — a wrong
 * password still has to count toward the lockout. `withTx` commits, then
 * rethrows `inner`.
 */
export class KeepWrites extends Error {
  readonly inner: unknown;
  constructor(inner: unknown) {
    super("keep writes");
    this.inner = inner;
  }
}

/**
 * @internal test-only
 * Overrides the PGlite instance used by `withTx` for isolated unit tests.
 */
let overridePglite: import("@electric-sql/pglite").PGlite | null = null;

/**
 * @internal test-only
 * Sets or clears the test PGlite override instance.
 */
export function setOverridePglite(pg: import("@electric-sql/pglite").PGlite | null): void {
  overridePglite = pg;
}

/**
 * Làm gì: Thực thi một hàm nghiệp vụ trong phạm vi database transaction, tự động COMMIT nếu thành công hoặc ROLLBACK nếu thất bại; hỗ trợ ngoại lệ KeepWrites để lưu dữ liệu kiểm toán trước khi ném lỗi.
 * Được gọi ở: src/server/controllers/router.ts (dispatch các API routes), các integration tests trong flows.test.ts và tx.test.ts.
 * @param fn Hàm callback chứa logic nghiệp vụ, nhận đối tượng Sql để thực thi truy vấn trong transaction.
 * @returns Kết quả trả về từ hàm callback fn.
 * @throws Lỗi nghiệp vụ từ callback fn, lỗi gốc trong KeepWrites.inner, hoặc lỗi cơ sở dữ liệu.
 */
export async function withTx<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  // Nhánh 1: Môi trường test cô lập hoặc dev local sử dụng PGlite (PostgreSQL WASM in-memory).
  if (overridePglite || dbSource === "pglite") {
    // Bước 1: Lấy instance PGlite (ưu tiên instance ghi đè từ unit test nếu có).
    const pg = overridePglite ?? (await getPglite());
    let keptError: unknown = undefined;
    let hasKeptError = false;
    // Bước 2: Mở transaction bằng pg.transaction() và thực thi hàm callback fn.
    const out = await pg.transaction(async (tx) => {
      const run: Run = async <R>(text: string, params: unknown[]) => {
        const result = await tx.query<R>(text, params ?? []);
        return result.rows;
      };
      // Nếu gặp KeepWrites (ví dụ: đếm số lần nhập sai mật khẩu để khóa tài khoản), lưu lại lỗi và cho phép transaction COMMIT bình thường.
      try {
        return await fn(wrap(run));
      } catch (e) {
        if (e instanceof KeepWrites) {
          keptError = e.inner;
          hasKeptError = true;
          return undefined as unknown as T;
        }
        throw e;
      }
    });
    // Bước 3: Sau khi transaction đã COMMIT thành công trên PGlite, ném lại lỗi gốc đã lưu.
    if (hasKeptError) {
      throw keptError;
    }
    return out;
  }
  // Nhánh 2: Môi trường production sử dụng Neon PostgreSQL thông qua connection pool.
  const pool = await neonPool();
  // Bước 1: Mượn một kết nối (client) từ pool và gắn listener ghi log nếu phát sinh lỗi kết nối nền.
  const client: PoolClient = await pool.connect();
  const clientErrHandler = (err: Error) => {
    console.error("[arena3 client error]", err.message);
  };
  client.on("error", clientErrHandler);
  let hasError = false;
  // Bước 2: Bắt đầu transaction bằng lệnh BEGIN, chạy fn, và phát lệnh COMMIT khi hoàn tất thành công.
  try {
    await client.query("BEGIN");
    const run: Run = async <R>(text: string, params: unknown[]) => {
      const result = await client.query(text, params ?? []);
      return result.rows as R[];
    };
    const out = await fn(wrap(run));
    await client.query("COMMIT");
    return out;
  // Bước 3: Bắt và xử lý các lỗi phát sinh trong transaction.
  } catch (e) {
    // Nếu là KeepWrites: COMMIT các thao tác ghi nhận trước đó (như tăng số lần thử OTP thất bại) rồi mới ném lỗi inner.
    if (e instanceof KeepWrites) {
      try {
        await client.query("COMMIT");
        hasError = false;
      } catch (commitErr) {
        hasError = true;
        try {
          await client.query("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw commitErr;
      }
      throw e.inner;
    }
    // Với các lỗi thông thường khác: đánh dấu lỗi kết nối và ROLLBACK toàn bộ thay đổi.
    hasError = true;
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  // Bước 4: Hủy listener lỗi và hoàn trả client về pool (truyền hasError để pool hủy client nếu kết nối bị hỏng).
  } finally {
    client.removeListener("error", clientErrHandler);
    client.release(hasError);
  }
}

/**
 * Làm gì: Thực thi truy vấn SQL và trả về duy nhất bản ghi đầu tiên trong kết quả, hoặc undefined nếu không tìm thấy bản ghi nào.
 * Được gọi ở: Khắp các handlers trong src/server/controllers/handlers/* (auth, bookings, classes, members...), helpers.ts, session.ts.
 * @param sql Đối tượng Sql thực thi truy vấn (từ withTx hoặc getSql).
 * @param text Câu lệnh SQL dạng text, thường chứa placeholder tham số ($1, $2...).
 * @param params Mảng giá trị truyền vào thay thế cho các placeholder (mặc định là mảng rỗng).
 * @returns Bản ghi đầu tiên dạng đối tượng kiểu T hoặc undefined nếu không có kết quả.
 */
export async function one<T>(sql: Sql, text: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await sql.query<T>(text, params);
  return rows[0];
}

/**
 * Làm gì: Helper thực thi câu lệnh SQL với mảng tham số truyền vào và trả về toàn bộ danh sách bản ghi kết quả.
 * Được gọi ở: src/server/controllers/session.ts, handlers/google.ts, handlers/staff.ts, services/membership.ts.
 * @param sql Đối tượng Sql thực thi truy vấn.
 * @param text Câu lệnh SQL dạng text có chứa placeholder tham số ($1, $2...).
 * @param params Mảng giá trị truyền vào thay thế cho các placeholder (mặc định là mảng rỗng).
 * @returns Mảng chứa tất cả các bản ghi kết quả kiểu T.
 */
export async function q<T>(sql: Sql, text: string, params: unknown[] = []): Promise<T[]> {
  return sql.query<T>(text, params);
}
