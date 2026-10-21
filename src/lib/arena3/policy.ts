import { err } from "./errors";
import { addDays, ictDateTime, ictWeekday, roundVnd } from "./time";

/**
 * Money and calendar rules for deposits, late cancellation and fixed weekly
 * bookings. Pure functions on purpose: the handlers read the database, these
 * only decide, so the rules can be tested without one.
 */

export type CancelTier = { hours: number; refund_pct: number };

/** What most Vietnamese venues publish: 24h+ free, 4–24h half, under 4h nothing. */
export const DEFAULT_CANCEL_TIERS: CancelTier[] = [
  { hours: 24, refund_pct: 100 },
  { hours: 4, refund_pct: 50 },
  { hours: 0, refund_pct: 0 },
];

/**
 * Check the tiers a manager typed. They must start from the longest notice and
 * only ever refund less as the notice gets shorter, and the last tier must be
 * "0 hours" so that every cancellation lands somewhere.
 */
export function parseCancelTiers(v: unknown): CancelTier[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 6) {
    throw err.field("cancel_tiers", "Add between 1 and 6 cancellation steps.");
  }
  const tiers = v.map((raw) => {
    const r = raw as { hours?: unknown; refund_pct?: unknown };
    const hours = Number(r.hours);
    const pct = Number(r.refund_pct);
    if (!Number.isInteger(hours) || hours < 0 || hours > 720) {
      throw err.field("cancel_tiers", "Hours must be a whole number from 0 to 720.");
    }
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
      throw err.field("cancel_tiers", "A refund must be a whole percentage from 0 to 100.");
    }
    return { hours, refund_pct: pct };
  });
  tiers.sort((a, b) => b.hours - a.hours);
  for (let i = 1; i < tiers.length; i += 1) {
    if (tiers[i]!.hours === tiers[i - 1]!.hours) {
      throw err.field("cancel_tiers", "Two steps cannot start at the same number of hours.");
    }
    if (tiers[i]!.refund_pct > tiers[i - 1]!.refund_pct) {
      throw err.field("cancel_tiers", "A later cancellation cannot be refunded more than an earlier one.");
    }
  }
  if (tiers[tiers.length - 1]!.hours !== 0) {
    throw err.field("cancel_tiers", "The last step must start at 0 hours, so every cancellation is covered.");
  }
  return tiers;
}

/** The refund percentage a cancellation `hoursLeft` before the start earns. */
export function refundPctFor(tiers: CancelTier[], hoursLeft: number): number {
  const sorted = [...tiers].sort((a, b) => b.hours - a.hours);
  for (const t of sorted) if (hoursLeft >= t.hours) return t.refund_pct;
  return sorted[sorted.length - 1]?.refund_pct ?? 0;
}

export type CancelQuote = {
  hours_left: number;
  refund_pct: number;
  paid_vnd: number;
  refund_vnd: number;
  fee_vnd: number;
  /** The centre cancelled, or an emergency: the customer loses nothing. */
  waived: boolean;
};

export function quoteCancel(args: {
  tiers: CancelTier[];
  startAt: string | Date;
  paidVnd: number;
  now?: number;
  waived?: boolean;
}): CancelQuote {
  const hoursLeft = (new Date(args.startAt).getTime() - (args.now ?? Date.now())) / 3_600_000;
  const pct = args.waived ? 100 : refundPctFor(args.tiers, hoursLeft);
  const refund = Math.min(args.paidVnd, Math.round((args.paidVnd * pct) / 100));
  return {
    hours_left: Math.round(hoursLeft * 10) / 10,
    refund_pct: pct,
    paid_vnd: args.paidVnd,
    refund_vnd: refund,
    fee_vnd: args.paidVnd - refund,
    waived: !!args.waived,
  };
}

/**
 * How much of a booking has to be paid to confirm it.
 *
 * 0 means "the whole price" — a booking with no deposit rule is paid in full,
 * exactly as before. A deposit never exceeds the price and is rounded to the
 * centre's rounding step so a bank transfer is a figure a person can type.
 */
export function depositFor(args: {
  priceVnd: number;
  pct: number;
  peakOnly: boolean;
  isPeak: boolean;
  round: number;
}): number {
  if (args.pct <= 0 || args.priceVnd <= 0) return 0;
  if (args.peakOnly && !args.isPeak) return 0;
  const d = Math.min(args.priceVnd, roundVnd((args.priceVnd * args.pct) / 100, args.round));
  return d >= args.priceVnd ? 0 : d;
}

/** What to collect now for a held booking. */
export function dueNow(b: { price_vnd: number; deposit_vnd?: number | null }): number {
  const d = Number(b.deposit_vnd ?? 0);
  return d > 0 && d < b.price_vnd ? d : b.price_vnd;
}

/**
 * The calendar days of a fixed weekly booking, as `YYYY-MM-DD` in the centre's
 * time zone. `firstDate` is the first session; the rest follow every 7 days.
 */
export function seriesDates(firstDate: string, weeks: number): string[] {
  return Array.from({ length: weeks }, (_, i) => addDays(firstDate, i * 7));
}

export function seriesWeekday(firstDate: string, startLocal: string): number {
  return ictWeekday(ictDateTime(firstDate, startLocal));
}
