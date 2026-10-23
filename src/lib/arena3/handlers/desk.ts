import type { Sql } from "@/lib/db";
import { err } from "../errors";
import { audit, readJson } from "../helpers";
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
