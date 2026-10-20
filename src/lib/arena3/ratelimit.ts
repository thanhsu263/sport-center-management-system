import { err } from "./errors";

/**
 * A small in-process sliding-window limiter for endpoints that are cheap to
 * call and expensive to honour — plan requests, password changes, the
 * assistant.
 *
 * Deliberately in-memory: the limits here exist to stop one impatient member
 * double-tapping a button into twenty rows, not to defend against a botnet. A
 * shared store would mean a round trip to Postgres on the happy path of every
 * request, which is the opposite of what this codebase needs. On a serverless
 * platform each instance keeps its own counters, so a burst spread across
 * lambdas gets a slightly higher effective ceiling — still far below the
 * damage a tight client loop can do, which is the case we actually hit.
 */

type Hit = { at: number };

const buckets = new Map<string, Hit[]>();
/** Housekeeping: drop keys we have not seen in a while so the map cannot grow forever. */
let lastSweep = 0;

function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, hits] of buckets) {
    // An hour past the longest window any caller uses.
    if (hits.length === 0 || now - hits[hits.length - 1]!.at > 3_600_000) buckets.delete(key);
  }
}

export type LimitRule = {
  /** How many calls are allowed inside the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

export const RULES = {
  /** Buying or renewing a plan. One a minute is generous for a real purchase. */
  planRequest: { limit: 3, windowMs: 60_000 },
  /** Cumulative guard so a member cannot queue twenty pending requests over an hour. */
  planRequestHourly: { limit: 10, windowMs: 3_600_000 },
  /** Assistant turns — each one costs a model call. */
  assistant: { limit: 20, windowMs: 60_000 },
  /** Password changes. */
  passwordChange: { limit: 5, windowMs: 900_000 },
  /** Profile edits. */
  profileUpdate: { limit: 10, windowMs: 300_000 },
  /** Manager media asset uploads. */
  assetUpload: { limit: 60, windowMs: 60_000 },
  /** Manager sport mutations. */
  sportMutation: { limit: 60, windowMs: 60_000 },
} satisfies Record<string, LimitRule>;

/**
 * Record a call against `key`. Returns the seconds the caller must wait when
 * the window is full, or `0` when the call is allowed.
 */
export function take(key: string, rule: LimitRule, now = Date.now()): number {
  sweep(now);
  const cutoff = now - rule.windowMs;
  const hits = (buckets.get(key) ?? []).filter((h) => h.at > cutoff);
  if (hits.length >= rule.limit) {
    buckets.set(key, hits);
    const oldest = hits[0]!.at;
    return Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000));
  }
  hits.push({ at: now });
  buckets.set(key, hits);
  return 0;
}

/** `take`, but throws the 429 for you. */
export function limit(key: string, rule: LimitRule, what = "requests"): void {
  const retry = take(key, rule);
  if (retry === 0) return;
  const wait = retry >= 60 ? `${Math.ceil(retry / 60)} minute${retry >= 120 ? "s" : ""}` : `${retry} seconds`;
  throw err.rateLimited(`Too many ${what} — try again in ${wait}.`);
}

/** Forget a key, e.g. once the action it guarded succeeded in a way that should reset it. */
export function reset(key: string): void {
  buckets.delete(key);
}

/** Test seam. */
export function clearAll(): void {
  buckets.clear();
  lastSweep = 0;
}
