#!/usr/bin/env node
/**
 * Live checks for the FIXLIST fixes. Run against a dev server on in-memory PGLite
 * (`DATABASE_URL= PGLITE_DATA_DIR=memory npm run dev`), never against production:
 * it writes settings and raises refunds.
 *
 *   BASE=http://127.0.0.1:8080 node scripts/arena3-fixes-check.mjs
 */
const BASE = (process.env.BASE ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const PASS = "ChangeMe!a3";
let passed = 0;

function fail(msg, extra) {
  console.error("FAIL", msg, extra === undefined ? "" : JSON.stringify(extra));
  process.exit(1);
}
function ok(cond, msg, extra) {
  if (!cond) fail(msg, extra);
  passed += 1;
  console.log("ok  ", msg);
}

async function req(path, { method = "GET", token, body, idem } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (idem) headers["idempotency-key"] = crypto.randomUUID();
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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
const member = await login("0901230101");

// ---- B-01 / G-01: settings ------------------------------------------------
{
  const cur = await req("/settings", { token: mgr.token });
  ok(cur.status === 200, "B-01 read settings", cur);
  const save = await req("/settings", {
    method: "PATCH",
    token: mgr.token,
    body: { legal_name: "Arena3 Sports Center", hold_minutes: "10", open_time: "06:00", close_time: "22:00", tax_code: "0312345678" },
  });
  ok(save.status === 200 && save.data.hold_minutes === 10, "B-01 a valid save succeeds", save);

  const blank = await req("/settings", { method: "PATCH", token: mgr.token, body: { gate_dedup_minutes: "" } });
  ok(blank.status === 400 && blank.data.field === "gate_dedup_minutes", "B-01 blank number is a 400 naming the field", blank);

  const big = await req("/settings", { method: "PATCH", token: mgr.token, body: { gate_dedup_minutes: 99999999999 } });
  ok(big.status === 400 && big.data.field === "gate_dedup_minutes", "B-01 over-int is a 400 naming the field", big);

  const long = await req("/settings", { method: "PATCH", token: mgr.token, body: { tax_code: "1".repeat(40) } });
  ok(long.status === 400 && long.data.field === "tax_code", "B-01 too-long text is a 400 naming the field", long);

  const hours = await req("/settings", { method: "PATCH", token: mgr.token, body: { close_time: "05:00" } });
  ok(hours.status === 400 && hours.data.field === "close_time", "B-01 close before open is refused", hours);

  const after = await req("/settings", { token: mgr.token });
  ok(after.data.hold_minutes === 10, "B-01 refused saves changed nothing", after.data);
  const notMgr = await req("/settings", { method: "PATCH", token: desk.token, body: { hold_minutes: 5 } });
  ok(notMgr.status === 403, "B-01 receptionist cannot change settings", notMgr);
}

// ---- B-02: refund queue ---------------------------------------------------
{
  // A paid court for the member, refunded above the receptionist limit.
  const settings = (await req("/settings", { token: mgr.token })).data;
  const limit = Number(settings.refund_manager_vnd);
  const shift = await req("/shifts/open", { method: "POST", token: desk.token });
  ok(shift.status === 201 || shift.status === 409, "B-02 desk has a till open", shift);

  // Lower the threshold so a small payment trips it.
  await req("/settings", { method: "PATCH", token: mgr.token, body: { refund_manager_vnd: 1000 } });
  const pending = await req("/payments/pending", { token: desk.token });
  ok(pending.status === 200, "B-02 queue readable", pending);

  // A member made for this check, so the run is repeatable and touches nobody real.
  const stamp = String(Date.now()).slice(-7);
  const created = await req("/members", {
    method: "POST",
    token: desk.token,
    body: { full_name: `Refund Check ${stamp}`, phone: `091${stamp}`, pii_consent: true },
  });
  const memberUser = created.data?.user;
  ok(created.status === 201 && memberUser?.id, "B-02 made a member to refund", created);
  const plans = (await req("/plans")).data.items;
  const plan = plans.find((p) => p.is_on_sale !== false && p.price_vnd > 0) ?? plans[0];
  const order = await req("/subscriptions", {
    method: "POST",
    token: desk.token,
    body: { plan_id: plan.id, user_id: memberUser.id },
  });
  ok(order.status === 201 && order.data.subscription?.id, "B-02 plan ordered", order);
  const pay = await req("/payments", {
    method: "POST",
    token: desk.token,
    idem: true,
    body: { ref_type: "subscription", ref_id: order.data.subscription.id, method: "cash", amount_vnd: plan.price_vnd },
  });
  ok(pay.status === 201, "B-02 plan paid", pay);
  const payment = pay.data.payment;
  const refund = await req(`/payments/${payment.id}/refund`, {
    method: "POST",
    token: desk.token,
    body: { amount_vnd: plan.price_vnd, reason: "check" },
  });
  ok(refund.status === 201 && refund.data.payment.status === "refund_pending", "B-02 large refund waits for a manager", refund);
  const queue = await req("/payments/pending", { token: mgr.token });
  ok(queue.data.refunds.some((r) => r.id === refund.data.payment.id), "B-02 manager sees it in the queue", queue.data.refunds);
  const selfApprove = await req(`/payments/${refund.data.payment.id}/approve-refund`, { method: "POST", token: desk.token });
  ok(selfApprove.status === 403, "B-02 receptionist cannot approve", selfApprove);
  const approve = await req(`/payments/${refund.data.payment.id}/approve-refund`, { method: "POST", token: mgr.token });
  ok(approve.status === 200 && approve.data.status === "posted", "B-02 manager approves", approve);
  const again = await req(`/payments/${refund.data.payment.id}/reject-refund`, { method: "POST", token: mgr.token });
  ok(again.status === 409, "B-02 cannot be decided twice", again);
  const audit = await req("/audit?action=refund_approved", { token: mgr.token });
  ok(audit.data?.items?.some((a) => a.entity_id === refund.data.payment.id), "B-02 decision is audited", audit.data);
  const mlogin = await req("/auth/login", {
    method: "POST",
    body: { login: memberUser.phone, password: created.data.temp_password },
  });
  ok(mlogin.status === 200, "B-02 member can sign in with the temp password", mlogin);
  const inbox = await req("/me", { token: mlogin.data.token });
  ok(
    inbox.data?.inbox?.some((n) => n.template === "refund_approved"),
    "B-02 member was told in-app",
    inbox.data?.inbox?.map((n) => n.template),
  );
  await req("/settings", { method: "PATCH", token: mgr.token, body: { refund_manager_vnd: limit } });
}

// ---- B-12 / B-17 / D-05: gear ----------------------------------------------
{
  const eq = await req("/equipment", { token: desk.token });
  const item = eq.data.items.find((i) => i.stock >= 2);
  ok(!!item, "gear: an item with stock exists", eq.data);
  const noPhone = await req("/equipment/loans", { method: "POST", token: desk.token, body: { item_id: item.id, qty: 1 } });
  ok(noPhone.status === 400 && noPhone.data.field === "phone", "B-12 missing phone names the field", noPhone);
  const tooMany = await req("/equipment/loans", {
    method: "POST",
    token: desk.token,
    body: { item_id: item.id, phone: "0987654321", qty: item.stock + 1 },
  });
  ok(tooMany.status === 422 && tooMany.data.br === "BR-50", "B-12 server refuses more than the stock", tooMany);
  const found = await req("/members?q=0901230101", { token: desk.token });
  const m = found.data.items[0];
  ok(!!m, "B-17 member is found by phone", found.data);
  const byMember = await req("/equipment/loans", {
    method: "POST",
    token: desk.token,
    body: { item_id: item.id, user_id: m.id, qty: 2 },
  });
  ok(byMember.status === 201 && byMember.data.loan.phone === m.phone, "B-17 member rents by account", byMember);
  const afterOut = (await req("/equipment", { token: desk.token })).data.items.find((i) => i.id === item.id);
  ok(afterOut.stock === item.stock - 2, "B-17 stock comes down by the quantity", afterOut);
  const loans = await req("/equipment/loans", { token: desk.token });
  const mine = loans.data.items.find((l) => l.id === byMember.data.loan.id);
  ok(mine?.member_name === m.full_name, "B-17 loan list names the member", mine);
  const back = await req(`/equipment/loans/${byMember.data.loan.id}/return`, { method: "POST", token: desk.token });
  ok(back.status === 200, "D-05 return works", back);
  const afterBack = (await req("/equipment", { token: desk.token })).data.items.find((i) => i.id === item.id);
  ok(afterBack.stock === item.stock, "D-05 return restores exactly that loan's quantity", afterBack);
  const twice = await req(`/equipment/loans/${byMember.data.loan.id}/return`, { method: "POST", token: desk.token });
  ok(twice.status === 409, "D-05 a loan cannot be returned twice", twice);
}

// ---- B-13: notifications can be read ----------------------------------------
{
  const me = await req("/me", { token: member.token });
  const first = me.data.inbox[0];
  if (first) {
    ok("read_at" in first, "B-13 inbox rows carry read_at", first);
    const mark = await req("/me/notifications/read", { method: "POST", token: member.token, body: { id: first.id } });
    ok(mark.status === 200, "B-13 mark one read", mark);
    const after = (await req("/me", { token: member.token })).data.inbox.find((n) => n.id === first.id);
    ok(!!after.read_at, "B-13 it stays read", after);
  } else {
    console.log("skip B-13 (member has no notifications in the seed)");
  }
  const bad = await req("/me/notifications/read", { method: "POST", token: member.token, body: { id: "nope" } });
  ok(bad.status === 400 && bad.data.field === "id", "B-13 bad id names the field", bad);
}

// ---- B-09 / C-01 / C-06: class code and detail ---------------------------------
{
  const list = await req("/classes", { token: desk.token });
  const c = list.data.items?.[0];
  ok(!!c?.code, "B-09 classes carry a code", c);
  const detail = await req(`/classes/${c.id}`, { token: desk.token });
  ok(detail.status === 200 && detail.data.class.code === c.code && Array.isArray(detail.data.sessions), "C-06 class detail opens", detail);
  const codes = list.data.items.map((i) => i.code);
  ok(new Set(codes).size === codes.length, "B-09 every class code is unique", codes);
}

// ---- B-05: hold -> confirm, every outcome is a code, none is a bare 500 ------
{
  // A member made for this check, so nobody real has their daily slots used up.
  const stamp5 = String(Date.now()).slice(-7);
  const made = await req("/members", {
    method: "POST",
    token: desk.token,
    body: { full_name: `Booking Check ${stamp5}`, phone: `092${stamp5}`, pii_consent: true },
  });
  ok(made.status === 201, "B-05 made a member to book with", made);
  const m5 = await login(made.data.user.phone, made.data.temp_password);
  // A date two days out, a court of the member's sport, an hour nobody holds.
  const ict = (d) => new Date(Date.now() + d * 86400000 + 7 * 3600000).toISOString().slice(0, 10);
  const date = ict(2);
  const occ = await req(`/occupancy?date=${date}`, { token: m5.token });
  const court = occ.data.courts.find((c) => c.sport === "badminton" && c.status === "ready");
  const busy = new Set(occ.data.slots.filter((s) => s.court_id === court.id).map((s) => new Date(s.start).getTime()));
  let hour = 7;
  while (busy.has(new Date(`${date}T${String(hour).padStart(2, "0")}:00:00+07:00`).getTime())) hour += 1;
  const startAt = `${date}T${String(hour).padStart(2, "0")}:00:00+07:00`;

  const h1 = await req("/bookings", { method: "POST", token: m5.token, body: { court_id: court.id, start_at: startAt }, idem: true });
  ok(h1.status === 201 && h1.data.booking?.status === "hold", "B-05 hold is created", h1);

  // Another member reaches for the same slot.
  const made2 = await req("/members", {
    method: "POST",
    token: desk.token,
    body: { full_name: `Booking Rival ${stamp5}`, phone: `093${stamp5}`, pii_consent: true },
  });
  const other = made2.status === 201 ? await login(made2.data.user.phone, made2.data.temp_password) : null;
  ok(!!other, "B-05 made a second member", made2);
  {
    const h2 = await req("/bookings", { method: "POST", token: other.token, body: { court_id: court.id, start_at: startAt }, idem: true });
    ok(h2.status === 409 && h2.data.code === "CONFLICT_SLOT", "B-05 the same slot twice is CONFLICT_SLOT", h2);
  }

  const badMethod = await req(`/bookings/${h1.data.booking.id}/confirm`, { method: "POST", token: m5.token, body: { method: "cash" }, idem: true });
  ok(badMethod.status === 403, "B-05 a member cannot mark it paid in cash", badMethod);

  const viaTransfer = await req(`/bookings/${h1.data.booking.id}/confirm`, { method: "POST", token: m5.token, body: { method: "transfer" }, idem: true });
  ok(viaTransfer.status === 202 && viaTransfer.data.awaiting_transfer === true, "B-05 transfer waits for reception", viaTransfer);

  const again = await req(`/bookings/${h1.data.booking.id}/confirm`, { method: "POST", token: m5.token, body: { method: "quota" }, idem: true });
  ok(again.status === 409, "B-05 confirming a booking already awaiting transfer is a 409, not a 500", again);

  const cancel = await req(`/bookings/${h1.data.booking.id}/cancel`, { method: "POST", token: m5.token });
  ok(cancel.status === 200, "B-05 the held court can be released", cancel);
}

console.log(`\n${passed} checks passed`);
