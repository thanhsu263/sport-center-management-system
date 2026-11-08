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
  /** Assistant turns — each one costs a model call (FR-A03). */
  assistant: { limit: 20, windowMs: 60_000 },
  /**
   * Opening a support request, from the form or from the assistant.
   *
   * Reception reads these by hand, so the real ceiling is how many a person can
   * be answered — not how many a browser can post. Matches `planRequest`: three
   * in a minute covers a double-tap and a correction, and no more.
   */
  ticketCreate: { limit: 3, windowMs: 60_000 },
  /** Cumulative guard so one member cannot bury the desk queue over an hour. */
  ticketCreateHourly: { limit: 10, windowMs: 3_600_000 },
  /** Chat messages — generous, because a real conversation is bursty. */
  chatMessage: { limit: 25, windowMs: 10_000 },
  /**
   * WebRTC signaling: polls, offers, answers and ICE candidates.
   *
   * Sized from the client's own loop, not from the small numbers above: while a
   * pair is still connecting `p2p.ts` polls every 400ms (~150/minute), and each
   * poll can be followed by signal posts. 400 a minute leaves room for a busy
   * negotiation and still stops a tight loop, which matters because every poll
   * writes a heartbeat row and runs two deletes.
   */
  rtcSignal: { limit: 400, windowMs: 60_000 },
  /**
   * The relay as a whole, per person rather than per room.
   *
   * `rtcSignal` is charged once the room is known, which means a request that
   * is rejected for a missing or malformed room never reaches it. This one is
   * charged first, before anything is parsed, so a loop posting junk still
   * costs its caller something. Wide on purpose: somebody with several
   * conversations open is legitimately doing several rooms' worth of polling,
   * and this is here to stop a loop, not to shape normal use.
   */
  rtcEndpoint: { limit: 2000, windowMs: 60_000 },
  /** Password changes. */
  passwordChange: { limit: 5, windowMs: 900_000 },
  /** Profile edits. */
  profileUpdate: { limit: 10, windowMs: 300_000 },
  /** Manager media asset uploads. */
  assetUpload: { limit: 60, windowMs: 60_000 },
  /** A member changing their own profile photo. */
  avatarUpload: { limit: 10, windowMs: 600_000 },
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
