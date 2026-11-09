import type { Sql } from "@/server/data/db";
import { err } from "../errors";
import { addDays, ictDateString } from "../../../shared/arena3/time";
import { audit, bool, getSettings, readJson, str } from "../helpers";
import { addMonths } from "../../services/membership";
import { quotePromo } from "../../services/promos";
import { limit, RULES } from "../ratelimit";
import { requireRole, type PublicUser } from "../session";
import { one } from "../tx";
import { parseInteger } from "../validate";

export async function plansList(sql: Sql, user: PublicUser | null) {
  const all = user?.role === "manager";
  const items = await sql.query(
    `select id, name, duration_months, duration_days, price_vnd, is_on_sale
       from membership_plans
      where $1 or is_on_sale = true
      order by price_vnd`,
    [all],
  );
  const settings = await getSettings(sql);
  return {
    status: 200,
    body: {
      items,
      member_court_fee_vnd: settings.member_court_fee_vnd,
    },
  };
}

const INT4 = 2_147_483_647;

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
  if (!name) throw err.field("name", "A plan needs a name.");
  const price_vnd = parseInteger("price_vnd", "Price", b.price_vnd, 0, INT4);
  const duration_months = parseInteger("duration_months", "Duration", b.duration_months, 1, 60);
  const row = await one(
    sql,
    `insert into membership_plans (name, sport_scope, duration_months, duration_days, price_vnd, is_on_sale)
     values ($1, 'all', $2, $3, $4, coalesce($5, true))
     returning *`,
    [name, duration_months, duration_months * 30, price_vnd, bool(b.is_on_sale)],
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
    `select id, name, duration_months, duration_days, price_vnd, is_on_sale
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
  const months = b.duration_months === undefined ? null : parseInteger("duration_months", "Duration", b.duration_months, 1, 60);
  await sql.query(
    `update membership_plans set
       name = coalesce($2, name),
       duration_months = coalesce($3::int, duration_months),
       duration_days = coalesce($3::int * 30, duration_days),
       price_vnd = coalesce($4, price_vnd),
       is_on_sale = coalesce($5, is_on_sale)
     where id = $1`,
    [id, name, months, price, bool(b.is_on_sale) ?? null],
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
    duration_months: number | null;
    duration_days: number | null;
    price_vnd: number;
    is_on_sale: boolean;
  }>(sql, `select * from membership_plans where id = $1`, [planId]);
  if (!plan) throw err.notFound("No such plan.");
  if (!plan.is_on_sale && user.role === "member") throw err.br("BR-16", "That plan is no longer on sale.");

  const today = ictDateString();
  const live = await one<{ status: string; end_on: string }>(
    sql,
    `select status::text, end_on::text from subscriptions
      where user_id = $1 and status in ('active','frozen')
      limit 1`,
    [userId],
  );
  if (live?.status === "frozen") throw err.br("BR-14", "Your plan is frozen — unfreeze it before buying more.");
  const pending = await one<{ id: string }>(
    sql,
    `select id from subscriptions where user_id = $1 and status = 'pending'`,
    [userId],
  );
  const start = live && live.end_on >= today ? live.end_on : today;
  const end = plan.duration_months ? addMonths(start, plan.duration_months) : addDays(start, plan.duration_days ?? 30);
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
              court_hours_left = 0, session_left = null, promo_id = $5, promo_discount_vnd = $6,
              price_vnd = $7
        where id = $1`,
      [pending.id, plan.id, start, end, promo?.promo_id ?? null, promo?.discount_vnd ?? 0, plan.price_vnd],
    );
    const row = await one(sql, `select * from subscriptions where id = $1`, [pending.id]);
    return { status: 201, body: { subscription: row, preview_end: end, amount_due_vnd: amountDue, promo } };
  }
  const row = await one(
    sql,
    `insert into subscriptions
       (user_id, plan_id, sport_scope, start_on, end_on, status, court_hours_left, session_left, promo_id, promo_discount_vnd, price_vnd)
     values ($1,$2,'all',$3,$4,'pending',0,null,$5,$6,$7)
     returning *`,
    [userId, plan.id, start, end, promo?.promo_id ?? null, promo?.discount_vnd ?? 0, plan.price_vnd],
  );
  return { status: 201, body: { subscription: row, preview_end: end, amount_due_vnd: amountDue, promo } };
}
