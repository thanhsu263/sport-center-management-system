import type { Sql } from "@/lib/db";
import { err } from "../errors";
import { audit, nextCode, num, pageOf, readJson, str } from "../helpers";
import { requireRole, type PublicUser } from "../session";
import { one } from "../tx";
import { pageParams } from "../validate";

/**
 * The extras the scope benchmark asked for: fixed weekly bookings,
 * loyalty points, coach commission, maintenance work orders and e-invoice
 * export. Every money flow here still ends in a `payments` row and an invoice,
 * and every court a customer takes still goes through `occupancies`.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const METHODS = ["cash", "card", "transfer"];

export async function openShift(sql: Sql, user: PublicUser): Promise<string | null> {
  if (user.role !== "receptionist") return null;
  const sh = await one<{ id: string }>(
    sql,
    `select id from cashier_shifts where receptionist_id = $1 and closed_at is null`,
    [user.id],
  );
  if (!sh) throw err.br("BR-44", "Open a till shift before taking payment.");
  return sh.id;
}

export function pickMethod(v: unknown): string {
  const m = str(v) ?? "cash";
  if (!METHODS.includes(m)) throw err.validation("Pick cash, card or transfer.");
  return m;
}

/* ───────────────────────── Fixed weekly bookings ───────────────────────── */

/* ───────────────────── Maintenance work orders ───────────────────── */

const WO_PRIORITY = ["low", "normal", "urgent"];
const WO_STATUS = ["open", "in_progress", "done", "cancelled"];

async function syncCourtBlock(sql: Sql, courtId: string | null) {
  if (!courtId) return;
  const blocking = await one<{ n: number }>(
    sql,
    `select count(*)::int as n from work_orders where court_id = $1 and blocks_court and status in ('open','in_progress')`,
    [courtId],
  );
  if ((blocking?.n ?? 0) > 0) {
    await sql.query(`update courts set status = 'maintenance' where id = $1 and status = 'ready'`, [courtId]);
  } else {
    await sql.query(`update courts set status = 'ready' where id = $1 and status = 'maintenance'`, [courtId]);
  }
}

export async function workOrdersList(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager", "coach"]);
  const status = new URL(request.url).searchParams.get("status");
  // "active" is the desk's default view: open or in progress.
  const statusFilter = status === "active" || (status && WO_STATUS.includes(status)) ? status : null;
  const { limit, offset } = pageParams(request, { def: 200, max: 200 });
  const rows = await sql.query<{ total: number } & Record<string, unknown>>(
    `select w.id, w.code, w.court_id, c.court_code, w.title, w.description, w.priority, w.status, w.blocks_court,
            w.assignee, w.cost_vnd, w.resolution, w.created_at, w.closed_at, u.full_name as reporter,
            count(*) over ()::int as total
       from work_orders w
       left join courts c on c.id = w.court_id
       left join users u on u.id = w.reported_by
      where ($1::text is null or w.status = $1 or ($1 = 'active' and w.status in ('open','in_progress')))
      order by (w.status in ('done','cancelled')), (w.priority = 'urgent') desc, w.created_at desc
      limit $2 offset $3`,
    [statusFilter, limit, offset],
  );
  const page = await pageOf(rows, { limit, offset }, async () =>
    ((await one<{ n: number }>(sql, `select count(*)::int as n from work_orders where ($1::text is null or status = $1 or ($1 = 'active' and status in ('open','in_progress')))`, [statusFilter]))?.n ?? 0),
  );
  const items = page.items;
  const sum = await one<{ open: number; urgent: number; cost: number }>(
    sql,
    `select count(*) filter (where status in ('open','in_progress'))::int as open,
            count(*) filter (where status in ('open','in_progress') and priority = 'urgent')::int as urgent,
            coalesce(sum(cost_vnd) filter (where status = 'done' and closed_at >= date_trunc('month', now())), 0)::int as cost
       from work_orders`,
  );
  return {
    status: 200,
    body: { items, total: page.total, limit, offset, open: sum?.open ?? 0, urgent: sum?.urgent ?? 0, cost_month_vnd: sum?.cost ?? 0 },
  };
}

export async function workOrdersCreate(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager", "coach"]);
  const b = await readJson(request);
  const title = str(b.title);
  if (!title) throw err.field("title", "Say what is broken.");
  if (title.length > 160) throw err.field("title", "Keep the title under 160 characters.");
  const priority = str(b.priority) ?? "normal";
  if (!WO_PRIORITY.includes(priority)) throw err.field("priority", "Pick low, normal or urgent.");
  const courtId = str(b.court_id) || null;
  if (courtId) await one(sql, `select 1 from courts where id = $1 and retired_at is null`, [courtId]).then((r) => { if (!r) throw err.notFound("No such court."); });
  const blocks = b.blocks_court === true && !!courtId;
  const code = await nextCode(sql, "WO");
  const row = await one<{ id: string }>(
    sql,
    `insert into work_orders (code, court_id, title, description, priority, blocks_court, reported_by)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [code, courtId, title, str(b.description) ?? null, priority, blocks, user.id],
  );
  await syncCourtBlock(sql, courtId);
  await audit(sql, user.id, "create_work_order", "work_order", row!.id, null, { title, priority, blocks });
  return { status: 201, body: { id: row!.id, code } };
}

export async function workOrdersPatch(sql: Sql, id: string, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  const b = await readJson(request);
  const cur = await one<{ court_id: string | null; status: string }>(sql, `select court_id, status from work_orders where id = $1 for update`, [id]);
  if (!cur) throw err.notFound();
  const status = str(b.status);
  if (status !== undefined && !WO_STATUS.includes(status)) throw err.field("status", "Unknown status.");
  const priority = str(b.priority);
  if (priority !== undefined && !WO_PRIORITY.includes(priority)) throw err.field("priority", "Pick low, normal or urgent.");
  const cost = b.cost_vnd === undefined ? undefined : num(b.cost_vnd);
  if (b.cost_vnd !== undefined && (cost == null || !Number.isInteger(cost) || cost < 0 || cost > 1_000_000_000)) {
    throw err.field("cost_vnd", "Enter the cost in whole đồng.");
  }
  const closing = status === "done" || status === "cancelled";
  await sql.query(
    `update work_orders set
        status = coalesce($2, status),
        priority = coalesce($3, priority),
        assignee = case when $4::boolean then $5 else assignee end,
        cost_vnd = coalesce($6, cost_vnd),
        resolution = case when $7::boolean then $8 else resolution end,
        blocks_court = coalesce($9, blocks_court),
        closed_at = case when $10::boolean then now() when $2 in ('open','in_progress') then null else closed_at end
      where id = $1`,
    [
      id,
      status ?? null,
      priority ?? null,
      b.assignee !== undefined,
      str(b.assignee) || null,
      cost ?? null,
      b.resolution !== undefined,
      str(b.resolution) || null,
      typeof b.blocks_court === "boolean" ? b.blocks_court : null,
      closing && !["done", "cancelled"].includes(cur.status),
    ],
  );
  await syncCourtBlock(sql, cur.court_id);
  await audit(sql, user.id, "patch_work_order", "work_order", id, { status: cur.status }, { status: status ?? cur.status });
  return { status: 200, body: { ok: true } };
}

