/**
 * File kiểm thử luồng nghiệp vụ tích hợp (integration / flow tests) cho hệ thống Arena3.
 * Sử dụng database PostgreSQL in-memory (PGlite) nạp toàn bộ migrations để giả lập môi trường thực tế.
 * Kiểm thử toàn diện các kịch bản: đặt sân, thanh toán cọc/đủ tiền, đăng ký lớp học, check-in qua cổng và các lỗi nghiệp vụ.
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

// Keep src/server/data/db.ts from bootstrapping a real connection.
process.env.DATABASE_URL = "postgres://mock:mock@localhost/mock";
process.env.PGLITE_DATA_DIR = "memory";

import { register } from "node:module";
import { pathToFileURL } from "node:url";

try {
  register(pathToFileURL("./scripts/tests/agent/ttf-loader.mjs"));
} catch {
  // already registered
}

const { setOverridePglite, withTx } = await import("./tx.ts");
const { classesEnroll, enrollmentDelete } = await import("./handlers/classes.ts");
const { bookingsHold, bookingsConfirm, bookingsTransferConfirm, bookingsCancel } = await import("./handlers/bookings.ts");
const { paymentsCreate } = await import("./handlers/desk.ts");
const { gateCheckin } = await import("./handlers/checkin.ts");
const { membersReportBody } = await import("./handlers/reports.ts");
const { handleApi } = await import("./router.ts");

let db: PGlite;

before(async () => {
  // Bước 1: Khởi tạo database PGlite chạy trên bộ nhớ (in-memory) và đợi kết nối sẵn sàng.
  db = new PGlite();
  await db.waitReady;
  // Bước 2: Quét thư mục migrations và thực thi lần lượt tất cả file .sql để dựng đầy đủ schema database.
  const migDir = "migrations";
  const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    await db.exec(readFileSync(join(migDir, f), "utf8"));
  }
  // Bước 3: Ghi đè kết nối database trong controller bằng instance PGlite này để phục vụ toàn bộ test suite.
  setOverridePglite(db);
});

after(() => {
  // Dọn dẹp: Hủy ghi đè PGlite, khôi phục kết nối mặc định sau khi chạy xong toàn bộ test.
  setOverridePglite(null);
});

// ---- shared fixtures (seeded by migrations 0003/0006) ----
const MANAGER = { id: "00000000-0000-0000-0000-000000000001", role: "manager", full_name: "Quan ly Arena3" } as any;
const RECEPTIONIST = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist", full_name: "Le tan ca 1" } as any;
const COACH_ID = "00000000-0000-0000-0000-000000000003";

let seq = 0;
/**
 * Làm gì: Sinh số điện thoại Việt Nam (+8497xxxxxxx) duy nhất bằng cách tăng biến đếm seq.
 * Được gọi ở: flows.test.ts (seedMember).
 * @returns Chuỗi số điện thoại chuẩn E.164.
 */
const nextPhone = () => "+8497" + String(++seq).padStart(7, "0");

/** Day n days from today in Asia/Ho_Chi_Minh (UTC+7), as YYYY-MM-DD. */
const ictDay = (n: number) => new Date(Date.now() + 7 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
/**
 * Làm gì: Lấy chuỗi ngày tương lai (sau hôm nay 3 ngày) theo múi giờ Việt Nam (ICT) để kiểm thử đặt sân trước.
 * Được gọi ở: flows.test.ts (holdSlot).
 * @returns Chuỗi ngày định dạng YYYY-MM-DD.
 */
const FUTURE = () => ictDay(3);
/**
 * Làm gì: Lấy chuỗi ngày trong quá khứ (trước hôm nay 2 ngày) theo múi giờ Việt Nam (ICT) để kiểm thử từ chối đặt slot đã qua.
 * Được gọi ở: flows.test.ts (EF-01d).
 * @returns Chuỗi ngày định dạng YYYY-MM-DD.
 */
const PAST = () => ictDay(-2);
/**
 * Làm gì: Lấy chuỗi ngày hôm nay theo múi giờ Việt Nam (ICT) để kiểm thử các ca đặt trong ngày.
 * Được gọi ở: flows.test.ts (các test case trong file).
 * @returns Chuỗi ngày định dạng YYYY-MM-DD.
 */
const TODAY = () => ictDay(0);

/**
 * Làm gì: Tạo đối tượng Request giả lập với header JSON để gọi trực tiếp các controller handler trong bài test.
 * Được gọi ở: flows.test.ts (holdSlot, bookingsConfirm, paymentsCreate, gateCheckin).
 * @param body Dữ liệu payload gửi kèm request (được chuyển thành JSON string).
 * @param method Phương thức HTTP (mặc định là "POST").
 * @returns Đối tượng Request chuẩn của Fetch API.
 */
function jsonReq(body: unknown, method = "POST"): Request {
  return new Request("http://localhost/v1/test", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Làm gì: Tạo tài khoản hội viên (role 'member') trong bảng users để phục vụ các kịch bản kiểm thử.
 * Được gọi ở: flows.test.ts (các ca kiểm thử MF-01, MF-01b, EF-01a..e).
 * @param name Họ và tên của hội viên cần tạo.
 * @returns Đối tượng người dùng gồm id, role và full_name để gán vào session context.
 */
async function seedMember(name: string): Promise<any> {
  // Bước 1: Sinh UUID ngẫu nhiên và số điện thoại không trùng lặp cho hội viên.
  const id = randomUUID();
  const phone = nextPhone();
  // Bước 2: Chèn bản ghi vào bảng users với role 'member' và đánh dấu đồng ý chính sách dữ liệu cá nhân (pii_consent_at).
  await db.query(
    `insert into users (id, phone, full_name, name_normalized, role, password_hash, pii_consent_at)
     values ($1, $2, $3, $4, 'member', 'hash', now())`,
    [id, phone, name, name.toLowerCase()],
  );
  return { id, role: "member", full_name: name } as any;
}

/**
 * Làm gì: Tạo mới một sân cầu lông với trạng thái 'ready' trong database để thực hiện kiểm thử đặt sân.
 * Được gọi ở: flows.test.ts (các ca kiểm thử MF-01, MF-01b, EF-01a..d).
 * @param tag Ký tự định danh để tạo mã court_code không trùng lặp.
 * @returns Mã UUID của sân vừa được tạo.
 */
async function seedCourt(tag: string): Promise<string> {
  // Bước 1: Sinh UUID và chèn bản ghi sân cầu lông mới vào bảng courts với trạng thái 'ready'.
  const id = randomUUID();
  await db.query(
    `insert into courts (id, court_code, sport, status) values ($1, $2, 'badminton', 'ready')`,
    [id, "C" + tag + String(++seq)],
  );
  return id;
}

/** The receptionist has at most one open shift (one_open_shift), so reuse it when present. */
async function openShift(): Promise<string> {
  // Bước 1: Kiểm tra xem lễ tân đã có ca thu ngân nào đang mở (closed_at is null) hay chưa.
  const existing = await db.query<{ id: string }>(
    "select id from cashier_shifts where receptionist_id = $1 and closed_at is null",
    [RECEPTIONIST.id],
  );
  // Tái sử dụng ca đang mở vì ràng buộc hệ thống (one_open_shift) chỉ cho phép mỗi lễ tân có tối đa 1 ca mở.
  if (existing.rows[0]) return existing.rows[0].id;
  // Bước 2: Nếu chưa có ca mở, tạo mới một ca thu ngân trong bảng cashier_shifts cho lễ tân.
  const r = await db.query<{ id: string }>(
    "insert into cashier_shifts (receptionist_id) values ($1) returning id",
    [RECEPTIONIST.id],
  );
  return r.rows[0].id;
}

/**
 * Làm gì: Tạo lớp học cầu lông mẫu với lịch định kỳ hàng tuần trong bảng classes để kiểm thử đăng ký lớp.
 * Được gọi ở: flows.test.ts (các ca kiểm thử lớp học MF-02, EF-02).
 * @param opts Cấu hình lớp: capacity (sức chứa), price (học phí VNĐ), courtId (sân gắn kèm), startOn/endOn (ngày bắt đầu/kết thúc).
 * @returns Mã UUID của lớp học vừa tạo.
 */
async function insertClass(opts: {
  capacity: number;
  price: number;
  startOn?: string;
  endOn?: string;
  courtId: string;
}): Promise<string> {
  // Bước 1: Sinh UUID và chèn lớp học với quy tắc rrule lặp hàng tuần vào thứ Ba lúc 14:00, thời lượng 60 phút.
  const id = randomUUID();
  await db.query(
    `insert into classes (id, sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count, price_vnd)
     values ($1, 'badminton', 'flow-test', $2, $3, 'FREQ=WEEKLY;BYDAY=TU;BYHOUR=14', $4::date, $5::date, 60, $6, 'open', 0, $7)`,
    [id, COACH_ID, opts.courtId, opts.startOn ?? ictDay(2), opts.endOn ?? ictDay(30), opts.capacity, opts.price],
  );
  return id;
}

/** Member places a hold on a court slot (09:00 local by default). Returns the hold response. */
async function holdSlot(member: any, courtId: string, day = FUTURE(), hhmm = "09:00") {
  return withTx((sql) =>
    bookingsHold(sql, jsonReq({ court_id: courtId, start_at: `${day}T${hhmm}:00+07:00` }), member),
  );
}

/**
 * Làm gì: Truy vấn trực tiếp bản ghi đặt sân từ bảng court_bookings theo ID để kiểm tra dữ liệu sau xử lý.
 * Được gọi ở: flows.test.ts (MF-01, MF-01b, EF-01b).
 * @param id Mã UUID của đơn đặt sân cần tra cứu.
 * @returns Dòng bản ghi đơn đặt sân trong database hoặc undefined nếu không tìm thấy.
 */
async function bookingRow(id: string): Promise<any> {
  return (await db.query<any>("select * from court_bookings where id = $1", [id])).rows[0];
}

/**
 * Làm gì: Hàm trợ giúp kiểm tra Promise bị reject với đúng mã HTTP status và chạy callback xác minh thuộc tính lỗi.
 * Được gọi ở: flows.test.ts (các ca kiểm thử ngoại lệ EF-01a, EF-01b, EF-01c, EF-01e).
 * @param p Hàm async dự kiến sẽ ném ra ngoại lệ HTTP.
 * @param status Mã HTTP status mong đợi (ví dụ: 403, 404, 409, 422).
 * @param check Callback tùy chọn để kiểm tra chi tiết lỗi (mã code, field vi phạm).
 * @throws Thất bại assertion nếu Promise không reject hoặc mã status không khớp.
 */
async function expectRejects(p: () => Promise<unknown>, status: number, check?: (e: any) => void) {
  await assert.rejects(p, (e: any) => {
    assert.equal(e.status, status, `expected HTTP ${status}, got ${e.status}: ${e.message}`);
    check?.(e);
    return true;
  });
}

/** Seed a court booking directly (for gate, cancel and report flows). */
async function seedConfirmedBooking(opts: {
  userId: string;
  courtId: string;
  startAt: string;
  paidVnd?: number;
  quotaHours?: number;
  status?: string;
}): Promise<string> {
  // Bước 1: Sinh UUID đơn đặt sân và tính thời điểm kết thúc ca chơi (cộng thêm 1 giờ = 3600_000 ms).
  const bookingId = randomUUID();
  const endAt = new Date(new Date(opts.startAt).getTime() + 3600_000).toISOString();
  // booking_occ_sync: a cancelled booking holds no occupancy; a live one must hold it.
  const live = (opts.status ?? "confirmed") !== "cancelled";
  // Bước 2: Tạo bản ghi chiếm chỗ trong occupancies nếu đơn đặt sân có trạng thái hoạt động (khác 'cancelled').
  const occId = live
    ? (
        await db.query<{ id: string }>(
          `insert into occupancies (id, court_id, start_at, end_at, kind, ref_id)
           values (gen_random_uuid(), $1, $2, $3, 'booking', $4) returning id`,
          [opts.courtId, opts.startAt, endAt, bookingId],
        )
      ).rows[0].id
    : null;
  // Bước 3: Chèn bản ghi vào bảng court_bookings với mã code BK... và liên kết tới occupancy_id vừa tạo.
  await db.query(
    `insert into court_bookings (id, court_id, user_id, start_at, end_at, status, price_vnd, deposit_vnd, paid_vnd, code, channel, occupancy_id)
     values ($1, $2, $3, $4, $5, $6, 100000, 0, $7, $8, 'app', $9)`,
    [
      bookingId,
      opts.courtId,
      opts.userId,
      opts.startAt,
      endAt,
      opts.status ?? "confirmed",
      opts.paidVnd ?? 0,
      "BK" + bookingId.slice(0, 8).toUpperCase(),
      occId,
    ],
  );
  // Bước 4: Cập nhật số giờ quota (quota_hours) nếu đơn đặt sân thanh toán bằng gói tập.
  if (opts.quotaHours) {
    await db.query("update court_bookings set quota_hours = $2 where id = $1", [bookingId, opts.quotaHours]);
  }
  return bookingId;
}

// =====================================================================
// MF-01: Member books a court and pays the full slot price
// =====================================================================
describe("MF-01 Member books a court and pays the full slot price", () => {
  /**
   * Làm gì: Kiểm thử luồng MF-01: Hội viên giữ chỗ -> gửi yêu cầu chuyển khoản -> lễ tân xác nhận; số tiền thanh toán ghi nhận bằng đúng giá slot sân.
   * Được gọi ở: test runner (node --test).
   */
  it("MF-01: hold -> transfer request -> desk confirms; the posted payment equals the slot price", async () => {
    // Bước 1: Tạo dữ liệu giả lập (hội viên, sân) và gọi API bookingsHold để giữ chỗ (hold) khung giờ chơi.
    const m = await seedMember("MF01 Member");
    const court = await seedCourt("MF01");
    const hold = await holdSlot(m, court);
    assert.equal(hold.status, 201);
    const booking = (hold.body as any).booking;
    const price = (hold.body as any).price;
    assert.equal(booking.status, "hold");
    assert.ok(price > 0, "slot price should be positive");

    // Bước 2: Hội viên gửi yêu cầu xác nhận đặt sân với phương thức chuyển khoản (transfer) -> trả về 202 chờ lễ tân duyệt.
    const confirm = await withTx((sql) => bookingsConfirm(sql, booking.id, jsonReq({ method: "transfer" }), m));
    assert.equal(confirm.status, 202);
    assert.equal((confirm.body as any).awaiting_transfer, true);

    // Bước 3: Lễ tân đối soát ngân hàng và xác nhận đơn chuyển khoản thành công (bookingsTransferConfirm) -> trả về 200.
    const settled = await withTx((sql) => bookingsTransferConfirm(sql, booking.id, RECEPTIONIST));
    assert.equal(settled.status, 200);

    // Bước 4: Kiểm tra trạng thái đơn chuyển sang 'confirmed', tạo đúng 1 bản ghi payment 'posted' với số tiền khớp đúng giá phải thu.
    const row = await bookingRow(booking.id);
    assert.equal(row.status, "confirmed");
    const pays = (await db.query<any>(
      "select amount_vnd, status from payments where ref_type = 'booking' and ref_id = $1",
      [booking.id],
    )).rows;
    assert.equal(pays.length, 1, "exactly one payment row");
    assert.equal(pays[0].status, "posted");
    // Default settings: the slot's own terms decide (deposit if valid, else full).
    const deposit = Number(row.deposit_vnd);
    const expectedDue = deposit > 0 && deposit < price ? deposit : price;
    assert.equal(Number(pays[0].amount_vnd), expectedDue);
    assert.equal(Number(row.paid_vnd), expectedDue);
  });

  /**
   * Làm gì: Kiểm thử chính sách cọc MF-01b: Khi cọc 30%, số tiền thu ban đầu nhỏ hơn giá sân và để lại công nợ; khi cọc 0%, thu đủ 100% giá sân.
   * Được gọi ở: test runner (node --test).
   */
  it("MF-01b: controlled settings - a 30% deposit collects less than the price and leaves a balance; 0% collects the full price", async () => {
    // Lưu lại cấu hình cọc gốc của trung tâm trong center_settings để hoàn trả sau khi test xong trong khối finally.
    const saved = (await db.query<any>("select deposit_pct, deposit_peak_only from center_settings where id = 1")).rows[0];
    try {
      /**
       * Làm gì: Hàm trợ giúp cập nhật tỷ lệ cọc và thực hiện toàn bộ chu trình đặt sân để đo lường số tiền thực thu.
       * Được gọi ở: flows.test.ts (MF-01b).
       * @param pct Tỷ lệ phần trăm tiền cọc cần áp dụng (30 hoặc 0).
       * @param tag Nhãn phân biệt dữ liệu test.
       * @returns Object chứa price (giá sân), row (bản ghi booking) và paid (số tiền đã thanh toán).
       */
      const run = async (pct: number, tag: string) => {
        // Bước 1: Cập nhật tỷ lệ cọc trong center_settings áp dụng cho mọi khung giờ (deposit_peak_only = false).
        await db.query("update center_settings set deposit_pct = $1, deposit_peak_only = false where id = 1", [pct]);
        // Bước 2: Tạo hội viên, sân và thực hiện giữ chỗ (hold).
        const m = await seedMember("MF01b " + tag);
        const court = await seedCourt("D" + tag[0]);
        const hold = await holdSlot(m, court);
        assert.equal(hold.status, 201);
        const id = (hold.body as any).booking.id;
        const price = Number((hold.body as any).price);
        // Bước 3: Hội viên gửi yêu cầu chuyển khoản và lễ tân xác nhận thanh toán.
        await withTx((sql) => bookingsConfirm(sql, id, jsonReq({ method: "transfer" }), m));
        await withTx((sql) => bookingsTransferConfirm(sql, id, RECEPTIONIST));
        // Bước 4: Lấy thông tin booking và thanh toán đã ghi nhận để đối soát.
        const row = await bookingRow(id);
        const pays = (await db.query<any>(
          "select amount_vnd from payments where ref_type = 'booking' and ref_id = $1 and status = 'posted'", [id],
        )).rows;
        assert.equal(pays.length, 1);
        return { price, row, paid: Number(pays[0].amount_vnd) };
      };
      // Bước 1: Kiểm thử trường hợp đặt cọc 30% - số tiền thu phải xấp xỉ 30% và để lại công nợ (balance) cho quầy thu tiếp.
      const dep = await run(30, "dep");
      assert.equal(dep.row.status, "confirmed");
      assert.ok(dep.paid > 0 && dep.paid < dep.price, `deposit ${dep.paid} must be between 0 and price ${dep.price}`);
      // 30% of the price within one rounding step (not a copy of depositFor).
      assert.ok(Math.abs(dep.paid - dep.price * 0.3) <= dep.price * 0.05, "deposit is about 30% of the price");
      assert.equal(Number(dep.row.deposit_vnd), dep.paid);
      assert.equal(Number(dep.row.paid_vnd), dep.paid);
      assert.ok(Number(dep.row.price_vnd) - Number(dep.row.paid_vnd) > 0, "a balance is left for the desk");

      // Bước 2: Kiểm thử trường hợp không đặt cọc (0%) - hệ thống phải thu đủ 100% giá slot sân ngay lúc xác nhận.
      const full = await run(0, "full");
      assert.equal(Number(full.row.deposit_vnd), 0);
      assert.equal(full.paid, full.price, "no deposit -> full price collected");
      assert.equal(Number(full.row.paid_vnd), full.price);
    } finally {
      await db.query("update center_settings set deposit_pct = $1, deposit_peak_only = $2 where id = 1", [saved.deposit_pct, saved.deposit_peak_only]);
    }
  });

  /**
   * Làm gì: Kiểm thử ngoại lệ EF-01a: Chặn hội viên thứ hai giữ chỗ trên slot đã có người giữ trước (lỗi 409 CONFLICT_SLOT).
   * Được gọi ở: test runner (node --test).
   */
  it("EF-01a: a second member cannot hold a slot that is already held (409 CONFLICT_SLOT)", async () => {
    // Bước 1: Hội viên 1 thực hiện giữ chỗ thành công một khung giờ trên sân.
    const m1 = await seedMember("EF01a Holder");
    const m2 = await seedMember("EF01a Latecomer");
    const court = await seedCourt("EF01a");
    await holdSlot(m1, court);
    // Bước 2: Hội viên 2 cố gắng giữ chỗ cùng khung giờ đó -> hệ thống phải chặn bằng lỗi 409 CONFLICT_SLOT.
    await expectRejects(() => holdSlot(m2, court), 409, (e) => assert.equal(e.code, "CONFLICT_SLOT"));
  });

  /**
   * Làm gì: Kiểm thử ngoại lệ EF-01b: Từ chối xác nhận đặt sân bằng phương thức 'quota' khi không đủ điều kiện (lỗi 422) và giữ nguyên trạng thái 'hold'.
   * Được gọi ở: test runner (node --test).
   */
  it("EF-01b: method quota is refused with 422 and the hold stays on hold", async () => {
    // Bước 1: Hội viên giữ chỗ sân thành công.
    const m = await seedMember("EF01b Member");
    const court = await seedCourt("EF01b");
    const hold = await holdSlot(m, court);
    const id = (hold.body as any).booking.id;
    // Bước 2: Hội viên xác nhận với method 'quota' -> hệ thống từ chối với lỗi 422 ở trường method và giữ nguyên trạng thái 'hold'.
    await expectRejects(
      () => withTx((sql) => bookingsConfirm(sql, id, jsonReq({ method: "quota" }), m)),
      422,
      (e) => assert.equal(e.extra.field, "method"),
    );
    assert.equal((await bookingRow(id)).status, "hold");
  });

  /**
   * Làm gì: Kiểm thử ngoại lệ EF-01c: Chặn hội viên khác can thiệp xác nhận đơn giữ chỗ của chủ đơn (lỗi 403 Forbidden).
   * Được gọi ở: test runner (node --test).
   */
  it("EF-01c: a member cannot confirm another member's hold (403)", async () => {
    // Bước 1: Chủ sở hữu (owner) giữ chỗ sân thành công.
    const owner = await seedMember("EF01c Owner");
    const intruder = await seedMember("EF01c Intruder");
    const court = await seedCourt("EF01c");
    const hold = await holdSlot(owner, court);
    const id = (hold.body as any).booking.id;
    // Bước 2: Người khác (intruder) cố xác nhận đơn giữ chỗ đó -> hệ thống phải chặn bằng lỗi 403 Forbidden.
    await expectRejects(
      () => withTx((sql) => bookingsConfirm(sql, id, jsonReq({ method: "transfer" }), intruder)),
      403,
    );
  });

  /**
   * Làm gì: Kiểm thử ngoại lệ EF-01d: Từ chối yêu cầu giữ chỗ cho thời điểm trong quá khứ (lỗi 4xx) và xác nhận không có bản ghi nào được tạo trong DB.
   * Được gọi ở: test runner (node --test).
   */
  it("EF-01d: a booking whose start is in the past is refused (4xx, no booking created)", async () => {
    // Bước 1: Gửi yêu cầu giữ chỗ với thời điểm bắt đầu nằm trong quá khứ -> hệ thống phải trả về lỗi 4xx.
    const m = await seedMember("EF01d Member");
    const court = await seedCourt("EF01d");
    await assert.rejects(() => holdSlot(m, court, PAST()), (e: any) => {
      assert.ok(e.status >= 400 && e.status < 500, `expected 4xx, got ${e.status}`);
      return true;
    });
    // Bước 2: Kiểm tra bảng court_bookings để bảo đảm không có bản ghi rác nào được tạo ra.
    const n = (await db.query<{ n: number }>("select count(*)::int as n from court_bookings where user_id = $1", [m.id])).rows[0].n;
    assert.equal(n, 0);
  });

  /**
   * Làm gì: Kiểm thử ngoại lệ EF-01e: Từ chối yêu cầu giữ chỗ khi mã sân court_id không tồn tại trong hệ thống (lỗi 404 Not Found).
   * Được gọi ở: test runner (node --test).
   */
  it("EF-01e: a court id that does not exist is refused with 404", async () => {
    // Gửi yêu cầu giữ chỗ với UUID sân ngẫu nhiên không tồn tại -> hệ thống phải ném lỗi 404 Not Found.
    const m = await seedMember("EF01e Member");
    await expectRejects(() => holdSlot(m, randomUUID()), 404);
  });
});

// =====================================================================
// MF-02: Member enrols in a class and pays the class price
// =====================================================================
/**
 * Làm gì: Nhóm các ca kiểm thử cho luồng MF-02: Hội viên đăng ký lớp học và thanh toán học phí tại quầy lễ tân.
 * Được gọi ở: test runner (node --test)
 */
describe("MF-02 Member enrols in a class and pays the class price", () => {
  /**
   * Làm gì: Kiểm tra luồng chính MF-02: Đăng ký lớp học giữ chỗ (hold) -> lễ tân thu đúng học phí -> chỗ học được xác nhận (confirmed).
   * Được gọi ở: test runner (node --test)
   */
  it("MF-02: enrol (hold) -> desk takes the class price -> seat confirmed", async () => {
    // Bước 1: Chuẩn bị dữ liệu mẫu gồm sân thể thao, lớp học sức chứa 5 học viên giá 300.000 VNĐ, và tài khoản hội viên
    const court = await seedCourt("MF02");
    const cls = await insertClass({ capacity: 5, price: 300000, courtId: court });
    const m = await seedMember("MF02 Member");
    // Bước 2: Hội viên đăng ký lớp học qua classesEnroll; tạo đơn giữ chỗ ban đầu ở trạng thái hold (HTTP 201)
    const enr = await withTx((sql) => classesEnroll(sql, cls, new Request("http://localhost"), m));
    assert.equal(enr.status, 201);
    const enrollment = (enr.body as any).enrollment;
    assert.equal(enrollment.status, "hold");

    // Bước 3: Lễ tân mở ca thu ngân và lập phiếu thu tiền mặt đúng 300.000 VNĐ cho đơn đăng ký lớp học
    const shift = await openShift();
    const pay = await withTx((sql) =>
      paymentsCreate(sql, jsonReq({ ref_type: "enrollment", ref_id: enrollment.id, method: "cash", amount_vnd: 300000, shift_id: shift }), RECEPTIONIST),
    );
    assert.equal(pay.status, 201);
    // Bước 4: Kiểm tra trạng thái enrollment chuyển sang confirmed và sĩ số enrolled_count của lớp tăng lên 1
    const row = (await db.query<any>("select status from enrollments where id = $1", [enrollment.id])).rows[0];
    assert.equal(row.status, "confirmed");
    const cnt = (await db.query<any>("select enrolled_count from classes where id = $1", [cls])).rows[0];
    assert.equal(cnt.enrolled_count, 1);
  });

  /**
   * Làm gì: Kiểm tra nhánh ngoại lệ EF-02a: Khi lớp học đã đầy sĩ số, hội viên đăng ký tiếp theo sẽ được chuyển vào danh sách chờ (waitlist).
   * Được gọi ở: test runner (node --test)
   */
  it("EF-02a: a full class seats the member on the waitlist (201, waitlisted: true)", async () => {
    // Bước 1: Tạo một lớp học với sức chứa giới hạn chỉ 1 học viên, cùng 2 tài khoản hội viên
    const court = await seedCourt("EF02a");
    const cls = await insertClass({ capacity: 1, price: 300000, courtId: court });
    const first = await seedMember("EF02a First");
    const second = await seedMember("EF02a Second");
    // Bước 2: Hội viên thứ nhất đăng ký lớp học thành công và chiếm suất duy nhất
    await withTx((sql) => classesEnroll(sql, cls, new Request("http://localhost"), first));
    // Bước 3: Hội viên thứ hai đăng ký vào cùng lớp; vì lớp đã đầy nên hệ thống chuyển vào danh sách chờ (waitlisted = true)
    const res = await withTx((sql) => classesEnroll(sql, cls, new Request("http://localhost"), second));
    assert.equal(res.status, 201);
    assert.equal((res.body as any).waitlisted, true);
    assert.equal((res.body as any).enrollment.status, "waitlisted");
  });

  /**
   * Làm gì: Kiểm tra nhánh ngoại lệ EF-02b: Hội viên đăng ký 2 lần vào cùng một lớp học sẽ bị từ chối với mã lỗi 422 và vi phạm quy tắc BR-22.
   * Được gọi ở: test runner (node --test)
   */
  it("EF-02b: enrolling twice in the same class is refused (422 BR-22)", async () => {
    // Bước 1: Khởi tạo lớp học và hội viên, thực hiện đăng ký lần đầu tiên thành công
    const court = await seedCourt("EF02b");
    const cls = await insertClass({ capacity: 5, price: 300000, courtId: court });
    const m = await seedMember("EF02b Member");
    await withTx((sql) => classesEnroll(sql, cls, new Request("http://localhost"), m));
    // Bước 2: Cố gắng đăng ký lần thứ hai cho cùng hội viên vào lớp; hệ thống phải chặn lại với HTTP 422 và mã lỗi BR-22
    await expectRejects(
      () => withTx((sql) => classesEnroll(sql, cls, new Request("http://localhost"), m)),
      422,
      (e) => assert.equal(e.extra.br, "BR-22"),
    );
  });

  /**
   * Làm gì: Kiểm tra nhánh ngoại lệ EF-02c: Lễ tân thu sai số tiền học phí sẽ bị từ chối với mã lỗi 400 (lỗi trường amount_vnd) và chỗ ngồi vẫn giữ nguyên trạng thái hold.
   * Được gọi ở: test runner (node --test)
   */
  it("EF-02c: a payment for a wrong class amount is refused (400, field amount_vnd) and the seat stays on hold", async () => {
    // Bước 1: Khởi tạo lớp học giá 300.000 VNĐ và hội viên đăng ký giữ chỗ (enrollment trạng thái hold)
    const court = await seedCourt("EF02c");
    const cls = await insertClass({ capacity: 5, price: 300000, courtId: court });
    const m = await seedMember("EF02c Member");
    const enr = await withTx((sql) => classesEnroll(sql, cls, new Request("http://localhost"), m));
    const enrId = (enr.body as any).enrollment.id;
    // Bước 2: Lễ tân mở ca thu ngân và cố tình thanh toán sai số tiền (250.000 VNĐ thay vì 300.000 VNĐ)
    const shift = await openShift();
    // Hệ thống từ chối thanh toán với HTTP 400 và chỉ rõ lỗi ở trường amount_vnd
    await expectRejects(
      () =>
        withTx((sql) =>
          paymentsCreate(sql, jsonReq({ ref_type: "enrollment", ref_id: enrId, method: "cash", amount_vnd: 250000, shift_id: shift }), RECEPTIONIST),
        ),
      400,
      (e) => assert.equal(e.extra.field, "amount_vnd"),
    );
    // Bước 3: Kiểm tra trạng thái enrollment trong DB vẫn giữ nguyên là hold, không bị xác nhận do số tiền thanh toán không khớp
    const row = (await db.query<any>("select status from enrollments where id = $1", [enrId])).rows[0];
    assert.equal(row.status, "hold");
  });
});

// =====================================================================
// MF-03: Desk records a payment for a booking or an enrolment
// =====================================================================
/**
 * Làm gì: Nhóm các ca kiểm thử cho luồng MF-03: Nhân viên quầy lễ tân lập phiếu thu thanh toán (paymentsCreate) cho đặt sân, lớp học hoặc gói tập.
 * Được gọi ở: test runner (node --test)
 */
describe("MF-03 Desk records a payment (paymentsCreate)", () => {
  /**
   * Làm gì: Kiểm tra luồng chính MF-03: Lễ tân có ca mở ghi nhận tiền mặt cho đơn đặt sân giữ chỗ thành công (HTTP 201, payment posted, tự động xuất hóa đơn).
   * Được gọi ở: test runner (node --test)
   */
  it("MF-03: receptionist with an open shift records cash for a held booking (201, posted, invoice issued)", async () => {
    // Bước 1: Khởi tạo hội viên, sân thể thao và giữ chỗ một ô giờ (booking trạng thái hold)
    const m = await seedMember("MF03 Member");
    const court = await seedCourt("MF03");
    const hold = await holdSlot(m, court);
    const booking = (hold.body as any).booking;
    const price = (hold.body as any).price;
    // Bước 2: Lễ tân mở ca thu ngân và lập phiếu thu tiền mặt bằng đúng số tiền giá sân
    const shift = await openShift();
    const res = await withTx((sql) =>
      paymentsCreate(sql, jsonReq({ ref_type: "booking", ref_id: booking.id, method: "cash", amount_vnd: price, shift_id: shift }), RECEPTIONIST),
    );
    // Bước 3: Xác nhận thanh toán thành công (HTTP 201), giao dịch ở trạng thái posted, phương thức cash và có hóa đơn kèm theo
    assert.equal(res.status, 201);
    assert.equal((res.body as any).payment.status, "posted");
    assert.equal((res.body as any).payment.method, "cash");
    assert.ok((res.body as any).invoice?.id, "an invoice is issued");
  });

  /**
   * Làm gì: Kiểm tra nhánh ngoại lệ EF-03a: paymentsCreate chấp nhận ref_type subscription; nếu ID gói không tồn tại thì lỗi không thuộc về trường ref_type.
   * Được gọi ở: test runner (node --test)
   */
  it("EF-03a: ref_type subscription is accepted again; an unknown plan is refused, not the ref_type", async () => {
    // Bước 1: Lễ tân mở ca làm việc để thực hiện thu ngân
    const shift = await openShift();
    // Bước 2: Gửi yêu cầu thanh toán với ref_type là subscription nhưng truyền UUID gói không tồn tại; xác nhận lỗi không bắt nguồn từ ref_type
    await assert.rejects(
      () =>
        withTx((sql) =>
          paymentsCreate(sql, jsonReq({ ref_type: "subscription", ref_id: randomUUID(), method: "cash", amount_vnd: 100000, shift_id: shift }), RECEPTIONIST),
        ),
      (e: any) => {
        assert.notEqual(e.extra?.field, "ref_type");
        return true;
      },
    );
  });

  /**
   * Làm gì: Kiểm tra nhánh ngoại lệ EF-03b: Hội viên thường không có quyền tự ghi nhận thanh toán tại quầy lễ tân (bị từ chối với HTTP 403 Forbidden).
   * Được gọi ở: test runner (node --test)
   */
  it("EF-03b: a member cannot record a desk payment (403)", async () => {
    // Bước 1: Tạo tài khoản người dùng với vai trò member
    const m = await seedMember("EF03b Member");
    // Bước 2: Hội viên gửi request gọi paymentsCreate; hệ thống kiểm tra phân quyền (RBAC) và từ chối với HTTP 403
    await expectRejects(
      () =>
        withTx((sql) =>
          paymentsCreate(sql, jsonReq({ ref_type: "booking", ref_id: randomUUID(), method: "cash", amount_vnd: 100000 }), m),
        ),
      403,
    );
  });
});

// =====================================================================
// MF-04: Gate check-in admits a member with a booking today
// =====================================================================
/**
 * Làm gì: Nhóm các ca kiểm thử cho luồng MF-04: Cổng soát vé (gateCheckin) kiểm tra quyền ra vào và cho phép hội viên có lịch hoạt động hôm nay vào sân.
 * Được gọi ở: test runner (node --test)
 */
describe("MF-04 Gate check-in admits a member with activity today", () => {
  /**
   * Làm gì: Kiểm tra luồng chính MF-04: Hội viên có lịch đặt sân đã xác nhận (confirmed) trong ngày hôm nay sẽ được cổng tự động cho phép vào (allowed = true).
   * Được gọi ở: test runner (node --test)
   */
  it("MF-04: a member with a confirmed booking today is entitled and admitted", async () => {
    // Bước 1: Khởi tạo hội viên và lịch đặt sân confirmed diễn ra vào 10:00 sáng hôm nay (TODAY)
    const m = await seedMember("MF04 Member");
    const court = await seedCourt("MF04");
    await seedConfirmedBooking({ userId: m.id, courtId: court, startAt: `${TODAY()}T10:00:00+07:00` });
    // Bước 2: Lễ tân thực hiện quét cổng check-in cho hội viên (với lý do quên thẻ/forgot)
    const res = await withTx((sql) => gateCheckin(sql, jsonReq({ member_id: m.id, reason: "forgot" }), RECEPTIONIST));
    // Bước 3: Xác nhận hội viên được phép vào cổng (allowed = true), không cần duyệt đè (needs_override = false) và ghi nhận đúng 1 booking hôm nay
    const body = res.body as any;
    assert.equal(body.allowed, true);
    assert.equal(body.needs_override, false);
    assert.equal(body.today.bookings.length, 1);
  });

  /**
   * Làm gì: Kiểm tra nhánh ngoại lệ EF-04a: Hội viên không có bất kỳ lịch đặt sân nào hôm nay sẽ bị từ chối vào cổng và phải chờ lễ tân duyệt thủ công (needs_override = true).
   * Được gọi ở: test runner (node --test)
   */
  it("EF-04a: a member with nothing booked today is not entitled (needs override)", async () => {
    // Bước 1: Khởi tạo tài khoản hội viên nhưng không tạo bất kỳ lịch đặt sân hay lớp học nào trong ngày
    const m = await seedMember("EF04a Member");
    // Bước 2: Quét check-in qua cổng; xác nhận bị từ chối tự động (allowed = false) và hệ thống yêu cầu quyền override từ lễ tân
    const res = await withTx((sql) => gateCheckin(sql, jsonReq({ member_id: m.id, reason: "forgot" }), RECEPTIONIST));
    assert.equal((res.body as any).allowed, false);
    assert.equal((res.body as any).needs_override, true);
  });

  /**
   * Làm gì: Kiểm tra nhánh ngoại lệ EF-04b: Lịch đặt sân của ngày hôm qua (PAST) không có giá trị để hội viên check-in vào sân ngày hôm nay.
   * Được gọi ở: test runner (node --test)
   */
  it("EF-04b: a booking that was yesterday does not admit the member today", async () => {
    // Bước 1: Tạo lịch đặt sân confirmed cho hội viên nhưng vào ngày hôm qua (PAST)
    const m = await seedMember("EF04b Member");
    const court = await seedCourt("EF04b");
    await seedConfirmedBooking({ userId: m.id, courtId: court, startAt: `${PAST()}T10:00:00+07:00` });
    // Bước 2: Thực hiện check-in cho ngày hôm nay; xác nhận hệ thống từ chối (allowed = false) và danh sách booking hôm nay rỗng
    const res = await withTx((sql) => gateCheckin(sql, jsonReq({ member_id: m.id, reason: "forgot" }), RECEPTIONIST));
    assert.equal((res.body as any).allowed, false);
    assert.equal((res.body as any).today.bookings.length, 0);
  });
});

// =====================================================================
// MF-05: Cancel a booking or an enrolment under the cancel rules
// =====================================================================
/**
 * Làm gì: Nhóm các ca kiểm thử cho luồng MF-05: Hủy lịch đặt sân hoặc đăng ký lớp học theo chính sách hủy và hoàn tiền.
 * Được gọi ở: test runner (node --test)
 */
describe("MF-05 Cancel a booking or enrolment", () => {
  /**
   * Làm gì: Kiểm tra luồng chính MF-05a: Hội viên hủy lịch đặt sân đã xác nhận và đã thanh toán của mình -> HTTP 200, trạng thái chuyển cancelled và tạo giao dịch hoàn tiền.
   * Được gọi ở: test runner (node --test)
   */
  it("MF-05a: member cancels own confirmed, paid booking -> 200, booking cancelled, refund row matches the quote", async () => {
    // Bước 1: Tạo lịch đặt sân confirmed đã thanh toán 100.000 VNĐ bắt đầu sau 20 ngày (ictDay(20))
    const m = await seedMember("MF05a Member");
    const court = await seedCourt("MF05a");
    const id = await seedConfirmedBooking({ userId: m.id, courtId: court, startAt: `${ictDay(20)}T09:00:00+07:00`, paidVnd: 100000 });
    // Bước 2: Hội viên chủ động gửi yêu cầu hủy lịch đặt sân qua bookingsCancel
    const res = await withTx((sql) => bookingsCancel(sql, id, m));
    assert.equal(res.status, 200);
    assert.equal((await bookingRow(id)).status, "cancelled");
    // Bước 3: Xác minh trạng thái booking chuyển thành cancelled và dòng thanh toán hoàn tiền ghi nhận số tiền âm (-refund_vnd)
    const quote = (res.body as any).quote;
    const refunds = (await db.query<any>("select amount_vnd from payments where ref_type = 'booking' and ref_id = $1", [id])).rows;
    if (quote.refund_vnd > 0) {
      assert.equal(refunds.length, 1);
      assert.equal(Number(refunds[0].amount_vnd), -quote.refund_vnd);
    } else {
      assert.equal(refunds.length, 0);
    }
  });

  /**
   * Làm gì: Kiểm tra luồng chính MF-05b: Hội viên hủy đơn giữ chỗ lớp học (enrollment hold) -> HTTP 200, trạng thái chuyển cancelled và sĩ số lớp học giảm về 0.
   * Được gọi ở: test runner (node --test)
   */
  it("MF-05b: member releases own enrolment hold -> 200, enrolment cancelled, class count back down", async () => {
    // Bước 1: Tạo lớp học và hội viên đăng ký giữ chỗ (enrollment trạng thái hold)
    const court = await seedCourt("MF05b");
    const cls = await insertClass({ capacity: 5, price: 300000, courtId: court });
    const m = await seedMember("MF05b Member");
    const enr = await withTx((sql) => classesEnroll(sql, cls, new Request("http://localhost"), m));
    const enrId = (enr.body as any).enrollment.id;
    // Bước 2: Hội viên thực hiện hủy giữ chỗ qua hàm enrollmentDelete
    const res = await withTx((sql) => enrollmentDelete(sql, enrId, m));
    assert.equal(res.status, 200);
    // Bước 3: Xác minh trạng thái enrollment trong DB chuyển sang cancelled và enrolled_count của lớp học giảm về 0
    assert.equal((await db.query<any>("select status from enrollments where id = $1", [enrId])).rows[0].status, "cancelled");
    assert.equal((await db.query<any>("select enrolled_count from classes where id = $1", [cls])).rows[0].enrolled_count, 0);
  });

  /**
   * Làm gì: Kiểm tra nhánh ngoại lệ EF-05a: Hội viên không được phép hủy lịch đặt sân của người khác (bị từ chối với HTTP 403 Forbidden).
   * Được gọi ở: test runner (node --test)
   */
  it("EF-05a: a member cannot cancel another member's booking (403)", async () => {
    // Bước 1: Tạo tài khoản hội viên chủ sở hữu (owner) và hội viên khác (other), cùng lịch đặt sân của owner
    const owner = await seedMember("EF05a Owner");
    const other = await seedMember("EF05a Other");
    const court = await seedCourt("EF05a");
    const id = await seedConfirmedBooking({ userId: owner.id, courtId: court, startAt: `${ictDay(20)}T09:00:00+07:00`, paidVnd: 100000 });
    // Bước 2: Hội viên other cố tình gửi yêu cầu hủy lịch của owner; hệ thống phải chặn lại với HTTP 403
    await expectRejects(() => withTx((sql) => bookingsCancel(sql, id, other)), 403);
    // Đảm bảo trạng thái lịch đặt sân trong cơ sở dữ liệu vẫn được bảo toàn là confirmed
    assert.equal((await bookingRow(id)).status, "confirmed");
  });

  /**
   * Làm gì: Kiểm tra nhánh ngoại lệ EF-05b: Lịch đặt sân bằng hạn mức gói tập (quota booking) khi hủy sẽ không hoàn tiền và không tạo bản ghi thanh toán.
   * Được gọi ở: test runner (node --test)
   */
  it("EF-05b: an old quota booking cancels with no refund and writes no payment row", async () => {
    // Bước 1: Tạo lịch đặt sân sử dụng hạn mức giờ của gói tập (paidVnd = 0, quotaHours = 1)
    const m = await seedMember("EF05b Member");
    const court = await seedCourt("EF05b");
    const id = await seedConfirmedBooking({ userId: m.id, courtId: court, startAt: `${ictDay(20)}T09:00:00+07:00`, paidVnd: 0, quotaHours: 1 });
    // Bước 2: Hội viên thực hiện hủy lịch đặt sân
    const res = await withTx((sql) => bookingsCancel(sql, id, m));
    // Bước 3: Xác nhận phản hồi thành công (HTTP 200), không có tiền hoàn (refund: null) và không phát sinh bản ghi trong payments
    assert.equal(res.status, 200);
    assert.equal((res.body as any).refund, null);
    const n = (await db.query<{ n: number }>("select count(*)::int as n from payments where ref_id = $1", [id])).rows[0].n;
    assert.equal(n, 0);
  });

  /**
   * Làm gì: Kiểm tra nhánh ngoại lệ EF-05c: Cố gắng hủy một lịch đặt sân đã bị hủy trước đó sẽ bị từ chối với HTTP 409 Conflict.
   * Được gọi ở: test runner (node --test)
   */
  it("EF-05c: cancelling a booking that is already cancelled is refused (409)", async () => {
    // Bước 1: Tạo lịch đặt sân có trạng thái ban đầu đã là cancelled
    const m = await seedMember("EF05c Member");
    const court = await seedCourt("EF05c");
    const id = await seedConfirmedBooking({ userId: m.id, courtId: court, startAt: `${ictDay(20)}T09:00:00+07:00`, status: "cancelled" });
    // Bước 2: Gửi yêu cầu hủy lịch lần thứ hai; hệ thống phải từ chối với HTTP 409 do xung đột trạng thái
    await expectRejects(() => withTx((sql) => bookingsCancel(sql, id, m)), 409);
  });

  /**
   * Làm gì: Kiểm tra nhánh ngoại lệ EF-05e: Lịch đặt sân đã bắt đầu trong quá khứ không được phép hủy và không được hoàn tiền (trả về HTTP 409 Conflict).
   * Được gọi ở: test runner (node --test)
   */
  it("EF-05e: a paid booking that has already started cannot be cancelled, and no refund is written", async () => {
    // Bước 1: Tạo lịch đặt sân đã thanh toán nhưng giờ bắt đầu nằm trong quá khứ (PAST)
    const m = await seedMember("EF05e Member");
    const court = await seedCourt("EF05e");
    const id = await seedConfirmedBooking({ userId: m.id, courtId: court, startAt: `${PAST()}T10:00:00+07:00`, paidVnd: 100000 });
    // Bước 2: Cố gắng gửi lệnh hủy; hệ thống từ chối với HTTP 409 vì vi phạm quy định cấm hủy lịch đã qua giờ bắt đầu
    await expectRejects(() => withTx((sql) => bookingsCancel(sql, id, m)), 409);
    // Xác nhận trạng thái vẫn là confirmed và bảng payments không phát sinh thêm bản ghi hoàn tiền nào
    assert.equal((await bookingRow(id)).status, "confirmed");
    const n = (await db.query<{ n: number }>("select count(*)::int as n from payments where ref_id = $1", [id])).rows[0].n;
    assert.equal(n, 0);
  });

  /**
   * Làm gì: Kiểm tra nhánh ngoại lệ EF-05d: Hội viên không được phép hủy đơn đăng ký lớp học của người khác (bị từ chối với HTTP 403 Forbidden).
   * Được gọi ở: test runner (node --test)
   */
  it("EF-05d: a member cannot release another member's enrolment (403)", async () => {
    // Bước 1: Tạo lớp học và hội viên owner đăng ký giữ chỗ
    const court = await seedCourt("EF05d");
    const cls = await insertClass({ capacity: 5, price: 300000, courtId: court });
    const owner = await seedMember("EF05d Owner");
    const other = await seedMember("EF05d Other");
    const enr = await withTx((sql) => classesEnroll(sql, cls, new Request("http://localhost"), owner));
    const enrId = (enr.body as any).enrollment.id;
    // Bước 2: Hội viên other gửi yêu cầu xóa enrollment của owner; hệ thống kiểm tra quyền sở hữu và từ chối với HTTP 403
    await expectRejects(() => withTx((sql) => enrollmentDelete(sql, enrId, other)), 403);
  });
});

// =====================================================================
// MF-06: Plan endpoints are back
// =====================================================================
/**
 * Làm gì: Nhóm các ca kiểm thử cho luồng MF-06: Khôi phục hoạt động của các API liên quan đến gói tập (plans) và đăng ký hội viên (subscriptions).
 * Được gọi ở: test runner (node --test)
 */
describe("MF-06 Plan endpoints answer again", () => {
  before(() => {
    // handleApi starts the job loop unless this flag is set; the loop would keep the process alive.
    (globalThis as any).__arena3Jobs__ = true;
  });

  /**
   * Làm gì: Kiểm tra luồng chính MF-06: API GET /v1/plans cho phép xem danh sách gói tập công khai không cần đăng nhập (HTTP 200).
   * Được gọi ở: test runner (node --test)
   */
  it("MF-06: GET /v1/plans lists plans publicly (200)", async () => {
    // Bước 1: Gửi request GET tới /v1/plans mà không kèm bất kỳ thông tin xác thực hay session cookie nào
    const res = await handleApi(new Request("http://localhost/v1/plans", { method: "GET" }));
    // Bước 2: Xác nhận phản hồi thành công (HTTP 200) và dữ liệu trả về chứa mảng items các gói tập
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(((await res.json()) as any).items));
  });

  /**
   * Làm gì: Kiểm tra nhánh ngoại lệ EF-06a: API tạo gói tập POST /v1/plans yêu cầu quyền quản trị, từ chối request không có session bằng mã 401 Unauthorized.
   * Được gọi ở: test runner (node --test)
   */
  it("EF-06a: POST /v1/plans without a session is refused (401), not missing", async () => {
    // Bước 1: Gửi request POST tạo gói tập mới nhưng không truyền thông tin đăng nhập của người quản lý
    const res = await handleApi(
      new Request("http://localhost/v1/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Goi thang", price_vnd: 500000 }),
      }),
    );
    // Bước 2: Xác nhận router nhận diện đúng endpoint và từ chối truy cập bằng mã 401 Unauthorized (thay vì 404)
    assert.equal(res.status, 401);
  });

  /**
   * Làm gì: Kiểm tra nhánh ngoại lệ EF-06b: API đăng ký gói tập POST /v1/subscriptions từ chối request không có session bằng mã 401 Unauthorized.
   * Được gọi ở: test runner (node --test)
   */
  it("EF-06b: POST /v1/subscriptions without a session is refused (401), not missing", async () => {
    // Bước 1: Gửi request POST đăng ký mua gói tập mà không có phiên đăng nhập của hội viên
    const res = await handleApi(
      new Request("http://localhost/v1/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan_id: "00000000-0000-0000-0000-000000000000" }),
      }),
    );
    // Bước 2: Xác nhận router trả về mã 401 Unauthorized do thiếu thông tin phiên làm việc hợp lệ
    assert.equal(res.status, 401);
  });
});

// =====================================================================
// MF-07: Reports count active members from bookings and enrolments
// =====================================================================
/**
 * Làm gì: Nhóm các ca kiểm thử cho luồng MF-07: Báo cáo thống kê tính hội viên tích cực (active members) từ cả lịch đặt sân và đăng ký lớp học.
 * Được gọi ở: test runner (node --test)
 */
describe("MF-07 Reports count active members from bookings and enrolments", () => {
  const FROM = "2099-03-01";
  const TO = "2099-03-31";

  /**
   * Làm gì: Truy vấn báo cáo hội viên trong kỳ FROM - TO và lấy ra số lượng hội viên đang hoạt động (active members).
   * Được gọi ở: src/server/controllers/flows.test.ts (trong các ca kiểm thử của describe MF-07)
   * @returns Số lượng hội viên active tính từ đặt sân và lớp học trong kỳ báo cáo
   */
  async function activeCount(): Promise<number> {
    // Chạy hàm membersReportBody trong transaction để trích xuất số lượng hội viên hoạt động
    const body: any = await withTx((sql) => membersReportBody(sql, FROM, TO, null));
    return body.members.active as number;
  }

  /**
   * Làm gì: Kiểm tra luồng chính MF-07: Cả hội viên có lịch đặt sân và hội viên có suất lớp học confirmed trong kỳ đều được tính vào active members.
   * Được gọi ở: test runner (node --test)
   */
  it("MF-07: a member with a booking in range and a member with a confirmed class seat both count as active", async () => {
    // Bước 1: Đếm số lượng active member hiện tại để làm mốc so sánh (base count)
    const base = await activeCount();
    // Bước 2: Tạo hội viên booker và tạo một lịch đặt sân confirmed vào ngày 10/03/2099 (nằm trong kỳ báo cáo)
    const booker = await seedMember("MF07 Booker");
    const seated = await seedMember("MF07 Seated");
    const courtB = await seedCourt("MF07b");
    await seedConfirmedBooking({ userId: booker.id, courtId: courtB, startAt: "2099-03-10T10:00:00+07:00" });
    // Bước 3: Tạo hội viên seated và ghi nhận một suất lớp học confirmed diễn ra trong kỳ báo cáo (tháng 03/2099)
    const courtC = await seedCourt("MF07c");
    const cls = await insertClass({ capacity: 10, price: 300000, courtId: courtC, startOn: FROM, endOn: TO });
    await withTx((sql) => classesEnroll(sql, cls, new Request("http://localhost"), seated));
    await db.query("update enrollments set status = 'confirmed' where class_id = $1 and user_id = $2", [cls, seated.id]);
    // Bước 4: Kiểm tra báo cáo thống kê; xác nhận số lượng active member tăng thêm đúng 2 người so với ban đầu
    assert.equal(await activeCount(), base + 2);
  });

  /**
   * Làm gì: Kiểm tra nhánh ngoại lệ EF-07a: Hội viên mới tạo tài khoản nhưng không có bất kỳ hoạt động đặt sân hay học lớp nào sẽ không được tính là active.
   * Được gọi ở: test runner (node --test)
   */
  it("EF-07a: a member with no activity is not counted", async () => {
    // Bước 1: Lấy số lượng active member hiện tại làm mốc ban đầu
    const base = await activeCount();
    // Bước 2: Tạo tài khoản hội viên mới nhưng không tạo bất kỳ hoạt động nào
    await seedMember("EF07a Idle");
    // Bước 3: Xác nhận số lượng active member trong báo cáo không đổi
    assert.equal(await activeCount(), base);
  });

  /**
   * Làm gì: Kiểm tra nhánh ngoại lệ EF-07b: Lịch đặt sân nằm ngoài khoảng thời gian báo cáo (tháng 02/2099) sẽ không được tính vào active members của kỳ này.
   * Được gọi ở: test runner (node --test)
   */
  it("EF-07b: a booking outside the report window does not make the member active", async () => {
    // Bước 1: Lấy số lượng active member ban đầu làm mốc chuẩn
    const base = await activeCount();
    // Bước 2: Tạo hội viên và lịch đặt sân vào ngày 10/02/2099 (trước kỳ báo cáo tháng 03/2099)
    const m = await seedMember("EF07b Outside");
    const court = await seedCourt("EF07b");
    await seedConfirmedBooking({ userId: m.id, courtId: court, startAt: "2099-02-10T10:00:00+07:00" });
    // Bước 3: Xác nhận số lượng active member trong kỳ báo cáo tháng 3 không bị tính tăng thêm
    assert.equal(await activeCount(), base);
  });
});
