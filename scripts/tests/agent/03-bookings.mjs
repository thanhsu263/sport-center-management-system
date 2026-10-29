/**
 * Suite 03 — court bookings: hold, confirm, bank transfer, promo codes, cancel,
 * reschedule, check-in, collect balance, idempotency.
 *
 *   node scripts/tests/agent/03-bookings.mjs
 *
 * Needs the safe server (scripts/tests/start-safe-server.mjs). Uses brand-new
 * members for almost everything, so it can run more than once on the same
 * server; a few cases (check-in, cancel tiers) depend on the clock and become
 * BLOCKED when the time of day makes them impossible — that is not a failure.
 *
 * Case IDs: BK-xx (bookings), PR-xx (promo codes on a booking).
 */
import {
  api,
  blocked,
  check,
  freeSlot,
  freeSlotAnyDay,
  ictDate,
  ictHour,
  IDS,
  isPeak,
  login,
  memberWithPlan,
  newMember,
  PHONES,
  slot,
  summary,
} from "../agent-lib.mjs";

const mgr = await login(PHONES.manager);
const rec = await login(PHONES.receptionist);
const coach = await login(PHONES.coach);
// Seeded plan members (Long, Hạnh) already have 2+ bookings every day → BR-05.
// Plan cases use fresh members whose plan the manager sells and activates.
const planMember = await memberWithPlan(mgr.token, IDS.planAllAccess30); // 4 court hours, 15% off courts
const A = await newMember();
const B = await newMember();

// `s` comes from freeSlot(); when no free slot was found it is null and the
// call is reported as status 0 instead of crashing the whole suite.
const hold = (tok, s, extra = {}, opts = {}) =>
  !s
    ? { status: 0, data: { error: "the test could not find a free slot" }, request: { method: "POST", path: "/bookings" } }
    : api("/bookings", { method: "POST", token: tok, idem: true, ...opts, body: { court_id: s.court_id, start_at: s.start_at, ...extra } });
const confirm = (tok, id, method) =>
  api(`/bookings/${id}/confirm`, { method: "POST", token: tok, idem: true, body: method === undefined ? {} : { method } });
const getB = (tok, id) => api(`/bookings/${id}`, { token: tok });

/** Hold + transfer + reception confirms → a CONFIRMED, PAID booking. Returns the booking row or null. */
async function paidBooking(member, s, extra = {}) {
  if (!s) return { error: "no free slot found" };
  const h = await hold(member.token, s, extra);
  if (h.status !== 201) return { error: `hold ${h.status} ${JSON.stringify(h.data)}` };
  const t = await confirm(member.token, h.data.booking.id, "transfer");
  if (t.status !== 202) return { error: `transfer ${t.status} ${JSON.stringify(t.data)}` };
  const c = await api(`/bookings/${h.data.booking.id}/transfer-confirm`, { method: "POST", token: mgr.token });
  if (c.status !== 200) return { error: `transfer-confirm ${c.status} ${JSON.stringify(c.data)}` };
  return { booking: c.data.booking, hold: h.data };
}

// ───────────────────────────── 1. Hold: input validation ─────────────────────────────
const s1 = await freeSlot(mgr.token, { daysAhead: 3, peak: false });
if (!s1) throw new Error("No free off-peak badminton slot 3 days ahead — restart the safe server for a fresh database.");

check("BK-01", "hold without Idempotency-Key → 422", await hold(A.token, s1, {}, { idem: false }), { status: 422, code: "VALIDATION" });
check("BK-02", "hold without court_id → 422", await api("/bookings", { method: "POST", token: A.token, idem: true, body: { start_at: s1.start_at } }), { status: 422, code: "VALIDATION" });
check("BK-03", "hold without start_at → 422", await api("/bookings", { method: "POST", token: A.token, idem: true, body: { court_id: s1.court_id } }), { status: 422, code: "VALIDATION" });
check("BK-04", "hold with start_at='abc' → 400/422, never 500", await hold(A.token, { court_id: s1.court_id, start_at: "abc" }), {
  status: [400, 422],
  why: "an unparseable date must be a validation error, not a crash",
});
check("BK-05", "hold with court_id that is not a UUID → 400", await hold(A.token, { court_id: "not-a-uuid", start_at: s1.start_at }), { status: [400, 422], notStatus: 500 });
check("BK-06", "hold on a court that does not exist → 404", await hold(A.token, { court_id: IDS.nonexistent, start_at: s1.start_at }), { status: 404, code: "NOT_FOUND" });
check("BK-07", "hold yesterday 10:00 → BR-07", await hold(A.token, { court_id: s1.court_id, start_at: slot(-1, 10) }), { status: 422, br: "BR-07" });
check("BK-08", "hold 05:00 (before opening 06:00) → BR-06", await hold(A.token, { court_id: s1.court_id, start_at: slot(3, 5) }), { status: 422, br: "BR-06" });
check("BK-09", "hold 22:00 (closing time) → BR-06", await hold(A.token, { court_id: s1.court_id, start_at: slot(3, 22) }), { status: 422, br: "BR-06" });
check("BK-10", "hold 9 days ahead (limit 7) → BR-05", await hold(A.token, { court_id: s1.court_id, start_at: slot(9, 10) }), { status: 422, br: "BR-05" });
check("BK-11", "receptionist cannot hold (members only) → 403", await hold(rec.token, s1), { status: 403, code: "FORBIDDEN" });
check("BK-12", "coach cannot hold → 403", await hold(coach.token, s1), { status: 403, code: "FORBIDDEN" });
check("BK-13", "hold without login → 401", await hold(undefined, s1), { status: 401 });

// Slot grid: 60-minute slots that start on the hour, inside 06:00–22:00.
const grid = await freeSlot(mgr.token, { daysAhead: 4, hours: [10, 11, 12, 13, 14] });
if (grid) {
  const odd = await hold(B.token, { court_id: grid.court_id, start_at: slot(4, grid.hour, 17) });
  check("BK-14", "hold starting at hh:17 (off the hourly grid) is refused", odd, {
    status: [400, 422],
    why: "slots are 60 minutes on the hour; 10:17–11:17 would overlap two grid cells",
  });
  if (odd.status === 201) await api(`/bookings/${odd.data.booking.id}/cancel`, { method: "POST", token: B.token, body: {} });
} else blocked("BK-14", "hold off the hourly grid", "no free 10–14h badminton slot 4 days ahead");

const late = await freeSlot(mgr.token, { daysAhead: 4, hours: [21] });
if (late) {
  const r = await hold(B.token, { court_id: late.court_id, start_at: slot(4, 21, 30) });
  check("BK-15", "hold 21:30 (would end 22:30, after closing) is refused", r, {
    status: [400, 422],
    why: "a slot must end by close_time 22:00",
  });
  if (r.status === 201) await api(`/bookings/${r.data.booking.id}/cancel`, { method: "POST", token: B.token, body: {} });
} else blocked("BK-15", "hold 21:30", "21:00 is taken on every badminton court 4 days ahead");

// Court in maintenance → BR-06 (and put it back afterwards).
const maint = await freeSlot(mgr.token, { daysAhead: 3, peak: false, notCourt: s1.court_id });
if (maint) {
  const off = await api(`/courts/${maint.court_id}`, { method: "PATCH", token: mgr.token, body: { status: "maintenance" } });
  if (off.status === 200) {
    check("BK-16", "hold on a court in maintenance → BR-06", await hold(B.token, maint), { status: 422, br: "BR-06" });
  } else blocked("BK-16", "hold on a court in maintenance", `PATCH /courts → ${off.status} ${JSON.stringify(off.data)}`);
  const on = await api(`/courts/${maint.court_id}`, { method: "PATCH", token: mgr.token, body: { status: "ready" } });
  check("BK-17", "manager puts the court back to ready → 200", on, { status: 200 });
} else blocked("BK-16", "hold on a court in maintenance", "no free slot");

// ───────────────────────────── 2. Hold: success, deposit, replace ─────────────────────────────
const h1 = await hold(A.token, s1);
check("BK-20", "valid off-peak hold → 201 with booking, hold_until, price", h1, {
  status: 201,
  test: (r) =>
    r.data.booking?.status === "hold" &&
    r.data.booking.court_id === s1.court_id &&
    typeof r.data.hold_until === "string" &&
    r.data.price > 0,
  why: "booking.status='hold' on the requested court; hold_until and price present",
});
const holdMs = Date.parse(h1.data?.hold_until ?? "") - Date.now();
check("BK-21", "hold_until is about 5 minutes from now (setting hold_minutes=5)", h1, {
  test: () => holdMs > 3.5 * 60_000 && holdMs < 6 * 60_000,
  why: `hold_until should be ~300 s ahead, was ${Math.round(holdMs / 1000)} s`,
});
check("BK-22", "off-peak: no deposit, due_now = full price, member with no plan pays list price", h1, {
  test: (r) => r.data.deposit_vnd === 0 && r.data.due_now_vnd === r.data.price && r.data.price === r.data.list_price,
  why: "deposit_vnd 0, due_now_vnd = price = list_price",
});

const sPeak = await freeSlot(mgr.token, { daysAhead: 3, peak: true });
let h2 = null;
if (sPeak) {
  h2 = await hold(A.token, sPeak);
  check("BK-23", "peak hold → deposit 30% (rounded to 1,000đ), due_now = deposit", h2, {
    status: 201,
    test: (r) =>
      r.data.deposit_vnd === Math.round((r.data.price * 0.3) / 1000) * 1000 && r.data.due_now_vnd === r.data.deposit_vnd,
    why: "deposit_pct=30, deposit_peak_only=true, round_vnd=1000",
  });
  const first = await getB(A.token, h1.data?.booking?.id);
  check("BK-24", "a member has only ONE hold: the new hold cancelled the previous one", first, {
    status: 200,
    test: (r) => r.data.status === "cancelled",
    why: "booking_replace_hold releases the member's older hold",
  });
  const back = await hold(B.token, s1);
  check("BK-25", "the released slot can be held again by someone else", back, { status: 201 });
  if (back.status === 201) await api(`/bookings/${back.data.booking.id}/cancel`, { method: "POST", token: B.token, body: {} });
} else blocked("BK-23", "peak hold", "no free peak slot 3 days ahead");

const target = h2?.status === 201 ? { s: sPeak, h: h2 } : { s: s1, h: h1 };
check("BK-26", "another member holding the same slot → 409 CONFLICT_SLOT", await hold(B.token, target.s), { status: 409, code: "CONFLICT_SLOT" });

// ───────────────────────────── 3. Idempotency ─────────────────────────────
const C = await newMember();
const sIdem = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 2 });
const key = crypto.randomUUID();
const i1 = await hold(C.token, sIdem, {}, { idem: false, idemKey: key });
const i2 = await hold(C.token, sIdem, {}, { idem: false, idemKey: key });
check("BK-30", "same Idempotency-Key + same body → same response replayed (same booking id)", i2, {
  status: 201,
  test: (r) => i1.status === 201 && r.data.booking?.id === i1.data.booking?.id,
  why: "second call must not create a second booking",
});
// The body differs only by one extra field — the key is reused for a different request.
const i3 = await api("/bookings", { method: "POST", token: C.token, idemKey: key, body: { court_id: sIdem?.court_id, start_at: sIdem?.start_at, confirm_overlap: true } });
check("BK-31", "same Idempotency-Key + different body → 422", i3, { status: 422, code: "VALIDATION" });
const D = await newMember();
const i4 = await hold(D.token, sIdem, {}, { idem: false, idemKey: key });
check("BK-32", "ANOTHER member re-using C's Idempotency-Key must not receive C's booking", i4, {
  test: (r) => r.data?.booking?.user_id !== C.user.id,
  why: "idempotency keys should be scoped per user; a replay leaked another member's booking",
});

// ───────────────────────────── 4. Confirm ─────────────────────────────
const hid = target.h.data?.booking?.id;
check("BK-40", "member confirm with method=cash → 403 (only staff can post cash)", await confirm(A.token, hid, "cash"), { status: 403 });
check("BK-41", "member confirm with method=card → 403", await confirm(A.token, hid, "card"), { status: 403 });
check("BK-42", "member confirm with method=gateway → 403", await confirm(A.token, hid, "gateway"), { status: 403 });
check("BK-43", "member confirms someone else's hold → 403", await confirm(B.token, hid, "transfer"), { status: 403 });
check("BK-44", "confirm unknown booking → 404", await confirm(A.token, IDS.nonexistent, "transfer"), { status: 404 });
check("BK-45", "receptionist cannot call the member confirm → 403", await confirm(rec.token, hid, "transfer"), { status: 403 });
check("BK-46", "quota confirm with no plan hours → BR-13", await confirm(A.token, hid, "quota"), { status: 422, br: "BR-13" });
check("BK-47", "confirm without Idempotency-Key → 422", await api(`/bookings/${hid}/confirm`, { method: "POST", token: A.token, body: { method: "transfer" } }), { status: 422 });

const tr = await confirm(A.token, hid, "transfer");
check("BK-48", "transfer → 202 awaiting_transfer, hold extended to ~120 min, nothing paid yet", tr, {
  status: 202,
  test: (r) => {
    const ms = Date.parse(r.data.hold_until) - Date.now();
    return r.data.awaiting_transfer === true && r.data.payment === null && ms > 110 * 60_000 && ms < 125 * 60_000;
  },
  why: "awaiting_transfer=true, payment=null, hold_until ≈ now + transfer_hold_minutes(120)",
});
check("BK-49", "confirming again while reception checks the bank → 409", await confirm(A.token, hid, "transfer"), { status: 409, code: "CONFLICT_STATE" });
const pend = await api("/payments/pending", { token: rec.token });
check("BK-50", "receptionist sees the booking in the pending list", pend, {
  status: 200,
  test: (r) => JSON.stringify(r.data).includes(hid),
  why: "GET /payments/pending must list bookings awaiting a transfer",
});
check("BK-51", "member cannot mark their own transfer as received → 403", await api(`/bookings/${hid}/transfer-confirm`, { method: "POST", token: A.token }), { status: 403 });
check("BK-52", "coach cannot confirm a transfer → 403", await api(`/bookings/${hid}/transfer-confirm`, { method: "POST", token: coach.token }), { status: 403 });
const tc = await api(`/bookings/${hid}/transfer-confirm`, { method: "POST", token: rec.token });
check("BK-53", "receptionist confirms the transfer → 200, booking confirmed, paid = due now, invoice issued", tc, {
  status: 200,
  test: (r) =>
    r.data.booking?.status === "confirmed" &&
    r.data.booking.paid_vnd === target.h.data.due_now_vnd &&
    !!r.data.invoice_id &&
    r.data.payment?.status === "posted",
  why: "status confirmed, paid_vnd = due_now_vnd from the hold, invoice_id set, payment posted",
});
check("BK-54", "transfer-confirm twice → 409", await api(`/bookings/${hid}/transfer-confirm`, { method: "POST", token: rec.token }), { status: 409 });
check("BK-55", "transfer-confirm unknown booking → 404", await api(`/bookings/${IDS.nonexistent}/transfer-confirm`, { method: "POST", token: rec.token }), { status: 404 });

// Transfer rejected by reception → slot released.
const E = await newMember();
const sRej = await freeSlot(mgr.token, { daysAhead: 2, peak: false });
const hr = await hold(E.token, sRej);
check("BK-56", "transfer-reject on a hold with no transfer request → 409", await api(`/bookings/${hr.data?.booking?.id}/transfer-reject`, { method: "POST", token: rec.token, body: {} }), { status: 409 });
await confirm(E.token, hr.data?.booking?.id, "transfer");
const rj = await api(`/bookings/${hr.data?.booking?.id}/transfer-reject`, { method: "POST", token: rec.token, body: { reason: "No money arrived" } });
check("BK-57", "receptionist rejects the transfer → 200 released", rj, { status: 200, test: (r) => r.data.released === true, why: "released: true" });
check("BK-58", "rejected booking is cancelled", await getB(E.token, hr.data?.booking?.id), { status: 200, test: (r) => r.data.status === "cancelled", why: "status cancelled" });
check("BK-59", "member cannot reject a transfer → 403", await api(`/bookings/${hr.data?.booking?.id}/transfer-reject`, { method: "POST", token: E.token, body: {} }), { status: 403 });

// Quota (plan hours) confirm.
const meBefore = await api("/me", { token: planMember.token });
const hoursBefore = Number(meBefore.data?.subscriptions?.find((x) => x.status === "active")?.court_hours_left ?? NaN);
const sQ = await freeSlotAnyDay(mgr.token, { peak: false, member: planMember.token }, { fromDay: 2 });
const hq = await hold(planMember.token, sQ);
check("BK-60", "member with All-access plan gets the plan's court discount on the hold", hq, {
  status: 201,
  test: (r) => r.data.price < r.data.list_price,
  why: "price < list_price because the plan has court_discount_pct > 0",
});
const cq = await confirm(planMember.token, hq.data?.booking?.id, "quota");
check("BK-61", "quota confirm → 200, paid 0, quota_hours 1", cq, {
  status: 200,
  test: (r) => r.data.booking?.status === "confirmed" && Number(r.data.booking.quota_hours) === 1 && r.data.booking.paid_vnd === 0,
  why: "status confirmed, quota_hours=1, paid_vnd=0",
});
const meAfter = await api("/me", { token: planMember.token });
const hoursAfter = Number(meAfter.data?.subscriptions?.find((x) => x.status === "active")?.court_hours_left ?? NaN);
check("BK-62", "quota confirm took exactly 1 court hour off the plan", meAfter, {
  test: () => hoursAfter === hoursBefore - 1,
  why: `court_hours_left ${hoursBefore} → ${hoursAfter}, expected ${hoursBefore - 1}`,
});

// ───────────────────────────── 5. BR-05: at most 2 confirmed slots a day ─────────────────────────────
const F = await newMember();
const day = 6;
const f1 = await paidBooking(F, await freeSlot(mgr.token, { daysAhead: day, peak: false }));
const f2 = await paidBooking(F, await freeSlot(mgr.token, { daysAhead: day, peak: false }));
if (f1.booking && f2.booking) {
  check("BK-65", "3rd booking on the same day → BR-05", await hold(F.token, await freeSlot(mgr.token, { daysAhead: day, peak: false })), { status: 422, br: "BR-05" });
  check("BK-66", "a booking on another day is still allowed", await hold(F.token, await freeSlot(mgr.token, { daysAhead: day - 1, peak: false })), { status: 201 });
} else blocked("BK-65", "BR-05 daily limit", `could not make 2 paid bookings: ${f1.error ?? ""} ${f2.error ?? ""}`);

// ───────────────────────────── 6. BR-09: clash with a class the member is in ─────────────────────────────
// A fresh member with a badminton plan joins an open badminton class that has a
// seat, then tries to hold a DIFFERENT court at the time of one of its sessions.
const Q = await memberWithPlan(mgr.token, IDS.planBadminton30);
const openClasses = ((await api("/classes", { token: mgr.token })).data?.items ?? []).filter(
  (c) => c.sport === "badminton" && c.status === "open" && c.enrolled_count < c.capacity,
);
let sClash = null;
let clashClass = null;
for (const cl of openClasses) {
  const hour = Number(/BYHOUR=(\d+)/.exec(cl.rrule)?.[1]);
  for (let d = 1; d <= 6 && !sClash; d++) {
    const o = await api(`/occupancy?date=${ictDate(d)}`, { token: mgr.token });
    const sess = o.data?.slots?.find((x) => x.kind === "session" && x.court_id === cl.court_id && new Date(Date.parse(x.start) + 7 * 3600_000).getUTCHours() === hour);
    if (sess) sClash = await freeSlot(mgr.token, { daysAhead: d, hours: [hour], notCourt: cl.court_id });
  }
  if (sClash) {
    clashClass = cl;
    break;
  }
}
if (sClash) {
  check("BK-69", `setup: plan member enrols in class ${clashClass.code} → 201, not waitlisted`, await api(`/classes/${clashClass.id}/enroll`, { method: "POST", token: Q.token, body: {} }), {
    status: 201,
    test: (r) => r.data.enrollment?.status === "confirmed" && !r.data.waitlisted,
    why: "enrollment.status confirmed",
  });
  const c1 = await hold(Q.token, sClash);
  check("BK-70", "hold that clashes with the member's own class → BR-09 with requires_confirm", c1, {
    status: 422,
    br: "BR-09",
    test: (r) => r.data.requires_confirm === true,
    why: "requires_confirm: true",
  });
  const c2 = await hold(Q.token, sClash, { confirm_overlap: true });
  check("BK-71", "same hold with confirm_overlap:true → 201", c2, { status: 201 });
  if (c2.status === 201) await api(`/bookings/${c2.data.booking.id}/cancel`, { method: "POST", token: Q.token, body: {} });
} else blocked("BK-70", "BR-09 class clash", "no open badminton class with a seat and a session in the next 6 days with a free court beside it");

// ───────────────────────────── 7. Promo codes on a booking (BR-40/41/42) ─────────────────────────────
const G = await newMember();
const sOff = await freeSlot(mgr.token, { daysAhead: 2, peak: false });
const p1 = await hold(G.token, sOff, { promo_code: "welcome10" });
check("PR-01", "WELCOME10 (lower-case) on an off-peak slot → 10% off", p1, {
  status: 201,
  test: (r) => r.data.promo?.code === "WELCOME10" && r.data.price === r.data.list_price - r.data.promo.discount_vnd && r.data.promo.discount_vnd === Math.round(r.data.list_price * 0.1),
  why: "promo.code WELCOME10, discount = 10% of list price, price = list − discount",
});
check("PR-02", "SUMMER50K is for plans only → BR-40", await hold(G.token, sOff, { promo_code: "SUMMER50K" }), { status: 422, br: "BR-40" });
check("PR-03", "TET2026 is paused → BR-40", await hold(G.token, sOff, { promo_code: "TET2026" }), { status: 422, br: "BR-40" });
check("PR-04", "unknown code NOPE123 → BR-40", await hold(G.token, sOff, { promo_code: "NOPE123" }), { status: 422, br: "BR-40" });
check("PR-05", "VIP15 needs an order ≥100,000đ; off-peak 80,000đ → BR-40", await hold(G.token, sOff, { promo_code: "VIP15" }), { status: 422, br: "BR-40" });
// Badminton 10 sessions: 10% off courts. WELCOME10 does not stack: the member gets
// whichever is better, and an equal code is refused (BR-42).
const R = await memberWithPlan(mgr.token, IDS.planBadminton10Sessions);
check("PR-06", "plan member (10% plan discount) + WELCOME10 (10%, not stackable, not better) → BR-42", await hold(R.token, await freeSlotAnyDay(mgr.token, { peak: false }), { promo_code: "WELCOME10" }), { status: 422, br: "BR-42" });
const sPk1 = await freeSlotAnyDay(mgr.token, { peak: true }, { fromDay: 2 });
check("PR-09", "plan member (10%) + VIP15 (15%) on peak → the better code wins: price = list − 15%", await hold(R.token, sPk1, { promo_code: "VIP15" }), {
  status: 201,
  test: (r) => r.data.price === r.data.list_price - Math.min(60000, Math.round((r.data.list_price * 0.15) / 1000) * 1000),
  why: "not stacked: 15% of list replaces the plan's 10% (140,000 → 119,000)",
});
// Use WELCOME10 for real, then try it again (max 1 per member).
const p7 = await paidBooking(G, await freeSlot(mgr.token, { daysAhead: 2, peak: false }), { promo_code: "WELCOME10" });
if (p7.booking) {
  check("PR-07", "WELCOME10 a second time by the same member → BR-40 (already used)", await hold(G.token, await freeSlot(mgr.token, { daysAhead: 4, peak: false }), { promo_code: "WELCOME10" }), { status: 422, br: "BR-40" });
} else blocked("PR-07", "WELCOME10 reuse", p7.error);
const sPk2 = await freeSlot(mgr.token, { daysAhead: 4, peak: true });
if (sPk2) {
  check("PR-08", "VIP15 on a peak slot (140,000đ) → 15% off = 21,000đ", await hold(B.token, sPk2, { promo_code: "VIP15" }), {
    status: 201,
    test: (r) => r.data.promo?.discount_vnd === Math.min(60000, Math.round(r.data.list_price * 0.15)),
    why: "discount = min(60,000, 15% of list price)",
  });
} else blocked("PR-08", "VIP15 on peak", "no free peak slot 4 days ahead");

// ───────────────────────────── 8. Read / cancel quote / cancel ─────────────────────────────
const H = await newMember();
const far = await paidBooking(H, await freeSlot(mgr.token, { daysAhead: 4, peak: false }));
const farId = far.booking?.id;
check("BK-80", "owner reads own booking → 200", await getB(H.token, farId), { status: 200 });
check("BK-81", "another member reads it → 403", await getB(A.token, farId), { status: 403 });
check("BK-82", "receptionist reads it → 200", await getB(rec.token, farId), { status: 200 });
check("BK-83", "coach reads a member's court booking → 403", await getB(coach.token, farId), {
  status: 403,
  why: "coaches have no business with members' court bookings (no requireRole in bookingGet)",
});
check("BK-84", "unknown booking → 404", await getB(H.token, IDS.nonexistent), { status: 404 });
check("BK-85", "cancel-quote by another member → 403", await api(`/bookings/${farId}/cancel-quote`, { token: A.token }), { status: 403 });
check("BK-86", "coach asks the cancel-quote of a member's booking → 403", await api(`/bookings/${farId}/cancel-quote`, { token: coach.token }), { status: 403 });
const q100 = await api(`/bookings/${farId}/cancel-quote`, { token: H.token });
check("BK-87", "cancel-quote >24h before start → refund 100%, fee 0", q100, {
  status: 200,
  test: (r) => r.data.refund_pct === 100 && r.data.fee_vnd === 0 && r.data.refund_vnd === r.data.paid_vnd && Array.isArray(r.data.tiers),
  why: "refund_pct 100, fee 0, refund = paid, tiers listed",
});
check("BK-88", "member cannot waive the fee (?waive=1 is ignored for members)", await api(`/bookings/${farId}/cancel-quote?waive=1`, { token: H.token }), {
  status: 200,
  test: (r) => r.data.waived === false,
  why: "waived false",
});
// The coach tries a separate booking, so a coach cancel that wrongly succeeds does not break BK-90.
const H2 = await newMember();
const victim = await paidBooking(H2, await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 4 }));
check("BK-89", "coach cannot cancel a member's booking → 403", await api(`/bookings/${victim.booking?.id}/cancel`, { method: "POST", token: coach.token, body: {} }), {
  status: 403,
  why: "bookingsCancel has no requireRole: a coach passes straight through",
});
const c100 = await api(`/bookings/${farId}/cancel`, { method: "POST", token: H.token, body: { reason: "test" } });
check("BK-90", "owner cancels >24h → 200, refund payment of the full amount", c100, {
  status: 200,
  test: (r) => r.data.refundable === true && r.data.refund?.amount_vnd === -far.booking?.paid_vnd,
  why: "refund.amount_vnd = −paid_vnd",
});
check("BK-91", "booking is now cancelled", await getB(H.token, farId), { status: 200, test: (r) => r.data.status === "cancelled", why: "status cancelled" });
check("BK-92", "cancel twice → 409", await api(`/bookings/${farId}/cancel`, { method: "POST", token: H.token, body: {} }), { status: 409, code: "CONFLICT_STATE" });
check("BK-93", "cancel-quote on a cancelled booking → 409", await api(`/bookings/${farId}/cancel-quote`, { token: H.token }), { status: 409 });
check("BK-94", "cancel unknown → 404", await api(`/bookings/${IDS.nonexistent}/cancel`, { method: "POST", token: H.token, body: {} }), { status: 404 });

// Quota booking cancelled early → the hour goes back to the plan.
if (cq.status === 200) {
  const cqc = await api(`/bookings/${hq.data.booking.id}/cancel`, { method: "POST", token: planMember.token, body: {} });
  const back = Number((await api("/me", { token: planMember.token })).data?.subscriptions?.find((x) => x.status === "active")?.court_hours_left ?? NaN);
  check("BK-95", "cancelling a quota booking ≥4h ahead gives the court hour back", cqc, {
    status: 200,
    test: (r) => r.data.refund?.kind === "quota" && r.data.refund.hours === 1 && back === hoursBefore,
    why: `refund {kind:'quota', hours:1} and court_hours_left back to ${hoursBefore} (now ${back})`,
  });
}

// Middle tier: 4–24 h before start → 50%.
const I = await newMember();
const mid = await freeSlotAnyDay(mgr.token, { minAheadH: 5, maxAheadH: 23 }, { fromDay: 0, maxDays: 1 });
if (mid) {
  const pb = await paidBooking(I, mid);
  const q = await api(`/bookings/${pb.booking?.id}/cancel-quote`, { token: I.token });
  check("BK-96", "cancel-quote 4–24h before start → 50%", q, { status: 200, test: (r) => r.data.refund_pct === 50, why: "refund_pct 50" });
  const qw = await api(`/bookings/${pb.booking?.id}/cancel-quote?waive=1`, { token: rec.token });
  check("BK-97", "receptionist with ?waive=1 → 100%, waived:true", qw, { status: 200, test: (r) => r.data.refund_pct === 100 && r.data.waived === true, why: "refund_pct 100, waived true" });
} else blocked("BK-96", "50% cancel tier", "no free slot 5–23 h from now");

// Last tier: under 4 h → 0%.
const J = await newMember();
const soon = await freeSlot(mgr.token, { daysAhead: 0, minAheadH: 0.6, maxAheadH: 3.5 });
if (soon) {
  const pb = await paidBooking(J, soon);
  const q = await api(`/bookings/${pb.booking?.id}/cancel-quote`, { token: J.token });
  check("BK-98", "cancel-quote <4h before start → 0%, fee = paid", q, { status: 200, test: (r) => r.data.refund_pct === 0 && r.data.fee_vnd === r.data.paid_vnd, why: "refund_pct 0" });
  check("BK-99", "reschedule within 2 h of start → 409 (cancel_court_hours=2)", await api(`/bookings/${pb.booking?.id}/reschedule`, { method: "POST", token: J.token, body: { start_at: slot(3, 7) } }), {
    status: (Date.parse(soon.start_at) - Date.now()) / 3600_000 < 2 ? 409 : [200, 409, 422],
  });
} else {
  const why = `no free slot 0.6–3.5 h from now (ICT hour ${ictHour()})`;
  blocked("BK-98", "0% cancel tier", why);
  blocked("BK-99", "reschedule within 2 h of start", why);
}

// ───────────────────────────── 9. Reschedule ─────────────────────────────
const K = await newMember();
// A weekday (off-peak 09–14 exists only on weekdays), at least 3 days ahead so every window rule is far away.
const rsSlot = await freeSlotAnyDay(mgr.token, { peak: false, hours: [9, 10, 11, 12, 13, 14] }, { fromDay: 3 });
const rsDay = rsSlot?.daysAhead ?? 5;
const rs = await paidBooking(K, rsSlot);
const rsId = rs.booking?.id;
const rsUrl = `/bookings/${rsId}/reschedule`;
if (!rs.booking) blocked("BK-100", "reschedule cases", `could not make K's paid booking: ${rs.error}`);
check("BK-100", "reschedule without start_at → 400 field start_at", await api(rsUrl, { method: "POST", token: K.token, body: {} }), { status: 400, test: (r) => r.data.field === "start_at", why: "field start_at" });
check("BK-101", "reschedule with start_at='abc' → 400", await api(rsUrl, { method: "POST", token: K.token, body: { start_at: "abc" } }), { status: 400 });
check("BK-102", "reschedule to the same slot → 400", await api(rsUrl, { method: "POST", token: K.token, body: { start_at: rs.booking?.start_at } }), { status: 400 });
check("BK-103", "reschedule to a basketball court → 400 field court_id", await api(rsUrl, { method: "POST", token: K.token, body: { start_at: slot(rsDay, 7), court_id: IDS.courtBR01 } }), { status: 400, test: (r) => r.data.field === "court_id", why: "field court_id" });
check("BK-104", "another member reschedules it → 403", await api(rsUrl, { method: "POST", token: A.token, body: { start_at: slot(rsDay, 7) } }), { status: 403 });
check("BK-105", "receptionist cannot use the member reschedule → 403", await api(rsUrl, { method: "POST", token: rec.token, body: { start_at: slot(rsDay, 7) } }), { status: 403 });
check("BK-106", "reschedule into the past → BR-07", await api(rsUrl, { method: "POST", token: K.token, body: { start_at: slot(-1, 10) } }), { status: 422, br: "BR-07" });
const peakTarget = await freeSlot(mgr.token, { daysAhead: rsDay, peak: true });
if (peakTarget) {
  check("BK-107", "move off-peak → peak (different price) → 409 with new_price_vnd", await api(rsUrl, { method: "POST", token: K.token, body: { start_at: peakTarget.start_at, court_id: peakTarget.court_id } }), {
    status: 409,
    test: (r) => typeof r.data.new_price_vnd === "number" || JSON.stringify(r.data).includes("new_price_vnd"),
    why: "body carries paid_vnd and new_price_vnd",
  });
} else blocked("BK-107", "reschedule to a peak slot", `no free peak badminton slot on ${ictDate(rsDay)}`);
const occ = await api(`/occupancy?date=${ictDate(rsDay)}`, { token: mgr.token });
const taken = occ.data?.slots?.find((x) => x.kind === "booking" && x.ref !== rsId && x.court_id.startsWith("10000000") && occ.data.courts.find((c) => c.id === x.court_id)?.sport === "badminton" && !isPeak(rsDay, new Date(Date.parse(x.start) + 7 * 3600_000).getUTCHours()));
if (taken) {
  check("BK-108", "move onto a slot someone else has → 409 CONFLICT_SLOT", await api(rsUrl, { method: "POST", token: K.token, body: { start_at: taken.start, court_id: taken.court_id } }), { status: 409, code: "CONFLICT_SLOT" });
} else blocked("BK-108", "reschedule onto a taken slot", `no off-peak badminton booking found on ${ictDate(rsDay)}`);
const okTarget = await freeSlot(mgr.token, { daysAhead: rsDay, peak: false, notCourt: rs.booking?.court_id });
if (okTarget) {
  const mv = await api(rsUrl, { method: "POST", token: K.token, body: { start_at: okTarget.start_at, court_id: okTarget.court_id } });
  check("BK-109", "valid move (off-peak → off-peak, other court) → 200", mv, {
    status: 200,
    test: (r) => r.data.booking?.court_id === okTarget.court_id && Date.parse(r.data.booking.start_at) === Date.parse(okTarget.start_at),
    why: "booking now on the new court and time",
  });
  check("BK-110", "the old slot is free again (someone else can hold it)", await hold(B.token, { court_id: rs.booking?.court_id, start_at: rs.booking?.start_at }), { status: 201 });
} else blocked("BK-109", "valid reschedule", `no second free off-peak slot on ${ictDate(rsDay)}`);
const kHold = await hold(K.token, await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 2 }));
check("BK-111", "reschedule a HOLD (not confirmed yet) → 409", await api(`/bookings/${kHold.data?.booking?.id}/reschedule`, { method: "POST", token: K.token, body: { start_at: slot(2, 7) } }), { status: 409 });

// ───────────────────────────── 10. Check-in (BR-11, window −15/+10 min) ─────────────────────────────
const L = await newMember();
const ci = await paidBooking(L, await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 2 }));
check("BK-120", "member cannot check a booking in → 403", await api(`/bookings/${ci.booking?.id}/check-in`, { method: "POST", token: L.token }), { status: 403 });
check("BK-121", "check-in days before the booking → BR-11", await api(`/bookings/${ci.booking?.id}/check-in`, { method: "POST", token: rec.token }), { status: 422, br: "BR-11" });
check("BK-122", "check-in unknown booking → 404", await api(`/bookings/${IDS.nonexistent}/check-in`, { method: "POST", token: rec.token }), { status: 404 });
const holdOnly = await hold(L.token, await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 2 }));
check("BK-123", "check-in a HOLD → 409", await api(`/bookings/${holdOnly.data?.booking?.id}/check-in`, { method: "POST", token: rec.token }), { status: 409 });

// In-window check-in needs a booking starting within −15/+10 min of now: made as a walk-in.
const nowIct = new Date(Date.now() + 7 * 3600_000);
const hh = nowIct.getUTCHours();
const mm = nowIct.getUTCMinutes();
let ciHour = null;
let expectOk = null;
if (mm <= 8) [ciHour, expectOk] = [hh, true];
else if (mm >= 47) [ciHour, expectOk] = [hh + 1, true];
else if (mm >= 12 && mm <= 38) [ciHour, expectOk] = [hh, false];
if (ciHour !== null && ciHour >= 6 && ciHour <= 21) {
  const sNow = await freeSlot(mgr.token, { daysAhead: 0, hours: [ciHour], minAheadH: -1 });
  if (sNow) {
    const w = await api("/walk-in", { method: "POST", token: mgr.token, idem: true, body: { court_id: sNow.court_id, start_at: sNow.start_at, guest_name: "Check-in Test", guest_phone: `09${String(Date.now()).slice(-8)}`, method: "cash" } });
    if (w.status === 201) {
      const r = await api(`/bookings/${w.data.booking.id}/check-in`, { method: "POST", token: rec.token });
      if (expectOk) {
        check("BK-124", "check-in inside the −15/+10 min window → 200 in_use", r, { status: 200, test: (x) => x.data.status === "in_use", why: "status in_use" });
        check("BK-125", "check-in twice → 409", await api(`/bookings/${w.data.booking.id}/check-in`, { method: "POST", token: rec.token }), { status: 409 });
      } else {
        check("BK-124", "check-in more than 10 min after start → BR-11 (no-show window)", r, { status: 422, br: "BR-11" });
        blocked("BK-125", "check-in twice → 409", "first check-in rejected because outside window (BR-11)");
      }
    } else {
      blocked("BK-124", "check-in in window", `walk-in failed: ${w.status} ${JSON.stringify(w.data)}`);
      blocked("BK-125", "check-in twice → 409", `walk-in failed: ${w.status}`);
    }
  } else {
    blocked("BK-124", "check-in in window", `no free court at ${ciHour}:00 today`);
    blocked("BK-125", "check-in twice → 409", `no free court at ${ciHour}:00 today`);
  }
} else {
  blocked("BK-124", "check-in in window", `ICT time ${hh}:${String(mm).padStart(2, "0")} — run between hh:47 and hh:08, or hh:12–hh:38, inside 06:00–22:00`);
  blocked("BK-125", "check-in twice → 409", `ICT time ${hh}:${String(mm).padStart(2, "0")} — outside allowed check-in window`);
}

// ───────────────────────────── 11. Collect the balance of a deposit booking ─────────────────────────────
const M = await newMember();
const sDep = await freeSlotAnyDay(mgr.token, { peak: true }, { fromDay: 2 });
if (sDep) {
  const dep = await paidBooking(M, sDep);
  const id = dep.booking?.id;
  check("BK-130", "peak booking paid by transfer: only the 30% deposit is paid", { status: dep.booking ? 200 : 0, data: dep.booking ?? dep, request: {} }, {
    test: () => dep.booking && dep.booking.paid_vnd === dep.hold.deposit_vnd && dep.booking.paid_vnd < dep.booking.price_vnd,
    why: "paid_vnd = deposit_vnd < price_vnd",
  });
  const cb = (tok, body) => api(`/bookings/${id}/collect-balance`, { method: "POST", token: tok, body });
  check("BK-131", "member cannot collect a balance → 403", await cb(M.token, { method: "cash" }), { status: 403 });
  check("BK-132", "method=bitcoin → 422", await cb(mgr.token, { method: "bitcoin" }), { status: 422 });
  const shift2 = await api("/shifts/current", { token: (await login(PHONES.receptionist2)).token });
  if (shift2.status === 404 || (shift2.status === 200 && !shift2.data?.shift && !shift2.data?.id)) {
    check("BK-133", "receptionist with no open till shift → BR-44", await cb((await login(PHONES.receptionist2)).token, { method: "cash" }), { status: 422, br: "BR-44" });
  } else blocked("BK-133", "BR-44 on collect-balance", `receptionist2 seems to have an open shift: ${JSON.stringify(shift2.data).slice(0, 200)}`);
  const ok = await cb(mgr.token, { method: "cash" });
  check("BK-134", "manager collects the rest → 200, amount = price − deposit, invoice", ok, {
    status: 200,
    test: (r) => r.data.amount_vnd === dep.booking.price_vnd - dep.booking.paid_vnd && r.data.booking?.paid_vnd === r.data.booking?.price_vnd && !!r.data.invoice_id,
    why: "amount_vnd = price − deposit; booking fully paid; invoice_id",
  });
  check("BK-135", "collect again → 409 nothing left", await cb(mgr.token, { method: "cash" }), { status: 409 });
} else blocked("BK-130", "deposit + collect balance", "no free peak slot in the next days");
check("BK-136", "collect-balance on a hold → 409", await api(`/bookings/${holdOnly.data?.booking?.id}/collect-balance`, { method: "POST", token: mgr.token, body: { method: "cash" } }), { status: 409 });

// ───────────────────────────── 12. Member's own list ─────────────────────────────
const mine = await api("/me/bookings", { token: K.token });
check("BK-140", "GET /me/bookings lists only the caller's bookings", mine, {
  status: 200,
  test: (r) => Array.isArray(r.data.items) && r.data.items.length >= 1 && r.data.items.every((b) => b.id !== farId),
  why: "items[] has K's booking and none of H's",
});
check("BK-141", "GET /me/bookings carries the cancel policy", mine, {
  test: (r) => r.data.window_hours === 2 && Array.isArray(r.data.cancel_tiers),
  why: "window_hours 2 and cancel_tiers[]",
});

summary();
