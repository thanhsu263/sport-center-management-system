import type { Sql } from "@/server/data/db";
import { hashOtp, hashPassword, randomOtp, randomToken, verifyPassword } from "../../services/crypto";
import { err } from "../errors";
import { ageYears, audit, getSettings, pageOf, readJson, str } from "../helpers";
import { isValidVnPhone, normalizePhone, passwordOk, unaccentVi } from "../../services/phone";
import { limit, RULES } from "../ratelimit";
import {
  findUserByLogin,
  issueSession,
  loadUser,
  toPublic,
  type PublicUser,
} from "../session";
import { KeepWrites, one } from "../tx";
import { pageParams } from "../validate";

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
  const { deliver } = await import("../../integrations/notify");
  const result = await deliver({ channel: "email", template: "otp", to: email, payload: { otp } });
  if (!result.sent) {
    console.warn(`[otp] could not email the code: ${result.detail ?? "unknown"}`);
    return { sentTo: null };
  }
  const [name, domain] = email.split("@");
  const masked = name && domain ? `${name.slice(0, 2)}${"*".repeat(Math.max(1, name.length - 2))}@${domain}` : null;
  return { sentTo: masked };
}

/** A new member's details, checked and ready to store. */
export type SignupFields = {
  full_name: string;
  phone: string;
  email: string | null;
  password_hash: string;
  dob: string | null;
  guardian_name: string | null;
  guardian_phone: string | null;
};

/**
 * The sign-up rules shared by the form (`register`) and Google (`googleRegister`).
 *
 * `password: false` is for Google: the person never chose one, so the account
 * gets a random one nobody knows, and "Forgot password" sets a real one later.
 * `email` is passed in rather than read from the body because Google's is the
 * verified one and must not be swapped for whatever the form sent.
 */
export async function checkSignup(
  sql: Sql,
  body: Record<string, unknown>,
  opts: { email: string | null; password: boolean },
): Promise<SignupFields> {
  const full_name = str(body.full_name);
  const phone = normalizePhone(str(body.phone) ?? "");
  const password = opts.password ? str(body.password) : randomToken();
  const dob = str(body.dob) ?? str(body.date_of_birth) ?? null;
  const email = opts.email;
  const pii = body.pii_consent === true;
  // `field` names the input at fault, so the form can mark it and not only say what went wrong.
  if (!full_name) throw err.validation("Full name is required.", { field: "full_name" });
  if (!isValidVnPhone(phone)) throw err.validation("That phone number is not valid.", { field: "phone" });
  if (!password || (opts.password && !passwordOk(password))) {
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
  return {
    full_name,
    phone,
    email,
    password_hash: hashPassword(password),
    dob,
    guardian_name: str(body.guardian_name) ?? null,
    guardian_phone: str(body.guardian_phone) ? normalizePhone(String(body.guardian_phone)) : null,
  };
}

/** Insert a checked member and sign them in. Both sign-up paths end here. */
export async function createMember(sql: Sql, f: SignupFields, action: string) {
  const existing = await one(sql, `select id from users where phone = $1`, [f.phone]);
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
      f.full_name,
      unaccentVi(f.full_name),
      f.phone,
      f.email,
      f.password_hash,
      f.dob,
      f.guardian_name,
      f.guardian_phone,
      codeRow?.next_member_code,
    ],
  );
  const user = await loadUser(sql, inserted!.id);
  await audit(sql, user.id, action, "user", user.id, null, { phone: f.phone });
  return { status: 200, body: await issueSession(sql, user) };
}

export async function register(sql: Sql, request: Request) {
  const body = await readJson(request);
  const fields = await checkSignup(sql, body, {
    email: str(body.email)?.trim().toLowerCase() || null,
    password: true,
  });
  const otp = randomOtp();
  const row = await one<{ id: string }>(
    sql,
    `insert into otp_challenges (phone, purpose, otp_hash, payload, expires_at)
     values ($1, 'register', $2, $3::jsonb, now() + interval '5 minutes')
     returning id`,
    [fields.phone, hashOtp(otp), JSON.stringify({ ...fields, pii_consent: true })],
  );
  const email = fields.email;
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
  await sql.query(`delete from otp_challenges where id = $1`, [ch.id]);
  return createMember(
    sql,
    {
      full_name: String(p.full_name),
      phone,
      email: (p.email as string | null) ?? null,
      password_hash: String(p.password_hash),
      dob: (p.dob as string | null) ?? null,
      guardian_name: (p.guardian_name as string | null) ?? null,
      guardian_phone: (p.guardian_phone as string | null) ?? null,
    },
    "register",
  );
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

/** sha256 of the bearer token on this request, or null. Never returned to the client. */
async function currentTokenHash(request: Request): Promise<string | null> {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!m) return null;
  const { sha256 } = await import("../../services/crypto");
  return sha256(m[1]!);
}

export async function logout(sql: Sql, request: Request, user: PublicUser) {
  const hash = await currentTokenHash(request);
  if (hash) {
    await sql.query(`delete from sessions_auth where token_hash = $1 and user_id = $2`, [
      hash,
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
      `select s.id, s.plan_id, s.start_on::text, s.end_on::text, s.status,
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
      `select e.id, e.status,
              case when e.status = 'waitlisted' then (select count(*) from enrollments w where w.class_id = e.class_id and w.status = 'waitlisted' and (w.waitlist_pos, w.id) <= (e.waitlist_pos, e.id)) end as waitlist_pos,
              e.class_id, cl.sport, cl.level, cl.rrule, c.court_code,
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
  return {
    status: 200,
    body: {
      user,
      subscriptions: subs,
      inbox,
      enrollments,
      offers,
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
  let full_name = user.full_name;
  if (body.full_name !== undefined) {
    const name = typeof body.full_name === "string" ? body.full_name.trim() : "";
    if (!name) throw err.field("full_name", "Full name is required.");
    if (name.length > 120) throw err.field("full_name", "Full name must be at most 120 characters.");
    full_name = name;
  }
  // Health notes are read by coaches before a member's session; staff have none (D1).
  let health_notes = user.health_notes;
  if (user.role === "member" && body.health_notes !== undefined) {
    const notes = typeof body.health_notes === "string" ? body.health_notes.trim() : "";
    if (notes.length > 1000) throw err.field("health_notes", "Health notes must be at most 1000 characters.");
    health_notes = notes || null;
  }
  await sql.query(
    `update users set full_name = $1, name_normalized = $2, health_notes = $3 where id = $4`,
    [full_name, unaccentVi(full_name), health_notes ?? null, user.id],
  );
  return { status: 200, body: { user: await loadUser(sql, user.id) } };
}

export async function meProfile(sql: Sql, request: Request, user: PublicUser) {
  const here = await currentTokenHash(request);

  const userQuery = sql.query<{
    guardian_name: string | null;
    guardian_phone: string | null;
    pii_consent_at: Date | string | null;
  }>(
    `select guardian_name, guardian_phone, pii_consent_at from users where id = $1`,
    [user.id],
  );

  const sessionsQuery = sql.query<{ n: number }>(
    `select count(*)::int as n from sessions_auth
      where user_id = $1 and revoked_at is null and expires_at > now()
        and ($2::text is null or token_hash <> $2)`,
    [user.id, here],
  );

  if (user.role === "coach") {
    const coachSportsQuery = sql.query<{ sports: string[] | null }>(
      `select array_agg(sport::text order by sport) as sports from coach_sports where user_id = $1`,
      [user.id],
    );
    const coachRatesQuery = sql.query<{ per_session_vnd: number; per_student_vnd: number }>(
      `select per_session_vnd, per_student_vnd from coach_rates where coach_id = $1`,
      [user.id],
    );

    const [sessionsRows, sportsRows, ratesRows] = await Promise.all([
      sessionsQuery,
      coachSportsQuery,
      coachRatesQuery,
    ]);

    const sportsRow = sportsRows[0];
    const ratesRow = ratesRows[0];
    const other_sessions = Number(sessionsRows[0]?.n ?? 0);

    return {
      status: 200,
      body: {
        guardian: null,
        pii_consent_at: null,
        coach: {
          sports: sportsRow?.sports ?? [],
          per_session_vnd: ratesRow?.per_session_vnd != null ? Number(ratesRow.per_session_vnd) : 150000,
          per_student_vnd: ratesRow?.per_student_vnd != null ? Number(ratesRow.per_student_vnd) : 10000,
        },
        other_sessions,
      },
    };
  }

  const [userRows, sessionsRows] = await Promise.all([userQuery, sessionsQuery]);
  const uRow = userRows[0];
  const other_sessions = Number(sessionsRows[0]?.n ?? 0);

  let guardian: { name: string | null; phone: string | null } | null = null;
  let pii_consent_at: string | null = null;

  if (user.role === "member" && uRow) {
    if (uRow.guardian_name || uRow.guardian_phone) {
      guardian = {
        name: uRow.guardian_name ?? null,
        phone: uRow.guardian_phone ?? null,
      };
    }
    if (uRow.pii_consent_at) {
      pii_consent_at = new Date(uRow.pii_consent_at).toISOString();
    }
  }

  return {
    status: 200,
    body: {
      guardian,
      pii_consent_at,
      coach: null,
      other_sessions,
    },
  };
}

export async function meSignOutOthers(sql: Sql, request: Request, user: PublicUser) {
  const here = await currentTokenHash(request);
  if (!here) throw err.unauth();
  limit(`signout:${user.id}`, RULES.profileUpdate, "profile updates");
  const revoked = await sql.query<{ id: string }>(
    `update sessions_auth set revoked_at = now()
      where user_id = $1 and revoked_at is null and token_hash <> $2
      returning id`,
    [user.id, here],
  );
  await audit(sql, user.id, "sign_out_other_sessions", "user", user.id);
  return { status: 200, body: { signed_out: revoked.length } };
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
  // Every other device has to sign in again with the new password; this one stays signed in (D2).
  const here = await currentTokenHash(request);
  const revoked = await sql.query<{ id: string }>(
    `update sessions_auth set revoked_at = now()
      where user_id = $1 and revoked_at is null and ($2::text is null or token_hash <> $2)
      returning id`,
    [user.id, here],
  );
  await audit(sql, user.id, "change_password", "user", user.id);
  return { status: 200, body: { ok: true, signed_out: revoked.length } };
}
