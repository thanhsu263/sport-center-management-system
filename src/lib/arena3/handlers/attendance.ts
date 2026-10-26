/**
 * Attendance rate and the at-risk list (SRS v1.4.1 FR-TRN-09, BR-36, BR-32).
 *
 * Attendance carries no penalty and moves no balance (BR-32). Its use is here:
 * telling the centre who is drifting away while there is still time to call,
 * and which classes and coaches keep people coming.
 *
 * Rate = (Present + Late) / (sessions marked − Excused). A session nobody marked
 * is not counted at all, and an excused absence is left out of the denominator
 * rather than counted against the student.
 */
import type { Sql } from "@/lib/db";
import { err } from "../errors";
import { requireFlag } from "../flags";
import { audit, getSettings, readJson, str } from "../helpers";
import { classCode } from "../labels";
import { absentStreak, ABSENT_STREAK_LIMIT } from "../rules";
import { avatarUrlSql, requireRole, type PublicUser } from "../session";
import { addDays, ictDateString, ictDateTime } from "../time";
import { one } from "../tx";
import { reportDay } from "./desk";

import { getActiveSportCodes } from "./sports";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DAYS = 93;
const EXPIRING_DAYS = 7;
const LOW_RATE_PCT = 50;

export const CONTACT_REASONS = ["streak", "idle", "expiring", "other"] as const;
export const CONTACT_CHANNELS = ["phone", "zalo", "sms", "in_person"] as const;
export const CONTACT_OUTCOMES = ["reached", "will_return", "leaving", "reschedule", "no_answer"] as const;

const pct1 = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

function oneOf<T extends string>(list: readonly T[], v: unknown, field: string, fallback?: T): T {
  const s = str(v);
  if (!s && fallback) return fallback;
  if (!s || !(list as readonly string[]).includes(s)) {
    throw err.field(field, `${field} must be one of: ${list.join(", ")}.`);
  }
  return s as T;
}

async function windowParams(sql: Sql, request: Request) {
  const sp = new URL(request.url).searchParams;
  const to = reportDay(sp, "to", ictDateString());
  const from = reportDay(sp, "from", addDays(to, -29));
  if (from > to) throw err.field("to", "The end date is before the start date.");
  if (Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1 > MAX_DAYS) {
    throw err.field("from", `Pick a period of at most ${MAX_DAYS} days.`);
  }
  const sport = sp.get("sport") || null;
  if (sport && !(await getActiveSportCodes(sql)).includes(sport)) throw err.field("sport", "Unknown sport.");
  const classId = sp.get("class_id");
  if (classId && !UUID_RE.test(classId)) throw err.field("class_id", "class_id is not valid.");
  return { from, to, sport, classId: classId || null };
}

type Counts = { present: number; late: number; absent: number; excused: number };
const emptyCounts = (): Counts => ({ present: 0, late: 0, absent: 0, excused: 0 });
const rateOf = (c: Counts) => pct1(c.present + c.late, c.present + c.late + c.absent);
const add = (a: Counts, b: Counts) => {
  a.present += b.present;
  a.late += b.late;
  a.absent += b.absent;
  a.excused += b.excused;
};

type AttRow = Counts & {
  user_id: string;
  full_name: string;
  member_code: string | null;
  class_id: string;
  sport: string;
  level: string;
  coach_id: string;
  coach: string;
};

/** The manager sees everyone; a coach only the classes they lead or assist (FR-TRN-09). */
export async function attendanceReportBody(
  sql: Sql,
  from: string,
  to: string,
  opts: { sport: string | null; classId: string | null; coachScopeId: string | null },
) {
  const rows = await sql.query<AttRow>(
    `select a.user_id, u.full_name, u.member_code, cl.id as class_id, cl.sport::text as sport, cl.level,
            cl.coach_id, co.full_name as coach,
            count(*) filter (where a.result = 'present')::int as present,
            count(*) filter (where a.result = 'late')::int as late,
            count(*) filter (where a.result = 'absent')::int as absent,
            count(*) filter (where a.result = 'excused')::int as excused
       from attendance a
       join sessions s on s.id = a.session_id
       join classes cl on cl.id = s.class_id
       join users u on u.id = a.user_id
       join users co on co.id = cl.coach_id
      where a.kind = 'session' and a.result is not null and s.status <> 'cancelled'
        and s.start_at >= $1 and s.start_at < $2
        and ($3::text is null or cl.sport::text = $3)
        and ($4::uuid is null or cl.id = $4)
        and ($5::uuid is null or cl.coach_id = $5 or cl.assistant_id = $5)
      group by a.user_id, u.full_name, u.member_code, cl.id, cl.sport, cl.level, cl.coach_id, co.full_name
      order by u.full_name`,
    [
      ictDateTime(from, "00:00").toISOString(),
      ictDateTime(addDays(to, 1), "00:00").toISOString(),
      opts.sport,
      opts.classId,
      opts.coachScopeId,
    ],
  );
  const students = rows.map((r) => ({
    user_id: r.user_id,
    full_name: r.full_name,
    member_code: r.member_code,
    class_id: r.class_id,
    class_code: classCode(r.sport, r.level, r.class_id),
    sport: r.sport,
    present: r.present,
    late: r.late,
    absent: r.absent,
    excused: r.excused,
    rate_pct: rateOf(r),
  }));
  const byClass = new Map<string, { class_id: string; class_code: string; sport: string; coach: string; counts: Counts; students: Set<string> }>();
  const byCoach = new Map<string, { coach_id: string; coach: string; counts: Counts; classes: Set<string> }>();
  for (const r of rows) {
    const c = byClass.get(r.class_id) ?? {
      class_id: r.class_id,
      class_code: classCode(r.sport, r.level, r.class_id),
      sport: r.sport,
      coach: r.coach,
      counts: emptyCounts(),
      students: new Set<string>(),
    };
    add(c.counts, r);
    c.students.add(r.user_id);
    byClass.set(r.class_id, c);
    const k = byCoach.get(r.coach_id) ?? { coach_id: r.coach_id, coach: r.coach, counts: emptyCounts(), classes: new Set<string>() };
    add(k.counts, r);
    k.classes.add(r.class_id);
    byCoach.set(r.coach_id, k);
  }
  const total = emptyCounts();
  for (const r of rows) add(total, r);
  return {
    from,
    to,
    totals: { ...total, rate_pct: rateOf(total) },
    students,
    classes: [...byClass.values()]
      .map((c) => ({
        class_id: c.class_id,
        class_code: c.class_code,
        sport: c.sport,
        coach: c.coach,
        students: c.students.size,
        ...c.counts,
        rate_pct: rateOf(c.counts),
      }))
      .sort((a, b) => (a.rate_pct ?? 101) - (b.rate_pct ?? 101)),
    coaches: [...byCoach.values()]
      .map((c) => ({ coach_id: c.coach_id, coach: c.coach, classes: c.classes.size, ...c.counts, rate_pct: rateOf(c.counts) }))
      .sort((a, b) => (a.rate_pct ?? 101) - (b.rate_pct ?? 101)),
  };
}

export async function reportsAttendance(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["manager", "coach"]);
  await requireFlag(sql, "F4");
  const { from, to, sport, classId } = await windowParams(sql, request);
  const body = await attendanceReportBody(sql, from, to, {
    sport,
    classId,
    coachScopeId: user.role === "coach" ? user.id : null,
  });
  return { status: 200, body };
}

/* ------------------------------------------------------------------ *
 * At-risk list                                                        *
 * ------------------------------------------------------------------ */

type RiskReason = { kind: "streak" | "idle" | "expiring"; message: string };

export type AtRiskItem = {
  user_id: string;
  full_name: string;
  member_code: string | null;
  phone: string | null;
  avatar_url: string | null;
  plan_end_on: string | null;
  reasons: RiskReason[];
  attendance_pct: number | null;
  last_seen_at: string | null;
  contacted: boolean;
  last_contact: { at: string; outcome: string; note: string | null; by: string | null } | null;
};

/**
 * Members worth a call before they leave (FR-TRN-09). Three signals, each given as
 * a reason the caller can read out:
 *  (a) absent three sessions running with no excuse (BR-36),
 *  (b) a live plan but no visit and no class for `at_risk_idle_days`,
 *  (c) a plan ending within a week while attending under half their sessions.
 * A row is "contacted" once someone logged a call for that reason in the last two
 * weeks; it stays in the list so the history is reviewable.
 */
export async function atRiskBody(sql: Sql, scopeCoachId: string | null): Promise<{ items: AtRiskItem[]; idle_days: number }> {
  const settings = await getSettings(sql);
  const idleDays = settings.at_risk_idle_days;
  const today = ictDateString();
  const idleSince = ictDateTime(addDays(today, -idleDays), "00:00").toISOString();

  // Members with a live plan, and the sessions they have been marked on.
  const members = await sql.query<{
    user_id: string;
    full_name: string;
    member_code: string | null;
    phone: string | null;
    avatar_version: number | null;
    end_on: string;
    start_on: string;
    last_seen: string | null;
  }>(
    `select u.id as user_id, u.full_name, u.member_code, u.phone,
            (select version from user_avatars a where a.user_id = u.id) as avatar_version,
            max(s.end_on)::text as end_on, min(s.start_on)::text as start_on,
            (select max(a.at) from attendance a
               where a.user_id = u.id and (a.kind = 'gate' or a.result in ('present','late'))) as last_seen
       from users u join subscriptions s on s.user_id = u.id and s.status = 'active' and s.end_on >= $1::date
      where u.role = 'member' and u.status = 'active'
        and ($2::uuid is null or exists (
              select 1 from enrollments e join classes cl on cl.id = e.class_id
               where e.user_id = u.id and e.status = 'confirmed' and (cl.coach_id = $2 or cl.assistant_id = $2)))
      group by u.id, u.full_name, u.member_code, u.phone`,
    [today, scopeCoachId],
  );

  // Absent streaks (a) include people whose plan has lapsed — they are still on the roll.
  const streakRows = await sql.query<{ user_id: string; class_id: string; result: string }>(
    `select a.user_id, s.class_id, a.result::text as result
       from attendance a join sessions s on s.id = a.session_id
       join enrollments e on e.class_id = s.class_id and e.user_id = a.user_id and e.status = 'confirmed'
      where a.kind = 'session' and a.result is not null and s.status <> 'cancelled'
        and s.start_at >= $1 and ($2::uuid is null or s.class_id in (
              select id from classes where coach_id = $2 or assistant_id = $2))
      order by s.start_at`,
    [ictDateTime(addDays(today, -90), "00:00").toISOString(), scopeCoachId],
  );
  const perPair = new Map<string, { user_id: string; marks: string[] }>();
  for (const r of streakRows) {
    const k = `${r.user_id}|${r.class_id}`;
    const e = perPair.get(k) ?? { user_id: r.user_id, marks: [] };
    e.marks.push(r.result);
    perPair.set(k, e);
  }
  const streakByUser = new Map<string, number>();
  for (const e of perPair.values()) {
    const n = absentStreak(e.marks);
    if (n >= ABSENT_STREAK_LIMIT) streakByUser.set(e.user_id, Math.max(streakByUser.get(e.user_id) ?? 0, n));
  }

  // Attendance share since each member's plan began, for (c).
  const rateRows = await sql.query<{ user_id: string } & Counts>(
    `select a.user_id,
            count(*) filter (where a.result = 'present')::int as present,
            count(*) filter (where a.result = 'late')::int as late,
            count(*) filter (where a.result = 'absent')::int as absent,
            count(*) filter (where a.result = 'excused')::int as excused
       from attendance a join sessions s on s.id = a.session_id
      where a.kind = 'session' and a.result is not null and s.status <> 'cancelled' and s.start_at >= $1
      group by a.user_id`,
    [ictDateTime(addDays(today, -60), "00:00").toISOString()],
  );
  const rateByUser = new Map(rateRows.map((r) => [r.user_id, r]));

  const byId = new Map(members.map((m) => [m.user_id, m]));
  // A student on a streak who has no live plan still needs the row.
  const missing = [...streakByUser.keys()].filter((id) => !byId.has(id));
  if (missing.length) {
    const extra = await sql.query<(typeof members)[number]>(
      `select u.id as user_id, u.full_name, u.member_code, u.phone,
              (select version from user_avatars a where a.user_id = u.id) as avatar_version,
              null::text as end_on, null::text as start_on,
              (select max(a.at) from attendance a
                 where a.user_id = u.id and (a.kind = 'gate' or a.result in ('present','late'))) as last_seen
         from users u where u.id = any($1::uuid[]) and u.role = 'member' and u.status = 'active'`,
      [missing],
    );
    for (const m of extra) byId.set(m.user_id, m);
  }

  const contacts = await sql.query<{ user_id: string; reason: string; outcome: string; note: string | null; created_at: string; by: string | null }>(
    `select c.user_id, c.reason, c.outcome, c.note, c.created_at, u.full_name as by
       from contact_log c left join users u on u.id = c.created_by
      where c.created_at >= now() - interval '14 days' order by c.created_at desc`,
  );

  const items: AtRiskItem[] = [];
  for (const m of byId.values()) {
    const reasons: RiskReason[] = [];
    const streak = streakByUser.get(m.user_id);
    if (streak) reasons.push({ kind: "streak", message: `Absent ${streak} sessions in a row without an excuse.` });
    const live = m.end_on !== null;
    if (live && m.start_on! <= addDays(today, -idleDays) && (!m.last_seen || new Date(m.last_seen).getTime() < new Date(idleSince).getTime())) {
      reasons.push({ kind: "idle", message: `No visit or class in ${idleDays}+ days.` });
    }
    const c = rateByUser.get(m.user_id);
    const rate = c ? rateOf(c) : null;
    if (live && m.end_on! <= addDays(today, EXPIRING_DAYS) && rate !== null && rate < LOW_RATE_PCT) {
      reasons.push({ kind: "expiring", message: `Plan ends ${m.end_on} and attendance is ${rate}%.` });
    }
    if (reasons.length === 0) continue;
    const mine = contacts.filter((x) => x.user_id === m.user_id && reasons.some((r) => r.kind === x.reason || x.reason === "other"));
    const last = mine[0] ?? null;
    items.push({
      user_id: m.user_id,
      full_name: m.full_name,
      member_code: m.member_code,
      phone: m.phone,
      avatar_url: m.avatar_version != null ? `/v1/users/${m.user_id}/avatar?v=${m.avatar_version}` : null,
      plan_end_on: m.end_on,
      reasons,
      attendance_pct: rate,
      last_seen_at: m.last_seen,
      contacted: mine.length > 0,
      last_contact: last ? { at: last.created_at, outcome: last.outcome, note: last.note, by: last.by } : null,
    });
  }
  // Not yet contacted first, then the longest absence streak / soonest expiry.
  items.sort(
    (a, b) =>
      Number(a.contacted) - Number(b.contacted) ||
      b.reasons.length - a.reasons.length ||
      (a.plan_end_on ?? "9999").localeCompare(b.plan_end_on ?? "9999") ||
      a.full_name.localeCompare(b.full_name),
  );
  return { items, idle_days: idleDays };
}

export async function atRiskList(sql: Sql, user: PublicUser) {
  requireRole(user, ["manager", "coach", "receptionist"]);
  await requireFlag(sql, "F4");
  return { status: 200, body: await atRiskBody(sql, user.role === "coach" ? user.id : null) };
}

/* ------------------------------------------------------------------ *
 * Contact log                                                         *
 * ------------------------------------------------------------------ */

/** "Contacted" — who called whom, why, and what came of it. Not a message sender. */
export async function contactCreate(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["manager", "coach", "receptionist"]);
  await requireFlag(sql, "F4");
  const b = await readJson(request);
  const userId = str(b.user_id) ?? "";
  if (!UUID_RE.test(userId)) throw err.field("user_id", "Choose a member.");
  const member = await one<{ id: string }>(sql, `select id from users where id = $1 and role = 'member'`, [userId]);
  if (!member) throw err.notFound("Member not found.");
  if (user.role === "coach") {
    const inScope = await one(
      sql,
      `select 1 as ok from enrollments e join classes cl on cl.id = e.class_id
        where e.user_id = $1 and e.status = 'confirmed' and (cl.coach_id = $2 or cl.assistant_id = $2) limit 1`,
      [userId, user.id],
    );
    if (!inScope) throw err.forbidden("That member is not in your classes.");
  }
  const reason = oneOf(CONTACT_REASONS, b.reason, "reason", "other");
  const channel = oneOf(CONTACT_CHANNELS, b.channel, "channel", "phone");
  const outcome = oneOf(CONTACT_OUTCOMES, b.outcome, "outcome");
  const note = (str(b.note) ?? "").trim();
  if (note.length > 500) throw err.field("note", "Keep the note under 500 characters.");
  const row = await one(
    sql,
    `insert into contact_log (user_id, reason, channel, outcome, note, created_by)
     values ($1,$2,$3,$4,$5,$6) returning *`,
    [userId, reason, channel, outcome, note || null, user.id],
  );
  await audit(sql, user.id, "contact_logged", "user", userId, null, { reason, outcome });
  return { status: 201, body: row };
}

export async function contactList(sql: Sql, memberId: string, user: PublicUser) {
  requireRole(user, ["manager", "coach", "receptionist"]);
  await requireFlag(sql, "F4");
  if (!UUID_RE.test(memberId)) throw err.notFound();
  if (user.role === "coach") {
    // A coach reads about their own students only, the same limit as writing one.
    const inScope = await one(
      sql,
      `select 1 as ok from enrollments e join classes cl on cl.id = e.class_id
        where e.user_id = $1 and e.status = 'confirmed' and (cl.coach_id = $2 or cl.assistant_id = $2) limit 1`,
      [memberId, user.id],
    );
    if (!inScope) throw err.forbidden("That member is not in your classes.");
  }
  const items = await sql.query(
    `select c.id, c.reason, c.channel, c.outcome, c.note, c.created_at, u.full_name as created_by_name
       from contact_log c left join users u on u.id = c.created_by
      where c.user_id = $1 order by c.created_at desc limit 50`,
    [memberId],
  );
  return { status: 200, body: { items } };
}
