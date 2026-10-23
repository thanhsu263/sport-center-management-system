/**
 * Business-rule checks that need no database.
 *
 * Kept free of imports so `arena3.test.ts` can load this file directly under
 * `node --experimental-strip-types`, the same way it loads `time.ts`.
 */

/**
 * Ceiling for one 60-minute slot, in VND.
 *
 * The dearest real rule is basketball peak at 500,000đ. The ceiling sits ten
 * times above that so a genuine price rise never trips it, and far enough
 * below 99,999,999đ that a typo — or somebody leaning on the demo manager
 * login — cannot quote an 80-million-dong badminton court again.
 */
export const MAX_SLOT_PRICE_VND = 5_000_000;

export const DAY_KINDS = ["weekday", "weekend", "holiday"] as const;

/** A slot price the centre could actually charge: whole đồng, above 0, at most the ceiling. */
export function slotPriceOk(price: unknown): price is number {
  return typeof price === "number" && Number.isInteger(price) && price > 0 && price <= MAX_SLOT_PRICE_VND;
}

/** BR-17 — a plan discount is a whole percentage in [0, 100]. */
export function discountPctOk(pct: unknown): pct is number {
  return typeof pct === "number" && Number.isInteger(pct) && pct >= 0 && pct <= 100;
}

/** BR-12 — a plan grants benefits only while start_on ≤ today ≤ end_on (all YYYY-MM-DD). */
export function planActiveOn(startOn: string, endOn: string, today: string): boolean {
  return startOn <= today && today <= endOn;
}

export type PriceRuleInput = {
  sport: string;
  court_id: string | null;
  day_kind: string;
  start_local: string;
  end_local: string;
  price_vnd: number;
  is_peak: boolean;
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)(:00)?$/;

function minutesOf(hm: string): number {
  return Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Check a full price table before it replaces the old one.
 *
 * `PUT /v1/price-rules` deletes every rule and inserts the new set, so a bad
 * row must be caught before the delete, not by a constraint halfway through.
 * Two rules covering the same minute for the same sport, court and day kind are
 * refused too: `lookupPrice` would pick one of them silently.
 */
export function validatePriceRules(
  items: unknown[],
  validSports?: readonly string[],
): { ok: true; rules: PriceRuleInput[] } | { ok: false; index: number; message: string } {
  if (!items.length) return { ok: false, index: -1, message: "At least one price rule is required." };
  const rules: PriceRuleInput[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const it = (items[i] ?? {}) as Record<string, unknown>;
    const sport = text(it.sport);
    const day_kind = text(it.day_kind);
    const start_local = text(it.start_local);
    const end_local = text(it.end_local);
    const price = typeof it.price_vnd === "string" ? Number(it.price_vnd) : it.price_vnd;
    if (!sport || (validSports ? !validSports.includes(sport) : !/^[a-z0-9_-]+$/.test(sport))) {
      return { ok: false, index: i, message: `Row ${i + 1}: unknown sport.` };
    }
    if (!day_kind || !(DAY_KINDS as readonly string[]).includes(day_kind)) {
      return { ok: false, index: i, message: `Row ${i + 1}: day kind must be weekday, weekend or holiday.` };
    }
    if (!start_local || !end_local || !HHMM.test(start_local) || !HHMM.test(end_local)) {
      return { ok: false, index: i, message: `Row ${i + 1}: times must be HH:MM.` };
    }
    if (minutesOf(end_local) <= minutesOf(start_local)) {
      return { ok: false, index: i, message: `Row ${i + 1}: the end time must be after the start time.` };
    }
    if (!slotPriceOk(price)) {
      return {
        ok: false,
        index: i,
        message: `Row ${i + 1}: price must be a whole amount above 0đ and at most ${MAX_SLOT_PRICE_VND.toLocaleString("en-US")}đ per slot.`,
      };
    }
    rules.push({
      sport,
      court_id: text(it.court_id),
      day_kind,
      start_local: start_local.slice(0, 5),
      end_local: end_local.slice(0, 5),
      price_vnd: price,
      is_peak: it.is_peak === true || it.is_peak === "true",
    });
  }
  for (let i = 0; i < rules.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const a = rules[i];
      const b = rules[j];
      if (a.sport !== b.sport || a.day_kind !== b.day_kind || a.court_id !== b.court_id) continue;
      if (minutesOf(a.start_local) < minutesOf(b.end_local) && minutesOf(b.start_local) < minutesOf(a.end_local)) {
        return { ok: false, index: i, message: `Row ${i + 1} overlaps row ${j + 1} for the same sport and day.` };
      }
    }
  }
  return { ok: true, rules };
}

// F4 training (Phase 4C)

export const ATT_RESULTS = ["present", "late", "absent", "excused"] as const;
export type AttResult = (typeof ATT_RESULTS)[number];

export function isAttResult(v: unknown): v is AttResult {
  return typeof v === "string" && (ATT_RESULTS as readonly string[]).includes(v);
}

/** BR-35: a coach may correct a session's register for this long after it ends. */
export const ATTENDANCE_LOCK_HOURS = 2;

/**
 * Whether the register for a session is closed to the coach.
 *
 * The job flips a session to `done` once the window is over, but it runs on a
 * timer: between the end of the window and the next tick the status still says
 * `scheduled`. Going by the clock as well means the lock does not depend on a
 * job having woken up.
 */
export function attendanceLocked(endAtMs: number, nowMs: number, status: string): boolean {
  if (status === "done") return true;
  return nowMs > endAtMs + ATTENDANCE_LOCK_HOURS * 3_600_000;
}

/** BR-36: this many absences in a row raises an alert (it never drops the student). */
export const ABSENT_STREAK_LIMIT = 3;

/**
 * How many `absent` marks end the list, counted from the most recent.
 *
 * `results` is oldest to newest and holds only sessions that were actually
 * marked. Anything other than `absent` ends the run — an excused absence is one
 * the member told the centre about, so it is not the pattern BR-36 looks for.
 */
export function absentStreak(results: readonly string[]): number {
  let n = 0;
  for (let i = results.length - 1; i >= 0 && results[i] === "absent"; i -= 1) n += 1;
  return n;
}

export const TRAINING_GOALS = ["weight", "technique", "compete", "fun"] as const;
export const LEVELS = ["beginner", "intermediate", "advanced"] as const;
export const PLAN_PHASES = ["warm-up", "technique", "fitness", "match", "cool-down"] as const;

/** The numbers a coach can log for a student in one session (FR-TRN-05). */
export const METRIC_KEYS = ["smash_count", "freethrow_pct", "serve_pct"] as const;

export type MetricsCheck =
  | { ok: true; metrics: Record<string, number> }
  | { ok: false; field: string; message: string };

export function validateMetrics(raw: unknown): MetricsCheck {
  if (raw === undefined || raw === null) return { ok: true, metrics: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, field: "metrics", message: "Metrics must be an object." };
  }
  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || value === "") continue;
    if (!(METRIC_KEYS as readonly string[]).includes(key)) {
      return { ok: false, field: "metrics", message: `"${key}" is not a metric we record.` };
    }
    const n = typeof value === "string" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) {
      return { ok: false, field: key, message: "Use a whole number." };
    }
    const max = key === "smash_count" ? 1000 : 100;
    if (n < 0 || n > max) return { ok: false, field: key, message: `Must be between 0 and ${max}.` };
    metrics[key] = n;
  }
  return { ok: true, metrics };
}

export const MAX_CHECKLIST_ITEMS = 20;

/** Homework checklist items: trimmed, non-empty, bounded. `null` when the shape is wrong. */
export function normalizeChecklist(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const it of raw) {
    if (typeof it !== "string") return null;
    const t = it.trim();
    if (!t) continue;
    if (t.length > 120) return null;
    out.push(t);
  }
  return out.length > MAX_CHECKLIST_ITEMS ? null : out;
}

/** Done-items are stored as the indexes of ticked checklist rows; anything out of range is dropped. */
export function normalizeDone(total: number, raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const set = new Set<number>();
  for (const v of raw) {
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < total) set.add(v);
  }
  return [...set].sort((a, b) => a - b);
}

/** A checklist is finished when every row is ticked; one with no rows is finished by an explicit "done". */
export function homeworkComplete(total: number, done: readonly number[], explicitDone: boolean): boolean {
  return total === 0 ? explicitDone : done.length >= total;
}

// ---- promotions (FR-PAY-03, BR-42) ---------------------------------------------

/** What a code takes off an order, never leaving less than this to pay. */
export const MIN_PAYABLE_VND = 1000;

export function normalizeCode(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toUpperCase().replace(/\s+/g, "") : "";
}

/**
 * The discount in whole đồng. A percentage is worked out once on the order total
 * and rounded once to the nearest 1,000đ (BR-42); a fixed amount is already a
 * multiple of 1,000. Capped by `max_discount_vnd`, and never so large that the
 * order drops under {@link MIN_PAYABLE_VND}.
 */
export function computeDiscount(
  promo: { kind: "percent" | "amount"; value: number; max_discount_vnd: number | null },
  orderVnd: number,
  round = 1000,
): number {
  let d =
    promo.kind === "percent" ? Math.round((orderVnd * promo.value) / 100 / round) * round : promo.value;
  if (promo.max_discount_vnd != null) d = Math.min(d, promo.max_discount_vnd);
  d = Math.min(d, Math.max(0, orderVnd - MIN_PAYABLE_VND));
  // Stay on the 1,000đ grid whichever cap bit (BR-42: rounded once).
  return Math.max(0, Math.floor(d / round) * round);
}
