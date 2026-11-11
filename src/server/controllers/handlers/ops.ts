import type { Sql } from "@/server/data/db";
import { assertMembershipOutlastsClass, hasRunningClass } from "../../services/membership";
import { err } from "../errors";
import { flagsMap, requireFlag, type FlagKey } from "../../services/flags";
import { assertNoClassClash, assertUnderClassLimit, audit, enqueue, enqueueReceipt, getSettings, issueInvoice, nextCode, pageOf, readJson, str } from "../helpers";
import { limit, RULES } from "../ratelimit";
import { avatarUrlSql, requireRole, withAvatarUrl, type PublicUser } from "../session";
import { isValidVnPhone, normalizePhone } from "../../services/phone";
import { generateAssistantReply, type ChatTurn } from "../../integrations/gemini";
import { COACHES } from "../../../shared/arena3/coaches";
import { ATTENDANCE_LOCK_HOURS, PLAN_PHASES, INTENSITIES, attendanceLocked, isAttResult, isTicketMessage, ticketBody } from "../../services/rules";
import { checkAbsentStreaks, sessionScope } from "./training";
import { openShift, pickMethod } from "./extras";
import { addDays, ictDateString } from "../../../shared/arena3/time";
import { one } from "../tx";
import { payosConfigured } from "../../integrations/payos";
import { centreBank } from "../../integrations/bank";
import { pageParams, parseInteger } from "../validate";
import { getActiveSportCodes } from "./sports";
import { uiConfigFrom } from "@/shared/ui-config";

export async function flagsGet(sql: Sql) {
  const settings = await getSettings(sql);
  return {
    status: 200,
    body: {
      // Opening hours and the hold length as the manager set them, for the copy and grids that
      // used to write "06:00-22:00" and "five minutes" in by hand. Not personal, not secret.
      venue: { open_time: settings.open_time, close_time: settings.close_time, hold_minutes: settings.hold_minutes },
      flags: await flagsMap(sql),
      // Each role's menu and the short lists' lengths, as the manager set them.
      ui: uiConfigFrom(settings.ui_config),
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

/**
 * The centre's bank account for a VietQR transfer, for signed-in people only: the booking card
 * shows it to the member who is paying, the desk box to the customer at the counter.
 */
export async function bankTransferGet(user: PublicUser) {
  requireRole(user, ["member", "receptionist", "manager"]);
  const bank = centreBank();
  return {
    status: 200,
    body: bank
      ? { configured: true, bin: bank.bin, account_no: bank.accountNo, account_name: bank.accountName, bank_name: bank.bankName }
      : { configured: false },
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
  if (await hasRunningClass(sql, sub.user_id)) {
    throw err.br("BR-14", "This member has a class running or coming up, so the plan cannot be frozen.");
  }
  if (sub.frozen_days + days > settings.freeze_max_days_year) {
    throw err.br("BR-15", `Over the limit of ${settings.freeze_max_days_year} freeze days a year.`);
  }
  const end = addDays(sub.end_on, days);
  await sql.query(
    `update subscriptions set status = 'frozen', frozen_days = frozen_days + $2, end_on = $3 where id = $1`,
    [id, days, end],
  );
  await audit(sql, user.id, "freeze_sub", "subscription", id, sub, { days, end });
  return { status: 200, body: await one(sql, `select id, user_id, plan_id, start_on::text, end_on::text, status, frozen_days, court_hours_left, session_left from subscriptions where id = $1`, [id]) };
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
  // Freeze charges the whole requested length up front. Days not used come back
  // onto the yearly allowance; a freeze with no audit row is left as stored.
  let frozenDays = sub.frozen_days;
  if (lastFreeze && lastFreeze.before?.end_on && lastFreeze.after?.days) {
    const freezeDate = String(lastFreeze.at).slice(0, 10);
    const today = ictDateString();
    const dFreeze = new Date(freezeDate);
    const dToday = new Date(today);
    const maxDays = Number(lastFreeze.after.days) || 0;
    const actualDays = Math.min(maxDays, Math.max(0, Math.round((dToday.getTime() - dFreeze.getTime()) / (86400 * 1000))));
    const unused = Math.max(0, maxDays - actualDays);
    frozenDays = Math.max(0, sub.frozen_days - unused);
    const originalEndOn = String(lastFreeze.before.end_on).slice(0, 10);
    newEndOn = addDays(originalEndOn, actualDays);
  }

  await sql.query(
    `update subscriptions set status = 'active', end_on = $2, frozen_days = $3 where id = $1`,
    [id, newEndOn, frozenDays],
  );
  await audit(sql, user.id, "unfreeze_sub", "subscription", id, sub, { end_on: newEndOn, frozen_days: frozenDays });
  return { status: 200, body: await one(sql, `select id, user_id, plan_id, start_on::text, end_on::text, status, frozen_days, court_hours_left, session_left from subscriptions where id = $1`, [id]) };
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
  if (offer.status === "skipped") throw err.br("BR-21", "The class just filled up.");
  if (offer.status !== "pending") throw err.conflictState();
  if (new Date(offer.expires_at) < new Date()) throw err.br("BR-23", "That offer has expired.");
  // Same lock order as enrollment_hold: the class first, then the enrolment.
  const pre = await one<{ class_id: string }>(sql, `select class_id from enrollments where id = $1`, [offer.enrollment_id]);
  if (!pre) throw err.notFound();
  const cl = await one<{ enrolled_count: number; capacity: number; price_vnd: number | null; start_on: string; end_on: string }>(
    sql,
    `select enrolled_count, capacity, price_vnd, start_on::text as start_on, end_on::text as end_on from classes where id = $1 for update`,
    [pre.class_id],
  );
  if (!cl) throw err.notFound();
  const enr = await one<{ id: string; class_id: string; user_id: string; status: string }>(
    sql,
    `select * from enrollments where id = $1 for update`,
    [offer.enrollment_id],
  );
  if (!enr || enr.user_id !== user.id) throw err.forbidden();
  if (enr.status !== "waitlisted") throw err.conflictState("You are no longer on the waitlist for this class.");
  await assertNoClassClash(sql, user.id, enr.class_id);
  if (cl.enrolled_count >= cl.capacity) throw err.br("BR-21", "The class just filled up.");
  if (cl.price_vnd == null) throw err.br("BR-53", "This class is not open for sale yet.");
  const settings = await getSettings(sql);
  // The seat is held, not confirmed: payment confirms it, and the price is locked now.
  // A free class has nothing to pay, so the seat is confirmed at once (as classesEnroll does).
  await assertUnderClassLimit(sql, user.id, enr.class_id, settings.max_active_classes);
  await assertMembershipOutlastsClass(sql, user.id, cl.end_on);
  const total = cl.price_vnd;
  const free = total === 0;
  await sql.query(
    `update enrollments
        set status = $4::enroll_status, waitlist_pos = null, price_vnd = $2,
            hold_until = case when $5::boolean then null else now() + ($3::int * interval '1 minute') end
      where id = $1`,
    [enr.id, total, settings.class_hold_minutes, free ? "confirmed" : "hold", free],
  );
  await sql.query(
    `update classes set enrolled_count = enrolled_count + 1 where id = $1 and enrolled_count < capacity`,
    [enr.class_id],
  );
  await sql.query(`update waitlist_offers set status = 'accepted' where id = $1`, [offerId]);
  await compactWaitlist(sql, enr.class_id);
  return { status: 200, body: { ok: true, status: free ? "confirmed" : "hold" } };
}

/** Renumber a class's waitlist 1..n (two-step, see migration 0052). */
export async function compactWaitlist(sql: Sql, classId: string) {
  await sql.query(`select waitlist_compact($1::uuid)`, [classId]);
}

export async function inviteWaitlist(sql: Sql, classId: string) {
  const cl = await one<{ capacity: number; enrolled_count: number }>(
    sql,
    `select capacity, enrolled_count from classes where id = $1 for update`,
    [classId],
  );
  if (!cl) return;
  const open = cl.capacity - cl.enrolled_count;
  if (open <= 0) return;
  const pending = await one<{ n: number }>(
    sql,
    `select count(*)::int as n
       from waitlist_offers o
       join enrollments e on e.id = o.enrollment_id
      where e.class_id = $1 and o.status = 'pending' and o.expires_at > now()`,
    [classId],
  );
  const room = open - (pending?.n ?? 0);
  if (room <= 0) return;
  const next = await sql.query<{ id: string; user_id: string }>(
    `select e.id, e.user_id from enrollments e
      where e.class_id = $1 and e.status = 'waitlisted'
        and not exists (
          select 1 from waitlist_offers o
           where o.enrollment_id = e.id and o.status = 'pending' and o.expires_at > now()
        )
      order by e.waitlist_pos nulls last, e.id
      limit $2`,
    [classId, room],
  );
  if (next.length === 0) return;
  const settings = await getSettings(sql);
  const hours = settings.waitlist_offer_hours || 2;
  for (const row of next) {
    const offer = await one<{ id: string }>(
      sql,
      `insert into waitlist_offers (enrollment_id, expires_at, status)
       values ($1, now() + ($2 * interval '1 hour'), 'pending')
       returning id`,
      [row.id, hours],
    );
    await enqueue(
      sql,
      "inapp",
      "waitlist_offer",
      row.user_id,
      { offer_id: offer!.id, class_id: classId },
      `wl|${offer!.id}`,
    );
  }
}

export async function equipmentList(sql: Sql) {
  const items = await sql.query(`select * from equipment_items order by name`);
  return { status: 200, body: { items } };
}

export async function equipmentLoan(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  const b = await readJson(request);
  const item_id = str(b.item_id);
  if (!item_id) throw err.field("item_id", "Choose the gear to rent out.");
  const qty = parseInteger("qty", "Quantity", b.qty ?? 1, 1, 99);
  const method = pickMethod(b.method);

  // A member rents against their account — the phone on the loan is theirs, so
  // the loan list can name them. A guest has only the number they give.
  const memberId = str(b.user_id);
  let phone: string;
  let buyer = "Khách lẻ";
  if (memberId) {
    const m = await one<{ phone: string; status: string; full_name: string }>(
      sql,
      `select phone, status, full_name from users where id = $1 and role = 'member'`,
      [memberId],
    );
    if (!m) throw err.field("user_id", "That member account was not found.");
    if (m.status !== "active") throw err.field("user_id", "That member account is not active.");
    phone = m.phone;
    buyer = m.full_name;
  } else {
    phone = normalizePhone(str(b.phone) ?? "");
    if (!phone) throw err.field("phone", "Enter the guest's phone number, or pick a member.");
    if (!isValidVnPhone(phone)) throw err.field("phone", "That phone number is not valid.");
  }

  const item = await one<{ stock: number; rent_vnd: number; name: string }>(
    sql,
    `select stock, rent_vnd, name from equipment_items where id = $1 for update`,
    [item_id],
  );
  if (!item) throw err.notFound();
  if (item.stock < qty) {
    throw err.br("BR-50", `Only ${item.stock} ${item.name} left — you asked for ${qty}.`, { available: item.stock });
  }
  // Gear is charged at the counter like any other sale, so the till must be open first.
  const shiftId = await openShift(sql, user);
  await sql.query(`update equipment_items set stock = stock - $2 where id = $1`, [item_id, qty]);
  const loan = await one(
    sql,
    `insert into equipment_loans (item_id, booking_id, phone, qty, due_at)
     values ($1,$2,$3,$4, now() + interval '3 hours')
     returning *`,
    [item_id, str(b.booking_id) ?? null, phone, qty],
  );
  const rentVnd = item.rent_vnd * qty;
  let invoiceId: string | null = null;
  if (rentVnd > 0) {
    const settings = await getSettings(sql);
    const userId = memberId ?? null;
    const pay = await one<{ id: string }>(
      sql,
      `insert into payments (code, user_id, shift_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by)
       values ($1,$2,$3,$4,$5,$6,'posted','equipment',$7,$8) returning id`,
      [await nextCode(sql, "PAY"), userId, shiftId, method, rentVnd, Number(settings.vat_rate), (loan as { id: string }).id, user.id],
    );
    invoiceId = await issueInvoice(sql, {
      paymentId: pay!.id,
      buyerName: buyer,
      buyerPhone: userId ? null : phone,
      amountVnd: rentVnd,
      vatRate: Number(settings.vat_rate ?? 0),
      description: `Thuê thiết bị — ${item.name} × ${qty}`,
      unit: "lượt",
      settings,
    });
    await enqueueReceipt(sql, userId, { payment_id: pay!.id, invoice_id: invoiceId, amount_vnd: rentVnd, method });
  }
  await audit(sql, user.id, "loan_out", "equipment", item_id, null, loan);
  return { status: 201, body: { loan, rent_vnd: rentVnd, invoice_id: invoiceId } };
}

export async function equipmentReturn(sql: Sql, id: string, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  const loan = await one<{ id: string; item_id: string; qty: number; status: string }>(
    sql,
    `select * from equipment_loans where id = $1 for update`,
    [id],
  );
  if (!loan) throw err.notFound();
  if (loan.status !== "out") throw err.conflictState();
  // Lock the item row so a return and a rental cannot interleave on the count.
  await sql.query(`select 1 from equipment_items where id = $1 for update`, [loan.item_id]);
  await sql.query(
    `update equipment_loans set status = 'returned', returned_at = now() where id = $1`,
    [id],
  );
  await sql.query(`update equipment_items set stock = stock + $2 where id = $1`, [loan.item_id, loan.qty]);
  await audit(sql, user.id, "loan_return", "equipment", loan.item_id, null, { loan_id: id, qty: loan.qty });
  return { status: 200, body: { ok: true } };
}

export async function loansOpen(sql: Sql, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  const items = await sql.query(
    `select l.*, i.name, i.sku,
            m.full_name as member_name, m.member_code
       from equipment_loans l
       join equipment_items i on i.id = l.item_id
       left join users m on m.phone = l.phone and m.role = 'member'
      where l.status = 'out'
      order by l.due_at`,
  );
  return { status: 200, body: { items } };
}

export async function sessionAttendanceGet(sql: Sql, sessionId: string, user: PublicUser) {
  requireRole(user, ["coach", "manager"]);
  await requireFlag(sql, "F4");
  // BR-45: a coach reads the register of their own classes only.
  const scope = await sessionScope(sql, sessionId, user);
  const session = {
    id: scope.id,
    class_id: scope.class_id,
    status: scope.status,
    start_at: scope.start_at,
    end_at: scope.end_at,
    locked: attendanceLocked(new Date(scope.end_at).getTime(), Date.now(), scope.status),
    lock_at: new Date(new Date(scope.end_at).getTime() + ATTENDANCE_LOCK_HOURS * 3_600_000).toISOString(),
  };
  const roster = await sql.query(
    `select u.id, u.full_name, u.member_code, u.health_notes,
            ${avatarUrlSql("u")},
            a.result, a.at
       from enrollments e
       join users u on u.id = e.user_id
       left join attendance a on a.session_id = $1 and a.user_id = u.id and a.kind = 'session'
      where e.class_id = $2 and e.status = 'confirmed'
      order by u.full_name`,
    [sessionId, session.class_id],
  );
  return { status: 200, body: { session, items: roster.map(withAvatarUrl) } };
}

/**
 * A member's own attendance (M-05): one line per session of the classes they
 * are in that has already run, with the mark the coach gave — present, late,
 * absent or excused — or null when none has been recorded. Only the caller's
 * own rows; there is no id parameter to point it at somebody else.
 */
export async function meAttendance(sql: Sql, user: PublicUser) {
  requireRole(user, ["member"]);
  await requireFlag(sql, "F4");
  const items = await sql.query<{
    session_id: string;
    start_at: string;
    end_at: string;
    sport: string;
    level: string;
    court_code: string;
    result: string | null;
  }>(
    `select s.id as session_id, s.start_at, s.end_at, cl.sport::text as sport, cl.level,
            c.court_code, a.result::text as result
       from sessions s
       join classes cl on cl.id = s.class_id
       join courts c on c.id = s.court_id
       left join attendance a on a.session_id = s.id and a.user_id = $1 and a.kind = 'session'
      where s.start_at < now()
        and s.status <> 'cancelled'
        and (a.id is not null
             or exists (select 1 from enrollments e
                         where e.class_id = cl.id and e.user_id = $1 and e.status = 'confirmed'))
      order by s.start_at desc
      limit 60`,
    [user.id],
  );
  const counts = { present: 0, late: 0, absent: 0, excused: 0 } as Record<string, number>;
  for (const r of items) if (r.result && r.result in counts) counts[r.result]++;
  return { status: 200, body: { items, counts } };
}

export async function sessionAttendancePost(sql: Sql, sessionId: string, request: Request, user: PublicUser) {
  requireRole(user, ["coach", "manager"]);
  await requireFlag(sql, "F4");
  const session = await sessionScope(sql, sessionId, user);
  if (session.status === "cancelled") throw err.conflictState("That session was cancelled.");
  const b = await readJson(request);
  const raw = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : [];
  if (raw.length === 0) throw err.field("items", "Nothing to save.");

  // BR-35: the register closes two hours after the session. Past that only a
  // manager may correct it, and must say why — the reason is kept in the audit.
  let reason: string | null = null;
  if (attendanceLocked(new Date(session.end_at).getTime(), Date.now(), session.status)) {
    if (user.role !== "manager") {
      throw err.br("BR-35", "This register closed 2 hours after the session. Ask a manager to correct it.");
    }
    reason = (str(b.reason) ?? "").trim();
    if (reason.length < 3) throw err.field("reason", "Say why this closed register is being changed.");
  }

  const marks = new Map<string, string>();
  for (const [i, it] of raw.entries()) {
    const uid = str(it.user_id);
    if (!uid || !/^[0-9a-f-]{36}$/i.test(uid)) throw err.field("user_id", `Row ${i + 1}: missing student.`, { index: i });
    const result = str(it.result) ?? "present";
    if (!isAttResult(result)) {
      throw err.field("result", `Row ${i + 1}: result must be present, late, absent or excused.`, { index: i });
    }
    const enrolled = await one(
      sql,
      `select 1 as ok from enrollments where class_id = $1 and user_id = $2 and status = 'confirmed'`,
      [session.class_id, uid],
    );
    if (!enrolled) throw err.field("user_id", `Row ${i + 1}: that student is not in this class.`, { index: i });
    marks.set(uid, result);
  }

  if (new Date(session.start_at).getTime() > Date.now()) {
    throw err.field("session_id", "Cannot mark attendance for a session that has not started.");
  }

  const before: Record<string, string | null> = {};
  for (const [uid, result] of marks) {
    const prev = await one<{ result: string | null }>(
      sql,
      `select result::text as result from attendance where session_id = $1 and user_id = $2 and kind = 'session' limit 1`,
      [session.id, uid],
    );
    before[uid] = prev?.result ?? null;
    await sql.query(`delete from attendance where session_id = $1 and user_id = $2 and kind = 'session'`, [session.id, uid]);
    await sql.query(
      `insert into attendance (kind, user_id, session_id, result) values ('session', $1, $2, $3::att_result)`,
      [uid, session.id, result],
    );
  }

  await audit(
    sql,
    user.id,
    reason ? "attendance_correct" : "attendance",
    "session",
    session.id,
    before,
    { marks: Object.fromEntries(marks), ...(reason ? { reason } : {}) },
  );
  // BR-36: only a fresh absence can start or extend a streak.
  const absent = [...marks].filter(([, r]) => r === "absent").map(([uid]) => uid);
  await checkAbsentStreaks(sql, session.class_id, absent);
  const res = await sessionAttendanceGet(sql, session.id, user);
  return {
    status: 200,
    body: {
      ...res.body,
    },
  };
}

export async function trainingList(sql: Sql, request: Request, user: PublicUser) {
  await requireFlag(sql, "F4");
  const url = new URL(request.url);
  const classId = url.searchParams.get("class_id");
  const mine = url.searchParams.get("mine") === "1";
  const items = await sql.query(
    `select p.*, s.start_at as session_start
       from training_plans p
       left join sessions s on s.id = p.session_id
      where not p.is_template
        and ($1::uuid is null or p.class_id = $1)
        and (
          case
            when $2::boolean then
              p.published = true
              and (p.user_id = $3
                   or (p.user_id is null and p.class_id is null)
                   or (p.user_id is null and p.class_id in (
                         select class_id from enrollments where user_id = $3 and status = 'confirmed')))
            when $4::text = 'coach' then
              p.created_by = $3
              or p.class_id in (select id from classes where coach_id = $3 or assistant_id = $3)
            else true
          end
        )
      order by coalesce(s.start_at, p.created_at) desc, p.id
      limit 60`,
    [classId && /^[0-9a-f-]{36}$/i.test(classId) ? classId : null, mine || user.role === "member", user.id, user.role],
  );
  return { status: 200, body: { items } };
}

export async function trainingSuggest(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["coach", "manager"]);
  await requireFlag(sql, "F5");
  const b = await readJson(request);
  const activeSports = await getActiveSportCodes(sql);
  const sport = str(b.sport) ?? activeSports[0] ?? "general";
  const level = str(b.level) ?? "beginner";
  const goal = str(b.goal) ?? "core technique";
  const defaultDrills: Record<string, string[]> = {
    beginner: ["Warm-up & footwork 8′", "Fundamental technique drills 12′", "Targeted control practice 10′", "Practice game to 11"],
    intermediate: ["Movement off the step 12′", "Speed & rally exchanges 10′", "Court coverage & defense 8′", "Set to 21"],
    advanced: ["High-power attack drills 10′", "Cross-court tactics", "Low defence transitions", "Umpired match play"],
  };
  const list = defaultDrills[level] ?? defaultDrills.beginner;
  // The coach's own instructions, if any. Capped and stripped of control characters before it reaches the model.
  const prompt = (str(b.prompt) ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500);
  const text = (value: unknown, max: number) => (str(value) ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
  const vietnamese = /[\u00c0-\u1ef9]/i.test(`${prompt} ${goal}`);
  const cleanBlocks = (items: Record<string, unknown>[]) => items.map((x, i) => {
    const title = text(x.title, 60);
    const duration = Number(x.minutes);
    const minutes = Number.isFinite(duration) ? Math.min(45, Math.max(3, Math.round(duration) || 10)) : 10;
    const inferredPhase = i === 0 ? "warm-up" : i === items.length - 1 ? "cool-down" : "technique";
    const phase = PLAN_PHASES.find((phase) => phase === text(x.phase, 40))
      ?? PLAN_PHASES.find((phase) => phase === inferredPhase) ?? PLAN_PHASES[0];
    const intensity = INTENSITIES.find((intensity) => intensity === text(x.intensity, 40)) ?? "medium";
    return {
      order: i + 1, title, minutes, phase, intensity,
      description: text(x.description, 600) || (vietnamese ? `Thực hiện ${title} trong ${minutes} phút, giữ đúng kỹ thuật và nghỉ ngắn giữa các lượt.` : `Perform ${title} for ${minutes} minutes, keeping good form with short rests between rounds.`),
      equipment: text(x.equipment, 200) || (vietnamese ? "Dụng cụ phù hợp môn tập và đồng hồ bấm giờ." : "Sport-appropriate equipment and a timer."),
      target: text(x.target, 200) || (vietnamese ? `Hoàn thành ${minutes} phút tập đúng kỹ thuật.` : `Complete ${minutes} minutes with correct technique.`),
    };
  });
  let blocks = cleanBlocks(list.map((title, i) => ({ title, minutes: 10 + i })));
  let usedAi = false;
  const system = [
    "You plan one training session for a sports coach.",
    `Sport: ${sport}. Level: ${level}. Focus: ${goal}.`,
    "Reply with ONLY a JSON array of 3 to 8 blocks, no prose, no code fence.",
    `Each block must contain title (short drill name, max 60 chars), minutes (whole number 3-45), phase (exactly one of ${PLAN_PHASES.join("| ")}), intensity (exactly one of ${INTENSITIES.join("| ")}), description (short instructions for running the drill, max 600 chars), equipment (max 200 chars), target (measurable goal, max 200 chars).`,
    "Use warm-up for the first block and cool-down for the last block when available in phase values.",
    "Total time 45-120 minutes. Keep drills safe for the level. Answer in the language the coach writes in.",
  ].join("\n");
  const ask = prompt ? `Coach instructions: ${prompt}` : `Plan a ${level} ${sport} session on ${goal}.`;
  const reply = await generateAssistantReply(system, [{ role: "user", text: ask }], { maxOutputTokens: 4096, json: true });
  if (reply) {
    try {
      const raw = reply.text.replace(/^```(?:json)?\s*|\s*```$/g, "");
      const parsed = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1)) as unknown;
      if (Array.isArray(parsed)) {
        const clean = cleanBlocks(parsed
          .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
          .filter((x) => text(x.title, 60))
          .slice(0, 8));
        if (clean.length >= 2) {
          blocks = clean;
          usedAi = true;
        }
      }
    } catch {
      // A reply that is not JSON falls back to the standard drills below.
    }
  }
  const payload = {
    sport,
    level,
    goal,
    source: "ai",
    generated_on: ictDateString(),
    ...(prompt ? { prompt } : {}),
    blocks,
    note: "A coach reviews this before it goes out. AI never overwrites a published plan.",
  };
  return { status: 200, body: { payload, ai: usedAi } };
}

// ticketBody() moved to ../rules — a Unicode-hardened version (zero-width
// characters, the full-width "：" an IME can produce) that still collapses
// repeated "ticket:" prefixes the same way. Re-exported here so nothing
// importing it from this module has to change.
export { ticketBody };

/**
 * The budget for opening a support request.
 *
 * One bucket for both doors into the queue — the support form and a `ticket:`
 * message to the assistant — because to reception they are the same row.
 * Counting them separately would let one member post a full allowance through
 * each, which is the hole the assistant route was: it was covered only by
 * `RULES.assistant`, and twenty a minute is a model-call budget, not a
 * someone-has-to-read-this budget.
 *
 * Callers charge this before the insert, so a burst is refused rather than
 * queued behind however long the write takes. A failed insert therefore costs
 * the member one of their three: the alternative, `reset()` on error, empties
 * the whole bucket and would let a real burst through on the back of one
 * unlucky write.
 */
function ticketQuota(userId: string): void {
  limit(`ticket:${userId}`, RULES.ticketCreate, "requests");
  limit(`ticket:${userId}:hour`, RULES.ticketCreateHourly, "requests");
}

export async function assistantChat(sql: Sql, request: Request, user: PublicUser) {
  await requireFlag(sql, "F6");
  const body = await readJson(request);
  const message = (str(body.message) ?? "").trim().slice(0, 800);
  if (message.length < 2) throw err.validation("Type a question first.");
  // The ceiling on the endpoint itself (FR-A03), charged before the branch
  // below rather than inside it: every turn costs a `requireFlag` query whether
  // or not it reaches the model, so a turn that goes to the desk still has to
  // be counted somewhere. A `ticket:` turn pays this and the desk's own,
  // tighter budget.
  limit(`ai:${user.id}`, RULES.assistant, "questions");

  // Only a marker at the very start goes to the desk (FR-S01). Matching
  // "complaint", "feedback", "khiếu nại" or "góp ý" anywhere in the message
  // turned "Is there a feedback form?" into a support request, so the one
  // question the assistant was asked went unanswered.
  if (isTicketMessage(message)) {
    const note = ticketBody(message);
    // "ticket:" and nothing else. Opening a blank request would put a row at the
    // desk that nobody can answer, so ask for the rest before writing anything.
    if (note.length < 2) {
      return {
        status: 200,
        body: {
          reply: "Tell me what happened after ticket: and I'll pass it to the front desk.",
          source: "rules" as const,
        },
      };
    }
    // Twenty a minute is a model-call budget; reception reads these by hand.
    // After the blank check, so asking for the rest of a sentence costs only
    // the endpoint ceiling above, not a slot in the desk's queue.
    ticketQuota(user.id);
    const t = await one<{ id: string }>(
      sql,
      `insert into tickets (user_id, body) values ($1,$2) returning id`,
      [user.id, note],
    );
    await audit(sql, user.id, "assistant", "chat", user.id, null, { q: note.slice(0, 200), source: "ticket" });
    return {
      status: 200,
      body: {
        // Where to read the answer, not just that one is coming: the request
        // used to vanish into a confirmation, and Account › Support is the
        // only screen that has it and its reply.
        reply: `Opened request ${t!.id.slice(0, 8)} for the front desk. Reception replies during opening hours — you will find it, and the reply, under Account › Support.`,
        source: "rules" as const,
      },
    };
  }

  const q = message.toLowerCase();

  const settings = await getSettings(sql);
  const classes = await sql.query<{
    sport: string;
    level: string;
    rrule: string;
    enrolled_count: number;
    capacity: number;
    coach_name: string | null;
    price_vnd: number | null;
  }>(
    `select cl.sport, cl.level, cl.rrule, cl.enrolled_count, cl.capacity, cl.price_vnd, u.full_name as coach_name
       from classes cl
       left join users u on u.id = cl.coach_id
      where cl.status = 'open'
      order by cl.sport, cl.level`,
  );
  const onSale = classes.filter((c): c is typeof c & { price_vnd: number } => c.price_vnd !== null).sort((a, b) => a.price_vnd - b.price_vnd);
  const todayBookings = await sql.query<{ court_code: string; start_at: string; status: string }>(
    `select c.court_code, b.start_at::text, b.status
       from court_bookings b join courts c on c.id = b.court_id
      where b.user_id = $1
        and b.status in ('hold','confirmed')
        and b.start_at >= now() - interval '12 hours'
        and b.start_at < now() + interval '7 days'
      order by b.start_at
      limit 20`,
    [user.id],
  );
  const subs = await sql.query<{
    plan: string; start_on: string; end_on: string; status: string;
    court_hours_left: string; session_left: number | null; days_left: number;
  }>(
    `select p.name as plan, s.start_on::text, s.end_on::text, s.status::text,
            s.court_hours_left::text, s.session_left,
            (s.end_on - (now() at time zone 'Asia/Ho_Chi_Minh')::date)::int as days_left
       from subscriptions s join membership_plans p on p.id = s.plan_id
      where s.user_id = $1
      -- Live plans first, then the latest expired one so "my plan ran out on…" can be answered.
      order by (s.status = 'expired'), s.end_on desc
      limit 4`,
    [user.id],
  );
  const myClasses = await sql.query<{ sport: string; level: string; status: string; waitlist_pos: number | null; next_at: string | null }>(
    `select cl.sport::text, cl.level::text, e.status::text, e.waitlist_pos,
            (select min(se.start_at)::text from sessions se
              where se.class_id = cl.id and se.status = 'scheduled' and se.start_at >= now()) as next_at
       from enrollments e join classes cl on cl.id = e.class_id
      where e.user_id = $1 and e.status in ('confirmed','waitlisted')
      order by cl.sport, cl.level`,
    [user.id],
  );
  const recentAtt = await sql.query<{ kind: string; result: string | null; at: string; label: string | null }>(
    `select a.kind::text, a.result::text, a.at::text, cl.sport || ' ' || cl.level as label
       from attendance a
       left join sessions se on se.id = a.session_id
       left join classes cl on cl.id = se.class_id
      where a.user_id = $1
      order by a.at desc
      limit 5`,
    [user.id],
  );

  const facts = [
    `Centre: ${centreName(settings)}. Open ${settings.open_time.slice(0, 5)}–${settings.close_time.slice(0, 5)} ICT every day.`,
    `Court holds last ${settings.hold_minutes} minutes. A customer who cancels a court or a class, or does not show up, gets no refund. If the centre cancels, the money comes back in cash at the desk. One membership covers every sport; plans differ only by length. Covered on the day, a court costs ${settings.member_court_fee_vnd.toLocaleString("en-US")}đ an hour at any time; otherwise the list price. A class charges tuition, and can be joined only when the membership ends after the class ends; otherwise buy or extend a plan first.`,
    `Waitlists are first-come; an offer stands for ${settings.waitlist_offer_hours}h. Under-${settings.minor_age}s cannot book or enrol on their own.`,
    `Classes on sale:\n${onSale.map((c) => `• ${c.sport} ${c.level} · coach ${c.coach_name ?? "—"} · ${c.price_vnd.toLocaleString("en-US")}đ`).join("\n") || "—"}`,
    `Open classes:\n${classes.map((c) => `• ${c.sport} ${c.level} · coach ${c.coach_name ?? "—"} · ${c.enrolled_count}/${c.capacity}`).join("\n") || "No classes are open."}`,
    `Coaches:\n${COACHES.map((c) => `• ${c.name} — ${c.title}. ${c.blurb}`).join("\n")}`,
    `Member asking: ${user.full_name} (${user.member_code ?? "no member code yet"}).`,
    `Today's date (ICT): ${ictDateString()}.`,
    `Member's plans:\n${subs.map((s) => `• ${s.plan} · ${s.status} · ${s.start_on} → ${s.end_on} (${s.days_left} days left)`).join("\n") || "No plan ever bought."}`,
    `Member's classes:\n${myClasses.map((c) => `• ${c.sport} ${c.level} · ${c.status}${c.waitlist_pos !== null ? ` #${c.waitlist_pos}` : ""} · next session ${c.next_at ?? "none scheduled"}`).join("\n") || "Not enrolled in any class."}`,
    `Court bookings, next 7 days:\n${todayBookings.map((b) => `• ${b.court_code} ${b.start_at} (${b.status})`).join("\n") || "Nothing booked."}`,
    `Recent attendance:\n${recentAtt.map((a) => `• ${a.at} ${a.kind}${a.label ? ` ${a.label}` : ""}${a.result ? ` · ${a.result}` : ""}`).join("\n") || "No records."}`,
  ].join("\n\n");

  const system = `You are the ${centreName(settings)} front-desk assistant inside the member app. Reply in the language of the member's latest message (Vietnamese if they write in Vietnamese, otherwise English), keep it short (2–8 sentences), and stay strictly inside the DATA BLOCK.
No medical advice, no discounts beyond the listed prices, never invent a free slot.
Only name coaches and classes that appear in the data block.
If you do not know: tell them to ask the desk or start a message with "ticket:" followed by what happened.
You can walk them through Book / Classes in the app. Payment is taken at the desk for each court booking or class they buy in the app.

DATA BLOCK:
${facts}`;

  const history = parseHistory(body.history);
  const turns: ChatTurn[] = [...history, { role: "user", text: message }];

  const ai = await generateAssistantReply(system, turns);
  const reply = ai?.text ?? ruleReply(q, settings, onSale, classes);
  const source = ai?.source ?? "rules";

  await audit(sql, user.id, "assistant", "chat", user.id, null, {
    q: message.slice(0, 200),
    source,
  });
  return { status: 200, body: { reply, source } };
}

/**
 * The earlier turns the browser sends up with a question.
 *
 * Only the member's own turns are kept. The client used to be able to post
 * turns as `role: "model"` too, which is the browser telling the model what the
 * model supposedly already said — a free hand to write the assistant's past for
 * it, and from there to talk it past the system prompt into quoting a discount
 * or a free court that does not exist.
 *
 * The cost is real and worth naming: with no assistant turns to look back on, a
 * follow-up that leans on the last answer ("what about the other one?") has
 * less to go on. Fixing that properly means the server keeping the thread
 * itself, which needs a table it does not have — this is the honest version
 * until then, because a confident wrong answer the member themselves planted is
 * worse than a vaguer right one.
 */
function parseHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatTurn[] = [];
  for (const item of raw.slice(-8)) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { role?: unknown; text?: unknown };
    if (rec.role !== "me" && rec.role !== "user") continue;
    const text = typeof rec.text === "string" ? rec.text.trim().slice(0, 800) : "";
    if (text.length < 1) continue;
    out.push({ role: "user", text });
  }
  return out;
}

/**
 * What the assistant calls the centre when it talks to a member.
 *
 * Read from `center_settings` rather than written into the prompt: the centre
 * was renamed to Lê Long Sport (migration 0041) and the assistant carried on
 * introducing itself as Arena3 — to the one audience that would notice. The
 * fallback matches the invoice header's (`desk.ts`), so a blank row never
 * leaves a member reading "undefined".
 */
function centreName(settings: { legal_name: string | null }): string {
  // `||`, not `??`: a settings row saved with the field cleared holds "", and
  // `??` would hand that straight to the member as " is open 06:00-22:00".
  return settings.legal_name?.trim() || "Lê Long Sport";
}

function ruleReply(
  q: string,
  settings: Awaited<ReturnType<typeof getSettings>>,
  onSale: Array<{ sport: string; level: string; price_vnd: number }>,
  classes: Array<{ sport: string; level: string; enrolled_count: number; capacity: number }>,
): string {
  if (/price|cost|how much|fee|giá/.test(q)) {
    return onSale.length
      ? `Classes on sale:\n${onSale.map((c) => `• ${c.sport} ${c.level}: ${c.price_vnd.toLocaleString("en-US")}đ`).join("\n")}\nPay at the desk after you enrol in the app.`
      : "No class has a price listed right now — ask the desk.";
  }
  if (/hour|open|close|what time|giờ|mở cửa/.test(q)) {
    return `${centreName(settings)} is open ${settings.open_time.slice(0, 5)}–${settings.close_time.slice(0, 5)} every day (ICT). Court holds last ${settings.hold_minutes} minutes. Cancelling a court gives no refund.`;
  }
  if (/class|coach|lesson|lớp|hlv/.test(q)) {
    return classes.length
      ? `Open classes:\n${classes.map((c) => `• ${c.sport} ${c.level} (${c.enrolled_count}/${c.capacity})`).join("\n")}`
      : "No classes are open right now — ask the desk.";
  }
  if (/cancel|book|hold|hủy|đặt sân/.test(q)) {
    return `Book in the app and the slot is held for ${settings.hold_minutes} minutes. Cancelling a court or a class gives no refund, so check the time first. If the centre cancels, you get the money back in cash at the desk. No-shows are not refunded.`;
  }
  if (/waitlist|full|queue|chờ|đầy/.test(q)) {
    return `When a class is full you join a first-come waitlist. If a seat frees up you get an offer that stands for ${settings.waitlist_offer_hours}h — claim it in the app.`;
  }
  return `I can help with the timetable, classes, coaches, booking and cancelling, and waitlists at ${centreName(settings)}. Start a message with ticket: to send a note to the desk. I do not give medical advice.`;
}


export async function ticketsCreate(sql: Sql, request: Request, user: PublicUser) {
  await requireFlag(sql, "F6");
  // Same stripping as the assistant route: a member who typed "ticket:" into
  // the support box is repeating the habit the assistant taught them.
  const body = ticketBody(str((await readJson(request)).body) ?? "").slice(0, 2000);
  if (body.length < 2) throw err.validation("The message is empty.");
  ticketQuota(user.id);
  const row = await one(sql, `insert into tickets (user_id, body) values ($1,$2) returning *`, [user.id, body]);
  return { status: 201, body: row };
}

/**
 * The member's own side of customer care.
 *
 * Closed tickets come back too. A request that has been answered is the most
 * useful row on this screen — it is the answer — and hiding it the moment the
 * desk replies would mean the reply is only ever seen if the member happens to
 * be looking when the notification lands.
 */
export async function ticketsMine(sql: Sql, request: Request, user: PublicUser) {
  const { limit: take, offset } = pageParams(request, { def: 50, max: 100 });
  const rows = await sql.query<{ total: number } & Record<string, unknown>>(
    `select t.id, t.body, t.status, t.created_at, t.reply, t.replied_at,
            s.full_name as replied_by_name, count(*) over ()::int as total
       from tickets t
       left join users s on s.id = t.replied_by
      where t.user_id = $1
      order by t.created_at desc
      limit $2 offset $3`,
    [user.id, take, offset],
  );
  const body = await pageOf(rows, { limit: take, offset }, async () =>
    ((await one<{ n: number }>(sql, `select count(*)::int as n from tickets where user_id = $1`, [user.id]))?.n ?? 0),
  );
  return { status: 200, body };
}

export async function ticketsList(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  // The desk works the open queue, but wants to be able to read back what it
  // told somebody last week without opening the database.
  const all = new URL(request.url).searchParams.get("status") === "all";
  const { limit: take, offset } = pageParams(request, { def: 50, max: 100 });
  const rows = await sql.query<{ total: number } & Record<string, unknown>>(
    `select t.id, t.body, t.status, t.created_at, t.reply, t.replied_at,
            u.full_name, u.phone, u.member_code,
            s.full_name as replied_by_name, count(*) over ()::int as total
       from tickets t
       left join users u on u.id = t.user_id
       left join users s on s.id = t.replied_by
      where ($1::bool or t.status = 'open')
      order by t.status = 'open' desc, t.created_at desc
      limit $2 offset $3`,
    [all, take, offset],
  );
  const body = await pageOf(rows, { limit: take, offset }, async () =>
    ((await one<{ n: number }>(sql, `select count(*)::int as n from tickets where ($1::bool or status = 'open')`, [all]))?.n ?? 0),
  );
  return { status: 200, body };
}

/**
 * Reception answers, and the member is told there is an answer.
 *
 * Replying closes the ticket in the same statement rather than leaving that as
 * a second button: an answered request that stays in the open queue is one a
 * colleague will answer again. Reopening is the member's move — they send
 * another note — which is also the honest signal that the first answer did not
 * land.
 *
 * So each request carries exactly one answer. A second attempt is refused
 * rather than written over the first, which is what used to happen and left
 * nobody able to see what the member had already been told.
 */
export async function ticketReply(sql: Sql, id: string, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  const reply = (str((await readJson(request)).reply) ?? "").trim().slice(0, 2000);
  if (reply.length < 2) throw err.validation("Write a reply first.");
  const t = await one<{ id: string; user_id: string | null; status: string; reply: string | null }>(
    sql,
    `select id, user_id, status, reply from tickets where id = $1 for update`,
    [id],
  );
  if (!t) throw err.notFound();
  // An answer already sent is not overwritten. It is what the member was told
  // and what they can still read on their Support screen; replacing it would
  // leave no record that the first answer was ever given. 409 rather than 422:
  // the reply the desk typed is fine, the ticket is simply past this point.
  //
  // A ticket closed *without* an answer is still answerable — `ticketClose`
  // leaves exactly that state, and refusing it would turn Close into a trap
  // that swallows the request.
  if (t.reply) {
    throw err.conflictState("That request has already been answered. The member can reply to reopen it.");
  }
  const row = await one(
    sql,
    `update tickets
        set reply = $2, replied_at = now(), replied_by = $3, status = 'closed'
      where id = $1
      returning *`,
    [id, reply, user.id],
  );
  // A ticket raised by a walk-in the desk typed in has nobody to notify.
  if (t.user_id) {
    await enqueue(
      sql,
      "inapp",
      "ticket_replied",
      t.user_id,
      { ticket_id: id, reply: reply.slice(0, 200) },
      // Keyed on the ticket alone. It used to carry `Date.now()`, which made
      // every call a new key and so turned `enqueue`'s `on conflict do nothing`
      // into a no-op — it was there for a second answer to the same ticket,
      // which the guard above no longer allows. One request, one answer, one
      // notification, even if Send is double-tapped.
      `ticket_replied|${id}`,
    );
  }
  await audit(sql, user.id, "ticket_reply", "ticket", id);
  return { status: 200, body: { ticket: row } };
}

/**
 * Reception closes a request without writing an answer.
 *
 * Used for the ones that need no reply — a duplicate, something already fixed,
 * a note the member followed up in person. The member is still told: their
 * Support screen showed "Waiting" for as long as the row existed, so closing
 * in silence meant the wait simply never visibly ended.
 *
 * Closing leaves `reply` null, which `ticketReply` reads as "still answerable":
 * the desk can change its mind and write back.
 */
export async function ticketClose(sql: Sql, id: string, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  const t = await one<{ id: string; user_id: string | null; status: string }>(
    sql,
    `select id, user_id, status from tickets where id = $1 for update`,
    [id],
  );
  if (!t) throw err.notFound();
  // Already closed. Answering `ok` is right — the caller wanted it closed and
  // it is — but a second audit row and a second notification are not: two
  // clicks on one button are still one decision.
  if (t.status === "closed") return { status: 200, body: { ok: true } };
  await sql.query(`update tickets set status = 'closed' where id = $1`, [id]);
  // A request the desk typed in for a walk-in has nobody to notify.
  if (t.user_id) {
    // Keyed on the ticket, not the moment: closing happens once.
    await enqueue(sql, "inapp", "ticket_closed", t.user_id, { ticket_id: id }, `ticket_closed|${id}`);
  }
  await audit(sql, user.id, "ticket_close", "ticket", id);
  return { status: 200, body: { ok: true } };
}
