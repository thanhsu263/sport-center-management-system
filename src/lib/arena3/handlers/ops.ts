import type { Sql } from "@/lib/db";
import { err } from "../errors";
import { flagsMap, type FlagKey } from "../flags";
import { audit, classSubscription, enqueue, getSettings, readJson } from "../helpers";
import { requireRole, type PublicUser } from "../session";
import { addDays, ictDateString } from "../time";
import { one } from "../tx";
import { payosConfigured } from "../payos";
import { centreBank } from "../bank";
import { parseInteger } from "../validate";

export async function flagsGet(sql: Sql) {
  const settings = await getSettings(sql);
  return {
    status: 200,
    body: {
      // Opening hours and the hold length as the manager set them, for the copy and grids that
      // used to write "06:00-22:00" and "five minutes" in by hand. Not personal, not secret.
      venue: { open_time: settings.open_time, close_time: settings.close_time, hold_minutes: settings.hold_minutes },
      flags: await flagsMap(sql),
      /*
       * Whether online payment can be offered at all.
       *
       * Not a feature flag a manager toggles — it is simply whether the centre
       * has put payOS credentials in the environment. The screens need to know
       * so they can leave the button out rather than offer one that fails, and
       * only the answer crosses the wire; the keys themselves never leave the
       * server.
       */
      capabilities: { online_payment: payosConfigured(), bank_transfer: centreBank() !== null },
    },
  };
}
export async function flagsPatch(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const b = await readJson(request);
  for (const key of ["F4", "F5", "F6"] as FlagKey[]) {
    if (typeof b[key] === "boolean") {
      await sql.query(`insert into feature_flags (key, enabled) values ($1,$2)
        on conflict (key) do update set enabled = excluded.enabled`, [key, b[key]]);
    }
  }
  await audit(sql, user.id, "patch_flags", "flags", null, null, b);
  return flagsGet(sql);
}

export async function subscriptionFreeze(sql: Sql, id: string, request: Request, user: PublicUser) {
  requireRole(user, ["manager", "receptionist"]);
  const b = await readJson(request);
  const raw = b.days;
  let days: number;
  if (raw === undefined || raw === null || raw === "") {
    days = 7;
  } else {
    days = parseInteger("days", "Freeze length", raw, -Infinity, Infinity);
    if (days < 1 || days > 90) throw err.validation("Freeze length must be 1–90 days.");
  }
  const settings = await getSettings(sql);
  const sub = await one<{
    id: string;
    status: string;
    frozen_days: number;
    end_on: string;
    user_id: string;
  }>(sql, `select id, status, frozen_days, end_on::text, user_id from subscriptions where id = $1 for update`, [id]);
  if (!sub) throw err.notFound();
  if (sub.status !== "active") throw err.br("BR-14", "Only an active plan can be frozen.");
  if (sub.frozen_days + days > settings.freeze_max_days_year) {
    throw err.br("BR-15", `Over the limit of ${settings.freeze_max_days_year} freeze days a year.`);
  }
  const end = addDays(sub.end_on, days);
  await sql.query(
    `update subscriptions set status = 'frozen', frozen_days = frozen_days + $2, end_on = $3 where id = $1`,
    [id, days, end],
  );
  await audit(sql, user.id, "freeze_sub", "subscription", id, sub, { days, end });
  return { status: 200, body: await one(sql, `select id, user_id, plan_id, sport_scope, start_on::text, end_on::text, status, frozen_days, court_hours_left, session_left from subscriptions where id = $1`, [id]) };
}

export async function subscriptionUnfreeze(sql: Sql, id: string, user: PublicUser) {
  requireRole(user, ["manager", "receptionist"]);
  const sub = await one<{ id: string; status: string; end_on: string; frozen_days: number }>(
    sql,
    `select id, status, end_on::text, frozen_days from subscriptions where id = $1 for update`,
    [id],
  );
  if (!sub) throw err.notFound();
  if (sub.status !== "frozen") throw err.conflictState("That plan is not frozen.");

  const lastFreeze = await one<{ at: string; before: any; after: any }>(
    sql,
    `select at::text, before, after from audit_logs
      where action = 'freeze_sub' and entity = 'subscription' and entity_id = $1
      order by at desc limit 1`,
    [id],
  );

  let newEndOn = sub.end_on;
  if (lastFreeze && lastFreeze.before?.end_on && lastFreeze.after?.days) {
    const freezeDate = String(lastFreeze.at).slice(0, 10);
    const today = ictDateString();
    const dFreeze = new Date(freezeDate);
    const dToday = new Date(today);
    const maxDays = Number(lastFreeze.after.days) || 0;
    const actualDays = Math.min(maxDays, Math.max(0, Math.round((dToday.getTime() - dFreeze.getTime()) / (86400 * 1000))));
    const originalEndOn = String(lastFreeze.before.end_on).slice(0, 10);
    newEndOn = addDays(originalEndOn, actualDays);
  }

  await sql.query(`update subscriptions set status = 'active', end_on = $2 where id = $1`, [id, newEndOn]);
  await audit(sql, user.id, "unfreeze_sub", "subscription", id, sub, { end_on: newEndOn });
  return { status: 200, body: await one(sql, `select id, user_id, plan_id, sport_scope, start_on::text, end_on::text, status, frozen_days, court_hours_left, session_left from subscriptions where id = $1`, [id]) };
}

export async function waitlistAccept(sql: Sql, offerId: string, user: PublicUser) {
  requireRole(user, ["member"]);
  const offer = await one<{
    id: string;
    enrollment_id: string;
    status: string;
    expires_at: string;
  }>(sql, `select * from waitlist_offers where id = $1 for update`, [offerId]);
  if (!offer) throw err.notFound();
  if (offer.status !== "pending") throw err.conflictState();
  if (new Date(offer.expires_at) < new Date()) throw err.br("BR-23", "That offer has expired.");
  const enr = await one<{ id: string; class_id: string; user_id: string; status: string }>(
    sql,
    `select * from enrollments where id = $1 for update`,
    [offer.enrollment_id],
  );
  if (!enr || enr.user_id !== user.id) throw err.forbidden();
  const cl = await one<{ enrolled_count: number; capacity: number; sport: string }>(
    sql,
    `select enrolled_count, capacity, sport from classes where id = $1 for update`,
    [enr.class_id],
  );
  if (!cl) throw err.notFound();
  const found = await classSubscription(sql, user.id, cl.sport);
  if (!found) throw err.br("BR-19", "You need an active plan covering this sport.");
  const sub = await one<{ id: string; session_left: number | null }>(
    sql,
    `select id, session_left from subscriptions where id = $1 for update`,
    [found.id],
  );
  if (!sub) throw err.br("BR-19", "You need an active plan covering this sport.");
  if (sub.session_left != null && sub.session_left <= 0) {
    throw err.br("BR-20", "You have no sessions left.");
  }
  if (cl.enrolled_count >= cl.capacity) throw err.br("BR-21", "The class just filled up.");
  await sql.query(
    `update enrollments set status = 'confirmed', waitlist_pos = null where id = $1`,
    [enr.id],
  );
  await sql.query(
    `update classes set enrolled_count = enrolled_count + 1 where id = $1 and enrolled_count < capacity`,
    [enr.class_id],
  );
  await sql.query(`update waitlist_offers set status = 'accepted' where id = $1`, [offerId]);
  if (sub.session_left != null) {
    const took = await sql.query(
      `update subscriptions
          set session_left = session_left - 1
        where id = $1 and session_left > 0
       returning id`,
      [sub.id],
    );
    if (took.length === 0) {
      throw err.br("BR-20", "You have no sessions left.");
    }
  }
  return { status: 200, body: { ok: true } };
}

export async function inviteWaitlist(sql: Sql, classId: string) {
  const pending = await one(
    sql,
    `select o.id from waitlist_offers o
       join enrollments e on e.id = o.enrollment_id
      where e.class_id = $1 and o.status = 'pending' and o.expires_at > now()
      limit 1`,
    [classId],
  );
  if (pending) return;
  const next = await one<{ id: string; user_id: string }>(
    sql,
    `select id, user_id from enrollments
      where class_id = $1 and status = 'waitlisted'
      order by waitlist_pos nulls last, id
      limit 1`,
    [classId],
  );
  if (!next) return;
  const settings = await getSettings(sql);
  const hours = settings.waitlist_offer_hours || 2;
  const offer = await one<{ id: string }>(
    sql,
    `insert into waitlist_offers (enrollment_id, expires_at, status)
     values ($1, now() + ($2 * interval '1 hour'), 'pending')
     returning id`,
    [next.id, hours],
  );
  await enqueue(
    sql,
    "inapp",
    "waitlist_offer",
    next.user_id,
    { offer_id: offer!.id, class_id: classId },
    `wl|${offer!.id}`,
  );
}
