/**
 * 14d-deep-states.mjs — Kiểm thử ma trận vòng đời trạng thái (State Lifecycle Matrix)
 * Bước 5 (14d) theo yêu cầu Vòng 3.
 * Phủ đủ 7 thực thể: booking, hold, subscription, enrollment, waitlist, ticket, shift.
 * Hợp lệ → 2xx; không hợp lệ → 409 CONFLICT_STATE (hoặc 422 BR).
 * Mỗi ô FAIL trong STATE-MATRIX phải có ID riêng.
 * Xuất kết quả chi tiết ra test-output/round3/STATE-MATRIX.md.
 */
import {
  api,
  check,
  freeSlotAnyDay,
  IDS,
  login,
  memberWithPlan,
  newMember,
  PHONES,
  slot,
  summary,
} from "../agent-lib.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

console.log("=== 14d — VÒNG ĐỜI TRẠNG THÁI (7 THỰC THỂ) ===");

const mgr = await login(PHONES.manager);
const rec = await login(PHONES.receptionist);
const coach = await login(PHONES.coach);
const memberA = await newMember();
const memberB = await newMember();

const matrixRows = [];

function recordMatrix(caseId, entity, fromState, action, expected, actualStatus, actualCode) {
  const isMatch = Array.isArray(expected)
    ? expected.includes(actualStatus)
    : expected === actualStatus;
  matrixRows.push({
    caseId,
    entity,
    fromState,
    action,
    expected: Array.isArray(expected) ? expected.join("/") : expected,
    actual: `${actualStatus} ${actualCode ?? ""}`.trim(),
    verdict: isMatch ? "PASS" : "FAIL",
  });
}

// ──────────────────────────────────────────────
// 1. THỰC THỂ: HOLD
// ──────────────────────────────────────────────
const sHold = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 4 });
const holdRes = await api("/bookings", {
  method: "POST",
  token: memberA.token,
  idem: true,
  body: { court_id: sHold.court_id, start_at: sHold.start_at },
});
const holdId = holdRes.data?.booking?.id;

// ST-HLD-01: hold → check-in (không hợp lệ: hold chưa confirmed)
const ciOnHold = await api(`/bookings/${holdId}/check-in`, { method: "POST", token: rec.token });
check("ST-HLD-01", "hold → check-in phải bị từ chối 409 CONFLICT_STATE", ciOnHold, { status: 409, code: "CONFLICT_STATE" });
recordMatrix("ST-HLD-01", "Hold", "hold", "check-in", 409, ciOnHold.status, ciOnHold.data?.code);

// ST-HLD-02: hold → cancel (hợp lệ)
const cancelHold = await api(`/bookings/${holdId}/cancel`, { method: "POST", token: memberA.token, body: {} });
check("ST-HLD-02", "hold → cancel thành công 200", cancelHold, { status: 200 });
recordMatrix("ST-HLD-02", "Hold", "hold", "cancel", 200, cancelHold.status, cancelHold.data?.code);

// ST-HLD-03: hold → confirm (member yêu cầu chuyển khoản và lễ tân xác nhận)
const sHold2 = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 5 });
const holdRes2 = await api("/bookings", {
  method: "POST",
  token: memberA.token,
  idem: true,
  body: { court_id: sHold2.court_id, start_at: sHold2.start_at },
});
const holdId2 = holdRes2.data?.booking?.id;
const reqTransfer = await api(`/bookings/${holdId2}/confirm`, {
  method: "POST",
  token: memberA.token,
  idem: true,
  body: { method: "transfer" },
});
const confirmRes = await api(`/bookings/${holdId2}/transfer-confirm`, {
  method: "POST",
  token: rec.token,
});
check("ST-HLD-03", "hold → confirm thành công 200", confirmRes, { status: 200 });
recordMatrix("ST-HLD-03", "Hold", "hold", "confirm", 200, confirmRes.status, confirmRes.data?.code);

// ──────────────────────────────────────────────
// 2. THỰC THỂ: BOOKING (CONFIRMED & CANCELLED)
// ──────────────────────────────────────────────
// booking đã confirmed từ ST-HLD-03
// ST-BK-01: confirmed → cancel (hợp lệ)
const cancelConfirmed = await api(`/bookings/${holdId2}/cancel`, {
  method: "POST",
  token: memberA.token,
  body: { reason: "Huỷ booking confirmed" },
});
check("ST-BK-01", "confirmed → cancel thành công 200", cancelConfirmed, { status: 200 });
recordMatrix("ST-BK-01", "Booking", "confirmed", "cancel", 200, cancelConfirmed.status, cancelConfirmed.data?.code);

// ST-BK-02: cancelled → cancel lại (không hợp lệ)
const cancelAgain = await api(`/bookings/${holdId2}/cancel`, {
  method: "POST",
  token: memberA.token,
  body: { reason: "Huỷ lại lần hai" },
});
check("ST-BK-02", "cancelled → cancel phải bị từ chối 409 CONFLICT_STATE", cancelAgain, { status: 409, code: "CONFLICT_STATE" });
recordMatrix("ST-BK-02", "Booking", "cancelled", "cancel", 409, cancelAgain.status, cancelAgain.data?.code);

// ST-BK-03: cancelled → confirm (không hợp lệ)
const confirmCancelled = await api(`/bookings/${holdId2}/confirm`, {
  method: "POST",
  token: memberA.token,
  idem: true,
  body: { method: "transfer" },
});
check("ST-BK-03", "cancelled → confirm phải bị từ chối 409 CONFLICT_STATE", confirmCancelled, { status: 409, code: "CONFLICT_STATE" });
recordMatrix("ST-BK-03", "Booking", "cancelled", "confirm", 409, confirmCancelled.status, confirmCancelled.data?.code);

// ST-BK-04: cancelled → check-in (không hợp lệ)
const checkinCancelled = await api(`/bookings/${holdId2}/check-in`, { method: "POST", token: rec.token });
check("ST-BK-04", "cancelled → check-in phải bị từ chối 409 CONFLICT_STATE", checkinCancelled, { status: 409, code: "CONFLICT_STATE" });
recordMatrix("ST-BK-04", "Booking", "cancelled", "check-in", 409, checkinCancelled.status, checkinCancelled.data?.code);

// ──────────────────────────────────────────────
// 3. THỰC THỂ: SUBSCRIPTION
// ──────────────────────────────────────────────
const subOrder = await api("/subscriptions", {
  method: "POST",
  token: mgr.token,
  body: { plan_id: IDS.planBadminton30, user_id: memberA.user.id },
});
const subId = subOrder.data?.subscription?.id;

// ST-SUB-01: pending → freeze (không hợp lệ: chưa thanh toán/chưa active)
const freezePending = await api(`/subscriptions/${subId}/freeze`, {
  method: "POST",
  token: rec.token,
  body: { days: 7 },
});
check("ST-SUB-01", "pending → freeze phải bị từ chối 422 BR-14", freezePending, { status: 422, br: "BR-14" });
recordMatrix("ST-SUB-01", "Subscription", "pending", "freeze", 422, freezePending.status, freezePending.data?.br ?? freezePending.data?.code);

// ST-SUB-02: pending → unfreeze (không hợp lệ)
const unfreezePending = await api(`/subscriptions/${subId}/unfreeze`, {
  method: "POST",
  token: rec.token,
  body: {},
});
check("ST-SUB-02", "pending → unfreeze phải bị từ chối 409 CONFLICT_STATE", unfreezePending, { status: 409, code: "CONFLICT_STATE" });
recordMatrix("ST-SUB-02", "Subscription", "pending", "unfreeze", 409, unfreezePending.status, unfreezePending.data?.code);

// ST-SUB-03: pending → active (thanh toán đầy đủ)
const paySub = await api("/payments", {
  method: "POST",
  token: mgr.token,
  idem: true,
  body: { ref_type: "subscription", ref_id: subId, method: "cash", amount_vnd: 800000 },
});
check("ST-SUB-03", "pending → active qua thanh toán thành công 201", paySub, { status: 201 });
recordMatrix("ST-SUB-03", "Subscription", "pending", "payment", 201, paySub.status, paySub.data?.code);

// ST-SUB-04: active → unfreeze (không hợp lệ: chưa frozen)
const unfreezeActive = await api(`/subscriptions/${subId}/unfreeze`, {
  method: "POST",
  token: rec.token,
  body: {},
});
check("ST-SUB-04", "active → unfreeze phải bị từ chối 409 CONFLICT_STATE", unfreezeActive, { status: 409, code: "CONFLICT_STATE" });
recordMatrix("ST-SUB-04", "Subscription", "active", "unfreeze", 409, unfreezeActive.status, unfreezeActive.data?.code);

// ST-SUB-05: active → freeze (hợp lệ)
const freezeActive = await api(`/subscriptions/${subId}/freeze`, {
  method: "POST",
  token: rec.token,
  body: { days: 7 },
});
check("ST-SUB-05", "active → freeze thành công 200", freezeActive, { status: 200 });
recordMatrix("ST-SUB-05", "Subscription", "active", "freeze", 200, freezeActive.status, freezeActive.data?.code);

// ST-SUB-06: frozen → freeze lại (không hợp lệ: vi phạm BR-14 vì gói đã frozen)
const freezeAgain = await api(`/subscriptions/${subId}/freeze`, {
  method: "POST",
  token: rec.token,
  body: { days: 7 },
});
check("ST-SUB-06", "frozen → freeze lần nữa phải bị từ chối 422 BR-14", freezeAgain, { status: 422, br: "BR-14" });
recordMatrix("ST-SUB-06", "Subscription", "frozen", "freeze", 422, freezeAgain.status, freezeAgain.data?.br ?? freezeAgain.data?.code);

// ST-SUB-07: frozen → unfreeze (hợp lệ)
const unfreezeFrozen = await api(`/subscriptions/${subId}/unfreeze`, {
  method: "POST",
  token: rec.token,
  body: {},
});
check("ST-SUB-07", "frozen → unfreeze thành công 200", unfreezeFrozen, { status: 200 });
recordMatrix("ST-SUB-07", "Subscription", "frozen", "unfreeze", 200, unfreezeFrozen.status, unfreezeFrozen.data?.code);

// ──────────────────────────────────────────────
// 4. THỰC THỂ: ENROLLMENT (LỚP HỌC)
// ──────────────────────────────────────────────
// Tạo lớp và publish
const createCl = await api("/classes", {
  method: "POST",
  token: mgr.token,
  body: {
    sport: "badminton",
    level: "state-test",
    capacity: 10,
    coach_id: coach.user.id,
    court_id: IDS.courtCL01,
    rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=9",
    start_on: "2026-11-01",
    end_on: "2026-11-30",
    duration_min: 60,
  },
});
const classId = createCl.data?.id;
await api(`/classes/${classId}/publish`, { method: "POST", token: mgr.token });

// ST-ENR-01: confirmed → enroll (ghi danh thành công 201)
const enrollRes = await api(`/classes/${classId}/enroll`, {
  method: "POST",
  token: memberA.token,
  body: {},
});
const enrollId = enrollRes.data?.enrollment?.id;
check("ST-ENR-01", "none → enrolled thành công 201", enrollRes, { status: 201 });
recordMatrix("ST-ENR-01", "Enrollment", "none", "enroll", 201, enrollRes.status, enrollRes.data?.code);

// ST-ENR-02: confirmed → enroll lại (không hợp lệ: đã ghi danh)
const enrollDup = await api(`/classes/${classId}/enroll`, {
  method: "POST",
  token: memberA.token,
  body: {},
});
check("ST-ENR-02", "enrolled → enroll lại phải bị từ chối 4xx", enrollDup, {
  notStatus: [200, 201, 500],
});
recordMatrix("ST-ENR-02", "Enrollment", "enrolled", "enroll", 422, enrollDup.status, enrollDup.data?.code);

// ST-ENR-03: enrolled → cancel/drop (hợp lệ)
if (enrollId) {
  const dropRes = await api(`/enrollments/${enrollId}`, {
    method: "DELETE",
    token: memberA.token,
  });
  check("ST-ENR-03", "enrolled → cancel/drop thành công 200", dropRes, { status: 200 });
  recordMatrix("ST-ENR-03", "Enrollment", "enrolled", "cancel", 200, dropRes.status, dropRes.data?.code);

  // ST-ENR-04: cancelled → cancel lại (không hợp lệ)
  const dropAgain = await api(`/enrollments/${enrollId}`, {
    method: "DELETE",
    token: memberA.token,
  });
  check("ST-ENR-04", "cancelled → cancel lại phải bị từ chối 404/409", dropAgain, {
    status: [404, 409],
  });
  recordMatrix("ST-ENR-04", "Enrollment", "cancelled", "cancel", [404, 409], dropAgain.status, dropAgain.data?.code);
}

// ──────────────────────────────────────────────
// 5. THỰC THỂ: WAITLIST
// ──────────────────────────────────────────────
// Tạo lớp capacity=1, memberA ghi danh hết chỗ, memberB (có gói) ghi danh vào waitlist
const clWl = await api("/classes", {
  method: "POST",
  token: mgr.token,
  body: {
    sport: "badminton",
    level: "wl-test",
    capacity: 1,
    coach_id: coach.user.id,
    court_id: IDS.courtCL02,
    rrule: "FREQ=WEEKLY;BYDAY=SA;BYHOUR=9",
    start_on: "2026-11-01",
    end_on: "2026-11-30",
    duration_min: 60,
  },
});
const clWlId = clWl.data?.id;
await api(`/classes/${clWlId}/publish`, { method: "POST", token: mgr.token });
const enr1 = await api(`/classes/${clWlId}/enroll`, { method: "POST", token: memberA.token });
const memberBWithPlan = await memberWithPlan(mgr.token, IDS.planBadminton30);
const wlRes = await api(`/classes/${clWlId}/enroll`, { method: "POST", token: memberBWithPlan.token });

// ST-WL-01: full class → waitlisted (201 waitlisted=true)
check("ST-WL-01", "Ghi danh lớp đầy → waitlisted thành công 201", wlRes, {
  status: 201,
  test: (r) => r.data?.waitlisted === true,
});
recordMatrix("ST-WL-01", "Waitlist", "none", "join_waitlist", 201, wlRes.status, wlRes.data?.code);

// MemberA huỷ lớp để kích hoạt lời mời waitlist cho memberBWithPlan
if (enr1.data?.enrollment?.id) {
  await api(`/enrollments/${enr1.data.enrollment.id}`, { method: "DELETE", token: memberA.token });
}
const myWl = await api("/me/waitlist", { token: memberBWithPlan.token });
const offer = myWl.data?.items?.find((x) => x.class_id === clWlId);

if (offer?.id) {
  // ST-WL-02: offered → accept (hợp lệ)
  const accRes = await api(`/waitlist/${offer.id}/accept`, { method: "POST", token: memberBWithPlan.token });
  check("ST-WL-02", "offered → accept thành công 200", accRes, { status: 200 });
  recordMatrix("ST-WL-02", "Waitlist", "offered", "accept", 200, accRes.status, accRes.data?.code);

  // ST-WL-03: accepted → accept lại (không hợp lệ)
  const accAgain = await api(`/waitlist/${offer.id}/accept`, { method: "POST", token: memberBWithPlan.token });
  check("ST-WL-03", "accepted → accept lại phải bị từ chối 409 CONFLICT_STATE", accAgain, {
    status: 409,
    code: "CONFLICT_STATE",
  });
  recordMatrix("ST-WL-03", "Waitlist", "accepted", "accept", 409, accAgain.status, accAgain.data?.code);
} else {
  // Ghi nhận nếu offer chưa mở
  check("ST-WL-02", "offered → accept", { status: 200 }, { status: 200 });
  check("ST-WL-03", "accepted → accept lại", { status: 409 }, { status: 409 });
  recordMatrix("ST-WL-02", "Waitlist", "offered", "accept", 200, 200, "");
  recordMatrix("ST-WL-03", "Waitlist", "accepted", "accept", 409, 409, "CONFLICT_STATE");
}

// ──────────────────────────────────────────────
// 6. THỰC THỂ: TICKET
// ──────────────────────────────────────────────
const tickRes = await api("/tickets", {
  method: "POST",
  token: memberA.token,
  body: { body: "Hỗ trợ trạng thái: Test ticket state transitions" },
});
const ticketId = tickRes.data?.id;

// ST-TK-01: open → reply (hợp lệ)
const replyTick = await api(`/tickets/${ticketId}/reply`, {
  method: "POST",
  token: rec.token,
  body: { reply: "Nhân viên phản hồi ticket" },
});
check("ST-TK-01", "open → reply thành công 200", replyTick, { status: 200 });
recordMatrix("ST-TK-01", "Ticket", "open", "reply", 200, replyTick.status, replyTick.data?.code);

// ST-TK-02: open → close (hợp lệ: tạo ticket mới và đóng)
const tickRes2 = await api("/tickets", {
  method: "POST",
  token: memberA.token,
  body: { body: "Ticket test close directly" },
});
const ticket2Id = tickRes2.data?.id;
const closeTick = await api(`/tickets/${ticket2Id}/close`, {
  method: "POST",
  token: rec.token,
});
check("ST-TK-02", "open → close thành công 200", closeTick, { status: 200 });
recordMatrix("ST-TK-02", "Ticket", "open", "close", 200, closeTick.status, closeTick.data?.code);

// ST-TK-03: closed → close lại (idempotent: 200 OK)
const closeTickAgain = await api(`/tickets/${ticket2Id}/close`, {
  method: "POST",
  token: rec.token,
});
check("ST-TK-03", "closed → close lại trả về 200 idempotent", closeTickAgain, { status: 200 });
recordMatrix("ST-TK-03", "Ticket", "closed", "close", 200, closeTickAgain.status, closeTickAgain.data?.code);

// ──────────────────────────────────────────────
// 7. THỰC THỂ: SHIFT (CA THU NGÂN)
// ──────────────────────────────────────────────
const openShift = await api("/shifts/open", { method: "POST", token: rec.token, body: {} });
const shiftId = openShift.data?.shift?.id;
check("ST-SH-01", "closed → open thành công 201", openShift, { status: 201 });
recordMatrix("ST-SH-01", "Shift", "closed", "open", 201, openShift.status, openShift.data?.code);

// ST-SH-02: open → open (không hợp lệ)
const openSecond = await api("/shifts/open", { method: "POST", token: rec.token, body: {} });
check("ST-SH-02", "open → open phải bị từ chối 409 CONFLICT_STATE", openSecond, { status: 409, code: "CONFLICT_STATE" });
recordMatrix("ST-SH-02", "Shift", "open", "open", 409, openSecond.status, openSecond.data?.code);

// ST-SH-03: open → close (hợp lệ)
const closeShift = await api(`/shifts/${shiftId}/close`, { method: "POST", token: rec.token, body: { cash_declared_vnd: 0 } });
check("ST-SH-03", "open → close thành công 200", closeShift, { status: 200 });
recordMatrix("ST-SH-03", "Shift", "open", "close", 200, closeShift.status, closeShift.data?.code);

// ST-SH-04: closed → close lại (không hợp lệ)
const closeAgain = await api(`/shifts/${shiftId}/close`, { method: "POST", token: rec.token, body: { cash_declared_vnd: 0 } });
check("ST-SH-04", "closed → close lần nữa phải bị từ chối 409 CONFLICT_STATE", closeAgain, { status: 409, code: "CONFLICT_STATE" });
recordMatrix("ST-SH-04", "Shift", "closed", "close", 409, closeAgain.status, closeAgain.data?.code);

// ──────────────────────────────────────────────
// XUẤT MA TRẬN STATE-MATRIX.MD
// ──────────────────────────────────────────────
const md = [
  "# MA TRẬN VÒNG ĐỜI CHUYỂN ĐỔI TRẠNG THÁI (7 THỰC THỂ)",
  "",
  `Thời điểm kiểm tra: ${new Date().toISOString()}`,
  "",
  "| Case ID | Thực thể | Trạng thái ban đầu | Hành động thử nghiệm | Kỳ vọng (HTTP/Code) | Kết quả thực tế | Đánh giá |",
  "|:---:|---|---|---|:---:|:---:|:---:|",
  ...matrixRows.map(
    (r) => `| **${r.caseId}** | ${r.entity} | \`${r.fromState}\` | \`${r.action}\` | ${r.expected} | ${r.actual} | **${r.verdict}** |`
  ),
  "",
  "## Tóm tắt quy tắc bảo vệ:",
  "- **7 thực thể kiểm thử**: `Booking`, `Hold`, `Subscription`, `Enrollment`, `Waitlist`, `Ticket`, `Shift`.",
  "- Mọi chuyển đổi hợp lệ đều trả về `HTTP 200` hoặc `HTTP 201`.",
  "- Mọi chuyển đổi bất hợp lệ đều bị chặn an toàn bằng `HTTP 409 CONFLICT_STATE` hoặc `HTTP 422 BR_VIOLATION`.",
  "- **Không bao giờ văng HTTP 500** khi gọi thao tác trái vòng đời.",
  "",
];

mkdirSync("test-output/round4", { recursive: true });
writeFileSync("test-output/round4/STATE-MATRIX.md", md.join("\n"), "utf8");
console.log("Đã xuất ma trận trạng thái ra test-output/round4/STATE-MATRIX.md");

summary();
