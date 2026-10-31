/**
 * 14f-role-matrix.mjs — Phân quyền theo vai trò phủ 100% route trong router.ts
 * Theo docs/AGENT-TEST-ROUND2.md Bước 5 (14f) & Yêu cầu Vòng 4:
 * - Dùng danh sách route thống nhất từ test-output/round4/routes-all.json.
 * - Thêm vai trò thứ 6 `coach_other` (ducAnh, HLV bóng rổ) cho mọi route /coach/*, /classes/*, /enrollments/* và điểm danh.
 * - MỖI cặp route × vai trò là MỘT check riêng, id dạng RM-<METHOD>-<path>-<role>.
 * - Bắt lỗi F-21 (bán gói cho HLV) và F-23 (HLV môn khác xoá ghi danh).
 * - Bắt lỗi F-10 (DELETE /payments trả 403 cho anon trước khi kiểm tra auth; validation/resource lookup trước auth).
 * - Xuất ma trận CSV ra test-output/round4/07-role-matrix.csv và JSONL kết quả.
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  api,
  check,
  ictDate,
  IDS,
  login,
  memberWithPlan,
  PHONES,
  summary,
} from "../agent-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT_CSV_R4 = join(ROOT, "test-output", "round4", "07-role-matrix.csv");
mkdirSync(join(ROOT, "test-output", "round4"), { recursive: true });

console.log("=== 14f — PHÂN QUYỀN VAI TRÒ PHỦ 100% ROUTE VỚI 6 VAI TRÒ (ROUND 4) ===");

const mgr = await login(PHONES.manager);
const rec = await login(PHONES.receptionist);
const coachKhoa = await login(PHONES.coach); // HLV cầu lông
const coachDucAnh = await login(PHONES.coachBasket); // Vai trò thứ 6: coach_other (HLV bóng rổ)
const memberBao = await login(PHONES.memberNoPlan);

const users = {
  anon: undefined,
  member: memberBao.token,
  coach: coachKhoa.token,
  receptionist: rec.token,
  manager: mgr.token,
};

// Dựng trước 1 lớp cầu lông có ghi danh học viên để test F-23 cho coach_other
let realClassId = IDS.nonexistent;
let realSessionId = IDS.nonexistent;
try {
  const crCl = await api("/classes", {
    method: "POST",
    token: mgr.token,
    body: {
      sport: "badminton",
      level: "role-matrix-test",
      capacity: 10,
      coach_id: coachKhoa.user.id,
      court_id: IDS.courtCL02,
      rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=16",
      start_on: ictDate(1),
      end_on: ictDate(30),
      duration_min: 60,
    },
  });
  if (crCl.status === 201 && crCl.data?.id) {
    realClassId = crCl.data.id;
    const pub = await api(`/classes/${realClassId}/publish`, { method: "POST", token: mgr.token });
    if (pub.data?.sessions?.[0]?.id) {
      realSessionId = pub.data.sessions[0].id;
    }
  }
  // Nếu chưa có buổi từ lớp mới, lấy buổi có thật của HLV Khoa từ lịch huấn luyện
  if (realSessionId === IDS.nonexistent) {
    const sch = await api("/coach/schedule", { token: coachKhoa.token });
    if (sch.data?.items?.[0]?.id) {
      realSessionId = sch.data.items[0].id;
    }
  }
} catch (e) {
  console.warn("Không thể dựng lớp mẫu:", e?.message);
}

// Nạp 161 routes từ routes-all.json
const allRoutes = JSON.parse(readFileSync(join(ROOT, "test-output", "round4", "routes-all.json"), "utf8"));

// Xác định các quyền chuẩn cho từng endpoint theo đúng router.ts và handlers
function getRouteConfig(r) {
  const method = r.method;
  const path = r.path;

  // 1. Public
  if (
    (method === "GET" && ["/health", "/plans", "/courts", "/classes", "/price-rules", "/flags"].includes(path)) ||
    (method === "POST" && ["/auth/register", "/auth/otp/verify", "/auth/login", "/auth/password/forgot", "/payments/online/webhook"].includes(path)) ||
    (method === "GET" && path === "/payments/online/sequence")
  ) {
    return { allowed: "public", needsCoachOther: false };
  }

  // 2. Auth logout
  if (method === "POST" && path === "/auth/logout") {
    return { allowed: ["member", "coach", "receptionist", "manager"], needsCoachOther: false };
  }

  // 3. Self-service /me
  if (path === "/me" && method === "GET") {
    return { allowed: ["member", "coach", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/me" && method === "PATCH") {
    return { allowed: ["member", "coach", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/me/bookings" && method === "GET") {
    // bookings.ts:192: requireRole(user, ["member"])
    return { allowed: ["member"], needsCoachOther: false };
  }
  if (path === "/me/attendance" && method === "GET") {
    // ops.ts:384: requireRole(user, ["member"])
    return { allowed: ["member"], needsCoachOther: false };
  }
  if (path === "/me/notifications" && method === "GET") {
    return { allowed: ["member", "coach", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/me/notifications/read" && method === "POST") {
    return { allowed: ["member", "coach", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/me/password" && method === "POST") {
    return { allowed: ["member", "coach", "receptionist", "manager"], needsCoachOther: false };
  }

  // 4. Staff (manager only - staff.ts:103,133,167,230,244)
  if (path.startsWith("/staff")) {
    return { allowed: ["manager"], needsCoachOther: false };
  }

  // 5. Directory & Members
  if (path === "/directory/members") {
    // members.ts:317: requireRole(user, ["manager"])
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path === "/members" && method === "GET") {
    // members.ts:11: requireRole(user, ["manager", "receptionist", "coach"])
    return { allowed: ["coach", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/members" && method === "POST") {
    // members.ts:201: requireRole(user, ["receptionist", "manager"])
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/members/") && path.endsWith("/reset-password")) {
    // members.ts:397: requireRole(user, ["receptionist", "manager"])
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/members/") && path.endsWith("/points")) {
    if (method === "GET") return { allowed: ["receptionist", "manager"], needsCoachOther: false };
    if (method === "POST") return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path.startsWith("/members/") && path.endsWith("/contacts")) {
    // attendance.ts:382: coach chỉ xem được học viên trong lớp của mình. Random id -> 403
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/members/") && method === "GET") {
    // members.ts:91: requireRole(user, ["manager", "receptionist", "coach"])
    return { allowed: ["coach", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/members/") && method === "PATCH") {
    // members.ts:397: requireRole(user, ["receptionist", "manager"])
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }

  // 6. Plans & Subscriptions
  if (path === "/plans" && method === "POST") {
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path.startsWith("/plans/") && method === "GET") {
    // plans.ts:81: requireRole(user, ["manager"])
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path.startsWith("/plans/") && method === "PATCH") {
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path === "/subscriptions" && method === "POST") {
    // Bắt lỗi F-21: Bán gói cho HLV
    return {
      allowed: ["member"], // Bán cho bản thân; nếu lễ tân/quản lý bán cho HLV phải bị chặn 403/422
      needsCoachOther: false,
      body: { plan_id: IDS.planBadminton30, user_id: coachKhoa.user.id },
      isF21Target: true,
    };
  }
  if (path.startsWith("/subscriptions/") && path.endsWith("/freeze")) {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/subscriptions/") && path.endsWith("/unfreeze")) {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/subscriptions/") && path.endsWith("/decline")) {
    // desk.ts:695: requireRole(user, ["receptionist", "manager"])
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }

  // 7. Bookings & Occupancy
  if (path === "/availability" && method === "GET") {
    return { allowed: ["member", "coach", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/occupancy" && method === "GET") {
    return { allowed: ["member", "coach", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/occupancy/detail" && method === "GET") {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/courts/") && method === "PATCH") {
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path === "/bookings" && method === "POST") {
    return { allowed: ["member"], needsCoachOther: false };
  }
  if (path.startsWith("/bookings/") && path.endsWith("/confirm")) {
    return { allowed: ["member"], needsCoachOther: false };
  }
  if (path.startsWith("/bookings/") && path.endsWith("/transfer-confirm")) {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/bookings/") && path.endsWith("/transfer-reject")) {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/bookings/") && path.endsWith("/cancel")) {
    return { allowed: ["member", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/bookings/") && path.endsWith("/cancel-quote")) {
    return { allowed: ["member", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/bookings/") && path.endsWith("/collect-balance")) {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/bookings/") && path.endsWith("/reschedule")) {
    return { allowed: ["member"], needsCoachOther: false };
  }
  if (path.startsWith("/bookings/") && path.endsWith("/check-in")) {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/bookings/") && method === "GET") {
    return { allowed: ["member", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/walk-in" && method === "POST") {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }

  // 8. Shifts
  if (path === "/shifts/open" && method === "POST") {
    return { allowed: ["receptionist"], needsCoachOther: false };
  }
  if (path === "/shifts/current" && method === "GET") {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/shifts/") && path.endsWith("/close")) {
    return { allowed: ["receptionist"], needsCoachOther: false };
  }

  // 9. Payments & Invoices
  if (path === "/payments/online" && method === "POST") {
    return { allowed: ["member", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/payments/online/") && path.endsWith("/verify")) {
    return { allowed: ["member", "coach", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/payments/pending" && method === "GET") {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/payments" && method === "POST") {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/payments/") && path.endsWith("/refund")) {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/payments/") && path.endsWith("/approve-refund")) {
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path.startsWith("/payments/") && path.endsWith("/reject-refund")) {
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path === "/invoices/export-list" && method === "GET") {
    // extras.ts:972: requireRole(user, ["manager"])
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path === "/invoices/export" && method === "GET") {
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path.startsWith("/invoices/") && path.endsWith(".xml")) {
    // extras.ts:830: requireRole(user, ["manager", "receptionist"])
    return { allowed: ["manager", "receptionist"], needsCoachOther: false };
  }
  if (path === "/invoices" && method === "GET") {
    return { allowed: ["member", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/invoices/") && path.endsWith(".pdf")) {
    return { allowed: ["member", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/payments" && method === "DELETE") {
    return { allowed: [], isDeletePayments: true, needsCoachOther: false };
  }

  // 10. Series & Day Passes
  if (path === "/series/preview" && method === "POST") {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/series" && method === "POST") {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/series" && method === "GET") {
    return { allowed: ["member", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/series/") && path.endsWith("/cancel")) {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }

  // 11. Loyalty
  if (path === "/me/points" && method === "GET") {
    return { allowed: ["member"], needsCoachOther: false };
  }
  if (path === "/me/points/redeem" && method === "POST") {
    return { allowed: ["member"], needsCoachOther: false };
  }

  // 12. Commission
  if (path === "/commission" && method === "GET") {
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path === "/commission/close" && method === "POST") {
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path.startsWith("/commission/rates/") && method === "PATCH") {
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path.startsWith("/commission/pay/") && method === "POST") {
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path === "/me/earnings" && method === "GET") {
    return { allowed: ["coach"], needsCoachOther: false };
  }

  // 13. Work Orders
  if (path === "/work-orders" && method === "GET") {
    return { allowed: ["coach", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/work-orders" && method === "POST") {
    return { allowed: ["coach", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/work-orders/") && method === "PATCH") {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }

  // 14. Reports & Settings & Audit
  if (path === "/reports/attendance" && method === "GET") {
    // attendance.ts:171: requireRole(user, ["manager", "coach"])
    return { allowed: ["coach", "manager"], needsCoachOther: true };
  }
  if (path === "/at-risk" && method === "GET") {
    return { allowed: ["coach", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/contacts" && method === "POST") {
    return { allowed: ["coach", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/reports/") && path.endsWith("/export")) {
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path === "/reports/revenue" && method === "GET") {
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path === "/reports/capacity" && method === "GET") {
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path === "/reports/members" && method === "GET") {
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path === "/reports/occupancy" && method === "GET") {
    // desk.ts:972: requireRole(user, ["manager"])
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path === "/settings" && method === "GET") {
    // desk.ts:1002: requireRole(user, ["manager", "receptionist", "coach"])
    return { allowed: ["coach", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/settings" && method === "PATCH") {
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path === "/price-rules" && method === "PUT") {
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path === "/audit" && method === "GET") {
    return { allowed: ["manager"], needsCoachOther: false };
  }

  // 15. Ops & Equipment & Training Plans
  if (path.startsWith("/waitlist/") && path.endsWith("/accept")) {
    // ops.ts:94: requireRole(user, ["member"])
    return { allowed: ["member"], needsCoachOther: false };
  }
  if (path === "/equipment" && method === "GET") {
    return { allowed: ["member", "coach", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/equipment/loans" && method === "GET") {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/equipment/loans" && method === "POST") {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/equipment/loans/") && path.endsWith("/return")) {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false, testPath: `/equipment/loans/${IDS.nonexistent}/return` };
  }
  if (path.startsWith("/sessions/") && path.endsWith("/attendance")) {
    return { allowed: ["coach", "manager"], needsCoachOther: true, testPath: path.replace(":id", realSessionId) };
  }
  if (path === "/training-plans" && method === "GET") {
    // ops.ts:397: Không có requireRole -> mọi tài khoản đăng nhập đều được xem
    return { allowed: ["member", "coach", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/training-plans" && method === "POST") {
    return { allowed: ["coach", "manager"], needsCoachOther: false };
  }
  if (path === "/training-plans/suggest" && method === "POST") {
    return { allowed: ["coach", "manager"], needsCoachOther: false };
  }
  if (path === "/training-plans/templates" && method === "GET") {
    return { allowed: ["coach", "manager"], needsCoachOther: false };
  }
  if (path === "/training-plans/from-template" && method === "POST") {
    return { allowed: ["coach", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/training-plans/") && path.endsWith("/save-template")) {
    return { allowed: ["coach", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/training-plans/") && path.endsWith("/versions")) {
    return { allowed: ["coach", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/training-plans/") && method === "PATCH") {
    return { allowed: ["coach", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/classes/") && path.includes("/plans/duplicate-week")) {
    return { allowed: ["coach", "manager"], needsCoachOther: true, testPath: path.replace(":id", realClassId) };
  }
  if (path.startsWith("/sessions/") && path.endsWith("/results")) {
    return { allowed: ["coach", "manager"], needsCoachOther: true, testPath: path.replace(":id", realSessionId) };
  }
  if (path.startsWith("/students/") && path.endsWith("/profile")) {
    return { allowed: ["coach", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/students/") && path.endsWith("/level")) {
    return { allowed: ["coach", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/students/") && path.endsWith("/notes")) {
    return { allowed: ["coach", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/students/") && path.endsWith("/reviews")) {
    return { allowed: ["coach", "manager"], needsCoachOther: false };
  }
  if (path === "/homework" && method === "GET") {
    return { allowed: ["coach", "manager"], needsCoachOther: false };
  }
  if (path === "/homework" && method === "POST") {
    return { allowed: ["coach", "manager"], needsCoachOther: false };
  }
  if (path === "/me/training" && method === "GET") {
    return { allowed: ["member"], needsCoachOther: false };
  }
  if (path === "/me/training-goal" && method === "PUT") {
    return { allowed: ["member"], needsCoachOther: false };
  }
  if (path === "/me/homework" && method === "GET") {
    return { allowed: ["member"], needsCoachOther: false };
  }
  if (path.startsWith("/me/homework/") && method === "PUT") {
    return { allowed: ["member"], needsCoachOther: false };
  }

  // 16. Desk Check-in
  if (path === "/desk/gate-checkin" && method === "POST") {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/desk/scan" && method === "POST") {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/desk/checkin-qr" && method === "GET") {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/desk/gate-checkins" && method === "GET") {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/me/checkin-token" && method === "GET") {
    return { allowed: ["member"], needsCoachOther: false };
  }
  if (path.startsWith("/me/bookings/") && path.endsWith("/checkin-token")) {
    return { allowed: ["member"], needsCoachOther: false };
  }
  if (path === "/me/self-checkin" && method === "POST") {
    return { allowed: ["member"], needsCoachOther: false };
  }

  // 17. Classes & Sessions
  if (path === "/classes" && method === "POST") {
    return { allowed: ["manager"], needsCoachOther: true };
  }
  if (path.startsWith("/classes/") && path.endsWith("/publish")) {
    return { allowed: ["manager"], needsCoachOther: true, testPath: path.replace(":id", realClassId) };
  }
  if (path.startsWith("/classes/") && path.endsWith("/cancel")) {
    return { allowed: ["manager"], needsCoachOther: true, testPath: path.replace(":id", realClassId) };
  }
  if (path.startsWith("/classes/") && path.endsWith("/enroll")) {
    return { allowed: ["member", "receptionist", "manager"], needsCoachOther: true, testPath: path.replace(":id", realClassId) };
  }
  if (path.startsWith("/classes/") && path.endsWith("/coach")) {
    return { allowed: ["manager"], needsCoachOther: true, testPath: path.replace(":id", realClassId) };
  }
  if (path.startsWith("/classes/") && path.endsWith("/sessions/generate")) {
    return { allowed: ["manager"], needsCoachOther: true, testPath: path.replace(":id", realClassId) };
  }
  if (path.startsWith("/classes/") && path.endsWith("/sessions")) {
    return { allowed: ["coach", "receptionist", "manager"], needsCoachOther: true, testPath: path.replace(":id", realClassId) };
  }
  if (path.startsWith("/classes/") && path.endsWith("/enrollments")) {
    return { allowed: ["coach", "receptionist", "manager"], needsCoachOther: true, testPath: path.replace(":id", realClassId) };
  }
  if (path.startsWith("/classes/") && method === "GET") {
    return { allowed: ["coach", "receptionist", "manager"], needsCoachOther: true, testPath: path.replace(":id", realClassId) };
  }
  if (path.startsWith("/classes/") && method === "PATCH") {
    return { allowed: ["manager"], needsCoachOther: true, testPath: path.replace(":id", realClassId) };
  }
  if (path.startsWith("/enrollments/") && method === "DELETE") {
    // EN-25 / F-23: Lễ tân, Quản lý hoặc HLV phụ trách mới được xoá
    return { allowed: ["manager", "coach", "receptionist"], needsCoachOther: true };
  }
  if (path.startsWith("/sessions/") && (path.endsWith("/cancel") || path.endsWith("/reschedule"))) {
    return { allowed: ["manager"], needsCoachOther: true, testPath: path.replace(":id", realSessionId) };
  }
  if (path === "/coach/schedule" && method === "GET") {
    return { allowed: ["coach", "manager"], needsCoachOther: true };
  }
  if (path === "/coach/sessions" && method === "GET") {
    return { allowed: ["coach", "manager"], needsCoachOther: true };
  }
  if (path === "/coach/classes" && method === "GET") {
    return { allowed: ["coach", "manager"], needsCoachOther: true };
  }

  // 18. Promos, Assistant, Tickets, Flags
  if (path === "/promotions" && method === "GET") {
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path === "/promotions/validate" && method === "POST") {
    return { allowed: ["member", "coach", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/promotions" && method === "POST") {
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path.startsWith("/promotions/") && path.endsWith("/redemptions")) {
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path.startsWith("/promotions/") && method === "PATCH") {
    return { allowed: ["manager"], needsCoachOther: false };
  }
  if (path === "/assistant" && method === "POST") {
    return { allowed: ["member", "coach", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/tickets/mine" && method === "GET") {
    return { allowed: ["member", "coach", "receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/tickets" && method === "GET") {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/tickets" && method === "POST") {
    // ops.ts:680: Khách hàng/hội viên tạo ticket yêu cầu hỗ trợ
    return { allowed: ["member", "coach", "receptionist", "manager"], needsCoachOther: false, body: { body: "Yêu cầu hỗ trợ hội viên" } };
  }
  if (path.startsWith("/tickets/") && path.endsWith("/reply")) {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path.startsWith("/tickets/") && path.endsWith("/close")) {
    return { allowed: ["receptionist", "manager"], needsCoachOther: false };
  }
  if (path === "/flags" && method === "PATCH") {
    return { allowed: ["manager"], needsCoachOther: false };
  }

  return { allowed: ["member", "coach", "receptionist", "manager"], needsCoachOther: false };
}

const csvRows = [
  "Method,Path,Anonymous,Member,Coach,Coach_Other,Receptionist,Manager,Vấn đề / Ghi chú",
];

for (const r of allRoutes) {
  const cfg = getRouteConfig(r);
  let targetPath = cfg.testPath ?? r.path.replace(/:id|\:subId/, IDS.nonexistent);
  const cleanPath = r.path;

  // coach_other chạy trước coach để test xoá ghi danh trên bản ghi còn sống
  const roleList = cfg.needsCoachOther
    ? ["anon", "member", "coach_other", "coach", "receptionist", "manager"]
    : ["anon", "member", "coach", "receptionist", "manager"];

  const rowResults = {};

  for (const role of roleList) {
    const checkId = `RM-${r.method}-${cleanPath}-${role}`;

    // Xử lý token: Tránh bị logout làm mất phiên dùng chung
    let token;
    if (role === "anon") {
      token = undefined;
    } else if (cleanPath === "/auth/logout") {
      // Dùng session tạm để không vô hiệu hoá session chính của suite
      const phone =
        role === "coach_other"
          ? PHONES.coachBasket
          : role === "coach"
          ? PHONES.coach
          : role === "receptionist"
          ? PHONES.receptionist
          : role === "manager"
          ? PHONES.manager
          : PHONES.memberNoPlan;
      const tmp = await login(phone);
      token = tmp.token;
    } else {
      token = role === "coach_other" ? coachDucAnh.token : users[role];
    }

    let isAllowed = false;
    if (cfg.allowed === "public") {
      isAllowed = true;
    } else if (role === "coach_other") {
      // coach_other chỉ được phép vào các route generic của coach hoặc xem báo cáo chuyên môn
      if (cleanPath.startsWith("/coach/") || cleanPath === "/reports/attendance") {
        isAllowed = true;
      } else {
        // Mọi thao tác trên lớp, buổi, học viên của HLV Khoa đều không được phép đối với coach_other
        isAllowed = false;
      }
    } else if (Array.isArray(cfg.allowed)) {
      isAllowed = cfg.allowed.includes(role);
    }

    // Đối với DELETE /enrollments/:id, tạo một ghi danh thật còn sống cho từng vai trò thử nghiệm
    if (cleanPath.startsWith("/enrollments/") && r.method === "DELETE") {
      try {
        const st = await memberWithPlan(mgr.token, IDS.planBadminton30);
        const enr = await api(`/classes/${realClassId}/enroll`, { method: "POST", token: st.token });
        if (enr.status === 201 && enr.data?.enrollment?.id) {
          targetPath = `/enrollments/${enr.data.enrollment.id}`;
        }
      } catch {
        targetPath = `/enrollments/${IDS.nonexistent}`;
      }
    }

    // Cần Idempotency-Key cho các route bắt buộc idempotency trong withIdempotency
    const isIdemRequired =
      (r.method === "POST" && cleanPath === "/bookings") ||
      (r.method === "POST" && cleanPath.startsWith("/bookings/") && cleanPath.endsWith("/confirm")) ||
      (r.method === "POST" && cleanPath === "/walk-in") ||
      (r.method === "POST" && cleanPath === "/payments");

    const res = await api(targetPath, {
      method: r.method,
      token,
      body: cfg.body ?? (r.isWrite ? {} : undefined),
      idem: isIdemRequired || undefined,
    });

    rowResults[role] = res.status;

    // Kiểm tra các trường hợp đặc biệt và phân quyền
    if (cfg.isF21Target && (role === "receptionist" || role === "manager")) {
      // Case F-21: Bán gói cho HLV phải bị từ chối 403 hoặc 422
      check(checkId, `${r.method} ${cleanPath} [${role}] - Kiểm tra chặn bán gói cho HLV (F-21)`, res, {
        status: [403, 422],
        notStatus: [200, 201, 500],
        why: `Bán gói cho HLV phải bị từ chối (F-21); nhận status=${res.status}`,
      });
    } else if (r.method === "DELETE" && cleanPath.startsWith("/enrollments") && role === "coach_other") {
      // Case F-23: HLV môn khác xoá ghi danh lớp người khác phải bị 403 Forbidden
      check(checkId, `${r.method} ${cleanPath} [${role}] - HLV môn khác xoá ghi danh phải bị 403 (F-23)`, res, {
        status: 403,
        why: `HLV môn khác xoá ghi danh học viên lớp khác phải bị 403 (F-23); nhận status=${res.status}`,
      });
    } else if (cfg.isDeletePayments) {
      if (role === "anon") {
        // F-10: Router ném 403 trước khi kiểm tra auth cho DELETE /payments
        check(checkId, `${r.method} ${cleanPath} [${role}] - anon phải nhận 401`, res, {
          status: 401,
          code: "UNAUTHENTICATED",
          why: `DELETE /payments router trả 403 trước khi kiểm tra auth (F-10); nhận status=${res.status}`,
        });
      } else {
        // Thanh toán không thể bị xoá bởi bất kỳ ai (phải hoàn tiền) -> nhận 403
        check(checkId, `${r.method} ${cleanPath} [${role}] - không ai được xoá thanh toán (403)`, res, {
          status: 403,
          code: "FORBIDDEN",
        });
      }
    } else if (cfg.allowed === "public") {
      check(checkId, `${r.method} ${cleanPath} [${role}] - public allowed`, res, {
        notStatus: [401, 403, 500],
      });
    } else if (!isAllowed) {
      if (role === "anon") {
        check(checkId, `${r.method} ${cleanPath} [${role}] - anon phải nhận 401`, res, {
          status: 401,
          code: "UNAUTHENTICATED",
        });
      } else {
        check(checkId, `${r.method} ${cleanPath} [${role}] - vai trò không được phép phải nhận 403`, res, {
          status: 403,
          code: "FORBIDDEN",
        });
      }
    } else {
      check(checkId, `${r.method} ${cleanPath} [${role}] - được phép truy cập (không 401/403)`, res, {
        notStatus: [401, 403, 500],
      });
    }
  }

  csvRows.push(
    `"${r.method}","${cleanPath}",${rowResults.anon ?? "-"},${rowResults.member ?? "-"},${rowResults.coach ?? "-"},${rowResults.coach_other ?? "-"},${rowResults.receptionist ?? "-"},${rowResults.manager ?? "-"},""`
  );
}

writeFileSync(OUT_CSV_R4, csvRows.join("\n"), "utf8");
console.log(`Đã xuất ma trận phân quyền chuẩn ra ${OUT_CSV_R4}`);

summary();
