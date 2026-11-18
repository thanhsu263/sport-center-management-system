/**
 * Module xử lý các nghiệp vụ mở rộng (extras) trong hệ thống Arena:
 * - Đặt lịch cố định hàng tuần (fixed weekly bookings / series): kiểm tra tính khả dụng của sân, giữ chỗ và xác nhận thanh toán trọn gói.
 * - Quản lý điểm thưởng hội viên (loyalty points): tích lũy khi hoàn thành đặt sân và hoàn điểm khi hủy đơn.
 * - Tính toán hoa hồng huấn luyện viên (coach commission) theo lớp học và ca dạy thực tế.
 * - Quản lý phiếu công tác bảo trì sân (maintenance work orders).
 * - Xuất dữ liệu hóa đơn điện tử (e-invoice export) phục vụ kế toán.
 * Mọi luồng tiền tệ đều được ghi nhận vào bảng payments và xuất hóa đơn tương ứng.
 */
import { loyaltyBalance } from "../../services/loyalty";
/**
 * Làm gì: Tái xuất (re-export) hàm loyaltyBalance từ service loyalty để các module khác dễ dàng tra cứu số dư điểm thưởng của hội viên.
 * Được gọi ở: Các handler và router cần kiểm tra điểm thưởng của người dùng.
 */
export { loyaltyBalance } from "../../services/loyalty";
import type { Sql } from "@/server/data/db";
import { err, isConflictSlot } from "../errors";
import {
  audit,
  enqueue,
  enqueueReceipt,
  getSettings,
  issueInvoice,
  nextCode,
  num,
  pageOf,
  readJson,
  str,
} from "../helpers";
import { memberCourtFee } from "../../services/membership";
import { isValidVnPhone, normalizePhone } from "../../services/phone";
import { seriesDates, seriesWeekday } from "../../services/policy";
import { applyDiscount, lookupPrice } from "../../services/pricing";
import { requireRole, type PublicUser } from "../session";
import { ictClock, ictDateString, ictDateTime, ictStamp, roundVnd } from "../../../shared/arena3/time";
import { one } from "../tx";
import { pageParams } from "../validate";
import { bookingsCancel, hasCourtOverlap } from "./bookings";
import { blockCourtCommitments } from "./court-block";

/**
 * The extras the scope benchmark asked for: fixed weekly bookings,
 * loyalty points, coach commission, maintenance work orders and e-invoice
 * export. Every money flow here still ends in a `payments` row and an invoice,
 * and every court a customer takes still goes through `occupancies`.
 */

// Biểu thức chính quy kiểm tra định dạng ngày dạng YYYY-MM-DD (ví dụ: "2026-11-17").
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Biểu thức chính quy kiểm tra định dạng kỳ kế toán dạng YYYY-MM (từ tháng 01 đến 12).
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
// Danh sách các phương thức thanh toán được chấp nhận tại quầy: tiền mặt (cash), thẻ ngân hàng (card), chuyển khoản (transfer).
const METHODS = ["cash", "card", "transfer"];

/**
 * Làm gì: Kiểm tra ca trực thu ngân đang hoạt động của nhân viên lễ tân và trả về id ca trực để gắn vào thanh toán.
 *   Đảm bảo quy tắc nghiệp vụ BR-44: nhân viên lễ tân bắt buộc phải mở ca trực trước khi thu tiền của khách.
 * Được gọi ở:
 *   - src/server/controllers/handlers/extras.ts trong hàm seriesCreate (đặt lịch cố định)
 *   - src/server/controllers/handlers/ops.ts trong hàm posEquipmentRent (thuê dụng cụ tại quầy)
 * @param sql Kết nối cơ sở dữ liệu để truy vấn bảng cashier_shifts.
 * @param user Thông tin tài khoản người dùng đang thực hiện thao tác.
 * @returns ID của ca thu ngân đang mở (UUID chuỗi), hoặc null nếu người thực hiện không phải lễ tân (ví dụ quản lý).
 * @throws Lỗi nghiệp vụ BR-44 "Open a till shift before taking payment." nếu người dùng là lễ tân nhưng chưa mở ca.
 */
export async function openShift(sql: Sql, user: PublicUser): Promise<string | null> {
  // Bước 1: nếu không phải nhân viên lễ tân (ví dụ quản lý), không yêu cầu ca thu ngân, trả về null.
  if (user.role !== "receptionist") return null;
  // Bước 2: truy vấn ca thu ngân đang mở (closed_at is null) của lễ tân trong bảng cashier_shifts.
  const sh = await one<{ id: string }>(
    sql,
    `select id from cashier_shifts where receptionist_id = $1 and closed_at is null`,
    [user.id],
  );
  // Bước 3: quy tắc BR-44 - chặn nhận thanh toán nếu lễ tân chưa mở ca trực thu ngân.
  if (!sh) throw err.br("BR-44", "Open a till shift before taking payment.");
  return sh.id;
}

/**
 * Làm gì: Xác thực và chuẩn hóa phương thức thanh toán từ dữ liệu người dùng gửi lên.
 *   Mặc định là "cash" nếu không truyền, và kiểm tra tính hợp lệ với danh sách METHODS được chấp nhận.
 * Được gọi ở:
 *   - src/server/controllers/handlers/extras.ts trong hàm seriesCreate (đặt lịch cố định)
 *   - src/server/controllers/handlers/ops.ts trong hàm posEquipmentRent (thuê dụng cụ tại quầy)
 * @param v Giá trị phương thức thanh toán nhận từ request body (chưa chuẩn hóa).
 * @returns Chuỗi phương thức thanh toán hợp lệ ("cash" | "card" | "transfer").
 * @throws Lỗi 422 (VALIDATION) nếu phương thức truyền lên không nằm trong danh sách cho phép.
 */
export function pickMethod(v: unknown): string {
  // Bước 1: chuyển đổi giá trị sang chuỗi, mặc định chọn tiền mặt ("cash") nếu để trống.
  const m = str(v) ?? "cash";
  // Bước 2: kiểm tra tính hợp lệ trong danh sách METHODS; báo lỗi nếu phương thức không được hỗ trợ.
  if (!METHODS.includes(m)) throw err.validation("Pick cash, card or transfer.");
  return m;
}

/* ───────────────────────── Fixed weekly bookings ───────────────────────── */

// Cấu trúc dữ liệu chứa thông tin khách hàng đặt lịch cố định (hội viên có userId hoặc khách vãng lai với userId = null).
type SeriesWho = { userId: string | null; name: string; phone: string; discountPct: number };

/**
 * Làm gì: Xác định thông tin khách hàng đặt lịch cố định (hội viên đã đăng ký hay khách vãng lai) từ số điện thoại.
 *   Chuẩn hóa số điện thoại theo định dạng Việt Nam và tìm kiếm trong bảng users để gắn tài khoản hội viên nếu có.
 * Được gọi ở:
 *   - src/server/controllers/handlers/extras.ts trong hàm seriesPreview (xem trước lịch cố định)
 *   - src/server/controllers/handlers/extras.ts trong hàm seriesCreate (tạo lịch cố định)
 * @param sql Kết nối cơ sở dữ liệu để tra cứu thông tin người dùng trong bảng users.
 * @param b Dữ liệu request body chứa số điện thoại (phone hoặc guest_phone) và tên khách (name hoặc guest_name).
 * @returns Đối tượng SeriesWho gồm userId (null nếu là khách vãng lai), tên khách, số điện thoại và mức giảm giá (0%).
 * @throws Lỗi 422 nếu thiếu số điện thoại hoặc số điện thoại không đúng định dạng Việt Nam.
 * @throws Lỗi 422 nếu là khách vãng lai nhưng không cung cấp họ tên.
 */
async function resolveWho(sql: Sql, b: Record<string, unknown>): Promise<SeriesWho> {
  // Bước 1: trích xuất số điện thoại từ trường phone hoặc guest_phone.
  const phoneRaw = str(b.phone) ?? str(b.guest_phone);
  if (!phoneRaw) throw err.field("phone", "Phone number is required.");
  // Bước 2: chuẩn hóa và kiểm tra số điện thoại hợp lệ theo chuẩn mạng di động Việt Nam (10 chữ số).
  const phone = normalizePhone(phoneRaw);
  if (!isValidVnPhone(phone)) throw err.field("phone", "That phone number is not valid.");
  // Bước 3: tìm kiếm tài khoản hội viên (role = 'member') có số điện thoại này trong bảng users.
  const member = await one<{ id: string; full_name: string }>(
    sql,
    `select id, full_name from users where phone = $1 and role = 'member'`,
    [phone],
  );
  // Members pay the slot price like everyone else; only the series discount applies.
  if (member) return { userId: member.id, name: member.full_name, phone, discountPct: 0 };
  // Bước 4: nếu là khách vãng lai (không có tài khoản hội viên), bắt buộc phải có tên khách hàng.
  const name = str(b.guest_name) ?? str(b.name);
  if (!name) throw err.field("guest_name", "Enter the customer's name.");
  return { userId: null, name, phone, discountPct: 0 };
}

// Cấu trúc dữ liệu đầu vào chứa các tham số đặt lịch cố định hàng tuần sau khi trích xuất từ request body.
type SeriesInput = {
  courtId: string;
  firstDate: string;
  startLocal: string;
  weeks: number;
};

/**
 * Làm gì: Đọc và xác thực toàn bộ dữ liệu đầu vào khi tạo hoặc xem trước lịch đặt sân cố định hàng tuần.
 *   Kiểm tra định dạng ngày, giờ, số tuần nằm trong giới hạn cấu hình trung tâm và xác minh sân có thể sử dụng (status = 'ready').
 * Được gọi ở:
 *   - src/server/controllers/handlers/extras.ts trong hàm seriesPreview
 *   - src/server/controllers/handlers/extras.ts trong hàm seriesCreate
 * @param sql Kết nối cơ sở dữ liệu để lấy cấu hình hệ thống và kiểm tra thông tin sân trong bảng courts.
 * @param b Dữ liệu request body JSON chứa court_id, first_date, start_local và weeks.
 * @returns Đối tượng chứa các tham số đặt lịch đã kiểm tra hợp lệ cùng bản ghi thông tin sân (court).
 * @throws Lỗi 422 nếu thiếu sân, ngày bắt đầu không đúng định dạng YYYY-MM-DD, giờ bắt đầu không đúng định dạng HH:MM, hoặc số tuần vượt ngoài giới hạn.
 * @throws Lỗi 404 nếu không tìm thấy sân trong hệ thống.
 * @throws Lỗi nghiệp vụ BR-06 nếu sân đã ngưng hoạt động (retired_at) hoặc trạng thái không sẵn sàng (status !== 'ready').
 */
async function readSeriesInput(sql: Sql, b: Record<string, unknown>): Promise<SeriesInput & { court: { id: string; court_code: string; sport: string; status: string } }> {
  // Bước 1: trích xuất các trường dữ liệu từ request body.
  const courtId = str(b.court_id);
  const firstDate = str(b.first_date);
  const startLocal = str(b.start_local);
  const weeks = num(b.weeks);
  // Bước 2: kiểm tra định dạng và tính bắt buộc của mã sân, ngày đầu tiên và giờ bắt đầu.
  if (!courtId) throw err.field("court_id", "Pick a court.");
  if (!firstDate || !DATE_RE.test(firstDate)) throw err.field("first_date", "Pick the first date.");
  if (!startLocal || !/^\d{1,2}:\d{2}$/.test(startLocal)) throw err.field("start_local", "Pick a start time like 19:00.");
  // Bước 3: đọc cấu hình hệ thống để xác thực số tuần đặt nằm trong khoảng cho phép (series_min_weeks đến series_max_weeks).
  const settings = await getSettings(sql);
  if (weeks == null || !Number.isInteger(weeks) || weeks < settings.series_min_weeks || weeks > settings.series_max_weeks) {
    throw err.field("weeks", `A fixed booking runs ${settings.series_min_weeks}–${settings.series_max_weeks} weeks.`);
  }
  // Bước 4: truy vấn thông tin sân từ bảng courts để kiểm tra trạng thái hoạt động.
  const court = await one<{ id: string; court_code: string; sport: string; status: string; retired_at: string | null }>(
    sql,
    `select id, court_code, sport::text as sport, status::text as status, retired_at from courts where id = $1`,
    [courtId],
  );
  // Bước 5: kiểm tra sân còn tồn tại, chưa bị ngừng hoạt động (retired_at) và có trạng thái sẵn sàng ('ready').
  if (!court) throw err.notFound("No such court.");
  if (court.retired_at || court.status !== "ready") throw err.br("BR-06", "That court is not available.");
  // Bước 6: chuẩn hóa giờ bắt đầu đủ 5 ký tự (ví dụ: "7:00" -> "07:00") và trả về dữ liệu hoàn chỉnh.
  return { courtId, firstDate, startLocal: startLocal.padStart(5, "0"), weeks, court };
}

// Cấu trúc dữ liệu biểu diễn thông tin chi tiết của một buổi chơi trong gói đặt lịch cố định hàng tuần.
type SeriesLine = {
  date: string;
  start_at: string;
  end_at: string;
  list_vnd: number;
  price_vnd: number;
  is_peak: boolean;
  available: boolean;
  reason?: string;
};

/**
 * Work out every week of the series. Each week is tried on the real occupancy
 * table inside a savepoint, so "free" means exactly what a booking would find;
 * a week that is taken is skipped, never forced.
 */
async function planSeries(
  sql: Sql,
  input: SeriesInput & { court: { sport: string } },
  who: SeriesWho,
  keep: boolean,
): Promise<{ lines: SeriesLine[]; discountPct: number; attached: { line: SeriesLine; bookingId: string; occId: string }[] }> {
  // Bước 1: lấy cấu hình hệ thống và xác định mức chiết khấu áp dụng (lấy giá trị lớn hơn giữa cấu hình và ưu đãi của khách).
  const settings = await getSettings(sql);
  const disc = Math.max(settings.series_discount_pct, who.discountPct);
  // Bước 2: quy tắc BR-06 - kiểm tra khung giờ chơi phải nằm hoàn toàn trong khung giờ mở cửa của trung tâm thể thao.
  const open = ictDateTime(input.firstDate, settings.open_time.slice(0, 5));
  const close = ictDateTime(input.firstDate, settings.close_time.slice(0, 5));
  const first = ictDateTime(input.firstDate, input.startLocal);
  if (first < open || first.getTime() + settings.slot_minutes * 60_000 > close.getTime() + 1) {
    // Compare the wall clock, not the day: opening hours repeat every day.
    throw err.br("BR-06", "That is outside opening hours.");
  }
  // Bước 3: khởi tạo danh sách tất cả các tuần (lines) và danh sách các tuần đã giữ sân thành công (attached).
  const lines: SeriesLine[] = [];
  const attached: { line: SeriesLine; bookingId: string; occId: string }[] = [];
  // Bước 4: duyệt qua từng tuần trong chu kỳ đặt lịch cố định theo hàm seriesDates.
  for (const date of seriesDates(input.firstDate, input.weeks)) {
    // Tính thời điểm bắt đầu và kết thúc của ca chơi theo độ dài slot (slot_minutes) theo múi giờ ICT.
    const start = ictDateTime(date, input.startLocal);
    const end = new Date(start.getTime() + settings.slot_minutes * 60_000);
    // Tra cứu bảng giá niêm yết (list price) và kiểm tra chính sách miễn giảm phí nếu khách là hội viên (memberCourtFee).
    const list = await lookupPrice(sql, { sport: input.court.sport, courtId: input.courtId, start });
    const covered = who.userId ? await memberCourtFee(sql, who.userId, start, settings) : null;
    const price = covered
      ? covered.fee_vnd
      : roundVnd(applyDiscount(list.price_vnd, disc, settings.round_vnd), settings.round_vnd);
    const line: SeriesLine = {
      date,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      list_vnd: list.price_vnd,
      price_vnd: price,
      is_peak: list.is_peak,
      available: true,
    };
    // Bước 5: kiểm tra khả dụng - đánh dấu không khả dụng nếu ca chơi nằm trong quá khứ.
    if (start < new Date()) {
      line.available = false;
      line.reason = "past";
    // Đánh dấu không khả dụng nếu hội viên đã có lịch đặt sân khác bị trùng khung giờ này.
    } else if (who.userId && (await hasCourtOverlap(sql, who.userId, start, end))) {
      line.available = false;
      line.reason = "taken";
    } else {
      // Bước 6: thử giữ sân trên bảng occupancies bằng savepoint để kiểm tra xung đột thời gian thực.
      const bookingId = (await one<{ id: string }>(sql, `select gen_random_uuid() as id`))!.id;
      await sql.query("savepoint sp_series");
      try {
        const occ = await one<{ occupancy_attach: string }>(
          sql,
          `select occupancy_attach($1::uuid, $2::timestamptz, $3::timestamptz, 'hold'::occ_kind, $4::uuid, null) as occupancy_attach`,
          [input.courtId, start.toISOString(), end.toISOString(), bookingId],
        );
        // Nếu keep = true (khi tạo thật): giải phóng savepoint và lưu lại occId; nếu keep = false (khi preview): rollback để nhả sân ngay.
        if (keep) {
          await sql.query("release savepoint sp_series");
          attached.push({ line, bookingId, occId: occ!.occupancy_attach });
        } else {
          await sql.query("rollback to savepoint sp_series");
        }
      } catch (e) {
        // Nếu bị xung đột khung giờ (conflict slot): rollback savepoint và đánh dấu tuần này là đã bị chiếm (taken).
        await sql.query("rollback to savepoint sp_series").catch(() => undefined);
        if (!isConflictSlot(e)) throw e;
        line.available = false;
        line.reason = "taken";
      }
    }
    lines.push(line);
  }
  // Bước 7: trả về danh sách toàn bộ các tuần, tỷ lệ giảm giá áp dụng và danh sách các tuần đã giữ chỗ thành công.
  return { lines, discountPct: disc, attached };
}

/**
 * Làm gì: Tính toán và trả về bản xem trước (preview) của gói đặt lịch sân cố định hàng tuần.
 *   Duyệt kiểm tra từng tuần xem sân có trống không, áp dụng chiết khấu series,
 *   tổng hợp số tuần đặt được, số tuần bị bỏ qua và tổng tiền phải trả.
 * Được gọi ở:
 *   - Màn hình đặt lịch cố định /desk/series (src/routes/desk.series.tsx) khi lễ tân nhấn "Xem trước" / thay đổi form.
 *   - Route: POST /series/preview, được router (src/server/controllers/router.ts) chuyển tiếp qua authed.
 * @param sql Kết nối cơ sở dữ liệu để truy vấn cấu hình, giá và kiểm tra lịch chiếm sân.
 * @param request HTTP POST request chứa JSON body (court_id, first_date, start_local, weeks, phone/guest_name).
 * @param user Thông tin tài khoản người dùng đăng nhập, yêu cầu quyền receptionist hoặc manager.
 * @returns Đối tượng { status: 200, body } chứa danh sách từng tuần (lines), số tuần thành công (booked), số tuần bị bỏ qua (skipped) và tổng tiền (total_vnd).
 * @throws Lỗi 403 (FORBIDDEN) nếu người dùng không phải lễ tân hoặc quản lý.
 * @throws Lỗi 422/400 nếu dữ liệu đầu vào hoặc thông tin khách hàng không hợp lệ.
 * @throws Lỗi nghiệp vụ BR-06 nếu giờ bắt đầu nằm ngoài khung giờ mở cửa của trung tâm.
 */
export async function seriesPreview(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: kiểm tra phân quyền, chỉ nhân viên lễ tân hoặc quản lý mới được phép xem trước lịch cố định.
  requireRole(user, ["receptionist", "manager"]);
  // Bước 2: đọc dữ liệu request JSON và xác thực các tham số đặt lịch cùng thông tin khách hàng.
  const b = await readJson(request);
  const input = await readSeriesInput(sql, b);
  const who = await resolveWho(sql, b);
  // Bước 3: lập kế hoạch các tuần với keep = false để kiểm tra độ khả dụng mà không thực sự chiếm giữ sân.
  const { lines, discountPct } = await planSeries(sql, input, who, false);
  // Bước 4: lọc ra các tuần khả dụng để tính tổng tiền và thống kê số tuần đặt được.
  const ok = lines.filter((l) => l.available);
  const settings = await getSettings(sql);
  // Bước 5: trả về kết quả xem trước đầy đủ gồm thông tin sân, khách hàng, chi tiết từng buổi và tổng tiền.
  return {
    status: 200,
    body: {
      court_code: input.court.court_code,
      customer: { name: who.name, phone: who.phone, is_member: !!who.userId },
      weekday: seriesWeekday(input.firstDate, input.startLocal),
      discount_pct: discountPct,
      min_weeks: settings.series_min_weeks,
      lines,
      booked: ok.length,
      skipped: lines.length - ok.length,
      list_total_vnd: ok.reduce((a, l) => a + l.list_vnd, 0),
      total_vnd: ok.reduce((a, l) => a + l.price_vnd, 0),
    },
  };
}

// ─────────────────────── Types cho seriesCreate ───────────────────────

/**
 * Dữ liệu tóm gọn của một tuần đã được đặt thành công trong planSeries,
 * đủ để tạo court_booking và xác nhận occupancy mà không cần truy vấn thêm.
 */
type SeriesAttachedWeek = {
  line: SeriesLine;
  bookingId: string;
  occId: string;
};

/**
 * Kết quả của bước lưu booking_series: id do database trả về cộng với
 * seriesCode để ghi vào audit log và trả về response.
 */
type SeriesRecord = {
  id: string;
  code: string;
};

/**
 * Kết quả của bước tạo payment: id dùng để phát hành hóa đơn và biên lai.
 */
type SeriesPayment = {
  id: string;
};

// ─────────────────────── Hàm phụ của seriesCreate ───────────────────────

/**
 * Làm gì: kiểm tra ít nhất một tuần trong danh sách đã được giữ sân thành công.
 *   Vì sao: nếu không có tuần nào trống, không có gì để đặt — báo lỗi ngay,
 *   không ghi bất cứ dòng nào vào database.
 * Được gọi ở: seriesCreate, Bước 5.
 * @param attachedWeeks Danh sách tuần đã giữ sân thành công từ planSeries.
 * @throws Lỗi 409 CONFLICT_SLOT "None of those weeks is free." khi danh sách rỗng.
 */
function assertSeriesHasFreeWeeks(attachedWeeks: SeriesAttachedWeek[]): void {
  // Kiểm tra số tuần giữ sân: nếu không có tuần nào khả dụng thì báo lỗi CONFLICT_SLOT ngay.
  if (attachedWeeks.length === 0) {
    throw err.conflictSlot("None of those weeks is free.");
  }
}

/**
 * Làm gì: tính tổng tiền của toàn bộ lịch cố định bằng cách cộng giá từng tuần đã đặt.
 *   Chỉ cộng các tuần đã được giữ sân thành công; tuần bị bỏ qua không tính vào hóa đơn.
 * Được gọi ở: seriesCreate, Bước 5.
 * @param attachedWeeks Danh sách tuần đã giữ sân thành công từ planSeries.
 * @returns Tổng tiền tính bằng đồng (VNĐ).
 */
function computeSeriesTotalVnd(attachedWeeks: SeriesAttachedWeek[]): number {
  // Tính tổng tiền bằng cách cộng dồn giá sau giảm (price_vnd) của tất cả các tuần đã giữ sân thành công.
  let total = 0;
  for (const attachedWeek of attachedWeeks) {
    total += attachedWeek.line.price_vnd;
  }
  return total;
}

/**
 * Làm gì: lưu dòng booking_series vào database và trả về id cùng mã series vừa tạo.
 *   Vì sao lưu series trước booking: các court_booking cần tham chiếu đến series_id.
 * Được gọi ở: seriesCreate, Bước 6.
 * @param sql Kết nối database trong transaction do router mở.
 * @param input Dữ liệu sân, ngày, giờ và số tuần đã kiểm tra từ readSeriesInput.
 * @param who Thông tin khách hàng (thành viên hay khách vãng lai) từ resolveWho.
 * @param discountPct Phần trăm giảm giá đã áp dụng từ planSeries.
 * @param user Người lễ tân/quản lý đang thao tác; id ghi vào cột created_by.
 * @returns Dòng vừa insert: { id, code }.
 */
async function insertSeriesRecord(
  sql: Sql,
  input: SeriesInput & { court: { id: string; court_code: string; sport: string; status: string } },
  who: SeriesWho,
  discountPct: number,
  user: PublicUser,
): Promise<SeriesRecord> {
  // Bước 1: sinh mã series mới có tiền tố "SER" (ví dụ: SER-00001).
  const seriesCode = await nextCode(sql, "SER");
  // Bước 2: lưu bản ghi vào bảng booking_series và trả về ID cùng mã series vừa tạo.
  const series = await one<{ id: string }>(
    sql,
    `insert into booking_series
       (code, user_id, guest_name, guest_phone, court_id, weekday, start_local, weeks, starts_on, discount_pct, created_by)
     values ($1,$2,$3,$4,$5,$6,$7::time,$8,$9::date,$10,$11) returning id`,
    [
      seriesCode,
      who.userId,
      who.userId ? null : who.name,
      who.userId ? null : who.phone,
      input.courtId,
      seriesWeekday(input.firstDate, input.startLocal),
      input.startLocal,
      input.weeks,
      input.firstDate,
      discountPct,
      user.id,
    ],
  );
  return { id: series!.id, code: seriesCode };
}

/**
 * Làm gì: với mỗi tuần đã giữ sân, tạo một dòng court_bookings, xác nhận occupancy
 *   và chuyển trạng thái booking từ 'hold' sang 'confirmed'. Thứ tự ba câu SQL trong mỗi
 *   vòng lặp là cố ý: insert trước, confirm occupancy sau, update status sau cùng —
 *   đảm bảo database luôn nhất quán nếu transaction bị rollback giữa chừng.
 * Được gọi ở: seriesCreate, Bước 7.
 * @param sql Kết nối database trong transaction do router mở.
 * @param attachedWeeks Danh sách tuần đã giữ sân thành công từ planSeries.
 * @param input Dữ liệu sân, ngày, giờ và số tuần đã kiểm tra từ readSeriesInput.
 * @param who Thông tin khách hàng từ resolveWho.
 * @param discountPct Phần trăm giảm giá đã áp dụng từ planSeries.
 * @param seriesId Id của dòng booking_series vừa tạo ở Bước 6.
 * @param settings Cấu hình hệ thống (dùng vat_rate) từ getSettings.
 * @returns Danh sách bookingId đã lưu, giữ đúng thứ tự các tuần để lấy [0] làm ref cho payment.
 */
async function insertSeriesBookings(
  sql: Sql,
  attachedWeeks: SeriesAttachedWeek[],
  input: SeriesInput & { court: { id: string; court_code: string; sport: string; status: string } },
  who: SeriesWho,
  discountPct: number,
  seriesId: string,
  settings: Awaited<ReturnType<typeof getSettings>>,
): Promise<string[]> {
  // Khởi tạo mảng lưu danh sách bookingId để trả về cho bước tạo thanh toán tiếp theo.
  const bookingIds: string[] = [];
  // Duyệt qua từng tuần đã giữ chỗ thành công để tạo bản ghi đặt sân và xác nhận occupancy.
  for (const attachedWeek of attachedWeeks) {
    // Bước 1: sinh mã đặt sân mới có tiền tố "CRT" (ví dụ: CRT-00001).
    const code = await nextCode(sql, "CRT");
    // Bước 2: chèn bản ghi court_bookings ở trạng thái 'hold' với kênh đặt 'series'.
    await sql.query(
      `insert into court_bookings
         (id, code, court_id, user_id, guest_name, guest_phone, start_at, end_at, status, channel,
          price_vnd, discount_pct, vat_rate, occupancy_id, series_id, paid_vnd)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'hold','series',$9,$10,$11,$12,$13,$9)`,
      [
        attachedWeek.bookingId,
        code,
        input.courtId,
        who.userId,
        who.userId ? null : who.name,
        who.userId ? null : who.phone,
        attachedWeek.line.start_at,
        attachedWeek.line.end_at,
        attachedWeek.line.price_vnd,
        discountPct,
        Number(settings.vat_rate),
        attachedWeek.occId,
        seriesId,
      ],
    );
    // Bước 3: xác nhận giữ chỗ thành công trong bảng occupancies (occupancy_confirm_hold).
    await sql.query(`select occupancy_confirm_hold($1::uuid)`, [attachedWeek.occId]);
    // Bước 4: cập nhật trạng thái đặt sân sang 'confirmed' và xóa hạn giữ chỗ (hold_until = null).
    await sql.query(`update court_bookings set status = 'confirmed', hold_until = null where id = $1`, [attachedWeek.bookingId]);
    bookingIds.push(attachedWeek.bookingId);
  }
  return bookingIds;
}

/**
 * Làm gì: ghi một dòng payments cho toàn bộ lịch cố định — một thanh toán chung cho tất cả
 *   các tuần, tham chiếu đến booking của tuần đầu tiên (bookingIds[0]).
 *   Vì sao dùng booking đầu tiên làm ref: payment gắn với lần chiếm sân đầu tiên là điểm tham chiếu
 *   kế toán; hóa đơn và biên lai đều trỏ về payment này.
 * Được gọi ở: seriesCreate, Bước 8.
 * @param sql Kết nối database trong transaction do router mở.
 * @param who Thông tin khách hàng từ resolveWho; userId có thể null nếu là khách vãng lai.
 * @param shiftId Id ca thu ngân đang mở (null nếu người dùng không phải lễ tân).
 * @param method Phương thức thanh toán: "cash" | "card" | "transfer".
 * @param totalVnd Tổng tiền tính bằng đồng từ computeSeriesTotalVnd.
 * @param settings Cấu hình hệ thống (dùng vat_rate) từ getSettings.
 * @param firstBookingId Id booking của tuần đầu tiên từ insertSeriesBookings[0].
 * @param user Người lễ tân/quản lý đang thao tác; id ghi vào created_by.
 * @returns Dòng payment vừa insert: { id }.
 */
async function insertSeriesPayment(
  sql: Sql,
  who: SeriesWho,
  shiftId: string | null,
  method: string,
  totalVnd: number,
  settings: Awaited<ReturnType<typeof getSettings>>,
  firstBookingId: string,
  user: PublicUser,
): Promise<SeriesPayment> {
  // Bước 1: sinh mã thanh toán mới có tiền tố "PAY" (ví dụ: PAY-00001).
  const paymentCode = await nextCode(sql, "PAY");
  // One payment and one invoice for the whole block, filed against the first week.
  // Bước 2: tạo một bản ghi payments duy nhất cho toàn bộ gói đặt lịch, tham chiếu đến booking của tuần đầu tiên.
  const payment = await one<{ id: string }>(
    sql,
    `insert into payments (code, user_id, shift_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by)
     values ($1,$2,$3,$4,$5,$6,'posted','booking',$7,$8) returning id`,
    [paymentCode, who.userId, shiftId, method, totalVnd, Number(settings.vat_rate), firstBookingId, user.id],
  );
  return { id: payment!.id };
}

/**
 * Làm gì: tra tên tiếng Việt của thứ trong tuần để ghi vào mô tả hóa đơn.
 *   Chỉ số của seriesWeekday là 0 (Chủ nhật) đến 6 (Thứ bảy), khớp với getDay() của JS.
 * Được gọi ở: seriesCreate, Bước 9, trước khi gọi issueInvoice.
 * @param firstDate Ngày đầu tiên của lịch cố định (YYYY-MM-DD).
 * @param startLocal Giờ bắt đầu dạng "HH:MM".
 * @returns Tên thứ tiếng Việt, ví dụ "Thứ hai", "Chủ nhật".
 */
function resolveSeriesWeekdayVietnamese(firstDate: string, startLocal: string): string {
  // Tính chỉ số thứ trong tuần (0: Chủ nhật, 1: Thứ hai, ... 6: Thứ bảy) và ánh xạ sang tên tiếng Việt.
  const weekdayIndex = seriesWeekday(firstDate, startLocal);
  const vietnameseWeekdays = ["Chủ nhật", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"];
  return vietnameseWeekdays[weekdayIndex];
}

/**
 * Làm gì: phát hành hóa đơn điện tử, gửi biên lai qua thông báo in-app và thông báo
 *   khách hàng đã tạo lịch cố định thành công. Ba side-effect này luôn đi cùng nhau sau
 *   khi payment được lưu — thứ tự không được đảo vì biên lai cần invoiceId.
 * Được gọi ở: seriesCreate, Bước 9.
 * @param sql Kết nối database trong transaction do router mở.
 * @param payment Dòng payment vừa tạo ở Bước 8.
 * @param who Thông tin khách hàng từ resolveWho.
 * @param input Dữ liệu sân, ngày, giờ từ readSeriesInput; dùng court_code và startLocal.
 * @param series Dòng booking_series vừa tạo ở Bước 6; dùng id và code.
 * @param attachedWeeks Danh sách tuần đã đặt; dùng length để ghi mô tả hóa đơn.
 * @param discountPct Phần trăm giảm giá; ghi vào mô tả hóa đơn.
 * @param totalVnd Tổng tiền; ghi vào hóa đơn và biên lai.
 * @param method Phương thức thanh toán; ghi vào biên lai.
 * @param weekdayVi Tên thứ tiếng Việt từ resolveSeriesWeekdayVietnamese; ghi vào mô tả hóa đơn.
 * @param settings Cấu hình hệ thống (dùng vat_rate) từ getSettings.
 * @returns invoiceId vừa phát hành, dùng để trả về trong response.
 */
async function issueSeriesInvoiceAndNotify(
  sql: Sql,
  payment: SeriesPayment,
  who: SeriesWho,
  input: SeriesInput & { court: { id: string; court_code: string; sport: string; status: string } },
  series: SeriesRecord,
  attachedWeeks: SeriesAttachedWeek[],
  discountPct: number,
  totalVnd: number,
  method: string,
  weekdayVi: string,
  settings: Awaited<ReturnType<typeof getSettings>>,
): Promise<string> {
  // Bước 1: Phát hành hóa đơn điện tử cho toàn bộ gói thuê cố định, ghi rõ sân, thứ, giờ và số buổi.
  const invoiceId = await issueInvoice(sql, {
    paymentId: payment.id,
    buyerName: who.name,
    buyerPhone: who.userId ? null : who.phone,
    amountVnd: totalVnd,
    vatRate: Number(settings.vat_rate ?? 0),
    description: `Thuê sân cố định ${input.court.court_code} — ${weekdayVi} ${input.startLocal}, ${attachedWeeks.length} buổi (giảm ${discountPct}%)`,
    unit: "buổi",
    settings,
  });
  // Bước 2: Đưa biên lai thanh toán vào hàng đợi gửi cho khách hàng.
  await enqueueReceipt(sql, who.userId, {
    payment_id: payment.id,
    invoice_id: invoiceId,
    amount_vnd: totalVnd,
    method,
  });
  // Bước 3: Đưa thông báo in-app (series_created) vào hàng đợi để thông báo lịch cố định đã tạo thành công.
  await enqueue(
    sql,
    "inapp",
    "series_created",
    who.userId,
    { series_id: series.id, code: series.code, weeks: attachedWeeks.length },
    `series_created|${series.id}`,
  );
  return invoiceId;
}

/**
 * Làm gì: ghi nhật ký audit để tra cứu sau này: ai tạo, bao nhiêu tuần đặt được,
 *   bao nhiêu tuần bỏ qua và tổng tiền là bao nhiêu.
 * Được gọi ở: seriesCreate, Bước 10.
 * @param sql Kết nối database trong transaction do router mở.
 * @param user Người lễ tân/quản lý đang thao tác; id ghi là actor.
 * @param series Dòng booking_series vừa tạo; id dùng làm entity_id trong audit.
 * @param attachedWeeks Danh sách tuần đã đặt thành công.
 * @param allLines Toàn bộ danh sách tuần (kể cả bị bỏ qua) từ planSeries; dùng length để tính số tuần skip.
 * @param totalVnd Tổng tiền tính bằng đồng.
 */
async function auditSeriesCreation(
  sql: Sql,
  user: PublicUser,
  series: SeriesRecord,
  attachedWeeks: SeriesAttachedWeek[],
  allLines: SeriesLine[],
  totalVnd: number,
): Promise<void> {
  await audit(sql, user.id, "create_series", "booking_series", series.id, null, {
    weeks: attachedWeeks.length,
    skipped: allLines.length - attachedWeeks.length,
    total_vnd: totalVnd,
  });
}

/**
 * Làm gì: lấy danh sách các tuần bị bỏ qua (không đặt được) để trả về cho màn hình
 *   hiển thị cho lễ tân biết tuần nào đã có người thuê.
 * Được gọi ở: seriesCreate, Bước 11.
 * @param allLines Toàn bộ danh sách tuần (kể cả bị bỏ qua) từ planSeries.
 * @returns Danh sách { date, reason } của các tuần không available.
 */
function collectSeriesSkippedWeeks(allLines: SeriesLine[]): { date: string; reason: string | undefined }[] {
  const skippedWeeks: { date: string; reason: string | undefined }[] = [];
  for (const line of allLines) {
    if (!line.available) {
      skippedWeeks.push({ date: line.date, reason: line.reason });
    }
  }
  return skippedWeeks;
}

// ─────────────────────── Hàm chính seriesCreate ───────────────────────

/**
 * Làm gì: tạo một lịch thuê sân cố định hàng tuần — đặt nhiều tuần liên tiếp cùng một lúc,
 *   thu một lần thanh toán chung và phát hành một hóa đơn điện tử duy nhất cho cả block.
 *   Tuần nào đã có người thuê hoặc đã qua thì bỏ qua (không lỗi), nhưng phải còn ít nhất
 *   một tuần trống thì mới tạo được.
 *   Đọc hàm này như mục lục: mỗi bước là một dòng gọi hàm phụ, chi tiết nằm trong hàm đó.
 *   Thứ tự các bước là cố ý — bước nào đứng trước thì lỗi của nó được báo trước cho lễ tân.
 * Được gọi ở:
 *   - Màn hình /desk/series (src/routes/desk.series.tsx), nút "Book fixed schedule",
 *     gửi apiPost("/series", body(), true) tức POST /v1/series (có idempotency key).
 *   - src/server/controllers/router.ts dòng "POST series": authed(...) mở transaction,
 *     withIdempotency kiểm tra key trùng, rồi gọi hàm này.
 * @param sql Kết nối database trong transaction do router mở; rollback tự động nếu có lỗi.
 * @param request Request POST /v1/series; body JSON chứa: court_id, first_date, start_local,
 *   weeks, method, phone (hoặc guest_phone), guest_name (nếu khách vãng lai).
 * @param user Người đang đăng nhập; phải là receptionist hoặc manager.
 * @returns { status: 201, body: { series_id, code, booked, skipped, total_vnd, payment_id, invoice_id } }.
 * @throws Lỗi 403 nếu không phải receptionist/manager.
 *   Lỗi 400/422 từ các bước đọc và kiểm tra dữ liệu.
 *   Lỗi 409 CONFLICT_SLOT "None of those weeks is free." nếu không còn tuần nào trống.
 */
export async function seriesCreate(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: chỉ lễ tân và quản lý mới được tạo lịch cố định.
  requireRole(user, ["receptionist", "manager"]);

  // Bước 2: đọc body JSON và lấy phương thức thanh toán (mặc định "cash").
  const body = await readJson(request);
  const method = pickMethod(body.method);

  // Bước 3: kiểm tra sân, ngày đầu, giờ bắt đầu và số tuần; lấy thông tin sân.
  const input = await readSeriesInput(sql, body);

  // Bước 4: xác định khách hàng qua số điện thoại (thành viên hoặc khách vãng lai).
  const who = await resolveWho(sql, body);

  // Bước 5: nếu là lễ tân thì phải có ca thu ngân đang mở.
  const shiftId = await openShift(sql, user);

  // Bước 6: lấy cấu hình hệ thống (slot_minutes, vat_rate, giảm giá series, v.v.).
  const settings = await getSettings(sql);

  // Bước 7: lên kế hoạch từng tuần — tính giá, kiểm tra và giữ sân cho các tuần trống.
  const { lines, discountPct, attached } = await planSeries(sql, input, who, true);

  // Bước 8: phải có ít nhất một tuần trống để tạo lịch.
  assertSeriesHasFreeWeeks(attached);

  // Bước 9: tính tổng tiền của tất cả các tuần đặt được.
  const totalVnd = computeSeriesTotalVnd(attached);

  // Bước 10: lưu dòng booking_series (cha của tất cả các court_booking bên dưới).
  const series = await insertSeriesRecord(sql, input, who, discountPct, user);

  // Bước 11: với mỗi tuần giữ sân thành công, tạo court_booking và xác nhận occupancy.
  const bookingIds = await insertSeriesBookings(sql, attached, input, who, discountPct, series.id, settings);

  // Bước 12: ghi một payment chung cho cả block, tham chiếu booking của tuần đầu tiên.
  const payment = await insertSeriesPayment(sql, who, shiftId, method, totalVnd, settings, bookingIds[0], user);

  // Bước 13: phát hành hóa đơn, gửi biên lai và thông báo in-app cho khách hàng.
  const weekdayVi = resolveSeriesWeekdayVietnamese(input.firstDate, input.startLocal);
  const invoiceId = await issueSeriesInvoiceAndNotify(
    sql,
    payment,
    who,
    input,
    series,
    attached,
    discountPct,
    totalVnd,
    method,
    weekdayVi,
    settings,
  );

  // Bước 14: ghi audit log — ai tạo, bao nhiêu tuần đặt được và bao nhiêu tuần bỏ qua.
  await auditSeriesCreation(sql, user, series, attached, lines, totalVnd);

  // Bước 15: trả kết quả về màn hình để hiển thị xác nhận cho lễ tân.
  const skippedWeeks = collectSeriesSkippedWeeks(lines);
  return {
    status: 201,
    body: {
      series_id: series.id,
      code: series.code,
      booked: attached.length,
      skipped: skippedWeeks,
      total_vnd: totalVnd,
      payment_id: payment.id,
      invoice_id: invoiceId,
    },
  };
}

/**
 * Làm gì: Lấy danh sách các gói thuê sân cố định (booking_series) có phân trang.
 *   Lễ tân và quản lý xem được toàn bộ danh sách; hội viên chỉ xem được các gói của chính mình.
 * Được gọi ở:
 *   - Route GET /v1/series (src/server/controllers/router.ts dòng 494).
 *   - Màn hình lễ tân quản lý lịch cố định (src/routes/desk.series.tsx, qua useRead("/series")).
 * @param sql Kết nối database trong transaction đọc do router mở.
 * @param request Request GET /v1/series chứa query params limit và offset.
 * @param user Người dùng đã xác thực; phải là receptionist, manager hoặc member.
 * @returns { status: 200, body: Page<SeriesRow> } Danh sách gói thuê kèm thông tin sân, khách hàng và số buổi.
 * @throws Lỗi 403 nếu user không thuộc các vai trò receptionist, manager hoặc member.
 */
export async function seriesList(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra phân quyền — chỉ lễ tân, quản lý hoặc hội viên mới được xem danh sách.
  requireRole(user, ["receptionist", "manager", "member"]);
  // Hội viên chỉ được xem lịch của chính mình, nhân viên xem được toàn bộ.
  const mine = user.role === "member";
  // Bước 2: Đọc tham số phân trang từ URL (mặc định 100 dòng/trang).
  const { limit, offset } = pageParams(request, { def: 100, max: 100 });
  // Bước 3: Truy vấn danh sách booking_series kèm thông tin sân, khách hàng, số buổi còn lại và buổi tiếp theo.
  const rows = await sql.query<{ total: number } & Record<string, unknown>>(
    `select s.id, s.code, s.weekday, s.start_local::text as start_local, s.weeks, s.starts_on::text as starts_on,
            s.discount_pct, s.status, c.court_code,
            coalesce(u.full_name, s.guest_name) as customer, coalesce(u.phone, s.guest_phone) as phone,
            (select count(*)::int from court_bookings b where b.series_id = s.id and b.status in ('confirmed','in_use') and b.start_at > now()) as remaining,
            (select count(*)::int from court_bookings b where b.series_id = s.id and b.status in ('confirmed','in_use','completed')) as booked,
            (select min(b.start_at) from court_bookings b where b.series_id = s.id and b.status = 'confirmed' and b.start_at > now()) as next_at,
            count(*) over ()::int as total
       from booking_series s
       join courts c on c.id = s.court_id
       left join users u on u.id = s.user_id
      where ($1::uuid is null or s.user_id = $1)
      order by s.status, s.created_at desc
      limit $2 offset $3`,
    [mine ? user.id : null, limit, offset],
  );
  // Bước 4: Đóng gói kết quả kèm tổng số bản ghi vào cấu trúc phân trang chuẩn.
  const body = await pageOf(rows, { limit, offset }, async () =>
    ((await one<{ n: number }>(sql, `select count(*)::int as n from booking_series where ($1::uuid is null or user_id = $1)`, [mine ? user.id : null]))?.n ?? 0),
  );
  return { status: 200, body };
}

/**
 * Stop a fixed booking. Every remaining week is cancelled through the normal
 * cancel path, so each one is refunded by the same tiers as any other booking.
 */
export async function seriesCancel(sql: Sql, id: string, request: Request, user: PublicUser) {
  // Bước 1: Chỉ lễ tân hoặc quản lý mới có quyền hủy chuỗi lịch cố định.
  requireRole(user, ["receptionist", "manager"]);
  // Bước 2: Đọc lý do hủy và tùy chọn waive (miễn phí phạt) từ body JSON.
  const b = await readJson(request);
  // Bước 3: Khóa dòng booking_series với FOR UPDATE để ngăn việc 2 người cùng thao tác hủy đồng thời.
  const series = await one<{ id: string; status: string }>(sql, `select id, status from booking_series where id = $1 for update`, [id]);
  if (!series) throw err.notFound();
  if (series.status !== "active") throw err.conflictState("That fixed booking is already cancelled.");
  // Bước 4: Lấy danh sách các buổi trong tương lai đang ở trạng thái confirmed để chuẩn bị hủy.
  const rows = await sql.query<{ id: string }>(
    `select id from court_bookings where series_id = $1 and status = 'confirmed' and start_at > now() order by start_at`,
    [id],
  );
  // Bước 5: Hủy từng buổi thông qua bookingsCancel để áp dụng đúng công thức hoàn tiền và phí phạt.
  let refunded = 0;
  let fees = 0;
  for (const r of rows) {
    const req = new Request("http://local/cancel", {
      method: "POST",
      body: JSON.stringify({ waive: b.waive === true, reason: str(b.reason) ?? "Hủy lịch cố định" }),
    });
    const res = await bookingsCancel(sql, r.id, user, req);
    const q = (res.body as { quote?: { refund_vnd: number; fee_vnd: number } }).quote;
    refunded += q?.refund_vnd ?? 0;
    fees += q?.fee_vnd ?? 0;
  }
  // Bước 6: Cập nhật trạng thái chuỗi lịch cố định sang cancelled.
  await sql.query(`update booking_series set status = 'cancelled' where id = $1`, [id]);
  // Bước 7: Ghi nhật ký audit lưu vết số buổi hủy, tổng tiền hoàn và phí phạt.
  await audit(sql, user.id, "cancel_series", "booking_series", id, null, { weeks: rows.length, refunded, fees });
  return { status: 200, body: { cancelled: rows.length, refunded_vnd: refunded, fee_vnd: fees } };
}

/* ───────────────────────────── Loyalty ───────────────────────────── */

/** The balance, and the history a page at a time (`?limit=&offset=`, newest first). */
export async function meLoyalty(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Chỉ hội viên (member) mới có tài khoản điểm thưởng cá nhân.
  requireRole(user, ["member"]);
  // Bước 2: Đọc tham số phân trang lịch sử biến động điểm từ URL (mặc định 30 dòng/trang).
  const { limit, offset } = pageParams(request, { def: 30, max: 100 });
  // Bước 3: Lấy số dư điểm hiện tại, tỷ lệ quy đổi và ngưỡng đổi thưởng tối thiểu.
  const bal = await loyaltyBalance(sql, user.id);
  // Bước 4: Truy vấn lịch sử cộng/trừ điểm từ bảng loyalty_adjustments kèm mã khuyến mãi (nếu có).
  const rows = await sql.query<{ total: number } & Record<string, unknown>>(
    `select id, points, reason, note, created_at, promo_id,
            (select code from promotions p where p.id = la.promo_id) as promo_code,
            count(*) over ()::int as total
       from loyalty_adjustments la where user_id = $1 order by created_at desc limit $2 offset $3`,
    [user.id, limit, offset],
  );
  // Bước 5: Đóng gói số dư điểm và lịch sử có phân trang để trả về cho giao diện hội viên.
  const page = await pageOf(rows, { limit, offset }, async () =>
    ((await one<{ n: number }>(sql, `select count(*)::int as n from loyalty_adjustments where user_id = $1`, [user.id]))?.n ?? 0),
  );
  return { status: 200, body: { ...bal, history: page.items, history_total: page.total, limit, offset } };
}

/**
 * Làm gì: Tra cứu số dư điểm thưởng, tỷ lệ quy đổi và ngưỡng đổi thưởng của một hội viên cụ thể.
 * Được gọi ở:
 *   - Route GET /v1/members/:id/points (src/server/controllers/router.ts dòng 507).
 *   - Màn hình lễ tân/quản lý tra cứu thông tin chi tiết hội viên.
 * @param sql Kết nối database trong transaction đọc do router mở.
 * @param memberId Id của hội viên cần tra cứu điểm thưởng.
 * @param user Người dùng hiện tại; phải là receptionist hoặc manager.
 * @returns { status: 200, body: LoyaltyBalance } Số dư điểm và thông tin quy đổi điểm thưởng.
 * @throws Lỗi 403 nếu user không phải là receptionist hoặc manager.
 */
export async function memberLoyalty(sql: Sql, memberId: string, user: PublicUser) {
  // Bước 1: Chỉ lễ tân hoặc quản lý mới có quyền tra cứu điểm của hội viên khác.
  requireRole(user, ["receptionist", "manager"]);
  // Bước 2: Truy vấn số dư điểm và cấu hình quy đổi từ dịch vụ loyaltyBalance.
  return { status: 200, body: await loyaltyBalance(sql, memberId) };
}

/** Turn points into a single-use discount code the member can type at checkout. */
export async function loyaltyRedeem(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Chỉ hội viên sở hữu tài khoản mới được tự đổi điểm thưởng.
  requireRole(user, ["member"]);
  // Bước 2: Đọc số điểm khách muốn đổi từ request body.
  const b = await readJson(request);
  const points = num(b.points);
  // Bước 3: Khóa dòng user với FOR UPDATE để ngăn xung đột dữ liệu khi đổi điểm đồng thời.
  await sql.query(`select id from users where id = $1 for update`, [user.id]);
  // Bước 4: Lấy số dư điểm hiện tại và kiểm tra tính hợp lệ (phải đạt mức tối thiểu và không vượt quá số dư).
  const bal = await loyaltyBalance(sql, user.id);
  if (points == null || !Number.isInteger(points) || points < bal.min_redeem) {
    throw err.field("points", `Redeem at least ${bal.min_redeem} points.`);
  }
  if (points > bal.points) throw err.field("points", "You do not have that many points.");
  // Bước 5: Tính giá trị tiền tương ứng và sinh mã voucher ngẫu nhiên duy nhất.
  const value = points * bal.redeem_vnd;
  const suffix = (await nextCode(sql, "RWD")).replace(/[^0-9]/g, "");
  const code = `DIEM${suffix}`.slice(0, 24);
  // Bước 6: Tạo mã voucher giảm giá cá nhân (hạn 60 ngày, dùng 1 lần, áp dụng cho thuê sân hoặc mua gói tập).
  const promo = await one<{ id: string }>(
    sql,
    `insert into promotions (code, name, kind, value, ends_at, max_uses, max_per_member, applies_to, created_by)
     values ($1,$2,'amount',$3, now() + interval '60 days', 1, 1, ARRAY['court','plan'], $4) returning id`,
    [code, `Đổi ${points} điểm`, value, user.id],
  );
  // Bước 7: Ghi nhận giao dịch trừ điểm thưởng trong bảng loyalty_adjustments kèm liên kết mã khuyến mãi.
  await sql.query(
    `insert into loyalty_adjustments (user_id, points, reason, note, promo_id, created_by)
     values ($1,$2,'redeem',$3,$4,$1)`,
    [user.id, -points, `Đổi ${points} điểm lấy mã ${code}`, promo!.id],
  );
  // Bước 8: Ghi nhật ký audit lưu vết việc đổi điểm và trả về mã voucher cùng số điểm còn lại.
  await audit(sql, user.id, "redeem_points", "promotion", promo!.id, null, { points, value });
  return { status: 201, body: { code, value_vnd: value, points_left: bal.points - points } };
}

/** Staff goodwill: add or take back points, with a reason on record. */
export async function loyaltyAdjust(sql: Sql, memberId: string, request: Request, user: PublicUser) {
  // Bước 1: Chỉ quản lý (manager) mới có quyền điều chỉnh điểm thưởng của hội viên.
  requireRole(user, ["manager"]);
  // Bước 2: Đọc số điểm điều chỉnh và lý do từ request body.
  const b = await readJson(request);
  const points = num(b.points);
  const note = str(b.note);
  // Bước 3: Xác thực: điểm phải là số nguyên khác 0 và tối đa 100.000 điểm.
  if (points == null || !Number.isInteger(points) || points === 0 || Math.abs(points) > 100_000) {
    throw err.field("points", "Enter a whole number of points, not zero.");
  }
  if (!note) throw err.field("note", "Say why.");
  // Bước 4: Lưu bản ghi điều chỉnh điểm (reason là bonus nếu điểm dương, correction nếu điểm âm).
  await sql.query(
    `insert into loyalty_adjustments (user_id, points, reason, note, created_by)
     values ($1,$2,$3,$4,$5)`,
    [memberId, points, points > 0 ? "bonus" : "correction", note, user.id],
  );
  // Bước 5: Ghi nhật ký audit lưu vết việc điều chỉnh điểm kèm lý do.
  await audit(sql, user.id, "adjust_points", "user", memberId, null, { points, note });
  // Bước 6: Trả về số dư điểm mới nhất của hội viên sau khi điều chỉnh.
  return { status: 200, body: await loyaltyBalance(sql, memberId) };
}

/* ───────────────────────── Coach commission ───────────────────────── */

type CommissionRow = {
  coach_id: string;
  coach_name: string;
  per_session_vnd: number;
  per_student_vnd: number;
  sessions: number;
  students: number;
  amount_vnd: number;
  payout_status: "closed" | "paid" | null;
  paid_at: string | null;
};

/**
 * Làm gì: Xác định mốc thời gian bắt đầu (ngày đầu tháng) và kết thúc (ngày đầu tháng sau) theo múi giờ Việt Nam (ICT).
 * Được gọi ở:
 *   - commissionRows (trong file này, dòng 775).
 * @param period Chuỗi định dạng kỳ tính hoa hồng "YYYY-MM" (ví dụ: "2026-11").
 * @returns { from: string, to: string } Mốc thời gian ISO biểu diễn khoảng [từ đầu tháng, đến đầu tháng sau).
 */
function periodBounds(period: string) {
  // Tách năm và tháng từ chuỗi YYYY-MM để tính ngày đầu tháng và ngày đầu tháng kế tiếp.
  const [y, m] = period.split("-").map(Number) as [number, number];
  const from = ictDateTime(`${period}-01`, "00:00");
  // Xử lý chuyển sang năm mới nếu tháng hiện tại là tháng 12.
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const to = ictDateTime(`${ny}-${String(nm).padStart(2, "0")}-01`, "00:00");
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * Làm gì: Lấy chuỗi định dạng kỳ hiện tại "YYYY-MM" theo ngày giờ Việt Nam (ICT).
 * Được gọi ở:
 *   - readPeriod, commissionReport, commissionClose trong file này.
 * @returns Chuỗi kỳ hiện tại "YYYY-MM" (ví dụ: "2026-11").
 */
function thisPeriod(): string {
  return ictDateString().slice(0, 7);
}

/**
 * Làm gì: Tính toán hoặc tra cứu bảng thù lao/hoa hồng của huấn luyện viên trong một kỳ (tháng).
 *   Bao gồm số buổi đã dạy, số học viên có mặt và tổng tiền theo định mức (mặc định 150.000đ/buổi và 10.000đ/học viên).
 *   Nếu tháng đã chốt sổ (closed), số liệu được giữ nguyên từ bảng coach_payouts để không bị thay đổi bởi mức giá mới.
 * Được gọi ở:
 *   - commissionReport, commissionClose trong file này.
 * @param sql Kết nối database để thực thi câu truy vấn.
 * @param period Kỳ tính hoa hồng định dạng "YYYY-MM".
 * @param coachId Id huấn luyện viên cụ thể nếu chỉ lọc cho 1 người, hoặc bỏ trống nếu lấy tất cả.
 * @returns Danh sách dòng CommissionRow chứa chi tiết số buổi dạy, số học viên, định mức và tổng tiền thù lao.
 */
async function commissionRows(sql: Sql, period: string, coachId?: string): Promise<CommissionRow[]> {
  // Bước 1: Xác định khoảng thời gian đầu tháng đến đầu tháng sau để lọc các buổi dạy.
  const { from, to } = periodBounds(period);
  // Bước 2: Truy vấn số buổi dạy hoàn thành ('done') và số học viên có mặt ('present','late'), kết hợp với định mức riêng hoặc mặc định (150k/buổi, 10k/học viên).
  const rows = await sql.query<CommissionRow>(
    `with taught as (
        select cl.coach_id,
               count(*)::int as sessions,
               coalesce(sum((select count(*) from attendance a
                              where a.session_id = s.id and a.kind = 'session' and a.result in ('present','late'))), 0)::int as students
          from sessions s join classes cl on cl.id = s.class_id
         where s.status = 'done' and s.start_at >= $1::timestamptz and s.start_at < $2::timestamptz
         group by cl.coach_id
     )
     select u.id as coach_id, u.full_name as coach_name,
            coalesce(r.per_session_vnd, 150000) as per_session_vnd,
            coalesce(r.per_student_vnd, 10000) as per_student_vnd,
            coalesce(t.sessions, 0) as sessions, coalesce(t.students, 0) as students,
            coalesce(t.sessions, 0) * coalesce(r.per_session_vnd, 150000)
              + coalesce(t.students, 0) * coalesce(r.per_student_vnd, 10000) as amount_vnd,
            po.status as payout_status, po.paid_at::text as paid_at
       from users u
       left join coach_rates r on r.coach_id = u.id
       left join taught t on t.coach_id = u.id
       left join coach_payouts po on po.coach_id = u.id and po.period = $3
      where u.role = 'coach' and ($4::uuid is null or u.id = $4)
      order by u.full_name`,
    [from, to, period, coachId ?? null],
  );
  // A closed month is frozen: show what was paid, not what today's rates would give.
  // Bước 3: Nếu tháng đã được chốt (đã lưu vào coach_payouts), ghi đè lại số liệu đã chốt để tránh bị ảnh hưởng bởi thay đổi định mức sau này.
  const frozen = await sql.query<{ coach_id: string; sessions: number; students: number; amount_vnd: number }>(
    `select coach_id, sessions, students, amount_vnd from coach_payouts where period = $1`,
    [period],
  );
  for (const r of rows) {
    const f = frozen.find((x) => x.coach_id === r.coach_id);
    if (f) {
      r.sessions = f.sessions;
      r.students = f.students;
      r.amount_vnd = f.amount_vnd;
    }
  }
  return rows;
}

/**
 * Làm gì: Đọc tham số kỳ "period" từ URL search params, kiểm tra định dạng "YYYY-MM", mặc định là kỳ hiện tại nếu không truyền.
 * Được gọi ở:
 *   - commissionReport (trong file này, dòng 825).
 * @param request Request HTTP GET gửi lên server.
 * @returns Chuỗi kỳ hợp lệ dạng "YYYY-MM".
 * @throws Lỗi 400 (validation) nếu định dạng period không khớp biểu thức chính quy PERIOD_RE (YYYY-MM).
 */
function readPeriod(request: Request): string {
  const p = new URL(request.url).searchParams.get("period") ?? thisPeriod();
  if (!PERIOD_RE.test(p)) throw err.validation("period must be YYYY-MM.");
  return p;
}

/**
 * Làm gì: Lấy báo cáo tổng hợp hoa hồng và thù lao huấn luyện viên theo tháng cho cấp quản lý xem.
 * Được gọi ở:
 *   - Route GET /v1/commission (src/server/controllers/router.ts dòng 514).
 *   - Màn hình quản lý hoa hồng (src/routes/manager.commission.tsx, qua useRead("/commission?period=...")).
 * @param sql Kết nối database trong transaction đọc do router mở.
 * @param request Request GET /v1/commission kèm query param period (YYYY-MM).
 * @param user Người dùng hiện tại; bắt buộc phải là quản lý (manager).
 * @returns { status: 200, body: CommissionReport } Báo cáo gồm kỳ tính, danh sách huấn luyện viên và tổng chi phí.
 * @throws Lỗi 403 nếu user không phải là manager.
 *   Lỗi 400 nếu period không đúng định dạng YYYY-MM.
 */
export async function commissionReport(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Chỉ quản lý mới có quyền xem báo cáo thù lao huấn luyện viên.
  requireRole(user, ["manager"]);
  // Bước 2: Đọc kỳ báo cáo từ query string (mặc định là tháng hiện tại).
  const period = readPeriod(request);
  // Bước 3: Tính toán danh sách thù lao từng huấn luyện viên trong kỳ.
  const items = await commissionRows(sql, period);
  // Bước 4: Tính tổng chi phí thù lao của toàn bộ huấn luyện viên và trả về kết quả.
  return {
    status: 200,
    body: {
      period,
      current: thisPeriod(),
      items,
      total_vnd: items.reduce((a, r) => a + r.amount_vnd, 0),
    },
  };
}

/**
 * Làm gì: Cài đặt hoặc cập nhật định mức thù lao riêng cho một huấn luyện viên (tiền theo buổi dạy và tiền theo từng học viên).
 * Được gọi ở:
 *   - Route PATCH /v1/commission/rates/:coachId (src/server/controllers/router.ts dòng 520).
 *   - Màn hình quản lý hoa hồng (src/routes/manager.commission.tsx, qua apiPatch).
 * @param sql Kết nối database trong transaction do router mở.
 * @param coachId Id của huấn luyện viên cần thiết lập định mức.
 * @param request Request PATCH chứa body JSON: per_session_vnd và per_student_vnd.
 * @param user Người dùng thực hiện; bắt buộc phải là quản lý (manager).
 * @returns { status: 200, body: { ok: true } } Xác nhận cập nhật thành công.
 * @throws Lỗi 403 nếu user không phải là manager.
 *   Lỗi 400 nếu số tiền không phải số nguyên không âm hợp lệ (0 đến 10 triệu đồng).
 *   Lỗi 404 nếu không tìm thấy huấn luyện viên với id đã truyền.
 */
export async function commissionRate(sql: Sql, coachId: string, request: Request, user: PublicUser) {
  // Bước 1: Chỉ quản lý mới có quyền điều chỉnh định mức thù lao của huấn luyện viên.
  requireRole(user, ["manager"]);
  // Bước 2: Đọc định mức thù lao mỗi buổi dạy và mỗi học viên từ body request.
  const b = await readJson(request);
  const perSession = num(b.per_session_vnd);
  const perStudent = num(b.per_student_vnd);
  // Bước 3: Xác thực định mức phải là số nguyên không âm và tối đa 10.000.000 VNĐ.
  for (const [k, v] of [["per_session_vnd", perSession], ["per_student_vnd", perStudent]] as const) {
    if (v == null || !Number.isInteger(v) || v < 0 || v > 10_000_000) {
      throw err.field(k, "Enter a whole amount in đồng, 0 or more.");
    }
  }
  // Bước 4: Kiểm tra sự tồn tại của huấn luyện viên trong hệ thống.
  const coach = await one(sql, `select id from users where id = $1 and role = 'coach'`, [coachId]);
  if (!coach) throw err.notFound("No such coach.");
  // Bước 5: Lưu định mức vào bảng coach_rates (sử dụng UPSERT để thêm mới hoặc cập nhật nếu đã có).
  await sql.query(
    `insert into coach_rates (coach_id, per_session_vnd, per_student_vnd) values ($1,$2,$3)
     on conflict (coach_id) do update set per_session_vnd = $2, per_student_vnd = $3, updated_at = now()`,
    [coachId, perSession, perStudent],
  );
  // Bước 6: Ghi nhật ký audit lưu vết định mức mới được cập nhật.
  await audit(sql, user.id, "set_coach_rate", "user", coachId, null, { perSession, perStudent });
  return { status: 200, body: { ok: true } };
}

/** Freeze a finished month: the figures are copied so a later rate change cannot rewrite them. */
/**
 * Làm gì: Chốt kỳ tính hoa hồng/thù lao của các HLV trong tháng đã qua và lưu cố định vào bảng coach_payouts.
 * Việc này giúp đóng băng số liệu thực nhận, đảm bảo các thay đổi biểu giá sau này không làm sai lệch số tiền của tháng cũ.
 * Được gọi ở:
 * - Giao diện quản lý hoa hồng: src/routes/manager.commission.tsx (nút "Chốt tháng" / "Close month").
 * - Router điều hướng: src/server/controllers/router.ts (route POST /v1/commission/close hoặc /api/commission/close).
 * @param sql Kết nối database trong transaction do router quản lý.
 * @param request Request POST chứa body JSON với trường period (định dạng YYYY-MM).
 * @param user Thông tin người thực hiện, yêu cầu vai trò quản lý (manager).
 * @returns { status: 200, body: { period, closed } } với closed là số lượng HLV đã được chốt số liệu.
 * @throws Lỗi 403 nếu không phải manager; lỗi 400 nếu period sai định dạng; lỗi 409 nếu tháng chưa kết thúc.
 */
export async function commissionClose(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền quản lý (manager) và giải mã chu kỳ tháng (period) từ body request.
  requireRole(user, ["manager"]);
  const b = await readJson(request);
  const period = str(b.period) ?? "";
  if (!PERIOD_RE.test(period)) throw err.field("period", "Pick a month.");
  // Ràng buộc nghiệp vụ: Chỉ được chốt tháng cũ đã hoàn toàn kết thúc; không cho phép chốt tháng hiện tại hoặc tương lai.
  if (period >= thisPeriod()) throw err.conflictState("A month can be closed only after it has ended.");
  // Bước 2: Tính toán danh sách số liệu hoa hồng của tất cả HLV trong tháng theo biểu giá và lịch dạy thực tế.
  const rows = await commissionRows(sql, period);
  // Bước 3: Đóng băng dữ liệu bằng cách lưu số liệu vào bảng coach_payouts.
  let closed = 0;
  for (const r of rows) {
    // Bỏ qua nếu HLV đã được chốt/chi trả trước đó hoặc không dạy buổi nào trong tháng.
    if (r.payout_status) continue;
    if (r.sessions === 0) continue;
    // Ghi nhận snapshot số liệu hoa hồng; dùng ON CONFLICT DO NOTHING để chống ghi đè hoặc trùng lặp.
    await sql.query(
      `insert into coach_payouts (coach_id, period, sessions, students, amount_vnd, closed_by)
       values ($1,$2,$3,$4,$5,$6) on conflict (coach_id, period) do nothing`,
      [r.coach_id, period, r.sessions, r.students, r.amount_vnd, user.id],
    );
    closed += 1;
  }
  // Bước 4: Ghi log kiểm toán (audit) hành động chốt hoa hồng và trả về kết quả số lượng HLV đã chốt.
  await audit(sql, user.id, "close_commission", "coach_payout", null, null, { period, closed });
  return { status: 200, body: { period, closed } };
}

/**
 * Làm gì: Đánh dấu khoản hoa hồng của một HLV trong tháng đã được chi trả thực tế (chuyển status thành 'paid').
 * Được gọi ở:
 * - Giao diện quản lý hoa hồng: src/routes/manager.commission.tsx (nút "Đã thanh toán" / "Mark as paid").
 * - Router điều hướng: src/server/controllers/router.ts (route POST /v1/commission/pay/:coachId hoặc /api/commission/pay/:coachId).
 * @param sql Kết nối database trong transaction do router quản lý.
 * @param coachId ID của huấn luyện viên được thanh toán hoa hồng.
 * @param request Request POST chứa body JSON với chu kỳ tháng period (định dạng YYYY-MM).
 * @param user Thông tin người thực hiện, yêu cầu quyền quản lý (manager).
 * @returns { status: 200, body: { ok: true } }.
 * @throws Lỗi 403 nếu không phải manager; lỗi 400 nếu period sai định dạng; lỗi 409 nếu chưa chốt tháng hoặc tháng đã thanh toán rồi.
 */
export async function commissionPay(sql: Sql, coachId: string, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền manager và đọc chu kỳ tháng (period) từ body request.
  requireRole(user, ["manager"]);
  const b = await readJson(request);
  const period = str(b.period) ?? "";
  if (!PERIOD_RE.test(period)) throw err.field("period", "Pick a month.");
  // Bước 2: Khóa bản ghi thanh toán (FOR UPDATE) để ngăn chặn việc bấm nút thanh toán đồng thời nhiều lần.
  const po = await one<{ status: string }>(sql, `select status from coach_payouts where coach_id = $1 and period = $2 for update`, [coachId, period]);
  // Ràng buộc nghiệp vụ: Bắt buộc phải chốt tháng trước khi thanh toán và không được thanh toán lại kỳ đã trả tiền.
  if (!po) throw err.conflictState("Close the month first.");
  if (po.status === "paid") throw err.conflictState("That month is already paid.");
  // Bước 3: Cập nhật trạng thái sang 'paid' và ghi nhận thời điểm chi trả thực tế (paid_at = now()).
  await sql.query(`update coach_payouts set status = 'paid', paid_at = now() where coach_id = $1 and period = $2`, [coachId, period]);
  // Bước 4: Ghi nhật ký kiểm toán (audit) và trả về kết quả thành công.
  await audit(sql, user.id, "pay_commission", "coach_payout", null, null, { coachId, period });
  return { status: 200, body: { ok: true } };
}

/**
 * Làm gì: Lấy bảng kê thu nhập, chi tiết các buổi dạy đã hoàn thành và lịch sử chi trả thù lao cho HLV đang đăng nhập.
 * Được gọi ở:
 * - Giao diện HLV: src/routes/coach.earnings.tsx (màn hình "Thu nhập của tôi" / "My Earnings").
 * - Router điều hướng: src/server/controllers/router.ts (route GET /v1/me/earnings hoặc /api/me/earnings).
 * @param sql Kết nối database (chỉ đọc).
 * @param request Request GET có thể kèm query param period (định dạng YYYY-MM, mặc định là tháng hiện tại).
 * @param user Thông tin tài khoản đăng nhập (bắt buộc vai trò coach).
 * @returns { status: 200, body: { period, current, summary, sessions, history } }.
 * @throws Lỗi 403 nếu người dùng không phải là HLV (coach); lỗi 400 nếu period không đúng định dạng.
 */
export async function coachEarnings(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Xác thực quyền HLV (coach) và lấy chu kỳ tháng từ URL (mặc định là tháng hiện tại).
  requireRole(user, ["coach"]);
  const period = readPeriod(request);
  // Bước 2: Tính tổng hợp thù lao của HLV trong kỳ (số buổi, số học viên, tổng tiền tính theo mức thù lao).
  const [row] = await commissionRows(sql, period, user.id);
  // Bước 3: Lấy danh sách tối đa 100 buổi dạy đã hoàn thành trong tháng để HLV đối chiếu chi tiết từng buổi.
  const { from, to } = periodBounds(period);
  // Chỉ đếm học viên thực tế tham gia (có mặt 'present' hoặc đi trễ 'late') để tính phụ cấp học viên theo sĩ số.
  const sessions = await sql.query(
    `select s.id, s.start_at, cl.level, c.court_code,
            (select count(*)::int from attendance a where a.session_id = s.id and a.kind = 'session' and a.result in ('present','late')) as students
       from sessions s join classes cl on cl.id = s.class_id join courts c on c.id = s.court_id
      where cl.coach_id = $1 and s.status = 'done' and s.start_at >= $2::timestamptz and s.start_at < $3::timestamptz
      order by s.start_at desc limit 100`,
    [user.id, from, to],
  );
  // Bước 4: Lấy lịch sử quyết toán hoa hồng trong 12 tháng gần nhất từ bảng coach_payouts.
  const history = await sql.query(
    `select period, sessions, students, amount_vnd, status, paid_at from coach_payouts where coach_id = $1 order by period desc limit 12`,
    [user.id],
  );
  // Bước 5: Trả về dữ liệu thu nhập, tổng hợp thù lao và lịch sử thanh toán cho giao diện HLV.
  return { status: 200, body: { period, current: thisPeriod(), summary: row ?? null, sessions, history } };
}

/* ───────────────────── Maintenance work orders ───────────────────── */

// Các mức độ ưu tiên (WO_PRIORITY) và trạng thái vòng đời (WO_STATUS) của phiếu bảo trì thiết bị/sân bãi.
const WO_PRIORITY = ["low", "normal", "urgent"];
const WO_STATUS = ["open", "in_progress", "done", "cancelled"];

/**
 * Làm gì: Đồng bộ trạng thái của sân (courts.status) theo các phiếu bảo trì đang hoạt động.
 * Nếu còn ít nhất một phiếu 'open' hoặc 'in_progress' có blocks_court = true thì chuyển sân sang 'maintenance', ngược lại trả về 'ready'.
 * Được gọi ở:
 * - Trong extras.ts: hàm workOrdersCreate và workOrdersPatch (sau khi tạo hoặc cập nhật phiếu bảo trì).
 * @param sql Kết nối database.
 * @param courtId ID của sân thể thao (nếu null thì bỏ qua).
 * @returns Không trả về giá trị (Promise<void>).
 */
async function syncCourtBlock(sql: Sql, courtId: string | null) {
  // Bỏ qua nếu phiếu bảo trì không liên quan đến sân thể thao cụ thể.
  if (!courtId) return;
  // Bước 1: Đếm số phiếu bảo trì đang hoạt động ('open' hoặc 'in_progress') có yêu cầu khóa sân.
  const blocking = await one<{ n: number }>(
    sql,
    `select count(*)::int as n from work_orders where court_id = $1 and blocks_court and status in ('open','in_progress')`,
    [courtId],
  );
  // Bước 2: Cập nhật trạng thái sân: chuyển sang 'maintenance' nếu có phiếu chặn, hoặc khôi phục 'ready' nếu đã hết phiếu chặn.
  if ((blocking?.n ?? 0) > 0) {
    await sql.query(`update courts set status = 'maintenance' where id = $1 and status = 'ready'`, [courtId]);
  } else {
    await sql.query(`update courts set status = 'ready' where id = $1 and status = 'maintenance'`, [courtId]);
  }
}

/**
 * Làm gì: Lấy danh sách phiếu bảo trì có phân trang và lọc theo trạng thái, kèm thống kê tổng số phiếu mở, khẩn cấp và chi phí trong tháng.
 * Được gọi ở:
 * - Giao diện quầy lễ tân: src/routes/desk.maintenance.tsx (màn hình "Bảo trì" / "Desk Maintenance").
 * - Router điều hướng: src/server/controllers/router.ts (route GET /v1/work-orders hoặc /api/work-orders).
 * @param sql Kết nối database (chỉ đọc).
 * @param request Request GET chứa query params: status ("active", "open", "in_progress", "done", "cancelled"), limit, offset.
 * @param user Thông tin tài khoản đăng nhập (receptionist, manager hoặc coach).
 * @returns { status: 200, body: { items, total, limit, offset, open, urgent, cost_month_vnd } }.
 * @throws Lỗi 403 nếu người dùng không thuộc các vai trò được phép truy cập.
 */
export async function workOrdersList(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền truy cập (lễ tân, quản lý hoặc HLV) và xử lý bộ lọc trạng thái (mặc định 'active' gồm open và in_progress).
  requireRole(user, ["receptionist", "manager", "coach"]);
  const status = new URL(request.url).searchParams.get("status");
  // "active" is the desk's default view: open or in progress.
  const statusFilter = status === "active" || (status && WO_STATUS.includes(status)) ? status : null;
  const { limit, offset } = pageParams(request, { def: 200, max: 200 });
  // Bước 2: Truy vấn danh sách phiếu bảo trì kèm mã sân, người báo cáo; sắp xếp ưu tiên phiếu chưa xong và phiếu khẩn cấp lên đầu.
  const rows = await sql.query<{ total: number } & Record<string, unknown>>(
    `select w.id, w.code, w.court_id, c.court_code, w.title, w.description, w.priority, w.status, w.blocks_court,
            w.assignee, w.cost_vnd, w.resolution, w.created_at, w.closed_at, u.full_name as reporter,
            count(*) over ()::int as total
       from work_orders w
       left join courts c on c.id = w.court_id
       left join users u on u.id = w.reported_by
      where ($1::text is null or w.status = $1 or ($1 = 'active' and w.status in ('open','in_progress')))
      order by (w.status in ('done','cancelled')), (w.priority = 'urgent') desc, w.created_at desc
      limit $2 offset $3`,
    [statusFilter, limit, offset],
  );
  // Bước 3: Đóng gói dữ liệu kết quả theo chuẩn phân trang (pageOf).
  const page = await pageOf(rows, { limit, offset }, async () =>
    ((await one<{ n: number }>(sql, `select count(*)::int as n from work_orders where ($1::text is null or status = $1 or ($1 = 'active' and status in ('open','in_progress')))`, [statusFilter]))?.n ?? 0),
  );
  const items = page.items;
  // Bước 4: Thống kê số phiếu đang mở, số phiếu khẩn cấp và tổng chi phí sửa chữa của các phiếu đã hoàn thành trong tháng hiện tại.
  const sum = await one<{ open: number; urgent: number; cost: number }>(
    sql,
    `select count(*) filter (where status in ('open','in_progress'))::int as open,
            count(*) filter (where status in ('open','in_progress') and priority = 'urgent')::int as urgent,
            coalesce(sum(cost_vnd) filter (where status = 'done' and closed_at >= date_trunc('month', now())), 0)::int as cost
       from work_orders`,
  );
  // Bước 5: Trả về danh sách phiếu bảo trì kèm các chỉ số thống kê tổng quan cho màn hình lễ tân.
  return {
    status: 200,
    body: { items, total: page.total, limit, offset, open: sum?.open ?? 0, urgent: sum?.urgent ?? 0, cost_month_vnd: sum?.cost ?? 0 },
  };
}

/**
 * Làm gì: Tạo mới phiếu yêu cầu bảo trì/sửa chữa (work order).
 * Nếu phiếu có cờ đóng sân (blocks_court = true), kiểm tra xung đột lịch và tự động giải phóng các lượt đặt sân/buổi học bị ảnh hưởng.
 * Được gọi ở:
 * - Giao diện quầy: src/routes/desk.maintenance.tsx (hộp thoại tạo mới phiếu bảo trì).
 * - Bộ kiểm thử: src/server/controllers/tx.test.ts (trong test case tạo phiếu bảo trì).
 * - Router điều hướng: src/server/controllers/router.ts (route POST /v1/work-orders hoặc /api/work-orders).
 * @param sql Kết nối database trong transaction do router quản lý.
 * @param request Request POST chứa body JSON: title, description, priority, court_id, blocks_court, confirm.
 * @param user Người tạo phiếu (receptionist, manager hoặc coach).
 * @returns { status: 201, body: { id, code } } với id và mã phiếu (tiền tố WO).
 * @throws Lỗi 403 nếu không đủ quyền; lỗi 400 nếu thiếu tiêu đề hoặc mức ưu tiên không hợp lệ; lỗi 404 nếu mã sân không tồn tại; lỗi 409 nếu đóng sân mà có lịch trùng chưa được xác nhận.
 */
export async function workOrdersCreate(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền truy cập và xác thực dữ liệu đầu vào (tiêu đề tối đa 160 ký tự, mức ưu tiên, kiểm tra sân tồn tại và chưa bị ngừng dùng).
  requireRole(user, ["receptionist", "manager", "coach"]);
  const b = await readJson(request);
  const title = str(b.title);
  if (!title) throw err.field("title", "Say what is broken.");
  if (title.length > 160) throw err.field("title", "Keep the title under 160 characters.");
  const priority = str(b.priority) ?? "normal";
  if (!WO_PRIORITY.includes(priority)) throw err.field("priority", "Pick low, normal or urgent.");
  const courtId = str(b.court_id) || null;
  if (courtId) await one(sql, `select 1 from courts where id = $1 and retired_at is null`, [courtId]).then((r) => { if (!r) throw err.notFound("No such court."); });
  // Bước 2: Nếu phiếu yêu cầu khóa sân, kiểm tra và giải phóng các lượt đặt sân/buổi học bị ảnh hưởng (yêu cầu confirm = true nếu có lịch trùng).
  const blocks = b.blocks_court === true && !!courtId;
  if (blocks) await blockCourtCommitments(sql, courtId!, b.confirm === true, user);
  // Bước 3: Tạo mã phiếu mới tự tăng theo định dạng WO-xxxx và chèn bản ghi vào bảng work_orders.
  const code = await nextCode(sql, "WO");
  const row = await one<{ id: string }>(
    sql,
    `insert into work_orders (code, court_id, title, description, priority, blocks_court, reported_by)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [code, courtId, title, str(b.description) ?? null, priority, blocks, user.id],
  );
  // Bước 4: Đồng bộ trạng thái sân sang 'maintenance', ghi nhật ký kiểm toán và trả về ID cùng mã phiếu vừa tạo.
  await syncCourtBlock(sql, courtId);
  await audit(sql, user.id, "create_work_order", "work_order", row!.id, null, { title, priority, blocks });
  return { status: 201, body: { id: row!.id, code } };
}

/**
 * Làm gì: Cập nhật thông tin phiếu bảo trì: đổi trạng thái, độ ưu tiên, người phụ trách, chi phí, giải pháp hoặc cờ chặn sân.
 * Khi cập nhật làm phát sinh chặn sân, hàm sẽ kiểm tra xung đột và yêu cầu xác nhận trước khi hủy lịch của khách.
 * Được gọi ở:
 * - Giao diện quầy: src/routes/desk.maintenance.tsx (các thao tác chuyển trạng thái, cập nhật chi phí, đóng phiếu).
 * - Bộ kiểm thử: src/server/controllers/tx.test.ts (trong test case cập nhật trạng thái phiếu bảo trì).
 * - Router điều hướng: src/server/controllers/router.ts (route PATCH /v1/work-orders/:id hoặc /api/work-orders/:id).
 * @param sql Kết nối database trong transaction do router quản lý.
 * @param id ID của phiếu bảo trì cần cập nhật.
 * @param request Request PATCH chứa body JSON với các trường cần sửa.
 * @param user Thông tin người thực hiện, yêu cầu vai trò receptionist hoặc manager.
 * @returns { status: 200, body: { ok: true } }.
 * @throws Lỗi 403 nếu không đủ quyền; lỗi 404 nếu không tìm thấy phiếu; lỗi 400 nếu dữ liệu cập nhật không hợp lệ; lỗi 409 nếu đóng sân có lịch trùng chưa xác nhận.
 */
export async function workOrdersPatch(sql: Sql, id: string, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền nhân viên (lễ tân hoặc quản lý) và khóa bản ghi hiện tại (FOR UPDATE) để đọc thông tin cũ.
  requireRole(user, ["receptionist", "manager"]);
  const b = await readJson(request);
  const cur = await one<{ court_id: string | null; status: string; blocks_court: boolean }>(sql, `select court_id, status, blocks_court from work_orders where id = $1 for update`, [id]);
  if (!cur) throw err.notFound();
  // Bước 2: Xác thực các trường dữ liệu cần cập nhật (trạng thái hợp lệ, độ ưu tiên, chi phí là số nguyên không âm tối đa 1 tỷ đồng).
  const status = str(b.status);
  if (status !== undefined && !WO_STATUS.includes(status)) throw err.field("status", "Unknown status.");
  const priority = str(b.priority);
  if (priority !== undefined && !WO_PRIORITY.includes(priority)) throw err.field("priority", "Pick low, normal or urgent.");
  const cost = b.cost_vnd === undefined ? undefined : num(b.cost_vnd);
  if (b.cost_vnd !== undefined && (cost == null || !Number.isInteger(cost) || cost < 0 || cost > 1_000_000_000)) {
    throw err.field("cost_vnd", "Enter the cost in whole đồng.");
  }
  // Bước 3: Nếu chuyển từ trạng thái không chặn sân sang trạng thái chặn sân, kiểm tra và giải phóng các lịch bị ảnh hưởng.
  const closing = status === "done" || status === "cancelled";
  const nextBlocks = typeof b.blocks_court === "boolean" ? b.blocks_court : cur.blocks_court;
  if (cur.court_id && nextBlocks && ["open", "in_progress"].includes(status ?? cur.status)
      && (!cur.blocks_court || !["open", "in_progress"].includes(cur.status))) {
    await blockCourtCommitments(sql, cur.court_id, b.confirm === true, user);
  }
  // Bước 4: Cập nhật thông tin phiếu bảo trì; tự động cập nhật closed_at khi đóng phiếu (hoặc xóa closed_at nếu mở lại phiếu).
  await sql.query(
    `update work_orders set
        status = coalesce($2, status),
        priority = coalesce($3, priority),
        assignee = case when $4::boolean then $5 else assignee end,
        cost_vnd = coalesce($6, cost_vnd),
        resolution = case when $7::boolean then $8 else resolution end,
        blocks_court = coalesce($9, blocks_court),
        closed_at = case when $10::boolean then now() when $2 in ('open','in_progress') then null else closed_at end
      where id = $1`,
    [
      id,
      status ?? null,
      priority ?? null,
      b.assignee !== undefined,
      str(b.assignee) || null,
      cost ?? null,
      b.resolution !== undefined,
      str(b.resolution) || null,
      typeof b.blocks_court === "boolean" ? b.blocks_court : null,
      closing && !["done", "cancelled"].includes(cur.status),
    ],
  );
  // Bước 5: Đồng bộ lại trạng thái sân ('ready' hoặc 'maintenance') dựa trên các phiếu còn tồn tại và ghi nhật ký kiểm toán.
  await syncCourtBlock(sql, cur.court_id);
  await audit(sql, user.id, "patch_work_order", "work_order", id, { status: cur.status }, { status: status ?? cur.status });
  return { status: 200, body: { ok: true } };
}

/* ───────────────────────────── E-invoice ───────────────────────────── */

/**
 * Làm gì: Mã hóa (escape) các ký tự đặc biệt của XML (<, >, &, ", ') thành thực thể an toàn nhằm chống lỗi cú pháp và XML Injection.
 * Được gọi ở:
 * - Trong extras.ts: hàm invoiceXml (khi sinh dữ liệu các thẻ XML).
 * @param v Giá trị bất kỳ cần chuyển thành chuỗi và escape XML.
 * @returns Chuỗi ký tự an toàn đã được thay thế ký tự đặc biệt bằng XML entity.
 */
function esc(v: unknown): string {
  // Thay thế từng ký tự đặc biệt bằng thực thể XML tương ứng.
  return String(v ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

type InvoiceExportRow = {
  id: string;
  code: string;
  issued_at: string;
  form_no: string | null;
  serial_no: string | null;
  buyer_name: string;
  buyer_tax_code: string | null;
  buyer_address: string | null;
  buyer_phone: string | null;
  seller_legal_name: string | null;
  seller_tax_code: string | null;
  seller_address: string | null;
  subtotal_vnd: number | null;
  vat_rate: string | number | null;
  vat_vnd: number | null;
  total_vnd: number | null;
  method: string;
  amount_vnd: number;
  payment_code: string;
  status: string;
  kind: "sale" | "adjustment";
  adj_code: string | null;
  adj_form_no: string | null;
  adj_serial_no: string | null;
  adj_issued_at: string | null;
};

const EXPORT_SELECT = `select i.id, i.code, i.issued_at::text as issued_at, i.form_no, i.serial_no, i.buyer_name, i.buyer_tax_code,
        i.buyer_address, i.buyer_phone, i.seller_legal_name, i.seller_tax_code, i.seller_address,
        i.subtotal_vnd, i.vat_rate, i.vat_vnd, i.total_vnd,
        p.method::text as method, p.amount_vnd, p.code as payment_code, p.status::text as status,
        i.kind, o.code as adj_code, o.form_no as adj_form_no, o.serial_no as adj_serial_no, o.issued_at::text as adj_issued_at
   from invoices i join payments p on p.id = i.payment_id
   left join invoices o on o.id = i.adjusts_invoice_id`;

/**
 * An invoice as the structured data Vietnamese e-invoice providers import.
 * The shape follows the field groups of Circular 78 (general data, seller,
 * buyer, goods lines, totals). It is NOT a legally issued e-invoice: that needs
 * a digital signature and a tax-authority code from an accredited provider, so
 * this file is the hand-off to that provider or to the accountant.
 */
/**
 * Làm gì: Tạo chuỗi XML hóa đơn điện tử theo chuẩn dữ liệu quy định tại Thông tư 78/2021/TT-BTC để nạp vào hệ thống hóa đơn hoặc gửi kế toán.
 * Được gọi ở:
 * - Trong extras.ts: hàm invoiceXmlOne và invoiceExport (khi xuất file XML).
 * @param inv Dữ liệu tổng thể của hóa đơn (thông tin người mua, người bán, số tiền, hình thức thanh toán).
 * @param lines Danh sách các dòng mặt hàng hoặc dịch vụ chi tiết của hóa đơn.
 * @returns Chuỗi XML hoàn chỉnh của thẻ <HDon>.
 */
function invoiceXml(inv: InvoiceExportRow, lines: { description: string; unit: string | null; qty: number; unit_vnd: number; amount_vnd: number }[]) {
  // Bước 1: Tính toán thuế suất, tổng tiền thanh toán, tiền trước thuế và tiền thuế VAT (fallback sang amount_vnd nếu chưa có total_vnd).
  const rate = Number(inv.vat_rate ?? 0);
  const total = inv.total_vnd ?? inv.amount_vnd;
  const sub = inv.subtotal_vnd ?? total;
  const vat = inv.vat_vnd ?? total - sub;
  // Bước 2: Ghép các khối XML theo quy chuẩn Thông tư 78: TTChung (quy đổi phương thức thanh toán sang TM/CK), NBan, NMua, DSHHDVu, TToan.
  return [
    `<HDon>`,
    `  <DLHDon Id="${esc(inv.code)}">`,
    `    <TTChung>`,
    `      <KHMSHDon>${esc(inv.form_no ?? "1")}</KHMSHDon>`,
    `      <KHHDon>${esc(inv.serial_no ?? "")}</KHHDon>`,
    `      <SHDon>${esc(inv.code)}</SHDon>`,
    `      <NLap>${esc(inv.issued_at.slice(0, 10))}</NLap>`,
    `      <DVTTe>VND</DVTTe>`,
    `      <HTTToan>${esc(inv.method === "cash" ? "TM" : inv.method === "transfer" ? "CK" : inv.method === "card" ? "TM/CK" : "Khác")}</HTTToan>`,
    // Hóa đơn điều chỉnh (TCHDon 2) phải dẫn chiếu hóa đơn bị điều chỉnh: mẫu số, ký hiệu, số, ngày lập.
    ...(inv.kind === "adjustment"
      ? [
          `      <TTHDLQuan><TCHDon>2</TCHDon><LHDCLQuan>1</LHDCLQuan><KHMSHDCLQuan>${esc(inv.adj_form_no ?? "")}</KHMSHDCLQuan><KHHDCLQuan>${esc(inv.adj_serial_no ?? "")}</KHHDCLQuan><SHDCLQuan>${esc(inv.adj_code ?? "")}</SHDCLQuan><NLHDCLQuan>${esc(inv.adj_issued_at?.slice(0, 10) ?? "")}</NLHDCLQuan></TTHDLQuan>`,
        ]
      : []),
    `    </TTChung>`,
    `    <NDHDon>`,
    `      <NBan><Ten>${esc(inv.seller_legal_name)}</Ten><MST>${esc(inv.seller_tax_code)}</MST><DChi>${esc(inv.seller_address)}</DChi></NBan>`,
    `      <NMua><Ten>${esc(inv.buyer_name)}</Ten><MST>${esc(inv.buyer_tax_code)}</MST><DChi>${esc(inv.buyer_address)}</DChi><SDThoai>${esc(inv.buyer_phone)}</SDThoai></NMua>`,
    `      <DSHHDVu>`,
    ...lines.map(
      (l, i) =>
        `        <HHDVu><STT>${i + 1}</STT><THHDVu>${esc(l.description)}</THHDVu><DVTinh>${esc(l.unit)}</DVTinh><SLuong>${l.qty}</SLuong><DGia>${l.unit_vnd}</DGia><ThTien>${l.amount_vnd}</ThTien><TSuat>${rate}%</TSuat></HHDVu>`,
    ),
    `      </DSHHDVu>`,
    `      <TToan><TgTCThue>${sub}</TgTCThue><TgTThue>${vat}</TgTThue><TgTTTBSo>${total}</TgTTTBSo></TToan>`,
    `    </NDHDon>`,
    `  </DLHDon>`,
    `</HDon>`,
  ].join("\n");
}

/**
 * Làm gì: Tạo HTTP Response chứa nội dung XML kèm header tải file đính kèm (Content-Disposition: attachment).
 * Được gọi ở:
 * - Trong extras.ts: hàm invoiceXmlOne và invoiceExport.
 * @param name Tên file tải về (ví dụ "HD-001.xml").
 * @param body Nội dung XML hoàn chỉnh (không bao gồm XML declaration).
 * @returns HTTP Response 200 với content-type application/xml và khai báo <?xml version="1.0" encoding="UTF-8"?>.
 */
function xmlResponse(name: string, body: string) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    status: 200,
    headers: { "content-type": "application/xml; charset=utf-8", "content-disposition": `attachment; filename="${name}"` },
  });
}

/**
 * Làm gì: Tải về file XML chi tiết của một hóa đơn cụ thể theo ID để kiểm tra hoặc nhập vào phần mềm hóa đơn điện tử.
 * Được gọi ở:
 * - Router điều hướng: src/server/controllers/router.ts (route GET /v1/invoices/:id.xml hoặc /api/invoices/:id.xml).
 * @param sql Kết nối database (chỉ đọc).
 * @param id ID của hóa đơn cần xuất XML.
 * @param user Thông tin người dùng đăng nhập (manager hoặc receptionist).
 * @returns HTTP Response trả về file XML tải về với tên "<mã_hóa_đơn>.xml".
 * @throws Lỗi 403 nếu không phải quản lý hoặc lễ tân; lỗi 404 nếu không tìm thấy hóa đơn.
 */
export async function invoiceXmlOne(sql: Sql, id: string, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn của người dùng (manager hoặc receptionist).
  requireRole(user, ["manager", "receptionist"]);
  // Bước 2: Truy vấn thông tin tổng thể của hóa đơn kết hợp thông tin thanh toán từ bảng payments.
  const inv = await one<InvoiceExportRow>(sql, `${EXPORT_SELECT} where i.id = $1`, [id]);
  if (!inv) throw err.notFound();
  // Bước 3: Lấy danh sách các dòng chi tiết hàng hóa, dịch vụ từ bảng invoice_lines.
  const lines = await sql.query<{ description: string; unit: string | null; qty: number; unit_vnd: number; amount_vnd: number }>(
    `select description, unit, qty, unit_vnd, amount_vnd from invoice_lines where invoice_id = $1`,
    [id],
  );
  // Bước 4: Tạo dữ liệu XML chuẩn Thông tư 78 và trả về file đính kèm tải xuống.
  return xmlResponse(`${inv.code}.xml`, invoiceXml(inv, lines));
}

/**
 * Làm gì: Định dạng và làm sạch giá trị một ô trong file CSV: xử lý null/undefined, bọc nháy kép nếu có ký tự đặc biệt, và chống tấn công CSV/Formula Injection.
 * Được gọi ở:
 * - Trong extras.ts: hàm invoiceExport (khi tạo các dòng dữ liệu CSV).
 * - Bộ kiểm thử: src/server/controllers/tx.test.ts (trong test case kiểm thử xuất CSV).
 * @param v Giá trị dữ liệu cần xuất vào ô CSV.
 * @returns Chuỗi ký tự an toàn đã được format chuẩn CSV.
 */
export function csvCell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return String(v);
  let s = String(v);
  // Chống CSV Injection: nếu chuỗi bắt đầu bằng dấu =, +, -, @ thì thêm dấu ' phía trước để Excel không tự chạy công thức nguy hiểm.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) {
    s = `'${s}`;
  }
  // Chuẩn RFC 4180: nếu ô chứa dấu phẩy, dấu nháy kép hoặc ký tự xuống dòng thì bọc trong ngoặc kép và nhân đôi dấu nháy kép bên trong.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Làm gì: Trích xuất và kiểm tra tính hợp lệ của khoảng ngày (from, to) từ URL search parameters theo giờ Việt Nam (ICT).
 * Mặc định 'to' là ngày hiện tại, 'from' là ngày đầu tiên của tháng đó.
 * Được gọi ở:
 * - Trong extras.ts: hàm invoiceExportList và invoiceExport.
 * @param request HTTP Request chứa query parameters trên URL.
 * @returns { sp, from, to } gồm searchParams và 2 chuỗi ngày hợp lệ (YYYY-MM-DD).
 * @throws Lỗi 400 (validation) nếu ngày sai định dạng hoặc from lớn hơn to.
 */
function rangeFromRequest(request: Request) {
  // Bước 1: Lấy tham số 'to' (mặc định hôm nay theo giờ ICT) và 'from' (mặc định ngày mùng 1 đầu tháng).
  const sp = new URL(request.url).searchParams;
  const to = sp.get("to") ?? ictDateString();
  const from = sp.get("from") ?? `${to.slice(0, 8)}01`;
  // Bước 2: Kiểm tra định dạng ngày YYYY-MM-DD và đảm bảo ngày bắt đầu không lớn hơn ngày kết thúc.
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw err.validation("Pick a valid date range.");
  return { sp, from, to };
}

/** The list the accountant sees before exporting: what is in range and what has already gone. */
/**
 * Làm gì: Lấy danh sách hóa đơn theo khoảng ngày để quản lý xem trước trước khi xuất file; thống kê số lượng, tổng tiền, thuế VAT và số hóa đơn chưa từng xuất.
 * Được gọi ở:
 * - Giao diện quản lý: src/routes/manager.invoices.tsx (màn hình "Xuất hóa đơn điện tử" / "E-invoice export").
 * - Router điều hướng: src/server/controllers/router.ts (route GET /v1/invoices/export-list hoặc /api/invoices/export-list).
 * @param sql Kết nối database (chỉ đọc).
 * @param request Request GET chứa query params: from, to, limit, offset.
 * @param user Người dùng đăng nhập (yêu cầu vai trò manager).
 * @returns { status: 200, body: { from, to, items, limit, offset, n, total, vat, pending } }.
 * @throws Lỗi 403 nếu không phải manager; lỗi 400 nếu khoảng ngày không hợp lệ.
 */
export async function invoiceExportList(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền quản lý (manager) và xác thực khoảng ngày lọc hóa đơn.
  requireRole(user, ["manager"]);
  const { from, to } = rangeFromRequest(request);
  const { limit, offset } = pageParams(request, { def: 500, max: 500 });
  // Bước 2: Truy vấn danh sách hóa đơn có phân trang, chuyển múi giờ ngày phát hành sang 'Asia/Ho_Chi_Minh'.
  const items = await sql.query(
    `select i.id, i.code, i.issued_at::text as issued_at, i.buyer_name, i.buyer_tax_code, i.total_vnd, i.vat_vnd,
            i.exported_at::text as exported_at, p.status::text as status,
            i.kind, o.code as adj_code
       from invoices i join payments p on p.id = i.payment_id
       left join invoices o on o.id = i.adjusts_invoice_id
      where (i.issued_at at time zone 'Asia/Ho_Chi_Minh')::date between $1::date and $2::date
      order by i.issued_at desc limit $3 offset $4`,
    [from, to, limit, offset],
  );
  // Bước 3: Thống kê số lượng hóa đơn (n), tổng tiền trước thuế, tổng VAT và số lượng hóa đơn chưa từng xuất (pending).
  const sum = await one<{ n: number; total: number; vat: number; pending: number }>(
    sql,
    `select count(*)::int as n, coalesce(sum(total_vnd), 0)::bigint::int as total, coalesce(sum(vat_vnd), 0)::bigint::int as vat,
            count(*) filter (where exported_at is null)::int as pending
       from invoices where (issued_at at time zone 'Asia/Ho_Chi_Minh')::date between $1::date and $2::date`,
    [from, to],
  );
  // `n` is the row count to page through; `total` in the summary is money (the sum of totals).
  // Bước 4: Trả về danh sách hóa đơn cùng các số liệu tài chính tổng hợp.
  return { status: 200, body: { from, to, items, limit, offset, ...sum } };
}

/**
 * Làm gì: Xuất danh sách hóa đơn theo khoảng ngày ra file XML (chuẩn Thông tư 78) hoặc file CSV (Excel) để chuyển cho kế toán; đánh dấu ngày xuất (exported_at) và ghi log kiểm toán.
 * Được gọi ở:
 * - Giao diện quản lý: src/routes/manager.invoices.tsx (nút "Tải bảng tính (CSV)" và "Tải XML").
 * - Router điều hướng: src/server/controllers/router.ts (route GET /v1/invoices/export hoặc /api/invoices/export).
 * @param sql Kết nối database trong transaction do router quản lý.
 * @param request Request GET chứa query params: from, to, format ("csv" | "xml"), only_new ("1" | "0").
 * @param user Người dùng đăng nhập (bắt buộc vai trò manager).
 * @returns HTTP Response trả về file XML hoặc file CSV đính kèm (có UTF-8 BOM để Excel hiển thị đúng tiếng Việt).
 * @throws Lỗi 403 nếu không phải manager; lỗi 400 nếu khoảng ngày không hợp lệ.
 */
export async function invoiceExport(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền quản lý và giải mã các tham số truy vấn (định dạng xuất, cờ only_new để chỉ lấy hóa đơn chưa xuất).
  requireRole(user, ["manager"]);
  const { sp, from, to } = rangeFromRequest(request);
  const format = sp.get("format") === "xml" ? "xml" : "csv";
  const onlyNew = sp.get("only_new") === "1";
  // Bước 2: Truy vấn tối đa 2.000 hóa đơn phù hợp điều kiện lọc ngày theo giờ Việt Nam ('Asia/Ho_Chi_Minh').
  const rows = await sql.query<InvoiceExportRow>(
    `${EXPORT_SELECT}
      where (i.issued_at at time zone 'Asia/Ho_Chi_Minh')::date between $1::date and $2::date
        and ($3::boolean = false or i.exported_at is null)
      order by i.issued_at, i.code limit 2000`,
    [from, to, onlyNew],
  );
  // Bước 3: Đánh dấu thời gian đã xuất (exported_at = now()) cho các hóa đơn chưa từng xuất trước đó và ghi log kiểm toán.
  await sql.query(`update invoices set exported_at = now() where id = any($1::uuid[]) and exported_at is null`, [rows.map((r) => r.id)]);
  await audit(sql, user.id, "export_invoices", "invoice", null, null, { from, to, format, count: rows.length });
  // Bước 4: Xử lý xuất định dạng XML: lấy toàn bộ các dòng chi tiết hàng hóa và bọc trong thẻ danh sách <DSHDon>.
  if (format === "xml") {
    const lines = await sql.query<{ invoice_id: string; description: string; unit: string | null; qty: number; unit_vnd: number; amount_vnd: number }>(
      `select invoice_id, description, unit, qty, unit_vnd, amount_vnd from invoice_lines where invoice_id = any($1::uuid[])`,
      [rows.map((r) => r.id)],
    );
    const body = `<DSHDon>\n${rows.map((r) => invoiceXml(r, lines.filter((l) => l.invoice_id === r.id))).join("\n")}\n</DSHDon>`;
    return xmlResponse(`hoa-don-${from}_${to}.xml`, body);
  }
  // Bước 5: Xử lý xuất định dạng CSV: tạo tiêu đề cột và chuyển đổi từng dòng hóa đơn qua hàm csvCell an toàn.
  const head = ["So_hoa_don", "Ngay_lap", "Mau_so", "Ky_hieu", "Ten_nguoi_mua", "MST_nguoi_mua", "Tien_truoc_thue", "Thue_suat_%", "Tien_thue", "Tong_tien", "Hinh_thuc_TT", "Ma_thanh_toan", "Trang_thai", "Loai", "HD_goc"];
  const out = [head.join(",")];
  for (const r of rows) {
    out.push(
      [
        r.code,
        r.issued_at.slice(0, 10),
        r.form_no ?? "1",
        r.serial_no ?? "",
        r.buyer_name,
        r.buyer_tax_code ?? "",
        r.subtotal_vnd ?? "",
        Number(r.vat_rate ?? 0),
        r.vat_vnd ?? "",
        r.total_vnd ?? r.amount_vnd,
        r.method,
        r.payment_code,
        r.status,
        r.kind === "adjustment" ? "dieu_chinh_giam" : "ban_hang",
        r.adj_code ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  // Thêm tiền tố UTF-8 BOM (\uFEFF) để phần mềm Microsoft Excel tự nhận diện và hiển thị đúng tiếng Việt có dấu.
  return new Response("﻿" + out.join("\r\n") + "\r\n", {
    status: 200,
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="hoa-don-${from}_${to}.csv"` },
  });
}

void ictClock;
void ictStamp;
