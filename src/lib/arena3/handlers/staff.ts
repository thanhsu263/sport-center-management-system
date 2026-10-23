import { randomInt } from "node:crypto";
import type { Sql } from "@/lib/db";
import { hashPassword } from "../crypto";
import { err } from "../errors";
import { audit, pageOf, readJson, str } from "../helpers";
import { isValidVnPhone, normalizePhone, unaccentVi } from "../phone";
import { requireRole, type PublicUser } from "../session";
import { one, q } from "../tx";
import { pageParams } from "../validate";
import { getActiveSportCodes } from "./sports";

/**
 * Staff accounts (R-01…R-03).
 *
 * There is no system-admin role: the manager is the one who hands out the
 * receptionist and coach logins, and the only way a staff account comes to
 * exist. Registration is member-only (`auth.register` hard-codes the role), so
 * nothing on a public page can produce one.
 *
 * Every change is written to the audit log with the manager as actor, which is
 * how "who issued this account, and when" is answered.
 */

const MANAGED_ROLES = ["receptionist", "coach"] as const;
type ManagedRole = (typeof MANAGED_ROLES)[number];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A temporary password: letters and digits, no look-alikes, never reused. */
export function tempPassword(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const pick = (set: string, n: number) =>
    Array.from({ length: n }, () => set[randomInt(set.length)]).join("");
  return `${pick(letters, 4)}-${pick(digits, 3)}${pick(letters, 3)}${pick(digits, 2)}`;
}

function managedRole(v: unknown, field = "role"): ManagedRole {
  if (!MANAGED_ROLES.includes(v as ManagedRole)) {
    throw err.field(field, "Choose receptionist or coach.");
  }
  return v as ManagedRole;
}

async function sportList(sql: Sql, v: unknown): Promise<string[]> {
  const list = Array.isArray(v) ? v.map(String) : [];
  const valid = await getActiveSportCodes(sql, true);
  const bad = list.find((s) => !valid.includes(s));
  if (bad) throw err.field("sports", `${bad} is not a sport we run.`);
  return [...new Set(list)];
}

type StaffRow = {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  role: string;
  status: string;
  must_change_password: boolean;
  created_at: string;
  sports: string[] | null;
  open_sessions: number;
  issued_by: string | null;
  issued_at: string | null;
};

const STAFF_SELECT = `
  select u.id, u.full_name, u.phone, u.email, u.role, u.status, u.must_change_password,
         u.created_at::text,
         (select array_agg(cs.sport::text order by cs.sport) from coach_sports cs where cs.user_id = u.id) as sports,
         (select count(*)::int from sessions_auth sa where sa.user_id = u.id and sa.expires_at > now()) as open_sessions,
         (select a.name from (
            select coalesce(m.full_name, 'System') as name
              from audit_logs al left join users m on m.id = al.actor_id
             where al.entity = 'user' and al.entity_id = u.id and al.action = 'create_staff'
             order by al.at desc limit 1) a) as issued_by,
         (select al.at::text from audit_logs al
           where al.entity = 'user' and al.entity_id = u.id and al.action = 'create_staff'
           order by al.at desc limit 1) as issued_at
    from users u`;

async function loadStaff(sql: Sql, id: string): Promise<StaffRow> {
  const row = await one<StaffRow>(sql, `${STAFF_SELECT} where u.id = $1`, [id]);
  if (!row) throw err.notFound("That account does not exist.");
  return row;
}

/** The account a manager is allowed to manage here: receptionists and coaches, never themselves. */
async function managedTarget(sql: Sql, id: string, manager: PublicUser): Promise<StaffRow> {
  const row = await loadStaff(sql, id);
  if (row.id === manager.id) throw err.forbidden("You cannot change your own account here.");
  if (!MANAGED_ROLES.includes(row.role as ManagedRole)) {
    throw err.forbidden("Only receptionist and coach accounts are managed from this screen.");
  }
  return row;
}

export async function revoke(sql: Sql, userId: string): Promise<number> {
  const gone = await q<{ id: string }>(sql, `update sessions_auth set revoked_at = now() where user_id = $1 and revoked_at is null returning id`, [userId]);
  return gone.length;
}

export async function staffList(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const url = new URL(request.url);
  const role = url.searchParams.get("role");
  const status = url.searchParams.get("status");
  const text = (url.searchParams.get("q") ?? "").trim();
  const params: unknown[] = [];
  const where: string[] = [`u.role in ('receptionist','coach','manager')`];
  if (role) {
    if (!["receptionist", "coach", "manager"].includes(role)) throw err.field("role", "Unknown role.");
    params.push(role);
    where.push(`u.role = $${params.length}::user_role`);
  }
  if (status) {
    if (!["active", "locked", "disabled"].includes(status)) throw err.field("status", "Unknown status.");
    params.push(status);
    where.push(`u.status = $${params.length}::user_status`);
  }
  if (text) {
    params.push(`%${unaccentVi(text)}%`, `%${text}%`);
    where.push(`(u.name_normalized ilike $${params.length - 1} or u.phone ilike $${params.length} or u.email ilike $${params.length})`);
  }
  const { limit, offset } = pageParams(request, { def: 200, max: 200 });
  const filter = where.join(" and ");
  const rows = await q<StaffRow & { total: number }>(
    sql,
    `${STAFF_SELECT.replace(/^\s*select /, "select count(*) over ()::int as total, ")} where ${filter}
      order by u.role, u.full_name limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, limit, offset],
  );
  const body = await pageOf(rows, { limit, offset }, async () =>
    Number((await q<{ n: number }>(sql, `select count(*)::int as n from users u where ${filter}`, params))[0]?.n ?? 0),
  );
  return { status: 200, body };
}

export async function staffCreate(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const body = await readJson(request);
  const full_name = str(body.full_name);
  const phone = normalizePhone(str(body.phone) ?? "");
  const email = str(body.email) ?? null;
  const role = managedRole(body.role);
  if (!full_name) throw err.field("full_name", "Full name is required.");
  if (!isValidVnPhone(phone)) throw err.field("phone", "That phone number is not valid.");
  if (email && !EMAIL_RE.test(email)) throw err.field("email", "That email address is not valid.");
  const sports = role === "coach" ? await sportList(sql, body.sports) : [];
  if (role === "coach" && !sports.length) {
    throw err.field("sports", "Pick at least one sport this coach can teach.");
  }
  const dup = await one(sql, `select 1 from users where phone = $1 or ($2::text is not null and email = $2)`, [
    phone,
    email,
  ]);
  if (dup) throw err.br("BR-01", "That phone or email already has an account.", { field: "phone" });

  const tmp = tempPassword();
  const row = await one<{ id: string }>(
    sql,
    `insert into users (full_name, name_normalized, phone, email, role, status, password_hash, must_change_password)
     values ($1,$2,$3,$4,$5::user_role,'active',$6,true) returning id`,
    [full_name, unaccentVi(full_name), phone, email, role, hashPassword(tmp)],
  );
  for (const s of sports) {
    await sql.query(`insert into coach_sports (user_id, sport) values ($1, $2)`, [row!.id, s]);
  }
  if (role === "coach") {
    await sql.query(
      `insert into site_assets (slot, kind, alt_en, alt_vi, enabled, version)
       values ($1, 'image', $2, $3, true, 1)
       on conflict (slot) do nothing`,
      [
        `coach.${row!.id}`,
        `Photo of coach ${full_name}`,
        `Ảnh HLV ${full_name}`,
      ],
    );
  }
  await audit(sql, user.id, "create_staff", "user", row!.id, null, { role, phone, sports });
  return { status: 201, body: { staff: await loadStaff(sql, row!.id), temp_password: tmp } };
}

export async function staffPatch(sql: Sql, id: string, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const target = await managedTarget(sql, id, user);
  const body = await readJson(request);
  const nextStatus = str(body.status);
  const nextRole = body.role === undefined ? null : managedRole(body.role);
  if (!nextStatus && !nextRole && body.sports === undefined) {
    throw err.field("status", "Nothing to change.");
  }
  const before = { role: target.role, status: target.status, sports: target.sports ?? [] };

  if (nextStatus) {
    if (!["active", "locked"].includes(nextStatus)) throw err.field("status", "Use active or locked.");
    if (nextStatus !== target.status) {
      await sql.query(
        `update users set status = $1::user_status, failed_logins = 0, locked_until = null where id = $2`,
        [nextStatus, id],
      );
      // A locked account must stop working now, not when its token expires.
      if (nextStatus === "locked") await revoke(sql, id);
      await audit(sql, user.id, nextStatus === "locked" ? "lock_staff" : "unlock_staff", "user", id, before, {
        status: nextStatus,
      });
    }
  }

  if (nextRole || body.sports !== undefined) {
    const role = nextRole ?? (target.role as ManagedRole);
    const sports = role === "coach" ? await sportList(sql, body.sports ?? target.sports ?? []) : [];
    if (role === "coach" && !sports.length) {
      throw err.field("sports", "Pick at least one sport this coach can teach.");
    }
    if (role === "receptionist" && target.role === "coach") {
      const classes = await one<{ n: number }>(
        sql,
        `select count(*)::int as n from classes
          where (coach_id = $1 or assistant_id = $1) and status in ('draft','open')`,
        [id],
      );
      if ((classes?.n ?? 0) > 0) {
        throw err.conflictState("This coach still has classes running. Reassign them before changing the role.");
      }
    }
    if (role !== target.role) {
      await sql.query(`update users set role = $1::user_role where id = $2`, [role, id]);
      // The permissions behind an open session were decided at sign-in.
      await revoke(sql, id);
    }
    if (role === "coach") {
      await sql.query(`delete from coach_sports where user_id = $1`, [id]);
      for (const s of sports) {
        await sql.query(`insert into coach_sports (user_id, sport) values ($1, $2)`, [id, s]);
      }
      await sql.query(
        `insert into site_assets (slot, kind, alt_en, alt_vi, enabled, version)
         values ($1, 'image', $2, $3, true, 1)
         on conflict (slot) do nothing`,
        [
          `coach.${id}`,
          `Photo of coach ${target.full_name}`,
          `Ảnh HLV ${target.full_name}`,
        ],
      );
    } else {
      await sql.query(`delete from coach_sports where user_id = $1`, [id]);
    }
    if (role !== target.role || body.sports !== undefined) {
      await audit(sql, user.id, "change_staff_role", "user", id, before, { role, sports });
    }
  }
  return { status: 200, body: { staff: await loadStaff(sql, id) } };
}

export async function staffResetPassword(sql: Sql, id: string, user: PublicUser) {
  requireRole(user, ["manager"]);
  await managedTarget(sql, id, user);
  const tmp = tempPassword();
  await sql.query(
    `update users set password_hash = $1, must_change_password = true, failed_logins = 0, locked_until = null
      where id = $2`,
    [hashPassword(tmp), id],
  );
  const revoked = await revoke(sql, id);
  await audit(sql, user.id, "reset_staff_password", "user", id, null, { sessions_revoked: revoked });
  return { status: 200, body: { staff: await loadStaff(sql, id), temp_password: tmp } };
}

export async function staffRevokeSessions(sql: Sql, id: string, user: PublicUser) {
  requireRole(user, ["manager"]);
  await managedTarget(sql, id, user);
  const revoked = await revoke(sql, id);
  await audit(sql, user.id, "revoke_staff_sessions", "user", id, null, { sessions_revoked: revoked });
  return { status: 200, body: { revoked, staff: await loadStaff(sql, id) } };
}
