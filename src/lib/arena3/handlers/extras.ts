import type { Sql } from "@/lib/db";
import { err } from "../errors";
import { str } from "../helpers";
import type { PublicUser } from "../session";
import { one } from "../tx";

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

