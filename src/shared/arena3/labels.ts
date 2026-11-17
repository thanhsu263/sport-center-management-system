/**
 * Tệp này định nghĩa các bảng từ điển nhãn hiển thị (labels), mã định danh chuẩn và các hàm tiện ích
 * định dạng ngày giờ, trạng thái, môn thể thao, vai trò, phương thức thanh toán và quy tắc lặp (RRULE)
 * dùng chung cho toàn bộ ứng dụng Arena 3 (cả client UI và server handler).
 * Hỗ trợ đa ngôn ngữ động thông qua Proxy lazyLabels kết hợp bộ dịch t() / tk().
 */
import { t, tk } from "./translator.ts";

/**
 * Label tables are module-scope, so they hold English (marked with `tk`) and translate when a
 * property is read: `LEVEL_LABEL[x]` returns the text in the language that is on at that moment.
 */
function lazyLabels(record: Record<string, string>): Record<string, string> {
  return new Proxy(record, {
    get(target, key, receiver) {
      const v = Reflect.get(target, key, receiver);
      return typeof key === "string" && typeof v === "string" ? t(v) : v;
    },
  });
}

/**
 * Làm gì: Bảng ánh xạ mã môn thể thao (badminton, basketball, volleyball, all) sang tên hiển thị đa ngôn ngữ.
 * Được gọi ở: src/shared/arena3/labels.ts:sportLabel (dùng làm từ điển dự phòng khi DB chưa có tên môn).
 */
export const SPORT_LABEL: Record<string, string> = lazyLabels({
  badminton: tk("Badminton"),
  basketball: tk("Basketball"),
  volleyball: tk("Volleyball"),
  all: tk("All 3 sports"),
});

/**
 * Làm gì: Bảng ánh xạ mã vai trò người dùng (manager, receptionist, coach, member) sang tên hiển thị đa ngôn ngữ.
 * Được gọi ở: src/shared/arena3/labels.ts:roleLabel.
 */
export const ROLE_LABEL: Record<string, string> = lazyLabels({
  manager: tk("Manager"),
  receptionist: tk("Front desk"),
  coach: tk("Coach"),
  member: tk("Member"),
});

/**
 * Làm gì: Bảng ánh xạ cấp độ kỹ năng (cả mã tiếng Anh: beginner, intermediate, advanced, team và viết tắt: new, tb, nc) sang tên hiển thị đa ngôn ngữ.
 * Được gọi ở: src/shared/arena3/labels.ts:levelLabel.
 */
export const LEVEL_LABEL: Record<string, string> = lazyLabels({
  beginner: tk("Beginner"),
  intermediate: tk("Intermediate"),
  advanced: tk("Advanced"),
  team: tk("Team"),
  new: tk("Beginner"),
  tb: tk("Intermediate"),
  nc: tk("Advanced"),
});

/**
 * Làm gì: Bảng ánh xạ mã trạng thái của toàn bộ hệ thống (đặt sân, lớp học, điểm danh, gói tập, dụng cụ) sang tên nhãn hiển thị thân thiện.
 * Được gọi ở: src/shared/arena3/labels.ts:statusLabel.
 */
export const STATUS_LABEL: Record<string, string> = lazyLabels({
  confirmed: tk("Confirmed"),
  hold: tk("On hold"),
  in_use: tk("Playing"),
  cancelled: tk("Cancelled"),
  completed: tk("Completed"),
  noshow: tk("No-show"),
  active: tk("Active"),
  pending: tk("Unpaid"),
  expired: tk("Expired"),
  frozen: tk("Frozen"),
  draft: tk("Draft"),
  published: tk("Published"),
  archived: tk("Archived"),
  open: tk("Open"),
  closed: tk("Closed"),
  waitlisted: tk("Waitlisted"),
  present: tk("Present"),
  late: tk("Late"),
  absent: tk("Absent"),
  excused: tk("Excused"),
  out: tk("Checked out"),
  returned: tk("Returned"),
  // Class sessions: a finished one used to show the raw word "done".
  done: tk("Session done"),
  scheduled: tk("Scheduled"),
});

/**
 * Làm gì: Bảng ánh xạ loại chiếm dụng sân (hold, booking, session, maintenance) sang tên hiển thị đa ngôn ngữ.
 * Được gọi ở: src/shared/arena3/labels.ts:kindLabel.
 */
export const KIND_LABEL: Record<string, string> = lazyLabels({
  hold: tk("Hold"),
  booking: tk("Booking"),
  session: tk("Class"),
  maintenance: tk("Maintenance"),
});

/**
 * What one hour on one court is doing, as the grid paints it.
 *
 * An occupancy row only says *what was sold*; this is what the centre needs to
 * *run* the day. "Booked" and "In use" are the same booking an hour apart, and
 * telling them apart is the difference between a court reception can prepare
 * and a court someone is standing on. "Maintenance" and "Closed" are not sales
 * states at all — they are the building saying no.
 */
export const SLOT_STATE_LABEL: Record<string, string> = lazyLabels({
  free: tk("Free"),
  hold: tk("On hold"),
  booked: tk("Booked"),
  in_use: tk("In use"),
  class: tk("Class"),
  maintenance: tk("Maintenance"),
  closed: tk("Closed"),
  past: tk("Already passed"),
});

/**
 * Làm gì: Chuyển đổi mã trạng thái ô giờ của sân (free, booked, in_use, class...) thành nhãn hiển thị tương ứng.
 * Được gọi ở: src/client/components/court-grid.tsx:CourtGrid (hiển thị trạng thái các ô giờ trên lưới lịch sân).
 * @param s Mã trạng thái ô giờ cần chuyển đổi.
 * @returns Nhãn hiển thị tương ứng từ SLOT_STATE_LABEL, hoặc giữ nguyên mã gốc nếu không tìm thấy.
 */
export function slotStateLabel(s: string) {
  return SLOT_STATE_LABEL[s] ?? s;
}

/**
 * Làm gì: Bảng ánh xạ loại ngày (ngày thường weekday, cuối tuần weekend, ngày lễ holiday) sang nhãn hiển thị đa ngôn ngữ.
 * Được gọi ở: src/routes/manager.prices.tsx:ManagerPrices (giao diện cấu hình bảng giá sân theo từng loại ngày).
 */
export const DAY_KIND_LABEL: Record<string, string> = lazyLabels({
  weekday: tk("Weekday"),
  weekend: tk("Weekend"),
  holiday: tk("Holiday"),
});

const BYDAY: Record<string, string> = {
  MO: tk("Mon"),
  TU: tk("Tue"),
  WE: tk("Wed"),
  TH: tk("Thu"),
  FR: tk("Fri"),
  SA: tk("Sat"),
  SU: tk("Sun"),
};

/**
 * Làm gì: Định dạng số tháng thành chuỗi hiển thị thời hạn gói tập (hỗ trợ số ít '1 month' và số nhiều '{n} months').
 * Được gọi ở: src/routes/desk.index.tsx, src/routes/manager.plans.tsx, src/routes/manager.prices.tsx.
 * @param n Số lượng tháng cần hiển thị.
 * @returns Chuỗi nhãn thời hạn đã dịch theo số tháng.
 */
export function monthsLabel(n: number) {
  return n === 1 ? t("1 month") : t("{n} months", { n });
}

/** Names from the `sports` table, keyed by code. Filled by the client catalog (useSports) or the server. */
const SPORT_NAMES = new Map<string, string>();

/**
 * Làm gì: Nạp danh sách tên môn thể thao từ cơ sở dữ liệu vào bộ nhớ đệm SPORT_NAMES để ưu tiên sử dụng thay vì nhãn mặc định.
 * Được gọi ở: src/client/components/sports-ui.tsx:useSports (tải danh mục), src/server/controllers/handlers/reports.ts:managerReportSummary.
 * @param items Mảng các đối tượng chứa mã môn (code) và tên môn tương ứng (name).
 */
export function registerSportNames(items: { code: string; name?: string | null }[]) {
  for (const it of items) if (it.code && it.name) SPORT_NAMES.set(it.code.toLowerCase(), it.name);
}

/**
 * Làm gì: Lấy tên hiển thị của môn thể thao theo thứ tự ưu tiên: tên nạp từ DB trong SPORT_NAMES -> từ điển SPORT_LABEL -> viết hoa chữ cái đầu của mã môn.
 * Được gọi ở: src/client/components/court-grid.tsx, src/client/components/class-detail.tsx, src/routes/app.classes.tsx, src/server/controllers/handlers/reports.ts.
 * @param s Mã môn thể thao (ví dụ: 'badminton', 'basketball', 'volleyball').
 * @returns Tên môn thể thao hiển thị cho người dùng.
 */
export function sportLabel(s: string) {
  if (!s) return s;
  // Bước 1: Ưu tiên lấy tên môn thể thao cấu hình từ cơ sở dữ liệu nếu có
  const fromDb = SPORT_NAMES.get(s.toLowerCase());
  if (fromDb) return fromDb;
  // Bước 2: Dự phòng từ điển SPORT_LABEL hoặc viết hoa chữ cái đầu nếu không khớp
  return SPORT_LABEL[s] ?? s.charAt(0).toUpperCase() + s.slice(1);
}

// Bảng ánh xạ mã 3 ký tự viết hoa cho môn thể thao và cấp độ, dùng để tạo mã lớp học (classCode)
const CODE_SPORT: Record<string, string> = { badminton: "BAD", basketball: "BAS", volleyball: "VOL" };
const CODE_LEVEL: Record<string, string> = { beginner: "BEG", intermediate: "INT", advanced: "ADV", team: "SQD" };

/**
 * A short, stable code for a class — "BAD-BEG-1F3A".
 *
 * Classes carry no code of their own, and "Beginner" on its own does not say
 * which of the three beginner badminton classes a coach or the desk means.
 * Sport and level make it readable aloud; the last four characters of the id
 * make it unique. Derived rather than stored: no schema change, and it can
 * never drift from the row it names.
 */
export function classCode(sport: string, level: string, id: string) {
  // Bước 1: Lấy mã 3 chữ cái của môn thể thao (mặc định lấy 3 ký tự đầu viết hoa)
  const sp = CODE_SPORT[sport] ?? sport.slice(0, 3).toUpperCase();
  // Bước 2: Lấy mã 3 chữ cái của cấp độ (mặc định lấy 3 ký tự đầu viết hoa)
  const lv = CODE_LEVEL[level.toLowerCase()] ?? level.slice(0, 3).toUpperCase();
  // Bước 3: Ghép mã môn, cấp độ và 4 ký tự hex cuối của id (bỏ dấu gạch nối) để tạo mã lớp duy nhất
  return `${sp}-${lv}-${id.replace(/-/g, "").slice(-4).toUpperCase()}`;
}

/**
 * Làm gì: Chuyển đổi mã vai trò người dùng (manager, receptionist, coach, member) sang nhãn hiển thị đa ngôn ngữ.
 * Được gọi ở: src/client/components/shell.tsx:Shell, src/routes/login.tsx:Login, src/routes/account.tsx, src/routes/manager.staff.tsx.
 * @param s Mã vai trò người dùng.
 * @returns Tên vai trò hiển thị tương ứng từ ROLE_LABEL, hoặc giữ nguyên mã gốc nếu không khớp.
 */
export function roleLabel(s: string) {
  return ROLE_LABEL[s] ?? s;
}

/**
 * Làm gì: Chuyển đổi mã cấp độ lớp học (tiếng Anh hoặc viết tắt tiếng Việt) sang tên hiển thị đa ngôn ngữ.
 * Được gọi ở: src/client/components/class-detail.tsx, src/routes/app.classes.tsx, src/routes/coach.classes.tsx, src/routes/manager.classes.tsx.
 * @param s Mã cấp độ (không phân biệt chữ hoa/thường).
 * @returns Nhãn cấp độ hiển thị tương ứng từ LEVEL_LABEL, hoặc giữ nguyên mã gốc nếu không khớp.
 */
export function levelLabel(s: string) {
  return LEVEL_LABEL[s.toLowerCase()] ?? s;
}

/**
 * Làm gì: Chuyển đổi mã trạng thái hệ thống thành nhãn hiển thị thân thiện với người dùng.
 * Được gọi ở: src/client/components/ui/index.tsx:StatusBadge, src/routes/app.index.tsx, src/routes/desk.member.$id.tsx.
 * @param s Mã trạng thái cần chuyển đổi (ví dụ: 'confirmed', 'hold', 'cancelled', 'completed').
 * @returns Nhãn trạng thái đã được bản địa hóa từ STATUS_LABEL, hoặc giữ nguyên mã gốc nếu không khớp.
 */
export function statusLabel(s: string) {
  return STATUS_LABEL[s] ?? s;
}

/**
 * Làm gì: Chuyển đổi mã loại lịch chiếm dụng sân (hold, booking, session, maintenance) sang nhãn hiển thị đa ngôn ngữ.
 * Được gọi ở: src/client/components/court-grid.tsx:CourtGrid, src/client/components/class-detail.tsx.
 * @param s Mã loại chiếm dụng sân.
 * @returns Nhãn loại lịch tương ứng từ KIND_LABEL, hoặc giữ nguyên mã gốc nếu không khớp.
 */
export function kindLabel(s: string) {
  return KIND_LABEL[s] ?? s;
}

/**
 * Làm gì: Phân loại mã trạng thái sang tông màu hiển thị (tone) tương ứng của giao diện (badge/tag trạng thái).
 * Được gọi ở: src/client/components/ui/index.tsx:StatusBadge.
 * @param s Mã trạng thái cần phân loại màu.
 * @returns Tên tông màu: 'hold' (chờ xử lý), 'danger' (nguy hiểm/hủy), 'accent' (nổi bật/hoạt động), hoặc 'muted' (trung tính).
 */
export function statusTone(s: string): "ink" | "accent" | "hold" | "muted" | "danger" {
  // Tông vàng/cam: trạng thái tạm thời, đang chờ thanh toán hoặc đang trong danh sách chờ
  if (s === "hold" || s === "pending" || s === "waitlisted") return "hold";
  // Tông đỏ/nguy hiểm: trạng thái tiêu cực như bị hủy, hết hạn, không đến hoặc bị đóng băng
  if (s === "cancelled" || s === "expired" || s === "noshow" || s === "frozen") return "danger";
  // Tông xanh/nhấn: trạng thái tích cực như đã xác nhận, đang hoạt động hoặc đã hoàn thành
  if (s === "confirmed" || s === "active" || s === "published" || s === "in_use" || s === "completed") return "accent";
  return "muted";
}

/**
 * Làm gì: Bảng ánh xạ mã phương thức thanh toán (cash, transfer, card, gateway, quota) sang nhãn hiển thị đa ngôn ngữ trên UI.
 * Được gọi ở: src/shared/arena3/labels.ts:methodLabel, src/routes/desk.member.$id.tsx.
 */
export const METHOD_LABEL: Record<string, string> = lazyLabels({
  cash: tk("Cash"),
  transfer: tk("Bank transfer"),
  card: tk("Card"),
  gateway: tk("Online gateway"),
  quota: tk("Plan hours"),
});

/**
 * Payment methods in Vietnamese, for the printed invoice only.
 *
 * The interface is in English; an invoice is a Vietnamese document that gets
 * filed, so it does not borrow the UI's wording.
 */
export const METHOD_LABEL_VI: Record<string, string> = {
  cash: "Tiền mặt",
  transfer: "Chuyển khoản",
  card: "Thẻ",
  gateway: "Cổng thanh toán",
  quota: "Trừ giờ trong gói",
};

/**
 * Làm gì: Chuyển đổi mã phương thức thanh toán sang chuỗi tiếng Việt chuẩn dùng riêng cho hóa đơn in ấn lưu trữ.
 * Được gọi ở: src/server/controllers/handlers/desk.ts:deskInvoiceHtml (in phiếu thu/hóa đơn cho khách tại quầy).
 * @param s Mã phương thức thanh toán (cash, transfer, card, gateway, quota).
 * @returns Tên phương thức thanh toán bằng tiếng Việt từ METHOD_LABEL_VI, hoặc giữ nguyên chuỗi gốc nếu không khớp.
 */
export function methodLabelVi(s: string) {
  return METHOD_LABEL_VI[s] ?? s;
}

/**
 * Làm gì: Bảng ánh xạ nguồn thu / nguồn phát sinh giao dịch trong trung tâm (thuê sân, lớp học, gói tập...) sang nhãn hiển thị đa ngôn ngữ.
 * Được gọi ở: src/shared/arena3/labels.ts:sourceLabel.
 */
export const SOURCE_LABEL: Record<string, string> = lazyLabels({
  court: tk("Court rental"),
  booking: tk("Court rental"),
  class: tk("Class"),
  enrollment: tk("Class seat"),
  equipment: tk("Equipment hire"),
  membership: tk("Plan"),
  subscription: tk("Plan"),
  walk_in: tk("Walk-in"),
  other: tk("Other"),
});

/**
 * Làm gì: Chuyển đổi mã phương thức thanh toán thành nhãn hiển thị đa ngôn ngữ trên giao diện người dùng.
 * Được gọi ở: src/client/lib/pages/manager.audit.ts, src/routes/manager.index.tsx, src/server/controllers/handlers/reports.ts.
 * @param s Mã phương thức thanh toán.
 * @returns Tên phương thức thanh toán tương ứng từ METHOD_LABEL, hoặc giữ nguyên mã gốc nếu không khớp.
 */
export function methodLabel(s: string) {
  return METHOD_LABEL[s] ?? s;
}

/**
 * Làm gì: Chuyển đổi mã loại nguồn thu (court, class, membership...) sang nhãn hiển thị đa ngôn ngữ.
 * Được gọi ở: src/client/lib/pages/manager.index.ts, src/routes/manager.index.tsx, src/server/controllers/handlers/reports.ts.
 * @param s Mã loại nguồn thu.
 * @returns Tên loại nguồn thu hiển thị tương ứng từ SOURCE_LABEL, hoặc giữ nguyên mã gốc nếu không khớp.
 */
export function sourceLabel(s: string) {
  return SOURCE_LABEL[s] ?? s;
}

/** What a payment or refund was raised against, in words the desk uses. */
export function refTypeLabel(r: string) {
  const label = (
    {
      subscription: tk("Plan"),
      booking: tk("Booking"),
      day_pass: tk("Day pass"),
      walkin: tk("Walk-in"),
      equipment: tk("Equipment hire"),
      enrollment: tk("Class seat"),
    } as Record<string, string>
  )[r];
  return label ? t(label) : r;
}

const MONTH_SHORT = [
  tk("Jan"),
  tk("Feb"),
  tk("Mar"),
  tk("Apr"),
  tk("May"),
  tk("Jun"),
  tk("Jul"),
  tk("Aug"),
  tk("Sep"),
  tk("Oct"),
  tk("Nov"),
  tk("Dec"),
];

/** 2026-09-17 → 17 Sep 2026 */
export function formatDate(iso: string) {
  // Bước 1: Trích xuất phần ngày YYYY-MM-DD từ chuỗi ISO và tách năm, tháng, ngày
  const day = iso.slice(0, 10);
  const [y, m, d] = day.split("-");
  if (!y || !m || !d) return iso;
  // Bước 2: Lấy tên viết tắt của tháng đã dịch và ghép thành chuỗi 'DD Month YYYY'
  const month = MONTH_SHORT[Number(m) - 1];
  if (!month) return iso;
  return `${Number(d)} ${t(month)} ${y}`;
}

/**
 * Làm gì: Cộng thêm (hoặc trừ đi) một số ngày vào chuỗi ngày định dạng YYYY-MM-DD và trả về ngày mới theo chuẩn ISO.
 * Được gọi ở: src/client/components/court-grid.tsx, src/routes/app.book.tsx, src/routes/desk.series.tsx, src/routes/manager.classes.tsx.
 * @param iso Chuỗi ngày đầu vào định dạng YYYY-MM-DD (hoặc chuỗi ISO timestamp).
 * @param days Số ngày cần cộng thêm (dùng số âm nếu muốn lùi ngày).
 * @returns Chuỗi ngày kết quả định dạng YYYY-MM-DD.
 */
export function addDaysISO(iso: string, days: number) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  // Dùng Date.UTC để tính toán ngày tuyệt đối, tránh lỗi lệch ngày do múi giờ địa phương
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + days));
  return dt.toISOString().slice(0, 10);
}

/**
 * Làm gì: Lấy tên thứ rút gọn trong tuần (Sun, Mon, Tue...) đã được dịch sang ngôn ngữ hiện tại từ chuỗi ngày ISO.
 * Được gọi ở: src/client/components/court-grid.tsx:CourtGrid, src/client/components/landing/util.tsx.
 * @param iso Chuỗi ngày định dạng YYYY-MM-DD.
 * @returns Tên thứ rút gọn đã dịch (ví dụ: 'Sun', 'Mon' hoặc 'CN', 'T2' tùy ngôn ngữ hiện hành).
 */
export function weekdayShort(iso: string) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  // Lấy chỉ số thứ trong tuần (0: Chủ Nhật .. 6: Thứ Bảy) theo giờ UTC để đảm bảo tính nhất quán
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  return t([tk("Sun"), tk("Mon"), tk("Tue"), tk("Wed"), tk("Thu"), tk("Fri"), tk("Sat")][dt.getUTCDay()] ?? "");
}

/**
 * Làm gì: Lấy ngày hiện tại ở định dạng YYYY-MM-DD theo múi giờ chuẩn Việt Nam (Asia/Ho_Chi_Minh).
 * Được gọi ở: src/client/components/court-grid.tsx, src/routes/app.book.tsx, src/routes/desk.courts.tsx, src/routes/manager.classes.tsx.
 * @returns Chuỗi ngày hôm nay định dạng YYYY-MM-DD (sử dụng locale en-CA để định dạng ISO).
 */
export function todayISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const DAY_ORDER = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** Weekday codes in calendar order, unknown tokens dropped. Click order is not kept. */
function orderedDays(raw: string): string[] {
  // Bước 1: Tách chuỗi theo dấu phẩy, lọc bỏ khoảng trắng và chỉ giữ các mã thứ hợp lệ
  const seen = new Set(
    raw
      .split(",")
      .map((d) => d.trim())
      .filter((d) => DAY_ORDER.includes(d)),
  );
  // Bước 2: Sắp xếp các thứ theo đúng thứ tự lịch tuần từ Thứ 2 (MO) đến Chủ Nhật (SU)
  return DAY_ORDER.filter((d) => seen.has(d));
}

/**
 * Làm gì: Chuyển đổi số phút trong ngày (tính từ 00:00) thành chuỗi giờ hiển thị dạng HH:mm.
 * Được gọi ở: src/shared/arena3/labels.ts:rruleLabel (định dạng giờ bắt đầu và khoảng giờ học).
 * @param mins Tổng số phút kể từ đầu ngày.
 * @returns Chuỗi thời gian định dạng 2 chữ số HH:mm (ví dụ: '08:00', '18:30').
 */
function clock(mins: number): string {
  // Chuẩn hóa phút về phạm vi một ngày 0..1439 phút (1440 phút/ngày), xử lý an toàn cho cả số âm
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=18 → Mon, Wed · 18:00. With a duration, the end is on the label too. */
export function rruleLabel(rrule: string, durationMin?: number) {
  // Bước 1: Tách các cặp khóa-giá trị trong chuỗi quy tắc lặp iCalendar (phân cách bằng dấu ';')
  const parts = Object.fromEntries(
    rrule.split(";").map((p) => {
      const [k, v] = p.split("=");
      return [k ?? "", v ?? ""];
    }),
  );
  // Bước 2: Chuẩn hóa và sắp xếp danh sách các ngày học trong tuần theo thứ tự lịch
  const codes = orderedDays(parts.BYDAY ?? "");
  // Bước 3: Định dạng tên ngày: nếu đủ cả 7 ngày thì hiển thị 'Hàng ngày', ngược lại nối tên các thứ
  const days =
    codes.length === 7
      ? t("Every day")
      : codes
          .map((d) => t(BYDAY[d]!))
          .filter(Boolean)
          .join(", ");
  // Bước 4: Lấy giờ bắt đầu (BYHOUR) và tính khoảng giờ bắt đầu – kết thúc nếu có thời lượng durationMin
  const hour = parts.BYHOUR != null && parts.BYHOUR !== "" ? Number(parts.BYHOUR) : NaN;
  const start = Number.isFinite(hour) ? clock(hour * 60) : "";
  const range = start && durationMin && durationMin > 0 ? `${start}–${clock(hour * 60 + durationMin)}` : start;
  // Bước 5: Ghép thông tin ngày và khung giờ (ví dụ: 'Thứ 2, Thứ 4 · 18:00–19:30')
  if (days && range) return `${days} · ${range}`;
  if (days) return days;
  return rrule;
}

/**
 * Làm gì: Tạo chuỗi quy tắc lặp hàng tuần theo chuẩn iCalendar RRULE (FREQ=WEEKLY) từ danh sách các thứ và giờ bắt đầu.
 * Được gọi ở: src/routes/manager.classes.tsx:ManagerClasses (form tạo và chỉnh sửa lịch học của lớp).
 * @param days Mảng các mã ngày trong tuần (ví dụ: ['MO', 'WE', 'FR']).
 * @param hour Giờ bắt đầu học trong ngày (0-23).
 * @returns Chuỗi RRULE chuẩn hóa (ví dụ: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18').
 */
export function composeWeeklyRrule(days: string[], hour: number) {
  // Sắp xếp các thứ theo thứ tự tuần; nếu mảng rỗng thì mặc định là Thứ 2 (MO)
  const byday = orderedDays(days.join(",")).join(",") || "MO";
  return `FREQ=WEEKLY;BYDAY=${byday};BYHOUR=${hour}`;
}

/**
 * Làm gì: Phân tích chuỗi quy tắc RRULE lặp hàng tuần thành đối tượng gồm mảng các ngày (days) và giờ bắt đầu (hour).
 * Được gọi ở: src/server/controllers/helpers.ts, src/shared/arena3/labels.ts:classSlotMatches.
 * @param rrule Chuỗi quy tắc lặp iCalendar (ví dụ: 'FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=19').
 * @returns Đối tượng chứa danh sách mã ngày days và giờ bắt đầu hour (mặc định 18:00 nếu thiếu).
 */
export function parseWeeklyRrule(rrule: string): { days: string[]; hour: number } {
  // Bước 1: Chuyển các tham số trong chuỗi RRULE thành đối tượng khóa-giá trị
  const parts = Object.fromEntries(
    rrule.split(";").map((p) => {
      const [k, v] = p.split("=");
      return [k ?? "", v ?? ""];
    }),
  );
  // Bước 2: Tách danh sách mã các ngày lặp (BYDAY), mặc định là Thứ 2 (MO) nếu không có
  const days = (parts.BYDAY ?? "MO")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  // Bước 3: Lấy giờ bắt đầu (BYHOUR), mặc định là 18:00 nếu không được chỉ định
  return { days, hour: Number(parts.BYHOUR ?? 18) };
}

/** The class-list filters: a weekday code ("MO"…) and a part of the day; empty means any. */
export function classSlotMatches(rrule: string | undefined, day: string, part: string): boolean {
  // Nếu không chọn bộ lọc ngày và buổi nào thì chấp nhận tất cả các lớp
  if (!day && !part) return true;
  if (!rrule) return false;
  // Phân tích chuỗi RRULE để lấy danh sách ngày và giờ bắt đầu của lớp học
  const p = parseWeeklyRrule(rrule);
  // Kiểm tra nếu lớp học không diễn ra vào ngày được chọn thì loại bỏ
  if (day && !p.days.includes(day)) return false;
  // Lọc theo buổi trong ngày: Sáng (<12h), Chiều (12h-17h), Tối (>=17h)
  if (part === "morning") return p.hour < 12;
  if (part === "afternoon") return p.hour >= 12 && p.hour < 17;
  if (part === "evening") return p.hour >= 17;
  return true;
}
