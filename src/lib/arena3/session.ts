import type { Sql } from "@/lib/db";
import { hashPassword, randomToken, sha256, verifyPassword } from "./crypto";
import { err } from "./errors";
import { one, q } from "./tx";

export type Role = "manager" | "coach" | "receptionist" | "member";

export type PublicUser = {
  id: string;
  member_code: string | null;
  full_name: string;
  phone: string;
  email: string | null;
  role: Role;
  status: string;
  date_of_birth: string | null;
  health_notes: string | null;
  must_change_password: boolean;
};

export type AuthUser = PublicUser & { password_hash: string };

const PUBLIC_COLS =
  "id, member_code, full_name, phone, email, role, status, date_of_birth, health_notes, must_change_password";

export function toPublic(u: Record<string, unknown>): PublicUser {
  return {
    id: String(u.id),
    member_code: (u.member_code as string | null) ?? null,
    full_name: String(u.full_name),
    phone: String(u.phone),
    email: (u.email as string | null) ?? null,
    role: u.role as Role,
    status: String(u.status),
    date_of_birth: u.date_of_birth ? String(u.date_of_birth).slice(0, 10) : null,
    health_notes: (u.health_notes as string | null) ?? null,
    must_change_password: Boolean(u.must_change_password),
  };
}

import { limit, RULES } from "./ratelimit";

export async function findUserByLogin(sql: Sql, login: string) {
  const clean = login.trim();
  return one<AuthUser>(
    sql,
    `select ${PUBLIC_COLS}, password_hash from users
     where phone = $1 or (email is not null and lower(email) = lower($1)) limit 1`,
    [clean],
  );
}

export async function issueSession(sql: Sql, user: PublicUser) {
  const token = randomToken();
  const hours = user.role === "member" ? 24 * 7 : 12;
  const expires = new Date(Date.now() + hours * 3600 * 1000);
  await sql.query(
    `insert into sessions_auth (user_id, token_hash, expires_at) values ($1,$2,$3)`,
    [user.id, sha256(token), expires.toISOString()],
  );
  return { token, expires_at: expires.toISOString(), user };
}

/**
 * EventSource cannot send headers, so the live update stream (GET /api/live) alone may carry
 * its token in the query string. Every other route needs the Authorization header, which keeps
 * tokens out of URLs, logs and Referer headers.
 */
function liveStreamToken(request: Request): string | null {
  if (request.method.toUpperCase() !== "GET") return null;
  const url = new URL(request.url);
  if (!/\/(api|v1)\/live\/?$/.test(url.pathname)) return null;
  return url.searchParams.get("token");
}

export async function authFromRequest(sql: Sql, request: Request): Promise<PublicUser> {
  const hdr = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(hdr);
  const token = m ? m[1] : liveStreamToken(request);
  if (!token) throw err.unauth();
  const row = await one<{
    id: string;
    member_code: string | null;
    full_name: string;
    phone: string;
    email: string | null;
    role: Role;
    status: string;
    date_of_birth: string | null;
    health_notes: string | null;
    must_change_password: boolean;
    locked_until: string | null;
    expires_at: string;
    revoked_at: string | null;
  }>(
    sql,
    `select u.id, u.member_code, u.full_name, u.phone, u.email, u.role, u.status,
            u.date_of_birth, u.health_notes, u.must_change_password,
            s.expires_at, s.revoked_at, u.locked_until
       from sessions_auth s
       join users u on u.id = s.user_id
      where s.token_hash = $1`,
    [sha256(token)],
  );
  if (!row) throw err.unauth("That session is not valid.");
  if (row.revoked_at) {
    const url = new URL(request.url);
    if (request.method.toUpperCase() === "POST" && /\/v1\/me\/password\/?$/.test(url.pathname)) {
      limit(`pw:${row.id}`, RULES.passwordChange, "password changes");
    }
    throw err.unauth("That session is not valid.");
  }
  if (new Date(row.expires_at) < new Date()) throw err.unauth("Your session has expired.");
  if (row.status !== "active") throw err.unauth("This account is not active.");
  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    throw err.rateLimited("This account is locked.");
  }
  return toPublic(row);
}

export async function optionalAuth(sql: Sql, request: Request): Promise<PublicUser | null> {
  const hdr = request.headers.get("authorization") ?? "";
  if (!/^Bearer\s+/i.test(hdr) && !liveStreamToken(request)) return null;
  try {
    return await authFromRequest(sql, request);
  } catch {
    return null;
  }
}

export function requireRole(user: PublicUser, roles: Role[]) {
  if (!roles.includes(user.role)) throw err.forbidden();
}

export const staffRoles: Role[] = ["manager", "coach", "receptionist"];
export const deskRoles: Role[] = ["manager", "receptionist"];

export { hashPassword, verifyPassword, q };
