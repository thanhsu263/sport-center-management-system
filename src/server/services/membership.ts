import type { Sql } from "@/server/data/db";
import { err } from "../controllers/errors";
import { addDays, ictDateString, roundVnd } from "../../shared/arena3/time";
import { one, q } from "../controllers/tx";

/** The plan row a class-created membership points at when the member has none. */
export const SHORTEST_PLAN_ID = "20000000-0000-0000-0000-000000000051";

/** Whole-thousand dong: the unit prices are quoted in. */
export function roundThousand(vnd: number): number {
  return Math.round(vnd / 1000) * 1000;
}

/** Same day n months later; a day the month lacks falls back to its last day (31/01 + 1 = 28/02). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, last);
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** A class can be joined only when the membership ends after the class does. */
export function outlastsClass(membershipEnd: string | null, classEnd: string): boolean {
  return membershipEnd !== null && membershipEnd > classEnd;
}

/**
 * The cheapest plan that, bought now, ends after the class.
 * `buyFrom` is the date the purchase counts from: the current end, or today with no live membership.
 */
export function planToOutlast<P extends { price_vnd: number; duration_months: number | null }>(
  plans: P[],
  buyFrom: string,
  classEnd: string,
): P | null {
  const enough = plans
    .filter((p) => p.duration_months && outlastsClass(addMonths(buyFrom, p.duration_months), classEnd))
    .sort((a, b) => a.price_vnd - b.price_vnd);
  return enough[0] ?? null;
}

type LiveSub = { id: string; start_on: string; end_on: string; status: string };

/** The member's one live membership; pass lock when about to change it. */
export async function liveMembership(sql: Sql, userId: string, lock = false): Promise<LiveSub | null> {
  return (
    (await one<LiveSub>(
      sql,
      `select id, start_on::text, end_on::text, status::text from subscriptions
        where user_id = $1 and status in ('active','frozen') limit 1${lock ? " for update" : ""}`,
      [userId],
    )) ?? null
  );
}

/** The active membership covering a play date, if any. A frozen one covers nothing. */
export async function coverageOn(sql: Sql, userId: string, date: string): Promise<LiveSub | null> {
  return (
    (await one<LiveSub>(
      sql,
      `select id, start_on::text, end_on::text, status::text from subscriptions
        where user_id = $1 and status = 'active' and start_on <= $2::date and end_on >= $2::date limit 1`,
      [userId, date],
    )) ?? null
  );
}

/** The member fee for one slot on that play date, or null when no membership covers it. */
export async function memberCourtFee(
  sql: Sql,
  userId: string,
  start: Date,
  settings: { member_court_fee_vnd: number; slot_minutes: number; round_vnd: number },
): Promise<{ fee_vnd: number; end_on: string } | null> {
  const sub = await coverageOn(sql, userId, ictDateString(start));
  if (!sub) return null;
  return {
    fee_vnd: roundVnd((settings.member_court_fee_vnd * settings.slot_minutes) / 60, settings.round_vnd),
    end_on: sub.end_on,
  };
}

/** The active membership's end, or null. A frozen membership does not qualify. */
export async function activeMembershipEnd(sql: Sql, userId: string): Promise<string | null> {
  const live = await liveMembership(sql, userId);
  return live?.status === "active" && live.end_on >= ictDateString() ? live.end_on : null;
}

/** The enrolment gate, used by every path that gives or queues a seat. */
export async function assertMembershipOutlastsClass(sql: Sql, userId: string, classEnd: string): Promise<void> {
  const currentEnd = await activeMembershipEnd(sql, userId);
  if (!outlastsClass(currentEnd, classEnd)) {
    throw err.br("BR-19", `The membership must end after this class ends (${classEnd}). Buy or extend a plan first.`, {
      class_end: classEnd,
      current_end: currentEnd,
    });
  }
}

/** What is left to collect on a held seat. */
export async function enrollmentAmountDue(sql: Sql, enrollmentId: string): Promise<number> {
  const e = await one<{ price_vnd: number | null }>(sql, `select price_vnd from enrollments where id = $1`, [enrollmentId]);
  return e?.price_vnd ?? 0;
}

/** Runs when a seat is confirmed. Only seats sold before the enrolment gate carry an extension to honour. */
export async function applyExtension(sql: Sql, enrollmentId: string): Promise<void> {
  const e = await one<{ user_id: string; extension_vnd: number; extension_to: string | null; start_on: string }>(
    sql,
    `select e.user_id, e.extension_vnd, e.extension_to::text, c.start_on::text
       from enrollments e join classes c on c.id = e.class_id where e.id = $1`,
    [enrollmentId],
  );
  if (!e || !e.extension_to || e.extension_vnd <= 0) return;
  const today = ictDateString();
  const live = await liveMembership(sql, e.user_id, true);
  let subId: string;
  let from: string;
  if (live && live.end_on >= today) {
    subId = live.id;
    from = addDays(live.end_on, 1);
    if (live.end_on < e.extension_to) {
      await sql.query(`update subscriptions set end_on = $2 where id = $1`, [live.id, e.extension_to]);
    } else {
      from = e.extension_to; // Another class got there first; the row still records what was paid.
    }
  } else {
    if (live) await sql.query(`update subscriptions set status = 'expired' where id = $1`, [live.id]);
    from = e.start_on > today ? e.start_on : today;
    const created = await one<{ id: string }>(
      sql,
      `insert into subscriptions (user_id, plan_id, sport_scope, start_on, end_on, status, price_vnd)
       values ($1, $2, 'all', $3, $4, 'active', 0) returning id`,
      [e.user_id, SHORTEST_PLAN_ID, from, e.extension_to],
    );
    subId = created!.id;
  }
  await sql.query(
    `insert into membership_extensions (subscription_id, enrollment_id, from_on, to_on, amount_vnd)
     values ($1, $2, $3, $4, $5)`,
    [subId, enrollmentId, from, e.extension_to, e.extension_vnd],
  );
}

/** Days given back and the refund: only what no other class needs and nobody has used yet. */
export function computeRollback(args: {
  fromOn: string;
  toOn: string;
  amountVnd: number;
  otherClassEnd: string | null;
  today: string;
  dayRate: number;
}): { days: number; refund_vnd: number } {
  const { fromOn, toOn, amountVnd, otherClassEnd, today, dayRate } = args;
  const floors = [addDays(fromOn, -1), addDays(today, -1)];
  if (otherClassEnd) floors.push(otherClassEnd);
  const keepTo = floors.reduce((a, b) => (a > b ? a : b));
  const days = Math.max(0, daysBetween(keepTo, toOn));
  if (days === 0) return { days: 0, refund_vnd: 0 };
  const whole = daysBetween(fromOn, toOn) + 1;
  return { days, refund_vnd: days >= whole ? amountVnd : Math.min(amountVnd, roundThousand(days * dayRate)) };
}

/** The centre cancelled a class: shorten the membership and return the dong to refund. */
export async function rollbackExtension(
  sql: Sql,
  enrollmentId: string,
  dayRate: number,
): Promise<{ refund_vnd: number; days: number; new_end: string | null }> {
  const none = { refund_vnd: 0, days: 0, new_end: null };
  const ext = await one<{ id: string; subscription_id: string; from_on: string; to_on: string; amount_vnd: number }>(
    sql,
    `select id, subscription_id, from_on::text, to_on::text, amount_vnd from membership_extensions
      where enrollment_id = $1 and status = 'active' for update`,
    [enrollmentId],
  );
  if (!ext) return none;
  const sub = await one<{ user_id: string; end_on: string }>(
    sql,
    `select user_id, end_on::text from subscriptions where id = $1 for update`,
    [ext.subscription_id],
  );
  await sql.query(`update membership_extensions set status = 'refunded' where id = $1`, [ext.id]);
  if (!sub) return none;
  const other = await one<{ end_on: string | null }>(
    sql,
    `select max(c.end_on)::text as end_on from enrollments e join classes c on c.id = e.class_id
      where e.user_id = $1 and e.id <> $2 and e.status = 'confirmed' and c.status <> 'cancelled'`,
    [sub.user_id, enrollmentId],
  );
  const today = ictDateString();
  const { days, refund_vnd } = computeRollback({
    fromOn: ext.from_on,
    toOn: ext.to_on,
    amountVnd: ext.amount_vnd,
    otherClassEnd: other?.end_on ?? null,
    today,
    dayRate,
  });
  if (days === 0) return { ...none, new_end: sub.end_on };
  const newEnd = addDays(sub.end_on, -days);
  await sql.query(
    `update subscriptions
        set end_on = $2::date,
            status = case when $2::date < $3::date then 'expired' else status end
      where id = $1`,
    [ext.subscription_id, newEnd, today],
  );
  return { refund_vnd, days, new_end: newEnd };
}

/** The centre moved a class's last day later: members already enrolled are carried there for free. */
export async function carryMembersToClassEnd(sql: Sql, classId: string, newEnd: string): Promise<number> {
  const rows = await q<{ id: string }>(
    sql,
    `update subscriptions s set end_on = $2::date
       from enrollments e
      where e.class_id = $1 and e.status = 'confirmed' and e.user_id = s.user_id
        and s.status in ('active','frozen') and s.end_on < $2::date
      returning s.id`,
    [classId, newEnd],
  );
  return rows.length;
}

/** A member with a class still ahead cannot pause: the class would outrun the membership. */
export async function hasRunningClass(sql: Sql, userId: string): Promise<boolean> {
  const row = await one(
    sql,
    `select 1 from enrollments e join classes c on c.id = e.class_id
      where e.user_id = $1 and e.status = 'confirmed' and c.status <> 'cancelled'
        and c.end_on >= $2::date limit 1`,
    [userId, ictDateString()],
  );
  return !!row;
}

/** Tuition and extension as separate invoice lines; undefined when the payment bought tuition only. */
export async function enrollmentInvoiceLines(
  sql: Sql,
  enrollmentId: string,
  amountVnd: number,
  item: { description: string; unit: string },
): Promise<{ description: string; unit: string; amount_vnd: number }[] | undefined> {
  const e = await one<{ extension_vnd: number; extension_to: string | null }>(
    sql,
    `select extension_vnd, extension_to::text from enrollments where id = $1`,
    [enrollmentId],
  );
  if (!e || e.extension_vnd <= 0 || !e.extension_to || e.extension_vnd >= amountVnd) return undefined;
  const [y, m, d] = e.extension_to.split("-");
  return [
    { description: item.description, unit: item.unit, amount_vnd: amountVnd - e.extension_vnd },
    { description: `Gia hạn hội viên đến ${d}/${m}/${y}`, unit: "lần", amount_vnd: e.extension_vnd },
  ];
}
