/**
 * File: src/server/controllers/handlers/bookings.ts
 * Vai trò: Module điều khiển (handler) quản lý toàn bộ nghiệp vụ đặt sân thể thao trong hệ thống Arena3.
 * Phụ trách: Tra cứu tình trạng kín sân (occupancy/availability), giữ chỗ tạm thời (hold),
 * xác nhận đặt sân (confirm), đặt trực tiếp tại quầy (walk-in), đổi lịch (reschedule), hủy sân & hoàn tiền,
 * cùng các hàm kiểm tra ràng buộc lưới giờ (slot grid, window) và tránh xung đột lịch chơi của khách hàng.
 */
import { reconcileLoyaltyRefund } from "../../services/loyalty";
import { PLAYED_SQL } from "./played";
import type { Sql } from "@/server/data/db";
import { BOOKING_COLS, PAYMENT_COLS } from "../../services/columns";
import type { Booking, BookingResponse, CancelQuoteResponse, CancelResponse, CheckInResponse, CollectBalanceResponse, ConfirmResponse, HoldResponse, MeBookingsResponse, MyBooking, MyClassSession, Payment, Reply, RescheduleResponse, SettledBooking, TransferConfirmResponse, TransferRejectResponse, WalkInResponse } from "../../../shared/arena3/contracts";
import { ApiError, err, isConflictSlot } from "../errors";
import { audit, bookingBuyer, enqueue, enqueueReceipt, getSettings, issueInvoice, nextCode, num, readJson, str } from "../helpers";
import { isValidVnPhone, normalizePhone } from "../../services/phone";
import { memberCourtFee } from "../../services/membership";
import { dueNow, quoteCancel } from "../../services/policy";
import { applyDiscount, lookupPrice } from "../../services/pricing";
import { quotePromo, redeemForBooking, restoreIfFullyRefunded } from "../../services/promos";
import { requireRole, type PublicUser } from "../session";
import { addDays, ictClock, ictDateString, ictDateTime, ictMinutes, ictStamp, roundVnd } from "../../../shared/arena3/time";
import { one } from "../tx";
import { getActiveSportCodes } from "./sports";
import { blockCourtCommitments } from "./court-block";

/**
 * Làm gì: Truy vấn thông tin chi tiết của một sân thể thao từ bảng courts theo mã định danh (id).
 * Được gọi ở: src/server/controllers/handlers/bookings.ts (các hàm courtsRetire, bookingsHold, bookingsConfirm, bookingsTransferReject, bookingsCollectBalance, bookingsReschedule, walkIn).
 * @param sql Đối tượng kết nối cơ sở dữ liệu Sql.
 * @param id Mã UUID của sân cần tra cứu.
 * @returns Thông tin chi tiết của sân (id, court_code, sport, status, display_name, sort_order, retired_at).
 * @throws Lỗi 404 (NOT_FOUND) nếu không tìm thấy sân tương ứng trong hệ thống.
 */
async function courtById(sql: Sql, id: string) {
  const c = await one<{
    id: string;
    court_code: string;
    sport: string;
    status: string;
    display_name: string | null;
    sort_order: number | null;
    retired_at: string | null;
  }>(sql, `select id, court_code, sport, status, display_name, sort_order, retired_at from courts where id = $1`, [id]);
  // Kiểm tra sự tồn tại của sân; nếu không tìm thấy thì ném lỗi 404 để dừng xử lý.
  if (!c) throw err.notFound("No such court.");
  return c;
}

/**
 * Làm gì: Tính toán mốc thời gian bắt đầu và kết thúc của một ca chơi (slot) dựa trên thời lượng số phút.
 * Được gọi ở: src/server/controllers/handlers/bookings.ts (các hàm bookingsHold, bookingsReschedule, walkIn).
 * @param startAt Thời điểm bắt đầu ca chơi (Date).
 * @param slotMin Thời lượng của một ca chơi tính bằng phút (từ cấu hình slot_minutes).
 * @returns Đối tượng { start, end } chứa thời điểm bắt đầu và kết thúc của ca chơi.
 */
function slotBounds(startAt: Date, slotMin: number) {
  // Quy đổi số phút của slot ra mili-giây (60.000 ms = 1 phút) rồi cộng vào thời điểm bắt đầu.
  const end = new Date(startAt.getTime() + slotMin * 60_000);
  return { start: startAt, end };
}

/**
 * Làm gì: Kiểm tra thời điểm bắt đầu ca chơi có hợp lệ và khớp với lưới thời gian (slot grid) cùng khung giờ hoạt động của trung tâm hay không.
 * Được gọi ở: src/server/controllers/handlers/bookings.ts (hàm assertBookWindow), src/server/controllers/handlers/classes.ts (hàm sessionReschedule).
 * @param start Thời điểm bắt đầu ca chơi cần kiểm tra (Date).
 * @param settings Cấu hình hệ thống gồm thời lượng slot (slot_minutes), giờ mở cửa (open_time) và giờ đóng cửa (close_time).
 * @returns Không trả về giá trị nếu thời gian hợp lệ.
 * @throws Lỗi 400 (FIELD) nếu giờ không hợp lệ, lệch lưới slot, hoặc kết thúc sau giờ đóng cửa; lỗi BR-06 nếu nằm ngoài giờ mở cửa.
 */
export function assertSlotGrid(
  start: Date,
  settings: { slot_minutes: number; open_time: string; close_time: string },
) {
  // Bước 1: Kiểm tra tính hợp lệ của đối tượng Date mốc bắt đầu.
  if (Number.isNaN(start.getTime())) {
    throw err.field("start_at", "That time is not valid.");
  }
  // Bước 2: Xác định mốc thời gian mở cửa và đóng cửa trong ngày theo múi giờ ICT.
  const date = ictDateString(start);
  const open = ictDateTime(date, settings.open_time.slice(0, 5));
  const close = ictDateTime(date, settings.close_time.slice(0, 5));
  // Quy tắc BR-06: Ca chơi không được bắt đầu trước giờ mở cửa hoặc sau giờ đóng cửa của trung tâm.
  if (start < open || start >= close) {
    throw err.br("BR-06", "That is outside opening hours.");
  }
  // Bước 3: Đổi giờ mở cửa và giờ bắt đầu ra số phút tính từ đầu ngày để kiểm tra độ khớp lưới slot.
  const [oh, om] = settings.open_time.split(":").map(Number);
  const openMinutes = oh * 60 + (om || 0);
  const startMin = ictMinutes(start);

  // Giờ bắt đầu phải tròn phút (giây và mili-giây bằng 0) và khoảng cách từ giờ mở cửa phải chia hết cho slot_minutes.
  if (
    start.getUTCSeconds() !== 0 ||
    start.getUTCMilliseconds() !== 0 ||
    Math.abs(startMin - openMinutes) % settings.slot_minutes !== 0
  ) {
    throw err.field("start_at", "Start time must be aligned to the slot grid.");
  }
  // Bước 4: Kiểm tra thời điểm kết thúc ca chơi không được vượt quá giờ đóng cửa trung tâm.
  const end = new Date(start.getTime() + settings.slot_minutes * 60_000);
  if (end > close) {
    throw err.field("start_at", "Slot would end after closing time.");
  }
}

/**
 * Làm gì: Kiểm tra các điều kiện khung thời gian đặt sân: không đặt trong quá khứ, đủ thời lượng cho khách vãng lai, khớp lưới slot và không vượt quá số ngày cho phép đặt trước.
 * Được gọi ở: src/server/controllers/handlers/bookings.ts (các hàm bookingsHold, bookingsReschedule, walkIn).
 * @param start Thời điểm bắt đầu ca chơi muốn đặt (Date).
 * @param opts Tùy chọn gồm cờ walkIn (đặt trực tiếp tại quầy) và đối tượng cấu hình settings.
 * @returns Không trả về giá trị nếu thời gian đặt sân hợp lệ.
 * @throws Lỗi BR-07 nếu đặt ca trong quá khứ hoặc ca walk-in còn dưới 20 phút; lỗi BR-05 nếu đặt trước quá số ngày cho phép (book_ahead_days).
 */
async function assertBookWindow(
  start: Date,
  opts: { walkIn: boolean; settings: Awaited<ReturnType<typeof getSettings>> },
) {
  // Bước 1: Kiểm tra thời điểm đặt sân so với thời gian hiện tại.
  const now = new Date();
  // Quy tắc BR-07: Người dùng đặt online không được phép đặt ca chơi trong quá khứ.
  if (!opts.walkIn && start < now) throw err.br("BR-07", "You cannot book a slot in the past.");
  // Khách vãng lai (walk-in) tại quầy đặt ca đang diễn ra phải còn tối thiểu 20 phút chơi.
  if (opts.walkIn && start < now) {
    const remain = (start.getTime() + opts.settings.slot_minutes * 60_000 - now.getTime()) / 60_000;
    if (remain < 20) throw err.br("BR-07", "Walk-ins need at least 20 minutes left in the slot.");
  }
  // Bước 2: Kiểm tra giờ đặt sân phải khớp với lưới thời gian (slot grid) và nằm trong giờ mở cửa.
  assertSlotGrid(start, opts.settings);
  // Bước 3: Kiểm tra giới hạn số ngày được phép đặt trước đối với hình thức đặt online thông thường.
  if (!opts.walkIn) {
    const ahead = opts.settings.book_ahead_days;
    const max = new Date(now.getTime() + ahead * 86400000);
    // Quy tắc BR-05: Chặn đặt sân nếu thời gian chơi vượt quá số ngày cho phép đặt trước (book_ahead_days).
    if (start > max) throw err.br("BR-05", `You can book at most ${ahead} days ahead.`);
  }
}

/** Whether this person already has a court overlapping that time. Back-to-back slots do not overlap; holds are left out because a new hold replaces the old one. */
export async function hasCourtOverlap(sql: Sql, userId: string, start: Date, end: Date, excludeId?: string) {
  // Tìm xem người dùng đã có đơn đặt sân nào ở trạng thái 'confirmed' hoặc 'in_use' giao nhau với khoảng thời gian [start, end) hay chưa (bỏ qua excludeId nếu đang đổi lịch).
  const clash = await one(
    sql,
    `select 1 from court_bookings
      where user_id = $1 and status in ('confirmed','in_use')
        and start_at < $3 and end_at > $2
        and ($4::uuid is null or id <> $4::uuid)
      limit 1`,
    [userId, start.toISOString(), end.toISOString(), excludeId ?? null],
  );
  return !!clash;
}

/** One person, one court at a time. The lock makes two taps at the same moment queue up. */
async function assertNoCourtOverlap(sql: Sql, userId: string, start: Date, end: Date, excludeId?: string) {
  // Khóa giao dịch theo userId (pg_advisory_xact_lock) để tuần tự hóa các yêu cầu đồng thời, ngăn chặn race condition khi người dùng nhấn đặt sân liên tiếp.
  await sql.query(`select pg_advisory_xact_lock(hashtext($1))`, [userId]);
  // Quy tắc BR-05: Một người dùng chỉ được phép đặt hoặc sử dụng một sân tại cùng một thời điểm.
  if (await hasCourtOverlap(sql, userId, start, end, excludeId)) {
    throw err.br("BR-05", "You already have a court at that time.");
  }
}

/**
 * Làm gì: Kiểm tra xem người dùng có buổi học lớp thể thao (class session) nào trùng thời gian với ca đặt sân hay không.
 * Được gọi ở: src/server/controllers/handlers/bookings.ts (các hàm bookingsHold, bookingsReschedule).
 * @param sql Đối tượng kết nối cơ sở dữ liệu Sql.
 * @param userId Mã UUID của người dùng cần kiểm tra.
 * @param start Thời điểm bắt đầu ca chơi (Date).
 * @param end Thời điểm kết thúc ca chơi (Date).
 * @returns Thông tin buổi học bị trùng (id, start_at, level, court_code) hoặc null nếu không trùng.
 */
async function overlapClass(sql: Sql, userId: string, start: Date, end: Date) {
  // Dùng toán tử giao nhau && giữa hai dải thời gian tstzrange để phát hiện buổi học đã xác nhận (confirmed) bị giao nhau với khung giờ đặt sân.
  return one(
    sql,
    `select s.id, s.start_at, cl.level, c.court_code
       from sessions s
       join classes cl on cl.id = s.class_id
       join enrollments e on e.class_id = cl.id and e.user_id = $1 and e.status = 'confirmed'
       join courts c on c.id = s.court_id
      where s.status = 'scheduled'
        and tstzrange(s.start_at, s.end_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
      limit 1`,
    [userId, start.toISOString(), end.toISOString()],
  );
}

/**
 * Làm gì: Lấy sơ đồ tình trạng chiếm sân (occupancy) của tất cả các sân trong một ngày cụ thể (mặc định là hôm nay).
 * Được gọi ở: GET /occupancy (src/server/controllers/router.ts), scripts/arena3-api-check.mjs.
 * @param sql Đối tượng kết nối cơ sở dữ liệu Sql.
 * @param request HTTP Request chứa query parameter date (định dạng YYYY-MM-DD).
 * @returns Phản hồi HTTP 200 kèm ngày tra cứu, danh sách sân đang hoạt động và các khoảng thời gian đã bị chiếm (đặt sân, lớp học, bảo trì).
 * @throws Lỗi 400 (VALIDATION) nếu định dạng tham số date không đúng YYYY-MM-DD.
 */
export async function occupancyGet(sql: Sql, request: Request) {
  // Bước 1: Trích xuất và kiểm tra tham số ngày từ URL query string (mặc định lấy ngày hôm nay theo giờ ICT).
  const date = new URL(request.url).searchParams.get("date") ?? ictDateString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw err.validation("date YYYY-MM-DD.");
  // Bước 2: Xác định mốc thời gian bắt đầu (00:00) và kết thúc (23:59:59) của ngày cần tra cứu.
  const start = ictDateTime(date, "00:00");
  const end = new Date(ictDateTime(date, "23:59").getTime() + 60_000);
  // Bước 3: Truy vấn toàn bộ các khoảng thời gian sân bị chiếm (đặt trước, lớp học, bảo trì) trong ngày từ view PLAYED_SQL.
  const rows = await sql.query<{
    court_id: string;
    start_at: string;
    end_at: string;
    kind: string;
    ref_id: string;
  }>(
    `select court_id, start_at, end_at, kind, ref_id from ${PLAYED_SQL} o
      where start_at < $2 and end_at > $1
      order by court_id, start_at`,
    [start.toISOString(), end.toISOString()],
  );
  // Bước 4: Lấy danh sách các sân thể thao đang hoạt động (chưa giải thể) sắp xếp theo thứ tự hiển thị và mã sân.
  const courts = await sql.query(
    `select id, court_code, sport, status, display_name, sort_order from courts where retired_at is null order by sort_order nulls last, court_code`,
  );
  // Bước 5: Cấu trúc dữ liệu và trả về cho client hiển thị lưới lịch sân.
  return {
    status: 200,
    body: {
      date,
      courts,
      slots: rows.map((r) => ({
        court_id: r.court_id,
        start: r.start_at,
        end: r.end_at,
        kind: r.kind,
        ref: r.ref_id,
      })),
    },
  };
}

/**
 * Which days still have a free slot (M-03).
 *
 * The court map answers one day at a time, so a member hunting for "any evening
 * this week" had to open seven of them. This answers the whole stretch in one
 * read: for each day, how many court-slots of the sport are still sellable
 * (ready courts, inside opening hours, not already taken, not in the past) out
 * of how many there are, and whether the day is inside the booking horizon.
 * Counts only — who holds what stays on the day view.
 */
export async function availabilityGet(sql: Sql, request: Request, user?: PublicUser | null) {
  // Bước 1: Đọc và xác thực các tham số truy vấn từ URL (from, days, sport).
  const params = new URL(request.url).searchParams;
  const today = ictDateString();
  const from = params.get("from") ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw err.field("from", "from must be YYYY-MM-DD.");
  // Mặc định kiểm tra 31 ngày (tối đa 62 ngày, tương đương 2 tháng).
  const days = Number(params.get("days") ?? 31);
  if (!Number.isInteger(days) || days < 1 || days > 62) throw err.field("days", "days must be 1 to 62.");
  const sport = params.get("sport");
  // Kiểm tra mã môn thể thao có hợp lệ và đang hoạt động trong hệ thống hay không.
  if (sport && !(await getActiveSportCodes(sql)).includes(sport)) {
    throw err.field("sport", "Unknown sport.");
  }
  // Không xét các ngày trong quá khứ; nếu ngày bắt đầu trước hôm nay thì tự động lấy từ hôm nay.
  const first = from < today ? today : from;
  // Bước 2: Tải cấu hình hệ thống và danh sách sân sẵn sàng hoạt động (status = 'ready') theo môn thể thao.
  const settings = await getSettings(sql);
  const courts = await sql.query<{ id: string }>(
    `select id from courts where status = 'ready' and retired_at is null and ($1::text is null or sport::text = $1) order by sort_order nulls last, court_code`,
    [sport],
  );
  // Bước 3: Xác định khoảng thời gian truy vấn và lấy toàn bộ dữ liệu chiếm sân (occupancies) trong khoảng này.
  const rangeStart = ictDateTime(first, "00:00");
  const rangeEnd = ictDateTime(addDays(first, days), "00:00");
  const occ = await sql.query<{ court_id: string; start_at: string; end_at: string }>(
    `select court_id, start_at, end_at from occupancies where start_at < $2 and end_at > $1`,
    [rangeStart.toISOString(), rangeEnd.toISOString()],
  );
  // Gom nhóm các khoảng thời gian bị chiếm theo từng sân để tối ưu tốc độ tra cứu khi quét từng slot.
  const byCourt = new Map<string, { s: number; e: number }[]>();
  for (const o of occ) {
    const list = byCourt.get(o.court_id) ?? [];
    list.push({ s: new Date(o.start_at).getTime(), e: new Date(o.end_at).getTime() });
    byCourt.set(o.court_id, list);
  }
  // Bước 4: Xác định thời điểm hiện tại và mốc chân trời tối đa được phép đặt trước (horizon).
  const now = Date.now();
  const horizon = now + settings.book_ahead_days * 86400000;
  const step = settings.slot_minutes * 60_000;
  // For a signed-in member, how many courts they already have each day.
  const mine = new Map<string, number>();
  // Nếu người dùng là hội viên, thống kê số lượng sân họ đã đặt trong từng ngày để hiển thị thông tin cá nhân.
  if (user?.role === "member") {
    const rows = await sql.query<{ d: string; n: number }>(
      `select (start_at at time zone 'Asia/Ho_Chi_Minh')::date::text as d, count(*)::int as n
         from court_bookings
        where user_id = $1 and status in ('confirmed','in_use') and start_at >= $2 and start_at < $3
        group by 1`,
      [user.id, rangeStart.toISOString(), rangeEnd.toISOString()],
    );
    for (const r of rows) mine.set(r.d, Number(r.n));
  }
  const out: { date: string; free: number; total: number; bookable: boolean; mine?: number }[] = [];
  // Bước 5: Duyệt qua từng ngày và từng khung giờ (slot) để đếm tổng số slot và số slot còn trống.
  for (let i = 0; i < days; i++) {
    const date = addDays(first, i);
    const open = ictDateTime(date, settings.open_time.slice(0, 5)).getTime();
    const close = ictDateTime(date, settings.close_time.slice(0, 5)).getTime();
    let total = 0;
    let free = 0;
    for (let t = open; t < close; t += step) {
      for (const c of courts) {
        total++;
        // Bỏ qua các slot đã qua trong quá khứ hoặc vượt quá số ngày được phép đặt trước.
        if (t < now || t > horizon) continue;
        // Kiểm tra khung giờ [t, t + step) có bị giao thoa với bất kỳ khoảng thời gian bị chiếm nào của sân c hay không.
        const taken = (byCourt.get(c.id) ?? []).some((o) => o.s < t + step && o.e > t);
        if (!taken) free++;
      }
    }
    // Tổng hợp số slot trống, tổng slot và cờ bookable (cho phép đặt nếu còn trong chân trời đặt trước) cho ngày i.
    out.push({
      date,
      free,
      total,
      bookable: Boolean(total) && date <= ictDateString(new Date(horizon)),
      ...(user?.role === "member" ? { mine: mine.get(date) ?? 0 } : {}),
    });
  }
  // Bước 6: Trả về kết quả tổng hợp tình trạng sẵn sàng của từng ngày cho client.
  return {
    status: 200,
    body: { from: first, sport: sport ?? null, days: out },
  };
}

/**
 * The member's own upcoming court bookings, each with whether it can still be
 * moved. The home screen only shows today's, which left no way to find a
 * booking next week in order to change it.
 */
export async function meBookings(sql: Sql, user: PublicUser): Promise<Reply<MeBookingsResponse>> {
  // Bước 1: Kiểm tra phân quyền, chỉ cho phép người dùng có vai trò hội viên (member) truy cập.
  requireRole(user, ["member"]);
  const settings = await getSettings(sql);
  // Bước 2: Truy vấn tối đa 50 lượt đặt sân sắp tới của hội viên (chưa kết thúc: end_at > now()).
  const rows = await sql.query<Omit<MyBooking, "can_move">>(
    `select b.id, b.code, b.status::text as status, b.start_at, b.end_at, b.price_vnd, b.paid_vnd, b.deposit_vnd, b.series_id, b.quota_hours,
            b.court_id, c.court_code, c.sport::text as sport
       from court_bookings b join courts c on c.id = b.court_id
      where b.user_id = $1 and b.status in ('hold','confirmed','in_use') and b.end_at > now()
      order by b.start_at
      limit 50`,
    [user.id],
  );
  // The classes the member is enrolled in run on courts too: their coming sessions sit beside the
  // courts they booked, so the member sees one schedule rather than half of it.
  // Bước 3: Lấy các buổi học thể thao mà hội viên đã đăng ký tham gia (diễn ra trên sân và sắp tới).
  const class_sessions = await sql.query<MyClassSession>(
    `select s.id, s.class_id, s.start_at, s.end_at, cl.sport::text as sport, cl.level, c.court_code,
            u.full_name as coach_name
       from sessions s
       join classes cl on cl.id = s.class_id
       join enrollments e on e.class_id = cl.id and e.user_id = $1 and e.status = 'confirmed'
       join courts c on c.id = s.court_id
       join users u on u.id = cl.coach_id
      where s.status = 'scheduled' and s.end_at > now()
      order by s.start_at
      limit 50`,
    [user.id],
  );
  const now = Date.now();
  // Bước 4: Trả về danh sách đặt sân kèm thuộc tính can_move (chỉ cho phép đổi lịch nếu còn cách giờ chơi ít nhất cancel_court_hours).
  return {
    status: 200,
    body: {
      window_hours: settings.cancel_court_hours,
      cancel_tiers: [],
      class_sessions,
      items: rows.map((r) => ({
        ...r,
        can_move:
          r.status === "confirmed" &&
          (new Date(r.start_at).getTime() - now) / 3600000 >= settings.cancel_court_hours,
      })),
    },
  };
}

/**
 * Làm gì: Cấu trúc tham số trích xuất từ query string khi xem chi tiết một ô chiếm sân (kind: loại ô, ref: mã tham chiếu).
 * Được gọi ở: src/server/controllers/handlers/bookings.ts (hàm readOccupancyDetailParams).
 */
type OccupancyDetailParams = {
  kind: string;
  ref: string;
};

/**
 * Làm gì: Cấu trúc dữ liệu dòng truy vấn từ bảng court_bookings kết hợp bảng courts và users để lấy chi tiết đơn đặt sân.
 * Được gọi ở: src/server/controllers/handlers/bookings.ts (hàm queryOccupancyDetailBooking).
 */
type OccupancyDetailBookingRow = {
  id: string;
  code: string;
  status: string;
  channel: string;
  start_at: string;
  end_at: string;
  price_vnd: number;
  discount_pct: number;
  hold_until: string | null;
  transfer_requested_at: string | null;
  court_code: string;
  sport: string;
  user_id: string | null;
  member_name: string | null;
  member_code: string | null;
  member_phone: string | null;
  guest_name: string | null;
  guest_phone: string | null;
};

/**
 * Làm gì: Định nghĩa kiểu dữ liệu thông tin khách hàng chuẩn hóa, phân biệt giữa hội viên (member) và khách vãng lai (guest).
 * Được gọi ở: src/server/controllers/handlers/bookings.ts (hàm formatOccupancyDetailCustomer).
 */
type OccupancyDetailCustomer =
  | {
      type: "member";
      id: string;
      name: string | null;
      phone: string | null;
      member_code: string | null;
    }
  | {
      type: "guest";
      id: null;
      name: string | null;
      phone: string | null;
      member_code: null;
    };

/**
 * Làm gì: Cấu trúc dữ liệu chi tiết buổi học lớp thể thao diễn ra trên sân, kết hợp thông tin lớp, huấn luyện viên và số học viên.
 * Được gọi ở: src/server/controllers/handlers/bookings.ts (hàm queryOccupancyDetailSession).
 */
type OccupancyDetailSessionRow = {
  id: string;
  class_id: string;
  start_at: string;
  end_at: string;
  status: string;
  court_code: string;
  sport: string;
  level: string;
  capacity: number;
  enrolled_count: number;
  coach_name: string;
};

/**
 * Làm gì: Cấu trúc dữ liệu lịch bảo dưỡng hoặc sửa chữa sân thể thao lấy từ bảng occupancies.
 * Được gọi ở: src/server/controllers/handlers/bookings.ts (hàm queryOccupancyDetailMaintenance).
 */
type OccupancyDetailMaintenanceRow = {
  reason: string | null;
  court_code: string;
  start_at: string;
  end_at: string;
};

/**
 * Làm gì: trích xuất hai tham số kind (loại ô) và ref (mã định danh tham chiếu) từ query string của request.
 *   Nếu tham số không được truyền thì mặc định gán là chuỗi rỗng để kiểm tra ở bước kế tiếp.
 * Được gọi ở: occupancyDetail, bước 2.
 * @param request Request HTTP GET gửi từ trình duyệt lên server.
 * @returns Đối tượng OccupancyDetailParams chứa kind và ref dạng chuỗi.
 */
function readOccupancyDetailParams(request: Request): OccupancyDetailParams {
  const searchParameters = new URL(request.url).searchParams;
  const kind = searchParameters.get("kind") ?? "";
  const ref = searchParameters.get("ref") ?? "";

  return { kind, ref };
}

/**
 * Làm gì: kiểm tra mã tham chiếu ref có đúng định dạng chuỗi UUID 36 ký tự hay không.
 *   Vì sao: ngăn chặn các giá trị rác hoặc sai cấu trúc trước khi gửi truy vấn vào cơ sở dữ liệu.
 * Được gọi ở: occupancyDetail, bước 3.
 * @param referenceId Chuỗi mã tham chiếu lấy từ params.ref của query string.
 * @throws Lỗi 400 (FIELD) gắn vào ô "ref" với thông báo "ref must be an id." nếu referenceId
 *   không khớp biểu thức chính quy /^[0-9a-f-]{36}$/i.
 */
function checkOccupancyDetailRef(referenceId: string): void {
  const isUuidFormat = /^[0-9a-f-]{36}$/i.test(referenceId);
  if (!isUuidFormat) {
    throw err.field("ref", "ref must be an id.");
  }
}

/**
 * Làm gì: truy vấn thông tin chi tiết một lượt đặt sân từ bảng court_bookings, kết hợp với bảng
 *   courts để lấy mã sân, môn thể thao, và bảng users để lấy thông tin hội viên (nếu có).
 *   Vì sao: cung cấp đầy đủ thông tin về giờ chơi, giá tiền, kênh đặt và người đặt cho lễ tân.
 * Được gọi ở: fetchOccupancyDetailBooking, bước 1.
 * @param sql Kết nối database dùng để truy vấn.
 * @param bookingId Mã UUID của lượt đặt sân cần tra cứu, lấy từ ref.
 * @returns Dòng dữ liệu OccupancyDetailBookingRow chứa đầy đủ thông tin đặt sân.
 * @throws Lỗi 404 (NOT_FOUND) với thông báo "No such booking." nếu không tìm thấy bản ghi tương ứng.
 */
async function queryOccupancyDetailBooking(
  sql: Sql,
  bookingId: string,
): Promise<OccupancyDetailBookingRow> {
  const booking = await one<OccupancyDetailBookingRow>(
    sql,
    `select b.id, b.code, b.status::text as status, b.channel, b.start_at, b.end_at, b.price_vnd,
              b.discount_pct, b.hold_until, b.transfer_requested_at,
              c.court_code, c.sport::text as sport,
              b.user_id, u.full_name as member_name, u.member_code, u.phone as member_phone,
              b.guest_name, b.guest_phone
         from court_bookings b
         join courts c on c.id = b.court_id
         left join users u on u.id = b.user_id
        where b.id = $1`,
    [bookingId],
  );

  if (!booking) {
    throw err.notFound("No such booking.");
  }

  return booking;
}

/**
 * Làm gì: tính tổng số tiền khách đã thanh toán cho lượt đặt sân từ bảng payments.
 *   Chỉ tính các giao dịch có trạng thái 'posted' (đã thu thành công) hoặc 'refund_pending' (chờ hoàn tiền).
 *   Vì sao: lễ tân tại quầy cần biết số tiền thực thu để đối soát và xử lý nhận sân cho khách.
 * Được gọi ở: fetchOccupancyDetailBooking, bước 2.
 * @param sql Kết nối database dùng để truy vấn.
 * @param bookingId Mã UUID của lượt đặt sân, lấy từ booking.id.
 * @returns Tổng số tiền VND đã thanh toán (số nguyên, mặc định 0 nếu chưa thanh toán khoản nào).
 */
async function queryOccupancyDetailBookingPaid(
  sql: Sql,
  bookingId: string,
): Promise<number> {
  const paid = await one<{ paid_vnd: number }>(
    sql,
    `select coalesce(sum(amount_vnd) filter (where status in ('posted','refund_pending')), 0)::int as paid_vnd
         from payments where ref_type = 'booking' and ref_id = $1`,
    [bookingId],
  );

  return paid?.paid_vnd ?? 0;
}

/**
 * Làm gì: chuẩn hóa thông tin người đặt sân thành một đối tượng khách hàng thống nhất.
 *   Nếu lượt đặt có user_id thì là hội viên (type: "member" kèm mã hội viên và tên),
 *   ngược lại là khách vãng lai (type: "guest" kèm tên và số điện thoại vãng lai lúc đặt sân).
 *   Vì sao: giao diện lễ tân hiển thị khác nhau giữa hội viên đã đăng ký và khách lẻ bên ngoài.
 * Được gọi ở: fetchOccupancyDetailBooking, bước 3.
 * @param booking Dòng dữ liệu lượt đặt sân vừa truy vấn được từ cơ sở dữ liệu.
 * @returns Đối tượng OccupancyDetailCustomer chuẩn hóa theo kiểu member hoặc guest.
 */
function formatOccupancyDetailCustomer(
  booking: OccupancyDetailBookingRow,
): OccupancyDetailCustomer {
  const hasMemberAccount = Boolean(booking.user_id);
  if (hasMemberAccount && booking.user_id) {
    return {
      type: "member",
      id: booking.user_id,
      name: booking.member_name,
      phone: booking.member_phone,
      member_code: booking.member_code,
    };
  }

  return {
    type: "guest",
    id: null,
    name: booking.guest_name,
    phone: booking.guest_phone,
    member_code: null,
  };
}

/**
 * Làm gì: thu thập và cấu trúc toàn bộ dữ liệu chi tiết cho ô đặt sân hoặc giữ chỗ (booking hoặc hold),
 *   bao gồm thông tin đặt sân, số tiền đã trả, trạng thái chờ chuyển khoản và thông tin khách hàng.
 * Được gọi ở: fetchOccupancyDetailByKind, khi kind là "booking" hoặc "hold".
 * @param sql Kết nối database dùng để truy vấn.
 * @param referenceId Mã UUID của lượt đặt sân, lấy từ params.ref.
 * @returns Phản hồi HTTP { status: 200, body: ... } với cấu trúc dữ liệu loại booking.
 * @throws Lỗi 404 (NOT_FOUND) "No such booking." nếu không tìm thấy lượt đặt sân trong database.
 */
async function fetchOccupancyDetailBooking(
  sql: Sql,
  referenceId: string,
) {
  // Bước 1: truy vấn dữ liệu lượt đặt sân cùng thông tin sân và hội viên.
  const booking = await queryOccupancyDetailBooking(sql, referenceId);

  // Bước 2: tra cứu tổng số tiền thực tế khách đã thanh toán cho lượt đặt này.
  const paidAmountVnd = await queryOccupancyDetailBookingPaid(sql, booking.id);

  // Bước 3: chuẩn hóa dữ liệu khách hàng (phân biệt giữa hội viên và khách vãng lai).
  const customer = formatOccupancyDetailCustomer(booking);

  // Ô đang giữ chỗ và đã có yêu cầu chuyển tiền thì đánh dấu đang chờ chuyển khoản.
  const isAwaitingTransfer =
    Boolean(booking.transfer_requested_at) && booking.status === "hold";

  return {
    status: 200,
    body: {
      kind: "booking",
      booking: {
        id: booking.id,
        code: booking.code,
        status: booking.status,
        channel: booking.channel,
        start_at: booking.start_at,
        end_at: booking.end_at,
        price_vnd: booking.price_vnd,
        discount_pct: booking.discount_pct,
        paid_vnd: paidAmountVnd,
        hold_until: booking.hold_until,
        awaiting_transfer: isAwaitingTransfer,
        court_code: booking.court_code,
        sport: booking.sport,
      },
      customer,
    },
  };
}

/**
 * Làm gì: truy vấn và trả về chi tiết buổi học lớp thể thao từ bảng sessions, kết hợp với bảng
 *   lớp học classes, bảng sân courts và bảng người dùng users (huấn luyện viên đứng lớp).
 *   Vì sao: lễ tân cần biết môn học, trình độ, sĩ số và giáo viên đang đứng lớp tại ô giờ đó.
 * Được gọi ở: fetchOccupancyDetailByKind, khi kind là "session".
 * @param sql Kết nối database dùng để truy vấn.
 * @param referenceId Mã UUID của buổi học, lấy từ params.ref.
 * @returns Phản hồi HTTP { status: 200, body: ... } với cấu trúc dữ liệu loại session.
 * @throws Lỗi 404 (NOT_FOUND) với thông báo "No such session." nếu không tìm thấy buổi học.
 */
async function fetchOccupancyDetailSession(
  sql: Sql,
  referenceId: string,
) {
  const session = await one<OccupancyDetailSessionRow>(
    sql,
    `select s.id, s.class_id, s.start_at, s.end_at, s.status::text as status,
              c.court_code, cl.sport::text as sport, cl.level, cl.capacity, cl.enrolled_count,
              co.full_name as coach_name
         from sessions s
         join classes cl on cl.id = s.class_id
         join courts c on c.id = s.court_id
         join users co on co.id = cl.coach_id
        where s.id = $1`,
    [referenceId],
  );

  if (!session) {
    throw err.notFound("No such session.");
  }

  return {
    status: 200,
    body: {
      kind: "session",
      session,
    },
  };
}

/**
 * Làm gì: truy vấn và trả về chi tiết lịch bảo trì hoặc sửa chữa sân từ bảng occupancies
 *   (loại 'maintenance'), kết hợp với bảng courts để lấy mã sân.
 *   Vì sao: lễ tân cần biết lý do và khoảng thời gian sân tạm ngừng phục vụ khi khách hỏi tại quầy.
 * Được gọi ở: fetchOccupancyDetailByKind, khi kind là "maintenance".
 * @param sql Kết nối database dùng để truy vấn.
 * @param referenceId Mã tham chiếu bảo trì (ref_id trong bảng occupancies, lấy từ params.ref).
 * @returns Phản hồi HTTP { status: 200, body: ... } với cấu trúc dữ liệu loại maintenance.
 * @throws Lỗi 404 (NOT_FOUND) nếu không tìm thấy bản ghi bảo trì tương ứng trong database.
 */
async function fetchOccupancyDetailMaintenance(
  sql: Sql,
  referenceId: string,
) {
  const maintenance = await one<OccupancyDetailMaintenanceRow>(
    sql,
    `select o.reason, c.court_code, o.start_at, o.end_at
         from occupancies o join courts c on c.id = o.court_id
        where o.kind = 'maintenance' and o.ref_id = $1 limit 1`,
    [referenceId],
  );

  if (!maintenance) {
    throw err.notFound();
  }

  return {
    status: 200,
    body: {
      kind: "maintenance",
      maintenance,
    },
  };
}

/**
 * Làm gì: điều hướng lấy dữ liệu chi tiết tùy theo loại ô chiếm sân: đặt sân hoặc giữ chỗ (booking/hold),
 *   buổi học (session), hoặc bảo trì (maintenance). Báo lỗi nếu loại ô không hợp lệ.
 * Được gọi ở: occupancyDetail, bước 4.
 * @param sql Kết nối database dùng để truy vấn.
 * @param kind Loại ô chiếm sân lấy từ query string ("booking", "hold", "session", "maintenance").
 * @param referenceId Mã UUID tham chiếu đã qua kiểm tra định dạng.
 * @returns Phản hồi HTTP { status: 200, body: ... } tương ứng với loại chiếm sân.
 * @throws Lỗi 400 (FIELD) gắn vào ô "kind" với thông báo "kind must be booking, hold, session or maintenance."
 *   nếu kind không thuộc các loại được hỗ trợ.
 * @throws Lỗi 404 (NOT_FOUND) nếu không tìm thấy bản ghi tương ứng trong database.
 */
async function fetchOccupancyDetailByKind(
  sql: Sql,
  kind: string,
  referenceId: string,
) {
  const isBookingOrHold = kind === "booking" || kind === "hold";
  if (isBookingOrHold) {
    return fetchOccupancyDetailBooking(sql, referenceId);
  }

  const isSession = kind === "session";
  if (isSession) {
    return fetchOccupancyDetailSession(sql, referenceId);
  }

  const isMaintenance = kind === "maintenance";
  if (isMaintenance) {
    return fetchOccupancyDetailMaintenance(sql, referenceId);
  }

  throw err.field("kind", "kind must be booking, hold, session or maintenance.");
}

/**
 * What is behind a taken cell on the court map (B-07).
 *
 * The grid only knows that an hour is occupied. At the counter the next
 * question is always "whose is it, what did they pay, and is it confirmed?", so
 * this answers it for the occupancy the desk clicked: a booking or hold (member
 * or walk-in, code, time, amount, status), a class session, or the reason a
 * court was taken out of service. Reception and the manager only — members see
 * that an hour is taken, never by whom.
 *
 * Làm gì: xem thông tin chi tiết đằng sau một ô đã bị chiếm trên bản đồ lịch sân (B-07).
 *   Lưới sân chỉ hiển thị ô giờ đó đang bận; nhân viên tại quầy luôn cần biết ô đó thuộc về ai,
 *   đã thanh toán bao nhiêu tiền và đã xác nhận hay chưa.
 *   Hàm này trả về thông tin chi tiết của ô được nhấp chọn: một lượt đặt sân hoặc giữ chỗ
 *   (hội viên hay khách vãng lai, mã đặt sân, khung giờ, tiền sân, trạng thái, đã trả bao nhiêu),
 *   một buổi học thể thao (môn học, trình độ, huấn luyện viên, số học viên), hoặc lý do sân
 *   phải tạm dừng hoạt động để bảo trì.
 *   Vì sao: chỉ lễ tân (receptionist) và quản lý (manager) mới được phép xem; hội viên chỉ thấy
 *   ô giờ đó đã có người chiếm chứ không bao giờ thấy ai là người đặt để bảo vệ quyền riêng tư.
 * Được gọi ở:
 *   - Màn hình Lịch sân tại quầy /desk/courts (src/routes/desk.courts.tsx), khi nhân viên nhấp
 *     chọn một ô đã bị chiếm trên bản đồ sân (sự kiện onInspect mở modal OccupancyDetailModal).
 *   - Modal OccupancyDetailModal (src/client/components/class-detail.tsx) gửi yêu cầu
 *     GET /v1/occupancy/detail?kind={kind}&ref={ref}.
 *   - src/server/controllers/router.ts nhận đường dẫn GET /occupancy/detail và gọi hàm này
 *     qua authedRead((sql, user) => bookH.occupancyDetail(sql, request, user)): authedRead
 *     kiểm tra đăng nhập và cấp kết nối database chỉ đọc.
 * @param sql Kết nối database do router cung cấp qua authedRead.
 * @param request Request HTTP GET /v1/occupancy/detail chứa các tham số kind và ref trên query string.
 * @param user Người dùng đang đăng nhập; phải có vai trò receptionist hoặc manager.
 * @returns { status: 200, body: ... } chứa chi tiết theo kind ("booking", "session", hoặc "maintenance").
 * @throws Lỗi 403 (FORBIDDEN) nếu người dùng không có vai trò receptionist hoặc manager.
 * @throws Lỗi 400 (FIELD) ở trường "ref" nếu ref không đúng định dạng ID 36 ký tự.
 * @throws Lỗi 404 (NOT_FOUND) nếu không tìm thấy thông tin đặt sân ("No such booking."),
 *   buổi học ("No such session."), hoặc lịch bảo trì tương ứng.
 * @throws Lỗi 400 (FIELD) ở trường "kind" nếu kind không thuộc: booking, hold, session, maintenance.
 */
export async function occupancyDetail(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: chỉ lễ tân hoặc quản lý mới có quyền xem thông tin chi tiết ô chiếm sân.
  requireRole(user, ["receptionist", "manager"]);

  // Bước 2: trích xuất các tham số kind và ref từ query string của request.
  const params = readOccupancyDetailParams(request);

  // Bước 3: kiểm tra mã tham chiếu ref phải đúng định dạng định danh 36 ký tự.
  checkOccupancyDetailRef(params.ref);

  // Bước 4: lấy dữ liệu chi tiết tương ứng với loại ô chiếm sân (đặt sân, lớp học, bảo trì).
  return fetchOccupancyDetailByKind(sql, params.kind, params.ref);
}

/**
 * Làm gì: Lấy danh sách toàn bộ các sân thể thao đang hoạt động (chưa ngưng sử dụng - retired_at is null), sắp xếp theo thứ tự hiển thị và mã sân.
 * Được gọi ở:
 *   - Route GET /courts (src/server/controllers/router.ts, dòng 177).
 *   - Được sử dụng bởi các trang lễ tân và quản lý: /desk/maintenance, /desk/series, /manager/classes, /manager/prices (qua hook useRead("/courts")).
 * @param sql Kết nối cơ sở dữ liệu.
 * @returns Phản hồi HTTP { status: 200, body: { items } } chứa danh sách các sân (id, court_code, sport, status, display_name, sort_order, retired_at).
 */
export async function courtsList(sql: Sql) {
  // Bước 1: Truy vấn danh sách các sân còn hoạt động (chưa ngưng sử dụng - retired_at is null), sắp xếp theo thứ tự hiển thị rồi đến mã sân.
  const items = await sql.query(
    `select id, court_code, sport, status, display_name, sort_order, retired_at
       from courts
      where retired_at is null
      order by sort_order nulls last, court_code`,
  );
  // Bước 2: Trả về kết quả HTTP 200 kèm danh sách sân phục vụ hiển thị trên giao diện.
  return { status: 200, body: { items } };
}

/**
 * Danh sách các trạng thái hoạt động hợp lệ của sân thể thao:
 * - ready: Sẵn sàng phục vụ cho việc đặt sân và mở lớp học.
 * - maintenance: Tạm ngưng hoạt động để bảo dưỡng hoặc sửa chữa.
 * - closed: Đóng cửa, không nhận khách.
 */
const COURT_STATUSES = ["ready", "maintenance", "closed"] as const;

/**
 * Take a court out of service, put it back, or update court metadata.
 */
/**
 * Làm gì: Cập nhật trạng thái hoạt động hoặc các thông tin cấu hình (mã sân, tên hiển thị, môn thể thao, thứ tự hiển thị) của sân.
 *   Điều phối logic: nếu chỉ đổi trạng thái (status) thì gọi patchCourtStatus, nếu có thay đổi metadata khác thì gọi patchCourtMetadata.
 * Được gọi ở:
 *   - Route PATCH /courts/:id và PATCH /manager/courts/:id trong src/server/controllers/router.ts (dòng 307 và dòng 819).
 *   - Màn hình Quản lý sân /manager/courts (src/client/lib/pages/manager.courts.ts qua handleStatusChange và handleEditSubmit).
 * @param sql Kết nối cơ sở dữ liệu Postgres.
 * @param id Mã UUID của sân cần cập nhật.
 * @param request HTTP request chứa body JSON với các trường cần cập nhật (status, court_code, display_name, sort_order, sport, reason).
 * @param user Người dùng đang thực hiện yêu cầu; bắt buộc phải có vai trò manager.
 * @returns Phản hồi HTTP { status: 200, body: { court, upcoming } } chứa thông tin sân sau khi cập nhật và số lượt chiếm sân trong tương lai.
 * @throws 403 (FORBIDDEN) nếu người dùng không có vai trò manager.
 * @throws 404 (NOT_FOUND) nếu không tìm thấy sân theo id tương ứng.
 * @throws 400 (VALIDATION/FIELD) nếu trạng thái hoặc thông tin sân không hợp lệ.
 * @throws 409 (CONFLICT_STATE/CONFLICT_SLOT) nếu đóng sân khả dụng cuối cùng của môn có lớp học, hoặc đổi môn khi có lịch tương lai, hoặc trùng mã sân.
 */
export async function courtsPatch(sql: Sql, id: string, request: Request, user: PublicUser) {
  // Bước 1: Xác thực quyền hạn — chỉ người dùng có vai trò quản lý (manager) mới được phép chỉnh sửa sân.
  requireRole(user, ["manager"]);
  // Bước 2: Đọc dữ liệu payload JSON từ request và lấy thông tin hiện tại của sân từ database.
  const b = await readJson(request);
  const cur = await courtById(sql, id);

  const status = str(b.status);

  // Bước 3: Kiểm tra xem payload có chứa các trường metadata mở rộng (mã sân, tên hiển thị, thứ tự, môn) hay không.
  const hasExtraFields =
    b.court_code !== undefined ||
    b.display_name !== undefined ||
    b.sort_order !== undefined ||
    b.sport !== undefined;

  // Preserve exact original behavior if only status is being patched (or no extra fields)
  // Bước 4: Điều hướng xử lý — nếu chỉ sửa trạng thái thì gọi patchCourtStatus, ngược lại gọi patchCourtMetadata.
  if (!hasExtraFields) return patchCourtStatus(sql, id, user, b, cur, status);
  return patchCourtMetadata(sql, id, user, b, cur, status);
}

/**
 * Làm gì: Cập nhật trạng thái vận hành của sân (ready, maintenance, closed).
 *   Nếu đóng sân (closed), kiểm tra nghiệp vụ chặn không cho đóng sân cuối cùng của một môn thể thao nếu môn đó đang có lớp học mở (open).
 *   Ghi nhận nhật ký kiểm toán (audit log) và đếm số lượng lịch chiếm sân sắp tới bị ảnh hưởng.
 * Được gọi ở: courtsPatch, dòng 713.
 * @param sql Kết nối cơ sở dữ liệu.
 * @param id Mã UUID của sân cần đổi trạng thái.
 * @param user Người dùng thực hiện thao tác (quản lý).
 * @param b Dữ liệu request body chứa lý do thay đổi trạng thái (reason) nếu có.
 * @param cur Bản ghi thông tin sân hiện tại trước khi cập nhật.
 * @param status Trạng thái mới cần chuyển đổi ("ready", "maintenance", "closed").
 * @returns Phản hồi HTTP { status: 200, body: { court, upcoming } } chứa thông tin sân sau khi cập nhật và số lịch chiếm sân trong tương lai.
 * @throws 400 (VALIDATION) nếu trạng thái không hợp lệ (không thuộc ready, maintenance, closed).
 * @throws 409 (CONFLICT_STATE) nếu đóng sân khả dụng cuối cùng của môn thể thao đang có lớp học hoạt động.
 */
async function patchCourtStatus(sql: Sql, id: string, user: PublicUser, b: Record<string, unknown>, cur: Awaited<ReturnType<typeof courtById>>, status: string | undefined) {
  // Bước 1: Xác thực trạng thái mới phải thuộc danh sách hợp lệ (ready, maintenance, closed).
  if (!status || !(COURT_STATUSES as readonly string[]).includes(status)) {
    throw err.validation(`status must be one of ${COURT_STATUSES.join(", ")}.`);
  }
  // Nếu trạng thái mới trùng với trạng thái hiện tại, trả về ngay kết quả mà không cần ghi DB hay ghi audit.
  if (cur.status === status) return { status: 200, body: { court: cur, upcoming: 0 } };

  // Bước 2: Kiểm tra quy tắc nghiệp vụ khi chuyển sang trạng thái đóng sân (closed):
  // Không được phép đóng sân khả dụng cuối cùng của một môn thể thao nếu môn đó vẫn còn lớp học đang mở hoạt động.
  if (status === "closed" && cur.status !== "closed") {
    // Đếm số lượng sân khác cùng môn thể thao vẫn đang mở (chưa bị đóng và chưa ngừng hoạt động).
    const remaining = await one<{ cnt: number }>(
      sql,
      `select count(*)::int as cnt from courts where sport = $1 and retired_at is null and status <> 'closed' and id <> $2`,
      [cur.sport, id],
    );
    if (!remaining || remaining.cnt === 0) {
      // Nếu không còn sân nào khác mở, kiểm tra xem có lớp học nào của môn này đang mở tuyển sinh/hoạt động không.
      const activeClasses = await one<{ cnt: number }>(
        sql,
        `select count(*)::int as cnt from classes where sport = $1 and status = 'open'`,
        [cur.sport],
      );
      if ((activeClasses?.cnt ?? 0) > 0) {
        // Báo lỗi 409 CONFLICT_STATE để ngăn chặn đóng sân, đảm bảo lớp học có sân tổ chức.
        throw new ApiError(
          409,
          "CONFLICT_STATE",
          "Cannot close the last available court for a sport with active classes.",
        );
      }
    }
  }

  // Bước 3: Lấy lý do thay đổi trạng thái (nếu có) và cập nhật trạng thái mới của sân vào bảng courts.
  // Taking an open court out of service frees what was on it, exactly as a blocking work order does:
  // bookings are cancelled with a full refund, and coach, managers and students hear about the sessions.
  // Without confirm the manager first gets the list of what would be affected (409, requires_confirm).
  if (cur.status === "ready" && status !== "ready") {
    await blockCourtCommitments(sql, id, b.confirm === true, user);
  }
  const reason = str(b.reason) ?? null;
  await sql.query(`update courts set status = $2 where id = $1`, [id, status]);
  // Bước 4: Đếm số lượng lịch chiếm sân (occupancies) trong tương lai bị ảnh hưởng bởi việc đổi trạng thái này.
  const live = await one<{ n: number }>(
    sql,
    `select count(*)::int as n from occupancies where court_id = $1 and end_at > now()`,
    [id],
  );
  // Bước 5: Ghi nhật ký kiểm toán (audit log) lưu vết thay đổi trạng thái kèm lý do phục vụ đối soát quản trị.
  await audit(sql, user.id, "patch_court", "court", id, { from: cur.status, to: status, reason });
  // Bước 6: Truy vấn lại thông tin mới nhất của sân từ cơ sở dữ liệu và trả về kết quả.
  const court = await one(
    sql,
    `select id, court_code, sport, status, display_name, sort_order, retired_at from courts where id = $1`,
    [id],
  );
  return { status: 200, body: { court, upcoming: live?.n ?? 0 } };
}

/**
 * Làm gì: Kiểm tra và xác thực môn thể thao mới khi cập nhật sân.
 *   Xác minh môn thể thao có nằm trong danh mục đang hoạt động (active sports) hay không.
 *   Nếu đổi sang môn khác, kiểm tra xem sân có lịch đặt chỗ (court_bookings) hoặc lịch chiếm sân (occupancies) nào trong tương lai không;
 *   nếu có thì chặn không cho đổi môn để tránh xung đột lịch và thiết bị sân bãi.
 * Được gọi ở: patchCourtMetadata, dòng 823.
 * @param sql Kết nối cơ sở dữ liệu.
 * @param id Mã UUID của sân cần cập nhật môn thể thao.
 * @param b Dữ liệu request body chứa trường sport (nếu có).
 * @param cur Bản ghi thông tin sân hiện tại trước khi cập nhật.
 * @returns Mã môn thể thao tiếp theo của sân (môn mới nếu hợp lệ hoặc giữ nguyên môn cũ).
 * @throws 400 (FIELD) nếu mã môn thể thao không tồn tại hoặc không đang hoạt động trong hệ thống.
 * @throws 409 (CONFLICT_STATE) nếu sân còn lịch đặt chỗ hoặc lớp học chưa kết thúc trong tương lai.
 */
async function courtSportForPatch(sql: Sql, id: string, b: Record<string, unknown>, cur: Awaited<ReturnType<typeof courtById>>) {
  // Mặc định giữ nguyên môn thể thao hiện tại của sân nếu request không yêu cầu thay đổi.
  let nextSport = cur.sport;
  // Bước 1: Nếu request có truyền trường môn thể thao (sport), kiểm tra tính hợp lệ trong danh mục môn thể thao đang hoạt động.
  if (b.sport !== undefined) {
    const s = str(b.sport);
    const valid = await getActiveSportCodes(sql);
    if (!s || !valid.includes(s)) {
      throw err.field("sport", "Unknown sport.");
    }
    // Bước 2: Nếu môn thể thao thực sự thay đổi, kiểm tra xem sân có lịch đặt hoặc lịch chiếm sắp tới (end_at > now()) hay không.
    if (s !== cur.sport) {
      const futureOccupancies = await one<{ cnt: number }>(
        sql,
        `select count(*)::int as cnt from (
           select 1 from occupancies where court_id = $1 and end_at > now()
           union all
           select 1 from court_bookings where court_id = $1 and end_at > now() and status::text in ('hold', 'confirmed', 'in_use', 'paid')
         ) t`,
        [id],
      );
      // Chặn thay đổi môn thể thao (409 CONFLICT_STATE) khi sân đang có lịch đặt chỗ hoặc lớp học chưa diễn ra để bảo đảm tính toàn vẹn dữ liệu.
      if (futureOccupancies && futureOccupancies.cnt > 0) {
        throw new ApiError(
          409,
          "CONFLICT_STATE",
          "Cannot change court sport while it has upcoming bookings or classes.",
          { affected: futureOccupancies.cnt },
        );
      }
      nextSport = s;
    }
  }

  return nextSport;
}

/**
 * Làm gì: Kiểm tra tính hợp lệ và chuẩn hóa toàn bộ các trường metadata của sân (trạng thái, mã sân, môn thể thao, tên hiển thị, thứ tự sắp xếp)
 *   trước khi lưu vào cơ sở dữ liệu. Đảm bảo mã sân đúng định dạng (2 chữ cái in hoa, dấu gạch nối, 2-3 chữ số) và không bị trùng lặp.
 * Được gọi ở: courtsPatch, dòng 714.
 * @param sql Kết nối cơ sở dữ liệu.
 * @param id Mã UUID của sân cần cập nhật.
 * @param user Người dùng thực hiện thao tác (quản lý).
 * @param b Dữ liệu request body chứa các trường metadata cần cập nhật.
 * @param cur Dữ liệu hiện tại của sân từ database.
 * @param status Trạng thái mới của sân nếu có (chuỗi đã được parse qua str(b.status)).
 * @returns Phản hồi HTTP { status: 200, body: { court, upcoming } } thông qua saveCourtMetadata.
 * @throws 400 (VALIDATION) nếu trạng thái sân không hợp lệ.
 * @throws 400 (FIELD) nếu mã sân không đúng định dạng hoặc tên hiển thị vượt quá 40 ký tự.
 * @throws 409 (CONFLICT_SLOT) nếu mã sân mới bị trùng với một sân khác đã tồn tại trong hệ thống.
 * @throws 409 (CONFLICT_STATE) nếu đổi môn thể thao khi sân đang có lịch đặt sắp tới.
 */
async function patchCourtMetadata(sql: Sql, id: string, user: PublicUser, b: Record<string, unknown>, cur: Awaited<ReturnType<typeof courtById>>, status: string | undefined) {
  // Bước 1: Kiểm tra tính hợp lệ của trạng thái sân nếu được gửi lên trong payload.
  if (b.status !== undefined) {
    if (!status || !(COURT_STATUSES as readonly string[]).includes(status)) {
      throw err.validation(`status must be one of ${COURT_STATUSES.join(", ")}.`);
    }
  }

  // Bước 2: Xác thực và chuẩn hóa mã sân mới (court_code):
  // Phải viết hoa, độ dài tối đa 8 ký tự, khớp định dạng regex ^[A-Z]{2}-\d{2,3}$ và không được trùng với sân khác.
  let nextCourtCode = cur.court_code;
  if (b.court_code !== undefined) {
    const rawCode = str(b.court_code)?.trim().toUpperCase() || "";
    if (rawCode.length > 8 || !/^[A-Z]{2}-\d{2,3}$/.test(rawCode)) {
      throw err.field(
        "court_code",
        "Court code must match format like CL-01 or BR-12 (2 capital letters, dash, 2-3 digits).",
      );
    }
    // Kiểm tra xem mã sân mới có bị trùng với bất kỳ sân nào khác trong cơ sở dữ liệu hay không.
    if (rawCode !== cur.court_code) {
      const dup = await one(
        sql,
        `select 1 from courts where lower(court_code) = lower($1) and id <> $2`,
        [rawCode, id],
      );
      if (dup) {
        throw err.conflictSlot("That court code is already in use.");
      }
      nextCourtCode = rawCode;
    }
  }

  // Bước 3: Xác thực môn thể thao mới qua hàm courtSportForPatch.
  const nextSport = await courtSportForPatch(sql, id, b, cur);
  // Bước 4: Chuẩn hóa trạng thái, tên hiển thị (tối đa 40 ký tự) và thứ tự sắp xếp sort_order.
  const nextStatus = status || cur.status;
  const nextDisplayName =
    b.display_name !== undefined ? str(b.display_name)?.trim() || null : cur.display_name;
  if (nextDisplayName && nextDisplayName.length > 40) {
    throw err.field("display_name", "Display name cannot exceed 40 characters.");
  }
  const nextSortOrder = b.sort_order !== undefined ? num(b.sort_order) ?? null : cur.sort_order;

  // Bước 5: Chuyển toàn bộ dữ liệu đã được xác thực sang hàm saveCourtMetadata để cập nhật database và ghi nhật ký kiểm toán.
  return saveCourtMetadata(sql, id, user, cur, nextCourtCode, nextSport, nextStatus, nextDisplayName, nextSortOrder);
}

/**
 * Làm gì: Thực thi truy vấn cập nhật metadata của sân vào bảng courts trong cơ sở dữ liệu,
 *   đếm số lượng lịch chiếm sân sắp tới (occupancies) và ghi nhật ký kiểm toán (audit log) lưu lại toàn bộ thay đổi.
 * Được gọi ở: patchCourtMetadata, dòng 832.
 * @param sql Kết nối cơ sở dữ liệu.
 * @param id Mã UUID của sân cần cập nhật.
 * @param user Người dùng thực hiện thao tác (quản lý).
 * @param cur Dữ liệu hiện tại của sân trước khi cập nhật.
 * @param nextCourtCode Mã sân mới sau khi kiểm tra tính duy nhất.
 * @param nextSport Mã môn thể thao mới sau khi xác thực.
 * @param nextStatus Trạng thái mới của sân.
 * @param nextDisplayName Tên hiển thị mới của sân (hoặc null nếu không đặt).
 * @param nextSortOrder Thứ tự sắp xếp hiển thị mới (hoặc null).
 * @returns Phản hồi HTTP { status: 200, body: { court, upcoming } } chứa thông tin sân sau khi cập nhật và số lịch chiếm sắp tới.
 */
async function saveCourtMetadata(sql: Sql, id: string, user: PublicUser, cur: Awaited<ReturnType<typeof courtById>>, nextCourtCode: string, nextSport: string, nextStatus: string, nextDisplayName: string | null, nextSortOrder: number | null) {
  // Bước 1: Thực thi câu lệnh SQL UPDATE để ghi các giá trị metadata mới vào bảng courts.
  await sql.query(
    `update courts
        set court_code = $1, sport = $2, status = $3, display_name = $4, sort_order = $5
      where id = $6`,
    [nextCourtCode, nextSport, nextStatus, nextDisplayName, nextSortOrder, id],
  );

  // Bước 2: Đếm số lịch chiếm sân trong tương lai (end_at > now()) của sân này để trả về cho người quản lý.
  const live = await one<{ n: number }>(
    sql,
    `select count(*)::int as n from occupancies where court_id = $1 and end_at > now()`,
    [id],
  );

  // Bước 3: Ghi nhật ký audit lưu lại toàn bộ trạng thái trước và sau khi cập nhật thông tin sân để phục vụ tra soát.
  await audit(
    sql,
    user.id,
    "patch_court",
    "court",
    id,
    {
      court_code: cur.court_code,
      sport: cur.sport,
      status: cur.status,
      display_name: cur.display_name,
      sort_order: cur.sort_order,
    },
    {
      court_code: nextCourtCode,
      sport: nextSport,
      status: nextStatus,
      display_name: nextDisplayName,
      sort_order: nextSortOrder,
    },
  );

  // Bước 4: Truy vấn lại thông tin sân mới nhất từ cơ sở dữ liệu và trả về kết quả 200 kèm số lịch sắp tới.
  const court = await one(
    sql,
    `select id, court_code, sport, status, display_name, sort_order, retired_at from courts where id = $1`,
    [id],
  );
  return { status: 200, body: { court, upcoming: live?.n ?? 0 } };
}

/**
 * Làm gì: Giữ chỗ (hold) sân thể thao tạm thời cho hội viên qua ứng dụng trong khoảng thời gian quy định (hold_minutes);
 *   tính toán giá thuê (ưu tiên quyền lợi gói hội viên hoặc mã khuyến mãi), tạo dòng court_bookings và khóa slot trong bảng occupancies.
 * Được gọi ở:
 *   - src/server/controllers/router.ts xử lý route POST /api/bookings (thông qua withIdempotency).
 *   - Test runner: src/server/controllers/tx.test.ts, src/server/controllers/flows.test.ts.
 * @param sql Kết nối cơ sở dữ liệu Postgres trong transaction.
 * @param request HTTP request chứa body JSON gồm: court_id, start_at, promo_code (tùy chọn), confirm_overlap (tùy chọn).
 * @param user Thông tin tài khoản người dùng đang đăng nhập (yêu cầu vai trò member).
 * @returns Phản hồi HTTP 201 kèm thông tin booking, thời hạn giữ chỗ (hold_until), số tiền cần thanh toán ngay và khuyến mãi áp dụng.
 * @throws Lỗi 403 FORBIDDEN nếu người dùng không có vai trò hội viên (member).
 * @throws Lỗi 400 VALIDATION nếu thiếu court_id, start_at hoặc start_at không đúng định dạng.
 * @throws Lỗi BR-06 nếu ngày giờ đặt nằm ngoài giờ mở cửa hoặc sân không ở trạng thái sẵn sàng ('ready').
 * @throws Lỗi BR-09 nếu trùng giờ với lớp học đã đăng ký mà chưa xác nhận (confirm_overlap !== true).
 * @throws Lỗi 409 CONFLICT nếu khung giờ vừa bị người khác giữ chỗ (conflictSlot).
 */
export async function bookingsHold(sql: Sql, request: Request, user: PublicUser): Promise<Reply<HoldResponse>> {
  // Bước 1: Kiểm tra phân quyền — chỉ hội viên (member) mới được phép tự giữ chỗ sân qua ứng dụng.
  requireRole(user, ["member"]);
  // Bước 2: Đọc dữ liệu đầu vào và kiểm tra bắt buộc phải có court_id và start_at.
  const b = await readJson(request);
  const courtId = str(b.court_id);
  const startAt = str(b.start_at);
  if (!courtId || !startAt) throw err.validation("court_id and start_at are required.");
  // Bước 3: Lấy cấu hình hệ thống, kiểm tra tính hợp lệ của giờ bắt đầu, tính giờ kết thúc theo slot_minutes và kiểm tra quy tắc cửa sổ đặt sân (booking window).
  const settings = await getSettings(sql);
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) throw err.field("start_at", "That time is not valid.");
  const { end } = slotBounds(start, settings.slot_minutes);
  await assertBookWindow(start, { walkIn: false, settings });
  // Bước 4: Kiểm tra sân tồn tại và đang sẵn sàng hoạt động (status 'ready') theo quy tắc BR-06.
  const court = await courtById(sql, courtId);
  if (court.status !== "ready") throw err.br("BR-06", "That court is not available.");
  // Ngăn hội viên tự đặt 2 sân bị trùng khung giờ với nhau.
  await assertNoCourtOverlap(sql, user.id, start, end);
  // Cảnh báo nếu trùng giờ với lớp học hội viên đã đăng ký (BR-09); bắt buộc gửi confirm_overlap: true nếu vẫn muốn giữ sân.
  const overlap = await overlapClass(sql, user.id, start, end);
  if (overlap && b.confirm_overlap !== true) {
    throw err.br("BR-09", "This slot clashes with a class you are in. Confirm to hold it anyway.", {
      requires_confirm: true,
    });
  }
  // Bước 5: Tra cứu giá niêm yết theo môn thể thao, sân và khung giờ chơi.
  const list = await lookupPrice(sql, { sport: court.sport, courtId, start });
  // A membership covering the play date fixes the price at the member fee, and no code applies to
  // it. Otherwise the list price, which a code can lower: priced into the hold so the member sees
  // what they will pay, and only counted when the money posts (BR-41).
  // Áp dụng chính sách giá: nếu có gói hội viên bao trả ngày chơi thì lấy giá ưu đãi member và không áp dụng voucher; ngược lại dùng giá niêm yết và thử áp dụng mã giảm giá promo (BR-41).
  const covered = await memberCourtFee(sql, user.id, start, settings);
  const promoCode = covered ? null : str(b.promo_code);
  const promo = promoCode
    ? await quotePromo(sql, {
        code: promoCode,
        userId: user.id,
        scope: "court",
        sport: court.sport,
        orderVnd: list.price_vnd,
        listVnd: list.price_vnd,
      })
    : null;
  // Xác định giá cuối cùng: ưu tiên giá theo gói hội viên, tiếp đến giá sau khuyến mãi, cuối cùng là giá niêm yết.
  const price = covered ? covered.fee_vnd : promo ? promo.final_vnd : list.price_vnd;
  // Courts are paid in full up front.
  const deposit = 0;
  // Bước 6: Sinh trước UUID cho booking và tính thời điểm hết hạn giữ chỗ (hold_until = thời điểm hiện tại + hold_minutes).
  const bookingIdRow = await one<{ id: string }>(sql, `select gen_random_uuid() as id`);
  const bookingId = bookingIdRow!.id;
  const holdUntil = new Date(Date.now() + settings.hold_minutes * 60_000);
  // Bước 7: Khóa vị trí sân trong bảng occupancies bằng stored procedure booking_replace_hold; nếu slot vừa bị người khác giữ thì báo lỗi 409 conflict.
  let occId: string;
  try {
    const occ = await one<{ booking_replace_hold: string }>(
      sql,
      `select booking_replace_hold($1::uuid, null, $2::uuid, $3::timestamptz, $4::timestamptz, $5::uuid) as booking_replace_hold`,
      [user.id, courtId, start.toISOString(), end.toISOString(), bookingId],
    );
    occId = occ!.booking_replace_hold;
  } catch (e) {
    if (isConflictSlot(e)) throw err.conflictSlot("Someone just took that slot.");
    throw e;
  }
  // Bước 8: Sinh mã đặt sân mới tiền tố CRT và lưu thông tin đặt sân vào bảng court_bookings với trạng thái 'hold', kênh 'app'.
  const code = await nextCode(sql, "CRT");
  await sql.query(
    `insert into court_bookings
       (id, code, court_id, user_id, start_at, end_at, status, channel, price_vnd, discount_pct, vat_rate, hold_until, occupancy_id,
        promo_id, promo_discount_vnd, deposit_vnd)
     values ($1,$2,$3,$4,$5,$6,'hold','app',$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      bookingId,
      code,
      courtId,
      user.id,
      start.toISOString(),
      end.toISOString(),
      price,
      0,
      Number(settings.vat_rate),
      holdUntil.toISOString(),
      occId,
      promo?.promo_id ?? null,
      promo?.discount_vnd ?? 0,
      deposit,
    ],
  );
  // Bước 9: Truy vấn lại thông tin đặt sân đầy đủ từ database và trả về HTTP 201 Created kèm chi tiết thanh toán.
  const booking = await one<Booking>(sql, `select ${BOOKING_COLS} from court_bookings where id = $1`, [bookingId]);
  return {
    status: 201,
    body: {
      booking: booking!,
      hold_until: holdUntil.toISOString(),
      price,
      deposit_vnd: deposit,
      due_now_vnd: price,
      list_price: list.price_vnd,
      membership: { covered: !!covered, end_on: covered?.end_on ?? null },
      promo: promo ? { code: promo.code, name: promo.name, discount_vnd: promo.discount_vnd } : null,
    },
  };
}

/** What settling a hold reads off the booking, locked `for update` by every caller. */
const HELD_KEYS = [
  "id",
  "code",
  "user_id",
  "status",
  "hold_until",
  "transfer_requested_at",
  "occupancy_id",
  "court_id",
  "start_at",
  "end_at",
  "price_vnd",
  "deposit_vnd",
  "discount_pct",
  "vat_rate",
  "quota_hours",
] as const satisfies readonly (keyof Booking)[];
/**
 * Làm gì: Danh sách các cột cần truy vấn từ bảng court_bookings khi xử lý xác nhận giữ chỗ (hold), luôn được khóa dòng bằng FOR UPDATE.
 * Được gọi ở:
 *   - src/server/controllers/handlers/bookings.ts trong các hàm bookingsConfirm, bookingsTransferConfirm, bookingsTransferReject.
 *   - src/server/controllers/handlers/online.ts khi nhận webhook từ payOS để xác nhận thanh toán trực tuyến.
 */
export const HELD_COLS = HELD_KEYS.join(", ");
/** A hold is always a member's: walk-ins are paid on the spot and never held. */
type HeldBooking = Omit<Pick<Booking, (typeof HELD_KEYS)[number]>, "user_id"> & { user_id: string };

/**
 * Turn a held booking into a paid, confirmed one: money in, slot locked,
 * invoice issued, member told.
 *
 * Shared by the member confirming at the moment of booking and by the desk
 * confirming a bank transfer hours later, because those two have to leave the
 * database in exactly the same state — a transfer reconciled at reception must
 * produce the same payment row and the same receipt as any other booking, or
 * the member ends up with a court and no proof they paid for it.
 */
/**
 * Làm gì: Quyết toán lượt giữ chỗ (hold) thành lượt đặt sân đã xác nhận (confirmed): ghi nhận thanh toán,
 *   chính thức khóa ô chiếm sân (occupancy), đổi trạng thái booking, tiêu mã khuyến mãi, xuất hóa đơn và gửi thông báo.
 * Được gọi ở:
 *   - handlers/bookings.ts: bookingsConfirm (khi hội viên xác nhận), bookingsTransferConfirm (khi lễ tân duyệt chuyển khoản).
 *   - handlers/online.ts: handlePayosWebhook (khi cổng payOS gửi webhook báo chuyển khoản trực tuyến thành công).
 * @param sql Kết nối cơ sở dữ liệu trong transaction.
 * @param booking Bản ghi đặt sân đang giữ chỗ (hold) đã được khóa dòng SELECT FOR UPDATE.
 * @param court Đối tượng chứa mã sân { court_code } để ghi mô tả trên hóa đơn.
 * @param opts Các tùy chọn quyết toán gồm phương thức thanh toán (method), số tiền thanh toán (payAmount),
 *   giờ gói tập (quotaHours), tên người mua (buyerName), số điện thoại (buyerPhone), người thao tác (actorId) và existingPaymentId (nếu đã tạo thanh toán online trước).
 * @returns Đối tượng SettledBooking chứa booking đã cập nhật, thông tin thanh toán payment và invoice_id hóa đơn.
 * @throws Lỗi holdExpired nếu thời hạn giữ chỗ của lượt đặt sân đã hết hạn hoặc ô sân đã bị giải phóng.
 */
export async function settleHeldBooking(
  sql: Sql,
  booking: HeldBooking,
  court: { court_code: string },
  opts: {
    method: string;
    payAmount: number;
    quotaHours: number;
    /** Whose name goes on the receipt. */
    buyerName: string;
    /** A guest booking's phone; null when the buyer is a member. */
    buyerPhone?: string | null;
    /** Who pressed the button — the member, or the receptionist. */
    actorId: string;
    /**
     * Settle against a payment row that already exists, instead of writing one.
     * Set by the payOS path, where the row was created as `pending` when the
     * link was issued.
     */
    existingPaymentId?: string;
  },
): Promise<SettledBooking> {
  // An online payment already has its row: it was written as `pending` when the
  // payOS link was issued, and the gateway's confirmation flipped it to
  // `posted`. Writing a second one here would double the day's takings.
  // Bước 1: Ghi nhận thanh toán — dùng lại paymentId đã có nếu thanh toán qua payOS (tránh ghi trùng doanh thu), hoặc chèn bản ghi mới vào bảng payments với trạng thái 'posted'.
  const pay = opts.existingPaymentId
    ? { id: opts.existingPaymentId }
    : await one<{ id: string }>(
        sql,
        `insert into payments (code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by, capture_mode)
         values ($1,$2,$3,$4,$5,'posted','booking',$6,$7,'manual') returning id`,
        [
          await nextCode(sql, "PAY"),
          booking.user_id,
          opts.method,
          opts.payAmount,
          Number(booking.vat_rate),
          booking.id,
          opts.actorId,
        ],
      );
  // Bước 2: Gọi stored procedure occupancy_confirm_hold để chính thức chuyển ô giữ chỗ sang đã xác nhận; nếu đã hết hạn thì ném lỗi holdExpired.
  try {
    await sql.query(`select occupancy_confirm_hold($1::uuid)`, [booking.occupancy_id]);
  } catch {
    throw err.holdExpired();
  }
  // Plan hours carry no money, so no code applies; otherwise the code is spent now.
  // Bước 3: Đổi mã khuyến mãi sang trạng thái đã sử dụng (redeem) nếu có phát sinh giao dịch tiền.
  if (opts.payAmount > 0) await redeemForBooking(sql, booking.id, booking.user_id, pay!.id);
  // Bước 4: Cập nhật court_bookings sang trạng thái 'confirmed', lưu số tiền đã trả paid_vnd và xóa thời hạn giữ chỗ hold_until.
  await sql.query(
    `update court_bookings
        set status = 'confirmed', quota_hours = $2,
            price_vnd = case when $3::int > 0 then price_vnd else 0 end,
            paid_vnd = $3,
            hold_until = null, transfer_requested_at = null,
            promo_id = case when $3::int > 0 then promo_id else null end,
            promo_discount_vnd = case when $3::int > 0 then promo_discount_vnd else 0 end
      where id = $1`,
    [booking.id, opts.quotaHours, opts.payAmount],
  );
  // Bước 5: Lấy cấu hình hệ thống và xuất hóa đơn điện tử (issueInvoice) tương ứng với khoản thanh toán vừa ghi nhận.
  const settings = await getSettings(sql);
  const invoiceId = await issueInvoice(sql, {
    paymentId: pay!.id,
    buyerName: opts.buyerName,
    buyerPhone: opts.buyerPhone ?? null,
    amountVnd: opts.payAmount,
    vatRate: Number(booking.vat_rate ?? 0),
    description:
      `${opts.payAmount < booking.price_vnd ? "Cọc thuê sân" : "Thuê sân"} ${court.court_code} — ` +
      `${ictStamp(booking.start_at)}–${ictClock(booking.end_at)}`,
    unit: "giờ",
    settings,
  });
  // Bước 6: Đưa thông báo đặt sân thành công (booking_confirmed) vào hàng đợi thông báo trong ứng dụng (inapp) cho hội viên.
  await enqueue(
    sql,
    "inapp",
    "booking_confirmed",
    booking.user_id,
    { booking_id: booking.id, code: booking.code },
    `booking_confirmed|${booking.id}`,
  );
  // Paid with plan hours is still a transaction worth a record, but it is not a
  // receipt for money — there is nothing for the member to have been charged.
  // Bước 7: Nếu có phát sinh tiền thực tế (payAmount > 0), đưa biên lai thanh toán vào hàng đợi gửi cho hội viên.
  if (opts.payAmount > 0) {
    await enqueueReceipt(sql, booking.user_id, {
      payment_id: pay!.id,
      invoice_id: invoiceId,
      amount_vnd: opts.payAmount,
      method: opts.method,
    });
  }
  // Bước 8: Truy vấn lại thông tin booking và payment mới nhất từ DB để trả về kết quả quyết toán đầy đủ.
  const fresh = await one<Booking>(sql, `select ${BOOKING_COLS} from court_bookings where id = $1`, [booking.id]);
  const payment = await one<Payment>(sql, `select ${PAYMENT_COLS} from payments where id = $1`, [pay!.id]);
  return { booking: fresh!, payment: payment!, invoice_id: invoiceId };
}

/**
 * What a member is allowed to settle their own booking with.
 *
 * `transfer` only asks reception to go and look at the bank — it posts no money
 * itself. (`quota` used to spend plan hours; plans are gone.) Everything else means
 * "cash/card changed hands", which is a claim only somebody standing at the
 * till can make.
 *
 * Without this list `method` went from the request body straight into the
 * payment row, so a member could POST `{"method":"cash"}` and mark their own
 * booking paid for money nobody had collected. `gateway` is absent on purpose:
 * an online payment becomes real when payOS confirms it, never because a
 * client said so.
 */
const MEMBER_SETTLE_METHODS = new Set(["transfer"]);

/**
 * Làm gì: Xử lý yêu cầu xác nhận giữ chỗ từ hội viên: nếu chọn chuyển khoản ngân hàng (transfer), hệ thống gia hạn thời gian giữ chỗ
 *   (transfer_hold_minutes) để chờ lễ tân kiểm tra tài khoản; nếu là phương thức khác hợp lệ sẽ tiến hành quyết toán ngay.
 * Được gọi ở:
 *   - Route POST /api/bookings/:id/confirm (src/server/controllers/router.ts qua withIdempotency).
 *   - Test runner: src/server/controllers/flows.test.ts, src/server/controllers/tx.test.ts.
 * @param sql Kết nối cơ sở dữ liệu trong transaction.
 * @param id Mã UUID của lượt đặt sân (court_bookings.id).
 * @param request HTTP request chứa body JSON với phương thức thanh toán method ("transfer").
 * @param user Thông tin tài khoản người dùng đăng nhập (yêu cầu vai trò member và phải là người tạo booking).
 * @returns Phản hồi HTTP 202 nếu đang chờ lễ tân duyệt chuyển khoản (kèm thời hạn mới), hoặc HTTP 200 kèm kết quả quyết toán hoàn tất.
 * @throws Lỗi 403 FORBIDDEN nếu không phải member, không phải chủ booking, hoặc chọn phương thức thanh toán không được phép tự xác nhận (như tiền mặt).
 * @throws Lỗi 422 VALIDATION nếu method là "quota" (gói giờ tập đã ngừng kinh doanh).
 * @throws Lỗi 404 NOT_FOUND nếu không tìm thấy booking tương ứng với ID.
 * @throws Lỗi 409 CONFLICT nếu booking không còn ở trạng thái 'hold', đã gửi yêu cầu chuyển khoản trước đó, hoặc đã quá hạn giữ chỗ (holdExpired).
 */
export async function bookingsConfirm(
  sql: Sql,
  id: string,
  request: Request,
  user: PublicUser,
): Promise<Reply<ConfirmResponse>> {
  // Bước 1: Kiểm tra quyền hạn — chỉ tài khoản hội viên (member) sở hữu lượt đặt mới được gửi yêu cầu xác nhận.
  requireRole(user, ["member"]);
  // Bước 2: Đọc phương thức thanh toán; chặn method 'quota' (không còn bán giờ tập) và chặn hội viên tự đánh dấu đã thanh toán tiền mặt/thẻ từ xa.
  const b = await readJson(request);
  const method = str(b.method) ?? "transfer";
  // Plans are gone, so there are no court hours to spend. Say so on the field.
  if (method === "quota") {
    throw new ApiError(422, "VALIDATION", "Court hours are no longer sold; pay the slot price.", { field: "method" });
  }
  if (!MEMBER_SETTLE_METHODS.has(method)) {
    throw err.forbidden(
      "Pay online, or pay at the front desk — a booking cannot be marked paid from the app.",
    );
  }
  // Bước 3: Lấy cấu hình hệ thống và khóa bản ghi booking (FOR UPDATE) để ngăn tranh chấp trạng thái giữa các request đồng thời.
  const settings = await getSettings(sql);
  const booking = await one<HeldBooking>(
    sql,
    `select ${HELD_COLS} from court_bookings where id = $1 for update`,
    [id],
  );
  // Bước 4: Kiểm tra tính hợp lệ của lượt đặt: phải tồn tại, thuộc quyền sở hữu của user, đang ở trạng thái 'hold', chưa yêu cầu chuyển khoản và chưa hết hạn.
  if (!booking) throw err.notFound();
  if (booking.user_id !== user.id) throw err.forbidden();
  if (booking.status !== "hold") throw err.conflictState("That booking is no longer on hold.");
  if (booking.transfer_requested_at) {
    throw err.conflictState("Reception is already checking the bank for this one.");
  }
  if (!booking.hold_until || new Date(booking.hold_until) < new Date()) {
    throw err.holdExpired();
  }
  // Bước 5: Lấy thông tin sân để phục vụ lập hóa đơn.
  const court = await courtById(sql, booking.court_id);

  /*
   * A bank transfer is a promise, not a payment.
   *
   * Nothing is posted and nothing is confirmed here: the slot stays on hold —
   * still blocking the court, still swept by expire_holds if the money never
   * arrives — on a longer clock, because five minutes is the wrong amount of
   * time to give somebody who has to open a banking app. Reception confirms it
   * against the statement, and only then does a payment row exist.
   */
  // Bước 6: Xử lý phương thức chuyển khoản: gia hạn thời gian hold (transfer_hold_minutes), đánh dấu transfer_requested_at, đưa thông báo vào hàng đợi và trả về HTTP 202 Accepted.
  if (method === "transfer") {
    const until = new Date(Date.now() + settings.transfer_hold_minutes * 60_000);
    await sql.query(
      `update court_bookings set hold_until = $2, transfer_requested_at = now() where id = $1`,
      [booking.id, until.toISOString()],
    );
    await enqueue(
      sql,
      "inapp",
      "transfer_requested",
      user.id,
      { booking_id: booking.id, code: booking.code, amount_vnd: dueNow(booking) },
      `transfer_requested|${booking.id}`,
    );
    const fresh = await one<Booking>(sql, `select ${BOOKING_COLS} from court_bookings where id = $1`, [id]);
    return {
      status: 202,
      body: {
        booking: fresh!,
        payment: null,
        invoice_id: null,
        awaiting_transfer: true,
        hold_until: until.toISOString(),
        amount_vnd: dueNow(booking),
      },
    };
  }

  // Bước 7: Với các phương thức thanh toán hợp lệ khác, tiến hành quyết toán ngay thông qua settleHeldBooking và trả về HTTP 200.
  const settled = await settleHeldBooking(sql, booking, court, {
    method,
    payAmount: dueNow(booking),
    quotaHours: 0,
    buyerName: user.full_name,
    actorId: user.id,
  });
  return { status: 200, body: settled };
}

/**
 * Reception has seen the money land in the bank account.
 *
 * Staff-only on purpose: the member asking for this would be marking their own
 * transfer as received, which is the whole thing this queue exists to prevent.
 */
/**
 * Làm gì: Lễ tân hoặc quản lý xác nhận đã nhận được tiền chuyển khoản ngân hàng từ hội viên:
 *   chuyển lượt đặt sân từ 'hold' sang 'confirmed', ghi nhận thanh toán, xuất hóa đơn và ghi log audit.
 * Được gọi ở:
 *   - Route POST /api/bookings/:id/transfer-confirm (src/server/controllers/router.ts qua authed).
 *   - Test runner: src/server/controllers/flows.test.ts.
 * @param sql Kết nối cơ sở dữ liệu trong transaction.
 * @param id Mã UUID của lượt đặt sân cần duyệt chuyển khoản.
 * @param user Nhân viên thực hiện thao tác (yêu cầu vai trò receptionist hoặc manager).
 * @returns Phản hồi HTTP 200 kèm thông tin lượt đặt sân đã quyết toán thành công (SettledBooking).
 * @throws Lỗi 403 FORBIDDEN nếu nhân viên không có vai trò receptionist hoặc manager.
 * @throws Lỗi 404 NOT_FOUND nếu không tìm thấy lượt đặt sân theo ID.
 * @throws Lỗi 409 CONFLICT nếu lượt đặt chưa từng yêu cầu chuyển khoản, không ở trạng thái 'hold', hoặc đã hết hạn giữ chỗ (holdExpired).
 */
export async function bookingsTransferConfirm(
  sql: Sql,
  id: string,
  user: PublicUser,
): Promise<Reply<TransferConfirmResponse>> {
  // Bước 1: Kiểm tra phân quyền nhân viên — chỉ lễ tân (receptionist) hoặc quản lý (manager) mới có quyền duyệt tiền chuyển khoản.
  requireRole(user, ["receptionist", "manager"]);
  // Bước 2: Khóa dòng booking (FOR UPDATE) và kiểm tra các điều kiện: phải tồn tại, có yêu cầu chuyển khoản, đang ở trạng thái 'hold' và chưa quá hạn giữ chỗ.
  const booking = await one<HeldBooking>(
    sql,
    `select ${HELD_COLS} from court_bookings where id = $1 for update`,
    [id],
  );
  if (!booking) throw err.notFound();
  if (!booking.transfer_requested_at) {
    throw err.conflictState("No transfer was requested for this booking.");
  }
  if (booking.status !== "hold") throw err.conflictState("That booking is no longer on hold.");
  // The hold is checked, not waived. A slot whose clock ran out has already
  // been handed back by the sweeper or is about to be, and confirming it would
  // sell a court that somebody else may already have booked.
  if (!booking.hold_until || new Date(booking.hold_until) < new Date()) {
    throw err.holdExpired();
  }
  // Bước 3: Lấy thông tin sân và thông tin người mua (tên, số điện thoại) để ghi vào hóa đơn.
  const court = await courtById(sql, booking.court_id);
  const buyer = await bookingBuyer(sql, booking.id);
  // Bước 4: Gọi hàm settleHeldBooking để quyết toán lượt đặt với phương thức thanh toán 'transfer' và số tiền cần thu.
  const settled = await settleHeldBooking(sql, booking, court, {
    method: "transfer",
    payAmount: dueNow(booking),
    quotaHours: 0,
    buyerName: buyer.name,
    buyerPhone: buyer.phone,
    actorId: user.id,
  });
  // Bước 5: Ghi nhật ký audit lưu vết nhân viên đã xác nhận khoản chuyển khoản cho booking này.
  await audit(sql, user.id, "transfer_confirm", "booking", booking.id);
  return { status: 200, body: settled };
}

/** The money never arrived, or arrived wrong. The slot goes back on sale. */
/**
 * Làm gì: Lễ tân hoặc quản lý từ chối yêu cầu chuyển khoản (do tiền chưa vào tài khoản hoặc sai lệch số tiền):
 *   giải phóng ô chiếm sân (occupancy_release_booking), hủy hạn giữ chỗ, thông báo cho hội viên và ghi nhận lý do.
 * Được gọi ở:
 *   - Route POST /api/bookings/:id/transfer-reject (src/server/controllers/router.ts qua authed).
 * @param sql Kết nối cơ sở dữ liệu trong transaction.
 * @param id Mã UUID của lượt đặt sân cần từ chối chuyển khoản.
 * @param request HTTP request chứa body JSON với lý do từ chối (reason).
 * @param user Nhân viên thực hiện thao tác (yêu cầu vai trò receptionist hoặc manager).
 * @returns Phản hồi HTTP 200 xác nhận đã giải phóng sân ({ booking_id: id, released: true }).
 * @throws Lỗi 403 FORBIDDEN nếu nhân viên không có vai trò receptionist hoặc manager.
 * @throws Lỗi 404 NOT_FOUND nếu không tìm thấy lượt đặt sân theo ID.
 * @throws Lỗi 409 CONFLICT nếu lượt đặt chưa từng yêu cầu chuyển khoản hoặc không ở trạng thái 'hold'.
 */
export async function bookingsTransferReject(
  sql: Sql,
  id: string,
  request: Request,
  user: PublicUser,
): Promise<Reply<TransferRejectResponse>> {
  // Bước 1: Kiểm tra phân quyền — chỉ lễ tân (receptionist) hoặc quản lý (manager) mới có quyền từ chối yêu cầu chuyển khoản.
  requireRole(user, ["receptionist", "manager"]);
  // Bước 2: Đọc lý do từ chối (reason) gửi lên từ body của request.
  const reason = str((await readJson(request)).reason) ?? null;
  // Bước 3: Khóa dòng booking (FOR UPDATE) và kiểm tra: phải tồn tại, có yêu cầu chuyển khoản và đang ở trạng thái 'hold'.
  const booking = await one<HeldBooking>(
    sql,
    `select ${HELD_COLS} from court_bookings where id = $1 for update`,
    [id],
  );
  if (!booking) throw err.notFound();
  if (!booking.transfer_requested_at) {
    throw err.conflictState("No transfer was requested for this booking.");
  }
  if (booking.status !== "hold") throw err.conflictState("That booking is no longer on hold.");
  // Bước 4: Giải phóng ô sân bằng stored procedure occupancy_release_booking để người khác có thể đặt lại, đồng thời xóa hạn giữ chỗ hold_until.
  await sql.query(`select occupancy_release_booking($1::uuid, 'cancelled'::booking_status)`, [id]);
  await sql.query(`update court_bookings set hold_until = null where id = $1`, [id]);
  // Bước 5: Đưa thông báo từ chối chuyển khoản (transfer_rejected) kèm lý do vào hàng đợi thông báo trong ứng dụng cho hội viên.
  await enqueue(
    sql,
    "inapp",
    "transfer_rejected",
    booking.user_id,
    { booking_id: booking.id, code: booking.code, reason },
    `transfer_rejected|${booking.id}`,
  );
  // Ghi nhật ký kiểm toán (audit log) ghi nhận nhân viên từ chối thanh toán chuyển khoản kèm lý do.
  await audit(sql, user.id, "transfer_reject", "booking", booking.id, null, { reason });
  // Trả về phản hồi HTTP 200 xác nhận đã giải phóng sân và từ chối yêu cầu chuyển khoản.
  return { status: 200, body: { booking_id: id, released: true } };
}

/**
 * Danh sách các trường dữ liệu tối thiểu từ bảng court_bookings cần lấy để xử lý tính toán và hủy đặt sân.
 */
const CANCEL_KEYS = [
  "id",
  "user_id",
  "status",
  "start_at",
  "price_vnd",
  "paid_vnd",
  "quota_hours",
  "court_id",
] as const satisfies readonly (keyof Booking)[];
type CancelRow = Pick<Booking, (typeof CANCEL_KEYS)[number]>;
const CANCEL_COLS = CANCEL_KEYS.join(", ");

/** A paid court that has already started is played, not cancellable: no refund math applies. */
const CANNOT_CANCEL_STARTED = "This booking has already started, so it cannot be cancelled.";
/**
 * Làm gì: Kiểm tra xem một lượt đặt sân đã xác nhận (confirmed) đã đến giờ bắt đầu hoặc đang diễn ra hay chưa.
 *   Vì sao: sân đã bắt đầu được coi là đã sử dụng (played), không được phép hủy và không áp dụng chính sách hoàn tiền.
 * Được gọi ở:
 *   - bookingsCancelQuote (dòng 1308)
 *   - bookingsCancel (dòng 1341)
 * @param booking Dòng dữ liệu lượt đặt sân chứa status và start_at.
 * @returns true nếu lượt đặt ở trạng thái confirmed và thời điểm bắt đầu nhỏ hơn hoặc bằng hiện tại.
 */
const hasStarted = (booking: CancelRow) => booking.status === "confirmed" && new Date(booking.start_at).getTime() <= Date.now();

/**
 * What cancelling a booking would cost, right now.
 *
 * Members receive nothing back. Staff can quote a full cash refund when the
 * centre cancels; the cancellation itself must include the centre's reason.
 */
/**
 * Làm gì: Tính toán số tiền hoàn lại và phí phạt nếu hủy lượt đặt sân tại thời điểm hiện tại.
 *   Hội viên chủ động hủy thì không được hoàn tiền (mất 100% tiền cọc/tiền sân); nhân viên có thể chọn miễn phạt (waive)
 *   để hoàn đủ 100% tiền mặt khi trung tâm chủ động hủy sân (do sự cố kỹ thuật hoặc đóng sân).
 * Được gọi ở:
 *   - Route GET /v1/bookings/:id/cancel-quote (src/server/controllers/router.ts:379, authedRead).
 *   - Modal hủy đặt sân CancelBookingDialog (src/client/components/cancel-booking.tsx:75).
 *   - Test runner kiểm thử báo giá hủy sân (src/server/services/business-gaps.test.ts:70).
 * @param sql Kết nối database chỉ đọc do router cấp qua authedRead.
 * @param id Mã UUID của lượt đặt sân cần tính phí hủy (court_bookings.id).
 * @param request HTTP request chứa query parameter waive=1 (chỉ dành cho nhân viên).
 * @param user Người dùng đang đăng nhập (member, receptionist hoặc manager).
 * @returns Phản hồi HTTP 200 kèm body chứa kết quả báo giá: hours_left, refund_pct, paid_vnd, refund_vnd, fee_vnd, waived, tiers, quota_hours.
 * @throws Lỗi 403 FORBIDDEN nếu hội viên cố xem báo giá hủy lượt đặt sân của người khác.
 * @throws Lỗi 404 NOT_FOUND nếu không tìm thấy lượt đặt sân theo id tương ứng.
 * @throws Lỗi 409 CONFLICT_STATE nếu lượt đặt không ở trạng thái hold/confirmed hoặc sân đã đến giờ bắt đầu.
 */
export async function bookingsCancelQuote(
  sql: Sql,
  id: string,
  request: Request,
  user: PublicUser,
): Promise<Reply<CancelQuoteResponse>> {
  // Bước 1: kiểm tra vai trò người dùng — chỉ hội viên, lễ tân hoặc quản lý mới được xem báo giá hủy sân.
  requireRole(user, ["member", "receptionist", "manager"]);
  // Bước 2: đọc thông tin các cột cần thiết của lượt đặt sân từ bảng court_bookings theo id.
  const booking = await one<CancelRow>(sql, `select ${CANCEL_COLS} from court_bookings where id = $1`, [id]);
  if (!booking) throw err.notFound();
  // Bước 3: kiểm tra quyền sở hữu — hội viên chỉ được xem lịch của mình; lễ tân và quản lý được xem tất cả.
  if (user.role === "member" && booking.user_id !== user.id) throw err.forbidden();
  // Bước 4: chỉ các lượt đặt đang ở trạng thái giữ chỗ (hold) hoặc đã xác nhận (confirmed) mới có thể tính phí hủy.
  if (!["hold", "confirmed"].includes(booking.status)) {
    throw err.conflictState("A booking in this state cannot be cancelled.");
  }
  // Sân đã đến giờ bắt đầu hoặc đang diễn ra thì không thể hủy (CANNOT_CANCEL_STARTED).
  if (hasStarted(booking)) throw err.conflictState(CANNOT_CANCEL_STARTED);
  // Bước 5: xác định người gọi có phải nhân viên hay không và kiểm tra tham số waive trên query URL.
  const staff = user.role === "receptionist" || user.role === "manager";
  const waived = staff && new URL(request.url).searchParams.get("waive") === "1";
  // Bước 6: tính toán báo giá hủy qua quoteCancel; lượt giữ chỗ (hold) coi như chưa trả tiền (paid = 0).
  const quote = quoteCancel({
    tiers: [],
    startAt: booking.start_at,
    paidVnd: booking.status === "hold" ? 0 : booking.paid_vnd,
    waived,
  });
  // Bước 7: trả về kết quả báo giá hủy với mã trạng thái HTTP 200.
  return {
    status: 200,
    body: { ...quote, tiers: [], quota_hours: Number(booking.quota_hours) || 0 },
  };
}

/**
 * Làm gì: Thực hiện hủy lượt đặt sân, giải phóng chỗ chiếm sân trên lưới giờ và xử lý hoàn tiền hoặc phí phạt hủy.
 *   Nếu lượt đặt đang giữ chỗ (hold): giải phóng sân ngay mà không phát sinh hoàn tiền.
 *   Nếu đã xác nhận (confirmed): tính phí hủy; khi trung tâm hủy (waived = true), hoàn đủ 100% tiền mặt,
 *   tạo bản ghi hoàn tiền refund_pending, đối soát lại điểm loyalty và khôi phục mã khuyến mãi đã dùng (BR-41).
 *   Đồng thời gửi thông báo inapp và ghi nhật ký kiểm toán (audit log).
 * Được gọi ở:
 *   - Route POST /v1/bookings/:id/cancel (src/server/controllers/router.ts:376 qua authed).
 *   - Modal xác nhận hủy đặt sân CancelBookingDialog (src/client/components/cancel-booking.tsx:109).
 *   - Hủy loạt lịch cố định recurringSeriesCancel (src/server/controllers/handlers/extras.ts:664).
 *   - Test runner kiểm thử luồng hủy sân (src/server/controllers/flows.test.ts:458, src/server/services/business-gaps.test.ts:73).
 * @param sql Kết nối database trong transaction do router quản lý.
 * @param id Mã UUID của lượt đặt sân cần hủy (court_bookings.id).
 * @param user Người dùng thực hiện thao tác (member, receptionist hoặc manager).
 * @param request HTTP request tùy chọn chứa body JSON { waive?: boolean, reason?: string }.
 * @returns Phản hồi HTTP 200 kèm body { refund, refundable, quote } chứa bản ghi hoàn tiền và chi tiết tính phí hủy.
 * @throws Lỗi 403 FORBIDDEN nếu hội viên cố hủy lượt đặt sân của người khác.
 * @throws Lỗi 404 NOT_FOUND nếu không tìm thấy lượt đặt sân theo id tương ứng.
 * @throws Lỗi 409 CONFLICT_STATE nếu lượt đặt không ở trạng thái hold/confirmed hoặc sân đã đến giờ bắt đầu.
 * @throws Lỗi 400 FIELD ở trường reason nếu nhân viên chọn miễn phí phạt (waived) nhưng không cung cấp lý do hủy.
 */
export async function bookingsCancel(
  sql: Sql,
  id: string,
  user: PublicUser,
  request?: Request,
): Promise<Reply<CancelResponse>> {
  // Bước 1: chỉ hội viên, lễ tân hoặc quản lý mới có quyền yêu cầu hủy lượt đặt sân.
  requireRole(user, ["member", "receptionist", "manager"]);
  // Bước 2: đọc payload JSON từ request (nếu có) chứa tùy chọn miễn phí phạt (waive) và lý do hủy.
  const body = request ? await readJson(request) : {};
  // Bước 3: đọc và khóa dòng lượt đặt sân (FOR UPDATE) để đảm bảo tính toàn vẹn dữ liệu trong transaction.
  const booking = await one<CancelRow>(sql, `select ${CANCEL_COLS} from court_bookings where id = $1 for update`, [id]);
  if (!booking) throw err.notFound();
  // Hội viên chỉ được phép hủy lịch của chính mình; nhân viên được quyền hủy lịch của bất kỳ ai.
  if (user.role === "member" && booking.user_id !== user.id) throw err.forbidden();
  // Bước 4: chỉ các lượt đặt đang giữ chỗ (hold) hoặc đã xác nhận (confirmed) mới được phép hủy.
  if (!["hold", "confirmed"].includes(booking.status)) {
    throw err.conflictState("A booking in this state cannot be cancelled.");
  }
  // Bước 5: xử lý hủy nhanh cho lượt đang giữ chỗ (hold) — giải phóng chỗ chiếm sân và trả về ngay vì chưa nộp tiền.
  if (booking.status === "hold") {
    await sql.query(`select occupancy_release_booking($1::uuid, 'cancelled'::booking_status)`, [id]);
    return { status: 200, body: { refund: null, booking_id: id } };
  }
  // Sân đã đến giờ bắt đầu hoặc đang diễn ra thì không được phép hủy (CANNOT_CANCEL_STARTED).
  if (hasStarted(booking)) throw err.conflictState(CANNOT_CANCEL_STARTED);
  // Bước 6: kiểm tra điều kiện hủy của trung tâm — nhân viên có thể chọn waive để hoàn 100%, bắt buộc phải nhập lý do.
  const staff = user.role === "receptionist" || user.role === "manager";
  const waived = staff && body.waive === true;
  const reason = str(body.reason)?.trim() ?? null;
  if (waived && !reason) throw err.field("reason", "A reason is required for a centre cancellation.");
  // Bước 7: tính toán số tiền hoàn và phí phạt hủy theo chính sách qua quoteCancel.
  const quote = quoteCancel({
    tiers: [],
    startAt: booking.start_at,
    paidVnd: booking.paid_vnd,
    waived,
  });
  // Bước 8: giải phóng chỗ chiếm sân (occupancy) để trả lại slot trống cho khách hàng khác đặt.
  await sql.query(`select occupancy_release_booking($1::uuid, 'cancelled'::booking_status)`, [id]);
  // Cập nhật tỷ lệ hoàn tiền (cancel_refund_pct) và phí phạt hủy (cancel_fee_vnd) vào bảng court_bookings.
  await sql.query(`update court_bookings set cancel_refund_pct = $2, cancel_fee_vnd = $3 where id = $1`, [
    id,
    quote.refund_pct,
    quote.fee_vnd,
  ]);
  // Bước 9: xử lý hoàn tiền nếu có khoản tiền thực tế cần hoàn lại cho khách hàng.
  let refund: Payment | null = null;
  const qh = Number(booking.quota_hours) || 0;
  if (qh > 0) {
    // Old bookings paid with plan hours. Plans no longer exist, so there is
    // nothing to give back: those hours are history, and no row is touched.
    refund = null;
  } else if (quote.refund_vnd > 0) {
    // Khóa tài khoản khách hàng để đồng bộ số dư và điểm loyalty, tránh xung đột khi tạo phiếu hoàn tiền.
    await sql.query(`select id from users where id = $1 for update`, [booking.user_id]);
    // Cấp mã phiếu chi (PAY) với số tiền âm (amount < 0) và trạng thái refund_pending để quầy duyệt chi tiền mặt.
    const payCode = await nextCode(sql, "PAY");
    const amount = -quote.refund_vnd;
    const st = "refund_pending";
    refund =
      (await one<Payment>(
        sql,
        `insert into payments (code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by)
         values ($1,$2,'cash',$3,0,$4,'booking',$5,null) returning ${PAYMENT_COLS}`,
        [payCode, booking.user_id, amount, st, id],
      )) ?? null;
    // Đối soát lại điểm tích lũy (loyalty points) của hội viên để tránh tình trạng âm điểm sau khi nhận hoàn tiền.
    await reconcileLoyaltyRefund(sql, booking.user_id);
    // A full refund gives the member their use of the code back (BR-41).
    if (quote.fee_vnd === 0) await restoreIfFullyRefunded(sql, "booking", id);
  }
  // Bước 10: đưa thông báo hủy sân thành công vào hàng đợi thông báo trong ứng dụng (inapp notification).
  await enqueue(
    sql,
    "inapp",
    "booking_cancelled",
    booking.user_id,
    { id, fee_vnd: quote.fee_vnd, refund_vnd: quote.refund_vnd },
    `booking_cancelled|${id}`,
  );
  // Bước 11: ghi nhật ký kiểm toán (audit log) lưu lại thông tin ai hủy, tỷ lệ hoàn, phí phạt và lý do.
  await audit(sql, user.id, "cancel_booking", "booking", id, null, {
    refund_pct: quote.refund_pct,
    fee_vnd: quote.fee_vnd,
    waived,
    reason,
  });
  // Bước 12: trả về kết quả hủy sân với mã HTTP 200 kèm thông tin phiếu hoàn tiền và báo giá tính toán.
  return { status: 200, body: { refund, refundable: quote.refund_vnd > 0 || refund !== null, quote } };
}

/**
 * Take the rest of the price at the desk, usually when the customer turns up.
 * A deposit booking is confirmed with only part of the money in; this is the
 * other part, as a payment row of its own with its own invoice.
 */
/**
 * Làm gì: Thu phần tiền còn lại tại quầy lễ tân cho lượt đặt sân đã cọc trước (deposit booking), xuất hóa đơn và gửi biên lai.
 *   Lượt đặt cọc được xác nhận chỉ với một phần tiền; khi khách đến sân nhận ca, nhân viên thu nốt số tiền còn thiếu,
 *   tạo một bản ghi thanh toán (payment) riêng với trạng thái posted, gán vào ca thu ngân và xuất hóa đơn tương ứng.
 * Được gọi ở:
 *   - Route POST /v1/bookings/:id/collect-balance (src/server/controllers/router.ts:382 qua authed).
 *   - Nút thu tiền còn lại trên màn hình chi tiết hội viên /desk/member/:id (src/routes/desk.member.$id.tsx:1022).
 * @param sql Kết nối database trong transaction do router quản lý.
 * @param id Mã UUID của lượt đặt sân cần thu tiền còn lại (court_bookings.id).
 * @param request HTTP request chứa body JSON với phương thức thanh toán method ("cash", "card", "transfer").
 * @param user Nhân viên thực hiện thu tiền; yêu cầu vai trò receptionist hoặc manager.
 * @returns Phản hồi HTTP 200 kèm body { booking, payment_id, invoice_id, amount_vnd } chứa thông tin booking đã thanh toán đủ và hóa đơn mới.
 * @throws Lỗi 403 FORBIDDEN nếu người dùng không phải lễ tân hoặc quản lý.
 * @throws Lỗi 400 VALIDATION nếu phương thức thanh toán không thuộc cash, card hoặc transfer.
 * @throws Lỗi 404 NOT_FOUND nếu không tìm thấy lượt đặt sân theo id.
 * @throws Lỗi 409 CONFLICT_STATE nếu lượt đặt không ở trạng thái "confirmed" hoặc "in_use", hoặc đã thanh toán đủ (due <= 0).
 * @throws Lỗi 422 BR-44 nếu nhân viên là lễ tân nhưng chưa mở ca thu ngân (cashier shift).
 */
export async function bookingsCollectBalance(
  sql: Sql,
  id: string,
  request: Request,
  user: PublicUser,
): Promise<Reply<CollectBalanceResponse>> {
  // Bước 1: chỉ lễ tân hoặc quản lý mới có quyền thu tiền còn lại của lượt đặt sân tại quầy.
  requireRole(user, ["receptionist", "manager"]);
  // Bước 2: đọc dữ liệu request và kiểm tra phương thức thanh toán hợp lệ (cash, card hoặc transfer).
  const b = await readJson(request);
  const method = str(b.method) ?? "cash";
  if (!["cash", "card", "transfer"].includes(method)) throw err.validation("Pick cash, card or transfer.");
  // Bước 3: đọc và khóa dòng lượt đặt sân (FOR UPDATE) để tính số tiền còn thiếu và tránh xung đột khi thu tiền đồng thời.
  const booking = await one<CancelRow & Pick<Booking, "vat_rate">>(
    sql,
    `select ${CANCEL_COLS}, vat_rate from court_bookings where id = $1 for update`,
    [id],
  );
  if (!booking) throw err.notFound();
  // Chỉ lượt đặt ở trạng thái đã xác nhận (confirmed) hoặc đang sử dụng (in_use) mới có thể thu tiền số dư.
  if (!["confirmed", "in_use"].includes(booking.status)) {
    throw err.conflictState("Only a confirmed booking has a balance to collect.");
  }
  // Bước 4: tính số tiền còn thiếu (due = giá niêm yết - tiền đã trả); nếu đã trả đủ thì từ chối xử lý.
  const due = booking.price_vnd - booking.paid_vnd;
  if (due <= 0) throw err.conflictState("Nothing left to pay on this booking.");
  // Bước 5: kiểm tra ca thu ngân theo BR-44 — lễ tân bắt buộc phải có ca đang mở để ghi nhận doanh thu vào ca.
  let shiftId: string | null = null;
  if (user.role === "receptionist") {
    const shift = await one<{ id: string }>(
      sql,
      `select id from cashier_shifts where receptionist_id = $1 and closed_at is null`,
      [user.id],
    );
    if (!shift) throw err.br("BR-44", "Open a till shift before taking payment.");
    shiftId = shift.id;
  }
  // Bước 6: cấp mã PAY và ghi nhận khoản thu số dư vào bảng payments với trạng thái 'posted' (đã thu tiền vào két).
  const pay = await one<{ id: string }>(
    sql,
    `insert into payments (code, user_id, shift_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by)
     values ($1,$2,$3,$4,$5,$6,'posted','booking',$7,$8) returning id`,
    [await nextCode(sql, "PAY"), booking.user_id, shiftId, method, due, Number(booking.vat_rate), id, user.id],
  );
  // Bước 7: cập nhật lượt đặt sân sang trạng thái đã trả đủ tiền (paid_vnd = price_vnd).
  await sql.query(`update court_bookings set paid_vnd = price_vnd where id = $1`, [id]);
  // Bước 8: lấy thông tin sân, người mua và cấu hình trung tâm để xuất hóa đơn điện tử cho khoản thu số dư.
  const court = await courtById(sql, booking.court_id);
  const buyer = await bookingBuyer(sql, id);
  const settings = await getSettings(sql);
  const invoiceId = await issueInvoice(sql, {
    paymentId: pay!.id,
    buyerName: buyer.name,
    buyerPhone: buyer.phone,
    amountVnd: due,
    vatRate: Number(booking.vat_rate ?? 0),
    description: `Thanh toán còn lại thuê sân ${court.court_code} — ${ictStamp(booking.start_at)}`,
    unit: "giờ",
    settings,
  });
  // Bước 9: đưa biên lai thanh toán vào hàng đợi thông báo cho khách hàng.
  await enqueueReceipt(sql, booking.user_id, {
    payment_id: pay!.id,
    invoice_id: invoiceId,
    amount_vnd: due,
    method,
  });
  // Bước 10: ghi nhật ký kiểm toán (audit log) lưu lại nhân viên thu tiền, số tiền và phương thức thanh toán.
  await audit(sql, user.id, "collect_balance", "booking", id, null, { amount_vnd: due, method });
  // Bước 11: đọc lại dữ liệu booking mới nhất sau khi cập nhật và trả về kết quả HTTP 200.
  const fresh = await one<Booking>(sql, `select ${BOOKING_COLS} from court_bookings where id = $1`, [id]);
  return { status: 200, body: { booking: fresh!, payment_id: pay!.id, invoice_id: invoiceId, amount_vnd: due } };
}

type BookingsRescheduleForm = {
  body: Record<string, unknown>;
  start: Date;
};

type BookingsRescheduleSettings = Awaited<ReturnType<typeof getSettings>>;

type BookingsRescheduleBooking = Pick<
  Booking,
  | "id"
  | "user_id"
  | "status"
  | "court_id"
  | "start_at"
  | "price_vnd"
  | "discount_pct"
  | "promo_discount_vnd"
  | "quota_hours"
  | "occupancy_id"
  | "code"
>;

type BookingsRescheduleCourt = Awaited<ReturnType<typeof courtById>>;

type BookingsRescheduleDestination = {
  courtId: string;
  court: BookingsRescheduleCourt;
};

/**
 * Làm gì: đọc yêu cầu đổi lịch và kiểm tra giờ bắt đầu mới.
 *   Giữ nguyên các trường khác trong body để kiểm tra ở đúng bước phía sau.
 * Được gọi ở: bookingsReschedule, bước 2.
 * @param request Request POST /v1/bookings/:id/reschedule từ màn hình đặt sân.
 * @returns Body chưa chuyển đổi các trường khác và giờ bắt đầu hợp lệ.
 * @throws Lỗi 422 VALIDATION nếu JSON sai, không phải object hoặc chứa ký tự NUL.
 *   Lỗi 400 VALIDATION ở start_at nếu thiếu giờ hoặc giờ không hợp lệ.
 */
async function readBookingsRescheduleForm(
  request: Request,
): Promise<BookingsRescheduleForm> {
  const body = await readJson(request);
  const startAt = str(body.start_at);

  if (!startAt) {
    throw err.field("start_at", "Pick the new time.");
  }

  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) {
    throw err.field("start_at", "That time is not valid.");
  }

  return { body, start };
}

/**
 * Làm gì: đọc và khóa lượt đặt sân cần đổi.
 *   Vì sao khóa: các yêu cầu cùng sửa lượt đặt này phải chờ nhau trong transaction.
 * Được gọi ở: bookingsReschedule, bước 4.
 * @param sql Kết nối database trong transaction do router mở.
 * @param bookingId Mã lượt đặt lấy từ tham số :id trên đường dẫn API.
 * @returns Lượt đặt đã khóa, gồm những trường cần cho việc đổi lịch.
 * @throws Lỗi 404 NOT_FOUND nếu lượt đặt không tồn tại.
 *   Lỗi database được chuyển tiếp cho router; lỗi không ánh xạ được trả HTTP 500.
 */
async function lockBookingsRescheduleBooking(
  sql: Sql,
  bookingId: string,
): Promise<BookingsRescheduleBooking> {
  const booking = await one<BookingsRescheduleBooking>(
    sql,
    `select id, user_id, status, court_id, start_at, price_vnd, discount_pct, promo_discount_vnd,
            quota_hours, occupancy_id, code
       from court_bookings where id = $1 for update`,
    [bookingId],
  );

  if (!booking) {
    throw err.notFound();
  }

  return booking;
}

/**
 * Làm gì: kiểm tra người yêu cầu có sở hữu lượt đặt và lượt đặt còn được phép đổi.
 *   Vì sao: chỉ lượt đã xác nhận, có chỗ chiếm sân và còn ngoài hạn đổi mới được chuyển.
 * Được gọi ở: bookingsReschedule, bước 4, sau lockBookingsRescheduleBooking.
 * @param booking Lượt đặt vừa đọc và khóa trong database.
 * @param user Người đăng nhập do router xác thực.
 * @param settings Cấu hình trung tâm đã đọc ở bước 3; dùng cancel_court_hours.
 * @returns Không trả dữ liệu; kết thúc bình thường nghĩa là được phép đổi.
 * @throws Lỗi 403 FORBIDDEN nếu lượt đặt thuộc người khác.
 *   Lỗi 409 CONFLICT_STATE nếu trạng thái không phù hợp, thiếu chỗ chiếm sân
 *   hoặc đã qua hạn đổi. Kiểm tra theo đúng thứ tự này.
 */
function checkBookingsRescheduleEligibility(
  booking: BookingsRescheduleBooking,
  user: PublicUser,
  settings: BookingsRescheduleSettings,
): void {
  if (booking.user_id !== user.id) {
    throw err.forbidden();
  }

  const bookingCannotBeMoved =
    booking.status !== "confirmed" || !booking.occupancy_id;

  if (bookingCannotBeMoved) {
    throw err.conflictState("Only a confirmed booking that has not started can be moved.");
  }

  const hoursUntilStart =
    (new Date(booking.start_at).getTime() - Date.now()) / 3600000;

  if (hoursUntilStart < settings.cancel_court_hours) {
    throw err.conflictState(
      `A booking can only be moved up to ${settings.cancel_court_hours} hours before it starts.`,
      { window_hours: settings.cancel_court_hours },
    );
  }
}

/**
 * Làm gì: tìm sân đích và kiểm tra sân cùng môn, đang sẵn sàng sử dụng.
 *   Không gửi court_id thì giữ sân cũ; gửi chuỗi rỗng vẫn phải tìm sân theo chuỗi đó.
 * Được gọi ở: bookingsReschedule, bước 5.
 * @param sql Kết nối database trong transaction của request.
 * @param booking Lượt đặt đã qua kiểm tra quyền sở hữu và hạn đổi.
 * @param body Body JSON từ readBookingsRescheduleForm; dùng trường court_id.
 * @returns Mã sân đích và thông tin sân để kiểm tra giá, lưu và thông báo.
 * @throws Lỗi 404 NOT_FOUND nếu sân cũ hoặc sân đích không tồn tại.
 *   Lỗi 400 VALIDATION ở court_id nếu khác môn; lỗi 422 BR-06 nếu sân chưa sẵn sàng.
 *   Lỗi database được chuyển tiếp cho router; lỗi không ánh xạ được trả HTTP 500.
 */
async function readBookingsRescheduleDestination(
  sql: Sql,
  booking: BookingsRescheduleBooking,
  body: Record<string, unknown>,
): Promise<BookingsRescheduleDestination> {
  const previousCourt = await courtById(sql, booking.court_id);

  // Phải đọc sân cũ trước; ?? giữ nguyên chuỗi rỗng thay vì coi là bỏ trống.
  const courtId = str(body.court_id) ?? booking.court_id;
  let court = previousCourt;

  if (courtId !== booking.court_id) {
    court = await courtById(sql, courtId);
  }

  if (court.sport !== previousCourt.sport) {
    throw err.field("court_id", "A booking can only move to a court of the same sport.");
  }

  if (court.status !== "ready") {
    throw err.br("BR-06", "That court is not available.");
  }

  return { courtId, court };
}

/**
 * Làm gì: kiểm tra khung giờ mới và tính giờ kết thúc theo độ dài một lượt đặt.
 *   Vì sao: không nhận lại đúng sân và giờ cũ; giờ mới phải tuân thủ lịch mở cửa và hạn đặt trước.
 * Được gọi ở: bookingsReschedule, bước 6.
 * @param booking Lượt đặt cũ dùng để nhận biết yêu cầu không thay đổi gì.
 * @param destination Sân đích đã kiểm tra ở bước 5.
 * @param start Giờ bắt đầu mới từ readBookingsRescheduleForm.
 * @param settings Cấu hình trung tâm đã đọc ở bước 3.
 * @returns Giờ kết thúc của lượt đặt mới.
 * @throws Lỗi 400 VALIDATION ở start_at nếu chọn lại khung cũ, giờ không hợp lệ,
 *   lệch lưới giờ hoặc kết thúc sau giờ đóng cửa.
 *   Lỗi 422 BR-07 nếu giờ ở quá khứ, BR-06 nếu ngoài giờ mở cửa,
 *   BR-05 nếu vượt số ngày được đặt trước.
 */
async function checkBookingsRescheduleTime(
  booking: BookingsRescheduleBooking,
  destination: BookingsRescheduleDestination,
  start: Date,
  settings: BookingsRescheduleSettings,
): Promise<Date> {
  const sameCourtAndStart =
    destination.courtId === booking.court_id &&
    start.getTime() === new Date(booking.start_at).getTime();

  if (sameCourtAndStart) {
    throw err.field("start_at", "That is the slot you already have.");
  }

  const { end } = slotBounds(start, settings.slot_minutes);
  await assertBookWindow(start, { walkIn: false, settings });

  return end;
}

/**
 * Làm gì: kiểm tra giờ mới có trùng lịch sân hoặc lớp học của thành viên không.
 *   Vì sao: không được dùng hai sân cùng lúc; trùng lớp chỉ được tiếp tục khi xác nhận rõ ràng.
 * Được gọi ở: bookingsReschedule, bước 7.
 * @param sql Kết nối database trong transaction của request.
 * @param user Người đăng nhập; dùng id để kiểm tra lịch cá nhân.
 * @param booking Lượt đặt đang đổi; bỏ qua chính lượt này khi tìm sân trùng.
 * @param form Body và giờ bắt đầu mới đã đọc ở bước 2.
 * @param end Giờ kết thúc trả về từ checkBookingsRescheduleTime.
 * @returns Không trả dữ liệu; kết thúc bình thường nghĩa là lịch cá nhân cho phép đổi.
 * @throws Lỗi 422 BR-05 nếu trùng lượt đặt sân khác.
 *   Lỗi 422 BR-09 kèm requires_confirm nếu trùng lớp và confirm_overlap không phải true.
 *   Lỗi database được chuyển tiếp cho router; lỗi không ánh xạ được trả HTTP 500.
 */
async function checkBookingsRescheduleMemberSchedule(
  sql: Sql,
  user: PublicUser,
  booking: BookingsRescheduleBooking,
  form: BookingsRescheduleForm,
  end: Date,
): Promise<void> {
  await assertNoCourtOverlap(sql, user.id, form.start, end, booking.id);
  const overlappingClass = await overlapClass(sql, user.id, form.start, end);

  const classOverlapNeedsConfirmation =
    overlappingClass && form.body.confirm_overlap !== true;

  if (classOverlapNeedsConfirmation) {
    throw err.br("BR-09", "This slot clashes with a class you are in. Confirm to move it anyway.", {
      requires_confirm: true,
    });
  }
}

/**
 * Làm gì: kiểm tra đổi lịch có giữ nguyên số tiền đã trả không.
 *   Vì sao: giờ trong gói dùng được cho mọi khung giờ; lượt trả bằng tiền chỉ đổi sang khung cùng giá.
 * Được gọi ở: bookingsReschedule, bước 8.
 * @param sql Kết nối database trong transaction của request.
 * @param user Người đăng nhập; dùng id để tìm mức phí thành viên ở giờ mới.
 * @param booking Lượt đặt cũ chứa giá đã trả, giảm giá và số giờ dùng từ gói.
 * @param destination Sân đích đã kiểm tra ở bước 5.
 * @param start Giờ bắt đầu mới đã kiểm tra.
 * @param settings Cấu hình trung tâm dùng để tính phí thành viên và làm tròn tiền.
 * @returns Không trả dữ liệu; kết thúc bình thường nghĩa là giá cho phép đổi.
 * @throws Lỗi 422 BR-37 nếu chưa có giá hợp lệ cho khung mới.
 *   Lỗi 409 CONFLICT_STATE nếu giá mới khác giá đã trả.
 *   Lỗi database được chuyển tiếp cho router; lỗi không ánh xạ được trả HTTP 500.
 */
async function checkBookingsReschedulePrice(
  sql: Sql,
  user: PublicUser,
  booking: BookingsRescheduleBooking,
  destination: BookingsRescheduleDestination,
  start: Date,
  settings: BookingsRescheduleSettings,
): Promise<void> {
  // Plan hours pay for any slot; money only moves between slots of equal price.
  const usesPlanHours = Number(booking.quota_hours) > 0;
  if (usesPlanHours) {
    return;
  }

  const listedPrice = await lookupPrice(sql, {
    sport: destination.court.sport,
    courtId: destination.courtId,
    start,
  });
  const memberFee = await memberCourtFee(sql, user.id, start, settings);

  let newPrice: number;
  if (memberFee) {
    newPrice = memberFee.fee_vnd;
  } else {
    newPrice =
      applyDiscount(listedPrice.price_vnd, booking.discount_pct, settings.round_vnd) -
      (booking.promo_discount_vnd ?? 0);
  }

  if (newPrice !== booking.price_vnd) {
    throw err.conflictState(
      "That slot is priced differently from the one you paid for. Cancel this booking and book the new slot instead.",
      { paid_vnd: booking.price_vnd, new_price_vnd: newPrice },
    );
  }
}

/**
 * Làm gì: khóa sân đích rồi chuyển dòng chiếm sân sang khung giờ mới.
 *   Vì sao: cập nhật ngay dòng cũ giúp nhả chỗ cũ và lấy chỗ mới trong cùng transaction;
 *   ràng buộc database vẫn quyết định cuối cùng xem khung giờ có bị trùng không.
 * Được gọi ở: bookingsReschedule, bước 9.
 * @param sql Kết nối database trong transaction của request.
 * @param booking Lượt đặt cũ; dùng occupancy_id để tìm dòng chiếm sân.
 * @param destination Sân đích đã qua các bước kiểm tra.
 * @param start Giờ bắt đầu mới đã kiểm tra.
 * @param end Giờ kết thúc mới từ checkBookingsRescheduleTime.
 * @returns Không trả dữ liệu; dòng chiếm sân đã được cập nhật trong transaction.
 * @throws Lỗi 409 CONFLICT_SLOT với thông báo "Someone just took that slot."
 *   nếu cập nhật dòng chiếm sân gặp lỗi trùng lịch.
 *   Lỗi khác được chuyển tiếp cho router; lỗi không ánh xạ được trả HTTP 500.
 */
async function moveBookingsRescheduleOccupancy(
  sql: Sql,
  booking: BookingsRescheduleBooking,
  destination: BookingsRescheduleDestination,
  start: Date,
  end: Date,
): Promise<void> {
  await sql.query(`select 1 from courts where id = $1 for update`, [destination.courtId]);

  // Chỉ đổi thông báo lỗi trùng phát sinh khi cập nhật occupancy, không bắt lỗi khóa sân.
  try {
    await sql.query(
      `update occupancies set court_id = $2, start_at = $3, end_at = $4 where id = $1`,
      [booking.occupancy_id, destination.courtId, start.toISOString(), end.toISOString()],
    );
  } catch (error) {
    if (isConflictSlot(error)) {
      throw err.conflictSlot("Someone just took that slot.");
    }
    throw error;
  }
}

/**
 * Làm gì: cập nhật sân và giờ trên lượt đặt sau khi chuyển chỗ chiếm sân thành công.
 * Được gọi ở: bookingsReschedule, bước 10.
 * @param sql Kết nối database trong transaction của request.
 * @param booking Lượt đặt cũ; dùng id để xác định dòng cần cập nhật.
 * @param destination Sân đích đã nhận chỗ ở bước 9.
 * @param start Giờ bắt đầu mới đã kiểm tra.
 * @param end Giờ kết thúc mới từ checkBookingsRescheduleTime.
 * @returns Không trả dữ liệu; lượt đặt đã được cập nhật trong transaction.
 * @throws Lỗi database được chuyển tiếp cho router; lỗi không ánh xạ được trả HTTP 500.
 */
async function updateBookingsRescheduleBooking(
  sql: Sql,
  booking: BookingsRescheduleBooking,
  destination: BookingsRescheduleDestination,
  start: Date,
  end: Date,
): Promise<void> {
  await sql.query(
    `update court_bookings set court_id = $2, start_at = $3, end_at = $4 where id = $1`,
    [booking.id, destination.courtId, start.toISOString(), end.toISOString()],
  );
}

/**
 * Làm gì: đưa thông báo đổi lịch vào hàng đợi thông báo trong ứng dụng.
 * Được gọi ở: bookingsReschedule, bước 11.
 * @param sql Kết nối database trong transaction của request.
 * @param user Người đăng nhập cũng là người nhận thông báo.
 * @param booking Lượt đặt đã kiểm tra; dùng id và code trong thông báo.
 * @param destination Sân đích; dùng court_code để người nhận biết sân mới.
 * @param start Giờ bắt đầu mới dùng trong nội dung và khóa chống thông báo trùng.
 * @returns Không trả dữ liệu; thông báo đã được đưa vào hàng đợi.
 * @throws Lỗi từ enqueue được chuyển tiếp cho router; lỗi không ánh xạ được trả HTTP 500.
 */
async function enqueueBookingsRescheduleNotification(
  sql: Sql,
  user: PublicUser,
  booking: BookingsRescheduleBooking,
  destination: BookingsRescheduleDestination,
  start: Date,
): Promise<void> {
  await enqueue(
    sql,
    "inapp",
    "booking_rescheduled",
    user.id,
    {
      booking_id: booking.id,
      code: booking.code,
      court_code: destination.court.court_code,
      start_at: start.toISOString(),
    },
    `booking_rescheduled|${booking.id}|${start.toISOString()}`,
  );
}

/**
 * Làm gì: ghi nhật ký ai đã đổi lịch, từ sân và giờ nào sang sân và giờ nào.
 * Được gọi ở: bookingsReschedule, bước 12.
 * @param sql Kết nối database trong transaction của request.
 * @param user Người đăng nhập thực hiện đổi lịch; id được lưu làm người thao tác.
 * @param booking Dữ liệu lượt đặt đọc trước khi cập nhật, dùng làm giá trị cũ.
 * @param destination Sân đích đã lưu, dùng làm giá trị mới.
 * @param start Giờ bắt đầu mới đã lưu.
 * @returns Không trả dữ liệu; nhật ký đã được ghi trong transaction.
 * @throws Lỗi từ audit được chuyển tiếp cho router; lỗi không ánh xạ được trả HTTP 500.
 */
async function auditBookingsRescheduleChange(
  sql: Sql,
  user: PublicUser,
  booking: BookingsRescheduleBooking,
  destination: BookingsRescheduleDestination,
  start: Date,
): Promise<void> {
  await audit(
    sql,
    user.id,
    "reschedule_booking",
    "booking",
    booking.id,
    { start_at: booking.start_at, court_id: booking.court_id },
    {
      start_at: start.toISOString(),
      court_id: destination.courtId,
    },
  );
}

/**
 * Làm gì: đọc lại lượt đặt sau khi lưu để tạo phản hồi cho màn hình.
 * Được gọi ở: bookingsReschedule, bước 13.
 * @param sql Kết nối database trong transaction của request.
 * @param booking Lượt đặt đã xử lý; dùng id để đọc lại dữ liệu.
 * @returns Phản hồi HTTP 200 với body.booking lấy từ database.
 * @throws Lỗi database được chuyển tiếp cho router; lỗi không ánh xạ được trả HTTP 500.
 */
async function readBookingsRescheduleResponse(
  sql: Sql,
  booking: BookingsRescheduleBooking,
): Promise<Reply<RescheduleResponse>> {
  const updatedBooking = await one<Booking>(
    sql,
    `select ${BOOKING_COLS} from court_bookings where id = $1`,
    [booking.id],
  );

  // Giữ nguyên hành vi cũ: dấu ! chỉ phục vụ TypeScript, không thêm kiểm tra lúc chạy.
  return { status: 200, body: { booking: updatedBooking! } };
}

/**
 * Làm gì: chuyển lượt đặt sân đã xác nhận sang sân hoặc giờ mới, không thay đổi tiền.
 *   Đọc hàm này như mục lục: mỗi bước gọi một phần xử lý ở phía trên.
 *   Vì sao giữ thứ tự: lỗi ở bước trước phải được báo trước; mọi cập nhật và thông báo
 *   cùng nằm trong transaction do router mở, có lỗi thì rollback.
 * Được gọi ở:
 *   - Màn hình /app/book (src/routes/app.book.tsx), nút "Change time" gọi startMove;
 *     sau đó chọn ô giờ trống trên CourtGrid sẽ gọi moveTo trong useCourtBooking
 *     (src/client/lib/pages/app.book.ts).
 *   - moveTo gửi POST /v1/bookings/:id/reschedule. Nếu trùng lớp, nút
 *     "Move it anyway" gọi lại moveTo với confirm_overlap: true.
 *   - src/server/controllers/router.ts nhận API qua dispatch, gọi
 *     authed((sql, user) => bookH.bookingsReschedule(sql, p1, request, user)).
 *     authed mở transaction bằng withTx và xác thực bằng authFromRequest.
 * @param sql Kết nối database trong transaction do router mở.
 * @param id Mã lượt đặt lấy từ :id trong đường dẫn API.
 * @param request Request chứa start_at, court_id tùy chọn và confirm_overlap tùy chọn.
 * @param user Người đăng nhập do router xác thực; chỉ member được đổi lượt đặt của mình.
 * @returns Phản hồi HTTP 200, body.booking là lượt đặt được đọc lại sau khi đổi.
 * @throws Lỗi 400 VALIDATION nếu sân hoặc giờ không hợp lệ; 403 FORBIDDEN nếu sai
 *   vai trò hoặc không sở hữu lượt đặt; 404 NOT_FOUND nếu không tìm thấy lượt đặt hoặc sân;
 *   409 CONFLICT_STATE nếu không được đổi hoặc khác giá; 409 CONFLICT_SLOT nếu chỗ bị lấy;
 *   422 VALIDATION nếu body không hợp lệ; 422 BR_VIOLATION cho BR-05, BR-06, BR-07,
 *   BR-09 hoặc BR-37. Lỗi khác chuyển cho router xử lý, HTTP 500 nếu không ánh xạ được.
 *
 * Move a confirmed booking to another slot (M-04).
 *
 * The same window as cancelling decides whether it is allowed — a change is
 * "cancel and rebook" without the member losing the court in between — and the
 * move is one transaction: the occupancy row is updated in place, so the old
 * slot is freed and the new one taken together, or neither happens. The overlap
 * trigger is still the last word. Money does not move: a slot that would cost a
 * different amount is refused rather than adjusted, because the SRS has no
 * formula for the difference; cancel and rebook is the path for that.
 */
export async function bookingsReschedule(
  sql: Sql,
  id: string,
  request: Request,
  user: PublicUser,
): Promise<Reply<RescheduleResponse>> {
  // Bước 1: chỉ thành viên mới được dùng chức năng đổi lịch này.
  requireRole(user, ["member"]);

  // Bước 2: kiểm tra giờ gửi lên trước khi đọc dữ liệu trong database.
  const form = await readBookingsRescheduleForm(request);

  // Bước 3: lấy cấu hình để áp dụng hạn đổi, giờ mở cửa và cách tính giá.
  const settings = await getSettings(sql);

  // Bước 4: khóa lượt đặt rồi kiểm tra quyền sở hữu, trạng thái và hạn đổi.
  const booking = await lockBookingsRescheduleBooking(sql, id);
  checkBookingsRescheduleEligibility(booking, user, settings);

  // Bước 5: chỉ cho chuyển sang sân cùng môn và đang sẵn sàng.
  const destination = await readBookingsRescheduleDestination(sql, booking, form.body);

  // Bước 6: bảo đảm khung giờ mới có thay đổi và nằm trong giới hạn cho phép.
  const end = await checkBookingsRescheduleTime(booking, destination, form.start, settings);

  // Bước 7: chặn trùng sân cá nhân và yêu cầu xác nhận nếu trùng lớp học.
  await checkBookingsRescheduleMemberSchedule(sql, user, booking, form, end);

  // Bước 8: không đổi sang khung khác giá đối với lượt đã trả bằng tiền.
  await checkBookingsReschedulePrice(sql, user, booking, destination, form.start, settings);

  // Bước 9: chuyển chỗ chiếm sân trước để database quyết định khung mới còn trống không.
  await moveBookingsRescheduleOccupancy(sql, booking, destination, form.start, end);

  // Bước 10: đồng bộ lượt đặt với chỗ chiếm sân vừa chuyển thành công.
  await updateBookingsRescheduleBooking(sql, booking, destination, form.start, end);

  // Bước 11: báo cho thành viên biết sân và giờ mới.
  await enqueueBookingsRescheduleNotification(sql, user, booking, destination, form.start);

  // Bước 12: lưu giá trị trước và sau để truy lại thao tác đổi lịch.
  await auditBookingsRescheduleChange(sql, user, booking, destination, form.start);

  // Bước 13: trả dữ liệu đọc lại từ database để phản ánh kết quả đã lưu.
  return readBookingsRescheduleResponse(sql, booking);
}

/**
 * Làm gì: thực hiện check-in vào sân cho lượt đặt sân đã xác nhận, chuyển trạng thái sang in_use.
 *   Vì sao: xác nhận người chơi có mặt đúng giờ; chỉ cho phép nhận sân trong khung giờ quy định theo BR-11.
 * Được gọi ở:
 *   - Route POST /v1/bookings/:id/check-in qua authed trong src/server/controllers/router.ts.
 *   - Quét mã QR vào cổng trong checkInQrScan (src/server/controllers/handlers/checkin.ts).
 * @param sql Kết nối database trong transaction do router quản lý.
 * @param id Mã lượt đặt sân (court_bookings.id) cần làm thủ tục check-in.
 * @param user Người đăng nhập thực hiện thao tác; yêu cầu vai trò receptionist hoặc manager.
 * @returns Phản hồi HTTP 200 kèm body { status: "in_use" }.
 * @throws Lỗi 403 FORBIDDEN nếu người dùng không có vai trò receptionist hoặc manager.
 * @throws Lỗi 404 NOT_FOUND nếu không tìm thấy lượt đặt sân với id tương ứng.
 * @throws Lỗi 409 CONFLICT_STATE nếu lượt đặt không ở trạng thái "confirmed".
 * @throws Lỗi 422 BR-11 nếu thời điểm check-in nằm ngoài khung giờ cho phép (−15/+10 phút so với giờ bắt đầu).
 */
export async function bookingsCheckIn(sql: Sql, id: string, user: PublicUser): Promise<Reply<CheckInResponse>> {
  // Bước 1: chỉ lễ tân hoặc quản lý mới có quyền xác nhận khách vào sân.
  requireRole(user, ["receptionist", "manager"]);
  // Bước 2: đọc cấu hình trung tâm để lấy quy định về khung giờ check-in cho phép.
  const settings = await getSettings(sql);
  // Bước 3: khóa dòng lượt đặt sân để kiểm tra trạng thái và tránh xung đột khi xử lý đồng thời.
  const booking = await one<Pick<Booking, "id" | "status" | "start_at">>(
    sql,
    `select id, status, start_at from court_bookings where id = $1 for update`,
    [id],
  );
  if (!booking) throw err.notFound();
  // Chỉ lượt đặt ở trạng thái đã xác nhận (confirmed) mới được phép check-in vào sân.
  if (booking.status !== "confirmed") throw err.conflictState("Only confirmed bookings can be checked in.");
  // Bước 4: kiểm tra thời điểm hiện tại có nằm trong khung giờ check-in hợp lệ theo BR-11 không.
  const start = new Date(booking.start_at).getTime();
  const now = Date.now();
  // Quy đổi phút ra mili-giây (* 60.000): cho phép vào sớm tối đa checkin_before_minutes (15 phút) và trễ tối đa noshow_grace_minutes (10 phút).
  const min = start - settings.checkin_before_minutes * 60_000;
  const max = start + settings.noshow_grace_minutes * 60_000;
  if (now < min || now > max) {
    throw err.br("BR-11", "Outside the check-in window of −15/+10 minutes.");
  }
  // Bước 5: cập nhật trạng thái lượt đặt sang "in_use" để ghi nhận khách đang sử dụng sân.
  await sql.query(`update court_bookings set status = 'in_use' where id = $1`, [id]);
  return { status: 200, body: { status: "in_use" } };
}

type WalkInForm = {
  body: Record<string, unknown>;
  courtId: string | undefined;
  startAt: string | undefined;
  guestName: string | undefined;
  guestPhoneRaw: string | undefined;
  method: string;
};

type WalkInCompleteForm = WalkInForm & {
  courtId: string;
  startAt: string;
  guestName: string;
  guestPhoneRaw: string;
};

type WalkInSettings = Awaited<ReturnType<typeof getSettings>>;
type WalkInCourt = Awaited<ReturnType<typeof courtById>>;
type WalkInSlot = { start: Date; end: Date };
type WalkInMember = { id: string; full_name: string };
type WalkInPaymentRow = { id: string };

/**
 * Làm gì: đọc các ô của form khách vãng lai và giữ lại body để ghi ca thu ngân ở bước sau.
 *   Phương thức thanh toán không phải chuỗi thì mặc định cash; chuỗi rỗng vẫn giữ nguyên để báo lỗi.
 * Được gọi ở: walkIn, bước 2.
 * @param request Request POST /v1/walk-in chứa body JSON từ form tại quầy.
 * @returns Các ô đã qua str; chưa kiểm tra thiếu dữ liệu.
 * @throws Lỗi 422 VALIDATION nếu readJson từ chối JSON hoặc nội dung body.
 */
async function readWalkInForm(request: Request): Promise<WalkInForm> {
  const body = await readJson(request);
  const courtId = str(body.court_id);
  const startAt = str(body.start_at);
  const guestName = str(body.guest_name);
  const guestPhoneRaw = str(body.guest_phone);
  const method = str(body.method) ?? "cash";

  return { body, courtId, startAt, guestName, guestPhoneRaw, method };
}

/**
 * Làm gì: chắc chắn đã nhập sân, giờ bắt đầu, tên và số điện thoại.
 *   Vì sao kiểm tra trước phương thức thanh toán: thiếu ô bắt buộc phải được báo trước.
 * Được gọi ở: walkIn, bước 2, sau readWalkInForm.
 * @param form Các ô vừa đọc từ request.
 * @returns Không trả dữ liệu; xác nhận form có đủ các chuỗi bắt buộc cho TypeScript.
 * @throws Lỗi 422 VALIDATION nếu một ô bắt buộc là undefined hoặc chuỗi rỗng.
 */
function checkWalkInRequiredFields(
  form: WalkInForm,
): asserts form is WalkInCompleteForm {
  const requiredFieldIsMissing =
    !form.courtId || !form.startAt || !form.guestName || !form.guestPhoneRaw;

  if (requiredFieldIsMissing) {
    throw err.validation("Court, time, name or phone is missing.");
  }
}

/**
 * Làm gì: chỉ cho phép thu tiền bằng cash, card hoặc transfer.
 * Được gọi ở: walkIn, bước 3, trước khi kiểm tra số điện thoại.
 * @param method Phương thức đã đọc từ form; mặc định cash khi str trả undefined.
 * @returns Không trả dữ liệu khi phương thức hợp lệ.
 * @throws Lỗi 400 VALIDATION ở field method nếu phương thức không được hỗ trợ.
 */
function checkWalkInPaymentMethod(method: string): void {
  const allowedWalkInMethods: readonly string[] = ["cash", "card", "transfer"];

  if (!allowedWalkInMethods.includes(method)) {
    throw err.field("method", `Payment method must be one of ${allowedWalkInMethods.join(", ")}.`);
  }
}

/**
 * Làm gì: chuẩn hóa số điện thoại rồi kiểm tra định dạng điện thoại Việt Nam.
 *   Vì sao chuẩn hóa trước: dùng cùng một số để tìm tài khoản, lưu booking và xuất hóa đơn.
 * Được gọi ở: walkIn, bước 3, sau checkWalkInPaymentMethod.
 * @param guestPhoneRaw Số điện thoại đã qua str và kiểm tra không rỗng.
 * @returns Số điện thoại đã chuẩn hóa.
 * @throws Lỗi 422 VALIDATION với field phone nếu số điện thoại không hợp lệ.
 */
function readWalkInGuestPhone(guestPhoneRaw: string): string {
  const guestPhone = normalizePhone(guestPhoneRaw);

  if (!isValidVnPhone(guestPhone)) {
    throw err.validation("That phone number is not valid.", { field: "phone" });
  }

  return guestPhone;
}

/**
 * Làm gì: tính giờ kết thúc và kiểm tra khung giờ được phép nhận khách vãng lai.
 *   Vì sao: ca đã bắt đầu phải còn ít nhất 20 phút, nằm trong giờ mở cửa và đúng lưới đặt sân.
 * Được gọi ở: walkIn, bước 4, sau khi đọc cấu hình trung tâm.
 * @param startAt Chuỗi giờ bắt đầu đã kiểm tra không rỗng từ form.
 * @param settings Cấu hình vừa lấy bằng getSettings.
 * @returns Giờ bắt đầu và kết thúc của một ca thuê sân.
 * @throws Lỗi 400 VALIDATION ở field start_at nếu giờ sai, lệch lưới hoặc kết thúc sau giờ đóng cửa.
 * @throws Lỗi 422 BR_VIOLATION, BR-07 nếu còn dưới 20 phút; BR-06 nếu ngoài giờ mở cửa.
 */
async function readWalkInSlot(
  startAt: string,
  settings: WalkInSettings,
): Promise<WalkInSlot> {
  const start = new Date(startAt);

  if (Number.isNaN(start.getTime())) {
    throw err.field("start_at", "That time is not valid.");
  }

  const { end } = slotBounds(start, settings.slot_minutes);
  await assertBookWindow(start, { walkIn: true, settings });

  return { start, end };
}

/**
 * Làm gì: lấy thông tin sân và chắc chắn sân đang ở trạng thái ready.
 * Được gọi ở: walkIn, bước 5, sau khi khung giờ đã hợp lệ.
 * @param sql Kết nối database trong transaction do router mở.
 * @param courtId Mã sân lấy từ form đã đủ ô bắt buộc.
 * @returns Dòng sân để tra giá và ghi mô tả hóa đơn.
 * @throws Lỗi 404 NOT_FOUND nếu không có sân; lỗi 422 BR_VIOLATION, BR-06 nếu sân không ready.
 * @throws Lỗi truy vấn được truyền nguyên trạng cho router xử lý, không tự đổi mã HTTP.
 */
async function readWalkInReadyCourt(sql: Sql, courtId: string): Promise<WalkInCourt> {
  const court = await courtById(sql, courtId);

  if (court.status !== "ready") {
    throw err.br("BR-06", "That court is not available.");
  }

  return court;
}

/**
 * Làm gì: với lễ tân, tìm ca thu ngân đang mở và ghi mã ca vào body để dùng khi lưu thanh toán.
 *   Vì sao: lễ tân phải mở ca trước khi nhận tiền; quản lý không cần kiểm tra ca.
 * Được gọi ở: walkIn, bước 6.
 * @param sql Kết nối database trong transaction do router mở.
 * @param user Người đang đăng nhập, đã qua kiểm tra vai trò.
 * @param body Body gốc được giữ lại trong form; hàm ghi thêm _shift khi người thao tác là lễ tân.
 * @returns Không trả dữ liệu; quản lý đi qua mà không truy vấn hoặc sửa body.
 * @throws Lỗi 422 BR_VIOLATION, BR-44 nếu lễ tân chưa mở ca.
 * @throws Lỗi truy vấn được truyền nguyên trạng cho router xử lý, không tự đổi mã HTTP.
 */
async function checkWalkInCashierShift(
  sql: Sql,
  user: PublicUser,
  body: Record<string, unknown>,
): Promise<void> {
  if (user.role === "receptionist") {
    const shift = await one<{ id: string }>(
      sql,
      `select id from cashier_shifts where receptionist_id = $1 and closed_at is null`,
      [user.id],
    );

    if (!shift) {
      throw err.br("BR-44", "Open a till shift before taking payment.");
    }

    (body as { _shift?: string })._shift = shift.id;
  }
}

/**
 * Làm gì: tìm tài khoản có số điện thoại trùng với số khách vừa cung cấp.
 *   Không tìm thấy vẫn được đặt sân với tư cách khách vãng lai.
 * Được gọi ở: walkIn, bước 7, trước khi tra giá sân.
 * @param sql Kết nối database trong transaction do router mở.
 * @param guestPhone Số điện thoại đã chuẩn hóa và kiểm tra.
 * @returns Tài khoản tìm được, hoặc undefined nếu chưa có tài khoản.
 * @throws Lỗi truy vấn được truyền nguyên trạng cho router xử lý, không tự đổi mã HTTP.
 */
async function findWalkInMember(
  sql: Sql,
  guestPhone: string,
): Promise<WalkInMember | undefined> {
  return one<WalkInMember>(
    sql,
    `select id, full_name from users where phone = $1`,
    [guestPhone],
  );
}

/**
 * Làm gì: tính số tiền phải thu cho ca thuê sân.
 *   Vì sao: tài khoản có gói tập bao phủ ngày chơi trả phí hội viên; trường hợp còn lại trả giá sân đã làm tròn.
 *   Tài khoản đã có sân trùng giờ bị từ chối trước khi kiểm tra quyền lợi gói tập.
 * Được gọi ở: walkIn, bước 7, sau findWalkInMember.
 * @param sql Kết nối database trong transaction do router mở.
 * @param court Sân đã được kiểm tra ready; dùng môn thể thao để tra giá.
 * @param courtId Mã sân lấy từ form.
 * @param slot Giờ bắt đầu và kết thúc đã kiểm tra.
 * @param member Tài khoản khớp số điện thoại, hoặc undefined.
 * @param settings Cấu hình giá hội viên, thời lượng ca và bước làm tròn.
 * @returns Số tiền phải thu, chưa cộng thêm bất kỳ khoản giảm giá nào.
 * @throws Lỗi 422 BR_VIOLATION, BR-05 nếu tài khoản đã có sân trùng giờ.
 * @throws Lỗi từ tra giá, kiểm tra gói tập hoặc database được truyền nguyên trạng cho router xử lý.
 */
async function calculateWalkInPrice(
  sql: Sql,
  court: WalkInCourt,
  courtId: string,
  slot: WalkInSlot,
  member: WalkInMember | undefined,
  settings: WalkInSettings,
): Promise<number> {
  const listPrice = await lookupPrice(sql, {
    sport: court.sport,
    courtId,
    start: slot.start,
  });

  // A known member whose membership covers the date pays the member fee; everyone else the slot price.
  if (member) {
    await assertNoCourtOverlap(sql, member.id, slot.start, slot.end);
  }

  let membershipCoverage: Awaited<ReturnType<typeof memberCourtFee>> = null;
  if (member) {
    membershipCoverage = await memberCourtFee(sql, member.id, slot.start, settings);
  }

  if (membershipCoverage) {
    return membershipCoverage.fee_vnd;
  }

  return roundVnd(listPrice.price_vnd, settings.round_vnd);
}

/**
 * Làm gì: xin UUID cho booking trước khi chiếm sân.
 *   Vì sao: bản ghi chiếm sân cần biết trước mã booking mà nó thuộc về.
 * Được gọi ở: walkIn, bước 8, trước attachWalkInOccupancy.
 * @param sql Kết nối database trong transaction do router mở.
 * @returns UUID do database tạo.
 * @throws Lỗi truy vấn được truyền nguyên trạng; kết quả thiếu dòng gây lỗi runtime như bản gốc
 *   và được router xử lý thành lỗi 500.
 */
async function createWalkInBookingId(sql: Sql): Promise<string> {
  return (await one<{ id: string }>(sql, `select gen_random_uuid() as id`))!.id;
}

/**
 * Làm gì: ghi nhận sân đã được booking này chiếm trong khoảng giờ đã chọn.
 *   Vì sao: database quyết định xung đột cuối cùng khi nhiều người cùng đặt một ca.
 * Được gọi ở: walkIn, bước 8, sau createWalkInBookingId.
 * @param sql Kết nối database trong transaction do router mở.
 * @param courtId Mã sân lấy từ form.
 * @param slot Khoảng giờ đã được kiểm tra.
 * @param bookingId UUID vừa tạo cho booking.
 * @returns Mã bản ghi chiếm sân để lưu vào booking.
 * @throws Lỗi 409 CONFLICT_SLOT nếu database báo xung đột ca.
 * @throws Lỗi khác được ném lại nguyên trạng; thiếu dòng kết quả gây lỗi runtime, router trả 500.
 */
async function attachWalkInOccupancy(
  sql: Sql,
  courtId: string,
  slot: WalkInSlot,
  bookingId: string,
): Promise<string> {
  try {
    const occupancy = await one<{ id: string }>(
      sql,
      `select occupancy_attach($1::uuid, $2::timestamptz, $3::timestamptz, 'booking'::occ_kind, $4::uuid) as id`,
      [courtId, slot.start.toISOString(), slot.end.toISOString(), bookingId],
    );

    return occupancy!.id;
  } catch (error) {
    if (isConflictSlot(error)) {
      throw err.conflictSlot("Someone just took that slot.");
    }

    throw error;
  }
}

/**
 * Làm gì: cấp mã CRT và lưu booking đã xác nhận, kênh walkin, đã trả đủ tiền.
 * Được gọi ở: walkIn, bước 9, sau khi chiếm sân thành công.
 * @param sql Kết nối database trong transaction do router mở.
 * @param form Form đã đủ ô bắt buộc.
 * @param guestPhone Số điện thoại đã chuẩn hóa.
 * @param member Tài khoản tìm theo điện thoại, hoặc undefined để lưu user_id là null.
 * @param slot Khoảng giờ thuê sân đã kiểm tra.
 * @param settings Cấu hình chứa thuế suất.
 * @param bookingId UUID đã tạo cho booking.
 * @param occupancyId Mã bản ghi chiếm sân vừa tạo.
 * @param price Số tiền đã tính cho ca thuê.
 * @param discount Phần trăm giảm giá; luồng walkIn hiện luôn truyền 0.
 * @returns Không trả dữ liệu sau khi lưu booking.
 * @throws Lỗi cấp mã hoặc truy vấn được truyền nguyên trạng cho router xử lý, không tự đổi mã HTTP.
 */
async function insertWalkInBooking(
  sql: Sql,
  form: WalkInCompleteForm,
  guestPhone: string,
  member: WalkInMember | undefined,
  slot: WalkInSlot,
  settings: WalkInSettings,
  bookingId: string,
  occupancyId: string,
  price: number,
  discount: number,
): Promise<void> {
  const code = await nextCode(sql, "CRT");

  await sql.query(
    `insert into court_bookings
       (id, code, court_id, user_id, guest_name, guest_phone, start_at, end_at, status, channel,
        price_vnd, discount_pct, vat_rate, occupancy_id, paid_vnd)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed','walkin',$9,$10,$11,$12,$13)`,
    [
      bookingId,
      code,
      form.courtId,
      member?.id ?? null,
      form.guestName,
      guestPhone,
      slot.start.toISOString(),
      slot.end.toISOString(),
      price,
      discount,
      Number(settings.vat_rate),
      occupancyId,
      price,
    ],
  );
}

/**
 * Làm gì: cấp mã PAY và lưu khoản tiền đã thu với trạng thái posted.
 *   Vì sao chỉ gắn ca cho lễ tân: quản lý thu tiền không dùng ca thu ngân trong luồng này.
 * Được gọi ở: walkIn, bước 10, sau khi lưu booking.
 * @param sql Kết nối database trong transaction do router mở.
 * @param user Người thao tác; id được ghi vào created_by.
 * @param form Form chứa phương thức thanh toán và body đã được ghi _shift ở bước 6.
 * @param member Tài khoản khớp số điện thoại, hoặc undefined.
 * @param settings Cấu hình chứa thuế suất.
 * @param bookingId UUID của booking vừa lưu.
 * @param price Số tiền phải thu đã tính ở bước 7.
 * @returns Dòng chứa id thanh toán, hoặc undefined nếu database không trả dòng.
 * @throws Lỗi cấp mã hoặc truy vấn được truyền nguyên trạng cho router xử lý, không tự đổi mã HTTP.
 */
async function insertWalkInPayment(
  sql: Sql,
  user: PublicUser,
  form: WalkInCompleteForm,
  member: WalkInMember | undefined,
  settings: WalkInSettings,
  bookingId: string,
  price: number,
): Promise<WalkInPaymentRow | undefined> {
  const paymentCode = await nextCode(sql, "PAY");

  let shiftId: string | null = null;
  if (user.role === "receptionist") {
    shiftId = (form.body as { _shift?: string })._shift ?? null;
  }

  return one<WalkInPaymentRow>(
    sql,
    `insert into payments (code, user_id, shift_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by)
     values ($1,$2,$3,$4,$5,$6,'posted','booking',$7,$8) returning id`,
    [
      paymentCode,
      member?.id ?? null,
      shiftId ?? null,
      form.method,
      price,
      Number(settings.vat_rate),
      bookingId,
      user.id,
    ],
  );
}

/**
 * Làm gì: xuất hóa đơn cho khoản tiền vừa thu, dùng tên và điện thoại khách nhập tại quầy.
 * Được gọi ở: walkIn, bước 11, trước khi ghi audit.
 * @param sql Kết nối database trong transaction do router mở.
 * @param paymentRow Dòng id trả về từ insertWalkInPayment.
 * @param form Form đã đủ ô; dùng tên khách.
 * @param guestPhone Số điện thoại đã chuẩn hóa.
 * @param price Số tiền vừa ghi vào thanh toán.
 * @param settings Cấu hình thuế và thông tin pháp lý dùng để xuất hóa đơn.
 * @param court Sân đã kiểm tra; dùng court_code để mô tả dịch vụ.
 * @param slot Khoảng giờ thuê sân; dùng giờ bắt đầu trong mô tả.
 * @returns Mã hóa đơn vừa xuất.
 * @throws Lỗi xuất hóa đơn được truyền nguyên trạng; thiếu paymentRow gây lỗi runtime,
 *   router trả 500 như bản gốc.
 */
async function issueWalkInInvoice(
  sql: Sql,
  paymentRow: WalkInPaymentRow | undefined,
  form: WalkInCompleteForm,
  guestPhone: string,
  price: number,
  settings: WalkInSettings,
  court: WalkInCourt,
  slot: WalkInSlot,
): Promise<string> {
  return issueInvoice(sql, {
    paymentId: paymentRow!.id,
    buyerName: form.guestName,
    buyerPhone: guestPhone,
    amountVnd: price,
    vatRate: Number(settings.vat_rate ?? 0),
    description: `Khách vãng lai — sân ${court.court_code} ${ictStamp(slot.start)}`,
    unit: "lượt",
    settings,
  });
}

/**
 * Làm gì: đọc lại booking trước, thanh toán sau, rồi tạo phản hồi cho màn hình tại quầy.
 * Được gọi ở: walkIn, bước 13, sau khi đã xuất hóa đơn và ghi audit.
 * @param sql Kết nối database trong transaction do router mở.
 * @param bookingId UUID của booking vừa tạo.
 * @param paymentRow Dòng id của khoản thanh toán vừa lưu.
 * @param invoiceId Mã hóa đơn vừa xuất.
 * @returns Phản hồi 201 chứa booking, payment và invoice_id, giữ nguyên dữ liệu database trả về.
 * @throws Lỗi truy vấn được truyền nguyên trạng; thiếu paymentRow gây lỗi runtime, router trả 500.
 */
async function readWalkInResponse(
  sql: Sql,
  bookingId: string,
  paymentRow: WalkInPaymentRow | undefined,
  invoiceId: string,
): Promise<Reply<WalkInResponse>> {
  const booking = await one<Booking>(sql, `select ${BOOKING_COLS} from court_bookings where id = $1`, [bookingId]);
  const payment = await one<Payment>(sql, `select ${PAYMENT_COLS} from payments where id = $1`, [paymentRow!.id]);

  return { status: 201, body: { booking: booking!, payment: payment!, invoice_id: invoiceId } };
}

/**
 * Làm gì: nhận khách đặt sân tại quầy, thu đủ tiền và xuất hóa đơn trong cùng transaction.
 *   Thứ tự các bước quyết định lỗi nào được báo trước và dữ liệu nào được ghi trước.
 * Được gọi ở:
 *   - Màn hình /desk/courts (src/routes/desk.courts.tsx), chọn ca sân rồi nhấn
 *     "Take payment & hold"; apiPost("/walk-in", ..., true) gửi POST /v1/walk-in.
 *   - src/server/controllers/router.ts nhận POST với phần đường dẫn đầu là "walk-in":
 *     authed mở transaction và xác thực người dùng, rồi withIdempotency gọi bookH.walkIn.
 *   - Màn hình dùng payment để báo đã thu tiền, tải lại sơ đồ sân và mở invoice_id.
 * @param sql Kết nối database trong transaction do authed của router mở.
 * @param request Request chứa JSON gồm court_id, start_at, guest_name, guest_phone và method.
 * @param user Người đã đăng nhập; phải là receptionist hoặc manager.
 * @returns Phản hồi 201 chứa booking vừa tạo, payment đã thu và invoice_id.
 * @throws Lỗi 403 FORBIDDEN nếu sai vai trò.
 * @throws Lỗi 400 VALIDATION nếu phương thức thanh toán hoặc giờ bắt đầu không hợp lệ.
 * @throws Lỗi 422 VALIDATION nếu body, ô bắt buộc hoặc số điện thoại không hợp lệ.
 * @throws Lỗi 404 NOT_FOUND nếu sân không tồn tại.
 * @throws Lỗi 422 BR_VIOLATION: BR-07 nếu ca còn quá ít thời gian; BR-06 nếu ngoài giờ
 *   mở cửa hoặc sân không sẵn sàng; BR-44 nếu lễ tân chưa mở ca; BR-05 nếu tài khoản trùng lịch sân.
 * @throws Lỗi 409 CONFLICT_SLOT nếu người khác vừa chiếm ca; lỗi từ các hàm dùng chung
 *   hoặc database được truyền nguyên trạng để router xử lý và rollback transaction.
 */
export async function walkIn(sql: Sql, request: Request, user: PublicUser): Promise<Reply<WalkInResponse>> {
  // Bước 1: chỉ lễ tân hoặc quản lý được nhận khách và thu tiền tại quầy.
  requireRole(user, ["receptionist", "manager"]);

  // Bước 2: đọc form và báo thiếu ô bắt buộc trước các lỗi nghiệp vụ khác.
  const form = await readWalkInForm(request);
  checkWalkInRequiredFields(form);

  // Bước 3: kiểm tra cách thu tiền trước, rồi chuẩn hóa số dùng để nhận diện khách.
  checkWalkInPaymentMethod(form.method);
  const guestPhone = readWalkInGuestPhone(form.guestPhoneRaw);

  // Bước 4: dùng cấu hình trung tâm để xác định ca và kiểm tra thời gian nhận khách.
  const settings = await getSettings(sql);
  const slot = await readWalkInSlot(form.startAt, settings);

  // Bước 5: sân phải tồn tại và sẵn sàng trước khi kiểm tra điều kiện thu tiền.
  const court = await readWalkInReadyCourt(sql, form.courtId);

  // Bước 6: lễ tân phải có ca đang mở để khoản thu được ghi đúng ca.
  await checkWalkInCashierShift(sql, user, form.body);

  // Bước 7: nhận diện tài khoản rồi tính giá, giữ tra giá trước kiểm tra lịch trùng.
  const member = await findWalkInMember(sql, guestPhone);
  const price = await calculateWalkInPrice(
    sql, court, form.courtId, slot, member, settings,
  );
  const discount = 0;

  // Bước 8: tạo mã định danh trước để bản ghi chiếm sân liên kết đúng booking.
  const bookingId = await createWalkInBookingId(sql);
  const occupancyId = await attachWalkInOccupancy(sql, form.courtId, slot, bookingId);

  // Bước 9: chỉ lưu booking đã xác nhận sau khi chiếm sân thành công.
  await insertWalkInBooking(
    sql, form, guestPhone, member, slot, settings, bookingId, occupancyId, price, discount,
  );

  // Bước 10: ghi khoản thu đủ tiền, gắn với booking vừa lưu.
  const paymentRow = await insertWalkInPayment(
    sql, user, form, member, settings, bookingId, price,
  );

  // Bước 11: dùng khoản thu đã lưu để xuất hóa đơn cho khách.
  const invoiceId = await issueWalkInInvoice(
    sql, paymentRow, form, guestPhone, price, settings, court, slot,
  );

  // Bước 12: ghi người thực hiện sau khi hóa đơn đã được tạo thành công.
  await audit(sql, user.id, "walk_in", "booking", bookingId);

  // Bước 13: đọc lại dữ liệu sau audit để trả đúng kết quả cho màn hình tại quầy.
  return readWalkInResponse(sql, bookingId, paymentRow, invoiceId);
}

/**
 * Làm gì: Lấy thông tin chi tiết của một lượt đặt sân theo id và kiểm tra quyền truy cập.
 *   Hội viên chỉ được xem đặt sân của chính mình (F-03); lễ tân và quản lý được xem tất cả.
 * Được gọi ở:
 *   - Route GET /v1/bookings/:id (src/server/controllers/router.ts:391), dispatch qua authedRead.
 *   - Test runner (node --test) kiểm tra phân quyền xem đặt sân (src/server/controllers/tx.test.ts:1194, 1206, 1217).
 * @param sql Kết nối database dùng để truy vấn dữ liệu (chế độ chỉ đọc qua authedRead).
 * @param id Mã UUID của lượt đặt sân cần tra cứu (court_bookings.id).
 * @param user Người dùng đang đăng nhập (member, receptionist hoặc manager).
 * @returns Phản hồi HTTP 200 kèm thông tin chi tiết đặt sân (BookingResponse).
 * @throws Lỗi 403 FORBIDDEN nếu sai vai trò hoặc hội viên cố xem đặt sân của người khác (F-03).
 * @throws Lỗi 404 NOT_FOUND nếu không tìm thấy lượt đặt sân theo id trong database.
 */
export async function bookingGet(sql: Sql, id: string, user: PublicUser): Promise<Reply<BookingResponse>> {
  // Bước 1: kiểm tra vai trò người dùng — chỉ hội viên, lễ tân hoặc quản lý mới có quyền tra cứu đặt sân.
  requireRole(user, ["member", "receptionist", "manager"]);
  // Bước 2: truy vấn chi tiết lượt đặt sân từ bảng court_bookings theo id.
  const b = await one<Booking>(sql, `select ${BOOKING_COLS} from court_bookings where id = $1`, [id]);
  // Báo lỗi 404 nếu không tìm thấy lượt đặt sân tương ứng với id.
  if (!b) throw err.notFound();
  // Bước 3: kiểm tra quyền truy cập (F-03) — hội viên chỉ được xem đặt sân của chính mình; lễ tân và quản lý được xem tất cả.
  if (user.role === "member" && b.user_id !== user.id) throw err.forbidden();
  // Bước 4: trả về dữ liệu lượt đặt sân với mã trạng thái HTTP 200.
  return { status: 200, body: b };
}
