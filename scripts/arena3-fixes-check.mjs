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

/**
 * Làm gì: In thông báo lỗi ra stderr và dừng ngay toàn bộ tiến trình kiểm thử với mã thoát 1 khi có assertion thất bại.
 * Được gọi ở: scripts/arena3-fixes-check.mjs (trong hàm ok và login).
 * - Tham số msg: Thông điệp mô tả vị trí hoặc lý do kiểm tra thất bại.
 * - Tham số extra: Dữ liệu ngữ cảnh hoặc object phản hồi kèm theo để hỗ trợ gỡ lỗi.
 * - Trả về: Không trả về giá trị (dừng tiến trình ngay lập tức).
 * - Lỗi có thể ném: Dừng tiến trình Node.js với mã 1 (process.exit(1)).
 */
function fail(msg, extra) {
  console.error("FAIL", msg, extra === undefined ? "" : JSON.stringify(extra));
  process.exit(1);
}
/**
 * Làm gì: Kiểm tra điều kiện assertion; nếu điều kiện sai sẽ dừng kịch bản qua fail(), nếu đúng sẽ tăng biến đếm passed và in log thành công.
 * Được gọi ở: scripts/arena3-fixes-check.mjs (xuyên suốt các ca kiểm thử B-01, B-02, B-12, B-13, B-09, B-05).
 * - Tham số cond: Biểu thức điều kiện cần kiểm tra (boolean).
 * - Tham số msg: Tên ca kiểm tra hoặc mô tả assertion kỳ vọng.
 * - Tham số extra: Dữ liệu ngữ cảnh đính kèm in ra khi assertion thất bại.
 * - Trả về: Không trả về giá trị.
 */
function ok(cond, msg, extra) {
  if (!cond) fail(msg, extra);
  passed += 1;
  console.log("ok  ", msg);
}

/**
 * Làm gì: Wrapper gửi HTTP request đến API backend `/v1`, tự động gắn Authorization Bearer, Idempotency-Key và parse JSON an toàn.
 * Được gọi ở: scripts/arena3-fixes-check.mjs (trong hàm login và tất cả các bước gọi API trong kịch bản).
 * - Tham số path: Đường dẫn endpoint sau tiền tố /v1 (ví dụ "/settings", "/bookings").
 * - Tham số options: Cấu hình request gồm HTTP method, Bearer token, body payload và cờ idem sinh idempotency-key.
 * - Trả về: Đối tượng chứa mã phản hồi status và dữ liệu data (JSON parse hoặc text thô).
 */
async function req(path, { method = "GET", token, body, idem } = {}) {
  // Bước 1: Chuẩn bị HTTP headers (nhận JSON, content-type khi có body, Bearer token và Idempotency-Key chống trùng lặp)
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (idem) headers["idempotency-key"] = crypto.randomUUID();
  // Bước 2: Thực hiện gọi HTTP fetch đến API server backend
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // Bước 3: Đọc phản hồi dưới dạng text và thử parse JSON an toàn (fallback về text thô nếu không phải JSON)
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  // Bước 4: Trả về kết quả gồm mã HTTP status và payload data đã xử lý
  return { status: res.status, data };
}

/**
 * Làm gì: Đăng nhập tài khoản qua route `/v1/auth/login` bằng số điện thoại và mật khẩu để lấy auth token.
 * Được gọi ở: scripts/arena3-fixes-check.mjs (dòng 49, 50, 51 để đăng nhập tài khoản seed và dòng 223, 243 cho hội viên tạo mới).
 * - Tham số phone: Số điện thoại của tài khoản cần đăng nhập.
 * - Tham số password: Mật khẩu tài khoản (mặc định lấy theo hằng số PASS).
 * - Trả về: Dữ liệu phản hồi đăng nhập chứa JWT token và thông tin người dùng.
 * - Lỗi có thể ném: Dừng kịch bản qua fail() nếu đăng nhập không trả về HTTP 200 hoặc thiếu token.
 */
async function login(phone, password = PASS) {
  // Bước 1: Gửi request đăng nhập với số điện thoại và mật khẩu đến /auth/login
  const r = await req("/auth/login", { method: "POST", body: { login: phone, password } });
  // Bước 2: Kiểm tra phản hồi trả về HTTP 200 và có token hợp lệ; nếu thất bại thì dừng kịch bản ngay
  if (r.status !== 200 || !r.data?.token) fail(`login ${phone}`, r);
  return r.data;
}

// Đăng nhập sẵn 3 vai trò nòng cốt từ dữ liệu seed để chuẩn bị ngữ cảnh kiểm thử: Manager (quản lý), Receptionist (lễ tân) và Member (hội viên)
const mgr = await login("0900000001");
const desk = await login("0900000002");
const member = await login("0901230101");

// ---- B-01 / G-01: settings ------------------------------------------------
{
  // Bước 1: Quản lý đọc cấu hình hệ thống hiện tại và cập nhật các thông số hợp lệ (hold_minutes, open_time, close_time)
  const cur = await req("/settings", { token: mgr.token });
  ok(cur.status === 200, "B-01 read settings", cur);
  const save = await req("/settings", {
    method: "PATCH",
    token: mgr.token,
    body: { legal_name: "Arena3 Sports Center", hold_minutes: "10", open_time: "06:00", close_time: "22:00", tax_code: "0312345678" },
  });
  ok(save.status === 200 && save.data.hold_minutes === 10, "B-01 a valid save succeeds", save);

  // Bước 2: Kiểm tra các trường hợp validation thất bại: để trống số nguyên, số vượt giới hạn int, chuỗi quá dài, giờ đóng trước giờ mở
  const blank = await req("/settings", { method: "PATCH", token: mgr.token, body: { gate_dedup_minutes: "" } });
  ok(blank.status === 400 && blank.data.field === "gate_dedup_minutes", "B-01 blank number is a 400 naming the field", blank);

  const big = await req("/settings", { method: "PATCH", token: mgr.token, body: { gate_dedup_minutes: 99999999999 } });
  ok(big.status === 400 && big.data.field === "gate_dedup_minutes", "B-01 over-int is a 400 naming the field", big);

  const long = await req("/settings", { method: "PATCH", token: mgr.token, body: { tax_code: "1".repeat(40) } });
  ok(long.status === 400 && long.data.field === "tax_code", "B-01 too-long text is a 400 naming the field", long);

  const hours = await req("/settings", { method: "PATCH", token: mgr.token, body: { close_time: "05:00" } });
  ok(hours.status === 400 && hours.data.field === "close_time", "B-01 close before open is refused", hours);

  // Bước 3: Xác minh các bản lưu lỗi không làm thay đổi cấu hình cũ và kiểm tra lễ tân bị chặn sửa cấu hình (403 Forbidden)
  const after = await req("/settings", { token: mgr.token });
  ok(after.data.hold_minutes === 10, "B-01 refused saves changed nothing", after.data);
  const notMgr = await req("/settings", { method: "PATCH", token: desk.token, body: { hold_minutes: 5 } });
  ok(notMgr.status === 403, "B-01 receptionist cannot change settings", notMgr);
}

// ---- B-02: refund queue ---------------------------------------------------
{
  // A paid court for the member, refunded above the receptionist limit.
  // Bước 1: Lấy cấu hình hạn mức duyệt hoàn tiền hiện tại và đảm bảo quầy lễ tân đã mở ca làm việc (open shift)
  const settings = (await req("/settings", { token: mgr.token })).data;
  const limit = Number(settings.refund_manager_vnd);
  const shift = await req("/shifts/open", { method: "POST", token: desk.token });
  ok(shift.status === 201 || shift.status === 409, "B-02 desk has a till open", shift);

  // Lower the threshold so a small payment trips it.
  // Bước 2: Tạm thời hạ hạn mức duyệt của Manager xuống 1.000 VNĐ để khoản thanh toán nhỏ cũng kích hoạt quy trình duyệt
  await req("/settings", { method: "PATCH", token: mgr.token, body: { refund_manager_vnd: 1000 } });
  const pending = await req("/payments/pending", { token: desk.token });
  ok(pending.status === 200, "B-02 queue readable", pending);

  // A member made for this check, so the run is repeatable and touches nobody real.
  // Bước 3: Tạo một hội viên mới kèm timestamp ngẫu nhiên để kịch bản độc lập và không ảnh hưởng dữ liệu thực
  const stamp = String(Date.now()).slice(-7);
  const created = await req("/members", {
    method: "POST",
    token: desk.token,
    body: { full_name: `Refund Check ${stamp}`, phone: `091${stamp}`, pii_consent: true },
  });
  const memberUser = created.data?.user;
  ok(created.status === 201 && memberUser?.id, "B-02 made a member to refund", created);
  // Bước 4: Đăng ký gói tập đang mở bán và thanh toán bằng tiền mặt (gắn cờ idem) để chuẩn bị kịch bản hoàn tiền
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
  // Bước 5: Lễ tân yêu cầu hoàn tiền; khoản tiền vượt hạn mức nên chuyển sang trạng thái chờ quản lý duyệt (refund_pending)
  const refund = await req(`/payments/${payment.id}/refund`, {
    method: "POST",
    token: desk.token,
    body: { amount_vnd: plan.price_vnd, reason: "check" },
  });
  ok(refund.status === 201 && refund.data.payment.status === "refund_pending", "B-02 large refund waits for a manager", refund);
  // Bước 6: Kiểm tra hàng đợi chờ duyệt: Quản lý thấy yêu cầu, lễ tân không thể tự duyệt (403), Quản lý duyệt thành công (posted)
  const queue = await req("/payments/pending", { token: mgr.token });
  ok(queue.data.refunds.some((r) => r.id === refund.data.payment.id), "B-02 manager sees it in the queue", queue.data.refunds);
  const selfApprove = await req(`/payments/${refund.data.payment.id}/approve-refund`, { method: "POST", token: desk.token });
  ok(selfApprove.status === 403, "B-02 receptionist cannot approve", selfApprove);
  const approve = await req(`/payments/${refund.data.payment.id}/approve-refund`, { method: "POST", token: mgr.token });
  ok(approve.status === 200 && approve.data.status === "posted", "B-02 manager approves", approve);
  // Bước 7: Xác minh tính bất biến (không thể duyệt/từ chối 2 lần - 409 Conflict), ghi log audit và gửi thông báo in-app cho hội viên
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
  // Bước 8: Khôi phục lại hạn mức hoàn tiền ban đầu của Quản lý để không ảnh hưởng đến các ca kiểm thử khác
  await req("/settings", { method: "PATCH", token: mgr.token, body: { refund_manager_vnd: limit } });
}

// ---- B-12 / B-17 / D-05: gear ----------------------------------------------
{
  // Bước 1: Lấy danh sách dụng cụ thể thao và chọn thiết bị có tồn kho từ 2 chiếc trở lên
  const eq = await req("/equipment", { token: desk.token });
  const item = eq.data.items.find((i) => i.stock >= 2);
  ok(!!item, "gear: an item with stock exists", eq.data);
  // Bước 2: Kiểm tra validation mượn đồ: thiếu số điện thoại báo 400; mượn vượt quá tồn kho bị từ chối theo quy tắc BR-50 (422)
  const noPhone = await req("/equipment/loans", { method: "POST", token: desk.token, body: { item_id: item.id, qty: 1 } });
  ok(noPhone.status === 400 && noPhone.data.field === "phone", "B-12 missing phone names the field", noPhone);
  const tooMany = await req("/equipment/loans", {
    method: "POST",
    token: desk.token,
    body: { item_id: item.id, phone: "0987654321", qty: item.stock + 1 },
  });
  ok(tooMany.status === 422 && tooMany.data.br === "BR-50", "B-12 server refuses more than the stock", tooMany);
  // Bước 3: Tìm kiếm hội viên theo số điện thoại và thực hiện mượn dụng cụ gắn theo tài khoản hội viên
  const found = await req("/members?q=0901230101", { token: desk.token });
  const m = found.data.items[0];
  ok(!!m, "B-17 member is found by phone", found.data);
  const byMember = await req("/equipment/loans", {
    method: "POST",
    token: desk.token,
    body: { item_id: item.id, user_id: m.id, qty: 2 },
  });
  ok(byMember.status === 201 && byMember.data.loan.phone === m.phone, "B-17 member rents by account", byMember);
  // Bước 4: Xác minh số lượng tồn kho giảm tương ứng và danh sách phiếu mượn hiển thị đúng tên hội viên
  const afterOut = (await req("/equipment", { token: desk.token })).data.items.find((i) => i.id === item.id);
  ok(afterOut.stock === item.stock - 2, "B-17 stock comes down by the quantity", afterOut);
  const loans = await req("/equipment/loans", { token: desk.token });
  const mine = loans.data.items.find((l) => l.id === byMember.data.loan.id);
  ok(mine?.member_name === m.full_name, "B-17 loan list names the member", mine);
  // Bước 5: Lễ tân xác nhận trả dụng cụ, kiểm tra tồn kho được phục hồi và chặn trả trùng lặp lần 2 (409 Conflict)
  const back = await req(`/equipment/loans/${byMember.data.loan.id}/return`, { method: "POST", token: desk.token });
  ok(back.status === 200, "D-05 return works", back);
  const afterBack = (await req("/equipment", { token: desk.token })).data.items.find((i) => i.id === item.id);
  ok(afterBack.stock === item.stock, "D-05 return restores exactly that loan's quantity", afterBack);
  const twice = await req(`/equipment/loans/${byMember.data.loan.id}/return`, { method: "POST", token: desk.token });
  ok(twice.status === 409, "D-05 a loan cannot be returned twice", twice);
}

// ---- B-13: notifications can be read ----------------------------------------
{
  // Bước 1: Lấy thông tin tài khoản hội viên, kiểm tra trường read_at trong inbox và đánh dấu đã đọc thông báo đầu tiên
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
  // Bước 2: Kiểm tra gửi id thông báo không hợp lệ ("nope") phải nhận mã lỗi 400 và chỉ rõ trường bị lỗi là id
  const bad = await req("/me/notifications/read", { method: "POST", token: member.token, body: { id: "nope" } });
  ok(bad.status === 400 && bad.data.field === "id", "B-13 bad id names the field", bad);
}

// ---- B-09 / C-01 / C-06: class code and detail ---------------------------------
{
  // Bước 1: Lấy danh sách lớp học và xác minh mỗi lớp học đều có mã code định danh
  const list = await req("/classes", { token: desk.token });
  const c = list.data.items?.[0];
  ok(!!c?.code, "B-09 classes carry a code", c);
  // Bước 2: Mở chi tiết lớp học để đảm bảo trả về đúng mã code và danh sách mảng các buổi học (sessions)
  const detail = await req(`/classes/${c.id}`, { token: desk.token });
  ok(detail.status === 200 && detail.data.class.code === c.code && Array.isArray(detail.data.sessions), "C-06 class detail opens", detail);
  // Bước 3: Đảm bảo toàn bộ mã code của các lớp học là duy nhất, không có mã nào bị trùng lặp
  const codes = list.data.items.map((i) => i.code);
  ok(new Set(codes).size === codes.length, "B-09 every class code is unique", codes);
}

// ---- B-05: hold -> confirm, every outcome is a code, none is a bare 500 ------
{
  // A member made for this check, so nobody real has their daily slots used up.
  // Bước 1: Tạo hội viên riêng cho ca kiểm thử đặt sân để không làm cạn hạn ngạch đặt sân trong ngày của hội viên khác
  const stamp5 = String(Date.now()).slice(-7);
  const made = await req("/members", {
    method: "POST",
    token: desk.token,
    body: { full_name: `Booking Check ${stamp5}`, phone: `092${stamp5}`, pii_consent: true },
  });
  ok(made.status === 201, "B-05 made a member to book with", made);
  const m5 = await login(made.data.user.phone, made.data.temp_password);
  // A date two days out, a court of the member's sport, an hour nobody holds.
  /**
   * Làm gì: Tính toán chuỗi ngày định dạng YYYY-MM-DD sau d ngày theo múi giờ Việt Nam (ICT, UTC+7).
   * Được gọi ở: scripts/arena3-fixes-check.mjs (dòng 226 để xác định ngày đặt sân trong tương lai).
   * - Tham số d: Số ngày cộng thêm tính từ ngày hiện tại.
   * - Trả về: Chuỗi ngày định dạng YYYY-MM-DD.
   */
  const ict = (d) => new Date(Date.now() + d * 86400000 + 7 * 3600000).toISOString().slice(0, 10);
  const date = ict(2);
  // Bước 2: Kiểm tra lịch chiếm sân (/occupancy) sau 2 ngày để tìm sân cầu lông và khung giờ trống
  const occ = await req(`/occupancy?date=${date}`, { token: m5.token });
  const court = occ.data.courts.find((c) => c.sport === "badminton" && c.status === "ready");
  const busy = new Set(occ.data.slots.filter((s) => s.court_id === court.id).map((s) => new Date(s.start).getTime()));
  let hour = 7;
  while (busy.has(new Date(`${date}T${String(hour).padStart(2, "0")}:00:00+07:00`).getTime())) hour += 1;
  const startAt = `${date}T${String(hour).padStart(2, "0")}:00:00+07:00`;

  // Bước 3: Hội viên 1 thực hiện giữ chỗ (hold) sân với cờ idempotency-key chống gửi trùng
  const h1 = await req("/bookings", { method: "POST", token: m5.token, body: { court_id: court.id, start_at: startAt }, idem: true });
  ok(h1.status === 201 && h1.data.booking?.status === "hold", "B-05 hold is created", h1);

  // Another member reaches for the same slot.
  // Bước 4: Tạo hội viên thứ 2 tranh chấp cùng khung giờ; hệ thống phải từ chối với lỗi xung đột CONFLICT_SLOT (409)
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

  // Bước 5: Hội viên không được phép tự xác nhận thanh toán tiền mặt (403 Forbidden do tiền mặt chỉ lễ tân xác nhận tại quầy)
  const badMethod = await req(`/bookings/${h1.data.booking.id}/confirm`, { method: "POST", token: m5.token, body: { method: "cash" }, idem: true });
  ok(badMethod.status === 403, "B-05 a member cannot mark it paid in cash", badMethod);

  // Bước 6: Hội viên chọn xác nhận bằng chuyển khoản (transfer), hệ thống chuyển sang 202 Accepted và chờ lễ tân đối soát
  const viaTransfer = await req(`/bookings/${h1.data.booking.id}/confirm`, { method: "POST", token: m5.token, body: { method: "transfer" }, idem: true });
  ok(viaTransfer.status === 202 && viaTransfer.data.awaiting_transfer === true, "B-05 transfer waits for reception", viaTransfer);

  // Bước 7: Không cho phép xác nhận đè phương thức thanh toán khác khi đang chờ chuyển khoản (409 Conflict thay vì lỗi 500)
  const again = await req(`/bookings/${h1.data.booking.id}/confirm`, { method: "POST", token: m5.token, body: { method: "quota" }, idem: true });
  ok(again.status === 409, "B-05 confirming a booking already awaiting transfer is a 409, not a 500", again);

  // Bước 8: Hủy giữ chỗ thành công để giải phóng khung giờ trên sân cho hội viên khác đặt
  const cancel = await req(`/bookings/${h1.data.booking.id}/cancel`, { method: "POST", token: m5.token });
  ok(cancel.status === 200, "B-05 the held court can be released", cancel);
}

// In tổng số lượng ca kiểm thử kiểm tra sửa lỗi đã vượt qua thành công
console.log(`\n${passed} checks passed`);
