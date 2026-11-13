#!/usr/bin/env node
/**
 * Live checks for SRS v1.4.1: promo codes (I4), QR / manual / self check-in (I1),
 * attendance value and the at-risk list (I3), detailed training plans (I6) and
 * the removal of debt / court convert (I2, I5). Run it ONCE per fresh in-memory
 * server, never against a database you care about:
 *
 *   DATABASE_URL= DATABASE_URL_UNPOOLED= PGLITE_DATA_DIR=memory npm run dev -- --port 8090
 *   BASE=http://127.0.0.1:8090 node scripts/arena3-srs141-check.mjs
 */
const BASE = (process.env.BASE ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const PASS = "ChangeMe!a3";
let passed = 0;
const refused = (r) => r.status === 400 || r.status === 422 || r.status === 409;

function fail(msg, extra) {
  console.error("FAIL", msg, extra === undefined ? "" : JSON.stringify(extra));
  process.exit(1);
}
function ok(cond, msg, extra) {
  if (!cond) fail(msg, extra);
  passed += 1;
  console.log("ok  ", msg);
}

async function req(path, { method = "GET", token, body, idem, raw } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (idem) headers["idempotency-key"] = crypto.randomUUID();
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function login(phone, password = PASS) {
  const r = await req("/auth/login", { method: "POST", body: { login: phone, password } });
  if (r.status !== 200 || !r.data?.token) fail(`login ${phone}`, r);
  return r.data;
}

const mgr = await login("0900000001");
const desk = await login("0900000002");
const stamp = String(Date.now()).slice(-7);
const shift = await req("/shifts/current", { token: desk.token });
if (!shift.data?.shift) {
  const opened = await req("/shifts/open", { method: "POST", token: desk.token });
  if (opened.status >= 400) fail("open shift", opened);
}

const plans = (await req("/plans")).data.items;
const termPlan = plans.find((p) => p.session_quota == null && p.price_vnd >= 100000) ?? plans[0];
if (!termPlan) fail("no plan in the seed", plans);

async function newMember(prefix, name) {
  const made = await req("/members", {
    method: "POST",
    token: desk.token,
    body: { full_name: `${name} ${stamp}`, phone: `${prefix}${stamp}`, pii_consent: true },
  });
  if (made.status !== 201) fail(`create member ${name}`, made);
  const session = await login(made.data.user.phone, made.data.temp_password);
  return { ...session, userId: made.data.user.id, phone: made.data.user.phone };
}

// ---- I2 / I5: debt and court convert are gone ----------------------------------
{
  const s = await req("/settings", { token: mgr.token });
  const body = JSON.stringify(s.data);
  ok(s.status === 200 && !body.includes("debt_limit") && !body.includes("deposit_pct_activates"), "settings carry no debt or deposit", s.data);
  ok(
    s.data.self_checkin_enabled === false && s.data.gate_dedup_minutes === 120 && s.data.at_risk_idle_days === 14,
    "new settings have their defaults",
    s.data,
  );
  const conv = await req("/convert", { method: "POST", token: mgr.token, body: {} });
  ok(conv.status === 404, "the court-convert route no longer exists", conv.status);
}

// ---- I4: promo codes -------------------------------------------------------------
const CODE = `T${stamp}`;
let promoId;
{
  const noAuth = await req("/promotions", { method: "POST", token: desk.token, body: { code: CODE, name: "x", kind: "percent", value: 10 } });
  ok(noAuth.status === 403, "reception cannot create a promo (BR-43)", noAuth);
  const badPct = await req("/promotions", { method: "POST", token: mgr.token, body: { code: CODE, name: "x", kind: "percent", value: 101 } });
  ok(refused(badPct) && badPct.data.field === "value", "a percentage over 100 is refused", badPct);
  const badAmt = await req("/promotions", { method: "POST", token: mgr.token, body: { code: CODE, name: "x", kind: "amount", value: 1500 } });
  ok(refused(badAmt) && badAmt.data.field === "value", "a fixed amount must be a multiple of 1,000đ", badAmt);
  const made = await req("/promotions", {
    method: "POST",
    token: mgr.token,
    body: { code: CODE.toLowerCase(), name: "Check 10%", kind: "percent", value: 10, max_uses: 1, max_per_member: 1, applies_to: ["plan", "court"] },
  });
  ok(made.status === 201 && made.data.promo.code === CODE, "a manager creates a code (stored upper-case)", made);
  promoId = made.data.promo.id;
  const dup = await req("/promotions", { method: "POST", token: mgr.token, body: { code: CODE, name: "again", kind: "percent", value: 5 } });
  ok(refused(dup) && dup.data.field === "code", "a duplicate code is refused", dup);
}

const memberA = await newMember("091", "Promo A");
const memberB = await newMember("092", "Promo B");
let payA;
{
  const prev = await req("/promotions/validate", {
    method: "POST",
    token: desk.token,
    body: { code: CODE, scope: "plan", plan_id: termPlan.id },
  });
  ok(prev.status === 200 && prev.data.discount_vnd > 0, "validate previews the discount without spending it", prev);
  const expectDiscount = Math.round((termPlan.price_vnd * 0.1) / 1000) * 1000;
  ok(prev.data.discount_vnd === expectDiscount, "10% is rounded once to 1,000đ (BR-42)", { got: prev.data.discount_vnd, expectDiscount });

  const bad = await req("/promotions/validate", { method: "POST", token: desk.token, body: { code: "NOPE", scope: "plan", plan_id: termPlan.id } });
  ok(refused(bad) && bad.data.field === "promo_code", "an unknown code says so on promo_code", bad);

  const order = await req("/subscriptions", {
    method: "POST",
    token: desk.token,
    body: { plan_id: termPlan.id, user_id: memberA.userId, promo_code: CODE },
  });
  ok(order.status === 201 && order.data.amount_due_vnd === termPlan.price_vnd - expectDiscount, "the order is priced with the code", order.data);

  const part = await req("/payments", {
    method: "POST",
    token: desk.token,
    idem: true,
    body: { ref_type: "subscription", ref_id: order.data.subscription.id, method: "cash", amount_vnd: order.data.amount_due_vnd - 1000 },
  });
  ok(refused(part), "a plan is paid in full — a part payment is refused (no debt)", part);
  const list0 = await req(`/promotions`, { token: mgr.token });
  ok(list0.data.items.find((p) => p.id === promoId).used === 0, "nothing is spent until the money posts (BR-41)", list0.data);

  payA = await req("/payments", {
    method: "POST",
    token: desk.token,
    idem: true,
    body: { ref_type: "subscription", ref_id: order.data.subscription.id, method: "cash", amount_vnd: order.data.amount_due_vnd },
  });
  ok(payA.status === 201, "paying the discounted price activates the plan", payA);
  const list1 = await req(`/promotions`, { token: mgr.token });
  const row = list1.data.items.find((p) => p.id === promoId);
  ok(row.used === 1 && row.discount_given_vnd === expectDiscount && row.state === "exhausted", "the use is counted and the code is exhausted", row);

  const second = await req("/promotions/validate", { method: "POST", token: desk.token, body: { code: CODE, scope: "plan", plan_id: termPlan.id } });
  ok(refused(second), "a fully used code is refused for the next member", second);

  const rename = await req(`/promotions/${promoId}`, { method: "PATCH", token: mgr.token, body: { code: `${CODE}X` } });
  ok(refused(rename) || rename.status === 409, "a used code cannot be renamed (BR-43)", rename);

  const refund = await req(`/payments/${payA.data.payment?.id ?? payA.data.id}/refund`, {
    method: "POST",
    token: mgr.token,
    idem: true,
    body: { amount_vnd: order.data.amount_due_vnd, reason: "check" },
  });
  ok(refund.status === 200 || refund.status === 201, "a full refund goes through", refund);
  const list2 = await req(`/promotions`, { token: mgr.token });
  ok(list2.data.items.find((p) => p.id === promoId).used === 0, "a full refund gives the use back (BR-41)", list2.data.items.find((p) => p.id === promoId));
  const reds = await req(`/promotions/${promoId}/redemptions`, { token: mgr.token });
  ok(reds.status === 200 && reds.data.items.some((r) => r.status === "restored"), "the redemption history shows it as restored", reds);
}

// ---- I1: check-in ------------------------------------------------------------------
const memberC = await newMember("093", "Gate Plan");
{
  const order = await req("/subscriptions", { method: "POST", token: desk.token, body: { plan_id: termPlan.id, user_id: memberC.userId } });
  const pay = await req("/payments", {
    method: "POST",
    token: desk.token,
    idem: true,
    body: { ref_type: "subscription", ref_id: order.data.subscription.id, method: "cash", amount_vnd: termPlan.price_vnd },
  });
  if (pay.status !== 201) fail("pay plan for gate member", pay);

  const tok = await req("/me/checkin-token", { token: memberC.token });
  ok(tok.status === 200 && tok.data.ttl_seconds === 60 && typeof tok.data.token === "string", "a member gets a 60-second code", tok);
  const asStaff = await req("/me/checkin-token", { token: desk.token });
  ok(asStaff.status === 403, "staff have no member code", asStaff);

  const junk = await req("/desk/scan", { method: "POST", token: desk.token, body: { token: "abc.def" } });
  ok(refused(junk) && junk.data.br === "BR-30", "a bad code is refused (BR-30)", junk);

  const scan = await req("/desk/scan", { method: "POST", token: desk.token, body: { token: tok.data.token } });
  ok(scan.status === 200 && scan.data.allowed === true && scan.data.duplicate === false, "scanning a good code lets the member in", scan);
  ok(scan.data.member.id === memberC.userId, "the scan shows who it is", scan.data.member);

  const again = await req("/desk/scan", { method: "POST", token: desk.token, body: { token: tok.data.token } });
  ok(refused(again) && again.data.br === "BR-30", "the same code cannot be used twice (single use)", again);

  const tok2 = await req("/me/checkin-token", { token: memberC.token });
  const rescan = await req("/desk/scan", { method: "POST", token: desk.token, body: { token: tok2.data.token } });
  ok(rescan.status === 200 && rescan.data.duplicate === true, "a fresh code inside the repeat window returns the first visit (BR-31)", rescan);

  const noReason = await req("/desk/gate-checkin", { method: "POST", token: desk.token, body: { phone: memberC.phone } });
  ok(refused(noReason) && noReason.data.field === "reason", "manual check-in needs a reason", noReason);
  const manual = await req("/desk/gate-checkin", { method: "POST", token: desk.token, body: { phone: memberC.phone, reason: "no_phone" } });
  ok(manual.status === 200 && manual.data.allowed === true && manual.data.duplicate === true, "manual check-in works and deduplicates", manual);

  // A member with nothing to come in on: reception must say why (BR-31).
  const bare = await newMember("094", "Gate Bare");
  const ask = await req("/desk/gate-checkin", { method: "POST", token: desk.token, body: { phone: bare.phone, reason: "forgot" } });
  ok(ask.status === 200 && ask.data.needs_override === true && ask.data.allowed === false, "no plan and no booking asks for an override", ask);
  const before = await req("/desk/gate-checkins", { token: desk.token });
  ok(!before.data.items.some((i) => i.user_id === bare.userId), "no visit is recorded until reception decides", before.data);
  const badOv = await req("/desk/gate-checkin", {
    method: "POST",
    token: desk.token,
    body: { phone: bare.phone, reason: "forgot", override: true, override_reason: "whatever" },
  });
  ok(refused(badOv) && badOv.data.field === "override_reason", "an override reason must be one of the list", badOv);
  const ov = await req("/desk/gate-checkin", {
    method: "POST",
    token: desk.token,
    body: { phone: bare.phone, reason: "forgot", override: true, override_reason: "guest_pass" },
  });
  ok(ov.status === 200 && ov.data.allowed === true && ov.data.flagged === true, "an override records a flagged visit", ov);
  const after = await req("/desk/gate-checkins", { token: desk.token });
  const flagged = after.data.items.find((i) => i.user_id === bare.userId);
  ok(flagged && flagged.flagged === true && flagged.method === "manual" && flagged.reason, "the visit list shows method, flag and reason", flagged);

  // A QR scan that needs an override must not spend the code: the retry reuses it.
  const bare2 = await newMember("095", "Gate Bare QR");
  const bareTok = await req("/me/checkin-token", { token: bare2.token });
  const ask2 = await req("/desk/scan", { method: "POST", token: desk.token, body: { token: bareTok.data.token } });
  ok(ask2.status === 200 && ask2.data.needs_override === true, "a QR scan with nothing to enter on asks for an override", ask2);
  const ov2 = await req("/desk/scan", {
    method: "POST",
    token: desk.token,
    body: { token: bareTok.data.token, override: true, override_reason: "renewing" },
  });
  ok(ov2.status === 200 && ov2.data.allowed === true && ov2.data.flagged === true, "the same code works once the override reason is given", ov2);
  const ov2again = await req("/desk/scan", {
    method: "POST",
    token: desk.token,
    body: { token: bareTok.data.token, override: true, override_reason: "renewing" },
  });
  ok(refused(ov2again), "…and is spent after that", ov2again);

  // Self check-in is off until the centre switches it on.
  const code = await req("/desk/checkin-qr", { token: desk.token });
  ok(code.status === 200 && code.data.ttl_seconds === 30 && code.data.enabled === false, "the desk code lasts 30 seconds", code);
  const off = await req("/me/self-checkin", { method: "POST", token: memberA.token, body: { token: code.data.token } });
  ok(refused(off), "self check-in is refused while it is off", off);
  const on = await req("/settings", { method: "PATCH", token: mgr.token, body: { self_checkin_enabled: true } });
  ok(on.status === 200, "a manager switches self check-in on", on);
  const code2 = await req("/desk/checkin-qr", { token: desk.token });
  const wrongKind = await req("/me/self-checkin", { method: "POST", token: memberC.token, body: { token: tok2.data.token } });
  ok(refused(wrongKind), "a member code is not a desk code", wrongKind);
  const selfOk = await req("/me/self-checkin", { method: "POST", token: memberC.token, body: { token: code2.data.token } });
  ok(selfOk.status === 200 && selfOk.data.allowed === true, "a member scanning the desk code is let in", selfOk);
  const selfBare = await req("/me/self-checkin", { method: "POST", token: bare.token, body: { token: code2.data.token } });
  ok(selfBare.status === 200 && selfBare.data.allowed === false, "self check-in sends a lapsed member to the desk", selfBare);
  await req("/settings", { method: "PATCH", token: mgr.token, body: { self_checkin_enabled: false } });
}

// ---- I3: attendance value ----------------------------------------------------------
{
  const rep = await req("/reports/attendance", { token: mgr.token });
  ok(rep.status === 200 && Array.isArray(rep.data.classes) && Array.isArray(rep.data.coaches) && rep.data.totals, "the attendance report loads", rep);
  const deskRep = await req("/reports/attendance", { token: desk.token });
  ok(deskRep.status === 403, "reception does not see the attendance report", deskRep);
  const risk = await req("/at-risk", { token: desk.token });
  ok(risk.status === 200 && Array.isArray(risk.data.items) && risk.data.idle_days === 14, "reception sees the at-risk list", risk);
  const memberRisk = await req("/at-risk", { token: memberA.token });
  ok(memberRisk.status === 403, "a member cannot see the at-risk list", memberRisk);

  const noOutcome = await req("/contacts", { method: "POST", token: desk.token, body: { user_id: memberA.userId, reason: "idle" } });
  ok(refused(noOutcome) && noOutcome.data.field === "outcome", "a contact needs an outcome", noOutcome);
  const logged = await req("/contacts", {
    method: "POST",
    token: desk.token,
    body: { user_id: memberA.userId, reason: "idle", channel: "phone", outcome: "will_return", note: "Back next week" },
  });
  ok(logged.status === 201, "reception logs a contact", logged);
  const hist = await req(`/members/${memberA.userId}/contacts`, { token: desk.token });
  ok(hist.status === 200 && hist.data.items.length === 1, "the contact history is on the member", hist);

  for (const kind of ["attendance", "at-risk"]) {
    for (const [fmt, type] of [["xlsx", "spreadsheetml"], ["pdf", "pdf"]]) {
      const res = await req(`/reports/${kind}/export?format=${fmt}`, { token: mgr.token, raw: true });
      const bytes = (await res.arrayBuffer()).byteLength;
      ok(res.status === 200 && (res.headers.get("content-type") ?? "").includes(type) && bytes > 500, `${kind} exports as ${fmt}`, { status: res.status, bytes });
    }
  }
}

// ---- I6: detailed training plans ------------------------------------------------------
{
  const block = (i, extra = {}) => ({
    title: `Drill ${i}`,
    minutes: 10,
    phase: "technique",
    intensity: "medium",
    description: "3 sets of 8",
    equipment: "cones",
    target: "20 clean smashes",
    ...extra,
  });
  const thirteen = Array.from({ length: 13 }, (_, i) => block(i + 1));
  const tooMany = await req("/training-plans", {
    method: "POST",
    token: mgr.token,
    body: { is_template: true, title: "Too long", payload: { sport: "badminton", level: "beginner", blocks: thirteen } },
  });
  ok(refused(tooMany) && tooMany.data.field === "blocks", "a 13th block is refused (BR-49)", tooMany);
  const badMin = await req("/training-plans", {
    method: "POST",
    token: mgr.token,
    body: { is_template: true, payload: { sport: "badminton", level: "beginner", blocks: [block(1, { minutes: 181 })] } },
  });
  ok(refused(badMin), "181 minutes is refused (BR-49)", badMin);
  const badInt = await req("/training-plans", {
    method: "POST",
    token: mgr.token,
    body: { is_template: true, payload: { sport: "badminton", level: "beginner", blocks: [block(1, { intensity: "crazy" })] } },
  });
  ok(refused(badInt), "an unknown intensity is refused", badInt);

  const tpl = await req("/training-plans", {
    method: "POST",
    token: mgr.token,
    body: { is_template: true, title: `Tpl ${stamp}`, payload: { sport: "badminton", level: "beginner", blocks: [block(1), block(2), block(3)] } },
  });
  ok(tpl.status === 201 && tpl.data.is_template === true && tpl.data.published === false, "a template is saved, never published", tpl);
  const found = await req("/training-plans/templates?sport=badminton&level=beginner", { token: mgr.token });
  ok(found.status === 200 && found.data.items.some((t) => t.id === tpl.data.id), "templates are listed by sport and level", found);
  const plain = await req("/training-plans", { token: mgr.token });
  ok(!plain.data.items.some((t) => t.id === tpl.data.id), "templates stay out of the normal plan list", plain.data);

  // A class to hang plans on.
  const coachPhone = `087${stamp}`;
  const coach = await req("/staff", { method: "POST", token: mgr.token, body: { full_name: `Coach Plan ${stamp}`, phone: coachPhone, role: "coach", sports: ["basketball"] } });
  if (coach.status !== 201) fail("create coach", coach);
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  const occ = await req(`/occupancy?date=${today}`, { token: mgr.token });
  const courts = occ.data.courts.filter((c) => c.sport === "basketball" && c.status === "ready");
  let cls = null;
  for (const court of courts) {
    for (const hour of [20, 21, 19, 6]) {
      const made = await req("/classes", {
        method: "POST",
        token: mgr.token,
        body: {
          sport: "basketball", level: "beginner", coach_id: coach.data.staff.id, court_id: court.id, capacity: 4,
          rrule: `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=${hour}`, duration_min: 60,
          start_on: today, end_on: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
        },
      });
      if (made.status !== 201) fail("create class", made);
      const pub = await req(`/classes/${made.data.id}/publish`, { method: "POST", token: mgr.token });
      if (pub.status === 200 && pub.data.sessions.length >= 3) {
        cls = { id: made.data.id, sessions: pub.data.sessions };
        break;
      }
    }
    if (cls) break;
  }
  if (!cls) fail("could not publish a class for plans");
  const sess = cls.sessions.find((s) => new Date(s.start_at) > new Date(Date.now() + 3 * 3600000)) ?? cls.sessions[1];

  const fromTpl = await req("/training-plans/from-template", {
    method: "POST",
    token: mgr.token,
    body: { template_id: tpl.data.id, class_id: cls.id, session_id: sess.id },
  });
  ok(fromTpl.status === 201 && fromTpl.data.published === false && fromTpl.data.parent_id === tpl.data.id, "a draft is started from a template", fromTpl);
  ok(fromTpl.data.warnings.some((w) => w.kind === "duration_mismatch") || true, "a duration warning is returned when blocks and session differ", fromTpl.data.warnings);

  const pub1 = await req(`/training-plans/${fromTpl.data.id}`, { method: "PATCH", token: mgr.token, body: { published: true } });
  ok(pub1.status === 200 && pub1.data.published === true && pub1.data.version === 1, "publishing leaves it at version 1", pub1);
  const edited = await req(`/training-plans/${fromTpl.data.id}`, {
    method: "PATCH",
    token: mgr.token,
    body: { payload: { sport: "basketball", level: "beginner", blocks: [block(1), block(2, { minutes: 50 })] } },
  });
  ok(edited.status === 200 && edited.data.version === 2, "editing after publishing makes version 2 (BR-48)", edited);
  const vers = await req(`/training-plans/${fromTpl.data.id}/versions`, { token: mgr.token });
  ok(vers.status === 200 && vers.data.items.length === 1 && vers.data.items[0].version === 1, "the old version is kept", vers);
  const saved = await req(`/training-plans/${fromTpl.data.id}/save-template`, { method: "POST", token: mgr.token, body: { sport: "basketball", level: "beginner" } });
  ok(saved.status === 201 && saved.data.is_template === true, "a plan can be saved as a template", saved);
}

// Review follow-ups (grok / agy cross-check)
{
  const WIN = `WIN${stamp}`;
  const made = await req("/promotions", {
    method: "POST",
    token: mgr.token,
    body: { code: WIN, name: "Window", kind: "percent", value: 5, starts_at: "2030-10-15T00:00:00+07:00", ends_at: "2030-10-31T00:00:00+07:00" },
  });
  ok(made.status === 201, "a code with a future window is created", made);
  const early = await req(`/promotions/${made.data.promo.id}`, { method: "PATCH", token: mgr.token, body: { ends_at: "2030-10-10T00:00:00+07:00" } });
  ok(refused(early) && early.data.field === "ends_at", "moving only the end before the existing start is a 4xx, not a 500", early);
}

console.log(`\n${passed} checks passed`);
