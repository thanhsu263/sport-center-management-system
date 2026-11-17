/**
 * Promotions (SRS v1.4.1 FR-PAY-03, BR-40 / BR-41 / BR-42 / BR-43).
 *
 * A code is *quoted* when an order is priced (a court hold, a plan order): the
 * discount is written onto the order so the price the member sees is the price
 * they pay. It is only *redeemed* — counted against the code's limits — when the
 * money actually posts, so a hold that expires or a payment that fails never
 * spends a use (BR-41).
 */
import type { Sql } from "@/server/data/db";
import { err } from "../controllers/errors";
import { MIN_PAYABLE_VND, computeDiscount, normalizeCode } from "./rules";
import { one } from "../controllers/tx";

export type PromoScope = "plan" | "court" | "class";

export type PromoRow = {
  id: string;
  code: string;
  name: string;
  kind: "percent" | "amount";
  value: number;
  max_discount_vnd: number | null;
  min_order_vnd: number;
  starts_at: string;
  ends_at: string | null;
  max_uses: number | null;
  max_per_member: number;
  applies_to: string[];
  sport: string | null;
  plan_id: string | null;
  stackable: boolean;
  status: "active" | "paused";
};

export { MIN_PAYABLE_VND, computeDiscount, normalizeCode };

export type PromoQuote = {
  promo_id: string;
  code: string;
  name: string;
  discount_vnd: number;
  final_vnd: number;
};

export type QuoteInput = {
  code: string;
  userId: string | null;
  scope: PromoScope;
  sport?: string | null;
  planId?: string | null;
  orderVnd: number;
  /** A percentage the plan already takes off this order (court discount). */
  planDiscountPct?: number;
  /** The price before the plan's percentage, so a code that cannot stack can be compared with it (BR-42). */
  listVnd?: number;
  now?: Date;
};

/**
 * Làm gì: Đếm tổng số lượt đã áp dụng mã khuyến mãi trên toàn hệ thống và số lượt của riêng người dùng này từ bảng promotion_redemptions.
 * Được gọi ở: Nội bộ src/server/services/promos.ts (trong các hàm quotePromo và redeemPromo).
 * @param sql Kết nối cơ sở dữ liệu Sql để thực thi truy vấn.
 * @param promoId Mã UUID của khuyến mãi cần kiểm tra số lượt dùng.
 * @param userId Mã UUID của người dùng cần kiểm tra hạn mức cá nhân (hoặc null nếu là khách vãng lai).
 * @returns Đối tượng chứa total (tổng số lượt đã dùng thành công) và mine (số lượt của riêng người dùng này).
 * @throws Lỗi kết nối cơ sở dữ liệu nếu truy vấn SQL thất bại.
 */
async function usage(sql: Sql, promoId: string, userId: string | null) {
  // Bước 1: Truy vấn bảng promotion_redemptions đếm số lượt đổi mã có status = 'applied' (chỉ tính giao dịch thành công).
  // Dùng conditional aggregation (filter where user_id = $2) để lấy cả tổng lượt dùng và lượt dùng của user trong 1 query duy nhất.
  const row = await one<{ total: number; mine: number }>(
    sql,
    `select count(*)::int as total,
            count(*) filter (where user_id = $2)::int as mine
       from promotion_redemptions where promo_id = $1 and status = 'applied'`,
    [promoId, userId],
  );
  // Bước 2: Trả về kết quả đếm; mặc định bằng 0 nếu chưa có lượt sử dụng nào.
  return { total: row?.total ?? 0, mine: row?.mine ?? 0 };
}

/** Check a code against an order and return the discount, or say precisely why not (BR-40). */
/**
 * Làm gì: Kiểm tra tính hợp lệ của mã khuyến mãi đối với một đơn hàng và tính toán số tiền chiết khấu thực tế (BR-40, BR-42).
 * Được gọi ở:
 * - src/server/controllers/handlers/bookings.ts (hàm bookingsHold)
 * - src/server/controllers/handlers/classes.ts (các hàm classesEnroll, sessionReschedule)
 * - src/server/controllers/handlers/desk.ts (hàm deskBookingPromoApply)
 * - src/server/controllers/handlers/plans.ts (hàm plansPurchase)
 * - src/server/controllers/handlers/promos.ts (hàm promosQuote)
 * - test runner (node --test): src/server/services/business-gaps.test.ts
 * @param sql Kết nối cơ sở dữ liệu Sql để truy vấn thông tin mã khuyến mãi.
 * @param input Thông tin đơn hàng và mã cần kiểm tra (gồm code, userId, scope, orderVnd, sport, planId, planDiscountPct, listVnd, now).
 * @returns Đối tượng PromoQuote chứa promo_id, code, name, discount_vnd (tiền giảm) và final_vnd (tiền sau giảm).
 * @throws ApiError lỗi 400 (FIELD) nếu mã rỗng; lỗi 422 BR-40 nếu mã không hợp lệ/hết hạn/không khớp điều kiện; lỗi 422 BR-42 nếu vi phạm quy tắc cộng dồn chiết khấu.
 */
export async function quotePromo(sql: Sql, input: QuoteInput): Promise<PromoQuote> {
  // Bước 1: Chuẩn hóa mã khuyến mãi (viết hoa, loại bỏ khoảng trắng thừa); báo lỗi nếu người dùng không nhập mã.
  const code = normalizeCode(input.code);
  if (!code) throw err.field("promo_code", "Enter a promo code.");
  // Bước 2: Truy vấn thông tin cấu hình mã khuyến mãi từ bảng promotions theo mã code.
  const promo = await one<PromoRow>(
    sql,
    `select id, code, name, kind, value, max_discount_vnd, min_order_vnd, starts_at, ends_at, max_uses,
            max_per_member, applies_to, sport::text as sport, plan_id, stackable, status
       from promotions where upper(code) = $1`,
    [code],
  );
  // Hàm trợ giúp tạo lỗi nghiệp vụ BR-40 chuẩn gắn kèm trường dữ liệu promo_code.
  const no = (message: string) => err.br("BR-40", message, { field: "promo_code", promo_code: code });
  // Bước 3: Xác thực các điều kiện hiệu lực cơ bản của mã theo BR-40.
  // Kiểm tra mã có tồn tại và đang ở trạng thái active (từ chối mã không tìm thấy hoặc đang bị paused).
  if (!promo || promo.status !== "active") throw no("That code is not valid.");
  // Mã đổi từ điểm thưởng loyalty là mã cá nhân; chỉ người dùng sở hữu mới có quyền áp dụng.
  const owner = await one<{ user_id: string }>(sql,
    `select user_id from loyalty_adjustments where promo_id = $1 and reason = 'redeem'`, [promo.id]);
  if (owner && owner.user_id !== input.userId) throw no("That code is not valid.");
  // Kiểm tra thời hạn hiệu lực của mã: chưa đến ngày bắt đầu (starts_at) hoặc đã quá hạn kết thúc (ends_at).
  const now = input.now ?? new Date();
  if (new Date(promo.starts_at) > now) throw no("That code is not active yet.");
  if (promo.ends_at && new Date(promo.ends_at) <= now) throw no("That code has expired.");
  // Kiểm tra phạm vi áp dụng (applies_to): mã phải cho phép loại đơn hàng này (plan, court, hoặc class).
  if (!promo.applies_to.includes(input.scope)) {
    throw no(`That code does not apply to ${input.scope === "plan" ? "plans" : input.scope === "class" ? "classes" : "courts"}.`);
  }
  // Kiểm tra môn thể thao áp dụng: nếu mã giới hạn môn cụ thể (khác 'all') thì đơn phải cùng môn thể thao.
  if (promo.sport && promo.sport !== "all" && input.sport && promo.sport !== input.sport && input.sport !== "all") {
    throw no(`That code is only for ${promo.sport}.`);
  }
  // Kiểm tra mã giảm giá dành riêng cho một gói hội viên cụ thể (plan_id).
  if (promo.plan_id && promo.plan_id !== input.planId) throw no("That code is for a different plan.");
  // Kiểm tra giá trị đơn hàng tối thiểu (min_order_vnd) theo yêu cầu của mã khuyến mãi.
  if (input.orderVnd < promo.min_order_vnd) {
    throw no(`That code needs an order of at least ${promo.min_order_vnd.toLocaleString("en-US")}đ.`);
  }
  // A code that does not stack never adds to the plan's percentage: the member gets
  // whichever is better, not both (BR-42).
  // Bước 4: Kiểm tra quy tắc cộng dồn ưu đãi (stacking) theo BR-42.
  // Nếu đơn đã có giảm giá từ gói hội viên (planPct > 0) mà mã không cho phép cộng dồn (!promo.stackable),
  // bắt buộc phải có giá gốc niêm yết (listVnd) để đối chiếu xem ưu đãi nào có lợi hơn cho khách hàng.
  const planPct = input.planDiscountPct ?? 0;
  const stackBlocked = planPct > 0 && !promo.stackable;
  if (stackBlocked && input.listVnd == null) {
    throw err.br("BR-42", "That code cannot be combined with your plan's court discount.", {
      field: "promo_code",
      promo_code: code,
    });
  }
  // Bước 5: Kiểm tra số lượt sử dụng tối đa của mã (max_uses) và hạn mức theo từng hội viên (max_per_member).
  const used = await usage(sql, promo.id, input.userId);
  if (promo.max_uses != null && used.total >= promo.max_uses) throw no("That code has been fully used.");
  if (input.userId && used.mine >= promo.max_per_member) throw no("You have already used that code.");
  // Bước 6: Tính toán số tiền chiết khấu thực tế (discount).
  let discount: number;
  // Trường hợp không cộng dồn: tính mức giảm của mã trên giá gốc (list) và so với mức giảm từ gói hội viên (viaPlan);
  // nếu mã không tốt hơn ưu đãi gói thì từ chối áp dụng (BR-42), nếu tốt hơn thì bù thêm phần chênh lệch.
  if (stackBlocked) {
    const list = input.listVnd as number;
    const viaCode = computeDiscount(promo, list);
    const viaPlan = list - input.orderVnd;
    if (viaCode <= viaPlan) {
      throw err.br("BR-42", "Your plan's court discount is already better than that code, so it was not applied.", {
        field: "promo_code",
        promo_code: code,
      });
    }
    discount = viaCode - viaPlan;
  } else {
    // Trường hợp được cộng dồn hoặc đơn không có ưu đãi gói: tính chiết khấu trực tiếp trên giá trị đơn hàng hiện tại.
    discount = computeDiscount(promo, input.orderVnd);
  }
  // Từ chối mã nếu mức giảm tính ra bằng 0 (không mang lại giá trị chiết khấu cho đơn hàng).
  if (discount <= 0) throw no("That code gives no discount on this order.");
  // Bước 7: Trả về đối tượng báo giá chiết khấu gồm mã promo, số tiền giảm và số tiền thanh toán cuối cùng.
  return {
    promo_id: promo.id,
    code: promo.code,
    name: promo.name,
    discount_vnd: discount,
    final_vnd: input.orderVnd - discount,
  };
}

/**
 * Count a use of a code against the payment that carried it. Atomic with the
 * payment (same transaction); the promotion row is locked so two payments cannot
 * both take the last use (BR-41).
 */
/**
 * Làm gì: Ghi nhận một lượt sử dụng mã khuyến mãi vào thanh toán, khóa hàng khuyến mãi để chống tranh chấp lượt dùng cuối cùng (BR-41).
 * Được gọi ở:
 * - src/server/controllers/handlers/classes.ts (hàm enrollPaid)
 * - src/server/controllers/handlers/desk.ts (hàm deskPaymentsCreate)
 * - src/server/controllers/handlers/online.ts (hàm confirmOnlinePayment)
 * - src/server/services/promos.ts (hàm redeemForBooking)
 * - test runner (node --test): src/server/services/business-gaps.test.ts
 * @param sql Kết nối cơ sở dữ liệu Sql trong cùng transaction với thanh toán.
 * @param args Tham số gồm promoId (ID mã), userId (ID người dùng), paymentId (ID khoản thanh toán) và discountVnd (số tiền chiết khấu).
 * @returns Không trả về giá trị (Promise<void>).
 * @throws ApiError lỗi 422 BR-40 nếu mã voucher cá nhân không hợp lệ/hết hạn; lỗi 422 BR-41 nếu mã đã hết lượt dùng hoặc user vượt quá hạn mức.
 */
export async function redeemPromo(
  sql: Sql,
  args: { promoId: string; userId: string | null; paymentId: string; discountVnd: number },
): Promise<void> {
  // Bước 1: Kiểm tra tính hợp lệ và quyền sở hữu nếu đây là voucher đổi từ điểm loyalty.
  // Khóa hàng người dùng trong bảng users (FOR UPDATE) để ngăn chặn hành vi sử dụng đồng thời cùng một mã voucher.
  const owner = await one<{ user_id: string }>(sql,
    `select user_id from loyalty_adjustments where promo_id = $1 and reason = 'redeem'`, [args.promoId]);
  if (owner) {
    if (owner.user_id !== args.userId) throw err.br("BR-40", "That code is not valid.", { field: "promo_code" });
    await sql.query(`select id from users where id = $1 for update`, [owner.user_id]);
  }
  // Bước 2: Khóa hàng khuyến mãi trong bảng promotions (FOR UPDATE) để đảm bảo hai giao dịch diễn ra đồng thời
  // không thể cùng chiếm lượt sử dụng cuối cùng (chống race condition theo BR-41).
  const promo = await one<Pick<PromoRow, "id" | "code" | "max_uses" | "max_per_member">>(
    sql,
    `select id, code, max_uses, max_per_member from promotions where id = $1 for update`,
    [args.promoId],
  );
  if (!promo) throw err.br("BR-41", "That promo code no longer exists.");
  // Tính lũy tiến (idempotency): nếu thanh toán này đã ghi nhận lượt đổi mã trước đó thì không trừ lần 2.
  if (await one(sql, `select 1 as ok from promotion_redemptions where payment_id = $1`, [args.paymentId])) return;
  // Tái kiểm tra voucher đổi điểm vẫn còn active và chưa quá hạn tại thời điểm ghi nhận tiền thực tế.
  if (owner && !await one(sql,
    `select id from promotions where id = $1 and status = 'active'
      and starts_at <= now() and (ends_at is null or ends_at > now())`, [promo.id])) {
    throw err.br("BR-40", "That code is not valid.", { field: "promo_code" });
  }
  // Bước 3: Đếm lại số lượt đã dùng trong transaction hiện tại để kiểm tra giới hạn toàn hệ thống và theo hội viên.
  const used = await usage(sql, promo.id, args.userId);
  if (promo.max_uses != null && used.total >= promo.max_uses) {
    throw err.br("BR-41", `Code ${promo.code} was just fully used — price the order again.`, { field: "promo_code" });
  }
  if (args.userId && used.mine >= promo.max_per_member) {
    throw err.br("BR-41", `You have already used ${promo.code}.`, { field: "promo_code" });
  }
  // Bước 4: Chèn bản ghi đổi mã vào bảng promotion_redemptions (mặc định status = 'applied').
  await sql.query(
    `insert into promotion_redemptions (promo_id, user_id, payment_id, discount_vnd) values ($1,$2,$3,$4)`,
    [promo.id, args.userId, args.paymentId, args.discountVnd],
  );
  // Bước 5: Cập nhật promo_id và discount_vnd vào bản ghi payments tương ứng để ghi nhận lịch sử giao dịch.
  await sql.query(`update payments set promo_id = $2, discount_vnd = $3 where id = $1`, [
    args.paymentId,
    promo.id,
    args.discountVnd,
  ]);
}

/** A full refund restores ordinary codes; spent loyalty rewards stay spent (G1). */
/**
 * Làm gì: Khôi phục lượt sử dụng mã khuyến mãi về trạng thái 'restored' khi đơn hàng được hoàn tiền đầy đủ (quy tắc G1).
 * Được gọi ở: Nội bộ src/server/services/promos.ts (hàm tiện ích hoàn trả lượt dùng cho một thanh toán cụ thể).
 * @param sql Kết nối cơ sở dữ liệu Sql để cập nhật dữ liệu.
 * @param paymentId Mã UUID của khoản thanh toán được hoàn tiền.
 * @returns boolean Trả về true nếu có bản ghi đổi mã được khôi phục, false nếu không tìm thấy hoặc là mã đổi điểm.
 * @throws Lỗi kết nối cơ sở dữ liệu nếu truy vấn SQL thất bại.
 */
export async function restoreRedemption(sql: Sql, paymentId: string): Promise<boolean> {
  // Bước 1: Cập nhật status = 'restored' và ghi nhận thời điểm restored_at cho lượt đổi mã ứng với khoản thanh toán này.
  // Quy tắc G1: Loại trừ mã sinh ra từ đổi điểm loyalty (voucher điểm thưởng đã tiêu sẽ không được hoàn lại).
  const rows = await sql.query<{ id: string }>(
    `update promotion_redemptions set status = 'restored', restored_at = now()
      where payment_id = $1 and status = 'applied'
        and not exists (select 1 from loyalty_adjustments la
                         where la.promo_id = promotion_redemptions.promo_id and la.reason = 'redeem')
      returning id`,
    [paymentId],
  );
  // Bước 2: Trả về true nếu có ít nhất một lượt dùng được hoàn trả thành công, ngược lại false.
  return rows.length > 0;
}

/**
 * Redeem the code a booking was priced with, once, when its money posts.
 * A booking is paid once, so an existing applied redemption means this is a
 * second call for the same order and nothing is counted twice.
 */
/**
 * Làm gì: Đổi mã khuyến mãi đã áp dụng cho ca đặt sân một lần duy nhất khi tiền thanh toán được ghi nhận (BR-41).
 * Được gọi ở:
 * - src/server/controllers/handlers/bookings.ts (hàm settleHeldBooking)
 * - src/server/controllers/handlers/desk.ts (hàm deskPaymentsCreate)
 * @param sql Kết nối cơ sở dữ liệu Sql trong cùng transaction thanh toán.
 * @param bookingId Mã UUID của ca đặt sân trong bảng court_bookings.
 * @param userId Mã UUID của hội viên đặt sân (hoặc null nếu là khách vãng lai).
 * @param paymentId Mã UUID của khoản thanh toán vừa được tạo thành công.
 * @returns Số tiền giảm giá VNĐ đã đổi cho ca đặt sân (trả về 0 nếu ca không có mã hoặc đã được đổi).
 * @throws ApiError lỗi BR-41 nếu mã khuyến mãi đã hết lượt sử dụng tại thời điểm thanh toán.
 */
export async function redeemForBooking(
  sql: Sql,
  bookingId: string,
  userId: string | null,
  paymentId: string,
): Promise<number> {
  // Bước 1: Truy vấn thông tin promo_id và số tiền giảm giá promo_discount_vnd từ bảng court_bookings.
  const b = await one<{ promo_id: string | null; promo_discount_vnd: number }>(
    sql,
    `select promo_id, promo_discount_vnd from court_bookings where id = $1`,
    [bookingId],
  );
  // Bỏ qua nếu đơn đặt sân không dùng mã khuyến mãi hoặc số tiền giảm giá bằng 0.
  if (!b?.promo_id || b.promo_discount_vnd <= 0) return 0;
  // Bước 2: Kiểm tra tính lũy tiến; nếu đơn đặt sân này đã có bản ghi đổi mã thành công thì không trừ lần 2.
  const done = await one(
    sql,
    `select 1 as ok from promotion_redemptions r join payments p on p.id = r.payment_id
      where p.ref_type = 'booking' and p.ref_id = $1 and r.status = 'applied'`,
    [bookingId],
  );
  if (done) return 0;
  // Bước 3: Gọi redeemPromo để khóa hàng khuyến mãi, kiểm tra hạn mức và ghi nhận lượt dùng cùng paymentId.
  await redeemPromo(sql, { promoId: b.promo_id, userId, paymentId, discountVnd: b.promo_discount_vnd });
  // Bước 4: Trả về số tiền đã được giảm giá theo mã khuyến mãi cho ca đặt sân này.
  return b.promo_discount_vnd;
}

/**
 * After a refund posts: if nothing of the order is left with the centre, the
 * code's use goes back to the member (BR-41). A partial refund keeps the use.
 */
/**
 * Làm gì: Khôi phục lượt sử dụng mã khuyến mãi cho hội viên nếu đơn hàng được hoàn tiền 100% (BR-41, G1).
 * Được gọi ở:
 * - src/server/controllers/handlers/bookings.ts (hàm bookingsCancel khi hủy đơn giữ sân)
 * - src/server/controllers/handlers/desk.ts (hàm deskRefundApprove khi duyệt hoàn tiền)
 * - src/server/controllers/handlers/extras.ts (hàm seriesCancelSession khi hủy buổi trong chuỗi)
 * @param sql Kết nối cơ sở dữ liệu Sql để thực thi cập nhật.
 * @param refType Loại tham chiếu của đơn hàng (ví dụ: "booking", "plan", "class").
 * @param refId Mã UUID của đối tượng tham chiếu (ví dụ: bookingId, subscriptionId).
 * @returns boolean Trả về true nếu có lượt dùng được hoàn lại, false nếu đơn chỉ hoàn một phần hoặc không có mã.
 * @throws Lỗi kết nối cơ sở dữ liệu nếu truy vấn SQL thất bại.
 */
export async function restoreIfFullyRefunded(sql: Sql, refType: string, refId: string): Promise<boolean> {
  // Bước 1: Tính số tiền thực thu ròng (net = tiền thanh toán dương + tiền hoàn âm) của các khoản đã hạch toán (status = 'posted').
  const net = await one<{ net: number }>(
    sql,
    `select coalesce(sum(amount_vnd) filter (where status = 'posted'), 0)::int as net
       from payments where ref_type = $1 and ref_id = $2`,
    [refType, refId],
  );
  // Quy tắc BR-41: Chỉ hoàn lại lượt dùng khi trung tâm không giữ lại đồng nào (net <= 0); hoàn tiền một phần vẫn tính đã dùng mã.
  if (!net || net.net > 0) return false;
  // Bước 2: Cập nhật status = 'restored' cho các bản ghi đổi mã ứng với đơn hàng này.
  // Quy tắc G1: Không khôi phục các mã sinh ra từ đổi điểm loyalty (voucher điểm thưởng đã tiêu vẫn tính là đã tiêu).
  const rows = await sql.query<{ id: string }>(
    `update promotion_redemptions r set status = 'restored', restored_at = now()
       from payments p
      where p.id = r.payment_id and p.ref_type = $1 and p.ref_id = $2 and r.status = 'applied'
        and not exists (select 1 from loyalty_adjustments la where la.promo_id = r.promo_id and la.reason = 'redeem')
      returning r.id`,
    [refType, refId],
  );
  // Bước 3: Trả về true nếu có ít nhất một lượt dùng được khôi phục thành công, ngược lại false.
  return rows.length > 0;
}
