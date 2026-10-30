/**
 * Suite 05 — membership plans and subscriptions: the plan catalogue (who sees
 * what), creating and editing plans (manager), members ordering plans (BR-16,
 * promo codes, renewals, the one-pending-per-sport rule, rate limits), staff
 * raising orders, freezing and unfreezing (BR-14, BR-15).
 *
 *   node scripts/tests/agent/05-plans-subscriptions.mjs
 *
 * Needs the safe server on a FRESH database (restart it first): it creates
 * plans and changes prices.
 *
 * Case IDs: PL-xx (plan catalogue + CRUD), SB-xx (ordering a plan),
 * FZ-xx (freeze / unfreeze).
 */
import { api, blocked, check, freeSlotAnyDay, IDS, login, memberWithPlan, newMember, PHONES, summary } from "../agent-lib.mjs";

const mgr = await login(PHONES.manager);
const rec = await login(PHONES.receptionist);
const coach = await login(PHONES.coach);
const bao = await login(PHONES.memberNoPlan);

const TRIAL = "20000000-0000-0000-0000-000000000008"; // hidden trial plan in the seed (is_on_sale = false)
const order = (tok, body) => api("/subscriptions", { method: "POST", token: tok, body });
const createPlan = (tok, body) => api("/plans", { method: "POST", token: tok, body });
const goodPlan = (extra = {}) => ({ name: `Test plan ${Date.now()}`, sport_scope: "badminton", price_vnd: 500000, duration_days: 30, court_hours: 2, court_discount_pct: 10, ...extra });
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// ───────────────────────────── 1. Catalogue ─────────────────────────────
check("PL-01", "GET /plans without login → 200, only plans on sale (the hidden trial plan is not listed)", await api("/plans"), {
  status: 200,
  test: (x) => x.data.items.length >= 7 && x.data.items.every((p) => p.is_on_sale) && !x.data.items.some((p) => p.id === TRIAL),
  why: "≥7 items, all on sale, no trial plan",
});
check("PL-02", "GET /plans as a member → the same on-sale list", await api("/plans", { token: bao.token }), {
  status: 200,
  test: (x) => !x.data.items.some((p) => p.id === TRIAL),
  why: "no trial plan",
});
check("PL-03", "GET /plans as manager → also lists the hidden trial plan", await api("/plans", { token: mgr.token }), {
  status: 200,
  test: (x) => x.data.items.some((p) => p.id === TRIAL && p.is_on_sale === false),
  why: "trial plan present with is_on_sale false",
});
check("PL-04", "the list is sorted by price, cheapest first", await api("/plans"), {
  status: 200,
  test: (x) => x.data.items.every((p, i, a) => i === 0 || Number(a[i - 1].price_vnd) <= Number(p.price_vnd)),
  why: "ascending price_vnd",
});
check("PL-05", "manager opens one plan → 200 { plan, holders{active,pending,frozen,ever} }", await api(`/plans/${IDS.planBadminton30}`, { token: mgr.token }), {
  status: 200,
  test: (x) => x.data.plan?.id === IDS.planBadminton30 && typeof x.data.holders?.active === "number",
  why: "plan + holders",
});
check("PL-06", "member cannot open the plan detail (manager screen) → 403", await api(`/plans/${IDS.planBadminton30}`, { token: bao.token }), { status: 403 });
check("PL-07", "receptionist cannot open the plan detail → 403", await api(`/plans/${IDS.planBadminton30}`, { token: rec.token }), { status: 403 });
check("PL-08", "plan detail for an unknown id → 404", await api(`/plans/${IDS.nonexistent}`, { token: mgr.token }), { status: 404 });
check("PL-09", "plan detail for id 'abc' → 400, never 500", await api(`/plans/abc`, { token: mgr.token }), { status: 400 });

// ───────────────────────────── 2. Create / edit plans ─────────────────────────────
check("PL-10", "receptionist cannot create a plan → 403", await createPlan(rec.token, goodPlan()), { status: 403 });
check("PL-11", "coach cannot create a plan → 403", await createPlan(coach.token, goodPlan()), { status: 403 });
check("PL-12", "member cannot create a plan → 403", await createPlan(bao.token, goodPlan()), { status: 403 });
check("PL-13", "create without login → 401", await createPlan(undefined, goodPlan()), { status: 401 });
const bad = [
  ["PL-14", "no name", { name: undefined }, "name"],
  ["PL-15", "name of 81 characters", { name: "x".repeat(81) }, "name"],
  ["PL-16", "sport_scope 'tennis'", { sport_scope: "tennis" }, "sport_scope"],
  ["PL-17", "no sport_scope", { sport_scope: undefined }, "sport_scope"],
  ["PL-18", "price −1", { price_vnd: -1 }, "price_vnd"],
  ["PL-19", "price 'abc'", { price_vnd: "abc" }, "price_vnd"],
  ["PL-20", "price 2,147,483,648 (over int4)", { price_vnd: 2147483648 }, "price_vnd"],
  ["PL-21", "price 1.5", { price_vnd: 1.5 }, "price_vnd"],
  ["PL-22", "duration 0 days", { duration_days: 0 }, "duration_days"],
  ["PL-23", "duration 3,651 days", { duration_days: 3651 }, "duration_days"],
  ["PL-24", "court discount 101%", { court_discount_pct: 101 }, "court_discount_pct"],
  ["PL-25", "court discount −1%", { court_discount_pct: -1 }, "court_discount_pct"],
  ["PL-26", "session_quota −1", { session_quota: -1 }, "session_quota"],
  ["PL-27", "court_hours 'many'", { court_hours: "many" }, "court_hours"],
];
for (const [id, what, extra, field] of bad) {
  check(id, `create a plan with ${what} → 400 field ${field}`, await createPlan(mgr.token, goodPlan(extra)), {
    status: 400,
    test: (x) => x.data.field === field,
    why: `field ${field}`,
  });
}
const created = await createPlan(mgr.token, goodPlan({ name: "Agent Badminton 30" }));
check("PL-28", "manager creates a valid plan → 201, on sale by default, carry_over_hours false", created, {
  status: 201,
  test: (x) => x.data.is_on_sale === true && x.data.carry_over_hours === false && Number(x.data.price_vnd) === 500000,
  why: "is_on_sale true, carry_over false, price 500000",
});
const planId = created.data?.id;
check("PL-29", "the new plan shows up in the public list", await api("/plans"), { status: 200, test: (x) => x.data.items.some((p) => p.id === planId), why: "listed" });
const hidden = await createPlan(mgr.token, goodPlan({ name: "Agent Hidden", is_on_sale: false }));
check("PL-30", "create with is_on_sale false → 201 and NOT in the public list", hidden, { status: 201, test: (x) => x.data.is_on_sale === false, why: "is_on_sale false" });
check("PL-31", "the hidden plan is not listed for members", await api("/plans", { token: bao.token }), {
  status: 200,
  test: (x) => !x.data.items.some((p) => p.id === hidden.data?.id),
  why: "not listed",
});
check("PL-32", "a plan with a price of 0 is allowed (free trial) → 201", await createPlan(mgr.token, goodPlan({ name: "Agent Free", price_vnd: 0, is_on_sale: false })), { status: 201 });

check("PL-33", "receptionist cannot edit a plan → 403", await api(`/plans/${planId}`, { method: "PATCH", token: rec.token, body: { price_vnd: 1 } }), { status: 403 });
check("PL-34", "edit an unknown plan → 404", await api(`/plans/${IDS.nonexistent}`, { method: "PATCH", token: mgr.token, body: { price_vnd: 1000 } }), { status: 404 });
check("PL-35", "edit plan id 'abc' → 400", await api(`/plans/abc`, { method: "PATCH", token: mgr.token, body: { price_vnd: 1000 } }), { status: 400 });
check("PL-36", "edit price to −5 → 400 field price_vnd", await api(`/plans/${planId}`, { method: "PATCH", token: mgr.token, body: { price_vnd: -5 } }), {
  status: 400,
  test: (x) => x.data.field === "price_vnd",
  why: "field price_vnd",
});
check("PL-37", "edit name to 81 characters → 400", await api(`/plans/${planId}`, { method: "PATCH", token: mgr.token, body: { name: "y".repeat(81) } }), { status: 400 });
check("PL-38", "edit discount to 150% → 400", await api(`/plans/${planId}`, { method: "PATCH", token: mgr.token, body: { court_discount_pct: 150 } }), { status: 400 });
check("PL-39", "edit only the name → 200, the price is unchanged", await api(`/plans/${planId}`, { method: "PATCH", token: mgr.token, body: { name: "Agent Badminton 30 (renamed)" } }), {
  status: 200,
  test: (x) => x.data.name === "Agent Badminton 30 (renamed)" && Number(x.data.price_vnd) === 500000,
  why: "name changed, price 500000",
});

// ───────────────────────────── 3. Ordering a plan ─────────────────────────────
check("SB-01", "order without login → 401", await order(undefined, { plan_id: planId }), { status: 401 });
check("SB-02", "coach cannot order a plan → 403", await order(coach.token, { plan_id: planId }), { status: 403 });
check("SB-03", "coach with NO plan_id still gets 403 (role is checked before the body) (advisory, F-10)", await order(coach.token, {}), { status: 403, advisory: true });

const A = await newMember();
const V = await newMember(); // validation cases on their own member: refused orders still count toward the 3-per-minute limit
check("SB-04", "member orders without plan_id → 422", await order(V.token, {}), { status: 422 });
check("SB-05", "member orders an unknown plan → 404", await order(V.token, { plan_id: IDS.nonexistent }), { status: 404 });
check("SB-06", "member orders plan_id 'abc' → 400", await order(V.token, { plan_id: "abc" }), { status: 400 });
const a1 = await order(A.token, { plan_id: planId });
check("SB-07", "member orders the new plan → 201 pending, amount_due 500,000, ends 30 days after it starts", a1, {
  status: 201,
  test: (x) => x.data.subscription?.status === "pending" && x.data.amount_due_vnd === 500000 && days(x.data.subscription.start_on, x.data.subscription.end_on) === 30,
  why: "pending, 500000, 30 days",
});
const aSub = a1.data?.subscription?.id;
const a2 = await order(A.token, { plan_id: IDS.planBadminton30 });
check("SB-08", "ordering a second badminton plan while one is pending REPLACES the pending order (same id, new plan, 800,000)", a2, {
  status: 201,
  test: (x) => x.data.subscription?.id === aSub && x.data.subscription?.plan_id === IDS.planBadminton30 && x.data.amount_due_vnd === 800000,
  why: "same subscription id, plan switched, 800000",
});
const a3 = await order(A.token, { plan_id: IDS.planBadminton30, promo_code: "summer50k" });
check("SB-09", "re-order with plan code SUMMER50K typed in lower case (−50,000đ) → amount_due 750,000", a3, {
  status: 201,
  test: (x) => x.data.amount_due_vnd === 750000 && x.data.subscription?.id === aSub,
  why: "750000, same id",
});
check("SB-10", "4th plan order within a minute → 429 RATE_LIMITED (3 per minute)", await order(A.token, { plan_id: IDS.planBadminton30 }), { status: 429, code: "RATE_LIMITED" });
check("SB-11", "the desk sees A's order with the SUMMER50K code priced in", await api("/payments/pending", { token: mgr.token }), {
  status: 200,
  test: (x) => x.data.orders?.some((o) => o.id === aSub && o.promo_code === "SUMMER50K" && Number(o.promo_discount_vnd) === 50000),
  why: "orders[] row with promo SUMMER50K, discount 50000",
});
check("SB-12", "paying the list price for A's discounted order is refused, expected 750,000", await api("/payments", {
  method: "POST",
  token: mgr.token,
  idem: true,
  body: { ref_type: "subscription", ref_id: aSub, method: "cash", amount_vnd: 800000 },
}), { status: 400, test: (x) => Number(x.data.expected_vnd) === 750000, why: "expected_vnd 750000" });
check("SB-13", "paying 750,000 → 201", await api("/payments", {
  method: "POST",
  token: mgr.token,
  idem: true,
  body: { ref_type: "subscription", ref_id: aSub, method: "cash", amount_vnd: 750000 },
}), { status: 201 });
check("SB-14", "SUMMER50K again for the same member after it was paid (1 use per member) → 422 BR-40 (desk raises it: A is rate limited)", await order(mgr.token, { plan_id: IDS.planVolleyball30, user_id: A.user.id, promo_code: "SUMMER50K" }), {
  status: 422,
  br: "BR-40",
});

const B = await newMember();
check("SB-15", "promo code that does not exist → 422 BR-40", await order(B.token, { plan_id: IDS.planBadminton30, promo_code: "NOPE123" }), { status: 422, br: "BR-40" });
check("SB-16", "paused promo TET2026 → 422 BR-40", await order(B.token, { plan_id: IDS.planBadminton30, promo_code: "TET2026" }), { status: 422, br: "BR-40" });
check("SB-17", "court-only code WELCOME10 on a plan → 422 BR-40 'does not apply to plans'", await order(B.token, { plan_id: IDS.planBadminton30, promo_code: "WELCOME10" }), { status: 422, br: "BR-40" });
const cheap = await createPlan(mgr.token, goodPlan({ name: "Agent Cheap", price_vnd: 200000 }));
check("SB-17b", "SUMMER50K needs an order of 300,000đ: on a 200,000đ plan → 422 BR-40 (desk raises it)", await order(mgr.token, { plan_id: cheap.data?.id, user_id: B.user.id, promo_code: "SUMMER50K" }), { status: 422, br: "BR-40" });

const C = await newMember();
check("SB-18", "member orders the hidden trial plan → 422 BR-16", await order(C.token, { plan_id: TRIAL }), { status: 422, br: "BR-16" });
check("SB-19", "member orders a hidden test plan → 422 BR-16", await order(C.token, { plan_id: hidden.data?.id }), { status: 422, br: "BR-16" });
check("SB-20", "staff can still raise the hidden trial plan for a member → 201", await order(mgr.token, { plan_id: TRIAL, user_id: C.user.id }), { status: 201 });
check("SB-21", "receptionist raises an order for a member → 201 (staff are not rate limited)", await order(rec.token, { plan_id: IDS.planVolleyball30, user_id: C.user.id }), { status: 201 });
check("SB-22", "staff raise an order for user_id that does not exist → 404/422, never 500", await order(mgr.token, { plan_id: IDS.planBadminton30, user_id: IDS.nonexistent }), { status: [400, 404, 422] });
check("SB-23", "staff raise an order for user_id 'abc' → 400", await order(mgr.token, { plan_id: IDS.planBadminton30, user_id: "abc" }), { status: [400, 422] });
check(
  "SB-24",
  "staff cannot sell a membership plan to a COACH account (members only) (advisory)",
  await (async () => {
    const me = await api("/me", { token: coach.token });
    return order(mgr.token, { plan_id: IDS.planBadminton30, user_id: me.data?.user?.id ?? me.data?.id });
  })(),
  { status: [403, 404, 422], advisory: true },
);

// Withdrawing a plan from sale (BR-16) keeps it for people who hold it.
const D = await newMember();
const dOrder = await order(D.token, { plan_id: planId });
const wd = await api(`/plans/${planId}`, { method: "PATCH", token: mgr.token, body: { is_on_sale: false } });
check("SB-25", "manager withdraws the test plan from sale → 200 is_on_sale false", wd, { status: 200, test: (x) => x.data.is_on_sale === false, why: "is_on_sale false" });
check("SB-26", "the withdrawal is audited as withdraw_plan_from_sale", await api(`/audit?action=withdraw_plan_from_sale&limit=5`, { token: mgr.token }), {
  status: 200,
  test: (x) => JSON.stringify(x.data).includes(planId),
  why: "audit row for the plan",
});
const E = await newMember();
check("SB-27", "a NEW order for the withdrawn plan → 422 BR-16", await order(E.token, { plan_id: planId }), { status: 422, br: "BR-16" });
check("SB-28", "D's order placed before the withdrawal can still be paid → 201", await api("/payments", {
  method: "POST",
  token: mgr.token,
  idem: true,
  body: { ref_type: "subscription", ref_id: dOrder.data?.subscription?.id, method: "cash", amount_vnd: 500000 },
}), { status: 201 });
check("SB-29", "plan detail shows D as an active holder", await api(`/plans/${planId}`, { token: mgr.token }), {
  status: 200,
  test: (x) => x.data.holders?.active >= 1,
  why: "holders.active ≥ 1",
});
check("SB-30", "put back on sale → 200 is_on_sale true", await api(`/plans/${planId}`, { method: "PATCH", token: mgr.token, body: { is_on_sale: true } }), {
  status: 200,
  test: (x) => x.data.is_on_sale === true,
  why: "is_on_sale true",
});

// Price change between ordering and paying.
const F = await newMember();
const fOrder = await order(F.token, { plan_id: planId });
await api(`/plans/${planId}`, { method: "PATCH", token: mgr.token, body: { price_vnd: 600000 } });
check("SB-31", "a member who ordered at 500,000 pays 500,000 after the manager raised the price to 600,000 (price locked at order time) (advisory)", await api("/payments", {
  method: "POST",
  token: mgr.token,
  idem: true,
  body: { ref_type: "subscription", ref_id: fOrder.data?.subscription?.id, method: "cash", amount_vnd: 500000 },
}), { status: 201, advisory: true });

// Renewal: an order on top of an active plan starts when the active one ends.
const G = await memberWithPlan(mgr.token, IDS.planBadminton30);
const gRenew = await order(G.token, { plan_id: IDS.planBadminton30 });
check("SB-32", "member with an active plan orders the same plan again → 201 pending, starting the day the active plan ends", gRenew, {
  status: 201,
  test: (x) => x.data.subscription?.status === "pending" && String(x.data.subscription?.start_on).slice(0, 10) === String(G.subscription.end_on).slice(0, 10),
  why: `start_on = ${String(G.subscription.end_on).slice(0, 10)}`,
});
check("SB-33", "/me lists both the active plan and the pending renewal", await api("/me", { token: G.token }), {
  status: 200,
  test: (x) => x.data.subscriptions?.some((s) => s.status === "active") && x.data.subscriptions?.some((s) => s.status === "pending"),
  why: "one active + one pending",
});
check("SB-34", "an all-sports plan is a different sport scope: ordering it does not replace the badminton renewal", await order(G.token, { plan_id: IDS.planAllAccess30 }), {
  status: 201,
  test: (x) => x.data.subscription?.id !== gRenew.data?.subscription?.id && x.data.subscription?.sport_scope === "all",
  why: "new subscription, sport_scope all",
});

// ───────────────────────────── 4. Freeze / unfreeze ─────────────────────────────
const H = await memberWithPlan(mgr.token, IDS.planBadminton30);
const hSub = H.subscription.id;
const freeze = (tok, id, body) => api(`/subscriptions/${id}/freeze`, { method: "POST", token: tok, body });
const unfreeze = (tok, id) => api(`/subscriptions/${id}/unfreeze`, { method: "POST", token: tok });
check("FZ-01", "member cannot freeze their own plan (the desk does it) → 403", await freeze(H.token, hSub, { days: 7 }), { status: 403 });
check("FZ-02", "coach cannot freeze → 403", await freeze(coach.token, hSub, { days: 7 }), { status: 403 });
check("FZ-03", "freeze without login → 401", await freeze(undefined, hSub, { days: 7 }), { status: 401 });
check("FZ-04", "freeze 0 days → 422", await freeze(rec.token, hSub, { days: 0 }), { status: 422 });
check("FZ-05", "freeze 91 days → 422", await freeze(rec.token, hSub, { days: 91 }), { status: 422 });
check("FZ-06", "freeze 1.5 days → 400/422 (whole days only)", await freeze(rec.token, hSub, { days: 1.5 }), { status: [400, 422] });
check("FZ-07", "freeze 31 days (over the 30 days/year limit) → 422 BR-15", await freeze(rec.token, hSub, { days: 31 }), { status: 422, br: "BR-15" });
check("FZ-08", "freeze an unknown subscription → 404", await freeze(rec.token, IDS.nonexistent, { days: 7 }), { status: 404 });
check("FZ-09", "freeze subscription id 'abc' → 400", await freeze(rec.token, "abc", { days: 7 }), { status: 400 });
check("FZ-10", "freeze a PENDING order → 422 BR-14", await freeze(rec.token, gRenew.data?.subscription?.id, { days: 7 }), { status: 422, br: "BR-14" });
const I = await memberWithPlan(mgr.token, IDS.planBadminton30); // its own member: if 'abc' is wrongly accepted it uses up freeze days
check("FZ-11", "freeze with days='abc' is refused, not silently turned into 7 days (advisory)", await freeze(rec.token, I.subscription.id, { days: "abc" }), {
  status: [400, 422],
  advisory: true,
});
const before = H.subscription; // fresh plan: frozen_days 0 (GET /me does not return frozen_days)
const fz = await freeze(rec.token, hSub, { days: 10 });
check("FZ-12", "receptionist freezes H's plan for 10 days → 200 frozen, end date pushed 10 days later, frozen_days 10", fz, {
  status: 200,
  test: (x) => x.data.status === "frozen" && days(before.end_on, x.data.end_on) === 10 && Number(x.data.frozen_days) === 10,
  why: "status frozen, end_on +10, frozen_days 10",
});
check("FZ-13", "freeze a plan that is already frozen → 422 BR-14", await freeze(rec.token, hSub, { days: 1 }), { status: 422, br: "BR-14" });
check("FZ-14", "taking payment for a frozen plan → 422 BR-14", await api("/payments", {
  method: "POST",
  token: mgr.token,
  idem: true,
  body: { ref_type: "subscription", ref_id: hSub, method: "cash", amount_vnd: 800000 },
}), { status: 422, br: "BR-14" });
check("FZ-15", "H orders another badminton plan while frozen → 422 BR-14", await order(H.token, { plan_id: IDS.planBadminton30 }), { status: 422, br: "BR-14" });
const fs = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 2 });
if (fs) {
  const hold = await api("/bookings", { method: "POST", token: H.token, idem: true, body: { court_id: fs.court_id, start_at: fs.start_at } });
  check("FZ-16", "while frozen, H's court booking gets no plan discount (discount 0)", hold, {
    status: 201,
    test: (x) => Number(x.data.booking?.discount_pct ?? 0) === 0,
    why: "discount_pct 0",
  });
  if (hold.status === 201) await api(`/bookings/${hold.data.booking.id}/cancel`, { method: "POST", token: H.token, body: {} });
} else blocked("FZ-16", "frozen plan gives no discount", "no free slot");
check("FZ-17", "member cannot unfreeze → 403", await unfreeze(H.token, hSub), { status: 403 });
check("FZ-18", "unfreeze → 200 active", await unfreeze(rec.token, hSub), { status: 200, test: (x) => x.data.status === "active", why: "active" });
check("FZ-19", "unfreeze an active plan → 409", await unfreeze(rec.token, hSub), { status: 409 });
check("FZ-20", "unfreeze an unknown id → 404", await unfreeze(rec.token, IDS.nonexistent), { status: 404 });
check("FZ-21", "after unfreezing the same day, the member does not keep the 10 bonus days (advisory: only days actually frozen should extend the plan)", await api("/me", { token: H.token }), {
  status: 200,
  test: (x) => days(before.end_on, x.data.subscriptions?.find((s) => s.id === hSub)?.end_on) <= 1,
  why: "end_on back within 1 day of the original",
  advisory: true,
});
check("FZ-22", "21 more freeze days (10 used + 21 = 31 > 30) → 422 BR-15", await freeze(mgr.token, hSub, { days: 21 }), { status: 422, br: "BR-15" });
check("FZ-23", "exactly 20 more (10 + 20 = 30) → 200", await freeze(mgr.token, hSub, { days: 20 }), { status: 200 });
await unfreeze(mgr.token, hSub);
check("FZ-24", "the year's allowance is used up: 1 more day → 422 BR-15", await freeze(mgr.token, hSub, { days: 1 }), { status: 422, br: "BR-15" });
check("FZ-25", "freeze/unfreeze are audited (freeze_sub / unfreeze_sub)", await api(`/audit?entity=subscription&limit=50`, { token: mgr.token }), {
  status: 200,
  test: (x) => JSON.stringify(x.data).includes("freeze_sub") && JSON.stringify(x.data).includes("unfreeze_sub"),
  why: "both actions in the audit log",
});

summary();
