import type { Sql } from "@/lib/db";
import { err } from "../errors";
import { audit, enqueue, getSettings, nextCode, num, readJson, str } from "../helpers";
import { restoreIfFullyRefunded } from "../promos";
import { requireRole, type PublicUser } from "../session";
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
