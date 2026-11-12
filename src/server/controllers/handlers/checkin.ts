/**
 * Check-in at the door (SRS v1.4.1 FR-TRN-02, FR-CRT-07, UC-12, UC-17; BR-30, BR-31, BR-32).
 *
 * Three ways in, all of which write the same `gate` visit and nothing else —
 * a class register is the coach's call (BR-33), so walking through the gate
 * never marks anyone present at a session and never touches a balance (BR-32):
 *
 *  1. QR (default): the member opens their code, reception scans it.   method = qr
 *  2. Manual: no phone → look the member up, pick a reason.            method = manual
 *  3. Self (optional, off by default): the member scans the desk's QR. method = self
 *
 * Nothing booked and no class today is not a hard stop — reception decides —
 * but if there is nothing at all to let them in on, reception must say why,
 * and the visit is flagged (BR-31). Plans no longer exist, so they are not read here.
 */
import type { Sql } from "@/server/data/db";
import { ApiError, err } from "../errors";
import { requireFlag } from "../../services/flags";
import { audit, getSettings, pageOf, readJson, str } from "../helpers";
import { signCheckinToken, verifyCheckinToken } from "../../services/checkin";
import { normalizePhone } from "../../services/phone";
import { avatarUrlSql, requireRole, withAvatarUrl, type PublicUser } from "../session";
import { addDays, ictDateString, ictDateTime } from "../../../shared/arena3/time";
import { one } from "../tx";
import { pageParams } from "../validate";
import { bookingsCheckIn } from "./bookings";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MANUAL_REASONS = ["no_phone", "dead_battery", "qr_failed", "forgot", "other"] as const;
export const OVERRIDE_REASONS = ["expired_ok", "manager_ok", "guest_pass", "renewing", "other"] as const;

type Member = { id: string; full_name: string; member_code: string | null; status: string; avatar_url: string | null };

async function findMember(sql: Sql, b: Record<string, unknown>): Promise<Member> {
  const id = str(b.member_id) || null;
  const code = str(b.code) || null;
  const phone = str(b.phone) || null;
  const q = str(b.q) || null;
  if (!id && !code && !phone && !q) {
    throw err.field("q", "Type a name, phone number or member code.");
  }
  const cols = `select id, full_name, member_code, status::text as status, ${avatarUrlSql("users")} from users where role = 'member'`;
  let rows: Member[] = [];
  if (id) {
    if (!UUID_RE.test(id)) throw err.field("member_id", "member_id is not valid.");
    rows = (await sql.query<Member>(`${cols} and id = $1`, [id])).map(withAvatarUrl);
  } else if (code) {
    rows = (await sql.query<Member>(`${cols} and upper(member_code) = upper($1)`, [code])).map(withAvatarUrl);
  } else if (phone) {
    rows = (await sql.query<Member>(`${cols} and phone = $1`, [normalizePhone(phone)])).map(withAvatarUrl);
  } else {
    const digits = (q as string).replace(/\D/g, "");
    rows = (await sql.query<Member>(
      `${cols} and (upper(member_code) = upper($1) or ($2 <> '' and phone like '%' || $2)
                    or name_normalized like '%' || lower($1) || '%')
        order by full_name limit 6`,
      [q, digits.length >= 4 ? digits : ""],
    )).map(withAvatarUrl);
    if (rows.length > 1) {
      throw err.conflictState("More than one member matches — pick one.", {
        candidates: rows.map((r) => ({ id: r.id, full_name: r.full_name, member_code: r.member_code })),
      });
    }
  }
  if (!rows[0]) throw err.notFound("No member matches that.");
  if (rows[0].status !== "active") {
    throw err.conflictState("This account is not active.", { member_status: rows[0].status });
  }
  return rows[0];
}

/** What reception needs to see in the five seconds after a scan. */
async function memberToday(sql: Sql, memberId: string) {
  const today = ictDateString();
  const dayStart = ictDateTime(today, "00:00").toISOString();
  const dayEnd = ictDateTime(addDays(today, 1), "00:00").toISOString();
  const warnings: { kind: string; message: string }[] = [];
  const bookings = await sql.query(
    `select b.id, b.code, b.start_at, b.end_at, c.court_code, b.status::text as status
       from court_bookings b join courts c on c.id = b.court_id
      where b.user_id = $1 and b.status in ('confirmed','in_use') and b.start_at >= $2 and b.start_at < $3
      order by b.start_at`,
    [memberId, dayStart, dayEnd],
  );
  const sessions = await sql.query(
    `select s.id, s.start_at, s.end_at, cl.sport::text as sport, cl.level, c.court_code
       from sessions s
       join classes cl on cl.id = s.class_id
       join courts c on c.id = s.court_id
       join enrollments e on e.class_id = cl.id and e.user_id = $1 and e.status = 'confirmed'
      where s.status = 'scheduled' and s.start_at >= $2 and s.start_at < $3
      order by s.start_at`,
    [memberId, dayStart, dayEnd],
  );
  // Something to let them in on: a court booked today or a class today.
  const entitled = bookings.length > 0 || sessions.length > 0;
  return { warnings, bookings, sessions, entitled };
}

type VisitInput = {
  member: Member;
  method: "qr" | "manual" | "self";
  actorId: string | null;
  reason?: string | null;
  flagged?: boolean;
};

/** Write the visit, or return the one already written inside the dedup window (BR-31). */
async function recordVisit(sql: Sql, v: VisitInput) {
  const settings = await getSettings(sql);
  const since = new Date(Date.now() - settings.gate_dedup_minutes * 60_000).toISOString();
  const recent = await one<{ at: string; method: string | null }>(
    sql,
    `select at, method from attendance where user_id = $1 and kind = 'gate' and at > $2 order by at desc limit 1`,
    [v.member.id, since],
  );
  if (recent) return { at: recent.at, duplicate: true, method: recent.method };
  const row = await one<{ at: string }>(
    sql,
    `insert into attendance (kind, user_id, method, flagged, reason, checked_by)
     values ('gate', $1, $2, $3, $4, $5) returning at`,
    [v.member.id, v.method, v.flagged ?? false, v.reason ?? null, v.actorId],
  );
  return { at: row?.at ?? new Date().toISOString(), duplicate: false, method: v.method };
}

function validReason(list: readonly string[], v: unknown, field: string, label: string): string {
  const r = str(v);
  if (!r || !list.includes(r)) throw err.field(field, `Choose ${label}.`);
  return r;
}

/**
 * Scan a code. The token says who or what it is for; staff only ever see the result.
 * Member code → gate visit. Booking code → check the booking in as well.
 */
export async function deskScan(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  await requireFlag(sql, "F4");
  const b = await readJson(request);
  const raw = str(b.token) || str(b.code) || str(b.q) || "";
  if (!raw.trim()) throw err.field("token", "Please enter or scan a code.");

  let t: ReturnType<typeof verifyCheckinToken> | null = null;
  try {
    t = verifyCheckinToken(raw);
  } catch (e) {
    if (b.token !== undefined || raw.includes(".")) throw e;
    // If raw is not a valid HMAC token and wasn't sent as `token`, see if it matches a member code or phone number directly
  }

  if (t) {
    if (t.kind === "desk") throw err.br("BR-30", "That is the desk code — a member scans it, reception does not.");
    const memberId =
      t.kind === "member"
        ? t.sub
        : (await one<{ user_id: string | null }>(sql, `select user_id from court_bookings where id = $1`, [t.sub]))
            ?.user_id;
    if (!memberId) throw err.notFound("That booking has no member to check in.");
    const member = await findMember(sql, { member_id: memberId });
    const today = await memberToday(sql, member.id);
    // Asking reception to decide writes nothing, so it must not spend the code:
    // the retry with an override reason carries the same one.
    if (!today.entitled && b.override !== true) return await overrideOrAsk(sql, b, member, today, "qr", user);
    // Single use: the second scan of the same code is refused, not silently accepted.
    const first = await sql.query<{ jti: string }>(
      `insert into checkin_tokens (jti, user_id) values ($1, $2) on conflict (jti) do nothing returning jti`,
      [t.jti, memberId],
    );
    if (first.length === 0) throw err.br("BR-30", "That code was already used — ask the member to refresh it.");
    if (!today.entitled) return await overrideOrAsk(sql, b, member, today, "qr", user);
    const visit = await recordVisit(sql, { member, method: "qr", actorId: user.id });
    let booking: unknown = null;
    let bookingNote: string | null = null;
    if (t.kind === "booking") {
      // Walking in early (or late) is still a gate visit; only the court itself waits
      // for its own window (BR-11). The handler refuses before it writes anything.
      try {
        booking = (await bookingsCheckIn(sql, t.sub, user)).body;
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        bookingNote = e.message;
      }
    }
    if (!visit.duplicate) await audit(sql, user.id, "gate_checkin", "user", member.id, null, { method: "qr" });
    return result(member, today, visit, {
      booking,
      ...(bookingNote ? { warnings: [...today.warnings, { kind: "booking", message: `Court not checked in: ${bookingNote}` }] } : {}),
    });
  }

  // Fallback: scanned or typed member code, barcode, or phone number
  const member = await findMember(sql, { q: raw });
  const today = await memberToday(sql, member.id);
  if (!today.entitled && b.override !== true) return await overrideOrAsk(sql, b, member, today, "manual", user, "qr_failed");
  const visit = await recordVisit(sql, { member, method: "manual", actorId: user.id, reason: "qr_failed" });
  if (!visit.duplicate) await audit(sql, user.id, "gate_checkin", "user", member.id, null, { method: "manual", code: raw });
  return result(member, today, visit);
}

/** Look a member up and let them in without a phone. A reason is mandatory. */
export async function gateCheckin(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  await requireFlag(sql, "F4");
  const b = await readJson(request);
  const member = await findMember(sql, b);
  const reason = validReason(MANUAL_REASONS, b.reason, "reason", "why the code was not used");
  const today = await memberToday(sql, member.id);
  if (!today.entitled) return await overrideOrAsk(sql, b, member, today, "manual", user, reason);
  const visit = await recordVisit(sql, { member, method: "manual", actorId: user.id, reason });
  if (!visit.duplicate) await audit(sql, user.id, "gate_checkin", "user", member.id, null, { method: "manual", reason });
  return result(member, today, visit);
}

async function overrideOrAsk(
  sql: Sql,
  b: Record<string, unknown>,
  member: Member,
  today: Awaited<ReturnType<typeof memberToday>>,
  method: "qr" | "manual",
  user: PublicUser,
  manualReason?: string,
) {
  if (b.override !== true) {
    return {
      status: 200,
      body: {
        member: { id: member.id, full_name: member.full_name, member_code: member.member_code },
        allowed: false,
        needs_override: true,
        duplicate: false,
        checked_in_at: null,
        warnings: today.warnings,
        today: { bookings: today.bookings, sessions: today.sessions },
      },
    };
  }
  const why = validReason(OVERRIDE_REASONS, b.override_reason, "override_reason", "why this member may come in");
  const visit = await recordVisit(sql, {
    member,
    method,
    actorId: user.id,
    reason: manualReason ? `${manualReason}; ${why}` : why,
    flagged: true,
  });
  if (!visit.duplicate) {
    await audit(sql, user.id, "gate_checkin_override", "user", member.id, null, { method, reason: why });
  }
  return result(member, today, visit, { flagged: true });
}

function result(
  member: Member,
  today: Awaited<ReturnType<typeof memberToday>>,
  visit: { at: string; duplicate: boolean },
  extra: Record<string, unknown> = {},
) {
  return {
    status: 200,
    body: {
      member: { id: member.id, full_name: member.full_name, member_code: member.member_code, avatar_url: member.avatar_url },
      allowed: true,
      needs_override: false,
      checked_in_at: visit.at,
      duplicate: visit.duplicate,
      warnings: today.warnings,
      today: { bookings: today.bookings, sessions: today.sessions },
      ...extra,
    },
  };
}

/** Today's gate check-ins, newest first, a page at a time (a busy day passes a hundred). */
export async function gateCheckins(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  await requireFlag(sql, "F4");
  const { limit, offset } = pageParams(request, { def: 100, max: 100 });
  const today = ictDateString();
  const span = [ictDateTime(today, "00:00").toISOString(), ictDateTime(addDays(today, 1), "00:00").toISOString()];
  const rows = await sql.query<{ total: number } & Record<string, unknown>>(
    `select a.id, a.at, a.method, a.flagged, a.reason, u.id as user_id, u.full_name, u.member_code,
            ${avatarUrlSql("u")},
            count(*) over ()::int as total
       from attendance a join users u on u.id = a.user_id
      where a.kind = 'gate' and a.at >= $1 and a.at < $2
      order by a.at desc limit $3 offset $4`,
    [...span, limit, offset],
  );
  const body = await pageOf(rows.map(withAvatarUrl), { limit, offset }, async () =>
    ((await one<{ n: number }>(
      sql,
      `select count(*)::int as n from attendance where kind = 'gate' and at >= $1 and at < $2`,
      span,
    ))?.n ?? 0),
  );
  return { status: 200, body };
}

/** The member's own door code (UI-22). Short-lived and single use. */
export async function meCheckinToken(sql: Sql, user: PublicUser) {
  requireRole(user, ["member"]);
  const m = await one<{ member_code: string | null; full_name: string }>(
    sql,
    `select member_code, full_name from users where id = $1`,
    [user.id],
  );
  return {
    status: 200,
    body: {
      ...signCheckinToken("member", user.id),
      member_code: m?.member_code ?? null,
      full_name: m?.full_name ?? user.full_name,
    },
  };
}

/** The same, for one of the member's own court bookings. */
export async function meBookingCheckinToken(sql: Sql, bookingId: string, user: PublicUser) {
  requireRole(user, ["member"]);
  if (!UUID_RE.test(bookingId)) throw err.notFound();
  const b = await one<{ user_id: string | null; status: string }>(
    sql,
    `select user_id, status::text as status from court_bookings where id = $1`,
    [bookingId],
  );
  if (!b || b.user_id !== user.id) throw err.notFound();
  if (b.status !== "confirmed") throw err.conflictState("Only a confirmed booking has a check-in code.");
  return { status: 200, body: signCheckinToken("booking", bookingId) };
}

/** The rotating code shown on the front-desk screen for optional self check-in. */
export async function deskCheckinCode(sql: Sql, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  const settings = await getSettings(sql);
  return {
    status: 200,
    body: { enabled: settings.self_checkin_enabled, ...signCheckinToken("desk", "front-desk") },
  };
}

/** Member scans the desk code with their own phone. Only when the centre has switched it on. */
export async function meSelfCheckin(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["member"]);
  await requireFlag(sql, "F4");
  const settings = await getSettings(sql);
  if (!settings.self_checkin_enabled) {
    throw err.br("BR-30", "Self check-in is not switched on — show your code to the front desk.");
  }
  const t = verifyCheckinToken((await readJson(request)).token);
  if (t.kind !== "desk") throw err.br("BR-30", "That is not the desk code.");
  const member = await findMember(sql, { member_id: user.id });
  const today = await memberToday(sql, member.id);
  if (!today.entitled) {
    return {
      status: 200,
      body: {
        allowed: false,
        needs_override: true,
        warnings: today.warnings,
        message: "Please see the front desk — your membership needs attention.",
      },
    };
  }
  const visit = await recordVisit(sql, { member, method: "self", actorId: user.id });
  return { status: 200, body: { allowed: true, checked_in_at: visit.at, duplicate: visit.duplicate, warnings: today.warnings } };
}
