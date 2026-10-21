import type { Sql } from "@/lib/db";
import { err } from "./errors";
import { slotPriceOk } from "./rules";
import { ictMinutes, isWeekendIct, roundVnd } from "./time";
import { one } from "./tx";

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

export async function memberDiscount(
  sql: Sql,
  userId: string | null,
  sport: string,
): Promise<{ pct: number; court_hours_left: number; sub_id: string | null }> {
  if (!userId) return { pct: 0, court_hours_left: 0, sub_id: null };
  const sub = await one<{
    id: string;
    court_discount_pct: number;
    court_hours_left: string | number;
    sport_scope: string;
  }>(
    sql,
    `select s.id, p.court_discount_pct, s.court_hours_left, s.sport_scope
       from subscriptions s
       join membership_plans p on p.id = s.plan_id
      where s.user_id = $1 and s.status = 'active'
        -- BR-12: a plan bought today for next month gives nothing until then.
        and s.start_on <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
        and s.end_on >= (now() at time zone 'Asia/Ho_Chi_Minh')::date
        and (s.sport_scope = $2 or s.sport_scope = 'all')
      -- One plan, never a sum: the sport's own plan beats all-access even
      -- when all-access has the bigger percentage, then the plan ending last.
      order by (s.sport_scope = $2) desc, s.end_on desc
      limit 1`,
    [userId, sport],
  );
  if (!sub) return { pct: 0, court_hours_left: 0, sub_id: null };
  return {
    pct: Number(sub.court_discount_pct) || 0,
    court_hours_left: Number(sub.court_hours_left) || 0,
    sub_id: sub.id,
  };
}

export function applyDiscount(list: number, pct: number, round = 1000): number {
  return roundVnd(list * (1 - pct / 100), round);
}
