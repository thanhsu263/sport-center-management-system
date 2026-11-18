/**
 * Tiện ích thời gian và tiền tệ dùng chung cho toàn bộ hệ thống Arena3.
 * File này quy chuẩn tất cả thao tác ngày giờ về múi giờ Việt Nam (ICT - Asia/Ho_Chi_Minh, UTC+7),
 * xử lý định dạng ngày/giờ hóa đơn, tính toán khung giờ thuê sân (slot), kiểm tra lịch học,
 * làm tròn và định dạng tiền tệ VNĐ, đảm bảo thống nhất giữa client và server.
 */
const ICT = "Asia/Ho_Chi_Minh";

/** Interpret YYYY-MM-DD + HH:mm as ICT wall clock (VN has no DST). */
export function ictDateTime(date: string, hm: string): Date {
  // Chuẩn hóa giờ HH:mm thành HH:mm:00 nếu chưa có giây để tạo chuỗi thời gian chuẩn ISO.
  const time = hm.length === 5 ? `${hm}:00` : hm;
  // Gắn cố định offset +07:00 (ICT) để đối tượng Date luôn đúng giờ Việt Nam dù server chạy ở múi giờ nào.
  return new Date(`${date}T${time}+07:00`);
}

/**
 * Làm gì: Lấy mốc thời gian hiện tại dưới dạng đối tượng Date.
 * Được gọi ở: Tiện ích dùng chung khi cần mốc thời gian hiện tại chuẩn hóa cho các tác vụ kiểm tra lịch.
 * @returns Đối tượng Date đại diện cho thời điểm hiện tại.
 */
export function ictNow(): Date {
  return new Date();
}

/**
 * Làm gì: Chuyển đổi đối tượng Date thành chuỗi ngày định dạng YYYY-MM-DD theo múi giờ Việt Nam (ICT). Dùng locale en-CA vì chuẩn này trả về đúng định dạng ISO YYYY-MM-DD.
 * Được gọi ở: handlers/ (bookings.ts, classes.ts, checkin.ts, attendance.ts, desk.ts, plans.ts, reports.ts, ops.ts, extras.ts, training.ts), services/ (membership.ts, rrule.ts), data/jobs.ts.
 * @param d Đối tượng Date cần định dạng (mặc định là thời điểm hiện tại).
 * @returns Chuỗi ngày định dạng YYYY-MM-DD theo giờ ICT.
 */
export function ictDateString(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ICT,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Làm gì: Lấy giá trị giờ trong ngày (từ 0 đến 23) theo múi giờ Việt Nam (ICT) từ đối tượng Date.
 * Được gọi ở: src/server/services/arena3.test.ts (bộ kiểm thử đơn vị, test runner (node --test)).
 * @param d Đối tượng Date cần lấy giờ.
 * @returns Số nguyên từ 0 đến 23 thể hiện giờ hiện tại theo giờ ICT.
 */
export function ictHour(d: Date): number {
  return Math.floor(ictMinutes(d) / 60);
}

/**
 * An instant as a Vietnamese reader expects to see it: `27/09/2026 19:00`.
 *
 * For invoice goods lines and anything else a member reads on paper. Takes the
 * raw timestamptz string the database hands back, so callers do not each parse
 * it their own way.
 */
export function ictStamp(at: string | Date): string {
  const d = at instanceof Date ? at : new Date(at);
  // Trả về nguyên bản chuỗi đầu vào nếu giá trị thời gian không hợp lệ, tránh gây lỗi hiển thị.
  if (Number.isNaN(d.getTime())) return String(at);
  // Bóc tách ngày, tháng, năm, giờ, phút theo định dạng 24h (h23) trong múi giờ ICT.
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: ICT,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  // Ghép thành chuỗi DD/MM/YYYY HH:mm quen thuộc với người dùng Việt Nam khi in hóa đơn.
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

/** Just the `HH:mm` half of {@link ictStamp}. */
export function ictClock(at: string | Date): string {
  return ictStamp(at).slice(-5);
}

/** Minutes since midnight in ICT (0–1439). */
export function ictMinutes(d: Date): number {
  // Bóc tách thành phần giờ và phút theo múi giờ ICT mà không phụ thuộc vào múi giờ của máy chủ.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: ICT,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  // Quy đổi tổng số phút trôi qua từ nửa đêm (00:00 ICT) để phục vụ so sánh và tính toán bảng giá.
  return hour * 60 + minute;
}

/**
 * Làm gì: Xác định thứ trong tuần theo múi giờ Việt Nam (ICT), quy ước từ 0 (Chủ nhật) đến 6 (Thứ bảy).
 * Được gọi ở: isWeekendIct (trong file), src/server/services/policy.ts, src/server/services/rrule.ts.
 * @param d Đối tượng Date cần xác định thứ trong tuần.
 * @returns Số nguyên từ 0 (Chủ nhật) đến 6 (Thứ bảy).
 */
export function ictWeekday(d: Date): number {
  // 0 Sun … 6 Sat in ICT
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: ICT, weekday: "short" }).format(d);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}

/**
 * Làm gì: Kiểm tra xem một thời điểm có rơi vào ngày cuối tuần (Thứ bảy hoặc Chủ nhật) theo giờ Việt Nam hay không.
 * Được gọi ở: src/server/services/pricing.ts (trong hàm quoteCourtPrice để áp dụng bảng giá cuối tuần).
 * @param d Đối tượng Date cần kiểm tra.
 * @returns boolean True nếu là Thứ bảy hoặc Chủ nhật, ngược lại false.
 */
export function isWeekendIct(d: Date): boolean {
  const wd = ictWeekday(d);
  return wd === 0 || wd === 6;
}

/**
 * Làm gì: Cộng hoặc trừ một số ngày vào chuỗi ngày YYYY-MM-DD và trả về chuỗi ngày kết quả dạng YYYY-MM-DD. Tính toán qua Date.UTC để tránh lỗi lệch múi giờ và DST.
 * Được gọi ở: handlers/ (bookings.ts, classes.ts, checkin.ts, attendance.ts, desk.ts, ops.ts, plans.ts, reports.ts, training.ts), services/ (membership.ts, policy.ts, rrule.ts), helpers.ts.
 * @param date Chuỗi ngày gốc định dạng YYYY-MM-DD.
 * @param n Số ngày cần cộng thêm (hoặc trừ đi nếu là số âm).
 * @returns Chuỗi ngày mới định dạng YYYY-MM-DD.
 */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  // Dùng Date.UTC (tháng trừ 1 do index từ 0) để tính toán thuần số học, tránh hiện tượng lệch ngày do chênh lệch múi giờ.
  const dt = new Date(Date.UTC(y!, m! - 1, d! + n));
  return dt.toISOString().slice(0, 10);
}

/**
 * Làm gì: Làm tròn số tiền Việt Nam Đồng (VND) theo bước chỉ định (mặc định 1.000đ) để không phát sinh tiền lẻ dưới mệnh giá tiền tệ thực tế.
 * Được gọi ở: handlers/bookings.ts, handlers/extras.ts, services/ (membership.ts, policy.ts, pricing.ts), arena3.test.ts.
 * @param n Số tiền cần làm tròn.
 * @param step Bước làm tròn (mặc định 1.000).
 * @returns Số tiền đã được làm tròn thành bội số của step.
 */
export function roundVnd(n: number, step = 1000): number {
  return Math.round(n / step) * step;
}

/**
 * Làm gì: Định dạng số tiền VND thành chuỗi hiển thị có dấu phẩy phân cách hàng nghìn và hậu tố 'đ' (ví dụ 100000 -> "100,000đ").
 * Được gọi ở: src/client/lib/pages/manager.audit.ts, src/routes/manager.audit.tsx.
 * @param n Số tiền VND cần hiển thị.
 * @returns Chuỗi tiền tệ đã định dạng kèm ký hiệu 'đ'.
 */
export function formatVnd(n: number): string {
  return `${new Intl.NumberFormat("en-US").format(n)}đ`;
}

/**
 * Làm gì: Tạo danh sách các mốc giờ mở cửa hoạt động của trung tâm từ 6h sáng đến 21h tối (khung giờ bắt đầu các ca thuê sân).
 * Được gọi ở: Tiện ích dùng chung cho các bộ kiểm thử và giao diện chọn khung giờ đặt sân.
 * @returns Mảng số nguyên từ 6 đến 21 đại diện cho các giờ bắt đầu slot.
 */
export function slotHours(): number[] {
  const hours: number[] = [];
  // Trung tâm hoạt động từ 6:00 đến 22:00, khung giờ bắt đầu ca thuê cuối cùng trong ngày là 21:00.
  for (let h = 6; h <= 21; h += 1) hours.push(h);
  return hours;
}

/**
 * Làm gì: Chuyển đổi số thành chuỗi và đệm số 0 ở đầu nếu có 1 chữ số, đảm bảo luôn có tối thiểu 2 chữ số (ví dụ: 8 -> "08").
 * Được gọi ở: src/server/services/arena3.test.ts (bộ kiểm thử đơn vị, test runner (node --test)).
 * @param n Số nguyên cần định dạng.
 * @returns Chuỗi có tối thiểu 2 ký tự với số 0 đệm đầu.
 */
export function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Làm gì: Kiểm tra xem khoảng thời gian từ lần chạy gần nhất (lastAt) đến hiện tại (now) đã vượt qua chu kỳ định kỳ (everyMs) hay chưa, hoặc kiểm tra tác vụ chưa từng chạy.
 * Được gọi ở: src/server/data/jobs.ts (điều phối chu kỳ chạy tác vụ nền), src/server/services/arena3.test.ts (test runner (node --test)).
 * @param lastAt Mốc thời gian lần thực thi gần nhất (millisecond), hoặc undefined nếu chưa từng chạy.
 * @param now Mốc thời gian hiện tại (millisecond).
 * @param everyMs Khoảng cách thời gian tối thiểu giữa các lần chạy (millisecond).
 * @returns boolean True nếu đã đến lúc cần chạy lại tác vụ, ngược lại false.
 */
export function elapsedAtLeast(lastAt: number | undefined, now: number, everyMs: number) {
  return lastAt == null || now - lastAt >= everyMs;
}

// Độ lệch múi giờ Việt Nam (UTC+7) tính bằng millisecond (7 giờ * 3.600.000 ms/giờ = 25.200.000 ms), dùng để căn chỉnh mốc thời gian về nửa đêm theo giờ địa phương.
const ICT_OFFSET_MS = 7 * 3_600_000;

/**
 * Every class session is exactly one court hour, the same as a court booking.
 * Anything else ends off the hour or holds more than one slot (a 90-minute
 * 18:00 class kept the court until 20:00, so the 19:00 class on that coach was
 * never created). `null` means the caller should refuse the value. A missing
 * value is one hour.
 */
export function classMinutes(raw: number | null | undefined): number | null {
  // Mặc định thời lượng một buổi lớp học là 60 phút nếu không truyền giá trị.
  const n = raw == null ? 60 : raw;
  // Quy tắc nghiệp vụ BR-11: mọi buổi học dài đúng 1 tiếng (60 phút), bằng một slot đặt sân; từ chối (trả null) mọi số phút khác.
  return n === 60 ? n : null;
}

/**
 * The court time a class really uses: whole booking slots, never part of one.
 *
 * The session keeps its declared start and end. The court is held for every
 * slot that window touches, counted from midnight in the centre's time zone,
 * so a stray partial hour cannot leave a gap too short to book.
 */
export function slotSpan(start: Date, end: Date, slotMinutes: number): { start: Date; end: Date } {
  // Bước 1: Quy đổi độ dài một slot sang millisecond (tối thiểu 1 phút = 60.000 ms để tránh chia cho 0).
  const slotMs = Math.max(1, Math.floor(slotMinutes)) * 60_000;
  // Bước 2: Làm tròn mốc bắt đầu xuống đầu slot và mốc kết thúc lên cuối slot theo múi giờ ICT, tránh để sót khoảng trống lẻ không thể đặt sân.
  const floor = (t: number) => Math.floor((t + ICT_OFFSET_MS) / slotMs) * slotMs - ICT_OFFSET_MS;
  const ceil = (t: number) => Math.ceil((t + ICT_OFFSET_MS) / slotMs) * slotMs - ICT_OFFSET_MS;
  // Bước 3: Trả về khoảng thời gian giữ sân thực tế bao trọn các slot bị chiếm dụng.
  return { start: new Date(floor(start.getTime())), end: new Date(ceil(end.getTime())) };
}

/** Compute age in years as of today in ICT timezone. */
export function ageYears(dob?: string | null): number {
  // Trả về 0 nếu ngày sinh chưa được cung cấp hoặc rỗng.
  if (!dob) return 0;
  const d = new Date(dob);
  // Trả về 0 nếu chuỗi ngày sinh không đúng định dạng hợp lệ.
  if (Number.isNaN(d.getTime())) return 0;
  // Bước 1: Lấy thời điểm hiện tại quy về múi giờ Việt Nam (ICT) để tính tuổi chính xác theo ngày địa phương.
  const nowIct = new Date(new Date().toLocaleString("en-US", { timeZone: ICT }));
  // Bước 2: Tính số năm chênh lệch sơ bộ giữa năm hiện tại và năm sinh.
  let age = nowIct.getFullYear() - d.getFullYear();
  const m = nowIct.getMonth() - d.getMonth();
  // Bước 3: Nếu chưa đến tháng sinh hoặc cùng tháng nhưng chưa đến ngày sinh trong năm nay thì trừ đi 1 tuổi.
  if (m < 0 || (m === 0 && nowIct.getDate() < d.getDate())) age -= 1;
  // Đảm bảo số tuổi không âm (tối thiểu là 0) nếu ngày sinh lớn hơn ngày hiện tại do dữ liệu nhập sai.
  return Math.max(0, age);
}
