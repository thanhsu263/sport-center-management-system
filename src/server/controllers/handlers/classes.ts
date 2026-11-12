import type { Sql } from "@/server/data/db";
import { err, isConflictSlot } from "../errors";
import { assertNoClassClash, assertUnderClassLimit, audit, enqueue, isUuid, getSettings, nextCode, num, readJson, str, type ClassPattern, classPatternsClash } from "../helpers";
import { classCode } from "../../../shared/arena3/labels";
import { expandWeekly } from "../../services/rrule";
import { avatarUrlSql, requireRole, withAvatarUrl, type PublicUser } from "../session";
import { addDays, classMinutes, ictDateString, ictDateTime, slotSpan } from "../../../shared/arena3/time";
import { quotePromo, redeemPromo } from "../../services/promos";
import { one } from "../tx";
import { compactWaitlist, inviteWaitlist } from "./ops";
import { lockEnrollmentLinks, withdrawLinks } from "../../integrations/payos";
import { assertClassStaff } from "./training";
import { assertSlotGrid } from "./bookings";
import { activeMembershipEnd, applyExtension, assertMembershipOutlastsClass, carryMembersToClassEnd, outlastsClass, planToOutlast, rollbackExtension } from "../../services/membership";

export const MAX_CLASS_CAPACITY = 200;
export const MAX_CLASS_PRICE_VND = 100_000_000;

/** A class price from a request body: null/"" clears it, a whole number of dong from 0 to 100,000,000 sets it. */
function parsePrice(raw: unknown): number | null {
  if (raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > MAX_CLASS_PRICE_VND) {
    throw err.field("price_vnd", "Price must be a whole number of dong, or empty.");
  }
  return n;
}

const CLASS_TEXT_LIMITS = { description: 2000, syllabus: 2000, who_for: 300, bring: 300 } as const;
type ClassTextKey = keyof typeof CLASS_TEXT_LIMITS;

/** Free text about a class (description, syllabus, who it is for, what to bring): empty clears it. */
function parseClassText(key: ClassTextKey, raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw err.field(key, "Text expected.");
  const v = raw.replace(/\r\n/g, "\n").trim();
  if (v.length > CLASS_TEXT_LIMITS[key]) throw err.field(key, `${CLASS_TEXT_LIMITS[key]} characters at most.`);
  return v === "" ? null : v;
}

/** The minimum to run a class: empty for none, otherwise a whole number from 1 up to the capacity. */
function parseMinEnrolled(raw: unknown, capacity: number): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = num(raw);
  if (n === undefined || !Number.isInteger(n) || n < 1 || n > capacity) {
    throw err.field("min_enrolled", "The minimum must be a whole number from 1 up to the capacity.");
  }
  return n;
}

export async function classesList(sql: Sql, request: Request, user: PublicUser | null) {
  const sport = new URL(request.url).searchParams.get("sport");
  const manager = user?.role === "manager";
  const items = await sql.query(
    `select cl.id, cl.sport, cl.level, cl.capacity, cl.enrolled_count, cl.rrule, cl.duration_min,
            cl.start_on::text, cl.end_on::text, cl.status, cl.court_id, c.court_code,
            cl.coach_id, u.full_name as coach_name, made.at as created_at, cl.price_vnd, cl.min_enrolled,
            cl.description, cl.syllabus, cl.who_for, cl.bring,
            case when me.id is null then null else jsonb_build_object(
              'id', me.id, 'status', me.status, 'hold_until', me.hold_until,
              'price_vnd', me.price_vnd, 'transfer_requested_at', me.transfer_requested_at) end as my_enrollment
       from classes cl
       join courts c on c.id = cl.court_id
       join users u on u.id = cl.coach_id
       left join lateral (
         select e.id, e.status, e.hold_until, e.price_vnd, e.transfer_requested_at
           from enrollments e
          where e.class_id = cl.id and e.user_id = $3::uuid and e.status <> 'cancelled'
          limit 1
       ) me on true
       left join lateral (
         select max(a.at) as at from audit_logs a
          where a.action = 'create_class' and a.entity_id = cl.id
       ) made on true
      where ($1 or cl.status = 'open')
        and ($2::text is null or cl.sport::text = $2)
      order by case cl.status when 'open' then 0 when 'closed' then 1 when 'draft' then 2 else 3 end,
               made.at desc nulls last, cl.start_on desc, cl.level`,
    [manager, sport, user && user.role === "member" ? user.id : null],
  );
  return {
    status: 200,
    body: { items: items.map((c) => ({ ...c, code: classCode(String(c.sport), String(c.level), String(c.id)) })) },
  };
}

export type { ClassPattern };
export { classPatternsClash };

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
  // Left out, the class gets the usual 12; sent but not a number (say "abc"), it is refused rather
  // than quietly turned into 12.
  const capacity = b.capacity === undefined || b.capacity === null || b.capacity === "" ? 12 : num(b.capacity);
  if (capacity !== undefined && capacity > MAX_CLASS_CAPACITY) {
    throw err.field("capacity", `Capacity cannot exceed ${MAX_CLASS_CAPACITY}.`);
  }
  if (capacity === undefined || !Number.isInteger(capacity) || capacity < 1) {
    throw err.field("capacity", `Capacity must be a whole number from 1 to ${MAX_CLASS_CAPACITY}.`);
  }
  const duration_min = classMinutes(num(b.duration_min));
  if (duration_min == null) {
    throw err.validation("A class runs for whole court hours (60, 120 or 180).");
  }
  const price_vnd = b.price_vnd === undefined ? null : parsePrice(b.price_vnd);
  const min_enrolled = parseMinEnrolled(b.min_enrolled, capacity);
  const texts = {
    description: parseClassText("description", b.description),
    syllabus: parseClassText("syllabus", b.syllabus),
    who_for: parseClassText("who_for", b.who_for),
    bring: parseClassText("bring", b.bring),
  };
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
       (sport, level, coach_id, assistant_id, court_id, capacity, rrule, duration_min, start_on, end_on, status, price_vnd, min_enrolled,
        description, syllabus, who_for, bring)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',$11,$12,$13,$14,$15,$16)
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
      price_vnd,
      min_enrolled,
      texts.description,
      texts.syllabus,
      texts.who_for,
      texts.bring,
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

/** The tuition, and whether this person's membership ends after the class. */
async function enrollmentQuote(
  sql: Sql,
  userId: string,
  cl: { end_on: string },
  tuition: number,
  promo: { code: string; name: string; discount_vnd: number } | null,
) {
  const currentEnd = await activeMembershipEnd(sql, userId);
  const eligible = outlastsClass(currentEnd, cl.end_on);
  const plans = eligible
    ? []
    : await sql.query<{ id: string; name: string; price_vnd: number; duration_months: number | null }>(
        `select id, name, price_vnd, duration_months from membership_plans
          where is_on_sale and duration_months is not null`,
      );
  return {
    tuition_vnd: tuition,
    promo: promo ? { code: promo.code, name: promo.name, discount_vnd: promo.discount_vnd } : null,
    total_vnd: tuition,
    eligible,
    current_end: currentEnd,
    class_end: cl.end_on,
    suggested_plan: eligible ? null : planToOutlast(plans, currentEnd ?? ictDateString(), cl.end_on),
  };
}

/** The same figures enrolment will charge, without holding a seat. */
export async function classQuote(sql: Sql, id: string, request: Request, user: PublicUser) {
  if (!["member", "receptionist", "manager"].includes(user.role)) throw err.forbidden();
  const params = new URL(request.url).searchParams;
  const userId = user.role === "member" ? user.id : (str(params.get("user_id")) ?? user.id);
  const cl = await one<{ status: string; sport: string; price_vnd: number | null; start_on: string; end_on: string }>(
    sql,
    `select status::text, sport::text as sport, price_vnd, start_on::text as start_on, end_on::text as end_on
       from classes where id = $1`,
    [id],
  );
  if (!cl) throw err.notFound();
  if (cl.status !== "open") throw err.br("BR-18", "That class is not open yet.");
  if (cl.price_vnd == null) throw err.br("BR-53", "This class is not open for sale yet.");
  await assertNoClassClash(sql, userId, id);
  const code = cl.price_vnd > 0 ? str(params.get("promo_code")) : null;
  const promo = code
    ? await quotePromo(sql, { code, userId, scope: "class", sport: cl.sport, orderVnd: cl.price_vnd })
    : null;
  const tuition = promo ? promo.final_vnd : cl.price_vnd;
  return { status: 200, body: await enrollmentQuote(sql, userId, cl, tuition, promo) };
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
    price_vnd: number | null;
    start_on: string;
    end_on: string;
  }>(sql, `select *, start_on::text as start_on, end_on::text as end_on from classes where id = $1`, [id]);
  if (!cl) throw err.notFound();
  if (cl.status !== "open") throw err.br("BR-18", "That class is not open yet.");
  if (cl.price_vnd == null) throw err.br("BR-53", "This class is not open for sale yet.");
  const settings = await getSettings(sql);
  await assertNoClassClash(sql, userId, id);
  await assertUnderClassLimit(sql, userId, id, settings.max_active_classes);
  await assertMembershipOutlastsClass(sql, userId, cl.end_on);
  const promoCode = cl.price_vnd > 0 ? str(b.promo_code) : null;
  const promo = promoCode
    ? await quotePromo(sql, { code: promoCode, userId, scope: "class", sport: cl.sport, orderVnd: cl.price_vnd })
    : null;
  const tuition = promo ? promo.final_vnd : cl.price_vnd;
  await sql.query("savepoint sp_enroll");
  try {
    const row = await one<{ enrollment_hold: string }>(
      sql,
      `select enrollment_hold($1::uuid, $2::uuid, $3::int, $4::int) as enrollment_hold`,
      [id, userId, settings.class_hold_minutes, cl.price_vnd],
    );
    const quote = await enrollmentQuote(sql, userId, cl, tuition, promo);
    const total = quote.total_vnd;
    await sql.query(
      `update enrollments set price_vnd = $2, promo_id = $3, promo_discount_vnd = $4
        where id = $1`,
      [row!.enrollment_hold, total, promo?.promo_id ?? null, promo?.discount_vnd ?? 0],
    );
    if (total === 0) {
      // Nothing to pay: the seat is confirmed at once.
      await sql.query(`update enrollments set status = 'confirmed', hold_until = null where id = $1`, [row!.enrollment_hold]);
    }
    await sql.query("release savepoint sp_enroll");
    const updatedClass = await one<{ enrolled_count: number; capacity: number }>(
      sql,
      `select enrolled_count, capacity from classes where id = $1`,
      [id],
    );
    if (updatedClass && updatedClass.enrolled_count >= updatedClass.capacity) {
      const pendingOffers = await sql.query<{ id: string; user_id: string }>(
        `select o.id, e.user_id
           from waitlist_offers o
           join enrollments e on e.id = o.enrollment_id
          where e.class_id = $1 and o.status = 'pending' and o.expires_at > now()`,
        [id],
      );
      for (const po of pendingOffers) {
        await sql.query(`update waitlist_offers set status = 'skipped' where id = $1`, [po.id]);
        await enqueue(sql, "inapp", "waitlist_seat_taken", po.user_id, { class_id: id, offer_id: po.id }, `wl_st|${po.id}`);
      }
    }
    const enr = await one(sql, `select * from enrollments where id = $1`, [row!.enrollment_hold]);
    return { status: 201, body: { enrollment: enr, quote } };
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

export type SettleOutcome =
  | "confirmed"
  | "already"
  | "duplicate"
  | "late_confirmed"
  | "late_no_seat"
  | "released"
  | "class_cancelled";

/** Outcomes where money landed without buying a seat: staff must handle them by hand. */
const FLAGGED: Record<string, string> = {
  late_no_seat: "enrollment_paid_no_seat",
  released: "enrollment_paid_released",
  class_cancelled: "enrollment_paid_class_cancelled",
  duplicate: "enrollment_paid_twice",
};

/**
 * Money for a class seat that bought no seat: write the audit row and tell the
 * desk. Every active receptionist and manager gets an in-app notification (the
 * same fan-out the absence alert uses for managers), keyed per payment and
 * per person, so a webhook retry does not notify twice.
 */
async function flagSeatPayment(
  sql: Sql,
  outcome: SettleOutcome,
  enrollmentId: string,
  classId: string,
  paymentId: string | null,
) {
  const action = FLAGGED[outcome];
  if (!action) return;
  await audit(sql, null, action, "enrollment", enrollmentId, null, paymentId ? { payment_id: paymentId } : null);
  const who = await one<{ user_id: string; full_name: string; sport: string; level: string }>(
    sql,
    `select e.user_id, u.full_name, c.sport::text as sport, c.level
       from enrollments e join users u on u.id = e.user_id join classes c on c.id = e.class_id
      where e.id = $1`,
    [enrollmentId],
  );
  const staff = await sql.query<{ id: string }>(
    `select id from users where role in ('receptionist','manager') and status = 'active'`,
  );
  for (const s of staff) {
    await enqueue(
      sql,
      "inapp",
      "class_payment_exception",
      s.id,
      {
        reason: outcome,
        enrollment_id: enrollmentId,
        class_id: classId,
        payment_id: paymentId,
        user_id: who?.user_id ?? null,
        member_name: who?.full_name ?? null,
        sport: who?.sport ?? null,
        level: who?.level ?? null,
      },
      `class_pay_exc|${paymentId ?? enrollmentId}|${outcome}|${s.id}`,
    );
  }
}

/**
 * Money has arrived for a class seat: turn the hold into a confirmed seat.
 *
 * This is the one place that decides whether a payment still buys a seat, so
 * the desk, payOS and any later path agree. Locks the class, then the enrolment
 * (the order enrollment_hold uses). The callers that hold a payment row lock it
 * before calling, so the full order is payment → class → enrolment.
 *
 * - The class was cancelled: nobody is seated; the money is flagged.
 * - The seat is held: it is confirmed.
 * - It is already confirmed: by this payment (a retry) is fine; by another
 *   payment is a double charge, flagged.
 * - The member released the hold (`released`): not re-seated; flagged.
 * - The hold lapsed: seated again only if a seat is free, otherwise flagged.
 *
 * A flagged outcome still leaves the payment posted (money did arrive); the
 * audit row and a notification to the desk make it a by-hand exception.
 */
/** The code priced into the seat counts as used once the money for it has posted (BR-41). */
async function redeemEnrollmentPromo(sql: Sql, enrollmentId: string, paymentId: string | null | undefined) {
  if (!paymentId) return;
  const e = await one<{ user_id: string; promo_id: string | null; promo_discount_vnd: number }>(
    sql,
    `select user_id, promo_id, promo_discount_vnd from enrollments where id = $1`,
    [enrollmentId],
  );
  if (e?.promo_id) {
    await redeemPromo(sql, { promoId: e.promo_id, userId: e.user_id, paymentId, discountVnd: e.promo_discount_vnd });
  }
}

export async function settleEnrollment(
  sql: Sql,
  enrollmentId: string,
  opts: { paymentId?: string | null; released?: boolean } = {},
): Promise<{ outcome: SettleOutcome }> {
  const paymentId = opts.paymentId ?? null;
  const pre = await one<{ class_id: string }>(sql, `select class_id from enrollments where id = $1`, [enrollmentId]);
  if (!pre) throw err.notFound();
  const cl = await one<{ enrolled_count: number; capacity: number; status: string }>(
    sql,
    `select enrolled_count, capacity, status::text as status from classes where id = $1 for update`,
    [pre.class_id],
  );
  if (!cl) throw err.notFound();
  const enr = await one<{ id: string; class_id: string; status: string }>(
    sql,
    `select id, class_id, status::text as status from enrollments where id = $1 for update`,
    [enrollmentId],
  );
  if (!enr) throw err.notFound();
  const done = async (outcome: SettleOutcome) => {
    await flagSeatPayment(sql, outcome, enrollmentId, enr.class_id, paymentId);
    return { outcome };
  };
  if (cl.status !== "open" && cl.status !== "closed" && enr.status !== "confirmed") {
    return done("class_cancelled");
  }
  if (enr.status === "hold") {
    await sql.query(
      `update enrollments set status = 'confirmed', hold_until = null, transfer_requested_at = null where id = $1`,
      [enrollmentId],
    );
    await applyExtension(sql, enrollmentId);
    await redeemEnrollmentPromo(sql, enrollmentId, paymentId);
    return { outcome: "confirmed" };
  }
  if (enr.status === "confirmed") {
    if (paymentId) {
      const other = await one(
        sql,
        `select 1 from payments
          where ref_type = 'enrollment' and ref_id = $1 and id <> $2 and status = 'posted' and amount_vnd > 0
          limit 1`,
        [enrollmentId, paymentId],
      );
      if (other) return done("duplicate");
    }
    return { outcome: "already" };
  }
  if (opts.released && enr.status === "cancelled") return done("released");
  if (cl.enrolled_count < cl.capacity) {
    await sql.query(`update classes set enrolled_count = enrolled_count + 1 where id = $1`, [enr.class_id]);
    await sql.query(
      `update enrollments set status = 'confirmed', hold_until = null, transfer_requested_at = null, waitlist_pos = null where id = $1`,
      [enrollmentId],
    );
    await applyExtension(sql, enrollmentId);
    await redeemEnrollmentPromo(sql, enrollmentId, paymentId);
    return { outcome: "late_confirmed" };
  }
  return done("late_no_seat");
}

/** The member says they have paid by bank transfer: the hold gets the longer transfer clock. */
export async function enrollmentTransfer(sql: Sql, id: string, user: PublicUser) {
  if (!isUuid(id)) throw err.notFound();
  const enr = await one<{
    user_id: string;
    status: string;
    hold_until: string | null;
    transfer_requested_at: string | null;
    class_status: string;
  }>(
    sql,
    `select e.user_id, e.status::text as status, e.hold_until, e.transfer_requested_at, c.status::text as class_status
       from enrollments e join classes c on c.id = e.class_id
      where e.id = $1 for update of e`,
    [id],
  );
  if (!enr) throw err.notFound();
  if (enr.user_id !== user.id) throw err.forbidden();
  if (enr.class_status === "cancelled") throw err.br("BR-18", "That class is cancelled.");
  if (enr.status === "hold" && enr.transfer_requested_at) {
    throw err.conflictState("Reception is already checking the bank for this one.");
  }
  if (enr.status !== "hold" || !enr.hold_until || new Date(enr.hold_until) <= new Date()) {
    throw err.br("BR-28", "This seat hold has expired.");
  }
  const settings = await getSettings(sql);
  await sql.query(
    `update enrollments
        set hold_until = now() + ($2::int * interval '1 minute'), transfer_requested_at = now()
      where id = $1`,
    [id, settings.transfer_hold_minutes],
  );
  const fresh = await one(sql, `select * from enrollments where id = $1`, [id]);
  return { status: 200, body: { enrollment: fresh } };
}

export async function enrollmentDelete(sql: Sql, id: string, user: PublicUser) {
  const enr = await one<{
    id: string;
    class_id: string;
    user_id: string;
    status: string;
  }>(sql, `select * from enrollments where id = $1`, [id]);
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
  // Lock order is payment → class → enrolment, the order settleOnline uses (it locks the payment
  // row, then settleEnrollment locks the class and the enrolment). A hold's pending payOS links are
  // locked first, then the class, then the row is re-read so a payment or expiry that just landed is seen.
  const links = enr.status === "hold" ? await lockEnrollmentLinks(sql, [id]) : [];
  await sql.query(`select 1 from classes where id = $1 for update`, [enr.class_id]);
  const locked = await one<{ status: string }>(sql, `select status::text as status from enrollments where id = $1 for update`, [id]);
  if (!locked) throw err.notFound();
  enr.status = locked.status;
  if (enr.status === "hold") {
    // Nothing has been paid for a hold, so letting it go has no cutoff and nothing to refund.
    await sql.query(`update enrollments set status = 'cancelled', waitlist_pos = null, hold_until = null where id = $1`, [id]);
    await sql.query(`update classes set enrolled_count = greatest(enrolled_count - 1, 0) where id = $1`, [enr.class_id]);
    // Withdraw the link at payOS so a late scan cannot take money for a seat the member gave up.
    // RELEASED tells settleOnline, should money still arrive, not to seat the member again.
    await withdrawLinks(sql, links, "Seat released", "RELEASED");
    await inviteWaitlist(sql, enr.class_id);
    return { status: 200, body: { ok: true } };
  }
  if (enr.status === "waitlisted") {
    await sql.query(`update enrollments set status = 'cancelled', waitlist_pos = null where id = $1`, [id]);
    await compactWaitlist(sql, enr.class_id);
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
      throw err.br("BR-24", `Cancel at least ${settings.cancel_class_hours} hours before the next session.`);
    }
  }
  // A member leaving a class gets nothing back: tuition and extension stay paid, the end date stays.
  await sql.query(`update enrollments set status = 'cancelled', waitlist_pos = null where id = $1`, [id]);
  await sql.query(
    `update classes set enrolled_count = greatest(enrolled_count - 1, 0) where id = $1`,
    [enr.class_id],
  );
  await inviteWaitlist(sql, enr.class_id);
  return { status: 200, body: { ok: true } };
}

export async function coachSchedule(sql: Sql, user: PublicUser) {
  requireRole(user, ["coach", "manager"]);
  const items = await sql.query(
    `select s.id, s.start_at, s.end_at, s.status, cl.level, cl.sport, cl.id as class_id,
            cl.capacity, cl.enrolled_count, cl.min_enrolled, c.court_code
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
            cl.coach_id, u.full_name as coach_name, cl.min_enrolled,
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
    price_vnd: number | null;
    min_enrolled: number | null;
    description: string | null;
    syllabus: string | null;
    who_for: string | null;
    bring: string | null;
  }>(
    sql,
    `select cl.id, cl.sport::text as sport, cl.level, cl.status::text as status, cl.capacity, cl.enrolled_count, cl.min_enrolled,
            cl.rrule, cl.duration_min, cl.start_on::text as start_on, cl.end_on::text as end_on,
            cl.court_id, c.court_code, cl.coach_id, cl.assistant_id,
            co.full_name as coach_name, asst.full_name as assistant_name, cl.price_vnd,
            cl.description, cl.syllabus, cl.who_for, cl.bring
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
    `select u.id, u.full_name, u.member_code, u.phone, e.status::text as status,
            ${avatarUrlSql("u")},
            case when e.status = 'waitlisted' then (select count(*) from enrollments w where w.class_id = e.class_id and w.status = 'waitlisted' and (w.waitlist_pos, w.id) <= (e.waitlist_pos, e.id)) end as waitlist_pos,
            exists(
              select 1 from waitlist_offers o
               where o.enrollment_id = e.id and o.status = 'pending' and o.expires_at > now()
            ) as offer_pending,
            (select o.expires_at from waitlist_offers o where o.enrollment_id = e.id and o.status = 'pending' and o.expires_at > now() limit 1) as offer_expires_at
       from enrollments e join users u on u.id = e.user_id
      where e.class_id = $1 and e.status in ('confirmed','waitlisted')
      order by e.status, e.waitlist_pos nulls first, u.full_name`,
    [classId],
  );
  return {
    status: 200,
    body: {
      class: { ...cl, my_enrollment: null, code: classCode(cl.sport, cl.level, cl.id) },
      sessions,
      roster: roster.map(withAvatarUrl),
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
    `select u.id, u.full_name, u.member_code, u.health_notes, e.status, e.id as enrollment_id,
            ${avatarUrlSql("u")}
       from enrollments e
       join users u on u.id = e.user_id
      where e.class_id = $1 and e.status = 'confirmed'
      order by u.full_name`,
    [classId],
  );
  return { status: 200, body: { items: items.map(withAvatarUrl) } };
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
  const refunded = 0;
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

/** Put another coach on a class from now on (FR-CLS-06, BR-25, BR-54). */
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
  // Cancelling closes the seat holds' payOS links. Those payment rows are locked before the class
  // (payment → class → enrolment, the order settleOnline uses), so a webhook racing the cancel
  // queues behind it instead of deadlocking.
  const cancelLinks =
    str(b.status) === "cancelled" && isUuid(classId)
      ? await lockEnrollmentLinks(
          sql,
          (
            await sql.query<{ id: string }>(`select id from enrollments where class_id = $1 and status = 'hold'`, [classId])
          ).map((r) => String(r.id)),
        )
      : [];
  const cl = await one<{
    id: string;
    sport: string;
    level: string;
    status: string;
    capacity: number;
    enrolled_count: number;
    min_enrolled: number | null;
    coach_id: string;
    assistant_id: string | null;
    start_on: string;
    end_on: string;
  }>(
    sql,
    `select id, sport::text as sport, level, status::text as status, capacity, enrolled_count, min_enrolled, coach_id, assistant_id,
            start_on::text as start_on, end_on::text as end_on
       from classes where id = $1 for update`,
    [classId],
  );
  if (!cl) throw err.notFound("No such class.");
  if (cl.status === "cancelled") throw err.conflictState("That class is cancelled.");

  const status = str(b.status);
  if (status === "cancelled") return cancelClass(sql, cl, reasonOf(b), user, cancelLinks);
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

  const priceSet = b.price_vnd !== undefined;
  const price_vnd = priceSet ? parsePrice(b.price_vnd) : undefined;
  const minSet = b.min_enrolled !== undefined;
  const min_enrolled = minSet ? parseMinEnrolled(b.min_enrolled, capacity) : cl.min_enrolled;
  if (!minSet && min_enrolled != null && min_enrolled > capacity) {
    throw err.field("capacity", "Capacity cannot go below the class's minimum.");
  }
  const end_on = b.end_on === undefined ? cl.end_on : str(b.end_on);
  if (!end_on || !/^\d{4}-\d{2}-\d{2}$/.test(end_on) || Number.isNaN(Date.parse(end_on))) {
    throw err.field("end_on", "That date is not valid.");
  }
  if (end_on < cl.start_on) throw err.field("end_on", "A class cannot end before it starts.");
  if (end_on < cl.end_on) {
    const beyond = await one(
      sql,
      `select 1 from sessions
        where class_id = $1 and status = 'scheduled'
          and (start_at at time zone 'Asia/Ho_Chi_Minh')::date > $2::date limit 1`,
      [classId, end_on],
    );
    if (beyond) throw err.conflictState("Sessions are still scheduled after that date. Cancel them first.");
  }
  await sql.query(
    `update classes set capacity = $2, level = $3, status = coalesce($4::class_status, status),
            price_vnd = case when $5::boolean then $6::int else price_vnd end, min_enrolled = $7 where id = $1`,
    [classId, capacity, level, status ?? null, priceSet, price_vnd ?? null, min_enrolled],
  );
  let membersCarried = 0;
  if (end_on !== cl.end_on) {
    await sql.query(`update classes set end_on = $2 where id = $1`, [classId, end_on]);
    // The centre moved the date, so members already enrolled are carried there for free.
    if (end_on > cl.end_on) membersCarried = await carryMembersToClassEnd(sql, classId, end_on);
  }
  // Each text changes only when sent; an empty string clears it.
  const textEdits: Partial<Record<ClassTextKey, string | null>> = {};
  for (const key of Object.keys(CLASS_TEXT_LIMITS) as ClassTextKey[]) {
    if (b[key] === undefined) continue;
    textEdits[key] = parseClassText(key, b[key]);
    await sql.query(`update classes set ${key} = $2 where id = $1`, [classId, textEdits[key]]);
  }
  if (capacity > cl.capacity && (status ?? cl.status) === "open") await inviteWaitlist(sql, classId);
  const after = { capacity, level, status: status ?? cl.status, min_enrolled, end_on, members_carried: membersCarried, ...(priceSet ? { price_vnd } : {}), ...textEdits };
  await audit(
    sql,
    user.id,
    "edit_class",
    "class",
    classId,
    { capacity: cl.capacity, level: cl.level, status: cl.status, min_enrolled: cl.min_enrolled, end_on: cl.end_on },
    after,
  );
  return { status: 200, body: { ok: true, class: { id: classId, ...after } } };
}

async function cancelClass(
  sql: Sql,
  cl: { id: string; sport: string; status: string; coach_id: string; assistant_id: string | null },
  reason: string | undefined,
  user: PublicUser,
  links: Array<{ id: string; provider_order_code: string | number | null }> = [],
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
  // Members holding an unpaid seat are told too: their hold ends with the class.
  const holding = (
    await sql.query(`select user_id from enrollments where class_id = $1 and status = 'hold'`, [cl.id])
  ).map((r) => String(r.user_id));
  // The centre cancelled: each member gets back the tuition paid and the extension days no other
  // class needs, less anything already sent back. Refunds are cash, so each row waits at the desk
  // until a receptionist hands the money over: only then is it posted, into that person's till.
  // created_by stays empty because nobody at the desk raised it; the audit row names the manager.
  const settings = await getSettings(sql);
  let refunded = 0;
  let refundedVnd = 0;
  const refundByUser = new Map<string, number>();
  const seats = await sql.query<{ id: string; user_id: string; price_vnd: number | null; extension_vnd: number; paid_vnd: number; returned_vnd: number }>(
    `select e.id, e.user_id, e.price_vnd, e.extension_vnd,
            coalesce((select sum(p.amount_vnd) from payments p
                       where p.ref_type = 'enrollment' and p.ref_id = e.id and p.status = 'posted' and p.amount_vnd > 0), 0)::int as paid_vnd,
            coalesce((select sum(-p.amount_vnd) from payments p
                       where p.ref_type = 'enrollment' and p.ref_id = e.id and p.status in ('posted','refund_pending') and p.amount_vnd < 0), 0)::int as returned_vnd
       from enrollments e where e.class_id = $1 and e.status = 'confirmed'`,
    [cl.id],
  );
  for (const seat of seats) {
    const tuition = Math.min(seat.paid_vnd, Math.max(0, (seat.price_vnd ?? 0) - seat.extension_vnd));
    const extension = await rollbackExtension(sql, seat.id, settings.member_day_rate_vnd);
    const refund = Math.min(tuition + extension.refund_vnd, Math.max(0, seat.paid_vnd - seat.returned_vnd));
    if (refund <= 0) continue;
    const code = await nextCode(sql, "PAY");
    await sql.query(
      `insert into payments (code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by)
       values ($1,$2,'cash',$3,0,'refund_pending','enrollment',$4,null)`,
      [code, seat.user_id, -refund, seat.id],
    );
    refundByUser.set(seat.user_id, (refundByUser.get(seat.user_id) ?? 0) + refund);
    refunded += 1;
    refundedVnd += refund;
  }
  await sql.query(
    `update waitlist_offers set status = 'expired'
      where status = 'pending' and enrollment_id in (select id from enrollments where class_id = $1)`,
    [cl.id],
  );
  await sql.query(
    `update enrollments
        set status = 'cancelled', waitlist_pos = null, hold_until = null, transfer_requested_at = null
      where class_id = $1 and status in ('confirmed','waitlisted','hold')`,
    [cl.id],
  );
  // No hold can be paid any more: withdraw its link at payOS so the money never moves.
  await withdrawLinks(sql, links, "Class cancelled", "CLASS_CANCELLED");
  await sql.query(`update classes set status = 'cancelled', enrolled_count = 0, cancel_reason = $2 where id = $1`, [
    cl.id,
    reason,
  ]);
  await notifyClass(
    sql,
    cl.id,
    [...members, ...waiting, ...holding, cl.coach_id, ...(cl.assistant_id ? [cl.assistant_id] : [])].filter((id) => !refundByUser.has(id)),
    { kind: "class_cancelled", reason },
    `class_cancel|${cl.id}`,
  );
  for (const [uid, refund_vnd] of refundByUser) {
    await notifyClass(sql, cl.id, [uid], { kind: "class_cancelled", reason, refund_vnd }, `class_cancel|${cl.id}`);
  }
  await audit(sql, user.id, "cancel_class", "class", cl.id, { status: cl.status }, {
    status: "cancelled",
    reason,
    sessions: upcoming.length,
    members_refunded: refunded,
    refunded_vnd: refundedVnd,
  });
  return {
    status: 200,
    body: {
      ok: true,
      sessions_cancelled: upcoming.length,
      notified: members.length + waiting.length + holding.length,
      refunded,
      refunded_vnd: refundedVnd,
    },
  };
}

void addDays;
