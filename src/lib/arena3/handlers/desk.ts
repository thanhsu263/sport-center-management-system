import type { Sql } from "@/lib/db";
import { err } from "../errors";
import { audit, bookingBuyer, enqueue, enqueueReceipt, getSettings, isUuid, issueInvoice, nextCode, num, readJson, str } from "../helpers";
import { quotePromo, redeemForBooking, redeemPromo, restoreIfFullyRefunded, type PromoQuote } from "../promos";
import { requireRole, type PublicUser } from "../session";
import { addDays, ictDateString } from "../time";
import { one } from "../tx";
import { parseInteger } from "../validate";

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
