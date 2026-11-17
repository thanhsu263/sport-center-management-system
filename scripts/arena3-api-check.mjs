#!/usr/bin/env node
/**
 * Live API check for Arena3. BASE=https://arena3-self.vercel.app npm run ... 
 * Exits 1 on the first failed assertion.
 */
// Cấu hình URL gốc của backend API (mặc định trỏ về 127.0.0.1:8080 nếu biến môi trường BASE chưa được đặt).
const BASE = (process.env.BASE ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
// Mật khẩu kiểm thử mặc định dùng chung cho các tài khoản seed data trong hệ thống.
const PASS = "ChangeMe!a3";

/**
 * Làm gì: In thông báo lỗi kiểm tra ra console và dừng ngay tiến trình kiểm thử với mã lỗi 1.
 * Được gọi ở: scripts/arena3-api-check.mjs (hàm expect).
 * - Tham số msg: Chuỗi thông điệp mô tả lỗi hoặc assertion bị vi phạm.
 * - Tham số extra: Dữ liệu phụ trợ bổ sung in kèm để hỗ trợ gỡ lỗi.
 * - Trả về: Không trả về giá trị (luôn thoát tiến trình bằng process.exit(1)).
 */
function fail(msg, extra) {
  console.error("FAIL", msg, extra ?? "");
  process.exit(1);
}

/**
 * Làm gì: Gửi HTTP request đến API backend Arena3 (${BASE}/v1${path}), tự động gắn headers, Bearer token, idempotency key và parse kết quả JSON.
 * Được gọi ở: scripts/arena3-api-check.mjs (hàm login và hàm main).
 * - Tham số path: Đường dẫn tương đối của endpoint API (ví dụ: "/plans", "/bookings").
 * - Tham số options: Cấu hình request bao gồm method, token xác thực, body payload và cờ sinh idempotency key.
 * - Trả về: Promise giải quyết thành object { status, data } chứa mã phản hồi HTTP và dữ liệu đã parse.
 * - Lỗi có thể ném: TypeError nếu fetch thất bại do sự cố kết nối mạng.
 */
async function req(path, { method = "GET", token, body, idem } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  // Header chống trùng lặp: đảm bảo các thao tác tài chính, đặt chỗ không bị thực thi 2 lần khi thử lại.
  if (idem) headers["idempotency-key"] = crypto.randomUUID();
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  // Thử parse dữ liệu phản hồi dạng JSON; nếu không phải JSON (text thuần hoặc rỗng) thì giữ nguyên.
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

/**
 * Làm gì: Kiểm tra điều kiện assertion trong kịch bản test; nếu điều kiện sai thì kích hoạt hàm fail để dừng tiến trình.
 * Được gọi ở: scripts/arena3-api-check.mjs (hàm login và các bước kiểm tra trong hàm main).
 * - Tham số cond: Biểu thức điều kiện cần kiểm tra (boolean).
 * - Tham số msg: Thông điệp lỗi cần hiển thị nếu điều kiện bị vi phạm.
 * - Tham số extra: Dữ liệu phụ trợ bổ sung in ra khi assertion thất bại.
 * - Trả về: Không trả về giá trị (void).
 */
function expect(cond, msg, extra) {
  if (!cond) fail(msg, extra);
}

/**
 * Làm gì: Đăng nhập vào hệ thống bằng số điện thoại và mật khẩu mặc định, kiểm tra tính hợp lệ của token trả về.
 * Được gọi ở: scripts/arena3-api-check.mjs (hàm main, dùng để lấy token cho manager, receptionist, coach, member).
 * - Tham số phone: Số điện thoại của tài khoản cần đăng nhập.
 * - Trả về: Promise giải quyết thành dữ liệu phiên đăng nhập chứa JWT token và thông tin người dùng.
 */
async function login(phone) {
  const r = await req("/auth/login", { method: "POST", body: { login: phone, password: PASS } });
  expect(r.status === 200 && r.data?.token, `login ${phone}`, r);
  return r.data;
}

/**
 * Làm gì: Thực thi kịch bản kiểm thử toàn diện (smoke test) các API cốt lõi của Arena3: danh mục, xác thực, phân quyền, giữ sân, chuyển khoản và đối soát.
 * Được gọi ở: scripts/arena3-api-check.mjs (dòng 255 khi chạy script trực tiếp qua CLI, lệnh npm run check:api, hoặc scripts/auto-grade.mjs).
 * - Trả về: Promise không trả về giá trị (void).
 */
async function main() {
  // Bước 1: Kiểm tra các API danh mục công khai (gói tập, lớp học, bảng giá) không cần đăng nhập.
  const plans = await req("/plans");
  expect(plans.status === 200 && plans.data.items?.length > 0, "GET /plans", plans);
  const classes = await req("/classes");
  expect(classes.status === 200 && classes.data.items?.length > 0, "GET /classes", classes);
  const prices = await req("/price-rules");
  expect(prices.status === 200 && prices.data.items?.some((p) => p.day_kind === "weekday"), "GET /price-rules", prices);

  // Pins the 2026-09-27 live-check P0: PUT /v1/price-rules had left the
  // weekday badminton court quoted at 99,999,999đ (and other slots at
  // 100,000,004đ / 0đ). Every price on the public list must sit in the real
  // range now, and none may be the vandalized value directly.
  for (const p of prices.data.items) {
    expect(
      p.price_vnd !== 99_999_999 && p.price_vnd !== 100_000_004,
      `price-rules row is not vandalized (${p.sport} ${p.day_kind})`,
      p,
    );
    expect(p.price_vnd > 0 && p.price_vnd <= 5_000_000, `price-rules row is within bounds (${p.sport} ${p.day_kind})`, p);
  }
  const weekdayBadminton = prices.data.items.find(
    (p) => p.sport === "badminton" && p.day_kind === "weekday" && p.start_local?.startsWith("06:"),
  );
  expect(weekdayBadminton && weekdayBadminton.price_vnd !== 80_000_000, "weekday 11:00 badminton quote is not 8e7", weekdayBadminton);

  // Pins P1 #3: the hidden trial plan must never reach a member-visible list.
  expect(
    !plans.data.items.some((p) => p.id === "20000000-0000-0000-0000-000000000008"),
    "hidden trial plan is not in public GET /plans",
    plans.data.items,
  );

  // Bước 2: Đăng nhập 4 vai trò người dùng mẫu (manager, receptionist, coach, member) và xác thực quyền hạn (role).
  const mgr = await login("0900000001");
  expect(mgr.user.role === "manager", "manager role");
  const desk = await login("0900000002");
  expect(desk.user.role === "receptionist", "desk role");
  const coach = await login("0901110011");
  expect(coach.user.role === "coach", "coach role");
  const member = await login("0901230101");
  expect(member.user.role === "member", "member role");

  // Bước 3: Lấy thông tin cá nhân của hội viên (/me) và kiểm tra tình trạng kín sân (/occupancy).
  const me = await req("/me", { token: member.token });
  expect(me.status === 200 && me.data.user?.full_name, "GET /me", me);
  expect(Array.isArray(me.data.subscriptions), "me.subscriptions");
  expect(Array.isArray(me.data.inbox), "me.inbox");

  const occ = await req("/occupancy", { token: member.token });
  expect(occ.status === 200 && occ.data.courts?.length >= 10, "GET /occupancy", occ);

  // Bước 4: Kiểm tra tính năng tạo ticket hỗ trợ và xử lý chuỗi tiền tố ghi chú (FR-S03).
  // Pins P1 #4: repeated "ticket:" prefixes collapse to the actual note,
  // and a note that is empty after stripping is refused rather than opened
  // blank (FR-S03).
  const ticketDouble = await req("/tickets", {
    method: "POST",
    token: member.token,
    idem: true,
    body: { body: "ticket:ticket: hello" },
  });
  expect(ticketDouble.status === 201 && ticketDouble.data.body === "hello", '"ticket:ticket: hello" is stored as "hello"', ticketDouble);
  const ticketEmpty = await req("/tickets", {
    method: "POST",
    token: member.token,
    idem: true,
    body: { body: "ticket:" },
  });
  expect(ticketEmpty.status === 422, 'empty "ticket:" returns 422', ticketEmpty);

  // Bước 5: Kiểm tra phân quyền truy cập (RBAC) giữa các vai trò và xử lý xác thực không hợp lệ.
  const reports = await req("/reports/revenue", { token: mgr.token });
  expect(reports.status === 200 && reports.data.totals, "GET /reports/revenue", reports);

  const schedule = await req("/coach/schedule", { token: coach.token });
  expect(schedule.status === 200 && Array.isArray(schedule.data.items), "GET /coach/schedule", schedule);

  const flags = await req("/flags");
  expect(flags.status === 200 && flags.data.flags, "GET /flags", flags);

  const search = await req("/members?q=Nam", { token: desk.token });
  expect(search.status === 200 && search.data.items?.length >= 1, "GET /members?q=Nam", search);

  // Kiểm tra RBAC: Hội viên (member) bị cấm xem báo cáo doanh thu (phải nhận mã 403 Forbidden).
  const forbidden = await req("/reports/revenue", { token: member.token });
  expect(forbidden.status === 403, "member cannot read revenue", forbidden);

  // Kiểm tra bảo mật: Đăng nhập sai mật khẩu phải bị từ chối với mã 401 Unauthorized.
  const badLogin = await req("/auth/login", { method: "POST", body: { login: "0900000001", password: "nope" } });
  expect(badLogin.status === 401, "bad password", badLogin);

  // Bước 6: Tìm một khung giờ trống trên sân cầu lông hôm nay để thử nghiệm quy trình đặt sân.
  // Hold a far-enough empty badminton slot, then cancel — must not leave occupancy.
  const date = occ.data.date;
  const courts = occ.data.courts.filter((c) => c.sport === "badminton" && c.status === "ready");
  // Khung giờ hoạt động trong ngày của trung tâm thể thao từ 06:00 đến 21:00.
  const hours = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
  let pick = null;
  for (const c of courts) {
    for (const h of hours) {
      const start = Date.parse(`${date}T${String(h).padStart(2, "0")}:00:00+07:00`);
      const busy = occ.data.slots.some((s) => {
        if (s.court_id !== c.id) return false;
        // Kiểm tra chồng lấn lịch trong khung 1 giờ (3,600,000 ms): slot đã bận nếu trùng thời gian với lịch đã đặt.
        return Date.parse(s.start) < start + 3600000 && Date.parse(s.end) > start;
      });
      if (!busy) {
        pick = { court: c, hour: h };
        break;
      }
    }
    if (pick) break;
  }
  expect(pick, "a free badminton slot today");
  const startAt = `${date}T${String(pick.hour).padStart(2, "0")}:00:00+07:00`;
  // Bước 7: Thực hiện giữ chỗ sân (hold) bằng tài khoản hội viên qua endpoint POST /v1/bookings.
  const hold = await req("/bookings", {
    method: "POST",
    token: member.token,
    idem: true,
    body: { court_id: pick.court.id, start_at: startAt },
  });
  // Nếu giữ chỗ thành công (201), tiếp tục kiểm tra luồng thanh toán chuyển khoản và đối soát.
  if (hold.status === 201 && hold.data.booking?.id) {
    expect(hold.data.price > 0, "hold has a price", hold);
    const bookingId = hold.data.booking.id;

    // Bước 8: Gửi yêu cầu xác nhận đặt sân bằng hình thức chuyển khoản ngân hàng (trạng thái hold và awaiting_transfer).
    /*
     * A bank transfer is a promise, not a payment.
     *
     * The assertions that matter here are the negative ones. Tapping "Bank
     * transfer" used to post a payment and confirm the booking on the spot, so
     * the centre's revenue counted money nobody had looked for yet. Nothing
     * may be posted until somebody finds it on the statement; the slot is held
     * in the meantime, which is what makes that safe to wait for.
     */
    const promised = await req(`/bookings/${bookingId}/confirm`, {
      method: "POST",
      token: member.token,
      idem: true,
      body: { method: "transfer" },
    });
    expect(promised.status === 202, "transfer does not confirm the booking", promised);
    expect(promised.data.awaiting_transfer === true, "confirm reports awaiting_transfer", promised);
    expect(promised.data.payment === null, "no payment row while the money is outstanding", promised);
    expect(promised.data.booking?.status === "hold", "the slot stays held for the transfer", promised);

    // Whose word counts. A member reconciling their own transfer is the exact
    // thing this queue exists to stop.
    const selfConfirm = await req(`/bookings/${bookingId}/transfer-confirm`, {
      method: "POST",
      token: member.token,
    });
    expect(selfConfirm.status === 403, "members cannot reconcile their own transfer", selfConfirm);

    // Bước 9: Lễ tân (receptionist) kiểm tra hàng đợi chờ duyệt và xác nhận tiền đã vào tài khoản.
    const pending = await req("/payments/pending", { token: desk.token });
    expect(pending.status === 200, "GET /payments/pending", pending);
    expect(
      pending.data.awaiting?.some((a) => a.id === bookingId),
      "the transfer reaches the desk queue",
      pending.data.awaiting,
    );

    const settled = await req(`/bookings/${bookingId}/transfer-confirm`, {
      method: "POST",
      token: desk.token,
    });
    expect(settled.status === 200, "desk confirms the transfer", settled);
    expect(settled.data.booking?.status === "confirmed", "the booking is confirmed once money lands", settled);
    expect(settled.data.payment?.status === "posted", "the payment exists only now", settled);
    expect(settled.data.invoice_id, "a receipt is issued for a reconciled transfer", settled);

    // Bước 10: Lễ tân thực hiện hoàn tiền (refund) và kiểm tra nghiệp vụ chống hoàn tiền trùng lặp (double refund).
    /*
     * The same money must not go back twice.
     *
     * No refund row links to the payment it undoes, so the guard has to read
     * the whole ledger for the booking rather than compare against one row.
     * The second call below asks for money that has already been sent back.
     */
    const paid = settled.data.payment;
    const refund = await req(`/payments/${paid.id}/refund`, {
      method: "POST",
      token: desk.token,
      idem: true,
      body: { amount_vnd: paid.amount_vnd, reason: "api-check" },
    });
    expect([200, 201].includes(refund.status), "desk raises a refund", refund);
    const again = await req(`/payments/${paid.id}/refund`, {
      method: "POST",
      token: desk.token,
      idem: true,
      body: { amount_vnd: paid.amount_vnd, reason: "api-check duplicate" },
    });
    expect(again.status === 422, "the same payment cannot be refunded twice", again);

    // Hand the court back. Tidying after the check, not an assertion.
    await req(`/bookings/${bookingId}/cancel`, { method: "POST", token: member.token });
  } else {
    // Trường hợp không giữ chỗ được: phải do quy tắc nghiệp vụ từ chối (422 vượt hạn mức hoặc 409 xung đột lịch).
    expect(
      hold.status === 422 || hold.status === 409,
      "hold rejected by business rule (quota/conflict)",
      hold,
    );
  }

  // Bước 11: Kiểm tra tính năng trợ lý ảo AI (/assistant) trả lời thắc mắc của hội viên.
  const assistant = await req("/assistant", {
    method: "POST",
    token: member.token,
    body: { message: "Giờ mở cửa?" },
  });
  expect(assistant.status === 200 && typeof assistant.data.reply === "string", "POST /assistant", assistant);

  // Bước 12: In tóm tắt kết quả kiểm tra thành công ra console cùng số lượng dữ liệu đã thu thập.
  console.log("OK", BASE, {
    plans: plans.data.items.length,
    classes: classes.data.items.length,
    prices: prices.data.items.length,
    occupancyCourts: occ.data.courts.length,
    coachSessions: schedule.data.items.length,
    assistant: assistant.data.source,
  });
}

// Kích hoạt kịch bản kiểm thử chính; nếu có lỗi chưa được bắt thì log ra console và thoát với mã 1.
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
