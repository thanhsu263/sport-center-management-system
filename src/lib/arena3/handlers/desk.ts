import type { Sql } from "@/lib/db";
import { err } from "../errors";
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
import { quotePromo, redeemForBooking, redeemPromo, restoreIfFullyRefunded, type PromoQuote } from "../promos";
import { methodLabelVi } from "../labels";
import { renderInvoicePdf } from "../pdf";
import { requireRole, type PublicUser } from "../session";
import { addDays, ictDateString } from "../time";
import { one } from "../tx";
import { pageParams, parseInteger } from "../validate";

export async function shiftOpen(sql: Sql, user: PublicUser) {
  requireRole(user, ["receptionist"]);
  const existing = await one(
    sql,
    `select id from cashier_shifts where receptionist_id = $1 and closed_at is null`,
    [user.id],
  );
  if (existing) throw err.conflictState("A till shift is already open.");
  const row = await one(
    sql,
    `insert into cashier_shifts (receptionist_id) values ($1) returning *`,
    [user.id],
  );
  return { status: 201, body: { shift: row } };
}

export async function shiftCurrent(sql: Sql, user: PublicUser, request: Request) {
  requireRole(user, ["receptionist", "manager"]);
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
  const totals = await one<{ cash: number; all: number }>(
    sql,
    `select coalesce(sum(amount_vnd) filter (where method = 'cash' and status = 'posted'),0)::int as cash,
            coalesce(sum(amount_vnd) filter (where status = 'posted' and method <> 'quota'),0)::int as all
       from payments where shift_id = $1`,
    [(row as { id: string }).id],
  );
  return { status: 200, body: { shift: row, totals } };
}

export async function shiftClose(sql: Sql, id: string, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist"]);
  const b = await readJson(request);
  const raw = b.cash_declared_vnd;
  if (raw === null || raw === undefined || raw === "" || Number.isNaN(Number(raw))) {
    throw err.validation("cash_declared_vnd is required.");
  }
  const cash = parseInteger("cash_declared_vnd", "Cash declared", raw, 0, 2_000_000_000);
  const sh = await one<{ id: string; receptionist_id: string; closed_at: string | null }>(
    sql,
    `select * from cashier_shifts where id = $1 for update`,
    [id],
  );
  if (!sh) throw err.notFound();
  if (sh.receptionist_id !== user.id) throw err.forbidden();
  if (sh.closed_at) throw err.conflictState("That shift is already closed.");
  await sql.query(
    `update cashier_shifts set closed_at = now(), cash_declared_vnd = $2 where id = $1`,
    [id, cash],
  );
  const actual = await one<{ cash: number }>(
    sql,
    `select coalesce(sum(amount_vnd) filter (where method='cash' and status='posted'),0)::int as cash
       from payments where shift_id = $1`,
    [id],
  );
  await audit(sql, user.id, "close_shift", "shift", id, null, {
    declared: cash,
    actual: actual?.cash,
  });
  return {
    status: 200,
    body: { ok: true, cash_declared_vnd: cash, cash_system_vnd: actual?.cash ?? 0 },
  };
}

export async function activateSubscription(sql: Sql, subId: string) {
  const sub = await one<{
    id: string;
    status: string;
    end_on: string;
    start_on: string;
    sport_scope: string;
    plan_id: string;
    user_id: string;
    court_hours_left: string | number;
    session_left: number | null;
  }>(sql, `select * from subscriptions where id = $1 for update`, [subId]);
  if (!sub) throw err.notFound();
  const plan = await one<{
    duration_days: number | null;
    court_hours: number;
    session_quota: number | null;
    carry_over_hours: boolean;
    price_vnd: number;
  }>(sql, `select * from membership_plans where id = $1`, [sub.plan_id]);
  if (!plan) throw err.notFound();
  const today = ictDateString();
  const duration = plan.duration_days ?? 365;

  if (sub.status === "active" && sub.end_on >= today) {
    const end = addDays(sub.end_on, duration);
    await sql.query(
      `update subscriptions
          set end_on = $2,
              court_hours_left = court_hours_left + $3,
              session_left = case when session_left is null and $4::int is null then null
                                  else coalesce(session_left,0) + coalesce($4,0) end
        where id = $1`,
      [sub.id, end, plan.court_hours, plan.session_quota],
    );
    return;
  }

  // Check whether there is an existing live subscription for (user_id, sport_scope)
  const live = await one<{
    id: string;
    status: string;
    end_on: string;
    plan_id: string;
    court_hours_left: string | number;
    session_left: number | null;
  }>(
    sql,
    `select id, status, end_on::text, plan_id, court_hours_left, session_left from subscriptions
      where user_id = $1 and sport_scope = $2 and status in ('active','frozen') and id <> $3
      limit 1`,
    [sub.user_id, sub.sport_scope, sub.id],
  );

  if (live) {
    if (live.end_on < today) {
      // The previous plan has expired; mark it expired so the new one can become active
      await sql.query(`update subscriptions set status = 'expired' where id = $1`, [live.id]);
    } else if (live.plan_id === sub.plan_id) {
      // Same plan renewal: extend live subscription directly
      const end = addDays(live.end_on, duration);
      await sql.query(
        `update subscriptions
            set end_on = $2,
                court_hours_left = court_hours_left + $3,
                session_left = case when session_left is null and $4::int is null then null
                                    else coalesce(session_left,0) + coalesce($4,0) end
          where id = $1`,
        [live.id, end, plan.court_hours, plan.session_quota],
      );
      // Repoint any payments on sub to live and clean up sub
      await sql.query(`update payments set ref_id = $1 where ref_type = 'subscription' and ref_id = $2`, [live.id, sub.id]);
      await sql.query(`delete from subscriptions where id = $1`, [sub.id]);
      return;
    } else {
      // Different plan: mark old plan expired, carry over hours if configured
      await sql.query(`update subscriptions set status = 'expired' where id = $1`, [live.id]);
      if (plan.carry_over_hours) {
        sub.court_hours_left = Number(live.court_hours_left) + Number(sub.court_hours_left);
      }
    }
  }

  const end = addDays(today, duration);
  const hours = plan.carry_over_hours ? Number(sub.court_hours_left) + plan.court_hours : plan.court_hours;
  await sql.query(
    `update subscriptions
        set status = 'active', start_on = $2, end_on = $3,
            court_hours_left = $4, session_left = $5
      where id = $1`,
    [sub.id, today, end, hours, plan.session_quota],
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
async function describePayment(
  sql: Sql,
  refType: string,
  refId: string,
): Promise<{ description: string; unit: string }> {
  if (refType === "subscription") {
    const row = await one<{ name: string }>(
      sql,
      `select p.name from subscriptions s join membership_plans p on p.id = s.plan_id where s.id = $1`,
      [refId],
    );
    return { description: row ? `Gói hội viên — ${row.name}` : "Gói hội viên", unit: "gói" };
  }
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
  if (refType === "walkin") return { description: "Vé lẻ vào cửa", unit: "lượt" };
  if (refType === "equipment") return { description: "Thuê thiết bị", unit: "lượt" };
  return { description: "Dịch vụ tại trung tâm", unit: "lượt" };
}

export async function paymentsCreate(sql: Sql, request: Request, user: PublicUser) {
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
  if (ref_type !== "booking" && ref_type !== "subscription") {
    throw err.field("ref_type", "ref_type must be booking or subscription.");
  }
  // Money in is a positive whole number of đồng. Zero and negative amounts used
  // to post: a -5,000 "payment" quietly lowered what the member had paid, and a
  // later one-đồng payment then activated the plan (D-01).
  if (!Number.isInteger(amount) || amount <= 0 || amount > 2_000_000_000) {
    throw err.field("amount_vnd", "Enter an amount above zero, in whole đồng.");
  }
  const settings = await getSettings(sql);
  let shiftId: string | null = null;
  const shiftIdRaw = str(b.shift_id);
  if (shiftIdRaw) {
    if (!isUuid(shiftIdRaw)) throw err.notFound("Shift does not exist.");
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
  let buyer = user.full_name;
  let buyerPhone: string | null = null;
  let userId: string | null = null;
  let quote: PromoQuote | null = null;
  let subPromo: { id: string; discount: number } | null = null;
  if (ref_type === "booking") {
    // The receipt is made out to whoever the booking is for — the member, or
    // the walk-in's typed name and phone — never to the receptionist taking it.
    if (!isUuid(ref_id)) throw err.notFound("Booking does not exist.");
    const bookingExists = await one<{ id: string }>(sql, `select id from court_bookings where id = $1`, [ref_id]);
    if (!bookingExists) throw err.notFound("Booking does not exist.");
    const who = await bookingBuyer(sql, ref_id);
    buyer = who.name;
    buyerPhone = who.phone;
    userId = who.userId;
  } else if (ref_type === "subscription") {
    if (!isUuid(ref_id)) throw err.field("ref_id", "That value is not in the right format.");
    // Locked for the rest of the transaction: two taps on "Take payment" queue
    // here, and the second sees what the first left behind instead of both
    // reading the same balance.
    const sub = await one<{
      user_id: string;
      plan_id: string;
      status: string;
      price_vnd: number;
      sub_price_vnd: number | null;
      court_discount_pct: number;
      sport_scope: string;
      promo_id: string | null;
      promo_discount_vnd: number;
    }>(
      sql,
      `select s.user_id, s.plan_id, s.status::text as status, s.promo_id, s.promo_discount_vnd, s.price_vnd as sub_price_vnd,
              p.price_vnd, p.court_discount_pct, p.sport_scope::text as sport_scope
         from subscriptions s join membership_plans p on p.id = s.plan_id
        where s.id = $1 for update of s`,
      [ref_id],
    );
    if (!sub) throw err.notFound("No such plan.");
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
    const basePrice = sub.sub_price_vnd ?? sub.price_vnd;
    let discount = sub.status === "pending" ? sub.promo_discount_vnd : 0;
    let promoId: string | null = sub.status === "pending" ? sub.promo_id : null;
    const code = str(b.promo_code);
    if (code && !(sub.status === "pending" && promoId)) {
      quote = await quotePromo(sql, {
        code,
        userId: sub.user_id,
        scope: "plan",
        sport: sub.sport_scope,
        planId: sub.plan_id,
        orderVnd: basePrice,
      });
      discount = quote.discount_vnd;
      promoId = quote.promo_id;
    }
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
    subPromo = promoId && discount > 0 ? { id: promoId, discount } : null;
    userId = sub.user_id;
    const u = await one<{ full_name: string }>(sql, `select full_name from users where id = $1`, [userId]);
    buyer = u?.full_name ?? buyer;
  }
  const payCode = await nextCode(sql, "PAY");
  const pay = await one<{ id: string }>(
    sql,
    `insert into payments (code, user_id, shift_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by)
     values ($1,$2,$3,$4,$5,$6,'posted',$7,$8,$9) returning id`,
    [payCode, userId, shiftId, method, amount, Number(settings.vat_rate), ref_type, ref_id, user.id],
  );
  if (ref_type === "subscription") {
    if (subPromo) {
      await sql.query(`update subscriptions set promo_id = $2, promo_discount_vnd = $3 where id = $1`, [
        ref_id,
        subPromo.id,
        subPromo.discount,
      ]);
      await redeemPromo(sql, { promoId: subPromo.id, userId, paymentId: pay!.id, discountVnd: subPromo.discount });
    }
    // Paid in full (checked above), so a pending plan activates and an active one renews.
    await activateSubscription(sql, ref_id);
  } else if (ref_type === "booking") {
    await redeemForBooking(sql, ref_id, userId, pay!.id);
  }
  const item = await describePayment(sql, ref_type, ref_id);
  const invoiceId = await issueInvoice(sql, {
    paymentId: pay!.id,
    buyerName: buyer,
    buyerPhone,
    amountVnd: amount,
    vatRate: Number(settings.vat_rate ?? 0),
    description: item.description,
    unit: item.unit,
    settings,
  });
  await enqueueReceipt(sql, userId, {
    payment_id: pay!.id,
    invoice_id: invoiceId,
    amount_vnd: amount,
    method,
  });
  const payment = await one(sql, `select * from payments where id = $1`, [pay!.id]);
  const invoice = await one(sql, `select * from invoices where id = $1`, [invoiceId]);
  await audit(sql, user.id, "create_payment", "payment", pay!.id);
  return { status: 201, body: { payment, invoice } };
}

export async function paymentsRefund(sql: Sql, id: string, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  const b = await readJson(request);
  const amount = num(b.amount_vnd);
  const reason = str(b.reason) ?? "";
  if (amount == null || amount === 0) throw err.validation("amount_vnd must not be zero.");
  const orig = await one<{
    id: string;
    amount_vnd: number;
    user_id: string | null;
    vat_rate: string | number;
    ref_type: string;
    ref_id: string;
    // `for update` so two clicks on the same payment queue behind each other
    // rather than both reading a ledger neither of them has written to yet.
  }>(sql, `select * from payments where id = $1 for update`, [id]);

  if (!orig) throw err.notFound();
  if (orig.amount_vnd <= 0) throw err.validation("That row is already a refund.");
  const settings = await getSettings(sql);
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

  const needMgr = Math.abs(signed) >= settings.refund_manager_vnd;
  if (needMgr && user.role !== "manager") {
    const payCode = await nextCode(sql, "PAY");
    const row = await one(
      sql,
      `insert into payments (code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by)
       values ($1,$2,'cash',$3,$4,'refund_pending',$5,$6,$7) returning *`,
      [payCode, orig.user_id, signed, orig.vat_rate, orig.ref_type, orig.ref_id, user.id],
    );
    await audit(sql, user.id, "refund_pending", "payment", (row as { id: string }).id, null, { reason });
    return { status: 201, body: { payment: row } };
  }
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
  const payCode = await nextCode(sql, "PAY");
  const row = await one(
    sql,
    `insert into payments (code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by, shift_id)
     values ($1,$2,'cash',$3,$4,'posted',$5,$6,$7,$8) returning *`,
    [payCode, orig.user_id, signed, orig.vat_rate, orig.ref_type, orig.ref_id, user.id, shiftId],
  );
  await audit(sql, user.id, "refund", "payment", (row as { id: string }).id, null, { reason });
  const restored = await restoreIfFullyRefunded(sql, orig.ref_type, orig.ref_id);
  return { status: 201, body: { payment: row, promo_restored: restored } };
}

type PendingRefund = {
  id: string;
  code: string;
  user_id: string | null;
  amount_vnd: number;
  status: string;
  created_by: string | null;
};

/**
 * Lock a refund that is waiting for a decision and check the decider may take it.
 *
 * Shared by approve and reject so the two cannot drift: both need the row
 * locked (two managers pressing at once must not both win), both refuse a row
 * that is not a pending refund, and both refuse the person who raised it.
 */
async function lockPendingRefund(sql: Sql, id: string, user: PublicUser): Promise<PendingRefund> {
  requireRole(user, ["manager"]);
  const p = await one<PendingRefund>(
    sql,
    `select id, code, user_id, amount_vnd, status, created_by from payments where id = $1 for update`,
    [id],
  );
  if (!p) throw err.notFound("That refund does not exist.");
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
 * Approve or reject, then tell the member.
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
  const p = await lockPendingRefund(sql, id, user);
  const b = request ? await readJson(request) : {};
  const note = str(b.reason);
  if (note && note.length > 500) throw err.field("reason", "The note must be at most 500 characters.");
  const next = approve ? "posted" : "refund_rejected";
  await sql.query(`update payments set status = $2 where id = $1`, [id, next]);
  if (approve) {
    const ref = await one<{ ref_type: string; ref_id: string }>(
      sql,
      `select ref_type, ref_id from payments where id = $1`,
      [id],
    );
    if (ref) await restoreIfFullyRefunded(sql, ref.ref_type, ref.ref_id);
  }
  await audit(
    sql,
    user.id,
    approve ? "refund_approved" : "refund_rejected",
    "payment",
    id,
    { status: "refund_pending", amount_vnd: p.amount_vnd },
    { status: next, ...(note ? { note } : {}) },
  );
  if (p.user_id) {
    await enqueue(
      sql,
      "inapp",
      approve ? "refund_approved" : "refund_rejected",
      p.user_id,
      { payment_id: p.id, code: p.code, amount_vnd: Math.abs(p.amount_vnd), ...(note ? { note } : {}) },
      `refund_${approve ? "approved" : "rejected"}|${p.id}`,
    );
  }
  return { status: 200, body: { status: next } };
}

export async function paymentsApproveRefund(sql: Sql, id: string, request: Request, user: PublicUser) {
  return decideRefund(sql, id, user, request, true);
}

export async function paymentsRejectRefund(sql: Sql, id: string, request: Request, user: PublicUser) {
  return decideRefund(sql, id, user, request, false);
}

/** How many receipts the reconciliation list will show at once. */

/**
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
  requireRole(user, ["receptionist", "manager"]);
  const sp = new URL(request.url).searchParams;
  const days = Math.min(30, Math.max(1, Number(sp.get("days") ?? 7) || 7));

  // The desk home wants a badge number and nothing else. Running three joined
  // queries — including sixty transfers with their invoices — on every visit to
  // the front page, to render a single digit, is work nobody ever reads.
  if (sp.get("brief") === "1") {
    const counts = await one<{ orders: number; refunds: number; awaiting: number }>(
      sql,
      `select (select count(*) from subscriptions where status = 'pending')::int as orders,
              (select count(*) from payments where status = 'refund_pending')::int as refunds,
              (select count(*) from court_bookings
                where status = 'hold' and transfer_requested_at is not null
                  and hold_until > now())::int as awaiting`,
    );
    return {
      status: 200,
      body: {
        waiting:
          Number(counts?.orders ?? 0) + Number(counts?.refunds ?? 0) + Number(counts?.awaiting ?? 0),
      },
    };
  }

  // Slots the centre is holding open against a promise to transfer. Expired
  // holds are left out: the sweeper has already handed those courts back, so
  // showing them would invite a receptionist to confirm money into a booking
  // that no longer owns its slot.
  const awaiting = await sql.query(
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

  // `paid_vnd` calculated directly from posted payments: the desk wants to see a part payment
  // for what it is ("2 of 5 taken"), not just the balance left over.
  const orders = await sql.query(
    `select s.id, s.sport_scope, s.start_on::text as ordered_on, s.end_on::text as end_on,
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
      group by s.id, s.sport_scope, s.start_on, s.end_on,
               u.id, u.full_name, u.phone, u.member_code, pl.name, s.price_vnd, pl.price_vnd, pl.id,
               s.promo_discount_vnd, pr.code
      order by s.start_on asc, u.full_name asc`,
  );

  const refunds = await sql.query(
    `select p.id, p.code, p.amount_vnd, p.created_at, p.ref_type, p.ref_id,
            u.full_name as member_name, u.member_code,
            r.full_name as raised_by
       from payments p
       left join users u on u.id = p.user_id
       left join users r on r.id = p.created_by
      where p.status = 'refund_pending'
      order by p.created_at asc`,
  );

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
  const rq = sp.get("receipt_q")?.trim() || null;
  const needle = rq ? `%${rq.replace(/[\\%_]/g, (c) => "\\" + c)}%` : null;
  const method = sp.get("receipt_method") || null;
  const receiptRows = (lim: number, off: number) =>
    sql.query<{ total: number } & Record<string, unknown>>(
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
      [days, lim, off, method, needle],
    );
  const rows = await receiptRows(page.limit, page.offset);
  const receipts = await pageOf(rows, page, async () => Number((await receiptRows(1, 0))[0]?.total ?? 0));

  return {
    status: 200,
    body: { awaiting, orders, refunds, receipts: receipts.items, receipts_total: receipts.total, days, capped: false },
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
export async function subscriptionDecline(sql: Sql, id: string, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  const sub = await one<{ id: string; status: string }>(
    sql,
    `select id, status from subscriptions where id = $1 for update`,
    [id],
  );
  if (!sub) throw err.notFound();
  if (sub.status !== "pending") throw err.conflictState("That order is no longer waiting for payment.");
  const paid = await one<{ paid: number }>(
    sql,
    `select coalesce(sum(amount_vnd) filter (where status = 'posted'), 0)::int as paid
       from payments where ref_type = 'subscription' and ref_id = $1`,
    [id],
  );
  if (Number(paid?.paid ?? 0) > 0) {
    throw err.conflictState("Money has already been taken against this order — refund it first.");
  }
  await sql.query(`update subscriptions set status = 'expired' where id = $1`, [id]);
  await audit(sql, user.id, "decline_plan_order", "subscription", id);
  return { status: 200, body: { ok: true } };
}

/**
 * Every receipt the signed-in member has paid for, newest first.
 *
 * Invoices hang off payments, and it is the payment that knows whose money it
 * was — so ownership is a join, not a column on the invoice.
 */
export async function invoicesMine(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["member", "receptionist", "manager"]);
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  let req = request;
  if (rawLimit && Number(rawLimit) > 100) {
    url.searchParams.set("limit", "100");
    req = new Request(url.toString(), request);
  }
  const { limit, offset } = pageParams(req, { def: 30, max: 100 });
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
  const body = await pageOf(rows, { limit, offset }, async () =>
    ((await one<{ n: number }>(
      sql,
      `select count(*)::int as n from invoices i join payments p on p.id = i.payment_id where p.user_id = $1`,
      [user.id],
    ))?.n ?? 0),
  );
  return { status: 200, body };
}

export async function invoicePdf(sql: Sql, id: string, request: Request, user: PublicUser) {
  requireRole(user, ["manager", "receptionist", "member"]);
  const format = new URL(request.url).searchParams.get("format") === "80mm" ? "80mm" : "a5";
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
  if (!inv) throw err.notFound();
  const pay = await one<{ code: string; method: string; amount_vnd: number; user_id: string | null }>(
    sql,
    `select code, method, amount_vnd, user_id from payments where id = $1`,
    [inv.payment_id],
  );
  // Staff work the till and print anybody's receipt; a member may only see
  // their own. Invoice ids are UUIDs, but "unguessable" is not an access
  // control — without this a member could walk the whole centre's takings.
  if (user.role === "member" && pay?.user_id !== user.id) throw err.notFound();
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
  const settings = await getSettings(sql);
  const total = inv.total_vnd ?? pay?.amount_vnd ?? 0;
  const vatRate = Number(inv.vat_rate ?? 0);
  const subtotal = inv.subtotal_vnd ?? Math.floor(total / (1 + vatRate / 100));

  const bytes = await renderInvoicePdf(
    {
      code: inv.code,
      form_no: inv.form_no,
      serial_no: inv.serial_no,
      issued_at: inv.issued_at,
      seller: {
        legal_name: inv.seller_legal_name ?? settings.legal_name ?? "Arena3 Sports Center",
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
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${inv.code}.pdf"`,
    },
  });
}

/** A report day, checked. Anything else used to reach the SQL cast and come back as a 500. */
export function reportDay(sp: URLSearchParams, field: string, fallback: string): string {
  const v = sp.get(field);
  if (v === null || v === "") return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    throw err.field(field, "Use a date like 2026-03-31.");
  }
  return v;
}

const REPORT_METHODS = ["cash", "transfer", "card", "gateway", "quota"];

export function revenueParams(request: Request) {
  const sp = new URL(request.url).searchParams;
  const from = reportDay(sp, "from", ictDateString());
  const to = reportDay(sp, "to", from);
  if (from > to) throw err.field("to", "The end date is before the start date.");
  const method = sp.get("method") || null;
  if (method && !REPORT_METHODS.includes(method)) throw err.field("method", "Unknown payment method.");
  return { from, to, method };
}

/** The window of the same length that ends the day before `from`. */
export function previousWindow(from: string, to: string) {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const prevTo = addDays(from, -1);
  return { from: addDays(prevTo, -(days - 1)), to: prevTo };
}

export async function reportsRevenue(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const { from, to, method } = revenueParams(request);
  const body = await revenueBody(sql, from, to, method);
  // FR-PAY-05: the period against the one before it, from the same query, so the
  // screen and the exported file can never disagree about the comparison.
  const win = previousWindow(from, to);
  const prev = await revenueBody(sql, win.from, win.to, method);
  return {
    status: 200,
    body: { ...body.body, method, prev: { from: win.from, to: win.to, totals: prev.body.totals, by_source: prev.body.by_source } },
  };
}

export async function revenueBody(sql: Sql, from: string, to: string, method: string | null) {
  const rows = await sql.query<{
    method: string;
    ref_type: string;
    total: number;
    refunded: number;
    cnt: number;
  }>(
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
  const money = rows.filter((r) => r.method !== "quota");
  const quota = rows.filter((r) => r.method === "quota");
  const gross = money.reduce((s, r) => s + r.total, 0);
  const refund = money.reduce((s, r) => s + r.refunded, 0);
  const by_source: Record<string, number> = {};
  const refunds_by_source: Record<string, number> = {};
  const by_method: Record<string, number> = {};
  for (const r of money) {
    by_source[r.ref_type] = (by_source[r.ref_type] ?? 0) + r.total;
    if (r.refunded) refunds_by_source[r.ref_type] = (refunds_by_source[r.ref_type] ?? 0) + r.refunded;
    by_method[r.method] = (by_method[r.method] ?? 0) + r.total;
  }
  const quotaHours = await one<{ hours: string | number }>(
    sql,
    `select coalesce(sum(quota_hours),0) as hours
       from court_bookings
      where quota_hours > 0
        and (start_at at time zone 'Asia/Ho_Chi_Minh')::date between $1::date and $2::date
        and status in ('confirmed','in_use','completed','no_show')`,
    [from, to],
  );
  // Takings per cashier shift (G-07). A payment with no shift — an online
  // payment nobody at the desk took — is its own line rather than being
  // dropped, so the shifts and that line still add up to the total.
  const by_shift = await sql.query<{
    shift_id: string | null;
    cashier: string | null;
    opened_at: string | null;
    closed_at: string | null;
    takings_vnd: number;
    refunds_vnd: number;
    count: number;
  }>(
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
  // Revenue per ICT day, gapless across the whole window.
  //
  // The report could only ever be sliced by method and source, so the manager
  // screen had no way to draw a trend — the one question a revenue report is
  // usually opened to answer. generate_series supplies the days with no
  // takings too: dropping them would make a quiet Tuesday vanish and join
  // Monday straight to Wednesday, which reads as steady trade.
  const by_day = await sql.query<{ day: string; revenue_vnd: number }>(
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
  return {
    status: 200,
    body: {
      from,
      to,
      totals: { revenue_vnd: gross - refund, gross_vnd: gross, refund_vnd: refund, quota_hours: Number(quotaHours?.hours ?? 0) },
      by_source,
      refunds_by_source,
      by_shift,
      by_method,
      by_day,
      quota_payments: quota,
      lines: money,
    },
  };
}

export async function reportsOccupancy(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const date = new URL(request.url).searchParams.get("date") ?? ictDateString();
  const rows = await sql.query<{ court_id: string; court_code: string; minutes: number }>(
    `select c.id as court_id, c.court_code,
            coalesce(sum(
              case when o.start_at is null then 0
                   else extract(epoch from (least(o.end_at, $2::timestamptz) - greatest(o.start_at, $1::timestamptz))) / 60
              end
            ),0)::int as minutes
       from courts c
       left join occupancies o
         on o.court_id = c.id and o.start_at < $2 and o.end_at > $1
       where c.retired_at is null or o.id is not null
      group by c.id, c.court_code
      order by c.court_code`,
    [`${date}T06:00:00+07:00`, `${date}T22:00:00+07:00`],
  );
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

