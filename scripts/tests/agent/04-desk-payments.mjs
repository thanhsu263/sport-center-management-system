/**
 * Suite 04 — the front desk: till shifts, walk-ins, taking payment, refunds
 * (with the manager sign-off), the "waiting on money" queue, plan-order
 * decline, invoices (PDF, XML, CSV export).
 *
 *   node scripts/tests/agent/04-desk-payments.mjs
 *
 * Needs the safe server (scripts/tests/start-safe-server.mjs) on a FRESH
 * database: it opens and closes receptionist2's till, so a second run on the
 * same server starts from a different state. Restart the server first.
 *
 * Case IDs: SH-xx (shifts), WI-xx (walk-in), PY-xx (payments), RF-xx (refunds),
 * PQ-xx (pending queue / decline), IV-xx (invoices).
 */
import {
  api,
  blocked,
  check,
  freeSlot,
  freeSlotAnyDay,
  IDS,
  login,
  memberWithPlan,
  newMember,
  PHONES,
  slot,
  summary,
} from "../agent-lib.mjs";

const mgr = await login(PHONES.manager);
const rec = await login(PHONES.receptionist); // never opens a till in this suite → BR-44 cases
const rec2 = await login(PHONES.receptionist2); // opens, uses and closes a till
const coach = await login(PHONES.coach);
const bao = await login(PHONES.memberNoPlan);

const walkIn = (tok, body, opts = {}) => api("/walk-in", { method: "POST", token: tok, idem: true, ...opts, body });
const pay = (tok, body, opts = {}) => api("/payments", { method: "POST", token: tok, idem: true, ...opts, body });
const guestPhone = () => `09${String(Date.now()).slice(-8)}`;
const settings = (await api("/settings", { token: mgr.token })).data;
const REFUND_LIMIT = Number(settings.refund_manager_vnd); // 1,000,000đ on the seed

// ───────────────────────────── 1. Till shifts ─────────────────────────────
check("SH-01", "coach cannot open a till shift → 403", await api("/shifts/open", { method: "POST", token: coach.token }), { status: 403 });
check("SH-02", "member cannot open a till shift → 403", await api("/shifts/open", { method: "POST", token: bao.token }), { status: 403 });
check("SH-03", "manager cannot open a till shift (receptionists only) → 403", await api("/shifts/open", { method: "POST", token: mgr.token }), { status: 403 });
check("SH-04", "open a shift without login → 401", await api("/shifts/open", { method: "POST" }), { status: 401 });
check("SH-05", "GET /shifts/current with no shift open → 404 NOT_FOUND", await api("/shifts/current", { token: rec2.token }), { status: 404, code: "NOT_FOUND" });
check("SH-06", "GET /shifts/current?optional=1 with no shift → 200 {shift:null}", await api("/shifts/current?optional=1", { token: rec2.token }), {
  status: 200,
  test: (x) => x.data.shift === null,
  why: "shift is null",
});
check("SH-07", "coach cannot read the current till → 403", await api("/shifts/current", { token: coach.token }), { status: 403 });

// BR-44 before any shift exists for receptionist2.
const sNoShift = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 1 });
check("WI-01", "receptionist with no open till takes a walk-in → BR-44", await walkIn(rec2.token, { court_id: sNoShift?.court_id, start_at: sNoShift?.start_at, guest_name: "No Shift", guest_phone: guestPhone(), method: "cash" }), {
  status: 422,
  br: "BR-44",
});

const opened = await api("/shifts/open", { method: "POST", token: rec2.token });
check("SH-08", "receptionist2 opens a till shift → 201 with shift.id", opened, { status: 201, test: (x) => !!x.data.shift?.id, why: "shift.id present" });
const shiftId = opened.data?.shift?.id;
check("SH-09", "opening a second shift while one is open → 409 CONFLICT_STATE", await api("/shifts/open", { method: "POST", token: rec2.token }), { status: 409, code: "CONFLICT_STATE" });
check("SH-10", "the new shift starts with totals cash 0 / all 0", await api("/shifts/current", { token: rec2.token }), {
  status: 200,
  test: (x) => x.data.shift?.id === shiftId && x.data.totals?.cash === 0 && x.data.totals?.all === 0,
  why: "same shift id, cash 0, all 0",
});

// ───────────────────────────── 2. Walk-in ─────────────────────────────
const w1 = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 1 });
const wiBody = (s, extra = {}) => ({ court_id: s?.court_id, start_at: s?.start_at, guest_name: "Walk In Guest", guest_phone: guestPhone(), method: "cash", ...extra });
check("WI-02", "member cannot sell a walk-in → 403", await walkIn(bao.token, wiBody(w1)), { status: 403 });
check("WI-03", "coach cannot sell a walk-in → 403", await walkIn(coach.token, wiBody(w1)), { status: 403 });
check("WI-04", "walk-in without login → 401", await walkIn(undefined, wiBody(w1)), { status: 401 });
check("WI-05", "walk-in without Idempotency-Key → 422", await api("/walk-in", { method: "POST", token: rec2.token, body: wiBody(w1) }), { status: 422 });
check("WI-06", "walk-in without guest_phone → 422 VALIDATION", await walkIn(rec2.token, wiBody(w1, { guest_phone: undefined })), { status: 422, code: "VALIDATION" });
check("WI-07", "walk-in without guest_name → 422 VALIDATION", await walkIn(rec2.token, wiBody(w1, { guest_name: undefined })), { status: 422, code: "VALIDATION" });
check("WI-08", "walk-in with phone '12345' → 422 VALIDATION", await walkIn(rec2.token, wiBody(w1, { guest_phone: "12345" })), { status: 422, code: "VALIDATION" });
check("WI-09", "walk-in with start_at='abc' → 400/422, never 500", await walkIn(rec2.token, wiBody(w1, { start_at: "abc" })), { status: [400, 422] });
check("WI-10", "walk-in yesterday 10:00 → BR-07", await walkIn(rec2.token, wiBody({ court_id: IDS.courtCL01, start_at: slot(-1, 10) })), { status: 422, br: "BR-07" });
check("WI-11", "walk-in 05:00 tomorrow (before opening) → BR-06", await walkIn(rec2.token, wiBody({ court_id: IDS.courtCL01, start_at: slot(1, 5) })), { status: 422, br: "BR-06" });
check("WI-12", "walk-in on a court that does not exist → 404", await walkIn(rec2.token, wiBody({ court_id: IDS.nonexistent, start_at: w1?.start_at })), { status: 404 });
check("WI-13", "walk-in with method=bitcoin → 400/422 (not a payment method)", await walkIn(rec2.token, wiBody(w1, { method: "bitcoin" })), { status: [400, 422] });

const sold = await walkIn(rec2.token, wiBody(w1, { guest_name: "Cash Guest" }));
check("WI-14", "valid cash walk-in by receptionist2 → 201: booking confirmed, payment posted into her shift, invoice issued", sold, {
  status: 201,
  test: (x) =>
    x.data.booking?.status === "confirmed" &&
    x.data.booking?.channel === "walkin" &&
    x.data.payment?.status === "posted" &&
    x.data.payment?.method === "cash" &&
    x.data.payment?.shift_id === shiftId &&
    Number(x.data.payment?.amount_vnd) === Number(x.data.booking?.price_vnd) &&
    !!x.data.invoice_id,
  why: "confirmed walkin booking, posted cash payment on the open shift, amount = price, invoice_id",
});
const cashTaken = Number(sold.data?.payment?.amount_vnd ?? 0);
const walkPayId = sold.data?.payment?.id;
const walkInvoiceId = sold.data?.invoice_id;
check("WI-15", "a second walk-in on the same court and hour → 409 CONFLICT_SLOT", await walkIn(rec2.token, wiBody(w1)), { status: 409, code: "CONFLICT_SLOT" });

const w2 = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 1 });
const card = await walkIn(rec2.token, wiBody(w2, { method: "card", guest_name: "Card Guest" }));
check("WI-16", "card walk-in → 201 with payment.method card", card, { status: 201, test: (x) => x.data.payment?.method === "card", why: "method card" });
const cardTaken = Number(card.data?.payment?.amount_vnd ?? 0);

// "quota" is the bookkeeping method for plan hours, not money. A walk-in paid
// "by quota" posts a court sale that no till and no revenue line ever counts.
const w3 = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 1 });
check("WI-17", "walk-in with method=quota (plan hours, not money) is refused → 400/422", await walkIn(rec2.token, wiBody(w3, { method: "quota", guest_name: "Quota Guest" })), { status: [400, 422] });

// A member's phone at the desk: the plan's court discount applies.
const planMember = await memberWithPlan(mgr.token, IDS.planAllAccess30); // 15% off courts
const w4 = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 1 });
check("WI-18", "walk-in for a plan member's phone → booking linked to the member with the 15% plan discount", await walkIn(rec2.token, wiBody(w4, { guest_name: planMember.user.full_name, guest_phone: planMember.phone })), {
  status: 201,
  test: (x) => x.data.booking?.user_id === planMember.user.id && Number(x.data.booking?.discount_pct) === 15,
  why: "booking.user_id = member, discount_pct 15",
});

// A walk-in for a member's phone must not cancel an unrelated hold that member
// is in the middle of paying for in the app (known finding F-09).
const X = await newMember();
const xs = await freeSlot(mgr.token, { daysAhead: 3, peak: false });
const xHold = xs ? await api("/bookings", { method: "POST", token: X.token, idem: true, body: { court_id: xs.court_id, start_at: xs.start_at } }) : null;
if (xHold?.status === 201) {
  const w5 = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 1 });
  const wx = await walkIn(rec2.token, wiBody(w5, { guest_name: "X at the desk", guest_phone: X.phone }));
  if (wx.status === 201) {
    check("WI-19", "walk-in for member X on another day leaves X's app hold alone (hold still 'hold')", await api(`/bookings/${xHold.data.booking.id}`, { token: X.token }), {
      status: 200,
      test: (x) => x.data.status === "hold",
      why: "the unrelated hold must not be cancelled by the walk-in (F-09)",
    });
  } else blocked("WI-19", "walk-in vs member hold", `walk-in failed: ${wx.status} ${JSON.stringify(wx.data)}`);
} else blocked("WI-19", "walk-in vs member hold", `X could not hold: ${xHold?.status} ${JSON.stringify(xHold?.data)}`);

// Court in maintenance.
const wm = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 2 });
if (wm) {
  const off = await api(`/courts/${wm.court_id}`, { method: "PATCH", token: mgr.token, body: { status: "maintenance" } });
  if (off.status === 200) {
    check("WI-20", "walk-in on a court in maintenance → BR-06", await walkIn(rec2.token, wiBody(wm)), { status: 422, br: "BR-06" });
  } else blocked("WI-20", "walk-in on a court in maintenance", `PATCH /courts → ${off.status}`);
  check("WI-21", "court back to ready → 200", await api(`/courts/${wm.court_id}`, { method: "PATCH", token: mgr.token, body: { status: "ready" } }), { status: 200 });
} else blocked("WI-20", "walk-in on a court in maintenance", "no free slot");

check("SH-11", "till totals: cash = the cash walk-in, all = cash + card", await api("/shifts/current", { token: rec2.token }), {
  status: 200,
  test: (x) => x.data.totals?.cash >= cashTaken && x.data.totals?.all >= cashTaken + cardTaken && x.data.totals.all > x.data.totals.cash,
  why: `cash ≥ ${cashTaken}, all ≥ ${cashTaken + cardTaken}, all > cash`,
});

// ───────────────────────────── 3. Taking payment (POST /payments) ─────────────────────────────
const M1 = await newMember();
const sub1 = await api("/subscriptions", { method: "POST", token: mgr.token, body: { plan_id: IDS.planBadminton30, user_id: M1.user.id } });
check("PY-01", "setup: manager raises a Badminton 30 days order for M1 → 201 pending, amount_due 800,000", sub1, {
  status: 201,
  test: (x) => x.data.subscription?.status === "pending" && x.data.amount_due_vnd === 800000,
  why: "pending, 800000",
});
const sub1Id = sub1.data?.subscription?.id;
const subPay = (amount, extra = {}) => ({ ref_type: "subscription", ref_id: sub1Id, method: "cash", amount_vnd: amount, ...extra });

check("PY-02", "member cannot post a payment → 403", await pay(M1.token, subPay(800000)), { status: 403 });
check("PY-03", "coach cannot post a payment → 403", await pay(coach.token, subPay(800000)), { status: 403 });
check("PY-04", "payment without login → 401", await pay(undefined, subPay(800000)), { status: 401 });
check("PY-05", "payment without Idempotency-Key → 422", await api("/payments", { method: "POST", token: mgr.token, body: subPay(800000) }), { status: 422 });
check("PY-06", "payment with no fields → 422 VALIDATION", await pay(mgr.token, {}), { status: 422, code: "VALIDATION" });
check("PY-07", "amount 0 → 400 field amount_vnd", await pay(mgr.token, subPay(0)), { status: 400, test: (x) => x.data.field === "amount_vnd", why: "field amount_vnd" });
check("PY-08", "amount −5,000 → 400 field amount_vnd", await pay(mgr.token, subPay(-5000)), { status: 400, test: (x) => x.data.field === "amount_vnd", why: "field amount_vnd" });
check("PY-09", "amount 1.5 (not whole đồng) → 400", await pay(mgr.token, subPay(1.5)), { status: 400 });
check("PY-10", "amount 2,000,000,001 → 400", await pay(mgr.token, subPay(2_000_000_001)), { status: 400 });
check("PY-11", "amount as text 'abc' → 400/422", await pay(mgr.token, subPay("abc")), { status: [400, 422] });
check("PY-12", "method=bitcoin → 400 VALIDATION", await pay(mgr.token, subPay(800000, { method: "bitcoin" })), { status: [400, 422], code: "VALIDATION" });
check("PY-13", "receptionist with no open till → BR-44", await pay(rec.token, subPay(800000)), { status: 422, br: "BR-44" });
check("PY-14", "subscription that does not exist → 404", await pay(mgr.token, { ...subPay(800000), ref_id: IDS.nonexistent }), { status: 404 });
check("PY-15", "ref_id that is not a UUID → 400", await pay(mgr.token, { ...subPay(800000), ref_id: "abc" }), { status: 400 });
check("PY-16", "partial payment 400,000 of an 800,000 plan → 400 with expected_vnd 800000", await pay(mgr.token, subPay(400000)), {
  status: 400,
  test: (x) => x.data.field === "amount_vnd" && x.data.expected_vnd === 800000,
  why: "field amount_vnd, expected_vnd 800000",
});
check("PY-17", "over-payment 900,000 → 400", await pay(mgr.token, subPay(900000)), { status: 400 });

const p1 = await pay(rec2.token, subPay(800000));
check("PY-18", "receptionist2 (till open) takes the exact 800,000 → 201 posted, on her shift, invoice issued", p1, {
  status: 201,
  test: (x) => x.data.payment?.status === "posted" && x.data.payment?.shift_id === shiftId && x.data.payment?.user_id === M1.user.id && !!x.data.invoice?.id,
  why: "posted, shift_id, user_id = M1, invoice",
});
const me1 = await api("/me", { token: M1.token });
const act1 = me1.data?.subscriptions?.find((s) => s.id === sub1Id);
check("PY-19", "M1's plan is now active", me1, { status: 200, test: () => act1?.status === "active", why: "subscription active" });
check("PY-20", "a second payment on an ACTIVE plan is a renewal: end date moves 30 days later", await (async () => {
  const r = await pay(mgr.token, subPay(800000));
  const after = (await api("/me", { token: M1.token })).data?.subscriptions?.find((s) => s.id === sub1Id);
  r.renewed = { before: act1?.end_on, after: after?.end_on };
  return r;
})(), {
  status: 201,
  test: (x) => x.renewed.before && x.renewed.after && (Date.parse(x.renewed.after) - Date.parse(x.renewed.before)) / 86400000 === 30,
  why: "end_on + 30 days",
});

// Idempotency on payments.
const M5 = await newMember();
const sub5 = await api("/subscriptions", { method: "POST", token: mgr.token, body: { plan_id: IDS.planBadminton30, user_id: M5.user.id } });
const key = crypto.randomUUID();
const body5 = { ref_type: "subscription", ref_id: sub5.data?.subscription?.id, method: "cash", amount_vnd: 800000 };
const i1 = await pay(mgr.token, body5, { idemKey: key });
const i2 = await pay(mgr.token, body5, { idemKey: key });
check("PY-21", "same Idempotency-Key + same body → the first payment is replayed (same id, no second charge)", i2, {
  status: [200, 201],
  test: (x) => i1.status === 201 && x.data.payment?.id === i1.data.payment?.id,
  why: "same payment id",
});
check("PY-22", "same Idempotency-Key + different body → 422", await pay(mgr.token, { ...body5, method: "card" }, { idemKey: key }), { status: 422 });

// A plan-only promo code at the till.
const M6 = await newMember();
const sub6 = await api("/subscriptions", { method: "POST", token: mgr.token, body: { plan_id: IDS.planBadminton30, user_id: M6.user.id } });
const sub6Body = (amount) => ({ ref_type: "subscription", ref_id: sub6.data?.subscription?.id, method: "cash", amount_vnd: amount, promo_code: "SUMMER50K" });
check("PY-23", "SUMMER50K at the till: paying the list price is refused, expected_vnd = 750,000", await pay(mgr.token, sub6Body(800000)), {
  status: 400,
  test: (x) => x.data.expected_vnd === 750000,
  why: "expected_vnd 750000",
});
check("PY-24", "SUMMER50K: paying 750,000 → 201", await pay(mgr.token, sub6Body(750000)), { status: 201 });

// Money that points at nothing. A payment must belong to a real plan or booking.
check("PY-25", "ref_type='anything' with a random ref_id is refused (no phantom revenue) → 400/404/422", await pay(mgr.token, { ref_type: "anything", ref_id: IDS.nonexistent, method: "cash", amount_vnd: 123000 }), {
  status: [400, 404, 422],
});
check("PY-26", "ref_type='booking' with a booking id that does not exist → 404", await pay(mgr.token, { ref_type: "booking", ref_id: IDS.nonexistent, method: "cash", amount_vnd: 80000 }), { status: [404, 422] });
check("PY-27", "method=quota through POST /payments is refused (plan hours are not money) → 400/422", await pay(mgr.token, { ref_type: "booking", ref_id: card.data?.booking?.id ?? IDS.nonexistent, method: "quota", amount_vnd: 1000 }), { status: [400, 422] });
check("PY-28", "manager sends shift_id of a shift that does not exist → 400/404/422, never 500", await pay(mgr.token, { ...body5, ref_id: sub6.data?.subscription?.id, amount_vnd: 800000, shift_id: IDS.nonexistent }), {
  status: [400, 404, 409, 422],
});
check(
  "PY-29",
  "manager cannot post money into receptionist2's till by sending her shift_id (advisory)",
  await (async () => {
    const M7 = await newMember();
    const s7 = await api("/subscriptions", { method: "POST", token: mgr.token, body: { plan_id: IDS.planBadminton30, user_id: M7.user.id } });
    return pay(mgr.token, { ref_type: "subscription", ref_id: s7.data?.subscription?.id, method: "cash", amount_vnd: 800000, shift_id: shiftId });
  })(),
  { test: (x) => x.status !== 201 || x.data.payment?.shift_id !== shiftId, why: "the payment must not land on another person's open shift", advisory: true },
);

// ───────────────────────────── 4. Refunds ─────────────────────────────
// Small refund on the cash walk-in (below the manager limit → posted at once).
check("RF-01", "member cannot refund → 403", await api(`/payments/${walkPayId}/refund`, { method: "POST", token: bao.token, body: { amount_vnd: 1000 } }), { status: 403 });
check("RF-02", "coach cannot refund → 403", await api(`/payments/${walkPayId}/refund`, { method: "POST", token: coach.token, body: { amount_vnd: 1000 } }), { status: 403 });
check("RF-03", "refund amount 0 → 422", await api(`/payments/${walkPayId}/refund`, { method: "POST", token: rec2.token, body: { amount_vnd: 0 } }), { status: 422 });
check("RF-04", "refund with no amount → 422", await api(`/payments/${walkPayId}/refund`, { method: "POST", token: rec2.token, body: {} }), { status: 422 });
check("RF-05", "refund a payment that does not exist → 404", await api(`/payments/${IDS.nonexistent}/refund`, { method: "POST", token: rec2.token, body: { amount_vnd: 1000 } }), { status: 404 });
check("RF-06", "refund with a non-UUID payment id → 400", await api(`/payments/abc/refund`, { method: "POST", token: rec2.token, body: { amount_vnd: 1000 } }), { status: 400 });
check("RF-07", "refund more than was paid → 422", await api(`/payments/${walkPayId}/refund`, { method: "POST", token: rec2.token, body: { amount_vnd: cashTaken + 1000 } }), { status: 422 });
const tillBefore = (await api("/shifts/current", { token: rec2.token })).data?.totals?.cash;
const small = await api(`/payments/${walkPayId}/refund`, { method: "POST", token: rec2.token, body: { amount_vnd: 20000, reason: "Net broke" } });
check("RF-08", `receptionist refunds 20,000 (below the ${REFUND_LIMIT.toLocaleString("en-US")}đ limit) → 201 posted at once, amount −20,000`, small, {
  status: 201,
  test: (x) => x.data.payment?.status === "posted" && Number(x.data.payment?.amount_vnd) === -20000,
  why: "posted, −20000",
});
// The 20,000đ went out of receptionist2's drawer, so her till must expect
// 20,000đ less cash at close — otherwise every cash refund shows as a shortage.
check("RF-13", "a cash refund at the desk lowers the till's expected cash by the same amount", await api("/shifts/current", { token: rec2.token }), {
  status: 200,
  test: (x) => typeof tillBefore === "number" && x.data.totals?.cash === tillBefore - 20000,
  why: `totals.cash should go from ${tillBefore} to ${tillBefore - 20000}`,
});
check("RF-09", "refunding the refund row itself → 422", await api(`/payments/${small.data?.payment?.id}/refund`, { method: "POST", token: rec2.token, body: { amount_vnd: 1000 } }), { status: 422 });
check("RF-10", "refund more than what is left (paid − already refunded) → 422", await api(`/payments/${walkPayId}/refund`, { method: "POST", token: rec2.token, body: { amount_vnd: cashTaken - 20000 + 1000 } }), { status: 422 });
check("RF-11", "manager refunds exactly the rest → 201", await api(`/payments/${walkPayId}/refund`, { method: "POST", token: mgr.token, body: { amount_vnd: cashTaken - 20000 } }), { status: 201 });
check("RF-12", "another 1,000 after a full refund → 422 (already refunded in full)", await api(`/payments/${walkPayId}/refund`, { method: "POST", token: mgr.token, body: { amount_vnd: 1000 } }), { status: 422 });

// Large refund → manager sign-off.
const M2 = await newMember();
const sub2 = await api("/subscriptions", { method: "POST", token: mgr.token, body: { plan_id: IDS.planAllAccess30, user_id: M2.user.id } });
const p2 = await pay(mgr.token, { ref_type: "subscription", ref_id: sub2.data?.subscription?.id, method: "cash", amount_vnd: 1500000 });
const bigPayId = p2.data?.payment?.id;
const bigInvoiceId = p2.data?.invoice?.id;
if (p2.status !== 201) blocked("RF-20", "large refund cases", `could not sell M2 a 1,500,000đ plan: ${p2.status} ${JSON.stringify(p2.data)}`);
else {
  const r1 = await api(`/payments/${bigPayId}/refund`, { method: "POST", token: rec2.token, body: { amount_vnd: 1200000, reason: "Moving abroad" } });
  check("RF-20", "receptionist refunds 1,200,000 (≥ limit) → 201 status refund_pending", r1, {
    status: 201,
    test: (x) => x.data.payment?.status === "refund_pending" && Number(x.data.payment?.amount_vnd) === -1200000,
    why: "refund_pending, −1200000",
  });
  const r1Id = r1.data?.payment?.id;
  check("RF-21", "the pending refund appears in GET /payments/pending → refunds", await api("/payments/pending", { token: rec2.token }), {
    status: 200,
    test: (x) => x.data.refunds?.some((r) => r.id === r1Id),
    why: "refunds[] contains it",
  });
  check("RF-22", "a pending refund counts as returned: another 400,000 (only 300,000 left) → 422", await api(`/payments/${bigPayId}/refund`, { method: "POST", token: rec2.token, body: { amount_vnd: 400000 } }), { status: 422 });
  check("RF-23", "receptionist cannot approve a refund → 403", await api(`/payments/${r1Id}/approve-refund`, { method: "POST", token: rec2.token, body: {} }), { status: 403 });
  check("RF-24", "member cannot reject a refund → 403", await api(`/payments/${r1Id}/reject-refund`, { method: "POST", token: M2.token, body: {} }), { status: 403 });
  check("RF-25", "reject with a 501-character note → 400 field reason", await api(`/payments/${r1Id}/reject-refund`, { method: "POST", token: mgr.token, body: { reason: "x".repeat(501) } }), {
    status: 400,
    test: (x) => x.data.field === "reason",
    why: "field reason",
  });
  check("RF-26", "manager rejects with a note → 200 refund_rejected", await api(`/payments/${r1Id}/reject-refund`, { method: "POST", token: mgr.token, body: { reason: "Plan already used" } }), {
    status: 200,
    test: (x) => x.data.status === "refund_rejected",
    why: "status refund_rejected",
  });
  check("RF-27", "M2 gets an in-app notification about the rejection", await api("/me/notifications", { token: M2.token }), {
    status: 200,
    test: (x) => JSON.stringify(x.data).includes("refund_rejected"),
    why: "a refund_rejected notification exists",
  });
  check("RF-28", "rejecting it again → 409", await api(`/payments/${r1Id}/reject-refund`, { method: "POST", token: mgr.token, body: {} }), { status: 409 });
  check("RF-29", "approving a rejected refund → 409", await api(`/payments/${r1Id}/approve-refund`, { method: "POST", token: mgr.token, body: {} }), { status: 409 });
  check("RF-30", "approving a normal (posted, positive) payment → 409", await api(`/payments/${bigPayId}/approve-refund`, { method: "POST", token: mgr.token, body: {} }), { status: 409 });
  check("RF-31", "approve an unknown id → 404", await api(`/payments/${IDS.nonexistent}/approve-refund`, { method: "POST", token: mgr.token, body: {} }), { status: 404 });

  const r2 = await api(`/payments/${bigPayId}/refund`, { method: "POST", token: rec2.token, body: { amount_vnd: 1200000 } });
  check("RF-32", "after the rejection the money is refundable again: receptionist raises 1,200,000 → 201 refund_pending", r2, {
    status: 201,
    test: (x) => x.data.payment?.status === "refund_pending",
    why: "refund_pending",
  });
  check("RF-33", "manager approves → 200 posted", await api(`/payments/${r2.data?.payment?.id}/approve-refund`, { method: "POST", token: mgr.token, body: { reason: "OK" } }), {
    status: 200,
    test: (x) => x.data.status === "posted",
    why: "status posted",
  });
  check("RF-34", "approve the same refund twice → 409", await api(`/payments/${r2.data?.payment?.id}/approve-refund`, { method: "POST", token: mgr.token, body: {} }), { status: 409 });
  check("RF-35", "manager refunds the last 300,000 directly → 201 posted (managers need no sign-off)", await api(`/payments/${bigPayId}/refund`, { method: "POST", token: mgr.token, body: { amount_vnd: 300000 } }), {
    status: 201,
    test: (x) => x.data.payment?.status === "posted",
    why: "posted",
  });
  check("RF-36", "nothing left: 1,000 more → 422", await api(`/payments/${bigPayId}/refund`, { method: "POST", token: mgr.token, body: { amount_vnd: 1000 } }), { status: 422 });
}

// ───────────────────────────── 5. Waiting-on-money queue + decline ─────────────────────────────
check("PQ-01", "member cannot read the desk queue → 403", await api("/payments/pending", { token: bao.token }), { status: 403 });
check("PQ-02", "coach cannot read the desk queue → 403", await api("/payments/pending", { token: coach.token }), { status: 403 });
check("PQ-03", "?brief=1 → 200 { waiting: <number> }", await api("/payments/pending?brief=1", { token: rec2.token }), {
  status: 200,
  test: (x) => typeof x.data.waiting === "number",
  why: "waiting is a number",
});
check("PQ-04", "full queue → awaiting[], orders[], refunds[], receipts[], days, capped", await api("/payments/pending", { token: rec2.token }), {
  status: 200,
  test: (x) => ["awaiting", "orders", "refunds", "receipts"].every((k) => Array.isArray(x.data[k])) && typeof x.data.capped === "boolean",
  why: "four arrays + capped",
});
check("PQ-05", "?days=999 is clamped to 30", await api("/payments/pending?days=999", { token: rec2.token }), { status: 200, test: (x) => x.data.days === 30, why: "days 30" });
check("PQ-06", "?days=abc falls back to 7", await api("/payments/pending?days=abc", { token: rec2.token }), { status: 200, test: (x) => x.data.days === 7, why: "days 7" });
check("PQ-07", "receipts include the cash walk-in, with who took it", await api("/payments/pending", { token: rec2.token }), {
  status: 200,
  test: (x) => x.data.receipts?.some((r) => r.id === walkPayId && r.taken_by),
  why: "receipt row for the walk-in with taken_by",
});

const M4 = await newMember();
const order = await api("/subscriptions", { method: "POST", token: M4.token, body: { plan_id: IDS.planBadminton30 } });
check("PQ-08", "setup: member M4 orders a plan in the app → 201 pending", order, { status: 201, test: (x) => x.data.subscription?.status === "pending", why: "pending" });
const orderId = order.data?.subscription?.id;
check("PQ-09", "the order appears in the desk queue → orders[]", await api("/payments/pending", { token: rec2.token }), {
  status: 200,
  test: (x) => x.data.orders?.some((o) => o.id === orderId),
  why: "orders[] contains it",
});
check("PQ-10", "member cannot decline (even their own order) → 403", await api(`/subscriptions/${orderId}/decline`, { method: "POST", token: M4.token }), { status: 403 });
check("PQ-11", "coach cannot decline → 403", await api(`/subscriptions/${orderId}/decline`, { method: "POST", token: coach.token }), { status: 403 });
check("PQ-12", "decline an unknown order → 404", await api(`/subscriptions/${IDS.nonexistent}/decline`, { method: "POST", token: rec2.token }), { status: 404 });
check("PQ-13", "decline an ACTIVE (paid) plan → 409", await api(`/subscriptions/${sub1Id}/decline`, { method: "POST", token: rec2.token }), { status: 409 });
check("PQ-14", "receptionist declines the unpaid order → 200", await api(`/subscriptions/${orderId}/decline`, { method: "POST", token: rec2.token }), { status: 200 });
check("PQ-15", "decline it again → 409", await api(`/subscriptions/${orderId}/decline`, { method: "POST", token: rec2.token }), { status: 409 });
check("PQ-16", "taking payment for a declined order → 409", await pay(mgr.token, { ref_type: "subscription", ref_id: orderId, method: "cash", amount_vnd: 800000 }), { status: 409 });
check("PQ-17", "the order left the queue", await api("/payments/pending", { token: rec2.token }), {
  status: 200,
  test: (x) => !x.data.orders?.some((o) => o.id === orderId),
  why: "orders[] no longer contains it",
});
check("PQ-18", "after the decline M4 can order the same plan again → 201", await api("/subscriptions", { method: "POST", token: M4.token, body: { plan_id: IDS.planBadminton30 } }), { status: 201 });

// ───────────────────────────── 6. Invoices ─────────────────────────────
check("IV-01", "M2 lists own invoices → 200, includes the 1,500,000đ plan receipt", await api("/invoices", { token: M2.token }), {
  status: 200,
  test: (x) => x.data.items?.some((i) => i.id === bigInvoiceId && Number(i.amount_vnd) === 1500000),
  why: "items[] has the invoice",
});
check("IV-02", "M1 does not see M2's invoice in their list", await api("/invoices", { token: M1.token }), {
  status: 200,
  test: (x) => !x.data.items?.some((i) => i.id === bigInvoiceId),
  why: "not in M1's list",
});
check("IV-03", "coach cannot list invoices → 403", await api("/invoices", { token: coach.token }), { status: 403 });
check("IV-04", "?limit=1000 is clamped (≤100 items, no error)", await api("/invoices?limit=1000", { token: mgr.token }), { status: 200, test: (x) => x.data.items.length <= 100, why: "≤100" });
check("IV-05", "M2 downloads own invoice PDF → 200 application/pdf, starts with %PDF", await api(`/invoices/${bigInvoiceId}.pdf`, { token: M2.token }), {
  status: 200,
  test: (x) => String(x.headers["content-type"]).includes("application/pdf") && String(x.data).startsWith("%PDF"),
  why: "PDF bytes",
});
check("IV-06", "receipt-printer format ?format=80mm → 200 PDF", await api(`/invoices/${bigInvoiceId}.pdf?format=80mm`, { token: rec2.token }), {
  status: 200,
  test: (x) => String(x.headers["content-type"]).includes("application/pdf"),
  why: "PDF",
});
check("IV-07", "M1 opens M2's invoice PDF → 404 (not 200, not 403 — do not reveal it exists)", await api(`/invoices/${bigInvoiceId}.pdf`, { token: M1.token }), { status: 404 });
check("IV-08", "coach opens an invoice PDF → 403", await api(`/invoices/${bigInvoiceId}.pdf`, { token: coach.token }), { status: 403 });
check("IV-09", "invoice PDF without login → 401", await api(`/invoices/${bigInvoiceId}.pdf`), { status: 401 });
check("IV-10", "unknown invoice PDF → 404", await api(`/invoices/${IDS.nonexistent}.pdf`, { token: mgr.token }), { status: 404 });
check("IV-11", "invoice id 'abc' → 400, never 500", await api(`/invoices/abc.pdf`, { token: mgr.token }), { status: 400 });
check("IV-12", "receptionist downloads the e-invoice XML → 200 application/xml with <HDon> and total 1500000", await api(`/invoices/${bigInvoiceId}.xml`, { token: rec2.token }), {
  status: 200,
  test: (x) => String(x.headers["content-type"]).includes("xml") && String(x.data).includes("<HDon>") && String(x.data).includes("<TgTTTBSo>1500000</TgTTTBSo>"),
  why: "XML with HDon and the total",
});
check("IV-13", "member cannot download the XML → 403", await api(`/invoices/${bigInvoiceId}.xml`, { token: M2.token }), { status: 403 });

// Hostile text in the buyer's name must come out escaped.
const wx2 = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 1 });
const evilName = `<script>alert(1)</script> & "Quote" =1+1`;
const evil = await walkIn(rec2.token, wiBody(wx2, { guest_name: evilName }));
if (evil.status === 201) {
  check("IV-14", "XML escapes a buyer name with <script>, & and quotes", await api(`/invoices/${evil.data.invoice_id}.xml`, { token: rec2.token }), {
    status: 200,
    test: (x) => !String(x.data).includes("<script>") && String(x.data).includes("&lt;script&gt;") && String(x.data).includes("&amp;"),
    why: "no raw <script>, &lt;script&gt; and &amp; present",
  });
  check("IV-15", "invoice PDF still renders for that name → 200", await api(`/invoices/${evil.data.invoice_id}.pdf`, { token: rec2.token }), { status: 200 });
} else blocked("IV-14", "XML escaping", `walk-in with a hostile name failed: ${evil.status} ${JSON.stringify(evil.data)}`);
// A buyer name that a spreadsheet would run as a formula when the accountant
// opens the CSV export (checked in IV-21).
const wf = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 1 });
const formula = await walkIn(rec2.token, wiBody(wf, { guest_name: "=1+1" }));
if (formula.status !== 201) blocked("IV-21", "CSV formula injection", `walk-in named '=1+1' failed: ${formula.status} ${JSON.stringify(formula.data)}`);

check("IV-16", "receptionist cannot open the export list (manager only) → 403", await api("/invoices/export-list", { token: rec2.token }), { status: 403 });
check("IV-17", "export list for this month → 200 with items[], n, total, pending", await api("/invoices/export-list", { token: mgr.token }), {
  status: 200,
  test: (x) => Array.isArray(x.data.items) && typeof x.data.n === "number" && typeof x.data.pending === "number",
  why: "items, n, pending",
});
check("IV-18", "export list with from after to → 422", await api("/invoices/export-list?from=2026-12-31&to=2026-01-01", { token: mgr.token }), { status: 422 });
check("IV-19", "export list with from='abc' → 422", await api("/invoices/export-list?from=abc", { token: mgr.token }), { status: 422 });
const csv = await api("/invoices/export?format=csv", { token: mgr.token });
check("IV-20", "CSV export → 200 text/csv with the header row", csv, {
  status: 200,
  test: (x) => String(x.headers["content-type"]).includes("text/csv") && String(x.data).includes("So_hoa_don,Ngay_lap"),
  why: "text/csv + header",
});
if (formula.status === 201) check("IV-21", "a buyer name starting with '=' is neutralised in the CSV (no spreadsheet formula injection) (advisory)", csv, {
  status: 200,
  test: (x) => !String(x.data).split(/\r?\n/).some((line) => /(^|,)"?[=+@]/.test(line)),
  why: "no cell begins with = + or @ (prefix it with ')",
  advisory: true,
});
check("IV-22", "export again with only_new=1 → only the header (everything was marked exported)", await api("/invoices/export?format=csv&only_new=1", { token: mgr.token }), {
  status: 200,
  test: (x) => String(x.data).trim().split(/\r?\n/).length === 1,
  why: "one line",
});
check("IV-23", "export list now shows pending 0", await api("/invoices/export-list", { token: mgr.token }), { status: 200, test: (x) => x.data.pending === 0, why: "pending 0" });
check("IV-24", "XML batch export → 200 with <DSHDon>", await api("/invoices/export?format=xml", { token: mgr.token }), {
  status: 200,
  test: (x) => String(x.data).includes("<DSHDon>"),
  why: "DSHDon root",
});
check("IV-25", "receptionist cannot export → 403", await api("/invoices/export", { token: rec2.token }), { status: 403 });

// ───────────────────────────── 7. Close the till ─────────────────────────────
check("SH-20", "receptionist (another person) cannot close receptionist2's shift → 403", await api(`/shifts/${shiftId}/close`, { method: "POST", token: rec.token, body: { cash_declared_vnd: 0 } }), { status: 403 });
check("SH-21", "manager cannot close a receptionist's shift → 403", await api(`/shifts/${shiftId}/close`, { method: "POST", token: mgr.token, body: { cash_declared_vnd: 0 } }), { status: 403 });
check("SH-22", "close without cash_declared_vnd → 422", await api(`/shifts/${shiftId}/close`, { method: "POST", token: rec2.token, body: {} }), { status: 422 });
check("SH-23", "close with cash_declared_vnd='abc' → 422", await api(`/shifts/${shiftId}/close`, { method: "POST", token: rec2.token, body: { cash_declared_vnd: "abc" } }), { status: 422 });
check("SH-25", "close an unknown shift → 404", await api(`/shifts/${IDS.nonexistent}/close`, { method: "POST", token: rec2.token, body: { cash_declared_vnd: 0 } }), { status: 404 });
const cur = await api("/shifts/current", { token: rec2.token });
if (cur.status === 200) {
  const sysCash = cur.data.totals.cash;
  check("SH-26", "receptionist2 closes her shift → 200 with cash_system_vnd = the till's cash total", await api(`/shifts/${shiftId}/close`, { method: "POST", token: rec2.token, body: { cash_declared_vnd: sysCash } }), {
    status: 200,
    test: (x) => x.data.cash_system_vnd === sysCash && x.data.cash_declared_vnd === sysCash,
    why: `cash_system_vnd = ${sysCash}`,
  });
  check("SH-27", "close it again → 409", await api(`/shifts/${shiftId}/close`, { method: "POST", token: rec2.token, body: { cash_declared_vnd: sysCash } }), { status: 409 });
  check("SH-28", "after closing, GET /shifts/current → 404", await api("/shifts/current", { token: rec2.token }), { status: 404 });
  check("SH-29", "after closing, a payment by receptionist2 → BR-44", await pay(rec2.token, { ref_type: "subscription", ref_id: sub1Id, method: "cash", amount_vnd: 800000 }), { status: 422, br: "BR-44" });
} else blocked("SH-26", "close the shift", `the shift was not open: ${cur.status}`);

// Negative cash count, on a second, empty shift: if the server wrongly accepts
// it, it closes that shift, so it must not run against the real one above.
const second = await api("/shifts/open", { method: "POST", token: rec2.token });
check("SH-30", "receptionist2 can open a new shift after closing the last one → 201", second, { status: 201 });
if (second.status === 201) {
  const neg = await api(`/shifts/${second.data.shift.id}/close`, { method: "POST", token: rec2.token, body: { cash_declared_vnd: -1 } });
  check("SH-24", "close with a negative cash count (−1đ) is refused → 400/422", neg, { status: [400, 422] });
  if (neg.status !== 200) await api(`/shifts/${second.data.shift.id}/close`, { method: "POST", token: rec2.token, body: { cash_declared_vnd: 0 } });
} else blocked("SH-24", "negative cash count", `could not open a second shift: ${second.status}`);

summary();
