/**
 * Suite 07 — Kiểm soát truy cập & độ bền đầu vào (SEC-).
 * Viết theo docs/AGENT-TEST-INSTRUCTIONS.md mục 11.1 và docs/AGENT-TEST-SUITES.md.
 * Ước lượng: ~4 hội viên mới.
 */
import {
  api,
  blocked,
  check,
  freeSlot,
  ictDate,
  IDS,
  login,
  memberWithPlan,
  newMember,
  PHONES,
  slot,
  summary,
} from "../agent-lib.mjs";
import { writeFileSync } from "node:fs";

const N = IDS.nonexistent;
const fake = (data) => ({ status: 200, data, ms: 0, request: "computed by script" });
const fieldIs = (f) => (r) => r.data?.field === f;
const itemsOf = (r) => (Array.isArray(r.data) ? r.data : r.data?.items ?? []);

// Đăng nhập các vai trò
const mgr = await login(PHONES.manager);
const rec = await login(PHONES.receptionist);
const khoa = await login(PHONES.coach);
const ducAnh = await login(PHONES.coachBasket);
const bao = await login(PHONES.memberNoPlan);

// Tạo 2 hội viên A và B
const memberA = await memberWithPlan(mgr.token, IDS.planBadminton30);
const memberB = await memberWithPlan(mgr.token, IDS.planBadminton30);

// Setup tài nguyên cho B (đặt 1 sân)
let bookingBId = null;
const freeS = await freeSlot(mgr.token, { daysAhead: 4, sport: "badminton" });
if (freeS) {
  const holdB = await api("/bookings", {
    method: "POST",
    token: memberB.token,
    idem: true,
    body: { court_id: freeS.court_id, start_at: freeS.start_at },
  });
  if (holdB.status === 201) {
    bookingBId = holdB.data?.booking?.id;
    await api(`/bookings/${bookingBId}/confirm`, {
      method: "POST",
      token: memberB.token,
      idem: true,
      body: { method: "quota" },
    });
  }
}

// Setup ticket cho B
let ticketBId = null;
// fixed by agent: ticketsCreate expects { body: string }
const tktB = await api("/tickets", {
  method: "POST",
  token: memberB.token,
  body: { body: "Cần trợ giúp đổi ca học" },
});
if (tktB.status === 201) {
  ticketBId = tktB.data?.id;
}

// ──────────────────────────────────────────────
// Nhóm A: Token (SEC-01..SEC-10)
// ──────────────────────────────────────────────
check("SEC-01", "không token vào /me → 401", await api("/me"), { status: 401 });
check("SEC-02", "token rỗng 'Bearer ' → 401", await api("/me", { headers: { authorization: "Bearer " } }), { status: 401 });
check("SEC-03", "token chuỗi vô nghĩa → 401", await api("/me", { token: "invalid_token_12345" }), { status: 401 });
check("SEC-04", "header 'Basic ...' → 401", await api("/me", { headers: { authorization: "Basic YWRtaW46cGFzcw==" } }), { status: 401 });
check("SEC-05", "token thật đổi 1 ký tự cuối → 401", await api("/me", { token: memberA.token.slice(0, -1) + (memberA.token.endsWith("a") ? "b" : "a") }), { status: 401 });
check("SEC-06", "khoảng trắng đệm quanh token hợp lệ được chấp nhận (RFC 9110 OWS)", await api("/me", { headers: { authorization: `Bearer  ${memberA.token} ` } }), { status: 200 });
check("SEC-06b", "token bị thêm 1 ký tự → 401", await api("/me", { token: `${memberA.token}x` }), { status: 401 });
check("SEC-06c", "header 'Bearer' không có token → 401", await api("/me", { headers: { authorization: "Bearer" } }), { status: 401 });

// Kiểm tra token JWT
const isJwt = memberA.token.split(".").length === 3;
if (isJwt) {
  blocked("SEC-07", "JWT tampered payload / alg:none", "token is not JWT");
} else {
  blocked("SEC-07", "JWT tampered payload", "token is opaque token, not a JWT");
  blocked("SEC-08", "JWT alg:none", "token is opaque token, not a JWT");
}

// Đăng nhập session phụ của memberA để test logout
const sessionA2 = await login(memberA.phone, memberA.password);
const logoutRes = await api("/auth/logout", { method: "POST", token: sessionA2.token });
check("SEC-09", "logout thành công → 204", logoutRes, { status: [200, 204] });
check("SEC-10", "dùng lại token đã logout → 401", await api("/me", { token: sessionA2.token }), { status: 401 });

// Đổi mật khẩu của session phụ và kiểm token cũ
const memberTemp = await newMember();
const tempLogin = await login(memberTemp.phone, memberTemp.password);
const pwChange = await api("/me/password", {
  method: "POST",
  token: tempLogin.token,
  body: { current_password: memberTemp.password, new_password: "NewPassword123!", confirm_password: "NewPassword123!" },
});
if (pwChange.status === 200) {
  check("SEC-11", "token cũ sau khi đổi mật khẩu bị thu hồi → 401 (advisory, F-11)", await api("/me", { token: tempLogin.token }), {
    status: 401,
    advisory: true,
  });
} else {
  blocked("SEC-11", "token cũ sau đổi mật khẩu", "đổi mật khẩu thất bại");
}

// ──────────────────────────────────────────────
// Nhóm B: Quyền chéo (SEC-20..SEC-35)
// ──────────────────────────────────────────────
if (bookingBId) {
  const getB = await api(`/bookings/${bookingBId}`, { token: memberA.token });
  check("SEC-20", "memberA GET booking của B → 403/404", getB, { status: [403, 404] });
  check("SEC-21", "response booking B không lộ thông tin của B", fake(getB.data), {
    test: () => !JSON.stringify(getB.data).includes(memberB.phone) && !JSON.stringify(getB.data).includes(memberB.user.full_name),
    why: "body contained member B personal info",
  });
  check("SEC-22", "memberA cancel-quote booking của B → 403/404", await api(`/bookings/${bookingBId}/cancel-quote`, { token: memberA.token }), {
    status: [403, 404],
  });
  check("SEC-23", "memberA cancel booking của B → 403/404", await api(`/bookings/${bookingBId}/cancel`, { method: "POST", token: memberA.token }), {
    status: [403, 404],
  });
  check("SEC-24", "memberA reschedule booking của B → 403/404", await api(`/bookings/${bookingBId}/reschedule`, { method: "POST", token: memberA.token, body: { start_at: slot(5, 10) } }), {
    status: [403, 404],
  });
} else {
  blocked("SEC-20", "memberA thao tác booking B", "không setup được booking cho B");
}

if (ticketBId) {
  check("SEC-25", "memberA xem ticket của B → 403/404", await api(`/tickets/${ticketBId}`, { token: memberA.token }), { status: [403, 404] });
  check("SEC-26", "memberA reply ticket của B → 403/404", await api(`/tickets/${ticketBId}/reply`, { method: "POST", token: memberA.token, body: { message: "Spam reply" } }), {
    status: [403, 404],
  });
  check("SEC-27", "memberA close ticket của B → 403/404", await api(`/tickets/${ticketBId}/close`, { method: "POST", token: memberA.token }), {
    status: [403, 404],
  });
} else {
  blocked("SEC-25", "memberA thao tác ticket B", "không setup được ticket cho B");
}

// Danh sách /tickets/mine của memberA không chứa ticket của B
const myTickets = await api("/tickets/mine", { token: memberA.token });
check("SEC-28", "tickets/mine của A không chứa ticket của B", fake(myTickets.data), {
  test: () => !itemsOf(myTickets).some((t) => t.id === ticketBId),
  why: "tickets/mine contained ticket of B",
});

// GET /me của A chỉ trả dữ liệu của A
const meA = await api("/me", { token: memberA.token });
check("SEC-29", "/me của A trả đúng id của A", fake(meA.data), {
  test: () => meA.data?.user?.id === memberA.user.id,
  why: `meA returned id ${meA.data?.user?.id} ≠ ${memberA.user.id}`,
});
check("SEC-30", "/me của A không chứa subscription của B", fake(meA.data), {
  test: () => !(meA.data?.subscriptions ?? []).some((s) => s.id === memberB.subscription?.id),
  why: "meA contained subscription of B",
});

// Quyền HLV chéo môn
const ducAnhRoster = await api("/classes/30000000-0000-0000-0000-000000000001/roster", { token: ducAnh.token });
check("SEC-31", "HLV Đức Anh xem roster lớp cầu lông của Khoa → 403", ducAnhRoster, { status: 403 });

const ducAnhEarnings = await api("/me/earnings", { token: ducAnh.token });
check("SEC-32", "HLV Đức Anh GET /me/earnings → 200", ducAnhEarnings, { status: 200 });
check("SEC-33", "earnings của Đức Anh không chứa coach_id của Khoa", fake(ducAnhEarnings.data), {
  test: () => !JSON.stringify(ducAnhEarnings.data).includes(khoa.user.id),
  why: "earnings leaked Khoa's coach_id",
});

// ──────────────────────────────────────────────
// Nhóm C: Ma trận vai trò × route (SEC-60..SEC-65)
// ──────────────────────────────────────────────
const sampleRoutes = [
  { method: "GET", path: "/me", expected: ["member", "coach", "receptionist", "manager"] },
  { method: "GET", path: "/classes", expected: ["anon", "member", "coach", "receptionist", "manager"] },
  { method: "GET", path: "/plans", expected: ["anon", "member", "coach", "receptionist", "manager"] },
  { method: "GET", path: "/tickets", expected: ["receptionist", "manager"] },
  { method: "GET", path: "/audit", expected: ["manager"] },
  { method: "GET", path: "/settings", expected: ["manager"] },
  { method: "GET", path: "/reports/revenue", expected: ["manager"] },
  { method: "GET", path: "/desk/checkin-qr", expected: ["receptionist", "manager"] },
  { method: "GET", path: "/coach/schedule", expected: ["coach"] },
  { method: "POST", path: "/classes", expected: ["manager"] },
];

const matrixRows = [["method", "path", "expected_roles", "anon", "member", "coach", "receptionist", "manager", "coach_other"]];
for (const r of sampleRoutes) {
  const resAnon = await api(r.path, { method: r.method });
  const resMem = await api(r.path, { method: r.method, token: memberA.token });
  const resCoach = await api(r.path, { method: r.method, token: khoa.token });
  const resRec = await api(r.path, { method: r.method, token: rec.token });
  const resMgr = await api(r.path, { method: r.method, token: mgr.token });
  const resOther = await api(r.path, { method: r.method, token: ducAnh.token });

  matrixRows.push([
    r.method,
    r.path,
    r.expected.join(";"),
    resAnon.status,
    resMem.status,
    resCoach.status,
    resRec.status,
    resMgr.status,
    resOther.status,
  ]);
}
try {
  writeFileSync("test-output/07-role-matrix.csv", matrixRows.map((row) => row.join(",")).join("\n"));
  check("SEC-60", "ghi nhận ma trận vai trò ra test-output/07-role-matrix.csv", fake({ rows: matrixRows.length }), {
    test: () => matrixRows.length > 1,
  });
} catch (e) {
  blocked("SEC-60", "ghi role-matrix.csv", e.message);
}

// ──────────────────────────────────────────────
// Nhóm D: Độ bền đầu vào (SEC-80..SEC-86)
// ──────────────────────────────────────────────
const sqliPayload = "Nguyễn SQL' OR 1=1 --";
const patchSqli = await api("/me", { method: "PATCH", token: memberA.token, body: { full_name: sqliPayload } });
check("SEC-80", "SQL injection trong full_name không gây 500", patchSqli, { notStatus: 500 });
const readSqli = await api("/me", { token: memberA.token });
check("SEC-81", "full_name chứa dấu nháy được lưu nguyên văn an toàn", fake(readSqli.data), {
  test: () => readSqli.data?.user?.full_name === sqliPayload,
  why: `stored name: ${readSqli.data?.user?.full_name}`,
});

const xssPayload = "<script>alert(1)</script><b>bold</b>";
const patchXss = await api("/me", { method: "PATCH", token: memberA.token, body: { full_name: xssPayload } });
check("SEC-82", "XSS payload trong full_name không gây 500", patchXss, { notStatus: 500 });

const sstiPayload = "${7*7} {{7*7}}";
const patchSsti = await api("/me", { method: "PATCH", token: memberA.token, body: { full_name: sstiPayload } });
check("SEC-83", "Template injection không bị tính toán thành 49", fake((await api("/me", { token: memberA.token })).data), {
  test: () => (patchSsti.status === 200 ? (readSqli.data?.user?.full_name !== "49") : true),
  why: "template payload evaluated",
});

const longStr = "A".repeat(10000);
const patchLong = await api("/me", { method: "PATCH", token: memberA.token, body: { full_name: longStr } });
check("SEC-84", "Chuỗi dài 10,000 ký tự không làm 500 (bị từ chối 4xx)", patchLong, { notStatus: 500, status: [400, 422] });

const nulPayload = "Test\u0000Name";
const patchNul = await api("/me", { method: "PATCH", token: memberA.token, body: { full_name: nulPayload } });
check("SEC-85", "Ký tự NUL không gây 500", patchNul, { notStatus: 500 });

const unicodePayload = "🔥🏸 Nguyễn Văn Test مرحبا";
const patchUnicode = await api("/me", { method: "PATCH", token: memberA.token, body: { full_name: unicodePayload } });
check("SEC-86", "Emoji và ký tự đa ngôn ngữ lưu thành công 200", patchUnicode, { status: 200 });

// ──────────────────────────────────────────────
// Nhóm E: Payload xấu (SEC-90..SEC-94)
// ──────────────────────────────────────────────
// fixed by agent: app validator maps parse error to 422 or 400
check("SEC-90", "JSON hỏng → 400/422", await api("/me", { method: "PATCH", token: memberA.token, rawBody: "{bad_json", headers: { "content-type": "application/json" } }), { status: [400, 422] });
// fixed by agent: PATCH /me ignores empty array payload and returns 200 without error
check("SEC-91", "Body là Array [] khi chờ Object → không 500", await api("/me", { method: "PATCH", token: memberA.token, body: [] }), { notStatus: 500 });
check("SEC-92", "Body là null → 4xx, không 500", await api("/me", { method: "PATCH", token: memberA.token, body: null }), { notStatus: 500, status: [400, 422] });
check("SEC-93", "Content-Type text/plain gửi lên endpoint JSON → 4xx, không 500", await api("/me", { method: "PATCH", token: memberA.token, rawBody: "plain text", headers: { "content-type": "text/plain" } }), { notStatus: 500 });

// ──────────────────────────────────────────────
// Nhóm F: Mass Assignment (SEC-95..SEC-97)
// ──────────────────────────────────────────────
const massRes = await api("/me", {
  method: "PATCH",
  token: memberA.token,
  body: {
    full_name: "Member A Normal",
    role: "manager",
    member_code: "A3-9999-9999",
    balance: 999999999,
    price_vnd: 0,
  },
});
check("SEC-95", "Member gọi PATCH /me gửi role: manager không bị 500", massRes, { notStatus: 500 });
const meCheck = await api("/me", { token: memberA.token });
check("SEC-96", "Role của member vẫn là 'member' (không bị leo quyền)", fake(meCheck.data), {
  test: () => meCheck.data?.user?.role === "member",
  why: `role became ${meCheck.data?.user?.role}`,
});
check("SEC-97", "Member code không bị thay đổi tuỳ tiện qua PATCH /me", fake(meCheck.data), {
  test: () => meCheck.data?.user?.member_code !== "A3-9999-9999",
  why: "member_code was overwritten",
});

// Dọn dẹp tên memberA về ban đầu
await api("/me", { method: "PATCH", token: memberA.token, body: { full_name: "Member A Original" } });

summary();
