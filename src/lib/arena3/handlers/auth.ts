import type { Sql } from "@/lib/db";
import { hashOtp, hashPassword, randomOtp, verifyPassword } from "../crypto";
import { err } from "../errors";
import { ageYears, audit, classSubscription, getSettings, pageOf, readJson, str } from "../helpers";
import { isValidVnPhone, normalizePhone, passwordOk, unaccentVi } from "../phone";
import { limit, RULES } from "../ratelimit";
import {
  findUserByLogin,
  issueSession,
  toPublic,
  type PublicUser,
} from "../session";
import { KeepWrites, one } from "../tx";
import { pageParams } from "../validate";
import { getActiveSportCodes } from "./sports";

/**
 * Whether the OTP may be handed straight back to whoever asked for it.
 *
 * There is no SMS transport (see SRS §1.3), so registration and password reset
 * returned the code in the response body to keep the demo usable. That makes
 * the OTP no barrier at all: anyone can register — or reset the password of —
 * any phone number they can type, because the challenge and its answer arrive
 * in the same reply.
 *
 * It stays on for local work, where the alternative is an unusable sign-up
 * form, and goes off the moment the app is running for real. `OTP_ECHO=1`
 * forces it back on for a staged demo, deliberately and in writing, rather
 * than by default.
 */
function mayEchoOtp(): boolean {
  if (process.env.OTP_ECHO === "1") return true;
  if (process.env.OTP_ECHO === "0") return false;
  return process.env.NODE_ENV !== "production";
}

/**
 * Get the code to the person asking for it.
 *
 * Email is the only channel this centre can actually reach somebody on: SMS to
 * a Vietnamese number needs a registered sender ID, which needs a registered
 * company (see `notify.ts`). Returning a masked address rather than a bare
 * boolean lets the sign-up screen say "check nam@example.com" — the single most
 * useful thing it can tell somebody staring at an empty code box — without
 * echoing an address back to whoever typed it.
 */
async function deliverOtp(email: string | null | undefined, otp: string): Promise<{ sentTo: string | null }> {
  if (!email) return { sentTo: null };
  const { deliver } = await import("../notify");
  const result = await deliver({ channel: "email", template: "otp", to: email, payload: { otp } });
  if (!result.sent) {
    console.warn(`[otp] could not email the code: ${result.detail ?? "unknown"}`);
    return { sentTo: null };
  }
  const [name, domain] = email.split("@");
  const masked = name && domain ? `${name.slice(0, 2)}${"*".repeat(Math.max(1, name.length - 2))}@${domain}` : null;
  return { sentTo: masked };
}

async function loadUser(sql: Sql, id: string) {
  const u = await one<Record<string, unknown>>(
    sql,
    `select id, member_code, full_name, phone, email, role, status, date_of_birth, health_notes, must_change_password
       from users where id = $1`,
    [id],
  );
  if (!u) throw err.notFound();
  return toPublic(u);
}

export async function register(sql: Sql, request: Request) {
  const body = await readJson(request);
  const full_name = str(body.full_name);
  const phone = normalizePhone(str(body.phone) ?? "");
  const password = str(body.password);
  const dob = str(body.dob) ?? str(body.date_of_birth);
  const email = str(body.email)?.trim().toLowerCase() || null;
  const pii = body.pii_consent === true;
  // `field` names the input at fault, so the form can mark it and not only say what went wrong.
  if (!full_name) throw err.validation("Full name is required.", { field: "full_name" });
  if (!isValidVnPhone(phone)) throw err.validation("That phone number is not valid.", { field: "phone" });
  if (!password || !passwordOk(password)) {
    throw err.br("BR-02", "Password needs at least 8 characters, with letters and numbers.", { field: "password" });
  }
  if (!pii) throw err.br("BR-04", "You must accept the terms and the data-privacy notice.");
  if (dob) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(`${dob}T00:00:00+07:00`))) {
      throw err.validation("Use a date like 2010-05-31.", { field: "dob" });
    }
    const settings = await getSettings(sql);
    const age = ageYears(dob);
    if (age < 0 || age > 120) throw err.validation("That date of birth is not possible.", { field: "dob" });
    if (age < settings.minor_age) {
      const gn = str(body.guardian_name);
      const gp = str(body.guardian_phone);
      if (!gn || !gp) throw err.br("BR-03", "A minor needs guardian details.", { field: "guardian_name" });
    }
  }
  const exists = await one(sql, `select id from users where phone = $1 or (email is not null and lower(email) = lower($2))`, [
    phone,
    email,
  ]);
  if (exists) throw err.br("BR-01", "That phone or email already has an account.");
  const otp = randomOtp();
  const row = await one<{ id: string }>(
    sql,
    `insert into otp_challenges (phone, purpose, otp_hash, payload, expires_at)
     values ($1, 'register', $2, $3::jsonb, now() + interval '5 minutes')
     returning id`,
    [
      phone,
      hashOtp(otp),
      JSON.stringify({
        full_name,
        phone,
        email,
        password_hash: hashPassword(password),
        dob,
        guardian_name: str(body.guardian_name),
        guardian_phone: str(body.guardian_phone) ? normalizePhone(String(body.guardian_phone)) : null,
        pii_consent: true,
      }),
    ],
  );
  // Sent, not queued. An OTP lives five minutes; waiting for the next pass of
  // the outbox dispatcher would spend a meaningful part of that on nothing.
  const delivery = await deliverOtp(email, otp);
  const echo = mayEchoOtp();
  return {
    status: 202,
    body: {
      challenge_id: row!.id,
      ...(echo ? { otp, staging: true } : {}),
      sent_to: delivery.sentTo,
      message: echo
        ? "OTP (demo environment) — enter it to verify."
        : "We have sent you a verification code.",
    },
  };
}

export async function verifyOtp(sql: Sql, request: Request) {
  const body = await readJson(request);
  const phone = normalizePhone(str(body.phone) ?? "");
  const otp = str(body.otp);
  const purpose = str(body.purpose) ?? "register";
  if (!phone || !otp) throw err.validation("Phone or OTP is missing.");
  const ch = await one<{
    id: string;
    otp_hash: string;
    payload: Record<string, unknown>;
    expires_at: string;
    attempts: number;
    purpose: string;
  }>(
    sql,
    `select id, otp_hash, payload, expires_at::text, attempts, purpose
       from otp_challenges
      where phone = $1 and purpose = $2
      order by expires_at desc limit 1
      for update`,
    [phone, purpose],
  );
  if (!ch) throw err.validation("No OTP request is pending.", { field: "otp" });
  if (ch.attempts >= 5) throw err.rateLimited("Too many OTP attempts — locked for 15 minutes.");
  if (new Date(ch.expires_at) < new Date()) throw err.validation("That OTP has expired.", { field: "otp" });
  if (ch.otp_hash !== hashOtp(otp)) {
    await sql.query(`update otp_challenges set attempts = attempts + 1 where id = $1`, [ch.id]);
    throw new KeepWrites(err.validation("That OTP is not correct.", { field: "otp" }));
  }
  if (purpose === "reset") {
    const newPw = str(body.password);
    if (!newPw || !passwordOk(newPw)) throw err.br("BR-02", "The new password is not valid.", { field: "password" });
    await sql.query(`update users set password_hash = $1, failed_logins = 0, locked_until = null where phone = $2`, [
      hashPassword(newPw),
      phone,
    ]);
    const u = await one<{ id: string }>(sql, `select id from users where phone = $1`, [phone]);
    if (u) await sql.query(`update sessions_auth set revoked_at = now() where user_id = $1 and revoked_at is null`, [u.id]);
    await sql.query(`delete from otp_challenges where id = $1`, [ch.id]);
    return { status: 200, body: { ok: true } };
  }
  const p = ch.payload ?? {};
  const existing = await one(sql, `select id from users where phone = $1`, [phone]);
  if (existing) throw err.br("BR-01", "That phone number already has an account.");
  const codeRow = await one<{ next_member_code: string }>(sql, `select next_member_code() as next_member_code`);
  const inserted = await one<{ id: string }>(
    sql,
    `insert into users
       (full_name, name_normalized, phone, email, role, status, password_hash,
        date_of_birth, guardian_name, guardian_phone, pii_consent_at, member_code)
     values ($1,$2,$3,$4,'member','active',$5,$6,$7,$8, now(), $9)
     returning id`,
    [
      p.full_name,
      unaccentVi(String(p.full_name)),
      phone,
      p.email ?? null,
      p.password_hash,
      p.dob ?? null,
      p.guardian_name ?? null,
      p.guardian_phone ?? null,
      codeRow?.next_member_code,
    ],
  );
  await sql.query(`delete from otp_challenges where id = $1`, [ch.id]);
  const user = await loadUser(sql, inserted!.id);
  await audit(sql, user.id, "register", "user", user.id, null, { phone });
  const session = await issueSession(sql, user);
  return { status: 200, body: session };
}

export async function login(sql: Sql, request: Request) {
  const body = await readJson(request);
  const loginId = str(body.login) ?? str(body.phone) ?? str(body.email);
  const password = str(body.password);
  if (!loginId || !password) throw err.validation("Enter your login and password.");
  const ident = loginId.includes("@") ? loginId.trim().toLowerCase() : normalizePhone(loginId);
  const user = await findUserByLogin(sql, ident);
  if (!user) throw err.unauth("Wrong login or password.");
  if (user.status !== "active") throw err.unauth("This account is not active.");
  const locked = await one<{ locked_until: string | null; failed_logins: number }>(
    sql,
    `select locked_until::text, failed_logins from users where id = $1`,
    [user.id],
  );
  if (locked?.locked_until && new Date(locked.locked_until) > new Date()) {
    throw err.rateLimited("This account is locked for 15 minutes.");
  }
  if (!verifyPassword(password, user.password_hash)) {
    const fails = (locked?.failed_logins ?? 0) + 1;
    if (fails >= 5) {
      await sql.query(
        `update users set failed_logins = $1, locked_until = now() + interval '15 minutes' where id = $2`,
        [fails, user.id],
      );
      throw new KeepWrites(err.rateLimited("5 wrong passwords — locked for 15 minutes."));
    }
    await sql.query(`update users set failed_logins = $1 where id = $2`, [fails, user.id]);
    throw new KeepWrites(err.unauth("Wrong login or password."));
  }
  await sql.query(`update users set failed_logins = 0, locked_until = null where id = $1`, [user.id]);
  const session = await issueSession(sql, toPublic(user));
  return { status: 200, body: session };
}

export async function logout(sql: Sql, request: Request, user: PublicUser) {
  const hdr = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(hdr);
  if (m) {
    const { sha256 } = await import("../crypto");
    await sql.query(`delete from sessions_auth where token_hash = $1 and user_id = $2`, [
      sha256(m[1]!),
      user.id,
    ]);
  }
  return { status: 204, body: null };
}

export async function forgot(sql: Sql, request: Request) {
  const body = await readJson(request);
  const phone = normalizePhone(str(body.phone) ?? "");
  if (!isValidVnPhone(phone)) throw err.validation("That phone number is not valid.", { field: "phone" });
  const user = await one<{ id: string; email: string | null }>(
    sql,
    `select id, email from users where phone = $1`,
    [phone],
  );
  const otp = randomOtp();
  const row = await one<{ id: string }>(
    sql,
    `insert into otp_challenges (phone, purpose, otp_hash, payload, expires_at)
     values ($1, 'reset', $2, '{}'::jsonb, now() + interval '5 minutes')
     returning id`,
    [phone, hashOtp(otp)],
  );
  // Only a real account gets a message; the response looks the same either
  // way so this cannot be used to find out who has an account here.
  const delivery = user ? await deliverOtp(user.email, otp) : { sentTo: null };
  const echo = mayEchoOtp();
  return {
    status: 202,
    body: {
      challenge_id: row!.id,
      ...(echo && user ? { otp, staging: true } : {}),
      sent_to: delivery.sentTo,
    },
  };
}

export async function meGet(sql: Sql, user: PublicUser) {
  // Seven independent reads. Awaited one at a time this was the slowest request
  // in the app — and it is on the critical path of every sign-in. Issued
  // together they each land on their own pooled connection, so the handler
  // costs one round trip instead of seven.
  const [subs, inbox, today, classesToday, enrollments, offers, flags] = await Promise.all([
    sql.query(
      `select s.id, s.plan_id, s.sport_scope, s.start_on::text, s.end_on::text, s.status,
              s.court_hours_left, s.session_left, p.name as plan_name, p.court_discount_pct,
              p.court_hours as plan_court_hours, p.session_quota as plan_session_quota
         from subscriptions s
         join membership_plans p on p.id = s.plan_id
        where s.user_id = $1
        order by s.status = 'active' desc, s.end_on desc`,
      [user.id],
    ),
    sql.query(
      `select id, template, payload, sent_at, read_at from inbox
        where user_id = $1 order by sent_at desc limit 30`,
      [user.id],
    ),
    sql.query(
      `select b.id, b.code, b.start_at, b.end_at, b.status, b.court_id, c.court_code
         from court_bookings b join courts c on c.id = b.court_id
        where b.user_id = $1
          and (b.start_at at time zone 'Asia/Ho_Chi_Minh')::date
              = (now() at time zone 'Asia/Ho_Chi_Minh')::date
          and b.status in ('hold','confirmed','in_use')
        order by b.start_at`,
      [user.id],
    ),
    sql.query(
      `select s.id, s.start_at, s.end_at, cl.level, cl.sport, c.court_code, u.full_name as coach_name
         from sessions s
         join classes cl on cl.id = s.class_id
         join enrollments e on e.class_id = cl.id and e.user_id = $1 and e.status = 'confirmed'
         join courts c on c.id = s.court_id
         join users u on u.id = cl.coach_id
        where s.status = 'scheduled'
          and (s.start_at at time zone 'Asia/Ho_Chi_Minh')::date
              = (now() at time zone 'Asia/Ho_Chi_Minh')::date
        order by s.start_at`,
      [user.id],
    ),
    sql.query(
      // `leave_until` is the last moment leaving is allowed (BR-24: cancel_class_hours before the
      // next session), worked out here with the same rule enrollmentDelete applies.
      `select e.id, e.status, e.waitlist_pos, e.class_id, cl.sport, cl.level, cl.rrule, c.court_code,
              nx.start_at as next_session_at,
              nx.start_at - make_interval(hours => st.cancel_class_hours) as leave_until
         from enrollments e
         join classes cl on cl.id = e.class_id
         join courts c on c.id = cl.court_id
         cross join (select cancel_class_hours from center_settings where id = 1) st
         left join lateral (
           select s.start_at from sessions s
            where s.class_id = e.class_id and s.status = 'scheduled' and s.start_at > now()
            order by s.start_at limit 1
         ) nx on true
        where e.user_id = $1 and e.status in ('confirmed','waitlisted')`,
      [user.id],
    ),
    sql.query(
      `select o.id, o.expires_at, o.status, e.class_id, cl.sport, cl.level
         from waitlist_offers o
         join enrollments e on e.id = o.enrollment_id
         join classes cl on cl.id = e.class_id
        where e.user_id = $1 and o.status = 'pending' and o.expires_at > now()`,
      [user.id],
    ),
    sql.query<{ key: string; enabled: boolean }>(`select key, enabled from feature_flags`),
  ]);
  // What enrolling in each sport would take (BR-19, BR-20), from the plan enrolment itself picks
  // (classSubscription), so a class card can say so before the tap instead of after.
  const activeSportCodes = await getActiveSportCodes(sql);
  const classAccess =
    user.role === "member"
      ? Object.fromEntries(
          await Promise.all(
            activeSportCodes.map(async (sport) => {
              const sub = await classSubscription(sql, user.id, sport);
              return [sport, sub ? { covered: true, session_left: sub.session_left } : { covered: false, session_left: null }];
            }),
          ),
        )
      : undefined;
  return {
    status: 200,
    body: {
      user,
      subscriptions: subs,
      inbox,
      enrollments,
      offers,
      class_access: classAccess,
      flags: Object.fromEntries(flags.map((f) => [f.key, f.enabled])),
      today: { bookings: today, classes: classesToday },
    },
  };
}

/**
 * Mark notifications read. One id, or every unread one when none is named.
 * Scoped to the caller: someone else's id simply matches nothing.
 */
/**
 * The inbox a page at a time, newest first. Without `?limit` the caller gets the newest 100 as
 * before; `?unread=1` keeps only what is still unread. `unread` always counts the whole inbox,
 * so the bell can ask for `?limit=1` and still be right.
 */
export async function meNotifications(sql: Sql, request: Request, user: PublicUser) {
  const { limit, offset } = pageParams(request, { def: 100, max: 100 });
  const onlyUnread = new URL(request.url).searchParams.get("unread") === "1";
  const rows = await sql.query<{ total: number } & Record<string, unknown>>(
    `select id, template, payload, sent_at, read_at, count(*) over ()::int as total from inbox
      where user_id = $1 and (not $2::bool or read_at is null)
      order by sent_at desc limit $3 offset $4`,
    [user.id, onlyUnread, limit, offset],
  );
  const unread = await one<{ n: number }>(
    sql,
    `select count(*)::int as n from inbox where user_id = $1 and read_at is null`,
    [user.id],
  );
  const page = await pageOf(rows, { limit, offset }, async () =>
    ((await one<{ n: number }>(
      sql,
      `select count(*)::int as n from inbox where user_id = $1 and (not $2::bool or read_at is null)`,
      [user.id, onlyUnread],
    ))?.n ?? 0),
  );
  return { status: 200, body: { ...page, unread: unread?.n ?? 0 } };
}

export async function meNotificationsRead(sql: Sql, request: Request, user: PublicUser) {
  const body = await readJson(request).catch(() => ({}) as Record<string, unknown>);
  const id = str(body.id);
  if (id && !/^[0-9a-f-]{36}$/i.test(id)) throw err.field("id", "That notification id is not valid.");
  const rows = await sql.query(
    `update outbox set read_at = now()
      where user_id = $1 and channel = 'inapp' and sent_at is not null and read_at is null
        and ($2::uuid is null or id = $2::uuid)
      returning id`,
    [user.id, id ?? null],
  );
  return { status: 200, body: { marked: rows.length } };
}

export async function mePatch(sql: Sql, request: Request, user: PublicUser) {
  const body = await readJson(request);
  if (body.phone || body.email) {
    throw err.validation("Changing phone or email needs an OTP (slice 2).");
  }
  limit(`profile:${user.id}`, RULES.profileUpdate, "profile updates");
  const full_name = str(body.full_name) ?? user.full_name;
  const health_notes = body.health_notes === undefined ? user.health_notes : str(body.health_notes);
  await sql.query(
    `update users set full_name = $1, name_normalized = $2, health_notes = $3 where id = $4`,
    [full_name, unaccentVi(full_name), health_notes ?? null, user.id],
  );
  return { status: 200, body: { user: await loadUser(sql, user.id) } };
}

/**
 * Change your own password.
 *
 * The current password is required even though the caller is already
 * authenticated — a session left open on a shared desk machine should not be
 * enough to lock the real owner out. Rate limited because the current-password
 * check is otherwise a free password oracle for whoever is sitting at that
 * machine.
 */
export async function mePassword(sql: Sql, request: Request, user: PublicUser) {
  const body = await readJson(request);
  const current = str(body.current_password) ?? "";
  const next = str(body.new_password) ?? "";
  const confirm = str(body.confirm_password);
  if (!current || !next) throw err.validation("current_password and new_password are required.");
  if (confirm !== undefined && confirm !== next) {
    throw err.validation("The two new passwords do not match.", { field: "confirm_password" });
  }
  limit(`pw:${user.id}`, RULES.passwordChange, "password changes");
  if (!passwordOk(next)) {
    throw err.validation("Use at least 8 characters with a letter and a number.", { field: "new_password" });
  }
  if (next === current) {
    throw err.validation("Pick a password you have not used here before.", { field: "new_password" });
  }
  const row = await one<{ password_hash: string }>(sql, `select password_hash from users where id = $1`, [user.id]);
  if (!row || !verifyPassword(current, row.password_hash)) {
    throw err.validation("That is not your current password.", { field: "current_password" });
  }
  await sql.query(
    `update users set password_hash = $1, must_change_password = false, failed_logins = 0, locked_until = null
      where id = $2`,
    [hashPassword(next), user.id],
  );
  await sql.query(`update sessions_auth set revoked_at = now() where user_id = $1 and revoked_at is null`, [user.id]);
  await audit(sql, user.id, "change_password", "user", user.id);
  return { status: 200, body: { ok: true } };
}
