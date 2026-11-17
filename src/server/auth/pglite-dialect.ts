/**
 * Kysely dialect for Better Auth over the app's embedded PGLite instance.
 * Lazy: resolves `getClient` on first connection so migrations can finish first.
 */
import type { PGlite } from "@electric-sql/pglite";
import {
  CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type Driver,
  type Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryCompiler,
  type QueryResult,
  type TransactionSettings,
} from "kysely";

type Client = PGlite;

/** Factory used by `auth/server.ts`: `pgliteDialect(() => getPglite())`. */
/**
 * Làm gì: Tạo Kysely Dialect tùy chỉnh kết nối với instance PGLite nhúng (embedded) cho Better Auth khi chạy ở môi trường preview (không có DATABASE_URL).
 * Được gọi ở: src/server/auth/server.ts (cấu hình biến database cho Better Auth).
 * @param getClient Hàm getter bất đồng bộ hoặc đồng bộ trả về client PGLite singleton (thường là () => getPglite()).
 * @returns Đối tượng Dialect của Kysely triển khai đầy đủ adapter, driver, query compiler và introspector chuẩn Postgres.
 */
export function pgliteDialect(
  getClient: () => Promise<Client> | Client,
): Dialect {
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new LazyPGliteDriver(getClient),
    createQueryCompiler: (): QueryCompiler => new PostgresQueryCompiler(),
    createIntrospector: (db: Kysely<unknown>): DatabaseIntrospector =>
      new PostgresIntrospector(db),
  };
}

/**
 * Làm gì: Driver Kysely hỗ trợ lazy loading client PGLite và quản lý hàng đợi kết nối (single connection queue) cho database nhúng.
 * Được gọi ở: pgliteDialect (phương thức createDriver).
 */
class LazyPGliteDriver implements Driver {
  private client: Client | undefined;
  private connection: PGliteConnection | undefined;
  private queue: Array<(con: PGliteConnection) => void> = [];

  /**
   * Làm gì: Khởi tạo driver với hàm lấy client PGLite.
   * Được gọi ở: pgliteDialect (trong createDriver).
   * @param getClient Hàm trả về instance PGLite (đồng bộ hoặc bất đồng bộ).
   */
  constructor(private readonly getClient: () => Promise<Client> | Client) {}

  /**
   * Làm gì: Khởi tạo client PGLite trước khi driver bắt đầu nhận truy vấn.
   * Được gọi ở: Kysely framework khi driver khởi tạo.
   * @returns Promise rỗng khi client đã sẵn sàng.
   */
  async init(): Promise<void> {
    this.client = await this.getClient();
  }

  /**
   * Làm gì: Xin cấp một kết nối DatabaseConnection để thực thi truy vấn; xếp hàng đợi (queue) nếu kết nối đang bận vì PGLite đơn luồng.
   * Được gọi ở: Kysely runtime trước khi thực thi truy vấn hoặc mở transaction.
   * @returns Kết nối PGliteConnection đã sẵn sàng để truy vấn.
   */
  async acquireConnection(): Promise<DatabaseConnection> {
    // Bước 1: Khởi tạo client PGLite nếu chưa có (lazy load để chờ migrations hoàn tất trước)
    if (this.client === undefined) {
      this.client = await this.getClient();
    }
    // Bước 2: Vì PGLite là DB nhúng đơn luồng, nếu kết nối đang bận thì đẩy resolve vào hàng đợi để chờ releaseConnection
    if (this.connection !== undefined) {
      return new Promise((resolve) => {
        this.queue.push(resolve);
      });
    }
    // Bước 3: Tạo mới wrapper PGliteConnection và lưu lại làm kết nối duy nhất đang hoạt động
    this.connection = new PGliteConnection(this.client);
    return this.connection;
  }

  /**
   * Làm gì: Giải phóng kết nối sau khi thực thi truy vấn xong và chuyển giao kết nối cho request tiếp theo trong hàng đợi.
   * Được gọi ở: Kysely runtime sau khi hoàn thành truy vấn hoặc kết thúc transaction.
   * @param connection Kết nối cần giải phóng.
   * @throws Error "Invalid connection" nếu kết nối giải phóng không khớp với kết nối hiện tại.
   */
  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    // Kiểm tra tính hợp lệ: chỉ cho phép giải phóng đúng kết nối đang được driver nắm giữ
    if (connection !== this.connection) {
      throw new Error("Invalid connection");
    }
    // Bước 1: Lấy resolver của request tiếp theo đang chờ trong hàng đợi
    const next = this.queue.shift();
    // Bước 2: Nếu không còn request nào chờ, đặt connection về undefined để request sau tạo mới
    if (next === undefined) {
      this.connection = undefined;
      return;
    }
    // Bước 3: Bàn giao kết nối hiện tại cho request kế tiếp đang chờ
    next(this.connection);
  }

  /**
   * Làm gì: Bắt đầu một transaction trên kết nối cơ sở dữ liệu với mức độ cô lập (isolation level) tương ứng.
   * Được gọi ở: Kysely runtime khi gọi db.transaction().
   * @param conn Kết nối PGliteConnection thực hiện transaction.
   * @param settings Cấu hình transaction (chứa isolationLevel nếu có).
   * @returns Promise rỗng khi lệnh SQL bắt đầu transaction chạy thành công.
   */
  async beginTransaction(
    conn: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    const c = conn as PGliteConnection;
    // Nếu có thiết lập mức cô lập thì chạy cú pháp 'start transaction isolation level ...', ngược lại chạy lệnh 'begin' mặc định
    if (settings.isolationLevel) {
      await c.executeQuery(
        CompiledQuery.raw(
          `start transaction isolation level ${settings.isolationLevel}`,
        ),
      );
    } else {
      await c.executeQuery(CompiledQuery.raw("begin"));
    }
  }

  /**
   * Làm gì: Xác nhận (commit) transaction hiện tại để ghi nhận vĩnh viễn các thay đổi vào database.
   * Được gọi ở: Kysely runtime khi khối db.transaction() hoàn thành thành công.
   * @param conn Kết nối đang thực thi transaction.
   * @returns Promise rỗng khi lệnh commit chạy xong.
   */
  async commitTransaction(conn: DatabaseConnection): Promise<void> {
    await (conn as PGliteConnection).executeQuery(CompiledQuery.raw("commit"));
  }

  /**
   * Làm gì: Hoàn tác (rollback) transaction hiện tại khi xảy ra lỗi trong quá trình thực thi.
   * Được gọi ở: Kysely runtime khi khối db.transaction() ném ra lỗi.
   * @param conn Kết nối đang thực thi transaction.
   * @returns Promise rỗng khi lệnh rollback chạy xong.
   */
  async rollbackTransaction(conn: DatabaseConnection): Promise<void> {
    await (conn as PGliteConnection).executeQuery(
      CompiledQuery.raw("rollback"),
    );
  }

  /**
   * Làm gì: Dọn dẹp tài nguyên nội bộ của driver (xóa tham chiếu connection, client và hàng đợi chờ).
   * Được gọi ở: Kysely runtime khi gọi db.destroy().
   * @returns Promise rỗng khi hoàn tất dọn dẹp.
   */
  async destroy(): Promise<void> {
    // Do not close the client: it is the shared getPglite() singleton used by
    // app SQL (getSql). Only drop our local handle so auth teardown cannot
    // poison the rest of the process.
    this.client = undefined;
    this.connection = undefined;
    this.queue = [];
  }
}

/**
 * Làm gì: Triển khai DatabaseConnection của Kysely để thực thi truy vấn SQL đơn lẻ hoặc streaming trên PGLite instance.
 * Được gọi ở: LazyPGliteDriver (phương thức acquireConnection).
 */
class PGliteConnection implements DatabaseConnection {
  /**
   * Làm gì: Khởi tạo kết nối với client PGLite cụ thể.
   * Được gọi ở: LazyPGliteDriver (phương thức acquireConnection).
   * @param client Instance PGLite dùng để gửi truy vấn SQL.
   */
  constructor(private readonly client: Client) {}

  /**
   * Làm gì: Thực thi một câu truy vấn SQL đã biên dịch (compiled query) và trả về danh sách các hàng kết quả kèm số lượng hàng bị ảnh hưởng.
   * Được gọi ở: Kysely runtime khi thực thi các câu lệnh SELECT, INSERT, UPDATE, DELETE.
   * @param compiledQuery Đối tượng câu truy vấn gồm chuỗi SQL và mảng tham số (parameters).
   * @returns Đối tượng QueryResult chứa mảng rows và numAffectedRows (nếu có).
   */
  async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    // Bước 1: Gửi câu lệnh SQL kèm danh sách tham số tới PGLite instance để thực thi
    const result = await this.client.query(compiledQuery.sql, [
      ...compiledQuery.parameters,
    ]);
    // Bước 2: Nếu câu lệnh làm thay đổi dữ liệu (INSERT/UPDATE/DELETE), trả về thêm numAffectedRows kiểu BigInt theo chuẩn Kysely
    if (result.affectedRows) {
      return {
        numAffectedRows: BigInt(result.affectedRows),
        rows: result.rows as O[],
      };
    }
    return { rows: result.rows as O[] };
  }

  /**
   * Làm gì: Thực thi câu truy vấn SQL và trả về kết quả dạng luồng (async generator) theo từng khối (chunk) dữ liệu.
   * Được gọi ở: Kysely runtime khi gọi stream() trên truy vấn để đọc dữ liệu lớn tiết kiệm bộ nhớ.
   * @param compiledQuery Câu truy vấn SQL đã biên dịch và danh sách tham số.
   * @param chunkSize Số lượng hàng (record) tối đa trong mỗi khối dữ liệu trả về.
   * @returns AsyncIterableIterator phát ra từng phần kết quả QueryResult chứa các hàng theo kích thước chunkSize.
   * @throws Error "chunkSize must be a positive integer" nếu chunkSize không phải số nguyên dương.
   */
  async *streamQuery<O>(
    compiledQuery: CompiledQuery,
    chunkSize: number,
  ): AsyncIterableIterator<QueryResult<O>> {
    // Bước 1: Xác thực tham số chunkSize phải là số nguyên dương lớn hơn 0
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new Error("chunkSize must be a positive integer");
    }
    // Bước 2: Thực thi truy vấn lấy toàn bộ dữ liệu từ PGLite instance
    const result = await this.client.query(compiledQuery.sql, [
      ...compiledQuery.parameters,
    ]);
    // Bước 3: Cắt nhỏ mảng kết quả thành các phần (chunk) theo kích thước chunkSize và yield lần lượt
    for (let i = 0; i < result.rows.length; i += chunkSize) {
      yield { rows: result.rows.slice(i, i + chunkSize) as O[] };
    }
  }
}
