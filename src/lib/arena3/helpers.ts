import type { Sql } from "@/lib/db";
import { sha256 } from "./crypto";
import { err } from "./errors";
import type { PublicUser } from "./session";
import type { CancelTier } from "./policy";
import { one } from "./tx";

export type Settings = {
  timezone: string;
  currency: string;
  open_time: string;
  close_time: string;
  slot_minutes: number;
  hold_minutes: number;
  /** How long a slot is held while the centre waits for a bank transfer. */
  transfer_hold_minutes: number;
  book_ahead_days: number;
  max_slots_per_day: number;
  cancel_court_hours: number;
  cancel_class_hours: number;
  noshow_grace_minutes: number;
  checkin_before_minutes: number;
  refund_manager_vnd: number;
  freeze_max_days_year: number;
  minor_age: number;
  vat_rate: string | number;
  round_vnd: number;
  waitlist_offer_hours: number;
  self_checkin_enabled: boolean;
  gate_dedup_minutes: number;
  at_risk_idle_days: number;
  tax_code: string | null;
  legal_name: string | null;
  address: string | null;
  deposit_pct: number;
  deposit_peak_only: boolean;
  cancel_tiers: CancelTier[];
  series_min_weeks: number;
  series_max_weeks: number;
  series_discount_pct: number;
  loyalty_earn_vnd: number;
  loyalty_redeem_vnd: number;
};

export async function getSettings(sql: Sql): Promise<Settings> {
  const row = await one<Settings>(
    sql,
    `select timezone, currency, open_time::text, close_time::text, slot_minutes, hold_minutes,
            transfer_hold_minutes,
            book_ahead_days, max_slots_per_day, cancel_court_hours, cancel_class_hours,
            noshow_grace_minutes, checkin_before_minutes, refund_manager_vnd,
            freeze_max_days_year, minor_age, vat_rate, round_vnd, waitlist_offer_hours,
            self_checkin_enabled, gate_dedup_minutes, at_risk_idle_days,
            tax_code, legal_name, address,
            deposit_pct, deposit_peak_only, cancel_tiers, series_min_weeks, series_max_weeks,
            series_discount_pct, loyalty_earn_vnd, loyalty_redeem_vnd
       from center_settings where id = 1`,
  );
  if (!row) throw err.validation("center_settings is missing.");
  return row;
}

/**
 * Who a court booking's receipt is made out to.
 *
 * A walk-in's name and phone were typed at the counter and live on the booking,
 * not on any account; reading the receptionist's own name off the session (as
 * the till did) put the wrong person on the invoice. What was typed wins, then
 * the account, then a plain label.
 */
export async function bookingBuyer(
  sql: Sql,
  bookingId: string,
): Promise<{ name: string; phone: string | null; userId: string | null }> {
  const r = await one<{ user_id: string | null; guest_name: string | null; guest_phone: string | null; full_name: string | null }>(
    sql,
    `select b.user_id, b.guest_name, b.guest_phone, u.full_name
       from court_bookings b left join users u on u.id = b.user_id
      where b.id = $1`,
    [bookingId],
  );
  return {
    name: r?.guest_name || r?.full_name || "Khách lẻ",
    phone: r?.guest_phone ?? null,
    userId: r?.user_id ?? null,
  };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export async function audit(
  sql: Sql,
  actor: string | null,
  action: string,
  entity: string,
  entityId: string | null,
  before: unknown = null,
  after: unknown = null,
) {
  // `entity_id` is a UUID column. A caller with a key that is not one (the
  // `center_settings` row is `id = 1`) used to fail the whole request with a
  // uuid syntax error, so the id is dropped to null rather than allowed to.
  const entityUuid = entityId && UUID_RE.test(entityId) ? entityId : null;
  await sql.query(
    `insert into audit_logs (actor_id, action, entity, entity_id, before, after)
     values ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
    [
      actor,
      action,
      entity,
      entityUuid,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
    ],
  );
}

export async function nextCode(sql: Sql, kind: string): Promise<string> {
  const row = await one<{ next_doc_code: string }>(sql, `select next_doc_code($1) as next_doc_code`, [
    kind,
  ]);
  return row?.next_doc_code ?? `${kind}-0000`;
}

/**
 * The next order code to hand a payment provider.
 *
 * Deliberately NOT `next_doc_code`. A document number is this centre's own
 * bookkeeping and may legitimately restart — on a fresh install, a restored
 * backup, a wiped demo database. An order code is a promise to somebody else's
 * system: payOS remembers every code it has ever seen and rejects a repeat, so
 * a number that can move backwards is a payment feature that stops working
 * one day with no change to the code.
 *
 * Two sources, whichever is higher:
 *
 *  - **The clock**, in milliseconds. Monotonic across any database reset,
 *    because it does not come from the database at all.
 *  - **The recorded high-water mark**, which covers the case the clock cannot:
 *    a machine whose time is wrong, or a snapshot restored from the future.
 *
 * `GREATEST` in a single statement, so two requests racing cannot both read
 * the same previous value — the second one sees the first one's write.
 *
 * `provider_sequences` is the one piece of state here that cannot be rebuilt
 * from anything else, because the authority for it is the provider's records
 * rather than ours. Migration 0018 explains how to carry it to a new database.
 */
export async function nextOrderCode(sql: Sql, provider: string): Promise<number> {
  const row = await one<{ last_order_code: string | number }>(
    sql,
    `insert into provider_sequences (provider, last_order_code, updated_at)
     values ($1, $2, now())
     on conflict (provider) do update
       set last_order_code = greatest(provider_sequences.last_order_code + 1, excluded.last_order_code),
           updated_at = now()
     returning last_order_code`,
    [provider, Date.now()],
  );
  const code = Number(row?.last_order_code ?? Date.now());
  if (!Number.isSafeInteger(code)) {
    throw err.validation(`Order code ${code} is outside the range the gateway accepts.`);
  }
  return code;
}

export async function enqueue(
  sql: Sql,
  channel: "inapp" | "email",
  template: string,
  userId: string | null,
  payload: unknown,
  dedupe: string,
) {
  await sql.query(
    `insert into outbox (channel, template, user_id, payload, dedupe_key, sent_at)
     values ($1,$2,$3,$4::jsonb,$5, now())
     on conflict (dedupe_key) do nothing`,
    [channel, template, userId, JSON.stringify(payload), dedupe],
  );
}

/**
 * Tell the payer their receipt exists, and where it is.
 *
 * Every route that takes money ends up here, which is the point: the till, a
 * member confirming a court, and reception reconciling a bank transfer hours
 * later all have to leave the same trace, because to the person who paid they
 * are the same event. Court bookings used to leave none at all — the invoice was
 * written and the member was told only that their booking was confirmed, so the
 * proof of payment existed but nobody was ever pointed at it.
 *
 * `invoice_id` and `amount_vnd` travel in the payload rather than being looked
 * up when the notification is read: the receipt is a record of what was paid at
 * the time, and a later refund or correction must not quietly restate it.
 *
 * Walk-ins have no account to notify, hence the null check.
 */
export async function enqueueReceipt(
  sql: Sql,
  userId: string | null,
  receipt: { payment_id: string; invoice_id: string; amount_vnd: number; method: string },
) {
  if (!userId) return;
  await enqueue(sql, "inapp", "payment_receipt", userId, receipt, `payment_receipt|${receipt.payment_id}`);
}

/**
 * Write an invoice and its single goods line for a payment just taken.
 *
 * Three routes take money — the till, a member confirming a court, and a
 * walk-in at the desk — and each used to write its own `insert into invoices`
 * with a different set of columns. That is how the seller block and the tax
 * split came to be filled in on one path and left null on the other two, and
 * how two of the three ended up with unaccented goods lines. One writer means
 * an invoice carries the same fields regardless of which door the money came
 * through.
 *
 * Counter prices are tax-inclusive, so `amountVnd` IS the payable total and the
 * net is derived from it. Flooring the net and taking VAT as the remainder
 * keeps `subtotal + vat = total` exact, which reconciliation checks.
 */
export async function issueInvoice(
  sql: Sql,
  args: {
    paymentId: string;
    buyerName: string;
    /** A walk-in's phone. Null for a member, whose account identifies them. */
    buyerPhone?: string | null;
    amountVnd: number;
    vatRate: number;
    description: string;
    unit: string;
    settings: Pick<Settings, "legal_name" | "tax_code" | "address">;
  },
): Promise<string> {
  const code = await nextCode(sql, "INV");
  const subtotal = Math.floor(args.amountVnd / (1 + args.vatRate / 100));
  const inv = await one<{ id: string }>(
    sql,
    `insert into invoices
       (code, payment_id, buyer_name, buyer_phone, form_no, serial_no,
        seller_legal_name, seller_tax_code, seller_address,
        subtotal_vnd, vat_rate, vat_vnd, total_vnd)
     values ($1,$2,$3,$12,'1',$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [
      code,
      args.paymentId,
      args.buyerName,
      `A3${new Date().getFullYear().toString().slice(2)}E`,
      args.settings.legal_name,
      args.settings.tax_code,
      args.settings.address,
      subtotal,
      args.vatRate,
      args.amountVnd - subtotal,
      args.amountVnd,
      args.buyerPhone ?? null,
    ],
  );
  await sql.query(
    `insert into invoice_lines (invoice_id, description, unit, qty, unit_vnd, amount_vnd)
     values ($1,$2,$3,1,$4,$4)`,
    [inv!.id, args.description, args.unit, args.amountVnd],
  );
  return inv!.id;
}

type InFlightIdem = {
  hash: string;
  promise: Promise<{ status: number; body: unknown }>;
};
const inFlightIdempotency = new Map<string, InFlightIdem>();

export async function withIdempotency(
  sql: Sql,
  request: Request,
  userId: string | null,
  required: boolean,
  handler: () => Promise<{ status: number; body: unknown }>,
): Promise<{ status: number; body: unknown; replay?: boolean }> {
  const key = request.headers.get("idempotency-key");
  if (required && !key) throw err.validation("Idempotency-Key is required.");
  if (!key) return handler();
  const uid = userId ?? "00000000-0000-0000-0000-000000000000";
  const raw = await request.clone().text();
  const hash = sha256(`${request.method}:${new URL(request.url).pathname}:${raw}`);

  const flightKey = `${uid}:${key}`;
  const existingFlight = inFlightIdempotency.get(flightKey);
  if (existingFlight) {
    if (existingFlight.hash !== hash) {
      throw err.validation("Idempotency-Key was already used for a different request.");
    }
    const res = await existingFlight.promise;
    return { status: res.status, body: res.body, replay: true };
  }

  const existing = await one<{
    request_hash: string;
    response_code: number;
    response_body: unknown;
    expires_at: string;
  }>(
    sql,
    `select request_hash, response_code, response_body, expires_at::text
       from idempotency_keys where user_id = $1 and key = $2`,
    [uid, key],
  );
  if (existing && new Date(existing.expires_at) > new Date()) {
    if (existing.request_hash !== hash) {
      throw err.validation("Idempotency-Key was already used for a different request.");
    }
    return { status: existing.response_code, body: existing.response_body, replay: true };
  }
  const promise = (async () => {
    const result = await handler();
    await sql.query(
      `insert into idempotency_keys
         (key, user_id, method, path, request_hash, response_code, response_body, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb, now() + interval '24 hours')
       on conflict (user_id, key) do update
         set response_code = excluded.response_code,
             response_body = excluded.response_body,
             request_hash = excluded.request_hash`,
      [
        key,
        uid,
        request.method,
        new URL(request.url).pathname,
        hash,
        result.status,
        JSON.stringify(result.body),
      ],
    );
    return result;
  })();

  inFlightIdempotency.set(flightKey, { hash, promise });
  try {
    return await promise;
  } finally {
    inFlightIdempotency.delete(flightKey);
  }
}

function assertNoNul(value: unknown): void {
  if (typeof value === "string") {
    if (value.includes("\u0000")) {
      throw err.validation("Text must not contain NUL characters.");
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      assertNoNul(item);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k.includes("\u0000")) {
        throw err.validation("Text must not contain NUL characters.");
      }
      assertNoNul(v);
    }
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) return {};
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw err.validation("Invalid JSON body.");
  }
  if (data === null || typeof data !== "object") {
    throw err.validation("Request body must be a JSON object.");
  }
  assertNoNul(data);
  return data as Record<string, unknown>;
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v.trim() : undefined;
}
export function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
export function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  return undefined;
}

export function ageYears(dob: string): number {
  const today = new Date();
  const d = new Date(dob + "T00:00:00+07:00");
  let age = today.getFullYear() - d.getFullYear();
  const m = today.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age -= 1;
  return age;
}

/** Active sub covering `sport`. Unlimited (session_left null) wins over quota. */
export async function classSubscription(
  sql: Sql,
  userId: string,
  sport: string,
): Promise<{ id: string; session_left: number | null } | undefined> {
  return one<{ id: string; session_left: number | null }>(
    sql,
    `select id, session_left from subscriptions
      where user_id = $1 and status = 'active'
        and end_on >= (now() at time zone 'Asia/Ho_Chi_Minh')::date
        and (sport_scope = $2 or sport_scope = 'all')
      order by (session_left is null) desc, (sport_scope = $2) desc
      limit 1`,
    [userId, sport],
  );
}

export type Ctx = { sql: Sql; request: Request; user: PublicUser | null };

/**
 * Shape a paged query's rows (selected with `count(*) over ()::int as total`) into
 * `{ items, total, limit, offset }`. Past the last page there are no rows to read the total
 * from, so `recount` answers instead; the client then steps back to the real last page.
 */
export async function pageOf<T extends { total: number }>(
  rows: T[],
  page: { limit: number; offset: number },
  recount: () => Promise<number>,
): Promise<{ items: Omit<T, "total">[]; total: number; limit: number; offset: number }> {
  const total = rows.length ? Number(rows[0]!.total) : page.offset > 0 ? await recount() : 0;
  return {
    items: rows.map(({ total: _t, ...r }) => r),
    total,
    limit: page.limit,
    offset: page.offset,
  };
}
