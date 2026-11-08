import type { Sql } from "@/lib/db";
import { err } from "../errors";
import { addDays, ictDateString } from "../time";
import { audit, bool, readJson, str } from "../helpers";
import { quotePromo } from "../promos";
import { limit, RULES } from "../ratelimit";
import { requireRole, type PublicUser } from "../session";
import { one } from "../tx";
import { parseInteger } from "../validate";
import { getActiveSportCodes } from "./sports";

export async function plansList(sql: Sql, user: PublicUser | null) {
  const all = user?.role === "manager";
  const items = await sql.query(
    `select id, name, sport_scope, duration_days, session_quota, court_hours,
            court_discount_pct, price_vnd, is_on_sale, carry_over_hours
       from membership_plans
      where $1 or is_on_sale = true
      order by price_vnd`,
    [all],
  );
  return { status: 200, body: { items } };
}

const INT4 = 2_147_483_647;

/** Blank means "not given" (null); anything else has to be a whole number in range. */
function optInt(field: string, label: string, v: unknown, min: number, max: number): number | null {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return null;
  return parseInteger(field, label, v, min, max);
}

function planName(v: unknown): string | undefined {
  const name = str(v);
  if (name === undefined) return undefined;
  if (name.length > 80) throw err.field("name", "A plan name is at most 80 characters.");
  return name;
}

export async function plansCreate(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const b = await readJson(request);
  const name = planName(b.name);
  const sport_scope = str(b.sport_scope);
  if (!name) throw err.field("name", "A plan needs a name.");
  const allowedScopes = await getActiveSportCodes(sql, true);
  if (!sport_scope || !allowedScopes.includes(sport_scope)) throw err.field("sport_scope", "Choose a sport.");
  const price_vnd = parseInteger("price_vnd", "Price", b.price_vnd, 0, INT4);
  const duration_days = optInt("duration_days", "Duration", b.duration_days, 1, 3650);
  const session_quota = optInt("session_quota", "Class sessions", b.session_quota, 0, 100000);
  const court_hours = optInt("court_hours", "Court hours", b.court_hours, 0, 100000) ?? 0;
  const court_discount_pct = optInt("court_discount_pct", "Court discount", b.court_discount_pct, 0, 100) ?? 0;
  const row = await one(
    sql,
    `insert into membership_plans
       (name, sport_scope, duration_days, session_quota, court_hours, court_discount_pct, price_vnd, is_on_sale, carry_over_hours)
     values ($1,$2,$3,$4,$5,$6,$7, coalesce($8,true), coalesce($9,false))
     returning *`,
    [
      name,
      sport_scope,
      duration_days,
      session_quota,
      court_hours,
      court_discount_pct,
      price_vnd,
      bool(b.is_on_sale),
      bool(b.carry_over_hours),
    ],
  );
  await audit(sql, user.id, "create_plan", "plan", (row as { id: string }).id);
  return { status: 201, body: row };
}

/**
 * One plan opened up (G-05): everything the table holds about it, and how many
 * people hold it today — which is what decides whether withdrawing it from sale
 * matters to anyone (it never takes it away from them; BR-16 only stops new
 * orders).
 */
export async function plansGet(sql: Sql, id: string, user: PublicUser) {
  requireRole(user, ["manager"]);
  const plan = await one(
    sql,
    `select id, name, sport_scope, duration_days, session_quota, court_hours,
            court_discount_pct, price_vnd, is_on_sale, carry_over_hours
       from membership_plans where id = $1`,
    [id],
  );
  if (!plan) throw err.notFound("No such plan.");
  const holders = await one<Record<string, number>>(
    sql,
    `select count(*) filter (where status = 'active')::int as active,
            count(*) filter (where status = 'pending')::int as pending,
            count(*) filter (where status = 'frozen')::int as frozen,
            count(*)::int as ever
       from subscriptions where plan_id = $1`,
    [id],
  );
  return { status: 200, body: { plan, holders } };
}

export async function plansPatch(sql: Sql, id: string, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const b = await readJson(request);
  const cur = await one(sql, `select * from membership_plans where id = $1`, [id]);
  if (!cur) throw err.notFound();
  const name = planName(b.name) ?? null;
  const price = b.price_vnd === undefined ? null : parseInteger("price_vnd", "Price", b.price_vnd, 0, INT4);
  const duration = b.duration_days === undefined ? null : optInt("duration_days", "Duration", b.duration_days, 1, 3650);
  const quota = b.session_quota === undefined ? null : optInt("session_quota", "Class sessions", b.session_quota, 0, 100000);
  const hours = b.court_hours === undefined ? null : optInt("court_hours", "Court hours", b.court_hours, 0, 100000);
  const disc = b.court_discount_pct === undefined ? null : optInt("court_discount_pct", "Court discount", b.court_discount_pct, 0, 100);
  await sql.query(
    `update membership_plans set
       name = coalesce($2, name),
       duration_days = coalesce($3, duration_days),
       session_quota = coalesce($4, session_quota),
       court_hours = coalesce($5, court_hours),
       court_discount_pct = coalesce($6, court_discount_pct),
       price_vnd = coalesce($7, price_vnd),
       is_on_sale = coalesce($8, is_on_sale),
       carry_over_hours = coalesce($9, carry_over_hours)
     where id = $1`,
    [id, name, duration, quota, hours, disc, price, bool(b.is_on_sale) ?? null, bool(b.carry_over_hours) ?? null],
  );
  const row = await one(sql, `select * from membership_plans where id = $1`, [id]);
  await audit(
    sql,
    user.id,
    typeof b.is_on_sale === "boolean" && Object.keys(b).length === 1
      ? b.is_on_sale
        ? "put_plan_on_sale"
        : "withdraw_plan_from_sale"
      : "patch_plan",
    "plan",
    id,
    cur,
    row,
  );
  return { status: 200, body: row };
}

export async function subscriptionsCreate(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["member", "receptionist", "manager"]);
  const b = await readJson(request);
  const planId = str(b.plan_id);
  if (!planId) throw err.validation("plan_id is required.");
  let userId = user.id;
  if (user.role === "receptionist" || user.role === "manager") {
    userId = str(b.user_id) ?? user.id;
    const targetUser = await one<{ role: string; status: string }>(
      sql,
      `select role, status from users where id = $1`,
      [userId],
    );
    if (!targetUser) throw err.field("user_id", "That user does not exist.");
    if (targetUser.role !== "member") {
      throw err.forbidden("Subscriptions can only be issued to members.");
    }
  }
  // Members only. Staff raise these on behalf of somebody standing at the desk,
  // and a queue of walk-ins legitimately looks like a burst.
  if (user.role === "member") {
    // Short window first: a double-tap or a stuck button is the common case and
    // deserves the cheaper, friendlier message.
    limit(`plan:${user.id}`, RULES.planRequest, "plan requests");
    limit(`plan-h:${user.id}`, RULES.planRequestHourly, "plan requests");
  }
  const plan = await one<{
    id: string;
    sport_scope: string;
    duration_days: number | null;
    session_quota: number | null;
    court_hours: number;
    price_vnd: number;
    is_on_sale: boolean;
  }>(sql, `select * from membership_plans where id = $1`, [planId]);
  if (!plan) throw err.notFound("No such plan.");
  if (!plan.is_on_sale && user.role === "member") throw err.br("BR-16", "That plan is no longer on sale.");

  const today = ictDateString();
  const duration = plan.duration_days ?? 365;
  const live = await one<{
    id: string;
    status: string;
    end_on: string;
    plan_id: string;
  }>(
    sql,
    `select id, status, end_on::text, plan_id from subscriptions
      where user_id = $1 and sport_scope = $2 and status in ('active','frozen')
      limit 1`,
    [userId, plan.sport_scope],
  );
  if (live?.status === "frozen") throw err.br("BR-14", "Your plan is frozen — unfreeze it before buying more.");
  const pending = await one<{ id: string }>(
    sql,
    `select id from subscriptions where user_id = $1 and sport_scope = $2 and status = 'pending'`,
    [userId, plan.sport_scope],
  );
  const start = live && live.end_on >= today ? live.end_on : today;
  const end = addDays(start, duration);
  // The code is priced into the order now; the use is counted when it is paid (BR-41).
  const promoCode = str(b.promo_code);
  const promo = promoCode
    ? await quotePromo(sql, {
        code: promoCode,
        userId,
        scope: "plan",
        sport: plan.sport_scope,
        planId: plan.id,
        orderVnd: plan.price_vnd,
      })
    : null;
  const amountDue = plan.price_vnd - (promo?.discount_vnd ?? 0);
  if (pending) {
    await sql.query(
      `update subscriptions set plan_id = $2, start_on = $3, end_on = $4,
              court_hours_left = $5, session_left = $6, promo_id = $7, promo_discount_vnd = $8,
              price_vnd = $9
        where id = $1`,
      [pending.id, plan.id, start, end, plan.court_hours, plan.session_quota, promo?.promo_id ?? null, promo?.discount_vnd ?? 0, plan.price_vnd],
    );
    const row = await one(sql, `select * from subscriptions where id = $1`, [pending.id]);
    return { status: 201, body: { subscription: row, preview_end: end, amount_due_vnd: amountDue, promo } };
  }
  const row = await one(
    sql,
    `insert into subscriptions
       (user_id, plan_id, sport_scope, start_on, end_on, status, court_hours_left, session_left, promo_id, promo_discount_vnd, price_vnd)
     values ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10)
     returning *`,
    [userId, plan.id, plan.sport_scope, start, end, plan.court_hours, plan.session_quota, promo?.promo_id ?? null, promo?.discount_vnd ?? 0, plan.price_vnd],
  );
  return { status: 201, body: { subscription: row, preview_end: end, amount_due_vnd: amountDue, promo } };
}
