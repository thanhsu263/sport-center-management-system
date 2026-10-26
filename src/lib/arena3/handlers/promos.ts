/**
 * Promotions — manager CRUD and the "does this code work?" preview (FR-PAY-03, UC-25).
 *
 * Only a manager creates, edits or pauses a code (BR-43). A code that has been
 * used is never deleted, and editing it only changes orders priced afterwards:
 * orders already quoted keep the discount written onto them.
 */
import type { Sql } from "@/lib/db";
import { err } from "../errors";
import { audit, bool, readJson, str } from "../helpers";
import { applyDiscount, lookupPrice, memberDiscount } from "../pricing";
import { normalizeCode, quotePromo, type PromoScope } from "../promos";
import { requireRole, type PublicUser } from "../session";
import { getSettings } from "../helpers";
import { one } from "../tx";
import { parseInteger } from "../validate";
import { getActiveSportCodes } from "./sports";

const INT4 = 2_147_483_647;
// Class sign-ups carry no price in Arena3, so a code can only apply to plans and courts.
const SCOPES: PromoScope[] = ["plan", "court"];
const CODE_RE = /^[A-Z0-9_-]{3,24}$/;

function isBlank(v: unknown) {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

function optInt(field: string, label: string, v: unknown, min: number, max: number): number | null {
  return isBlank(v) ? null : parseInteger(field, label, v, min, max);
}

function optDate(field: string, v: unknown): string | null {
  if (isBlank(v)) return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw err.field(field, "That date is not valid.");
  return d.toISOString();
}

function parseScopes(v: unknown): string[] {
  if (v === undefined) return ["plan", "court"];
  if (!Array.isArray(v) || v.length === 0) throw err.field("applies_to", "Pick plans, courts or both.");
  const out = [...new Set(v.map(String))];
  for (const s of out) {
    if (!(SCOPES as string[]).includes(s)) throw err.field("applies_to", `"${s}" is not something a code can apply to.`);
  }
  return out;
}

type Parsed = {
  code: string;
  name: string;
  kind: "percent" | "amount";
  value: number;
  max_discount_vnd: number | null;
  min_order_vnd: number;
  starts_at: string | null;
  ends_at: string | null;
  max_uses: number | null;
  max_per_member: number;
  applies_to: string[];
  sport: string | null;
  plan_id: string | null;
  stackable: boolean;
};

async function parseBody(sql: Sql, b: Record<string, unknown>, partial: boolean): Promise<Partial<Parsed>> {
  const out: Partial<Parsed> = {};
  const has = (k: string) => b[k] !== undefined;
  if (!partial || has("code")) {
    const code = normalizeCode(b.code);
    if (!CODE_RE.test(code)) {
      throw err.field("code", "Use 3–24 letters, digits, - or _ (no spaces).");
    }
    out.code = code;
  }
  if (!partial || has("name")) {
    const name = str(b.name)?.trim();
    if (!name) throw err.field("name", "Give the code a name.");
    if (name.length > 120) throw err.field("name", "The name must be at most 120 characters.");
    out.name = name;
  }
  if (!partial || has("kind")) {
    const kind = str(b.kind);
    if (kind !== "percent" && kind !== "amount") throw err.field("kind", "Choose percent or fixed amount.");
    out.kind = kind;
  }
  if (!partial || has("value")) {
    out.value = parseInteger("value", "Value", b.value, 1, INT4);
  }
  if (!partial || has("max_discount_vnd")) out.max_discount_vnd = optInt("max_discount_vnd", "Max discount", b.max_discount_vnd, 1000, INT4);
  if (!partial || has("min_order_vnd")) out.min_order_vnd = optInt("min_order_vnd", "Minimum order", b.min_order_vnd, 0, INT4) ?? 0;
  if (!partial || has("starts_at")) out.starts_at = optDate("starts_at", b.starts_at);
  if (!partial || has("ends_at")) out.ends_at = optDate("ends_at", b.ends_at);
  if (!partial || has("max_uses")) out.max_uses = optInt("max_uses", "Total uses", b.max_uses, 1, INT4);
  if (!partial || has("max_per_member")) out.max_per_member = optInt("max_per_member", "Uses per member", b.max_per_member, 1, 1000) ?? 1;
  if (!partial || has("applies_to")) out.applies_to = parseScopes(b.applies_to);
  if (!partial || has("sport")) {
    const sport = isBlank(b.sport) ? null : String(b.sport);
    const valid = await getActiveSportCodes(sql, true);
    if (sport && !valid.includes(sport)) throw err.field("sport", "Pick a sport or leave it for all.");
    out.sport = sport === "all" ? null : sport;
  }
  if (!partial || has("plan_id")) out.plan_id = isBlank(b.plan_id) ? null : String(b.plan_id);
  if (!partial || has("stackable")) out.stackable = bool(b.stackable) ?? false;
  return out;
}

function checkShape(p: Partial<Parsed>, kind: string, value: number) {
  if (kind === "percent" && value > 100) throw err.field("value", "A percentage is at most 100.");
  if (kind === "amount" && value % 1000 !== 0) {
    throw err.field("value", "A fixed amount is a multiple of 1,000đ (BR-42).");
  }
  if (p.starts_at && p.ends_at && new Date(p.ends_at) <= new Date(p.starts_at)) {
    throw err.field("ends_at", "The end must be after the start.");
  }
}

const SELECT = `
  select p.id, p.code, p.name, p.kind, p.value, p.max_discount_vnd, p.min_order_vnd, p.starts_at, p.ends_at,
         p.max_uses, p.max_per_member, p.applies_to, p.sport::text as sport, p.plan_id, mp.name as plan_name,
         p.stackable, p.status, p.created_at, p.updated_at,
         case
           when p.status = 'paused' then 'paused'
           when p.ends_at is not null and p.ends_at <= now() then 'expired'
           when p.starts_at > now() then 'scheduled'
           when p.max_uses is not null and u.used >= p.max_uses then 'exhausted'
           else 'active'
         end as state,
         coalesce(u.used, 0)::int as used,
         coalesce(u.given, 0)::int as discount_given_vnd
    from promotions p
    left join membership_plans mp on mp.id = p.plan_id
    left join lateral (
      select count(*) filter (where r.status = 'applied') as used,
             coalesce(sum(r.discount_vnd) filter (where r.status = 'applied'), 0) as given
        from promotion_redemptions r where r.promo_id = p.id
    ) u on true`;

export async function promosList(sql: Sql, user: PublicUser) {
  requireRole(user, ["manager"]);
  const items = await sql.query(`${SELECT} order by p.created_at desc`);
  return { status: 200, body: { items } };
}

export async function promosCreate(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const p = (await parseBody(sql, await readJson(request), false)) as Parsed;
  checkShape(p, p.kind, p.value);
  if (await one(sql, `select 1 as ok from promotions where upper(code) = $1`, [p.code])) {
    throw err.field("code", "That code already exists.");
  }
  if (p.plan_id && !(await one(sql, `select 1 as ok from membership_plans where id = $1`, [p.plan_id]))) {
    throw err.field("plan_id", "No such plan.");
  }
  const row = await one<{ id: string }>(
    sql,
    `insert into promotions
       (code, name, kind, value, max_discount_vnd, min_order_vnd, starts_at, ends_at, max_uses, max_per_member,
        applies_to, sport, plan_id, stackable, created_by)
     values ($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz, now()),$8,$9,$10,$11,$12,$13,$14,$15)
     returning id`,
    [
      p.code, p.name, p.kind, p.value, p.max_discount_vnd, p.min_order_vnd, p.starts_at, p.ends_at,
      p.max_uses, p.max_per_member, p.applies_to, p.sport, p.plan_id, p.stackable, user.id,
    ],
  );
  await audit(sql, user.id, "create_promo", "promotion", row!.id, null, { code: p.code });
  const promo = await one(sql, `${SELECT} where p.id = $1`, [row!.id]);
  return { status: 201, body: { promo } };
}

export async function promosPatch(sql: Sql, id: string, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const cur = await one<{
    id: string;
    code: string;
    kind: string;
    value: number;
    status: string;
    starts_at: string | Date;
    ends_at: string | Date | null;
  }>(
    sql,
    `select id, code, kind, value, status, starts_at, ends_at from promotions where id = $1 for update`,
    [id],
  );
  if (!cur) throw err.notFound("No such code.");
  const b = await readJson(request);
  const p = await parseBody(sql, b, true);
  const status = str(b.status);
  if (status && status !== "active" && status !== "paused") throw err.field("status", "Status is active or paused.");
  const used = await one<{ n: number }>(sql, `select count(*)::int as n from promotion_redemptions where promo_id = $1`, [id]);
  if (p.code && p.code !== cur.code && (used?.n ?? 0) > 0) {
    throw err.br("BR-43", "A code that has been used keeps its name — pause it and create a new one.");
  }
  if (p.code && p.code !== cur.code && (await one(sql, `select 1 as ok from promotions where upper(code) = $1 and id <> $2`, [p.code, id]))) {
    throw err.field("code", "That code already exists.");
  }
  // Moving only one end of the window must still leave the end after the start.
  checkShape(
    {
      ...p,
      starts_at: (p.starts_at ?? cur.starts_at) as Parsed["starts_at"],
      ends_at: (p.ends_at === undefined ? cur.ends_at : p.ends_at) as Parsed["ends_at"],
    },
    p.kind ?? cur.kind,
    p.value ?? cur.value,
  );
  const sets: string[] = [];
  const vals: unknown[] = [id];
  const add = (col: string, v: unknown, cast = "") => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}${cast}`);
  };
  for (const [k, v] of Object.entries(p)) {
    if (k === "starts_at" && v === null) continue;
    add(k, v, k.endsWith("_at") ? "::timestamptz" : "");
  }
  if (status) add("status", status);
  if (!sets.length) throw err.validation("Nothing to change.");
  sets.push("updated_at = now()");
  await sql.query(`update promotions set ${sets.join(", ")} where id = $1`, vals);
  await audit(sql, user.id, status && Object.keys(p).length === 0 ? `${status === "paused" ? "pause" : "resume"}_promo` : "patch_promo", "promotion", id, cur, { ...p, status });
  const promo = await one(sql, `${SELECT} where p.id = $1`, [id]);
  return { status: 200, body: { promo } };
}

/** Per-code redemptions, newest first — what the manager reads to see a campaign working. */
export async function promosRedemptions(sql: Sql, id: string, user: PublicUser) {
  requireRole(user, ["manager"]);
  const items = await sql.query(
    `select r.id, r.status, r.discount_vnd, r.created_at, r.restored_at, u.full_name, u.member_code,
            p.code as payment_code, p.ref_type
       from promotion_redemptions r
       left join users u on u.id = r.user_id
       join payments p on p.id = r.payment_id
      where r.promo_id = $1
      order by r.created_at desc limit 200`,
    [id],
  );
  return { status: 200, body: { items } };
}

/**
 * Preview: what would this code take off this order? Used by the order forms so the
 * price on screen is the price that will be charged. Nothing is written.
 */
export async function promosValidate(sql: Sql, request: Request, user: PublicUser) {
  const b = await readJson(request);
  const scope = str(b.scope) as PromoScope | undefined;
  if (!scope || !SCOPES.includes(scope)) throw err.field("scope", "scope must be plan or court.");
  const code = str(b.code);
  if (!code) throw err.field("promo_code", "Enter a promo code.");
  const staff = user.role === "receptionist" || user.role === "manager";
  const targetUser = staff && str(b.user_id) ? str(b.user_id)! : user.id;

  if (scope === "plan") {
    const planId = str(b.plan_id);
    if (!planId) throw err.field("plan_id", "plan_id is required.");
    const plan = await one<{ price_vnd: number; sport_scope: string }>(
      sql,
      `select price_vnd, sport_scope::text as sport_scope from membership_plans where id = $1`,
      [planId],
    );
    if (!plan) throw err.notFound("No such plan.");
    const q = await quotePromo(sql, { code, userId: targetUser, scope, sport: plan.sport_scope, planId, orderVnd: plan.price_vnd });
    return { status: 200, body: { valid: true, order_vnd: plan.price_vnd, ...q } };
  }
  {
    const courtId = str(b.court_id);
    const startAt = str(b.start_at);
    if (!courtId || !startAt) throw err.field("court_id", "court_id and start_at are required.");
    const court = await one<{ sport: string }>(sql, `select sport::text as sport from courts where id = $1`, [courtId]);
    if (!court) throw err.notFound("No such court.");
    const settings = await getSettings(sql);
    const start = new Date(startAt);
    if (Number.isNaN(start.getTime())) throw err.field("start_at", "That time is not valid.");
    const list = await lookupPrice(sql, { sport: court.sport, courtId, start });
    const disc = await memberDiscount(sql, targetUser, court.sport);
    const order = applyDiscount(list.price_vnd, disc.pct, settings.round_vnd);
    const q = await quotePromo(sql, { code, userId: targetUser, scope, sport: court.sport, orderVnd: order, planDiscountPct: disc.pct, listVnd: list.price_vnd });
    return { status: 200, body: { valid: true, order_vnd: order, ...q } };
  }
  throw err.field("scope", "scope must be plan or court.");
}
