/**
 * Mục đích file:
 * Xử lý các nghiệp vụ tại quầy thu ngân và bàn lễ tân (Front Desk) của trung tâm thể thao.
 * Bao gồm quản lý ca thu ngân (mở ca, kiểm tra ca hiện tại, chốt ca, phát hiện chênh lệch tiền mặt),
 * tiếp nhận thanh toán trực tiếp (tiền mặt, thẻ, chuyển khoản) cho thuê sân, lớp học và gói hội viên,
 * xuất hóa đơn, kích hoạt hoặc gia hạn gói tập, và quy trình xử lý hoàn tiền.
 *
 * Vị trí trong hệ thống:
 * Thuộc tầng controller handlers, tiếp nhận các yêu cầu HTTP từ bộ điều hướng trung tâm (src/server/controllers/router.ts)
 * đối với các endpoint quầy (/shifts, /payments, /invoices, /reports, /settings).
 */
import { reconcileLoyaltyRefund } from "../../services/loyalty";
import { PLAYED_SQL } from "./played";
import { classCode } from "../../../shared/arena3/labels";
import type { Sql } from "@/server/data/db";
import { addMonths, enrollmentAmountDue, enrollmentInvoiceLines } from "../../services/membership";
import { INVOICE_COLS, PAYMENT_COLS } from "../../services/columns";
import type { Invoice, Payment, PaymentCreateResponse, Reply } from "../../../shared/arena3/contracts";
import { err } from "../errors";
import { settleEnrollment } from "./classes";
import { lockEnrollmentLinks, withdrawLinks } from "../../integrations/payos";
import {
  audit,
  bookingBuyer,
  enqueue,
  enqueueReceipt,
  getSettings,
  isUuid,
  issueInvoice,
  nextCode,
  num,
  pageOf,
  readJson,
  str,
} from "../helpers";
import { quotePromo, redeemForBooking, redeemPromo, restoreIfFullyRefunded } from "../../services/promos";
import { methodLabelVi } from "../../../shared/arena3/labels";
import { parseCancelTiers } from "../../services/policy";
import { parseUiConfigPatch } from "@/shared/ui-config";
import { renderInvoicePdf } from "../../integrations/pdf";
import { validatePriceRules } from "../../services/rules";
import { requireRole, type PublicUser } from "../session";
import { addDays, ictDateString } from "../../../shared/arena3/time";
import { one } from "../tx";
import { checkOpeningHours, pageParams, parseInteger, parseSettingsPatch } from "../validate";

/**
 * Làm gì: Mở ca làm việc thu ngân mới cho nhân viên lễ tân, bảo đảm mỗi lễ tân chỉ có một ca trực đang mở tại một thời điểm.
 * Được gọi ở: src/server/controllers/router.ts (route POST /shifts/open).
 * @param sql Kết nối cơ sở dữ liệu trong transaction hiện tại.
 * @param user Thông tin người dùng đang thực hiện, bắt buộc có vai trò receptionist.
 * @returns Khách thể phản hồi HTTP 201 chứa bản ghi ca thu ngân mới tạo (shift).
 * @throws err.forbidden nếu người dùng không phải lễ tân; err.conflictState nếu lễ tân đã có ca trực đang mở chưa đóng.
 */
export async function shiftOpen(sql: Sql, user: PublicUser) {
  // Bước 1: Kiểm tra quyền truy cập — chỉ nhân viên lễ tân (receptionist) mới được phép mở ca thu ngân.
  requireRole(user, ["receptionist"]);
  // Bước 2: Kiểm tra trong bảng cashier_shifts xem lễ tân này đã có ca nào đang mở (closed_at is null) chưa.
  const existing = await one(
    sql,
    `select id from cashier_shifts where receptionist_id = $1 and closed_at is null`,
    [user.id],
  );
  if (existing) throw err.conflictState("A till shift is already open.");
  // Bước 3: Tạo bản ghi ca thu ngân mới cho lễ tân và trả về kết quả kèm mã HTTP 201.
  const row = await one(
    sql,
    `insert into cashier_shifts (receptionist_id) values ($1) returning *`,
    [user.id],
  );
  return { status: 201, body: { shift: row } };
}

/**
 * Làm gì: Lấy thông tin ca thu ngân hiện tại đang mở của nhân viên lễ tân và tổng kết số tiền đã thu (tiền mặt và tổng các phương thức khác trừ quota).
 * Được gọi ở: src/server/controllers/router.ts (route GET /shifts/current).
 * @param sql Kết nối cơ sở dữ liệu.
 * @param user Thông tin người dùng đang đăng nhập (receptionist hoặc manager).
 * @param request Đối tượng Request để đọc query parameter (ví dụ ?optional=1).
 * @returns Khách thể phản hồi HTTP 200 chứa thông tin ca trực (shift) và tổng số tiền đã thu (totals).
 * @throws err.forbidden nếu vai trò không hợp lệ; err.notFound nếu không tìm thấy ca nào đang mở và không có cờ optional=1.
 */
export async function shiftCurrent(sql: Sql, user: PublicUser, request: Request) {
  // Bước 1: Kiểm tra quyền — lễ tân hoặc quản lý được phép xem ca thu ngân hiện tại.
  requireRole(user, ["receptionist", "manager"]);
  // Bước 2: Truy vấn ca thu ngân đang mở (closed_at is null) của lễ tân.
  const row = await one(
    sql,
    `select * from cashier_shifts where receptionist_id = $1 and closed_at is null`,
    [user.id],
  );
  if (!row) {
    // The desk screens ask with ?optional=1: "no till open yet" is a normal state for them, so they
    // get an empty answer instead of a 404 in the browser console. Everyone else keeps the 404.
    if (new URL(request.url).searchParams.get("optional") === "1") return { status: 200, body: { shift: null, totals: null } };
    throw err.notFound("No till shift is open.");
  }
  // Bước 3: Tính tổng doanh thu ca trực: tiền mặt (cash) và tổng các khoản thu trừ hạn mức hội viên quota (all).
  const totals = await one<{ cash: number; all: number }>(
    sql,
    `select coalesce(sum(amount_vnd) filter (where method = 'cash' and status = 'posted'),0)::int as cash,
            coalesce(sum(amount_vnd) filter (where status = 'posted' and method <> 'quota'),0)::int as all
       from payments where shift_id = $1`,
    [(row as { id: string }).id],
  );
  return { status: 200, body: { shift: row, totals } };
}

/**
 * Làm gì: Đóng (chốt) ca thu ngân, đối soát tiền mặt khai báo với tiền mặt hệ thống, ghi audit log và phát cảnh báo đến quản lý nếu có chênh lệch.
 * Được gọi ở: src/server/controllers/router.ts (route POST /shifts/:id/close).
 * @param sql Kết nối cơ sở dữ liệu trong transaction.
 * @param id ID của ca thu ngân cần đóng (cashier_shifts.id).
 * @param request Đối tượng Request chứa body JSON (tiền mặt khai báo cash_declared_vnd, lý do nếu quản lý ép đóng).
 * @param user Thông tin người dùng thực hiện (lễ tân sở hữu ca hoặc quản lý ép đóng).
 * @returns Khách thể phản hồi HTTP 200 kèm số tiền khai báo và số tiền hệ thống ghi nhận.
 * @throws err.forbidden nếu lễ tân cố đóng ca của người khác; err.conflictState nếu ca đã đóng; err.validation nếu thiếu số tiền khai báo; err.field nếu quản lý ép đóng mà thiếu lý do.
 */
export async function shiftClose(sql: Sql, id: string, request: Request, user: PublicUser) {
  // Bước 1: Xác thực quyền và trích xuất dữ liệu đầu vào (tiền mặt khai báo, lý do đóng nếu là quản lý).
  requireRole(user, ["receptionist", "manager"]);
  const b = await readJson(request);
  const forceClose = user.role === "manager";
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (forceClose && !reason) throw err.field("reason", "A reason is required to force close a shift.");
  const raw = b.cash_declared_vnd;
  if (raw === null || raw === undefined || raw === "" || Number.isNaN(Number(raw))) {
    throw err.validation("cash_declared_vnd is required.");
  }
  const cash = parseInteger("cash_declared_vnd", "Cash declared", raw, 0, 2_000_000_000);
  // Bước 2: Khóa dòng ca thu ngân bằng SELECT ... FOR UPDATE để ngăn ngừa việc đóng ca trùng lặp cùng lúc.
  const sh = await one<{ id: string; receptionist_id: string; closed_at: string | null }>(
    sql,
    `select * from cashier_shifts where id = $1 for update`,
    [id],
  );
  if (!sh) throw err.notFound();
  if (!forceClose && sh.receptionist_id !== user.id) throw err.forbidden();
  if (sh.closed_at) throw err.conflictState("That shift is already closed.");
  // Bước 3: Đóng ca thu ngân bằng cách ghi nhận thời điểm đóng (closed_at) và số tiền mặt thực tế kiểm đếm.
  await sql.query(
    `update cashier_shifts set closed_at = now(), cash_declared_vnd = $2 where id = $1`,
    [id, cash],
  );
  // Bước 4: Tính tổng số tiền mặt thực tế hệ thống đã ghi nhận (payments có method = 'cash' và status = 'posted') trong ca.
  const actual = await one<{ cash: number }>(
    sql,
    `select coalesce(sum(amount_vnd) filter (where method='cash' and status='posted'),0)::int as cash
       from payments where shift_id = $1`,
    [id],
  );
  // Bước 5: Ghi nhật ký kiểm toán (audit log) lưu số tiền khai báo, số tiền hệ thống và lý do nếu là quản lý cưỡng chế đóng ca.
  await audit(sql, user.id, forceClose ? "force_close_shift" : "close_shift", "shift", id, null, {
    declared: cash,
    actual: actual?.cash,
    ...(forceClose ? { reason } : {}),
  });
  // Bước 6: Nếu có chênh lệch giữa tiền khai báo và hệ thống, gửi thông báo cảnh báo nội bộ (inapp) cho toàn bộ quản lý đang hoạt động.
  if (cash !== (actual?.cash ?? 0)) {
    const managers = await sql.query<{ id: string }>(
      `select id from users where role = 'manager' and status = 'active'`,
    );
    for (const manager of managers) {
      await enqueue(sql, "inapp", "shift_cash_difference", manager.id, {
        shift_id: id, receptionist_id: sh.receptionist_id,
        cash_declared_vnd: cash, cash_system_vnd: actual?.cash ?? 0,
      }, `shift_cash_difference:${id}:${manager.id}`);
    }
  }
  return {
    status: 200,
    body: { ok: true, cash_declared_vnd: cash, cash_system_vnd: actual?.cash ?? 0 },
  };
}

/** Still running: add to the current end. Expired or new: count from today. One account, one membership. */
export async function activateSubscription(sql: Sql, subId: string) {
  // Bước 1: Khóa dòng dữ liệu của subscription và lấy thông tin thời hạn của gói tương ứng trong membership_plans.
  const sub = await one<{ id: string; status: string; end_on: string; plan_id: string; user_id: string }>(
    sql,
    `select id, status::text, end_on::text, plan_id, user_id from subscriptions where id = $1 for update`,
    [subId],
  );
  if (!sub) throw err.notFound();
  const plan = await one<{ duration_months: number | null; duration_days: number | null }>(
    sql,
    `select duration_months, duration_days from membership_plans where id = $1`,
    [sub.plan_id],
  );
  if (!plan) throw err.notFound();
  // Bước 2: Xác định ngày hiện tại theo giờ Việt Nam (ICT) và hàm tiện ích gia hạn (extend) theo tháng hoặc ngày.
  const today = ictDateString();
  const extend = (from: string) =>
    plan.duration_months ? addMonths(from, plan.duration_months) : addDays(from, plan.duration_days ?? 30);

  // Bước 3: Trường hợp gói hiện tại đang hoạt động và chưa hết hạn, gia hạn nối tiếp từ ngày hết hạn cũ (end_on).
  if (sub.status === "active" && sub.end_on >= today) {
    await sql.query(`update subscriptions set end_on = $2 where id = $1`, [sub.id, extend(sub.end_on)]);
    return;
  }

  // Bước 4: Kiểm tra xem người dùng có gói nào khác đang chạy không; nếu có thì gộp thời hạn vào gói đó, chuyển ref_id của payment và xóa bản ghi subscription thừa.
  const live = await one<{ id: string; end_on: string }>(
    sql,
    `select id, end_on::text from subscriptions
      where user_id = $1 and status in ('active','frozen') and id <> $2
      limit 1 for update`,
    [sub.user_id, sub.id],
  );
  if (live && live.end_on >= today) {
    await sql.query(`update subscriptions set end_on = $2 where id = $1`, [live.id, extend(live.end_on)]);
    await sql.query(`update payments set ref_id = $1 where ref_type = 'subscription' and ref_id = $2`, [live.id, sub.id]);
    await sql.query(`delete from subscriptions where id = $1`, [sub.id]);
    return;
  }
  // Bước 5: Nếu gói cũ đã hết hạn thì đánh dấu 'expired', sau đó kích hoạt gói mới từ ngày hôm nay và reset số giờ sân còn lại về 0.
  if (live) await sql.query(`update subscriptions set status = 'expired' where id = $1`, [live.id]);
  await sql.query(
    `update subscriptions
        set status = 'active', start_on = $2, end_on = $3, court_hours_left = 0, session_left = null
      where id = $1`,
    [sub.id, today, extend(today)],
  );
}

/**
 * What the money actually bought, as it should read on the invoice.
 *
 * The goods line used to be the literal string "Thu ngan" for everything that
 * was not a plan, so a member who paid for a court got an invoice saying
 * "1 x Thu ngan". The payment already knows its `ref_type`/`ref_id`; this looks
 * through to the thing itself so the line names the court and the hour.
 */
export async function describePayment(
  sql: Sql,
  refType: string,
  refId: string,
): Promise<{ description: string; unit: string }> {
  // Nhánh 1: Gói hội viên (subscription) — hiển thị tên gói dịch vụ và đơn vị tính là 'gói'.
  if (refType === "subscription") {
    const row = await one<{ name: string }>(
      sql,
      `select p.name from subscriptions s join membership_plans p on p.id = s.plan_id where s.id = $1`,
      [refId],
    );
    return { description: row ? `Gói hội viên — ${row.name}` : "Gói hội viên", unit: "gói" };
  }
  // Nhánh 2: Thuê sân (booking) — hiển thị mã sân và khung giờ đặt (theo múi giờ Việt Nam), đơn vị tính là 'giờ'.
  if (refType === "booking") {
    const row = await one<{ court_code: string; window: string }>(
      sql,
      `select c.court_code,
              to_char(b.start_at at time zone 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY HH24:MI')
                || '–' || to_char(b.end_at at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI') as window
         from court_bookings b join courts c on c.id = b.court_id
        where b.id = $1`,
      [refId],
    );
    return {
      description: row ? `Thuê sân ${row.court_code} — ${row.window}` : "Thuê sân",
      unit: "giờ",
    };
  }
  // Nhánh 3: Đăng ký lớp học (enrollment) — hiển thị môn thể thao và cấp độ lớp, đơn vị tính là 'khoá'.
  if (refType === "enrollment") {
    const row = await one<{ sport: string; level: string }>(
      sql,
      `select c.sport::text as sport, c.level from enrollments e join classes c on c.id = e.class_id where e.id = $1`,
      [refId],
    );
    return { description: row ? `Khoá ${row.sport} · ${row.level}` : "Khoá học", unit: "khoá" };
  }
  // Nhánh 4: Vé lẻ vào cửa (walkin) hoặc thuê thiết bị (equipment) tại trung tâm.
  if (refType === "walkin") return { description: "Vé lẻ vào cửa", unit: "lượt" };
  if (refType === "equipment") return { description: "Thuê thiết bị", unit: "lượt" };
  return { description: "Dịch vụ tại trung tâm", unit: "lượt" };
}

/**
 * Làm gì: Tiếp nhận và xử lý thanh toán trực tiếp tại quầy (tiền mặt, thẻ, chuyển khoản) cho đặt sân, gói hội viên hoặc lớp học, sau đó xuất hóa đơn và gửi biên lai.
 * Được gọi ở: src/server/controllers/router.ts (route POST /payments).
 * @param sql Kết nối cơ sở dữ liệu trong transaction có bảo đảm Idempotency.
 * @param request Đối tượng Request chứa thông tin thanh toán (ref_type, ref_id, method, amount_vnd, shift_id,...).
 * @param user Thông tin nhân viên quầy thực hiện giao dịch (receptionist hoặc manager).
 * @returns Khách thể phản hồi HTTP 201 chứa thông tin thanh toán (payment) và hóa đơn vừa xuất (invoice).
 * @throws err.validation nếu thiếu trường bắt buộc; err.field nếu phương thức thanh toán hoặc số tiền không hợp lệ (số tiền phải nguyên dương <= 2 tỷ); err.notFound nếu không tìm thấy bản ghi liên quan.
 */
export async function paymentsCreate(
  sql: Sql,
  request: Request,
  user: PublicUser,
): Promise<Reply<PaymentCreateResponse>> {
  // Bước 1: Kiểm tra quyền lễ tân/quản lý và xác thực dữ liệu đầu vào (ref_type, ref_id, method, amount_vnd).
  requireRole(user, ["receptionist", "manager"]);
  const b = await readJson(request);
  const ref_type = str(b.ref_type);
  const ref_id = str(b.ref_id);
  const method = str(b.method);
  const amount = num(b.amount_vnd);
  if (!ref_type || !ref_id || !method || amount == null) {
    throw err.validation("ref_type, ref_id, method and amount_vnd are required.");
  }
  const ALLOWED_PAYMENT_METHODS = ["cash", "card", "transfer"] as const;
  if (!ALLOWED_PAYMENT_METHODS.includes(method as any)) {
    throw err.field("method", `Payment method must be one of ${ALLOWED_PAYMENT_METHODS.join(", ")}.`);
  }
  if (ref_type !== "booking" && ref_type !== "subscription" && ref_type !== "enrollment") {
    throw err.field("ref_type", "ref_type must be booking, subscription or enrollment.");
  }
  // Money in is a positive whole number of đồng. Zero and negative amounts used
  // to post: a -5,000 "payment" quietly lowered what the member had paid, and a
  // later one-đồng payment then activated the plan (D-01).
  if (!Number.isInteger(amount) || amount <= 0 || amount > 2_000_000_000) {
    throw err.field("amount_vnd", "Enter an amount above zero, in whole đồng.");
  }
  // Bước 2: Lấy cấu hình hệ thống (tỷ lệ thuế VAT) và xác định ca thu ngân gắn với khoản thu này.
  const settings = await getSettings(sql);
  const shiftId = await paymentShift(sql, b, user);
  // Bước 3: Thu thập thông tin chi tiết người mua, người thụ hưởng và kiểm tra số tiền khớp với khoản nợ.
  const details = await deskPaymentDetails(sql, ref_type, ref_id, amount, user, b);
  const { userId } = details;
  // Bước 4: Tạo mã thanh toán mới (tiền tố PAY) và chèn bản ghi giao dịch thành công (status = 'posted') vào bảng payments.
  const payCode = await nextCode(sql, "PAY");
  const pay = await one<{ id: string }>(
    sql,
    `insert into payments (code, user_id, shift_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by)
     values ($1,$2,$3,$4,$5,$6,'posted',$7,$8,$9) returning id`,
    [payCode, userId, shiftId, method, amount, Number(settings.vat_rate), ref_type, ref_id, user.id],
  );
  // Bước 5: Hoàn tất quyết toán nghiệp vụ tương ứng (kích hoạt gói hội viên, xác nhận lớp học, hủy link thanh toán online trùng lặp).
  await settleDeskPayment(sql, ref_type, ref_id, pay!.id, details);
  // Bước 6: Xuất hóa đơn (invoices), xếp hàng gửi biên lai điện tử cho khách hàng và ghi audit log.
  const invoiceId = await invoiceDeskPayment(sql, ref_type, ref_id, pay!.id, amount, method, details, settings);
  const payment = await one<Payment>(sql, `select ${PAYMENT_COLS} from payments where id = $1`, [pay!.id]);
  const invoice = await one<Invoice>(sql, `select ${INVOICE_COLS} from invoices where id = $1`, [invoiceId]);
  await audit(sql, user.id, "create_payment", "payment", pay!.id);
  return { status: 201, body: { payment: payment!, invoice: invoice! } };
}

type DeskPaymentDetails = { buyer: string; buyerPhone: string | null; userId: string | null; subPromo: { id: string; discount: number } | null; enrollmentLinks: Array<{ id: string; provider_order_code: string | number | null }> };

/**
 * Làm gì: Lấy thông tin người mua (họ tên, số điện thoại, mã người dùng) của lượt đặt sân để ghi nhận lên hóa đơn và biên lai.
 * Được gọi ở: deskPaymentDetails() (dòng 360) trong src/server/controllers/handlers/desk.ts.
 * @param sql Kết nối cơ sở dữ liệu.
 * @param ref_id ID của lượt đặt sân trong bảng court_bookings.
 * @returns Đối tượng chứa thông tin người mua gồm buyer, buyerPhone và userId.
 * @throws err.notFound nếu ref_id không phải UUID hoặc không tồn tại lượt đặt sân.
 */
async function bookingPaymentDetails(sql: Sql, ref_id: string) {
  // The receipt is made out to whoever the booking is for — the member, or
  // the walk-in's typed name and phone — never to the receptionist taking it.
  // Bước 1: Kiểm tra định dạng UUID và xác minh sự tồn tại của lượt đặt sân.
  if (!isUuid(ref_id)) throw err.notFound("Booking does not exist.");
  const bookingExists = await one<{ id: string }>(sql, `select id from court_bookings where id = $1`, [ref_id]);
  if (!bookingExists) throw err.notFound("Booking does not exist.");
  // Bước 2: Truy vấn thông tin người thụ hưởng thực tế (hội viên hoặc khách vãng lai) qua helper bookingBuyer.
  const who = await bookingBuyer(sql, ref_id);
  return { buyer: who.name, buyerPhone: who.phone, userId: who.userId };
}

/**
 * Làm gì: Khóa và kiểm tra thông tin ghi danh lớp học (enrollment), kiểm tra lớp bị hủy hoặc chỗ ngồi không ở trạng thái giữ chỗ (hold), và đối soát số tiền phải trả.
 * Được gọi ở: deskPaymentDetails() (dòng 361) trong src/server/controllers/handlers/desk.ts.
 * @param sql Kết nối cơ sở dữ liệu trong transaction.
 * @param ref_id ID của bản ghi ghi danh (enrollments.id).
 * @param amount Số tiền khách hàng thanh toán tại quầy (VNĐ).
 * @param buyer Tên người mua mặc định (tên nhân viên lễ tân) nếu không tìm thấy người dùng.
 * @returns Đối tượng chứa danh sách link payOS cần khóa (enrollmentLinks), mã người dùng (userId) và tên người mua (buyer).
 * @throws err.notFound nếu không tìm thấy enrollment; err.br("BR-18") nếu lớp học đã bị hủy; err.br("BR-28") nếu chỗ ngồi không ở trạng thái chờ thanh toán (hold); err.field nếu số tiền không khớp với học phí trọn gói.
 */
async function enrollmentPaymentDetails(sql: Sql, ref_id: string, amount: number, buyer: string) {
  // Bước 1: Kiểm tra ID hợp lệ và lấy class_id của bản ghi ghi danh.
  if (!isUuid(ref_id)) throw err.notFound("Enrollment does not exist.");
  // Lock order payment → class → enrolment, as settleOnline: the seat's pending payOS links
  // first, then the class, then the enrolment. A retry queues here, re-reads the status and
  // is refused once the seat is confirmed.
  const preEnr = await one<{ class_id: string }>(sql, `select class_id from enrollments where id = $1`, [ref_id]);
  if (!preEnr) throw err.notFound("Enrollment does not exist.");
  // Bước 2: Khóa theo thứ tự: link payOS đang chờ -> lớp học (classes) -> bản ghi ghi danh (enrollments) để tránh xung đột thanh toán online đồng thời.
  const enrollmentLinks = await lockEnrollmentLinks(sql, [ref_id]);
  const cls = await one<{ status: string }>(
    sql,
    `select status::text as status from classes where id = $1 for update`,
    [preEnr.class_id],
  );
  if (cls?.status === "cancelled") throw err.br("BR-18", "That class is cancelled.");
  const enr = await one<{ user_id: string; status: string; price_vnd: number | null }>(
    sql,
    `select user_id, status::text as status, price_vnd from enrollments where id = $1 for update`,
    [ref_id],
  );
  if (!enr) throw err.notFound("Enrollment does not exist.");
  // Bước 3: Kiểm tra trạng thái chỗ ngồi phải là 'hold' (BR-28) và số tiền thanh toán phải khớp chính xác với học phí của lớp.
  if (enr.status !== "hold") throw err.br("BR-28", "That seat is not on hold, so there is nothing to pay.");
  const expected = await enrollmentAmountDue(sql, ref_id);
  if (amount !== expected) {
    throw err.field(
      "amount_vnd",
      `A class seat is paid in full: ${expected.toLocaleString("en-US")}đ.`,
      { expected_vnd: expected },
    );
  }
  // Bước 4: Lấy thông tin học viên từ bảng users để điền tên người mua thực tế trên hóa đơn.
  const userId = enr.user_id;
  const u = await one<{ full_name: string }>(sql, `select full_name from users where id = $1`, [userId]);
  return { enrollmentLinks, userId, buyer: u?.full_name ?? buyer };
}

/**
 * Làm gì: Khóa và kiểm tra thông tin gói hội viên cần thanh toán hoặc gia hạn, áp dụng mã giảm giá (promo) nếu có, và bắt buộc thanh toán trọn gói 100%.
 * Được gọi ở: deskPaymentDetails() (dòng 362) trong src/server/controllers/handlers/desk.ts.
 * @param sql Kết nối cơ sở dữ liệu trong transaction.
 * @param ref_id ID của bản ghi đăng ký gói hội viên (subscriptions.id).
 * @param amount Số tiền khách hàng thanh toán tại quầy (VNĐ).
 * @param buyer Tên người mua mặc định.
 * @param b Dữ liệu request body chứa mã khuyến mãi promo_code (nếu có).
 * @returns Đối tượng gồm thông tin khuyến mãi (subPromo), mã người dùng (userId) và tên người mua (buyer).
 * @throws err.field nếu ref_id sai định dạng hoặc số tiền thanh toán không khớp với giá sau giảm giá; err.notFound nếu không tìm thấy gói; err.br("BR-14") nếu gói đang bị đóng băng (frozen); err.conflictState nếu gói không ở trạng thái chờ thanh toán hoặc đã được thanh toán trước đó.
 */
async function subscriptionPaymentDetails(sql: Sql, ref_id: string, amount: number, buyer: string, b: Record<string, unknown>) {
  // Bước 1: Khóa bản ghi subscription bằng SELECT ... FOR UPDATE để tránh tình trạng nhấn thanh toán 2 lần cùng lúc.
  if (!isUuid(ref_id)) throw err.field("ref_id", "That value is not in the right format.");
  // Locked for the rest of the transaction: two taps on "Take payment" queue
  // here, and the second sees what the first left behind instead of both
  // reading the same balance.
  const sub = await one<DeskSubscription>(
    sql,
    `select s.user_id, s.plan_id, s.status::text as status, s.promo_id, s.promo_discount_vnd, s.price_vnd as sub_price_vnd,
            p.price_vnd, p.court_discount_pct
       from subscriptions s join membership_plans p on p.id = s.plan_id
      where s.id = $1 for update of s`,
    [ref_id],
  );
  if (!sub) throw err.notFound("No such plan.");
  // Bước 2: Kiểm tra các ràng buộc trạng thái: không nhận tiền khi gói bị đóng băng (BR-14), và kiểm tra gói chưa được thanh toán thành công trước đó.
  if (sub.status === "frozen") throw err.br("BR-14", "This plan is frozen — unfreeze it before taking payment.");
  if (sub.status !== "pending" && sub.status !== "active") {
    throw err.conflictState("That plan is not waiting for payment.");
  }
  // No credit and no deposit (BR-19): a plan is paid in one go for exactly what it
  // costs after any code, or it stays pending and grants nothing.
  if (sub.status === "pending") {
    const paid = await one<{ n: number }>(
      sql,
      `select count(*)::int as n from payments
        where ref_type = 'subscription' and ref_id = $1 and amount_vnd > 0 and status = 'posted'`,
      [ref_id],
    );
    if ((paid?.n ?? 0) > 0) throw err.conflictState("This plan order is already paid for.");
  }
  // Bước 3: Tính toán giá gốc, chiết khấu khuyến mãi (nếu có) và yêu cầu thanh toán đủ 100% giá trị gói (BR-19, không cho phép trả góp).
  const { basePrice, discount, promoId } = await subscriptionPaymentPromo(sql, sub, b);
  const expected = basePrice - discount;
  if (amount !== expected) {
    throw err.field(
      "amount_vnd",
      sub.status === "active"
        ? `A renewal is one full period: ${expected.toLocaleString("en-US")}đ.`
        : `A plan is paid in full: ${expected.toLocaleString("en-US")}đ. Partial payments are not taken.`,
      { expected_vnd: expected },
    );
  }
  // Bước 4: Chuẩn bị thông tin khuyến mãi và lấy tên hội viên để hiển thị trên hóa đơn.
  const subPromo = promoId && discount > 0 ? { id: promoId, discount } : null;
  const userId = sub.user_id;
  const u = await one<{ full_name: string }>(sql, `select full_name from users where id = $1`, [userId]);
  return { subPromo, userId, buyer: u?.full_name ?? buyer };
}

/**
 * Làm gì: Điều phối lấy thông tin chi tiết của người mua và đối tượng giao dịch tùy theo loại nghiệp vụ (đặt sân booking, lớp học enrollment, hoặc gói hội viên subscription).
 * Được gọi ở: paymentsCreate() (dòng 249) trong src/server/controllers/handlers/desk.ts.
 * @param sql Kết nối cơ sở dữ liệu trong transaction.
 * @param ref_type Loại đối tượng thanh toán ('booking' | 'enrollment' | 'subscription').
 * @param ref_id ID của bản ghi đối tượng thanh toán tương ứng.
 * @param amount Số tiền khách trả tại quầy (VNĐ).
 * @param user Thông tin nhân viên quầy đang thao tác.
 * @param b Dữ liệu request body.
 * @returns Đối tượng DeskPaymentDetails chứa người mua, số điện thoại, user_id, khuyến mãi và các link thanh toán liên quan.
 * @throws Chuyển tiếp lỗi từ các hàm con tương ứng nếu không tìm thấy bản ghi hoặc vi phạm điều kiện nghiệp vụ.
 */
async function deskPaymentDetails(sql: Sql, ref_type: string, ref_id: string, amount: number, user: PublicUser, b: Record<string, unknown>): Promise<DeskPaymentDetails> {
  // Phân nhánh lấy thông tin chi tiết thanh toán tùy theo đối tượng nghiệp vụ (thuê sân, khoá học, gói tập).
  const details: DeskPaymentDetails = { buyer: user.full_name, buyerPhone: null, userId: null, subPromo: null, enrollmentLinks: [] };
  if (ref_type === "booking") return { ...details, ...await bookingPaymentDetails(sql, ref_id) };
  if (ref_type === "enrollment") return { ...details, ...await enrollmentPaymentDetails(sql, ref_id, amount, details.buyer) };
  if (ref_type === "subscription") return { ...details, ...await subscriptionPaymentDetails(sql, ref_id, amount, details.buyer, b) };
  return details;
}

/**
 * Làm gì: Xác định và kiểm tra tính hợp lệ của ca thu ngân (shift) để gán cho giao dịch thanh toán tại quầy (bắt buộc đối với lễ tân theo BR-44).
 * Được gọi ở: paymentsCreate() (dòng 248) trong src/server/controllers/handlers/desk.ts.
 * @param sql Kết nối cơ sở dữ liệu.
 * @param b Dữ liệu request body có thể chứa shift_id được truyền lên từ giao diện.
 * @param user Thông tin nhân viên đang thực hiện giao dịch (receptionist hoặc manager).
 * @returns ID của ca thu ngân hợp lệ (shiftId) hoặc null nếu không áp dụng.
 * @throws err.notFound nếu shift_id không đúng định dạng hoặc không tồn tại; err.forbidden nếu lễ tân chỉ định ca của người khác hoặc ca đã đóng; err.br("BR-44") nếu lễ tân chưa mở ca nào.
 */
async function paymentShift(sql: Sql, b: Record<string, unknown>, user: PublicUser) {
  // Bước 1: Khởi tạo biến shiftId và lấy mã ca trực từ request payload.
  let shiftId: string | null = null;
  const shiftIdRaw = str(b.shift_id);
  // Bước 2: Nếu client truyền shift_id thì xác thực ca đó phải tồn tại, thuộc về lễ tân này và vẫn đang mở.
  if (shiftIdRaw) {
    if (!isUuid(shiftIdRaw)) throw err.notFound("Shift does not exist.");
    // Trường hợp 1: Có truyền shift_id — kiểm tra ca thu ngân có tồn tại, thuộc về lễ tân hiện tại và chưa đóng ca
    const sh = await one<{ id: string; receptionist_id: string; closed_at: string | null }>(
      sql,
      `select id, receptionist_id, closed_at from cashier_shifts where id = $1`,
      [shiftIdRaw],
    );
    if (!sh) throw err.notFound("Shift does not exist.");
    if (user.role === "receptionist") {
      if (sh.receptionist_id !== user.id || sh.closed_at !== null) {
        throw err.forbidden("Cannot record payment to another or closed shift.");
      }
    } else {
      throw err.forbidden("Cannot record payment to a shift.");
    }
    shiftId = sh.id;
  } else {
    // Trường hợp 2: Không truyền shift_id — tự động tìm ca thu ngân đang mở của lễ tân (theo BR-44, lễ tân bắt buộc phải có ca mở để thu tiền)
    if (user.role === "receptionist") {
      const sh = await one<{ id: string }>(
        sql,
        `select id from cashier_shifts where receptionist_id = $1 and closed_at is null`,
        [user.id],
      );
      if (!sh) throw err.br("BR-44", "The front desk needs an open shift.");
      shiftId = sh.id;
    }
  }
  return shiftId;
}

/**
 * Làm gì: Quyết toán nghiệp vụ tương ứng cho từng loại thanh toán tại quầy (gói tập, đặt sân, lớp học).
 *   Kích hoạt gói tập, ghi nhận thanh toán đặt sân, hoặc thu hồi link payOS trực tuyến và chốt giữ chỗ lớp học.
 * Được gọi ở: src/server/controllers/handlers/desk.ts:paymentsCreate.
 * @param sql Kết nối database do router cung cấp trong transaction.
 * @param ref_type Loại đối tượng thanh toán ("subscription", "booking" hoặc "enrollment").
 * @param ref_id UUID của đối tượng cần quyết toán.
 * @param paymentId UUID của giao dịch thanh toán (payments) vừa tạo.
 * @param details Thông tin chi tiết gồm mã giảm giá, ID hội viên và danh sách link thanh toán trực tuyến.
 * @returns Không trả về dữ liệu (Promise<void>).
 * @throws Lỗi database hoặc lỗi nghiệp vụ từ các hàm xử lý thành phần.
 */
async function settleDeskPayment(sql: Sql, ref_type: string, ref_id: string, paymentId: string, details: DeskPaymentDetails) {
  const { userId, subPromo, enrollmentLinks } = details;
  // Bước 1: Gói tập (subscription) — ghi nhận mã khuyến mãi (nếu có) và kích hoạt hoặc gia hạn gói tập
  if (ref_type === "subscription") {
    if (subPromo) {
      await sql.query(`update subscriptions set promo_id = $2, promo_discount_vnd = $3 where id = $1`, [
        ref_id,
        subPromo.id,
        subPromo.discount,
      ]);
      await redeemPromo(sql, { promoId: subPromo.id, userId, paymentId, discountVnd: subPromo.discount });
    }
    // Paid in full (checked above), so a pending plan activates and an active one renews.
    await activateSubscription(sql, ref_id);
  // Bước 2: Đặt sân (booking) — ghi nhận thanh toán và áp dụng điểm thưởng/mã giảm giá
  } else if (ref_type === "booking") {
    await redeemForBooking(sql, ref_id, userId, paymentId);
  // Bước 3: Lớp học (enrollment) — thu hồi link payOS trực tuyến để tránh thanh toán trùng, sau đó chốt chỗ học
  } else if (ref_type === "enrollment") {
    // The desk took the money, so the member's payOS link must not take it again.
    await withdrawLinks(sql, enrollmentLinks, "Paid at the desk", "PAID_AT_DESK");
    // The seat is on hold (checked above), so this confirms it. Any outcome that
    // buys no seat would be flagged to the desk by settleEnrollment itself.
    await settleEnrollment(sql, ref_id, { paymentId: paymentId });
  }
}

/**
 * Làm gì: Lập hóa đơn điện tử VAT cho giao dịch thanh toán tại quầy và đưa biên nhận vào hàng đợi gửi thông báo cho khách hàng.
 * Được gọi ở: src/server/controllers/handlers/desk.ts:paymentsCreate.
 * @param sql Kết nối database do router cung cấp trong transaction.
 * @param ref_type Loại đối tượng thanh toán ("subscription", "booking" hoặc "enrollment").
 * @param ref_id UUID của đối tượng thanh toán.
 * @param paymentId UUID của giao dịch thanh toán (payments) vừa tạo.
 * @param amount Số tiền thanh toán thực tế bằng VNĐ.
 * @param method Phương thức thanh toán ("cash", "card" hoặc "transfer").
 * @param details Chi tiết thanh toán chứa thông tin người mua và tài khoản hội viên.
 * @param settings Cấu hình trung tâm chứa thuế suất VAT (vat_rate).
 * @returns UUID của hóa đơn (invoices) vừa phát hành.
 * @throws Lỗi truy vấn database khi tạo hóa đơn hoặc khi đưa biên nhận vào hàng đợi.
 */
async function invoiceDeskPayment(sql: Sql, ref_type: string, ref_id: string, paymentId: string, amount: number, method: string, details: DeskPaymentDetails, settings: Awaited<ReturnType<typeof getSettings>>) {
  const { buyer, buyerPhone, userId } = details;
  // Bước 1: Lấy thông tin mô tả chi tiết và đơn vị tính của dịch vụ
  const item = await describePayment(sql, ref_type, ref_id);
  // Bước 2: Phát hành hóa đơn điện tử với thuế suất VAT từ cấu hình trung tâm
  const invoiceId = await issueInvoice(sql, {
    paymentId: paymentId,
    buyerName: buyer,
    buyerPhone,
    amountVnd: amount,
    vatRate: Number(settings.vat_rate ?? 0),
    description: item.description,
    unit: item.unit,
    lines: ref_type === "enrollment" ? await enrollmentInvoiceLines(sql, ref_id, amount, item) : undefined,
    settings,
  });
  // Bước 3: Đưa biên nhận thanh toán vào hàng đợi (enqueueReceipt) để gửi thông báo cho khách hàng
  await enqueueReceipt(sql, userId, {
    payment_id: paymentId,
    invoice_id: invoiceId,
    amount_vnd: amount,
    method,
  });
  return invoiceId;
}

/**
 * Làm gì: Tạo yêu cầu hoàn tiền cho một giao dịch đã thu, kiểm tra số dư hoàn tối đa từ sổ cái,
 *   tạo bản ghi hoàn tiền ở trạng thái refund_pending, trừ điểm thưởng và ghi nhật ký kiểm toán.
 * Được gọi ở: Route POST /v1/payments/:id/refund trong src/server/controllers/router.ts;
 *   kiểm thử tại src/server/controllers/tx.test.ts và src/server/services/business-gaps.test.ts.
 * @param sql Kết nối database do router cung cấp trong transaction.
 * @param id UUID của giao dịch thanh toán gốc cần hoàn tiền.
 * @param request HTTP Request chứa amount_vnd (số tiền cần hoàn) và reason (lý do hoàn tiền).
 * @param user Nhân viên đang đăng nhập (yêu cầu role receptionist hoặc manager).
 * @returns Phản hồi HTTP 201 kèm bản ghi hoàn tiền (payments) vừa tạo ở trạng thái refund_pending.
 * @throws Lỗi 400 nếu thiếu lý do, số tiền không hợp lệ hoặc vượt quá số dư có thể hoàn;
 *   403 nếu lễ tân không có ca mở (BR-44); 404 nếu không tìm thấy giao dịch thanh toán gốc.
 */
export async function paymentsRefund(sql: Sql, id: string, request: Request, user: PublicUser) {
  // Bước 1: Phân quyền (receptionist hoặc manager) và xác thực dữ liệu đầu vào (bắt buộc có lý do và số tiền hoàn hợp lệ)
  requireRole(user, ["receptionist", "manager"]);
  const b = await readJson(request);
  const amount = num(b.amount_vnd);
  const reason = str(b.reason)?.trim() ?? "";
  if (!reason) throw err.field("reason", "A refund reason is required.");
  if (amount == null || amount === 0) throw err.validation("amount_vnd must not be zero.");
  // Bước 2: Khóa giao dịch gốc bằng 'for update' để các yêu cầu hoàn tiền đồng thời xếp hàng chờ nhau
  const orig = await one<{
    id: string;
    amount_vnd: number;
    user_id: string | null;
    vat_rate: string | number;
    ref_type: string;
    ref_id: string;
    // `for update` so two clicks on the same payment queue behind each other
    // rather than both reading a ledger neither of them has written to yet.
  }>(sql, `select id, amount_vnd, user_id, vat_rate, ref_type, ref_id from payments where id = $1 for update`, [id]);

  if (!orig) throw err.notFound();
  if (orig.amount_vnd <= 0) throw err.validation("That row is already a refund.");
  const signed = amount > 0 ? -amount : amount;

  /*
   * How much of this money is still the centre's to give back.
   *
   * Comparing against `orig.amount_vnd` alone — which is all this did — asks
   * "is one refund too big?" and never "have we already given this back?".
   * Nothing links a refund row to its parent payment, so the same 1,500,000đ
   * payment could be refunded 1,500,000đ as many times as somebody pressed the
   * button. The ledger for the booking or subscription is what actually has to
   * balance, so that is what is counted: everything posted in, less everything
   * already sent back or waiting on a manager to send it back.
   */
  // Bước 3: Tính số tiền tối đa có thể hoàn dựa trên sổ cái (tổng đã thu trừ đi tổng đã hoàn hoặc đang chờ duyệt)
  const ledger = await one<{ taken: number; returned: number }>(
    sql,
    `select coalesce(sum(amount_vnd) filter (where amount_vnd > 0 and status = 'posted'), 0)::int as taken,
            coalesce(sum(-amount_vnd) filter (where amount_vnd < 0 and status in ('posted','refund_pending')), 0)::int as returned
       from payments
      where ref_type = $1 and ref_id = $2`,
    [orig.ref_type, orig.ref_id],
  );
  const refundable = Math.min(
    orig.amount_vnd,
    Number(ledger?.taken ?? 0) - Number(ledger?.returned ?? 0),
  );
  if (refundable <= 0) throw err.validation("This payment has already been refunded in full.");
  if (Math.abs(signed) > refundable) {
    throw err.validation(`The refund is larger than the ${refundable.toLocaleString("en-US")}đ still refundable.`);
  }

  // Bước 4: Kiểm tra ca thu ngân đang mở của lễ tân theo quy tắc BR-44 (manager không bắt buộc có ca thu ngân)
  let shiftId: string | null = null;
  if (user.role === "receptionist") {
    const sh = await one<{ id: string }>(
      sql,
      `select id from cashier_shifts where receptionist_id = $1 and closed_at is null`,
      [user.id],
    );
    if (!sh) throw err.br("BR-44", "The front desk needs an open shift.");
    shiftId = sh.id;
  }

  // Bước 5: Khóa tài khoản hội viên để tránh xung đột điểm thưởng và tạo bản ghi hoàn tiền (số tiền âm) với trạng thái refund_pending
  await sql.query(`select id from users where id = $1 for update`, [orig.user_id]);
  const row = await one(
    sql,
    `insert into payments (code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by, shift_id)
     values ($1,$2,'cash',$3,$4,'refund_pending',$5,$6,$7,$8) returning *`,
    [await nextCode(sql, "PAY"), orig.user_id, signed, orig.vat_rate, orig.ref_type, orig.ref_id, user.id, shiftId],
  );
  // Bước 6: Khấu trừ điểm thưởng tích lũy tương ứng số tiền hoàn và ghi nhật ký kiểm toán (audit log)
  await reconcileLoyaltyRefund(sql, orig.user_id);
  await audit(sql, user.id, "refund_pending", "payment", (row as { id: string }).id, null, { reason });
  return { status: 201, body: { payment: row } };
}

type PendingRefund = {
  id: string;
  code: string;
  user_id: string | null;
  amount_vnd: number;
  status: string;
  created_by: string | null;
  shift_id: string | null;
};

/**
 * Lock a refund that is waiting for a decision and check the decider may take it.
 *
 * Shared by approve and reject so the two cannot drift: both need the row
 * locked (two managers pressing at once must not both win), both refuse a row
 * that is not a pending refund, and both refuse the person who raised it.
 */
async function lockPendingRefund(sql: Sql, id: string, user: PublicUser): Promise<PendingRefund> {
  // Bước 1: Kiểm tra quyền — chỉ manager mới có quyền duyệt hoặc từ chối hoàn tiền
  requireRole(user, ["manager"]);
  // Bước 2: Khóa bản ghi thanh toán chờ hoàn tiền bằng 'for update' để chống xung đột race condition giữa các quản lý
  const p = await one<PendingRefund>(
    sql,
    `select id, code, user_id, amount_vnd, status, created_by, shift_id from payments where id = $1 for update`,
    [id],
  );
  if (!p) throw err.notFound("That refund does not exist.");
  // Bước 3: Kiểm tra trạng thái refund_pending và đảm bảo người duyệt không phải người đã tạo yêu cầu hoàn tiền
  if (p.status !== "refund_pending" || p.amount_vnd >= 0) {
    throw err.conflictState("That refund is no longer waiting for a decision.");
  }
  // A role can change after the refund was raised, so "managers only" is not
  // enough on its own: whoever asked for the money back does not also release it.
  if (p.created_by && p.created_by === user.id) {
    throw err.forbidden("You raised this refund, so someone else has to sign it off.");
  }
  return p;
}

/**
 * Authorize a cash payout, or reject a discretionary refund and tell the member.
 *
 * The status flip, the audit row and the notification all run inside the one
 * request transaction (`authed`): a refund that is decided but unaudited, or
 * decided with the member never told, cannot be committed.
 */
async function decideRefund(
  sql: Sql,
  id: string,
  user: PublicUser,
  request: Request | null,
  approve: boolean,
) {
  // Bước 1: Khóa và kiểm tra tính hợp lệ của khoản hoàn tiền chờ quyết định
  const p = await lockPendingRefund(sql, id, user);
  const b = request ? await readJson(request) : {};
  const note = str(b.reason);
  if (note && note.length > 500) throw err.field("reason", "The note must be at most 500 characters.");
  // Bước 2: Trường hợp duyệt (approve) — ghi log refund_authorized để cấp phép chi trả; tiền chỉ thực sự xuất quỹ khi pay-out
  if (approve) {
    // Approval authorizes release; only payout records cash leaving a drawer.
    await audit(sql, user.id, "refund_authorized", "payment", id, null, { note });
    return { status: 200, body: { status: "refund_pending" } };
  }
  // Bước 3: Trường hợp từ chối (reject) — cập nhật status thành refund_rejected, ghi log kiểm toán và gửi thông báo inapp cho hội viên
  if (!p.created_by) throw err.conflictState("The centre owes this refund: the front desk pays it out.");
  await sql.query(`update payments set status = 'refund_rejected' where id = $1`, [id]);
  await audit(sql, user.id, "refund_rejected", "payment", id, null, { note });
  if (p.user_id) await enqueue(sql, "inapp", "refund_rejected", p.user_id,
    { payment_id: p.id, code: p.code, amount_vnd: Math.abs(p.amount_vnd), note }, `refund_rejected|${p.id}`);
  return { status: 200, body: { status: "refund_rejected" } };
}

/**
 * Làm gì: Quản lý phê duyệt yêu cầu hoàn tiền, cấp phép cho lễ tân thực hiện chi tiền mặt cho khách.
 * Được gọi ở: Route POST /v1/payments/:id/approve-refund trong src/server/controllers/router.ts;
 *   kiểm thử tại src/server/controllers/tx.test.ts và src/server/services/business-gaps.test.ts.
 * @param sql Kết nối database do router cung cấp trong transaction.
 * @param id UUID của giao dịch thanh toán hoàn tiền cần phê duyệt.
 * @param request HTTP Request chứa ghi chú hoặc lý do phê duyệt (tối đa 500 ký tự).
 * @param user Quản lý đang đăng nhập thực hiện thao tác (bắt buộc khác người tạo yêu cầu).
 * @returns Phản hồi HTTP 200 kèm trạng thái refund_pending (đã duyệt, chờ chi tiền mặt).
 * @throws Lỗi 400 nếu ghi chú vượt quá 500 ký tự; 403 nếu không phải manager hoặc tự duyệt yêu cầu của chính mình;
 *   404 nếu không tìm thấy giao dịch; 409 nếu giao dịch không còn ở trạng thái refund_pending.
 */
export async function paymentsApproveRefund(sql: Sql, id: string, request: Request, user: PublicUser) {
  return decideRefund(sql, id, user, request, true);
}

/**
 * Làm gì: Quản lý từ chối yêu cầu hoàn tiền, đổi trạng thái sang refund_rejected và gửi thông báo inapp cho hội viên.
 * Được gọi ở: Route POST /v1/payments/:id/reject-refund trong src/server/controllers/router.ts;
 *   kiểm thử tại src/server/controllers/tx.test.ts.
 * @param sql Kết nối database do router cung cấp trong transaction.
 * @param id UUID của giao dịch thanh toán hoàn tiền bị từ chối.
 * @param request HTTP Request chứa lý do từ chối (tối đa 500 ký tự).
 * @param user Quản lý đang đăng nhập thực hiện thao tác (bắt buộc khác người tạo yêu cầu).
 * @returns Phản hồi HTTP 200 kèm trạng thái refund_rejected.
 * @throws Lỗi 400 nếu lý do vượt quá 500 ký tự; 403 nếu không phải manager hoặc tự từ chối yêu cầu của chính mình;
 *   404 nếu không tìm thấy giao dịch; 409 nếu khoản hoàn tiền thuộc trách nhiệm hoàn trả tự động của trung tâm.
 */
export async function paymentsRejectRefund(sql: Sql, id: string, request: Request, user: PublicUser) {
  return decideRefund(sql, id, user, request, false);
}

/**
 * The desk hands over cash for a pending refund, after approval when required.
 *
 * The refund only counts as paid from this moment, and it comes out of the till of whoever paid it.
 */
export async function paymentsPayOutRefund(sql: Sql, id: string, user: PublicUser) {
  // Bước 1: Kiểm tra quyền (receptionist hoặc manager) và khóa bản ghi hoàn tiền (for update) để tránh chi trả trùng lặp
  requireRole(user, ["receptionist", "manager"]);
  const p = await one<PendingRefund & { ref_type: string; ref_id: string }>(
    sql,
    `select id, code, user_id, amount_vnd, status, created_by, shift_id, ref_type, ref_id from payments where id = $1 for update`,
    [id],
  );
  if (!p) throw err.notFound("That refund does not exist.");
  if (p.status !== "refund_pending" || p.amount_vnd >= 0) {
    throw err.conflictState("That refund is no longer waiting to be paid out.");
  }
  // Bước 2: Kiểm tra hạn mức hoàn tiền (refund_manager_vnd) — nếu vượt ngưỡng quy định thì bắt buộc quản lý phải duyệt trước (log refund_authorized)
  const settings = await getSettings(sql);
  if (Math.abs(p.amount_vnd) >= settings.refund_manager_vnd) {
    const approval = await one(sql, `select id from audit_logs where entity = 'payment' and entity_id = $1 and action = 'refund_authorized' limit 1`, [id]);
    if (!approval) throw err.forbidden("A manager must approve this refund before cash is paid out.");
  }
  // Bước 3: Khóa và kiểm tra ca thu ngân đang mở của người chi tiền theo quy tắc BR-44 (tiền mặt thực tế xuất khỏi két của ca này)
  const shift = await one<{ id: string }>(sql,
    `select id from cashier_shifts where receptionist_id = $1 and closed_at is null for update`, [user.id]);
  if (!shift) throw err.br("BR-44", "The front desk needs an open shift.");
  const shiftId = shift.id;
  // Bước 4: Chuyển trạng thái sang posted, gán shift_id, hoàn trả mã khuyến mãi nếu hoàn tiền toàn phần (BR-41), ghi nhật ký kiểm toán và gửi thông báo inapp
  await sql.query(`update payments set status = 'posted', shift_id = $2 where id = $1`, [id, shiftId]);
  await restoreIfFullyRefunded(sql, p.ref_type, p.ref_id);
  await audit(sql, user.id, "refund_paid_out", "payment", id, { status: "refund_pending", amount_vnd: p.amount_vnd }, { status: "posted", shift_id: shiftId });
  if (p.user_id) {
    await enqueue(sql, "inapp", "refund_approved", p.user_id, { payment_id: p.id, code: p.code, amount_vnd: Math.abs(p.amount_vnd) }, `refund_approved|${p.id}`);
  }
  return { status: 200, body: { status: "posted" } };
}

/** How many receipts the reconciliation list will show at once. */

type PaymentsPendingRequestOptions = {
  searchParams: URLSearchParams;
  days: number;
};

type PaymentsPendingCounts = {
  orders: number;
  refunds: number;
  awaiting: number;
};

type PaymentsPendingReceiptOptions = {
  page: { limit: number; offset: number };
  days: number;
  method: string | null;
  needle: string | null;
};

type PaymentsPendingReceiptRow = { total: number } & Record<string, unknown>;

/**
 * Làm gì: đọc tham số URL và giới hạn khoảng tra cứu biên nhận trong 1–30 ngày.
 *   Không gửi days, gửi chuỗi rỗng, số 0 hoặc giá trị không đổi được thành số thì dùng 7.
 * Được gọi ở: paymentsPending, bước 2.
 * @param request Request GET /v1/payments/pending do router chuyển vào.
 * @returns Tham số URL và số ngày tra cứu; chưa kiểm tra phân trang.
 * @throws TypeError nếu URL không hợp lệ; không tự tạo lỗi HTTP.
 */
function readPaymentsPendingRequestOptions(
  request: Request,
): PaymentsPendingRequestOptions {
  const searchParams = new URL(request.url).searchParams;
  const days = Math.min(30, Math.max(1, Number(searchParams.get("days") ?? 7) || 7));

  return { searchParams, days };
}

/**
 * Làm gì: đếm tổng gói tập chờ thanh toán, khoản chờ hoàn tiền và chỗ giữ chờ chuyển khoản.
 *   Vì sao: màn hình tổng quan chỉ cần số lượng, không cần tải từng giao dịch.
 * Được gọi ở: paymentsPending, bước 3, khi brief=1.
 * @param sql Kết nối database do router cung cấp sau khi xác thực.
 * @returns Phản hồi HTTP 200 với body.waiting là tổng số việc đang chờ.
 * @throws Lỗi truy vấn database được truyền nguyên ra ngoài; không tự tạo lỗi HTTP.
 */
async function countPaymentsPendingWaiting(sql: Sql) {
  // The desk home wants a badge number and nothing else. Running three joined
  // queries — including sixty transfers with their invoices — on every visit to
  // the front page, to render a single digit, is work nobody ever reads.
  const counts = await one<PaymentsPendingCounts>(
    sql,
    `select (select count(*) from subscriptions where status = 'pending')::int as orders,
              (select count(*) from payments where status = 'refund_pending')::int as refunds,
              (select count(*) from court_bookings
                where status = 'hold' and transfer_requested_at is not null
                  and hold_until > now())::int
              + (select count(*) from enrollments
                  where status = 'hold' and transfer_requested_at is not null
                    and hold_until > now())::int as awaiting`,
  );

  return {
    status: 200,
    body: {
      waiting:
        Number(counts?.orders ?? 0) +
        Number(counts?.refunds ?? 0) +
        Number(counts?.awaiting ?? 0),
    },
  };
}

/**
 * Làm gì: lấy các lượt đặt sân còn giữ chỗ và đã yêu cầu chuyển khoản.
 *   Vì sao: chỗ đã hết hạn không còn thuộc lượt đặt, nên không đưa vào danh sách đối soát.
 * Được gọi ở: paymentsPending, bước 4.
 * @param sql Kết nối database do router cung cấp.
 * @returns Các lượt đặt sân theo thời điểm yêu cầu chuyển khoản, cũ trước.
 * @throws Lỗi truy vấn database được truyền nguyên ra ngoài; không tự tạo lỗi HTTP.
 */
async function loadPaymentsPendingCourtTransfers(sql: Sql) {
  // Slots the centre is holding open against a promise to transfer. Expired
  // holds are left out: the sweeper has already handed those courts back, so
  // showing them would invite a receptionist to confirm money into a booking
  // that no longer owns its slot.
  return sql.query(
    `select b.id, b.code, b.price_vnd, b.deposit_vnd, b.start_at, b.end_at,
            b.transfer_requested_at, b.hold_until,
            c.court_code, c.sport,
            u.full_name as member_name, u.member_code, u.phone
       from court_bookings b
       join courts c on c.id = b.court_id
       left join users u on u.id = b.user_id
      where b.status = 'hold'
        and b.transfer_requested_at is not null
        and b.hold_until > now()
      order by b.transfer_requested_at asc`,
  );
}

/**
 * Làm gì: lấy các chỗ học còn giữ chỗ chờ chuyển khoản, gắn kind để màn hình phân biệt với sân.
 * Được gọi ở: paymentsPending, bước 5.
 * @param sql Kết nối database do router cung cấp.
 * @returns Các chỗ học theo thời điểm yêu cầu chuyển khoản, chỉ gồm các field cần trả về.
 * @throws Lỗi truy vấn database được truyền nguyên ra ngoài; không tự tạo lỗi HTTP.
 */
async function loadPaymentsPendingEnrollmentTransfers(sql: Sql) {
  // Class seats on hold with a transfer promised, in the same list under their own kind.
  const enrollmentRows = await sql.query(
    `select e.id, e.price_vnd as amount_vnd, e.hold_until, e.transfer_requested_at,
            u.full_name as member_name, u.member_code, u.phone,
            c.sport, c.level
       from enrollments e
       join classes c on c.id = e.class_id
       join users u on u.id = e.user_id
      where e.status = 'hold'
        and e.transfer_requested_at is not null
        and e.hold_until > now()
      order by e.transfer_requested_at asc`,
  );

  // Gán kind = 'enrollment' để màn hình quầy lễ tân phân biệt được chỗ học lớp với lượt đặt sân trong cùng hàng đợi.
  return enrollmentRows.map((enrollmentRow: any) => ({
    kind: "enrollment",
    id: enrollmentRow.id,
    member_name: enrollmentRow.member_name,
    member_code: enrollmentRow.member_code,
    phone: enrollmentRow.phone,
    sport: enrollmentRow.sport,
    level: enrollmentRow.level,
    amount_vnd: enrollmentRow.amount_vnd,
    hold_until: enrollmentRow.hold_until,
    transfer_requested_at: enrollmentRow.transfer_requested_at,
  }));
}

/**
 * Làm gì: lấy các gói tập đang chờ thanh toán cùng số tiền đã thu.
 *   Vì sao: lễ tân cần thấy cả giá gói và phần đã trả, không chỉ số tiền còn thiếu.
 * Được gọi ở: paymentsPending, bước 6.
 * @param sql Kết nối database do router cung cấp.
 * @returns Các đơn gói tập theo ngày bắt đầu, rồi theo tên hội viên.
 * @throws Lỗi truy vấn database được truyền nguyên ra ngoài; không tự tạo lỗi HTTP.
 */
async function loadPaymentsPendingSubscriptionOrders(sql: Sql) {
  // `paid_vnd` calculated directly from posted payments: the desk wants to see a part payment
  // for what it is ("2 of 5 taken"), not just the balance left over.
  return sql.query(
    `select s.id, s.start_on::text as ordered_on, s.end_on::text as end_on,
            u.id as user_id, u.full_name, u.phone, u.member_code,
            pl.name as plan_name, coalesce(s.price_vnd, pl.price_vnd)::int as price_vnd, pl.id as plan_id,
            s.promo_discount_vnd, pr.code as promo_code,
            coalesce(sum(p.amount_vnd) filter (where p.status = 'posted'), 0)::int as paid_vnd
       from subscriptions s
       join users u on u.id = s.user_id
       join membership_plans pl on pl.id = s.plan_id
       left join promotions pr on pr.id = s.promo_id
       left join payments p on p.ref_type = 'subscription' and p.ref_id = s.id
      where s.status = 'pending'
      group by s.id, s.start_on, s.end_on,
               u.id, u.full_name, u.phone, u.member_code, pl.name, s.price_vnd, pl.price_vnd, pl.id,
               s.promo_discount_vnd, pr.code
      order by s.start_on asc, u.full_name asc`,
  );
}

/**
 * Làm gì: lấy các khoản chờ hoàn tiền và xác định khoản nào còn cần quản lý duyệt.
 *   Vì sao: khoản đạt ngưỡng duyệt chỉ hết cần duyệt khi đã có nhật ký refund_authorized.
 * Được gọi ở: paymentsPending, bước 8, sau khi bước 7 đọc cấu hình trung tâm.
 * @param sql Kết nối database do router cung cấp.
 * @param managerApprovalThreshold Ngưỡng refund_manager_vnd từ getSettings ở bước 7.
 * @returns Các khoản chờ hoàn tiền theo thời điểm tạo, cũ trước.
 * @throws Lỗi truy vấn database được truyền nguyên ra ngoài; không tự tạo lỗi HTTP.
 */
async function loadPaymentsPendingRefunds(
  sql: Sql,
  managerApprovalThreshold: number,
) {
  return sql.query(
    `select p.id, p.code, p.amount_vnd, p.created_at, p.ref_type, p.ref_id,
            u.full_name as member_name, u.member_code,
            r.full_name as raised_by, p.created_by is null as centre_owed,
            (abs(p.amount_vnd) >= $1 and not exists (
              select 1 from audit_logs a where a.entity = 'payment' and a.entity_id = p.id and a.action = 'refund_authorized'
            )) as needs_approval
       from payments p
       left join users u on u.id = p.user_id
       left join users r on r.id = p.created_by
      where p.status = 'refund_pending'
      order by p.created_at asc`,
    [managerApprovalThreshold],
  );
}

/**
 * Làm gì: đọc phân trang và bộ lọc biên nhận, bảo vệ ký tự đặc biệt trong từ khóa tìm kiếm.
 *   Vì sao: dấu %, _ và \ người dùng nhập phải được tìm như chữ, không thành mẫu SQL.
 * Được gọi ở: paymentsPending, bước 9, sau khi đã lấy các khoản chờ hoàn tiền.
 * @param request Request gốc, dùng để đọc receipt_limit và receipt_offset.
 * @param requestOptions Tham số URL và số ngày đã đọc ở bước 2.
 * @returns Phân trang, số ngày, phương thức thanh toán và mẫu tìm kiếm.
 * @throws Lỗi HTTP 400 từ pageParams nếu receipt_limit hoặc receipt_offset không hợp lệ;
 *   kiểm tra receipt_limit trước receipt_offset. Giữ nguyên field và thông báo của pageParams.
 */
function readPaymentsPendingReceiptOptions(
  request: Request,
  requestOptions: PaymentsPendingRequestOptions,
): PaymentsPendingReceiptOptions {
  /*
   * Every posted payment, whatever it was paid with.
   *
   * This list was filtered to `method = 'transfer'`, which made it a bank
   * reconciliation tool and nothing else. But a receipt is a receipt: cash taken
   * at the counter, a card tapped, a plan paid off, a court settled in the app —
   * each one issues an invoice, and none of them appeared anywhere at reception.
   * A member coming back with "I paid on Tuesday, can I have that again?" had to
   * be met by somebody guessing which queue to open.
   *
   * `taken_by` comes along because with cash in the list the obvious next
   * question is whose till it went into.
   */
  //
  // Paged and searched here, across the whole window: a statement read back against the bank
  // needs every row reachable, not the newest sixty.
  const page = pageParams(request, { def: 25, max: 100, prefix: "receipt_" });
  const receiptQuery = requestOptions.searchParams.get("receipt_q")?.trim() || null;

  let needle: string | null = null;
  if (receiptQuery) {
    needle = `%${receiptQuery.replace(/[\\%_]/g, "\\$&")}%`;
  }

  const method = requestOptions.searchParams.get("receipt_method") || null;

  return { page, days: requestOptions.days, method, needle };
}

/**
 * Làm gì: truy vấn một trang biên nhận đã ghi nhận, kèm tổng số dòng phù hợp bộ lọc.
 * Được gọi ở: paymentsPending, bước 10; và recountPaymentsPendingReceipts trong bước 11.
 * @param sql Kết nối database do router cung cấp.
 * @param options Bộ lọc biên nhận đã đọc ở bước 9.
 * @param limit Số dòng cần lấy: kích thước trang ở bước 10, hoặc 1 khi đếm lại.
 * @param offset Số dòng bỏ qua: vị trí trang ở bước 10, hoặc 0 khi đếm lại.
 * @returns Các dòng biên nhận, mỗi dòng có total do SQL tính.
 * @throws Lỗi truy vấn database được truyền nguyên ra ngoài; không tự tạo lỗi HTTP.
 */
function loadPaymentsPendingReceiptRows(
  sql: Sql,
  options: PaymentsPendingReceiptOptions,
  limit: number,
  offset: number,
): Promise<PaymentsPendingReceiptRow[]> {
  return sql.query<PaymentsPendingReceiptRow>(
    `select p.id, p.code, p.method, p.amount_vnd, p.created_at, p.ref_type, p.ref_id,
              p.capture_mode, p.provider,
              coalesce(u.full_name, i.buyer_name) as member_name, u.member_code,
              i.buyer_phone,
              s.full_name as taken_by,
              i.id as invoice_id,
              count(*) over ()::int as total
         from payments p
         left join users u on u.id = p.user_id
         left join users s on s.id = p.created_by
         left join invoices i on i.payment_id = p.id
        where p.status = 'posted'
          and p.created_at >= now() - ($1::int * interval '1 day')
          and ($4::text is null or p.method::text = $4)
          and ($5::text is null or concat_ws(' ', coalesce(u.full_name, i.buyer_name), u.member_code, i.buyer_phone, p.code) ilike $5)
        order by p.created_at desc
        limit $2 offset $3`,
    [options.days, limit, offset, options.method, options.needle],
  );
}

/**
 * Làm gì: bỏ field total khỏi từng biên nhận và xác định tổng số biên nhận.
 *   Vì sao: trang vượt cuối danh sách không có dòng để đọc total, nên cần đếm lại khi đó.
 * Được gọi ở: paymentsPending, bước 11.
 * @param sql Kết nối database do router cung cấp, dùng nếu cần đếm lại.
 * @param rows Các dòng biên nhận đã truy vấn ở bước 10.
 * @param options Phân trang và bộ lọc đã đọc ở bước 9.
 * @returns Trang biên nhận theo cấu trúc của pageOf, gồm items, total, limit và offset.
 * @throws Lỗi truy vấn database nếu lần đếm lại thất bại; không tự tạo lỗi HTTP.
 */
async function formatPaymentsPendingReceiptPage(
  sql: Sql,
  rows: PaymentsPendingReceiptRow[],
  options: PaymentsPendingReceiptOptions,
) {
  /**
   * Làm gì: đọc lại tổng số biên nhận bằng cách lấy một dòng đầu tiên với cùng bộ lọc.
   * Được gọi ở: pageOf trong formatPaymentsPendingReceiptPage, bước 11 của paymentsPending,
   *   chỉ khi trang hiện tại rỗng và offset lớn hơn 0.
   * @returns Tổng số biên nhận phù hợp; trả 0 nếu truy vấn không có dòng nào.
   * @throws Lỗi truy vấn database được truyền nguyên ra ngoài; không tự tạo lỗi HTTP.
   */
  async function recountPaymentsPendingReceipts(): Promise<number> {
    const firstReceiptRows = await loadPaymentsPendingReceiptRows(sql, options, 1, 0);
    return Number(firstReceiptRows[0]?.total ?? 0);
  }

  return pageOf(rows, options.page, recountPaymentsPendingReceipts);
}

/**
 * Làm gì: trả các khoản đang chờ xử lý tiền tại quầy và lịch sử biên nhận đã ghi nhận.
 *   Với brief=1, chỉ trả tổng số việc đang chờ. Với yêu cầu đầy đủ, giữ thứ tự truy vấn
 *   để lỗi và dữ liệu được xử lý đúng như luồng hiện có.
 * Được gọi ở:
 *   - Màn hình /desk/payments (src/routes/desk.payments.tsx), qua useDeskPayments trong
 *     src/client/lib/pages/desk.payments.ts, gọi GET /v1/payments/pending khi tải danh sách,
 *     đổi bộ lọc, chuyển trang hoặc tải lại sau thao tác.
 *   - Màn hình /desk và /desk/courts (desk.index.tsx, desk.courts.tsx) gọi
 *     GET /v1/payments/pending?brief=1 để hiển thị số việc đang chờ.
 *   - src/server/controllers/router.ts chuyển GET /v1/payments/pending qua authedRead:
 *     lấy kết nối, xác thực người dùng, rồi gọi deskH.paymentsPending(sql, request, user).
 *     Luồng đọc này không mở transaction.
 * @param sql Kết nối database do authedRead của router cung cấp.
 * @param request Request chứa brief, days và các tham số receipt_* trên URL.
 * @param user Người đã đăng nhập, phải có vai trò receptionist hoặc manager.
 * @returns HTTP 200 với body.waiting nếu brief=1; nếu không, trả awaiting, orders,
 *   refunds, receipts, receipts_total, days và capped=false.
 * @throws Lỗi HTTP 403 từ requireRole nếu không đúng vai trò; lỗi HTTP 422
 *   "center_settings is missing." nếu thiếu cấu hình; lỗi HTTP 400 từ pageParams
 *   nếu phân trang không hợp lệ. Lỗi database được truyền nguyên ra ngoài.
 *   Lỗi HTTP 401 do router xử lý trước khi gọi hàm này.
 *
 * Everything at the desk that is still waiting on money.
 *
 * Three queues that until now had no screen anywhere. A plan a member ordered
 * in the app sits at `pending` until somebody takes payment for it, and the
 * only way to find one was to already know whose profile to open. A refund a
 * receptionist raised above their own limit sits at `refund_pending` until a
 * manager signs it off, and the approve/reject endpoints existed with nothing
 * to call them. A member who chose "Bank transfer" in the app leaves their slot
 * on a long hold with nothing posted, waiting for somebody here to find the
 * money on the statement — that is the one queue where the centre is holding a
 * court open on trust, so it goes first. And transfers already reconciled land
 * in the last list, which is a record rather than a queue and carries no
 * actions: it exists to be read back against the bank line by line.
 */
export async function paymentsPending(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: chỉ lễ tân và quản lý được xem các khoản tiền tại quầy.
  requireRole(user, ["receptionist", "manager"]);

  // Bước 2: đọc URL và khoảng ngày trước khi chọn chế độ trả về.
  const requestOptions = readPaymentsPendingRequestOptions(request);

  // Bước 3: màn hình tổng quan chỉ cần số lượng, nên kết thúc sớm ở nhánh này.
  const onlyWaitingCountRequested = requestOptions.searchParams.get("brief") === "1";
  if (onlyWaitingCountRequested) {
    return countPaymentsPendingWaiting(sql);
  }

  // Bước 4: lấy sân còn giữ chỗ chờ chuyển khoản để ưu tiên xử lý trước.
  const awaitingCourtTransfers = await loadPaymentsPendingCourtTransfers(sql);

  // Bước 5: lấy chỗ học chờ chuyển khoản để ghép sau danh sách sân.
  const awaitingEnrollmentTransfers = await loadPaymentsPendingEnrollmentTransfers(sql);

  // Bước 6: lấy gói tập chờ thanh toán cùng phần tiền đã thu.
  const orders = await loadPaymentsPendingSubscriptionOrders(sql);

  // Bước 7: đọc cấu hình đúng tại đây để giữ nguyên thứ tự truy vấn và báo lỗi.
  const refundSettings = await getSettings(sql);

  // Bước 8: lấy khoản chờ hoàn tiền theo ngưỡng duyệt vừa đọc.
  const refunds = await loadPaymentsPendingRefunds(sql, refundSettings.refund_manager_vnd);

  // Bước 9: chỉ kiểm tra phân trang sau các truy vấn hàng chờ như luồng hiện có.
  const receiptOptions = readPaymentsPendingReceiptOptions(request, requestOptions);

  // Bước 10: lấy trang biên nhận theo khoảng ngày và bộ lọc đã đọc.
  const receiptRows = await loadPaymentsPendingReceiptRows(
    sql,
    receiptOptions,
    receiptOptions.page.limit,
    receiptOptions.page.offset,
  );

  // Bước 11: chuẩn bị biên nhận trả về, chỉ đếm lại khi pageOf yêu cầu.
  const receipts = await formatPaymentsPendingReceiptPage(sql, receiptRows, receiptOptions);

  // Bước 12: trả đúng cấu trúc màn hình đang dùng, giữ sân đứng trước chỗ học.
  return {
    status: 200,
    body: {
      awaiting: [...awaitingCourtTransfers, ...awaitingEnrollmentTransfers],
      orders,
      refunds,
      receipts: receipts.items,
      receipts_total: receipts.total,
      days: requestOptions.days,
      capped: false,
    },
  };
}

/**
 * Clear a plan order the member never came in to pay for.
 *
 * `sub_status` has no `cancelled` member, and migrating a production enum for
 * a row nobody will ever open again is a poor trade — so an abandoned order is
 * retired as `expired`. It leaves the queue, it releases the one-pending-per-
 * sport slot so the member can order again, and the audit row records who
 * retired it. An order with money already against it is not eligible: a desk
 * screen should not be able to make a payment stop pointing at anything.
 */
/**
 * Làm gì: Hủy và từ chối một đơn mua gói tập chưa thanh toán bằng cách chuyển trạng thái sang 'expired', giải phóng vị trí chờ mua gói để hội viên có thể đăng ký lại, đồng thời ghi nhật ký kiểm toán (audit log).
 * Được gọi ở:
 *   - Route POST /v1/subscriptions/:id/decline trong file src/server/controllers/router.ts.
 *   - Hàm decline trong src/client/lib/pages/desk.payments.ts (khi nhấn nút "Decline" trên hàng đợi đơn mua gói tập tại màn hình /desk/payments - file src/routes/desk.payments.tsx).
 * @param sql Kết nối cơ sở dữ liệu do authed của router cung cấp (trong transaction).
 * @param id Mã định danh của đơn mua gói tập (subscriptions.id) cần từ chối.
 * @param user Người dùng thực hiện thao tác; phải có vai trò receptionist hoặc manager.
 * @returns Phản hồi HTTP 200 dạng { status: 200, body: { ok: true } }.
 * @throws Lỗi HTTP 403 nếu người dùng không phải receptionist hoặc manager; lỗi HTTP 404 nếu không tìm thấy đơn; lỗi HTTP 409 nếu đơn không còn ở trạng thái 'pending' hoặc đã phát sinh khoản thanh toán posted.
 */
export async function subscriptionDecline(sql: Sql, id: string, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn — chỉ nhân viên lễ tân hoặc quản lý mới được phép từ chối đơn gói tập.
  requireRole(user, ["receptionist", "manager"]);
  // Bước 2: Khóa dòng đơn gói tập (for update) để tránh xung đột cập nhật đồng thời, và kiểm tra đơn còn chờ thanh toán.
  const sub = await one<{ id: string; status: string }>(
    sql,
    `select id, status from subscriptions where id = $1 for update`,
    [id],
  );
  if (!sub) throw err.notFound();
  if (sub.status !== "pending") throw err.conflictState("That order is no longer waiting for payment.");
  // Bước 3: Tính tổng tiền đã thanh toán (posted). Nếu đã thu tiền (dù một phần), không được hủy đơn mà phải qua quy trình hoàn tiền.
  const paid = await one<{ paid: number }>(
    sql,
    `select coalesce(sum(amount_vnd) filter (where status = 'posted'), 0)::int as paid
       from payments where ref_type = 'subscription' and ref_id = $1`,
    [id],
  );
  if (Number(paid?.paid ?? 0) > 0) {
    throw err.conflictState("Money has already been taken against this order — refund it first.");
  }
  // Bước 4: Chuyển trạng thái sang 'expired' thay vì xóa hẳn — enum sub_status không có 'cancelled', dùng 'expired' để rời hàng đợi và nhả slot đăng ký.
  await sql.query(`update subscriptions set status = 'expired' where id = $1`, [id]);
  // Bước 5: Ghi nhật ký kiểm toán (audit log) ghi nhận nhân viên đã từ chối đơn gói tập.
  await audit(sql, user.id, "decline_plan_order", "subscription", id);
  // Bước 6: Trả về kết quả thành công cho phía client.
  return { status: 200, body: { ok: true } };
}

/**
 * Every receipt the signed-in member has paid for, newest first.
 *
 * Invoices hang off payments, and it is the payment that knows whose money it
 * was — so ownership is a join, not a column on the invoice.
 */
/**
 * Làm gì: Lấy danh sách hóa đơn / biên lai thanh toán thuộc quyền sở hữu của chính người dùng đang đăng nhập (dựa trên liên kết với payments.user_id), sắp xếp theo ngày phát hành mới nhất, hỗ trợ phân trang.
 * Được gọi ở:
 *   - Route GET /v1/invoices trong file src/server/controllers/router.ts (được bọc bởi authedRead).
 *   - Màn hình tài khoản hội viên /account (file src/routes/account.tsx) thông qua hook useRead('/invoices?...') để hiển thị danh sách hóa đơn cá nhân.
 * @param sql Kết nối cơ sở dữ liệu do authedRead của router cung cấp.
 * @param request Request HTTP chứa tham số phân trang limit và offset trên URL query.
 * @param user Người dùng đang đăng nhập; phải có vai trò member, receptionist hoặc manager.
 * @returns Phản hồi HTTP 200 với body phân trang chứa items (danh sách hóa đơn kèm mã và phương thức thanh toán), total, limit, offset.
 * @throws Lỗi HTTP 403 nếu không đúng vai trò; lỗi HTTP 400 từ pageParams nếu tham số limit hoặc offset không hợp lệ; lỗi database truyền nguyên ra ngoài.
 */
export async function invoicesMine(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền truy cập — cho phép hội viên, lễ tân và quản lý xem hóa đơn cá nhân của họ.
  requireRole(user, ["member", "receptionist", "manager"]);
  // Bước 2: Đọc tham số URL và giới hạn trần limit tối đa 100 bản ghi để bảo vệ hiệu năng hệ thống.
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  let req = request;
  if (rawLimit && Number(rawLimit) > 100) {
    url.searchParams.set("limit", "100");
    req = new Request(url.toString(), request);
  }
  // Bước 3: Xác thực phân trang với giá trị mặc định 30 dòng/trang và tối đa 100 dòng.
  const { limit, offset } = pageParams(req, { def: 30, max: 100 });
  // Bước 4: Truy vấn danh sách hóa đơn theo user_id qua bảng payments (hóa đơn gắn với thanh toán), dùng count(*) over() để tính tổng số dòng.
  const rows = await sql.query<{ total: number } & Record<string, unknown>>(
    `select i.id, i.code, i.issued_at::text as issued_at,
            p.code as payment_code, p.method, p.amount_vnd, p.status, p.ref_type,
            count(*) over ()::int as total
       from invoices i
       join payments p on p.id = i.payment_id
      where p.user_id = $1
      order by i.issued_at desc
      limit $2 offset $3`,
    [user.id, limit, offset],
  );
  // Bước 5: Định dạng kết quả theo cấu trúc phân trang chuẩn (pageOf); chỉ đếm lại tổng số hóa đơn qua SQL khi trang rỗng mà offset > 0.
  const body = await pageOf(rows, { limit, offset }, async () =>
    ((await one<{ n: number }>(
      sql,
      `select count(*)::int as n from invoices i join payments p on p.id = i.payment_id where p.user_id = $1`,
      [user.id],
    ))?.n ?? 0),
  );
  // Bước 6: Trả về HTTP 200 kèm danh sách hóa đơn và thông tin phân trang.
  return { status: 200, body };
}

/**
 * Làm gì: Xuất hóa đơn / biên lai thanh toán dưới dạng file PDF (khổ in nhiệt 80mm cho quầy lễ tân hoặc khổ A5 tiêu chuẩn), kiểm tra quyền bảo mật để hội viên không thể xem trộm hóa đơn của người khác.
 * Được gọi ở:
 *   - Route GET /v1/invoices/:id.pdf trong file src/server/controllers/router.ts (được bọc bởi authedRead).
 *   - Client qua hàm downloadInvoicePdf trong file src/client/arena3/client.ts (gọi API /invoices/:id.pdf khi người dùng bấm tải hoặc in hóa đơn).
 * @param sql Kết nối cơ sở dữ liệu do authedRead của router cung cấp.
 * @param id Mã định danh của hóa đơn (invoices.id) cần xuất file PDF.
 * @param request Request HTTP, hỗ trợ tham số query format ("80mm" cho hóa đơn in nhiệt, mặc định là "a5").
 * @param user Người dùng đang đăng nhập; hội viên chỉ được xem hóa đơn của chính mình, nhân viên quầy và quản lý được in hóa đơn của bất kỳ ai.
 * @returns Response HTTP 200 với Content-Type "application/pdf" chứa dữ liệu nhị phân của file PDF.
 * @throws Lỗi HTTP 403 nếu không đúng vai trò; lỗi HTTP 404 nếu không tìm thấy hóa đơn hoặc nếu hội viên cố truy cập hóa đơn của người khác.
 */
export async function invoicePdf(sql: Sql, id: string, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền truy cập — chỉ quản lý, lễ tân và hội viên mới được phép yêu cầu xuất PDF hóa đơn.
  requireRole(user, ["manager", "receptionist", "member"]);
  // Bước 2: Phân tích định dạng in từ tham số query trên URL: '80mm' cho máy in bill nhiệt tại quầy, mặc định là 'a5'.
  const format = new URL(request.url).searchParams.get("format") === "80mm" ? "80mm" : "a5";
  // Bước 3: Lấy thông tin chi tiết hóa đơn (mã hóa đơn, thông tin người mua, người bán, thuế suất và tổng tiền).
  const inv = await one<{
    id: string;
    code: string;
    payment_id: string;
    buyer_name: string;
    buyer_phone: string | null;
    buyer_tax_code: string | null;
    buyer_address: string | null;
    form_no: string | null;
    serial_no: string | null;
    seller_legal_name: string | null;
    seller_tax_code: string | null;
    seller_address: string | null;
    subtotal_vnd: number | null;
    vat_rate: string | number | null;
    vat_vnd: number | null;
    total_vnd: number | null;
    issued_at: string;
  }>(
    sql,
    `select id, code, payment_id, buyer_name, buyer_phone, buyer_tax_code, buyer_address,
            form_no, serial_no, seller_legal_name, seller_tax_code, seller_address,
            subtotal_vnd, vat_rate, vat_vnd, total_vnd, issued_at::text
       from invoices where id = $1`,
    [id],
  );
  // Không tìm thấy hóa đơn khớp với ID yêu cầu thì báo lỗi 404 Not Found.
  if (!inv) throw err.notFound();
  // Bước 2: Truy vấn thông tin giao dịch thanh toán gốc (payments) để kiểm tra phương thức và quyền truy cập của người dùng.
  const pay = await one<{ code: string; method: string; amount_vnd: number; user_id: string | null }>(
    sql,
    `select code, method, amount_vnd, user_id from payments where id = $1`,
    [inv.payment_id],
  );
  // Staff work the till and print anybody's receipt; a member may only see
  // their own. Invoice ids are UUIDs, but "unguessable" is not an access
  // control — without this a member could walk the whole centre's takings.
  if (user.role === "member" && pay?.user_id !== user.id) throw err.notFound();
  // Bước 3: Lấy danh sách các dòng chi tiết trên hóa đơn (mặt hàng/dịch vụ, số lượng, đơn giá, thành tiền).
  const lines = await sql.query<{
    description: string;
    unit: string | null;
    qty: number;
    unit_vnd: number;
    amount_vnd: number;
  }>(`select description, unit, qty, unit_vnd, amount_vnd from invoice_lines where invoice_id = $1`, [id]);

  // The seller block and the tax split are read off the invoice, not off
  // today's settings: an invoice states what was true when it was issued.
  // `settings` is only the fallback for a row written before 0014.
  // Bước 4: Lấy thông tin pháp nhân trung tâm (dự phòng) và tính toán bóc tách thuế VAT, tiền trước thuế (subtotal).
  const settings = await getSettings(sql);
  const total = inv.total_vnd ?? pay?.amount_vnd ?? 0;
  const vatRate = Number(inv.vat_rate ?? 0);
  const subtotal = inv.subtotal_vnd ?? Math.floor(total / (1 + vatRate / 100));

  // Bước 5: Gọi hàm renderInvoicePdf để kết xuất file PDF nhị phân theo mẫu yêu cầu (A5 hoặc cuộn in nhiệt 80mm).
  const bytes = await renderInvoicePdf(
    {
      code: inv.code,
      form_no: inv.form_no,
      serial_no: inv.serial_no,
      issued_at: inv.issued_at,
      seller: {
        legal_name: inv.seller_legal_name ?? settings.legal_name ?? "Lê Long Sport",
        tax_code: inv.seller_tax_code ?? settings.tax_code,
        address: inv.seller_address ?? settings.address,
      },
      buyer: { name: inv.buyer_name, phone: inv.buyer_phone, tax_code: inv.buyer_tax_code, address: inv.buyer_address },
      pay_code: pay?.code ?? "",
      method_label: methodLabelVi(pay?.method ?? ""),
      lines,
      subtotal_vnd: subtotal,
      vat_rate: vatRate,
      vat_vnd: inv.vat_vnd ?? total - subtotal,
      total_vnd: total,
    },
    format,
  );
  // Bước 6: Trả về file nhị phân PDF kèm header HTTP phù hợp để hiển thị trực tiếp (inline) trên trình duyệt.
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${inv.code}.pdf"`,
    },
  });
}

/** A report day, checked. Anything else used to reach the SQL cast and come back as a 500. */
/**
 * Làm gì: Trích xuất và kiểm tra tính hợp lệ của tham số ngày (định dạng YYYY-MM-DD) từ query string (URLSearchParams). Nếu không truyền hoặc rỗng thì dùng giá trị mặc định (fallback). Nếu sai định dạng hoặc không phải ngày hợp lệ thì ném lỗi BadRequest 400 để chặn sớm, tránh việc SQL cast ngày bị lỗi 500.
 * Được gọi ở:
 *   - revenueParams trong src/server/controllers/handlers/desk.ts (lấy tham số 'from' và 'to' cho báo cáo doanh thu).
 *   - attendanceRange trong src/server/controllers/handlers/attendance.ts (lấy tham số 'from' và 'to' cho tỷ lệ điểm danh).
 *   - reportsAttendance, reportsMembers, reportsCapacity trong src/server/controllers/handlers/reports.ts (lấy khoảng ngày lọc cho các báo cáo điểm danh, hội viên và công suất sân).
 * @param sp Đối tượng URLSearchParams chứa các tham số truy vấn từ URL của request.
 * @param field Tên tham số ngày cần lấy (ví dụ: 'from', 'to').
 * @param fallback Giá trị ngày mặc định (YYYY-MM-DD) dùng khi tham số không tồn tại hoặc mang giá trị rỗng.
 * @returns Chuỗi ngày hợp lệ chuẩn định dạng YYYY-MM-DD.
 * @throws Lỗi BadRequest 400 (err.field) nếu chuỗi ngày không khớp biểu thức chính quy YYYY-MM-DD hoặc không phân tích được thành ngày hợp lệ (Date.parse).
 */
export function reportDay(sp: URLSearchParams, field: string, fallback: string): string {
  // Bước 1: Trích xuất giá trị chuỗi của tham số theo tên trường (field) từ URLSearchParams.
  const v = sp.get(field);
  // Bước 2: Nếu không truyền hoặc giá trị rỗng thì sử dụng ngày mặc định (fallback).
  if (v === null || v === "") return fallback;
  // Bước 3: Kiểm tra định dạng YYYY-MM-DD và đảm bảo ngày hợp lệ trong lịch; ném lỗi 400 để chặn trước khi xuống SQL cast bị lỗi 500.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    throw err.field(field, "Use a date like 2026-03-31.");
  }
  return v;
}

// Danh sách 5 phương thức thanh toán hợp lệ được hỗ trợ lọc trong báo cáo doanh thu: tiền mặt (cash), chuyển khoản (transfer), quẹt thẻ (card), cổng thanh toán (gateway), trừ giờ gói tập (quota).
const REPORT_METHODS = ["cash", "transfer", "card", "gateway", "quota"];

/**
 * Làm gì: Đọc, chuẩn hóa và kiểm tra tính hợp lệ của các tham số lọc báo cáo doanh thu từ URL của request, gồm ngày bắt đầu (from), ngày kết thúc (to) và phương thức thanh toán (method).
 * Được gọi ở:
 *   - reportsRevenue trong src/server/controllers/handlers/desk.ts (xử lý API GET /v1/reports/revenue).
 *   - revenueDocument trong src/server/controllers/handlers/reports.ts (xử lý API xuất file báo cáo GET /v1/reports/:kind/export với kind = 'revenue').
 * @param request Đối tượng HTTP Request từ client gửi lên chứa URL và các tham số truy vấn.
 * @returns Đối tượng { from: string, to: string, method: string | null } chứa các tham số lọc đã được kiểm tra hợp lệ.
 * @throws Lỗi BadRequest 400 (err.field) nếu ngày không hợp lệ, ngày kết thúc nhỏ hơn ngày bắt đầu, hoặc phương thức thanh toán không nằm trong REPORT_METHODS.
 */
export function revenueParams(request: Request) {
  // Bước 1: Trích xuất các tham số truy vấn (searchParams) từ URL của request gửi lên.
  const sp = new URL(request.url).searchParams;
  // Bước 2: Đọc tham số ngày bắt đầu (mặc định hôm nay theo giờ ICT) và ngày kết thúc (mặc định trùng với 'from').
  const from = reportDay(sp, "from", ictDateString());
  const to = reportDay(sp, "to", from);
  // Bước 3: Ràng buộc nghiệp vụ: ngày kết thúc không được nhỏ hơn ngày bắt đầu báo cáo.
  if (from > to) throw err.field("to", "The end date is before the start date.");
  // Bước 4: Đọc và xác thực phương thức thanh toán lọc (nếu có) phải nằm trong danh sách REPORT_METHODS cho phép.
  const method = sp.get("method") || null;
  if (method && !REPORT_METHODS.includes(method)) throw err.field("method", "Unknown payment method.");
  return { from, to, method };
}

/** The window of the same length that ends the day before `from`. */
/**
 * Làm gì: Tính toán khoảng thời gian (cửa sổ ngày) của kỳ trước liền kề có cùng độ dài (số ngày) và kết thúc vào ngày ngay trước ngày bắt đầu (from) của kỳ hiện tại.
 * Được gọi ở:
 *   - reportsRevenue trong src/server/controllers/handlers/desk.ts (dùng để tính số liệu kỳ trước nhằm đối soát tăng trưởng doanh thu theo nghiệp vụ FR-PAY-05).
 *   - revenueDocument trong src/server/controllers/handlers/reports.ts (chuẩn bị số liệu kỳ trước cho tài liệu xuất báo cáo doanh thu).
 * @param from Ngày bắt đầu của kỳ hiện tại dạng YYYY-MM-DD.
 * @param to Ngày kết thúc của kỳ hiện tại dạng YYYY-MM-DD.
 * @returns Đối tượng { from: string, to: string } đại diện cho khoảng thời gian của kỳ trước liền kề.
 * @throws Không ném lỗi nào.
 */
export function previousWindow(from: string, to: string) {
  // Bước 1: Tính tổng số ngày trong chu kỳ [from, to] (86,400,000 ms = 24 giờ; cộng 1 để tính đủ cả 2 đầu mút ngày).
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  // Bước 2: Ngày kết thúc của kỳ trước liền kề chính là ngày ngay trước ngày bắt đầu 'from' của kỳ hiện tại.
  const prevTo = addDays(from, -1);
  // Bước 3: Lùi tiếp (days - 1) ngày từ prevTo để xác định ngày bắt đầu kỳ trước, đảm bảo hai kỳ có số ngày bằng nhau.
  return { from: addDays(prevTo, -(days - 1)), to: prevTo };
}

/**
 * Làm gì: Xử lý yêu cầu lấy báo cáo doanh thu tổng hợp của trung tâm trong khoảng thời gian chỉ định; tự động truy vấn thêm số liệu của kỳ trước liền kề có cùng độ dài để so sánh đối soát tăng trưởng theo nghiệp vụ FR-PAY-05.
 * Được gọi ở:
 *   - Route GET /v1/reports/revenue trong src/server/controllers/router.ts (được bọc bởi authedRead, yêu cầu đăng nhập với vai trò 'manager').
 *   - Màn hình Quản lý / Báo cáo /manager (src/routes/manager.index.tsx), thông qua hook useManagerOverview (src/client/lib/pages/manager.index.ts) khi tải trang tổng quan hoặc chọn khoảng ngày lọc doanh thu.
 * @param sql Kết nối cơ sở dữ liệu do router cung cấp qua wrapper authedRead.
 * @param request Request HTTP chứa URL và searchParams (from, to, method).
 * @param user Thông tin tài khoản người dùng đang đăng nhập, bắt buộc phải có vai trò 'manager'.
 * @returns Đối tượng phản hồi { status: 200, body: ... } chứa toàn bộ dữ liệu báo cáo doanh thu của kỳ hiện tại và số liệu so sánh kỳ trước trong trường prev.
 * @throws Lỗi 403 Forbidden (requireRole) nếu người dùng không phải là 'manager'.
 * @throws Lỗi 400 BadRequest (err.field) từ revenueParams nếu khoảng ngày hoặc phương thức thanh toán không hợp lệ.
 * @throws Lỗi truy vấn database nếu xảy ra sự cố trong quá trình đọc dữ liệu.
 */
export async function reportsRevenue(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Phân quyền: chỉ người dùng có vai trò 'manager' (quản lý) mới được xem báo cáo doanh thu.
  requireRole(user, ["manager"]);
  // Bước 2: Trích xuất và xác thực các tham số bộ lọc báo cáo (from, to, method) từ request URL.
  const { from, to, method } = revenueParams(request);
  // Bước 3: Tính toán toàn bộ dữ liệu báo cáo doanh thu của kỳ hiện tại (bao gồm chi tiết theo ca và theo ngày).
  const body = await revenueBody(sql, from, to, method);
  // FR-PAY-05: the period against the one before it, from the same query, so the
  // screen and the exported file can never disagree about the comparison.
  // Bước 4: Xác định khoảng thời gian kỳ trước liền kề và truy vấn doanh thu kỳ trước (không lấy chi tiết) để so sánh đối chiếu (FR-PAY-05).
  const win = previousWindow(from, to);
  const prev = await revenueBody(sql, win.from, win.to, method, false);
  // Bước 5: Ghép dữ liệu kỳ hiện tại và kỳ trước vào cấu trúc kết quả phản hồi HTTP 200 gửi về client.
  return {
    status: 200,
    body: { ...body.body, method, prev: { from: win.from, to: win.to, totals: prev.body.totals, by_source: prev.body.by_source } },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Định nghĩa các kiểu dữ liệu nội bộ phục vụ tổng hợp và phân bổ báo cáo doanh thu
// ─────────────────────────────────────────────────────────────────────────────
type RevenuePaymentSummaryRow = {
  method: string;
  ref_type: string;
  total: number;
  refunded: number;
  cnt: number;
};

type RevenuePaymentBreakdown = {
  moneyPayments: RevenuePaymentSummaryRow[];
  quotaPayments: RevenuePaymentSummaryRow[];
  grossVnd: number;
  refundVnd: number;
  bySource: Record<string, number>;
  refundsBySource: Record<string, number>;
  byMethod: Record<string, number>;
};

type RevenueShiftRow = {
  shift_id: string | null;
  cashier: string | null;
  opened_at: string | null;
  closed_at: string | null;
  takings_vnd: number;
  refunds_vnd: number;
  count: number;
};

type RevenueDayRow = {
  day: string;
  revenue_vnd: number;
};

type RevenueTotals = {
  revenue_vnd: number;
  gross_vnd: number;
  refund_vnd: number;
  quota_hours: number;
};

type RevenueReportBody = {
  from: string;
  to: string;
  totals: RevenueTotals;
  by_source: Record<string, number>;
  refunds_by_source: Record<string, number>;
  by_shift: RevenueShiftRow[];
  by_method: Record<string, number>;
  by_day: RevenueDayRow[];
  quota_payments: RevenuePaymentSummaryRow[];
  lines: RevenuePaymentSummaryRow[];
};

type RevenueReportResponse = {
  status: 200;
  body: RevenueReportBody;
};

/**
 * Làm gì: truy vấn bảng payments để tổng hợp các khoản thanh toán đã ghi nhận theo từng phương thức và loại dịch vụ.
 *   Vì sao: gom nhóm trực tiếp ở tầng database giúp giảm thiểu dữ liệu truyền qua mạng và tăng tốc độ xử lý báo cáo.
 * Được gọi ở: revenueBody, bước 1.
 * @param sql Kết nối database do revenueBody chuyển vào từ router hoặc handler gọi tới.
 * @param from Ngày bắt đầu chu kỳ báo cáo (YYYY-MM-DD), tính theo múi giờ Asia/Ho_Chi_Minh.
 * @param to Ngày kết thúc chu kỳ báo cáo (YYYY-MM-DD), tính theo múi giờ Asia/Ho_Chi_Minh.
 * @param method Phương thức thanh toán cần lọc, hoặc null nếu lấy tất cả phương thức.
 * @returns Mảng các dòng tổng hợp doanh thu và tiền hoàn theo phương thức và nguồn thu.
 * @throws Lỗi truy vấn database được truyền nguyên ra ngoài; không tự tạo lỗi HTTP.
 */
async function loadRevenuePaymentSummaryRows(
  sql: Sql,
  from: string,
  to: string,
  method: string | null,
): Promise<RevenuePaymentSummaryRow[]> {
  return sql.query<RevenuePaymentSummaryRow>(
    `select method::text, ref_type,
            coalesce(sum(amount_vnd) filter (where amount_vnd >= 0),0)::int as total,
            coalesce(sum(-amount_vnd) filter (where amount_vnd < 0),0)::int as refunded,
            count(*)::int as cnt
       from payments
      where status = 'posted'
        and (created_at at time zone 'Asia/Ho_Chi_Minh')::date between $1::date and $2::date
        and ($3::text is null or method::text = $3)
      group by method, ref_type`,
    [from, to, method],
  );
}

/**
 * Làm gì: phân tách các dòng thanh toán thành tiền thực và lượt trừ giờ quota, đồng thời tính tổng thu, tổng hoàn và phân bổ doanh thu.
 *   Vì sao: lượt trừ giờ quota là quyền lợi của gói hội viên đã thanh toán từ trước, không phải dòng tiền mới, nên cần tách riêng để không tính trùng doanh thu.
 * Được gọi ở: revenueBody, bước 2.
 * @param summaryRows Danh sách các dòng tổng hợp thanh toán đã truy vấn từ database ở bước 1.
 * @returns Dữ liệu phân tách gồm danh sách tiền thực, danh sách quota, tổng thu, tổng hoàn và các bảng tra cứu phân bổ.
 * @throws Không có lỗi nào được ném ra từ hàm này.
 */
function calculateRevenuePaymentBreakdown(
  summaryRows: RevenuePaymentSummaryRow[],
): RevenuePaymentBreakdown {
  const moneyPayments: RevenuePaymentSummaryRow[] = [];
  const quotaPayments: RevenuePaymentSummaryRow[] = [];
  let grossVnd = 0;
  let refundVnd = 0;
  const bySource: Record<string, number> = {};
  const refundsBySource: Record<string, number> = {};
  const byMethod: Record<string, number> = {};

  for (const summaryRow of summaryRows) {
    // Quota là lượt trừ giờ từ gói tập đã mua trước đó, không phát sinh dòng tiền mới ở lần đặt này.
    const isQuotaPayment = summaryRow.method === "quota";
    if (isQuotaPayment) {
      quotaPayments.push(summaryRow);
      continue;
    }

    // Các khoản thanh toán bằng tiền thực (tiền mặt, thẻ, chuyển khoản...) được đưa vào doanh thu và hoàn tiền.
    moneyPayments.push(summaryRow);
    grossVnd += summaryRow.total;
    refundVnd += summaryRow.refunded;

    // Tổng hợp doanh thu thực tế theo từng loại dịch vụ (thuê sân, mua gói, lớp học...).
    const currentSourceTotal = bySource[summaryRow.ref_type] ?? 0;
    bySource[summaryRow.ref_type] = currentSourceTotal + summaryRow.total;

    // Chỉ ghi nhận nguồn có phát sinh hoàn tiền để đối chiếu số tiền trả lại khách theo từng dịch vụ.
    const hasRefundedAmount = Boolean(summaryRow.refunded);
    if (hasRefundedAmount) {
      const currentRefundSourceTotal = refundsBySource[summaryRow.ref_type] ?? 0;
      refundsBySource[summaryRow.ref_type] = currentRefundSourceTotal + summaryRow.refunded;
    }

    // Phân bổ doanh thu theo hình thức thanh toán để đối soát với sổ quỹ tiền mặt và tài khoản ngân hàng.
    const currentMethodTotal = byMethod[summaryRow.method] ?? 0;
    byMethod[summaryRow.method] = currentMethodTotal + summaryRow.total;
  }

  return {
    moneyPayments,
    quotaPayments,
    grossVnd,
    refundVnd,
    bySource,
    refundsBySource,
    byMethod,
  };
}

/**
 * Làm gì: truy vấn tổng số giờ chơi được thanh toán bằng gói giờ (quota_hours) trong các lượt đặt sân hợp lệ.
 *   Vì sao: chỉ tính các lượt đặt sân có trạng thái confirmed, in_use, completed hoặc no_show để phản ánh đúng số giờ hội viên đã thực tế giữ sân hoặc sử dụng.
 * Được gọi ở: revenueBody, bước 3.
 * @param sql Kết nối database do revenueBody chuyển vào từ router hoặc caller.
 * @param from Ngày bắt đầu chu kỳ báo cáo (YYYY-MM-DD), tính theo múi giờ Asia/Ho_Chi_Minh.
 * @param to Ngày kết thúc chu kỳ báo cáo (YYYY-MM-DD), tính theo múi giờ Asia/Ho_Chi_Minh.
 * @returns Tổng số giờ chơi đặt qua gói giờ quota; trả về 0 nếu không phát sinh giờ chơi nào.
 * @throws Lỗi truy vấn database được truyền nguyên ra ngoài; không tự tạo lỗi HTTP.
 */
async function loadRevenueQuotaHours(
  sql: Sql,
  from: string,
  to: string,
): Promise<number> {
  const row = await one<{ hours: string | number }>(
    sql,
    `select coalesce(sum(quota_hours),0) as hours
       from court_bookings
      where quota_hours > 0
        and (start_at at time zone 'Asia/Ho_Chi_Minh')::date between $1::date and $2::date
        and status in ('confirmed','in_use','completed','no_show')`,
    [from, to],
  );

  return Number(row?.hours ?? 0);
}

/**
 * Làm gì: truy vấn doanh thu tiền thực và tiền hoàn theo từng ca trực thu ngân, kèm tên thu ngân và thời gian ca trực.
 *   Vì sao: khoản thanh toán online không qua quầy (shift_id là null) vẫn được giữ lại thành một dòng riêng chứ không bị bỏ qua, đảm bảo tổng tiền các ca cộng lại khớp đúng tổng doanh thu trung tâm (nghiệp vụ G-07).
 * Được gọi ở: revenueBody, bước 4.
 * @param sql Kết nối database do revenueBody chuyển vào từ router hoặc caller.
 * @param from Ngày bắt đầu chu kỳ báo cáo (YYYY-MM-DD), tính theo múi giờ Asia/Ho_Chi_Minh.
 * @param to Ngày kết thúc chu kỳ báo cáo (YYYY-MM-DD), tính theo múi giờ Asia/Ho_Chi_Minh.
 * @param method Phương thức thanh toán cần lọc, hoặc null nếu lấy tất cả phương thức.
 * @param includeDetails Cờ xác định có cần truy vấn chi tiết theo ca hay không; nếu false thì trả về mảng rỗng ngay lập tức.
 * @returns Danh sách doanh thu theo ca trực sắp xếp theo thời gian mở ca; trả về mảng rỗng nếu includeDetails là false.
 * @throws Lỗi truy vấn database được truyền nguyên ra ngoài; không tự tạo lỗi HTTP.
 */
async function loadRevenueByShift(
  sql: Sql,
  from: string,
  to: string,
  method: string | null,
  includeDetails: boolean,
): Promise<RevenueShiftRow[]> {
  // Khi người gọi không cần xem bảng ca trực (ví dụ so sánh kỳ trước hoặc kiểm tra công suất), bỏ qua truy vấn để tối ưu hiệu năng.
  if (!includeDetails) {
    return [];
  }

  // Takings per cashier shift (G-07). A payment with no shift — an online
  // payment nobody at the desk took — is its own line rather than being
  // dropped, so the shifts and that line still add up to the total.
  return sql.query<RevenueShiftRow>(
    `select p.shift_id, u.full_name as cashier, s.opened_at, s.closed_at,
            coalesce(sum(p.amount_vnd) filter (where p.amount_vnd >= 0), 0)::int as takings_vnd,
            coalesce(sum(-p.amount_vnd) filter (where p.amount_vnd < 0), 0)::int as refunds_vnd,
            count(*)::int as count
       from payments p
       left join cashier_shifts s on s.id = p.shift_id
       left join users u on u.id = s.receptionist_id
      where p.status = 'posted' and p.method <> 'quota'
        and (p.created_at at time zone 'Asia/Ho_Chi_Minh')::date between $1::date and $2::date
        and ($3::text is null or p.method::text = $3)
      group by p.shift_id, u.full_name, s.opened_at, s.closed_at
      order by s.opened_at nulls last`,
    [from, to, method],
  );
}

/**
 * Làm gì: tạo chuỗi ngày liên tục bằng generate_series và tính doanh thu tiền thực cho từng ngày trong khoảng thời gian.
 *   Vì sao: generate_series đảm bảo những ngày không có doanh thu vẫn xuất hiện với giá trị 0đ, giúp vẽ biểu đồ xu hướng chính xác thay vì nối liền các ngày có giao dịch làm biến dạng biểu đồ.
 * Được gọi ở: revenueBody, bước 5.
 * @param sql Kết nối database do revenueBody chuyển vào từ router hoặc caller.
 * @param from Ngày bắt đầu chu kỳ báo cáo (YYYY-MM-DD), tính theo múi giờ Asia/Ho_Chi_Minh.
 * @param to Ngày kết thúc chu kỳ báo cáo (YYYY-MM-DD), tính theo múi giờ Asia/Ho_Chi_Minh.
 * @param method Phương thức thanh toán cần lọc, hoặc null nếu lấy tất cả phương thức.
 * @param includeDetails Cờ xác định có cần truy vấn chi tiết theo ngày hay không; nếu false thì trả về mảng rỗng ngay lập tức.
 * @returns Danh sách doanh thu theo từng ngày sắp xếp theo thứ tự ngày tăng dần; trả về mảng rỗng nếu includeDetails là false.
 * @throws Lỗi truy vấn database được truyền nguyên ra ngoài; không tự tạo lỗi HTTP.
 */
async function loadRevenueByDay(
  sql: Sql,
  from: string,
  to: string,
  method: string | null,
  includeDetails: boolean,
): Promise<RevenueDayRow[]> {
  // Khi không cần vẽ biểu đồ diễn biến ngày, không sinh chuỗi ngày để giảm tải tính toán cho cơ sở dữ liệu.
  if (!includeDetails) {
    return [];
  }

  // Revenue per ICT day, gapless across the whole window.
  //
  // The report could only ever be sliced by method and source, so the manager
  // screen had no way to draw a trend — the one question a revenue report is
  // usually opened to answer. generate_series supplies the days with no
  // takings too: dropping them would make a quiet Tuesday vanish and join
  // Monday straight to Wednesday, which reads as steady trade.
  return sql.query<RevenueDayRow>(
    `select to_char(d.day, 'YYYY-MM-DD') as day,
            coalesce(sum(p.amount_vnd) filter (where p.method <> 'quota'), 0)::int as revenue_vnd
       from generate_series($1::date, $2::date, interval '1 day') as d(day)
       left join payments p
              on p.status = 'posted'
             and (p.created_at at time zone 'Asia/Ho_Chi_Minh')::date = d.day::date
             and ($3::text is null or p.method::text = $3)
      group by d.day
      order by d.day`,
    [from, to, method],
  );
}

/**
 * Làm gì: tổng hợp các số liệu doanh thu, phân bổ nguồn thu, ca trực và chuỗi ngày thành đối tượng phản hồi HTTP 200 hoàn chỉnh.
 *   Vì sao: doanh thu thuần (revenue_vnd) luôn được tính bằng tổng thực thu (gross_vnd) trừ đi tổng tiền hoàn trả (refund_vnd).
 * Được gọi ở: revenueBody, bước 6.
 * @param from Ngày bắt đầu chu kỳ báo cáo (YYYY-MM-DD).
 * @param to Ngày kết thúc chu kỳ báo cáo (YYYY-MM-DD).
 * @param breakdown Dữ liệu phân bổ thanh toán đã tính ở bước 2.
 * @param quotaHours Tổng số giờ chơi bằng gói giờ hội viên lấy từ bước 3.
 * @param byShift Danh sách doanh thu theo ca trực lấy từ bước 4.
 * @param byDay Danh sách doanh thu theo từng ngày lấy từ bước 5.
 * @returns Đối tượng phản hồi HTTP 200 chứa body báo cáo doanh thu đầy đủ.
 * @throws Không có lỗi nào được ném ra từ hàm này.
 */
function buildRevenueReportResponse(
  from: string,
  to: string,
  breakdown: RevenuePaymentBreakdown,
  quotaHours: number,
  byShift: RevenueShiftRow[],
  byDay: RevenueDayRow[],
): RevenueReportResponse {
  // Doanh thu thuần bằng tổng thực thu trừ đi các khoản tiền đã hoàn trả cho khách hàng.
  const netRevenueVnd = breakdown.grossVnd - breakdown.refundVnd;

  return {
    status: 200,
    body: {
      from,
      to,
      totals: {
        revenue_vnd: netRevenueVnd,
        gross_vnd: breakdown.grossVnd,
        refund_vnd: breakdown.refundVnd,
        quota_hours: quotaHours,
      },
      by_source: breakdown.bySource,
      refunds_by_source: breakdown.refundsBySource,
      by_shift: byShift,
      by_method: breakdown.byMethod,
      by_day: byDay,
      quota_payments: breakdown.quotaPayments,
      lines: breakdown.moneyPayments,
    },
  };
}

/**
 * Làm gì: tính toán và tổng hợp toàn bộ dữ liệu báo cáo doanh thu của trung tâm trong một khoảng thời gian, hỗ trợ lọc theo phương thức thanh toán.
 *   Vì sao: cung cấp số liệu doanh thu thuần, doanh thu gộp, tiền hoàn, phân bổ theo nguồn thu/phương thức, cùng chi tiết theo ca và theo ngày cho màn hình quản trị và báo cáo định kỳ.
 * Được gọi ở:
 *   - Hàm reportsRevenue trong src/server/controllers/handlers/desk.ts (bước tính kỳ hiện tại và tính kỳ trước liền kề để so sánh đối chiếu FR-PAY-05).
 *     Hàm reportsRevenue được gọi qua route GET /v1/reports/revenue (bọc bởi authedRead yêu cầu role manager trong src/server/controllers/router.ts),
 *     phục vụ màn hình Dashboard Báo cáo của Quản lý /manager/ (src/routes/manager.index.tsx) thông qua hook useManagerOverview (src/client/lib/pages/manager.index.ts).
 *   - Hàm reportsCapacity trong src/server/controllers/handlers/reports.ts (gọi với includeDetails = false để lấy by_source nhằm tách riêng doanh thu thuê sân và học phí lớp học,
 *     phục vụ API GET /v1/reports/capacity và GET /v1/manager/capacity trên màn hình /manager/capacity).
 *   - Hàm revenueDocument trong src/server/controllers/handlers/reports.ts (gọi để chuẩn bị dữ liệu xuất file PDF/CSV báo cáo doanh thu,
 *     phục vụ API GET /v1/reports/:kind/export với kind = 'revenue' khi bấm nút Export trên màn hình /manager/).
 * @param sql Kết nối database do caller cung cấp (từ authedRead của router hoặc handler khác).
 * @param from Ngày bắt đầu chu kỳ báo cáo dạng YYYY-MM-DD, tính theo múi giờ Asia/Ho_Chi_Minh.
 * @param to Ngày kết thúc chu kỳ báo cáo dạng YYYY-MM-DD, tính theo múi giờ Asia/Ho_Chi_Minh.
 * @param method Phương thức thanh toán cần lọc (cash, transfer, card, gateway, quota), hoặc null nếu xem toàn bộ.
 * @param includeDetails Cờ xác định có cần lấy chi tiết theo ca trực (by_shift) và theo ngày (by_day) hay không; mặc định là true.
 * @returns Phản hồi HTTP 200 với body chứa from, to, totals, by_source, refunds_by_source, by_shift, by_method, by_day, quota_payments, lines.
 * @throws Lỗi truy vấn database được truyền nguyên ra ngoài; không tự tạo lỗi HTTP vì việc kiểm tra tính hợp lệ của tham số ngày và quyền truy cập do caller/router đảm nhiệm.
 */
export async function revenueBody(
  sql: Sql,
  from: string,
  to: string,
  method: string | null,
  includeDetails = true,
) {
  // Bước 1: truy vấn tổng hợp thanh toán thực tế và lượt trừ giờ từ cơ sở dữ liệu.
  const summaryRows = await loadRevenuePaymentSummaryRows(sql, from, to, method);

  // Bước 2: phân loại tiền thực và quota, tính tổng doanh thu gộp, hoàn tiền và phân bổ theo nguồn/phương thức.
  const breakdown = calculateRevenuePaymentBreakdown(summaryRows);

  // Bước 3: lấy tổng số giờ chơi đặt sân bằng gói giờ hội viên trong khoảng thời gian.
  const quotaHours = await loadRevenueQuotaHours(sql, from, to);

  // Bước 4: lấy chi tiết doanh thu theo từng ca trực thu ngân nếu cần hiển thị chi tiết.
  const byShift = await loadRevenueByShift(sql, from, to, method, includeDetails);

  // Bước 5: lấy doanh thu liên tục theo từng ngày nếu cần hiển thị chi tiết biểu đồ xu hướng.
  const byDay = await loadRevenueByDay(sql, from, to, method, includeDetails);

  // Bước 6: đóng gói toàn bộ các nhóm số liệu thành cấu trúc phản hồi HTTP 200 theo quy ước.
  return buildRevenueReportResponse(
    from,
    to,
    breakdown,
    quotaHours,
    byShift,
    byDay,
  );
}

/**
 * Làm gì: Thống kê tỷ lệ lấp đầy sân (occupancy) theo từng sân trong ngày dựa trên các lượt đặt sân và ca học thực tế.
 * Được gọi ở: Route GET /v1/reports/occupancy (trong src/server/controllers/router.ts), phục vụ trang báo cáo công suất của Quản lý.
 * @param sql Kết nối cơ sở dữ liệu Postgres.
 * @param request Request chứa query parameter date (YYYY-MM-DD, mặc định là ngày hiện tại theo giờ Việt Nam).
 * @param user Thông tin người dùng gọi API, yêu cầu role manager.
 * @returns Phản hồi HTTP 200 kèm ngày báo cáo và danh sách từng sân với số phút hoạt động và tỷ lệ % lấp đầy.
 * @throws Ném lỗi 403 Forbidden nếu người dùng không có role manager.
 */
export async function reportsOccupancy(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền truy cập, chỉ quản lý (manager) mới được xem báo cáo lấp đầy sân.
  requireRole(user, ["manager"]);
  // Bước 2: Lấy ngày cần xem báo cáo từ query parameter date, mặc định là ngày hôm nay theo giờ ICT.
  const date = new URL(request.url).searchParams.get("date") ?? ictDateString();
  // Bước 3: Tính tổng số phút có lịch đặt hoặc ca học diễn ra trên từng sân trong khung giờ mở cửa 06:00 - 22:00.
  // Sử dụng least/greatest để chỉ tính khoảng thời gian giao thoa thực tế nằm trong khung giờ của ngày báo cáo.
  const rows = await sql.query<{ court_id: string; court_code: string; minutes: number }>(
    `select c.id as court_id, c.court_code,
            coalesce(sum(
              case when o.start_at is null then 0
                   else extract(epoch from (least(o.end_at, $2::timestamptz) - greatest(o.start_at, $1::timestamptz))) / 60
              end
            ),0)::int as minutes
       from courts c
       left join ${PLAYED_SQL} o
         on o.court_id = c.id and o.kind in ('booking','session') and o.start_at < $2 and o.end_at > $1
       where c.retired_at is null or o.id is not null
      group by c.id, c.court_code
      order by c.court_code`,
    [`${date}T06:00:00+07:00`, `${date}T22:00:00+07:00`],
  );
  // Bước 4: Tính tỷ lệ lấp đầy (% occupancy) trên tổng thời gian mở cửa 16 tiếng (960 phút) mỗi ngày, làm tròn 1 chữ số thập phân.
  const openMin = 16 * 60;
  return {
    status: 200,
    body: {
      date,
      items: rows.map((r) => ({
        ...r,
        pct: Math.round((r.minutes / openMin) * 1000) / 10,
      })),
    },
  };
}

/**
 * Làm gì: Lấy thông tin cấu hình toàn hệ thống của trung tâm thể thao từ bảng center_settings (bản ghi duy nhất id = 1).
 * Được gọi ở: Route GET /v1/settings (trong src/server/controllers/router.ts), phục vụ tải cấu hình trung tâm trên giao diện nội bộ.
 * @param sql Kết nối cơ sở dữ liệu Postgres.
 * @param user Thông tin người dùng đăng nhập (chỉ cho phép các role manager, receptionist, coach).
 * @returns Phản hồi HTTP 200 chứa bản ghi cấu hình trung tâm center_settings.
 * @throws Ném lỗi 403 Forbidden nếu người dùng không thuộc các role nhân viên được phép.
 */
export async function settingsGet(sql: Sql, user: PublicUser) {
  // Chỉ nhân viên nội bộ (manager, receptionist, coach) mới được phép đọc thông tin cấu hình trung tâm.
  requireRole(user, ["manager", "receptionist", "coach"]);
  // Bảng center_settings là bảng cấu hình đơn bản ghi (singleton) luôn có id = 1.
  const row = await one<Record<string, unknown>>(sql, `select * from center_settings where id = 1`);
  return { status: 200, body: row };
}

/**
 * Làm gì: Cập nhật từng phần (PATCH) các thông số cấu hình trung tâm và ghi nhật ký kiểm toán (audit log).
 * Được gọi ở: Route PATCH /v1/settings (trong src/server/controllers/router.ts), từ trang Cài đặt trung tâm của Quản lý (/manager/settings).
 * @param sql Kết nối cơ sở dữ liệu Postgres (đã nằm trong transaction authed).
 * @param request Request chứa body JSON với các trường cấu hình cần thay đổi.
 * @param user Thông tin người dùng thực hiện (bắt buộc role manager).
 * @returns Phản hồi HTTP 200 kèm bản ghi cấu hình trung tâm mới nhất sau khi cập nhật.
 * @throws Ném lỗi 403 nếu không phải manager, 400 nếu dữ liệu cấu hình hoặc ràng buộc giờ/tuần không hợp lệ.
 */
export async function settingsPatch(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền quản lý, chỉ manager mới được thay đổi cấu hình trung tâm.
  requireRole(user, ["manager"]);
  // Bước 2: Đọc dữ liệu gửi lên, xác thực định dạng từng trường và chuẩn hóa các cấu hình phức tạp (cancel_tiers, ui_config).
  const b = await readJson(request);
  const patch = parseSettingsPatch(b);
  if (b.cancel_tiers !== undefined) patch.cancel_tiers = JSON.stringify(parseCancelTiers(b.cancel_tiers));
  if (b.ui_config !== undefined) {
    const stored = await one<{ ui_config: unknown }>(sql, `select ui_config from center_settings where id = 1`);
    const ui = parseUiConfigPatch(b.ui_config, stored?.ui_config);
    if (!ui.ok) throw err.field(ui.field, ui.message);
    patch.ui_config = JSON.stringify(ui.value);
  }
  // Bước 3: Lấy các giá trị cấu hình hiện tại trong database để kiểm tra các ràng buộc chéo và lưu vết audit log.
  const keys = Object.keys(patch);
  const current = await one<Record<string, string>>(
    sql,
    `select open_time::text, close_time::text, hold_minutes, book_ahead_days, max_slots_per_day,
            cancel_court_hours, cancel_class_hours, noshow_grace_minutes, checkin_before_minutes,
            refund_manager_vnd, self_checkin_enabled, gate_dedup_minutes, at_risk_idle_days, minor_age, vat_rate, legal_name, tax_code, address,
            freeze_max_days_year, waitlist_offer_hours, deposit_pct, deposit_peak_only, cancel_tiers::text,
            series_min_weeks, series_max_weeks, series_discount_pct, loyalty_earn_vnd, loyalty_redeem_vnd, member_court_fee_vnd, member_day_rate_vnd, max_active_classes, ui_config::text
       from center_settings where id = 1`,
  );
  // Nếu không có trường nào thay đổi thì trả về ngay cấu hình hiện tại để tránh cập nhật database thừa.
  if (keys.length === 0) {
    const row = await one<Record<string, unknown>>(sql, `select * from center_settings where id = 1`);
    return { status: 200, body: row };
  }
  // Opening hours are judged as a pair, so changing only one is still checked.
  checkOpeningHours(
    (patch.open_time as string | undefined) ?? current!.open_time,
    (patch.close_time as string | undefined) ?? current!.close_time,
  );
  // Kiểm tra ràng buộc thời hạn đăng ký cố định: số tuần tối thiểu không được vượt quá số tuần tối đa.
  const minW = Number(patch.series_min_weeks ?? current!.series_min_weeks);
  const maxW = Number(patch.series_max_weeks ?? current!.series_max_weeks);
  if (minW > maxW) throw err.field("series_max_weeks", "The maximum cannot be below the minimum.");
  // Bước 4: Xây dựng câu lệnh động và thực hiện cập nhật các trường thay đổi vào bản ghi cấu hình id = 1.
  const sets = keys.map((k, i) => `${k} = $${i + 1}${k === "cancel_tiers" || k === "ui_config" ? "::jsonb" : ""}`);
  await sql.query(`update center_settings set ${sets.join(", ")} where id = 1`, keys.map((k) => patch[k]));
  // Bước 5: Ghi nhật ký audit log lưu lại trạng thái trước và sau khi thay đổi (entity_id là null vì id = 1 không phải kiểu UUID).
  await audit(
    sql,
    user.id,
    "patch_settings",
    "settings",
    // The row is `id = 1`, which is not a UUID: passing "1" here is what made
    // every save fail with "invalid input syntax for type uuid" (B-01).
    null,
    Object.fromEntries(keys.map((k) => [k, current![k]])),
    patch,
  );
  // Bước 6: Đọc lại toàn bộ cấu hình mới nhất từ database và trả về cho client.
  const finalRow = await one<Record<string, unknown>>(sql, `select * from center_settings where id = 1`);
  return { status: 200, body: finalRow };
}

/**
 * Làm gì: Lấy toàn bộ danh sách quy tắc giá thuê sân (price rules) của trung tâm, sắp xếp theo môn, loại ngày và giờ bắt đầu.
 * Được gọi ở:
 *   - Route GET /v1/price-rules (trong src/server/controllers/router.ts), API công khai xem bảng giá.
 *   - Hàm priceRulesPut trong file này (dòng 1699 và 1709) để lấy trạng thái trước và sau khi thay thế bảng giá.
 * @param sql Kết nối cơ sở dữ liệu Postgres.
 * @returns Phản hồi HTTP 200 kèm danh sách các quy tắc giá (items).
 * @throws Không ném lỗi nghiệp vụ.
 */
export async function priceRulesGet(sql: Sql) {
  // Lấy danh sách quy tắc giá sân, sắp xếp tuần tự theo môn thể thao, loại ngày (weekday/weekend) và khung giờ trong ngày.
  const items = await sql.query(
    `select id, sport, court_id, day_kind, start_local::text, end_local::text, price_vnd, is_peak
       from price_rules order by sport, day_kind, start_local`,
  );
  return { status: 200, body: { items } };
}

/**
 * Làm gì: Thay thế toàn bộ bảng quy tắc giá sân (price rules) của trung tâm bằng danh sách quy tắc mới.
 * Được gọi ở: Route PUT /v1/price-rules (trong src/server/controllers/router.ts), từ màn hình Cài đặt Bảng giá của Quản lý (/manager/pricing).
 * @param sql Kết nối cơ sở dữ liệu Postgres (chạy trong transaction authed).
 * @param request Request chứa danh sách quy tắc giá mới trong body JSON (trường items hoặc mảng JSON trực tiếp).
 * @param user Thông tin người dùng thực hiện (bắt buộc role manager).
 * @returns Phản hồi HTTP 200 kèm danh sách quy tắc giá mới sau khi cập nhật thành công.
 * @throws Ném lỗi 403 nếu không phải manager, 400 nếu mảng items thiếu hoặc có quy tắc giá không hợp lệ.
 */
export async function priceRulesPut(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền quản lý, chỉ manager mới được cập nhật bảng giá sân.
  requireRole(user, ["manager"]);
  // Bước 2: Đọc và trích xuất danh sách quy tắc giá từ body request.
  const b = await readJson(request);
  const items = Array.isArray(b.items) ? b.items : Array.isArray(b) ? b : null;
  if (!items) throw err.validation("items[] is required.");
  // The one thing standing between a fat-fingered (or malicious) PUT and a
  // court quoted at 99,999,999đ. Validate the whole table before touching a
  // row — `delete from price_rules` is not the place to discover row 9 was bad.
  // Bước 3: Lấy danh sách môn thể thao đang hoạt động để xác thực toàn bộ bảng quy tắc mới trước khi xóa dữ liệu cũ.
  const sportsRes = await sql.query<{ code: string }>(`select code from sports where retired_at is null`);
  const validSports = sportsRes.map((r) => r.code);
  const checked = validatePriceRules(items, validSports);
  if (!checked.ok) throw err.validation(checked.message, { index: checked.index });
  // Bước 4: Lưu lại dữ liệu bảng giá trước khi xóa để đưa vào bản ghi audit log.
  const before = await priceRulesGet(sql);
  // Bước 5: Xóa toàn bộ quy tắc giá cũ và chèn danh sách quy tắc giá mới đã được xác thực.
  await sql.query(`delete from price_rules`);
  for (const it of checked.rules) {
    await sql.query(
      `insert into price_rules (sport, court_id, day_kind, start_local, end_local, price_vnd, is_peak)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [it.sport, it.court_id, it.day_kind, it.start_local, it.end_local, it.price_vnd, it.is_peak],
    );
  }
  // Bước 6: Ghi nhật ký audit log lưu lại toàn bộ thay đổi của bảng giá (hành động replace_prices).
  await audit(sql, user.id, "replace_prices", "price_rules", null, before.body, { items: checked.rules });
  // Bước 7: Lấy lại danh sách quy tắc giá vừa tạo và trả về cho client.
  return priceRulesGet(sql);
}

// The log stores a table and an id. A manager needs the booking code or the member's name, so each page
// looks them up by kind. A record deleted since simply has no name and the row falls back to its kind.
const AUDIT_SUBJECT_SQL: Record<string, string> = {
  user: `select t.id, t.full_name as subject from users t where t.id = any($1::uuid[])`,
  payment: `select t.id, concat_ws(' · ', t.code, u.full_name) as subject, t.amount_vnd as subject_vnd
              from payments t left join users u on u.id = t.user_id where t.id = any($1::uuid[])`,
  booking: `select t.id, concat_ws(' · ', t.code, u.full_name) as subject
              from court_bookings t left join users u on u.id = t.user_id where t.id = any($1::uuid[])`,
  booking_series: `select t.id, concat_ws(' · ', t.code, u.full_name) as subject
                     from booking_series t left join users u on u.id = t.user_id where t.id = any($1::uuid[])`,
  court: `select t.id, t.court_code as subject from courts t where t.id = any($1::uuid[])`,
  plan: `select t.id, t.name as subject from membership_plans t where t.id = any($1::uuid[])`,
  promotion: `select t.id, t.code as subject from promotions t where t.id = any($1::uuid[])`,
  equipment: `select t.id, t.name as subject from equipment_items t where t.id = any($1::uuid[])`,
  work_order: `select t.id, concat_ws(' · ', t.code, t.title) as subject from work_orders t where t.id = any($1::uuid[])`,
  ticket: `select t.id, u.full_name as subject from tickets t left join users u on u.id = t.user_id where t.id = any($1::uuid[])`,
  subscription: `select t.id, concat_ws(' · ', u.full_name, p.name) as subject
                   from subscriptions t join users u on u.id = t.user_id
                   join membership_plans p on p.id = t.plan_id where t.id = any($1::uuid[])`,
};

/**
 * Làm gì: Truy vấn thông tin hiển thị (tên, mã code, số tiền) cho các đối tượng xuất hiện trong nhật ký kiểm toán (audit log).
 * Được gọi ở: Hàm auditList trong file này (dòng 1794) để làm giàu dữ liệu (enrich) cho từng dòng audit log trước khi trả về.
 * @param sql Kết nối cơ sở dữ liệu Postgres.
 * @param rows Danh sách các dòng log cần tra cứu, mỗi dòng gồm tên bảng thực thể (entity) và ID thực thể (entity_id).
 * @returns Map ánh xạ từ khóa dạng "entity:id" sang thông tin mô tả { subject, subject_vnd }.
 * @throws Lỗi truy vấn cơ sở dữ liệu nếu có.
 */
async function auditSubjects(sql: Sql, rows: { entity: string; entity_id: string | null }[]) {
  // Bước 1: Khởi tạo Map lưu kết quả và định nghĩa hàm trích xuất danh sách ID duy nhất theo từng loại thực thể.
  const out = new Map<string, { subject: string; subject_vnd?: number }>();
  const idsOf = (kind: string) => [...new Set(rows.filter((r) => r.entity === kind && r.entity_id).map((r) => r.entity_id!))];
  // Bước 2: Duyệt từng loại thực thể đã được định nghĩa câu lệnh SQL tra cứu theo lô (batch query) để lấy subject.
  for (const [kind, text] of Object.entries(AUDIT_SUBJECT_SQL)) {
    const ids = idsOf(kind);
    if (!ids.length) continue;
    const found = await sql.query<{ id: string; subject: string; subject_vnd?: number }>(text, [ids]);
    for (const f of found) out.set(`${kind}:${f.id}`, { subject: f.subject, subject_vnd: f.subject_vnd });
  }
  // Bước 3: Tra cứu riêng cho thực thể lớp học (class) để sinh mã lớp định dạng chuẩn bằng hàm classCode.
  const classIds = idsOf("class");
  if (classIds.length) {
    const found = await sql.query<{ id: string; sport: string; level: string }>(
      `select id, sport, level from classes where id = any($1::uuid[])`,
      [classIds],
    );
    for (const c of found) out.set(`class:${c.id}`, { subject: classCode(c.sport, c.level, c.id) });
  }
  return out;
}

/**
 * Làm gì: Lấy danh sách nhật ký kiểm toán (audit log) có phân trang, hỗ trợ lọc theo hành động, người thực hiện, thực thể, khoảng ngày và từ khóa tìm kiếm.
 * Được gọi ở: Route GET /v1/audit (trong src/server/controllers/router.ts), phục vụ trang Nhật ký kiểm toán của Quản lý (/manager/audit).
 * @param sql Kết nối cơ sở dữ liệu Postgres.
 * @param request Request chứa các search params (action, actor, entity, from, to, q, limit, offset).
 * @param user Thông tin người dùng đăng nhập (bắt buộc role manager).
 * @returns Phản hồi HTTP 200 kèm danh sách dòng log đã bổ sung thông tin mô tả đối tượng, thông tin phân trang và các tùy chọn bộ lọc có sẵn.
 * @throws Ném lỗi 403 nếu không phải manager, 400 nếu định dạng ngày hoặc UUID người thực hiện không hợp lệ.
 */
export async function auditList(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền truy cập, chỉ quản lý (manager) mới được xem nhật ký kiểm toán.
  requireRole(user, ["manager"]);
  // Bước 2: Đọc và xác thực tính hợp lệ của các bộ lọc tìm kiếm (khoảng ngày, ID người thao tác, phân trang).
  const sp = new URL(request.url).searchParams;
  const day = (field: string) => {
    const v = sp.get(field);
    if (!v) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
      throw err.field(field, "Use a date like 2026-03-31.");
    }
    return v;
  };
  const from = day("from");
  const to = day("to");
  if (from && to && from > to) throw err.field("to", "The end date is before the start date.");
  const actor = sp.get("actor");
  if (actor && !/^[0-9a-f-]{36}$/i.test(actor)) throw err.field("actor", "Unknown person.");
  const { limit, offset } = pageParams(request, { def: 50, max: 200 });
  // One search over who, what and which record, across every page; underscores in the stored
  // action and entity names match the spaces people type.
  const q = sp.get("q")?.trim() || null;
  const needle = q ? `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%` : null;
  // Days are the centre's days: 23:30 on the 31st is still the 31st here.
  // Bước 3: Định nghĩa hàm truy vấn phân trang nhật ký kiểm toán, lọc theo múi giờ Asia/Ho_Chi_Minh và tìm kiếm từ khóa.
  const page = (lim: number, off: number) =>
    sql.query<{ total: number } & Record<string, unknown>>(
      `select a.id, a.at, a.actor_id, u.full_name as actor_name, u.role as actor_role,
              a.action, a.entity, a.entity_id, a.before, a.after, count(*) over ()::int as total
         from audit_logs a
         left join users u on u.id = a.actor_id
        where ($1::text is null or a.action = $1)
          and ($2::uuid is null or a.actor_id = $2::uuid)
          and ($3::text is null or a.entity = $3)
          and ($4::date is null or (a.at at time zone 'Asia/Ho_Chi_Minh')::date >= $4::date)
          and ($5::date is null or (a.at at time zone 'Asia/Ho_Chi_Minh')::date <= $5::date)
          and ($8::text is null or concat_ws(' ', u.full_name, replace(a.action, '_', ' '), replace(a.entity, '_', ' '), a.entity_id::text) ilike $8)
        order by a.at desc, a.id desc
        limit $6 offset $7`,
      [sp.get("action"), actor, sp.get("entity"), from, to, lim, off, needle],
    );
  // Bước 4: Thực thi truy vấn lấy dữ liệu của trang hiện tại và tính toán tổng số bản ghi.
  const rows = await page(limit, offset);
  const { items, total } = await pageOf(rows, { limit, offset }, async () => Number((await page(1, 0))[0]?.total ?? 0));
  const more = offset + items.length < total;
  // Bước 5: Tra cứu thông tin tên/mã của các đối tượng tác động (subject) để hiển thị chi tiết thân thiện với người dùng.
  const subjects = await auditSubjects(sql, items as unknown as { entity: string; entity_id: string | null }[]);
  const named = items.map((it) => ({ ...it, ...subjects.get(`${it.entity}:${it.entity_id}`) }));
  // What the filters can offer: only what actually exists, so the pickers never
  // drift from the handlers that write the log.
  // Bước 6: Lấy danh sách thực tế các hành động, thực thể và người thao tác hiện có trong log để cung cấp cho các bộ lọc trên UI.
  const actions = await sql.query<{ action: string }>(`select distinct action from audit_logs order by action`);
  const entities = await sql.query<{ entity: string }>(`select distinct entity from audit_logs order by entity`);
  const actors = await sql.query<{ id: string; full_name: string; role: string }>(
    `select distinct u.id, u.full_name, u.role from audit_logs a join users u on u.id = a.actor_id order by u.full_name`,
  );
  // Bước 7: Trả về dữ liệu nhật ký kiểm toán kèm thông tin phân trang và danh sách giá trị bộ lọc.
  return {
    status: 200,
    body: {
      items: named,
      more,
      total,
      limit,
      offset,
      actions: actions.map((a) => a.action),
      entities: entities.map((e) => e.entity),
      actors,
    },
  };
}

type DeskSubscription = {
    user_id: string;
    plan_id: string;
    status: string;
    price_vnd: number;
    sub_price_vnd: number | null;
    court_discount_pct: number;
    promo_id: string | null;
    promo_discount_vnd: number;
  };

/**
 * Làm gì: Xác định giá gốc, số tiền giảm giá và áp dụng mã khuyến mãi cho khoản thanh toán gói hội viên.
 * Được gọi ở: Hàm subscriptionPaymentDetails trong file này (dòng 341) khi quầy lễ tân xử lý thanh toán gói hội viên (POST /v1/payments).
 * @param sql Kết nối cơ sở dữ liệu Postgres.
 * @param sub Thông tin gói hội viên cần thanh toán (giá gói, trạng thái, khuyến mãi đã lưu nếu đang chờ thanh toán).
 * @param b Request body từ client, có thể chứa promo_code mới do lễ tân nhập thêm.
 * @returns Đối tượng chứa basePrice (giá gốc), discount (tiền giảm giá) và promoId (ID khuyến mãi nếu có).
 * @throws Ném lỗi từ quotePromo nếu mã khuyến mãi mới không hợp lệ, hết hạn hoặc không thỏa mãn điều kiện.
 */
async function subscriptionPaymentPromo(sql: Sql, sub: DeskSubscription, b: Record<string, unknown>) {
  // Bước 1: Xác định giá gốc của gói hội viên: ưu tiên giá đã chốt trên đơn đăng ký (sub_price_vnd), nếu chưa có thì lấy giá niêm yết (price_vnd).
  const basePrice = sub.sub_price_vnd ?? sub.price_vnd;
  // Bước 2: Khởi tạo mức giảm giá và mã khuyến mãi: nếu đơn đang chờ thanh toán (pending) và đã có sẵn khuyến mãi thì giữ nguyên.
  let discount = sub.status === "pending" ? sub.promo_discount_vnd : 0;
  let promoId: string | null = sub.status === "pending" ? sub.promo_id : null;
  // Bước 3: Nếu lễ tân nhập mã khuyến mãi mới và đơn chưa có khuyến mãi trước đó, tiến hành kiểm tra điều kiện và tính mức giảm giá.
  const code = str(b.promo_code);
  if (code && !(sub.status === "pending" && promoId)) {
    const quote = await quotePromo(sql, {
      code,
      userId: sub.user_id,
      scope: "plan",
      sport: "all",
      planId: sub.plan_id,
      orderVnd: basePrice,
    });
    discount = quote.discount_vnd;
    promoId = quote.promo_id;
  }
  return { basePrice, discount, promoId };
}
