/**
 * File: src/server/controllers/errors.ts
 * Vai trò: Định nghĩa lớp lỗi ApiError, danh sách mã lỗi ErrorCode, bộ helper tạo lỗi nhanh err, tiện ích HTTP json, cùng các hàm chuyển đổi lỗi cơ sở dữ liệu Postgres (mapDbError) và xử lý lỗi tập trung (handleError).
 * Vị trí trong app: Chạy ở tầng server, được tất cả các API controller/handler (src/server/controllers/handlers/*) và router chính (src/server/controllers/router.ts) sử dụng để chuẩn hóa phản hồi lỗi JSON trả về cho client.
 */
export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT_SLOT"
  | "HOLD_EXPIRED"
  | "CONFLICT_STATE"
  | "BR_VIOLATION"
  | "VALIDATION"
  | "RATE_LIMITED"
  | "INTERNAL";

/**
 * Làm gì: Lớp ngoại lệ đại diện cho các lỗi nghiệp vụ và HTTP của API trong toàn bộ hệ thống Arena3.
 * Được gọi ở: Các hàm helper trong đối tượng err, src/server/services/flags.ts, src/server/controllers/router.ts và các bài test.
 */
export class ApiError extends Error {
  // Declared longhand: `node --experimental-strip-types` (the unit tests) cannot
  // erase constructor parameter properties.
  status: number;
  code: ErrorCode;
  extra: Record<string, unknown>;

  /**
   * Làm gì: Khởi tạo đối tượng ApiError với HTTP status, mã lỗi ErrorCode, thông điệp và dữ liệu phụ trợ.
   * Được gọi ở: Các hàm tạo lỗi err.*, src/server/services/flags.ts (hàm requireFlag).
   * @param status Mã trạng thái HTTP (400, 401, 403, 404, 409, 422, 429).
   * @param code Mã phân loại lỗi chuẩn (ErrorCode).
   * @param message Thông điệp giải thích lỗi bằng tiếng Anh trả về cho client.
   * @param extra Các thông tin bổ sung đính kèm (ví dụ: tên field bị lỗi, mã quy tắc br).
   */
  constructor(status: number, code: ErrorCode, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }

  /**
   * Làm gì: Chuyển đổi thông tin lỗi thành đối tượng JSON chuẩn để đặt vào body của HTTP Response.
   * Được gọi ở: src/server/controllers/errors.ts (hàm handleError), src/server/controllers/router.ts (hàm handleApi).
   * @returns Đối tượng chứa code, message và các trường bổ sung từ extra.
   */
  body(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.extra };
  }
}

/**
 * Làm gì: Đối tượng chứa các hàm helper tiện ích giúp tạo nhanh thể hiện của ApiError theo từng tình huống nghiệp vụ thường gặp.
 * Được gọi ở: Khắp các API handlers (src/server/controllers/handlers/*), validate.ts và các file services (checkin.ts, promos.ts, membership.ts).
 */
export const err = {
  unauth: (msg = "Please sign in.") => new ApiError(401, "UNAUTHENTICATED", msg),
  forbidden: (msg = "You do not have permission.") => new ApiError(403, "FORBIDDEN", msg),
  notFound: (msg = "Not found.") => new ApiError(404, "NOT_FOUND", msg),
  // Trùng khung giờ sân hoặc lớp học (status 409), người khác đã giữ chỗ hoặc thanh toán.
  conflictSlot: (msg = "That slot is already held.", extra: Record<string, unknown> = {}) =>
    new ApiError(409, "CONFLICT_SLOT", msg, extra),
  // Thời gian giữ chỗ tạm thời (hold slot) đã hết hạn trước khi hoàn tất thanh toán (status 409).
  holdExpired: (msg = "Your hold has expired.") => new ApiError(409, "HOLD_EXPIRED", msg),
  // Xung đột trạng thái bản ghi hoặc luồng xử lý không hợp lệ (status 409).
  conflictState: (msg = "That is not a valid state.", extra: Record<string, unknown> = {}) =>
    new ApiError(409, "CONFLICT_STATE", msg, extra),
  conflict: (msg = "Conflict.", extra: Record<string, unknown> = {}) =>
    new ApiError(409, "CONFLICT_STATE", msg, extra),
  // Vi phạm quy tắc nghiệp vụ Business Rule (status 422) kèm mã định danh quy tắc (ví dụ: BR-02, BR-19).
  br: (br: string, message: string, extra: Record<string, unknown> = {}) =>
    new ApiError(422, "BR_VIOLATION", message, { br, ...extra }),
  // Lỗi xác thực dữ liệu logic nghiệp vụ (status 422), khác với lỗi 400 field sai cú pháp.
  validation: (message: string, extra: Record<string, unknown> = {}) =>
    new ApiError(422, "VALIDATION", message, extra),
  /**
   * A malformed form value, named by the field that carried it. 400 rather than
   * the 422 `validation` uses for state the request was well-formed about, so
   * the screen can put the message under the right input.
   */
  field: (field: string, message: string, extra: Record<string, unknown> = {}) =>
    new ApiError(400, "VALIDATION", message, { field, ...extra }),
  // Bị giới hạn tần suất gửi yêu cầu (status 429 Too Many Requests).
  rateLimited: (msg = "Too many attempts — try again later.") => new ApiError(429, "RATE_LIMITED", msg),
};

/**
 * Làm gì: Kiểm tra nhanh xem một ngoại lệ có phải là lỗi xung đột khung giờ đặt sân hoặc lớp học (CONFLICT_SLOT) hay không.
 * Được gọi ở: src/server/controllers/handlers/bookings.ts, src/server/controllers/handlers/classes.ts, src/server/controllers/handlers/extras.ts.
 * @param e Đối tượng lỗi cần kiểm tra.
 * @returns true nếu lỗi do vi phạm ràng buộc loại trừ của Postgres (23P01) hoặc thông điệp chứa CONFLICT_SLOT; ngược lại false.
 */
export function isConflictSlot(e: unknown): boolean {
  const x = e as { code?: string; message?: string };
  const msg = `${x?.code ?? ""} ${x?.message ?? ""}`;
  // 23P01 là mã PostgreSQL (exclusion_violation) khi vi phạm ràng buộc chống trùng lịch thời gian; CONFLICT_SLOT là mã lỗi nghiệp vụ của hệ thống.
  return x?.code === "23P01" || msg.includes("CONFLICT_SLOT");
}

/**
 * Làm gì: Tiện ích tạo đối tượng Response chuẩn Web API trả về dữ liệu định dạng JSON kèm HTTP status và header UTF-8.
 * Được gọi ở: src/server/controllers/errors.ts (hàm handleError), src/server/controllers/router.ts (hàm handleApi), src/server/controllers/handlers/assets.ts.
 * @param status Mã trạng thái HTTP trả về (ví dụ: 200, 400, 404, 500).
 * @param body Dữ liệu sẽ được tuần tự hóa thành chuỗi JSON trong body response.
 * @param headers Các HTTP header tùy chọn bổ sung gộp vào response.
 * @returns Đối tượng Response sẵn sàng gửi về client.
 */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

// Cấu trúc mô tả các trường thông tin lỗi trả về từ PostgreSQL driver.
type PgErrorShape = {
  code?: string;
  message?: string;
  column?: string;
  constraint?: string;
};

/**
 * What a database error means to the caller, when it means anything.
 *
 * Postgres says precisely what is wrong with a value — too long, out of range,
 * missing, a duplicate — and the old catch-all threw that away and answered
 * "Something went wrong on our side" with code `VALIDATION`, which told a
 * manager nothing and told the logs nothing they could not already see. A bad
 * value is the caller's to fix, so it comes back as a 4xx naming the column;
 * only an error nobody can attribute to the request is a 500.
 *
 * Returns null for anything else so the caller can decide it is a 500.
 */
export function mapDbError(e: unknown): { status: number; body: Record<string, unknown> } | null {
  const x = (e ?? {}) as PgErrorShape;
  const msg = `${x.code ?? ""} ${x.message ?? ""}`;
  // Bước 1: Kiểm tra các lỗi nghiệp vụ đặt sân và lớp học từ ràng buộc hoặc trigger database.
  // Mã 23P01 (exclusion_violation) là ràng buộc loại trừ của Postgres khi bị trùng giờ đặt sân.
  if (x.code === "23P01" || msg.includes("CONFLICT_SLOT")) {
    return { status: 409, body: { code: "CONFLICT_SLOT", message: "That slot is already held." } };
  }
  // Lỗi hết hạn giữ chỗ tạm thời (HOLD_EXPIRED) từ transaction đặt chỗ.
  if (msg.includes("HOLD_EXPIRED")) {
    return { status: 409, body: { code: "HOLD_EXPIRED", message: "Your hold has expired." } };
  }
  // Quy tắc nghiệp vụ BR-22: Học viên đã đăng ký tham gia lớp học này rồi.
  if (msg.includes("ALREADY_ENROLLED")) {
    return {
      status: 422,
      body: { code: "BR_VIOLATION", br: "BR-22", message: "You are already enrolled in that class." },
    };
  }
  // Quy tắc nghiệp vụ BR-21: Lớp học đã đạt sĩ số tối đa, không thể nhận thêm.
  if (msg.includes("CLASS_FULL")) {
    return { status: 422, body: { code: "BR_VIOLATION", br: "BR-21", message: "That class is full." } };
  }
  // Bước 2: Kiểm tra các lỗi định dạng và kiểu dữ liệu từ Postgres (mã 22xxx và 23502), trả về status 400 kèm tên cột nếu có.
  const field = x.column ? { field: x.column } : {};
  // Mã 22001 (string_data_right_truncation): Chuỗi ký tự vượt quá độ dài tối đa của cột.
  if (x.code === "22001") {
    return { status: 400, body: { code: "VALIDATION", message: "That value is too long.", ...field } };
  }
  // Mã 22003 (numeric_value_out_of_range): Giá trị số nằm ngoài khoảng cho phép của kiểu dữ liệu.
  if (x.code === "22003") {
    return { status: 400, body: { code: "VALIDATION", message: "That number is out of range.", ...field } };
  }
  // Mã 22P02, 22007, 22008: Dữ liệu sai định dạng (ví dụ cú pháp UUID hoặc ngày giờ không hợp lệ).
  if (x.code === "22P02" || x.code === "22007" || x.code === "22008") {
    return { status: 400, body: { code: "VALIDATION", message: "That value is not in the right format.", ...field } };
  }
  // Mã 23502 (not_null_violation): Cột bắt buộc (NOT NULL) nhưng gửi lên giá trị null hoặc thiếu.
  if (x.code === "23502") {
    return { status: 400, body: { code: "VALIDATION", message: "A required value is missing.", ...field } };
  }
  // Bước 3: Kiểm tra các lỗi vi phạm ràng buộc toàn vẹn dữ liệu (UNIQUE hoặc CHECK constraint).
  // Mã 23505 (unique_violation): Trùng lặp dữ liệu duy nhất (ví dụ số điện thoại, email, mã khuyến mãi).
  if (x.code === "23505") {
    return {
      status: 409,
      body: {
        code: "CONFLICT_STATE",
        message: "That already exists.",
        ...(x.constraint ? { constraint: x.constraint } : {}),
      },
    };
  }
  // Mã 23514 (check_violation): Giá trị gửi lên vi phạm điều kiện CHECK của bảng trong database.
  if (x.code === "23514") {
    return {
      status: 422,
      body: {
        code: "VALIDATION",
        message: "That value is not allowed.",
        ...(x.constraint ? { constraint: x.constraint } : {}),
      },
    };
  }
  // Bước 4: Trả về null nếu không khớp lỗi database cụ thể nào để hàm gọi ngoài xử lý thành lỗi 500 INTERNAL.
  return null;
}

/**
 * Làm gì: Hàm bắt và xử lý lỗi tầng cao nhất của API, chuyển đổi mọi lỗi thành HTTP Response JSON chuẩn hóa.
 * Được gọi ở: src/server/controllers/router.ts (trong hàm handleApi khi bắt được ngoại lệ lúc dispatch request).
 * @param e Ngoại lệ bị ném ra trong quá trình xử lý request.
 * @returns Đối tượng Response chứa HTTP status code và payload JSON tương ứng.
 */
export function handleError(e: unknown): Response {
  // Bước 1: Nếu là ApiError được chủ động ném ra từ code nghiệp vụ, trả về đúng status và body đã định nghĩa.
  if (e instanceof ApiError) return json(e.status, e.body());
  // Bước 2: Thử ánh xạ lỗi cơ sở dữ liệu Postgres thành phản hồi lỗi 4xx rõ nghĩa cho client.
  const mapped = mapDbError(e);
  if (mapped) return json(mapped.status, mapped.body);
  // Anything left is ours to fix. It is reported as what it is — INTERNAL, not a
  // rule and not a form error — and the detail stays in the log.
  // Bước 3: Với các lỗi hệ thống không lường trước (500), ghi log phía server và trả thông báo chung để bảo mật.
  console.error("[arena3]", e);
  return json(500, { code: "INTERNAL", message: "Something went wrong on our side." });
}
