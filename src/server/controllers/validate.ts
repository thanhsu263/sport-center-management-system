/**
 * File: src/server/controllers/validate.ts
 * Vai trò: Cung cấp các hàm kiểm tra hợp lệ (validation) và chuẩn hóa dữ liệu đầu vào cho các API của hệ thống Arena3.
 * Vị trí trong app: Chạy ở tầng server controllers; được các handler (desk, plans, promos, ops, auth, checkin, extras, staff) gọi để kiểm tra số nguyên, tham số phân trang, giờ giấc và cấu hình trung tâm (center settings) trước khi dữ liệu chạm tới cơ sở dữ liệu Postgres.
 */
import { err } from "./errors.ts";

/**
 * Form validation that names the field.
 *
 * The settings screen used to send whatever the inputs held — `Number("")` is
 * `NaN`, which JSON turns into `null`, which a NOT NULL column refuses, which
 * surfaced as a blank "something went wrong". Every value is checked here
 * before it reaches SQL, and a bad one is a 400 that says which input to fix.
 */

/** Largest value an INT column holds. */
export const INT4_MAX = 2_147_483_647;

type IntRule = { kind: "int"; min: number; max: number };
type DecimalRule = { kind: "decimal"; min: number; max: number };
type TimeRule = { kind: "time" };
type TextRule = { kind: "text"; max: number };
type BoolRule = { kind: "bool" };
export type SettingRule = IntRule | DecimalRule | TimeRule | TextRule | BoolRule;

/**
 * Làm gì: Tạo nhanh đối tượng quy tắc kiểm tra số nguyên (IntRule) với khoảng giá trị từ min đến max.
 * Được gọi ở: Nội bộ src/server/controllers/validate.ts (định nghĩa bảng SETTING_RULES).
 * @param min Giá trị số nguyên nhỏ nhất được phép cấu hình.
 * @param max Giá trị số nguyên lớn nhất được phép cấu hình.
 * @returns Đối tượng IntRule chứa kind: "int" cùng min và max.
 */
const int = (min: number, max: number): IntRule => ({ kind: "int", min, max });

/**
 * Every setting a manager may change, with the bounds the centre can live with.
 * `max` on the money columns is the INT limit: past it Postgres answers
 * "integer out of range", which is the manager's typo and not a server fault.
 */
export const SETTING_RULES: Record<string, SettingRule> = {
  open_time: { kind: "time" },
  close_time: { kind: "time" },
  hold_minutes: int(1, 120),
  book_ahead_days: int(1, 365),
  max_slots_per_day: int(1, 24),
  cancel_court_hours: int(0, 168),
  cancel_class_hours: int(0, 168),
  noshow_grace_minutes: int(0, 120),
  checkin_before_minutes: int(0, 240),
  self_checkin_enabled: { kind: "bool" },
  gate_dedup_minutes: int(1, 720),
  at_risk_idle_days: int(1, 90),
  refund_manager_vnd: int(0, INT4_MAX),
  minor_age: int(1, 100),
  vat_rate: { kind: "decimal", min: 0, max: 100 },
  freeze_max_days_year: int(0, 365),
  waitlist_offer_hours: int(1, 168),
  deposit_pct: int(0, 100),
  deposit_peak_only: { kind: "bool" },
  series_min_weeks: int(1, 52),
  series_max_weeks: int(1, 52),
  series_discount_pct: int(0, 50),
  loyalty_earn_vnd: int(1000, 10_000_000),
  loyalty_redeem_vnd: int(1, 100_000),
  member_court_fee_vnd: int(0, 10_000_000),
  member_day_rate_vnd: int(1, 1_000_000),
  max_active_classes: int(1, 50),
  // Column limits: legal_name VARCHAR(190), tax_code VARCHAR(20), address TEXT.
  legal_name: { kind: "text", max: 190 },
  tax_code: { kind: "text", max: 20 },
  address: { kind: "text", max: 500 },
};

/**
 * Làm gì: Danh sách tên các khóa cấu hình trung tâm hợp lệ mà quản lý có thể cập nhật, trích xuất từ SETTING_RULES.
 * Được gọi ở: src/server/controllers/validate.ts (hàm parseSettingsPatch).
 */
export const SETTING_KEYS = Object.keys(SETTING_RULES);

/** Plain-language names, for messages a manager reads. */
const SETTING_LABEL: Record<string, string> = {
  open_time: "Opening time",
  close_time: "Closing time",
  hold_minutes: "Hold length",
  book_ahead_days: "Book-ahead window",
  max_slots_per_day: "Slots per day",
  cancel_court_hours: "Court cancellation window",
  cancel_class_hours: "Class cancellation window",
  noshow_grace_minutes: "No-show grace",
  checkin_before_minutes: "Check-in window",
  self_checkin_enabled: "Self check-in",
  gate_dedup_minutes: "Gate repeat window",
  at_risk_idle_days: "At-risk idle days",
  refund_manager_vnd: "Refund approval threshold",
  minor_age: "Minor age",
  vat_rate: "VAT rate",
  freeze_max_days_year: "Freeze cap",
  waitlist_offer_hours: "Waitlist offer window",
  deposit_pct: "Deposit",
  deposit_peak_only: "Deposit on peak slots only",
  series_min_weeks: "Fixed booking minimum weeks",
  series_max_weeks: "Fixed booking maximum weeks",
  series_discount_pct: "Fixed booking discount",
  loyalty_earn_vnd: "Spend per loyalty point",
  loyalty_redeem_vnd: "Value of a loyalty point",
  member_court_fee_vnd: "Member court fee per hour",
  member_day_rate_vnd: "Membership price per day",
  max_active_classes: "Most classes a member can be in at once",
  legal_name: "Legal name",
  tax_code: "Tax code",
  address: "Address",
};

/**
 * Làm gì: Kiểm tra một giá trị có phải là rỗng hay không (null, undefined hoặc chuỗi chỉ chứa khoảng trắng).
 * Được gọi ở: Nội bộ src/server/controllers/validate.ts (trong parseInteger và parseDecimal).
 * @param v Giá trị bất kỳ cần kiểm tra.
 * @returns true nếu giá trị là null, undefined hoặc chuỗi rỗng; ngược lại false.
 */
function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/**
 * A whole number from a JSON number or a numeric string. Anything else —
 * blank, `NaN`, `1e3`, `12.5`, `"abc"` — is rejected rather than coerced.
 */
export function parseInteger(field: string, label: string, v: unknown, min: number, max: number): number {
  // Bước 1: Từ chối giá trị rỗng (null, undefined hoặc chuỗi trắng) vì đây là trường bắt buộc.
  if (isBlank(v)) throw err.field(field, `${label} is required.`);
  // Bước 2: Ép kiểu sang số; chỉ chấp nhận kiểu number hoặc chuỗi số nguyên thuần túy (loại bỏ số thực, ký hiệu khoa học 1e3).
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^-?\d+$/.test(v.trim())) n = Number(v.trim());
  else throw err.field(field, `${label} must be a whole number.`);
  // Bước 3: Đảm bảo số là hữu hạn và là số nguyên thực sự (loại trừ NaN, Infinity, số thập phân).
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw err.field(field, `${label} must be a whole number.`);
  }
  // Bước 4: Kiểm tra giới hạn [min, max], format số theo chuẩn en-US trong thông báo lỗi để dễ đọc.
  if (n < min || n > max) {
    throw err.field(field, `${label} must be between ${min.toLocaleString("en-US")} and ${max.toLocaleString("en-US")}.`);
  }
  return n;
}

/**
 * `?limit=&offset=` for a paged list. Absent values fall back to `def` rows from the top, so a
 * caller that never asked for paging keeps the page it always got. Queries pair this with
 * `count(*) over ()` and answer `{ items, total, limit, offset }`.
 */
export function pageParams(
  request: Request,
  opts: { def: number; max: number; prefix?: string },
): { limit: number; offset: number } {
  // Bước 1: Bóc tách searchParams từ URL của HTTP Request.
  const sp = new URL(request.url).searchParams;
  // A screen that pages two lists through one endpoint names one of them, e.g. `receipt_limit`.
  const key = (name: string) => `${opts.prefix ?? ""}${name}`;
  // Bước 2: Đọc tham số query rawLimit và rawOffset (có áp dụng tiền tố prefix nếu phân trang danh sách phụ).
  const rawLimit = sp.get(key("limit"));
  const rawOffset = sp.get(key("offset"));
  // Bước 3: Parse và kiểm tra ràng buộc: nếu khuyết thì lấy mặc định (limit = def, offset = 0); có thì validate qua parseInteger (offset tối đa 1.000.000 để tránh quét DB quá tải).
  return {
    limit: rawLimit === null ? opts.def : parseInteger(key("limit"), "Page size", rawLimit, 1, opts.max),
    offset: rawOffset === null ? 0 : parseInteger(key("offset"), "Offset", rawOffset, 0, 1_000_000),
  };
}

/**
 * Làm gì: Phân tích cú pháp và kiểm tra số thập phân từ JSON number hoặc chuỗi số, làm tròn tối đa 2 chữ số thập phân (chuẩn numeric(5,2)).
 * Được gọi ở: Nội bộ src/server/controllers/validate.ts (trong hàm parseSettingsPatch cho trường decimal như vat_rate).
 * @param field Tên trường dữ liệu để gắn vào lỗi ApiError nếu không hợp lệ.
 * @param label Tên hiển thị của trường dùng trong thông báo lỗi.
 * @param v Giá trị đầu vào cần kiểm tra (number, string hoặc bất kỳ).
 * @param min Giá trị số tối thiểu cho phép.
 * @param max Giá trị số tối đa cho phép.
 * @returns Số thập phân đã được làm tròn tới 2 chữ số sau dấu phẩy.
 * @throws ApiError (HTTP 400 VALIDATION) nếu giá trị để trống, không phải số hữu hạn hoặc vượt ngoài khoảng [min, max].
 */
function parseDecimal(field: string, label: string, v: unknown, min: number, max: number): number {
  // Bước 1: Kiểm tra bắt buộc, từ chối nếu giá trị để trống.
  if (isBlank(v)) throw err.field(field, `${label} is required.`);
  // Bước 2: Ép kiểu sang số, chỉ chấp nhận kiểu number hoặc chuỗi số có phần thập phân hợp lệ.
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) n = Number(v.trim());
  else throw err.field(field, `${label} must be a number.`);
  // Bước 3: Đảm bảo số là hữu hạn và nằm trong khoảng giá trị cho phép [min, max].
  if (!Number.isFinite(n)) throw err.field(field, `${label} must be a number.`);
  if (n < min || n > max) throw err.field(field, `${label} must be between ${min} and ${max}.`);
  // numeric(5,2): two decimals at most. Round here so 8.005 is not a surprise.
  return Math.round(n * 100) / 100;
}

/** `HH:MM` (seconds tolerated) on a 24-hour clock, normalised to `HH:MM`. */
export function parseClock(field: string, label: string, v: unknown): string {
  // Bước 1: Kiểm tra kiểu chuỗi và khớp biểu thức chính quy định dạng giờ 24h (HH:MM hoặc HH:MM:SS).
  if (typeof v !== "string") throw err.field(field, `${label} must be a time like 06:00.`);
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(v.trim());
  if (!m) throw err.field(field, `${label} must be a time like 06:00.`);
  // Bước 2: Bóc tách giờ và phút dạng số để kiểm tra phạm vi đồng hồ hợp lệ (giờ 0-23, phút 0-59).
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw err.field(field, `${label} must be a time like 06:00.`);
  // Bước 3: Chuẩn hóa về định dạng HH:MM 5 ký tự với 2 chữ số đệm 0 ở đầu.
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * Check a settings patch and return only what should be written.
 *
 * Unknown keys are ignored, as before. A key that is present is always
 * validated — present-but-blank is an error for numbers (never a silent null)
 * and a deliberate "clear it" for the optional text fields.
 */
export function parseSettingsPatch(body: Record<string, unknown>): Record<string, string | number | boolean | null> {
  // Bước 1: Khởi tạo đối tượng lưu trữ các trường cấu hình hợp lệ sau khi validate.
  const out: Record<string, string | number | boolean | null> = {};
  // Bước 2: Duyệt qua các khóa cấu hình cho phép; bỏ qua trường không được gửi lên (undefined).
  for (const key of SETTING_KEYS) {
    if (body[key] === undefined) continue;
    const rule = SETTING_RULES[key];
    const label = SETTING_LABEL[key] ?? key;
    const v = body[key];
    // Bước 3: Áp dụng quy tắc kiểm tra tương ứng với từng loại trường (kind: int, decimal, time, bool).
    if (rule.kind === "int") out[key] = parseInteger(key, label, v, rule.min, rule.max);
    else if (rule.kind === "decimal") out[key] = parseDecimal(key, label, v, rule.min, rule.max);
    else if (rule.kind === "time") out[key] = parseClock(key, label, v);
    else if (rule.kind === "bool") {
      if (typeof v !== "boolean") throw err.field(key, `${label} must be on or off.`);
      out[key] = v;
    }
    // Với trường văn bản (legal_name, tax_code, address): null/rỗng thì gán null để xóa; cắt khoảng trắng và kiểm tra độ dài tối đa theo cột DB.
    else {
      if (v === null || v === undefined) {
        out[key] = null;
        continue;
      }
      if (typeof v !== "string") throw err.field(key, `${label} must be text.`);
      const t = v.trim();
      if (t.length > rule.max) {
        throw err.field(key, `${label} must be at most ${rule.max} characters.`);
      }
      out[key] = t === "" ? null : t;
    }
  }
  return out;
}

/** Minutes after midnight for an `HH:MM` clock. */
export function clockMinutes(hhmm: string): number {
  // Bóc tách giờ và phút rồi quy đổi thành tổng số phút tính từ 00:00 để thuận tiện so sánh thứ tự thời gian.
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Opening hours must describe a real day: close after open. Checked against the
 * stored values so that changing only one of the two is still caught.
 */
export function checkOpeningHours(open: string, close: string): void {
  // Giờ đóng cửa phải sau giờ mở cửa trong cùng một ngày hoạt động; nếu không sẽ báo lỗi 400 gắn vào trường close_time.
  if (clockMinutes(close) <= clockMinutes(open)) {
    throw err.field("close_time", "Closing time must be after opening time.");
  }
}
