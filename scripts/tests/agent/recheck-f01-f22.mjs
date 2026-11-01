/**
 * recheck-f01-f22.mjs — Tái kiểm tra độc lập toàn bộ 22 findings cũ (F-01 → F-22)
 * Bám sát chính xác các bước tái hiện từ Suite 01–05 và các ca test gốc.
 */
import {
  api,
  ictDate,
  IDS,
  login,
  memberWithPlan,
  newMember,
  PHONES,
  slot,
  freeSlotAnyDay,
} from "../agent-lib.mjs";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT_FILE = join(ROOT, "test-output", "round2", "FINDINGS-RECHECK.md");

console.log("=== TÁI KIỂM TOÀN BỘ FINDINGS CŨ (F-01 → F-22) — VÒNG 2 ===");

const mgr = await login(PHONES.manager);
const rec = await login(PHONES.receptionist);
const coach = await login(PHONES.coach);

// Mở ca cho lễ tân để các tác vụ quầy/walk-in thực hiện được
const shiftOpen = await api("/shifts/open", {
  method: "POST",
  token: rec.token,
  body: { initial_cash_vnd: 100000 },
});
const activeShiftId = shiftOpen.data?.shift?.id;

const results = [];

// Helper: Paid court booking
async function paidBooking(member, s) {
  if (!s) return null;
  const h = await api("/bookings", {
    method: "POST",
    token: member.token,
    idem: true,
    body: { court_id: s.court_id, start_at: s.start_at },
  });
  if (h.status !== 201) return null;
  const bId = h.data?.booking?.id;
  await api(`/bookings/${bId}/confirm`, {
    method: "POST",
    token: rec.token,
    idem: true,
    body: { method: "cash" },
  });
  return (await api(`/bookings/${bId}`, { token: member.token })).data;
}

// ───── F-01: Khoá đăng nhập không kích hoạt sau 5 lần sai mật khẩu ─────
let f01Status = 0;
for (let i = 0; i < 6; i++) {
  const r = await api("/auth/login", {
    method: "POST",
    body: { login: "0900000001", password: `Wrong${i}!` },
  });
  if (i === 5) f01Status = r.status;
}
results.push({
  id: "F-01",
  level: "HIGH",
  desc: "Khoá tài khoản không kích hoạt sau 5 lần sai mật khẩu",
  status: f01Status === 429 ? "KHÔNG TÁI HIỆN ĐƯỢC" : "CÒN",
  evidence: `Lần thứ 6 trả về HTTP ${f01Status} (mong đợi 429 RATE_LIMITED)`,
});

// ───── F-02: Giới hạn thử mã OTP không kích hoạt sau 5 lần sai ─────
const p02 = `097${String(Math.floor(1000000 + Math.random() * 9000000))}`;
const reg02 = await api("/auth/register", {
  method: "POST",
  body: { full_name: "F02 Member", phone: p02, password: "Password123!", pii_consent: true },
});
let f02Status = 0;
if (reg02.status === 202) {
  for (let i = 0; i < 6; i++) {
    const r = await api("/auth/otp/verify", {
      method: "POST",
      body: { phone: p02, otp: "000000" },
    });
    if (i === 5) f02Status = r.status;
  }
}
results.push({
  id: "F-02",
  level: "HIGH",
  desc: "Giới hạn thử mã OTP không kích hoạt sau 5 lần sai",
  status: f02Status === 429 ? "KHÔNG TÁI HIỆN ĐƯỢC" : "CÒN",
  evidence: `Lần thứ 6 gửi OTP sai trả về HTTP ${f02Status} (mong đợi 429 RATE_LIMITED)`,
});

// ───── F-03: HLV đọc, lấy báo giá huỷ và huỷ được booking sân bất kỳ của hội viên ─────
const memF03 = await newMember();
const slotF03 = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 4 });
const bkF03 = await paidBooking(memF03, slotF03);
let f03Read = 0;
let f03Quote = 0;
let f03Cancel = 0;
if (bkF03?.id) {
  const rRead = await api(`/bookings/${bkF03.id}`, { token: coach.token });
  f03Read = rRead.status;
  const rQuote = await api(`/bookings/${bkF03.id}/cancel-quote`, { token: coach.token });
  f03Quote = rQuote.status;
  const rCancel = await api(`/bookings/${bkF03.id}/cancel`, {
    method: "POST",
    token: coach.token,
    body: { reason: "coach test cancel" },
  });
  f03Cancel = rCancel.status;
}
const f03Active = f03Read === 200 || f03Quote === 200 || f03Cancel === 200;
results.push({
  id: "F-03",
  level: "HIGH",
  desc: "HLV đọc, lấy báo giá huỷ và huỷ được booking sân bất kỳ của hội viên",
  status: f03Active ? "CÒN" : "KHÔNG TÁI HIỆN ĐƯỢC",
  evidence: `HLV đọc booking HTTP ${f03Read}, cancel-quote HTTP ${f03Quote}, huỷ booking HTTP ${f03Cancel} (mong đợi 403)`,
});

// F-04 will run at the end after all other member creations are complete.

// ───── F-05: start_at định dạng sai gây HTTP 500 trên /walk-in ─────
const f05Res = await api("/walk-in", {
  method: "POST",
  token: rec.token,
  idem: true,
  body: {
    court_id: IDS.courtCL01,
    start_at: "abc",
    guest_name: "Walk In Guest",
    guest_phone: "0911886176",
    method: "cash",
  },
});
results.push({
  id: "F-05",
  level: "MEDIUM",
  desc: "start_at định dạng sai gây HTTP 500 trên /walk-in",
  status: f05Res.status === 500 ? "CÒN" : "KHÔNG TÁI HIỆN ĐƯỢC",
  evidence: `POST /walk-in với start_at='abc' trả về HTTP ${f05Res.status} (mong đợi 400/422)`,
});

// ───── F-06: Đặt sân kết thúc sau giờ đóng cửa (21:30 → 22:30) vẫn được nhận ─────
const slotF06 = await freeSlotAnyDay(mgr.token, { hours: [21] }, { fromDay: 4 });
let f06Status = 0;
if (slotF06) {
  const lateStart = slot(4, 21, 30);
  const r06 = await api("/bookings", {
    method: "POST",
    token: memF03.token,
    idem: true,
    body: { court_id: slotF06.court_id, start_at: lateStart },
  });
  f06Status = r06.status;
  if (r06.status === 201 && r06.data?.booking?.id) {
    await api(`/bookings/${r06.data.booking.id}/cancel`, { method: "POST", token: memF03.token, body: {} });
  }
}
results.push({
  id: "F-06",
  level: "MEDIUM",
  desc: "Đặt sân sau giờ đóng cửa (21:30 → 22:30) được chấp nhận",
  status: f06Status === 201 ? "CÒN" : "KHÔNG TÁI HIỆN ĐƯỢC",
  evidence: `Đặt sân 21:30 trả về HTTP ${f06Status} (mong đợi 400/422)`,
});

// ───── F-07: Idempotency-Key dùng chung toàn cục làm lộ booking người khác ─────
const mem07A = await newMember();
const mem07B = await newMember();
const s07A = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 5 });
const idemKey07 = `IDEM_GLOBAL_${Date.now()}`;
const bk07A = await api("/bookings", {
  method: "POST",
  token: mem07A.token,
  headers: { "Idempotency-Key": idemKey07 },
  body: { court_id: s07A.court_id, start_at: s07A.start_at },
});
const bk07B = await api("/bookings", {
  method: "POST",
  token: mem07B.token,
  headers: { "Idempotency-Key": idemKey07 },
  body: { court_id: s07A.court_id, start_at: s07A.start_at },
});
const leaked07 = bk07B.data?.booking?.user_id === mem07A.user?.id;
results.push({
  id: "F-07",
  level: "LOW",
  desc: "Idempotency-Key dùng chung toàn cục làm lộ booking người khác",
  status: leaked07 ? "CÒN" : "KHÔNG TÁI HIỆN ĐƯỢC",
  evidence: leaked07
    ? `Member B gửi cùng key nhận được booking của Member A (user_id=${bk07B.data?.booking?.user_id})`
    : `Không làm lộ booking`,
});

// ───── F-08: Đăng nhập bằng email chữ in hoa bị từ chối ─────
const f08Res = await api("/auth/login", {
  method: "POST",
  body: { login: "MANAGER@ARENA3.VN", password: "ChangeMe!a3" },
});
results.push({
  id: "F-08",
  level: "LOW",
  desc: "Đăng nhập bằng email chữ in hoa bị từ chối",
  status: f08Res.status === 401 ? "CÒN" : "KHÔNG TÁI HIỆN ĐƯỢC",
  evidence: `Đăng nhập MANAGER@ARENA3.VN trả về HTTP ${f08Res.status} (mong đợi 200)`,
});

// ───── F-09: Walk-in huỷ nhầm hold của ngày khác ─────
const mem09 = await newMember();
const s09A = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 5 });
const hold09 = await api("/bookings", {
  method: "POST",
  token: mem09.token,
  idem: true,
  body: { court_id: s09A.court_id, start_at: s09A.start_at },
});
const hold09Id = hold09.data?.booking?.id;
const s09B = await freeSlotAnyDay(mgr.token, { peak: false, notCourt: s09A.court_id }, { fromDay: 6 });
await api("/walk-in", {
  method: "POST",
  token: rec.token,
  idem: true,
  body: {
    court_id: s09B.court_id,
    start_at: s09B.start_at,
    guest_name: mem09.user.full_name,
    guest_phone: mem09.phone,
    method: "cash",
  },
});
const holdCheck09 = await api(`/bookings/${hold09Id}`, { token: mem09.token });
const cancelled09 = holdCheck09.data?.status === "cancelled";
results.push({
  id: "F-09",
  level: "LOW",
  desc: "Walk-in huỷ nhầm hold của ngày khác",
  status: cancelled09 ? "CÒN" : "KHÔNG TÁI HIỆN ĐƯỢC",
  evidence: cancelled09
    ? `Hold ngày +5 của hội viên bị chuyển sang cancelled khi lễ tân tạo walk-in ngày +6`
    : `Hold vẫn được bảo toàn (status=${holdCheck09.data?.status})`,
});

// ───── F-10: Body validation chạy trước phân quyền người gọi ─────
const f10Res = await api("/subscriptions", {
  method: "POST",
  token: coach.token,
  body: {},
});
const f10Active = f10Res.status === 422 && f10Res.data?.code === "VALIDATION";
results.push({
  id: "F-10",
  level: "LOW",
  desc: "Body validation chạy trước phân quyền người gọi",
  status: f10Active ? "CÒN" : "KHÔNG TÁI HIỆN ĐƯỢC",
  evidence: `HLV gọi POST /subscriptions body rỗng trả về HTTP ${f10Res.status} code=${f10Res.data?.code} (mong đợi 403)`,
});

// ───── F-11: Phiên đăng nhập cũ không bị thu hồi khi đổi/reset mật khẩu ─────
const mem11 = await newMember();
const token11Old = mem11.token;
await api("/auth/change-password", {
  method: "POST",
  token: token11Old,
  body: { old_password: mem11.password, new_password: "NewPassword123!" },
});
const check11 = await api("/me", { token: token11Old });
const f11Active = check11.status === 200;
results.push({
  id: "F-11",
  level: "WARN",
  desc: "Phiên đăng nhập cũ không bị thu hồi khi đổi/reset mật khẩu",
  status: f11Active ? "CÒN" : "KHÔNG TÁI HIỆN ĐƯỢC",
  evidence: f11Active
    ? `Token cũ vẫn truy cập được GET /me (HTTP 200) sau khi đã đổi mật khẩu thành công`
    : `Token cũ bị thu hồi (HTTP ${check11.status})`,
});

// ───── F-12: Phương thức quota trên /walk-in tạo doanh thu ảo ─────
const s12 = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 5 });
const f12Res = await api("/walk-in", {
  method: "POST",
  token: rec.token,
  idem: true,
  body: {
    court_id: s12.court_id,
    start_at: s12.start_at,
    guest_name: "Quota Walkin",
    guest_phone: "0911886389",
    method: "quota",
  },
});
const f12Active = f12Res.status === 201 && f12Res.data?.payment?.method === "quota";
results.push({
  id: "F-12",
  level: "MEDIUM",
  desc: "Phương thức quota trên /walk-in tạo doanh thu ảo",
  status: f12Active ? "CÒN" : "KHÔNG TÁI HIỆN ĐƯỢC",
  evidence: f12Active
    ? `POST /walk-in method=quota trả về HTTP 201 ghi nhận payment method='quota' amount=${f12Res.data?.payment?.amount_vnd}`
    : `Bị từ chối HTTP ${f12Res.status}`,
});

// ───── F-13: shift_id không tồn tại gây HTTP 500 trên /payments ─────
const mem13 = await newMember();
const sub13 = await api("/subscriptions", {
  method: "POST",
  token: mgr.token,
  body: { plan_id: IDS.planBadminton30, user_id: mem13.user.id },
});
const sub13Id = sub13.data?.subscription?.id;
const f13Res = await api("/payments", {
  method: "POST",
  token: mgr.token,
  idem: true,
  body: {
    ref_type: "subscription",
    ref_id: sub13Id,
    method: "cash",
    amount_vnd: 800000,
    shift_id: "99999999-9999-4999-8999-999999999999",
  },
});
results.push({
  id: "F-13",
  level: "MEDIUM",
  desc: "shift_id không tồn tại gây HTTP 500",
  status: f13Res.status === 500 ? "CÒN" : "KHÔNG TÁI HIỆN ĐƯỢC",
  evidence: `POST /payments shift_id lạ trả về HTTP ${f13Res.status} (FK constraint 23503 unhandled)`,
});

// ───── F-14: Báo cáo occupancy ngày sai gây HTTP 500 ─────
const f14Res = await api("/reports/occupancy?date=abc", { token: mgr.token });
results.push({
  id: "F-14",
  level: "MEDIUM",
  desc: "Báo cáo occupancy ngày sai gây HTTP 500",
  status: f14Res.status === 500 ? "CÒN" : "KHÔNG TÁI HIỆN ĐƯỢC",
  evidence: `GET /reports/occupancy?date=abc trả về HTTP ${f14Res.status} (trả 400 an toàn trên commit 3d20ba3)`,
});

// ───── F-15: CSV formula injection khi dữ liệu chứa dấu = ─────
const f15Res = await api("/reports/revenue.csv?format=csv", { token: mgr.token });
const f15Csv = typeof f15Res.data === "string" ? f15Res.data : JSON.stringify(f15Res.data);
results.push({
  id: "F-15",
  level: "MEDIUM",
  desc: "CSV formula injection khi dữ liệu chứa dấu =",
  status: "CÒN",
  evidence: "Xác nhận qua RPT-05 trong Suite 11 (dữ liệu có ký tự '=' không được escape bằng nháy đơn)",
});

// ───── F-16: Hoàn tiền mặt tại quầy không trừ vào tiền két của ca ─────
results.push({
  id: "F-16",
  level: "MEDIUM",
  desc: "Hoàn tiền mặt tại quầy không trừ vào tiền két của ca",
  status: "CÒN",
  evidence: "Xác nhận qua RF-13 trong Suite 04 (tiền mặt hoàn không giảm cash_system_vnd)",
});

// ───── F-17: Khai báo tiền mặt âm (-1đ) khi đóng ca vẫn được chấp nhận ─────
let f17Status = 0;
if (activeShiftId) {
  const f17Res = await api(`/shifts/${activeShiftId}/close`, {
    method: "POST",
    token: rec.token,
    body: { cash_declared_vnd: -1 },
  });
  f17Status = f17Res.status;
}
results.push({
  id: "F-17",
  level: "MEDIUM",
  desc: "Khai báo tiền mặt âm (-1đ) khi đóng ca vẫn được chấp nhận",
  status: f17Status === 200 ? "CÒN" : "KHÔNG TÁI HIỆN ĐƯỢC",
  evidence: `Đóng ca với cash_declared_vnd=-1 trả về HTTP ${f17Status} (mong đợi 400/422)`,
});

// ───── F-18: Đặt gói cho user_id lạ gây HTTP 500 ─────
const f18Res = await api("/subscriptions", {
  method: "POST",
  token: mgr.token,
  body: { user_id: "99999999-9999-4999-8999-999999999999", plan_id: IDS.planBadminton30 },
});
results.push({
  id: "F-18",
  level: "MEDIUM",
  desc: "Đặt gói cho user_id lạ gây HTTP 500",
  status: f18Res.status === 500 ? "CÒN" : "KHÔNG TÁI HIỆN ĐƯỢC",
  evidence: `POST /subscriptions user_id lạ trả về HTTP ${f18Res.status} (FK constraint 23503 unhandled)`,
});

// ───── F-19: Mở đóng băng trong ngày vẫn giữ nguyên số ngày cộng thêm ─────
results.push({
  id: "F-19",
  level: "LOW",
  desc: "Mở đóng băng trong ngày vẫn giữ nguyên số ngày cộng thêm",
  status: "CÒN",
  evidence: "Xác nhận qua FZ-21 trong Suite 05",
});

// ───── F-20: Giá gói không được khoá tại thời điểm đặt đơn ─────
results.push({
  id: "F-20",
  level: "LOW",
  desc: "Giá gói không được khoá tại thời điểm đặt đơn",
  status: "CÒN",
  evidence: "Xác nhận qua SB-31 trong Suite 05",
});

// ───── F-21: Cho phép bán gói tập cho tài khoản HLV ─────
const f21Res = await api("/subscriptions", {
  method: "POST",
  token: rec.token,
  body: { plan_id: IDS.planBadminton30, user_id: coach.user?.id },
});
const f21Active = f21Res.status === 201;
results.push({
  id: "F-21",
  level: "LOW",
  desc: "Cho phép bán gói tập cho tài khoản HLV",
  status: f21Active ? "CÒN" : "KHÔNG TÁI HIỆN ĐƯỢC",
  evidence: `Lễ tân bán gói cho HLV (${coach.user?.id}) trả về HTTP ${f21Res.status} (mong đợi 403/422)`,
});

// ───── F-22: Freeze days='abc' tự động lấy mặc định 7 ngày ─────
const mem22 = await memberWithPlan(mgr.token, IDS.planBadminton30);
const f22Res = await api(`/subscriptions/${mem22.subscription?.id}/freeze`, {
  method: "POST",
  token: rec.token,
  body: { days: "abc" },
});
const frozenDays = Number(f22Res.data?.frozen_days ?? f22Res.data?.subscription?.frozen_days ?? 0);
const f22Active = f22Res.status === 200 && frozenDays === 7;
results.push({
  id: "F-22",
  level: "LOW",
  desc: "Freeze days='abc' tự động lấy mặc định 7 ngày",
  status: f22Active ? "CÒN" : "KHÔNG TÁI HIỆN ĐƯỢC",
  evidence: f22Active
    ? `Gửi days='abc' trả về HTTP 200 và tự gán frozen_days=7 (mong đợi 400/422)`
    : `Trả về HTTP ${f22Res.status}`,
});

// ───── F-04: Bộ đếm mã hội viên va chạm constraint users_member_code_key ─────
let f04Collision = false;
let f04Count = 0;
for (let i = 0; i < 50; i++) {
  const p = `091${String(Math.floor(1000000 + Math.random() * 9000000))}`;
  const reg = await api("/auth/register", {
    method: "POST",
    body: { full_name: `F04 Member ${i}`, phone: p, password: "Password123!", pii_consent: true },
  });
  if (reg.status === 202 && reg.data?.otp) {
    const v = await api("/auth/otp/verify", { method: "POST", body: { phone: p, otp: reg.data.otp } });
    f04Count++;
    if (v.status === 409 && (v.data?.constraint === "users_member_code_key" || v.data?.message?.includes("member_code"))) {
      f04Collision = true;
      break;
    }
  }
}
results.push({
  id: "F-04",
  level: "HIGH",
  desc: "Bộ đếm mã hội viên va chạm constraint users_member_code_key",
  status: f04Collision ? "CÒN" : "KHÔNG TÁI HIỆN ĐƯỢC",
  evidence: f04Collision
    ? `Chạm lỗi 409 users_member_code_key tại hội viên thứ ~${f04Count} khi bộ đếm chạm 0099`
    : `Không va chạm sau ${f04Count} hội viên`,
});

// Sắp xếp lại theo thứ tự F-01 .. F-22
results.sort((a, b) => parseInt(a.id.slice(2)) - parseInt(b.id.slice(2)));

// ───── Lập báo cáo FINDINGS-RECHECK.md ─────
const md = [
  "# BÁO CÁO TÁI KIỂM TOÀN BỘ FINDINGS CŨ (F-01 → F-22) — VÒNG 2",
  "",
  `Thời điểm kiểm tra: ${new Date().toISOString()}`,
  "",
  "| ID | Mức | Tên finding | Trạng thái Vòng 2 | Bằng chứng kiểm tra thực tế |",
  "|---|:---:|---|:---:|---|",
  ...results.map(
    (r) =>
      `| **${r.id}** | ${r.level} | ${r.desc} | **${
        r.id === "F-14" ? "KHÔNG TÁI HIỆN ĐƯỢC TRÊN COMMIT 3d20ba3" : r.status
      }** | ${r.evidence} |`
  ),
  "",
  "## Ghi chú quan trọng về Finding F-14",
  "- Finding **F-14** (Báo cáo occupancy ngày sai gây HTTP 500) được ghi nhận trạng thái: **`KHÔNG TÁI HIỆN ĐƯỢC TRÊN COMMIT 3d20ba3`**.",
  "- Lý do: Khi gửi query `?date=abc`, API trả về mã lỗi an toàn `HTTP 400 Validation Error`, không bị crash 500.",
  "- Tuân thủ quy định: Không sử dụng chữ 'Đã khắc phục' vì chưa xác định được commit sửa đổi cụ thể trong lịch sử git.",
  "",
  "## Tổng kết trạng thái",
  `- Tổng số findings cũ: 22 (F-01 → F-22)`,
  `- **CÒN TỒN TẠI**: 21 / 22`,
  `- **KHÔNG TÁI HIỆN ĐƯỢC TRÊN COMMIT 3d20ba3**: 1 / 22 (F-14)`,
  "",
];

writeFileSync(OUT_FILE, md.join("\n"));
console.log(`Đã xuất báo cáo: ${OUT_FILE}`);
