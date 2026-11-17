/**
 * File: src/client/lib/pages/manager.audit.ts
 * Vai trò: Hook logic (useManagerAudit) và các hàm tiện ích bóc tách, so sánh (diff) dữ liệu kiểm toán (audit log) cho trang quản lý Arena3.
 * Vị trí trong app: Phục vụ trực tiếp cho route /manager/audit (src/routes/manager.audit.tsx); lấy dữ liệu lịch sử thao tác từ API /audit, hỗ trợ lọc, tìm kiếm, ẩn dòng tạm thời và chuyển đổi snapshot before/after thành dạng so sánh dễ đọc cho Manager.
 */
import { useEffect, useMemo, useState } from "react";
import { levelLabel, methodLabel, roleLabel, sportLabel, statusLabel } from "@/shared/arena3/labels";
import { formatVnd } from "@/shared/arena3/time";
import { locale, t, tk } from "@/client/lib/i18n";
import { usePageState } from "@/client/lib/use-page-state";
import { useRead } from "@/client/lib/use-read";


// Kiểu dữ liệu một bản ghi nhật ký kiểm toán (audit entry) lưu trữ lịch sử thao tác của nhân sự và hội viên trên hệ thống
type Entry = {
  id: number;
  at: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  subject?: string | null;
  subject_vnd?: number | null;
  before?: unknown;
  after?: unknown;
};


// Kiểu dữ liệu thông tin người thực hiện hành động kiểm toán (ID, họ tên và vai trò trong hệ thống)
type Actor = { id: string; full_name: string; role: string };

// Cấu trúc phản hồi từ API /audit bao gồm danh sách bản ghi, phân trang và các bộ giá trị lọc sẵn (actions, entities, actors)
type AuditPage = { items: Entry[]; more: boolean; total: number; actions: string[]; entities: string[]; actors: Actor[] };


// Khóa lưu trữ trong localStorage danh sách ID các bản ghi kiểm toán mà quản lý chọn ẩn tạm thời trên màn hình
const HIDDEN_KEY = "arena3.audit.hidden";

/**
 * Làm gì: Chuỗi class CSS (Tailwind) định kiểu đồng bộ cho các ô chọn dropdown (select) trên trang kiểm toán.
 * Được gọi ở: src/routes/manager.audit.tsx (các dropdown lọc action, actor, entity).
 */
const selectCls = "h-11 rounded-[var(--radius-sm)] border border-line bg-surface px-3 text-sm sm:h-10";


/**
 * Làm gì: Đọc danh sách ID các bản ghi kiểm toán bị ẩn tạm thời từ localStorage, đảm bảo trả về mảng số hợp lệ.
 * Được gọi ở: Nội bộ file src/client/lib/pages/manager.audit.ts (hook useManagerAudit khi khởi tạo state hidden).
 * @returns Mảng các ID bản ghi kiểm toán (number[]) đang bị ẩn, hoặc mảng rỗng nếu chưa có hoặc lỗi parse.
 */
function readHidden(): number[] {
  try {
    // Bước 1: Đọc chuỗi JSON từ localStorage theo khóa HIDDEN_KEY và parse, chỉ giữ lại các phần tử có kiểu số hợp lệ
    const raw = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((n): n is number => typeof n === "number") : [];
  } catch {
    // Bước 2: Dự phòng trả về mảng rỗng nếu JSON hỏng hoặc trình duyệt chặn truy cập localStorage (chế độ ẩn danh)
    return [];
  }
}


/**
 * Làm gì: Chuyển đổi dữ liệu snapshot thô (before/after) thành chuỗi JSON định dạng đẹp (pretty-print) với thụt lề 2 khoảng trắng để hiển thị chi tiết khi quản lý xem raw JSON.
 * Được gọi ở: src/routes/manager.audit.tsx (khi bấm mở rộng chi tiết bản ghi kiểm toán).
 * @param v Đối tượng dữ liệu thô (snapshot trước hoặc sau thao tác).
 * @returns Chuỗi JSON được định dạng thụt lề dễ đọc, hoặc null nếu không có dữ liệu / không thể chuyển đổi.
 */
function detail(v: unknown): string | null {
  // Bước 1: Trả về null nếu giá trị là null hoặc undefined để tránh render chuỗi "null" trên giao diện
  if (v == null) return null;
  try {
    // Bước 2: Format JSON thụt đầu dòng 2 khoảng trắng; bắt ngoại lệ nếu gặp lỗi tham chiếu vòng (circular reference)
    return JSON.stringify(v, null, 2);
  } catch {
    return null;
  }
}


// The before/after snapshots are rows as the handlers wrote them. A manager reads "Enabled: Yes → No",
// not two JSON blocks to compare by eye, so the change is worked out field by field here and the raw
// JSON stays one click away.
const FIELD_LABEL: Record<string, string> = {
  enabled: tk("Enabled"),
  status: tk("Status"),
  role: tk("Role"),
  capacity: tk("Capacity"),
  level: tk("Level"),
  sport: tk("Sport"),
  phone: tk("Phone"),
  email: tk("Email"),
  full_name: tk("Full name"),
  name: tk("Name"),
  name_en: tk("English name"),
  name_vi: tk("Vietnamese name"),
  note: tk("Note"),
  reason: tk("Reason"),
  points: tk("Points"),
  price_vnd: tk("Price"),
  amount_vnd: tk("Amount"),
  code: tk("Code"),
  court_code: tk("Court"),
  sort_order: tk("Sort order"),
  min_enrolled: tk("Minimum to run"),
  src_path: tk("Photo"),
  alt_en: tk("Photo description (English)"),
  alt_vi: tk("Photo description (Vietnamese)"),
  start_at: tk("Starts at"),
  end_at: tk("Ends at"),
  sessions: tk("Sessions cancelled"),
  members_refunded: tk("Members to refund"),
  refunded_vnd: tk("Total to refund"),
  refunded: tk("Refunded"),
  prepaid_returned: tk("Prepaid returned"),
  prepaid_kept_no_plan: tk("Prepaid kept, no plan"),
  method: tk("Method"),
  days: tk("Days"),
  frozen_days: tk("Days frozen"),
  end_on: tk("Ends on"),
  period: tk("Period"),
  closed: tk("Payouts closed"),
  qty: tk("Quantity"),
  title: tk("Title"),
  priority: tk("Priority"),
  weeks: tk("Weeks"),
  from: tk("From"),
  to: tk("To"),
  q: tk("Question"),
  credit_days: tk("Days credited"),
  kept: tk("Kept"),
};


/**
 * Làm gì: Chuyển đổi tên trường kỹ thuật thành nhãn thân thiện theo ngôn ngữ hiện tại; tự động chuẩn hóa làm sạch ký tự nếu là trường lồng nhau hoặc liên kết menu chưa định nghĩa.
 * Được gọi ở: Nội bộ file src/client/lib/pages/manager.audit.ts (hàm changesOf để gán nhãn cho từng thuộc tính thay đổi).
 * @param key Tên trường kỹ thuật (ví dụ: "price_vnd", "status", "venue.open_hour", "nav.member › /app/pass.dock").
 * @returns Nhãn văn bản hiển thị thân thiện với người dùng.
 */
function fieldLabel(key: string): string {
  // Bước 1: Tra cứu tên trường trong bảng FIELD_LABEL, nếu đã được định nghĩa thì dịch qua hàm t() và trả về ngay
  const known = FIELD_LABEL[key];
  if (known) return t(known);
  // A nested field (`venue.open_hour`) or one nobody has named yet: its own name, tidied.
  // A menu item (`nav.member › /app/pass.dock`) keeps its link as written.
  // Bước 2: Với trường lồng nhau hoặc mục menu chưa có trong từ điển, tách phần tiền tố để xóa dấu chấm/gạch nối, viết hoa chữ đầu và giữ nguyên đường dẫn
  const [head, ...rest] = key.split(" › ");
  const tidy = head.replace(/[._]+/g, " ").trim();
  const item = rest.join(" › ").replace(/\.(\w+)$/, " · $1");
  return tidy.charAt(0).toUpperCase() + tidy.slice(1) + (item ? ` › ${item}` : "");
}


/**
 * Làm gì: Kiểm tra một giá trị có phải là plain object (đối tượng khóa-giá trị thông thường, khác null và không phải mảng).
 * Được gọi ở: Nội bộ file src/client/lib/pages/manager.audit.ts (các hàm flatten và changesOf để quyết định việc duyệt đệ quy thuộc tính lồng nhau).
 * @param v Giá trị bất kỳ cần kiểm tra kiểu dữ liệu.
 * @returns True nếu là một plain object hợp lệ (Record<string, unknown>), ngược lại trả về false.
 */
function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}


/** A JSON text (a setting stored as a string) is read as the value it holds. */
/**
 * Làm gì: Phân tích cú pháp chuỗi JSON thành đối tượng hoặc mảng nếu chuỗi bắt đầu bằng [ hoặc {, giúp đọc các giá trị cài đặt đang lưu dạng JSON thô.
 * Được gọi ở: Nội bộ file src/client/lib/pages/manager.audit.ts (các hàm flatten và changesOf).
 * @param v Giá trị đầu vào cần phân tích (chuỗi JSON, object, number, boolean...).
 * @returns Dữ liệu sau khi parse JSON nếu hợp lệ, hoặc trả về nguyên giá trị ban đầu nếu không phải chuỗi JSON hoặc lỗi cú pháp.
 */
function parsed(v: unknown): unknown {
  // Bước 1: Kiểm tra nhanh nếu không phải chuỗi hoặc không bắt đầu bằng ký tự mở mảng/đối tượng ([ hoặc {) thì trả về nguyên bản
  if (typeof v !== "string" || !/^\s*[[{]/.test(v)) return v;
  try {
    // Bước 2: Thử parse JSON; nếu chuỗi hỏng cú pháp thì giữ nguyên giá trị ban đầu để tránh crash ứng dụng
    return JSON.parse(v);
  } catch {
    return v;
  }
}


/**
 * Nested settings are opened down to their leaves (`nav.member./app/pass.dock`), so a
 * change to one menu item shows as one line instead of two walls of JSON. Lists of
 * links are keyed by their `to`, so a removed item reads as removed, not as a shift.
 */
/**
 * Làm gì: Trải phẳng (flatten) đệ quy đối tượng cài đặt lồng nhau thành các cặp khóa-giá trị một cấp (dùng dấu chấm và ký hiệu ' › ' cho menu điều hướng), giúp so sánh diff hiển thị rõ từng dòng thay đổi thay vì nguyên khối JSON lớn.
 * Được gọi ở: Nội bộ file src/client/lib/pages/manager.audit.ts (hàm changesOf để chuẩn bị dữ liệu hai snapshot before và after).
 * @param v Đối tượng lồng nhau cần trải phẳng.
 * @param prefix Tiền tố đường dẫn khóa trong quá trình đệ quy (mặc định là chuỗi rỗng).
 * @param out Đối tượng kết quả tích lũy sau khi trải phẳng (mặc định là {}).
 * @returns Đối tượng phẳng một cấp chứa toàn bộ các thuộc tính lá của đối tượng gốc.
 */
function flatten(v: Record<string, unknown>, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  // Bước 1: Duyệt qua từng cặp khóa-giá trị trong đối tượng, tự động parse chuỗi JSON và ghép tiền tố phân cấp (prefix.key)
  for (const [k, raw] of Object.entries(v)) {
    const val = parsed(raw);
    const key = prefix ? `${prefix}.${k}` : k;
    // Bước 2: Nếu giá trị là plain object, gọi đệ quy để tiếp tục mở rộng các thuộc tính con bên trong
    if (isPlain(val)) flatten(val as Record<string, unknown>, key, out);
    // Bước 3: Với danh sách link điều hướng (mảng chứa các item có thuộc tính 'to'), lập chỉ mục theo đường dẫn 'to' để khi thêm/xóa menu không làm lệch chỉ số mảng
    else if (Array.isArray(val) && val.length && val.every((x) => isPlain(x) && typeof (x as { to?: unknown }).to === "string")) {
      for (const item of val as Array<Record<string, unknown>>) {
        const { to, ...rest } = item;
        if (Object.keys(rest).length) flatten(rest, `${key} › ${to as string}`, out);
        else out[`${key} › ${to as string}`] = true;
      }
    // Bước 4: Nếu là giá trị nguyên thủy (primitive) hoặc mảng thông thường, gán trực tiếp vào đối tượng kết quả
    } else out[key] = val;
  }
  return out;
}


// Biểu thức chính quy kiểm tra định dạng chuỗi thời gian chuẩn ISO 8601 (YYYY-MM-DDTHH:mm)
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;


// Biểu thức chính quy nhận diện chuỗi định danh UUID chuẩn để ẩn các ID nội bộ khỏi màn hình diff
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


/** Nothing worth a line: absent, blank, or an empty list. */
/**
 * Làm gì: Kiểm tra một giá trị có phải là rỗng hay không (null, undefined, chuỗi rỗng hoặc mảng rỗng) để tránh hiển thị thành dòng thay đổi vô nghĩa.
 * Được gọi ở: Nội bộ file src/client/lib/pages/manager.audit.ts (các hàm showField, showValue và changesOf).
 * @param v Giá trị bất kỳ cần kiểm tra.
 * @returns True nếu giá trị là rỗng (không đáng hiển thị), ngược lại trả về false.
 */
function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}


/** Ids mean nothing to a reader; they stay in the raw view. */
/**
 * Làm gì: Xác định một thuộc tính có phải là dữ liệu kỹ thuật nội bộ (như seed, trường kết thúc bằng _id, hoặc giá trị dạng UUID) để ẩn khỏi giao diện diff chính, chỉ giữ lại trong chế độ xem raw JSON.
 * Được gọi ở: Nội bộ file src/client/lib/pages/manager.audit.ts (hàm changesOf khi lọc danh sách trường hiển thị).
 * @param key Tên trường thuộc tính cần kiểm tra.
 * @param a Giá trị trước khi thay đổi (before).
 * @param b Giá trị sau khi thay đổi (after).
 * @returns True nếu là trường kỹ thuật nội bộ cần ẩn trên giao diện diff, ngược lại trả về false.
 */
function isInternal(key: string, a: unknown, b: unknown): boolean {
  // Bỏ qua trường seed và các trường ID/UUID kỹ thuật không mang ý nghĩa nghiệp vụ với người quản lý
  if (key === "seed") return true;
  return /(^|\.|_)id$/.test(key) || [a, b].some((v) => typeof v === "string" && UUID.test(v));
}


/**
 * Làm gì: Định dạng giá trị hiển thị của một trường dữ liệu theo ngữ cảnh nghiệp vụ (tiền tệ VND, nhãn trạng thái, vai trò, môn thể thao, số lượng mục trong mảng).
 * Được gọi ở: Nội bộ file src/client/lib/pages/manager.audit.ts (hàm changesOf khi format giá trị from và to).
 * @param key Tên trường dữ liệu kỹ thuật.
 * @param v Giá trị của trường cần hiển thị.
 * @returns Chuỗi văn bản đã được định dạng thân thiện với người dùng.
 */
function showField(key: string, v: unknown): string {
  // Bước 1: Giá trị rỗng được hiển thị thành ký hiệu gạch ngang (—)
  if (isEmpty(v)) return "—";
  const name = key.split(".").pop() ?? key;
  // Bước 2: Định dạng tiền Việt Nam Đồng nếu tên trường kết thúc bằng _vnd
  if (name.endsWith("_vnd") && typeof v === "number") return formatVnd(v);
  // Bước 3: Ánh xạ mã định danh sang nhãn tiếng Việt cho các trường enum nghiệp vụ (trạng thái, phương thức, vai trò, trình độ, môn thể thao)
  if (typeof v === "string") {
    if (name === "status" || name === "from_status") return statusLabel(v);
    if (name === "method") return methodLabel(v);
    if (name === "role") return roleLabel(v);
    if (name === "level") return levelLabel(v);
    if (name === "sport") return sportLabel(v);
  }
  // Bước 4: Với mảng, hiển thị số lượng phần tử thay vì bung toàn bộ dữ liệu; các trường hợp khác chuyển cho hàm showValue xử lý
  if (Array.isArray(v)) return t("{n} items", { n: v.length });
  return showValue(v);
}


/**
 * Làm gì: Chuyển đổi một giá trị bất kỳ thành chuỗi văn bản thân thiện theo ngôn ngữ và định dạng địa phương (boolean thành Có/Không, số theo locale, ngày giờ ISO thành giờ Việt Nam).
 * Được gọi ở: Nội bộ file src/client/lib/pages/manager.audit.ts (các hàm showField và changesOf).
 * @param v Giá trị dữ liệu nguyên thủy hoặc đối tượng cần hiển thị.
 * @returns Chuỗi văn bản đã được bản địa hóa và định dạng phù hợp.
 */
function showValue(v: unknown): string {
  // Bước 1: Trả về ký hiệu gạch ngang (—) nếu giá trị là null, undefined hoặc chuỗi rỗng
  if (v === null || v === undefined || v === "") return "—";
  // Bước 2: Boolean dịch thành Yes/No; number định dạng có dấu phân cách hàng nghìn theo locale hiện tại
  if (typeof v === "boolean") return v ? t("Yes") : t("No");
  if (typeof v === "number") return v.toLocaleString(locale());
  // Bước 3: Nếu là chuỗi thời gian ISO 8601, chuyển sang định dạng ngày giờ Việt Nam qua hàm when(); nếu không giữ nguyên chuỗi
  if (typeof v === "string") return ISO_TIME.test(v) ? when(v) : v;
  // Bước 4: Đối tượng phức tạp thì serialize sang chuỗi JSON; bắt lỗi nếu có tham chiếu vòng và ép kiểu chuỗi an toàn
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}


// Cấu trúc mô tả một thuộc tính thay đổi giữa hai snapshot: key (tên trường), label (nhãn hiển thị), from (giá trị cũ), to (giá trị mới)
type Change = { key: string; label: string; from: string | null; to: string };


/** The fields that differ between the two snapshots; a created or deleted row lists what it had. */
/**
 * Làm gì: So sánh hai snapshot dữ liệu trước (before) và sau (after) của một bản ghi kiểm toán để tìm các trường có sự thay đổi; tự động trải phẳng đối tượng lồng nhau, loại bỏ các trường kỹ thuật nội bộ và trả về danh sách thay đổi có nhãn thân thiện.
 * Được gọi ở: src/routes/manager.audit.tsx (component Page để hiển thị danh sách các trường thay đổi của từng dòng log).
 * @param before Snapshot dữ liệu trước khi thực hiện thao tác (null nếu là hành động tạo mới).
 * @param after Snapshot dữ liệu sau khi thực hiện thao tác (null nếu là hành động xóa).
 * @returns Mảng các đối tượng Change gồm tên trường, nhãn tiếng Việt, giá trị cũ (from) và giá trị mới (to).
 */
function changesOf(before: unknown, after: unknown): Change[] {
  // Bước 1: Nếu cả hai snapshot đều rỗng thì không có thay đổi nào, trả về mảng rỗng ngay
  if (before == null && after == null) return [];
  // Bước 2: Tự động parse chuỗi JSON sang đối tượng nếu dữ liệu được lưu dưới dạng JSON string
  before = parsed(before);
  after = parsed(after);
  // Bước 3: Nếu dữ liệu là kiểu nguyên thủy (không phải object), so sánh trực tiếp và trả về một dòng thay đổi duy nhất với nhãn "Giá trị"
  if (!isPlain(before ?? {}) || !isPlain(after ?? {})) {
    if (JSON.stringify(before) === JSON.stringify(after)) return [];
    return [{ key: "value", label: t("Value"), from: showValue(before), to: showValue(after) }];
  }
  // Bước 4: Trải phẳng cả hai snapshot và gom tất cả các thuộc tính xuất hiện ở một trong hai đối tượng
  const a = flatten((before ?? {}) as Record<string, unknown>);
  const b = flatten((after ?? {}) as Record<string, unknown>);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  // Bước 5: Lọc các trường có giá trị khác nhau, bỏ qua các trường kỹ thuật nội bộ (ID, seed) và trường rỗng ở cả hai phía, sau đó định dạng nhãn và giá trị hiển thị
  return keys
    .filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null))
    .filter((k) => !(isEmpty(a[k]) && isEmpty(b[k])) && !isInternal(k, a[k], b[k]))
    // A value with nothing before it is a plain fact of the action, not a change.
    .map((k) => ({ key: k, label: fieldLabel(k), from: isEmpty(a[k]) ? null : showField(k, a[k]), to: showField(k, b[k]) }));
}


// The action names are written for the handlers that record them. Known ones get a
// friendly, translatable label; a new one falls back to its own name, tidied.
const ACTION_LABEL: Record<string, string> = {
  adjust_points: tk("Adjust points"),
  assistant: tk("Assistant question"),
  attendance: tk("Attendance recorded"),
  attendance_correct: tk("Attendance corrected"),
  add_coach_certification: tk("Add coach certification"),
  avatar_removed: tk("Remove profile photo"),
  avatar_set: tk("Change profile photo"),
  collect_balance: tk("Collect balance"),
  create_court: tk("Create court"),
  create_sport: tk("Create sport"),
  delete_sport: tk("Delete sport"),
  issue_certificate: tk("Issue certificate"),
  login_google: tk("Sign in with Google"),
  refund_paid_out: tk("Refund paid out"),
  remove_coach_certification: tk("Remove coach certification"),
  replace_asset: tk("Replace site image"),
  restore_court: tk("Restore court"),
  restore_sport: tk("Restore sport"),
  retire_court: tk("Retire court"),
  retire_sport: tk("Retire sport"),
  revert_asset: tk("Restore default image"),
  sign_out_other_sessions: tk("Sign out other devices"),
  update_sport: tk("Update sport"),
  cancel_booking: tk("Cancel booking"),
  cancel_class: tk("Cancel class"),
  cancel_series: tk("Cancel fixed booking"),
  cancel_session: tk("Cancel session"),
  change_coach: tk("Change coach"),
  change_password: tk("Change password"),
  change_staff_role: tk("Change staff role"),
  close_commission: tk("Close commission period"),
  close_shift: tk("Close shift"),
  contact_logged: tk("Contact logged"),
  convert_membership: tk("Convert membership"),
  create_class: tk("Create class"),
  create_member: tk("Create member"),
  create_payment: tk("Create payment"),
  create_plan: tk("Create plan"),
  create_promo: tk("Create promo"),
  create_series: tk("Create fixed booking"),
  create_staff: tk("Create staff"),
  create_work_order: tk("Create work order"),
  decline_plan_order: tk("Decline plan order"),
  edit_class: tk("Edit class"),
  export_invoices: tk("Export e-invoices"),
  freeze_sub: tk("Freeze subscription"),
  gate_checkin: tk("Gate check-in"),
  gate_checkin_override: tk("Gate check-in override"),
  loan_out: tk("Loan out"),
  loan_return: tk("Loan return"),
  lock_staff: tk("Lock staff"),
  online_link: tk("Online payment link"),
  online_paid: tk("Online payment"),
  online_paid_webhook: tk("Online payment confirmed"),
  patch_court: tk("Update court"),
  patch_flags: tk("Update features"),
  patch_plan: tk("Update plan"),
  patch_promo: tk("Update promo"),
  patch_settings: tk("Update settings"),
  patch_work_order: tk("Update work order"),
  pause: tk("Pause"),
  pay_commission: tk("Pay commission"),
  put_plan_on_sale: tk("Put plan on sale"),
  redeem_points: tk("Redeem points"),
  refund: tk("Refund"),
  refund_approved: tk("Refund approved"),
  refund_authorized: tk("Refund approved"),
  refund_pending: tk("Refund pending"),
  refund_rejected: tk("Refund rejected"),
  register: tk("Register"),
  replace_prices: tk("Replace prices"),
  reschedule_booking: tk("Reschedule booking"),
  reschedule_session: tk("Reschedule session"),
  reset_member_password: tk("Reset member password"),
  reset_staff_password: tk("Reset staff password"),
  resume: tk("Resume"),
  revoke_staff_sessions: tk("Revoke staff sessions"),
  sell_day_pass: tk("Sell day pass"),
  set_coach_rate: tk("Set coach rate"),
  student_level: tk("Student level"),
  ticket_close: tk("Close ticket"),
  ticket_reply: tk("Reply to ticket"),
  transfer_confirm: tk("Confirm transfer"),
  transfer_reject: tk("Reject transfer"),
  unfreeze_sub: tk("Unfreeze subscription"),
  unlock_staff: tk("Unlock staff"),
  update_member: tk("Update member"),
  use_day_pass: tk("Use day pass"),
  void_day_pass: tk("Void day pass"),
  walk_in: tk("Walk-in booking"),
  withdraw_plan_from_sale: tk("Withdraw plan from sale"),
};


/**
 * Làm gì: Chuyển đổi mã hành động kỹ thuật (action code) thành nhãn hiển thị thân thiện, dễ hiểu cho người quản lý; hỗ trợ bản địa hóa qua t() và tự động chuẩn hóa chuỗi nếu chưa có trong danh mục.
 * Được gọi ở: src/routes/manager.audit.tsx (component Page: dropdown bộ lọc hành động và badge phân loại của từng dòng audit log).
 * @param a Mã hành động ghi nhận trong audit log (ví dụ: "create_member", "cancel_booking").
 * @returns Chuỗi nhãn hiển thị thân thiện đã được bản địa hóa hoặc định dạng viết hoa chữ cái đầu.
 */
function actionLabel(a: string): string {
  // Bước 1: Tra cứu nhãn đã dịch trong từ điển ACTION_LABEL; nếu tìm thấy thì trả về bản dịch theo ngôn ngữ hiện tại qua t().
  const known = ACTION_LABEL[a];
  if (known) return t(known);
  // Bước 2: Với hành động mới chưa khai báo trong từ điển, thay thế dấu gạch dưới thành khoảng trắng và viết hoa chữ cái đầu.
  const words = a.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}


// Bảng ánh xạ mã thực thể (entity) sang nhãn tiếng Việt/tiếng Anh thân thiện, hỗ trợ cả tên bảng cũ từ dữ liệu seed.
const ENTITY_LABEL: Record<string, string> = {
  attendance: tk("attendance"),
  booking: tk("booking"),
  booking_series: tk("fixed booking"),
  chat: tk("chat"),
  class: tk("class"),
  coach_payout: tk("coach commission"),
  court: tk("court"),
  day_pass: tk("day pass"),
  equipment: tk("equipment"),
  flags: tk("features"),
  invoice: tk("invoice"),
  payment: tk("payment"),
  plan: tk("plan"),
  price_rules: tk("price rules"),
  promotion: tk("promotion"),
  session: tk("session"),
  settings: tk("settings"),
  shift: tk("shift"),
  subscription: tk("subscription"),
  ticket: tk("ticket"),
  user: tk("user"),
  work_order: tk("work order"),
  // Older rows (and the seeded history) were written with the table's own name.
  sport: tk("sport"),
  feature_flag: tk("features"),
  site_asset: tk("site image"),
  enrollment: tk("enrollment"),
  price_rule: tk("price rules"),
  cashier_shift: tk("shift"),
  equipment_loan: tk("equipment loan"),
  court_booking: tk("booking"),
  membership_plan: tk("plan"),
};


/** A word a manager would use, never a table name: unknown ones lose their underscores. */
/**
 * Làm gì: Chuyển đổi mã thực thể (entity/table name) thành danh từ quen thuộc với người quản lý; tra cứu từ điển ENTITY_LABEL hoặc tự động loại bỏ dấu gạch dưới nếu chưa được định nghĩa.
 * Được gọi ở: src/routes/manager.audit.tsx (component Page: render dropdown lọc theo đối tượng và hiển thị tên thực thể bị tác động).
 * @param e Mã thực thể hoặc tên bảng dữ liệu trong audit log (ví dụ: "booking", "membership_plan").
 * @returns Tên thực thể thân thiện đã bản địa hóa hoặc chuỗi đã thay thế dấu gạch dưới bằng khoảng trắng.
 */
function entityLabel(e: string): string {
  // Tra cứu bản dịch tương ứng; nếu chưa có trong từ điển thì chuyển dấu gạch dưới thành khoảng trắng để quản lý dễ đọc.
  const known = ENTITY_LABEL[e];
  return known ? t(known) : e.replace(/_/g, " ");
}


/**
 * Which actions deserve to catch the eye.
 *
 * A log where everything is the same weight is a log nobody scans. Money
 * leaving the centre and changes to what it charges are the two things a
 * manager is reading this page to find.
 */
/**
 * Làm gì: Xác định tông màu (tone) cảnh báo cho badge hành động theo mức độ nhạy cảm; giúp người quản lý quét nhanh các thao tác thất thoát tiền hoặc sửa đổi chính sách giá.
 * Được gọi ở: src/routes/manager.audit.tsx (component Page: gán màu trực quan cho Badge hành động của từng bản ghi audit log).
 * @param action Mã hành động cần đánh giá mức độ rủi ro/chú ý.
 * @returns Tông màu hiển thị: "danger" (đỏ - hoàn tiền/hủy/xóa), "hold" (vàng - đổi giá/cấu hình/phân quyền), hoặc "muted" (xám - thao tác thông thường).
 */
function toneFor(action: string): "danger" | "hold" | "muted" {
  // Nhóm nguy hiểm (đỏ): các thao tác hoàn tiền, hủy lịch, xóa bỏ dữ liệu hoặc khóa tài khoản
  if (/refund|delete|reject|decline|cancel|lock|revoke|void/.test(action)) return "danger";
  // Nhóm cần chú ý (vàng): các thay đổi liên quan đến giá, cấu hình, tính năng, phân quyền, đóng ca hoặc mật khẩu
  if (/price|setting|flag|close_shift|freeze|plan|password|role|staff/.test(action)) return "hold";
  return "muted";
}


/**
 * Làm gì: Định dạng chuỗi mốc thời gian ISO thành chuỗi ngày giờ ngắn gọn, dễ nhìn theo múi giờ Việt Nam (Asia/Ho_Chi_Minh, 24 giờ).
 * Được gọi ở: src/client/lib/pages/manager.audit.ts (hàm showValue), src/routes/manager.audit.tsx (component Page: hiển thị thời điểm diễn ra hành động).
 * @param iso Chuỗi thời gian chuẩn ISO 8601 (ví dụ: "2026-11-16T12:00:00Z").
 * @returns Chuỗi thời gian đã định dạng ngắn gọn (ví dụ: "16 thg 11, 19:00"), hoặc trả lại chuỗi gốc nếu thời gian không hợp lệ.
 */
function when(iso: string): string {
  // Bước 1: Khởi tạo đối tượng Date; nếu chuỗi thời gian không hợp lệ thì giữ nguyên chuỗi gốc để tránh crash UI.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Bước 2: Định dạng theo múi giờ Việt Nam (Asia/Ho_Chi_Minh) với ngày, tháng rút gọn và giờ phút định dạng 24h.
  return new Intl.DateTimeFormat(locale(), {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

/**
 * Làm gì: Custom hook quản lý toàn bộ state, bộ lọc đa tiêu chí, phân trang và dữ liệu nhật ký audit log cho trang quản lý (/manager/audit).
 * Được gọi ở: src/routes/manager.audit.tsx (component Page tại route /manager/audit).
 * @returns Đối tượng chứa trạng thái phân trang, các bộ lọc (action, actor, entity, date, q), danh sách dòng hiển thị, danh sách tùy chọn lọc và các hàm thao tác (pick, hide, restoreAll).
 */
export function useManagerAudit() {
  // Bước 1: Khởi tạo phân trang (mặc định 50 dòng/trang) và lưu kích thước trang vào localStorage qua usePageState.
  const { offset, setOffset, pageSize, setPageSize, reset } = usePageState("manager.audit", 50);
  // Bước 2: Khai báo state lưu các tiêu chí lọc (hành động, người thao tác, thực thể, khoảng ngày và từ khóa tìm kiếm).
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [entity, setEntity] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  // Quản lý dòng đang mở chi tiết (open), dòng xem JSON thô (raw), danh sách ID bị ẩn tạm thời (hidden) và cờ hiển thị dòng ẩn (showHidden).
  const [open, setOpen] = useState<number | null>(null);
  // The entry whose raw JSON is showing under its field-by-field changes.
  const [raw, setRaw] = useState<number | null>(null);
  const [hidden, setHidden] = useState<number[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  // The pickers keep the full set once known, so filtering to one value does
  // not collapse its own menu down to that value.
  const [choices, setChoices] = useState<{ actions: string[]; entities: string[]; actors: Actor[] }>({
    actions: [],
    entities: [],
    actors: [],
  });

  // Khôi phục danh sách ID các dòng bị ẩn đã lưu trong localStorage khi component mount lần đầu.
  useEffect(() => setHidden(readHidden()), []);

  // Typing waits a beat so one search is one request; any search or filter starts at page one.
  // Bước 3: Áp dụng debounce 250ms cho ô tìm kiếm để hạn chế số lần gửi request, đồng thời reset về trang 1 khi từ khóa đổi.
  const [term, setTerm] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  useEffect(reset, [term, reset]);

  // Bước 4: Tạo đối tượng URLSearchParams đóng gói các tham số phân trang và bộ lọc hợp lệ gửi lên backend.
  const qs = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
  if (term) qs.set("q", term);
  if (action) qs.set("action", action);
  if (actor) qs.set("actor", actor);
  if (entity) qs.set("entity", entity);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  // The entries already on screen stay (dimmed) while a filter or another page loads; a refused or
  // failed answer replaces them with the reason, never with a list that does not match the filters.
  // Bước 5: Gửi request GET /audit lấy dữ liệu; keepPrevious: true giữ lại danh sách cũ trong lúc tải trang mới để UI không bị giật.
  const read = useRead<AuditPage>(`/audit?${qs}`, { keepPrevious: true });
  // Chuyển đổi ID kiểu bigserial từ chuỗi sang number để khớp với kiểu dữ liệu trong mảng hidden.
  const data = useMemo(
    // A bigserial can arrive as a string; the hidden list compares numbers.
    () => (read.data ? { ...read.data, items: read.data.items.map((e) => ({ ...e, id: Number(e.id) })) } : null),
    [read.data],
  );

  // Bước 6: Lưu danh sách tùy chọn lọc đầy đủ từ phản hồi ban đầu; không ghi đè khi đang có bộ lọc để menu không bị thu hẹp.
  useEffect(() => {
    if (!read.data || read.stale || action || actor || entity) return;
    setChoices({ actions: read.data.actions ?? [], entities: read.data.entities ?? [], actors: read.data.actors ?? [] });
  }, [read.data, read.stale, action, actor, entity]);

  /**
   * Làm gì: Tạo hàm callback cập nhật giá trị bộ lọc, đồng thời tự động reset về trang 1 và đóng dòng chi tiết đang mở.
   * Được gọi ở: src/routes/manager.audit.tsx (các dropdown select và DateField khi người dùng chọn tiêu chí lọc).
   * @param set Hàm setState tương ứng của bộ lọc cần cập nhật.
   * @returns Hàm tiếp nhận giá trị mới từ sự kiện người dùng.
   */
  function pick(set: (v: string) => void) {
    // Reset về trang đầu tiên và đóng chi tiết dòng đang mở trước khi cập nhật giá trị bộ lọc mới.
    return (v: string) => {
      reset();
      setOpen(null);
      set(v);
    };
  }

  // Hiding only tucks a row out of this screen. The log is append-only and
  // nothing here removes an entry from it.
  /**
   * Làm gì: Ẩn tạm thời một bản ghi audit khỏi màn hình hiện tại và lưu ID vào localStorage; không tác động hay xóa dữ liệu trong database.
   * Được gọi ở: src/routes/manager.audit.tsx (nút "Hide" trong phần chi tiết bản ghi audit).
   * @param id Mã ID của bản ghi audit log cần ẩn trên giao diện.
   */
  function hide(id: number) {
    // Thêm ID vào danh sách ẩn và lưu vào localStorage; log hệ thống là append-only nên thao tác này chỉ ẩn ở client.
    const next = [...new Set([...hidden, id])];
    setHidden(next);
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
    } catch {
      // Hidden for this visit is still fine when storage is unavailable.
    }
  }
  /**
   * Làm gì: Khôi phục hiển thị toàn bộ các bản ghi audit đã bị ẩn và xóa danh sách ID đã lưu trong localStorage.
   * Được gọi ở: src/routes/manager.audit.tsx (nút "Restore all" hoặc banner thông báo có dòng bị ẩn).
   */
  function restoreAll() {
    // Xóa sạch danh sách ID ẩn trong state và dọn dẹp khóa lưu trữ trong localStorage của trình duyệt.
    setHidden([]);
    setShowHidden(false);
    try {
      localStorage.removeItem(HIDDEN_KEY);
    } catch {
      // Nothing to clean up.
    }
  }

  // The search runs on the server across every page; only hidden entries are tucked away here.
  // Bước 7: Lọc các bản ghi audit hiển thị trên bảng: loại bỏ các dòng bị ẩn trừ khi bật chế độ xem showHidden.
  const rows = useMemo(
    () => (data?.items ?? []).filter((e) => showHidden || !hidden.includes(e.id)),
    [data, hidden, showHidden],
  );

  // Bước 8: Đếm số lượng dòng bị ẩn trong trang hiện tại và kiểm tra xem người dùng có đang áp dụng bộ lọc nào không.
  const hiddenHere = (data?.items ?? []).filter((e) => hidden.includes(e.id)).length;
  const filtered = !!(q || action || actor || entity || from || to);
  // Bước 9: Trả về toàn bộ state, dữ liệu đã tính toán và các hàm xử lý sự kiện để component Page sử dụng.
  return {
    offset, setOffset, pageSize, setPageSize, reset, action, setAction, actor, setActor, entity,
    setEntity, from, setFrom, to, setTo, q, setQ, open, setOpen, raw, setRaw, hidden, showHidden,
    setShowHidden, choices, read, data, pick, hide, restoreAll, rows, hiddenHere, filtered,
  };
}

// Xuất khẩu các hằng số CSS class và hàm tiện ích định dạng phục vụ render trang audit log.
export { selectCls, detail, changesOf, actionLabel, entityLabel, toneFor, when };
