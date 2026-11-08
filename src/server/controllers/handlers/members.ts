import type { Sql } from "@/lib/db";
import { hashPassword } from "../crypto";
import { err } from "../errors";
import { ageYears, audit, getSettings, readJson, str } from "../helpers";
import { isValidVnPhone, normalizePhone, phoneLast9, unaccentVi } from "../phone";
import { requireRole, toPublic, type PublicUser } from "../session";
import { one } from "../tx";
import { revoke, tempPassword } from "./staff";
import { getActiveSportCodes } from "./sports";

export async function membersSearch(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["manager", "receptionist", "coach"]);
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 3) return { status: 200, body: { items: [] } };
  const nq = unaccentVi(q);
  const phone = q.replace(/[\s-]/g, "");
  const tail = phoneLast9(q);
  const items = await sql.query(
    `select id, member_code, full_name, phone, email, role, status, date_of_birth
       from users
      where role = 'member'
        and (
          name_normalized like '%' || $1 || '%'
          or phone like '%' || $2 || '%'
          or coalesce(member_code,'') ilike '%' || $3 || '%'
          or ($4::text is not null and right(phone, 9) = $4)
        )
      order by name_normalized
      limit 20`,
    [nq, phone, q, tail],
  );
  return { status: 200, body: { items } };
}

export async function membersCreate(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  const body = await readJson(request);
  const full_name = str(body.full_name);
  const phone = normalizePhone(str(body.phone) ?? "");
  const dob = str(body.dob) ?? str(body.date_of_birth);
  const pii = body.pii_consent === true;
  if (!full_name) throw err.validation("Full name is required.");
  if (!isValidVnPhone(phone)) throw err.validation("That phone number is not valid.");
  if (!pii) throw err.br("BR-04", "You must accept the terms and the data-privacy notice.");
  const existing = await one<Record<string, unknown>>(
    sql,
    `select id, member_code, full_name, phone, email, role, status, date_of_birth, health_notes, must_change_password
       from users where phone = $1`,
    [phone],
  );
  if (existing) {
    return { status: 200, body: { user: toPublic(existing), existing: true } };
  }
  const settings = await getSettings(sql);
  if (dob && ageYears(dob) < settings.minor_age) {
    if (!str(body.guardian_name) || !str(body.guardian_phone)) {
      throw err.br("BR-03", "A minor needs guardian details.");
    }
  }
  const tmp = `A3tmp${Math.floor(1000 + Math.random() * 9000)}a`;
  const code = await one<{ next_member_code: string }>(sql, `select next_member_code() as next_member_code`);
  const inserted = await one<{ id: string }>(
    sql,
    `insert into users
       (full_name, name_normalized, phone, email, role, status, password_hash,
        date_of_birth, guardian_name, guardian_phone, pii_consent_at, member_code, must_change_password)
     values ($1,$2,$3,$4,'member','active',$5,$6,$7,$8, now(), $9, true)
     returning id`,
    [
      full_name,
      unaccentVi(full_name),
      phone,
      str(body.email) ?? null,
      hashPassword(tmp),
      dob ?? null,
      str(body.guardian_name) ?? null,
      str(body.guardian_phone) ? normalizePhone(String(body.guardian_phone)) : null,
      code?.next_member_code,
    ],
  );
  await audit(sql, user.id, "create_member", "user", inserted!.id);
  const created = await one<Record<string, unknown>>(
    sql,
    `select id, member_code, full_name, phone, email, role, status, date_of_birth, health_notes, must_change_password
       from users where id = $1`,
    [inserted!.id],
  );
  return { status: 201, body: { user: toPublic(created!), temp_password: tmp } };
}

export async function memberGet(sql: Sql, id: string, user: PublicUser) {
  requireRole(user, ["manager", "receptionist", "coach"]);
  const m = await one<Record<string, unknown>>(
    sql,
    `select id, member_code, full_name, phone, email, role, status, date_of_birth, health_notes, must_change_password
       from users where id = $1`,
    [id],
  );
  if (!m) throw err.notFound();
  if (user.role === "coach" && m.role === "member") {
    const taught = await one(
      sql,
      `select 1 from enrollments e
         join classes c on c.id = e.class_id
        where e.user_id = $1 and (c.coach_id = $2 or c.assistant_id = $2)
        limit 1`,
      [id, user.id],
    );
    if (!taught) throw err.forbidden("Coaches can only view members in their own classes.");
  }
  const subs = await sql.query(
    // due_vnd is what "Take payment" has to collect — exactly what POST /payments will accept: the plan
    // price less any code already on an unpaid order, or the full price for a renewal. The desk sends
    // this number rather than working it out, so a code on the order can never make it come out wrong.
    `select s.id, s.status, s.start_on::text, s.end_on::text, s.sport_scope, s.court_hours_left, s.session_left,
            s.frozen_days, p.name as plan_name, coalesce(s.price_vnd, p.price_vnd)::int as price_vnd,
            (coalesce(s.price_vnd, p.price_vnd) - case when s.status::text = 'pending' then coalesce(s.promo_discount_vnd, 0) else 0 end)::int as due_vnd
       from subscriptions s join membership_plans p on p.id = s.plan_id
      where s.user_id = $1 order by s.end_on desc`,
    [id],
  );
  // Guardian details are not part of the public user shape, but the desk needs
  // them to correct a profile that was filled in wrongly.
  const guardian = await one<{ guardian_name: string | null; guardian_phone: string | null }>(
    sql,
    `select guardian_name, guardian_phone from users where id = $1`,
    [id],
  );
  const bookings = await sql.query(
    `select b.id, b.code, b.start_at, b.end_at, b.status, b.price_vnd, b.paid_vnd, c.court_code
       from court_bookings b join courts c on c.id = b.court_id
      where b.user_id = $1
        and (b.start_at at time zone 'Asia/Ho_Chi_Minh')::date
            = (now() at time zone 'Asia/Ho_Chi_Minh')::date
      order by b.start_at`,
    [id],
  );
  const classes = await sql.query(
    `select s.id, s.start_at, s.end_at, cl.level, cl.sport, ct.court_code
       from sessions s
       join classes cl on cl.id = s.class_id
       join enrollments e on e.class_id = cl.id and e.user_id = $1 and e.status = 'confirmed'
       join courts ct on ct.id = s.court_id
      where s.status = 'scheduled'
        and (s.start_at at time zone 'Asia/Ho_Chi_Minh')::date
            = (now() at time zone 'Asia/Ho_Chi_Minh')::date`,
    [id],
  );
  /*
   * What this member has paid, and how much of it is still the centre's to
   * give back.
   *
   * `refundable_vnd` is computed here rather than left to the screen because
   * the screen cannot see it: refunds are separate rows that carry no link to
   * the payment they undo, so "how much of this is left" is a question about
   * the whole ledger for that booking or subscription, not about one row. The
   * same arithmetic guards the refund endpoint — this is the desk being shown
   * the answer before it presses the button rather than after.
   */
  const payments = await sql.query(
    `select p.id, p.code, p.method, p.amount_vnd, p.status, p.created_at,
            p.ref_type, p.ref_id, i.id as invoice_id,
            least(p.amount_vnd, greatest((
              select coalesce(sum(q.amount_vnd) filter (where q.amount_vnd > 0 and q.status = 'posted'), 0)
                   - coalesce(sum(-q.amount_vnd) filter (where q.amount_vnd < 0 and q.status in ('posted','refund_pending')), 0)
                from payments q
               where q.ref_type = p.ref_type and q.ref_id = p.ref_id
            ), 0))::int as refundable_vnd
       from payments p
       left join invoices i on i.payment_id = p.id
      where p.user_id = $1
      order by p.created_at desc
      limit 20`,
    [id],
  );
  return {
    status: 200,
    body: {
      user: toPublic(m),
      guardian: { name: guardian?.guardian_name ?? null, phone: guardian?.guardian_phone ?? null },
      subscriptions: subs,
      payments,
      today: { bookings, classes },
    },
  };
}

/**
 * Correct a member's profile (B-11 / D-06).
 *
 * Members get their name, phone or date of birth wrong at sign-up and the desk
 * had no way to put it right. Reception and the manager may edit those four
 * things plus the guardian; anything else on the account is left alone.
 *
 * - A phone that already belongs to another account is refused with BR-01, the
 *   same rule registration enforces — never silently merged.
 * - A date of birth that makes the member a minor needs guardian details
 *   (BR-03), checked against the values the row will hold after the edit.
 * - The audit entry keeps the before and after of only what changed.
 */
export async function membersUpdate(sql: Sql, id: string, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  const body = await readJson(request);
  const cur = await one<{
    id: string;
    full_name: string;
    phone: string;
    date_of_birth: string | null;
    guardian_name: string | null;
    guardian_phone: string | null;
    role: string;
  }>(
    sql,
    `select id, full_name, phone, date_of_birth::text as date_of_birth, guardian_name, guardian_phone, role::text as role
       from users where id = $1 for update`,
    [id],
  );
  if (!cur || cur.role !== "member") throw err.notFound("No such member.");

  const next = {
    full_name: cur.full_name,
    phone: cur.phone,
    date_of_birth: cur.date_of_birth,
    guardian_name: cur.guardian_name,
    guardian_phone: cur.guardian_phone,
  };

  if (body.full_name !== undefined) {
    const name = typeof body.full_name === "string" ? body.full_name.trim() : "";
    if (!name) throw err.field("full_name", "Full name is required.");
    if (name.length > 120) throw err.field("full_name", "Full name must be at most 120 characters.");
    next.full_name = name;
  }
  if (body.phone !== undefined) {
    const raw = typeof body.phone === "string" ? body.phone : "";
    if (!isValidVnPhone(raw)) throw err.field("phone", "That phone number is not valid.");
    next.phone = normalizePhone(raw);
  }
  const dobIn = body.date_of_birth !== undefined ? body.date_of_birth : body.dob;
  if (dobIn !== undefined) {
    if (dobIn === null || dobIn === "") {
      next.date_of_birth = null;
    } else {
      const d = typeof dobIn === "string" ? dobIn.trim() : "";
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
      if (!ok) throw err.field("date_of_birth", "Date of birth must be a real date (YYYY-MM-DD).");
      if (new Date(`${d}T00:00:00+07:00`).getTime() > Date.now()) {
        throw err.field("date_of_birth", "Date of birth cannot be in the future.");
      }
      next.date_of_birth = d;
    }
  }
  if (body.guardian_name !== undefined) {
    const g = typeof body.guardian_name === "string" ? body.guardian_name.trim() : "";
    if (g.length > 120) throw err.field("guardian_name", "Guardian name must be at most 120 characters.");
    next.guardian_name = g || null;
  }
  if (body.guardian_phone !== undefined) {
    const raw = typeof body.guardian_phone === "string" ? body.guardian_phone.trim() : "";
    if (raw && !isValidVnPhone(raw)) throw err.field("guardian_phone", "That guardian phone number is not valid.");
    next.guardian_phone = raw ? normalizePhone(raw) : null;
  }

  if (next.phone !== cur.phone) {
    const taken = await one(sql, `select 1 as x from users where phone = $1 and id <> $2`, [next.phone, id]);
    if (taken) throw err.br("BR-01", "That phone number already has an account.", { field: "phone" });
  }
  const settings = await getSettings(sql);
  if (next.date_of_birth && ageYears(next.date_of_birth) < settings.minor_age) {
    if (!next.guardian_name || !next.guardian_phone) {
      throw err.br("BR-03", "A minor needs guardian details.", { field: "guardian_name" });
    }
  }

  const keys = Object.keys(next) as Array<keyof typeof next>;
  const changed = keys.filter((k) => next[k] !== cur[k]);
  if (changed.length) {
    await sql.query(
      `update users
          set full_name = $2, name_normalized = $3, phone = $4,
              date_of_birth = $5, guardian_name = $6, guardian_phone = $7
        where id = $1`,
      [
        id,
        next.full_name,
        unaccentVi(next.full_name),
        next.phone,
        next.date_of_birth,
        next.guardian_name,
        next.guardian_phone,
      ],
    );
    await audit(
      sql,
      user.id,
      "update_member",
      "user",
      id,
      Object.fromEntries(changed.map((k) => [k, cur[k]])),
      Object.fromEntries(changed.map((k) => [k, next[k]])),
    );
  }
  return { status: 200, body: { ok: true, changed } };
}

const PLAN_STATES = ["active", "expiring", "expired", "none"] as const;

/**
 * The manager's member list (FR-MEM-04): everyone with an account, filtered by
 * status, sport and plan state, in name order and paged.
 *
 * `plan_state` comes from the member's latest plan: live and ending within a
 * week is `expiring`, live is `active`, lapsed is `expired`, and nobody who has
 * never bought one is `none`. Filtering by `active` includes `expiring` — a plan
 * that ends next Tuesday is still a live plan.
 */
export async function membersDirectory(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const sp = new URL(request.url).searchParams;
  const q = (sp.get("q") ?? "").trim();
  const status = sp.get("status");
  if (status && !["active", "locked", "disabled"].includes(status)) throw err.field("status", "Unknown status.");
  const sport = sp.get("sport");
  if (sport && !(await getActiveSportCodes(sql)).includes(sport)) throw err.field("sport", "Unknown sport.");
  const plan = sp.get("plan");
  if (plan && !(PLAN_STATES as readonly string[]).includes(plan)) throw err.field("plan", "Unknown plan state.");
  const intParam = (name: string, fallback: number, min: number, max: number) => {
    const raw = sp.get(name);
    if (raw === null) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw err.field(name, `${name} must be a whole number from ${min} to ${max}.`);
    return n;
  };
  const limit = intParam("limit", 25, 1, 100);
  const offset = intParam("offset", 0, 0, 100000);
  const nq = q ? unaccentVi(q) : null;

  const rows = await sql.query(
    `with base as (
       select u.id, u.member_code, u.full_name, u.phone, u.status::text as status, u.created_at,
              u.name_normalized, latest.plan_name, latest.sport_scope, latest.end_on, latest.sub_status,
              (select count(*) from enrollments e where e.user_id = u.id and e.status = 'confirmed')::int as classes,
              case
                when latest.id is null then 'none'
                when latest.sub_status in ('active','frozen') and latest.end_on >= today.d then
                  case when latest.end_on <= today.d + 7 then 'expiring' else 'active' end
                else 'expired'
              end as plan_state
         from users u
        cross join (select (now() at time zone 'Asia/Ho_Chi_Minh')::date as d) today
         left join lateral (
           select s.id, mp.name as plan_name, s.sport_scope::text as sport_scope, s.end_on,
                  s.status::text as sub_status
             from subscriptions s join membership_plans mp on mp.id = s.plan_id
            where s.user_id = u.id and s.status in ('active','frozen','expired')
            order by (s.status in ('active','frozen')) desc, s.end_on desc
            limit 1
         ) latest on true
        where u.role = 'member'
          and ($1::text is null or u.status::text = $1)
          and ($2::text is null
               or u.name_normalized like '%' || $2 || '%'
               or u.phone like '%' || $3 || '%'
               or coalesce(u.member_code,'') ilike '%' || $4 || '%')
     )
     select *, count(*) over ()::int as total
       from base
      where ($5::text is null or sport_scope = $5 or sport_scope = 'all')
        and ($6::text is null
             or plan_state = $6
             or ($6 = 'active' and plan_state = 'expiring'))
      order by name_normalized, id
      limit $7 offset $8`,
    [status, nq, q.replace(/[\s-]/g, ""), q, sport, plan, limit, offset],
  );
  const total = rows.length ? Number(rows[0]!.total) : 0;
  return {
    status: 200,
    body: {
      total,
      limit,
      offset,
      items: rows.map(({ total: _t, name_normalized: _n, ...r }) => r),
    },
  };
}

/**
 * Front-desk password reset for a member.
 *
 * The self-service route (`/forgot`) mails a code, which is no use to a member
 * with no email on file or no access to it. This is the way back in for them:
 * a one-time temporary password, shown once to the person at the desk, that the
 * member must replace at first sign-in. Every open session is signed out, and
 * the audit row records who did it — never the password itself.
 */
export async function memberResetPassword(sql: Sql, id: string, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  const target = await one<{ id: string; full_name: string; phone: string; role: string }>(
    sql,
    `select id, full_name, phone, role::text as role from users where id = $1 for update`,
    [id],
  );
  if (!target || target.role !== "member") throw err.notFound("No such member.");
  const tmp = tempPassword();
  await sql.query(
    `update users set password_hash = $1, must_change_password = true, failed_logins = 0, locked_until = null
      where id = $2`,
    [hashPassword(tmp), id],
  );
  const revoked = await revoke(sql, id);
  await audit(sql, user.id, "reset_member_password", "user", id, null, { sessions_revoked: revoked });
  return {
    status: 200,
    body: { temp_password: tmp, full_name: target.full_name, phone: target.phone, sessions_revoked: revoked },
  };
}
