/**
 * Helpers for the scripted test pass described in docs/AGENT-TEST-INSTRUCTIONS.md.
 *
 * Every test script under test-output/api/ imports this file and nothing else
 * from the project. Each `check()` appends one line to
 * test-output/results/<suite>.jsonl and prints PASS/FAIL, so the final report
 * is built from those files rather than from anybody's memory of the run.
 *
 * Targets the isolated server from scripts/tests/start-safe-server.mjs
 * (port 8090) unless BASE says otherwise — and refuses to touch anything that
 * is not on this machine.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

export const BASE = (process.env.BASE ?? "http://127.0.0.1:8090").replace(/\/+$/, "");
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(BASE)) {
  console.error(`agent-lib: BASE must be a local http://127.0.0.1:<port> server, got ${BASE}. STOP.`);
  process.exit(2);
}

export const PASS = "ChangeMe!a3";

/** Seeded accounts (fresh in-memory DB). Plan states are relative to the day the server started. */
export const PHONES = {
  manager: "0900000001",
  receptionist: "0900000002",
  receptionist2: "0900000003",
  coach: "0901110011", // Nguyễn Minh Khoa, badminton
  coachLan: "0901110012", // Trần Thị Lan, badminton
  coachBasket: "0901110013", // Phạm Đức Anh, basketball
  coachVolley: "0901110014", // Lê Quốc Việt, volleyball
  memberNoPlan: "0901230107", // Bùi Gia Bảo — no plan
  memberNam: "0901230101", // Nguyễn Văn Nam — plan expired
  memberAllAccess: "0901230103", // Phạm Hoàng Long — All-access 90 days, active, 12 court hours
  memberBadmintonSessions: "0901230104", // Lê Thị Hạnh — Badminton 10 sessions, active
  memberBasketSessions: "0901230109", // Ngô Phương Anh — Basketball 8 sessions, active
  memberBadminton30: "0900000004", // Nguyễn Thanh Hà — Badminton 30 days, active
};

export const IDS = {
  hiddenTrialPlan: "20000000-0000-0000-0000-000000000008",
  planBadminton30: "20000000-0000-0000-0000-000000000002",
  planBadminton10Sessions: "20000000-0000-0000-0000-000000000003",
  planAllAccess30: "20000000-0000-0000-0000-000000000001",
  planAllAccess90: "20000000-0000-0000-0000-000000000006",
  planBasketball30: "20000000-0000-0000-0000-000000000004",
  planVolleyball30: "20000000-0000-0000-0000-000000000005",
  planBasketball8Sessions: "20000000-0000-0000-0000-000000000007",
  courtCL01: "10000000-0000-0000-0000-000000000001",
  courtCL02: "10000000-0000-0000-0000-000000000002",
  courtCL03: "10000000-0000-0000-0000-000000000003",
  courtCL04: "10000000-0000-0000-0000-000000000004",
  courtCL05: "10000000-0000-0000-0000-000000000005",
  courtBR01: "10000000-0000-0000-0000-000000000010",
  courtBC01: "10000000-0000-0000-0000-000000000011",
  nonexistent: "99999999-9999-4999-8999-999999999999",
};

const SUITE = process.env.SUITE ?? basename(process.argv[1] ?? "adhoc").replace(/\.m?js$/, "");
mkdirSync("test-output/results", { recursive: true });
const RESULTS_FILE = `test-output/results/${SUITE}.jsonl`;
writeFileSync(RESULTS_FILE, "");
const tally = { PASS: 0, FAIL: 0, WARN: 0, BLOCKED: 0 };

/**
 * One HTTP call to /v1. Never throws on an HTTP error status — it returns it.
 * `idem: true` adds a fresh Idempotency-Key; `idemKey: "x"` sends that exact key.
 */
export async function api(path, { method = "GET", token, body, idem, idemKey, headers = {}, rawBody } = {}) {
  const h = { accept: "application/json", ...headers };
  if (body !== undefined || rawBody !== undefined) h["content-type"] ??= "application/json";
  if (token) h.authorization = `Bearer ${token}`;
  if (idemKey) h["idempotency-key"] = idemKey;
  else if (idem) h["idempotency-key"] = crypto.randomUUID();
  const started = Date.now();
  let res;
  try {
    res = await fetch(`${BASE}/v1${path}`, {
      method,
      headers: h,
      body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { status: 0, data: { network_error: String(e) }, ms: Date.now() - started, headers: {}, request: { method, path } };
  }
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON (PDF, XML, CSV, HTML): keep the text.
  }
  return {
    status: res.status,
    data,
    ms: Date.now() - started,
    headers: Object.fromEntries(res.headers.entries()),
    request: { method, path, body: rawBody !== undefined ? String(rawBody).slice(0, 300) : body, as: token ? "token" : "anonymous" },
  };
}

/** Sign in and return { token, user }. Throws when it fails — a broken login blocks the suite. */
export async function login(phone, password = PASS) {
  const r = await api("/auth/login", { method: "POST", body: { login: phone, password } });
  if (r.status !== 200 || !r.data?.token) {
    throw new Error(`login ${phone} failed: ${r.status} ${JSON.stringify(r.data)}`);
  }
  return r.data;
}

/** Sign in every role used by the suites. */
export async function loginAll() {
  const out = {};
  for (const [k, phone] of Object.entries(PHONES)) out[k] = await login(phone);
  return out;
}

/** "YYYY-MM-DD" in Vietnam time, `daysAhead` days from today. */
export function ictDate(daysAhead = 0) {
  const d = new Date(Date.now() + 7 * 3600_000 + daysAhead * 86400_000);
  return d.toISOString().slice(0, 10);
}

/** ISO start time `daysAhead` days from today at hh:mm Vietnam time, e.g. "2026-10-14T10:00:00+07:00". */
export function slot(daysAhead, hour, minute = 0) {
  return `${ictDate(daysAhead)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+07:00`;
}

/** Current hour in Vietnam time (0–23). */
export function ictHour() {
  return new Date(Date.now() + 7 * 3600_000).getUTCHours();
}

/** Day of week in Vietnam time for `daysAhead` (0 = Sunday … 6 = Saturday). */
export function ictWeekday(daysAhead = 0) {
  return new Date(Date.now() + 7 * 3600_000 + daysAhead * 86400_000).getUTCDay();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "YYYY-MM-DD" in Vietnam time of an ISO timestamp. */
export function ictDateOf(iso) {
  return new Date(Date.parse(iso) + 7 * 3600_000).toISOString().slice(0, 10);
}

/** True when hh:00 on that day is a peak hour in the seeded price rules (weekday 17–22, weekend 08–22). */
export function isPeak(daysAhead, hour) {
  const wd = ictWeekday(daysAhead);
  const weekend = wd === 0 || wd === 6;
  return weekend ? hour >= 8 : hour >= 17;
}

/**
 * Find a free one-hour slot by reading GET /v1/occupancy (needs a staff token).
 *
 *   const s = await freeSlot(mgr.token, { daysAhead: 3, sport: "badminton", peak: false });
 *   // → { court_id, court_code, start_at } or null when the whole day is full
 *
 * Options:
 *   daysAhead   day to look at (0 = today)
 *   sport       "badminton" | "basketball" | "volleyball"
 *   peak        true = only peak hours, false = only off-peak, undefined = any
 *   hours       explicit list of start hours to try, e.g. [10, 11]
 *   minAheadH / maxAheadH   only slots starting that many hours from now
 *   notCourt    court id to skip (to move a booking to a DIFFERENT court)
 *   court       only this court id
 *   member      a member's token: return null for a day on which that member
 *               already has 2 confirmed bookings (max_slots_per_day — BR-05
 *               would hide the rule you are trying to test)
 *
 * Every slot it returns is remembered, so two calls in one run never return
 * the same slot even before the first one is booked.
 */
const handedOut = new Set();
export async function freeSlot(staffToken, opts = {}) {
  const { daysAhead = 2, sport = "badminton", peak, hours, minAheadH = 0.5, maxAheadH, notCourt, court, member } = opts;
  if (member) {
    const mine = await api("/me/bookings", { token: member });
    const sameDay = (mine.data?.items ?? []).filter(
      (b) => ["confirmed", "in_use"].includes(b.status) && ictDateOf(b.start_at) === ictDate(daysAhead),
    );
    if (sameDay.length >= 2) return null;
  }
  const r = await api(`/occupancy?date=${ictDate(daysAhead)}`, { token: staffToken });
  if (r.status !== 200) throw new Error(`freeSlot: GET /occupancy → ${r.status} ${JSON.stringify(r.data)}`);
  const courts = r.data.courts.filter(
    (c) =>
      c.sport === sport &&
      c.status === "ready" &&
      !c.id.startsWith("00000000") &&
      c.id !== notCourt &&
      (!court || c.id === court),
  );
  const busy = r.data.slots.map((s) => ({ c: s.court_id, s: Date.parse(s.start), e: Date.parse(s.end) }));
  const tryHours = hours ?? [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
  for (const h of tryHours) {
    if (peak !== undefined && isPeak(daysAhead, h) !== peak) continue;
    const start_at = slot(daysAhead, h);
    const s = Date.parse(start_at);
    const aheadH = (s - Date.now()) / 3600_000;
    if (aheadH < minAheadH) continue;
    if (maxAheadH !== undefined && aheadH > maxAheadH) continue;
    for (const c of courts) {
      const key = `${c.id}|${start_at}`;
      if (handedOut.has(key)) continue;
      if (busy.some((b) => b.c === c.id && b.s < s + 3600_000 && b.e > s)) continue;
      handedOut.add(key);
      return { court_id: c.id, court_code: c.court_code, start_at, hour: h, daysAhead };
    }
  }
  return null;
}

/** First free slot over the next `maxDays` days that matches `opts` (see freeSlot). */
export async function freeSlotAnyDay(staffToken, opts = {}, { fromDay = 1, maxDays = 6 } = {}) {
  for (let d = fromDay; d <= maxDays; d++) {
    const s = await freeSlot(staffToken, { ...opts, daysAhead: d });
    if (s) return s;
  }
  return null;
}

/** A phone number nobody in the seed uses (097xxxxxxx), for accounts a test creates. */
export function freshPhone() {
  return `097${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
}

/**
 * Register a brand-new member through the real OTP flow (needs OTP_ECHO=1, which
 * start-safe-server.mjs sets) and return { token, user, phone, password }.
 */
export async function newMember(extra = {}) {
  const phone = freshPhone();
  const password = "Test1234a";
  const reg = await api("/auth/register", {
    method: "POST",
    body: { full_name: `Test Member ${phone.slice(-4)}`, phone, password, pii_consent: true, ...extra },
  });
  if (reg.status !== 202 || !reg.data?.otp) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.data)}`);
  const ok = await api("/auth/otp/verify", { method: "POST", body: { phone, otp: reg.data.otp } });
  if (ok.status === 409 && ok.data?.constraint === "users_member_code_key") {
    // Known finding F-04: the member-code counter has reached A3-2026-0099, a code
    // the seed hard-codes, and is stuck there. Nothing in this run can fix it.
    throw new Error(
      "KNOWN BUG F-04: new sign-ups are blocked (member code A3-2026-0099 collides with the seed). " +
        "Restart the safe server (fresh database) and run this suite again. Do NOT report this as a new bug.",
    );
  }
  if (ok.status !== 200 || !ok.data?.token) throw new Error(`otp verify failed: ${ok.status} ${JSON.stringify(ok.data)}`);
  return { ...ok.data, phone, password };
}

/**
 * A brand-new member with an ACTIVE plan: the manager raises the plan order and
 * takes the full payment in cash (managers need no till shift).
 * Returns the member (as newMember) plus `subscription`.
 *
 * Use this instead of the seeded plan members (Long, Hạnh…): the seed gives them
 * 2+ bookings on every day of the week, so every hold they try is refused with
 * BR-05 before the rule under test is even looked at.
 */
export async function memberWithPlan(managerToken, planId) {
  const m = await newMember();
  const sub = await api("/subscriptions", { method: "POST", token: managerToken, body: { plan_id: planId, user_id: m.user.id } });
  if (sub.status !== 201) throw new Error(`memberWithPlan: POST /subscriptions → ${sub.status} ${JSON.stringify(sub.data)}`);
  const pay = await api("/payments", {
    method: "POST",
    token: managerToken,
    idem: true,
    body: { ref_type: "subscription", ref_id: sub.data.subscription.id, method: "cash", amount_vnd: sub.data.amount_due_vnd },
  });
  if (pay.status !== 201) throw new Error(`memberWithPlan: POST /payments → ${pay.status} ${JSON.stringify(pay.data)}`);
  const me = await api("/me", { token: m.token });
  const active = me.data?.subscriptions?.find((s) => s.id === sub.data.subscription.id);
  if (active?.status !== "active") throw new Error(`memberWithPlan: plan did not activate: ${JSON.stringify(active)}`);
  return { ...m, subscription: active };
}

function trim(data) {
  const s = typeof data === "string" ? data : JSON.stringify(data);
  return s && s.length > 1500 ? `${s.slice(0, 1500)}…(truncated)` : s;
}

/**
 * Record one test case.
 *
 *   check("BK-03", "hold in the past is refused", res, { status: 422, code: "BR_VIOLATION", br: "BR-07" })
 *
 * `exp.status` may be a number or an array of allowed numbers. `exp.test` is an
 * optional extra predicate `(res) => boolean` for anything else that must hold.
 * `exp.advisory: true` turns a failure into WARN: a hardening recommendation,
 * not a broken requirement.
 * Returns true on PASS so a script can decide whether a dependent step can run.
 */
export function check(id, title, res, exp = {}) {
  const problems = [];
  if (exp.status !== undefined) {
    const ok = Array.isArray(exp.status) ? exp.status.includes(res.status) : res.status === exp.status;
    if (!ok) problems.push(`status ${res.status} ≠ expected ${JSON.stringify(exp.status)}`);
  }
  if (exp.notStatus !== undefined) {
    const bad = Array.isArray(exp.notStatus) ? exp.notStatus : [exp.notStatus];
    if (bad.includes(res.status)) problems.push(`status ${res.status} is one of the forbidden ${JSON.stringify(bad)}`);
  }
  if (exp.code !== undefined && res.data?.code !== exp.code) {
    problems.push(`code ${JSON.stringify(res.data?.code)} ≠ expected ${exp.code}`);
  }
  if (exp.br !== undefined && res.data?.br !== exp.br) {
    problems.push(`br ${JSON.stringify(res.data?.br)} ≠ expected ${exp.br}`);
  }
  if (exp.test) {
    let ok = false;
    try {
      ok = Boolean(exp.test(res));
    } catch (e) {
      problems.push(`test threw: ${e?.message ?? e}`);
    }
    if (!ok) problems.push(`extra condition failed: ${exp.why ?? exp.test.toString().slice(0, 160)}`);
  }
  const result = !problems.length ? "PASS" : exp.advisory ? "WARN" : "FAIL";
  tally[result] += 1;
  const line = {
    suite: SUITE,
    id,
    title,
    result,
    problems,
    expected: { ...exp, test: exp.test ? exp.why ?? "custom" : undefined },
    request: res.request,
    actual: { status: res.status, ms: res.ms, body: trim(res.data) },
    at: new Date().toISOString(),
  };
  appendFileSync(RESULTS_FILE, `${JSON.stringify(line)}\n`);
  console.log(`${result}  ${id}  ${title}${problems.length ? `  ← ${problems.join("; ")}` : ""}`);
  return result === "PASS";
}

/** A case that could not be run (missing precondition). Say why. */
export function blocked(id, title, reason) {
  tally.BLOCKED += 1;
  appendFileSync(
    RESULTS_FILE,
    `${JSON.stringify({ suite: SUITE, id, title, result: "BLOCKED", problems: [reason], at: new Date().toISOString() })}\n`,
  );
  console.log(`BLOCKED  ${id}  ${title}  ← ${reason}`);
}

/** Print and save the totals. Call once at the end of every script. */
export function summary() {
  const line = `${SUITE}: PASS ${tally.PASS} · FAIL ${tally.FAIL} · WARN ${tally.WARN} · BLOCKED ${tally.BLOCKED}`;
  console.log(`\n=== ${line} ===`);
  appendFileSync("test-output/results/_summary.txt", `${new Date().toISOString()}  ${line}\n`);
}
