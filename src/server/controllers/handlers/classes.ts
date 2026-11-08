import type { Sql } from "@/lib/db";
import { err, isConflictSlot } from "../errors";
import { audit, classSubscription, enqueue, getSettings, num, readJson, str } from "../helpers";
import { classCode, parseWeeklyRrule } from "../labels";
import { expandWeekly } from "../rrule";
import { requireRole, type PublicUser } from "../session";
import { addDays, classMinutes, ictDateString, ictDateTime, slotSpan } from "../time";
import { one } from "../tx";
import { inviteWaitlist } from "./ops";
import { assertClassStaff } from "./training";
import { assertSlotGrid } from "./bookings";

export const MAX_CLASS_CAPACITY = 200;

export async function classesList(sql: Sql, request: Request, user: PublicUser | null) {
  const sport = new URL(request.url).searchParams.get("sport");
  const manager = user?.role === "manager";
  const items = await sql.query(
    `select cl.id, cl.sport, cl.level, cl.capacity, cl.enrolled_count, cl.rrule, cl.duration_min,
            cl.start_on::text, cl.end_on::text, cl.status, cl.court_id, c.court_code,
            cl.coach_id, u.full_name as coach_name, made.at as created_at
       from classes cl
       join courts c on c.id = cl.court_id
       join users u on u.id = cl.coach_id
       left join lateral (
         select max(a.at) as at from audit_logs a
          where a.action = 'create_class' and a.entity_id = cl.id
       ) made on true
      where ($1 or cl.status = 'open')
        and ($2::text is null or cl.sport::text = $2)
      order by case cl.status when 'open' then 0 when 'closed' then 1 when 'draft' then 2 else 3 end,
               made.at desc nulls last, cl.start_on desc, cl.level`,
    [manager, sport],
  );
  return {
    status: 200,
    body: { items: items.map((c) => ({ ...c, code: classCode(String(c.sport), String(c.level), String(c.id)) })) },
  };
}

type ClassPattern = { rrule: string; duration_min: number; start_on: string; end_on: string };

/** True when two weekly classes meet on at least one same date at overlapping hours. */
export function classPatternsClash(a: ClassPattern, b: ClassPattern) {
  const from = a.start_on > b.start_on ? a.start_on : b.start_on;
  const to = a.end_on < b.end_on ? a.end_on : b.end_on;
  if (from > to) return false;
  const pa = parseWeeklyRrule(a.rrule);
  const pb = parseWeeklyRrule(b.rrule);
  const aStart = pa.hour * 60;
  const bStart = pb.hour * 60;
  if (!(aStart < bStart + b.duration_min && bStart < aStart + a.duration_min)) return false;
  const codes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  // Only weekdays that really fall inside the shared date range count.
  let day = from;
  for (let i = 0; i < 7 && day <= to; i++, day = addDays(day, 1)) {
    const code = codes[new Date(`${day}T00:00:00Z`).getUTCDay()]!;
    if (pa.days.includes(code) && pb.days.includes(code)) return true;
  }
  return false;
}

export async function classesCreate(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const b = await readJson(request);
  const sport = str(b.sport);
  const level = str(b.level);
  const coach_id = str(b.coach_id);
  const court_id = str(b.court_id);
  const rrule = str(b.rrule);
  const start_on = str(b.start_on);
  const end_on = str(b.end_on);
  const capacity = num(b.capacity) ?? 12;
  if (capacity > MAX_CLASS_CAPACITY) {
    throw err.field("capacity", `Capacity cannot exceed ${MAX_CLASS_CAPACITY}.`);
  }
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw err.field("capacity", `Capacity must be a whole number from 1 to ${MAX_CLASS_CAPACITY}.`);
  }
  const duration_min = classMinutes(num(b.duration_min));
  if (duration_min == null) {
    throw err.validation("A class runs for whole court hours (60, 120 or 180).");
  }
  if (!sport || !level || !coach_id || !court_id || !rrule || !start_on || !end_on) {
    throw err.validation("Class details are incomplete.");
  }
  if (start_on > end_on) {
    throw err.field("end_on", "End date must be on or after start date.");
  }

  const rruleParts = Object.fromEntries(
    rrule.split(";").map((p) => {
      const [k, v] = p.split("=");
      return [k ?? "", v ?? ""];
    }),
  );
  if (rruleParts.BYHOUR !== undefined) {
    const byHour = Number(rruleParts.BYHOUR);
    if (!Number.isInteger(byHour) || byHour < 0 || byHour > 23) {
      throw err.field("rrule", "BYHOUR must be an integer between 0 and 23.");
    }
  }

  const coach = await one<{ role: string }>(sql, `select role from users where id = $1`, [coach_id]);
  if (!coach || coach.role !== "coach") throw err.br("BR-25", "That coach is not valid.");
  const sportOk = await one(
    sql,
    `select 1 from coach_sports where user_id = $1 and (sport = $2 or sport = 'all')`,
    [coach_id, sport],
  );
  if (!sportOk) throw err.br("BR-25", "That coach is not assigned to this sport.");

  const court = await one<{ sport: string; retired_at: string | null }>(
    sql,
    `select sport::text as sport, retired_at from courts where id = $1`,
    [court_id],
  );
  if (!court || court.retired_at) throw err.field("court_id", "That court does not exist.");
  if (court.sport !== sport) {
    throw err.field("court_id", "Court sport must match class sport.");
  }

  const assistant_id = str(b.assistant_id);
  if (assistant_id) {
    const asst = await one<{ role: string }>(sql, `select role from users where id = $1`, [assistant_id]);
    if (!asst || asst.role !== "coach") throw err.field("assistant_id", "That assistant coach is not valid.");
  }

  // A class whose every date sits on another class's court or coach would publish
  // with no sessions at all, so a clashing timetable is refused up front.
  const people = [coach_id, assistant_id].filter(Boolean);
  const rivals = await sql.query(
    `select court_id, coach_id, assistant_id, rrule, duration_min, start_on::text, end_on::text
       from classes
      where status <> 'cancelled'
        and start_on <= $3::date and end_on >= $2::date
        and (court_id = $1 or coach_id = any($4::uuid[]) or assistant_id = any($4::uuid[]))`,
    [court_id, start_on, end_on, people],
  );
  const mine = { rrule, duration_min, start_on, end_on };
  for (const r of rivals as Array<ClassPattern & { court_id: string; coach_id: string; assistant_id: string | null }>) {
    if (!classPatternsClash(mine, r)) continue;
    if (r.court_id === court_id) throw err.conflict("Another class already uses this court on those days and hours.");
    throw err.conflict("This coach already teaches another class on those days and hours.");
  }

  const row = await one(
    sql,
    `insert into classes
       (sport, level, coach_id, assistant_id, court_id, capacity, rrule, duration_min, start_on, end_on, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft')
     returning *`,
    [
      sport,
      level,
      coach_id,
      str(b.assistant_id) ?? null,
      court_id,
      capacity,
      rrule,
      duration_min,
      start_on,
      end_on,
    ],
  );
  await audit(sql, user.id, "create_class", "class", (row as { id: string }).id);
  return { status: 201, body: row };
}

export async function materializeClassSessions(
  sql: Sql,
  id: string,
  actorId: string | null,
) {
  const cl = await one<{
    id: string;
    status: string;
    court_id: string;
    coach_id: string;
    assistant_id: string | null;
    rrule: string;
    duration_min: number;
    start_on: string;
    end_on: string;
  }>(sql, `select * from classes where id = $1 for update`, [id]);
  if (!cl) throw err.notFound();
  if (cl.status === "cancelled") throw err.conflictState("That class is cancelled.");
  const from = new Date();
  const until = new Date(Date.now() + 14 * 86400000);
  const todayStr = ictDateString(from);
  const todayStart = ictDateTime(todayStr, "00:00");
  const windowStart = cl.start_on >= todayStr ? ictDateTime(cl.start_on, "00:00") : todayStart;
  const windowEnd = cl.end_on < ictDateString(until) ? ictDateTime(cl.end_on, "23:59") : until;
  const occs = expandWeekly(cl.rrule, cl.duration_min, windowStart, windowEnd);
  const { slot_minutes } = await getSettings(sql);
  const created: unknown[] = [];
  const skipped: unknown[] = [];
  for (const o of occs) {
    const exists = await one(
      sql,
      `select id from sessions
        where class_id = $1 and (start_at = $2 or original_start_at = $2)`,
      [id, o.start.toISOString()],
    );
    if (exists) continue;
    const sid = (await one<{ id: string }>(sql, `select gen_random_uuid() as id`))!.id;
    // The court is held for whole slots; the session keeps its declared times.
    const held = slotSpan(o.start, o.end, slot_minutes);
    const courtBusy = await one(
      sql,
      `select 1 from occupancies
        where court_id = $1
          and tstzrange(start_at, end_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
        limit 1`,
      [cl.court_id, held.start.toISOString(), held.end.toISOString()],
    );
    const coaches = [cl.coach_id, cl.assistant_id].filter(Boolean);
    let coachBusy = false;
    for (const cid of coaches) {
      const hit = await one(
        sql,
        `select 1 from coach_occupancies
          where coach_id = $1
            and tstzrange(start_at, end_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
          limit 1`,
        [cid, o.start.toISOString(), o.end.toISOString()],
      );
      if (hit) {
        coachBusy = true;
        break;
      }
    }
    if (courtBusy || coachBusy) {
      skipped.push({ start_at: o.start.toISOString(), reason: courtBusy ? "court" : "coach" });
      if (actorId) {
        await enqueue(
          sql,
          "inapp",
          "class_changed",
          actorId,
          { class_id: id, reason: "conflict", start: o.start.toISOString() },
          `class_conflict|${id}|${o.start.toISOString()}`,
        );
      }
      continue;
    }
    try {
      await sql.query("savepoint sp_occ");
      const occ = await one<{ occupancy_attach: string }>(
        sql,
        `select occupancy_attach($1::uuid, $2::timestamptz, $3::timestamptz, 'session'::occ_kind, $4::uuid, null) as occupancy_attach`,
        [cl.court_id, held.start.toISOString(), held.end.toISOString(), sid],
      );
      await sql.query(
        `insert into sessions (id, class_id, court_id, start_at, end_at, status, occupancy_id)
         values ($1,$2,$3,$4,$5,'scheduled',$6)`,
        [sid, id, cl.court_id, o.start.toISOString(), o.end.toISOString(), occ!.occupancy_attach],
      );
      await sql.query(
        `insert into coach_occupancies (coach_id, session_id, start_at, end_at) values ($1,$2,$3,$4)`,
        [cl.coach_id, sid, o.start.toISOString(), o.end.toISOString()],
      );
      if (cl.assistant_id) {
        await sql.query(
          `insert into coach_occupancies (coach_id, session_id, start_at, end_at) values ($1,$2,$3,$4)`,
          [cl.assistant_id, sid, o.start.toISOString(), o.end.toISOString()],
        );
      }
      await sql.query("release savepoint sp_occ");
      created.push({ id: sid, start_at: o.start.toISOString() });
    } catch (e) {
      try {
        await sql.query("rollback to savepoint sp_occ");
      } catch {
        /* ignore */
      }
      if (isConflictSlot(e) || (e instanceof Error && /CONFLICT_SLOT/.test(e.message))) {
        skipped.push({ start_at: o.start.toISOString() });
        if (actorId) {
          await enqueue(
            sql,
            "inapp",
            "class_changed",
            actorId,
            { class_id: id, reason: "conflict", start: o.start.toISOString() },
            `class_conflict|${id}|${o.start.toISOString()}`,
          );
        }
        continue;
      }
      throw e;
    }
  }
  return { created, skipped };
}

export async function classesPublish(sql: Sql, id: string, user: PublicUser) {
  requireRole(user, ["manager"]);
  const result = await materializeClassSessions(sql, id, user.id);
  if (!result.created.length && result.skipped.length) {
    const any = await one(sql, `select 1 from sessions where class_id = $1 and status = 'scheduled' limit 1`, [id]);
    if (!any) throw err.conflict("Every date of this class clashes with a court booking or the coach's other classes.");
  }
  await sql.query(`update classes set status = 'open' where id = $1`, [id]);
  return { status: 200, body: { sessions: result.created, skipped: result.skipped } };
}

export async function classesEnroll(sql: Sql, id: string, request: Request, user: PublicUser) {
  if (!["member", "receptionist", "manager"].includes(user.role)) throw err.forbidden();
  const b = await request.headers.get("content-type") ? await readJson(request) : {};
  const userId =
    user.role === "member" ? user.id : (str(b.user_id) ?? user.id);
  if (user.role === "member" && str(b.user_id) && str(b.user_id) !== user.id) {
    throw err.forbidden();
  }
  const cl = await one<{
    id: string;
    status: string;
    sport: string;
    capacity: number;
    enrolled_count: number;
  }>(sql, `select * from classes where id = $1`, [id]);
  if (!cl) throw err.notFound();
  if (cl.status !== "open") throw err.br("BR-18", "That class is not open yet.");
  const sub = await classSubscription(sql, userId, cl.sport);
  if (!sub) throw err.br("BR-19", "You need an active plan covering this sport.");
  if (sub.session_left != null && sub.session_left <= 0) throw err.br("BR-20", "You have no sessions left.");
  const overlap = await one(
    sql,
    `select 1
       from sessions s
       join enrollments e on e.class_id = s.class_id and e.user_id = $1 and e.status = 'confirmed'
      where e.class_id <> $2
        and s.status = 'scheduled'
        and exists (
          select 1 from sessions s2
           where s2.class_id = $2 and s2.status = 'scheduled'
             and tstzrange(s.start_at, s.end_at, '[)') && tstzrange(s2.start_at, s2.end_at, '[)')
        )
      limit 1`,
    [userId, id],
  );
  if (overlap) throw err.br("BR-22", "This clashes with another class you are in.");
  // Sessions are only laid out two weeks ahead, so the weekly timetables are compared too.
  const target = await one<ClassPattern>(
    sql,
    `select rrule, duration_min, start_on::text, end_on::text from classes where id = $1`,
    [id],
  );
  const others = await sql.query(
    `select cl.rrule, cl.duration_min, cl.start_on::text, cl.end_on::text
       from classes cl
       join enrollments e on e.class_id = cl.id and e.user_id = $1 and e.status = 'confirmed'
      where cl.id <> $2 and cl.status <> 'cancelled'`,
    [userId, id],
  );
  if (target && (others as ClassPattern[]).some((o) => classPatternsClash(target, o))) {
    throw err.br("BR-22", "This clashes with another class you are in.");
  }
  const pendingOffers = await one<{ n: number }>(
    sql,
    `select count(*)::int as n
       from waitlist_offers o
       join enrollments e on e.id = o.enrollment_id
      where e.class_id = $1 and o.status = 'pending' and o.expires_at > now()`,
    [id],
  );
  const reservedSeats = (cl.enrolled_count ?? 0) + (pendingOffers?.n ?? 0);
  if (reservedSeats >= cl.capacity) {
    try {
      const wl = await one<{ enrollment_waitlist: string }>(
        sql,
        `select enrollment_waitlist($1::uuid, $2::uuid) as enrollment_waitlist`,
        [id, userId],
      );
      const enr = await one(sql, `select * from enrollments where id = $1`, [wl!.enrollment_waitlist]);
      return { status: 201, body: { enrollment: enr, waitlisted: true } };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("ALREADY_ENROLLED")) throw err.br("BR-22", "You are already enrolled.");
      throw e;
    }
  }
  await sql.query("savepoint sp_enroll");
  try {
    const row = await one<{ enrollment_confirm: string }>(
      sql,
      `select enrollment_confirm($1::uuid, $2::uuid) as enrollment_confirm`,
      [id, userId],
    );
    await sql.query("release savepoint sp_enroll");
    if (sub.session_left != null) {
      await sql.query(
        `update subscriptions set session_left = session_left - 1
          where id = $1 and session_left > 0`,
        [sub.id],
      );
    }
    const enr = await one(sql, `select * from enrollments where id = $1`, [row!.enrollment_confirm]);
    return { status: 201, body: { enrollment: enr } };
  } catch (e) {
    try {
      await sql.query("rollback to savepoint sp_enroll");
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("CLASS_FULL")) {
      const wl = await one<{ enrollment_waitlist: string }>(
        sql,
        `select enrollment_waitlist($1::uuid, $2::uuid) as enrollment_waitlist`,
        [id, userId],
      );
      const enr = await one(sql, `select * from enrollments where id = $1`, [wl!.enrollment_waitlist]);
      return { status: 201, body: { enrollment: enr, waitlisted: true } };
    }
    if (msg.includes("ALREADY_ENROLLED")) throw err.br("BR-22", "You are already enrolled.");
    throw e;
  }
}

export async function enrollmentDelete(sql: Sql, id: string, user: PublicUser) {
  const enr = await one<{
    id: string;
    class_id: string;
    user_id: string;
    status: string;
  }>(sql, `select * from enrollments where id = $1 for update`, [id]);
  if (!enr) throw err.notFound();
  if (user.role === "member" && enr.user_id !== user.id) throw err.forbidden();
  if (user.role === "coach") {
    const cl = await one<{ coach_id: string; assistant_id: string | null }>(
      sql,
      `select coach_id, assistant_id from classes where id = $1`,
      [enr.class_id],
    );
    if (!cl) throw err.notFound();
    assertClassStaff(cl, user);
  }
  if (enr.status === "waitlisted") {
    await sql.query(`update enrollments set status = 'cancelled', waitlist_pos = null where id = $1`, [id]);
    return { status: 200, body: { ok: true } };
  }
  if (enr.status !== "confirmed") throw err.conflictState();
  const settings = await getSettings(sql);
  const next = await one<{ start_at: string }>(
    sql,
    `select start_at from sessions
      where class_id = $1 and status = 'scheduled' and start_at > now()
      order by start_at limit 1`,
    [enr.class_id],
  );
  if (next) {
    const hours = (new Date(next.start_at).getTime() - Date.now()) / 3600000;
    if (hours < settings.cancel_class_hours) {
      throw err.br("BR-24", "Cancel at least 4 hours before the next session.");
    }
  }
  await sql.query(`update enrollments set status = 'cancelled', waitlist_pos = null where id = $1`, [id]);
  await sql.query(
    `update classes set enrolled_count = greatest(enrolled_count - 1, 0) where id = $1`,
    [enr.class_id],
  );
  const cl = await one<{ sport: string }>(sql, `select sport from classes where id = $1`, [enr.class_id]);
  if (cl) {
    const sub = await classSubscription(sql, enr.user_id, cl.sport);
    if (sub?.session_left != null) {
      await sql.query(`update subscriptions set session_left = session_left + 1 where id = $1`, [sub.id]);
    }
  }
  await inviteWaitlist(sql, enr.class_id);
  return { status: 200, body: { ok: true } };
}

export async function coachSchedule(sql: Sql, user: PublicUser) {
  requireRole(user, ["coach", "manager"]);
  const items = await sql.query(
    `select s.id, s.start_at, s.end_at, s.status, cl.level, cl.sport, cl.id as class_id,
            cl.capacity, cl.enrolled_count, c.court_code
       from sessions s
       join classes cl on cl.id = s.class_id
       join courts c on c.id = s.court_id
      where ($2::boolean or cl.coach_id = $1 or cl.assistant_id = $1)
        and s.start_at > now() - interval '1 day'
      order by s.start_at
      limit 80`,
    [user.id, user.role === "manager"],
  );
  return {
    status: 200,
    body: { items: items.map((s) => ({ ...s, class_code: classCode(String(s.sport), String(s.level), String(s.class_id)) })) },
  };
}

export async function coachClasses(sql: Sql, user: PublicUser) {
  requireRole(user, ["coach", "manager"]);
  const items = await sql.query(
    `select cl.id, cl.sport, cl.level, cl.capacity, cl.enrolled_count, cl.rrule, cl.duration_min,
            cl.start_on::text, cl.end_on::text, cl.status, cl.court_id, c.court_code,
            cl.coach_id, u.full_name as coach_name,
            (select count(*)::int from sessions s where s.class_id = cl.id and s.status = 'scheduled') as upcoming_sessions_count
       from classes cl
       join courts c on c.id = cl.court_id
       join users u on u.id = cl.coach_id
      where ($2::boolean or cl.coach_id = $1 or cl.assistant_id = $1)
      order by cl.status = 'open' desc, cl.start_on desc`,
    [user.id, user.role === "manager"],
  );
  return {
    status: 200,
    body: {
      total: items.length,
      items: items.map((c) => ({ ...c, code: classCode(String(c.sport), String(c.level), String(c.id)) })),
    },
  };
}

/**
 * One class, opened (B-08 / D-07).
 *
 * The manager list showed a card and nothing behind it. This is what is behind
 * it: the class itself, every session with its date, time, court and headcount,
 * and who is on the roster. Reception sees the same thing the manager does; a
 * coach sees only a class they teach.
 */
export async function classDetail(sql: Sql, classId: string, user: PublicUser) {
  requireRole(user, ["manager", "receptionist", "coach"]);
  const cl = await one<{
    id: string;
    sport: string;
    level: string;
    status: string;
    capacity: number;
    enrolled_count: number;
    rrule: string;
    duration_min: number;
    start_on: string;
    end_on: string;
    court_id: string;
    court_code: string;
    coach_id: string;
    assistant_id: string | null;
    coach_name: string;
    assistant_name: string | null;
  }>(
    sql,
    `select cl.id, cl.sport::text as sport, cl.level, cl.status::text as status, cl.capacity, cl.enrolled_count,
            cl.rrule, cl.duration_min, cl.start_on::text as start_on, cl.end_on::text as end_on,
            cl.court_id, c.court_code, cl.coach_id, cl.assistant_id,
            co.full_name as coach_name, asst.full_name as assistant_name
       from classes cl
       join courts c on c.id = cl.court_id
       join users co on co.id = cl.coach_id
       left join users asst on asst.id = cl.assistant_id
      where cl.id = $1`,
    [classId],
  );
  if (!cl) throw err.notFound("No such class.");
  if (user.role === "coach" && cl.coach_id !== user.id && cl.assistant_id !== user.id) throw err.forbidden();

  // `headcount` is who is expected for a session still to come, and who turned
  // up (present or late) for one already taken.
  const sessions = await sql.query(
    `select s.id, s.start_at, s.end_at, s.status::text as status, ct.court_code,
            case when s.status = 'done'
                 then (select count(*) from attendance a
                        where a.session_id = s.id and a.result in ('present','late'))::int
                 else $2::int end as headcount
       from sessions s
       join courts ct on ct.id = s.court_id
      where s.class_id = $1
      order by s.start_at`,
    [classId, cl.enrolled_count],
  );
  const roster = await sql.query(
    `select u.id, u.full_name, u.member_code, u.phone, e.status::text as status
       from enrollments e join users u on u.id = e.user_id
      where e.class_id = $1 and e.status in ('confirmed','waitlisted')
      order by e.status, e.waitlist_pos nulls first, u.full_name`,
    [classId],
  );
  return {
    status: 200,
    body: {
      class: { ...cl, code: classCode(cl.sport, cl.level, cl.id) },
      sessions,
      roster,
    },
  };
}

export async function classRoster(sql: Sql, classId: string, user: PublicUser) {
  requireRole(user, ["coach", "manager", "receptionist"]);
  const cl = await one<{ coach_id: string; assistant_id: string | null }>(
    sql,
    `select coach_id, assistant_id from classes where id = $1`,
    [classId],
  );
  if (!cl) throw err.notFound();
  if (user.role === "coach" && cl.coach_id !== user.id && cl.assistant_id !== user.id) {
    throw err.forbidden();
  }
  const items = await sql.query(
    `select u.id, u.full_name, u.member_code, u.health_notes, e.status, e.id as enrollment_id
       from enrollments e
       join users u on u.id = e.user_id
      where e.class_id = $1 and e.status = 'confirmed'
      order by u.full_name`,
    [classId],
  );
  return { status: 200, body: { items } };
}

/* ------------------------------------------------------------------ *
 * Phase 4A — class lifecycle (FR-CLS: cancel / move a session, change *
 * the coach, close or cancel a class).                                *
 * ------------------------------------------------------------------ */

/** BR-27: a session may be moved freely only this long before its old time. */
const MOVE_FREE_HOURS = 12;

type SessionRow = {
  id: string;
  class_id: string;
  court_id: string;
  start_at: string;
  end_at: string;
  status: string;
  occupancy_id: string | null;
  original_start_at: string | null;
  sport: string;
  level: string;
  coach_id: string;
  assistant_id: string | null;
  class_end_on: string | null;
};

async function lockSession(sql: Sql, sessionId: string): Promise<SessionRow> {
  const s = await one<SessionRow>(
    sql,
    `select s.id, s.class_id, s.court_id, s.start_at, s.end_at, s.status::text as status, s.occupancy_id,
            s.original_start_at, cl.sport::text as sport, cl.level, cl.coach_id, cl.assistant_id,
            cl.end_on::text as class_end_on
       from sessions s join classes cl on cl.id = s.class_id
      where s.id = $1
      for update of s`,
    [sessionId],
  );
  if (!s) throw err.notFound("No such session.");
  return s;
}

async function confirmedMembers(sql: Sql, classId: string): Promise<string[]> {
  const rows = await sql.query(
    `select user_id from enrollments where class_id = $1 and status = 'confirmed'`,
    [classId],
  );
  return rows.map((r) => String(r.user_id));
}

/** Everyone a class change touches: the roster plus the coaches on it. */
async function notifyClass(
  sql: Sql,
  classId: string,
  people: string[],
  payload: Record<string, unknown>,
  key: string,
) {
  for (const uid of new Set(people)) {
    await enqueue(sql, "inapp", "class_changed", uid, { class_id: classId, ...payload }, `${key}|${uid}`);
  }
}

/** BR-29: a per-session plan gets the session back; a time-based plan has nothing to give back. */
async function giveSessionBack(sql: Sql, userId: string, sport: string): Promise<boolean> {
  const sub = await classSubscription(sql, userId, sport);
  if (sub?.session_left == null) return false;
  await sql.query(`update subscriptions set session_left = session_left + 1 where id = $1`, [sub.id]);
  return true;
}

function reasonOf(b: Record<string, unknown>): string | undefined {
  const r = str(b.reason);
  return r ? r.slice(0, 300) : undefined;
}

/** Cancel one session of a class (FR-CLS-04, BR-29). */
export async function sessionCancel(sql: Sql, sessionId: string, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const b = await readJson(request);
  const reason = reasonOf(b);
  if (!reason) throw err.field("reason", "Give a reason for cancelling this session.");
  const s = await lockSession(sql, sessionId);
  if (s.status !== "scheduled") throw err.conflictState("Only a scheduled session can be cancelled.");
  if (new Date(s.end_at).getTime() <= Date.now()) throw err.conflictState("That session has already finished.");

  await sql.query(`select occupancy_release_session($1::uuid, 'cancelled'::session_status)`, [sessionId]);
  await sql.query(`update sessions set change_reason = $2 where id = $1`, [sessionId, reason]);

  const members = await confirmedMembers(sql, s.class_id);
  let refunded = 0;
  for (const uid of members) {
    if (await giveSessionBack(sql, uid, s.sport)) refunded += 1;
  }
  await notifyClass(
    sql,
    s.class_id,
    [...members, s.coach_id, ...(s.assistant_id ? [s.assistant_id] : [])],
    { kind: "session_cancelled", session_id: sessionId, start: s.start_at, reason },
    `session_cancel|${sessionId}`,
  );
  await audit(sql, user.id, "cancel_session", "session", sessionId, { status: "scheduled", start_at: s.start_at }, { status: "cancelled", reason });
  return { status: 200, body: { ok: true, notified: members.length, refunded } };
}

/** Move one session to another time (FR-CLS-05, BR-26, BR-27). Same court, same coach. */
export async function sessionReschedule(sql: Sql, sessionId: string, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const b = await readJson(request);
  const startRaw = str(b.start_at);
  const newStart = startRaw ? new Date(startRaw) : null;
  if (!newStart || Number.isNaN(newStart.getTime())) throw err.field("start_at", "Pick the new start time.");
  if (newStart.getTime() <= Date.now()) throw err.field("start_at", "The new time must be in the future.");
  const s = await lockSession(sql, sessionId);
  if (s.status !== "scheduled") throw err.conflictState("Only a scheduled session can be moved.");
  const oldStart = new Date(s.start_at);
  const length = new Date(s.end_at).getTime() - oldStart.getTime();
  if (oldStart.getTime() <= Date.now()) throw err.conflictState("That session has already started.");
  if (newStart.getTime() === oldStart.getTime()) throw err.field("start_at", "That is the time it already has.");

  const settings = await getSettings(sql);
  assertSlotGrid(newStart, settings);
  const newStartDate = ictDateString(newStart);
  if (s.class_end_on && newStartDate > s.class_end_on) {
    throw err.field("start_at", "Cannot reschedule past class end date.");
  }
  const newEnd = new Date(newStart.getTime() + length);
  const close = ictDateTime(newStartDate, settings.close_time.slice(0, 5));
  if (newEnd > close) {
    throw err.field("start_at", "Session would end after closing time.");
  }

  const reason = reasonOf(b);
  const hoursAhead = (oldStart.getTime() - Date.now()) / 3600000;
  if (hoursAhead < MOVE_FREE_HOURS && !reason) {
    throw err.br(
      "BR-27",
      `This session starts in under ${MOVE_FREE_HOURS} hours — give a reason to move it.`,
      { field: "reason" },
    );
  }

  const { slot_minutes } = settings;
  const held = slotSpan(newStart, newEnd, slot_minutes);
  try {
    // Moved in place, so the session's own old slot never counts as a clash.
    await sql.query(`update occupancies set start_at = $2, end_at = $3 where id = $1`, [
      s.occupancy_id,
      held.start.toISOString(),
      held.end.toISOString(),
    ]);
    await sql.query(`update coach_occupancies set start_at = $2, end_at = $3 where session_id = $1`, [
      sessionId,
      newStart.toISOString(),
      newEnd.toISOString(),
    ]);
    await sql.query(
      `update sessions
          set start_at = $2, end_at = $3,
              original_start_at = coalesce(original_start_at, start_at),
              change_reason = $4
        where id = $1`,
      [sessionId, newStart.toISOString(), newEnd.toISOString(), reason ?? null],
    );
  } catch (e) {
    if (isConflictSlot(e)) throw err.conflictSlot("The court or the coach is busy at that time.");
    throw e;
  }

  const members = await confirmedMembers(sql, s.class_id);
  await notifyClass(
    sql,
    s.class_id,
    [...members, s.coach_id, ...(s.assistant_id ? [s.assistant_id] : [])],
    {
      kind: "session_moved",
      session_id: sessionId,
      from: s.start_at,
      start: newStart.toISOString(),
      ...(reason ? { reason } : {}),
    },
    `session_move|${sessionId}|${newStart.toISOString()}`,
  );
  await audit(
    sql,
    user.id,
    "reschedule_session",
    "session",
    sessionId,
    { start_at: s.start_at, end_at: s.end_at },
    { start_at: newStart.toISOString(), end_at: newEnd.toISOString(), reason: reason ?? null },
  );
  return { status: 200, body: { ok: true, start_at: newStart.toISOString(), end_at: newEnd.toISOString() } };
}

/** Put another coach on a class from now on (FR-CLS-06, BR-25, BR-28). */
export async function classesAssignCoach(sql: Sql, classId: string, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const b = await readJson(request);
  const coachId = str(b.coach_id);
  if (!coachId) throw err.field("coach_id", "Choose the new coach.");
  const cl = await one<{
    id: string;
    sport: string;
    status: string;
    coach_id: string;
    assistant_id: string | null;
  }>(sql, `select id, sport::text as sport, status::text as status, coach_id, assistant_id from classes where id = $1 for update`, [classId]);
  if (!cl) throw err.notFound("No such class.");
  if (cl.status === "cancelled") throw err.conflictState("That class is cancelled.");
  if (coachId === cl.coach_id) throw err.field("coach_id", "That coach already teaches this class.");
  if (coachId === cl.assistant_id) throw err.field("coach_id", "That coach is already the assistant.");
  const coach = await one<{ role: string; full_name: string }>(
    sql,
    `select role::text as role, full_name from users where id = $1`,
    [coachId],
  );
  if (!coach || coach.role !== "coach") throw err.br("BR-25", "That coach is not valid.");
  const sportOk = await one(
    sql,
    `select 1 from coach_sports where user_id = $1 and (sport::text = $2 or sport::text = 'all')`,
    [coachId, cl.sport],
  );
  if (!sportOk) throw err.br("BR-25", "That coach is not assigned to this sport.");

  const upcoming = await sql.query(
    `select s.id, s.start_at from sessions s
      where s.class_id = $1 and s.status = 'scheduled' and s.start_at > now()
      order by s.start_at`,
    [classId],
  );
  const clashes: string[] = [];
  for (const s of upcoming) {
    try {
      await sql.query("savepoint sp_coach");
      await sql.query(`update coach_occupancies set coach_id = $2 where session_id = $1 and coach_id = $3`, [
        s.id,
        coachId,
        cl.coach_id,
      ]);
      await sql.query("release savepoint sp_coach");
    } catch (e) {
      await sql.query("rollback to savepoint sp_coach").catch(() => undefined);
      if (!isConflictSlot(e)) throw e;
      clashes.push(String(s.start_at));
    }
  }
  if (clashes.length) {
    throw err.conflictSlot("That coach is already teaching at some of this class's times (BR-26).", {
      sessions: clashes,
    });
  }
  await sql.query(`update classes set coach_id = $2 where id = $1`, [classId, coachId]);

  const members = await confirmedMembers(sql, classId);
  await notifyClass(
    sql,
    classId,
    [...members, cl.coach_id, coachId],
    { kind: "coach_changed", coach_name: coach.full_name, ...(reasonOf(b) ? { reason: reasonOf(b) } : {}) },
    `coach_change|${classId}|${coachId}|${upcoming.length}`,
  );
  await audit(sql, user.id, "change_coach", "class", classId, { coach_id: cl.coach_id }, { coach_id: coachId, sessions: upcoming.length });
  return { status: 200, body: { ok: true, sessions_moved: upcoming.length } };
}

/** Edit a class's capacity or level, close or reopen enrolment, or cancel it (FR-CLS-03/07). */
export async function classesPatch(sql: Sql, classId: string, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const b = await readJson(request);
  const cl = await one<{
    id: string;
    sport: string;
    level: string;
    status: string;
    capacity: number;
    enrolled_count: number;
    coach_id: string;
    assistant_id: string | null;
  }>(
    sql,
    `select id, sport::text as sport, level, status::text as status, capacity, enrolled_count, coach_id, assistant_id
       from classes where id = $1 for update`,
    [classId],
  );
  if (!cl) throw err.notFound("No such class.");
  if (cl.status === "cancelled") throw err.conflictState("That class is cancelled.");

  const status = str(b.status);
  if (status === "cancelled") return cancelClass(sql, cl, reasonOf(b), user);
  if (status !== undefined && !["open", "closed"].includes(status)) {
    throw err.field("status", "Status can be open, closed or cancelled.");
  }
  if (status && cl.status === "draft") throw err.conflictState("Publish the class before opening or closing it.");

  const capacity = b.capacity === undefined ? cl.capacity : num(b.capacity);
  if (capacity === undefined || !Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CLASS_CAPACITY) {
    throw err.field("capacity", `Capacity must be a whole number from 1 to ${MAX_CLASS_CAPACITY}.`);
  }
  if (capacity < cl.enrolled_count) {
    throw err.br("BR-21", `${cl.enrolled_count} members are already enrolled — capacity cannot go below that.`, {
      field: "capacity",
    });
  }
  const level = b.level === undefined ? cl.level : str(b.level);
  if (!level || level.length > 24) throw err.field("level", "Level is required (24 characters at most).");

  await sql.query(
    `update classes set capacity = $2, level = $3, status = coalesce($4::class_status, status) where id = $1`,
    [classId, capacity, level, status ?? null],
  );
  if (capacity > cl.capacity && (status ?? cl.status) === "open") await inviteWaitlist(sql, classId);
  const after = { capacity, level, status: status ?? cl.status };
  await audit(sql, user.id, "edit_class", "class", classId, { capacity: cl.capacity, level: cl.level, status: cl.status }, after);
  return { status: 200, body: { ok: true, class: { id: classId, ...after } } };
}

async function cancelClass(
  sql: Sql,
  cl: { id: string; sport: string; status: string; coach_id: string; assistant_id: string | null },
  reason: string | undefined,
  user: PublicUser,
) {
  if (!reason) throw err.field("reason", "Give a reason for cancelling this class.");
  const upcoming = await sql.query(
    `select id, start_at from sessions where class_id = $1 and status = 'scheduled' and end_at > now()`,
    [cl.id],
  );
  for (const s of upcoming) {
    await sql.query(`select occupancy_release_session($1::uuid, 'cancelled'::session_status)`, [s.id]);
    await sql.query(`update sessions set change_reason = $2 where id = $1`, [s.id, reason]);
  }
  const members = await confirmedMembers(sql, cl.id);
  const waiting = (
    await sql.query(`select user_id from enrollments where class_id = $1 and status = 'waitlisted'`, [cl.id])
  ).map((r) => String(r.user_id));
  // One refund each: enrolling is what spent the session, not each date.
  let refunded = 0;
  for (const uid of members) {
    if (await giveSessionBack(sql, uid, cl.sport)) refunded += 1;
  }
  await sql.query(
    `update waitlist_offers set status = 'expired'
      where status = 'pending' and enrollment_id in (select id from enrollments where class_id = $1)`,
    [cl.id],
  );
  await sql.query(
    `update enrollments set status = 'cancelled', waitlist_pos = null
      where class_id = $1 and status in ('confirmed','waitlisted')`,
    [cl.id],
  );
  await sql.query(`update classes set status = 'cancelled', enrolled_count = 0, cancel_reason = $2 where id = $1`, [
    cl.id,
    reason,
  ]);
  await notifyClass(
    sql,
    cl.id,
    [...members, ...waiting, cl.coach_id, ...(cl.assistant_id ? [cl.assistant_id] : [])],
    { kind: "class_cancelled", reason },
    `class_cancel|${cl.id}`,
  );
  await audit(sql, user.id, "cancel_class", "class", cl.id, { status: cl.status }, {
    status: "cancelled",
    reason,
    sessions: upcoming.length,
  });
  return {
    status: 200,
    body: { ok: true, sessions_cancelled: upcoming.length, notified: members.length + waiting.length, refunded },
  };
}

void addDays;
