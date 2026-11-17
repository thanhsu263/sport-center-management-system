/**
 * Xử lý luồng thanh toán trực tuyến qua cổng payOS cho hệ thống Arena 3.
 * Quản lý việc tạo link thanh toán và mã QR (cho hội viên tự thanh toán hoặc lễ tân tạo tại quầy),
 * kiểm tra đối soát kết quả giao dịch và quyết toán các đơn hàng (đặt sân, mua gói hội viên, đăng ký lớp học).
 */
import type { Sql } from "@/server/data/db";
import { err } from "../errors";
import {
  audit,
  bookingBuyer,
  enqueueReceipt,
  getSettings,
  issueInvoice,
  nextCode,
  nextOrderCode,
  readJson,
  str,
} from "../helpers";
import {
  cancelPaymentLink,
  createPaymentLink,
  describeForGateway,
  gatewayAmount,
  payosConfigured,
  readPaymentLink,
  verifyWebhook,
} from "../../integrations/payos";
import { requireRole, type PublicUser } from "../session";
import { one } from "../tx";
import { dueNow } from "../../services/policy";
import { enrollmentAmountDue, enrollmentInvoiceLines } from "../../services/membership";
import { redeemPromo } from "../../services/promos";
import { HELD_COLS, settleHeldBooking } from "./bookings";
import { activateSubscription, describePayment } from "./desk";
import { settleEnrollment } from "./classes";

/**
 * Online payment through payOS.
 *
 * The rule the whole file is built around: **money is posted when payOS says
 * it moved, and at no other moment.** A customer landing back on the return URL
 * proves nothing — that address can be opened by anybody, in any order, any
 * number of times. Every path that posts money here has first either polled
 * payOS or verified a webhook signature.
 *
 * Both the member's phone and the front desk use the same two endpoints. The
 * desk case is the common one in this centre: the customer is standing at the
 * counter, reception raises the link, shows the QR on screen, and the customer
 * scans it with their banking app. Reception never types "received" — the
 * confirmation comes from payOS, and the payment is stamped `capture_mode =
 * 'auto'` so the till can tell the two kinds of money apart.
 */

/** A payment the gateway has been told about but has not confirmed. */
type PendingPayment = {
  id: string;
  code: string;
  user_id: string | null;
  amount_vnd: number;
  status: string;
  ref_type: string;
  ref_id: string;
  provider_order_code: string | number | null;
};

/**
 * Làm gì: Trích xuất origin (protocol và host) từ request để xây dựng returnUrl và cancelUrl cho cổng thanh toán payOS.
 * Được gọi ở: src/server/controllers/handlers/online.ts (trong onlineCreate).
 * @param request Đối tượng Request HTTP gửi từ client.
 * @returns Chuỗi URL gốc dạng protocol://host (ví dụ: https://arena3.vn).
 */
function baseUrlOf(request: Request): string {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

/**
 * Post a confirmed online payment, whatever told us about it.
 *
 * Poll and webhook both land here so they cannot drift apart. Called inside a
 * transaction with the payment row already locked.
 */
/**
 * Làm gì: Quyết toán giao dịch thanh toán online sau khi đã xác thực tiền về tài khoản, cập nhật trạng thái và kích hoạt dịch vụ tương ứng (đặt sân, gói hội viên, lớp học).
 * Được gọi ở: src/server/controllers/handlers/online.ts (trong onlineVerify, payosWebhook), src/server/controllers/tx.test.ts.
 * @param sql Đối tượng kết nối hoặc transaction cơ sở dữ liệu Sql.
 * @param pay Bản ghi thanh toán đang chờ xử lý (PendingPayment) đã được khóa dòng.
 * @param paid Dữ liệu thanh toán đã xác nhận từ cổng (số tiền đã trả, mã giao dịch đối tác, trạng thái từ payOS).
 * @returns Đối tượng { posted: boolean; reason?: string } báo hiệu thanh toán thành công hoặc lý do chưa đủ tiền.
 * @throws Lỗi validation nếu ref_type không thuộc loại được hỗ trợ.
 */
export async function settleOnline(
  sql: Sql,
  pay: PendingPayment,
  paid: { amountPaid: number; transactionId: string | null; providerStatus: string },
): Promise<{ posted: boolean; reason?: string }> {
  // Bước 1: Kiểm tra tính lũy kế (idempotency) — nếu giao dịch đã quyết toán (posted) từ trước thì trả về thành công ngay.
  if (pay.status === "posted") return { posted: true };

  // Bước 2: Kiểm tra trạng thái chỗ lớp học — xác định xem hội viên có từng hủy giữ chỗ (RELEASED) trước khi thanh toán hay không.
  // A seat link the member withdrew by releasing the hold. Read before the row is
  // overwritten below; the caller already holds the row lock.
  const wasReleased =
    pay.ref_type === "enrollment" &&
    (
      await one<{ provider_status: string | null }>(sql, `select provider_status from payments where id = $1`, [pay.id])
    )?.provider_status === "RELEASED";

  // Bước 3: Đối soát số tiền thực nhận từ cổng thanh toán với số tiền cần thu của đơn hàng.
  // Never trust an amount from outside. A confirmation for less than the price
  // is a partial payment, not a paid booking.
  if (paid.amountPaid < gatewayAmount(pay.amount_vnd)) {
    return { posted: false, reason: `paid ${paid.amountPaid} of ${pay.amount_vnd}` };
  }

  // Bước 4: Cập nhật giao dịch sang trạng thái đã ghi nhận (posted), lưu mã giao dịch và thời gian thanh toán.
  await sql.query(
    `update payments
        set status = 'posted', capture_mode = 'auto', provider = 'payos',
            provider_txn_id = $2, provider_status = $3, paid_at = now()
      where id = $1`,
    [pay.id, paid.transactionId, paid.providerStatus],
  );

  // Bước 5: Điều phối quyết toán nghiệp vụ tương ứng theo loại đơn hàng (đặt sân, gói hội viên, hoặc đăng ký lớp học).
  if (pay.ref_type === "booking") return settleOnlineBooking(sql, pay);

  if (pay.ref_type === "subscription") return settleOnlineSubscription(sql, pay);

  if (pay.ref_type === "enrollment") return settleOnlineEnrollment(sql, pay, wasReleased);

  throw err.validation(`Online payment does not cover ${pay.ref_type}.`);
}

/**
 * How far the order sequence has got, and the note that travels with it.
 *
 * Deliberately readable without signing in. It exposes no money, no member and
 * no key — only a counter and a reminder — and it needs to be readable by the
 * operator standing in front of a half-migrated database, which is exactly the
 * moment nobody can sign in.
 */
/**
 * Làm gì: Lấy số thứ tự mã đơn hàng (order code) hiện tại của payOS cùng ghi chú liên quan mà không yêu cầu đăng nhập.
 * Được gọi ở: src/server/controllers/router.ts (route GET /payments/online/sequence).
 * @param sql Đối tượng kết nối cơ sở dữ liệu Sql.
 * @returns Đối tượng { status: 200, body: ... } chứa provider, last_order_code, updated_at và note.
 */
export async function onlineSequence(sql: Sql) {
  // Bước 1: Truy vấn mốc số thứ tự đơn hàng cao nhất của payOS từ bảng provider_sequences.
  const row = await one<{
    provider: string;
    last_order_code: string | number;
    updated_at: string;
    note: string | null;
  }>(
    sql,
    `select provider, last_order_code, updated_at::text, note
       from provider_sequences where provider = 'payos'`,
  );
  // Bước 2: Trả về thông tin sequence nếu đã khởi tạo, hoặc giá trị mặc định nếu chưa có bản ghi.
  return {
    status: 200,
    body: row
      ? {
          provider: row.provider,
          last_order_code: Number(row.last_order_code),
          updated_at: row.updated_at,
          note: row.note,
        }
      : { provider: "payos", last_order_code: null },
  };
}

/**
 * Raise a payment link for an order awaiting payment.
 *
 * A member may only do this for their own held court. Staff may do it for
 * anybody, which is the counter case: the customer is at the desk and will
 * scan the QR that appears on reception's screen.
 */
/**
 * Làm gì: Khởi tạo phiên thanh toán trực tuyến qua payOS, tạo mã thanh toán, mã đơn hàng và link/mã QR để khách quét trả tiền.
 * Được gọi ở: src/server/controllers/router.ts (route POST /payments/online), src/server/controllers/tx.test.ts.
 * @param sql Đối tượng kết nối hoặc transaction cơ sở dữ liệu Sql.
 * @param request Đối tượng Request HTTP chứa thông tin ref_type và ref_id.
 * @param user Thông tin người dùng đang thực hiện yêu cầu (member, receptionist, manager).
 * @returns Đối tượng { status: 201, body: ... } chứa link thanh toán, mã QR, thời gian hết hạn và thông tin đơn hàng.
 * @throws Lỗi 403 nếu không đủ quyền, lỗi C-08 nếu chưa bật payOS, lỗi validation nếu thiếu ref_id hoặc số tiền <= 0, lỗi C-09 nếu không tạo được link payOS.
 */
export async function onlineCreate(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn (member, receptionist, manager) và xác minh trung tâm đã bật cổng payOS.
  requireRole(user, ["member", "receptionist", "manager"]);
  if (!payosConfigured()) {
    throw err.br("C-08", "Online payment is not switched on for this centre.");
  }
  // Bước 2: Đọc dữ liệu từ request body và xác thực định danh đơn hàng ref_id.
  const b = await readJson(request);
  const refType = str(b.ref_type) ?? "booking";
  const refId = str(b.ref_id);
  if (!refId) throw err.validation("ref_id is required.");

  // Bước 3: Lấy thông tin đơn hàng cần thanh toán (số tiền, người trả, thời hạn giữ chỗ) theo loại ref_type.
  const staff = user.role === "receptionist" || user.role === "manager";
  /** When the class seat hold ends (ms since epoch); null for courts and plans. */
  const order = await onlineOrder(sql, refType, refId, staff, user);
  let { amount } = order;
  const { payerId, label, holdEndsAt } = order;

  // Không tạo link thanh toán nếu số tiền bằng 0 hoặc âm
  if (amount <= 0) throw err.validation("There is nothing to pay.");

  // Bước 4: Kiểm tra và tái sử dụng link thanh toán đang còn hiệu lực nếu người dùng thao tác lại.
  const reused = await reuseOnlineLink(sql, refType, refId);
  if (reused) return reused;

  // Bước 5: Lấy cấu hình hệ thống, tính lại học phí mới nhất cho lớp học và lấy mã ca trực của nhân viên (nếu có).
  const settings = await getSettings(sql);
  // A link already live keeps its figure (returned above); a new one prices the seat as of now.
  if (refType === "enrollment") {
    amount = await enrollmentAmountDue(sql, refId);
    if (amount <= 0) throw err.validation("There is nothing to pay.");
  }
  const shiftId = staff
    ? (
        await one<{ id: string }>(
          sql,
          `select id from cashier_shifts where receptionist_id = $1 and closed_at is null`,
          [user.id],
        )
      )?.id ?? null
    : null;
  const base = baseUrlOf(request);

  // Bước 6: Khởi tạo bản ghi thanh toán trong DB và gọi API payOS để sinh link thanh toán cùng mã QR.
  const { pay, payCode, orderCode, link } = await issueOnlineLink(sql, user, { amount, payerId, label, holdEndsAt, refType, refId, shiftId, base }, settings);

  // Bước 7: Ghi log kiểm toán (audit log) và trả về thông tin link/QR cho client.
  await audit(sql, user.id, "online_link", "payment", pay!.id);
  return {
    status: 201,
    body: {
      payment_id: pay!.id,
      payment_code: payCode,
      order_code: orderCode,
      amount_vnd: amount,
      checkout_url: link.checkoutUrl,
      qr_code: link.qrCode,
      expires_at: link.expiredAt,
      for: label,
      /** Whoever raised it: the desk shows the QR, a member is redirected. */
      raised_by: staff ? "desk" : "member",
    },
  };
}

type OnlineOrder = { amount: number; payerId: string | null; label: string; holdEndsAt: number | null };

/**
 * Làm gì: Kiểm tra trạng thái đặt sân, quyền sở hữu, thời hạn giữ chỗ và tính số tiền cần thanh toán cho đơn đặt sân.
 * Được gọi ở: src/server/controllers/handlers/online.ts (trong onlineOrder).
 * @param sql Đối tượng kết nối cơ sở dữ liệu Sql.
 * @param refId ID của đơn đặt sân trong bảng court_bookings.
 * @param staff Cờ xác định người thực hiện có phải là nhân viên quầy (receptionist/manager) hay không.
 * @param user Thông tin người dùng đang thực hiện yêu cầu.
 * @returns Đối tượng OnlineOrder chứa số tiền phải trả, ID người trả, nhãn "court" và thời hạn giữ chỗ.
 * @throws Lỗi 404 nếu không tìm thấy đơn, lỗi 403 nếu xem đơn người khác, lỗi conflictState nếu không ở trạng thái hold, lỗi holdExpired nếu đã hết hạn giữ chỗ.
 */
async function bookingOnlineOrder(sql: Sql, refId: string, staff: boolean, user: PublicUser): Promise<OnlineOrder> {
  // Bước 1: Truy vấn thông tin đơn đặt sân từ bảng court_bookings theo refId.
  const booking = await one<{
    id: string;
    user_id: string;
    status: string;
    price_vnd: number;
    deposit_vnd: number;
    hold_until: string | null;
  }>(sql, `select id, user_id, status, price_vnd, deposit_vnd, hold_until from court_bookings where id = $1`, [refId]);
  // Bước 2: Kiểm tra tính hợp lệ — quyền sở hữu của hội viên, trạng thái giữ chỗ (hold) và thời hạn giữ chỗ.
  if (!booking) throw err.notFound();
  if (!staff && booking.user_id !== user.id) throw err.forbidden();
  if (booking.status !== "hold") throw err.conflictState("That booking is not waiting for payment.");
  if (!booking.hold_until || new Date(booking.hold_until) < new Date()) throw err.holdExpired();
  // Bước 3: Tính số tiền cần thanh toán ngay (tiền cọc hoặc toàn bộ tiền sân) và trả về thông tin đơn hàng.
  return { amount: dueNow(booking), payerId: booking.user_id, label: "court", holdEndsAt: null };
}

/**
 * Làm gì: Kiểm tra trạng thái đơn mua gói hội viên (chỉ nhân viên quầy được tạo link) và tính số tiền sau khi áp dụng giảm giá promo.
 * Được gọi ở: src/server/controllers/handlers/online.ts (trong onlineOrder).
 * @param sql Đối tượng kết nối cơ sở dữ liệu Sql.
 * @param refId ID của bản ghi đăng ký gói trong bảng subscriptions.
 * @param staff Cờ xác định người thực hiện có phải là nhân viên quầy hay không.
 * @returns Đối tượng OnlineOrder chứa số tiền sau giảm giá, ID người mua, nhãn "plan" và thời hạn giữ chỗ (null).
 * @throws Lỗi 403 nếu hội viên tự gọi, lỗi 404 nếu không tìm thấy gói, lỗi conflictState nếu gói không ở trạng thái pending.
 */
async function subscriptionOnlineOrder(sql: Sql, refId: string, staff: boolean): Promise<OnlineOrder> {
  // Bước 1: Kiểm tra quyền hạn — chỉ nhân viên quầy mới được phép tạo link thanh toán cho gói hội viên.
  // Members order plans in the app but pay at the desk, so raising a link for
  // one is reception's job.
  if (!staff) throw err.forbidden("Ask the front desk to take payment for a plan.");
  // Bước 2: Truy vấn thông tin đăng ký gói hội viên từ bảng subscriptions và kiểm tra trạng thái chờ thanh toán (pending).
  const sub = await one<{
    user_id: string;
    plan_id: string;
    status: string;
    promo_discount_vnd: number;
    price_vnd: number | null;
  }>(
    sql,
    `select user_id, plan_id, status, promo_discount_vnd, price_vnd from subscriptions where id = $1`,
    [refId],
  );
  if (!sub) throw err.notFound();
  // A link settles by activating the order, so it only makes sense for one
  // still waiting for money (D-01).
  if (sub.status !== "pending") throw err.conflictState("That plan is not waiting for payment.");
  // Bước 3: Lấy giá niêm yết của gói từ membership_plans và trừ đi số tiền giảm giá promo (nếu có).
  const plan = await one<{ price_vnd: number }>(
    sql,
    `select price_vnd from membership_plans where id = $1`,
    [sub.plan_id],
  );
  const basePrice = sub.price_vnd ?? plan?.price_vnd ?? 0;
  return { amount: Math.max(0, basePrice - (sub.promo_discount_vnd ?? 0)), payerId: sub.user_id, label: "plan", holdEndsAt: null };
}

/**
 * Làm gì: Kiểm tra điều kiện đơn đăng ký lớp học (lớp chưa hủy, chỗ đang giữ còn hạn) và lấy số tiền học phí cần thanh toán.
 * Được gọi ở: src/server/controllers/handlers/online.ts (trong onlineOrder).
 * @param sql Đối tượng kết nối cơ sở dữ liệu Sql.
 * @param refId ID của đơn đăng ký lớp học trong bảng enrollments.
 * @param staff Cờ xác định người thực hiện có phải là nhân viên quầy hay không.
 * @param user Thông tin người dùng đang thực hiện yêu cầu.
 * @returns Đối tượng OnlineOrder chứa học phí, ID học viên, nhãn "class" và mốc thời gian hết hạn giữ chỗ (timestamp ms).
 * @throws Lỗi 404 nếu không tìm thấy đơn, lỗi 403 nếu xem đơn người khác, lỗi BR-18 nếu lớp bị hủy, lỗi BR-28 nếu không ở trạng thái hold hoặc đã hết hạn giữ chỗ.
 */
async function enrollmentOnlineOrder(sql: Sql, refId: string, staff: boolean, user: PublicUser): Promise<OnlineOrder> {
  // Bước 1: Truy vấn đơn đăng ký kèm trạng thái lớp học tương ứng từ bảng enrollments và classes.
  const enr = await one<{
    user_id: string;
    status: string;
    price_vnd: number | null;
    hold_until: string | null;
    class_status: string;
  }>(
    sql,
    `select e.user_id, e.status::text as status, e.price_vnd, e.hold_until, c.status::text as class_status
       from enrollments e join classes c on c.id = e.class_id
      where e.id = $1`,
    [refId],
  );
  // Bước 2: Kiểm tra các quy tắc nghiệp vụ — quyền sở hữu, lớp không bị hủy (BR-18), chỗ đang giữ (BR-28) và thời hạn giữ chỗ chưa hết.
  if (!enr) throw err.notFound();
  if (!staff && enr.user_id !== user.id) throw err.forbidden();
  if (enr.class_status === "cancelled") throw err.br("BR-18", "That class is cancelled.");
  if (enr.status !== "hold") throw err.br("BR-28", "That seat is not on hold, so there is nothing to pay.");
  if (!enr.hold_until || new Date(enr.hold_until) < new Date()) {
    throw err.br("BR-28", "This seat hold has expired.");
  }
  // Bước 3: Trả về thông tin đơn đăng ký lớp học kèm thời điểm hết hạn giữ chỗ (timestamp ms).
  return { amount: enr.price_vnd ?? 0, payerId: enr.user_id, label: "class", holdEndsAt: new Date(enr.hold_until).getTime() };
}

/**
 * Làm gì: Điều phối lấy thông tin đơn hàng thanh toán online theo loại dịch vụ (booking, subscription, enrollment).
 * Được gọi ở: src/server/controllers/handlers/online.ts (trong onlineCreate).
 * @param sql Đối tượng kết nối cơ sở dữ liệu Sql.
 * @param refType Loại dịch vụ thanh toán ("booking" | "subscription" | "enrollment").
 * @param refId ID của bản ghi dịch vụ tương ứng trong cơ sở dữ liệu.
 * @param staff Cờ xác định người thực hiện có phải nhân viên quầy hay không.
 * @param user Thông tin người dùng đang thực hiện yêu cầu.
 * @returns Đối tượng OnlineOrder chứa số tiền, người trả, nhãn và thời hạn giữ chỗ.
 * @throws Lỗi validation nếu refType không thuộc các loại dịch vụ được hỗ trợ.
 */
async function onlineOrder(sql: Sql, refType: string, refId: string, staff: boolean, user: PublicUser) {
  if (refType === "booking") return bookingOnlineOrder(sql, refId, staff, user);
  if (refType === "subscription") return subscriptionOnlineOrder(sql, refId, staff);
  if (refType === "enrollment") return enrollmentOnlineOrder(sql, refId, staff, user);
  throw err.validation("Online payment covers courts, plans and class seats.");
}

type OnlineLinkInput = OnlineOrder & { refType: string; refId: string; shiftId: string | null; base: string };

/**
 * Làm gì: Cấp phát mã đơn hàng, lưu bản ghi thanh toán pending vào DB và gọi API payOS tạo link thanh toán (có cơ chế thử lại nếu trùng mã).
 * Được gọi ở: src/server/controllers/handlers/online.ts (trong onlineCreate).
 * @param sql Đối tượng kết nối cơ sở dữ liệu Sql.
 * @param user Thông tin người dùng tạo giao dịch.
 * @param input Dữ liệu tạo link gồm số tiền, người trả, loại dịch vụ, ca trực và origin URL.
 * @param settings Cấu hình hệ thống (thuế VAT, thời gian giữ chỗ transfer_hold_minutes).
 * @returns Đối tượng chứa bản ghi thanh toán (pay), mã thanh toán nội bộ (payCode), mã đơn hàng payOS (orderCode) và dữ liệu link từ payOS.
 * @throws Lỗi C-09 nếu cả 2 lần thử đều không tạo được link thanh toán từ payOS.
 */
async function issueOnlineLink(sql: Sql, user: PublicUser, input: OnlineLinkInput, settings: Awaited<ReturnType<typeof getSettings>>) {
  /*
   * Allocate a code, ask payOS for a link, and move on if that code is taken.
   *
   * `nextOrderCode` comes from the clock and a recorded high-water mark, so a
   * collision should not happen at all. The retry is here for the one case it
   * cannot rule out: an order code spent at payOS by something other than this
   * database — an earlier install, a colleague's machine sharing the merchant
   * account, a test script.
   *
   * Each pass genuinely advances now. The previous version derived the code
   * from the document counter and, on giving up, threw — which rolled back the
   * whole transaction including every counter increment, so the next request
   * started from exactly the same number and failed in exactly the same way,
   * forever. Nothing in this loop depends on the counter any more.
   *
   * Two attempts, not five: payOS rate-limits at five calls a minute, and
   * burning that budget on retries is how one stuck payment becomes several.
   */
  let pay: { id: string } | null = null;
  let payCode = "";
  let orderCode = 0;
  let link = null;
  let lastError: unknown = null;

  // Bước 1: Thử tối đa 2 lần tạo link với mã đơn hàng mới để phòng trường hợp mã bị trùng trên payOS (giữ dưới hạn mức 5 req/phút).
  for (let attempt = 0; attempt < 2 && !link; attempt += 1) {
    // Sinh mã thanh toán nội bộ PAY-xxx và mã số đơn hàng cho payOS
    const code = await nextCode(sql, "PAY");
    payCode = code;
    orderCode = await nextOrderCode(sql, "payos");

    // Bước 2: Chèn trước bản ghi thanh toán ở trạng thái pending vào DB để sẵn sàng đối soát khi có webhook hoặc polling
    pay = await insertOnlinePayment(sql, user, input, settings, code, orderCode);

    // Bước 3: Gửi yêu cầu sang cổng payOS để tạo payment link và mã QR
    try {
      link = await requestOnlineLink(pay!.id, input, settings, code, orderCode);
    } catch (e) {
      lastError = e;
      // 231 — payOS already has an order with this code.
      const taken = (e as { code?: string })?.code === "231";
      // The row for a code payOS refused is not a payment of any kind.
      await sql.query(`update payments set status = 'failed', provider_status = $2 where id = $1`, [
        pay!.id,
        taken ? "ORDER_CODE_TAKEN" : "CREATE_FAILED",
      ]);
      pay = null;
      if (!taken) throw e;
      console.warn(`[payos] order code ${orderCode} already exists — taking the next one`);
    }
  }

  // Nếu sau 2 lần thử vẫn không tạo được link thanh toán PayOS hoặc bản ghi payment thì báo lỗi C-09 yêu cầu thanh toán tại quầy
  if (!link || !pay) {
    console.error("[payos] could not issue a payment link", lastError);
    throw err.br("C-09", "Could not start the online payment. Take it at the desk instead.");
  }

  return { pay, payCode, orderCode, link };
}

/**
 * Ask payOS whether a link has been paid, and post it if so.
 *
 * Safe to call repeatedly — from the return page, from reception's screen while
 * the customer scans, or from a job. Posting is guarded by the payment's own
 * status, so the second call through finds the work already done.
 */
/**
 * Làm gì: Kiểm tra trạng thái thanh toán trực tuyến từ cổng payOS và quyết toán (settle) đơn hàng nếu đã nhận đủ tiền.
 * Được gọi ở: src/server/controllers/router.ts qua route POST /api/payments/online/:id/verify.
 * @param sql Kết nối cơ sở dữ liệu trong transaction.
 * @param id Mã định danh UUID của bản ghi thanh toán (payments.id).
 * @param user Thông tin người dùng hiện tại đang gửi yêu cầu kiểm tra.
 * @returns Đối tượng HTTP response gồm HTTP status (200) và body chứa trạng thái thanh toán (posted, pending, cancelled, expired, underpaid).
 * @throws 404 NOT_FOUND nếu không tìm thấy giao dịch; 403 FORBIDDEN nếu khách hàng tra cứu giao dịch của người khác; 400 VALIDATION nếu giao dịch không phải thanh toán online.
 */
export async function onlineVerify(sql: Sql, id: string, user: PublicUser) {
  // Bước 1: Khóa dòng giao dịch thanh toán trong bảng payments bằng FOR UPDATE để tránh race condition khi nhiều luồng cùng xác minh.
  const pay = await one<PendingPayment>(
    sql,
    `select id, code, user_id, amount_vnd, status::text as status, ref_type, ref_id, provider_order_code
       from payments where id = $1 for update`,
    [id],
  );
  // Bước 2: Kiểm tra quyền truy cập (chỉ nhân viên hoặc chính người mua mới được tra cứu) và tính hợp lệ của giao dịch trực tuyến.
  if (!pay) throw err.notFound();
  const staff = user.role === "receptionist" || user.role === "manager";
  if (!staff && pay.user_id !== user.id) throw err.forbidden();
  if (!pay.provider_order_code) throw err.validation("That payment was not taken online.");
  // Nếu giao dịch đã được quyết toán thành công trước đó, trả về ngay kết quả để đảm bảo tính idempotent.
  if (pay.status === "posted") {
    return { status: 200, body: { status: "posted", payment_id: pay.id, amount_vnd: pay.amount_vnd } };
  }

  // Bước 3: Truy vấn API payOS để lấy trạng thái thanh toán thực tế mới nhất của đơn hàng qua provider_order_code.
  const state = await readPaymentLink(Number(pay.provider_order_code));
  // Bước 4: Xử lý các trạng thái đơn hàng chưa hoàn tất thanh toán (chưa thanh toán, bị hủy hoặc hết hạn).
  if (state.status !== "PAID") {
    // Đồng bộ trạng thái failed hoặc expired vào cơ sở dữ liệu nếu đơn hàng đã bị hủy hoặc hết hạn trên cổng payOS.
    if (state.status === "CANCELLED" || state.status === "EXPIRED") {
      await sql.query(
        `update payments set status = $2::pay_status, provider_status = $3 where id = $1`,
        [pay.id, state.status === "EXPIRED" ? "expired" : "failed", state.status],
      );
    }
    return {
      status: 200,
      body: { status: state.status.toLowerCase(), payment_id: pay.id, amount_vnd: pay.amount_vnd },
    };
  }

  // Bước 5: Khi payOS xác nhận PAID, tiến hành quyết toán đơn hàng tương ứng (đặt sân, gói hội viên, lớp học).
  const settled = await settleOnline(sql, pay, {
    amountPaid: state.amountPaid,
    transactionId: state.transactionId,
    providerStatus: state.status,
  });
  // Trường hợp khách chuyển thiếu tiền so với số tiền cần thanh toán (underpaid), không ghi nhận hoàn tất và trả về lý do.
  if (!settled.posted) {
    return {
      status: 200,
      body: { status: "underpaid", detail: settled.reason, payment_id: pay.id, amount_vnd: pay.amount_vnd },
    };
  }
  // Bước 6: Ghi nhật ký kiểm toán (audit log) xác nhận thanh toán trực tuyến thành công và trả về trạng thái posted.
  await audit(sql, user.id, "online_paid", "payment", pay.id);
  return { status: 200, body: { status: "posted", payment_id: pay.id, amount_vnd: pay.amount_vnd } };
}

/**
 * payOS calling to say a link was paid.
 *
 * Public by necessity — payOS holds no session — so the signature is the only
 * thing standing between this endpoint and anybody on the internet posting
 * themselves a free court. An unverifiable body is discarded without reading
 * its contents.
 *
 * payOS retries, and sends a test call when the URL is registered, so this is
 * written to be safe to receive any number of times. It always answers 200:
 * a non-2xx makes payOS retry, and the one thing worse than missing a
 * confirmation is a retry storm over a payment already posted.
 */
/**
 * Làm gì: Tiếp nhận webhook thông báo thanh toán thành công từ cổng payOS, xác thực chữ ký số và quyết toán đơn hàng.
 * Được gọi ở: src/server/controllers/router.ts qua route POST /api/payments/online/webhook.
 * @param sql Kết nối cơ sở dữ liệu trong transaction.
 * @param request Đối tượng Request HTTP chứa webhook payload từ payOS.
 * @returns Đối tượng HTTP response status 200 kèm body xác nhận đã nhận { received: true } (luôn trả 200 để tránh payOS gửi lại liên tục).
 * @throws Không ném ngoại lệ ra ngoài; luôn phản hồi HTTP 200 an toàn cho webhook payOS.
 */
export async function payosWebhook(sql: Sql, request: Request) {
  // Bước 1: Đọc body JSON từ request webhook, luôn trả về HTTP 200 ngay cả khi lỗi định dạng để ngăn payOS gửi lại dồn dập (retry storm).
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { status: 200, body: { received: true, note: "unreadable body" } };
  }

  // Bước 2: Xác thực chữ ký số HMAC của webhook để đảm bảo dữ liệu thật sự từ payOS và không bị giả mạo.
  let verified;
  try {
    verified = await verifyWebhook(body);
  } catch {
    // Not from payOS, or tampered with. Say nothing useful back.
    return { status: 200, body: { received: true } };
  }

  // Bước 3: Tìm và khóa dòng bản ghi thanh toán theo provider_order_code bằng FOR UPDATE để chuẩn bị quyết toán.
  const pay = await one<PendingPayment>(
    sql,
    `select id, code, user_id, amount_vnd, status::text as status, ref_type, ref_id, provider_order_code
       from payments where provider_order_code = $1 for update`,
    [verified.orderCode],
  );
  // payOS sends a probe with a dummy order code when the URL is registered.
  if (!pay) return { status: 200, body: { received: true } };

  // Bước 4: Quyết toán giao dịch trực tuyến tương ứng với loại dịch vụ (sân, gói hội viên, lớp học).
  const settled = await settleOnline(sql, pay, {
    amountPaid: verified.amount,
    transactionId: verified.reference,
    providerStatus: "PAID",
  });
  // Bước 5: Ghi nhật ký kiểm toán với actor là null (hệ thống tự động xử lý qua webhook) và phản hồi HTTP 200.
  if (settled.posted) await audit(sql, null, "online_paid_webhook", "payment", pay.id);
  return { status: 200, body: { received: true } };
}

/**
 * Withdraw links for holds that have since lapsed.
 *
 * Run from the job loop. A link that outlives its court is a customer paying
 * for a slot somebody else now has; cancelling it at payOS is what stops the
 * money arriving in the first place, which is much easier than refunding it.
 */
/**
 * Làm gì: Hủy các link thanh toán payOS của các lượt giữ chỗ (booking/enrollment) đã hết hạn để tránh việc khách trả tiền vào slot đã bị thu hồi.
 * Được gọi ở: src/server/data/jobs.ts trong cron job expireGatewayLinks; test runner (src/server/controllers/tx.test.ts).
 * @param sql Kết nối cơ sở dữ liệu trong transaction.
 * @returns Tổng số link thanh toán hết hạn đã được xử lý hủy.
 * @throws Không ném ngoại lệ; lỗi hủy từng link được bắt trong try/catch để đảm bảo các link khác vẫn được cập nhật.
 */
export async function expireOnlineLinks(sql: Sql): Promise<number> {
  // Bước 1: Kiểm tra cấu hình payOS, nếu trung tâm chưa tích hợp cổng thanh toán trực tuyến thì bỏ qua.
  if (!payosConfigured()) return 0;
  // Bước 2: Truy vấn các giao dịch pending mà lượt giữ chỗ sân hoặc chỗ học lớp đã bị hủy hoặc hết hạn thời gian giữ (hold_until < now()).
  const stale = await sql.query<{ id: string; provider_order_code: string }>(
    `select p.id, p.provider_order_code
       from payments p
       left join court_bookings b on p.ref_type = 'booking' and b.id = p.ref_id
       left join enrollments e on p.ref_type = 'enrollment' and e.id = p.ref_id
      where p.status::text = 'pending'
        and p.provider = 'payos'
        and p.provider_order_code is not null
        and (case when p.ref_type = 'enrollment'
                  then e.id is null or e.status::text <> 'hold' or e.hold_until < now()
                  else b.id is null or b.status <> 'hold' or b.hold_until < now() end)`,
  );
  // Bước 3: Duyệt qua từng link quá hạn để gọi payOS hủy link và cập nhật trạng thái expired trong bảng payments.
  for (const row of stale) {
    try {
      await cancelPaymentLink(Number(row.provider_order_code), "Hold expired");
    } catch {
      // Already cancelled or already paid at payOS; the status update below
      // still has to happen either way.
    }
    await sql.query(`update payments set status = 'expired', provider_status = 'EXPIRED' where id = $1`, [
      row.id,
    ]);
  }
  return stale.length;
}

/**
 * Làm gì: Kiểm tra và tái sử dụng link thanh toán payOS đang chờ xử lý (PENDING) cho cùng một đơn hàng, tránh tạo trùng lặp nhiều link khi bấm nhiều lần.
 * Được gọi ở: src/server/controllers/handlers/online.ts trong hàm onlineCreate.
 * @param sql Kết nối cơ sở dữ liệu trong transaction.
 * @param refType Loại tham chiếu của đơn hàng (booking, subscription, enrollment).
 * @param refId Mã định danh UUID của đối tượng tham chiếu cần thanh toán.
 * @returns Phản hồi HTTP 200 chứa thông tin link cũ nếu link vẫn đang PENDING trên payOS; ngược lại trả về undefined để tạo link mới.
 * @throws Có thể ném lỗi từ readPaymentLink nếu kết nối tới payOS thất bại.
 */
async function reuseOnlineLink(sql: Sql, refType: string, refId: string) {
  // One live link per thing being paid for. Without this, pressing the button
  // twice leaves two pending rows and the second confirmation has no order to
  // attach to.
  // Bước 1: Tìm bản ghi thanh toán pending gần nhất của đối tượng này trên hệ thống.
  const existing = await one<PendingPayment>(
    sql,
    `select id, code, user_id, amount_vnd, status::text as status, ref_type, ref_id, provider_order_code
       from payments
      where ref_type = $1 and ref_id = $2 and status::text = 'pending' and provider = 'payos'
      order by created_at desc limit 1`,
    [refType, refId],
  );
  // Bước 2: Nếu có mã đơn hàng, gọi payOS kiểm tra xem link cũ có còn hiệu lực (PENDING) hay không.
  if (existing?.provider_order_code) {
    const state = await readPaymentLink(Number(existing.provider_order_code));
    if (state.status === "PENDING") {
      // Link cũ vẫn còn hạn, trả về ngay thông tin kèm cờ reused: true để hiển thị lại mã QR mà không tạo giao dịch mới.
      return {
        status: 200,
        body: {
          payment_id: existing.id,
          order_code: Number(existing.provider_order_code),
          amount_vnd: existing.amount_vnd,
          reused: true,
        },
      };
    }
  }

}

/**
 * Làm gì: Chèn bản ghi giao dịch mới vào bảng payments với trạng thái pending trước khi gọi cổng payOS để tạo link thanh toán.
 * Được gọi ở: src/server/controllers/handlers/online.ts trong hàm issueOnlineLink.
 * @param sql Kết nối cơ sở dữ liệu trong transaction.
 * @param user Người dùng thực hiện thao tác tạo thanh toán (hội viên tự đặt hoặc lễ tân tạo hộ).
 * @param input Dữ liệu đầu vào gồm số tiền, người trả tiền, ca thu ngân, loại và mã tham chiếu.
 * @param settings Cấu hình hệ thống chứa thuế suất VAT (vat_rate).
 * @param code Mã chứng từ thanh toán nội bộ dạng PAY-xxxxxx.
 * @param orderCode Mã số đơn hàng dạng số nguyên duy nhất gửi sang cổng payOS.
 * @returns Đối tượng chứa mã UUID id của bản ghi payments vừa tạo, hoặc null nếu tạo thất bại.
 * @throws Lỗi cơ sở dữ liệu nếu vi phạm ràng buộc khóa ngoại hoặc trùng lặp mã đơn hàng.
 */
async function insertOnlinePayment(sql: Sql, user: PublicUser, input: OnlineLinkInput, settings: Awaited<ReturnType<typeof getSettings>>, code: string, orderCode: number) {
  // Tạo trước bản ghi payments ở trạng thái pending với capture_mode='auto' để sẵn sàng hứng webhook hoặc xác thực sau này.
  const { amount, payerId, shiftId, refType, refId } = input;
    // The row exists before the link does, so a confirmation always has
    // somewhere to land — and it is `pending`, which no report counts.
    return (await one<{ id: string }>(
      sql,
      `insert into payments
         (code, user_id, shift_id, method, amount_vnd, vat_rate, status, ref_type, ref_id,
          created_by, capture_mode, provider, provider_order_code, provider_status)
       values ($1,$2,$3,'gateway',$4,$5,'pending',$6,$7,$8,'auto','payos',$9,'PENDING')
       returning id`,
      [code, payerId, shiftId, amount, Number(settings.vat_rate ?? 0), refType, refId, user.id, orderCode],
    )) ?? null;

}

/**
 * Làm gì: Gọi thư viện payOS để khởi tạo link thanh toán và mã QR, tính toán thời gian hết hạn khớp với thời hạn giữ chỗ của đơn hàng.
 * Được gọi ở: src/server/controllers/handlers/online.ts trong hàm issueOnlineLink.
 * @param paymentId Mã UUID của bản ghi thanh toán nội bộ.
 * @param input Dữ liệu đơn hàng gồm số tiền (amount), mốc thời gian hết hạn giữ chỗ (holdEndsAt) và URL gốc (base).
 * @param settings Cấu hình trung tâm chứa thời gian giữ chỗ chuyển khoản mặc định (transfer_hold_minutes).
 * @param code Mã chứng từ thanh toán PAY-xxxxxx dùng để tạo nội dung chuyển khoản.
 * @param orderCode Mã số đơn hàng số nguyên gửi cho payOS.
 * @returns Promise chứa thông tin link thanh toán từ cổng payOS (checkoutUrl, qrCode, expiredAt,...).
 * @throws Lỗi từ cổng thanh toán payOS nếu mã đơn hàng đã tồn tại (code 231) hoặc tham số không hợp lệ.
 */
function requestOnlineLink(paymentId: string, input: OnlineLinkInput, settings: Awaited<ReturnType<typeof getSettings>>, code: string, orderCode: number) {
  // Thiết lập URL chuyển hướng kết quả kèm paymentId và giới hạn thời gian sống của link theo thời gian giữ chỗ (hold).
  const { amount, holdEndsAt, base } = input;
      return createPaymentLink({
        orderCode,
        amountVnd: amount,
        description: describeForGateway(code),
        // The payment's own id travels in the URL we control, so the return
        // page has something to ask about without looking one up by order code.
        returnUrl: `${base}/pay/return?pid=${paymentId}`,
        cancelUrl: `${base}/pay/return?pid=${paymentId}&cancelled=1`,
        // Outliving the court hold would let somebody pay for a slot that has
        // already been released to another member. A class seat's link also
        // ends with its own hold, whichever comes first.
        expiresInSeconds:
          holdEndsAt === null
            ? settings.transfer_hold_minutes * 60
            : Math.max(
                1,
                Math.min(settings.transfer_hold_minutes * 60, Math.floor((holdEndsAt - Date.now()) / 1000)),
              ),
      });
}

/**
 * Làm gì: Quyết toán lượt đặt sân sau khi thanh toán trực tuyến thành công: khóa bản ghi đặt sân, gọi settleHeldBooking để xác nhận lịch, xuất hóa đơn và gửi thông báo.
 * Được gọi ở: src/server/controllers/handlers/online.ts trong hàm settleOnline.
 * @param sql Kết nối cơ sở dữ liệu trong transaction.
 * @param pay Bản ghi thanh toán trực tuyến ở trạng thái đang chờ (PendingPayment).
 * @returns Đối tượng { posted: true } báo hiệu quyết toán đặt sân hoàn tất.
 * @throws 404 NOT_FOUND nếu bản ghi đặt sân không còn tồn tại trong hệ thống.
 */
async function settleOnlineBooking(sql: Sql, pay: PendingPayment): Promise<{ posted: boolean }> {
    // Bước 1: Khóa dòng đặt sân trong court_bookings bằng FOR UPDATE để kiểm tra trạng thái và ngăn chặn cập nhật đồng thời.
    const booking = await one<Parameters<typeof settleHeldBooking>[1]>(
      sql,
      `select ${HELD_COLS} from court_bookings where id = $1 for update`,
      [pay.ref_id],
    );
    if (!booking) throw err.notFound("That booking no longer exists.");
    // Bước 2: Lấy thông tin mã sân thể thao để ghi nhận vào nội dung hóa đơn thanh toán.
    const court = await one<{ court_code: string }>(
      sql,
      `select court_code from courts where id = $1`,
      [booking.court_id],
    );
    // Reuses the same settle path as cash at the desk — occupancy confirmed,
    // invoice issued, member notified — against the row that already exists.
    // Bước 3: Lấy thông tin người mua và gọi settleHeldBooking với phương thức gateway để hoàn tất đặt sân và xuất hóa đơn.
    const buyer = await bookingBuyer(sql, booking.id);
    await settleHeldBooking(sql, booking, court!, {
      method: "gateway",
      payAmount: pay.amount_vnd,
      quotaHours: 0,
      buyerName: buyer.name,
      buyerPhone: buyer.phone,
      actorId: pay.user_id ?? "",
      existingPaymentId: pay.id,
    });
    return { posted: true };
  }

/**
 * Làm gì: Quyết toán đơn mua gói hội viên sau khi thanh toán trực tuyến thành công: tiêu mã giảm giá, kích hoạt gói tập, xuất hóa đơn VAT và gửi biên lai.
 * Được gọi ở: src/server/controllers/handlers/online.ts trong hàm settleOnline.
 * @param sql Kết nối cơ sở dữ liệu trong transaction.
 * @param pay Bản ghi thanh toán trực tuyến (PendingPayment).
 * @returns Đối tượng { posted: true } xác nhận gói hội viên đã được kích hoạt thành công.
 * @throws 404 NOT_FOUND nếu đơn đăng ký gói hội viên không tồn tại.
 */
async function settleOnlineSubscription(sql: Sql, pay: PendingPayment): Promise<{ posted: boolean }> {
    // Bước 1: Lấy thông tin đơn đăng ký gói hội viên (subscriptions) và thông tin cấu hình gói (membership_plans).
    const sub = await one<{
      user_id: string;
      plan_id: string;
      promo_id: string | null;
      promo_discount_vnd: number;
    }>(sql, `select user_id, plan_id, promo_id, promo_discount_vnd from subscriptions where id = $1`, [
      pay.ref_id,
    ]);
    if (!sub) throw err.notFound("That plan order no longer exists.");
    const plan = await one<{ name: string; duration_days: number; price_vnd: number }>(
      sql,
      `select name, duration_days, price_vnd from membership_plans where id = $1`,
      [sub.plan_id],
    );
    // Bước 2: Đánh dấu tiêu dùng mã khuyến mãi (promo code) nếu đơn hàng có áp dụng giảm giá.
    if (sub.promo_id && sub.promo_discount_vnd > 0) {
      await redeemPromo(sql, {
        promoId: sub.promo_id,
        userId: sub.user_id,
        paymentId: pay.id,
        discountVnd: sub.promo_discount_vnd,
      });
    }
    // Bước 3: Kích hoạt gói hội viên theo quy tắc BR-19 và BR-20 (cộng giờ chơi, lượt vào và thiết lập ngày hiệu lực).
    // The same activation the front desk uses: the plan starts the day it is paid,
    // and its hours and sessions are credited (BR-19, BR-20).
    await activateSubscription(sql, pay.ref_id);
    // Bước 4: Lấy thông tin khách hàng và xuất hóa đơn điện tử (invoices) cho gói hội viên.
    const buyer = await one<{ full_name: string }>(sql, `select full_name from users where id = $1`, [
      sub.user_id,
    ]);
    const settings = await getSettings(sql);
    const invoiceId = await issueInvoice(sql, {
      paymentId: pay.id,
      buyerName: buyer?.full_name ?? "Khách hàng",
      amountVnd: pay.amount_vnd,
      vatRate: Number(settings.vat_rate ?? 0),
      description: plan ? `Gói hội viên — ${plan.name}` : "Gói hội viên",
      unit: "gói",
      settings,
    });
    // Bước 5: Đưa biên lai thanh toán vào hàng đợi thông báo (enqueueReceipt) gửi tới người dùng.
    await enqueueReceipt(sql, sub.user_id, {
      payment_id: pay.id,
      invoice_id: invoiceId,
      amount_vnd: pay.amount_vnd,
      method: "gateway",
    });
    return { posted: true };
  }

/**
 * Làm gì: Quyết toán đăng ký lớp học khi thanh toán trực tuyến thành công: cập nhật chỗ học (enrollment), lập hóa đơn và gửi biên lai cho học viên.
 * Được gọi ở: src/server/controllers/handlers/online.ts trong hàm settleOnline.
 * @param sql Kết nối cơ sở dữ liệu trong transaction.
 * @param pay Bản ghi thanh toán trực tuyến (PendingPayment).
 * @param wasReleased Cờ đánh dấu chỗ học đã từng bị giải phóng trước khi tiền về (để xử lý giữ tiền và cảnh báo lễ tân).
 * @returns Đối tượng { posted: true } xác nhận việc ghi nhận thanh toán chỗ học hoàn tất.
 * @throws Lỗi nếu không tìm thấy bản ghi enrollment tương ứng khi xử lý settleEnrollment.
 */
async function settleOnlineEnrollment(sql: Sql, pay: PendingPayment, wasReleased: boolean): Promise<{ posted: boolean }> {
    // Bước 1: Quyết toán chỗ học qua settleEnrollment (chuyển sang confirmed hoặc xử lý các ngoại lệ thanh toán trễ/đã giải phóng).
    // The money is in whatever happens to the seat. An outcome that buys no seat
    // (late, released, class cancelled, paid twice) is flagged to the desk by
    // settleEnrollment, so the payment stays posted and invoiced.
    await settleEnrollment(sql, pay.ref_id, { paymentId: pay.id, released: wasReleased });
    // Bước 2: Lấy thông tin học viên, cấu hình thuế và mô tả chi tiết các khoản học phí của lớp học.
    const buyer = await one<{ full_name: string; phone: string | null }>(
      sql,
      `select full_name, phone from users where id = $1`,
      [pay.user_id],
    );
    const settings = await getSettings(sql);
    const item = await describePayment(sql, "enrollment", pay.ref_id);
    // Bước 3: Xuất hóa đơn chi tiết từng dòng (lines) cho khoản học phí vừa thanh toán.
    const invoiceId = await issueInvoice(sql, {
      paymentId: pay.id,
      buyerName: buyer?.full_name ?? "Khách hàng",
      buyerPhone: buyer?.phone ?? undefined,
      amountVnd: pay.amount_vnd,
      vatRate: Number(settings.vat_rate ?? 0),
      description: item.description,
      unit: item.unit,
      lines: await enrollmentInvoiceLines(sql, pay.ref_id, pay.amount_vnd, item),
      settings,
    });
    // Bước 4: Đưa biên lai điện tử vào hàng đợi để gửi thông báo cho học viên.
    if (pay.user_id) {
      await enqueueReceipt(sql, pay.user_id, {
        payment_id: pay.id,
        invoice_id: invoiceId,
        amount_vnd: pay.amount_vnd,
        method: "gateway",
      });
    }
    return { posted: true };
  }
