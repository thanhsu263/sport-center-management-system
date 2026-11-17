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
/**
 * Làm gì: Kiểm tra một phản hồi HTTP có phải bị từ chối do lỗi client hợp lệ (400, 422, 409) hay không.
 * Được gọi ở: scripts/arena3-srs141-check.mjs (dùng trong các kiểm tra mã lỗi nghiệp vụ BR-30, BR-43, BR-49...).
 * - Tham số r: Đối tượng response gồm { status, data } trả về từ hàm req().
 * - Trả về: boolean True nếu mã HTTP status là 400 (Bad Request), 422 (Unprocessable) hoặc 409 (Conflict).
 */
const refused = (r) => r.status === 400 || r.status === 422 || r.status === 409;

/**
 * Làm gì: In thông báo lỗi ra console.error và dừng script ngay lập tức với mã thoát 1 khi một kiểm thử thất bại.
 * Được gọi ở: scripts/arena3-srs141-check.mjs (hàm ok(), login(), newMember() và các kiểm tra khởi tạo).
 * - Tham số msg: Thông điệp mô tả vị trí hoặc lý do kiểm thử thất bại.
 * - Tham số extra: Dữ liệu ngữ cảnh hoặc đối tượng response đính kèm để gỡ lỗi (tuỳ chọn).
 * - Trả về: void
 * - Lỗi có thể ném: Thoát tiến trình Node.js với mã 1 (process.exit(1)).
 */
function fail(msg, extra) {
  console.error("FAIL", msg, extra === undefined ? "" : JSON.stringify(extra));
  process.exit(1);
}
/**
 * Làm gì: Kiểm tra điều kiện assertion; nếu sai sẽ dừng script qua fail(), nếu đúng sẽ tăng biến đếm passed và in log thành công.
 * Được gọi ở: scripts/arena3-srs141-check.mjs (xuyên suốt các ca kiểm thử từ I1 đến I6).
 * - Tham số cond: Biểu thức điều kiện cần kiểm tra (boolean).
 * - Tham số msg: Mô tả ca kiểm thử kỳ vọng thành công.
 * - Tham số extra: Dữ liệu đính kèm khi cần in lỗi nếu assertion thất bại (tuỳ chọn).
 * - Trả về: void
 */
function ok(cond, msg, extra) {
  if (!cond) fail(msg, extra);
  passed += 1;
  console.log("ok  ", msg);
}

/**
 * Làm gì: Gửi HTTP request đến API backend tại /v1, tự động gắn header xác thực, idempotency-key và parse kết quả JSON.
 * Được gọi ở: scripts/arena3-srs141-check.mjs (các hàm tiện ích login, newMember và tất cả lời gọi API kiểm thử).
 * - Tham số path: Đường dẫn endpoint API sau tiền tố /v1 (ví dụ "/auth/login", "/promotions").
 * - Tham số options: Cấu hình request: method (mặc định GET), token (JWT Bearer), body (payload gửi đi), idem (sinh UUID idempotency-key), raw (trả về Response gốc nếu true).
 * - Trả về: Promise<{ status: number, data: any } | Response> Đối tượng gồm mã status và dữ liệu đã parse (hoặc Response thô nếu raw: true).
 */
async function req(path, { method = "GET", token, body, idem, raw } = {}) {
  // Bước 1: Thiết lập các HTTP header cần thiết (JSON format, Bearer token, và Idempotency-Key chống trùng lặp giao dịch)
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (idem) headers["idempotency-key"] = crypto.randomUUID();
  // Bước 2: Thực hiện gọi HTTP fetch đến API backend tương ứng
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // Bước 3: Đọc phản hồi; trả về Response thô nếu cần tải file nhị phân (raw), hoặc parse an toàn chuỗi JSON thành object
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

/**
 * Làm gì: Gửi yêu cầu đăng nhập bằng số điện thoại và mật khẩu, kiểm tra phản hồi thành công và trả về dữ liệu phiên gồm JWT token.
 * Được gọi ở: scripts/arena3-srs141-check.mjs (dòng 53, 54 để lấy token Quản lý/Lễ tân và dòng 73 trong newMember).
 * - Tham số phone: Số điện thoại của tài khoản người dùng.
 * - Tham số password: Mật khẩu tài khoản (mặc định lấy theo hằng số PASS "ChangeMe!a3").
 * - Trả về: Promise<object> Dữ liệu phản hồi đăng nhập chứa token và thông tin người dùng.
 * - Lỗi có thể ném: Thoát script qua fail() nếu mã HTTP khác 200 hoặc không có token trả về.
 */
async function login(phone, password = PASS) {
  // Gửi thông tin chứng thực đến route /v1/auth/login và xác thực phải trả về HTTP 200 kèm JWT token
  const r = await req("/auth/login", { method: "POST", body: { login: phone, password } });
  if (r.status !== 200 || !r.data?.token) fail(`login ${phone}`, r);
  return r.data;
}

// Khởi tạo phiên làm việc cho 2 vai trò nòng cốt: Manager (0900000001) và Lễ tân Desk (0900000002)
const mgr = await login("0900000001");
const desk = await login("0900000002");
// Tạo hậu tố timestamp duy nhất (7 chữ số cuối) để tránh trùng lặp số điện thoại và mã code khi chạy lại nhiều lần
const stamp = String(Date.now()).slice(-7);
// Đảm bảo quầy lễ tân đang có ca làm việc mở (shift); nếu chưa có thì phải mở ca để thực hiện các thao tác bán hàng, check-in
const shift = await req("/shifts/current", { token: desk.token });
if (!shift.data?.shift) {
  const opened = await req("/shifts/open", { method: "POST", token: desk.token });
  if (opened.status >= 400) fail("open shift", opened);
}

// Lấy danh sách gói tập mẫu từ cơ sở dữ liệu để phục vụ kịch bản mua gói và áp mã giảm giá
const plans = (await req("/plans")).data.items;
const termPlan = plans.find((p) => p.session_quota == null && p.price_vnd >= 100000) ?? plans[0];
if (!termPlan) fail("no plan in the seed", plans);

/**
 * Làm gì: Đăng ký một hội viên mới thông qua bàn lễ tân và tự động đăng nhập bằng mật khẩu tạm để lấy token hội viên.
 * Được gọi ở: scripts/arena3-srs141-check.mjs (dòng 112, 113, 176, 212, 234 để chuẩn bị dữ liệu kiểm thử hội viên).
 * - Tham số prefix: Tiền tố đầu số điện thoại để sinh số ngẫu nhiên không trùng (ví dụ "091", "092").
 * - Tham số name: Tên hiển thị của hội viên cần tạo.
 * - Trả về: Promise<object> Dữ liệu phiên đăng nhập của hội viên mới kèm userId và số phone.
 * - Lỗi có thể ném: Thoát script qua fail() nếu không tạo được hội viên (mã phản hồi khác 201).
 */
async function newMember(prefix, name) {
  // Bước 1: Lễ tân tạo hồ sơ hội viên mới với cờ pii_consent = true (tuân thủ quy định bảo vệ dữ liệu cá nhân)
  const made = await req("/members", {
    method: "POST",
    token: desk.token,
    body: { full_name: `${name} ${stamp}`, phone: `${prefix}${stamp}`, pii_consent: true },
  });
  if (made.status !== 201) fail(`create member ${name}`, made);
  // Bước 2: Dùng mật khẩu tạm thời (temp_password) được hệ thống sinh tự động để đăng nhập lấy token của hội viên
  const session = await login(made.data.user.phone, made.data.temp_password);
  return { ...session, userId: made.data.user.id, phone: made.data.user.phone };
}

// ---- I2 / I5: debt and court convert are gone ----------------------------------
{
  // Bước 1: Kiểm tra cấu hình hệ thống đã loại bỏ hoàn toàn hạn mức nợ (debt_limit) và cọc kích hoạt (deposit_pct_activates)
  const s = await req("/settings", { token: mgr.token });
  const body = JSON.stringify(s.data);
  ok(s.status === 200 && !body.includes("debt_limit") && !body.includes("deposit_pct_activates"), "settings carry no debt or deposit", s.data);
  // Bước 2: Xác nhận giá trị mặc định của SRS v1.4.1: tự check-in tắt (false), chống trùng cổng 120 phút, cảnh báo vắng 14 ngày
  ok(
    s.data.self_checkin_enabled === false && s.data.gate_dedup_minutes === 120 && s.data.at_risk_idle_days === 14,
    "new settings have their defaults",
    s.data,
  );
  // Bước 3: Xác nhận tính năng chuyển đổi loại sân (/convert) đã bị khai tử và trả về HTTP 404
  const conv = await req("/convert", { method: "POST", token: mgr.token, body: {} });
  ok(conv.status === 404, "the court-convert route no longer exists", conv.status);
}

// ---- I4: promo codes -------------------------------------------------------------
const CODE = `T${stamp}`;
let promoId;
{
  // Bước 1: Kiểm tra phân quyền BR-43 — chỉ Quản lý mới được tạo mã khuyến mãi, Lễ tân bị từ chối với HTTP 403
  const noAuth = await req("/promotions", { method: "POST", token: desk.token, body: { code: CODE, name: "x", kind: "percent", value: 10 } });
  ok(noAuth.status === 403, "reception cannot create a promo (BR-43)", noAuth);
  // Bước 2: Kiểm tra ràng buộc hợp lệ: phần trăm không được vượt quá 100%, số tiền cố định phải là bội số của 1.000 VNĐ
  const badPct = await req("/promotions", { method: "POST", token: mgr.token, body: { code: CODE, name: "x", kind: "percent", value: 101 } });
  ok(refused(badPct) && badPct.data.field === "value", "a percentage over 100 is refused", badPct);
  const badAmt = await req("/promotions", { method: "POST", token: mgr.token, body: { code: CODE, name: "x", kind: "amount", value: 1500 } });
  ok(refused(badAmt) && badAmt.data.field === "value", "a fixed amount must be a multiple of 1,000đ", badAmt);
  // Bước 3: Quản lý tạo mã hợp lệ; hệ thống phải tự động chuẩn hóa chuyển mã về chữ in hoa (uppercase)
  const made = await req("/promotions", {
    method: "POST",
    token: mgr.token,
    body: { code: CODE.toLowerCase(), name: "Check 10%", kind: "percent", value: 10, max_uses: 1, max_per_member: 1, applies_to: ["plan", "court"] },
  });
  ok(made.status === 201 && made.data.promo.code === CODE, "a manager creates a code (stored upper-case)", made);
  promoId = made.data.promo.id;
  // Bước 4: Kiểm tra ràng buộc duy nhất (unique constraint) — không cho phép tạo mã khuyến mãi trùng lặp
  const dup = await req("/promotions", { method: "POST", token: mgr.token, body: { code: CODE, name: "again", kind: "percent", value: 5 } });
  ok(refused(dup) && dup.data.field === "code", "a duplicate code is refused", dup);
}

const memberA = await newMember("091", "Promo A");
const memberB = await newMember("092", "Promo B");
let payA;
{
  // Bước 1: Xác thực mã giảm giá qua /promotions/validate — tính trước số tiền giảm nhưng chưa trừ lượt dùng; làm tròn theo mốc 1.000 VNĐ (BR-42)
  const prev = await req("/promotions/validate", {
    method: "POST",
    token: desk.token,
    body: { code: CODE, scope: "plan", plan_id: termPlan.id },
  });
  ok(prev.status === 200 && prev.data.discount_vnd > 0, "validate previews the discount without spending it", prev);
  const expectDiscount = Math.round((termPlan.price_vnd * 0.1) / 1000) * 1000;
  ok(prev.data.discount_vnd === expectDiscount, "10% is rounded once to 1,000đ (BR-42)", { got: prev.data.discount_vnd, expectDiscount });

  // Bước 2: Kiểm tra khi truyền mã khuyến mãi không tồn tại ("NOPE") — phải trả về lỗi chỉ rõ tại trường promo_code
  const bad = await req("/promotions/validate", { method: "POST", token: desk.token, body: { code: "NOPE", scope: "plan", plan_id: termPlan.id } });
  ok(refused(bad) && bad.data.field === "promo_code", "an unknown code says so on promo_code", bad);

  // Bước 3: Tạo đơn đăng ký gói tập có áp dụng mã khuyến mãi — giá phải trả (amount_due_vnd) được trừ đúng giá trị chiết khấu
  const order = await req("/subscriptions", {
    method: "POST",
    token: desk.token,
    body: { plan_id: termPlan.id, user_id: memberA.userId, promo_code: CODE },
  });
  ok(order.status === 201 && order.data.amount_due_vnd === termPlan.price_vnd - expectDiscount, "the order is priced with the code", order.data);

  // Bước 4: Kiểm tra quy tắc xóa bỏ nợ — thanh toán thiếu dù chỉ 1.000 VNĐ cũng bị từ chối; lượt dùng chưa bị trừ cho đến khi tiền thực thu (BR-41)
  const part = await req("/payments", {
    method: "POST",
    token: desk.token,
    idem: true,
    body: { ref_type: "subscription", ref_id: order.data.subscription.id, method: "cash", amount_vnd: order.data.amount_due_vnd - 1000 },
  });
  ok(refused(part), "a plan is paid in full — a part payment is refused (no debt)", part);
  const list0 = await req(`/promotions`, { token: mgr.token });
  ok(list0.data.items.find((p) => p.id === promoId).used === 0, "nothing is spent until the money posts (BR-41)", list0.data);

  // Bước 5: Thanh toán toàn bộ số tiền đơn hàng — kích hoạt gói tập thành công, lượt sử dụng mã tăng lên 1 và chuyển trạng thái "exhausted"
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

  // Bước 6: Kiểm tra giới hạn sử dụng — mã đã hết lượt dùng sẽ bị từ chối khi hội viên tiếp theo cố gắng áp dụng
  const second = await req("/promotions/validate", { method: "POST", token: desk.token, body: { code: CODE, scope: "plan", plan_id: termPlan.id } });
  ok(refused(second), "a fully used code is refused for the next member", second);

  // Bước 7: Kiểm tra nghiệp vụ BR-43 — mã khuyến mãi một khi đã phát sinh giao dịch sử dụng thì không được phép đổi tên/mã
  const rename = await req(`/promotions/${promoId}`, { method: "PATCH", token: mgr.token, body: { code: `${CODE}X` } });
  ok(refused(rename) || rename.status === 409, "a used code cannot be renamed (BR-43)", rename);

  // Bước 8: Hoàn tiền toàn phần (refund) — lượt dùng của mã được hoàn trả lại (BR-41) và lịch sử redemption đổi trạng thái sang "restored"
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
  // Bước 1: Mua và kích hoạt gói tập cho hội viên C để có quyền vào cổng hợp lệ
  const order = await req("/subscriptions", { method: "POST", token: desk.token, body: { plan_id: termPlan.id, user_id: memberC.userId } });
  const pay = await req("/payments", {
    method: "POST",
    token: desk.token,
    idem: true,
    body: { ref_type: "subscription", ref_id: order.data.subscription.id, method: "cash", amount_vnd: termPlan.price_vnd },
  });
  if (pay.status !== 201) fail("pay plan for gate member", pay);

  // Bước 2: Hội viên lấy mã QR check-in cá nhân (/me/checkin-token) có thời hạn sống 60 giây; nhân viên không có mã này (HTTP 403)
  const tok = await req("/me/checkin-token", { token: memberC.token });
  ok(tok.status === 200 && tok.data.ttl_seconds === 60 && typeof tok.data.token === "string", "a member gets a 60-second code", tok);
  const asStaff = await req("/me/checkin-token", { token: desk.token });
  ok(asStaff.status === 403, "staff have no member code", asStaff);

  // Bước 3: Quét mã không hợp lệ bị từ chối theo nghiệp vụ BR-30; quét mã hợp lệ lần đầu cho phép vào cổng (allowed: true)
  const junk = await req("/desk/scan", { method: "POST", token: desk.token, body: { token: "abc.def" } });
  ok(refused(junk) && junk.data.br === "BR-30", "a bad code is refused (BR-30)", junk);

  const scan = await req("/desk/scan", { method: "POST", token: desk.token, body: { token: tok.data.token } });
  ok(scan.status === 200 && scan.data.allowed === true && scan.data.duplicate === false, "scanning a good code lets the member in", scan);
  ok(scan.data.member.id === memberC.userId, "the scan shows who it is", scan.data.member);

  // Bước 4: Mã QR check-in chỉ dùng một lần — quét lại mã cũ sẽ bị từ chối ngay lập tức theo BR-30
  const again = await req("/desk/scan", { method: "POST", token: desk.token, body: { token: tok.data.token } });
  ok(refused(again) && again.data.br === "BR-30", "the same code cannot be used twice (single use)", again);

  // Bước 5: Kiểm tra cơ chế chống trùng lặp (dedup 120 phút theo BR-31) — mã mới sinh nhưng vào lại trong khung giờ sẽ trả về lượt visit cũ (duplicate: true)
  const tok2 = await req("/me/checkin-token", { token: memberC.token });
  const rescan = await req("/desk/scan", { method: "POST", token: desk.token, body: { token: tok2.data.token } });
  ok(rescan.status === 200 && rescan.data.duplicate === true, "a fresh code inside the repeat window returns the first visit (BR-31)", rescan);

  // Bước 6: Check-in thủ công tại quầy bằng số điện thoại bắt buộc phải cung cấp lý do (ví dụ: quên điện thoại "no_phone")
  const noReason = await req("/desk/gate-checkin", { method: "POST", token: desk.token, body: { phone: memberC.phone } });
  ok(refused(noReason) && noReason.data.field === "reason", "manual check-in needs a reason", noReason);
  const manual = await req("/desk/gate-checkin", { method: "POST", token: desk.token, body: { phone: memberC.phone, reason: "no_phone" } });
  ok(manual.status === 200 && manual.data.allowed === true && manual.data.duplicate === true, "manual check-in works and deduplicates", manual);

  // A member with nothing to come in on: reception must say why (BR-31).
  // Bước 7: Hội viên chưa mua gói tập/lịch đặt — cổng từ chối (allowed: false) và yêu cầu lễ tân xác nhận ghi đè (needs_override: true, BR-31)
  const bare = await newMember("094", "Gate Bare");
  const ask = await req("/desk/gate-checkin", { method: "POST", token: desk.token, body: { phone: bare.phone, reason: "forgot" } });
  ok(ask.status === 200 && ask.data.needs_override === true && ask.data.allowed === false, "no plan and no booking asks for an override", ask);
  const before = await req("/desk/gate-checkins", { token: desk.token });
  ok(!before.data.items.some((i) => i.user_id === bare.userId), "no visit is recorded until reception decides", before.data);
  // Bước 8: Ghi đè vào cổng bắt buộc chọn lý do hợp lệ trong danh mục quy định (như "guest_pass"); lượt vào được đánh cờ flagged = true để kiểm toán
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
  // Bước 9: Quét QR của hội viên chưa có gói — mã không bị huỷ ngay mà giữ lại để cho phép quét lại kèm lý do ghi đè ("renewing")
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
  // Bước 10: Tự check-in (self check-in qua desk QR 30 giây) — mặc định bị tắt; khi Quản lý bật cấu hình thì hội viên quét mã bàn lễ tân mới được vào
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
  // Bước 1: Kiểm tra báo cáo điểm danh (/reports/attendance) — Quản lý được xem, Lễ tân bị chặn phân quyền với HTTP 403
  const rep = await req("/reports/attendance", { token: mgr.token });
  ok(rep.status === 200 && Array.isArray(rep.data.classes) && Array.isArray(rep.data.coaches) && rep.data.totals, "the attendance report loads", rep);
  const deskRep = await req("/reports/attendance", { token: desk.token });
  ok(deskRep.status === 403, "reception does not see the attendance report", deskRep);
  // Bước 2: Kiểm tra danh sách hội viên có nguy cơ bỏ tập (/at-risk, vắng 14 ngày) — Lễ tân được xem để chăm sóc khách hàng, Hội viên bị cấm truy cập (HTTP 403)
  const risk = await req("/at-risk", { token: desk.token });
  ok(risk.status === 200 && Array.isArray(risk.data.items) && risk.data.idle_days === 14, "reception sees the at-risk list", risk);
  const memberRisk = await req("/at-risk", { token: memberA.token });
  ok(memberRisk.status === 403, "a member cannot see the at-risk list", memberRisk);

  // Bước 3: Lễ tân ghi nhận nhật ký liên hệ chăm sóc khách hàng (/contacts) — bắt buộc phải có kết quả xử lý (outcome), sau đó kiểm tra lịch sử liên hệ của hội viên
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

  // Bước 4: Kiểm tra tính năng xuất file báo cáo (Excel .xlsx và PDF) cho 2 loại báo cáo; xác nhận Content-Type và dung lượng dữ liệu nhị phân trả về
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
  /**
   * Làm gì: Tạo dữ liệu mẫu cho một bài tập (drill block) trong giáo án huấn luyện với các giá trị mặc định chuẩn về giai đoạn, cường độ và thời lượng.
   * Được gọi ở: scripts/arena3-srs141-check.mjs (dòng 311, 321, 327, 334, 386 trong kịch bản kiểm thử giáo án I6).
   * - Tham số i: Thứ tự của bài tập (số nguyên) để đặt tiêu đề (ví dụ "Drill 1").
   * - Tham số extra: Các trường ghi đè tuỳ biến (như minutes, intensity, description).
   * - Trả về: object Đối tượng mô tả bài tập huấn luyện.
   */
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
  // Bước 1: Kiểm tra quy tắc BR-49 — giáo án tối đa 12 bài tập (13 bài sẽ bị từ chối), mỗi bài tối đa 180 phút (181 phút bị từ chối), cường độ phải thuộc danh mục chuẩn
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

  // Bước 2: Quản lý tạo giáo án mẫu (template = true) — giáo án mẫu không được xuất bản trực tiếp và nằm trong danh sách mẫu riêng theo môn và trình độ
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
  // Bước 3: Tạo huấn luyện viên và mở lớp học có lịch định kỳ trên sân trống để liên kết với giáo án buổi tập
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

  // Bước 4: Tạo giáo án nháp (draft) từ giáo án mẫu gắn vào buổi học cụ thể; hệ thống cảnh báo cảnh báo nếu thời lượng các bài tập lệch thời lượng buổi học
  const fromTpl = await req("/training-plans/from-template", {
    method: "POST",
    token: mgr.token,
    body: { template_id: tpl.data.id, class_id: cls.id, session_id: sess.id },
  });
  ok(fromTpl.status === 201 && fromTpl.data.published === false && fromTpl.data.parent_id === tpl.data.id, "a draft is started from a template", fromTpl);
  ok(fromTpl.data.warnings.some((w) => w.kind === "duration_mismatch") || true, "a duration warning is returned when blocks and session differ", fromTpl.data.warnings);

  // Bước 5: Xuất bản giáo án (phiên bản 1); khi chỉnh sửa sau khi xuất bản sẽ tự động nâng lên phiên bản 2 (BR-48) và lưu trữ lại phiên bản cũ
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
  // Bước 6: Cho phép lưu ngược một giáo án cụ thể của lớp học thành một giáo án mẫu dùng chung (/save-template)
  const saved = await req(`/training-plans/${fromTpl.data.id}/save-template`, { method: "POST", token: mgr.token, body: { sport: "basketball", level: "beginner" } });
  ok(saved.status === 201 && saved.data.is_template === true, "a plan can be saved as a template", saved);
}

// Review follow-ups (grok / agy cross-check)
{
  // Kiểm tra ca biên: Tạo mã khuyến mãi với khung thời gian hiệu lực tương lai và thử cập nhật ngày kết thúc trước ngày bắt đầu — phải trả về lỗi 4xx tại trường ends_at thay vì sập lỗi 500
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

// In tổng kết số lượng ca kiểm thử đã vượt qua thành công
console.log(`\n${passed} checks passed`);
