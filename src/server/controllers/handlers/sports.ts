import type { Sql } from "@/lib/db";
import { ApiError, err } from "../errors";
import { audit, num, readJson, str } from "../helpers";
import { limit, RULES } from "../ratelimit";
import { requireRole, type PublicUser } from "../session";
import { one } from "../tx";

const CODE_RE = /^[a-z][a-z0-9_-]{1,23}$/;
const PREFIX_RE = /^[A-Z]{2}$/;
export const ALLOWED_COLOR_KEYS = ["leaf", "clay", "sky", "plum", "sun", "slate", "moss", "dune"] as const;

export type SportRow = {
  code: string;
  name_en: string;
  name_vi: string;
  court_prefix: string | null;
  color_key: string;
  glyph_key: string;
  is_scope_all: boolean;
  max_players: number;
  slot_duration_min: number;
  sort_order: number;
  enabled: boolean;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function publicSportsList(sql: Sql) {
  const items = await sql.query<SportRow & { photo_url: string }>(
    `select s.code, s.name_en, s.name_vi, s.court_prefix, s.color_key, s.glyph_key,
            s.is_scope_all, s.max_players, s.slot_duration_min, s.sort_order, s.enabled,
            s.retired_at, s.created_at, s.updated_at,
            concat('/v1/site-assets/sport.', s.code, '/file') as photo_url
       from sports s
      where not s.is_scope_all and s.enabled = true and s.retired_at is null
      order by s.sort_order asc, s.code asc`,
  );
  return { status: 200, body: { items } };
}

export async function managerSportsList(sql: Sql, user: PublicUser) {
  requireRole(user, ["manager"]);

  const items = await sql.query<
    SportRow & {
      active_courts_count: number;
      future_bookings_count: number;
      future_classes_count: number;
      active_plans_count: number;
      photo_url: string;
    }
  >(
    `select s.code, s.name_en, s.name_vi, s.court_prefix, s.color_key, s.glyph_key,
            s.is_scope_all, s.max_players, s.slot_duration_min, s.sort_order, s.enabled,
            s.retired_at, s.created_at, s.updated_at,
            concat('/v1/site-assets/sport.', s.code, '/file') as photo_url,
            coalesce(c.courts_count, 0)::int as active_courts_count,
            coalesce(b.bookings_count, 0)::int as future_bookings_count,
            coalesce(cl.classes_count, 0)::int as future_classes_count,
            coalesce(p.plans_count, 0)::int as active_plans_count
       from sports s
       left join (
         select sport, count(*)::int as courts_count
           from courts
          where status = 'ready' and retired_at is null
          group by sport
       ) c on c.sport = s.code
       left join (
         select ct.sport, count(*)::int as bookings_count
           from occupancies o
           join courts ct on ct.id = o.court_id
          where o.kind = 'booking' and o.start_at > now()
          group by ct.sport
       ) b on b.sport = s.code
       left join (
         select sport, count(*)::int as classes_count
           from classes
          where status = 'open' and end_on >= current_date
          group by sport
       ) cl on cl.sport = s.code
       left join (
         select sport_scope, count(*)::int as plans_count
           from membership_plans
          where is_on_sale = true
          group by sport_scope
       ) p on p.sport_scope = s.code
      order by s.sort_order asc, s.code asc`,
  );

  return { status: 200, body: { items } };
}

export async function managerSportCreate(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  limit(`sport:${user.id}`, RULES.sportMutation);

  const b = await readJson(request);

  const code = str(b.code)?.trim().toLowerCase();
  if (!code || !CODE_RE.test(code)) {
    throw err.field("code", "Code must be 2-24 lowercase letters, numbers, hyphens or underscores, starting with a letter.");
  }
  if (code === "all") {
    throw err.field("code", "Code 'all' is reserved for global scope.");
  }

  const nameEn = str(b.name_en)?.trim();
  if (!nameEn || nameEn.length > 40) {
    throw err.field("name_en", "English name is required (max 40 characters).");
  }

  const nameVi = str(b.name_vi)?.trim();
  if (!nameVi || nameVi.length > 40) {
    throw err.field("name_vi", "Vietnamese name is required (max 40 characters).");
  }

  const courtPrefix = str(b.court_prefix)?.trim().toUpperCase();
  if (!courtPrefix || !PREFIX_RE.test(courtPrefix)) {
    throw err.field("court_prefix", "Court prefix must be exactly 2 capital letters (e.g. PB).");
  }

  const rawColor = str(b.color_key)?.trim().toLowerCase() ?? "leaf";
  const colorKey = (ALLOWED_COLOR_KEYS as readonly string[]).includes(rawColor) ? rawColor : "leaf";
  const glyphKey = str(b.glyph_key)?.trim().toLowerCase() || "generic";
  const sortOrder = num(b.sort_order) ?? 100;
  const maxPlayers = num(b.max_players) ?? 4;
  const slotDurationMin = num(b.slot_duration_min) ?? 60;

  // Check code uniqueness
  const dupCode = await one(sql, `select 1 from sports where lower(code) = lower($1)`, [code]);
  if (dupCode) {
    throw err.conflict("A sport with this code already exists.");
  }

  // Check prefix uniqueness
  const dupPrefix = await one(sql, `select 1 from sports where court_prefix = $1`, [courtPrefix]);
  if (dupPrefix) {
    throw err.conflict("That court prefix is already used by another sport.");
  }

  // Insert sport
  const row = await one<SportRow>(
    sql,
    `insert into sports (code, name_en, name_vi, court_prefix, color_key, glyph_key, is_scope_all, max_players, slot_duration_min, sort_order, enabled)
     values ($1, $2, $3, $4, $5, $6, false, $7, $8, $9, true)
     returning *`,
    [code, nameEn, nameVi, courtPrefix, colorKey, glyphKey, maxPlayers, slotDurationMin, sortOrder],
  );

  // Initial price rules
  const weekdayPrice = num(b.weekday_price_vnd) ?? num(b.price_vnd) ?? 100000;
  const weekdayPeak = num(b.weekday_peak_price_vnd) ?? Math.round(weekdayPrice * 1.5);
  const weekendPrice = num(b.weekend_price_vnd) ?? weekdayPrice;
  const weekendPeak = num(b.weekend_peak_price_vnd) ?? Math.round(weekendPrice * 1.5);

  const priceRules = [
    { day_kind: "weekday", start_local: "06:00:00", end_local: "17:00:00", price_vnd: weekdayPrice, is_peak: false, start_min: 360, end_min: 1020 },
    { day_kind: "weekday", start_local: "17:00:00", end_local: "22:00:00", price_vnd: weekdayPeak, is_peak: true, start_min: 1020, end_min: 1320 },
    { day_kind: "weekend", start_local: "06:00:00", end_local: "08:00:00", price_vnd: weekendPrice, is_peak: false, start_min: 360, end_min: 480 },
    { day_kind: "weekend", start_local: "08:00:00", end_local: "22:00:00", price_vnd: weekendPeak, is_peak: true, start_min: 480, end_min: 1320 },
  ];

  for (const pr of priceRules) {
    await sql.query(
      `insert into price_rules (id, sport, court_id, day_kind, start_local, end_local, price_vnd, is_peak)
       values (gen_random_uuid(), $1, null, $2, $3, $4, $5, $6)`,
      [code, pr.day_kind, pr.start_local, pr.end_local, pr.price_vnd, pr.is_peak],
    );
  }

  // Register site asset slot
  const defaultPhotoPath = str(b.default_path) || `/media/sports/${code}.jpg`;
  await sql.query(
    `insert into site_assets (slot, kind, default_path, alt_en, alt_vi, enabled)
     values ($1, 'image', $2, $3, $4, true)
     on conflict (slot) do nothing`,
    [`sport.${code}`, defaultPhotoPath, `${nameEn} court photo`, `Ảnh sân ${nameVi}`],
  );

  await audit(sql, user.id, "create_sport", "sport", code, null, {
    code,
    name_en: nameEn,
    court_prefix: courtPrefix,
  });
  invalidateSportCodesCache();

  return { status: 201, body: { ok: true, sport: row } };
}

export async function managerSportPatch(sql: Sql, code: string, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  limit(`sport:${user.id}`, RULES.sportMutation);

  const cur = await one<SportRow>(sql, `select * from sports where code = $1`, [code]);
  if (!cur) throw err.notFound("No such sport.");

  const b = await readJson(request);

  const nameEn = b.name_en !== undefined ? str(b.name_en)?.trim() : cur.name_en;
  if (!nameEn || nameEn.length > 40) throw err.field("name_en", "English name must be 1-40 characters.");

  const nameVi = b.name_vi !== undefined ? str(b.name_vi)?.trim() : cur.name_vi;
  if (!nameVi || nameVi.length > 40) throw err.field("name_vi", "Vietnamese name must be 1-40 characters.");

  let courtPrefix = cur.court_prefix;
  if (b.court_prefix !== undefined && b.court_prefix !== cur.court_prefix) {
    const nextPrefix = str(b.court_prefix)?.trim().toUpperCase();
    if (cur.is_scope_all) {
      throw err.field("court_prefix", "Scope 'all' cannot have a court prefix.");
    }
    if (!nextPrefix || !PREFIX_RE.test(nextPrefix)) {
      throw err.field("court_prefix", "Court prefix must be exactly 2 capital letters.");
    }
    // Check if courts already exist for this sport
    const courtCount = await one<{ cnt: number }>(sql, `select count(*)::int as cnt from courts where sport = $1`, [code]);
    if ((courtCount?.cnt ?? 0) > 0) {
      throw err.conflict("Cannot change prefix when courts already exist for this sport.");
    }
    // Check if prefix in use by other sport
    const dup = await one(sql, `select 1 from sports where court_prefix = $1 and code <> $2`, [nextPrefix, code]);
    if (dup) {
      throw err.conflict("Court prefix is already in use by another sport.");
    }
    courtPrefix = nextPrefix;
  }

  const rawColor = b.color_key !== undefined ? str(b.color_key)?.trim().toLowerCase() : cur.color_key;
  const colorKey = (ALLOWED_COLOR_KEYS as readonly string[]).includes(rawColor ?? "") ? (rawColor ?? "leaf") : cur.color_key;
  const glyphKey = b.glyph_key !== undefined ? str(b.glyph_key)?.trim().toLowerCase() || "generic" : cur.glyph_key;
  const sortOrder = b.sort_order !== undefined ? num(b.sort_order) ?? cur.sort_order : cur.sort_order;
  const enabled = b.enabled !== undefined ? b.enabled === true || b.enabled === "true" : cur.enabled;

  const row = await one<SportRow>(
    sql,
    `update sports
        set name_en = $1, name_vi = $2, court_prefix = $3, color_key = $4,
            glyph_key = $5, sort_order = $6, enabled = $7, updated_at = now()
      where code = $8
      returning *`,
    [nameEn, nameVi, courtPrefix, colorKey, glyphKey, sortOrder, enabled, code],
  );

  await audit(sql, user.id, "update_sport", "sport", code, cur, row);
  invalidateSportCodesCache();
  return { status: 200, body: { ok: true, sport: row } };
}

export async function managerSportRetire(sql: Sql, code: string, user: PublicUser) {
  requireRole(user, ["manager"]);
  limit(`sport:${user.id}`, RULES.sportMutation);

  const cur = await one<SportRow>(sql, `select * from sports where code = $1`, [code]);
  if (!cur) throw err.notFound("No such sport.");
  if (cur.is_scope_all) {
    throw err.conflict("Cannot retire the global 'all' sport scope.");
  }
  if (cur.retired_at) {
    return { status: 200, body: { ok: true, sport: cur } };
  }

  // Cannot retire the last active playable sport
  const remainingActive = await one<{ cnt: number }>(
    sql,
    `select count(*)::int as cnt from sports where enabled and retired_at is null and not is_scope_all and code <> $1`,
    [code],
  );
  if (!remainingActive || remainingActive.cnt === 0) {
    throw err.conflict("Cannot retire the last active sport.");
  }

  // Check blockers: active courts, future bookings, future classes, active plans
  const blockers: string[] = [];

  const activeCourts = await one<{ cnt: number }>(
    sql,
    `select count(*)::int as cnt from courts where sport = $1 and status = 'ready' and retired_at is null`,
    [code],
  );
  if ((activeCourts?.cnt ?? 0) > 0) {
    blockers.push(`${activeCourts!.cnt} active court(s) must be retired first.`);
  }

  const futureBookings = await one<{ cnt: number }>(
    sql,
    `select count(*)::int as cnt
       from occupancies o
       join courts c on c.id = o.court_id
      where c.sport = $1 and o.kind = 'booking' and o.start_at > now()`,
    [code],
  );
  if ((futureBookings?.cnt ?? 0) > 0) {
    blockers.push(`${futureBookings!.cnt} future booking(s) exist for this sport.`);
  }

  const futureClasses = await one<{ cnt: number }>(
    sql,
    `select count(*)::int as cnt from classes where sport = $1 and status = 'open' and end_on >= current_date`,
    [code],
  );
  if ((futureClasses?.cnt ?? 0) > 0) {
    blockers.push(`${futureClasses!.cnt} active or upcoming class(es) exist for this sport.`);
  }

  const activePlans = await one<{ cnt: number }>(
    sql,
    `select count(*)::int as cnt from membership_plans where sport_scope = $1 and is_on_sale = true`,
    [code],
  );
  if ((activePlans?.cnt ?? 0) > 0) {
    blockers.push(`${activePlans!.cnt} active membership plan(s) cover this sport.`);
  }

  if (blockers.length > 0) {
    throw new ApiError(409, "CONFLICT_STATE", `Cannot retire sport: ${blockers.join(" ")}`, {
      reasons: blockers,
    });
  }

  const row = await one<SportRow>(
    sql,
    `update sports set retired_at = now(), updated_at = now() where code = $1 returning *`,
    [code],
  );

  await audit(sql, user.id, "retire_sport", "sport", code, { retired_at: null }, { retired_at: row!.retired_at });
  invalidateSportCodesCache();
  return { status: 200, body: { ok: true, sport: row } };
}

export async function managerSportRestore(sql: Sql, code: string, user: PublicUser) {
  requireRole(user, ["manager"]);
  limit(`sport:${user.id}`, RULES.sportMutation);

  const cur = await one<SportRow>(sql, `select * from sports where code = $1`, [code]);
  if (!cur) throw err.notFound("No such sport.");
  if (!cur.retired_at) {
    return { status: 200, body: { ok: true, sport: cur } };
  }

  const row = await one<SportRow>(
    sql,
    `update sports set retired_at = null, enabled = true, updated_at = now() where code = $1 returning *`,
    [code],
  );

  await audit(sql, user.id, "restore_sport", "sport", code, { retired_at: cur.retired_at }, { retired_at: null });
  invalidateSportCodesCache();
  return { status: 200, body: { ok: true, sport: row } };
}

export async function managerSportDelete(sql: Sql, code: string, user: PublicUser) {
  requireRole(user, ["manager"]);
  limit(`sport:${user.id}`, RULES.sportMutation);

  const cur = await one<SportRow>(sql, `select * from sports where code = $1`, [code]);
  if (!cur) throw err.notFound("No such sport.");
  if (cur.is_scope_all) {
    throw err.conflict("Cannot delete the global 'all' sport scope.");
  }

  // Check if sport has ANY history anywhere in the system
  const checks = [
    { table: "courts", query: `select 1 from courts where sport = $1 limit 1` },
    { table: "classes", query: `select 1 from classes where sport = $1 limit 1` },
    { table: "membership_plans", query: `select 1 from membership_plans where sport_scope = $1 limit 1` },
    { table: "subscriptions", query: `select 1 from subscriptions where sport_scope = $1 limit 1` },
    { table: "promotions", query: `select 1 from promotions where sport = $1 limit 1` },
    { table: "equipment_items", query: `select 1 from equipment_items where sport = $1 limit 1` },
    { table: "member_levels", query: `select 1 from member_levels where sport = $1 limit 1` },
    { table: "progress_reviews", query: `select 1 from progress_reviews where sport = $1 limit 1` },
    { table: "coach_sports", query: `select 1 from coach_sports where sport = $1 limit 1` },
  ];

  for (const c of checks) {
    const hasHistory = await one(sql, c.query, [code]);
    if (hasHistory) {
      throw err.conflict("This sport has history. Retire it instead.");
    }
  }

  // Safe to delete completely
  await sql.query(`delete from price_rules where sport = $1`, [code]);
  await sql.query(`delete from site_assets where slot = $1`, [`sport.${code}`]);
  await sql.query(`delete from sports where code = $1`, [code]);

  await audit(sql, user.id, "delete_sport", "sport", code, cur, null);
  invalidateSportCodesCache();
  return { status: 200, body: { ok: true, deleted: code } };
}

let cachedSportCodes: { codes: string[]; timestamp: number } | null = null;
let cachedAllSportCodes: { codes: string[]; timestamp: number } | null = null;

export function invalidateSportCodesCache() {
  cachedSportCodes = null;
  cachedAllSportCodes = null;
}

export async function getActiveSportCodes(sql: Sql, includeScopeAll = false): Promise<string[]> {
  const now = Date.now();
  const cache = includeScopeAll ? cachedAllSportCodes : cachedSportCodes;
  if (cache && now - cache.timestamp < 30_000) {
    return cache.codes;
  }
  const rows = await sql.query<{ code: string }>(
    `select code from sports where retired_at is null ${includeScopeAll ? "" : "and not is_scope_all"} order by sort_order asc, code asc`,
  );
  const codes = rows.map((r) => r.code);
  if (includeScopeAll) {
    cachedAllSportCodes = { codes, timestamp: now };
  } else {
    cachedSportCodes = { codes, timestamp: now };
  }
  return codes;
}

