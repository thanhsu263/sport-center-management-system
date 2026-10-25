import type { Sql } from "@/lib/db";
import { err } from "../errors";
import { classSubscription, enqueue, getSettings } from "../helpers";
import { requireRole, type PublicUser } from "../session";
import { one } from "../tx";

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
