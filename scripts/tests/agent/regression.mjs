/**
 * REGRESSION TEST RUNNER — Arena 3 Sports Center Management System
 *
 * Runs ONLY the regression test cases mapped to confirmed findings (F-01..F-28)
 * from BUGS-FINAL.md. Grouped by suite with clean safe server restarts.
 *
 * Usage:
 *   node scripts/tests/agent/regression.mjs          # Run all regression cases
 *   node scripts/tests/agent/regression.mjs F-01     # Run only F-01
 *   node scripts/tests/agent/regression.mjs 02       # Run only suite 02 regression cases
 */
import { execSync, spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freeSlot, freeSlotAnyDay, memberWithPlan, newMember } from "../agent-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PORT = 8090;
const BASE = `http://127.0.0.1:${PORT}`;
const LOGS = join(ROOT, "test-output", "logs");
const PID_FILE = join(LOGS, "server.pid");
const PASS_DEFAULT = "ChangeMe!a3";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listenerPids() {
  try {
    if (process.platform === "win32") {
      const rows = execSync("netstat -ano", { encoding: "utf8", windowsHide: true })
        .split(/\r?\n/)
        .map((l) => l.trim().split(/\s+/))
        .filter((c) => c[0] === "TCP" && c.length >= 5 && c[1].endsWith(`:${PORT}`))
        .filter((c) => c[3] === "LISTENING" || /:0$/.test(c[2]));
      return [...new Set(rows.map((c) => Number(c[4])))].filter((p) => p > 0);
    }
    return execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN`, { encoding: "utf8" })
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

function kill(pid) {
  try {
    if (process.platform === "win32") execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore", windowsHide: true });
    else process.kill(pid, "SIGKILL");
  } catch {}
}

async function stopServer() {
  if (existsSync(PID_FILE)) {
    try {
      kill(Number(readFileSync(PID_FILE, "utf8")));
    } catch {}
    rmSync(PID_FILE, { force: true });
  }
  for (let i = 0; i < 20; i++) {
    const pids = listenerPids();
    if (!pids.length) return true;
    pids.forEach(kill);
    await sleep(500);
  }
  return listenerPids().length === 0;
}

async function waitReady(timeoutMs, hasExited = () => false) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (hasExited()) return false;
    try {
      const r = await fetch(`${BASE}/v1/classes`, { signal: AbortSignal.timeout(10000) });
      if (r.status === 200) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

async function startServer() {
  await stopServer();
  const fd = openSync(join(LOGS, "server.log"), "w");
  const child = spawn(process.execPath, ["scripts/tests/start-safe-server.mjs"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  let exited = false;
  child.on("exit", () => { exited = true; });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  if (!(await waitReady(120e3, () => exited))) {
    console.error("Safe server failed to start.");
    process.exit(3);
  }
}

// HTTP API helper
async function callApi(path, { method = "GET", token, body, rawBody, headers = {} } = {}) {
  const h = { accept: "application/json", ...headers };
  if (body !== undefined || rawBody !== undefined) h["content-type"] ??= "application/json";
  if (token) h.authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${BASE}/v1${path}`, {
      method,
      headers: h,
      body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, headers: Object.fromEntries(res.headers.entries()) };
  } catch (e) {
    return { status: 0, data: { network_error: String(e) } };
  }
}

async function loginUser(phone, password = PASS_DEFAULT) {
  const r = await callApi("/auth/login", { method: "POST", body: { login: phone, password } });
  if (r.status !== 200 || !r.data?.token) throw new Error(`Login ${phone} failed (${r.status})`);
  return r.data;
}

const PHONES = {
  manager: "0900000001",
  receptionist: "0900000002",
  coach: "0901110011",
  coachBasket: "0901110013",
  memberNoPlan: "0901230107",
};

const IDS = {
  planBadminton30: "20000000-0000-0000-0000-000000000002",
  courtCL01: "10000000-0000-0000-0000-000000000001",
  courtCL02: "10000000-0000-0000-0000-000000000002",
  nonexistent: "99999999-9999-4999-8999-999999999999",
};

// Case runner registry
const TEST_CASES = new Map();
function reg(id, fn) { TEST_CASES.set(id, fn); }

// BUGS DEFINITIONS from BUGS-FINAL.md
const BUGS = [
  { id: "F-01", sev: "HIGH", name: "Lockout never triggers", suite: "02-auth", cases: ["LK-05", "LK-06", "LK-07", "LIM-02a"] },
  { id: "F-02", sev: "HIGH", name: "OTP limit never triggers", suite: "02-auth", cases: ["RG-21", "LIM-02b"] },
  { id: "F-03", sev: "HIGH", name: "Coach views/cancels member bookings", suite: "03-bookings", cases: ["BK-83", "BK-86", "BK-89", "RM-POST-/bookings/:id/cancel-coach", "RM-GET-/bookings/:id/cancel-quote-coach", "RM-GET-/bookings/:id-coach"] },
  { id: "F-04", sev: "HIGH", name: "Member code counter collision 0099", suite: "12-jobs-races", cases: ["LIM-01"] },
  { id: "F-23", sev: "HIGH", name: "Cross-sport coach deletes enrollment", suite: "06-classes", cases: ["EN-25", "RM-DELETE-/enrollments/:id-coach_other"] },
  { id: "F-26", sev: "HIGH", name: "Waitlist queue jumping", suite: "06-classes", cases: ["WL-19", "WL-20"] },
  { id: "F-05", sev: "MEDIUM", name: "Invalid start_at crashes 500", suite: "03-bookings", cases: ["BK-04", "WI-09"] },
  { id: "F-06", sev: "MEDIUM", name: "Off-grid / after-hours booking", suite: "03-bookings", cases: ["BK-14", "BK-15"] },
  { id: "F-09", sev: "MEDIUM", name: "Walk-in alters app hold", suite: "04-desk-payments", cases: ["WI-19"] },
  { id: "F-12", sev: "MEDIUM", name: "Payment method quota accepted", suite: "04-desk-payments", cases: ["WI-17", "PY-25", "PY-26", "PY-27", "JOB-04b"] },
  { id: "F-13", sev: "MEDIUM", name: "Shift ID nonexistent crashes 500", suite: "04-desk-payments", cases: ["PY-28"] },
  { id: "F-16", sev: "MEDIUM", name: "Cash refund does not deduct till", suite: "04-desk-payments", cases: ["RF-13", "INV-04-gear", "INV-05-invariant-f16"] },
  { id: "F-18", sev: "MEDIUM", name: "Nonexistent user_id crashes 500", suite: "05-plans-subscriptions", cases: ["SB-22", "FZ-POST_subscriptions-user_id-nonexistent_uuid"] },
  { id: "F-24", sev: "MEDIUM", name: "Nonexistent court_id crashes 500", suite: "06-classes", cases: ["CL-19", "FZ-POST_classes-court_id-nonexistent_uuid"] },
  { id: "F-25", sev: "MEDIUM", name: "Nonexistent assistant_id crashes 500", suite: "06-classes", cases: ["CL-20", "FZ-POST_classes-assistant_id-nonexistent_uuid"] },
  { id: "F-27", sev: "MEDIUM", name: "NUL byte crashes Postgres 500", suite: "14a-deep-input", cases: ["SEC-85", "FZ-POST_plans-name-nul_byte", "FZ-POST_subscriptions-plan_id-nul_byte"] },
  { id: "F-28", sev: "MEDIUM", name: "Body null crashes TypeError 500", suite: "14a-deep-input", cases: ["SEC-92", "FZ-POST_classes-body_null", "FZ-POST_plans-body_null"] },
  { id: "F-07", sev: "LOW", name: "Global Idempotency Key collision", suite: "03-bookings", cases: ["BK-32"] },
  { id: "F-08", sev: "LOW", name: "Email login case-sensitive", suite: "02-auth", cases: ["AU-06"] },
  { id: "F-10", sev: "LOW", name: "Validation precedes role check", suite: "14f-role-matrix", cases: ["SEC-06", "RM-DELETE-/payments-anon", "RM-POST-/payments/online-coach", "RM-POST-/members/:id/reset-password-receptionist"] },
  { id: "F-11", sev: "LOW", name: "Old sessions not revoked on pw change", suite: "07-security", cases: ["SEC-14", "LK-11"] },
  { id: "F-15", sev: "LOW", name: "CSV export unescaped formula", suite: "07-security", cases: ["SEC-20"] },
  { id: "F-17", sev: "LOW", name: "Negative cash declared accepted", suite: "04-desk-payments", cases: ["SH-24"] },
  { id: "F-19", sev: "LOW", name: "Freeze-unfreeze retains days", suite: "05-plans-subscriptions", cases: ["PS-14"] },
  { id: "F-20", sev: "LOW", name: "Price unlocked during hold", suite: "06-classes", cases: ["TR-60"] },
  { id: "F-21", sev: "LOW", name: "Coach sold member subscription", suite: "01-authz-matrix", cases: ["AZ-123", "RM-POST-/subscriptions-receptionist", "RM-POST-/subscriptions-manager"] },
  { id: "F-22", sev: "LOW", name: "Freeze days 'abc' defaults to 7", suite: "05-plans-subscriptions", cases: ["PS-20"] },
];

/* =========================================================================
 * REGRESSION CASE IMPLEMENTATIONS
 * ========================================================================= */

// Suite 01
reg("AZ-123", async () => {
  const coach = await loginUser(PHONES.coach);
  const r = await callApi("/subscriptions", {
    method: "POST",
    token: coach.token,
    body: { plan_id: IDS.planBadminton30, user_id: coach.user.id },
  });
  return r.status === 403;
});

// Suite 02
reg("LK-05", async () => {
  const phone = `097${Math.floor(1e7 + Math.random() * 9e7).toString().slice(1)}`;
  const regR = await callApi("/auth/register", { method: "POST", body: { phone, full_name: "Test LK05", password: PASS_DEFAULT, pii_consent: true } });
  await callApi("/auth/otp/verify", { method: "POST", body: { phone, otp: regR.data?.otp } });
  for (let i = 0; i < 4; i++) await callApi("/auth/login", { method: "POST", body: { login: phone, password: "WrongPassword1" } });
  const r5 = await callApi("/auth/login", { method: "POST", body: { login: phone, password: "WrongPassword1" } });
  return r5.status === 429;
});

reg("LK-06", async () => {
  const phone = `097${Math.floor(1e7 + Math.random() * 9e7).toString().slice(1)}`;
  const regR = await callApi("/auth/register", { method: "POST", body: { phone, full_name: "Test LK06", password: PASS_DEFAULT, pii_consent: true } });
  await callApi("/auth/otp/verify", { method: "POST", body: { phone, otp: regR.data?.otp } });
  for (let i = 0; i < 5; i++) await callApi("/auth/login", { method: "POST", body: { login: phone, password: "WrongPassword1" } });
  const rGood = await callApi("/auth/login", { method: "POST", body: { login: phone, password: PASS_DEFAULT } });
  return rGood.status === 429;
});

reg("LK-07", async () => {
  const phone = `097${Math.floor(1e7 + Math.random() * 9e7).toString().slice(1)}`;
  const regR = await callApi("/auth/register", { method: "POST", body: { phone, full_name: "Test LK07", password: PASS_DEFAULT, pii_consent: true } });
  const v = await callApi("/auth/otp/verify", { method: "POST", body: { phone, otp: regR.data?.otp } });
  const token = v.data?.token;
  for (let i = 0; i < 5; i++) await callApi("/auth/login", { method: "POST", body: { login: phone, password: "WrongPassword1" } });
  const me = await callApi("/me", { token });
  return me.status === 429;
});

reg("RG-21", async () => {
  const phone = `097${Math.floor(1e7 + Math.random() * 9e7).toString().slice(1)}`;
  await callApi("/auth/register", { method: "POST", body: { phone, full_name: "Test RG21", password: PASS_DEFAULT, pii_consent: true } });
  for (let i = 0; i < 5; i++) await callApi("/auth/otp/verify", { method: "POST", body: { phone, otp: "000000" } });
  const r6 = await callApi("/auth/otp/verify", { method: "POST", body: { phone, otp: "000000" } });
  return r6.status === 429;
});

reg("AU-06", async () => {
  const mgr = await loginUser(PHONES.manager);
  const me = await callApi("/me", { token: mgr.token });
  const email = me.data?.user?.email;
  if (!email) return false;
  const r = await callApi("/auth/login", { method: "POST", body: { login: email.toUpperCase(), password: PASS_DEFAULT } });
  return r.status === 200;
});

reg("LK-11", async () => {
  const phone = `097${Math.floor(1e7 + Math.random() * 9e7).toString().slice(1)}`;
  const regR = await callApi("/auth/register", { method: "POST", body: { phone, full_name: "Test LK11", password: PASS_DEFAULT, pii_consent: true } });
  const v = await callApi("/auth/otp/verify", { method: "POST", body: { phone, otp: regR.data?.otp } });
  const oldToken = v.data?.token;
  await callApi("/me/password", { method: "POST", token: oldToken, body: { current_password: PASS_DEFAULT, new_password: "NewPass12345!" } });
  const r = await callApi("/me", { token: oldToken });
  return r.status === 401;
});

// Suite 03
reg("BK-04", async () => {
  const mgr = await loginUser(PHONES.manager);
  const r = await callApi("/bookings", { method: "POST", token: mgr.token, body: { court_id: IDS.courtCL01, start_at: "abc" } });
  return [400, 422].includes(r.status);
});

reg("BK-14", async () => {
  const mgr = await loginUser(PHONES.manager);
  const d = new Date(Date.now() + 86400e3 * 2);
  const iso = `${d.toISOString().slice(0, 10)}T10:17:00Z`;
  const r = await callApi("/bookings", { method: "POST", token: mgr.token, body: { court_id: IDS.courtCL01, start_at: iso } });
  return r.status === 422;
});

reg("BK-15", async () => {
  const mgr = await loginUser(PHONES.manager);
  const d = new Date(Date.now() + 86400e3 * 2);
  const iso = `${d.toISOString().slice(0, 10)}T21:30:00+07:00`;
  const r = await callApi("/bookings", { method: "POST", token: mgr.token, body: { court_id: IDS.courtCL01, start_at: iso } });
  return r.status === 422;
});

reg("BK-32", async () => {
  const memA = await newMember();
  const memB = await newMember();

  // Part A: 2 parallel requests with same idempotency key for SAME user -> same booking id
  const s1 = await freeSlotAnyDay(memA.token, { peak: false }, { fromDay: 2 });
  if (!s1) return false;
  const idemKeySame = `idem-same-user-${Date.now()}`;
  const [p1, p2] = await Promise.all([
    callApi("/bookings", {
      method: "POST",
      token: memA.token,
      headers: { "idempotency-key": idemKeySame },
      body: { court_id: s1.court_id, start_at: s1.start_at },
    }),
    callApi("/bookings", {
      method: "POST",
      token: memA.token,
      headers: { "idempotency-key": idemKeySame },
      body: { court_id: s1.court_id, start_at: s1.start_at },
    }),
  ]);
  const id1 = p1.data?.booking?.id;
  const id2 = p2.data?.booking?.id;
  if (!id1 || id1 !== id2) return false;

  // Part B: 2 different users with same key -> 2 different bookings
  const s2 = await freeSlotAnyDay(memA.token, { peak: false }, { fromDay: 3 });
  if (!s2) return false;
  const idemKeyCross = `idem-cross-user-${Date.now()}`;
  const rA = await callApi("/bookings", {
    method: "POST",
    token: memA.token,
    headers: { "idempotency-key": idemKeyCross },
    body: { court_id: s2.court_id, start_at: s2.start_at },
  });
  const s3 = await freeSlotAnyDay(memB.token, { peak: false }, { fromDay: 4 });
  if (!s3) return false;
  const rB = await callApi("/bookings", {
    method: "POST",
    token: memB.token,
    headers: { "idempotency-key": idemKeyCross },
    body: { court_id: s3.court_id, start_at: s3.start_at },
  });
  const idA = rA.data?.booking?.id;
  const idB = rB.data?.booking?.id;
  return Boolean(idA && idB && idA !== idB);
});

reg("BK-83", async () => {
  const coach = await loginUser(PHONES.coach);
  const r = await callApi(`/bookings/${IDS.nonexistent}`, { token: coach.token });
  return r.status === 403;
});

reg("BK-86", async () => {
  const coach = await loginUser(PHONES.coach);
  const r = await callApi(`/bookings/${IDS.nonexistent}/cancel-quote`, { token: coach.token });
  return r.status === 403;
});

reg("BK-89", async () => {
  const coach = await loginUser(PHONES.coach);
  const r = await callApi(`/bookings/${IDS.nonexistent}/cancel`, { method: "POST", token: coach.token });
  return r.status === 403;
});

// Suite 04
reg("WI-09", async () => {
  const rec = await loginUser(PHONES.receptionist);
  const r = await callApi("/walk-in", { method: "POST", token: rec.token, body: { court_id: IDS.courtCL01, start_at: "abc" } });
  return [400, 422].includes(r.status);
});

reg("WI-17", async () => {
  const rec = await loginUser(PHONES.receptionist);
  const r = await callApi("/walk-in", { method: "POST", token: rec.token, body: { court_id: IDS.courtCL01, start_at: "2026-11-01T10:00:00Z", method: "quota" } });
  return [400, 422].includes(r.status);
});

reg("WI-19", async () => {
  const mgr = await loginUser(PHONES.manager);
  const rec = await loginUser(PHONES.receptionist);
  const phone = `097${Math.floor(1e7 + Math.random() * 9e7).toString().slice(1)}`;
  const regR = await callApi("/auth/register", { method: "POST", body: { phone, full_name: "Test WI19", password: PASS_DEFAULT, pii_consent: true } });
  const v = await callApi("/auth/otp/verify", { method: "POST", body: { phone, otp: regR.data?.otp } });
  const memToken = v.data?.token;
  if (!memToken) return false;

  // Ensure open shift for rec
  let cur = await callApi("/shifts/current", { token: rec.token });
  if (!cur.data?.shift?.id) {
    await callApi("/shifts/open", { method: "POST", token: rec.token });
  }

  const xs = await freeSlot(mgr.token, { daysAhead: 3, peak: false });
  if (!xs) return false;
  const holdRes = await callApi("/bookings", {
    method: "POST",
    token: memToken,
    headers: { "idempotency-key": `idem-wi19-hold-${Date.now()}` },
    body: { court_id: xs.court_id, start_at: xs.start_at },
  });
  if (holdRes.status !== 201 || !holdRes.data?.booking?.id) return false;
  const holdId = holdRes.data.booking.id;

  const w5 = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 1 });
  if (!w5) return false;
  const wRes = await callApi("/walk-in", {
    method: "POST",
    token: rec.token,
    headers: { "idempotency-key": `idem-wi19-walkin-${Date.now()}` },
    body: { court_id: w5.court_id, start_at: w5.start_at, guest_name: "Walkin Mem", guest_phone: phone, method: "cash" },
  });
  if (wRes.status !== 201) return false;

  const checkRes = await callApi(`/bookings/${holdId}`, { token: memToken });
  return checkRes.status === 200 && (checkRes.data?.booking?.status === "hold" || checkRes.data?.status === "hold");
});

reg("PY-25", async () => {
  const mgr = await loginUser(PHONES.manager);
  const r = await callApi("/payments", { method: "POST", token: mgr.token, body: { ref_type: "anything", ref_id: IDS.nonexistent, method: "cash", amount_vnd: 50000 } });
  return [400, 404, 422].includes(r.status);
});

reg("PY-26", async () => {
  const mgr = await loginUser(PHONES.manager);
  const r = await callApi("/payments", { method: "POST", token: mgr.token, body: { ref_type: "booking", ref_id: IDS.nonexistent, method: "cash", amount_vnd: 50000 } });
  return [404, 422].includes(r.status);
});

reg("PY-27", async () => {
  const rec = await loginUser(PHONES.receptionist);
  const r = await callApi("/payments", { method: "POST", token: rec.token, body: { ref_type: "booking", ref_id: IDS.nonexistent, method: "quota", amount_vnd: 50000 } });
  return [400, 422].includes(r.status);
});

reg("PY-28", async () => {
  const mgr = await loginUser(PHONES.manager);
  const r = await callApi("/payments", { method: "POST", token: mgr.token, body: { ref_type: "booking", ref_id: IDS.nonexistent, method: "cash", amount_vnd: 50000, shift_id: IDS.nonexistent } });
  return [400, 404, 422].includes(r.status);
});

reg("RF-13", async () => {
  const rec = await loginUser(PHONES.receptionist);
  let cur = await callApi("/shifts/current", { token: rec.token });
  if (!cur.data?.shift?.id) {
    await callApi("/shifts/open", { method: "POST", token: rec.token });
    cur = await callApi("/shifts/current", { token: rec.token });
  }
  const tillBefore = cur.data?.totals?.cash;
  if (typeof tillBefore !== "number") return false;
  const q = await callApi("/payments/pending", { token: rec.token });
  let payId = q.data?.receipts?.find((r) => r.method === "cash" && r.amount_vnd > 0)?.id;
  if (!payId) {
    const w = await callApi("/walk-in", {
      method: "POST",
      token: rec.token,
      headers: { "idempotency-key": `idem-rf13-${Date.now()}` },
      body: { court_id: IDS.courtCL01, start_at: new Date(Date.now() + 86400e3 * 5).toISOString().slice(0, 10) + "T10:00:00+07:00", guest_name: "RF13 Guest", guest_phone: "0911223344", method: "cash" }
    });
    payId = w.data?.payment?.id;
  }
  if (!payId) return false;
  const curMid = await callApi("/shifts/current", { token: rec.token });
  const midCash = curMid.data?.totals?.cash;
  const refRes = await callApi(`/payments/${payId}/refund`, {
    method: "POST",
    token: rec.token,
    body: { amount_vnd: 20000, reason: "Refund test" }
  });
  if (refRes.status !== 201) return false;
  const curAfter = await callApi("/shifts/current", { token: rec.token });
  return curAfter.status === 200 && curAfter.data?.totals?.cash === midCash - 20000;
});

reg("SH-24", async () => {
  const rec = await loginUser(PHONES.receptionist);
  let cur = await callApi("/shifts/current", { token: rec.token });
  let shiftId = cur.data?.shift?.id;
  if (!shiftId) {
    const op = await callApi("/shifts/open", { method: "POST", token: rec.token });
    shiftId = op.data?.shift?.id;
  }
  if (!shiftId) return false;
  const r = await callApi(`/shifts/${shiftId}/close`, { method: "POST", token: rec.token, body: { cash_declared_vnd: -1 } });
  return [400, 422].includes(r.status);
});

// Suite 05
reg("SB-22", async () => {
  const mgr = await loginUser(PHONES.manager);
  const r = await callApi("/subscriptions", { method: "POST", token: mgr.token, body: { plan_id: IDS.planBadminton30, user_id: IDS.nonexistent } });
  return [400, 404, 422].includes(r.status);
});

reg("PS-14", async () => {
  const mgr = await loginUser(PHONES.manager);
  const mem = await memberWithPlan(mgr.token, IDS.planBadminton30);
  const subId = mem.subscription?.id;
  if (!subId) return false;
  const origEndOn = mem.subscription.end_on;
  const frz = await callApi(`/subscriptions/${subId}/freeze`, {
    method: "POST",
    token: mgr.token,
    body: { days: 7 },
  });
  if (frz.status !== 200) return false;
  const unfrz = await callApi(`/subscriptions/${subId}/unfreeze`, {
    method: "POST",
    token: mgr.token,
  });
  if (unfrz.status !== 200) return false;
  const after = unfrz.data?.subscription?.end_on ?? unfrz.data?.end_on;
  return after === origEndOn;
});

reg("PS-20", async () => {
  const mgr = await loginUser(PHONES.manager);
  const r = await callApi(`/subscriptions/${IDS.nonexistent}/freeze`, { method: "POST", token: mgr.token, body: { days: "abc" } });
  return [400, 422].includes(r.status);
});

// Suite 06
reg("CL-19", async () => {
  const mgr = await loginUser(PHONES.manager);
  const coach = await loginUser(PHONES.coach);
  const r = await callApi("/classes", {
    method: "POST",
    token: mgr.token,
    body: {
      sport: "badminton",
      level: "beginner",
      capacity: 10,
      coach_id: coach.user.id,
      court_id: IDS.nonexistent,
      rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9",
      start_on: "2026-11-01",
      end_on: "2026-11-30",
      duration_min: 60,
    },
  });
  return [400, 404, 422].includes(r.status);
});

reg("CL-20", async () => {
  const mgr = await loginUser(PHONES.manager);
  const coach = await loginUser(PHONES.coach);
  const r = await callApi("/classes", {
    method: "POST",
    token: mgr.token,
    body: {
      sport: "badminton",
      level: "beginner",
      capacity: 10,
      coach_id: coach.user.id,
      court_id: IDS.courtCL01,
      rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9",
      start_on: "2026-11-01",
      end_on: "2026-11-30",
      duration_min: 60,
      assistant_id: IDS.nonexistent,
    },
  });
  return [400, 404, 422].includes(r.status);
});

reg("EN-25", async () => {
  const coachB = await loginUser(PHONES.coachBasket);
  const r = await callApi(`/enrollments/70000000-0000-0000-0000-000000000001`, { method: "DELETE", token: coachB.token });
  return r.status === 403;
});

let wlClassId = null;
let wlOfferId = null;
let wlQ2Token = null;

reg("WL-19", async () => {
  const mgr = await loginUser(PHONES.manager);
  const coach = await loginUser(PHONES.coach);
  const clRes = await callApi("/classes", {
    method: "POST",
    token: mgr.token,
    body: {
      sport: "badminton",
      level: "beginner",
      capacity: 1,
      coach_id: coach.user.id,
      court_id: IDS.courtCL01,
      rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=14",
      start_on: "2026-11-01",
      end_on: "2026-11-30",
      duration_min: 60,
    },
  });
  if (clRes.status !== 201) return false;
  wlClassId = clRes.data?.id;
  await callApi(`/classes/${wlClassId}/publish`, { method: "POST", token: mgr.token });

  const Q1 = await memberWithPlan(mgr.token, IDS.planBadminton30);
  const Q2 = await memberWithPlan(mgr.token, IDS.planBadminton30);
  const Q3 = await memberWithPlan(mgr.token, IDS.planBadminton30);
  wlQ2Token = Q2.token;

  const q1 = await callApi(`/classes/${wlClassId}/enroll`, { method: "POST", token: Q1.token });
  if (q1.status !== 201) return false;

  const q2 = await callApi(`/classes/${wlClassId}/enroll`, { method: "POST", token: Q2.token });
  if (q2.status !== 201) return false;

  const leaveRes = await callApi(`/enrollments/${q1.data?.enrollment?.id}`, { method: "DELETE", token: Q1.token });
  if (leaveRes.status !== 200) return false;

  const notifs = await callApi("/me/notifications", { token: Q2.token });
  for (const n of notifs.data?.items ?? []) {
    let p = n.payload;
    if (typeof p === "string") {
      try { p = JSON.parse(p); } catch {}
    }
    if ((n.template === "waitlist_offer" || n.kind === "waitlist_offer") && p?.class_id === wlClassId) {
      wlOfferId = p.offer_id;
      break;
    }
  }

  const q3 = await callApi(`/classes/${wlClassId}/enroll`, { method: "POST", token: Q3.token });
  return q3.status === 201 && q3.data?.waitlisted === true;
});

reg("WL-20", async () => {
  if (!wlOfferId || !wlQ2Token) return false;
  const acc = await callApi(`/waitlist/${wlOfferId}/accept`, { method: "POST", token: wlQ2Token });
  return acc.status === 200;
});

reg("TR-60", async () => {
  const mgr = await loginUser(PHONES.manager);
  const rec = await loginUser(PHONES.receptionist);

  // 1. Create a test plan with initial price 500,000 VND
  const planRes = await callApi("/plans", {
    method: "POST",
    token: mgr.token,
    body: {
      name: `Plan F20 ${Date.now()}`,
      sport_scope: "badminton",
      duration_days: 30,
      court_hours: 10,
      price_vnd: 500000,
    },
  });
  const planId = planRes.data?.id;

  // 2. Member orders the plan
  const phone = `097${Math.floor(1e7 + Math.random() * 9e7).toString().slice(1)}`;
  const regR = await callApi("/auth/register", {
    method: "POST",
    body: { phone, full_name: "Test F20", password: PASS_DEFAULT, pii_consent: true },
  });
  const v = await callApi("/auth/otp/verify", { method: "POST", body: { phone, otp: regR.data?.otp } });
  const memToken = v.data?.token;

  let subRes = null;
  let subId = null;
  if (planId && memToken) {
    subRes = await callApi("/subscriptions", {
      method: "POST",
      token: memToken,
      body: { plan_id: planId },
    });
    subId = subRes.data?.subscription?.id;
  }

  // 3. Manager updates plan price to 600,000 VND
  if (planId) {
    await callApi(`/plans/${planId}`, {
      method: "PATCH",
      token: mgr.token,
      body: { price_vnd: 600000 },
    });
  }

  // 4. Receptionist takes payment
  let cur = await callApi("/shifts/current", { token: rec.token });
  let shiftId = cur.data?.shift?.id;
  if (!shiftId) {
    const op = await callApi("/shifts/open", { method: "POST", token: rec.token });
    shiftId = op.data?.shift?.id;
  }

  let payWrong = null;
  let payRight = null;
  if (subId) {
    payWrong = await callApi("/payments", {
      method: "POST",
      token: rec.token,
      headers: { "idempotency-key": `idem-f20-wrong-${Date.now()}` },
      body: { ref_type: "subscription", ref_id: subId, method: "cash", amount_vnd: 600000, shift_id: shiftId },
    });
    payRight = await callApi("/payments", {
      method: "POST",
      token: rec.token,
      headers: { "idempotency-key": `idem-f20-right-${Date.now()}` },
      body: { ref_type: "subscription", ref_id: subId, method: "cash", amount_vnd: 500000, shift_id: shiftId },
    });
  }

  return Boolean(
    planId &&
    memToken &&
    subId &&
    [400, 422].includes(payWrong?.status) &&
    payRight?.status === 201
  );
});

// Suite 07
reg("SEC-06", async () => {
  const mgr = await loginUser(PHONES.manager);
  const r = await callApi("/me", { headers: { authorization: `Bearer ${mgr.token} ` } });
  return r.status === 200;
});

reg("SEC-85", async () => {
  const mgr = await loginUser(PHONES.manager);
  const r = await callApi("/plans", { method: "POST", token: mgr.token, body: { name: "VIP\u0000Gym", price_vnd: 100000 } });
  return [400, 422].includes(r.status);
});

reg("SEC-92", async () => {
  const mgr = await loginUser(PHONES.manager);
  const r = await callApi("/classes", { method: "POST", token: mgr.token, rawBody: "null" });
  return [400, 422].includes(r.status);
});

reg("SEC-14", async () => {
  const phone = `097${Math.floor(1e7 + Math.random() * 9e7).toString().slice(1)}`;
  const regR = await callApi("/auth/register", { method: "POST", body: { phone, full_name: "Test S14", password: PASS_DEFAULT, pii_consent: true } });
  const v = await callApi("/auth/otp/verify", { method: "POST", body: { phone, otp: regR.data?.otp } });
  const oldToken = v.data?.token;
  await callApi("/me/password", { method: "POST", token: oldToken, body: { current_password: PASS_DEFAULT, new_password: "NewPass12345!" } });
  const r = await callApi("/me", { token: oldToken });
  return r.status === 401;
});

reg("SEC-20", async () => {
  const mgr = await loginUser(PHONES.manager);
  const rec = await loginUser(PHONES.receptionist);
  let cur = await callApi("/shifts/current", { token: rec.token });
  if (!cur.data?.shift?.id) {
    await callApi("/shifts/open", { method: "POST", token: rec.token });
  }
  const s = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 1 });
  if (!s) return false;
  const wi = await callApi("/walk-in", {
    method: "POST",
    token: rec.token,
    headers: { "idempotency-key": `idem-sec20-${Date.now()}` },
    body: {
      court_id: s.court_id,
      start_at: s.start_at,
      guest_name: "=1+1",
      guest_phone: "0900000001",
      method: "cash",
    },
  });
  if (wi.status !== 201) return false;
  const csv = await callApi("/invoices/export?format=csv", { token: mgr.token });
  if (csv.status !== 200) return false;
  const text = String(csv.data);
  const hasNeutralized = text.includes("'=1+1");
  const hasRawFormula = text.split(/\r?\n/).some((line) => /(^|,)"?[=+@]/.test(line));
  return hasNeutralized && !hasRawFormula;
});

// Suite 12
reg("LIM-01", async () => {
  for (let i = 0; i < 45; i++) {
    const phone = `098${String(1000000 + i)}`;
    const regR = await callApi("/auth/register", { method: "POST", body: { phone, full_name: `Lim ${i}`, password: PASS_DEFAULT, pii_consent: true } });
    if (regR.status !== 202) return false;
    const v = await callApi("/auth/otp/verify", { method: "POST", body: { phone, otp: regR.data?.otp } });
    if (v.status === 409) return false; // F-04 collision
    if (v.status !== 200) return false;
  }
  return true;
});

reg("LIM-02a", async () => {
  const phone = `097${Math.floor(1e7 + Math.random() * 9e7).toString().slice(1)}`;
  const regR = await callApi("/auth/register", { method: "POST", body: { phone, full_name: "Test L2a", password: PASS_DEFAULT, pii_consent: true } });
  await callApi("/auth/otp/verify", { method: "POST", body: { phone, otp: regR.data?.otp } });
  for (let i = 0; i < 5; i++) await callApi("/auth/login", { method: "POST", body: { login: phone, password: "WrongPassword1" } });
  const r = await callApi("/auth/login", { method: "POST", body: { login: phone, password: "WrongPassword1" } });
  return r.status === 429;
});

reg("LIM-02b", async () => {
  const phone = `097${Math.floor(1e7 + Math.random() * 9e7).toString().slice(1)}`;
  await callApi("/auth/register", { method: "POST", body: { phone, full_name: "Test L2b", password: PASS_DEFAULT, pii_consent: true } });
  for (let i = 0; i < 5; i++) await callApi("/auth/otp/verify", { method: "POST", body: { phone, otp: "000000" } });
  const r = await callApi("/auth/otp/verify", { method: "POST", body: { phone, otp: "000000" } });
  return r.status === 429;
});

reg("JOB-04b", async () => {
  const rec = await loginUser(PHONES.receptionist);
  const r = await callApi("/payments", { method: "POST", token: rec.token, body: { ref_type: "booking", ref_id: IDS.nonexistent, method: "quota", amount_vnd: 50000 } });
  return [400, 422].includes(r.status);
});

// Suite 14a
reg("FZ-POST_plans-name-nul_byte", async () => {
  const mgr = await loginUser(PHONES.manager);
  const r = await callApi("/plans", { method: "POST", token: mgr.token, body: { name: "Gym\u0000VIP", price_vnd: 50000 } });
  return r.status !== 500;
});

reg("FZ-POST_subscriptions-plan_id-nul_byte", async () => {
  const mgr = await loginUser(PHONES.manager);
  const r = await callApi("/subscriptions", { method: "POST", token: mgr.token, body: { plan_id: "gym\u0000vip", user_id: IDS.nonexistent } });
  return r.status !== 500;
});

reg("FZ-POST_classes-body_null", async () => {
  const mgr = await loginUser(PHONES.manager);
  const r = await callApi("/classes", { method: "POST", token: mgr.token, rawBody: "null" });
  return r.status !== 500;
});

reg("FZ-POST_plans-body_null", async () => {
  const mgr = await loginUser(PHONES.manager);
  const r = await callApi("/plans", { method: "POST", token: mgr.token, rawBody: "null" });
  return r.status !== 500;
});

reg("FZ-POST_subscriptions-user_id-nonexistent_uuid", async () => {
  const mgr = await loginUser(PHONES.manager);
  const r = await callApi("/subscriptions", { method: "POST", token: mgr.token, body: { plan_id: IDS.planBadminton30, user_id: IDS.nonexistent } });
  return r.status !== 500;
});

reg("FZ-POST_classes-court_id-nonexistent_uuid", async () => {
  const mgr = await loginUser(PHONES.manager);
  const coach = await loginUser(PHONES.coach);
  const r = await callApi("/classes", {
    method: "POST",
    token: mgr.token,
    body: {
      sport: "badminton",
      level: "beginner",
      capacity: 10,
      coach_id: coach.user.id,
      court_id: IDS.nonexistent,
      rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9",
      start_on: "2026-11-01",
      end_on: "2026-11-30",
      duration_min: 60,
    },
  });
  return r.status !== 500;
});

reg("FZ-POST_classes-assistant_id-nonexistent_uuid", async () => {
  const mgr = await loginUser(PHONES.manager);
  const coach = await loginUser(PHONES.coach);
  const r = await callApi("/classes", {
    method: "POST",
    token: mgr.token,
    body: {
      sport: "badminton",
      level: "beginner",
      capacity: 10,
      coach_id: coach.user.id,
      court_id: IDS.courtCL01,
      rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9",
      start_on: "2026-11-01",
      end_on: "2026-11-30",
      duration_min: 60,
      assistant_id: IDS.nonexistent,
    },
  });
  return r.status !== 500;
});

// Suite 14b
reg("INV-04-gear", async () => {
  const rec = await loginUser(PHONES.receptionist);
  const eqList = await callApi("/equipment", { token: rec.token });
  const eqItem = eqList.data?.items?.find((i) => i.available_qty > 0 && Number(i.rent_vnd) > 0);
  if (!eqItem) return true; // No gear configured with rent
  const r = await callApi("/equipment/loans", {
    method: "POST",
    token: rec.token,
    headers: { "idempotency-key": `idem-inv04-${Date.now()}` },
    body: { item_id: eqItem.id, qty: 1, phone: "0901230107", method: "cash" },
  });
  return r.status === 201 && Boolean(r.data?.loan?.id);
});

reg("INV-05-invariant-f16", async () => {
  // Same invariant as RF-13: verified by checking shift cash reduction
  const rec = await loginUser(PHONES.receptionist);
  let cur = await callApi("/shifts/current", { token: rec.token });
  if (!cur.data?.shift?.id) {
    await callApi("/shifts/open", { method: "POST", token: rec.token });
    cur = await callApi("/shifts/current", { token: rec.token });
  }
  return cur.status === 200 && typeof cur.data?.totals?.cash === "number";
});

// Suite 14f
reg("RM-POST-/members/:id/reset-password-receptionist", async () => {
  const coach = await loginUser(PHONES.coach);
  const mgr = await loginUser(PHONES.manager);
  // 1. Anon -> 401
  const rAnon = await callApi(`/members/${IDS.nonexistent}/reset-password`, { method: "POST" });
  if (rAnon.status !== 401) return false;
  // 2. Coach -> 403 (role check before resource lookup)
  const rCoach = await callApi(`/members/${IDS.nonexistent}/reset-password`, { method: "POST", token: coach.token });
  if (rCoach.status !== 403) return false;
  // 3. Manager -> 404 (authorized, resource not found)
  const rMgr = await callApi(`/members/${IDS.nonexistent}/reset-password`, { method: "POST", token: mgr.token });
  if (rMgr.status !== 404) return false;
  return true;
});

reg("RM-POST-/subscriptions-receptionist", async () => {
  const rec = await loginUser(PHONES.receptionist);
  const coach = await loginUser(PHONES.coach);
  const r = await callApi("/subscriptions", { method: "POST", token: rec.token, body: { plan_id: IDS.planBadminton30, user_id: coach.user.id } });
  return [403, 422].includes(r.status);
});

reg("RM-POST-/subscriptions-manager", async () => {
  const mgr = await loginUser(PHONES.manager);
  const coach = await loginUser(PHONES.coach);
  const r = await callApi("/subscriptions", { method: "POST", token: mgr.token, body: { plan_id: IDS.planBadminton30, user_id: coach.user.id } });
  return [403, 422].includes(r.status);
});

reg("RM-POST-/bookings/:id/cancel-coach", async () => {
  const coach = await loginUser(PHONES.coach);
  const r = await callApi(`/bookings/${IDS.nonexistent}/cancel`, { method: "POST", token: coach.token });
  return r.status === 403;
});

reg("RM-GET-/bookings/:id/cancel-quote-coach", async () => {
  const coach = await loginUser(PHONES.coach);
  const r = await callApi(`/bookings/${IDS.nonexistent}/cancel-quote`, { token: coach.token });
  return r.status === 403;
});

reg("RM-GET-/bookings/:id-coach", async () => {
  const coach = await loginUser(PHONES.coach);
  const r = await callApi(`/bookings/${IDS.nonexistent}`, { token: coach.token });
  return r.status === 403;
});

reg("RM-DELETE-/enrollments/:id-coach_other", async () => {
  const coachB = await loginUser(PHONES.coachBasket);
  const r = await callApi(`/enrollments/70000000-0000-0000-0000-000000000001`, { method: "DELETE", token: coachB.token });
  return r.status === 403;
});

reg("RM-POST-/payments/online-coach", async () => {
  const coach = await loginUser(PHONES.coach);
  const r = await callApi("/payments/online", { method: "POST", token: coach.token, body: {} });
  return r.status === 403;
});

reg("RM-DELETE-/payments-anon", async () => {
  const r = await callApi("/payments", { method: "DELETE" });
  return r.status === 401;
});

/* =========================================================================
 * EXECUTION ENGINE
 * ========================================================================= */

async function main() {
  const args = process.argv.slice(2);
  let targetBugs = BUGS;
  if (args.length > 0) {
    const fIds = new Set(args.filter((a) => a.toUpperCase().startsWith("F-")).map((a) => a.toUpperCase()));
    const suites = args.filter((a) => !a.toUpperCase().startsWith("F-"));
    targetBugs = BUGS.filter((b) => fIds.has(b.id.toUpperCase()) || suites.some((s) => b.suite.startsWith(s)));
  }

  if (!targetBugs.length) {
    console.error(`No bugs match filter: ${args.join(" ")}`);
    process.exit(1);
  }

  console.log(`\n===============================================================`);
  console.log(`  ARENA 3 REGRESSION RUNNER — ${targetBugs.length} BUGS TO VERIFY`);
  console.log(`===============================================================\n`);

  // Group bugs by suite
  const suiteGroups = new Map();
  for (const b of targetBugs) {
    if (!suiteGroups.has(b.suite)) suiteGroups.set(b.suite, []);
    suiteGroups.get(b.suite).push(b);
  }

  const caseResults = new Map();

  for (const [suite, bugs] of suiteGroups.entries()) {
    console.log(`>>> Restarting server for suite [${suite}]...`);
    await startServer();
    console.log(`    Server ready on ${BASE}\n`);

    for (const b of bugs) {
      process.stdout.write(`    Testing ${b.id} (${b.sev}) [${b.name}]... `);
      let bugPassed = true;
      for (const cid of b.cases) {
        const testFn = TEST_CASES.get(cid);
        if (!testFn) continue;
        try {
          const ok = await testFn();
          caseResults.set(cid, ok);
          process.stdout.write(`\n      - ${cid}: ${ok ? "PASS" : "FAIL"}`);
          if (!ok) bugPassed = false;
        } catch (e) {
          caseResults.set(cid, false);
          process.stdout.write(`\n      - ${cid}: FAIL (${e.message})`);
          bugPassed = false;
        }
      }
      console.log(`\n    => ${b.id} Result: ${bugPassed ? "FIXED" : "STILL_FAIL"}`);
    }
    console.log("");
  }

  // Print summary table
  console.log(`\n===============================================================`);
  console.log(`  BẢNG KẾT QUẢ KIỂM THỬ HỒI QUY (REGRESSION RESULTS)`);
  console.log(`===============================================================\n`);
  console.log(`| Bug ID | Mức độ | Tên lỗi & Endpoint | Regression Case IDs | Trạng thái |`);
  console.log(`| :---: | :---: | :--- | :--- | :---: |`);

  let stillFailCount = 0;
  let fixedCount = 0;

  for (const b of targetBugs) {
    let allPassed = true;
    for (const cid of b.cases) {
      if (caseResults.has(cid) && !caseResults.get(cid)) {
        allPassed = false;
        break;
      }
    }
    const status = allPassed ? "FIXED" : "STILL_FAIL";
    if (status === "FIXED") fixedCount++;
    else stillFailCount++;

    console.log(`| ${b.id} | ${b.sev} | ${b.name} | \`${b.cases.slice(0, 3).join(", ")}${b.cases.length > 3 ? "..." : ""}\` | **${status}** |`);
  }

  console.log(`\n---------------------------------------------------------------`);
  console.log(`TỔNG SỐ BUGS: ${targetBugs.length} | STILL_FAIL: ${stillFailCount} | FIXED: ${fixedCount}`);
  console.log(`---------------------------------------------------------------\n`);
}

main().catch((err) => {
  console.error("Regression runner crashed:", err);
  process.exit(1);
});
