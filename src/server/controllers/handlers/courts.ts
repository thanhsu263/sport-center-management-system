import type { Sql } from "@/lib/db";
import { ApiError, err } from "../errors";
import { audit, num, readJson, str } from "../helpers";
import { one } from "../tx";
import { requireRole, type PublicUser } from "../session";

const COURT_CODE_RE = /^[A-Z]{2}-\d{2,3}$/;

export async function managerCourtsList(sql: Sql, user: PublicUser) {
  requireRole(user, ["manager"]);

  const items = await sql.query<{
    id: string;
    court_code: string;
    sport: string;
    status: string;
    display_name: string | null;
    sort_order: number | null;
    retired_at: string | null;
    upcoming_bookings: number;
    active_classes: number;
    has_custom_price: boolean;
  }>(
    `select c.id, c.court_code, c.sport, c.status, c.display_name, c.sort_order, c.retired_at,
            coalesce(occ.upcoming_count, 0)::int as upcoming_bookings,
            coalesce(cls.class_count, 0)::int as active_classes,
            (exists (select 1 from price_rules pr where pr.court_id = c.id)) as has_custom_price
       from courts c
       left join (
         select court_id, count(*)::int as upcoming_count
           from occupancies
          where end_at > now() and kind in ('booking', 'hold')
          group by court_id
       ) occ on occ.court_id = c.id
       left join (
         select court_id, count(distinct class_id)::int as class_count
           from sessions
          where end_at > now() and status <> 'cancelled'
          group by court_id
       ) cls on cls.court_id = c.id
      order by c.sort_order nulls last, c.court_code`,
  );

  return { status: 200, body: { items } };
}

export async function managerCourtCreate(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const b = await readJson(request);

  const sport = str(b.sport);
  if (!sport) {
    throw err.field("sport", "Sport is required.");
  }

  const spRow = await one<{ court_prefix: string | null; enabled: boolean; retired_at: string | null }>(
    sql,
    `select court_prefix, enabled, retired_at from sports where code = $1 and not is_scope_all`,
    [sport],
  );
  if (!spRow || !spRow.enabled || spRow.retired_at) {
    throw err.field("sport", "Invalid or retired sport.");
  }

  let courtCode = str(b.court_code)?.trim().toUpperCase();

  if (!courtCode) {
    // Auto-generate code based on sport prefix and lowest unused number
    const prefix = spRow.court_prefix ? `${spRow.court_prefix}-` : "CT-";
    const existing = await sql.query<{ court_code: string }>(
      `select court_code from courts where court_code like $1`,
      [`${prefix}%`],
    );
    const used = new Set<number>();
    for (const row of existing) {
      const match = /^[A-Z]{2}-(\d+)$/.exec(row.court_code);
      if (match && match[1]) {
        used.add(parseInt(match[1], 10));
      }
    }
    let n = 1;
    while (used.has(n)) {
      n++;
    }
    courtCode = `${prefix}${String(n).padStart(2, "0")}`;
  } else {
    // Validate custom code
    if (courtCode.length > 8 || !COURT_CODE_RE.test(courtCode)) {
      throw err.validation(
        "Court code must match format like CL-01 or BR-12 (2 capital letters, dash, 2-3 digits).",
        { field: "court_code" },
      );
    }
    const duplicate = await one(
      sql,
      `select 1 from courts where lower(court_code) = lower($1)`,
      [courtCode],
    );
    if (duplicate) {
      throw err.conflictSlot("That court code is already in use.");
    }
  }

  const displayName = str(b.display_name)?.trim() || null;
  if (displayName && displayName.length > 40) {
    throw err.field("display_name", "Display name cannot exceed 40 characters.");
  }

  const status = str(b.status) || "ready";
  const sortOrder = num(b.sort_order) ?? null;

  const court = await one<{
    id: string;
    court_code: string;
    sport: string;
    status: string;
    display_name: string | null;
    sort_order: number | null;
    retired_at: string | null;
  }>(
    sql,
    `insert into courts (court_code, sport, status, display_name, sort_order)
     values ($1, $2, $3, $4, $5)
     returning id, court_code, sport, status, display_name, sort_order, retired_at`,
    [courtCode, sport, status, displayName, sortOrder],
  );

  await audit(sql, user.id, "create_court", "court", court!.id, null, {
    court_code: courtCode,
    sport,
    display_name: displayName,
  });

  return { status: 201, body: { court } };
}

export async function managerCourtRetire(
  sql: Sql,
  id: string,
  _request: Request,
  user: PublicUser,
) {
  requireRole(user, ["manager"]);

  const cur = await one<{
    id: string;
    court_code: string;
    sport: string;
    status: string;
    retired_at: string | null;
  }>(sql, `select id, court_code, sport, status, retired_at from courts where id = $1`, [id]);

  if (!cur) {
    throw err.notFound("No such court.");
  }
  if (cur.retired_at) {
    throw err.validation("Court is already retired.");
  }

  // Protection: cannot retire the last court of a sport with active subscriptions or active classes
  const remaining = await one<{ cnt: number }>(
    sql,
    `select count(*)::int as cnt from courts where sport = $1 and retired_at is null and id <> $2`,
    [cur.sport, id],
  );

  if (!remaining || remaining.cnt === 0) {
    const activeSubs = await one<{ cnt: number }>(
      sql,
      `select count(*)::int as cnt
         from subscriptions s
         join membership_plans p on p.id = s.plan_id
        where s.status = 'active' and (p.sport_scope = $1 or (p.sport_scope = 'all' and $1 in (select code from sports where enabled = true and not is_scope_all and retired_at is null)))`,
      [cur.sport],
    );
    const activeClasses = await one<{ cnt: number }>(
      sql,
      `select count(*)::int as cnt from classes where sport = $1 and status = 'open'`,
      [cur.sport],
    );

    if ((activeSubs?.cnt ?? 0) > 0 || (activeClasses?.cnt ?? 0) > 0) {
      throw new ApiError(
        409,
        "CONFLICT_STATE",
        "Cannot retire the last court for a sport with active plans or classes.",
      );
    }
  }

  // Check upcoming bookings, holds, classes, maintenance
  const upcoming = await sql.query<{
    id: string;
    start_at: string;
    end_at: string;
    kind: string;
    ref_id: string;
    code: string | null;
    title: string | null;
  }>(
    `select o.id, o.start_at, o.end_at, o.kind, o.ref_id,
            b.code,
            concat_ws(' ', c.sport::text, c.level) as title
       from occupancies o
       left join court_bookings b on o.kind = 'booking' and b.id = o.ref_id
       left join sessions s on o.kind = 'session' and s.id = o.ref_id
       left join classes c on c.id = s.class_id
      where o.court_id = $1 and o.end_at > now()
      order by o.start_at`,
    [id],
  );

  if (upcoming.length > 0) {
    throw new ApiError(
      409,
      "CONFLICT_STATE",
      "Cannot retire court with upcoming bookings or sessions.",
      {
        affected: upcoming.map((u) => ({
          kind: u.kind,
          start_at: u.start_at,
          end_at: u.end_at,
          description: u.code ? `Booking ${u.code}` : u.title ? `Class ${u.title}` : u.kind,
        })),
        blockers: upcoming.map((u) => ({
          kind: u.kind,
          start_at: u.start_at,
          end_at: u.end_at,
          description: u.code ? `Booking ${u.code}` : u.title ? `Class ${u.title}` : u.kind,
        })),
      },
    );
  }

  await sql.query(
    `update courts set retired_at = now(), status = 'closed' where id = $1`,
    [id],
  );

  await audit(sql, user.id, "retire_court", "court", id, { from_status: cur.status }, { retired_at: new Date().toISOString() });

  const court = await one(
    sql,
    `select id, court_code, sport, status, display_name, sort_order, retired_at from courts where id = $1`,
    [id],
  );

  return { status: 200, body: { ok: true, court } };
}

export async function managerCourtRestore(sql: Sql, id: string, user: PublicUser) {
  requireRole(user, ["manager"]);

  const cur = await one<{
    id: string;
    court_code: string;
    sport: string;
    status: string;
    retired_at: string | null;
  }>(sql, `select id, court_code, sport, status, retired_at from courts where id = $1`, [id]);

  if (!cur) {
    throw err.notFound("No such court.");
  }
  if (!cur.retired_at) {
    throw err.validation("Court is not retired.");
  }

  await sql.query(
    `update courts set retired_at = null, status = 'ready' where id = $1`,
    [id],
  );

  await audit(sql, user.id, "restore_court", "court", id, null, { status: "ready" });

  const court = await one(
    sql,
    `select id, court_code, sport, status, display_name, sort_order, retired_at from courts where id = $1`,
    [id],
  );

  return { status: 200, body: { ok: true, court } };
}
