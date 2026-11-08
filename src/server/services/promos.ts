/**
 * Promotions (SRS v1.4.1 FR-PAY-03, BR-40 / BR-41 / BR-42 / BR-43).
 *
 * A code is *quoted* when an order is priced (a court hold, a plan order): the
 * discount is written onto the order so the price the member sees is the price
 * they pay. It is only *redeemed* — counted against the code's limits — when the
 * money actually posts, so a hold that expires or a payment that fails never
 * spends a use (BR-41).
 */
import type { Sql } from "@/lib/db";
import { err } from "./errors";
import { MIN_PAYABLE_VND, computeDiscount, normalizeCode } from "./rules";
import { one } from "./tx";

export type PromoScope = "plan" | "court";

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

async function usage(sql: Sql, promoId: string, userId: string | null) {
  const row = await one<{ total: number; mine: number }>(
    sql,
    `select count(*)::int as total,
            count(*) filter (where user_id = $2)::int as mine
       from promotion_redemptions where promo_id = $1 and status = 'applied'`,
    [promoId, userId],
  );
  return { total: row?.total ?? 0, mine: row?.mine ?? 0 };
}

/** Check a code against an order and return the discount, or say precisely why not (BR-40). */
export async function quotePromo(sql: Sql, input: QuoteInput): Promise<PromoQuote> {
  const code = normalizeCode(input.code);
  if (!code) throw err.field("promo_code", "Enter a promo code.");
  const promo = await one<PromoRow>(
    sql,
    `select id, code, name, kind, value, max_discount_vnd, min_order_vnd, starts_at, ends_at, max_uses,
            max_per_member, applies_to, sport::text as sport, plan_id, stackable, status
       from promotions where upper(code) = $1`,
    [code],
  );
  const no = (message: string) => err.br("BR-40", message, { field: "promo_code", promo_code: code });
  if (!promo || promo.status !== "active") throw no("That code is not valid.");
  const now = input.now ?? new Date();
  if (new Date(promo.starts_at) > now) throw no("That code is not active yet.");
  if (promo.ends_at && new Date(promo.ends_at) <= now) throw no("That code has expired.");
  if (!promo.applies_to.includes(input.scope)) {
    throw no(`That code does not apply to ${input.scope === "plan" ? "plans" : "courts"}.`);
  }
  if (promo.sport && promo.sport !== "all" && input.sport && promo.sport !== input.sport && input.sport !== "all") {
    throw no(`That code is only for ${promo.sport}.`);
  }
  if (promo.plan_id && promo.plan_id !== input.planId) throw no("That code is for a different plan.");
  if (input.orderVnd < promo.min_order_vnd) {
    throw no(`That code needs an order of at least ${promo.min_order_vnd.toLocaleString("en-US")}đ.`);
  }
  // A code that does not stack never adds to the plan's percentage: the member gets
  // whichever is better, not both (BR-42).
  const planPct = input.planDiscountPct ?? 0;
  const stackBlocked = planPct > 0 && !promo.stackable;
  if (stackBlocked && input.listVnd == null) {
    throw err.br("BR-42", "That code cannot be combined with your plan's court discount.", {
      field: "promo_code",
      promo_code: code,
    });
  }
  const used = await usage(sql, promo.id, input.userId);
  if (promo.max_uses != null && used.total >= promo.max_uses) throw no("That code has been fully used.");
  if (input.userId && used.mine >= promo.max_per_member) throw no("You have already used that code.");
  let discount: number;
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
    discount = computeDiscount(promo, input.orderVnd);
  }
  if (discount <= 0) throw no("That code gives no discount on this order.");
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
export async function redeemPromo(
  sql: Sql,
  args: { promoId: string; userId: string | null; paymentId: string; discountVnd: number },
): Promise<void> {
  const promo = await one<Pick<PromoRow, "id" | "code" | "max_uses" | "max_per_member">>(
    sql,
    `select id, code, max_uses, max_per_member from promotions where id = $1 for update`,
    [args.promoId],
  );
  if (!promo) throw err.br("BR-41", "That promo code no longer exists.");
  if (await one(sql, `select 1 as ok from promotion_redemptions where payment_id = $1`, [args.paymentId])) return;
  const used = await usage(sql, promo.id, args.userId);
  if (promo.max_uses != null && used.total >= promo.max_uses) {
    throw err.br("BR-41", `Code ${promo.code} was just fully used — price the order again.`, { field: "promo_code" });
  }
  if (args.userId && used.mine >= promo.max_per_member) {
    throw err.br("BR-41", `You have already used ${promo.code}.`, { field: "promo_code" });
  }
  await sql.query(
    `insert into promotion_redemptions (promo_id, user_id, payment_id, discount_vnd) values ($1,$2,$3,$4)`,
    [promo.id, args.userId, args.paymentId, args.discountVnd],
  );
  await sql.query(`update payments set promo_id = $2, discount_vnd = $3 where id = $1`, [
    args.paymentId,
    promo.id,
    args.discountVnd,
  ]);
}

/** A full refund gives the use back; a part refund or a no-show does not (BR-41). */
export async function restoreRedemption(sql: Sql, paymentId: string): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `update promotion_redemptions set status = 'restored', restored_at = now()
      where payment_id = $1 and status = 'applied' returning id`,
    [paymentId],
  );
  return rows.length > 0;
}

/**
 * Redeem the code a booking was priced with, once, when its money posts.
 * A booking is paid once, so an existing applied redemption means this is a
 * second call for the same order and nothing is counted twice.
 */
export async function redeemForBooking(
  sql: Sql,
  bookingId: string,
  userId: string | null,
  paymentId: string,
): Promise<number> {
  const b = await one<{ promo_id: string | null; promo_discount_vnd: number }>(
    sql,
    `select promo_id, promo_discount_vnd from court_bookings where id = $1`,
    [bookingId],
  );
  if (!b?.promo_id || b.promo_discount_vnd <= 0) return 0;
  const done = await one(
    sql,
    `select 1 as ok from promotion_redemptions r join payments p on p.id = r.payment_id
      where p.ref_type = 'booking' and p.ref_id = $1 and r.status = 'applied'`,
    [bookingId],
  );
  if (done) return 0;
  await redeemPromo(sql, { promoId: b.promo_id, userId, paymentId, discountVnd: b.promo_discount_vnd });
  return b.promo_discount_vnd;
}

/**
 * After a refund posts: if nothing of the order is left with the centre, the
 * code's use goes back to the member (BR-41). A partial refund keeps the use.
 */
export async function restoreIfFullyRefunded(sql: Sql, refType: string, refId: string): Promise<boolean> {
  const net = await one<{ net: number }>(
    sql,
    `select coalesce(sum(amount_vnd) filter (where status = 'posted'), 0)::int as net
       from payments where ref_type = $1 and ref_id = $2`,
    [refType, refId],
  );
  if (!net || net.net > 0) return false;
  const rows = await sql.query<{ id: string }>(
    `update promotion_redemptions r set status = 'restored', restored_at = now()
       from payments p
      where p.id = r.payment_id and p.ref_type = $1 and p.ref_id = $2 and r.status = 'applied'
      returning r.id`,
    [refType, refId],
  );
  return rows.length > 0;
}
