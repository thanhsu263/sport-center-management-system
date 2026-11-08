import type { Sql } from "@/lib/db";
import { err } from "./errors";
import { slotPriceOk } from "./rules";
import { ictMinutes, isWeekendIct, roundVnd } from "./time";

export type PriceRule = {
  id: string;
  sport: string;
  court_id: string | null;
  day_kind: string;
  start_local: string;
  end_local: string;
  price_vnd: number;
  is_peak: boolean;
  start_min: number;
  end_min: number;
};

export async function lookupPrice(
  sql: Sql,
  opts: { sport: string; courtId: string; start: Date },
): Promise<{ price_vnd: number; is_peak: boolean }> {
  const dayKind = isWeekendIct(opts.start) ? "weekend" : "weekday";
  const minutes = ictMinutes(opts.start);
  const rules = await sql.query<PriceRule>(
    `select id, sport, court_id, day_kind, start_local::text, end_local::text,
            price_vnd, is_peak, start_min, end_min
       from price_rules
      where sport = $1 and day_kind = $2
        and start_min <= $3 and end_min > $3
      order by (court_id is not null) desc`,
    [opts.sport, dayKind, minutes],
  );
  const courtRule = rules.find((r) => r.court_id === opts.courtId);
  const sportRule = rules.find((r) => r.court_id == null);
  const hit = courtRule ?? sportRule;
  // BR-37. No rule is not a free court, and a rule outside the bounds a
  // price can have is not a price — 0đ or 99,999,999đ both came from a table
  // somebody edited by hand. Refuse to quote either; callers look the price up
  // before `booking_replace_hold`, so the member's current hold survives.
  if (!hit || !slotPriceOk(hit.price_vnd)) {
    throw err.br("BR-37", "There is no price for that slot yet — ask the desk.", {
      sport: opts.sport,
      day_kind: dayKind,
    });
  }
  return { price_vnd: hit.price_vnd, is_peak: hit.is_peak };
}

export function applyDiscount(list: number, pct: number, round = 1000): number {
  return roundVnd(list * (1 - pct / 100), round);
}
