import { randomBytes } from "node:crypto";
import type { Sql } from "@/server/data/db";
import { err } from "../errors";
import { audit, isUuid, readJson, str } from "../helpers";
import { requireRole, type PublicUser } from "../session";
import { one } from "../tx";

/** The share of a finished class's sessions a member must attend to earn its certificate. */
export const COMPLETION_SHARE = 0.8;

// ---- Coach certifications -------------------------------------------------

/** Every coach's certifications that have not expired, for the public coach profiles. */
export async function coachCertificationsPublic(sql: Sql) {
  const items = await sql.query(
    `select cc.id, cc.coach_id, cc.name, cc.issuer, cc.issued_on::text, cc.expires_on::text
       from coach_certifications cc
       join users u on u.id = cc.coach_id and u.role = 'coach' and u.status = 'active'
      where cc.expires_on is null or cc.expires_on >= current_date
      order by cc.coach_id, cc.issued_on desc nulls last, cc.name`,
  );
  return { status: 200, body: { items } };
}

/** One coach's certifications, expired ones included, for whoever manages them. */
export async function coachCertificationsList(sql: Sql, coachId: string, user: PublicUser) {
  requireRole(user, ["manager", "coach", "receptionist"]);
  if (!isUuid(coachId)) throw err.notFound("No such coach.");
  const items = await sql.query(
    `select id, coach_id, name, issuer, issued_on::text, expires_on::text,
            (expires_on is not null and expires_on < current_date) as expired
       from coach_certifications where coach_id = $1
      order by issued_on desc nulls last, name`,
    [coachId],
  );
  return { status: 200, body: { items } };
}

function assertCanManage(user: PublicUser, coachId: string) {
  if (user.role === "manager") return;
  if (user.role === "coach" && user.id === coachId) return;
  throw err.forbidden("Only a manager or the coach can change these certifications.");
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function coachCertificationCreate(sql: Sql, coachId: string, request: Request, user: PublicUser) {
  if (!isUuid(coachId)) throw err.notFound("No such coach.");
  assertCanManage(user, coachId);
  const coach = await one<{ role: string }>(sql, `select role from users where id = $1`, [coachId]);
  if (!coach || coach.role !== "coach") throw err.notFound("No such coach.");
  const b = await readJson(request);
  const name = str(b.name)?.trim();
  const issuer = str(b.issuer)?.trim() || null;
  const issued_on = str(b.issued_on) || null;
  const expires_on = str(b.expires_on) || null;
  if (!name || name.length > 120) throw err.field("name", "Name the certification (120 characters at most).");
  if (issuer && issuer.length > 120) throw err.field("issuer", "The issuer is 120 characters at most.");
  if (issued_on && !ISO_DATE.test(issued_on)) throw err.field("issued_on", "Pick the date it was issued.");
  if (expires_on && !ISO_DATE.test(expires_on)) throw err.field("expires_on", "Pick the date it expires.");
  if (issued_on && expires_on && expires_on < issued_on) {
    throw err.field("expires_on", "It cannot expire before it was issued.");
  }
  const row = await one<{ id: string }>(
    sql,
    `insert into coach_certifications (coach_id, name, issuer, issued_on, expires_on, created_by)
     values ($1, $2, $3, $4::date, $5::date, $6)
     returning id, coach_id, name, issuer, issued_on::text, expires_on::text`,
    [coachId, name, issuer, issued_on, expires_on, user.id],
  );
  await audit(sql, user.id, "add_coach_certification", "user", coachId, null, { name, issuer, issued_on, expires_on });
  return { status: 201, body: row };
}

export async function coachCertificationDelete(sql: Sql, id: string, user: PublicUser) {
  if (!isUuid(id)) throw err.notFound("No such certification.");
  const row = await one<{ coach_id: string; name: string }>(
    sql,
    `select coach_id, name from coach_certifications where id = $1 for update`,
    [id],
  );
  if (!row) throw err.notFound("No such certification.");
  assertCanManage(user, row.coach_id);
  await sql.query(`delete from coach_certifications where id = $1`, [id]);
  await audit(sql, user.id, "remove_coach_certification", "user", row.coach_id, { name: row.name }, null);
  return { status: 200, body: { ok: true } };
}

// ---- Member completion certificates ---------------------------------------

type Completion = {
  enrollment_id: string;
  class_id: string;
  sport: string;
  level: string;
  coach_name: string;
  start_on: string;
  end_on: string;
  sessions: number;
  attended: number;
  remaining: number;
  code: string | null;
  issued_at: string | null;
};

// A session counts once it has ended and was not cancelled; present or late counts as attended.
const COMPLETION_SQL = `
  select e.id as enrollment_id, cl.id as class_id, cl.sport::text as sport, cl.level, u.full_name as coach_name,
         cl.start_on::text, cl.end_on::text,
         (select count(*)::int from sessions s
           where s.class_id = cl.id and s.status <> 'cancelled' and s.end_at <= now()) as sessions,
         (select count(*)::int from sessions s
           where s.class_id = cl.id and s.status <> 'cancelled' and s.end_at > now()) as remaining,
         (select count(distinct a.session_id)::int from attendance a
            join sessions s on s.id = a.session_id
           where a.kind = 'session' and a.user_id = e.user_id and s.class_id = cl.id
             and s.status <> 'cancelled' and a.result in ('present', 'late')) as attended,
         cc.code, cc.issued_at
    from enrollments e
    join classes cl on cl.id = e.class_id
    join users u on u.id = cl.coach_id
    left join class_certificates cc on cc.enrollment_id = e.id
   where e.user_id = $1 and e.status = 'confirmed' and cl.status <> 'cancelled'`;

function earned(c: Pick<Completion, "sessions" | "attended" | "remaining">) {
  return c.remaining === 0 && c.sessions > 0 && c.attended / c.sessions >= COMPLETION_SHARE;
}

/** The member's classes with how far each is from a certificate, and the certificates earned. */
export async function meCertificates(sql: Sql, user: PublicUser) {
  requireRole(user, ["member"]);
  const rows = await sql.query<Completion>(`${COMPLETION_SQL} order by cl.end_on desc`, [user.id]);
  return {
    status: 200,
    body: {
      share: COMPLETION_SHARE,
      items: rows.map((r) => ({ ...r, eligible: earned(r) })),
    },
  };
}

// Ten characters a person can read aloud: no 0/O or 1/I.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function certCode(): string {
  const bytes = randomBytes(10);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** Issues the certificate for a finished class, once; asking again returns the same code. */
export async function meCertificateIssue(sql: Sql, enrollmentId: string, user: PublicUser) {
  requireRole(user, ["member"]);
  if (!isUuid(enrollmentId)) throw err.notFound("No such class.");
  const row = await one<Completion>(sql, `${COMPLETION_SQL} and e.id = $2`, [user.id, enrollmentId]);
  if (!row) throw err.notFound("No such class.");
  if (row.code) return { status: 200, body: { code: row.code } };
  if (!earned(row)) {
    throw err.conflictState(
      row.remaining > 0
        ? "The class is not over yet."
        : `Attend at least ${Math.round(COMPLETION_SHARE * 100)}% of the sessions to earn this certificate.`,
    );
  }
  const issued = await one<{ code: string }>(
    sql,
    `insert into class_certificates (enrollment_id, code, attended, sessions)
     values ($1, $2, $3, $4)
     on conflict (enrollment_id) do update set enrollment_id = excluded.enrollment_id
     returning code`,
    [enrollmentId, certCode(), row.attended, row.sessions],
  );
  await audit(sql, user.id, "issue_certificate", "enrollment", enrollmentId, null, { code: issued?.code });
  return { status: 201, body: { code: issued?.code } };
}

/** Anyone holding the code can check the certificate: who, which class, when. */
export async function certificateVerify(sql: Sql, code: string) {
  const clean = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,24}$/.test(clean)) throw err.notFound("No certificate has that code.");
  const row = await one(
    sql,
    `select cc.code, cc.attended, cc.sessions, cc.issued_at, m.full_name as member_name,
            cl.sport::text as sport, cl.level, cl.start_on::text, cl.end_on::text, co.full_name as coach_name
       from class_certificates cc
       join enrollments e on e.id = cc.enrollment_id
       join users m on m.id = e.user_id
       join classes cl on cl.id = e.class_id
       join users co on co.id = cl.coach_id
      where cc.code = $1`,
    [clean],
  );
  if (!row) throw err.notFound("No certificate has that code.");
  return { status: 200, body: row };
}
