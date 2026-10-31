/**
 * Authorization matrix: every /v1 route × {anonymous, manager, receptionist, coach, member}.
 *
 *  - anonymous on a protected route        → 401 UNAUTHENTICATED
 *  - a signed-in role that is not allowed  → 403 FORBIDDEN
 *  - an allowed role on a read (GET)       → anything but 401/403/500
 *  - an allowed role on a write            → only probed when `probe: true`
 *    (a write with a made-up id that cannot change anything); never 401/403/500
 *
 * Owner checks (a member reaching into somebody else's booking) are not here —
 * they need real rows and live in 07-security.mjs.
 *
 *   node scripts/tests/agent/01-authz-matrix.mjs
 */
import { IDS, api, check, loginAll, summary } from "../agent-lib.mjs";

const X = IDS.nonexistent;
const M = "manager";
const R = "receptionist";
const C = "coach";
const U = "member";
const ALL = [M, R, C, U];
const DESK = [M, R];

/*
 * [method, path, allowed roles | "public", { probe, idem, body }]
 * `probe: true` → also send the write as an allowed role (safe: unknown id or empty body).
 */
const ROUTES = [
  ["GET", "/health", "public"],
  ["GET", "/plans", "public"],
  ["GET", "/courts", "public"],
  ["GET", "/classes", "public"],
  ["GET", "/price-rules", "public"],
  ["GET", "/flags", "public"],
  ["GET", "/payments/online/sequence", "public"],

  ["POST", "/auth/logout", ALL],
  ["GET", "/me", ALL],
  ["PATCH", "/me", ALL],
  ["GET", "/me/bookings", [U]],
  ["GET", "/me/attendance", [U]],
  ["GET", "/me/notifications", ALL],
  ["POST", "/me/notifications/read", ALL, { probe: true, body: { ids: [] } }],
  ["POST", "/me/password", ALL],
  ["GET", "/occupancy/detail", DESK],
  ["GET", "/availability", ALL],
  ["GET", "/occupancy", ALL],
  ["PATCH", `/courts/${X}`, [M], { probe: true, body: { status: "ready" } }],

  ["GET", "/staff", [M]],
  ["POST", "/staff", [M]],
  ["PATCH", `/staff/${X}`, [M], { probe: true, body: {} }],
  ["POST", `/staff/${X}/reset-password`, [M], { probe: true }],
  ["POST", `/staff/${X}/revoke-sessions`, [M], { probe: true }],

  ["GET", "/directory/members", [M]],
  ["GET", "/members?q=a", [M, R, C]],
  ["POST", "/members", DESK],
  ["GET", `/members/${X}`, [M, R, C]],
  ["POST", `/members/${X}/reset-password`, DESK, { probe: true }],
  ["PATCH", `/members/${X}`, DESK, { probe: true, body: {} }],

  ["POST", "/plans", [M]],
  ["GET", `/plans/${X}`, [M]],
  ["PATCH", `/plans/${X}`, [M], { probe: true, body: {} }],
  ["POST", "/subscriptions", [M, R, U]],
  // Same route with a real plan id, so a disallowed role cannot hide behind "plan_id is required".
  ["POST", "/subscriptions", [M, R, U], { body: { plan_id: IDS.planBadminton30 }, tagSuffix: " (with plan_id)" }],

  ["POST", "/bookings", [U], { idem: true }],
  ["POST", `/bookings/${X}/confirm`, [U], { idem: true, probe: true, body: { method: "quota" } }],
  ["POST", `/bookings/${X}/transfer-confirm`, DESK, { probe: true }],
  ["POST", `/bookings/${X}/transfer-reject`, DESK, { probe: true, body: {} }],
  ["POST", `/bookings/${X}/collect-balance`, DESK, { probe: true, body: {} }],
  ["POST", `/bookings/${X}/reschedule`, [U], { probe: true, body: {} }],
  ["POST", `/bookings/${X}/check-in`, DESK, { probe: true }],
  ["POST", "/walk-in", DESK, { idem: true }],

  ["POST", "/shifts/open", [R]],
  ["GET", "/shifts/current", DESK],
  ["POST", `/shifts/${X}/close`, [R], { probe: true, body: { counted_cash_vnd: 0 } }],

  ["POST", "/classes", [M]],
  ["POST", `/classes/${X}/publish`, [M], { probe: true }],
  ["POST", `/classes/${X}/enroll`, [M, R, U], { probe: true, body: {} }],
  ["GET", `/classes/${X}`, [M, R, C]],
  ["GET", `/classes/${X}/roster`, [M, R, C]],
  ["PATCH", `/classes/${X}`, [M], { probe: true, body: {} }],
  ["POST", `/classes/${X}/coach`, [M], { probe: true, body: {} }],
  ["POST", `/sessions/${X}/cancel`, [M], { probe: true, body: {} }],
  ["POST", `/sessions/${X}/reschedule`, [M], { probe: true, body: {} }],
  ["GET", "/coach/schedule", [M, C]],
  ["GET", "/coach/classes", [M, C]],

  ["GET", "/payments/pending", DESK],
  ["POST", "/payments", DESK, { idem: true }],
  ["POST", `/payments/${X}/refund`, DESK, { probe: true, body: { amount_vnd: 1000, reason: "matrix" } }],
  ["POST", `/payments/${X}/approve-refund`, [M], { probe: true, body: {} }],
  ["POST", `/payments/${X}/reject-refund`, [M], { probe: true, body: {} }],
  // Refused for every signed-in role; anonymous gets 401 first (rule 6.0).
  ["DELETE", `/payments/${X}`, "nobody"],

  ["POST", "/series/preview", DESK],
  ["POST", "/series", DESK],
  ["GET", "/series", [M, R, U]],
  ["POST", `/series/${X}/cancel`, DESK, { probe: true, body: {} }],

  ["GET", "/me/points", [U]],
  ["POST", "/me/points/redeem", [U]],
  ["GET", `/members/${X}/points`, DESK],
  ["POST", `/members/${X}/points`, [M], { probe: true, body: { points: 1, reason: "matrix" } }],

  ["GET", "/commission", [M]],
  ["POST", "/commission/close", [M]],
  ["PATCH", `/commission/rates/${X}`, [M], { probe: true, body: { rate_pct: 10 } }],
  ["POST", `/commission/pay/${X}`, [M], { probe: true }],
  ["GET", "/me/earnings", [C]],

  ["GET", "/work-orders", [M, R, C]],
  ["POST", "/work-orders", [M, R, C]],
  ["PATCH", `/work-orders/${X}`, DESK, { probe: true, body: {} }],

  ["GET", "/invoices/export-list", [M]],
  ["GET", "/invoices/export", [M]],
  ["GET", `/invoices/${X}.xml`, DESK],
  ["GET", "/invoices", [M, R, U]],
  ["GET", `/invoices/${X}.pdf`, [M, R, U]],

  ["GET", "/reports/attendance", [M, C]],
  ["GET", "/at-risk", [M, R, C]],
  ["POST", "/contacts", [M, R, C]],
  // A coach may read contacts only for their own students, so a made-up member is 403 for them too.
  ["GET", `/members/${X}/contacts`, DESK],
  ["GET", "/reports/revenue/export", [M]],
  ["GET", "/reports/revenue", [M]],
  ["GET", "/reports/capacity", [M]],
  ["GET", "/reports/members", [M]],
  ["GET", "/reports/occupancy", [M]],

  ["GET", "/settings", [M, R, C]],
  ["PATCH", "/settings", [M]],
  ["PUT", "/price-rules", [M]],
  ["GET", "/audit", [M]],

  ["POST", `/subscriptions/${X}/freeze`, DESK, { probe: true, body: { days: 3 } }],
  ["POST", `/subscriptions/${X}/unfreeze`, DESK, { probe: true }],
  ["POST", `/subscriptions/${X}/decline`, DESK, { probe: true }],
  ["POST", `/waitlist/${X}/accept`, [U], { probe: true }],

  ["GET", "/equipment", ALL],
  ["GET", "/equipment/loans", DESK],
  ["POST", "/equipment/loans", DESK],
  ["POST", `/equipment/loans/${X}/return`, DESK, { probe: true }],

  ["GET", `/sessions/${X}/attendance`, [M, C]],
  ["POST", `/sessions/${X}/attendance`, [M, C], { probe: true, body: { marks: [] } }],
  ["GET", "/training-plans", ALL],
  ["POST", "/training-plans", [M, C]],
  ["POST", "/training-plans/suggest", [M, C]],
  ["GET", "/training-plans/templates", [M, C]],
  ["POST", "/training-plans/from-template", [M, C]],
  ["POST", `/training-plans/${X}/save-template`, [M, C], { probe: true, body: {} }],
  ["GET", `/training-plans/${X}/versions`, [M, C]],
  ["PATCH", `/training-plans/${X}`, [M, C], { probe: true, body: {} }],
  ["POST", `/classes/${X}/plans/duplicate-week`, [M, C], { probe: true, body: {} }],
  ["GET", `/sessions/${X}/results`, [M, C]],
  ["PUT", `/sessions/${X}/results`, [M, C], { probe: true, body: { results: [] } }],
  ["GET", `/students/${X}/profile`, [M, C]],
  ["PUT", `/students/${X}/level`, [M, C], { probe: true, body: {} }],
  ["POST", `/students/${X}/notes`, [M, C], { probe: true, body: {} }],
  ["POST", `/students/${X}/reviews`, [M, C], { probe: true, body: {} }],
  ["GET", "/homework", [M, C]],
  ["POST", "/homework", [M, C]],
  ["GET", "/me/training", [U]],
  ["PUT", "/me/training-goal", [U]],
  ["GET", "/me/homework", [U]],
  ["PUT", `/me/homework/${X}`, [U], { probe: true, body: {} }],

  ["POST", "/desk/gate-checkin", DESK],
  ["POST", "/desk/scan", DESK],
  ["GET", "/desk/checkin-qr", DESK],
  ["GET", "/desk/gate-checkins", DESK],
  ["GET", "/me/checkin-token", [U]],
  ["GET", `/me/bookings/${X}/checkin-token`, [U]],
  ["POST", "/me/self-checkin", [U]],

  ["GET", "/promotions", [M]],
  ["POST", "/promotions/validate", ALL],
  ["POST", "/promotions", [M]],
  ["PATCH", `/promotions/${X}`, [M], { probe: true, body: {} }],
  ["GET", `/promotions/${X}/redemptions`, [M]],

  ["POST", "/assistant", ALL],
  ["GET", "/tickets/mine", ALL],
  ["GET", "/tickets", DESK],
  ["POST", "/tickets", ALL],
  ["POST", `/tickets/${X}/reply`, DESK, { probe: true, body: { reply: "matrix" } }],
  ["POST", `/tickets/${X}/close`, DESK, { probe: true }],
  ["PATCH", "/flags", [M]],

  ["POST", "/payments/online", ALL],
  ["POST", `/payments/online/${X}/verify`, ALL, { probe: true }],
];

const who = await loginAll();
const tokens = {
  manager: who.manager.token,
  receptionist: who.receptionist.token,
  coach: who.coach.token,
  member: who.memberNoPlan.token,
};

let n = 0;
for (const [method, path, allowed, opt = {}] of ROUTES) {
  const send = (token) =>
    api(path, { method, token, idem: opt.idem, body: method === "GET" ? undefined : opt.body ?? {} });
  const tag = `${method} ${path.replace(X, ":id")}${opt.tagSuffix ?? ""}`;

  if (allowed === "nobody") {
    for (const role of [undefined, ...ALL]) {
      n += 1;
      if (role === undefined) {
        check(`AZ-${n}`, `${tag} — anonymous → 401`, await send(undefined), {
          status: 401,
          code: "UNAUTHENTICATED",
        });
      } else {
        check(`AZ-${n}`, `${tag} — ${role} → 403`, await send(tokens[role]), {
          status: 403,
          code: "FORBIDDEN",
        });
      }
    }
    continue;
  }

  if (allowed === "public") {
    n += 1;
    check(`AZ-${n}`, `${tag} — anonymous allowed`, await send(undefined), { status: 200 });
    continue;
  }

  n += 1;
  check(`AZ-${n}`, `${tag} — anonymous → 401`, await send(undefined), { status: 401, code: "UNAUTHENTICATED" });

  for (const role of ALL) {
    const isAllowed = allowed.includes(role);
    if (!isAllowed) {
      n += 1;
      check(`AZ-${n}`, `${tag} — ${role} → 403`, await send(tokens[role]), { status: 403, code: "FORBIDDEN" });
      continue;
    }
    if (method !== "GET" && !opt.probe) continue;
    n += 1;
    check(`AZ-${n}`, `${tag} — ${role} allowed (not 401/403/500)`, await send(tokens[role]), {
      notStatus: [401, 403, 500],
    });
  }
}

summary();
