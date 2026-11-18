/**
 * File: src/server/controllers/tx.test.ts
 * Vai trò: Bộ kiểm thử tích hợp (integration tests) cho toàn bộ hệ thống API backend Arena 3.
 * Kiểm tra các luồng nghiệp vụ thực tế (xác thực OTP, quản lý tài khoản staff, chốt ca thu ngân, bảo trì sân, v.v.)
 * chạy trên cơ sở dữ liệu PGlite (PostgreSQL in-memory) với cơ chế bọc transaction (withTx) tự rollback để cô lập dữ liệu giữa các ca kiểm thử.
 */
import assert from "node:assert/strict";
import { SHORTEST_PLAN_ID } from "../services/membership";
import { describe, it, before, after } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

// Prevent src/server/data/db.ts from running bootstrap in test runner
process.env.DATABASE_URL = "postgres://mock:mock@localhost/mock";
process.env.PGLITE_DATA_DIR = "memory";

import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Register custom loader for .ttf font files required by pdf.ts (via desk.ts)
try {
  register(pathToFileURL("./scripts/tests/agent/ttf-loader.mjs"));
} catch {
  // Ignore if already registered
}

const { KeepWrites, setOverridePglite, withTx } = await import("./tx.ts");
const authH = await import("./handlers/auth.ts");
const { readJson, withIdempotency } = await import("./helpers.ts");
const opsH = await import("./handlers/ops.ts");
const { classesCreate, enrollmentDelete, classesEnroll, sessionReschedule, sessionCancel, classDetail, classRoster, classesPatch, classQuote } = await import("./handlers/classes.ts");
const { bookingGet, bookingsReschedule, walkIn, bookingsHold, bookingsConfirm, bookingsCancel } = await import("./handlers/bookings.ts");
const { shiftClose, paymentsCreate, shiftCurrent, paymentsRefund, paymentsApproveRefund, paymentsRejectRefund, paymentsPayOutRefund } = await import("./handlers/desk.ts");
const { waitlistAccept, inviteWaitlist, sessionAttendancePost } = await import("./handlers/ops.ts");
const { waitlistExpire, notifyClassMinimums, notifyOverdueShifts } = await import("../data/jobs.ts");
const { classesList } = await import("./handlers/classes.ts");
const { classCode } = await import("../../shared/arena3/labels.ts");
const { findUserByLogin, issueSession, authFromRequest, toPublic } = await import("./session.ts");
const { hashPassword, hashOtp } = await import("../services/crypto.ts");
const { csvCell, workOrdersCreate, workOrdersPatch } = await import("./handlers/extras.ts");
const { trainingCreate } = await import("./handlers/training.ts");
const { clearAll: clearLimits, RULES: LIMITS, take: takeLimit } = await import("./ratelimit.ts");
const { onlineCreate } = await import("./handlers/online.ts");
const { handleApi } = await import("./router.ts");
const { setOverridePaymentLinkCreator, setOverridePaymentLinkCanceller } = await import("../integrations/payos.ts");
const chatH = await import("./handlers/chat.ts");
const avatarH = await import("./handlers/avatar.ts");
const { sniffAvatar, meAvatarPut, meAvatarDelete, userAvatarGet } = avatarH;
const membersH = await import("./handlers/members.ts");
const { memberGet, membersDirectory, membersSearch } = membersH;
const { PLAN_PHASES, INTENSITIES } = await import("../services/rules.ts");
const { thinkingOffConfig } = await import("../integrations/gemini.ts");

let db: PGlite;

// Suite G10: Bộ kiểm thử các cơ chế bảo vệ và giới hạn chống lạm dụng endpoint gửi OTP công khai.
describe("G10 public OTP abuse guards", () => {
  /**
   * Làm gì: Kiểm tra các tầng bảo vệ chống lạm dụng endpoint gửi OTP công khai (register và forgot password):
   * bắt buộc xác thực Captcha trước khi query DB, âm thầm nuốt honeypot spam bot, và áp dụng cooldown 60 giây trước khi cho phép gửi lại.
   * Được gọi ở: test runner (node --test)
   * @param t Ngữ cảnh kiểm thử của node:test cung cấp tiện ích mock method
   * @returns Promise<void>
   * @throws AssertionError nếu các điều kiện bảo mật hoặc logic xác thực OTP không thỏa mãn
   */
  it("checks captcha before queries, quietly drops honeypots, and replaces challenges after 60 seconds", async (t) => {
    // Bước 1: Chuẩn bị biến môi trường, bật OTP_ECHO để nhận OTP trong response và mock các dịch vụ ngoài (console.info gửi mail, fetch gọi Cloudflare Turnstile).
    const envNames = ["TURNSTILE_SECRET_KEY", "OTP_ECHO", "SMTP_HOST", "SMTP_USER", "SMTP_PASS", "MAIL_TRANSPORT"];
    const saved = envNames.map((key) => process.env[key]);
    for (const key of envNames) delete process.env[key];
    process.env.OTP_ECHO = "1";
    const mail = t.mock.method(console, "info", () => {});
    const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ success: true })));
    const rollback = new Error("Roll back G10 fixtures");
    try {
      // Bước 2: Bọc toàn bộ ca kiểm thử trong withTx và tạo các bảng tạm (temporary tables) để cô lập dữ liệu hoàn toàn khỏi seed data.
      await assert.rejects(withTx(async (sql) => {
        // Shadow seed tables with private, transaction-local fixtures.
        for (const table of ["users", "otp_challenges"]) {
          await sql.query(`create temporary table ${table} (like public.${table} including all) on commit drop`);
        }
        // Thêm user thành viên mẫu để phục vụ kiểm thử luồng quên mật khẩu (forgot password/reset).
        await sql.query(`insert into users (full_name,name_normalized,role,password_hash,phone,email)
          values ('G10 Reset','g10 reset','member','hash','+84987654102','g10-reset@example.test')`);
        // Bước 3: Lần lượt kiểm thử cho cả 2 mục đích gửi OTP công khai: đăng ký mới (register) và đặt lại mật khẩu (reset).
        for (const purpose of ["register", "reset"] as const) {
          clearLimits();
          const handler = purpose === "register" ? authH.register : authH.forgot;
          const body = purpose === "register"
            ? { full_name: "G10 Signup", phone: "0987654101", email: "g10-signup@example.test", password: "G10Password!", pii_consent: true }
            : { phone: "0987654102" };
          /**
           * Làm gì: Tạo Request HTTP POST giả lập gửi dữ liệu đăng ký hoặc quên mật khẩu tới API.
           * Được gọi ở: test "checks captcha before queries, quietly drops honeypots, and replaces challenges after 60 seconds"
           * @param extra Các trường dữ liệu bổ sung hoặc ghi đè trong body
           * @returns Đối tượng Request HTTP với header IP giả lập
           */
          const request = (extra: Record<string, unknown> = {}) => new Request("http://localhost/v1/auth/test", {
            method: "POST", headers: { "x-forwarded-for": "192.0.2.10" }, body: JSON.stringify({ ...body, ...extra }),
          });
          /**
           * Làm gì: Đếm số lượng mã OTP challenge hiện có trong database theo mục đích (purpose).
           * Được gọi ở: test "checks captcha before queries, quietly drops honeypots, and replaces challenges after 60 seconds"
           * @returns Số lượng bản ghi challenge tìm thấy
           */
          const count = async () => (await sql.query<{ n: number }>(`select count(*)::int as n from otp_challenges where purpose=$1`, [purpose]))[0].n;
          // Bước 4: Kiểm tra Captcha phải được xác thực trước khi chạm vào DB; xử lý các tình huống lỗi mạng, JSON sai định dạng hoặc Turnstile từ chối.
          process.env.TURNSTILE_SECRET_KEY = "test-secret";
          const noQueries = { query: async () => { assert.fail("captcha/honeypot must run before any query"); } } as unknown as typeof sql;
          const captchaError = (e: any) => e.code === "VALIDATION" && e.extra.field === "captcha";
          const mailsBefore = mail.mock.callCount();
          const callsBefore = fetchMock.mock.callCount();
          await assert.rejects(handler(noQueries, request()), captchaError);
          assert.equal(fetchMock.mock.callCount(), callsBefore);
          for (const response of ["rejected", "network", "malformed", "http"] as const) {
            fetchMock.mock.mockImplementation(async () => {
              if (response === "network") throw new Error("offline");
              if (response === "malformed") return new Response("not json");
              return new Response(JSON.stringify({ success: response === "http" }), { status: response === "http" ? 503 : 200 });
            });
            await assert.rejects(handler(noQueries, request({ captcha_token: "bad" })), captchaError);
          }
          assert.equal(await count(), 0);
          assert.equal(mail.mock.callCount(), mailsBefore);
          // Bước 5: Bẫy Honeypot: request chứa trường ẩn website (do bot tự điền) sẽ được trả về 202 thành công giả nhưng âm thầm hủy bỏ, không ghi DB, không gửi mail.
          assert.equal((await handler(noQueries, request({ website: "spam" }))).status, 202);
          assert.equal(await count(), 0);
          assert.equal(mail.mock.callCount(), mailsBefore);
          // Bước 6: Giả lập Cloudflare Turnstile xác thực thành công; kiểm tra handler tạo challenge vào DB và gửi mã OTP qua email.
          fetchMock.mock.mockImplementation(async (_url, init) => {
            assert.equal(String(_url), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
            assert.deepEqual(JSON.parse(String(init?.body)), { secret: "test-secret", response: "valid", remoteip: "192.0.2.10" });
            return new Response(JSON.stringify({ success: true }));
          });
          const first = await handler(sql, request({ captcha_token: "valid" }));
          assert.equal(first.status, 202);
          assert.equal(await count(), 1);
          assert.equal(mail.mock.callCount(), mailsBefore + 1);
          const initial = (await sql.query<any>(`select * from otp_challenges where purpose=$1`, [purpose]))[0];
          assert.equal(initial.otp_hash, hashOtp((first.body as any).otp));
          // Bước 7: Kiểm tra cơ chế chống spam (cooldown 60s): gửi lại ngay lập tức phải bị từ chối với mã 429 Too Many Requests.
          delete process.env.TURNSTILE_SECRET_KEY;
          const verifiedCalls = fetchMock.mock.callCount();
          await assert.rejects(handler(sql, request()), (e: any) => e.status === 429 && e.message === "Wait 60 seconds before requesting another code.");
          assert.equal(mail.mock.callCount(), mailsBefore + 1);
          // Bước 8: Tua thời gian hết hạn trong DB để giả lập qua 60 giây; kiểm tra cho phép gửi lại, tái sử dụng ID challenge cũ và reset số lần thử.
          // Advance the persisted send time, not the wall clock or time of day.
          await sql.query(`update otp_challenges set expires_at=now() + interval '239 seconds', attempts=4 where id=$1`, [initial.id]);
          const resent = await handler(sql, request());
          const replacement = (await sql.query<any>(`select * from otp_challenges where purpose=$1`, [purpose]))[0];
          assert.equal(resent.status, 202);
          assert.equal(replacement.id, initial.id);
          assert.equal(replacement.attempts, 0);
          assert.equal(replacement.otp_hash, hashOtp((resent.body as any).otp));
          assert.equal(await count(), 1);
          assert.equal(mail.mock.callCount(), mailsBefore + 2);
          assert.equal(fetchMock.mock.callCount(), verifiedCalls);
          // Bước 9: Kiểm tra hệ thống cho phép bỏ qua xác thực Captcha khi biến môi trường TURNSTILE_SECRET_KEY chưa được cấu hình.
          await sql.query(`delete from otp_challenges where id=$1`, [initial.id]);
          assert.equal((await handler(sql, request())).status, 202); // Initial send also works without a key.
        }
        // Ném lỗi rollback có chủ đích để withTx hoàn tác toàn bộ dữ liệu bảng tạm sau ca kiểm thử.
        throw rollback;
      }), (e) => e === rollback);
    // Dọn dẹp: Khôi phục biến môi trường gốc, xóa bộ đếm rate limit và gỡ bỏ các mock function.
    } finally {
      envNames.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
      clearLimits();
      mail.mock.restore();
      fetchMock.mock.restore();
    }
  });

  /**
   * Làm gì: Kiểm tra cơ chế Rate Limit (giới hạn tần suất gọi) cho API gửi OTP và xác thực OTP:
   * chặn spam gửi OTP theo IP, số điện thoại, email và chặn brute-force xác thực OTP theo IP và số điện thoại.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu số lần cho phép hoặc mã lỗi 429 không chính xác
   */
  it("limits sends and resends per IP, phone and email, and verification per IP and phone", async () => {
    // Bước 1: Tắt Turnstile captcha để tập trung kiểm thử tầng rate limit; tạo mock SQL ném lỗi reachedDatabase khi request vượt qua tầng guard.
    const secret = process.env.TURNSTILE_SECRET_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    const reachedDatabase = new Error("request passed guards");
    const sql = { query: async () => { throw reachedDatabase; } } as any;
    /**
     * Làm gì: Tạo Request HTTP POST giả lập với body và địa chỉ IP tùy chọn để test rate limit.
     * Được gọi ở: test "limits sends and resends per IP, phone and email, and verification per IP and phone"
     * @param body Payload dữ liệu gửi lên
     * @param ip Địa chỉ IP trong header x-forwarded-for
     * @returns Đối tượng Request HTTP
     */
    const request = (body: unknown, ip: string) => new Request("http://localhost/v1/auth/test", {
      method: "POST", headers: { "x-forwarded-for": ip }, body: JSON.stringify(body),
    });
    try {
      // Bước 2: Kiểm tra giới hạn số lần gửi mã OTP (authSend) theo từng chiều: IP, số điện thoại và email; vượt quá ngưỡng phải trả về 429.
      for (const dimension of ["ip", "phone", "email"] as const) {
        clearLimits();
        const maximum = dimension === "ip" ? LIMITS.authSendIp.limit : LIMITS.authSendIdentity.limit;
        for (let i = 0; i <= maximum; i++) {
          const body = { full_name: "G10", phone: dimension === "phone" ? "0987654103" : `0987654${String(200 + i)}`,
            email: dimension === "email" ? " G10@example.test " : `g10-${i}@example.test`, password: "Password123", pii_consent: true };
          await assert.rejects(authH.register(sql, request(body, dimension === "ip" ? "192.0.2.1" : `192.0.2.${i + 1}`)),
            (e: any) => i < maximum ? e === reachedDatabase : e.status === 429);
        }
      }
      // Bước 3: Kiểm tra giới hạn số lần thử xác thực OTP (authVerify) theo IP và số điện thoại để chống tấn công vét cạn (brute-force).
      for (const dimension of ["ip", "phone"] as const) {
        clearLimits();
        const maximum = dimension === "ip" ? LIMITS.authVerifyIp.limit : LIMITS.authVerifyIdentity.limit;
        for (let i = 0; i <= maximum; i++) {
          await assert.rejects(authH.verifyOtp(sql, request({ phone: dimension === "phone" ? "0987654103" : `0987654${String(300 + i)}`, otp: "123456" },
            dimension === "ip" ? "192.0.2.1" : `192.0.2.${i + 1}`)),
            (e: any) => i < maximum ? e === reachedDatabase : e.status === 429);
        }
      }
    // Bước 4: Khôi phục lại biến môi trường TURNSTILE_SECRET_KEY và xóa sạch bộ đếm rate limit trong bộ nhớ.
    } finally {
      if (secret === undefined) delete process.env.TURNSTILE_SECRET_KEY; else process.env.TURNSTILE_SECRET_KEY = secret;
      clearLimits();
    }
  });
});

// Suite G8: Bộ kiểm thử quản lý tài khoản quản lý (Manager), phân quyền và kiểm toán.
describe("G8 manager accounts", () => {
  /**
   * Làm gì: Kiểm tra toàn diện vòng đời tài khoản Manager (G8): tạo mới, đặt lại mật khẩu,
   * phân quyền, chặn tự thao tác lên chính mình, ghi log kiểm toán (audit log) đầy đủ,
   * và thực thi quy tắc bất biến: hệ thống phải luôn có ít nhất một Manager hoạt động (không thể xóa/khóa manager cuối cùng).
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu các ràng buộc phân quyền, audit log hoặc bảo vệ manager cuối cùng bị vi phạm
   */
  it("creates and resets managers, audits changes, and refuses removing the last active manager", async () => {
    // Bước 1: Import động các handler xử lý nghiệp vụ nhân viên (staff).
    const { staffCreate, staffPatch, staffResetPassword, staffRevokeSessions } = await import("./handlers/staff.ts");
    const rollback = new Error("Roll back G8 fixtures");
    await assert.rejects(withTx(async (sql) => {
      // Bước 2: Tạo các bảng tạm cô lập trong transaction để tránh làm thay đổi hoặc phụ thuộc vào dữ liệu seed có sẵn.
      // Empty tables with the real schema isolate the manager count from seed data.
      // These transaction-local fixtures disappear on rollback; no seed row is changed.
      for (const table of ["users", "sessions_auth", "audit_logs", "coach_sports", "user_avatars", "classes", "site_assets"]) {
        await sql.query(`create temporary table ${table} (like public.${table} including all) on commit drop`);
      }
      // Bước 3: Tạo tài khoản Manager ban đầu (actor) làm người thực thi các thao tác quản trị.
      const actor = (await sql.query<any>(
        `insert into users (full_name,name_normalized,role,password_hash,phone)
         values ('G8 Manager','g8 manager','manager','hash','+84987654001') returning *`,
      ))[0];
      /**
       * Làm gì: Tạo Request HTTP POST giả lập gửi dữ liệu thao tác nhân viên tới endpoint /v1/staff.
       * Được gọi ở: test "G8 manager accounts"
       * @param body Payload dữ liệu gửi lên
       * @returns Đối tượng Request HTTP
       */
      const request = (body: unknown) => new Request("http://localhost/v1/staff", {
        method: "POST", body: JSON.stringify(body),
      });
      // Bước 4: Manager đầu tiên tạo tài khoản Manager thứ hai; kiểm tra cờ must_change_password được bật mặc định cho nhân viên mới.
      const created = await staffCreate(sql, request({ full_name: "G8 Second Manager", phone: "0987654002", role: "manager" }), actor);
      const second = created.body.staff;
      assert.equal(created.status, 201);
      assert.equal(second.role, "manager");
      assert.equal(second.status, "active");
      assert.equal(second.must_change_password, true);
      // Bước 5: Cấp session cho Manager thứ hai, sau đó Manager đầu tiên reset mật khẩu; xác minh mật khẩu tạm mới và thu hồi toàn bộ session cũ.
      await issueSession(sql, { ...actor, id: second.id });
      const reset = await staffResetPassword(sql, second.id, actor);
      assert.notEqual(reset.body.temp_password, created.body.temp_password);
      const { verifyPassword } = await import("../services/crypto.ts");
      const password = (await sql.query<any>(`select password_hash from users where id=$1`, [second.id]))[0];
      assert.ok(verifyPassword(reset.body.temp_password, password.password_hash));
      assert.ok((await sql.query<any>(`select revoked_at from sessions_auth where user_id=$1`, [second.id]))[0].revoked_at);

      /**
       * Làm gì: Gửi request cập nhật thông tin nhân viên qua handler staffPatch với quyền của actor chỉ định.
       * Được gọi ở: test "G8 manager accounts"
       * @param id ID của nhân viên cần cập nhật
       * @param body Dữ liệu cần cập nhật (role, status, sports)
       * @param by Người thực hiện thao tác (mặc định là actor ban đầu)
       * @returns Promise kết quả cập nhật nhân viên từ staffPatch
       */
      const patch = (id: string, body: unknown, by = actor) => staffPatch(sql, id, request(body), by);
      const forbidden = (e: any) => e.code === "FORBIDDEN";
      // Bước 6: Kiểm tra các quy tắc tự bảo vệ: Manager không thể tự khóa, tự hạ quyền, tự reset mật khẩu hay tự thu hồi session của chính mình.
      await assert.rejects(patch(actor.id, { status: "locked" }), forbidden);
      await assert.rejects(patch(actor.id, { role: "receptionist" }), forbidden);
      await assert.rejects(staffResetPassword(sql, actor.id, actor), forbidden);
      await assert.rejects(staffRevokeSessions(sql, actor.id, actor), forbidden);
      await assert.rejects(staffCreate(sql, request({ role: "manager" }), { ...actor, role: "member" }), forbidden);

      // Bước 7: Cập nhật trạng thái (khóa/mở khóa) và luân chuyển vai trò (lễ tân, HLV kèm môn thể thao, quản lý) của Manager thứ hai.
      assert.equal((await patch(second.id, { status: "locked" })).body.staff.status, "locked");
      await patch(second.id, { status: "active" });
      assert.equal((await patch(second.id, { role: "receptionist" })).body.staff.role, "receptionist");
      await patch(second.id, { role: "manager" });
      assert.equal((await patch(second.id, { role: "coach", sports: ["badminton"] })).body.staff.role, "coach");
      await patch(second.id, { role: "manager" });
      // Bước 8: Kiểm tra quy tắc sống còn: Khi Manager thứ hai hạ quyền Manager thứ nhất, hệ thống từ chối mọi yêu cầu khóa/hạ quyền Manager thứ hai (trả về lỗi 409 Conflict).
      // The second manager retires the first. Its already-authorized request
      // must still be unable to remove the remaining manager (the race case).
      await patch(actor.id, { role: "receptionist" }, { ...actor, id: second.id });
      const conflict = (e: any) => e.status === 409 && e.message === "At least one active manager must remain.";
      for (const body of [{ status: "locked" }, { role: "receptionist" }, { role: "coach", sports: ["badminton"] }, { role: "manager", status: "locked" }]) {
        await assert.rejects(patch(second.id, body), conflict);
      }
      assert.deepEqual(await sql.query(`select role,status from users where id=$1`, [second.id]), [{ role: "manager", status: "active" }]);
      // Bước 9: Kiểm tra tính toàn vẹn của Audit Log: ghi nhận chính xác 8 thao tác thay đổi nhân viên kèm actor_id thực hiện.
      const audits = await sql.query<any>(`select actor_id,action from audit_logs where entity_id=$1 order by at`, [second.id]);
      assert.equal(audits.length, 8);
      assert.ok(audits.every((a) => a.actor_id === actor.id));
      assert.deepEqual(audits.map((a) => a.action).sort(), ["create_staff", "reset_staff_password", "lock_staff", "unlock_staff", ...Array(4).fill("change_staff_role")].sort());
      throw rollback;
    }), (e) => e === rollback);
  });
});

// Suite G7: Bộ kiểm thử các cơ chế bảo vệ và đối soát ca thu ngân (chốt ca, lệch tiền, ca quá hạn).
describe("G7 till shift safeguards", () => {
  /**
   * Làm gì: Kiểm tra các cơ chế an toàn khi chốt ca thu ngân (G7): bắt buộc Manager nhập lý do khi đóng ca hộ,
   * kiểm tra quyền sở hữu ca, ghi audit log, phát hiện và gửi thông báo khi có chênh lệch tiền mặt giữa thực tế và sổ sách.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu thiếu xác thực lý do, sai quyền đóng ca hoặc không ghi nhận chênh lệch tiền
   */
  it("requires a manager reason, preserves ownership checks, audits closure and reports cash differences", async () => {
    const rollback = new Error("Roll back G7 close fixtures");
    await assert.rejects(withTx(async (sql) => {
      // Bước 1: Khởi tạo dữ liệu người dùng gồm 1 Manager, 2 Lễ tân (chủ ca và lễ tân khác) và 1 Khách hàng.
      const users = await sql.query<any>(
        `insert into users (full_name,name_normalized,role,password_hash,phone)
         select 'G7 ' || role,'g7 ' || role,role::user_role,'hash',substr(gen_random_uuid()::text,1,16)
         from unnest(array['manager','receptionist','receptionist','member']) role returning *`,
      );
      const manager = users.find((u) => u.role === "manager");
      const [owner, other] = users.filter((u) => u.role === "receptionist");
      const member = users.find((u) => u.role === "member");
      // Bước 2: Tạo một ca thu ngân mới thuộc sở hữu của Lễ tân (owner).
      const shift = (await sql.query<{ id: string }>(
        `insert into cashier_shifts (receptionist_id) values ($1) returning id`, [owner.id],
      ))[0];
      // Bước 3: Tạo các giao dịch mẫu trong ca: thu tiền mặt 100k, hoàn tiền mặt 20k, hoàn 10k đang chờ duyệt (chưa trừ), thanh toán thẻ 50k -> Tiền mặt hệ thống tính toán là 80,000 VND.
      await sql.query(
        `insert into payments (code,shift_id,method,amount_vnd,vat_rate,status,ref_type,ref_id)
         select 'G7-' || substr(gen_random_uuid()::text,1,20),$1,method::pay_method,amount,0,status::pay_status,'booking',gen_random_uuid()
         from (values ('cash',100000,'posted'),('cash',-20000,'posted'),
                      ('cash',-10000,'refund_pending'),('card',50000,'posted')) p(method,amount,status)`, [shift.id],
      );
      /**
       * Làm gì: Tạo Request HTTP POST giả lập gửi yêu cầu đóng ca thu ngân.
       * Được gọi ở: test "G7 till shift safeguards"
       * @param body Dữ liệu đóng ca gồm số tiền khai báo và lý do
       * @returns Đối tượng Request HTTP
       */
      const request = (body: unknown) => new Request(`http://localhost/v1/shifts/${shift.id}/close`, {
        method: "POST", body: JSON.stringify(body),
      });
      // Bước 4: Kiểm tra quy tắc nghiệp vụ: Manager đóng ca hộ bắt buộc phải có lý do hợp lệ (từ chối undefined, rỗng, khoảng trắng hoặc kiểu số).
      for (const reason of [undefined, "", "  ", 42]) {
        await assert.rejects(shiftClose(sql, shift.id, request({ cash_declared_vnd: 70000, reason }), manager),
          (e: any) => e.code === "VALIDATION" && e.extra.field === "reason");
      }
      // Bước 5: Kiểm tra phân quyền: Lễ tân khác hoặc khách hàng không có quyền đóng ca này (trả về lỗi FORBIDDEN).
      for (const user of [other, member]) {
        await assert.rejects(shiftClose(sql, shift.id, request({ cash_declared_vnd: 70000, reason: "Review" }), user),
          (e: any) => e.code === "FORBIDDEN");
      }
      // Bước 6: Manager thực hiện đóng ca hộ thành công với lý do hợp lệ; khai báo 70,000 VND tiền mặt trong khi hệ thống tính toán là 80,000 VND.
      const closed = await shiftClose(sql, shift.id, request({ cash_declared_vnd: 70000, reason: "  Forgotten shift  " }), manager);
      assert.deepEqual(closed.body, { ok: true, cash_declared_vnd: 70000, cash_system_vnd: 80000 });
      // Bước 7: Kiểm tra Audit Log: ghi nhận action force_close_shift kèm actor_id của Manager, lý do đã được trim và số tiền chênh lệch.
      const audits = await sql.query<any>(`select actor_id,action,after from audit_logs where entity_id=$1`, [shift.id]);
      assert.equal(audits.length, 1);
      assert.equal(audits[0].actor_id, manager.id);
      assert.equal(audits[0].action, "force_close_shift");
      assert.deepEqual(audits[0].after, { declared: 70000, actual: 80000, reason: "Forgotten shift" });
      // Bước 8: Kiểm tra Outbox: tạo cảnh báo mẫu shift_cash_difference gửi tới Manager vì có chênh lệch giữa tiền mặt khai báo và hệ thống.
      const alerts = await sql.query<any>(`select payload from outbox where template='shift_cash_difference' and user_id=$1 and payload->>'shift_id'=$2`, [manager.id, shift.id]);
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].payload.cash_declared_vnd, 70000);
      assert.equal(alerts[0].payload.cash_system_vnd, 80000);
      // Bước 9: Đảm bảo không thể đóng lại ca đã đóng (trả về lỗi CONFLICT_STATE).
      await assert.rejects(shiftClose(sql, shift.id, request({ cash_declared_vnd: 70000, reason: "Retry" }), manager),
        (e: any) => e.code === "CONFLICT_STATE");
      // Bước 10: Kiểm tra Lễ tân tự đóng ca của mình: khai báo khớp tiền không tạo cảnh báo; khai báo lệch tiền (1 VND vs 0 VND) tạo cảnh báo gửi Manager.
      // Normal owner closure still works; matching cash produces no warning.
      const ownShift = (await sql.query<{ id: string }>(
        `insert into cashier_shifts (receptionist_id) values ($1) returning id`, [owner.id],
      ))[0];
      await shiftClose(sql, ownShift.id, request({ cash_declared_vnd: 0 }), owner);
      assert.equal((await sql.query(`select id from outbox where payload->>'shift_id'=$1`, [ownShift.id])).length, 0);
      assert.equal((await sql.query<any>(`select action from audit_logs where entity_id=$1`, [ownShift.id]))[0].action, "close_shift");
      const mismatch = (await sql.query<{ id: string }>(
        `insert into cashier_shifts (receptionist_id) values ($1) returning id`, [owner.id],
      ))[0];
      await shiftClose(sql, mismatch.id, request({ cash_declared_vnd: 1 }), owner);
      assert.equal((await sql.query(`select id from outbox where user_id=$1 and payload->>'shift_id'=$2`, [manager.id, mismatch.id])).length, 1);
      throw rollback;
    }), (e) => e === rollback);
  });

  /**
   * Làm gì: Kiểm tra tác vụ quét và gửi cảnh báo ca thu ngân quá hạn (G7):
   * chỉ gửi thông báo đúng 1 lần cho Manager đang hoạt động đối với ca mở quá 16 tiếng mà chưa chốt.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu cảnh báo gửi trùng lặp, gửi cho tài khoản bị khóa hoặc sai mốc thời gian 16 giờ
   */
  it("warns active managers once only for open shifts strictly older than 16 hours", async () => {
    const rollback = new Error("Roll back G7 overdue fixtures");
    await assert.rejects(withTx(async (sql) => {
      // Bước 1: Khởi tạo 2 Manager (1 active, 1 disabled) và 4 Lễ tân để mở ca thu ngân.
      const users = await sql.query<any>(
        `insert into users (full_name,name_normalized,role,password_hash,phone)
         select 'G7 ' || role,'g7 ' || role,role::user_role,'hash',substr(gen_random_uuid()::text,1,16)
         from unnest(array['manager','manager','receptionist','receptionist','receptionist','receptionist']) role returning *`,
      );
      const [manager, disabled] = users.filter((u) => u.role === "manager");
      await sql.query(`update users set status='disabled' where id=$1`, [disabled.id]);
      const owners = users.filter((u) => u.role === "receptionist");
      const shifts: string[] = [];
      // Bước 2: Tạo 4 ca thu ngân: 17h (quá hạn > 16h), 16h (chưa quá hạn), 15h (chưa quá hạn), và 20h nhưng đã chốt ca.
      for (const [i, hours] of [17, 16, 15, 20].entries()) {
        shifts.push((await sql.query<{ id: string }>(
          `insert into cashier_shifts (receptionist_id,opened_at,closed_at)
           values ($1,now()-($2 * interval '1 hour'),case when $3 then now() else null end) returning id`,
          [owners[i].id, hours, i === 3],
        ))[0].id);
      }
      // Bước 3: Chạy job notifyOverdueShifts hai lần liên tiếp để kiểm tra tính idempotent (chống gửi trùng cảnh báo).
      await notifyOverdueShifts(sql);
      await notifyOverdueShifts(sql);
      // Bước 4: Kiểm tra Outbox: chỉ gửi đúng 1 thông báo cho Manager active về ca mở 17h, bỏ qua manager bị khóa và ca đã đóng.
      const alerts = await sql.query<any>(
        `select user_id,payload from outbox where template='shift_overdue'
         and user_id=any($1::uuid[]) and payload->>'shift_id'=any($2::text[])`,
        [[manager.id, disabled.id], shifts],
      );
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].user_id, manager.id);
      assert.equal(alerts[0].payload.shift_id, shifts[0]);
      assert.equal(alerts[0].payload.receptionist_id, owners[0].id);
      throw rollback;
    }), (e) => e === rollback);
  });
});

// Suite G6: Ràng buộc và xử lý xung đột khi bảo trì sân (hủy đặt sân, hoàn tiền, cảnh báo lớp học).
describe("G6 maintenance commitments", () => {
  // Lần lượt kiểm tra qua 3 kịch bản: tạo mới lệnh bảo trì, mở lại lệnh bảo trì cũ, và bật cờ chặn sân trên lệnh đang mở.
  for (const mode of ["create", "reopen", "enable blocking"] as const) {
    /**
     * Làm gì: Kiểm tra quy trình chặn sân khi bảo trì (G6) qua 3 kịch bản (tạo mới, mở lại, bật chặn sân):
     * yêu cầu xác nhận trước khi hủy lịch, tự động hủy booking tương lai và hoàn số tiền mặt còn lại,
     * bảo toàn buổi học (session) và gửi cảnh báo tới Manager cùng Huấn luyện viên.
     * Được gọi ở: test runner (node --test)
     * @returns Promise<void>
     * @throws AssertionError nếu thiếu bước yêu cầu xác nhận 409, sai số tiền hoàn hoặc hủy nhầm buổi học
     */
    it(`${mode}: requires confirmation, refunds only remaining cash, and preserves sessions with staff alerts`, async () => {
      const rollback = new Error("Roll back G6 fixtures");
      await assert.rejects(withTx(async (sql) => {
        // Bước 1: Khởi tạo người dùng mẫu: Manager, Lễ tân (desk), Huấn luyện viên (coach) và Khách hàng (member).
        const users = await sql.query<any>(
          `insert into users (full_name,name_normalized,role,password_hash,phone)
           select 'G6 ' || role,'g6 ' || role,role::user_role,'hash',substr(gen_random_uuid()::text,1,16)
           from unnest(array['manager','receptionist','coach','member']) role returning *`,
        );
        const manager = users.find((u) => u.role === "manager");
        const desk = users.find((u) => u.role === "receptionist");
        const coach = users.find((u) => u.role === "coach");
        const member = users.find((u) => u.role === "member");
        // Bước 2: Tạo một sân cầu lông ở trạng thái ready và một lớp học định kỳ hàng tuần diễn ra trên sân này.
        const court = (await sql.query<{ id: string }>(
          `insert into courts (court_code,sport,status)
           values ('G6-' || substr(gen_random_uuid()::text,1,5),'badminton','ready') returning id`,
        ))[0];
        const cls = (await sql.query<{ id: string }>(
          `insert into classes (sport,level,coach_id,court_id,capacity,rrule,duration_min,start_on,end_on,status)
           values ('badminton','beginner',$1,$2,10,'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10',60,
                   current_date - 7,current_date + 30,'open') returning id`, [coach.id, court.id],
        ))[0];
        // Bước 3: Tạo 8 đặt sân: 7 booking trong tương lai (booking 0 đã thanh toán 100k, booking 1 giữ chỗ, booking 2-6 xác nhận) và 1 booking trong quá khứ.
        const bookings: { id: string; occupancy_id: string }[] = [];
        for (let i = 0; i < 8; i++) {
          bookings.push((await sql.query<{ id: string; occupancy_id: string }>(
            `with occupied as (
               insert into occupancies (court_id,start_at,end_at,kind,ref_id)
               values ($1,now() + $3 * interval '2 hours',now() + $3 * interval '2 hours' + interval '1 hour',
                       'booking',gen_random_uuid()) returning *
             ) insert into court_bookings (id,court_id,user_id,start_at,end_at,status,price_vnd,deposit_vnd,paid_vnd,code,channel,occupancy_id)
               select ref_id,$1,$2,start_at,end_at,$4::booking_status,100000,0,$5,
                      'G6-' || substr(ref_id::text,1,20),'app',id from occupied returning id,occupancy_id`,
            [court.id, member.id, i === 7 ? -2 : i + 1, i === 1 ? "hold" : "confirmed", i === 0 ? 100000 : 0],
          ))[0]);
        }
        // Bước 4: Tạo lịch sử thanh toán cho booking 0: thu 100k bằng thẻ, đã có 1 khoản hoàn 20k tiền mặt đang chờ duyệt -> số tiền thực tế cần hoàn là 80,000 VND.
        await sql.query(
          `insert into payments (code,user_id,method,amount_vnd,vat_rate,status,ref_type,ref_id)
           values ('G6-' || substr(gen_random_uuid()::text,1,20),$1,'card',100000,0,'posted','booking',$2),
                  ('G6-' || substr(gen_random_uuid()::text,1,20),$1,'cash',-20000,0,'refund_pending','booking',$2)`,
          [member.id, bookings[0].id],
        );
        // Bước 5: Tạo 1 buổi học (session) của lớp học diễn ra trên sân này sau 2 ngày nữa.
        const session = (await sql.query<{ id: string; occupancy_id: string }>(
          `with occupied as (
             insert into occupancies (court_id,start_at,end_at,kind,ref_id)
             values ($2,now() + interval '2 days',now() + interval '2 days 1 hour','session',gen_random_uuid()) returning *
           ) insert into sessions (id,class_id,court_id,start_at,end_at,status,occupancy_id)
             select ref_id,$1,$2,start_at,end_at,'scheduled',id from occupied returning id,occupancy_id`, [cls.id, court.id],
        ))[0];
        /**
         * Làm gì: Tạo Request HTTP POST giả lập gửi tới endpoint quản lý lệnh bảo trì work-orders.
         * Được gọi ở: test "G6 maintenance commitments"
         * @param body Payload dữ liệu lệnh bảo trì
         * @returns Đối tượng Request HTTP
         */
        const request = (body: object) => new Request("http://test/work-orders", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        // Bước 6: Khởi tạo lệnh bảo trì ban đầu tùy theo mode kiểm thử (nếu là reopen thì hoàn thành trước lệnh bảo trì).
        let id: string | undefined;
        if (mode !== "create") {
          id = (await workOrdersCreate(sql, request({ title: "G6 repair", court_id: court.id }), desk)).body.id;
          if (mode === "reopen") await workOrdersPatch(sql, id, request({ status: "done", blocks_court: true }), desk);
        }
        /**
         * Làm gì: Thực thi tạo mới hoặc cập nhật lệnh bảo trì tùy theo chế độ (mode) đang kiểm thử.
         * Được gọi ở: test "G6 maintenance commitments"
         * @param confirm Cờ boolean xác nhận cưỡng chế thực hiện dù có xung đột lịch
         * @returns Promise chứa phản hồi từ handler workOrdersCreate hoặc workOrdersPatch
         */
        const run = (confirm?: boolean) => mode === "create"
          ? workOrdersCreate(sql, request({ title: "G6 repair", court_id: court.id, blocks_court: true, confirm }), coach)
          : workOrdersPatch(sql, id!, request({ status: "open", blocks_court: true, confirm }), desk);
        // Bước 7: Gọi thao tác chặn sân KHÔNG truyền confirm -> hệ thống phải chặn lại bằng mã lỗi 409 Conflict và trả về danh sách lịch bị ảnh hưởng.
        await assert.rejects(run(), (error: any) => {
          assert.equal(error.status, 409);
          assert.equal(error.extra.requires_confirm, true);
          assert.equal(error.extra.affected.booking_count, 7);
          assert.equal(error.extra.affected.session_count, 1);
          assert.equal(error.extra.affected.bookings.length, 5);
          assert.equal(error.extra.affected.bookings[0].id, bookings[0].id);
          assert.ok(error.extra.affected.sessions[0].start_at);
          return true;
        });
        assert.equal((await sql.query<any>(`select status from courts where id = $1`, [court.id]))[0].status, "ready");
        assert.equal((await sql.query<any>(`select count(*)::int n from work_orders where court_id = $1`, [court.id]))[0].n, mode === "create" ? 0 : 1);
        assert.equal((await sql.query<any>(`select count(*)::int n from outbox where payload->>'session_id' = $1`, [session.id]))[0].n, 0);
        // Bước 8: Gửi lại yêu cầu kèm confirm: true -> sân chuyển sang maintenance, 7 booking tương lai bị hủy và giải phóng vị trí chiếm dụng sân (occupancy).
        const result = await run(true);
        if (mode === "create") id = (result.body as { id: string }).id;
        assert.equal((await sql.query<any>(`select status from courts where id = $1`, [court.id]))[0].status, "maintenance");
        const cancelled = await sql.query<any>(`select status,occupancy_id from court_bookings where id = any($1::uuid[])`, [bookings.slice(0, 7).map((b) => b.id)]);
        assert.ok(cancelled.every((b) => b.status === "cancelled" && b.occupancy_id === null));
        assert.equal((await sql.query<any>(`select count(*)::int n from occupancies where id = any($1::uuid[])`, [bookings.slice(0, 7).map((b) => b.occupancy_id)]))[0].n, 0);
        assert.equal((await sql.query<any>(`select status from court_bookings where id = $1`, [bookings[7].id]))[0].status, "confirmed");
        // Bước 9: Kiểm tra thanh toán hoàn tiền: hệ thống chỉ tạo thêm 1 bản ghi hoàn tiền -80,000 VND (sau khi đã trừ 20,000 VND đang chờ hoàn trước đó).
        const refunds = await sql.query<any>(`select amount_vnd,method,status,shift_id from payments where ref_id = $1 and amount_vnd < 0 order by amount_vnd`, [bookings[0].id]);
        assert.deepEqual(refunds, [
          { amount_vnd: -80000, method: "cash", status: "refund_pending", shift_id: null },
          { amount_vnd: -20000, method: "cash", status: "refund_pending", shift_id: null },
        ]);
        // Bước 10: Kiểm tra Outbox: tạo đúng 7 thông báo booking_cancelled tương ứng với 7 booking tương lai bị hủy.
        assert.equal((await sql.query<any>(`select count(*)::int n from outbox where template = 'booking_cancelled' and payload->>'id' = any($1::text[])`, [bookings.map((b) => b.id)]))[0].n, 7);
        // Bước 11: Quy tắc bảo vệ lớp học: buổi học (session) giữ nguyên trạng thái scheduled không bị hủy; hệ thống gửi cảnh báo maintenance_session tới Manager và HLV.
        assert.deepEqual((await sql.query<any>(`select status,occupancy_id from sessions where id = $1`, [session.id]))[0], { status: "scheduled", occupancy_id: session.occupancy_id });
        /**
         * Làm gì: Truy vấn danh sách người nhận thông báo bảo trì (maintenance_session) từ bảng outbox.
         * Được gọi ở: test "G6 maintenance commitments"
         * @returns Danh sách user_id nhận thông báo
         */
        const notices = () => sql.query<any>(`select user_id from outbox where template = 'maintenance_session' and payload->>'session_id' = $1 and user_id = any($2::uuid[]) order by user_id`, [session.id, users.map((u) => u.id)]);
        assert.deepEqual((await notices()).map((n) => n.user_id).sort(), [manager.id, coach.id].sort());
        // Bước 12: Cập nhật trạng thái lệnh bảo trì sang in_progress; đảm bảo không tạo thêm thông báo cảnh báo trùng lặp.
        await workOrdersPatch(sql, id!, request({ status: "in_progress", confirm: true }), desk);
        assert.equal((await notices()).length, 2);
        assert.equal((await sql.query<any>(`select count(*)::int n from payments where ref_id = $1`, [bookings[0].id]))[0].n, 3);
        throw rollback;
      }), (error) => error === rollback);
    });
  }
});

// Suite G5: Cảnh báo không đạt sĩ số tối thiểu cho lớp học sắp diễn ra.
describe("G5 class minimum warnings", () => {
  /**
   * Làm gì: Kiểm tra cảnh báo số lượng học viên tối thiểu của lớp học (G5):
   * cảnh báo Manager đúng 1 lần trong cửa sổ 24 giờ trước buổi học đầu tiên nếu chưa đủ sĩ số tối thiểu,
   * chỉ đếm chỗ ngồi đã xác nhận (confirmed) và đánh dấu cảnh báo lớp học đang chạy mà không tự ý hủy lớp.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu cảnh báo gửi sai thời điểm, đếm sai sĩ số hoặc tự động hủy lớp học
   */
  it("warns managers once in the first-session 24-hour window, counts only confirmed seats, and flags running classes without cancelling", async () => {
    // Định nghĩa lỗi rollback để hoàn tác toàn bộ dữ liệu kiểm thử của suite G5 sau khi test xong
    const rollback = new Error("Roll back G5 fixtures");
    await assert.rejects(withTx(async (sql) => {
      // Bước 1: Tạo dữ liệu người dùng mẫu gồm 3 managers, 1 coach và 5 members
      const users = await sql.query<any>(
        `insert into users (full_name, name_normalized, role, password_hash, phone)
         select 'G5 ' || role, 'g5 ' || role, role::user_role, 'hash', substr(gen_random_uuid()::text, 1, 16)
           from unnest(array['manager','manager','manager','coach','member','member','member','member','member']) role
         returning *`,
      );
      const managers = users.filter((u) => u.role === "manager");
      const coach = users.find((u) => u.role === "coach");
      const members = users.filter((u) => u.role === "member");
      // Vô hiệu hóa manager thứ 3 để kiểm tra quy tắc: cảnh báo chỉ gửi tới các manager đang hoạt động (active)
      await sql.query(`update users set status = 'disabled' where id = $1`, [managers[2].id]);
      // Bước 2: Chuẩn bị 10 kịch bản kiểm thử: cận 24h, trước 12h, sớm 25h, đủ học viên, không đặt min, trạng thái draft/cancelled, đã bắt đầu...
      const cases = [
        { name: "boundary", hours: 24, minimum: 2, status: "open", confirmed: 1, warn: true, running: false },
        { name: "soon", hours: 12, minimum: 2, status: "open", confirmed: 1, warn: true, running: false },
        { name: "early", hours: 25, minimum: 2, status: "open", confirmed: 1, warn: false, running: false },
        { name: "met", hours: 12, minimum: 2, status: "open", confirmed: 2, warn: false, running: false },
        { name: "none", hours: 12, minimum: null, status: "open", confirmed: 1, warn: false, running: false },
        { name: "draft", hours: 12, minimum: 2, status: "draft", confirmed: 1, warn: false, running: false },
        { name: "cancelled", hours: 12, minimum: 2, status: "cancelled", confirmed: 1, warn: false, running: false },
        { name: "started", hours: 0, minimum: 2, status: "open", confirmed: 1, warn: false, running: true },
        { name: "later-session", hours: 12, minimum: 2, status: "open", confirmed: 1, warn: false, running: true },
        { name: "no-session", hours: null, minimum: 2, status: "open", confirmed: 1, warn: false, running: false },
      ];
      const fixtures: Array<(typeof cases)[number] & { id: string }> = [];
      // Bước 3: Tạo sân, lớp học và các bản ghi ghi danh (enrollments) tương ứng cho từng kịch bản kiểm thử
      for (const c of cases) {
        const court = (await sql.query<{ id: string }>(
          `insert into courts (court_code, sport, status)
           values ('G5-' || substr(gen_random_uuid()::text, 1, 5),'badminton','ready') returning id`,
        ))[0];
        const cls = (await sql.query<{ id: string }>(
          `insert into classes (sport, level, coach_id, court_id, capacity, enrolled_count,
                                min_enrolled, rrule, duration_min, start_on, end_on, status)
           values ('badminton','beginner',$1,$2,10,5,$3,'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10',60,
                   current_date - 7,current_date + 30,$4::class_status) returning id`,
          [coach.id, court.id, c.minimum, c.status],
        ))[0];
        fixtures.push({ ...c, id: cls.id });
        for (const [i, member] of members.entries()) {
          // Chỉ trạng thái confirmed mới tính vào sĩ số tối thiểu; các trạng thái hold, waitlisted, cancelled bị loại trừ
          const status = i < c.confirmed ? "confirmed" : i === 2 ? "hold" : i === 3 ? "waitlisted" : "cancelled";
          await sql.query(
            `insert into enrollments (class_id,user_id,status,waitlist_pos,hold_until)
             values ($1,$2,$3::enroll_status,case when $3 = 'waitlisted' then 1 else null end,
                     case when $3 = 'hold' then now() + interval '1 hour' else null end)`,
            [cls.id, member.id, status],
          );
        }
        // All times are relative to the transaction's stable now(), never wall-clock hours.
        if (c.hours !== null) await sql.query(
          `with occupied as (
             insert into occupancies (court_id,start_at,end_at,kind,ref_id)
             values ($2,now() + $3 * interval '1 hour',now() + ($3 + 1) * interval '1 hour','session',gen_random_uuid())
             returning id,ref_id,start_at,end_at
           ) insert into sessions (id,class_id,court_id,start_at,end_at,status,occupancy_id)
             select ref_id,$1,$2,start_at,end_at,'scheduled',id from occupied`,
          [cls.id, court.id, c.hours],
        );
        // Thêm buổi tập trong quá khứ đã hoàn thành (done) để đánh dấu lớp học đang diễn ra (running)
        if (c.name === "later-session") await sql.query(
          `insert into sessions (class_id,court_id,start_at,end_at,status)
           values ($1,$2,now() - interval '7 days',now() - interval '7 days' + interval '1 hour','done')`,
          [cls.id, court.id],
        );
      }
      const ids = fixtures.map((c) => c.id);
      // Hàm trợ giúp truy vấn trạng thái hiện tại của các lớp học để so sánh trước và sau khi quét cảnh báo
      const states = () => sql.query(
        `select id,status::text,enrolled_count from classes where id = any($1::uuid[]) order by id`, [ids],
      );
      // Bước 4: Lưu lại trạng thái của các lớp trước khi chạy tác vụ cảnh báo
      const before = await states();
      // Bước 5: Kích hoạt job quét cảnh báo thiếu sĩ số tối thiểu (notifyClassMinimums) lần 1
      await notifyClassMinimums(sql);
      // Hàm trợ giúp lấy danh sách thông báo class_below_minimum đã ghi vào bảng outbox
      const notices = () => sql.query<any>(
        `select user_id,payload,channel,sent_at,dedupe_key from outbox
          where template = 'class_below_minimum' and payload->>'class_id' = any($1::text[])
            and user_id = any($2::uuid[]) order by dedupe_key`, [ids, users.map((u) => u.id)],
      );
      const first = await notices();
      // Bước 6: Kiểm tra chỉ có đúng 4 thông báo (2 lớp vi phạm boundary và soon x 2 manager đang active)
      assert.equal(first.length, 4);
      // Xác minh chi tiết từng thông báo: đúng người nhận, kênh inapp, và nội dung payload
      for (const c of fixtures) {
        const messages = first.filter((n) => n.payload.class_id === c.id);
        assert.equal(messages.length, c.warn ? 2 : 0, c.name);
        for (const n of messages) {
          assert.ok(managers.slice(0, 2).some((u) => u.id === n.user_id));
          assert.equal(n.channel, "inapp");
          assert.ok(n.sent_at);
          assert.deepEqual(n.payload, { class_id: c.id, code: classCode("badminton", "beginner", c.id), confirmed_count: 1, min_enrolled: 2 });
        }
      }
      // Bước 7: Quét cảnh báo lần 2 để kiểm tra tính idempotent (không gửi trùng lặp thông báo)
      await notifyClassMinimums(sql);
      assert.deepEqual(await notices(), first, "repeat sweeps do not duplicate notifications");
      // Đảm bảo việc gửi cảnh báo không làm thay đổi trạng thái lớp và không sinh giao dịch hoàn tiền
      assert.deepEqual(await states(), before, "warnings never cancel or change a class");
      assert.deepEqual(await sql.query(
        `select p.id from payments p join enrollments e on p.ref_type = 'enrollment' and p.ref_id = e.id
          where e.class_id = any($1::uuid[])`, [ids],
      ), [], "warnings create no refunds");
      // Bước 8: Gọi API classesList kiểm tra hiển thị confirmed_count và cờ running_below_minimum
      const listed = await classesList(sql, new Request("http://localhost/classes"), toPublic(managers[0]));
      const listedItems = listed.body.items as Array<{ code: string; id: string; confirmed_count: number; running_below_minimum: boolean }>;
      for (const c of fixtures) {
        const row = listedItems.find((item) => item.id === c.id)!;
        assert.equal(row.confirmed_count, c.confirmed, c.name);
        assert.equal(row.running_below_minimum, c.running, c.name);
      }
      throw rollback;
    }), (error) => error === rollback);
  });
});

// ============================================================================
// Suite: G4 voluntary class departure - Rút lui tự nguyện khỏi lớp học
// ============================================================================
describe("G4 voluntary class departure", () => {
  /**
   * Làm gì: Kiểm tra nghiệp vụ G4 khi học viên tự nguyện hủy ghi danh khỏi lớp: giữ nguyên học phí đã đóng (không hoàn tiền) và tự động tạo offer nhường suất cho người đầu danh sách chờ (waitlist).
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>} Hoàn tất kiểm thử hoặc ném lỗi nếu sai kết quả
   */
  it("keeps paid tuition without a refund and offers the released seat to the waitlist", async () => {
    const rollback = new Error("Roll back G4 fixtures");
    await assert.rejects(withTx(async (sql) => {
      // Bước 1: Khởi tạo người dùng mẫu gồm 1 coach, 1 member chính thức và 1 member trong danh sách chờ
      const users = await sql.query<any>(
        `insert into users (full_name, name_normalized, role, password_hash, phone)
         select 'G4 ' || role, 'g4 ' || role, role::user_role, 'hash', substr(gen_random_uuid()::text, 1, 16)
           from unnest(array['coach','member','member']) role returning *`,
      );
      const coach = users.find((u) => u.role === "coach");
      const [member, waiting] = users.filter((u) => u.role === "member");
      // Bước 2: Tạo sân cầu lông và lớp học mở trong tương lai (không có lịch buổi tập để tránh bị chặn bởi mốc cutoff)
      const court = (await sql.query<{ id: string }>(
        `insert into courts (court_code, sport, status)
         values ('G4-' || substr(gen_random_uuid()::text, 1, 5), 'badminton', 'ready') returning id`,
      ))[0];
      // No scheduled session: this tests a permitted departure, independent of clock/cutoff.
      const cls = (await sql.query<{ id: string }>(
        `insert into classes (sport, level, coach_id, court_id, capacity, enrolled_count,
                              rrule, duration_min, start_on, end_on, status)
         values ('badminton','beginner',$1,$2,1,1,'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10',60,
                 '2099-01-01','2099-02-01','open') returning id`, [coach.id, court.id],
      ))[0];
      // Bước 3: Tạo bản ghi ghi danh (confirmed) cho học viên và vị trí thứ 1 trong waitlist cho học viên chờ
      const seat = (await sql.query<{ id: string }>(
        `insert into enrollments (class_id, user_id, status, price_vnd)
         values ($1,$2,'confirmed',300000) returning id`, [cls.id, member.id],
      ))[0];
      const queued = (await sql.query<{ id: string }>(
        `insert into enrollments (class_id, user_id, status, waitlist_pos)
         values ($1,$2,'waitlisted',1) returning id`, [cls.id, waiting.id],
      ))[0];
      // Bước 4: Tạo giao dịch thanh toán học phí 300.000 VNĐ ở trạng thái posted
      await sql.query(
        `insert into payments (code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id)
         values ('G4-' || substr(gen_random_uuid()::text, 1, 20),$1,'transfer',300000,0,'posted','enrollment',$2)`,
        [member.id, seat.id],
      );
      // Lưu trạng thái các bản ghi thanh toán trước khi hủy để đối chiếu
      const paymentsBefore = await sql.query(`select * from payments where user_id = $1`, [member.id]);
      // Bước 5: Học viên tự gọi API enrollmentDelete để rút khỏi lớp học
      const result = await enrollmentDelete(sql, seat.id, toPublic(member));
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { ok: true });
      // Bước 6: Kiểm tra các quy tắc nghiệp vụ: học phí không được hoàn lại, sĩ số lớp giảm về 0
      assert.deepEqual(await sql.query(`select * from payments where user_id = $1`, [member.id]), paymentsBefore);
      assert.deepEqual(await sql.query(`select status::text as status from enrollments where id = $1`, [seat.id]),
        [{ status: "cancelled" }]);
      assert.deepEqual(await sql.query(`select enrolled_count from classes where id = $1`, [cls.id]),
        [{ enrolled_count: 0 }]);
      // Suất vừa giải phóng phải tự động tạo ưu đãi (offer) trạng thái pending cho học viên đứng đầu danh sách chờ
      assert.deepEqual(await sql.query(
        `select enrollment_id, status::text as status from waitlist_offers
          where enrollment_id in ($1,$2)`, [seat.id, queued.id],
      ), [{ enrollment_id: queued.id, status: "pending" }]);
      throw rollback;
    }), (error) => error === rollback);
  });
});

// ============================================================================
// Suite: G3 centre-cancelled session refunds - Trung tâm hủy buổi tập và hoàn tiền
// ============================================================================
describe("G3 centre-cancelled session refunds", () => {
  /**
   * Làm gì: Tạo đối tượng Request giả lập yêu cầu HTTP POST kèm dữ liệu JSON chứa lý do hủy hoặc dời lịch buổi tập.
   * Được gọi ở: Các ca kiểm thử trong suite G3 centre-cancelled session refunds (tx.test.ts)
   * @param body Dữ liệu payload JSON gửi kèm trong body của Request (mặc định lý do hủy là "Court unavailable")
   * @returns {Request} Đối tượng Request hoàn chỉnh để truyền vào controller handler
   */
  const request = (body: Record<string, unknown> = { reason: "Court unavailable" }) =>
    new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  /**
   * Làm gì: Thiết lập dữ liệu mẫu (fixture) cho các ca kiểm thử G3: gồm tài khoản, sân, lớp học lặp lại, danh sách ghi danh với nhiều mức đóng tiền/hoàn tiền và các buổi tập.
   * Được gọi ở: Các ca kiểm thử trong suite G3 centre-cancelled session refunds (tx.test.ts: lines 654, 689, 699)
   * @param sql Client kết nối cơ sở dữ liệu trong transaction
   * @returns {Promise<{ manager: PublicUser; members: any[]; cls: { id: string }; seats: string[]; sessions: { id: string }[]; moveDay: string }>} Bộ dữ liệu phục vụ test
   */
  async function fixture(sql: Parameters<Parameters<typeof withTx>[0]>[0]) {
    // Use a Monday at least six weeks away, with fixed local session times.
    // No time-of-day cutoff or mocked global clock can affect these fixtures.
    const monday = new Date();
    monday.setUTCHours(0, 0, 0, 0);
    monday.setUTCDate(monday.getUTCDate() + 42 + (8 - monday.getUTCDay()) % 7);
    const day = (offset: number) => new Date(monday.getTime() + offset * 86400000).toISOString().slice(0, 10);
    // Bước 1: Tạo các người dùng gồm manager, coach và 6 members
    const users = await sql.query<any>(
      `insert into users (full_name, name_normalized, role, password_hash, phone)
       select 'G3 ' || role, 'g3 ' || role, role::user_role, 'hash', substr(gen_random_uuid()::text, 1, 16)
         from unnest(array['manager','coach','member','member','member','member','member','member']) role
       returning *`,
    );
    const manager = toPublic(users.find((u) => u.role === "manager"));
    const coach = users.find((u) => u.role === "coach");
    const members = users.filter((u) => u.role === "member");
    // Bước 2: Tạo sân cầu lông và lớp học mở lặp lại vào Thứ Hai hàng tuần trong 4 tuần (tổng cộng 5 buổi)
    const court = (await sql.query<{ id: string }>(
      `insert into courts (court_code, sport, status)
       values ('G3-' || substr(gen_random_uuid()::text, 1, 5), 'badminton', 'ready') returning id`,
    ))[0];
    // Five Mondays including both endpoints, but only two materialized sessions.
    const cls = (await sql.query<{ id: string }>(
      `insert into classes (sport, level, coach_id, court_id, capacity, rrule, duration_min, start_on, end_on, status)
       values ('badminton', 'beginner', $1, $2, 10, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10', 60,
               $3::date, $4::date, 'open') returning id`, [coach.id, court.id, day(0), day(28)],
    ))[0];
    // Bước 3: Tạo các bản ghi ghi danh (enrollments) cho 6 học viên với các mức học phí và trạng thái khác nhau
    const seats: string[] = [];
    const amounts = [110003, 50000, 0, 100000, 12347, 30000];
    for (const [i, member] of members.entries()) {
      const seat = (await sql.query<{ id: string }>(
        `insert into enrollments (class_id, user_id, status, price_vnd, extension_vnd, waitlist_pos)
         values ($1,$2,$3::enroll_status,$4,$5,case when $3 = 'waitlisted' then 1 else null end) returning id`,
        [cls.id, member.id, i === 3 ? 'waitlisted' : 'confirmed', i === 4 ? 100000 : amounts[i], i === 0 ? 10000 : 0],
      ))[0];
      seats.push(seat.id);
      // Ghi nhận khoản thu học phí ban đầu ở trạng thái posted
      if (amounts[i]) await sql.query(
        `insert into payments (code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id)
         values ('G3-' || substr(gen_random_uuid()::text, 1, 20),$1,'transfer',$2,0,'posted','enrollment',$3)`,
        [member.id, amounts[i], seat.id],
      );
    }
    // Bước 4: Thêm các giao dịch hoàn tiền mẫu (đã hoàn posted, đang chờ refund_pending) để thử giới hạn hoàn tiền tối đa (cap)
    for (const [index, amount, status] of [[1, -35000, 'posted'], [1, -12000, 'refund_pending'], [5, -30000, 'posted']] as const) {
      await sql.query(
        `insert into payments (code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id)
         values ('G3-' || substr(gen_random_uuid()::text, 1, 20),$1,'cash',$2,0,$3::pay_status,'enrollment',$4)`,
        [members[index].id, amount, status, seats[index]],
      );
    }
    // Bước 5: Khởi tạo 2 buổi tập (sessions) gắn liền với lịch chiếm dụng sân (occupancies)
    const sessions = await sql.query<{ id: string }>(
      `with occupied as (
         insert into occupancies (court_id, start_at, end_at, kind, ref_id)
         select $2,d,d + interval '1 hour','session',gen_random_uuid()
           from unnest(array[$3::timestamptz,$4::timestamptz]) d
         returning id, ref_id, start_at, end_at
       ) insert into sessions (id, class_id, court_id, start_at, end_at, status, occupancy_id)
         select ref_id,$1,$2,start_at,end_at,'scheduled',id from occupied returning id`,
      [cls.id, court.id, `${day(0)}T10:00:00+07:00`, `${day(7)}T10:00:00+07:00`],
    );
    return { manager, members, cls, seats, sessions, moveDay: day(1) };
  }

  /**
   * Làm gì: Kiểm tra việc hủy buổi tập bởi trung tâm: tính toán tiền hoàn thực tế theo tỷ lệ số buổi lặp lại, chặn hoàn vượt trần (cap), và ngăn chặn hủy lặp lại (idempotent).
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>} Hoàn tất kiểm thử hoặc ném lỗi nếu kết quả kiểm tra không khớp
   */
  it("refunds actual tuition over the full recurrence, caps posted and pending returns, and rejects repeat cancellation", async () => {
    await withTx(async (sql) => {
      // Bước 1: Khởi tạo bộ dữ liệu mẫu cho bài test
      const { manager, members, seats, sessions } = await fixture(sql);
      // Bước 2: Manager gọi sessionCancel để hủy buổi tập đầu tiên
      const result = await sessionCancel(sql, sessions[0].id, request(), manager);
      assert.deepEqual(result.body, { ok: true, notified: 5, refunded: 3, refunded_vnd: 25469 });
      // Bước 3: Kiểm tra các bản ghi hoàn tiền (status = 'refund_pending') được tạo ra trong bảng payments
      const refunds = await sql.query<any>(
        `select ref_id, amount_vnd, method, status, shift_id, created_by from payments
          where ref_id = any($1::uuid[]) and status = 'refund_pending' and amount_vnd <> -12000`, [seats],
      );
      assert.equal(refunds.length, 3);
      // Số tiền hoàn được chia đều theo tỷ lệ số buổi trong chuỗi (trừ phụ phí, không vượt quá số tiền thực trả sau khi trừ các khoản đã hoàn)
      for (const [index, amount] of [[0, -20000], [1, -3000], [4, -2469]]) {
        assert.deepEqual(refunds.find((r) => r.ref_id === seats[index]), {
          ref_id: seats[index], amount_vnd: amount, method: 'cash', status: 'refund_pending', shift_id: null, created_by: null,
        });
      }
      // Bước 4: Kiểm tra thông báo gửi tới outbox cho các học viên bị hủy buổi tập
      const notifications = await sql.query<any>(
        `select user_id, payload from outbox where template = 'class_changed' and payload->>'session_id' = $1`, [sessions[0].id],
      );
      for (const [index, amount] of [[0, 20000], [1, 3000], [2, 0], [4, 2469], [5, 0]]) {
        const notification = notifications.find((n) => n.user_id === members[index].id);
        assert.equal(notification.payload.kind, 'session_cancelled');
        assert.equal(notification.payload.refund_vnd, amount);
      }
      // Học viên trong danh sách chờ (waitlist) không có lịch học nên không nhận thông báo hủy ca
      assert.equal(notifications.some((n) => n.user_id === members[3].id), false);
      // Bước 5: Thử hủy lại buổi tập vừa hủy; hệ thống phải ném lỗi xung đột trạng thái (CONFLICT_STATE)
      await assert.rejects(sessionCancel(sql, sessions[0].id, request(), manager), { code: 'CONFLICT_STATE' });
      // Bước 6: Hủy buổi tập thứ 2 và kiểm tra số tiền hoàn không vượt quá mức trần tối đa đã thanh toán
      const second = await sessionCancel(sql, sessions[1].id, request(), manager);
      assert.equal(second.body.refunded, 2);
      assert.equal(second.body.refunded_vnd, 22469);
      // Tổng tiền đã hoàn (gồm cả refund_pending và posted) không bao giờ được vượt quá tổng thu ban đầu (50.000 VNĐ)
      const capped = await sql.query<{ returned: number }>(
        `select sum(-amount_vnd)::int as returned from payments where ref_id = $1 and amount_vnd < 0`, [seats[1]],
      );
      assert.equal(capped[0].returned, 50000);
    });
  });

  /**
   * Làm gì: Kiểm tra trường hợp biên khi lớp học có chuỗi lặp không sinh ra buổi nào trong khoảng start_on - end_on, hệ thống dự phòng chia theo tối thiểu 1 buổi kế hoạch.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>} Hoàn tất kiểm thử hoặc ném lỗi nếu kết quả không khớp
   */
  it("uses at least one planned session when the recurrence has no occurrences", async () => {
    await withTx(async (sql) => {
      // Bước 1: Khởi tạo dữ liệu mẫu
      const { manager, cls, sessions, moveDay } = await fixture(sql);
      // Bước 2: Cập nhật ngày bắt đầu và kết thúc của lớp trùng nhau vào ngày không trùng lịch rrule (không sinh ra buổi lặp nào)
      await sql.query(`update classes set start_on = $2::date, end_on = $2::date where id = $1`, [cls.id, moveDay]);
      // Bước 3: Hủy buổi tập và kiểm tra tiền hoàn được tính dựa trên số buổi tối thiểu là 1
      const result = await sessionCancel(sql, sessions[0].id, request(), manager);
      assert.equal(result.body.refunded, 3);
      assert.equal(result.body.refunded_vnd, 115350);
    });
  });

  /**
   * Làm gì: Kiểm tra nghiệp vụ dời lịch buổi tập (sessionReschedule): chỉ đổi thời gian tổ chức, không tác động hay phát sinh hoàn tiền/thay đổi bảng payments.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>} Hoàn tất kiểm thử hoặc ném lỗi nếu kết quả không khớp
   */
  it("moving a session leaves payments unchanged", async () => {
    await withTx(async (sql) => {
      // Bước 1: Khởi tạo dữ liệu mẫu và sao lưu danh sách thanh toán hiện tại
      const { manager, seats, sessions, moveDay } = await fixture(sql);
      const before = await sql.query(`select * from payments where ref_id = any($1::uuid[]) order by id`, [seats]);
      // Bước 2: Manager gọi sessionReschedule để dời lịch buổi tập sang ngày khác
      const result = await sessionReschedule(sql, sessions[0].id,
        request({ start_at: `${moveDay}T10:00:00+07:00`, reason: 'Move only' }), manager);
      // Bước 3: Xác minh đổi lịch thành công (200) và toàn bộ bản ghi payments vẫn giữ nguyên
      assert.equal(result.status, 200);
      assert.deepEqual(await sql.query(`select * from payments where ref_id = any($1::uuid[]) order by id`, [seats]), before);
    });
  });
});

// ============================================================================
// Suite: G2 certificates and G7 Progress attendance - Cấp chứng chỉ & Điểm danh
// ============================================================================
describe("G2 certificates and G7 Progress attendance", () => {
  /**
   * Làm gì: Thiết lập dữ liệu mẫu cho bài kiểm tra chứng chỉ G2 và điểm danh G7: tạo hội viên, lớp học, buổi tập và dữ liệu điểm danh (present, late, absent).
   * Được gọi ở: Các ca kiểm thử trong suite G2 certificates and G7 Progress attendance (tx.test.ts: lines 758, 789)
   * @param sql Client kết nối cơ sở dữ liệu trong transaction
   * @returns {Promise<{ member: PublicUser; cls: { id: string }; enrollment: { id: string }; sessions: { id: string }[] }>} Dữ liệu mẫu khởi tạo
   */
  async function fixture(sql: Parameters<Parameters<typeof withTx>[0]>[0]) {
    // Bước 1: Tạo tài khoản member và coach thử nghiệm
    const users = await sql.query<any>(
      `insert into users (full_name, name_normalized, role, password_hash, phone)
       values ('G2 Member', 'g2 member', 'member', 'hash', substr(gen_random_uuid()::text, 1, 16)),
              ('G2 Coach', 'g2 coach', 'coach', 'hash', substr(gen_random_uuid()::text, 1, 16)) returning *`,
    );
    const member = toPublic(users.find((u) => u.role === 'member'));
    const coach = users.find((u) => u.role === 'coach');
    // Bước 2: Tạo sân, lớp học cầu lông và bản ghi ghi danh (confirmed) cho member
    const court = (await sql.query<{ id: string }>(
      `insert into courts (court_code, sport, status)
       values ('G2-' || substr(gen_random_uuid()::text, 1, 5), 'badminton', 'ready') returning id`,
    ))[0];
    const cls = (await sql.query<{ id: string }>(
      `insert into classes (sport, level, coach_id, court_id, capacity, rrule, duration_min, start_on, end_on, status)
       values ('badminton', 'beginner', $1, $2, 10, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10', 60,
         (now() at time zone 'Asia/Ho_Chi_Minh')::date - 30,
         (now() at time zone 'Asia/Ho_Chi_Minh')::date + 1, 'open') returning id`,
      [coach.id, court.id],
    ))[0];
    const enrollment = (await sql.query<{ id: string }>(
      `insert into enrollments (class_id, user_id, status) values ($1, $2, 'confirmed') returning id`,
      [cls.id, member.id],
    ))[0];
    // Bước 3: Tạo 5 buổi tập trong quá khứ đã hoàn thành (done)
    const sessions = await sql.query<{ id: string }>(
      `insert into sessions (class_id, court_id, start_at, end_at, status)
       select $1, $2, now() - n * interval '1 day', now() - n * interval '1 day' + interval '1 hour', 'done'
       from generate_series(2, 6) n returning id`, [cls.id, court.id],
    );
    // Bước 4: Điểm danh cho member theo từng buổi (1 buổi late, 3 buổi present, 1 buổi absent)
    for (const [i, session] of sessions.entries()) {
      await sql.query(
        `insert into attendance (kind, user_id, session_id, result)
         values ('session', $1, $2, $3::att_result)`,
        [member.id, session.id, i === 0 ? 'late' : i === 4 ? 'absent' : 'present'],
      );
    }
    return { member, cls, enrollment, sessions };
  }

  /**
   * Làm gì: Kiểm tra điều kiện cấp chứng chỉ hoàn thành khóa học (G2): lớp học phải kết thúc trước ngày hôm nay theo múi giờ Việt Nam mới đủ điều kiện cấp chứng chỉ.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>} Hoàn tất kiểm thử hoặc ném lỗi nếu điều kiện cấp chứng chỉ bị vi phạm
   */
  it("G2: generated sessions alone cannot qualify a class ending today or later in Vietnam", async () => {
    // Bước 1: Import động các handler chứng chỉ meCertificates và meCertificateIssue
    const { meCertificates, meCertificateIssue } = await import('./handlers/certificates.ts');
    await withTx(async (sql) => {
      // Keep the database session date different from Vietnam's date at any hour.
      const { zone } = (await sql.query<{ zone: string }>(
        `select case when (now() at time zone 'Pacific/Honolulu')::date
           <> (now() at time zone 'Asia/Ho_Chi_Minh')::date
         then 'Pacific/Honolulu' else 'Pacific/Kiritimati' end as zone`,
      ))[0];
      await sql.query(`select set_config('TimeZone', $1, true)`, [zone]);
      // Bước 2: Thiết lập dữ liệu mẫu hội viên và các buổi tập
      const { member, cls, enrollment } = await fixture(sql);
      // Bước 3: Duyệt qua các độ lệch ngày kết thúc lớp (ngày mai offset +1, hôm nay offset 0, hôm qua offset -1)
      for (const offset of [1, 0, -1]) {
        await sql.query(
          `update classes set end_on = (now() at time zone 'Asia/Ho_Chi_Minh')::date + $2::int where id = $1`,
          [cls.id, offset],
        );
        // Lấy danh sách chứng chỉ và kiểm tra: chỉ khi lớp kết thúc trước hôm nay (offset < 0) mới đủ điều kiện (eligible = true)
        const listed = (await meCertificates(sql, member)).body.items[0];
        assert.equal(listed.remaining, 0);
        assert.equal(listed.sessions, 5);
        assert.equal(listed.attended, 4);
        assert.equal(listed.eligible, offset < 0);
        // Bước 4: Nếu lớp chưa kết thúc (offset >= 0), từ chối cấp chứng chỉ (CONFLICT_STATE)
        if (offset >= 0) {
          await assert.rejects(meCertificateIssue(sql, enrollment.id, member), {
            code: 'CONFLICT_STATE', message: 'The class is not over yet.',
          });
          assert.equal((await sql.query(`select 1 from class_certificates where enrollment_id = $1`, [enrollment.id])).length, 0);
        } else {
          // Bước 5: Khi lớp đã kết thúc trong quá khứ (offset < 0), cấp chứng chỉ thành công và kiểm tra tính idempotent khi gọi lại
          const issued = await meCertificateIssue(sql, enrollment.id, member);
          assert.equal(issued.status, 201);
          assert.ok(issued.body.code);
          assert.deepEqual((await meCertificateIssue(sql, enrollment.id, member)).body, issued.body);
        }
      }
    });
  });

  /**
   * Làm gì: Kiểm tra tiến độ tập luyện của hội viên (G7): số buổi hoàn thành tính cả có mặt (present) và đi muộn (late), loại trừ vắng mặt (absent) và buổi bị hủy (cancelled).
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>} Hoàn tất kiểm thử hoặc ném lỗi nếu kết quả tính buổi không chính xác
   */
  it("G7: Progress counts present and late sessions without coach results, excluding absent and cancelled", async () => {
    // Bước 1: Import handler meTraining và kích hoạt cờ tính năng F4
    const { meTraining } = await import('./handlers/training.ts');
    await withTx(async (sql) => {
      await sql.query(`insert into feature_flags (key, enabled) values ('F4', true)
        on conflict (key) do update set enabled = true`);
      // Bước 2: Khởi tạo dữ liệu mẫu và xác nhận số buổi hoàn thành ban đầu là 4 (3 present + 1 late)
      const { member, sessions } = await fixture(sql);
      assert.equal((await meTraining(sql, member)).body.completed_sessions, 4);
      // Bước 3: Đổi trạng thái 1 buổi sang cancelled để kiểm tra số buổi hoàn thành tự động giảm xuống 3
      await sql.query(`update sessions set status = 'cancelled' where id = $1`, [sessions[1].id]);
      const progress = (await meTraining(sql, member)).body;
      assert.equal(progress.completed_sessions, 3);
      assert.equal(progress.results.length, 0);
    });
  });
});

// ============================================================================
// Suite: Gợi ý giáo án AI - Tự động chuẩn hóa và xuất bản không cần sửa tay
// ============================================================================
describe("training suggestions publish without manual edits", () => {
  for (const mode of ["ai", "unavailable", "invalid-json"] as const) {
    /**
     * Làm gì: Kiểm tra luồng gợi ý giáo án tập luyện (trainingSuggest) từ AI hoặc fallback, tự động chuẩn hóa các block (pha, cường độ, thời gian) và xuất bản qua trainingCreate.
     * Được gọi ở: test runner (node --test)
     * @param t Context kiểm thử từ test runner, cung cấp mock method
     * @returns {Promise<void>} Hoàn tất kiểm thử hoặc ném lỗi nếu gợi ý không hợp lệ
     */
    it(`publishes ${mode} suggestions through trainingCreate`, async (t) => {
      // Bước 1: Thiết lập biến môi trường API key và mock hàm fetch toàn cục để giả lập phản hồi từ Gemini API
      const original = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = "test-training-suggestion";
      t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        // Kiểm tra cấu hình bắt buộc: định dạng application/json và tắt thinking budget để giảm độ trễ phản hồi
        assert.equal(body.generationConfig.responseMimeType, "application/json");
        // Thinking off, in the form the model takes: thinkingLevel on Gemini 3+, thinkingBudget before.
        const model = String(url).match(/models\/([^:]+):/)?.[1] ?? "";
        assert.deepEqual(body.generationConfig.thinkingConfig, thinkingOffConfig(model));
        for (const value of [...PLAN_PHASES, ...INTENSITIES]) assert.ok(body.systemInstruction.parts[0].text.includes(value));
        if (mode === "unavailable") return new Response("unavailable", { status: 503 });
        // Chuẩn bị danh sách blocks bài tập mẫu chứa dữ liệu bất thường (Infinity, số âm, text quá dài) để kiểm tra bộ lọc làm sạch
        const blocks = [
          { title: " Khởi động ", minutes: "Infinity", phase: "invalid", intensity: "invalid" },
          { title: "Kỹ thuật", minutes: 12.5, phase: "technique", intensity: "hard", description: "d".repeat(700), equipment: "e".repeat(250), target: "t".repeat(250) },
          { title: "Thả lỏng", minutes: -4, phase: null, description: " " },
          null, [], { title: " " },
        ];
        return Response.json({ candidates: [{ content: { parts: [{ text: mode === "invalid-json" ? "not JSON" : JSON.stringify(blocks) }] } }] });
      });
      try {
        // Bước 2: Bắt đầu giao dịch cơ sở dữ liệu để kiểm tra logic nghiệp vụ gợi ý và tạo giáo án
        await withTx(async (sql) => {
          // Bật cờ tính năng F4 và F5 cho phép sử dụng module giáo án AI
          await sql.query("insert into feature_flags (key, enabled) values ('F4', true), ('F5', true) on conflict (key) do update set enabled = true");
          const coach = toPublic((await sql.query("select * from users where role = 'coach' limit 1"))[0] as any);
          const classId = (await sql.query<{ id: string }>(`insert into classes (sport, level, coach_id, court_id, capacity, rrule, duration_min, start_on, end_on, status)
            values ('badminton', 'beginner', $1, (select id from courts where sport='badminton' limit 1), 10, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10', 60, '2026-01-01', '2026-12-31', 'open') returning id`, [coach.id]))[0].id;
          // Bước 3: Coach gửi yêu cầu gợi ý giáo án tập luyện qua API /v1/training-plans/suggest
          const suggestion = await opsH.trainingSuggest(sql, new Request("http://localhost/v1/training-plans/suggest", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ sport: "badminton", level: "beginner", prompt: "Tập kỹ thuật cầu lông" }),
          }), coach);
          // Xác nhận cờ ai phản ánh đúng chế độ (true khi AI thành công, false khi fallback về mẫu do lỗi kết nối hoặc JSON hỏng)
          assert.equal(suggestion.body.ai, mode === "ai");
          const payload = suggestion.body.payload!;
          // Bước 4: Xác thực các block bài tập đã được chuẩn hóa (pha đầu là warm-up, pha cuối là cool-down, giới hạn độ dài ký tự)
          assert.equal(payload.blocks[0].phase, "warm-up");
          assert.equal(payload.blocks.at(-1)!.phase, "cool-down");
          for (const block of payload.blocks) {
            assert.ok(PLAN_PHASES.includes(block.phase));
            assert.ok(INTENSITIES.includes(block.intensity));
            assert.ok(block.description.length > 0 && block.description.length <= 600);
            assert.ok(block.equipment.length > 0 && block.equipment.length <= 200);
            assert.ok(block.target.length > 0 && block.target.length <= 200);
          }
          // Ở chế độ AI thành công: kiểm tra các giá trị lỗi đã được chuyển đổi về giá trị hợp lệ mặc định (10 phút, cường độ medium)
          if (mode === "ai") {
            assert.equal(payload.blocks[0].minutes, 10);
            assert.equal(payload.blocks[0].intensity, "medium");
            assert.equal(payload.blocks[1].intensity, "hard");
            assert.equal(payload.blocks[1].minutes, 13);
            assert.equal(payload.blocks[1].description.length, 600);
          }
          // Bước 5: Đăng xuất bản giáo án đã gợi ý (không cần chỉnh sửa thủ công) qua API trainingCreate
          const published = await trainingCreate(sql, new Request("http://localhost/v1/training-plans", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ class_id: classId, source: "ai", published: true, payload }),
          }), coach);
          assert.equal(published.status, 201);
          // Bước 6: Kiểm tra giáo án lưu trong cơ sở dữ liệu có cờ published = true và cấu trúc payload khớp với gợi ý
          const saved = (await sql.query<{ published: boolean; payload: unknown }>("select published, payload from training_plans where id=$1", [published.body.id]))[0];
          assert.equal(saved.published, true);
          assert.deepEqual((saved.payload as { blocks: unknown }).blocks, payload.blocks);
          // Bước 7: Dọn dẹp dữ liệu kiểm thử (xóa giáo án và lớp học đã tạo)
          await sql.query("delete from training_plans where class_id=$1", [classId]);
          await sql.query("delete from classes where id=$1", [classId]);
        });
      } finally {
        if (original === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = original;
      }
    });
  }
});

/**
 * Làm gì: Khởi tạo database PGlite in-memory và chạy toàn bộ migration SQL trước khi thực hiện các bài test trong file.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
before(async () => {
  // Bước 1: Khởi tạo instance database PGlite in-memory mới và chờ database sẵn sàng
  db = new PGlite();
  await db.waitReady;
  // Bước 2: Đọc danh sách tất cả các file migration .sql theo thứ tự và thực thi vào database để tạo cấu trúc bảng
  const migDir = "migrations";
  const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sqlContent = readFileSync(join(migDir, f), "utf8");
    await db.exec(sqlContent);
  }
  // Bước 3: Đăng ký instance db này làm override cho các handler chạy qua withTx
  setOverridePglite(db);
});

/**
 * Làm gì: Dọn dẹp override database PGlite sau khi các ca kiểm thử trong suite hoàn tất, khôi phục kết nối mặc định.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
after(() => {
  // Hủy ghi đè PGlite, trả kết nối về null để không làm ảnh hưởng đến các bộ test chạy phía sau
  setOverridePglite(null);
});

/**
 * Làm gì: Nhóm các ca kiểm thử đơn vị cho withTx và KeepWrites, đảm bảo transaction commit hoặc rollback đúng theo loại lỗi ném ra.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("withTx & KeepWrites unit tests", () => {
  /**
   * Làm gì: Kiểm tra cơ chế KeepWrites trong withTx: commit dữ liệu đã ghi vào DB trước khi ném lại lỗi bên trong (inner error).
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("commits writes when KeepWrites is thrown, and rethrows inner error", async () => {
    // Bước 1: Tạo bảng tạm _tx_test để phục vụ kiểm tra commit/rollback của transaction
    await db.query("create table if not exists _tx_test (id serial primary key, note text);");

    // Bước 2: Chuẩn bị inner error và thực thi withTx ném KeepWrites
    const inner = new Error("custom inner error");
    await assert.rejects(
      async () => {
        await withTx(async (sql) => {
          await sql.query("insert into _tx_test (note) values ($1)", ["survived_keep_writes"]);
          // KeepWrites báo hiệu withTx commit transaction thay vì rollback dù vẫn ném lỗi ra ngoài
          throw new KeepWrites(inner);
        });
      },
      // Xác minh withTx đã unwrap KeepWrites và trả về chính xác lỗi gốc (inner error)
      (err: any) => {
        assert.equal(err, inner);
        assert.equal(err instanceof KeepWrites, false);
        return true;
      }
    );

    // Bước 3: Kiểm tra dòng dữ liệu vẫn tồn tại trong DB, xác nhận transaction đã commit thành công
    const rows = await db.query("select * from _tx_test where note = 'survived_keep_writes'");
    assert.equal(rows.rows.length, 1);
  });

  /**
   * Làm gì: Kiểm tra withTx sẽ rollback toàn bộ thay đổi dữ liệu khi gặp Error thông thường (không phải KeepWrites).
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("rolls back writes when a normal error is thrown", async () => {
    // Bước 1: Đảm bảo bảng tạm _tx_test đã sẵn sàng
    await db.query("create table if not exists _tx_test (id serial primary key, note text);");

    // Bước 2: Thực thi withTx và ném lỗi thông thường để kích hoạt cơ chế rollback
    const normal = new Error("regular rollback error");
    await assert.rejects(
      async () => {
        await withTx(async (sql) => {
          await sql.query("insert into _tx_test (note) values ($1)", ["should_be_rolled_back"]);
          throw normal;
        });
      },
      (err: any) => {
        assert.equal(err, normal);
        return true;
      }
    );

    // Bước 3: Kiểm tra database xác nhận không có dòng dữ liệu nào được lưu do transaction đã bị rollback
    const rows = await db.query("select * from _tx_test where note = 'should_be_rolled_back'");
    assert.equal(rows.rows.length, 0);
  });

  /**
   * Làm gì: Kiểm tra nghiệp vụ khóa tài khoản sau 5 lần nhập sai mật khẩu liên tiếp, cập nhật số lần failed_logins và thời điểm locked_until nhờ KeepWrites.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("5 consecutive wrong password attempts locks account and preserves counter", async () => {
    // Bước 1: Khởi tạo tài khoản người dùng test với failed_logins = 0 và locked_until = null
    const testPhone = "+84999888777";
    await db.query(`
      insert into users (id, phone, full_name, name_normalized, role, status, password_hash, failed_logins)
      values (
        '99999999-0000-0000-0000-000000000001',
        $1,
        'Test Lockout User',
        'test lockout user',
        'member',
        'active',
        '$2b$10$wE4Q1i5s88xV83rGzLqWdOBiK7GjBvhVv6U1X7r2H5P1G8z123456',
        0
      )
      on conflict (phone) do update set failed_logins = 0, locked_until = null
    `, [testPhone]);

    // 4 wrong passwords -> 401 UNAUTHORIZED, failed_logins increases 1..4
    for (let i = 1; i <= 4; i++) {
      // Bước 2: Thử đăng nhập sai mật khẩu lần thứ i, kỳ vọng trả về 401 UNAUTHORIZED
      const req = new Request("http://localhost/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: testPhone, password: "WrongPassword!123" }),
      });

      await assert.rejects(
        async () => {
          await withTx(async (sql) => authH.login(sql, req));
        },
        (err: any) => {
          assert.equal(err.status, 401);
          return true;
        }
      );

      // Kiểm tra failed_logins trong DB được lưu bền vững (nhờ KeepWrites) tăng tương ứng 1..4 và chưa bị khóa
      const r = await db.query<{ failed_logins: number; locked_until: string | null }>(
        "select failed_logins, locked_until from users where phone = $1",
        [testPhone]
      );
      assert.equal(r.rows[0].failed_logins, i);
      assert.equal(r.rows[0].locked_until, null);
    }

    // 5th wrong password -> 429 RATE_LIMITED, locked_until is set
    // Bước 3: Đăng nhập sai lần thứ 5 để kích hoạt ngưỡng khóa tài khoản
    const req5 = new Request("http://localhost/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: testPhone, password: "WrongPassword!123" }),
    });

    // Khi đạt 5 lần sai liên tiếp, hệ thống phải chặn và trả về 429 RATE_LIMITED
    await assert.rejects(
      async () => {
        await withTx(async (sql) => authH.login(sql, req5));
      },
      (err: any) => {
        assert.equal(err.status, 429);
        return true;
      }
    );

    // Bước 4: Kiểm tra database xác nhận failed_logins = 5 và locked_until đã được gán mốc thời gian khóa
    const r5 = await db.query<{ failed_logins: number; locked_until: string | null }>(
      "select failed_logins, locked_until from users where phone = $1",
      [testPhone]
    );
    assert.equal(r5.rows[0].failed_logins, 5);
    assert.notEqual(r5.rows[0].locked_until, null);
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho hàm readJson, kiểm tra tính hợp lệ của request body JSON, xử lý chuỗi rỗng và lọc ký tự NUL độc hại.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("readJson unit tests", () => {
  /**
   * Làm gì: Tạo đối tượng Request giả lập với content-type application/json và body truyền vào để kiểm thử readJson.
   * Được gọi ở: Các ca kiểm thử trong suite "readJson unit tests"
   * @param body Chuỗi raw JSON body cần đưa vào request
   * @returns {Request} Đối tượng Request chuẩn của web platform
   */
  const reqOf = (body?: string) =>
    new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

  /**
   * Làm gì: Kiểm tra readJson từ chối các kiểu dữ liệu nguyên thủy (primitive) hoặc null với mã lỗi 422 VALIDATION.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("throws validation error for null and primitives", async () => {
    // Bước 1: Duyệt qua các giá trị raw không phải object hoặc array: null, number, string, boolean
    for (const raw of ["null", "5", '"x"', "true"]) {
      // Bước 2: Xác nhận hàm ném lỗi 422 VALIDATION yêu cầu body phải là JSON object
      await assert.rejects(
        async () => readJson(reqOf(raw)),
        (err: any) => {
          assert.equal(err.status, 422);
          assert.equal(err.code, "VALIDATION");
          assert.equal(err.message, "Request body must be a JSON object.");
          return true;
        }
      );
    }
  });

  /**
   * Làm gì: Kiểm tra readJson cho phép và giữ nguyên mảng JSON rỗng hoặc mảng chứa phần tử hợp lệ.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("returns arrays as-is for [] and [{\"a\":1}]", async () => {
    // Bước 1: Kiểm tra mảng rỗng [] được parse thành công và giữ nguyên định dạng
    const emptyArr = await readJson(reqOf("[]"));
    assert.deepEqual(emptyArr, []);

    // Bước 2: Kiểm tra mảng chứa đối tượng [{ a: 1 }] được parse nguyên vẹn
    const filledArr = await readJson(reqOf('[{"a":1}]'));
    assert.deepEqual(filledArr, [{ a: 1 }]);
  });

  /**
   * Làm gì: Kiểm tra readJson trả về đối tượng rỗng {} khi request body là chuỗi rỗng.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("returns empty object for empty body", async () => {
    // Khi request body rỗng, hàm trả về đối tượng {} mặc định thay vì báo lỗi parse JSON
    const res = await readJson(reqOf(""));
    assert.deepEqual(res, {});
  });

  /**
   * Làm gì: Kiểm tra readJson chặn ký tự NUL (\u0000) trong string value, mảng lồng nhau hoặc object key để chống SQL injection và memory corruption.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("rejects NUL byte in string value, nested array, or object key", async () => {
    // Bước 1: Chuẩn bị danh sách các payload chứa byte NUL độc hại ở nhiều vị trí khác nhau
    const cases = [
      '{"a":"x\\u0000y"}',
      '{"a":["\\u0000"]}',
      '{"bad\\u0000key":1}',
    ];
    // Bước 2: Xác nhận mọi trường hợp chứa ký tự NUL đều bị từ chối với lỗi 422 VALIDATION
    for (const raw of cases) {
      await assert.rejects(
        async () => readJson(reqOf(raw)),
        (err: any) => {
          assert.equal(err.status, 422);
          assert.equal(err.code, "VALIDATION");
          assert.equal(err.message, "Text must not contain NUL characters.");
          return true;
        }
      );
    }
  });

  /**
   * Làm gì: Kiểm tra readJson parse thành công payload JSON object thông thường với đầy đủ các kiểu dữ liệu hợp lệ.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("returns normal object as-is", async () => {
    // Parse JSON object chứa các trường chuỗi, số và boolean rồi xác nhận kết quả khớp hoàn toàn
    const res = await readJson(reqOf('{"name":"Tennis Court","price":100000,"active":true}'));
    assert.deepEqual(res, { name: "Tennis Court", price: 100000, active: true });
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử tính toàn vẹn khóa ngoại (FK) và vai trò người dùng khi tạo lớp học (F-24, F-25, F-18, F-21).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("foreign keys & subscription role unit tests (Vòng 3: F-24, F-25, F-18, F-21)", () => {
  const managerUser = { id: "00000000-0000-0000-0000-000000000001", role: "manager" } as any;
  const receptionistUser = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist" } as any;
  const coachUser = { id: "00000000-0000-0000-0000-000000000003", role: "coach" } as any;
  const memberUser = { id: "00000000-0000-0000-0000-000000000004", role: "member" } as any;

  const validCourtId = "10000000-0000-0000-0000-000000000001";
  const nonexistentId = "99999999-9999-4999-8999-999999999999";
  const asstCoachId = "00000000-0000-0000-0000-000000000005";

  /**
   * Làm gì: Khởi tạo dữ liệu người dùng mẫu (HLV Phụ với vai trò coach) để dùng cho các ca test trợ giảng.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  before(async () => {
    // Chèn tài khoản HLV phụ vào bảng users nếu chưa tồn tại
    await db.query(`
      insert into users (id, full_name, name_normalized, phone, role, status, password_hash, pii_consent_at)
      values ($1, 'HLV Phu', 'hlv phu', '+84900000005', 'coach', 'active', 'hash', now())
      on conflict (id) do nothing
    `, [asstCoachId]);
  });

  /**
   * Làm gì: Tạo đối tượng payload mặc định để gọi API classesCreate, cho phép ghi đè các trường cần test.
   * Được gọi ở: Các ca kiểm thử tạo lớp học trong suite kiểm tra khóa ngoại
   * @param overrides Đối tượng chứa các trường cần ghi đè lên dữ liệu mặc định
   * @returns {Record<string, unknown>} Payload dữ liệu tạo lớp học
   */
  const classBody = (overrides = {}) => ({
    sport: "badminton",
    level: "beginner",
    coach_id: coachUser.id,
    court_id: validCourtId,
    rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9",
    start_on: "2027-11-01",
    end_on: "2027-11-30",
    duration_min: 60,
    capacity: 10,
    ...overrides,
  });

  // 1. sân không tồn tại (nonexistent court_id -> 400 field: court_id)
  /**
   * Làm gì: Kiểm tra classesCreate từ chối tạo lớp học khi court_id không tồn tại trong database, trả về mã lỗi 400 và field chỉ định là court_id.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("rejects nonexistent court_id with 400", async () => {
    // Bước 1: Chuẩn bị request tạo lớp học với court_id không tồn tại trong DB
    const req = new Request("http://localhost/v1/classes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(classBody({ court_id: nonexistentId })),
    });
    // Bước 2: Gọi classesCreate và kiểm tra lỗi 400 bad request trỏ đúng vào trường court_id
    await assert.rejects(
      async () => withTx(async (sql) => classesCreate(sql, req, managerUser)),
      (err: any) => {
        assert.equal(err.status, 400);
        assert.equal(err.extra?.field, "court_id");
        return true;
      }
    );
  });

  // 2. trợ giảng không tồn tại (nonexistent assistant_id -> 400 field: assistant_id)
  /**
   * Làm gì: Kiểm tra classesCreate từ chối khi assistant_id không tồn tại trong hệ thống, trả về mã lỗi 400 và field là assistant_id.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("rejects nonexistent assistant_id with 400", async () => {
    // Bước 1: Chuẩn bị request tạo lớp với assistant_id là ID không tồn tại
    const req = new Request("http://localhost/v1/classes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(classBody({ assistant_id: nonexistentId })),
    });
    // Bước 2: Xác nhận API ném lỗi 400 với thông tin lỗi ở trường assistant_id
    await assert.rejects(
      async () => withTx(async (sql) => classesCreate(sql, req, managerUser)),
      (err: any) => {
        assert.equal(err.status, 400);
        assert.equal(err.extra?.field, "assistant_id");
        return true;
      }
    );
  });

  // 3. trợ giảng là member (assistant is member -> 400 field: assistant_id)
  /**
   * Làm gì: Kiểm tra nghiệp vụ không cho phép người dùng có role member làm trợ giảng lớp học, trả về lỗi 400.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("rejects member as assistant_id with 400", async () => {
    // Bước 1: Gửi request với assistant_id là ID của một hội viên thông thường (member)
    const req = new Request("http://localhost/v1/classes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(classBody({ assistant_id: memberUser.id })),
    });
    // Bước 2: Xác nhận hệ thống chặn lại với lỗi 400 vì trợ giảng phải có vai trò coach
    await assert.rejects(
      async () => withTx(async (sql) => classesCreate(sql, req, managerUser)),
      (err: any) => {
        assert.equal(err.status, 400);
        assert.equal(err.extra?.field, "assistant_id");
        return true;
      }
    );
  });

  // 4. trợ giảng hợp lệ (vẫn tạo được) (assistant is coach -> creates class)
  /**
   * Làm gì: Kiểm tra tạo lớp học thành công (HTTP 201) khi assistant_id là người dùng có role coach hợp lệ.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("creates class when assistant is coach", async () => {
    // Bước 1: Gửi request tạo lớp học với trợ giảng là HLV (coach) hợp lệ
    const req = new Request("http://localhost/v1/classes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(classBody({ assistant_id: asstCoachId })),
    });
    // Bước 2: Thực thi classesCreate và xác nhận trả về mã trạng thái 201 Created
    const res = await withTx(async (sql) => classesCreate(sql, req, managerUser));
    assert.equal(res.status, 201);
  });

});

/**
 * Làm gì: Nhóm các ca kiểm thử phân quyền (authorization) và thứ tự kiểm tra vai trò người dùng (F-10, F-03, F-23).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("authorization & role check order unit tests (Vòng 4: F-10, F-03, F-23)", () => {
  const coachUser = { id: "00000000-0000-0000-0000-000000000003", role: "coach" } as any;
  const otherCoachUser = { id: "00000000-0000-0000-0000-000000000006", role: "coach" } as any;
  const memberUser = { id: "00000000-0000-0000-0000-000000000004", role: "member" } as any;
  const otherMemberUser = { id: "00000000-0000-0000-0000-000000000007", role: "member" } as any;

  const courtId = "10000000-0000-0000-0000-000000000001";
  const testBookingId = "30000000-0000-0000-0000-000000000001";
  const testClassId = "40000000-0000-0000-0000-000000000001";
  const testEnrollmentId = "50000000-0000-0000-0000-000000000001";

  /**
   * Làm gì: Khởi tạo dữ liệu mẫu gồm HLV khác, hội viên khác, lượt đặt sân, lớp học và lượt ghi danh để kiểm tra phân quyền.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  before(async () => {
    // Insert otherCoach and otherMember
    // Bước 1: Thêm tài khoản HLV khác và hội viên khác vào bảng users
    await db.query(`
      insert into users (id, full_name, name_normalized, phone, role, status, password_hash, pii_consent_at)
      values
        ($1, 'HLV Khac', 'hlv khac', '+84900000006', 'coach', 'active', 'hash', now()),
        ($2, 'Hoi Vien Khac', 'hoi vien khac', '+84900000007', 'member', 'active', 'hash', now())
      on conflict (id) do nothing
    `, [otherCoachUser.id, otherMemberUser.id]);

    // Insert test booking owned by memberUser
    // Bước 2: Tạo đơn đặt sân mẫu thuộc sở hữu của memberUser
    await db.query(`
      insert into court_bookings (id, court_id, user_id, start_at, end_at, status, price_vnd, deposit_vnd, paid_vnd, code, channel)
      values ($1, $2, $3, now() + interval '1 day', now() + interval '1 day 1 hour', 'completed', 100000, 100000, 100000, 'BK-TEST-R4', 'online')
      on conflict (id) do nothing
    `, [testBookingId, courtId, memberUser.id]);

    // Insert class with coachUser and enrollment for otherMemberUser
    // Bước 3: Tạo lớp học do coachUser phụ trách và thêm bản ghi ghi danh cho otherMemberUser
    await db.query(`
      insert into classes (id, sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count)
      values ($1, 'badminton', 'beginner', $2, $3, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9', '2026-11-01', '2026-11-30', 60, 10, 'open', 1)
      on conflict (id) do nothing
    `, [testClassId, coachUser.id, courtId]);

    await db.query(`
      insert into enrollments (id, class_id, user_id, status)
      values ($1, $2, $3, 'confirmed')
      on conflict (id) do nothing
    `, [testEnrollmentId, testClassId, otherMemberUser.id]);
  });

  // 1. HLV gọi GET /bookings/:id của hội viên → 403
  /**
   * Làm gì: Kiểm tra HLV không được quyền xem chi tiết đơn đặt sân của hội viên khác, trả về lỗi 403 FORBIDDEN (F-03).
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("rejects coach viewing member booking with 403 (F-03)", async () => {
    // HLV không phải chủ sở hữu booking và không có quyền quản lý nên bị chặn truy cập
    await assert.rejects(
      async () => withTx(async (sql) => bookingGet(sql, testBookingId, coachUser)),
      (err: any) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, "FORBIDDEN");
        return true;
      }
    );
  });

  // 2. Hội viên khác gọi GET /bookings/:id → 403
  /**
   * Làm gì: Kiểm tra hội viên không được phép xem đơn đặt sân của hội viên khác (chống IDOR), trả về lỗi 403 FORBIDDEN (F-03).
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("rejects other member viewing member booking with 403 (F-03)", async () => {
    // Người dùng role member chỉ được phép xem các đơn đặt sân do chính mình tạo
    await assert.rejects(
      async () => withTx(async (sql) => bookingGet(sql, testBookingId, otherMemberUser)),
      (err: any) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, "FORBIDDEN");
        return true;
      }
    );
  });

  // 3. Chủ booking gọi GET /bookings/:id → 200
  /**
   * Làm gì: Kiểm tra chính chủ sở hữu đơn đặt sân được phép xem thông tin chi tiết với mã trạng thái 200 OK.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("allows owner viewing member booking with 200", async () => {
    // Bước 1: Gọi bookingGet với vai trò chủ sở hữu đơn đặt sân (memberUser)
    const res = await withTx(async (sql) => bookingGet(sql, testBookingId, memberUser));
    // Bước 2: Xác nhận phản hồi HTTP 200 và ID booking trả về trùng khớp
    assert.equal(res.status, 200);
    assert.equal((res.body as any).id, testBookingId);
  });

  // 4. HLV khác lớp xoá ghi danh → 403
  /**
   * Làm gì: Kiểm tra HLV không được phép xóa ghi danh của lớp học do HLV khác phụ trách, trả về lỗi 403 FORBIDDEN (F-23).
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("rejects cross-sport coach deleting enrollment with 403 (F-23)", async () => {
    // otherCoachUser không phụ trách lớp này nên bị chặn khi cố xóa bản ghi ghi danh
    await assert.rejects(
      async () => withTx(async (sql) => enrollmentDelete(sql, testEnrollmentId, otherCoachUser)),
      (err: any) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, "FORBIDDEN");
        return true;
      }
    );
  });

  // 5. HLV đúng lớp xoá ghi danh → thành công (không ném 403)
  /**
   * Làm gì: Kiểm tra HLV phụ trách lớp được quyền xóa học viên khỏi danh sách ghi danh lớp của mình thành công (F-23).
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("allows assigned coach deleting enrollment in their class (F-23)", async () => {
    // Bước 1: Thực hiện xóa ghi danh với vai trò coachUser là HLV phụ trách lớp
    const res = await withTx(async (sql) => enrollmentDelete(sql, testEnrollmentId, coachUser));
    // Bước 2: Xác nhận API trả về HTTP 200 và thuộc tính ok = true
    assert.equal(res.status, 200);
    assert.equal((res.body as any).ok, true);
  });

  // 6. HLV dời lịch booking của hội viên → 403 (Section 7.3)
  /**
   * Làm gì: Kiểm tra HLV bị từ chối với lỗi 403 khi cố dời lịch đặt sân của hội viên, kiểm tra quyền trước khi đọc body request (Section 7.3).
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("rejects coach rescheduling member booking with 403 before body/query (Section 7.3)", async () => {
    // Bước 1: Tạo request dời lịch đặt sân với body rỗng
    const req = new Request("http://localhost/v1/bookings/" + testBookingId + "/reschedule", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    await assert.rejects(
      // Bước 2: Xác nhận hệ thống chặn 403 ngay từ bước kiểm tra quyền, trước cả khi validate request body
      async () => withTx(async (sql) => bookingsReschedule(sql, testBookingId, req, coachUser)),
      (err: any) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, "FORBIDDEN");
        return true;
      }
    );
  });

  // 7. Chủ booking dời lịch booking → không phải 403 (Section 7.3)
  /**
   * Làm gì: Kiểm tra chủ đặt sân khi dời lịch không bị chặn bởi lỗi 403 phân quyền (Section 7.3).
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("does not reject owner with 403 when rescheduling (Section 7.3)", async () => {
    // Bước 1: Tạo request dời lịch với thời gian start_at mới
    const req = new Request("http://localhost/v1/bookings/" + testBookingId + "/reschedule", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ start_at: "2026-11-05T09:00:00.000Z" }),
    });
    // Bước 2: Thực thi dời lịch và xác nhận không ném mã lỗi 403 FORBIDDEN
    try {
      await withTx(async (sql) => bookingsReschedule(sql, testBookingId, req, memberUser));
    } catch (err: any) {
      assert.notEqual(err.status, 403);
    }
  });
});

/**
 * Làm gì: Nhóm ca kiểm thử xác nhận migration đã xóa bảng day_passes và cột day_pass_vnd trong bảng center_settings.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("Section 8: Drop day_passes table & center_settings.day_pass_vnd column", () => {
  // 1. select to_regclass('day_passes') ra null
  /**
   * Làm gì: Kiểm tra bảng day_passes đã bị xóa hoàn toàn khỏi database bằng hàm to_regclass trả về null.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("confirms day_passes table is dropped (to_regclass returns null)", async () => {
    // Truy vấn to_regclass('day_passes'), nếu bảng không còn tồn tại hàm sẽ trả về null
    const res = await db.query<{ tbl: string | null }>("select to_regclass('day_passes') as tbl");
    assert.equal(res.rows[0].tbl, null);
  });

  // 2. information_schema.columns không có center_settings.day_pass_vnd
  /**
   * Làm gì: Kiểm tra cột day_pass_vnd trong bảng center_settings đã bị xóa khỏi lược đồ cơ sở dữ liệu.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("confirms center_settings.day_pass_vnd column is dropped", async () => {
    // Kiểm tra information_schema.columns để bảo đảm cột day_pass_vnd không còn tồn tại trong center_settings
    const res = await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'center_settings' and column_name = 'day_pass_vnd'"
    );
    assert.equal(res.rows.length, 0);
  });

  // 3. insert payment ref_type='day_pass', method='cash', status='posted' vào một ca thì tổng ca tăng đúng số tiền (lịch sử vẫn được tính)
  /**
   * Làm gì: Kiểm tra các giao dịch vé ngày (day_pass) bằng tiền mặt trong quá khứ vẫn được cộng dồn chính xác vào tổng tiền mặt ca hiện tại (shiftCurrent).
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("counts historical day_pass cash payment in real shift till totals via shiftCurrent", async () => {
    // Bước 1: Khởi tạo thông tin lễ tân và mở một ca thu ngân mới trong cashier_shifts
    const receptionistUser = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist" } as any;
    const shift = (await db.query<{ id: string }>(
      "insert into cashier_shifts (receptionist_id) values ($1) returning id",
      [receptionistUser.id]
    )).rows[0];
    // Bước 2: Chèn giao dịch thanh toán vé ngày cũ (ref_type = 'day_pass') với số tiền 50.000đ tiền mặt vào ca
    await db.query(
      `insert into payments (code, shift_id, method, amount_vnd, vat_rate, status, ref_type, ref_id)
       values ('PAY-HIST-DP', $1, 'cash', 50000, 8, 'posted', 'day_pass', gen_random_uuid())`,
      [shift.id]
    );
    // Bước 3: Gửi request lấy thông tin ca hiện tại qua shiftCurrent và xác minh tổng tiền mặt ghi nhận chính xác 50.000đ
    const req = new Request("http://localhost/v1/shifts/current");
    const res = await withTx(async (sql) => shiftCurrent(sql, receptionistUser, req));
    assert.equal(res.status, 200);
    assert.equal((res.body as any).totals.cash, 50000);
    // Clean up test shift
    await db.query("update cashier_shifts set closed_at = now() where id = $1", [shift.id]);
  });
});

describe("Round 5: Money & Cashier Shift unit tests (F-17, F-12, F-13, F-09)", () => {
  const receptionistUser = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist", full_name: "Lễ tân test" } as any;
  const managerUser = { id: "00000000-0000-0000-0000-000000000001", role: "manager", full_name: "Quản lý test" } as any;
  const validCourtId = "10000000-0000-0000-0000-000000000001";
  const nonexistentId = "99999999-9999-4999-8999-999999999999";
  const testBookingId = "30000000-0000-0000-0000-000000000001";

  // F-17: cash_declared_vnd parseInteger min 0
  /**
   * Làm gì: Kiểm thử tính năng F-17: Từ chối đóng ca với mã 400 nếu số tiền mặt khai báo (cash_declared_vnd) âm, và chấp nhận khi khai báo bằng 0.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("rejects negative cash_declared_vnd with 400 (F-17)", async () => {
    // Bước 1: Mở ca thu ngân mới cho lễ tân trong bảng cashier_shifts
    const shift = (await db.query<{ id: string }>(
      "insert into cashier_shifts (receptionist_id) values ($1) returning id",
      [receptionistUser.id]
    )).rows[0];
    // Bước 2: Gửi yêu cầu đóng ca với số tiền khai báo âm (-1đ) -> mong đợi lỗi 400 ở trường cash_declared_vnd
    const req = new Request("http://localhost/v1/shifts/" + shift.id + "/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cash_declared_vnd: -1 }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => shiftClose(sql, shift.id, req, receptionistUser)),
      (err: any) => {
        assert.equal(err.status, 400);
        assert.equal(err.extra?.field, "cash_declared_vnd");
        return true;
      }
    );
    // 0 is accepted
    // Bước 3: Gửi yêu cầu đóng ca hợp lệ với số tiền khai báo bằng 0đ -> mong đợi thành công 200 OK
    const reqZero = new Request("http://localhost/v1/shifts/" + shift.id + "/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cash_declared_vnd: 0 }),
    });
    const res = await withTx(async (sql) => shiftClose(sql, shift.id, reqZero, receptionistUser));
    assert.equal(res.status, 200);
    assert.equal((res.body as any).cash_declared_vnd, 0);
  });

  // F-12: method quota rejected in paymentsCreate
  /**
   * Làm gì: Kiểm thử tính năng F-12: paymentsCreate từ chối phương thức thanh toán quota tại quầy với mã lỗi 400 và chấp nhận phương thức tiền mặt cash (201 Created).
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("rejects payment method quota with 400 (F-12)", async () => {
    // Bước 1: Mở ca thu ngân cho lễ tân để chuẩn bị môi trường thanh toán
    const shift = (await db.query<{ id: string }>(
      "insert into cashier_shifts (receptionist_id) values ($1) returning id",
      [receptionistUser.id]
    )).rows[0];
    // Bước 2: Thử tạo thanh toán với method='quota' -> mong đợi lỗi 400 vì quota không áp dụng qua API quầy
    const reqQuota = new Request("http://localhost/v1/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref_type: "booking",
        ref_id: testBookingId,
        method: "quota",
        amount_vnd: 50000,
      }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => paymentsCreate(sql, reqQuota, receptionistUser)),
      (err: any) => {
        assert.equal(err.status, 400);
        assert.equal(err.extra?.field, "method");
        return true;
      }
    );
    // cash is accepted
    // Bước 3: Tạo thanh toán hợp lệ với method='cash' -> mong đợi thành công 201 Created
    const reqCash = new Request("http://localhost/v1/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref_type: "booking",
        ref_id: testBookingId,
        method: "cash",
        amount_vnd: 50000,
      }),
    });
    const resCash = await withTx(async (sql) => paymentsCreate(sql, reqCash, receptionistUser));
    assert.equal(resCash.status, 201);
    assert.equal((resCash.body as any).payment?.method, "cash");
    // Bước 4: Đóng ca thu ngân để dọn dẹp dữ liệu kiểm thử
    await db.query("update cashier_shifts set closed_at = now() where id = $1", [shift.id]);
  });

  // F-13: shift_id validation
  /**
   * Làm gì: Kiểm thử tính năng F-13: Xác thực quyền sở hữu ca thu ngân (shift_id) khi tạo thanh toán: 404 nếu không tồn tại, 403 nếu gắn nhầm ca người khác, 201 nếu đúng ca mở của mình.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("validates shift_id in paymentsCreate: 404 for nonexistent, 403 for other shift (F-13)", async () => {
    // Bước 1: Khởi tạo 2 ca thu ngân riêng biệt: một ca của lễ tân hiện tại và một ca của người khác (quản lý)
    const myShift = (await db.query<{ id: string }>(
      "insert into cashier_shifts (receptionist_id) values ($1) returning id",
      [receptionistUser.id]
    )).rows[0];
    const otherShift = (await db.query<{ id: string }>(
      "insert into cashier_shifts (receptionist_id) values ($1) returning id",
      [managerUser.id]
    )).rows[0];

    // Nonexistent shift_id -> 404
    // Bước 2: Truyền shift_id không tồn tại -> mong đợi lỗi 404 Not Found
    const req404 = new Request("http://localhost/v1/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref_type: "booking",
        ref_id: testBookingId,
        method: "cash",
        amount_vnd: 50000,
        shift_id: nonexistentId,
      }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => paymentsCreate(sql, req404, receptionistUser)),
      (err: any) => {
        assert.equal(err.status, 404);
        return true;
      }
    );

    // Other shift_id -> 403
    // Bước 3: Truyền shift_id thuộc ca của người khác -> mong đợi lỗi 403 Forbidden do không có quyền ghi nhận tiền vào ca người khác
    const req403 = new Request("http://localhost/v1/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref_type: "booking",
        ref_id: testBookingId,
        method: "cash",
        amount_vnd: 50000,
        shift_id: otherShift.id,
      }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => paymentsCreate(sql, req403, receptionistUser)),
      (err: any) => {
        assert.equal(err.status, 403);
        return true;
      }
    );

    // Own open shift -> 201
    // Bước 4: Truyền đúng shift_id ca mở của chính mình -> thanh toán thành công 201 Created và gắn đúng shift_id
    const reqOwn = new Request("http://localhost/v1/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref_type: "booking",
        ref_id: testBookingId,
        method: "cash",
        amount_vnd: 50000,
        shift_id: myShift.id,
      }),
    });
    const resOwn = await withTx(async (sql) => paymentsCreate(sql, reqOwn, receptionistUser));
    assert.equal(resOwn.status, 201);
    assert.equal((resOwn.body as any).payment?.shift_id, myShift.id);

    // Bước 5: Đóng cả hai ca thu ngân để dọn dẹp dữ liệu kiểm thử
    await db.query("update cashier_shifts set closed_at = now() where id in ($1, $2)", [myShift.id, otherShift.id]);
  });

  // F-09: walkIn phone validation & slot clash
  /**
   * Làm gì: Kiểm thử tính năng F-09: Xác thực số điện thoại khách vãng lai (422 nếu sai format) và từ chối nếu khung giờ đã bị giữ chỗ trước (409 CONFLICT_SLOT).
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("validates phone and rejects conflicting slot with 409 in walkIn (F-09)", async () => {
    // Bước 1: Chuẩn bị dữ liệu sân cầu lông, người dùng lễ tân, hội viên và tính khung giờ mở cửa ngày mai theo giờ ICT
    const court = (await db.query<{ id: string }>(
      `insert into courts (court_code, sport, status) values ('G9-F09', 'badminton', 'ready') returning id`,
    )).rows[0];
    const receptionist = (await db.query<any>(
      `insert into users (phone, full_name, name_normalized, role, password_hash)
       values ('+84987654907', 'G9 Receptionist', 'g9 receptionist', 'receptionist', 'hash') returning *`,
    )).rows[0];
    const member = (await db.query<{ phone: string }>(
      `insert into users (phone, full_name, name_normalized, role, password_hash)
       values ('+84987654909', 'G9 Walkin Member', 'g9 walkin member', 'member', 'hash') returning phone`,
    )).rows[0];
    // Tomorrow at opening time in ICT is future, on-grid and in hours even at night.
    const slot = (await db.query<{ start_at: Date; end_at: Date }>(
      `select ((now() at time zone 'Asia/Ho_Chi_Minh')::date + 1 + open_time)
                at time zone 'Asia/Ho_Chi_Minh' as start_at,
              (((now() at time zone 'Asia/Ho_Chi_Minh')::date + 1 + open_time)
                at time zone 'Asia/Ho_Chi_Minh') + slot_minutes * interval '1 minute' as end_at
         from center_settings where id = 1`,
    )).rows[0];
    // Bước 2: Mở ca thu ngân cho lễ tân để thực hiện nghiệp vụ khách vãng lai tại quầy
    const shift = (await db.query<{ id: string }>(
      "insert into cashier_shifts (receptionist_id) values ($1) returning id",
      [receptionist.id]
    )).rows[0];

    // SĐT rác -> validation error
    // Bước 3: Gửi thông tin đặt sân với số điện thoại không hợp lệ ("12345") -> mong đợi lỗi 422 Unprocessable Entity ở trường phone
    const reqBadPhone = new Request("http://localhost/v1/walk-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        court_id: court.id,
        start_at: slot.start_at,
        guest_name: "Walkin Guest",
        guest_phone: "12345",
        method: "cash",
      }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => walkIn(sql, reqBadPhone, receptionist)),
      (err: any) => {
        assert.equal(err.status, 422);
        assert.equal(err.extra?.field, "phone");
        return true;
      }
    );

    // Slot đã hold -> 409 CONFLICT_SLOT
    // Bước 4: Chèn bản ghi occupancies loại hold để giả lập slot đã có người giữ chỗ trước
    await db.query(`
      insert into occupancies (id, court_id, start_at, end_at, kind, ref_id)
      values (gen_random_uuid(), $1, $2, $3, 'hold', gen_random_uuid())
    `, [court.id, slot.start_at, slot.end_at]);

    // Bước 5: Gửi yêu cầu đặt walk-in trùng vào đúng khung giờ đã bị hold -> mong đợi lỗi 409 CONFLICT_SLOT
    const reqClash = new Request("http://localhost/v1/walk-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        court_id: court.id,
        start_at: slot.start_at,
        guest_name: "Walkin Clash",
        guest_phone: member.phone,
        method: "cash",
      }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => walkIn(sql, reqClash, receptionist)),
      (err: any) => {
        assert.equal(err.status, 409);
        assert.equal(err.code, "CONFLICT_SLOT");
        return true;
      }
    );

    // Bước 6: Đóng ca thu ngân để dọn dẹp dữ liệu kiểm thử
    await db.query("update cashier_shifts set closed_at = now() where id = $1", [shift.id]);
  });

  // F-09: walkIn preserves member's app hold on another day
  /**
   * Làm gì: Kiểm thử tính năng F-09: Đảm bảo khi lễ tân tạo đơn walk-in cho hội viên thì lệnh giữ chỗ (hold) trên app ở ngày khác của hội viên đó vẫn được bảo toàn.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("preserves member's app hold on another day when receptionist creates a walk-in for that member (F-09)", async () => {
    // Bước 1: Đóng các ca cũ nếu có và mở ca thu ngân mới cho lễ tân
    await db.query("update cashier_shifts set closed_at = now() where receptionist_id = $1 and closed_at is null", [receptionistUser.id]);
    const shift = (await db.query<{ id: string }>(
      "insert into cashier_shifts (receptionist_id) values ($1) returning id",
      [receptionistUser.id]
    )).rows[0];

    // Bước 2: Tạo đơn giữ chỗ (status='hold') của hội viên vào ngày 2026-11-25 kèm bản ghi chiếm chỗ trong occupancies
    const memberUser = { id: "00000000-0000-0000-0000-000000000004", role: "member" } as any;
    const memberHoldId = "30000000-0000-0000-0000-000000000002";
    // Member has an app hold on 2026-11-25
    const occId = (await db.query<{ id: string }>(`
      insert into occupancies (id, court_id, start_at, end_at, kind, ref_id)
      values (gen_random_uuid(), $1, '2026-11-25 09:00:00+00', '2026-11-25 10:00:00+00', 'hold', $2)
      returning id
    `, [validCourtId, memberHoldId])).rows[0].id;
    await db.query(`
      insert into court_bookings (id, court_id, user_id, start_at, end_at, status, price_vnd, deposit_vnd, paid_vnd, code, channel, occupancy_id)
      values ($1, $2, $3, '2026-11-25 09:00:00+00', '2026-11-25 10:00:00+00', 'hold', 100000, 0, 0, 'BK-HOLD-MEM', 'online', $4)
      on conflict (id) do nothing
    `, [memberHoldId, validCourtId, memberUser.id, occId]);

    // Receptionist creates walk-in for the same member on 2026-11-26
    // Bước 3: Lễ tân tạo đơn walk-in thanh toán tiền mặt cho chính hội viên này vào ngày hôm sau (2026-11-26)
    const reqWalkIn = new Request("http://localhost/v1/walk-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        court_id: validCourtId,
        start_at: "2026-11-26T09:00:00.000Z",
        guest_name: "Member Walkin",
        guest_phone: "+84900000004",
        method: "cash",
      }),
    });
    const resWalkIn = await withTx(async (sql) => walkIn(sql, reqWalkIn, receptionistUser));
    assert.equal(resWalkIn.status, 201);

    // Member's original hold is STILL in status 'hold'
    // Bước 4: Kiểm tra đơn giữ chỗ ngày 2026-11-25 ban đầu của hội viên vẫn giữ nguyên trạng thái 'hold', không bị hủy bỏ hay ghi đè
    const origHold = (await db.query<{ status: string }>(
      "select status from court_bookings where id = $1",
      [memberHoldId]
    )).rows[0];
    assert.equal(origHold.status, "hold");

    // Bước 5: Đóng ca thu ngân để dọn dẹp dữ liệu kiểm thử
    await db.query("update cashier_shifts set closed_at = now() where id = $1", [shift.id]);
  });

  // F-16 (1): Lễ tân thu 100.000 đ mặt, hoàn 40.000 đ mặt → shiftCurrent tiền mặt = 60.000 đ
  /**
   * Làm gì: Kiểm thử tính năng F-16: Lễ tân hoàn tiền mặt 40.000đ từ khoản thu 100.000đ, xác minh tổng tiền mặt ca trực giảm còn 60.000đ sau khi chi trả.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("F-16: receptionist refunds 40,000 cash from 100,000 intake -> shift till cash is 60,000", async () => {
    // Bước 1: Đóng các ca cũ và mở một ca thu ngân mới cho lễ tân
    await db.query("update cashier_shifts set closed_at = now() where receptionist_id = $1 and closed_at is null", [receptionistUser.id]);
    const shift = (await db.query<{ id: string }>(
      "insert into cashier_shifts (receptionist_id) values ($1) returning id",
      [receptionistUser.id]
    )).rows[0];

    // Seed positive payment of 100,000 cash in this shift
    // Bước 2: Tạo khoản thu ban đầu 100.000đ tiền mặt (status='posted') thuộc ca trực này
    const pay = (await db.query<{ id: string }>(`
      insert into payments (code, shift_id, method, amount_vnd, vat_rate, status, ref_type, ref_id)
      values ('PAY-RF-100K', $1, 'cash', 100000, 8, 'posted', 'booking', $2)
      returning id
    `, [shift.id, testBookingId])).rows[0];

    // Direct refund 40,000 cash by receptionist
    // Bước 3: Lễ tân tạo yêu cầu hoàn 40.000đ tiền mặt -> tạo giao dịch âm (-40.000đ) trạng thái refund_pending
    const reqRefund = new Request("http://localhost/v1/payments/" + pay.id + "/refund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount_vnd: 40000, reason: "Hỏng vợt" }),
    });
    const resRefund = await withTx(async (sql) => paymentsRefund(sql, pay.id, reqRefund, receptionistUser));
    assert.equal(resRefund.status, 201);
    assert.equal((resRefund.body as any).payment?.shift_id, shift.id);
    assert.equal((resRefund.body as any).payment?.amount_vnd, -40000);

    assert.equal((resRefund.body as any).payment.status, "refund_pending");
    // Bước 4: Thực hiện chi tiền hoàn từ két (paymentsPayOutRefund) và kiểm tra tổng tiền mặt ca trực giảm xuống còn 60.000đ (100k - 40k)
    await withTx((sql) => paymentsPayOutRefund(sql, (resRefund.body as any).payment.id, receptionistUser));
    // Verify shift totals after cash payout: 100k - 40k = 60k
    const reqCurrent = new Request("http://localhost/v1/shifts/current");
    const cur = await withTx(async (sql) => shiftCurrent(sql, receptionistUser, reqCurrent));
    assert.equal(cur.status, 200);
    assert.equal((cur.body as any).totals?.cash, 60000);

    // Bước 5: Đóng ca thu ngân để dọn dẹp dữ liệu kiểm thử
    await db.query("update cashier_shifts set closed_at = now() where id = $1", [shift.id]);
  });

  // F-16 (2): Quản lý duyệt hoàn tiền (approve-refund) → tổng ca lễ tân giảm theo số tiền hoàn
  /**
   * Làm gì: Kiểm thử tính năng F-16: Quản lý phê duyệt yêu cầu hoàn tiền lớn (1.200.000đ) và kiểm tra tổng tiền mặt ca lễ tân giảm tương ứng sau khi chi trả.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("F-16: manager approves refund (approve-refund) -> receptionist shift till totals reduced by refund", async () => {
    // Bước 1: Mở ca thu ngân mới cho lễ tân và lấy số dư tiền mặt ban đầu của ca
    await db.query("update cashier_shifts set closed_at = now() where receptionist_id = $1 and closed_at is null", [receptionistUser.id]);
    const shift = (await db.query<{ id: string }>(
      "insert into cashier_shifts (receptionist_id) values ($1) returning id",
      [receptionistUser.id]
    )).rows[0];

    // Seed large payment of 1,500,000
    // Bước 2: Tạo khoản thu lớn 1.500.000đ tiền mặt vào ca trực để làm căn cứ hoàn tiền
    const pay = (await db.query<{ id: string }>(`
      insert into payments (code, shift_id, method, amount_vnd, vat_rate, status, ref_type, ref_id)
      values ('PAY-RF-BIG', $1, 'cash', 1500000, 8, 'posted', 'booking', $2)
      returning id
    `, [shift.id, testBookingId])).rows[0];

    const reqCurrentBefore = new Request("http://localhost/v1/shifts/current");
    const curBefore = await withTx(async (sql) => shiftCurrent(sql, receptionistUser, reqCurrentBefore));
    const cashBefore = (curBefore.body as any).totals?.cash;

    // Receptionist requests 1,200,000 refund -> refund_pending
    // Bước 3: Lễ tân gửi yêu cầu hoàn 1.200.000đ (vượt hạn mức tự quyết) -> chuyển trạng thái chờ duyệt (refund_pending)
    const reqPending = new Request("http://localhost/v1/payments/" + pay.id + "/refund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount_vnd: 1200000, reason: "Chuyển nhà" }),
    });
    const resPending = await withTx(async (sql) => paymentsRefund(sql, pay.id, reqPending, receptionistUser));
    assert.equal(resPending.status, 201);
    assert.equal((resPending.body as any).payment?.status, "refund_pending");
    assert.equal((resPending.body as any).payment?.shift_id, shift.id);
    const pendingId = (resPending.body as any).payment.id;

    // Manager approves refund
    // Bước 4: Quản lý (managerUser) gọi API approve-refund để phê duyệt yêu cầu hoàn tiền
    const reqApprove = new Request("http://localhost/v1/payments/" + pendingId + "/approve-refund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Duyệt hoàn tiền" }),
    });
    const resApprove = await withTx(async (sql) => paymentsApproveRefund(sql, pendingId, reqApprove, managerUser));
    assert.equal(resApprove.status, 200);
    assert.equal((resApprove.body as any).status, "refund_pending");
    // Bước 5: Lễ tân thực hiện chi tiền hoàn từ két và xác minh tổng tiền mặt ca trực giảm đúng 1.200.000đ
    await withTx((sql) => paymentsPayOutRefund(sql, pendingId, receptionistUser));

    // Shift totals for receptionist MUST drop by refund amount (the approved refund has shift_id = shift.id)
    const curAfter = await withTx(async (sql) => shiftCurrent(sql, receptionistUser, reqCurrentBefore));
    assert.equal((curAfter.body as any).totals?.cash, cashBefore - 1200000);

    // Bước 6: Đóng ca thu ngân để dọn dẹp dữ liệu kiểm thử
    await db.query("update cashier_shifts set closed_at = now() where id = $1", [shift.id]);
  });

  // F-16 (3): Lễ tân không có ca mà hoàn mặt → lỗi BR (BR-44)
  /**
   * Làm gì: Kiểm thử tính năng F-16: Lễ tân không có ca thu ngân đang mở mà cố gắng hoàn tiền mặt sẽ bị từ chối theo quy tắc BR-44 (BR_VIOLATION).
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("F-16: receptionist without open shift attempting cash refund throws BR-44", async () => {
    // Ensure no open shift for receptionist
    // Bước 1: Đóng toàn bộ ca thu ngân của lễ tân để giả lập trạng thái chưa mở ca trực
    await db.query("update cashier_shifts set closed_at = now() where receptionist_id = $1 and closed_at is null", [receptionistUser.id]);

    // Bước 2: Tạo giao dịch thanh toán gốc 50.000đ tiền mặt trong cơ sở dữ liệu
    const pay = (await db.query<{ id: string }>(`
      insert into payments (code, method, amount_vnd, vat_rate, status, ref_type, ref_id)
      values ('PAY-RF-NOCASHIER', 'cash', 50000, 8, 'posted', 'booking', $1)
      returning id
    `, [testBookingId])).rows[0];

    // Bước 3: Gửi yêu cầu hoàn 20.000đ tiền mặt khi không có ca mở -> mong đợi ném lỗi vi phạm quy tắc nghiệp vụ BR-44
    const reqRefund = new Request("http://localhost/v1/payments/" + pay.id + "/refund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount_vnd: 20000, reason: "Staff decision" }),
    });

    await assert.rejects(
      async () => withTx(async (sql) => paymentsRefund(sql, pay.id, reqRefund, receptionistUser)),
      (err: any) => {
        assert.equal(err.code, "BR_VIOLATION");
        assert.equal(err.extra?.br, "BR-44");
        return true;
      }
    );
  });
});

describe("Section 10.0: Patch Round 5 omissions", () => {
  const receptionistUser = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist", full_name: "Lễ tân test" } as any;
  const managerUser = { id: "00000000-0000-0000-0000-000000000001", role: "manager", full_name: "Quản lý test" } as any;
  const validCourtId = "10000000-0000-0000-0000-000000000001";
  const testBookingId = "30000000-0000-0000-0000-000000000001";

  /**
   * Làm gì: Kiểm tra quản lý tạo đơn walk-in với shift_id tự bịa (không tồn tại) thì hệ thống vẫn tạo thành công (201) và tự động gán shift_id của payment về NULL.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("manager walk-in with invented shift_id -> 201, payment shift_id is NULL", async () => {
    // Bước 1: Quản lý gửi request đặt sân vãng lai kèm shift_id giả lập ("99999999-...")
    const req = new Request("http://localhost/v1/walk-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        court_id: validCourtId,
        start_at: "2026-11-28T09:00:00.000Z",
        guest_name: "Mgr Walkin",
        guest_phone: "0912345678",
        method: "cash",
        shift_id: "99999999-9999-4999-8999-999999999999",
      }),
    });
    // Bước 2: Thực thi giao dịch walk-in với quyền manager; kiểm tra HTTP 201 và payment.shift_id là null vì manager không mở ca trực thu ngân
    const res = await withTx(async (sql) => walkIn(sql, req, managerUser));
    assert.equal(res.status, 201);
    assert.equal((res.body as any).payment?.shift_id, null);
  });

  /**
   * Làm gì: Kiểm tra việc manager tạo walk-in kèm shift_id của ca lễ tân đang mở; giao dịch thành công nhưng tiền mặt trong két của lễ tân không bị ảnh hưởng.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("manager walk-in with open receptionist shift_id -> 201, receptionist till cash unchanged", async () => {
    // Bước 1: Đóng các ca trực cũ và mở một ca trực thu ngân mới cho tài khoản lễ tân
    await db.query("update cashier_shifts set closed_at = now() where receptionist_id = $1 and closed_at is null", [receptionistUser.id]);
    const shift = (await db.query<{ id: string }>(
      "insert into cashier_shifts (receptionist_id) values ($1) returning id",
      [receptionistUser.id]
    )).rows[0];

    // Bước 2: Lấy thông tin ca hiện tại của lễ tân để ghi nhận tổng tiền mặt trong két trước giao dịch
    const reqBefore = new Request("http://localhost/v1/shifts/current");
    const curBefore = await withTx(async (sql) => shiftCurrent(sql, receptionistUser, reqBefore));
    const cashBefore = (curBefore.body as any).totals?.cash;

    // Bước 3: Chuẩn bị request walk-in dưới quyền manager nhưng truyền kèm shift_id của ca lễ tân
    const req = new Request("http://localhost/v1/walk-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        court_id: validCourtId,
        start_at: "2026-11-29T09:00:00.000Z",
        guest_name: "Mgr Walkin 2",
        guest_phone: "0912345678",
        method: "cash",
        shift_id: shift.id,
      }),
    });
    // Bước 4: Thực hiện đặt sân walk-in; kiểm tra HTTP 201 và payment.shift_id là null vì manager không gắn giao dịch vào ca của người khác
    const res = await withTx(async (sql) => walkIn(sql, req, managerUser));
    assert.equal(res.status, 201);
    assert.equal((res.body as any).payment?.shift_id, null);

    // Bước 5: Xác minh số tiền mặt trong két của ca lễ tân không bị thay đổi sau giao dịch của manager
    const curAfter = await withTx(async (sql) => shiftCurrent(sql, receptionistUser, reqBefore));
    assert.equal((curAfter.body as any).totals?.cash, cashBefore);

    // Bước 6: Đóng ca trực thu ngân của lễ tân để dọn dẹp dữ liệu test
    await db.query("update cashier_shifts set closed_at = now() where id = $1", [shift.id]);
  });

  /**
   * Làm gì: Kiểm tra API paymentsCreate trả về mã lỗi 404 khi shift_id hoặc ref_id không phải là định dạng UUID hợp lệ.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("paymentsCreate: non-UUID shift_id -> 404, non-UUID ref_id -> 404", async () => {
    // 1. shift_id = "abc" -> 404
    // Bước 1: Tạo request thanh toán với shift_id không phải UUID ("abc") và kiểm tra phản hồi lỗi 404
    const reqBadShift = new Request("http://localhost/v1/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref_type: "booking",
        ref_id: testBookingId,
        method: "cash",
        amount_vnd: 50000,
        shift_id: "abc",
      }),
    });
    // Xác minh hệ thống từ chối với mã lỗi 404 do không tìm thấy ca trực tương ứng
    await assert.rejects(
      async () => withTx(async (sql) => paymentsCreate(sql, reqBadShift, receptionistUser)),
      (err: any) => {
        assert.equal(err.status, 404);
        return true;
      }
    );

    // 2. ref_id = "abc" with ref_type = "booking" -> 404
    // Bước 2: Tạo request thanh toán cho booking với ref_id không phải UUID ("abc") và kiểm tra phản hồi lỗi 404
    const reqBadRef = new Request("http://localhost/v1/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref_type: "booking",
        ref_id: "abc",
        method: "cash",
        amount_vnd: 50000,
      }),
    });
    // Xác minh hệ thống từ chối với mã lỗi 404 do không tìm thấy đơn đặt sân tham chiếu
    await assert.rejects(
      async () => withTx(async (sql) => paymentsCreate(sql, reqBadRef, managerUser)),
      (err: any) => {
        assert.equal(err.status, 404);
        return true;
      }
    );
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử Round 6: kiểm tra lưới giờ đặt sân (F-06), tính lũy thừa Idempotency-Key (F-07), hàng đợi danh sách chờ (F-26), và sinh mã hội viên tuần tự (F-04).
 * Được gọi ở: test runner (node --test)
 */
describe("Round 6: F-06, F-07, F-26, F-04 unit tests", () => {
  const memberF06 = { id: "00000000-0000-0000-0000-000000000201", role: "member", full_name: "Member F06" } as any;
  const memberF07A = { id: "00000000-0000-0000-0000-000000000202", role: "member", full_name: "Member F07A" } as any;
  const memberF07B = { id: "00000000-0000-0000-0000-000000000203", role: "member", full_name: "Member F07B" } as any;
  const receptionistUser = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist", full_name: "Lễ tân" } as any;
  const _managerUser = { id: "00000000-0000-0000-0000-000000000001", role: "manager", full_name: "Quản lý" } as any;
  const validCourtId = "10000000-0000-0000-0000-000000000001";
  const validCourtId2 = "10000000-0000-0000-0000-000000000002";
  const testDate = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

  /**
   * Làm gì: Khởi tạo người dùng mẫu và dọn dẹp lịch đặt sân, lớp học, occupancy cũ trong ngày kiểm thử trước khi chạy suite Round 6.
   * Được gọi ở: test runner (node --test) - hook before của suite Round 6
   * @returns {Promise<void>}
   */
  before(async () => {
    // Bước 1: Khởi tạo các tài khoản hội viên mẫu phục vụ cho kịch bản F-06 và F-07 nếu chưa tồn tại trong bảng users
    for (const m of [memberF06, memberF07A, memberF07B]) {
      const phone = "+8490" + m.id.replace(/-/g, "").slice(-7);
      await db.query(
        `insert into users (id, phone, full_name, name_normalized, role, password_hash)
         values ($1, $2, $3, $4, 'member', 'hash')
         on conflict (id) do nothing`,
        [m.id, phone, m.full_name, m.full_name.toLowerCase()]
      );
    }
    // Bước 2: Hủy các đơn đặt sân và buổi tập cũ trên 2 sân kiểm thử trong ngày testDate để giải phóng sân
    await db.query(`update court_bookings set occupancy_id = null, status = 'cancelled' where court_id in ($1, $2) and (start_at at time zone 'Asia/Ho_Chi_Minh')::date = $3::date`, [validCourtId, validCourtId2, testDate]);
    await db.query(`update sessions set occupancy_id = null, status = 'cancelled' where court_id in ($1, $2) and (start_at at time zone 'Asia/Ho_Chi_Minh')::date = $3::date`, [validCourtId, validCourtId2, testDate]);
    // Bước 3: Xóa triệt để các bản ghi chiếm sân (occupancies) trong ngày testDate để đảm bảo sân hoàn toàn trống
    await db.query(`delete from occupancies where court_id in ($1, $2) and (start_at at time zone 'Asia/Ho_Chi_Minh')::date = $3::date`, [validCourtId, validCourtId2, testDate]);
  });

  // F-06: 10:17 -> 4xx; 21:30 (ends 22:30) -> 4xx; 21:00 -> 201; walk-in 10:17 -> 4xx
  /**
   * Làm gì: Kiểm tra quy tắc lưới giờ (F-06): từ chối giờ lẻ không khớp slot (10:17) và giờ kết thúc vượt giờ đóng cửa (21:30), chấp nhận giờ chuẩn (21:00) và từ chối walk-in giờ lẻ.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("F-06: rejects off-grid 10:17 and after-closing 21:30, allows 21:00, rejects walk-in 10:17", async () => {
    // 1. 10:17 -> 4xx
    // Bước 1: Gửi request đặt sân vào giờ lẻ không khớp bước nhảy slot (10:17), kỳ vọng bị từ chối với lỗi 4xx
    const req1017 = new Request("http://localhost/v1/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ court_id: validCourtId, start_at: `${testDate}T10:17:00.000+07:00` }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => bookingsHold(sql, req1017, memberF06)),
      (err: any) => {
        assert.ok(err.status >= 400 && err.status < 500);
        return true;
      }
    );

    // 2. 21:30 (ends 22:30, after close 22:00) -> 4xx
    // Bước 2: Gửi request đặt sân lúc 21:30 (thời lượng 60 phút sẽ kết thúc lúc 22:30, vượt quá giờ đóng cửa 22:00)
    const req2130 = new Request("http://localhost/v1/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ court_id: validCourtId, start_at: `${testDate}T21:30:00.000+07:00` }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => bookingsHold(sql, req2130, memberF06)),
      (err: any) => {
        assert.ok(err.status >= 400 && err.status < 500);
        return true;
      }
    );

    // 3. 21:00 -> 201 (on court 2 to avoid occupancy conflict)
    // Bước 3: Đặt sân lúc 21:00 đúng khung giờ lưới và kịp kết thúc trước giờ đóng cửa (22:00), kỳ vọng HTTP 201
    const req2100 = new Request("http://localhost/v1/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ court_id: validCourtId2, start_at: `${testDate}T21:00:00.000+07:00` }),
    });
    const res2100 = await withTx(async (sql) => bookingsHold(sql, req2100, memberF06));
    assert.equal(res2100.status, 201);

    // 4. walk-in 10:17 -> 4xx
    // Bước 4: Kiểm tra tính năng walk-in cũng phải tuân thủ nghiêm ngặt lưới giờ slot, từ chối giờ lẻ 10:17
    const reqWi1017 = new Request("http://localhost/v1/walk-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        court_id: validCourtId,
        start_at: `${testDate}T10:17:00.000+07:00`,
        guest_name: "Walkin Grid",
        guest_phone: "0912345678",
        method: "cash",
      }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => walkIn(sql, reqWi1017, receptionistUser)),
      (err: any) => {
        assert.ok(err.status >= 400 && err.status < 500);
        return true;
      }
    );
  });

  // F-07: Member A & B using same key -> 2 different bookings; A resends key -> same booking id, count unchanged
  /**
   * Làm gì: Kiểm tra tính bất biến Idempotency-Key (F-07): khóa lũy thừa được giới hạn theo từng user, và khi gửi lại cùng một khóa thì nhận về booking id cũ mà không tạo bản ghi mới.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("F-07: Idempotency-Key scoped per user and replaying returns same booking id", async () => {
    // Bước 1: Hội viên A gửi request giữ chỗ sân 1 kèm Idempotency-Key lần đầu tiên
    const key = "f07-test-key-" + Date.now();
    const reqA = new Request("http://localhost/v1/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ court_id: validCourtId, start_at: `${testDate}T08:00:00.000+07:00` }),
    });
    const resA1 = await withTx(async (sql) =>
      withIdempotency(sql, reqA, memberF07A.id, true, () => bookingsHold(sql, reqA, memberF07A))
    );
    assert.equal(resA1.status, 201);
    const bookingIdA = (resA1.body as any).booking?.id;
    assert.ok(bookingIdA);

    // Member B using the same key -> gets their own booking (not A's, different booking id)
    // Bước 2: Hội viên B dùng cùng Idempotency-Key; vì khóa được phân vùng theo user_id nên B tạo ra đơn mới trên sân 2
    const reqB = new Request("http://localhost/v1/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ court_id: validCourtId2, start_at: `${testDate}T08:00:00.000+07:00` }),
    });
    const resB = await withTx(async (sql) =>
      withIdempotency(sql, reqB, memberF07B.id, true, () => bookingsHold(sql, reqB, memberF07B))
    );
    assert.equal(resB.status, 201);
    const bookingIdB = (resB.body as any).booking?.id;
    assert.ok(bookingIdB);
    assert.notEqual(bookingIdA, bookingIdB);

    // Member A resends with same key -> same booking id
    // Bước 3: Hội viên A gửi lại đúng Idempotency-Key ban đầu; hệ thống trả lại kết quả đã lưu mà không tạo thêm đơn mới
    const countBefore = (await db.query<{ n: number }>("select count(*)::int as n from court_bookings where user_id = $1", [memberF07A.id])).rows[0].n;
    const reqA2 = new Request("http://localhost/v1/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ court_id: validCourtId, start_at: `${testDate}T08:00:00.000+07:00` }),
    });
    const resA2 = await withTx(async (sql) =>
      withIdempotency(sql, reqA2, memberF07A.id, true, () => bookingsHold(sql, reqA2, memberF07A))
    );
    assert.equal(resA2.status, 201);
    assert.equal((resA2.body as any).booking?.id, bookingIdA);
    const countAfter = (await db.query<{ n: number }>("select count(*)::int as n from court_bookings where user_id = $1", [memberF07A.id])).rows[0].n;
    assert.equal(countBefore, countAfter);
  });

  // F-26: Waitlist queue jumping
  /**
   * Làm gì: Kiểm tra vòng đời ưu tiên danh sách chờ (F-26): người ngoài chiếm chỗ khi có offer đang pending khiến offer bị skipped, từ chối nhận offer với lỗi BR-21, và gửi lại offer mới khi chỗ trống xuất hiện lại.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("F-26: pending offer reserves seat against newcomer; offer accepted -> 200; offer expired -> newcomer can take seat", async () => {
    // Bước 1: Khởi tạo huấn luyện viên, sân cầu lông, lớp học sức chứa 1 học viên, và 4 tài khoản hội viên có gói tập active
    const coach = (await db.query<{ id: string }>(
      `insert into users (phone, full_name, name_normalized, role, password_hash)
       values ('+84987654908', 'G9 Coach', 'g9 coach', 'coach', 'hash') returning id`,
    )).rows[0];
    const court = (await db.query<{ id: string }>(
      `insert into courts (court_code, sport, status) values ('G9-F26', 'badminton', 'ready') returning id`,
    )).rows[0];
    const { id: classId } = (await db.query<{ id: string }>(
      `insert into classes (sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count, price_vnd)
       select 'badminton', 'f26-test', $1, $2,
              'FREQ=WEEKLY;BYDAY=MO;BYHOUR=' || extract(hour from open_time)::int,
              (now() at time zone 'Asia/Ho_Chi_Minh')::date + 1,
              (now() at time zone 'Asia/Ho_Chi_Minh')::date + 14,
              slot_minutes, 1, 'open', 0, 300000
         from center_settings where id = 1 returning id`,
      [coach.id, court.id],
    )).rows[0];
    const members = (await db.query<any>(
      `insert into users (phone, full_name, name_normalized, role, password_hash)
       select '+8498765490' || n, 'G9 Member ' || n, 'g9 member ' || n, 'member', 'hash'
         from generate_series(1, 4) n returning *`,
    )).rows;
    const [mem1, mem2, mem3, mem4] = members;

    try {
      await db.query(
        `insert into subscriptions (user_id, plan_id, start_on, end_on, status)
         select u, (select id from membership_plans order by price_vnd limit 1), current_date - 1, current_date + 400, 'active'
           from unnest($1::uuid[]) as u`,
        [[mem1.id, mem2.id, mem3.id, mem4.id]],
      );

      // 1. mem1 enrolls -> hold (1/1)
      // Bước 2: mem1 đăng ký lớp học thành công và chiếm suất duy nhất (trạng thái hold, sĩ số 1/1)
      const enr1 = await withTx(async (sql) => classesEnroll(sql, classId, new Request("http://localhost"), mem1));
      assert.equal(enr1.status, 201);
      assert.equal((enr1.body as any).enrollment?.status, "hold");

      // 2. mem2 enrolls -> waitlisted
      // Bước 3: mem2 đăng ký khi lớp đã hết chỗ; hệ thống tự động đưa mem2 vào danh sách chờ (waitlisted)
      const enr2 = await withTx(async (sql) => classesEnroll(sql, classId, new Request("http://localhost"), mem2));
      assert.equal(enr2.status, 201);
      assert.equal((enr2.body as any).enrollment?.status, "waitlisted");

      // 3. mem1 cancels -> triggers inviteWaitlist -> creates offer for mem2
      // Bước 4: mem1 hủy đơn giữ chỗ; hệ thống kích hoạt inviteWaitlist để tạo lời mời nhận suất (offer pending) cho mem2
      await withTx(async (sql) => enrollmentDelete(sql, (enr1.body as any).enrollment.id, mem1));
      await withTx(async (sql) => inviteWaitlist(sql, classId));

      const offer = (await db.query<{ id: string }>(
        "select o.id from waitlist_offers o join enrollments e on e.id = o.enrollment_id where e.class_id = $1 and o.status = 'pending'",
        [classId]
      )).rows[0];
      assert.ok(offer);

      // 4. mem3 (newcomer) attempts to enroll while offer is pending -> hold (D5: free seat is not held back)
      // Bước 5: mem3 đăng ký mới khi có chỗ trống; theo thiết kế D5 chỗ trống không bị phong tỏa nên mem3 giữ chỗ (hold) và offer của mem2 bị chuyển thành skipped
      const enr3 = await withTx(async (sql) => classesEnroll(sql, classId, new Request("http://localhost"), mem3));
      assert.equal(enr3.status, 201);
      assert.equal((enr3.body as any).enrollment?.status, "hold");

      // offer for mem2 was skipped
      const offerAfter = (await db.query<{ status: string }>("select status from waitlist_offers where id = $1", [offer.id])).rows[0];
      assert.equal(offerAfter.status, "skipped");

      // mem2 attempts to accept skipped/full offer -> throws BR-21
      // Bước 6: mem2 cố gắng chấp nhận offer đã bị skipped/lớp đã đầy; hệ thống từ chối với lỗi BR-21 và giữ nguyên vị trí waitlist của mem2
      await assert.rejects(
        () => withTx(async (sql) => waitlistAccept(sql, offer.id, mem2)),
        (err: any) => {
          assert.equal(err.extra?.br, "BR-21");
          return true;
        }
      );
      // The refused accept changed nothing: mem2 is still waitlisted and the offer is still skipped.
      const mem2After = (await db.query<{ status: string }>("select status from enrollments where id = $1", [(enr2.body as any).enrollment.id])).rows[0];
      assert.equal(mem2After.status, "waitlisted");
      const offerStill = (await db.query<{ status: string }>("select status from waitlist_offers where id = $1", [offer.id])).rows[0];
      assert.equal(offerStill.status, "skipped");

      // Cancel mem3 -> triggers new offer for mem2
      // Bước 7: mem3 hủy chỗ giữ; hệ thống gửi lại lời mời waitlist mới cho mem2
      await withTx(async (sql) => enrollmentDelete(sql, (enr3.body as any).enrollment.id, mem3));
      const newOffer = (await db.query<{ id: string }>(
        "select o.id from waitlist_offers o join enrollments e on e.id = o.enrollment_id where e.class_id = $1 and o.status = 'pending'",
        [classId]
      )).rows[0];
      assert.ok(newOffer);

      // 5. mem2 accepts offer -> 200, a hold awaiting payment
      // Bước 8: mem2 chấp nhận lời mời mới thành công (HTTP 200) và đơn đăng ký chuyển sang trạng thái hold chờ thanh toán
      const accRes = await withTx(async (sql) => waitlistAccept(sql, newOffer.id, mem2));
      assert.equal(accRes.status, 200);
      const mem2Enr = (await db.query<{ status: string }>("select status from enrollments where id = $1", [(enr2.body as any).enrollment.id])).rows[0];
      assert.equal(mem2Enr.status, "hold");
    } finally {
      // Clean up test class and enrollments so later tests don't clash on court
      // Bước 9: Dọn dẹp dữ liệu kiểm thử (offers, enrollments, classes) trong khối finally để tránh đụng độ lịch sân
      await db.query("delete from waitlist_offers where enrollment_id in (select id from enrollments where class_id = $1)", [classId]);
      await db.query("delete from enrollments where class_id = $1", [classId]);
      await db.query("delete from classes where id = $1", [classId]);
    }
  });

  /**
   * Làm gì: Kiểm tra quy tắc nghiệp vụ BR-63: mỗi hội viên không được tham gia đồng thời số lượng lớp học vượt quá giới hạn max_active_classes của trung tâm.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("BR-63: a member cannot be in more classes at once than the centre allows", async () => {
    // Bước 1: Khởi tạo thông tin huấn luyện viên, 2 lớp học (c1 vào Thứ 2, c2 vào Thứ 5) và tài khoản hội viên
    const coachId = "00000000-0000-0000-0000-000000000011";
    const c1 = "40000000-0000-0000-0000-0000000000c1";
    const c2 = "40000000-0000-0000-0000-0000000000c2";
    const m = { id: "00000000-0000-0000-0000-0000000001c1", phone: "+84900001c1", name: "Cap", role: "member" } as any;
    const before = (await db.query(`select max_active_classes from center_settings where id = 1`)).rows[0] as any;
    try {
      // Bước 2: Thiết lập giới hạn max_active_classes = 1 trong cấu hình trung tâm (center_settings) để thử nghiệm
      await db.query(`update center_settings set max_active_classes = 1 where id = 1`);
      // Bước 3: Tạo dữ liệu 2 lớp học c1, c2 và cấp gói tập active cho hội viên
      for (const [id, day] of [[c1, "MO"], [c2, "TH"]]) {
        await db.query(
          `insert into classes (id, sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count, price_vnd)
           values ($1, 'badminton', 'scratch', $2, $3, $4, current_date + 3, current_date + 30, 60, 5, 'open', 0, 300000)`,
          [id, coachId, validCourtId, `FREQ=WEEKLY;BYDAY=${day};BYHOUR=6`],
        );
      }
      await db.query(`insert into users (id, phone, full_name, name_normalized, role, password_hash) values ($1,$2,$3,$4,'member','hash') on conflict (id) do nothing`, [m.id, m.phone, m.name, "cap"]);
      await db.query(`insert into subscriptions (user_id, plan_id, start_on, end_on, status) values ($1, (select id from membership_plans order by price_vnd limit 1), current_date - 1, current_date + 400, 'active')`, [m.id]);
      // Bước 4: Hội viên đăng ký lớp thứ nhất (c1) thành công
      await withTx(async (sql) => classesEnroll(sql, c1, new Request("http://localhost"), m));
      // Bước 5: Hội viên đăng ký tiếp lớp thứ hai (c2); hệ thống từ chối do vi phạm quy tắc BR-63 vượt quá số lớp được phép tham gia cùng lúc
      await assert.rejects(
        withTx(async (sql) => classesEnroll(sql, c2, new Request("http://localhost"), m)),
        /the most at once/,
      );
    } finally {
      // Bước 6: Khôi phục cấu hình max_active_classes ban đầu và xóa dữ liệu lớp học thử nghiệm
      await db.query(`update center_settings set max_active_classes = $1 where id = 1`, [before.max_active_classes]);
      await db.query("delete from enrollments where class_id in ($1, $2)", [c1, c2]);
      await db.query("delete from classes where id in ($1, $2)", [c1, c2]);
    }
  });

  /**
   * Làm gì: Kiểm tra việc dồn hàng đợi waitlist (compaction) vẫn hoạt động đúng thứ tự ngay cả khi thứ tự lưu trữ vật lý trong bảng bị xáo trộn do cập nhật dòng.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("waitlist claim survives out-of-order compaction and the freed seat goes to the first in line", async () => {
    // Bước 1: Tạo lớp học sức chứa 1 học viên và khởi tạo 4 hội viên A, B, C, D có gói tập active
    const coachId = "00000000-0000-0000-0000-000000000011";
    const classId = "40000000-0000-0000-0000-0000000000aa";
    await db.query(
      `insert into classes (id, sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count, price_vnd)
       values ($1, 'badminton', 'scratch', $2, $3, 'FREQ=WEEKLY;BYDAY=TU;BYHOUR=15', current_date + 3, current_date + 30, 60, 1, 'open', 0, 300000)`,
      [classId, coachId, validCourtId],
    );
    const a = { id: "00000000-0000-0000-0000-0000000001a1", phone: "+84900001a1", name: "A", role: "member" } as any;
    const b = { id: "00000000-0000-0000-0000-0000000001a2", phone: "+84900001a2", name: "B", role: "member" } as any;
    const c = { id: "00000000-0000-0000-0000-0000000001a3", phone: "+84900001a3", name: "C", role: "member" } as any;
    const d = { id: "00000000-0000-0000-0000-0000000001a4", phone: "+84900001a4", name: "D", role: "member" } as any;
    for (const m of [a, b, c, d]) {
      await db.query(`insert into users (id, phone, full_name, name_normalized, role, password_hash) values ($1,$2,$3,$4,'member','hash') on conflict (id) do nothing`, [m.id, m.phone, m.name, m.name.toLowerCase()]);
      await db.query(`insert into subscriptions (user_id, plan_id, start_on, end_on, status) values ($1, (select id from membership_plans order by price_vnd limit 1), current_date - 1, current_date + 400, 'active')`, [m.id]);
    }
    // Bước 2: Hội viên A đăng ký trước và được xác nhận (confirmed); các hội viên B, C, D đăng ký sau và vào waitlist (vị trí 1, 2, 3)
    const ea = await withTx(async (sql) => classesEnroll(sql, classId, new Request("http://localhost"), a));
    await db.query(`update enrollments set status='confirmed', hold_until=null where id=$1`, [(ea.body as any).enrollment.id]);
    for (const m of [b, c, d]) await withTx(async (sql) => classesEnroll(sql, classId, new Request("http://localhost"), m));
    // Bước 3: Hội viên A hủy tham gia; hệ thống phát sinh 1 offer waitlist cho người đứng đầu hàng đợi (B)
    await withTx(async (sql) => enrollmentDelete(sql, (ea.body as any).enrollment.id, a));
    const offers = (await db.query(`select o.* from waitlist_offers o join enrollments e on e.id=o.enrollment_id where e.class_id=$1`, [classId])).rows;
    assert.equal(offers.length, 1);
    // Touching C moves its row to the end of the heap, so compaction meets D (3 -> 2) before C leaves 2.
    // Cập nhật giá để thay đổi vị trí dòng của C trong heap table, giả lập tình huống compaction gặp D trước C
    await db.query(`update enrollments set price_vnd = price_vnd where class_id=$1 and user_id=$2`, [classId, c.id]);
    // Bước 4: Hội viên B chấp nhận offer và chuyển sang trạng thái hold; các vị trí trong waitlist được dồn lại (C lên 1, D lên 2)
    const r = await withTx(async (sql) => waitlistAccept(sql, (offers[0] as any).id, b));
    assert.equal((r.body as any).status, "hold");
    // Bước 5: Hội viên A đăng ký lại và bị đẩy xuống cuối hàng đợi waitlist ở vị trí 3
    const re = await withTx(async (sql) => classesEnroll(sql, classId, new Request("http://localhost"), a));
    assert.equal((re.body as any).enrollment.status, "waitlisted");
    const pos = (await db.query(`select user_id, waitlist_pos from enrollments where class_id=$1 and status='waitlisted' order by waitlist_pos`, [classId])).rows.map((x: any) => [x.user_id, x.waitlist_pos]);
    assert.deepEqual(pos, [[c.id, 1], [d.id, 2], [a.id, 3]]);
    // Bước 6: Dọn dẹp dữ liệu kiểm thử của lớp học và các bản ghi liên quan
    await db.query(`delete from waitlist_offers where enrollment_id in (select id from enrollments where class_id=$1)`, [classId]);
    await db.query(`delete from enrollments where class_id=$1`, [classId]);
    await db.query(`delete from classes where id=$1`, [classId]);
  });

  /**
   * Làm gì: Kiểm tra hàm inviteWaitlist gửi đồng thời nhiều offer tương ứng với toàn bộ số chỗ trống hiện có, thay vì chỉ mời duy nhất người đầu tiên.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("inviteWaitlist offers one seat per open place, not only the first person", async () => {
    // Bước 1: Khởi tạo thông tin lớp học sức chứa 3 học viên và danh sách 3 hội viên mẫu
    const coachId = "00000000-0000-0000-0000-000000000011";
    const classId = "40000000-0000-0000-0000-000000000191";
    const members = [1, 2, 3].map((n) => ({
      id: `00000000-0000-0000-0000-00000000019${n}`,
      phone: `+8490000019${n}`,
      name: `Wait ${n}`,
    }));
    try {
      // Bước 2: Tạo lớp học có sức chứa capacity = 3 nhưng chưa có ai đăng ký chính thức (enrolled_count = 0)
      await db.query(
        `insert into classes (id, sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count)
         values ($1, 'badminton', 'wl-seats', $2, $3, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=8', current_date + 1, current_date + 14, 60, 3, 'open', 0)`,
        [classId, coachId, validCourtId],
      );
      // Bước 3: Đưa cả 3 hội viên vào danh sách chờ (waitlist) ở các vị trí 1, 2, 3
      for (const [i, m] of members.entries()) {
        await db.query(
          `insert into users (id, phone, full_name, name_normalized, role, password_hash)
           values ($1, $2, $3, $4, 'member', 'hash') on conflict (id) do nothing`,
          [m.id, m.phone, m.name, m.name.toLowerCase()],
        );
        await db.query(
          `insert into enrollments (class_id, user_id, status, waitlist_pos) values ($1, $2, 'waitlisted', $3)`,
          [classId, m.id, i + 1],
        );
      }
      // Bước 4: Gọi hàm inviteWaitlist để phát lời mời tham gia lớp học cho các ứng viên đang chờ
      await withTx(async (sql) => inviteWaitlist(sql, classId));
      // Bước 5: Xác nhận hệ thống tạo đủ 3 lời mời pending tương ứng với cả 3 chỗ đang trống của lớp
      const offers = (
        await db.query<{ n: number }>(
          `select count(*)::int as n from waitlist_offers o
             join enrollments e on e.id = o.enrollment_id
            where e.class_id = $1 and o.status = 'pending'`,
          [classId],
        )
      ).rows[0];
      assert.equal(offers.n, 3);
    } finally {
      // Bước 6: Dọn dẹp dữ liệu bảng waitlist_offers, enrollments và classes trong khối finally
      await db.query("delete from waitlist_offers where enrollment_id in (select id from enrollments where class_id = $1)", [classId]);
      await db.query("delete from enrollments where class_id = $1", [classId]);
      await db.query("delete from classes where id = $1", [classId]);
    }
  });

  // F-04: next_member_code past 0099
  /**
   * Làm gì: Kiểm tra hàm SQL next_member_code (F-04): tự động tăng mã hội viên vượt mốc 0099 lên 0101 (tránh trùng 0100 đã có) và đảm bảo không trùng lặp qua 150 lần gọi liên tiếp.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("F-04: seed A3-2026-0099 and A3-2026-0100 -> next code is A3-2026-0101, 150 consecutive calls without collision", async () => {
    // Bước 1: Lấy năm hiện tại để tạo tiền tố mã hội viên chuẩn A3-YYYY-xxxx
    const y = new Date().getFullYear();
    // Seed 0099 and 0100
    // Bước 2: Seed trước hai hội viên có mã 0099 và 0100, đồng thời đặt bộ đếm n = 98 để kiểm tra khả năng nhảy cóc qua mã đã tồn tại
    await db.query("insert into users (id, phone, full_name, name_normalized, role, member_code, password_hash) values (gen_random_uuid(), '0988000099', 'Seed 99', 'seed 99', 'member', $1, 'hash') on conflict do nothing", [`A3-${y}-0099`]);
    await db.query("insert into users (id, phone, full_name, name_normalized, role, member_code, password_hash) values (gen_random_uuid(), '0988000100', 'Seed 100', 'seed 100', 'member', $1, 'hash') on conflict do nothing", [`A3-${y}-0100`]);
    await db.query("insert into code_counters (kind, yyyy, n) values ('member', $1, 98) on conflict (kind, yyyy) do update set n = 98", [y]);

    // Bước 3: Gọi hàm next_member_code() lần đầu; vì 0099 và 0100 đã có người dùng nên mã tiếp theo phải là 0101
    const code1 = (await db.query<{ next_member_code: string }>("select next_member_code()")).rows[0].next_member_code;
    assert.equal(code1, `A3-${y}-0101`);

    // 150 consecutive calls
    // Bước 4: Khởi tạo Set lưu các mã đã sinh để kiểm tra tính duy nhất qua 150 lần gọi tiếp theo
    const seen = new Set<string>();
    seen.add(code1);
    // Bước 2: Vòng lặp gọi liên tiếp 150 lần hàm next_member_code() để kiểm tra không bị trùng mã và đúng định dạng A3-YYYY-NNNN
    for (let i = 0; i < 150; i++) {
      const code = (await db.query<{ next_member_code: string }>("select next_member_code()")).rows[0].next_member_code;
      assert.ok(!seen.has(code), `Duplicate code: ${code}`);
      seen.add(code);
      assert.match(code, new RegExp(`^A3-${y}-\\d{4,}$`));
    }
  });
});

describe("Round 7: Group A unit tests (F-08, F-11)", () => {
  /**
   * Làm gì: Kiểm tra tính năng F-08 cho phép người dùng đăng nhập bằng email không phân biệt chữ hoa hay chữ thường (case-insensitive).
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("F-08: 'Abc@X.com' can log in to account registered with 'abc@x.com'", async () => {
    // Bước 1: Chuẩn bị dữ liệu tài khoản mẫu với email viết thường hoàn toàn (abc@x.com)
    const phone = "0987000008";
    const email = "abc@x.com";
    await db.query(
      `insert into users (id, phone, full_name, name_normalized, email, role, status, password_hash)
       values (gen_random_uuid(), $1, 'Test F08', 'test f08', $2, 'member', 'active', $3)
       on conflict (phone) do update set email = $2`,
      [phone, email, hashPassword("Pass12345!")],
    );

    // Bước 2: Thực hiện kiểm thử trong transaction cách ly: xác minh cả hàm tìm kiếm và endpoint đăng nhập đều tìm thấy tài khoản khi nhập email hỗn hợp hoa thường
    await withTx(async (sql) => {
      // 1. findUserByLogin with mixed case email
      const u = await findUserByLogin(sql, "Abc@X.com");
      assert.ok(u, "findUserByLogin should find user with mixed case email");
      assert.equal(u.email, "abc@x.com");

      // 2. login handler with mixed case email
      const req = new Request("http://localhost/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login: "Abc@X.com", password: "Pass12345!" }),
      });
      const res = await authH.login(sql, req);
      assert.equal(res.status, 200);
      assert.ok((res.body as any).token);
    });
  });

  /**
   * Làm gì: Kiểm tra tính năng F-11: Khi đổi mật khẩu tại phiên hiện tại (session 1), toàn bộ các phiên khác (session 2) phải bị thu hồi, phiên hiện tại vẫn đăng nhập bình thường.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("F-11: change password in session 1 -> session 2 is revoked, session 1 stays signed in", async () => {
    // Bước 1: Khởi tạo người dùng thử nghiệm và cấp phát 2 token phiên (session s1 và s2)
    const phone = "0987000011";
    const pwHash = hashPassword("OldPass123!");
    const userId = (
      await db.query<{ id: string }>(
        `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
         values (gen_random_uuid(), $1, 'Test F11', 'test f11', 'member', 'active', $2)
         returning id`,
        [phone, pwHash],
      )
    ).rows[0].id;

    const userRow = (await db.query("select * from users where id = $1", [userId])).rows[0];
    const userPub = toPublic(userRow as any);

    let s1: any;
    let s2: any;
    await withTx(async (sql) => {
      s1 = await issueSession(sql, userPub);
      s2 = await issueSession(sql, userPub);
    });

    // Both sessions valid initially
    // Bước 2: Xác minh cả 2 phiên s1 và s2 đều hợp lệ và truy xuất đúng thông tin user qua /v1/me
    await withTx(async (sql) => {
      const u1 = await authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${s1.token}` } }));
      const u2 = await authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${s2.token}` } }));
      assert.equal(u1.id, userId);
      assert.equal(u2.id, userId);
    });

    // Session 1 changes password
    // Bước 3: Thực hiện đổi mật khẩu bằng phiên s1 qua endpoint /v1/me/password, hệ thống trả về signed_out = 1 tương ứng thu hồi các phiên khác
    await withTx(async (sql) => {
      const changeReq = new Request("http://localhost/v1/me/password", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${s1.token}` },
        body: JSON.stringify({ current_password: "OldPass123!", new_password: "NewPass123!", confirm_password: "NewPass123!" }),
      });
      const res = await authH.mePassword(sql, changeReq, userPub);
      assert.equal(res.status, 200);
      assert.equal((res.body as any).signed_out, 1);
    });

    // Session 2 is revoked -> throws 401
    // Bước 4: Kiểm tra phiên s2 đã bị vô hiệu hóa (ném lỗi 401 Unauthorized), trong khi phiên s1 vẫn tiếp tục duy trì đăng nhập thành công
    await withTx(async (sql) => {
      await assert.rejects(
        async () => {
          await authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${s2.token}` } }));
        },
        (err: any) => {
          assert.equal(err.status, 401);
          return true;
        },
      );

      // Session 1 stays signed in
      const u1 = await authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${s1.token}` } }));
      assert.equal(u1.id, userId);
    });
  });
});

describe("Round 7: Group B unit tests (F-15, F-20, F-19)", () => {
  /**
   * Làm gì: Kiểm tra tính năng F-15 phòng chống CSV Formula Injection qua hàm csvCell (thêm tiền tố nháy đơn trước các ký tự kích hoạt công thức) đồng thời giữ nguyên chuỗi thông thường và dữ liệu số.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("F-15: csvCell neutralises formula injection and preserves normal strings/numbers", () => {
    // Starts with =, +, -, @, \t, \r -> prefixed with '
    // Bước 1: Kiểm tra các chuỗi bắt đầu bằng ký tự nguy hiểm (=, +, @, tab) đều được thêm tiền tố nháy đơn (') để phần mềm bảng tính không thực thi công thức
    assert.equal(csvCell("=1+1"), "'=1+1");
    assert.equal(csvCell("+84971234567"), "'+84971234567");
    assert.equal(csvCell("@cmd"), "'@cmd");
    assert.equal(csvCell("\tindented"), "'\tindented");

    // Negative case: 'Nguyễn' does NOT get prefixed with '
    // Bước 2: Kiểm tra chuỗi văn bản thông thường không chứa ký tự kích hoạt công thức thì không bị thêm tiền tố nháy đơn
    assert.equal(csvCell("Nguyễn Văn A"), "Nguyễn Văn A");

    // Negative case: purely numeric values (including negative money) are NOT prefixed with '
    // Bước 3: Kiểm tra các giá trị số và chuỗi số (kể cả số âm biểu thị tiền hoàn) được giữ nguyên vẹn để bảng tính nhận diện đúng kiểu số
    assert.equal(csvCell(500000), "500000");
    assert.equal(csvCell(-20000), "-20000");
    assert.equal(csvCell("-50000"), "-50000");
  });

});

describe("Round 7: Group C unit tests (CL-21, CL-22, CL-23, CL-24, SS-18, SS-20, AT-12, TR-47)", () => {
  // Dữ liệu mẫu dùng chung cho nhóm test C: người dùng có quyền manager, coach và mã sân cầu lông mặc định
  const managerUser = { id: "00000000-0000-0000-0000-000000000001", role: "manager", full_name: "Quản lý" } as any;
  const coachUser = { id: "00000000-0000-0000-0000-000000000011", role: "coach", full_name: "HLV" } as any;
  const badmintonCourtId = "10000000-0000-0000-0000-000000000001";

  /**
   * Làm gì: Kiểm tra quy tắc nghiệp vụ CL-21: Giới hạn sĩ số tối đa của lớp học là 200, từ chối capacity > 200 với mã lỗi 400 và chấp nhận capacity <= 200 với mã 201 Created.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  // CL-21: capacity > 200 rejected, <= 200 accepted
  it("CL-21: rejects capacity > 200 with 400, accepts capacity <= 200 with 201", async () => {
    await withTx(async (sql) => {
      // Negative
      // Bước 1: Trường hợp lỗi (negative test) - gửi capacity = 1000 vượt ngưỡng 200, kiểm tra ném lỗi 400 tại trường capacity
      const reqBad = new Request("http://localhost/v1/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sport: "badminton",
          level: "cl21-test",
          coach_id: coachUser.id,
          court_id: badmintonCourtId,
          rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=10",
          start_on: "2027-11-01",
          end_on: "2027-11-30",
          capacity: 1000,
        }),
      });
      await assert.rejects(
        async () => classesCreate(sql, reqBad, managerUser),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "capacity");
          return true;
        },
      );

      // Positive
      // Bước 2: Trường hợp thành công (positive test) - gửi capacity = 200 chạm ngưỡng biên tối đa cho phép, tạo lớp thành công với mã 201
      const reqGood = new Request("http://localhost/v1/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sport: "badminton",
          level: "cl21-test-ok",
          coach_id: coachUser.id,
          court_id: badmintonCourtId,
          rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=10",
          start_on: "2027-11-01",
          end_on: "2027-11-30",
          capacity: 200,
        }),
      });
      const res = await classesCreate(sql, reqGood, managerUser);
      assert.equal(res.status, 201);
      assert.equal((res.body as any).capacity, 200);
    });
  });

  /**
   * Làm gì: Kiểm tra quy tắc nghiệp vụ CL-22: Xác thực giá trị giờ trong quy tắc lặp rrule (BYHOUR), từ chối giờ không hợp lệ (25) với mã lỗi 400 và chấp nhận giờ hợp lệ (11) với mã 201 Created.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  // CL-22: BYHOUR=25 rejected with 400, BYHOUR=10 accepted with 201
  it("CL-22: rejects invalid BYHOUR with 400, accepts valid BYHOUR with 201", async () => {
    await withTx(async (sql) => {
      // Negative: BYHOUR=25
      // Bước 1: Trường hợp lỗi (negative test) - truyền BYHOUR=25 ngoài phạm vi 0-23 giờ trong ngày, kiểm tra ném lỗi 400 tại trường rrule
      const reqBad = new Request("http://localhost/v1/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sport: "badminton",
          level: "cl22-test",
          coach_id: coachUser.id,
          court_id: badmintonCourtId,
          rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=25",
          start_on: "2027-11-01",
          end_on: "2027-11-30",
          capacity: 20,
        }),
      });
      await assert.rejects(
        async () => classesCreate(sql, reqBad, managerUser),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "rrule");
          return true;
        },
      );

      // Positive: BYHOUR=10
      // Bước 2: Trường hợp thành công (positive test) - truyền BYHOUR=11 hợp lệ, tạo lớp thành công với mã 201 Created
      const reqGood = new Request("http://localhost/v1/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sport: "badminton",
          level: "cl22-test-ok",
          coach_id: coachUser.id,
          court_id: badmintonCourtId,
          rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=11",
          start_on: "2027-11-01",
          end_on: "2027-11-30",
          capacity: 20,
        }),
      });
      const res = await classesCreate(sql, reqGood, managerUser);
      assert.equal(res.status, 201);
    });
  });

  /**
   * Làm gì: Kiểm tra quy tắc nghiệp vụ CL-23: Xác thực khoảng thời gian khóa học bắt buộc start_on <= end_on, nếu ngày bắt đầu sau ngày kết thúc thì từ chối với lỗi 400 tại trường end_on.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  // CL-23: start_on > end_on rejected with 400, start_on <= end_on accepted with 201
  it("CL-23: rejects start_on > end_on with 400, accepts start_on <= end_on with 201", async () => {
    await withTx(async (sql) => {
      // Negative
      // Bước 1: Trường hợp lỗi (negative test) - ngày bắt đầu (30/11) sau ngày kết thúc (01/11), kiểm tra ném lỗi 400 tại trường end_on
      const reqBad = new Request("http://localhost/v1/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sport: "badminton",
          level: "cl23-test",
          coach_id: coachUser.id,
          court_id: badmintonCourtId,
          rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=10",
          start_on: "2027-11-30",
          end_on: "2027-11-01",
          capacity: 20,
        }),
      });
      await assert.rejects(
        async () => classesCreate(sql, reqBad, managerUser),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "end_on");
          return true;
        },
      );

      // Positive
      // Bước 2: Trường hợp thành công (positive test) - ngày bắt đầu (01/11) trước ngày kết thúc (30/11), tạo lớp thành công với mã 201
      const reqGood = new Request("http://localhost/v1/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sport: "badminton",
          level: "cl23-test-ok",
          coach_id: coachUser.id,
          court_id: badmintonCourtId,
          rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=12",
          start_on: "2027-11-01",
          end_on: "2027-11-30",
          capacity: 20,
        }),
      });
      const res = await classesCreate(sql, reqGood, managerUser);
      assert.equal(res.status, 201);
    });
  });

  /**
   * Làm gì: Kiểm tra quy tắc nghiệp vụ CL-24: Đảm bảo môn thể thao của lớp phải khớp với môn thể thao của sân (court sport match), từ chối tạo lớp cầu lông trên sân bóng rổ với mã 400.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  // CL-24: court sport mismatch rejected with 400, matching court accepted with 201
  it("CL-24: rejects court sport mismatch with 400, accepts matching court with 201", async () => {
    // Find or insert a basketball court
    // Bước 1: Chuẩn bị dữ liệu - lấy hoặc chèn sân bóng rổ (sport = 'basketball') để kiểm tra tính tương thích môn thể thao
    let basketballCourt = (await db.query<{ id: string }>("select id from courts where sport = 'basketball' limit 1")).rows[0];
    if (!basketballCourt) {
      basketballCourt = (await db.query<{ id: string }>(
        `insert into courts (court_code, sport, is_active) values ('BB-TEST', 'basketball', true) returning id`
      )).rows[0];
    }

    await withTx(async (sql) => {
      // Negative: badminton class on basketball court
      // Bước 2: Trường hợp lỗi (negative test) - cố tình tạo lớp cầu lông trên sân bóng rổ, kiểm tra ném lỗi 400 tại trường court_id
      const reqBad = new Request("http://localhost/v1/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sport: "badminton",
          level: "cl24-test",
          coach_id: coachUser.id,
          court_id: basketballCourt.id,
          rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=10",
          start_on: "2027-11-01",
          end_on: "2027-11-30",
          capacity: 20,
        }),
      });
      await assert.rejects(
        async () => classesCreate(sql, reqBad, managerUser),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "court_id");
          return true;
        },
      );

      // Positive: badminton class on badminton court
      // Bước 3: Trường hợp thành công (positive test) - tạo lớp cầu lông trên đúng sân cầu lông, tạo lớp thành công với mã 201
      const reqGood = new Request("http://localhost/v1/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sport: "badminton",
          level: "cl24-test-ok",
          coach_id: coachUser.id,
          court_id: badmintonCourtId,
          rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=13",
          start_on: "2027-11-01",
          end_on: "2027-11-30",
          capacity: 20,
        }),
      });
      const res = await classesCreate(sql, reqGood, managerUser);
      assert.equal(res.status, 201);
    });
  });

  /**
   * Làm gì: Kiểm tra quy tắc nghiệp vụ CL-25: Phát hiện trùng lịch sân, từ chối tạo lớp mới với mã lỗi 409 Conflict nếu trùng cùng sân, cùng thứ trong tuần và cùng khung giờ với lớp đã có.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("CL-25: a class on the same court, weekday and hour as an existing one is refused with 409", async () => {
    await withTx(async (sql) => {
      // CL-24 left a Monday 13:00 class on this court for November.
      // Bước 1: Gửi yêu cầu tạo lớp học trùng vào Thứ 2 lúc 13h trên sân đã được đăng ký ở test trước đó
      const reqClash = new Request("http://localhost/v1/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sport: "badminton",
          level: "cl25-clash",
          coach_id: coachUser.id,
          court_id: badmintonCourtId,
          rrule: "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=13",
          start_on: "2027-11-10",
          end_on: "2027-12-20",
          capacity: 9,
        }),
      });
      // Bước 2: Kiểm tra hệ thống phát hiện xung đột chiếm dụng sân và từ chối với mã lỗi 409 Conflict
      await assert.rejects(
        async () => classesCreate(sql, reqClash, managerUser),
        (err: any) => {
          assert.equal(err.status, 409);
          return true;
        },
      );
    });
  });

  /**
   * Làm gì: Kiểm tra quy tắc SS-18 và SS-20 khi dời lịch buổi học (session reschedule): từ chối dời ra ngoài giờ mở cửa (lỗi 422 BR-06), từ chối dời vượt quá ngày kết thúc lớp (lỗi 400), và chấp nhận khi lịch mới hợp lệ (200 OK).
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  // SS-18 & SS-20: session reschedule outside hours or past class end_on
  it("SS-18 & SS-20: session reschedule outside hours or past end_on rejected, valid reschedule accepted", async () => {
    // Dates are relative to "now" and far past the seeded bookings: the seed
    // fills the courts for the next days, so fixed dates collided with it
    // (409 on the valid reschedule) and went stale once the day passed.
    /**
     * Làm gì: Tính toán chuỗi ngày định dạng YYYY-MM-DD theo múi giờ Việt Nam (ICT, UTC+7) sau một số ngày xác định từ thời điểm hiện tại.
     * Được gọi ở: test case SS-18 & SS-20 trong tx.test.ts
     * @param plusDays Số ngày cộng thêm tính từ hôm nay
     * @returns {string} Chuỗi ngày có định dạng YYYY-MM-DD
     */
    const ictDay = (plusDays: number) =>
      new Date(Date.now() + plusDays * 86400000 + 7 * 3600000).toISOString().slice(0, 10);
    const dStart = ictDay(40);
    const dMove = ictDay(41);
    const dEnd = ictDay(55);
    const dPast = ictDay(70);
    // Bước 1: Khởi tạo lớp học, bản ghi chiếm sân (occupancies) và buổi học (sessions) với ngày trong tương lai xa để không đụng lịch seed data
    const clId = (
      await db.query<{ id: string }>(
        `insert into classes (sport, level, coach_id, court_id, capacity, rrule, duration_min, start_on, end_on, status)
         values ('badminton', 'ss-test', $1, $2, 10, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10', 60, '${dStart}', '${dEnd}', 'open')
         returning id`,
        [coachUser.id, badmintonCourtId],
      )
    ).rows[0].id;

    const occId = (await db.query<{ id: string }>(`
      insert into occupancies (court_id, start_at, end_at, kind, ref_id)
      values ($1, '${dStart} 10:00:00+07', '${dStart} 11:00:00+07', 'session', gen_random_uuid())
      returning id
    `, [badmintonCourtId])).rows[0].id;

    const sessId = (
      await db.query<{ id: string }>(
        `insert into sessions (class_id, court_id, start_at, end_at, status, occupancy_id)
         values ($1, $2, '${dStart} 10:00:00+07', '${dStart} 11:00:00+07', 'scheduled', $3)
         returning id`,
        [clId, badmintonCourtId, occId],
      )
    ).rows[0].id;

    await withTx(async (sql) => {
      // SS-18: reschedule to 03:00 (outside opening hours) -> 422 BR-06
      // Bước 2: SS-18 - Cố tình dời buổi học về 03:00 sáng (ngoài giờ mở cửa), kiểm tra ném lỗi 422 vi phạm quy tắc BR-06
      const req0300 = new Request(`http://localhost/v1/sessions/${sessId}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ start_at: `${dStart}T03:00:00.000+07:00`, reason: "test 03:00" }),
      });
      await assert.rejects(
        async () => sessionReschedule(sql, sessId, req0300, managerUser),
        (err: any) => {
          assert.equal(err.code, "BR_VIOLATION");
          assert.equal(err.extra?.br, "BR-06");
          return true;
        },
      );

      // SS-20: reschedule past class end_on (2026-11-20) -> 400
      const reqPastEnd = new Request(`http://localhost/v1/sessions/${sessId}/reschedule`, {
        // Bước 3: SS-20 - Cố tình dời buổi học vượt quá ngày kết thúc khóa học dEnd, kiểm tra ném lỗi 400 tại trường start_at
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ start_at: `${dPast}T10:00:00.000+07:00`, reason: "test past end" }),
      });
      await assert.rejects(
        async () => sessionReschedule(sql, sessId, reqPastEnd, managerUser),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "start_at");
          return true;
        },
      );

      // Positive: reschedule within hours and class end_on -> 200
      // Bước 4: Trường hợp hợp lệ - dời buổi học sang ngày dMove trong giờ mở cửa và trước khi khóa học kết thúc, kiểm tra trả về 200 OK
      const reqValid = new Request(`http://localhost/v1/sessions/${sessId}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ start_at: `${dMove}T10:00:00.000+07:00`, reason: "test valid reschedule" }),
      });
      const res = await sessionReschedule(sql, sessId, reqValid, managerUser);
      assert.equal(res.status, 200);
    });
  });

  /**
   * Làm gì: Kiểm tra quy tắc nghiệp vụ AT-12: Ngăn chặn điểm danh cho buổi học chưa bắt đầu với mã lỗi 400 và chấp nhận điểm danh khi buổi học đã hoặc đang diễn ra với mã 200 OK.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  // AT-12: attendance marking for unstarted session rejected with 400, started session accepted with 200
  it("AT-12: rejects attendance for session that has not started with 400, accepts started session with 200", async () => {
    // Ensure feature flag F4 is on
    // Bước 1: Kích hoạt feature flag F4 trong cơ sở dữ liệu vì API sessionAttendancePost yêu cầu cờ này phải bật mới cho phép điểm danh
    await db.query("insert into feature_flags (key, enabled) values ('F4', true) on conflict (key) do update set enabled = true");

    // Bước 2: Chuẩn bị thông tin hội viên (memberUser) và tạo lớp học cầu lông mẫu (classes).
    const memberUser = { id: "00000000-0000-0000-0000-000000000004", role: "member" } as any;
    const clId = (
      await db.query<{ id: string }>(
        `insert into classes (sport, level, coach_id, court_id, capacity, rrule, duration_min, start_on, end_on, status)
         values ('badminton', 'at12-test', $1, $2, 10, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10', 60, '2026-01-01', '2026-12-31', 'open')
         returning id`,
        [coachUser.id, badmintonCourtId],
      )
    ).rows[0].id;

    // Enrolled member
    await db.query(
      `insert into enrollments (class_id, user_id, status) values ($1, $2, 'confirmed') on conflict do nothing`,
      [clId, memberUser.id],
    );

    // Bước 3: Tạo 2 buổi học mẫu để kiểm tra: một buổi trong tương lai (chưa bắt đầu) và một buổi trong quá khứ (đã bắt đầu cách đây 2 giờ).
    // Future session (not started)
    const occFuture = (await db.query<{ id: string }>(`
      insert into occupancies (court_id, start_at, end_at, kind, ref_id)
      values ($1, now() + interval '50 days', now() + interval '50 days 1 hour', 'session', gen_random_uuid())
      returning id
    `, [badmintonCourtId])).rows[0].id;

    const futureSessId = (
      await db.query<{ id: string }>(
        `insert into sessions (class_id, court_id, start_at, end_at, status, occupancy_id)
         values ($1, $2, now() + interval '50 days', now() + interval '50 days 1 hour', 'scheduled', $3)
         returning id`,
        [clId, badmintonCourtId, occFuture],
      )
    ).rows[0].id;

    // Past session (started 1 hour ago)
    const occPast = (await db.query<{ id: string }>(`
      insert into occupancies (court_id, start_at, end_at, kind, ref_id)
      values ($1, now() - interval '2 hours', now() - interval '1 hour', 'session', gen_random_uuid())
      returning id
    `, [badmintonCourtId])).rows[0].id;

    const pastSessId = (
      await db.query<{ id: string }>(
        `insert into sessions (class_id, court_id, start_at, end_at, status, occupancy_id)
         values ($1, $2, now() - interval '2 hours', now() - interval '1 hour', 'scheduled', $3)
         returning id`,
        [clId, badmintonCourtId, occPast],
      )
    ).rows[0].id;

    // Bước 4: Thực thi kiểm thử điểm danh trong transaction (withTx):
    await withTx(async (sql) => {
      // Negative: future session -> 400
      const reqFuture = new Request(`http://localhost/v1/sessions/${futureSessId}/attendance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ user_id: memberUser.id, result: "present" }] }),
      });
      // Quy tắc AT-12: Không cho phép điểm danh trước giờ bắt đầu của buổi học (báo lỗi trường session_id).
      await assert.rejects(
        async () => sessionAttendancePost(sql, futureSessId, reqFuture, coachUser),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "session_id");
          return true;
        },
      );

      // Positive: past session -> 200
      const reqPast = new Request(`http://localhost/v1/sessions/${pastSessId}/attendance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ user_id: memberUser.id, result: "present" }] }),
      });
      // Buổi học trong quá khứ (đã bắt đầu) được phép điểm danh thành công với mã 200 OK.
      const res = await sessionAttendancePost(sql, pastSessId, reqPast, coachUser);
      assert.equal(res.status, 200);
    });
  });

  // TR-47: training plan for session with results rejected with 422 (BR-48), session without results accepted with 201
  /**
   * Làm gì: Kiểm tra quy tắc nghiệp vụ BR-48 (TR-47): từ chối tạo giáo án mới cho buổi học đã có kết quả đánh giá (trả về lỗi 422 BR_VIOLATION), và chấp thuận tạo giáo án cho buổi học chưa có kết quả (trả về 201 Created).
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu mã trạng thái HTTP hoặc mã lỗi vi phạm quy tắc BR-48 không đúng kỳ vọng
   */
  it("TR-47: rejects new plan for session with results with 422 (BR-48), accepts session without results with 201", async () => {
    // Bước 1: Kích hoạt feature flag F4 (quản lý giáo án tập luyện) để cho phép sử dụng API training.
    // Ensure feature flag F4 is on
    await db.query("insert into feature_flags (key, enabled) values ('F4', true) on conflict (key) do update set enabled = true");

    // Bước 2: Tạo lớp học cầu lông mẫu làm dữ liệu cha cho các buổi học.
    const clId = (
      await db.query<{ id: string }>(
        `insert into classes (sport, level, coach_id, court_id, capacity, rrule, duration_min, start_on, end_on, status)
         values ('badminton', 'tr47-test', $1, $2, 10, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10', 60, '2026-01-01', '2026-12-31', 'open')
         returning id`,
        [coachUser.id, badmintonCourtId],
      )
    ).rows[0].id;

    // Bước 3: Tạo buổi học đã hoàn thành trong quá khứ và chèn kết quả đánh giá vào bảng session_results (đáp ứng điều kiện kiểm thử vi phạm BR-48).
    const sessWithResults = (
      await db.query<{ id: string }>(
        `insert into sessions (class_id, court_id, start_at, end_at, status)
         values ($1, $2, now() - interval '2 days', now() - interval '2 days - 1 hour', 'done')
         returning id`,
        [clId, badmintonCourtId],
      )
    ).rows[0].id;

    // Seed result in session_results (plan_pct and note)
    await db.query(
      `insert into session_results (session_id, user_id, plan_pct, note)
       values ($1, '00000000-0000-0000-0000-000000000004', 100, 'Good form')`,
      [sessWithResults],
    );

    // Bước 4: Tạo buổi học trong tương lai (sau 300 ngày) chưa có kết quả đánh giá để kiểm thử trường hợp hợp lệ.
    const occNoRes = (await db.query<{ id: string }>(`
      insert into occupancies (court_id, start_at, end_at, kind, ref_id)
      values ($1, now() + interval '300 days', now() + interval '300 days 1 hour', 'session', gen_random_uuid())
      returning id
    `, [badmintonCourtId])).rows[0].id;

    const sessNoResults = (
      await db.query<{ id: string }>(
        `insert into sessions (class_id, court_id, start_at, end_at, status, occupancy_id)
         values ($1, $2, now() + interval '300 days', now() + interval '300 days 1 hour', 'scheduled', $3)
         returning id`,
        [clId, badmintonCourtId, occNoRes],
      )
    ).rows[0].id;

    // Bước 5: Chuẩn bị payload giáo án tập luyện gồm khối khởi động warm-up 15 phút.
    const planPayload = {
      sport: "badminton",
      level: "tr47-test",
      blocks: [
        {
          title: "Warmup block",
          minutes: 15,
          phase: "warm-up",
          intensity: "light",
          description: "Stretching and warm-up drills",
        },
      ],
    };

    // Bước 6: Gọi API tạo giáo án (trainingCreate) trong transaction và đối soát kết quả theo quy tắc BR-48:
    await withTx(async (sql) => {
      // Negative: session with results -> 422 BR-48
      const reqBad = new Request("http://localhost/v1/training", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          class_id: clId,
          session_id: sessWithResults,
          title: "Plan for session with results",
          payload: planPayload,
        }),
      });
      // Quy tắc BR-48: Buổi học đã có kết quả trong session_results thì không được phép tạo thêm giáo án mới.
      await assert.rejects(
        async () => trainingCreate(sql, reqBad, coachUser),
        (err: any) => {
          assert.equal(err.status, 422);
          assert.equal(err.code, "BR_VIOLATION");
          assert.equal(err.extra?.br, "BR-48");
          return true;
        },
      );

      // Positive: session without results -> 201
      const reqGood = new Request("http://localhost/v1/training", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          class_id: clId,
          session_id: sessNoResults,
          title: "Plan for session without results",
          payload: planPayload,
        }),
      });
      // Buổi học chưa có kết quả đánh giá: tạo giáo án thành công và trả về mã 201 Created.
      const res = await trainingCreate(sql, reqGood, coachUser);
      assert.equal(res.status, 201);
    });
  });
});

// Suite Round 8: Bộ kiểm thử đơn vị cho các tính năng điểm danh (AT-12), thu hồi phiên làm việc khi đổi mật khẩu (F-11) và các nghiệp vụ liên quan.
describe("Round 8 unit tests (AT-12, SB-31 / F-20, F-11, F-19)", () => {
  /**
   * Làm gì: Kiểm tra quy tắc điểm danh AT-12: từ chối điểm danh buổi học trong tương lai với mã 400, và cho phép điểm danh buổi học đã bắt đầu (mã 200) ngay cả khi buổi học trước đó chưa được điểm danh.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu mã phản hồi hoặc trường lỗi không khớp kỳ vọng
   */
  it("AT-12: rejects attendance for future session with 400, accepts started session with 200 even if earlier session is uncompleted", async () => {
    // Bước 1: Kích hoạt feature flag F4, lấy user coach/member mẫu và tạo sân cầu lông AT12 riêng để tránh xung đột lịch đặt (CONFLICT_SLOT).
    await db.query("insert into feature_flags (key, enabled) values ('F4', true) on conflict (key) do update set enabled = true");
    const coachUser = toPublic((await db.query("select * from users where role = 'coach' limit 1")).rows[0] as any);
    const memberUser = toPublic((await db.query("select * from users where role = 'member' limit 1")).rows[0] as any);
    // Dedicated court to avoid CONFLICT_SLOT with seed occupancies
    const courtId = (
      await db.query<{ id: string }>(
        `insert into courts (court_code, sport, status) values ('AT12', 'badminton', 'ready') returning id`,
      )
    ).rows[0].id;

    // Bước 2: Tạo lớp học mới và ghi danh học viên với trạng thái confirmed.
    // Create class and enroll member
    const clId = (
      await db.query<{ id: string }>(
        `insert into classes (sport, level, coach_id, court_id, capacity, rrule, duration_min, start_on, end_on, status)
         values ('badminton', 'at12-v8-test', $1, $2, 10, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=7', 60, '2026-01-01', '2026-12-31', 'open')
         returning id`,
        [coachUser.id, courtId],
      )
    ).rows[0].id;

    await db.query(
      `insert into enrollments (class_id, user_id, status) values ($1, $2, 'confirmed')`,
      [clId, memberUser.id],
    );

    // Bước 3: Tạo 3 buổi học với các mốc thời gian khác nhau để kiểm thử tính độc lập khi điểm danh:
    // - Buổi 1 (sess1): đã qua 3 giờ, chưa điểm danh.
    // - Buổi 2 (sess2): đã bắt đầu được 1 giờ, đang trong khung giờ điểm danh.
    // - Buổi 3 (sess3): 2 giờ nữa mới bắt đầu (tương lai).
    // Session 1: past unattended session (started 3 hours ago, still scheduled)
    const occ1 = (await db.query<{ id: string }>(`
      insert into occupancies (court_id, start_at, end_at, kind, ref_id)
      values ($1, now() - interval '3 hours', now() - interval '2 hours', 'session', gen_random_uuid())
      returning id
    `, [courtId])).rows[0].id;
    const _sess1 = (
      await db.query<{ id: string }>(
        `insert into sessions (class_id, court_id, start_at, end_at, status, occupancy_id)
         values ($1, $2, now() - interval '3 hours', now() - interval '2 hours', 'scheduled', $3)
         returning id`,
        [clId, courtId, occ1],
      )
    ).rows[0].id;

    // Session 2: past started session (started 1 hour ago, currently within lock window)
    const occ2 = (await db.query<{ id: string }>(`
      insert into occupancies (court_id, start_at, end_at, kind, ref_id)
      values ($1, now() - interval '1 hour', now(), 'session', gen_random_uuid())
      returning id
    `, [courtId])).rows[0].id;
    const sess2 = (
      await db.query<{ id: string }>(
        `insert into sessions (class_id, court_id, start_at, end_at, status, occupancy_id)
         values ($1, $2, now() - interval '1 hour', now(), 'scheduled', $3)
         returning id`,
        [clId, courtId, occ2],
      )
    ).rows[0].id;

    // Session 3: future session (starts in 2 hours)
    const occ3 = (await db.query<{ id: string }>(`
      insert into occupancies (court_id, start_at, end_at, kind, ref_id)
      values ($1, now() + interval '2 hours', now() + interval '3 hours', 'session', gen_random_uuid())
      returning id
    `, [courtId])).rows[0].id;
    const sess3 = (
      await db.query<{ id: string }>(
        `insert into sessions (class_id, court_id, start_at, end_at, status, occupancy_id)
         values ($1, $2, now() + interval '2 hours', now() + interval '3 hours', 'scheduled', $3)
         returning id`,
        [clId, courtId, occ3],
      )
    ).rows[0].id;

    // Bước 4: Thực thi kiểm tra điểm danh trong transaction (withTx):
    await withTx(async (sql) => {
      // 1. Future session (sess3) -> rejected with 400
      const reqFuture = new Request(`http://localhost/v1/sessions/${sess3}/attendance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ user_id: memberUser.id, result: "present" }] }),
      });
      // Buổi học trong tương lai (sess3): phải bị từ chối với lỗi 400 tại trường session_id (quy tắc AT-12).
      await assert.rejects(
        async () => sessionAttendancePost(sql, sess3, reqFuture, coachUser),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "session_id");
          return true;
        },
      );

      // 2. Started session (sess2) -> accepted with 200 even though sess1 was never attended
      const reqStarted = new Request(`http://localhost/v1/sessions/${sess2}/attendance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ user_id: memberUser.id, result: "present" }] }),
      });
      // Buổi học đã bắt đầu (sess2): được phép điểm danh thành công với mã 200 dù buổi trước đó (sess1) chưa được điểm danh.
      const resStarted = await sessionAttendancePost(sql, sess2, reqStarted, coachUser);
      assert.equal(resStarted.status, 200);
    });
  });

  /**
   * Làm gì: Kiểm tra tính năng bảo mật F-11: khi người dùng hoàn tất đặt lại mật khẩu qua mã OTP (purpose = 'reset'), tất cả phiên làm việc (sessions/tokens) đang hoạt động của người dùng đó phải bị thu hồi lập tức (trả về lỗi 401 khi truy cập).
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu các phiên cũ không bị vô hiệu hóa hoặc mã lỗi không phải 401
   */
  it("F-11: password reset via OTP revokes all sessions of the user", async () => {
    // Bước 1: Khởi tạo tài khoản người dùng thử nghiệm (member) với mật khẩu ban đầu 'OldPass123!'.
    const rawPhone = "0987000211";
    const phone = "+84987000211";
    const testMemberF11 = { id: "00000000-0000-0000-0000-000000000211", role: "member", phone, full_name: "Member F11" } as any;
    await db.query(
      `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
       values ($1, $2, 'Member F11', 'member f11', 'member', 'active', $3)
       on conflict (id) do nothing`,
      [testMemberF11.id, testMemberF11.phone, hashPassword("OldPass123!")],
    );

    // Bước 2: Cấp 2 phiên đăng nhập hoạt động độc lập (s1, s2) cho người dùng.
    // Issue 2 active sessions
    let s1: any;
    let s2: any;
    await withTx(async (sql) => {
      s1 = await issueSession(sql, testMemberF11);
      s2 = await issueSession(sql, testMemberF11);
    });

    // Bước 3: Xác thực cả 2 token s1 và s2 đều hợp lệ và truy vấn được thông tin người dùng qua /v1/me.
    // Verify both tokens are valid
    await withTx(async (sql) => {
      const u1 = await authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${s1.token}` } }));
      const u2 = await authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${s2.token}` } }));
      assert.equal(u1?.id, testMemberF11.id);
      assert.equal(u2?.id, testMemberF11.id);
    });

    // Bước 4: Tạo yêu cầu OTP (challenge) với mục đích 'reset' và lưu mã băm của OTP '123456'.
    // Create OTP challenge for purpose 'reset'
    await db.query(
      `insert into otp_challenges (phone, purpose, otp_hash, payload, expires_at)
       values ($1, 'reset', $2, '{}'::jsonb, now() + interval '10 minutes')`,
      [phone, hashOtp("123456")],
    );

    // Bước 5: Gọi hàm verifyOtp để xác thực mã OTP và cập nhật mật khẩu mới 'NewPassword123!'.
    // Call verifyOtp with new password
    await withTx(async (sql) => {
      const verifyReq = new Request("http://localhost/v1/auth/otp/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: rawPhone, otp: "123456", purpose: "reset", password: "NewPassword123!" }),
      });
      const verifyRes = await authH.verifyOtp(sql, verifyReq);
      assert.equal(verifyRes.status, 200);
    });

    // Bước 6: Kiểm tra bảo mật: cả 2 phiên đăng nhập cũ (s1, s2) đều đã bị thu hồi, mọi yêu cầu tiếp theo phải bị từ chối với lỗi 401.
    // Verify both session tokens are now revoked and receive 401
    await withTx(async (sql) => {
      await assert.rejects(
        async () => authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${s1.token}` } })),
        (err: any) => {
          assert.equal(err.status, 401);
          return true;
        },
      );
      await assert.rejects(
        async () => authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${s2.token}` } })),
        (err: any) => {
          assert.equal(err.status, 401);
          return true;
        },
      );
    });
  });

});

// Suite Round 10: Bộ kiểm thử đơn vị cho hệ thống nhắn tin hai chiều (Two-way Chat) giữa hội viên và huấn luyện viên.
describe("Round 10: Two-way Chat unit tests", () => {
  /**
   * Làm gì: Kiểm tra luồng nhắn tin hai chiều (Two-way Chat): khởi tạo hội thoại (cho phép hội viên nhắn tin cho HLV để trao đổi trước khi đăng ký), gửi tin nhắn an toàn idempotent với clientMsgId, và đánh dấu tin nhắn đã đọc.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu thông tin hội thoại, mã tin nhắn hoặc trạng thái idempotent không hợp lệ
   */
  it("enforces permissions: member not enrolled in coach class cannot chat, enrolled member can, idempotent send, and mark read", async () => {
    // Bước 1: Tạo tài khoản huấn luyện viên (coach) và hội viên (member) để thực hiện hội thoại mẫu.
    // 1. Create a coach C1 and a member M1, and an active class taught by C1
    const coachRes = await db.query<{ id: string; role: string; full_name: string }>(
      `insert into users (full_name, name_normalized, phone, role, status, password_hash)
       values ('Coach Chat Test', 'coach chat test', '0901999881', 'coach', 'active', 'test_hash')
       returning id, role, full_name`,
    );
    const coach = {
      id: coachRes.rows[0]!.id,
      role: "coach" as const,
      full_name: coachRes.rows[0]!.full_name,
      phone: "0901999881",
      email: null,
      member_code: null,
      status: "active",
      date_of_birth: null,
      health_notes: null,
      must_change_password: false,
      avatar_url: null,
    };

    const memberRes = await db.query<{ id: string; role: string; full_name: string }>(
      `insert into users (full_name, name_normalized, phone, role, status, password_hash)
       values ('Member Chat Test', 'member chat test', '0901999882', 'member', 'active', 'test_hash')
       returning id, role, full_name`,
    );
    const member = {
      id: memberRes.rows[0]!.id,
      role: "member" as const,
      full_name: memberRes.rows[0]!.full_name,
      phone: "0901999882",
      email: null,
      member_code: null,
      status: "active",
      date_of_birth: null,
      health_notes: null,
      must_change_password: false,
      avatar_url: null,
    };

    // Bước 2: Kiểm tra hội viên có thể tạo hội thoại và gửi tin nhắn tới HLV ngay cả trước khi đăng ký lớp học.
    // Anyone may message anyone: a member reaches a coach before enrolling.
    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipient_id: coach.id }),
      });
      const res = await chatH.createOrGetConversation(sql, member, req);
      assert.ok(res.conversation!.id);
    });

      // Bước 3: Tạo lớp học do HLV giảng dạy và ghi danh hội viên vào lớp.
      // Create an active class taught by coach and enroll member
      const court = await db.query<{ id: string }>(`select id from courts where sport = 'badminton' limit 1`);
      const clsRes = await db.query<{ id: string }>(
        `insert into classes (sport, level, coach_id, court_id, capacity, rrule, duration_min, status, start_on, end_on)
         values ('badminton', 'beginner', $1, $2, 12, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10', 60, 'open', current_date, current_date + 30)
         returning id`,
        [coach.id, court.rows[0]!.id],
      );
      const classId = clsRes.rows[0]!.id;

      await db.query(
        `insert into enrollments (class_id, user_id, status)
         values ($1, $2, 'confirmed')`,
        [classId, member.id],
      );

      // Bước 4: Khởi tạo hoặc lấy hội thoại hiện có (createOrGetConversation) và lưu lại conversation ID (convId).
      // Now member can create conversation with Coach -> 201 Created
      let convId = "";
      await withTx(async (sql) => {
        const req = new Request("http://localhost/v1/conversations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ recipient_id: coach.id }),
        });
        const res = await chatH.createOrGetConversation(sql, member, req);
        assert.ok(res.conversation!.id);
        convId = res.conversation!.id;
      });

      // Bước 5: Kiểm tra tính idempotent khi gửi tin nhắn: sử dụng clientMsgId cố định để đảm bảo gửi lại không tạo tin nhắn trùng.
      // 2. Idempotent message sending
      const clientMsgId = "11111111-2222-3333-4444-555555555555";
      // Thực hiện gửi tin nhắn lần đầu với clientMsgId qua endpoint /v1/conversations/:id/messages.
      await withTx(async (sql) => {
        const req = new Request(`http://localhost/v1/conversations/${convId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: clientMsgId, body: "Xin chao HLV!" }),
        });
        const res = await chatH.sendMessage(sql, member, convId, req);
        assert.equal(res.message!.id, clientMsgId);
        assert.equal(res.message!.body, "Xin chao HLV!");
        assert.equal(res.message!.read_at, null);
      });

      // Replay with exact same clientMsgId -> returns same message without duplicate
      await withTx(async (sql) => {
        const req = new Request(`http://localhost/v1/conversations/${convId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: clientMsgId, body: "Xin chao HLV!" }),
        });
        const res = await chatH.sendMessage(sql, member, convId, req);
        assert.equal(res.message!.id, clientMsgId);
      });

      // Xác minh tính bất biến (idempotency): bảng messages chỉ có đúng 1 bản ghi, không bị tạo trùng lặp khi gửi lại cùng clientMsgId
      const msgCount = await db.query<{ c: number }>(
        `select count(*)::int as c from messages where conversation_id = $1`,
        [convId],
      );
      assert.equal(msgCount.rows[0]!.c, 1);

      // 3. Mark conversation read
      await withTx(async (sql) => {
        const res = await chatH.markConversationRead(sql, coach, convId);
        assert.equal(res.ok, true);
      });

      // Kiểm tra trường read_at được gán thời gian đọc, chứng minh tin nhắn đã được đánh dấu là đã đọc
      const readCheck = await db.query<{ read_at: string | null }>(
        `select read_at from messages where id = $1`,
        [clientMsgId],
      );
      assert.ok(readCheck.rows[0]!.read_at !== null);
    });
  });

  /**
   * Làm gì: Nhóm các ca kiểm thử cho quy trình hoàn tiền mặt cần quản lý phê duyệt trong ca trực thu ngân (Task A2 - SU-FL05-01).
   * Được gọi ở: test runner (node --test)
   */
  describe("Task A2: manager-approved cash refund in till shift (SU-FL05-01)", () => {
    const receptionistUser = { id: "00000000-0000-0000-0000-a20000000001", role: "receptionist", full_name: "A2 Receptionist" } as any;
    const managerUser = { id: "00000000-0000-0000-0000-a20000000002", role: "manager", full_name: "A2 Manager" } as any;
    const bookingId = "30000000-0000-0000-0000-a20000000003";

    /**
     * Làm gì: Dọn dẹp dữ liệu cũ và khởi tạo tài khoản lễ tân cùng quản lý để chuẩn bị môi trường kiểm thử cho Task A2.
     * Được gọi ở: src/server/controllers/tx.test.ts trong các ca kiểm thử A2-1 đến A2-6
     * @returns {Promise<void>} Hoàn tất sau khi xóa và tạo mới các bản ghi kiểm thử
     */
    async function setupA2() {
      // Bước 1: Xóa các bản ghi payments, cashier_shifts và users liên quan đến fixture A2 để tránh xung đột dữ liệu
      await db.query("delete from payments where ref_id = $1", [bookingId]);
      await db.query("delete from cashier_shifts where receptionist_id in ($1, $2)", [receptionistUser.id, managerUser.id]);
      await db.query("delete from users where id in ($1, $2) or phone in ('+84999999002', '+84999999003')", [receptionistUser.id, managerUser.id]);

      // Bước 2: Tạo mới tài khoản lễ tân (receptionist) và quản lý (manager) phục vụ kiểm thử luồng hoàn tiền
      await db.query(
        `insert into users (id, phone, full_name, name_normalized, role, password_hash)
         values ($1, '+84999999002', $2, 'a2 receptionist', 'receptionist', 'hash'),
                ($3, '+84999999003', $4, 'a2 manager', 'manager', 'hash')`,
        [receptionistUser.id, receptionistUser.full_name, managerUser.id, managerUser.full_name],
      );
    }

    /**
     * Làm gì: Tạo một giao dịch thanh toán tiền mặt ban đầu ở trạng thái posted gắn vào ca thu ngân để làm căn cứ hoàn tiền.
     * Được gọi ở: src/server/controllers/tx.test.ts trong các ca kiểm thử A2-2 đến A2-6
     * @param shiftId Mã định danh ca trực thu ngân (cashier_shifts) nhận khoản thanh toán ban đầu
     * @param amount Số tiền thanh toán ban đầu tính theo VND (mặc định 1.500.000 VND)
     * @returns {Promise<string>} ID của bản ghi payment vừa tạo trong cơ sở dữ liệu
     */
    async function seedBasePayment(shiftId: string, amount = 1_500_000) {
      // Chèn bản ghi thanh toán tiền mặt với trạng thái posted cho đơn đặt sân để làm tiền đề thực hiện hoàn tiền
      const pay = (await db.query<{ id: string }>(
        `insert into payments (code, shift_id, method, amount_vnd, vat_rate, status, ref_type, ref_id)
         values ('PAY-A2-' || substr(gen_random_uuid()::text, 1, 8), $1, 'cash', $2, 8, 'posted', 'booking', $3)
         returning id`,
        [shiftId, amount, bookingId],
      )).rows[0];
      return pay.id;
    }

    /**
     * Làm gì: Kiểm tra lễ tân không có ca trực đang mở khi yêu cầu hoàn tiền mặt sẽ bị từ chối với lỗi BR-44 và không tạo bản ghi thanh toán rác.
     * Được gọi ở: test runner (node --test)
     */
    it("A2-1: receptionist with no open shift, refund >= refund_manager_vnd -> throws BR-44, no payment row inserted", async () => {
      // Bước 1: Khởi tạo dữ liệu và đóng toàn bộ ca trực của lễ tân để giả lập tình trạng không có ca mở
      await setupA2();
      // Ensure no open shift
      await db.query("update cashier_shifts set closed_at = now() where receptionist_id = $1", [receptionistUser.id]);

      // Seed an unattached positive payment
      // Bước 2: Tạo một giao dịch thanh toán gốc thành công không gắn ca trực để thử nghiệm hoàn tiền
      const payId = (await db.query<{ id: string }>(
        `insert into payments (code, method, amount_vnd, vat_rate, status, ref_type, ref_id)
         values ('PAY-A2-NO-SHIFT', 'cash', 1000000, 8, 'posted', 'booking', $1)
         returning id`,
        [bookingId],
      )).rows[0].id;

      // Bước 3: Gửi yêu cầu hoàn 800.000 VND từ tài khoản lễ tân; xác minh bị chặn bởi quy tắc BR-44 do thiếu ca mở
      const req = new Request("http://localhost/v1/payments/" + payId + "/refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount_vnd: 800000, reason: "Refund test" }),
      });

      await assert.rejects(
        () => withTx(async (sql) => paymentsRefund(sql, payId, req, receptionistUser)),
        (e: any) => e.extra?.br === "BR-44",
      );

      // Bước 4: Kiểm tra cơ sở dữ liệu để bảo đảm không có bản ghi refund_pending nào bị chèn sai sót
      const count = (await db.query<{ c: number }>(
        `select count(*)::int as c from payments where status = 'refund_pending' and ref_id = $1`,
        [bookingId],
      )).rows[0].c;
      assert.equal(count, 0);
    });

    /**
     * Làm gì: Kiểm tra lễ tân có ca trực S1 đang mở gửi yêu cầu hoàn tiền lớn thì bản ghi payment tạo ra có trạng thái refund_pending và gắn đúng shift_id = S1.
     * Được gọi ở: test runner (node --test)
     */
    it("A2-2: receptionist with an open shift S1, large refund -> refund_pending row has shift_id = S1", async () => {
      // Bước 1: Khởi tạo dữ liệu và mở ca thu ngân S1 cho lễ tân
      await setupA2();
      const s1 = (await db.query<{ id: string }>(
        `insert into cashier_shifts (receptionist_id) values ($1) returning id`,
        [receptionistUser.id],
      )).rows[0].id;

      // Bước 2: Tạo khoản thanh toán gốc 1.500.000 VND gắn với ca trực S1
      const payId = await seedBasePayment(s1);

      // Bước 3: Gửi yêu cầu hoàn 1.000.000 VND (vượt ngưỡng duyệt trực tiếp) để tạo yêu cầu hoàn tiền chờ duyệt
      const req = new Request("http://localhost/v1/payments/" + payId + "/refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount_vnd: 1000000, reason: "Move out" }),
      });
      const res = await withTx(async (sql) => paymentsRefund(sql, payId, req, receptionistUser));
      // Bước 4: Xác minh kết quả trả về HTTP 201, trạng thái payment là refund_pending và gắn đúng shift_id của ca S1
      assert.equal(res.status, 201);
      assert.equal((res.body as any).payment?.status, "refund_pending");
      assert.equal((res.body as any).payment?.shift_id, s1);
    });

    /**
     * Làm gì: Kiểm tra quy trình hoàn tiền đầy đủ: quản lý phê duyệt và thu ngân chi tiền mặt, xác minh tiền mặt trong ca giảm tương ứng.
     * Được gọi ở: test runner (node --test)
     */
    it("A2-3: manager approves then cashier pays -> posted, shift_id = S1, cash total drops", async () => {
      // Bước 1: Mở ca S1 và nạp khoản thanh toán tiền mặt 1.500.000 VND vào két
      await setupA2();
      const s1 = (await db.query<{ id: string }>(
        `insert into cashier_shifts (receptionist_id) values ($1) returning id`,
        [receptionistUser.id],
      )).rows[0].id;

      const payId = await seedBasePayment(s1, 1500000);

      // Bước 2: Lấy thông tin ca hiện tại để ghi nhận số dư tiền mặt ban đầu trước khi hoàn tiền
      const reqCurrent = new Request("http://localhost/v1/shifts/current");
      const curBefore = await withTx(async (sql) => shiftCurrent(sql, receptionistUser, reqCurrent));
      const cashBefore = (curBefore.body as any).totals?.cash;

      // Bước 3: Lễ tân tạo yêu cầu hoàn tiền 1.000.000 VND (chờ duyệt do số tiền lớn)
      const reqPending = new Request("http://localhost/v1/payments/" + payId + "/refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount_vnd: 1000000, reason: "Refund" }),
      });
      const resPending = await withTx(async (sql) => paymentsRefund(sql, payId, reqPending, receptionistUser));
      const pendingId = (resPending.body as any).payment.id;

      // Bước 4: Quản lý phê duyệt yêu cầu hoàn tiền (trạng thái vẫn là refund_pending chờ lễ tân xuất quỹ)
      const reqApprove = new Request("http://localhost/v1/payments/" + pendingId + "/approve-refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Approved" }),
      });
      const resApprove = await withTx(async (sql) => paymentsApproveRefund(sql, pendingId, reqApprove, managerUser));
      assert.equal(resApprove.status, 200);
      assert.equal((resApprove.body as any).status, "refund_pending");
      // Bước 5: Lễ tân thực hiện chi tiền mặt (pay out) cho khách hàng
      await withTx((sql) => paymentsPayOutRefund(sql, pendingId, receptionistUser));

      // Bước 6: Xác minh trạng thái giao dịch chuyển sang posted, gắn với ca S1 và tổng tiền mặt trong ca giảm đúng 1.000.000 VND
      const checkRow = (await db.query<{ status: string; shift_id: string }>(
        `select status, shift_id from payments where id = $1`,
        [pendingId],
      )).rows[0];
      assert.equal(checkRow.status, "posted");
      assert.equal(checkRow.shift_id, s1);

      const curAfter = await withTx(async (sql) => shiftCurrent(sql, receptionistUser, reqCurrent));
      assert.equal((curAfter.body as any).totals?.cash, cashBefore - 1000000);
    });

    /**
     * Làm gì: Kiểm tra ca cũ S1 đóng và mở ca mới S2, khi hoàn tiền được duyệt và chi trả thì chuyển shift_id sang S2, số liệu ca S1 không đổi.
     * Được gọi ở: test runner (node --test)
     */
    it("A2-4: S1 closes -> receptionist opens S2 -> approve and pay out -> shift_id = S2; S1's figures unchanged", async () => {
      // Bước 1: Mở ca S1, nạp 1.500.000 VND và tạo yêu cầu hoàn 1.000.000 VND
      await setupA2();
      const s1 = (await db.query<{ id: string }>(
        `insert into cashier_shifts (receptionist_id) values ($1) returning id`,
        [receptionistUser.id],
      )).rows[0].id;

      const payId = await seedBasePayment(s1, 1500000);

      const reqPending = new Request("http://localhost/v1/payments/" + payId + "/refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount_vnd: 1000000, reason: "Refund" }),
      });
      const resPending = await withTx(async (sql) => paymentsRefund(sql, payId, reqPending, receptionistUser));
      const pendingId = (resPending.body as any).payment.id;

      // Close S1
      await db.query("update cashier_shifts set closed_at = now() where id = $1", [s1]);
      const s1Totals = (await db.query<{ cash: number }>(
        `select coalesce(sum(amount_vnd) filter (where method = 'cash' and status = 'posted'), 0)::int as cash from payments where shift_id = $1`,
        [s1],
      )).rows[0].cash;
      assert.equal(s1Totals, 1500000);

      // Receptionist opens S2
      const s2 = (await db.query<{ id: string }>(
        `insert into cashier_shifts (receptionist_id) values ($1) returning id`,
        [receptionistUser.id],
      )).rows[0].id;

      // Seed some intake in S2
      await seedBasePayment(s2, 2000000);

      // Manager approves
      const reqApprove = new Request("http://localhost/v1/payments/" + pendingId + "/approve-refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Approved in new shift" }),
      });
      const resApprove = await withTx(async (sql) => paymentsApproveRefund(sql, pendingId, reqApprove, managerUser));
      assert.equal(resApprove.status, 200);
      assert.equal((resApprove.body as any).status, "refund_pending");
      // Lễ tân thực hiện chi trả tiền mặt; hệ thống sẽ hạch toán tiền xuất quỹ vào ca mới S2 đang mở theo quy tắc BR-44
      await withTx((sql) => paymentsPayOutRefund(sql, pendingId, receptionistUser));

      // Bước 2: Kiểm tra bản ghi thanh toán chuyển sang posted với shift_id của ca mới S2 và doanh thu ca cũ S1 được bảo toàn
      const checkRow = (await db.query<{ status: string; shift_id: string }>(
        `select status, shift_id from payments where id = $1`,
        [pendingId],
      )).rows[0];
      assert.equal(checkRow.status, "posted");
      assert.equal(checkRow.shift_id, s2);

      // S1 figures remain 1500000
      const s1After = (await db.query<{ cash: number }>(
        `select coalesce(sum(amount_vnd) filter (where method = 'cash' and status = 'posted'), 0)::int as cash from payments where shift_id = $1`,
        [s1],
      )).rows[0].cash;
      assert.equal(s1After, 1500000);

      // S2 cash dropped by 1000000 (2000000 - 1000000 = 1000000)
      const s2Totals = (await db.query<{ cash: number }>(
        `select coalesce(sum(amount_vnd) filter (where method = 'cash' and status = 'posted'), 0)::int as cash from payments where shift_id = $1`,
        [s2],
      )).rows[0].cash;
      assert.equal(s2Totals, 1000000);
    });

    /**
     * Làm gì: Kiểm tra ca S1 đã đóng mà chưa mở ca mới thì dù quản lý đã duyệt hoàn tiền, lễ tân vẫn không thể chi trả (bị chặn bởi BR-44).
     * Được gọi ở: test runner (node --test)
     */
    it("A2-5: S1 closes, no new shift -> payout refused after approval; payment still refund_pending", async () => {
      // Bước 1: Mở ca S1, nạp tiền và tạo yêu cầu hoàn tiền ở trạng thái refund_pending
      await setupA2();
      const s1 = (await db.query<{ id: string }>(
        `insert into cashier_shifts (receptionist_id) values ($1) returning id`,
        [receptionistUser.id],
      )).rows[0].id;

      const payId = await seedBasePayment(s1, 1500000);

      const reqPending = new Request("http://localhost/v1/payments/" + payId + "/refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount_vnd: 1000000, reason: "Refund" }),
      });
      const resPending = await withTx(async (sql) => paymentsRefund(sql, payId, reqPending, receptionistUser));
      const pendingId = (resPending.body as any).payment.id;

      // Close S1 and ensure no open shift
      await db.query("update cashier_shifts set closed_at = now() where receptionist_id = $1", [receptionistUser.id]);

      // Bước 2: Quản lý phê duyệt yêu cầu hoàn tiền thành công
      const reqApprove = new Request("http://localhost/v1/payments/" + pendingId + "/approve-refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Approved" }),
      });

      await withTx((sql) => paymentsApproveRefund(sql, pendingId, reqApprove, managerUser));
      // Bước 3: Lễ tân cố gắng chi trả tiền mặt khi không có ca mở sẽ bị chặn bởi BR-44 do thiếu két tiền hợp lệ
      await assert.rejects(
        () => withTx((sql) => paymentsPayOutRefund(sql, pendingId, receptionistUser)),
        (e: any) => e.extra?.br === "BR-44",
      );

      // Bước 4: Xác minh giao dịch vẫn giữ nguyên trạng thái refund_pending và gắn với shift_id cũ S1
      const checkRow = (await db.query<{ status: string; shift_id: string }>(
        `select status, shift_id from payments where id = $1`,
        [pendingId],
      )).rows[0];
      assert.equal(checkRow.status, "refund_pending");
      assert.equal(checkRow.shift_id, s1);
    });

    /**
     * Làm gì: Kiểm tra luồng quản lý từ chối yêu cầu hoàn tiền, bản ghi chuyển sang refund_rejected và giữ nguyên shift_id bất kể ca S1 đã đóng.
     * Được gọi ở: test runner (node --test)
     */
    it("A2-6: reject (decideRefund approve=false) -> shift_id unchanged, status refund_rejected", async () => {
      // Bước 1: Mở ca S1, nạp tiền và tạo yêu cầu hoàn tiền ở trạng thái refund_pending
      await setupA2();
      const s1 = (await db.query<{ id: string }>(
        `insert into cashier_shifts (receptionist_id) values ($1) returning id`,
        [receptionistUser.id],
      )).rows[0].id;

      const payId = await seedBasePayment(s1, 1500000);

      const reqPending = new Request("http://localhost/v1/payments/" + payId + "/refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount_vnd: 1000000, reason: "Refund" }),
      });
      const resPending = await withTx(async (sql) => paymentsRefund(sql, payId, reqPending, receptionistUser));
      const pendingId = (resPending.body as any).payment.id;

      // Close S1 - reject should still work even if S1 is closed!
      await db.query("update cashier_shifts set closed_at = now() where receptionist_id = $1", [receptionistUser.id]);

      // Bước 2: Quản lý từ chối yêu cầu hoàn tiền qua API reject-refund mà không cần ca thu ngân mở
      const reqReject = new Request("http://localhost/v1/payments/" + pendingId + "/reject-refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Denied by manager" }),
      });
      const resReject = await withTx(async (sql) => paymentsRejectRefund(sql, pendingId, reqReject, managerUser));
      assert.equal(resReject.status, 200);

      // Bước 3: Xác minh trạng thái giao dịch chuyển sang refund_rejected và shift_id vẫn giữ nguyên là ca S1
      const checkRow = (await db.query<{ status: string; shift_id: string }>(
        `select status, shift_id from payments where id = $1`,
        [pendingId],
      )).rows[0];
      assert.equal(checkRow.status, "refund_rejected");
      assert.equal(checkRow.shift_id, s1);
    });
  });

  /**
   * Làm gì: Nhóm các ca kiểm thử cho tính năng tự quản lý ảnh đại diện của người dùng (Task B: self-service user avatars).
   * Được gọi ở: test runner (node --test)
   */
  describe("Task B: self-service user avatars", () => {
    /**
     * Làm gì: Tạo buffer nhị phân giả lập tệp PNG hợp lệ tối thiểu gồm header signature 8 byte và chunk IHDR chứa kích thước ảnh.
     * Được gọi ở: src/server/controllers/tx.test.ts trong các ca kiểm thử sniffAvatar và meAvatarPut (B-1, B-2)
     * @param width Chiều rộng ảnh tính bằng pixel (mặc định 64)
     * @param height Chiều cao ảnh tính bằng pixel (mặc định 64)
     * @returns {Buffer} Buffer chứa dữ liệu nhị phân header định dạng PNG
     */
    function makePng(width = 64, height = 64): Buffer {
      // Tạo magic signature chuẩn của PNG (8 byte: 89 50 4E 47 0D 0A 1A 0A) và chunk IHDR chứa kích thước ảnh định dạng Big-Endian
      const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const ihdr = Buffer.alloc(25);
      ihdr.writeUInt32BE(13, 0);
      ihdr.write("IHDR", 4, 4, "ascii");
      ihdr.writeUInt32BE(width, 8);
      ihdr.writeUInt32BE(height, 12);
      ihdr[16] = 8;
      ihdr[17] = 6;
      ihdr[18] = 0;
      ihdr[19] = 0;
      ihdr[20] = 0;
      ihdr.writeUInt32BE(0, 21);
      return Buffer.concat([sig, ihdr]);
    }

    /**
     * Làm gì: Tạo buffer nhị phân giả lập tệp JPEG với SOI marker, marker APP0 (JFIF tùy chọn) và marker SOF0 chứa chiều rộng/chiều cao.
     * Được gọi ở: src/server/controllers/tx.test.ts trong ca kiểm thử hàm sniffAvatar
     * @param width Chiều rộng ảnh tính bằng pixel (mặc định 100)
     * @param height Chiều cao ảnh tính bằng pixel (mặc định 100)
     * @param withApp0 Có kèm theo marker APP0 (JFIF) hay chỉ tạo SOI và SOF0 (mặc định true)
     * @returns {Buffer} Buffer chứa các khối dữ liệu nhị phân chuẩn JPEG
     */
    function makeJpeg(width = 100, height = 100, withApp0 = true): Buffer {
      const parts: Buffer[] = [];
      // Ghép SOI marker (0xFFD8) và khối APP0 JFIF nếu được yêu cầu
      if (withApp0) {
        const app0 = Buffer.alloc(18);
        app0[0] = 0xff;
        app0[1] = 0xe0;
        app0.writeUInt16BE(16, 2);
        app0.write("JFIF\0", 4, "ascii");
        parts.push(Buffer.from([0xff, 0xd8]), app0);
      } else {
        parts.push(Buffer.from([0xff, 0xd8]));
      }
      // Ghép SOF0 marker (0xFFC0) chứa thông số độ sâu bit, chiều cao và chiều rộng ảnh
      const sof0 = Buffer.alloc(19);
      sof0[0] = 0xff;
      sof0[1] = 0xc0;
      sof0.writeUInt16BE(17, 2);
      sof0[4] = 8;
      sof0.writeUInt16BE(height, 5);
      sof0.writeUInt16BE(width, 7);
      parts.push(sof0);
      return Buffer.concat(parts);
    }

    /**
     * Làm gì: Tạo buffer nhị phân giả lập tệp WebP mở rộng (chunk VP8X) chứa thông tin kích thước chiều rộng và chiều cao ảnh.
     * Được gọi ở: src/server/controllers/tx.test.ts trong ca kiểm thử hàm sniffAvatar
     * @param width Chiều rộng ảnh tính bằng pixel (mặc định 120)
     * @param height Chiều cao ảnh tính bằng pixel (mặc định 90)
     * @returns {Buffer} Buffer 32 byte định dạng WebP với container RIFF/WEBP và header VP8X
     */
    function makeWebpVP8X(width = 120, height = 90): Buffer {
      // Định dạng WebP VP8X: container RIFF kích thước 32 byte, chunk VP8X lưu kích thước canvas dạng (kích_thước - 1) trong 24-bit Little-Endian
      const buf = Buffer.alloc(32);
      buf.write("RIFF", 0, "ascii");
      buf.writeUInt32LE(24, 4);
      buf.write("WEBP", 8, "ascii");
      buf.write("VP8X", 12, "ascii");
      buf.writeUInt32LE(10, 16);
      const w = width - 1;
      buf[24] = w & 0xff;
      buf[25] = (w >> 8) & 0xff;
      buf[26] = (w >> 16) & 0xff;
      const h = height - 1;
      buf[27] = h & 0xff;
      buf[28] = (h >> 8) & 0xff;
      buf[29] = (h >> 16) & 0xff;
      return buf;
    }

    /**
     * Làm gì: Kiểm tra hàm sniffAvatar nhận diện chính xác MIME và kích thước của các định dạng ảnh PNG, JPEG, WebP VP8X cũng như trả về null khi buffer rỗng hoặc bị cắt cụt.
     * Được gọi ở: test runner (node --test)
     */
    it("sniffAvatar: covers PNG, JPEG with APP0, WebP VP8X, truncated, and empty buffer", () => {
      // Bước 1: Kiểm tra nhận diện định dạng PNG và trích xuất đúng kích thước width x height
      const png = sniffAvatar(makePng(64, 64));
      assert.deepEqual(png, { mime: "image/png", width: 64, height: 64 });

      // Bước 2: Kiểm tra nhận diện định dạng JPEG có APP0 marker chuẩn JFIF
      const jpeg = sniffAvatar(makeJpeg(100, 80, true));
      assert.deepEqual(jpeg, { mime: "image/jpeg", width: 100, height: 80 });

      // Bước 3: Kiểm tra nhận diện định dạng WebP với chunk mở rộng VP8X
      const webp = sniffAvatar(makeWebpVP8X(120, 90));
      assert.deepEqual(webp, { mime: "image/webp", width: 120, height: 90 });

      // Bước 4: Kiểm tra các trường hợp dữ liệu bị cắt cụt (thiếu byte) hoặc buffer rỗng phải trả về null
      assert.equal(sniffAvatar(Buffer.from([0x89, 0x50, 0x4e])), null);
      assert.equal(sniffAvatar(Buffer.alloc(0)), null);
    });

    const memberA = { id: "00000000-0000-0000-0000-b00000000001", role: "member", full_name: "Member A", phone: "+84999999081" } as any;
    const memberB = { id: "00000000-0000-0000-0000-b00000000002", role: "member", full_name: "Member B", phone: "+84999999082" } as any;
    const staffCoach = { id: "00000000-0000-0000-0000-b00000000003", role: "coach", full_name: "Coach B", phone: "+84999999083" } as any;

    /**
     * Làm gì: Dọn dẹp dữ liệu cũ (user_avatars, conversations, users) và khởi tạo người dùng mẫu cho các ca kiểm thử avatar Task B.
     * Được gọi ở: src/server/controllers/tx.test.ts trong ca kiểm thử B-1 (và các ca kiểm thử sau)
     * @returns {Promise<void>} Hoàn tất sau khi dọn dẹp và chèn dữ liệu người dùng mẫu
     */
    async function setupTaskB() {
      // Bước 1: Dọn dẹp dữ liệu avatar cũ, cuộc hội thoại và thông tin người dùng mẫu để tránh xung đột ràng buộc dữ liệu
      await db.query("delete from user_avatars where user_id in ($1, $2, $3)", [memberA.id, memberB.id, staffCoach.id]);
      await db.query("delete from conversations where id = '00000000-0000-0000-0000-b00000000099'");
      await db.query("delete from users where id in ($1, $2, $3) or phone in ('+84999999081', '+84999999082', '+84999999083')", [memberA.id, memberB.id, staffCoach.id]);
      // Bước 2: Tạo mới danh sách người dùng gồm 2 hội viên (memberA, memberB) và 1 huấn luyện viên (staffCoach)
      await db.query(
        `insert into users (id, phone, full_name, name_normalized, role, password_hash)
         values ($1, $2, $3, 'member a', 'member', 'hash'),
                ($4, $5, $6, 'member b', 'member', 'hash'),
                ($7, $8, $9, 'coach b', 'coach', 'hash')`,
        [memberA.id, memberA.phone, memberA.full_name, memberB.id, memberB.phone, memberB.full_name, staffCoach.id, staffCoach.phone, staffCoach.full_name],
      );
    }

    /**
     * Làm gì: Kiểm tra hội viên cập nhật ảnh đại diện PNG hợp lệ thành công: avatar_url có đuôi cache-busting ?v=1 và bản ghi audit_logs chỉ lưu metadata ảnh chứ không lưu mảng byte.
     * Được gọi ở: test runner (node --test)
     */
    it("B-1: member PUTs a valid 64x64 PNG -> 200, avatar_url ends in ?v=1, audit row created with no bytes", async () => {
      // Bước 1: Khởi tạo dữ liệu người dùng kiểm thử Task B
      await setupTaskB();
      // Bước 2: Gửi yêu cầu PUT /v1/me/avatar với ảnh PNG 64x64 được mã hóa base64
      const req = new Request("http://localhost/v1/me/avatar", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data_base64: makePng(64, 64).toString("base64") }),
      });
      const res = await withTx(async (sql) => meAvatarPut(sql, req, memberA));
      // Bước 3: Xác minh HTTP 200 và avatar_url có tham số phiên bản ?v=1 để trình duyệt làm mới bộ nhớ cache
      assert.equal(res.status, 200);
      const user = (res.body as any).user;
      assert.match(user.avatar_url, /\/v1\/users\/00000000-0000-0000-0000-b00000000001\/avatar\?v=1$/);

      // Bước 4: Kiểm tra bản ghi audit_logs lưu lại thông số kỹ thuật (mime, width, height, bytes) nhưng không chứa payload dữ liệu ảnh thô
      const audits = (await db.query<{ action: string; after: string }>(
        `select action, after from audit_logs where action = 'avatar_set' and actor_id = $1`,
        [memberA.id],
      )).rows;
      assert.equal(audits.length, 1);
      const after = typeof audits[0].after === "string" ? JSON.parse(audits[0].after) : audits[0].after;
      assert.equal(after.mime, "image/png");
      assert.equal(after.width, 64);
      assert.equal(after.height, 64);
      assert.equal(after.bytes > 0, true);
      assert.equal(after.data, undefined);
    });

    /**
     * Làm gì: Kiểm tra cập nhật ảnh đại diện lần thứ hai liên tiếp sẽ tự động tăng phiên bản cache-busting lên ?v=2.
     * Được gọi ở: test runner (node --test)
     */
    it("B-2: PUT again -> ?v=2", async () => {
      // Bước 1: Gửi yêu cầu PUT /v1/me/avatar lần thứ hai với ảnh PNG kích thước mới (128x128)
      const req = new Request("http://localhost/v1/me/avatar", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data_base64: makePng(128, 128).toString("base64") }),
      });
      const res = await withTx(async (sql) => meAvatarPut(sql, req, memberA));
      // Bước 2: Xác minh API trả về HTTP 200 và avatar_url tăng version lên ?v=2 để xóa cache ảnh cũ
      assert.equal(res.status, 200);
      const user = (res.body as any).user;
      assert.match(user.avatar_url, /\?v=2$/);
    });

    /**
     * Làm gì: Kiểm tra giới hạn dung lượng tải lên avatar: từ chối file vượt quá 2 MB (2 MB + 1 byte) với lỗi 400 và trường lỗi "file".
     * Được gọi ở: test runner (node --test)
     * @returns Promise<void>
     * @throws AssertionError nếu không trả về mã lỗi 400 hoặc thiếu trường lỗi "file"
     */
    it("B-3: 2 MB + 1 byte -> field error file", async () => {
      // Bước 1: Tạo payload ảnh giả lập có dung lượng vượt quá giới hạn tối đa 2 MB đúng 1 byte.
      const bigBuf = Buffer.alloc(2 * 1024 * 1024 + 1);
      const req = new Request("http://localhost/v1/me/avatar", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data_base64: bigBuf.toString("base64") }),
      });
      // Bước 2: Gọi meAvatarPut và kiểm tra hệ thống ném lỗi HTTP 400 Bad Request, chỉ định rõ lỗi ở trường "file".
      await assert.rejects(
        () => withTx(async (sql) => meAvatarPut(sql, req, memberA)),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "file");
          assert.match(err.message, /2 MB/);
          return true;
        },
      );
    });

    /**
     * Làm gì: Kiểm tra tính hợp lệ của định dạng ảnh (magic bytes): từ chối các file không phải ảnh hợp lệ như mã SVG (nguy cơ XSS), file thực thi .exe đổi tên (MZ...) hoặc chuỗi byte ngẫu nhiên.
     * Được gọi ở: test runner (node --test)
     * @returns Promise<void>
     * @throws AssertionError nếu các file không hợp lệ không bị từ chối với lỗi 400
     */
    it("B-4: SVG (<svg ...>), a renamed .exe (MZ...), random bytes -> field error file", async () => {
      // Bước 1: Duyệt qua các payload nguy hại hoặc sai định dạng: SVG chứa mã script, file binary thực thi Windows (MZ) và byte rác.
      for (const raw of ["<svg width='100' height='100'></svg>", "MZ9999renamedexe", "randombytes12345678901234567890"]) {
        const req = new Request("http://localhost/v1/me/avatar", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data_base64: Buffer.from(raw).toString("base64") }),
        });
        // Bước 2: Gửi request cập nhật avatar và xác nhận hệ thống chặn lại với lỗi 400 cùng trường lỗi "file".
        await assert.rejects(
          () => withTx(async (sql) => meAvatarPut(sql, req, memberA)),
          (err: any) => {
            assert.equal(err.status, 400);
            assert.equal(err.extra?.field, "file");
            return true;
          },
        );
      }
    });

    /**
     * Làm gì: Kiểm tra ràng buộc kích thước pixel (width x height) của ảnh: từ chối ảnh quá nhỏ (32x32) hoặc ảnh có chiều vượt quá 4096 (5000x10), yêu cầu kích thước trong khoảng 64 - 4096 pixels.
     * Được gọi ở: test runner (node --test)
     * @returns Promise<void>
     * @throws AssertionError nếu ảnh ngoài kích thước cho phép không bị từ chối
     */
    it("B-5: 32x32 PNG; PNG with IHDR 5000x10 -> field error file", async () => {
      // Bước 1: Thử nghiệm với các kích thước pixel không hợp lệ: nhỏ hơn ngưỡng tối thiểu 64px (32x32) hoặc vượt ngưỡng tối đa 4096px (5000x10).
      for (const [w, h] of [[32, 32], [5000, 10]]) {
        const req = new Request("http://localhost/v1/me/avatar", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data_base64: makePng(w, h).toString("base64") }),
        });
        // Bước 2: Xác nhận meAvatarPut ném lỗi 400 kèm thông báo yêu cầu kích thước trong khoảng 64 đến 4096 pixels.
        await assert.rejects(
          () => withTx(async (sql) => meAvatarPut(sql, req, memberA)),
          (err: any) => {
            assert.equal(err.status, 400);
            assert.equal(err.extra?.field, "file");
            assert.match(err.message, /between 64 and 4096 pixels/);
            return true;
          },
        );
      }
    });

    /**
     * Làm gì: Kiểm tra endpoint lấy ảnh đại diện của chính mình: trả về HTTP 200, Content-Type image/png, header bảo mật Cache-Control chứa private, X-Content-Type-Options: nosniff và ETag.
     * Được gọi ở: test runner (node --test)
     * @returns Promise<void>
     * @throws AssertionError nếu status hoặc các header trả về không thỏa mãn
     */
    it("B-6: GET own avatar -> 200, correct Content-Type, Cache-Control contains private, X-Content-Type-Options: nosniff", async () => {
      // Bước 1: Gọi userAvatarGet để lấy dữ liệu ảnh đại diện của chính hội viên A (memberA).
      const res = await withTx(async (sql) => userAvatarGet(sql, memberA.id, memberA));
      // Bước 2: Kiểm tra HTTP status 200 và các header bảo mật: ngăn browser tự đoán MIME type (nosniff) và chỉ định cache riêng tư (private).
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/png");
      assert.equal(res.headers.get("cache-control")?.includes("private"), true);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("etag"), '"2"');
    });

    /**
     * Làm gì: Kiểm tra bảo mật endpoint lấy avatar: từ chối truy cập với lỗi HTTP 401 Unauthorized khi không có token xác thực (actor là null).
     * Được gọi ở: test runner (node --test)
     * @returns Promise<void>
     * @throws AssertionError nếu request không có token mà không bị từ chối với lỗi 401
     */
    it("B-7: GET without a token -> 401", async () => {
      // Bước 1: Gọi userAvatarGet mà không truyền thông tin người dùng xác thực và kiểm tra kết quả bị ném lỗi 401 Unauthorized.
      await assert.rejects(
        () => withTx(async (sql) => userAvatarGet(sql, memberA.id, null)),
        (err: any) => {
          assert.equal(err.status, 401);
          return true;
        },
      );
    });

    /**
     * Làm gì: Kiểm tra chính sách quyền riêng tư avatar giữa các hội viên: hội viên A không thể xem avatar của hội viên B nếu không có cuộc trò chuyện (conversation) chung, trả về 404 Not Found để chống dò quét người dùng.
     * Được gọi ở: test runner (node --test)
     * @returns Promise<void>
     * @throws AssertionError nếu hội viên xem được avatar của người lạ hoặc hệ thống không trả về 404
     */
    it("B-8: member A GETs member B (no conversation) -> 404", async () => {
      // Bước 1: Hội viên A yêu cầu xem avatar của hội viên B khi hai bên chưa từng có cuộc hội thoại chung; hệ thống phải trả về lỗi 404 Not Found.
      await assert.rejects(
        () => withTx(async (sql) => userAvatarGet(sql, memberB.id, memberA)),
        (err: any) => {
          assert.equal(err.status, 404);
          return true;
        },
      );
    });

    /**
     * Làm gì: Kiểm tra quyền xem avatar có liên hệ công việc: hội viên được xem avatar của nhân viên (staff) nếu có cuộc trò chuyện chung, và nhân viên có quyền xem avatar của hội viên.
     * Được gọi ở: test runner (node --test)
     * @returns Promise<void>
     * @throws AssertionError nếu các bên có quan hệ nghiệp vụ không xem được avatar của nhau
     */
    it("B-9: member A GETs a staff member A has a conversation with; staff GETs a member -> 200", async () => {
      // Upload avatar for staffCoach
      // Bước 1: Tải lên ảnh avatar mẫu cho tài khoản huấn luyện viên (staffCoach).
      const reqCoach = new Request("http://localhost/v1/me/avatar", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data_base64: makePng(64, 64).toString("base64") }),
      });
      await withTx(async (sql) => meAvatarPut(sql, reqCoach, staffCoach));

      // Create conversation
      // Bước 2: Tạo cuộc trò chuyện (conversation) giữa hội viên A và HLV trong database.
      await db.query(
        `insert into conversations (id, member_id, staff_id) values ('00000000-0000-0000-0000-b00000000099', $1, $2)`,
        [memberA.id, staffCoach.id],
      );

      // member A GETs staffCoach
      // Bước 3: Hội viên A lấy avatar của HLV thành công (200 OK) vì có liên kết hội thoại.
      const res1 = await withTx(async (sql) => userAvatarGet(sql, staffCoach.id, memberA));
      assert.equal(res1.status, 200);

      // staffCoach GETs member A
      // Bước 4: HLV lấy avatar của hội viên A thành công (200 OK) theo quyền của nhân viên.
      const res2 = await withTx(async (sql) => userAvatarGet(sql, memberA.id, staffCoach));
      assert.equal(res2.status, 200);
    });

    /**
     * Làm gì: Kiểm tra luồng xóa ảnh đại diện: xóa avatar đặt avatar_url thành null, gọi GET sau đó trả về 404, và thao tác xóa lại có tính lũy kế (idempotent - vẫn trả về 200).
     * Được gọi ở: test runner (node --test)
     * @returns Promise<void>
     * @throws AssertionError nếu xóa thất bại hoặc thao tác xóa lặp lại ném lỗi
     */
    it("B-10: DELETE -> avatar_url = null; GET -> 404; DELETE again -> still 200", async () => {
      // Bước 1: Gọi meAvatarDelete để xóa ảnh đại diện của memberA; kiểm tra avatar_url được đặt lại thành null.
      const resDel = await withTx(async (sql) => meAvatarDelete(sql, memberA));
      assert.equal(resDel.status, 200);
      assert.equal((resDel.body as any).user.avatar_url, null);

      // Bước 2: Thử lấy avatar vừa bị xóa; xác nhận hệ thống trả về lỗi 404 Not Found.
      await assert.rejects(
        () => withTx(async (sql) => userAvatarGet(sql, memberA.id, memberA)),
        (err: any) => {
          assert.equal(err.status, 404);
          return true;
        },
      );

      // Bước 3: Gọi xóa lần nữa để đảm bảo tính idempotent; hệ thống không bị crash mà vẫn trả về 200 OK.
      const resDelAgain = await withTx(async (sql) => meAvatarDelete(sql, memberA));
      assert.equal(resDelAgain.status, 200);
    });

    /**
     * Làm gì: Kiểm tra tính đồng bộ thông tin cá nhân: sau khi upload avatar mới, endpoint GET /me giải mã qua authFromRequest phải trả về avatar_url kèm query param phiên bản (?v=...).
     * Được gọi ở: test runner (node --test)
     * @returns Promise<void>
     * @throws AssertionError nếu avatar_url không xuất hiện hoặc không đúng định dạng URL phiên bản
     */
    it("B-11: GET /me after an upload -> user.avatar_url present through authFromRequest", async () => {
      // Bước 1: Upload avatar mới kích thước 64x64 cho memberA qua handler meAvatarPut.
      const req = new Request("http://localhost/v1/me/avatar", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data_base64: makePng(64, 64).toString("base64") }),
      });
      await withTx(async (sql) => meAvatarPut(sql, req, memberA));

      // Bước 2: Cấp session mới và giả lập request GET /v1/me kèm header Authorization Bearer token.
      const sess = await withTx(async (sql) => issueSession(sql, memberA));
      const reqMe = new Request("http://localhost/v1/me", {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      // Bước 3: Giải mã thông tin user từ request qua authFromRequest và xác nhận avatar_url chứa query param phiên bản (?v=\d+).
      const meUser = await withTx(async (sql) => authFromRequest(sql, reqMe));
      assert.match(meUser.avatar_url ?? "", /\/v1\/users\/00000000-0000-0000-0000-b00000000001\/avatar\?v=\d+$/);
    });

    /**
     * Làm gì: Kiểm tra ràng buộc khóa ngoại tầng cơ sở dữ liệu: khi tài khoản user bị xóa, bản ghi lưu trữ ảnh tương ứng trong bảng user_avatars phải tự động bị xóa theo (ON DELETE CASCADE).
     * Được gọi ở: test runner (node --test)
     * @returns Promise<void>
     * @throws AssertionError nếu bản ghi ảnh đại diện không tự động bị xóa khi user bị xóa
     */
    it("B-12: user is deleted -> the user_avatars row is gone (cascade)", async () => {
      // Bước 1: Tạo tài khoản user tạm thời và upload ảnh đại diện cho user này.
      const tempUser = { id: "00000000-0000-0000-0000-b00000000089", role: "member", full_name: "Temp", phone: "+84999999089" } as any;
      await db.query(
        `insert into users (id, phone, full_name, name_normalized, role, password_hash)
         values ($1, $2, $3, 'temp', 'member', 'hash')`,
        [tempUser.id, tempUser.phone, tempUser.full_name],
      );
      const req = new Request("http://localhost/v1/me/avatar", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data_base64: makePng(64, 64).toString("base64") }),
      });
      await withTx(async (sql) => meAvatarPut(sql, req, tempUser));

      // Bước 2: Xác nhận bảng user_avatars đã ghi nhận chính xác 1 bản ghi ảnh của user tạm thời.
      const beforeCount = (await db.query<{ count: number }>(
        `select count(*)::int as count from user_avatars where user_id = $1`,
        [tempUser.id],
      )).rows[0].count;
      assert.equal(beforeCount, 1);

      // Bước 3: Xóa tài khoản user tạm thời khỏi bảng users.
      await db.query("delete from users where id = $1", [tempUser.id]);

      // Bước 4: Kiểm tra ràng buộc ON DELETE CASCADE tự động xóa sạch hàng tương ứng trong bảng user_avatars (số lượng về 0).
      const afterCount = (await db.query<{ count: number }>(
        `select count(*)::int as count from user_avatars where user_id = $1`,
        [tempUser.id],
      )).rows[0].count;
      assert.equal(afterCount, 0);
    });
  });

  // Suite Task W: Bộ kiểm thử tính công bằng của thứ tự hàng đợi danh sách chờ (fair waitlist order) và phân bổ chỗ trống lớp học (free seat allocation).
  describe("Task W: fair waitlist order and free seat allocation (D5, D6)", () => {
    const coachW = { id: "00000000-0000-0000-0000-c00000000001", role: "coach", full_name: "Coach W" } as any;
    const courtW = "10000000-0000-0000-0000-000000000004";
    const classW = "40000000-0000-0000-0000-c00000000001";
    const memA = { id: "00000000-0000-0000-0000-c0000000000a", phone: "+84999999011", full_name: "An", role: "member" } as any;
    const memH = { id: "00000000-0000-0000-0000-c0000000000b", phone: "+84999999012", full_name: "Hoa", role: "member" } as any;
    const memN = { id: "00000000-0000-0000-0000-c0000000000c", phone: "+84999999013", full_name: "Nam", role: "member" } as any;
    const memL = { id: "00000000-0000-0000-0000-c0000000000d", phone: "+84999999014", full_name: "Linh", role: "member" } as any;

    /**
     * Làm gì: Dọn dẹp dữ liệu cũ và khởi tạo môi trường thử nghiệm cho Task W: 4 hội viên có gói tập còn hạn, 1 HLV và 1 lớp học cầu lông sức chứa 1 học viên.
     * Được gọi ở: test "W-1: QA scenario with capacity 1 (steps 1 to 6)", test "W-2: expired offer drops its holder and moves everyone up by one (gap-free)"
     * @returns Promise<void>
     * @throws Error nếu các câu lệnh thao tác cơ sở dữ liệu thất bại
     */
    async function setupW() {
      // Bước 1: Dọn dẹp triệt để dữ liệu cũ của các bảng liên quan: outbox, waitlist_offers, enrollments, classes, subscriptions, users.
      await db.query("delete from outbox where user_id in ($1, $2, $3, $4)", [memA.id, memH.id, memN.id, memL.id]);
      await db.query("delete from waitlist_offers where enrollment_id in (select id from enrollments where class_id = $1)", [classW]);
      await db.query("delete from enrollments where class_id = $1", [classW]);
      await db.query("delete from classes where id = $1", [classW]);
      await db.query("delete from subscriptions where user_id in ($1, $2, $3, $4)", [memA.id, memH.id, memN.id, memL.id]);
      await db.query("delete from users where id in ($1, $2, $3, $4, $5)", [memA.id, memH.id, memN.id, memL.id, coachW.id]);

      // Bước 2: Tạo người dùng mẫu gồm 4 học viên (An, Hoa, Nam, Linh) và 1 huấn luyện viên (Coach W).
      await db.query(
        `insert into users (id, phone, full_name, name_normalized, role, password_hash)
         values ($1, $2, $3, 'an', 'member', 'hash'),
                ($4, $5, $6, 'hoa', 'member', 'hash'),
                ($7, $8, $9, 'nam', 'member', 'hash'),
                ($10, $11, $12, 'linh', 'member', 'hash'),
                ($13, '+84999999015', $14, 'coach w', 'coach', 'hash')`,
        [memA.id, memA.phone, memA.full_name, memH.id, memH.phone, memH.full_name, memN.id, memN.phone, memN.full_name, memL.id, memL.phone, memL.full_name, coachW.id, coachW.full_name],
      );
      // Bước 3: Đăng ký gói tập còn hạn cho cả 4 học viên để thỏa mãn điều kiện tiên quyết khi tham gia lớp học.
      await db.query(
        `insert into subscriptions (user_id, plan_id, start_on, end_on, status)
         select u, (select id from membership_plans order by price_vnd limit 1), current_date - 1, current_date + 400, 'active'
           from unnest($1::uuid[]) as u`,
        [[memA.id, memH.id, memN.id, memL.id]],
      );

      // Bước 4: Tạo lớp học cầu lông với capacity = 1 để thử nghiệm kịch bản cạnh tranh suất học và xếp hàng chờ.
      await db.query(
        `insert into classes (id, sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count, price_vnd)
         values ($1, 'badminton', 'w-test', $2, $3, 'FREQ=WEEKLY;BYDAY=TU;BYHOUR=14', current_date + 1, current_date + 14, 60, 1, 'open', 0, 300000)`,
        [classW, coachW.id, courtW],
      );
    }

    /**
     * Làm gì: Kiểm tra kịch bản QA toàn diện cho lớp học sức chứa 1 người qua 6 giai đoạn:
     * An giữ chỗ, Hoa vào waitlist 1, An hủy -> Hoa nhận offer pending;
     * Nam đăng ký trực tiếp chiếm chỗ (hold) khiến offer của Hoa chuyển sang skipped nhưng Hoa vẫn giữ waitlist 1 và nhận thông báo;
     * Linh vào waitlist 2; Hoa cố chấp nhận offer cũ bị lỗi BR-21;
     * Nam hủy -> Hoa nhận offer mới và chấp nhận thành công; Linh đôn lên waitlist 1;
     * Linh hủy đăng ký -> danh sách chờ sạch bóng, đảm bảo không có lỗ hổng số thứ tự (gap-free).
     * Được gọi ở: test runner (node --test)
     * @returns Promise<void>
     * @throws AssertionError nếu các trạng thái đăng ký, offer hoặc thứ tự hàng đợi không chính xác
     */
    it("W-1: QA scenario with capacity 1 (steps 1 to 6)", async () => {
      // Bước 1: Chuẩn bị dữ liệu lớp học capacity = 1 và danh sách 4 học viên.
      await setupW();

      // 1. A enrols (hold). H joins (waitlist 1). A leaves -> H has a pending offer.
      const enrA = await withTx(async (sql) => classesEnroll(sql, classW, new Request("http://localhost"), memA));
      assert.equal(enrA.status, 201);
      assert.equal((enrA.body as any).enrollment?.status, "hold");

      // Hoa đăng ký khi lớp đã có người giữ chỗ -> được đưa vào danh sách chờ với vị trí số 1 (waitlist_pos = 1).
      const enrH = await withTx(async (sql) => classesEnroll(sql, classW, new Request("http://localhost"), memH));
      assert.equal(enrH.status, 201);
      assert.equal((enrH.body as any).enrollment?.status, "waitlisted");
      const hRow1 = (await db.query<{ waitlist_pos: number }>("select waitlist_pos from enrollments where id = $1", [(enrH.body as any).enrollment.id])).rows[0];
      assert.equal(hRow1.waitlist_pos, 1);

      // A leaves -> triggers inviteWaitlist -> creates pending offer for H
      // An hủy đăng ký -> kích hoạt hàm inviteWaitlist, tự động phát hành lời mời (offer pending) cho người đứng đầu danh sách chờ (Hoa).
      await withTx(async (sql) => enrollmentDelete(sql, (enrA.body as any).enrollment.id, memA));
      const offerH = (await db.query<{ id: string; status: string }>(
        "select id, status from waitlist_offers where enrollment_id = $1 and status = 'pending'",
        [(enrH.body as any).enrollment.id],
      )).rows[0];
      assert.ok(offerH);
      assert.equal(offerH.status, "pending");

      // 2. N enrols -> hold (takes the seat); H's offer is skipped; H is still waitlist 1
      // Bước 2: Nam đăng ký trực tiếp và chiếm chỗ (hold); offer đang chờ của Hoa bị chuyển sang trạng thái skipped nhưng Hoa vẫn giữ vị trí số 1.
      const enrN = await withTx(async (sql) => classesEnroll(sql, classW, new Request("http://localhost"), memN));
      assert.equal(enrN.status, 201);
      assert.equal((enrN.body as any).enrollment?.status, "hold");

      const offerHAfter = (await db.query<{ status: string }>("select status from waitlist_offers where id = $1", [offerH.id])).rows[0];
      assert.equal(offerHAfter.status, "skipped");

      const hRow2 = (await db.query<{ status: string; waitlist_pos: number }>("select status, waitlist_pos from enrollments where id = $1", [(enrH.body as any).enrollment.id])).rows[0];
      assert.equal(hRow2.status, "waitlisted");
      assert.equal(hRow2.waitlist_pos, 1);

      // Verify inapp note waitlist_seat_taken queued for H
      // Ghi nhận thông báo mẫu waitlist_seat_taken vào outbox để gửi thông báo cho Hoa biết lượt giữ chỗ đã bị người khác đăng ký mất.
      const notes = (await db.query<{ template: string; user_id: string }>(
        "select template, user_id from outbox where user_id = $1 and template = 'waitlist_seat_taken'",
        [memH.id],
      )).rows;
      assert.equal(notes.length, 1);

      // 3. L enrols -> waitlist 2
      // Bước 3: Linh đăng ký vào lớp và được xếp vào danh sách chờ ở vị trí tiếp theo (waitlist_pos = 2).
      const enrL = await withTx(async (sql) => classesEnroll(sql, classW, new Request("http://localhost"), memL));
      assert.equal(enrL.status, 201);
      assert.equal((enrL.body as any).enrollment?.status, "waitlisted");
      const lRow1 = (await db.query<{ waitlist_pos: number }>("select waitlist_pos from enrollments where id = $1", [(enrL.body as any).enrollment.id])).rows[0];
      assert.equal(lRow1.waitlist_pos, 2);

      // 4. H accepts -> BR-21, H stays waitlist 1
      // Bước 4: Hoa cố chấp nhận offer đã bị skipped -> hệ thống chặn với lỗi nghiệp vụ BR-21 ("The class just filled up."); Hoa tiếp tục giữ vị trí số 1.
      await assert.rejects(
        () => withTx(async (sql) => waitlistAccept(sql, offerH.id, memH)),
        (err: any) => {
          assert.equal(err.extra?.br, "BR-21");
          return true;
        },
      );
      const hRow3 = (await db.query<{ status: string; waitlist_pos: number }>("select status, waitlist_pos from enrollments where id = $1", [(enrH.body as any).enrollment.id])).rows[0];
      assert.equal(hRow3.status, "waitlisted");
      assert.equal(hRow3.waitlist_pos, 1);

      // 5. N leaves -> H gets a new offer, accepts -> hold; L is now waitlist 1
      // Bước 5: Nam hủy đăng ký -> chỗ trống mở ra, Hoa nhận offer mới và chấp nhận thành công chuyển sang hold; Linh được đôn lên vị trí số 1.
      await withTx(async (sql) => enrollmentDelete(sql, (enrN.body as any).enrollment.id, memN));
      const newOfferH = (await db.query<{ id: string; status: string }>(
        "select id, status from waitlist_offers where enrollment_id = $1 and status = 'pending'",
        [(enrH.body as any).enrollment.id],
      )).rows[0];
      assert.ok(newOfferH);

      const accRes = await withTx(async (sql) => waitlistAccept(sql, newOfferH.id, memH));
      assert.equal(accRes.status, 200);
      const hRow4 = (await db.query<{ status: string }>("select status from enrollments where id = $1", [(enrH.body as any).enrollment.id])).rows[0];
      assert.equal(hRow4.status, "hold");

      // L is now waitlist 1
      const lRow2 = (await db.query<{ status: string; waitlist_pos: number }>("select status, waitlist_pos from enrollments where id = $1", [(enrL.body as any).enrollment.id])).rows[0];
      assert.equal(lRow2.status, "waitlisted");
      assert.equal(lRow2.waitlist_pos, 1);

      // 6. L leaves the waitlist -> class has no waitlisted rows; positions of any others stay gap-free
      // Bước 6: Linh hủy đăng ký khỏi danh sách chờ -> lớp học không còn ai trong waitlist; thứ tự đảm bảo liên tục không có khoảng trống (gap-free).
      const delL = await withTx(async (sql) => enrollmentDelete(sql, (enrL.body as any).enrollment.id, memL));
      assert.equal(delL.status, 200);
      const remainingWl = (await db.query<{ count: number }>("select count(*)::int as count from enrollments where class_id = $1 and status = 'waitlisted'", [classW])).rows[0].count;
      assert.equal(remainingWl, 0);

      // Clean up
      // Dọn dẹp dữ liệu đăng ký và lớp học sau khi kịch bản test kết thúc.
      await db.query("delete from waitlist_offers where enrollment_id in (select id from enrollments where class_id = $1)", [classW]);
      await db.query("delete from enrollments where class_id = $1", [classW]);
      await db.query("delete from classes where id = $1", [classW]);
    });

    /**
     * Làm gì: Kiểm tra cơ chế tự động xử lý offer hết hạn qua job waitlistExpire:
     * hủy đăng ký của người để hết hạn (status = 'cancelled', waitlist_pos = null),
     * và tự động đôn tất cả những người xếp sau lên một bậc để đảm bảo danh sách chờ luôn liên tục không có lỗ hổng (gap-free).
     * Được gọi ở: test runner (node --test)
     * @returns Promise<void>
     * @throws AssertionError nếu người hết hạn không bị hủy hoặc thứ tự dồn hàng bị sai lệch
     */
    it("W-2: expired offer drops its holder and moves everyone up by one (gap-free)", async () => {
      // Bước 1: Chuẩn bị dữ liệu: An chiếm chỗ, Hoa (waitlist 1), Nam (waitlist 2), Linh (waitlist 3).
      await setupW();

      // Enrol A (confirmed, fills capacity)
      await withTx(async (sql) => classesEnroll(sql, classW, new Request("http://localhost"), memA));

      // H joins (waitlist 1)
      const enrH = await withTx(async (sql) => classesEnroll(sql, classW, new Request("http://localhost"), memH));
      // N joins (waitlist 2)
      const enrN = await withTx(async (sql) => classesEnroll(sql, classW, new Request("http://localhost"), memN));
      // L joins (waitlist 3)
      const enrL = await withTx(async (sql) => classesEnroll(sql, classW, new Request("http://localhost"), memL));

      // Create an expired pending offer for H
      // Bước 2: Tạo một lời mời đang chờ (pending) cho Hoa nhưng cố tình đặt thời gian hết hạn trong quá khứ (-5 phút).
      await db.query(
        `insert into waitlist_offers (enrollment_id, expires_at, status)
         values ($1, now() - interval '5 minutes', 'pending')`,
        [(enrH.body as any).enrollment.id],
      );

      // Run waitlistExpire job
      // Bước 3: Chạy cron job waitlistExpire để quét và xử lý các offer đã quá hạn trong hệ thống.
      const expiredCount = await waitlistExpire();
      assert.ok(expiredCount >= 1);

      // H's enrollment should be cancelled
      // Bước 4: Kiểm tra đơn đăng ký của Hoa bị chuyển sang cancelled và vị trí hàng đợi waitlist_pos bị xóa thành null.
      const hRow = (await db.query<{ status: string; waitlist_pos: number | null }>("select status, waitlist_pos from enrollments where id = $1", [(enrH.body as any).enrollment.id])).rows[0];
      assert.equal(hRow.status, "cancelled");
      assert.equal(hRow.waitlist_pos, null);

      // N should now be waitlist 1
      // Bước 5: Kiểm tra cơ chế dồn hàng liên tục (gap-free): Nam từ vị trí 2 được đôn lên vị trí 1, Linh từ vị trí 3 lên vị trí 2.
      const nRow = (await db.query<{ status: string; waitlist_pos: number }>("select status, waitlist_pos from enrollments where id = $1", [(enrN.body as any).enrollment.id])).rows[0];
      assert.equal(nRow.status, "waitlisted");
      assert.equal(nRow.waitlist_pos, 1);

      // L should now be waitlist 2
      const lRow = (await db.query<{ status: string; waitlist_pos: number }>("select status, waitlist_pos from enrollments where id = $1", [(enrL.body as any).enrollment.id])).rows[0];
      assert.equal(lRow.status, "waitlisted");
      assert.equal(lRow.waitlist_pos, 2);

      // Clean up
      // Dọn dẹp dữ liệu của lớp học W và các bảng liên quan sau ca kiểm thử.
      await db.query("delete from waitlist_offers where enrollment_id in (select id from enrollments where class_id = $1)", [classW]);
      await db.query("delete from enrollments where class_id = $1", [classW]);
      await db.query("delete from classes where id = $1", [classW]);
    });
  });

  // Suite Task M: Bộ kiểm thử hồ sơ chi tiết hội viên (full member profile) phục vụ cho giao diện của lễ tân (receptionist) và quản lý (manager).
  describe("Task M: full member profile for reception and manager", () => {
    const memM1 = { id: "e0000000-0000-0000-0000-000000000001", phone: "+84999992001", full_name: "M Member 1", role: "member" } as any;
    const memM2 = { id: "e0000000-0000-0000-0000-000000000002", phone: "+84999992002", full_name: "M Member 2", role: "member" } as any;
    const coachM = { id: "e0000000-0000-0000-0000-000000000003", phone: "+84999992003", full_name: "M Coach", role: "coach" } as any;
    const mgrM = { id: "e0000000-0000-0000-0000-000000000004", phone: "+84999992004", full_name: "M Manager", role: "manager" } as any;
    const recM = { id: "e0000000-0000-0000-0000-000000000005", phone: "+84999992005", full_name: "M Reception", role: "receptionist" } as any;

    const classM1 = "f0000000-0000-0000-0000-000000000001";
    const classM2 = "f0000000-0000-0000-0000-000000000002";
    const courtM = "10000000-0000-0000-0000-000000000001";
    const planM = "20000000-0000-0000-0000-000000000003";
    const subM1 = "e1000000-0000-0000-0000-000000000001";

    /**
     * Làm gì: Xóa sạch dữ liệu thử nghiệm liên quan đến hội viên, nhân viên và các lớp học của Task M (attendance, waitlist_offers, enrollments, classes, subscriptions, payments, users).
     * Được gọi ở: setupM, hook after của suite Task M
     * @returns Promise<void>
     * @throws Error nếu câu lệnh xóa dữ liệu database thất bại
     */
    async function cleanupM() {
      // Bước 1: Xóa theo thứ tự ràng buộc khóa ngoại: attendance, waitlist_offers, enrollments, classes, subscriptions, payments và users.
      await db.query("delete from attendance where user_id in ($1, $2)", [memM1.id, memM2.id]);
      await db.query("delete from waitlist_offers where enrollment_id in (select id from enrollments where class_id in ($1, $2))", [classM1, classM2]);
      await db.query("delete from enrollments where class_id in ($1, $2) or user_id in ($3, $4)", [classM1, classM2, memM1.id, memM2.id]);
      await db.query("delete from classes where id in ($1, $2)", [classM1, classM2]);
      await db.query("delete from subscriptions where user_id in ($1, $2)", [memM1.id, memM2.id]);
      await db.query("delete from payments where user_id in ($1, $2)", [memM1.id, memM2.id]);
      await db.query("delete from users where id in ($1, $2, $3, $4, $5)", [memM1.id, memM2.id, coachM.id, mgrM.id, recM.id]);
    }

    /**
     * Làm gì: Khởi tạo dữ liệu kiểm thử hoàn chỉnh cho hồ sơ hội viên M1 (vị thành niên có người giám hộ, gói tập, đăng ký lớp học, điểm danh và giao dịch thanh toán) và hội viên M2.
     * Được gọi ở: các ca kiểm thử trong suite Task M (như test memberGet returns full profile)
     * @returns Promise<void>
     * @throws Error nếu các câu lệnh chèn dữ liệu thất bại
     */
    async function setupM() {
      // Bước 1: Dọn sạch dữ liệu cũ trước khi bắt đầu tạo mới.
      await cleanupM();
      // Bước 2: Khởi tạo danh sách tài khoản nhân viên (huấn luyện viên, quản lý, lễ tân).
      for (const u of [coachM, mgrM, recM]) {
        await db.query(
          `insert into users (id, phone, full_name, name_normalized, role, password_hash)
           values ($1, $2, $3, $4, $5, 'hash')`,
          [u.id, u.phone, u.full_name, u.full_name.toLowerCase(), u.role],
        );
      }
      // Bước 3: Tạo hội viên M1 là đối tượng vị thành niên (sinh năm 2008, dưới 18 tuổi) nên bắt buộc có thông tin người giám hộ (guardian) và ngày đồng ý lưu trữ PII.
      await db.query(
        `insert into users (id, phone, full_name, name_normalized, role, password_hash, email, status, date_of_birth, pii_consent_at, guardian_name, guardian_phone, created_at)
         values ($1, $2, $3, $4, 'member', 'hash', 'm1@example.com', 'active', '2008-05-15', now(), 'Guardian One', '+84999992099', now() - interval '60 days')`,
        [memM1.id, memM1.phone, memM1.full_name, memM1.full_name.toLowerCase()],
      );
      // Bước 4: Tạo hội viên M2 là người trưởng thành (sinh năm 1995, không cần người giám hộ).
      await db.query(
        `insert into users (id, phone, full_name, name_normalized, role, password_hash, status, date_of_birth, created_at)
         values ($1, $2, $3, $4, 'member', 'hash', 'active', '1995-10-20', now() - interval '100 days')`,
        [memM2.id, memM2.phone, memM2.full_name, memM2.full_name.toLowerCase()],
      );

      // Bước 5: Tạo 2 lớp học cầu lông (trình độ Beginner và Advanced) do coachM phụ trách.
      await db.query(
        `insert into classes (id, sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count)
         values ($1, 'badminton', 'Beginner', $2, $3, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=18', current_date - 10, current_date + 30, 60, 5, 'open', 1)`,
        [classM1, coachM.id, courtM],
      );
      await db.query(
        `insert into classes (id, sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count)
         values ($1, 'badminton', 'Advanced', $2, $3, 'FREQ=WEEKLY;BYDAY=TH;BYHOUR=19', current_date - 10, current_date + 30, 60, 5, 'open', 1)`,
        [classM2, coachM.id, courtM],
      );

      // Bước 6: Khởi tạo gói tập active kèm số buổi còn lại (session_left = 7) cho hội viên M1.
      await db.query(
        `insert into subscriptions (id, user_id, plan_id, start_on, end_on, status, session_left, price_vnd)
         values ($1, $2, $3, current_date - 5, current_date + 25, 'active', 7, 500000)`,
        [subM1, memM1.id, planM],
      );

      // Bước 7: Tạo các lượt đăng ký: M1 được xác nhận ở lớp 1 và nằm trong danh sách chờ lớp 2 kèm offer pending.
      const enr1 = "e2000000-0000-0000-0000-000000000001";
      const enr2 = "e2000000-0000-0000-0000-000000000002";
      await db.query(
        `insert into enrollments (id, class_id, user_id, status, waitlist_pos)
         values ($1, $2, $3, 'confirmed', null)`,
        [enr1, classM1, memM1.id],
      );
      await db.query(
        `insert into enrollments (id, class_id, user_id, status, waitlist_pos)
         values ($1, $2, $3, 'waitlisted', 1)`,
        [enr2, classM2, memM1.id],
      );
      await db.query(
        `insert into waitlist_offers (id, enrollment_id, status, expires_at)
         values ('e3000000-0000-0000-0000-000000000001', $1, 'pending', now() + interval '2 hours')`,
        [enr2],
      );

      // Bước 8: Khởi tạo lịch sử điểm danh (attendance) cho M1 với đầy đủ các kết quả: có mặt (present), đi muộn (late), vắng mặt (absent), nghỉ phép (excused).
      await db.query(
        `insert into attendance (user_id, kind, result, at)
         values
           ($1, 'session', 'present', now() - interval '2 days'),
           ($1, 'session', 'late', now() - interval '5 days'),
           ($1, 'session', 'absent', now() - interval '10 days'),
           ($1, 'session', 'excused', now() - interval '15 days'),
           ($1, 'session', 'present', now() - interval '40 days')`,
        [memM1.id],
      );

      // Ghi nhận hóa đơn thanh toán gói tập (payments) cho hội viên memM1 để kiểm tra trường payments trong hồ sơ.
      await db.query(
        `insert into payments (id, user_id, code, method, amount_vnd, vat_rate, status, ref_type, ref_id)
         values ('e4000000-0000-0000-0000-000000000001', $1, 'PAY-M1', 'cash', 500000, 8, 'posted', 'subscription', $2)`,
        [memM1.id, subM1],
      );
    }

    // Dọn dẹp dữ liệu kiểm thử của Task M sau khi chạy xong tất cả các ca test trong suite.
    after(async () => {
      await cleanupM();
    });

    /**
     * Làm gì: Kiểm tra API memberGet trả về đầy đủ hồ sơ chi tiết của hội viên cho Manager:
     * thông tin user cơ bản, người giám hộ (guardian), gói tập (subscriptions), lớp học đăng ký (enrollments),
     * thống kê điểm danh trong 30 ngày (attendance_summary) và danh sách thanh toán (payments).
     * Được gọi ở: test runner (node --test)
     * @returns Promise<void>
     * @throws AssertionError nếu thông tin chi tiết hội viên trả về không đầy đủ hoặc sai lệch
     */
    it("memberGet returns full profile: user fields, subscriptions, enrollments, attendance_summary", async () => {
      // Bước 1: Khởi tạo dữ liệu mẫu (hội viên memM1, người giám hộ, gói tập, lớp học, điểm danh, hóa đơn thanh toán).
      await setupM();
      // Bước 2: Gọi hàm memberGet với quyền Manager để lấy toàn bộ hồ sơ chi tiết của hội viên memM1.
      const res = await withTx(async (sql) => memberGet(sql, memM1.id, mgrM));
      assert.equal(res.status, 200);
      const b = res.body as any;

      // Bước 3: Xác minh các trường thông tin cơ bản của user (id, email, status, created_at, pii_consent_at).
      assert.equal(b.user.id, memM1.id);
      assert.equal(b.user.email, "m1@example.com");
      assert.equal(b.user.status, "active");
      assert.ok(b.user.created_at);
      assert.ok(b.user.pii_consent_at);

      // Bước 4: Xác minh thông tin người giám hộ (guardian_name, guardian_phone) đã lưu cho hội viên vị thành niên.
      assert.equal(b.guardian.name, "Guardian One");
      assert.equal(b.guardian.phone, "+84999992099");

      // Bước 5: Kiểm tra danh sách gói tập (subscriptions): đúng ID gói tập, trạng thái active, số buổi còn lại và công nợ.
      // memberGet still returns the member's plan orders (the desk takes payment from them),
      // so the contract is the seeded subscription, not the absence of the key.
      assert.ok(Array.isArray(b.subscriptions));
      assert.equal(b.subscriptions.length, 1);
      assert.equal(b.subscriptions[0].id, subM1);
      assert.equal(b.subscriptions[0].status, "active");
      assert.equal(b.subscriptions[0].session_left, 7);
      assert.equal(b.subscriptions[0].price_vnd, 500000);
      assert.equal(b.subscriptions[0].due_vnd, 500000);

      // Bước 6: Kiểm tra các lớp học đăng ký (enrollments): lớp đã xác nhận (confirmed) và lớp trong danh sách chờ (waitlisted) kèm ưu đãi suất trống.
      assert.equal(b.enrollments.length, 2);
      const conf = b.enrollments.find((e: any) => e.status === "confirmed");
      assert.ok(conf);
      assert.equal(conf.coach_name, "M Coach");
      const wait = b.enrollments.find((e: any) => e.status === "waitlisted");
      assert.ok(wait);
      assert.equal(wait.waitlist_pos, 1);
      assert.equal(wait.offer_pending, true);
      assert.ok(wait.offer_expires_at);

      // Bước 7: Kiểm tra tổng kết điểm danh trong 30 ngày (present, late, absent, excused) và thời điểm điểm danh gần nhất (last_visit_at).
      assert.equal(b.attendance_summary.present, 1);
      assert.equal(b.attendance_summary.late, 1);
      assert.equal(b.attendance_summary.absent, 1);
      assert.equal(b.attendance_summary.excused, 1);
      assert.ok(b.attendance_summary.last_visit_at);

      // Bước 8: Kiểm tra lịch sử giao dịch thanh toán (payments) của hội viên hiển thị đầy đủ cho cấp quản lý.
      assert.ok(b.payments && b.payments.length >= 1);
    });

    /**
     * Làm gì: Kiểm tra phân quyền truy cập hồ sơ hội viên đối với Huấn luyện viên (Coach):
     * ẩn dữ liệu nhạy cảm (payments, pii_consent_at) khi xem học viên trong lớp mình dạy,
     * và chặn truy cập (403 Forbidden) khi cố xem học viên không thuộc bất kỳ lớp nào do HLV phụ trách.
     * Được gọi ở: test runner (node --test)
     * @returns Promise<void>
     * @throws AssertionError nếu thông tin nhạy cảm không bị ẩn hoặc HLV xem được học viên ngoài lớp
     */
    it("memberGet for coach strips payments and pii_consent_at, forbids non-taught member", async () => {
      // Bước 1: Khởi tạo dữ liệu mẫu gồm học viên memM1 (có ghi danh lớp của coachM) và memM2 (không học coachM).
      await setupM();

      // Bước 2: HLV gọi memberGet xem học viên memM1 trong lớp của mình; kiểm tra payments và pii_consent_at bị loại bỏ (undefined).
      const res = await withTx(async (sql) => memberGet(sql, memM1.id, coachM));
      assert.equal(res.status, 200);
      const b = res.body as any;
      assert.equal(b.payments, undefined);
      assert.equal(b.user.pii_consent_at, undefined);

      // Bước 3: HLV cố gắng xem học viên memM2 không thuộc lớp mình dạy; hệ thống phải chặn với mã lỗi 403 Forbidden.
      await assert.rejects(
        () => withTx(async (sql) => memberGet(sql, memM2.id, coachM)),
        (err: any) => err.status === 403,
      );
    });

    /**
     * Làm gì: Kiểm tra API danh bạ hội viên (membersDirectory) trả về đúng trường ngày sinh (date_of_birth)
     * cho từng hội viên để nhân viên kiểm tra độ tuổi và quản lý chính sách hội viên.
     * Được gọi ở: test runner (node --test)
     * @returns Promise<void>
     * @throws AssertionError nếu trường date_of_birth bị thiếu hoặc trả về sai giá trị
     */
    it("membersDirectory returns date_of_birth for members", async () => {
      // Bước 1: Khởi tạo dữ liệu danh bạ mẫu gồm các hội viên có ngày sinh xác định.
      await setupM();
      // Bước 2: Tạo request tìm kiếm danh bạ theo từ khóa và gọi membersDirectory với quyền Manager.
      const req = new Request("http://localhost?limit=10&q=M%20Member");
      const res = await withTx(async (sql) => membersDirectory(sql, req, mgrM));
      assert.equal(res.status, 200);
      const b = res.body as any;
      // Bước 3: Xác minh trường date_of_birth chuẩn định dạng YYYY-MM-DD trả về chính xác cho từng hội viên tìm thấy.
      const m1 = b.items.find((r: any) => r.id === memM1.id);
      assert.ok(m1);
      assert.equal(m1.date_of_birth, "2008-05-15");
      const m2 = b.items.find((r: any) => r.id === memM2.id);
      assert.ok(m2);
      assert.equal(m2.date_of_birth, "1995-10-20");
    });
  });

  // Suite Task V: Bộ kiểm thử đồng bộ ảnh đại diện (avatar) của người dùng trên toàn bộ các danh sách và màn hình chi tiết.
  describe("Task V: avatars wherever a name is listed", () => {
    /**
     * Làm gì: Tạo Buffer nhị phân chứa header ảnh PNG hợp lệ tối thiểu (PNG signature và chunk IHDR)
     * phục vụ kiểm thử tính năng upload avatar mà không cần cài thêm thư viện đồ họa ngoài.
     * Được gọi ở: test "after meAvatarPut, membersDirectory, membersSearch, memberGet, and class roster return non-null avatar_url; after meAvatarDelete they return null"
     * @param width Chiều rộng ảnh theo pixel (mặc định 64)
     * @param height Chiều cao ảnh theo pixel (mặc định 64)
     * @returns Buffer nhị phân chứa cấu trúc header PNG hợp lệ
     */
    function makePng(width = 64, height = 64): Buffer {
      // Bước 1: 8 bytes signature tiêu chuẩn nhận diện file định dạng PNG.
      const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      // Bước 2: Tạo chunk IHDR 25 bytes chứa kích thước (width x height), bit depth 8, color type 6 (RGBA) và CRC checksum.
      const ihdr = Buffer.alloc(25);
      ihdr.writeUInt32BE(13, 0);
      ihdr.write("IHDR", 4, 4, "ascii");
      ihdr.writeUInt32BE(width, 8);
      ihdr.writeUInt32BE(height, 12);
      ihdr[16] = 8;
      ihdr[17] = 6;
      ihdr[18] = 0;
      ihdr[19] = 0;
      ihdr[20] = 0;
      ihdr.writeUInt32BE(0, 21);
      return Buffer.concat([sig, ihdr]);
    }

    // Dữ liệu mẫu dùng chung cho Task V: hội viên, HLV, quản lý, lớp học và sân tập.
    const memV = { id: "d0000000-0000-0000-0000-000000000001", phone: "+84999993001", full_name: "V Member", role: "member" } as any;
    const coachV = { id: "d0000000-0000-0000-0000-000000000002", phone: "+84999993002", full_name: "V Coach", role: "coach" } as any;
    const mgrV = { id: "d0000000-0000-0000-0000-000000000003", phone: "+84999993003", full_name: "V Manager", role: "manager" } as any;
    const classV = "f0000000-0000-0000-0000-000000000010";
    const courtV = "10000000-0000-0000-0000-000000000001";

    /**
     * Làm gì: Dọn dẹp sạch dữ liệu kiểm thử Task V (xóa avatar, danh sách ghi danh, lớp học và tài khoản người dùng).
     * Được gọi ở: setupV, hook after trong describe "Task V: avatars wherever a name is listed"
     * @returns Promise<void>
     */
    async function cleanupV() {
      await db.query("delete from user_avatars where user_id in ($1, $2, $3)", [memV.id, coachV.id, mgrV.id]);
      await db.query("delete from enrollments where class_id = $1 or user_id = $2", [classV, memV.id]);
      await db.query("delete from classes where id = $1", [classV]);
      await db.query("delete from users where id in ($1, $2, $3)", [memV.id, coachV.id, mgrV.id]);
    }

    /**
     * Làm gì: Khởi tạo dữ liệu môi trường kiểm thử cho Task V: xóa dữ liệu cũ, thêm user (HLV, Manager, Member), tạo lớp học và ghi danh học viên.
     * Được gọi ở: test "after meAvatarPut, membersDirectory, membersSearch, memberGet, and class roster return non-null avatar_url; after meAvatarDelete they return null"
     * @returns Promise<void>
     */
    async function setupV() {
      // Bước 1: Xóa sạch dữ liệu cũ tránh xung đột khóa chính trước khi tạo mới.
      await cleanupV();
      // Bước 2: Thêm tài khoản HLV và Quản lý vào bảng users.
      for (const u of [coachV, mgrV]) {
        await db.query(
          `insert into users (id, phone, full_name, name_normalized, role, password_hash)
           values ($1, $2, $3, $4, $5, 'hash')`,
          [u.id, u.phone, u.full_name, u.full_name.toLowerCase(), u.role],
        );
      }
      // Bước 3: Thêm tài khoản Hội viên đang hoạt động kèm ngày sinh.
      await db.query(
        `insert into users (id, phone, full_name, name_normalized, role, password_hash, status, date_of_birth)
         values ($1, $2, $3, $4, 'member', 'hash', 'active', '1990-01-01')`,
        [memV.id, memV.phone, memV.full_name, memV.full_name.toLowerCase()],
      );
      // Bước 4: Tạo lớp học cầu lông (badminton) gán cho HLV và sân tập tương ứng.
      await db.query(
        `insert into classes (id, sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count)
         values ($1, 'badminton', 'Beginner', $2, $3, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=18', current_date - 1, current_date + 30, 60, 5, 'open', 1)`,
        [classV, coachV.id, courtV],
      );
      // Bước 5: Ghi danh hội viên vào lớp học với trạng thái confirmed.
      await db.query(
        `insert into enrollments (id, class_id, user_id, status)
         values ('d2000000-0000-0000-0000-000000000001', $1, $2, 'confirmed')`,
        [classV, memV.id],
      );
    }

    // Dọn dẹp dữ liệu test Task V sau khi toàn bộ suite hoàn tất.
    after(async () => {
      await cleanupV();
    });

    /**
     * Làm gì: Kiểm tra vòng đời ảnh đại diện (avatar) của người dùng trên toàn bộ hệ thống:
     * khi chưa có avatar, tất cả 5 endpoint (danh bạ, tìm kiếm, hồ sơ chi tiết, chi tiết lớp, danh sách điểm danh lớp) đều trả về avatar_url là null;
     * sau khi tải lên avatar (PUT /v1/me/avatar), toàn bộ các endpoint trên trả về URL dẫn tới ảnh đại diện;
     * sau khi xóa avatar (DELETE /v1/me/avatar), tất cả quay về giá trị null.
     * Được gọi ở: test runner (node --test)
     * @returns Promise<void>
     * @throws AssertionError nếu avatar_url không đồng bộ chính xác trên các màn hình và danh sách
     */
    it("after meAvatarPut, membersDirectory, membersSearch, memberGet, and class roster return non-null avatar_url; after meAvatarDelete they return null", async () => {
      // Bước 1: Chuẩn bị dữ liệu ban đầu cho các user chưa có ảnh đại diện.
      await setupV();

      // Bước 2: Kiểm tra trạng thái ban đầu khi chưa upload avatar: cả 5 endpoint đều phải trả về avatar_url = null.
      // 1. Initially without avatar, all return avatar_url = null
      const initDir = await withTx(async (sql) => membersDirectory(sql, new Request("http://localhost?q=V%20Member"), mgrV));
      const initSearch = await withTx(async (sql) => membersSearch(sql, new Request("http://localhost?q=V%20Member"), mgrV));
      const initGet = await withTx(async (sql) => memberGet(sql, memV.id, mgrV));
      const initClass = await withTx(async (sql) => classDetail(sql, classV, mgrV));
      const initRoster = await withTx(async (sql) => classRoster(sql, classV, mgrV));

      assert.equal((initDir.body as any).items.find((r: any) => r.id === memV.id)?.avatar_url, null);
      assert.equal((initSearch.body as any).items.find((r: any) => r.id === memV.id)?.avatar_url, null);
      assert.equal((initGet.body as any).user.avatar_url, null);
      assert.equal((initClass.body as any).roster.find((r: any) => r.id === memV.id)?.avatar_url, null);
      assert.equal((initRoster.body as any).items.find((r: any) => r.id === memV.id)?.avatar_url, null);

      // Bước 3: Người dùng memV tải lên avatar mới dạng PNG base64 thông qua handler meAvatarPut.
      // 2. PUT avatar
      const reqPut = new Request("http://localhost/v1/me/avatar", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data_base64: makePng(64, 64).toString("base64") }),
      });
      const putRes = await withTx(async (sql) => meAvatarPut(sql, reqPut, memV));
      assert.equal(putRes.status, 200);

      // Bước 4: Kiểm tra lại cả 5 endpoint sau khi upload; avatar_url phải trỏ về URL hợp lệ dạng /v1/users/{id}/avatar.
      // 3. Each returns non-null avatar_url
      const afterDir = await withTx(async (sql) => membersDirectory(sql, new Request("http://localhost?q=V%20Member"), mgrV));
      const afterSearch = await withTx(async (sql) => membersSearch(sql, new Request("http://localhost?q=V%20Member"), mgrV));
      const afterGet = await withTx(async (sql) => memberGet(sql, memV.id, mgrV));
      const afterClass = await withTx(async (sql) => classDetail(sql, classV, mgrV));
      const afterRoster = await withTx(async (sql) => classRoster(sql, classV, mgrV));

      const dirUrl = (afterDir.body as any).items.find((r: any) => r.id === memV.id)?.avatar_url;
      const searchUrl = (afterSearch.body as any).items.find((r: any) => r.id === memV.id)?.avatar_url;
      const getUrl = (afterGet.body as any).user.avatar_url;
      const classUrl = (afterClass.body as any).roster.find((r: any) => r.id === memV.id)?.avatar_url;
      const rosterUrl = (afterRoster.body as any).items.find((r: any) => r.id === memV.id)?.avatar_url;

      assert.ok(dirUrl && dirUrl.includes(`/v1/users/${memV.id}/avatar`));
      assert.ok(searchUrl && searchUrl.includes(`/v1/users/${memV.id}/avatar`));
      assert.ok(getUrl && getUrl.includes(`/v1/users/${memV.id}/avatar`));
      assert.ok(classUrl && classUrl.includes(`/v1/users/${memV.id}/avatar`));
      assert.ok(rosterUrl && rosterUrl.includes(`/v1/users/${memV.id}/avatar`));

      // Bước 5: Người dùng memV gọi meAvatarDelete để xóa ảnh đại diện cá nhân.
      // 4. DELETE avatar
      const delRes = await withTx(async (sql) => meAvatarDelete(sql, memV));
      assert.equal(delRes.status, 200);

      // Bước 6: Kiểm tra lại cả 5 endpoint sau khi xóa avatar; tất cả đều phải đồng bộ quay về giá trị null.
      // 5. Each returns null
      const finalDir = await withTx(async (sql) => membersDirectory(sql, new Request("http://localhost?q=V%20Member"), mgrV));
      const finalSearch = await withTx(async (sql) => membersSearch(sql, new Request("http://localhost?q=V%20Member"), mgrV));
      const finalGet = await withTx(async (sql) => memberGet(sql, memV.id, mgrV));
      const finalClass = await withTx(async (sql) => classDetail(sql, classV, mgrV));
      const finalRoster = await withTx(async (sql) => classRoster(sql, classV, mgrV));

      assert.equal((finalDir.body as any).items.find((r: any) => r.id === memV.id)?.avatar_url, null);
      assert.equal((finalSearch.body as any).items.find((r: any) => r.id === memV.id)?.avatar_url, null);
      assert.equal((finalGet.body as any).user.avatar_url, null);
      assert.equal((finalClass.body as any).roster.find((r: any) => r.id === memV.id)?.avatar_url, null);
      assert.equal((finalRoster.body as any).items.find((r: any) => r.id === memV.id)?.avatar_url, null);
    });
  });

// Suite Cài đặt tài khoản (Account settings): Kiểm tra cập nhật thông tin cá nhân (PATCH /v1/me), hồ sơ mở rộng (GET /v1/me/profile) và quản lý đa phiên đăng nhập.
describe("Account settings (profile page)", () => {
  /**
   * Làm gì: Kiểm tra tính hợp lệ dữ liệu (validation) khi cập nhật thông tin cá nhân (PATCH /v1/me):
   * chặn tên trống hoặc vượt quá 120 ký tự, chặn ghi chú sức khỏe vượt quá 1000 ký tự,
   * tự động chuyển chuỗi khoảng trắng thành null, và bỏ qua trường health_notes nếu người dùng không phải role member (ví dụ coach).
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu validation hoặc quyền cập nhật trường không hoạt động đúng kỳ vọng
   */
  it("validates mePatch full_name and health_notes", async () => {
    // Bước 1: Khởi tạo tài khoản hội viên mẫu trong DB và chuyển sang đối tượng public userPub.
    const phone = "0987000021";
    const pwHash = hashPassword("Pass123!");
    const userId = (
      await db.query<{ id: string }>(
        `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
         values (gen_random_uuid(), $1, 'Member TwentyOne', 'member twentyone', 'member', 'active', $2)
         returning id`,
        [phone, pwHash],
      )
    ).rows[0].id;
    const userPub = toPublic((await db.query("select * from users where id = $1", [userId])).rows[0] as any);

    // Bước 2: Kiểm tra cập nhật full_name toàn khoảng trắng; handler phải reject mã lỗi 400 kèm field "full_name".
    // mePatch with full_name: "   " -> rejects with 400 and field === "full_name"
    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ full_name: "   " }),
      });
      await assert.rejects(
        async () => authH.mePatch(sql, req, userPub),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "full_name");
          return true;
        },
      );
    });

    // Bước 3: Kiểm tra giới hạn độ dài full_name vượt quá 120 ký tự (121 ký tự); handler phải reject 400 kèm field "full_name".
    // mePatch with a 121-character name -> 400, field === "full_name"
    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ full_name: "A".repeat(121) }),
      });
      await assert.rejects(
        async () => authH.mePatch(sql, req, userPub),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "full_name");
          return true;
        },
      );
    });

    // Bước 4: Kiểm tra giới hạn độ dài health_notes vượt quá 1000 ký tự (1001 ký tự); handler phải reject 400 kèm field "health_notes".
    // mePatch by a member with 1001-character health_notes -> 400, field === "health_notes"
    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ health_notes: "H".repeat(1001) }),
      });
      await assert.rejects(
        async () => authH.mePatch(sql, req, userPub),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "health_notes");
          return true;
        },
      );
    });

    // Bước 5: Chuỗi health_notes chỉ gồm khoảng trắng phải được chuẩn hóa thành null trong DB và trả về user.health_notes = null.
    // mePatch by a member with health_notes: "  " -> stored as null
    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ health_notes: "  " }),
      });
      const res = await authH.mePatch(sql, req, userPub);
      assert.equal(res.status, 200);
      assert.equal((res.body as any).user.health_notes, null);
    });
    const checkDb = (await db.query<{ health_notes: string | null }>("select health_notes from users where id = $1", [userId])).rows[0];
    assert.equal(checkDb.health_notes, null);

    // Bước 6: Kiểm tra tài khoản HLV (coach): trường health_notes chỉ dành cho hội viên nên HLV gửi lên sẽ bị bỏ qua, giữ nguyên giá trị cũ trong DB.
    // mePatch by a coach with health_notes: "x" -> 200 and health_notes unchanged in database
    const coachPhone = "0987000022";
    const coachId = (
      await db.query<{ id: string }>(
        `insert into users (id, phone, full_name, name_normalized, role, status, password_hash, health_notes)
         values (gen_random_uuid(), $1, 'Coach TwentyTwo', 'coach twentytwo', 'coach', 'active', $2, 'initial notes')
         returning id`,
        [coachPhone, pwHash],
      )
    ).rows[0].id;
    const coachPub = toPublic((await db.query("select * from users where id = $1", [coachId])).rows[0] as any);

    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ health_notes: "x" }),
      });
      const res = await authH.mePatch(sql, req, coachPub);
      assert.equal(res.status, 200);
    });
    const coachDb = (await db.query<{ health_notes: string | null }>("select health_notes from users where id = $1", [coachId])).rows[0];
    assert.equal(coachDb.health_notes, "initial notes");
  });

  /**
   * Làm gì: Kiểm tra API xem hồ sơ cá nhân mở rộng (GET /v1/me/profile) trả về cấu trúc dữ liệu chính xác theo role:
   * với Member: trả về thông tin người giám hộ (guardian), ngày đồng ý PII (pii_consent_at) và coach = null;
   * với Coach: trả về danh sách môn dạy (sports), mức thù lao mặc định (per_session_vnd, per_student_vnd) và guardian = null.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu dữ liệu hồ sơ cá nhân trả về không khớp với vai trò của người dùng
   */
  it("handles meProfile for member and coach correctly", async () => {
    // Bước 1: Chuẩn bị mật khẩu mã hóa dùng chung cho các tài khoản test.
    const pwHash = hashPassword("Pass123!");
    // Bước 2: Tạo tài khoản hội viên có người giám hộ và kiểm tra meProfile trả về đúng guardian, coach = null.
    // meProfile for a member with a guardian -> guardian.name matches, coach === null
    const memberGuardPhone = "0987000023";
    const memberGuardId = (
      await db.query<{ id: string }>(
        `insert into users (id, phone, full_name, name_normalized, role, status, password_hash, guardian_name, guardian_phone, pii_consent_at)
         values (gen_random_uuid(), $1, 'Member With Guardian', 'member with guardian', 'member', 'active', $2, 'Parent Guardian', '0912345678', now())
         returning id`,
        [memberGuardPhone, pwHash],
      )
    ).rows[0].id;
    const memberGuardPub = toPublic((await db.query("select * from users where id = $1", [memberGuardId])).rows[0] as any);
    let sGuard: any;
    await withTx(async (sql) => {
      sGuard = await issueSession(sql, memberGuardPub);
    });
    // Bước 3: Gọi endpoint meProfile cho hội viên; xác minh thông tin guardian, pii_consent_at và trường coach là null.
    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/me/profile", {
        headers: { authorization: `Bearer ${sGuard.token}` },
      });
      const res = await authH.meProfile(sql, req, memberGuardPub);
      assert.equal(res.status, 200);
      const b = res.body as any;
      assert.equal(b.guardian?.name, "Parent Guardian");
      assert.equal(b.guardian?.phone, "0912345678");
      assert.ok(b.pii_consent_at);
      assert.equal(b.coach, null);
    });

    // Bước 4: Tạo tài khoản HLV kèm môn dạy badminton và kiểm tra meProfile trả về đúng sports, thù lao mặc định và guardian = null.
    // meProfile for a coach with one coach_sports row and no coach_rates row -> sports has that sport, rates are 150000 / 10000, guardian === null
    const coachProfPhone = "0987000024";
    const coachProfId = (
      await db.query<{ id: string }>(
        `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
         values (gen_random_uuid(), $1, 'Coach Profile', 'coach profile', 'coach', 'active', $2)
         returning id`,
        [coachProfPhone, pwHash],
      )
    ).rows[0].id;
    await db.query(`insert into coach_sports (user_id, sport) values ($1, 'badminton')`, [coachProfId]);
    const coachProfPub = toPublic((await db.query("select * from users where id = $1", [coachProfId])).rows[0] as any);
    let sCoach: any;
    await withTx(async (sql) => {
      sCoach = await issueSession(sql, coachProfPub);
    });
    // Bước 5: Gọi endpoint meProfile cho HLV; kiểm tra danh sách môn thể thao, thù lao mặc định (150.000đ/buổi, 10.000đ/học viên) và guardian là null.
    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/me/profile", {
        headers: { authorization: `Bearer ${sCoach.token}` },
      });
      const res = await authH.meProfile(sql, req, coachProfPub);
      assert.equal(res.status, 200);
      const b = res.body as any;
      assert.deepEqual(b.coach?.sports, ["badminton"]);
      assert.equal(b.coach?.per_session_vnd, 150000);
      assert.equal(b.coach?.per_student_vnd, 10000);
      assert.equal(b.guardian, null);
    });
  });

  /**
   * Làm gì: Kiểm tra tính năng quản lý đa phiên đăng nhập (multi-session):
   * đếm chính xác số lượng phiên đăng nhập khác đang hoạt động (other_sessions) qua meProfile,
   * và thu hồi toàn bộ các phiên khác (meSignOutOthers) trong khi vẫn duy trì hiệu lực của phiên hiện tại.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu số lượng other_sessions sai hoặc các phiên khác không bị vô hiệu hóa
   */
  it("handles multi-session counting and sign-out-others", async () => {
    // Bước 1: Tạo tài khoản hội viên và cấp đồng thời 3 phiên đăng nhập (sA, sB, sC).
    const pwHash = hashPassword("Pass123!");
    const multiPhone = "0987000025";
    const multiId = (
      await db.query<{ id: string }>(
        `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
         values (gen_random_uuid(), $1, 'Multi User', 'multi user', 'member', 'active', $2)
         returning id`,
        [multiPhone, pwHash],
      )
    ).rows[0].id;
    const multiPub = toPublic((await db.query("select * from users where id = $1", [multiId])).rows[0] as any);
    let sA: any, sB: any, sC: any;
    await withTx(async (sql) => {
      sA = await issueSession(sql, multiPub);
      sB = await issueSession(sql, multiPub);
      sC = await issueSession(sql, multiPub);
    });

    // Bước 2: Gọi meProfile với token của session A; kiểm tra trường other_sessions đếm chính xác 2 phiên còn lại.
    // Three sessions for one user; meProfile called with session A's token -> other_sessions === 2
    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/me/profile", {
        headers: { authorization: `Bearer ${sA.token}` },
      });
      const res = await authH.meProfile(sql, req, multiPub);
      assert.equal(res.status, 200);
      assert.equal((res.body as any).other_sessions, 2);
    });

    // Bước 3: Gọi meSignOutOthers từ session A để đăng xuất các phiên khác; kết quả trả về signed_out = 2.
    // meSignOutOthers with session A -> signed_out === 2; A still authenticates, B and C get 401; calling it again returns signed_out === 0
    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/me/sessions/sign-out-others", {
        method: "POST",
        headers: { authorization: `Bearer ${sA.token}` },
      });
      const res = await authH.meSignOutOthers(sql, req, multiPub);
      assert.equal(res.status, 200);
      assert.equal((res.body as any).signed_out, 2);

      // Bước 4: Xác minh session hiện tại (A) vẫn xác thực thành công sau khi thu hồi các phiên khác.
      // A still authenticates
      const uA = await authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${sA.token}` } }));
      assert.equal(uA.id, multiId);

      // Bước 5: Xác minh các session còn lại (B và C) đã bị thu hồi, gửi request sẽ nhận mã lỗi 401 Unauthorized.
      // B and C get 401
      await assert.rejects(
        async () => authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${sB.token}` } })),
        (err: any) => {
          assert.equal(err.status, 401);
          return true;
        },
      );
      // Bước 6: Xác minh phiên đăng nhập của thiết bị C (sC) cũng bị thu hồi, trả về HTTP 401 khi gọi API xác thực
      await assert.rejects(
        async () => authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${sC.token}` } })),
        (err: any) => {
          assert.equal(err.status, 401);
          return true;
        },
      );

      // Calling it again returns signed_out === 0
      // Bước 7: Thử nghiệm tính idempotent: gọi lại meSignOutOthers lần thứ hai, kết quả trả về signed_out = 0 vì không còn phiên nào khác
      const res2 = await authH.meSignOutOthers(sql, req, multiPub);
      assert.equal(res2.status, 200);
      assert.equal((res2.body as any).signed_out, 0);
    });
  });
});

// Suite kiểm tra tính toàn vẹn của danh sách cột (Shared row contracts match tables)
describe("Shared row contracts match the tables", () => {
  // columns.ts replaces `select *`; a migration that adds or drops a column
  // must update contracts.ts and columns.ts too, or the API shape drifts.
  /**
   * Làm gì: Đối soát danh sách cột tĩnh trong columns.ts (thay thế cho SELECT *) với thông tin schema thực tế trong PostgreSQL.
   * Ngăn chặn tình trạng sai lệch (schema drift) khi migration thêm/bớt cột trên các bảng court_bookings, payments và invoices.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu danh sách cột trong code không khớp chính xác với database
   */
  it("lists every column of court_bookings, payments and invoices, and nothing else", async () => {
    // Bước 1: Nạp động các hằng số danh sách cột cần đối soát từ service columns.ts
    const { BOOKING_COLS, PAYMENT_COLS, INVOICE_COLS } = await import("../services/columns.ts");
    // Bước 2: Duyệt qua từng bảng nghiệp vụ cốt lõi để so sánh danh sách cột giữa code và database
    for (const [table, cols] of [
      ["court_bookings", BOOKING_COLS],
      ["payments", PAYMENT_COLS],
      ["invoices", INVOICE_COLS],
    ] as const) {
      // Truy vấn danh sách cột thực tế từ bảng hệ thống information_schema.columns của PostgreSQL
      const res = await db.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1",
        [table],
      );
      // Bước 3: Sắp xếp và so sánh 2 mảng cột, đảm bảo không thiếu hoặc thừa bất kỳ cột nào
      assert.deepEqual(
        cols.split(", ").sort(),
        res.rows.map((r) => r.column_name).sort(),
        `${table} columns`,
      );
    }
  });
});

// Biến đếm tăng dần dùng để tạo khung giờ học (rrule) và cấp độ duy nhất, tránh xung đột lịch giữa các lớp học mẫu
let scClassSeq = 0;

/**
 * Làm gì: Tạo dữ liệu mẫu một lớp học cầu lông (badminton) với khung giờ hàng tuần duy nhất và trạng thái open.
 * Được gọi ở: Các ca kiểm thử đăng ký và bán lớp học trong tx.test.ts
 * @param opts Cấu hình lớp học gồm: giá học phí (price), sức chứa (capacity), mã sân (courtId) và lịch định kỳ (slot)
 * @returns ID của lớp học vừa được chèn vào database
 */
/** An open badminton class with a unique weekly slot, so classes never clash. */
async function seedClass(opts: { price: number | null; capacity: number; courtId?: string; slot?: string }): Promise<string> {
  // Bước 1: Tăng biến đếm tuần tự để tính toán thứ trong tuần và khung giờ học không trùng lặp
  scClassSeq += 1;
  const days = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
  const day = days[scClassSeq % 7];
  const hour = 6 + (Math.floor(scClassSeq / 7) % 16);
  const rrule = opts.slot ?? `FREQ=WEEKLY;BYDAY=${day};BYHOUR=${hour}`;
  // Bước 2: Chèn bản ghi lớp học vào database với thời hạn 60 ngày kể từ ngày mai
  const rows = await db.query<{ id: string }>(
    `insert into classes (sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count, price_vnd)
     values ('badminton', $1, '00000000-0000-0000-0000-000000000011', $5,
             $2, current_date + 1, current_date + 60, 60, $3, 'open', 0, $4)
     returning id`,
    [`sc-level-${scClassSeq}`, rrule, opts.capacity, opts.price, opts.courtId ?? "10000000-0000-0000-0000-000000000001"],
  );
  return rows.rows[0].id;
}

/**
 * Làm gì: Tạo hội viên mẫu sở hữu gói tập (subscription) còn hạn 400 ngày, đủ bao trọn thời gian lớp học để chỉ phải trả học phí.
 * Được gọi ở: Các ca kiểm thử đăng ký và thanh toán lớp học trong tx.test.ts
 * @param n Chỉ số định danh số thứ tự của hội viên
 * @returns Đối tượng PublicUser đại diện cho hội viên vừa tạo
 */
/** A member whose membership already covers every seeded class, so the price is the tuition alone. */
async function seedMember(n: number) {
  // Bước 1: Tạo tài khoản người dùng với vai trò member
  const member = await seedPlainUser(n);
  // Bước 2: Kích hoạt gói hội viên có thời hạn dài (400 ngày) nếu người dùng chưa có gói active
  await db.query(
    `insert into subscriptions (user_id, plan_id, start_on, end_on, status)
     select $1, $2, current_date - 1, current_date + 400, 'active'
      where not exists (select 1 from subscriptions where user_id = $1 and status = 'active')`,
    [member.id, SHORTEST_PLAN_ID],
  );
  return member;
}

/**
 * Làm gì: Tạo tài khoản người dùng thông thường (member) với UUID và số điện thoại cố định theo số thứ tự n.
 * Được gọi ở: seedMember và các ca kiểm thử trong tx.test.ts
 * @param n Số thứ tự để sinh ID và số điện thoại duy nhất
 * @returns Đối tượng người dùng tối giản dạng PublicUser (id, phone, full_name, role)
 */
/** A user with a fixed id 0000...0500 + n, shaped like a PublicUser. */
async function seedPlainUser(n: number) {
  // Bước 1: Sinh ID cố định định dạng UUID và số điện thoại duy nhất theo chỉ số n
  const id = `00000000-0000-0000-0000-0000000005${String(n).padStart(2, "0")}`;
  const phone = `+8490000${String(500 + n)}`;
  const name = `Sell Member ${n}`;
  // Bước 2: Chèn người dùng vào bảng users nếu chưa tồn tại (on conflict do nothing)
  await db.query(
    `insert into users (id, phone, full_name, name_normalized, role, password_hash)
     values ($1, $2, $3, $4, 'member', 'hash')
     on conflict (id) do nothing`,
    [id, phone, name, name.toLowerCase()],
  );
  return { id, phone, full_name: name, role: "member" } as any;
}

// Suite kiểm tra báo giá đăng ký lớp học (Class quote) kết hợp điều kiện gói hội viên (Membership)
describe("One membership: class quote", () => {
  /**
   * Làm gì: Kiểm tra khi người dùng chưa có gói hội viên yêu cầu báo giá lớp học:
   * hệ thống trả về eligible = false (không đủ điều kiện) và tuyệt đối không giữ chỗ (hold) trong database.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu quote cho phép ghi danh hoặc phát sinh bản ghi giữ chỗ
   */
  it("MB-quote: with no membership the quote refuses, and holds no seat", async () => {
    // Bước 1: Tạo lớp học có phí (300.000 VNĐ) và người dùng thường chưa đăng ký gói tập
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const m = await seedPlainUser(90);
    // Bước 2: Gọi API báo giá đăng ký lớp học (/v1/classes/:id/quote)
    const res = await withTx((sql) =>
      classQuote(sql, classId, new Request(`http://localhost/v1/classes/${classId}/quote`), m),
    );
    const q = (res as any).body;
    // Bước 3: Xác minh người dùng không đủ điều kiện (eligible=false) và không tạo bản ghi enrollments giữ chỗ
    assert.equal(q.eligible, false);
    assert.equal(q.total_vnd, 300000);
    const held = await db.query("select 1 from enrollments where class_id = $1", [classId]);
    assert.equal(held.rows.length, 0);
  });
  /**
   * Làm gì: Kiểm tra khi hội viên có gói tập còn hạn dài hơn ngày kết thúc lớp học:
   * báo giá trả về eligible = true và tổng số tiền bằng đúng học phí của lớp.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu báo giá không hợp lệ hoặc sai số tiền
   */
  it("MB-covered: a membership past the class end can enrol and pays tuition only", async () => {
    // Bước 1: Tạo lớp học và hội viên có gói tập đang active (hạn 400 ngày)
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const m = await seedMember(91);
    // Bước 2: Lấy báo giá lớp học cho hội viên
    const res = await withTx((sql) =>
      classQuote(sql, classId, new Request(`http://localhost/v1/classes/${classId}/quote`), m),
    );
    const q = (res as any).body;
    // Bước 3: Xác nhận hội viên đủ điều kiện ghi danh và tổng tiền bằng đúng giá học phí
    assert.equal(q.eligible, true);
    assert.equal(q.total_vnd, 300000);
  });
  /**
   * Làm gì: Kiểm tra quy tắc nghiệp vụ BR-19: từ chối đăng ký lớp học nếu người dùng không có gói hội viên
   * có thời hạn kết thúc sau ngày kết thúc của lớp học, đồng thời không giữ chỗ.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu hệ thống không chặn lỗi BR-19 hoặc giữ chỗ sai quy định
   */
  it("MB-gate: enrolling without a membership that outlasts the class is refused", async () => {
    // Bước 1: Chuẩn bị lớp học có phí và người dùng chưa có gói hội viên
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const m = await seedPlainUser(92);
    // Bước 2: Thử ghi danh vào lớp học và xác minh hệ thống ném lỗi vi phạm quy tắc BR-19
    await assert.rejects(
      withTx((sql) => classesEnroll(sql, classId, new Request("http://localhost"), m)),
      (e: any) => e.extra?.br === "BR-19",
    );
    // Bước 3: Đảm bảo không có bản ghi giữ chỗ nào được lưu trong bảng enrollments
    const held = await db.query("select 1 from enrollments where class_id = $1", [classId]);
    assert.equal(held.rows.length, 0);
  });
  /**
   * Làm gì: Kiểm tra trường hợp biên của BR-19: gói hội viên hết hạn trùng đúng ngày kết thúc lớp học
   * vẫn bị từ chối (quy tắc yêu cầu hạn gói hội viên phải lớn hơn ngày kết thúc lớp).
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu hệ thống cho phép ghi danh khi hạn gói bằng hạn lớp
   */
  it("MB-gate-equal: a membership ending the same day as the class is refused", async () => {
    // Bước 1: Chuẩn bị lớp học và hội viên hợp lệ ban đầu
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const m = await seedMember(93);
    // Bước 2: Cập nhật ngày hết hạn gói tập của hội viên bằng chính xác ngày kết thúc lớp học
    const cl = await db.query<{ end_on: string }>("select end_on::text from classes where id = $1", [classId]);
    await db.query("update subscriptions set end_on = $2 where user_id = $1", [m.id, cl.rows[0].end_on]);
    // Bước 3: Thử ghi danh và xác nhận bị từ chối với mã lỗi BR-19
    await assert.rejects(
      withTx((sql) => classesEnroll(sql, classId, new Request("http://localhost"), m)),
      (e: any) => e.extra?.br === "BR-19",
    );
  });
});

// Suite kiểm tra schema và hàm thủ tục lưu trữ (stored functions) cho nghiệp vụ bán lớp học
describe("Sell classes: schema", () => {
  /**
   * Làm gì: Kiểm tra hàm cơ sở dữ liệu enrollment_hold: tạo bản ghi giữ chỗ có khóa giá (price_vnd),
   * gán thời hạn giữ chỗ 15 phút (hold_until) và tự động tăng sĩ số đã ghi danh (enrolled_count) của lớp.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu trạng thái, giá khóa, hạn giữ chỗ hoặc số lượng ghi danh không đúng
   */
  it("SC-schema-hold: enrollment_hold writes a priced, timed hold", async () => {
    // Bước 1: Tạo lớp học có học phí 300.000 VNĐ, sức chứa 1 chỗ và tạo hội viên m1
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const m1 = await seedMember(1);
    // Bước 2: Gọi trực tiếp stored function enrollment_hold trong DB để giữ chỗ 15 phút với giá 300.000 VNĐ
    const r = await db.query<{ id: string }>("select enrollment_hold($1,$2,15,300000) as id", [classId, m1.id]);
    // Bước 3: Truy vấn bản ghi enrollment vừa tạo để kiểm tra trạng thái hold, giá tiền và thời hạn
    const row = (
      await db.query<{ status: string; price_vnd: number; ok: boolean }>(
        `select status, price_vnd,
                hold_until between now() + interval '14 minutes' and now() + interval '16 minutes' as ok
           from enrollments where id = $1`,
        [r.rows[0].id],
      )
    ).rows[0];
    assert.equal(row.status, "hold");
    assert.equal(row.price_vnd, 300000);
    assert.equal(row.ok, true);
    // Bước 4: Kiểm tra sĩ số lớp học đã được cộng thêm 1 người giữ chỗ
    const cnt = (await db.query<{ enrolled_count: number }>("select enrolled_count from classes where id = $1", [classId])).rows[0];
    assert.equal(cnt.enrolled_count, 1);
  });

  /**
   * Làm gì: Kiểm tra các lỗi nghiệp vụ ở tầng cơ sở dữ liệu khi giữ chỗ hoặc vào danh sách chờ:
   * chặn giữ chỗ trùng lặp (ALREADY_ENROLLED), chặn giữ chỗ khi lớp đã đầy (CLASS_FULL),
   * chặn người đã giữ chỗ đăng ký vào waitlist, và xác minh cấu hình mặc định thời gian giữ chỗ là 15 phút.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu DB không ném đúng mã lỗi hoặc thời gian giữ chỗ cấu hình sai
   */
  it("SC-schema-errors: duplicate hold, full class and the default hold setting", async () => {
    // Bước 1: Tạo lớp học sức chứa 1 người và 2 hội viên m1, m2
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const m1 = await seedMember(1);
    const m2 = await seedMember(2);
    // Bước 2: Hội viên m1 giữ chỗ thành công chỗ duy nhất của lớp
    await db.query("select enrollment_hold($1,$2,15,300000)", [classId, m1.id]);
    // Bước 3: Kiểm tra m1 không thể giữ chỗ lần hai (ném lỗi ALREADY_ENROLLED)
    await assert.rejects(
      () => db.query("select enrollment_hold($1,$2,15,300000)", [classId, m1.id]),
      /ALREADY_ENROLLED/,
    );
    // Bước 4: Kiểm tra m2 không thể giữ chỗ vì lớp đã hết chỗ (ném lỗi CLASS_FULL)
    await assert.rejects(
      () => db.query("select enrollment_hold($1,$2,15,300000)", [classId, m2.id]),
      /CLASS_FULL/,
    );
    // Bước 5: Kiểm tra m1 đã có chỗ thì không được phép đăng ký vào danh sách chờ (waitlist)
    await assert.rejects(
      () => db.query("select enrollment_waitlist($1,$2)", [classId, m1.id]),
      /ALREADY_ENROLLED/,
    );
    // Bước 6: Kiểm tra cấu hình hệ thống: thời gian giữ chỗ lớp học mặc định là 15 phút
    const { getSettings } = await import("./helpers.ts");
    const s = await withTx((sql) => getSettings(sql));
    assert.equal(s.class_hold_minutes, 15);
  });
});

// Suite kiểm tra quy trình ghi danh lớp học (classesEnroll) và các quy tắc giữ chỗ, định giá
describe("Sell classes: enrol", () => {
  /**
   * Làm gì: Tạo Request HTTP giả lập gửi body định dạng JSON với phương thức chỉ định.
   * Được gọi ở: Các ca kiểm thử trong suite Sell classes: enrol
   * @param method Phương thức HTTP (POST, PATCH, v.v.)
   * @param body Dữ liệu payload gửi kèm trong body
   * @returns Đối tượng Request HTTP
   */
  const jsonReq = (method: string, body: unknown) =>
    new Request("http://localhost", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  /**
   * Làm gì: Thực thi handler classesEnroll ghi danh người dùng vào lớp học trong một database transaction.
   * Được gọi ở: Các ca kiểm thử đăng ký lớp học trong suite Sell classes: enrol
   * @param classId ID của lớp học cần ghi danh
   * @param m Đối tượng người dùng thực hiện ghi danh
   * @returns Kết quả HTTP response từ handler classesEnroll
   */
  const enrol = (classId: string, m: any) =>
    withTx((sql) => classesEnroll(sql, classId, new Request("http://localhost"), m));
  // Định nghĩa đối tượng quản lý mẫu (manager) phục vụ các thao tác cấu hình lớp học
  const mgr = { id: "00000000-0000-0000-0000-000000000001", role: "manager" } as any;

  /**
   * Làm gì: Kiểm tra luồng ghi danh lớp học có thu phí: hệ thống tạo bản ghi giữ chỗ (status='hold'),
   * khóa giá tiền tại thời điểm giữ chỗ, sinh thời hạn hold_until và tăng sĩ số lớp.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu trạng thái không phải 201 hoặc dữ liệu giữ chỗ không chính xác
   */
  it("SC-enrol-hold: a priced class holds a seat with the price locked, no plan needed", async () => {
    // Bước 1: Tạo lớp học có giá 300.000 VNĐ, sức chứa 5 chỗ và tạo hội viên
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(10);
    // Bước 2: Ghi danh vào lớp học và xác nhận mã HTTP 201 Created
    const res = await enrol(classId, m);
    assert.equal(res.status, 201);
    // Bước 3: Xác minh trạng thái giữ chỗ (hold), giá tiền khóa cứng và có hạn thanh toán hold_until
    const e = (res.body as any).enrollment;
    assert.equal(e.status, "hold");
    assert.equal(e.price_vnd, 300000);
    assert.ok(e.hold_until);
    // Bước 4: Kiểm tra sĩ số lớp học tăng lên 1
    const c = (await db.query<{ enrolled_count: number }>("select enrolled_count from classes where id = $1", [classId])).rows[0];
    assert.equal(c.enrolled_count, 1);
  });

  /**
   * Làm gì: Kiểm tra quy tắc nghiệp vụ BR-53: lớp học chưa thiết lập giá (price_vnd là null)
   * không được phép mở bán và hệ thống từ chối mọi yêu cầu ghi danh.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu hệ thống không chặn lỗi vi phạm quy tắc BR-53
   */
  it("SC-enrol-unpriced: a class with no price is not open for sale (BR-53)", async () => {
    // Bước 1: Tạo lớp học chưa cấu hình giá (price = null)
    const classId = await seedClass({ price: null, capacity: 5 });
    const m = await seedMember(11);
    // Bước 2: Thử ghi danh và xác nhận bị từ chối với mã lỗi BR-53
    await assert.rejects(() => enrol(classId, m), (e: any) => e.extra?.br === "BR-53");
  });

  /**
   * Làm gì: Kiểm tra lớp học miễn phí (price = 0): xác nhận ngay lập tức (status='confirmed'),
   * không có thời hạn giữ chỗ (hold_until = null) và không tạo bản ghi thanh toán trong bảng payments.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu lớp miễn phí không được xác nhận ngay hoặc phát sinh payment thừa
   */
  it("SC-enrol-free: a free class confirms at once with no payment row", async () => {
    // Bước 1: Tạo lớp học miễn phí (giá 0 VNĐ)
    const classId = await seedClass({ price: 0, capacity: 5 });
    const m = await seedMember(12);
    // Bước 2: Thực hiện ghi danh cho hội viên
    const res = await enrol(classId, m);
    // Bước 3: Xác minh ghi danh được xác nhận trực tiếp mà không cần thanh toán (status='confirmed', hold_until=null)
    const e = (res.body as any).enrollment;
    assert.equal(e.status, "confirmed");
    assert.equal(e.hold_until, null);
    // Bước 4: Đảm bảo không có bản ghi thanh toán nào được tạo trong bảng payments
    const p = await db.query("select 1 from payments where ref_id = $1", [e.id]);
    assert.equal(p.rows.length, 0);
  });

  /**
   * Làm gì: Kiểm tra khi lớp học chỉ có 1 chỗ và đã có người giữ chỗ:
   * người thứ hai đăng ký sẽ tự động chuyển vào danh sách chờ (status='waitlisted').
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu người thứ nhất không được giữ chỗ hoặc người thứ hai không vào waitlist
   */
  it("SC-enrol-full: the second member on a one-seat class is waitlisted", async () => {
    // Bước 1: Tạo lớp học chỉ có sức chứa 1 chỗ và 2 hội viên m1, m2
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const m1 = await seedMember(13);
    const m2 = await seedMember(14);
    // Bước 2: Người thứ nhất ghi danh nhận trạng thái hold, người thứ hai ghi danh vào waitlisted
    assert.equal(((await enrol(classId, m1)).body as any).enrollment.status, "hold");
    assert.equal(((await enrol(classId, m2)).body as any).enrollment.status, "waitlisted");
  });

  /**
   * Làm gì: Kiểm tra quy tắc nghiệp vụ BR-22: một lớp đang ở trạng thái giữ chỗ (hold)
   * sẽ chặn hội viên đăng ký một lớp học khác có cùng khung giờ hàng tuần (clashes).
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu hệ thống không phát hiện và chặn trùng lịch học (BR-22)
   */
  it("SC-clash-hold: a held class blocks another class in the same weekly slot", async () => {
    // Bước 1: Tạo 2 lớp học trên 2 sân khác nhau nhưng trùng khung giờ hàng tuần (thứ 2, 21h)
    const slot = "FREQ=WEEKLY;BYDAY=MO;BYHOUR=21";
    const a = await seedClass({ price: 100000, capacity: 5, slot });
    const b = await seedClass({ price: 100000, capacity: 5, slot, courtId: "10000000-0000-0000-0000-000000000002" });
    // Bước 2: Hội viên ghi danh giữ chỗ lớp thứ nhất thành công
    const m = await seedMember(15);
    await enrol(a, m);
    // Bước 3: Hội viên cố gắng ghi danh lớp thứ hai và bị từ chối do xung đột lịch học (BR-22)
    await assert.rejects(() => enrol(b, m), (e: any) => e.extra?.br === "BR-22" && /clashes/.test(e.message));
  });

  /**
   * Làm gì: Kiểm tra tính năng cập nhật giá lớp học của quản lý (classesPatch):
   * chặn các giá trị giá không hợp lệ (số âm, chuỗi, số thập phân, vượt trần),
   * và đảm bảo những người đã giữ chỗ trước đó vẫn giữ nguyên mức giá cũ đã khóa.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu kiểm tra validation giá hoặc bảo toàn giá khóa bị sai
   */
  it("SC-price-patch: a manager sets the price; bad values are field errors; holds keep their price", async () => {
    // Bước 1: Tạo lớp học giá 300.000 VNĐ và hội viên ghi danh giữ chỗ lớp này
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(16);
    const held = (await enrol(classId, m)).body as any;
    /**
     * Làm gì: Gửi yêu cầu PATCH để cập nhật học phí của lớp học dưới quyền manager.
     * Được gọi ở: test "SC-price-patch"
     * @param price Mức giá mới cần thiết lập
     * @returns Kết quả thực thi handler classesPatch
     */
    const patch = (price: unknown) =>
      withTx((sql) => classesPatch(sql, classId, jsonReq("PATCH", { price_vnd: price }), mgr));
    // Bước 2: Quản lý hạ giá lớp xuống 250.000 VNĐ và xác minh giá lớp đã đổi trong DB
    await patch(250000);
    const row = (await db.query<{ price_vnd: number }>("select price_vnd from classes where id = $1", [classId])).rows[0];
    assert.equal(row.price_vnd, 250000);
    // Bước 3: Thử nghiệm các giá trị không hợp lệ (âm, chữ, số thập phân, vượt quá 100 triệu) -> phải báo lỗi trường price_vnd
    for (const bad of [-1, "abc", 1.5, 100_000_001]) {
      await assert.rejects(() => patch(bad), (e: any) => e.extra?.field === "price_vnd");
    }
    // Bước 4: Hủy thiết lập giá (set về null) và xác minh bản ghi đã giữ chỗ vẫn bảo lưu nguyên giá cũ 300.000 VNĐ
    await patch(null);
    const e = (await db.query<{ price_vnd: number }>("select price_vnd from enrollments where id = $1", [held.enrollment.id])).rows[0];
    assert.equal(e.price_vnd, 300000);
  });

  /**
   * Làm gì: Kiểm tra API danh sách lớp học (/v1/classes): trường my_enrollment chỉ hiển thị
   * thông tin ghi danh cho chính người đang giữ chỗ, trả về null đối với người khác hoặc khách vãng lai.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu trường my_enrollment bị lộ cho người dùng khác
   */
  it("SC-list-mine: classesList shows my_enrollment for the holder only", async () => {
    // Bước 1: Import handler classesList để kiểm tra dữ liệu trả về theo từng vai trò người gọi
    const { classesList } = await import("./handlers/classes.ts");
    // Bước 2: Tạo lớp học giá 300.000 VNĐ, hội viên m ghi danh giữ chỗ
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(17);
    const other = await seedMember(18);
    await enrol(classId, m);
    /**
     * Làm gì: Truy vấn danh sách lớp học với tư cách người dùng u và tìm kiếm thông tin của lớp học hiện tại.
     * Được gọi ở: test "SC-list-mine"
     * @param u Người dùng gọi API (hội viên giữ chỗ, hội viên khác, hoặc khách vãng lai null)
     * @returns Dữ liệu lớp học kèm trường my_enrollment tương ứng
     */
    const find = async (u: any) => {
      const r = await withTx((sql) => classesList(sql, new Request("http://localhost/v1/classes"), u));
      return (r.body as any).items.find((c: any) => c.id === classId);
    };
    // Bước 3: Người giữ chỗ thấy thông tin ghi danh của mình (status='hold')
    const mine = await find(m);
    assert.equal(mine.price_vnd, 300000);
    assert.equal(mine.my_enrollment.status, "hold");
    // Bước 4: Người khác hoặc khách chưa đăng nhập (null) thấy my_enrollment là null
    assert.equal((await find(other)).my_enrollment, null);
    assert.equal((await find(null)).my_enrollment, null);
  });
});

// Suite kiểm tra các phương thức thanh toán lớp học: chuyển khoản, tiền mặt tại quầy, đối soát và xử lý thanh toán muộn
describe("Sell classes: pay", () => {
  /**
   * Làm gì: Tạo Request HTTP giả lập mang payload JSON cho các bài test thanh toán.
   * Được gọi ở: Các ca kiểm thử trong suite Sell classes: pay
   * @param method Phương thức HTTP
   * @param body Dữ liệu body dạng JSON
   * @returns Đối tượng Request HTTP
   */
  const jsonReq = (method: string, body: unknown) =>
    new Request("http://localhost", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  /**
   * Làm gì: Thực hiện đăng ký giữ chỗ lớp học cho hội viên m trong transaction.
   * Được gọi ở: Các ca kiểm thử trong suite Sell classes: pay
   * @param classId ID lớp học cần ghi danh
   * @param m Đối tượng hội viên ghi danh
   * @returns Promise kết quả ghi danh từ classesEnroll
   */
  const enrol = (classId: string, m: any) =>
    withTx((sql) => classesEnroll(sql, classId, new Request("http://localhost"), m));
  // Định nghĩa tài khoản nhân viên quản lý (manager) thực hiện thu tiền tại quầy
  const mgr = { id: "00000000-0000-0000-0000-000000000001", role: "manager", full_name: "Quan ly" } as any;
  /**
   * Làm gì: Hàm tiện ích thực hiện ghi danh giữ chỗ và trích xuất lấy ID của bản ghi enrollment.
   * Được gọi ở: Các ca kiểm thử thanh toán trong suite Sell classes: pay
   * @param classId ID lớp học
   * @param m Hội viên đăng ký
   * @returns Promise chứa chuỗi ID của bản ghi enrollment vừa giữ chỗ
   */
  const holdFor = async (classId: string, m: any) => ((await enrol(classId, m)).body as any).enrollment.id as string;
  /**
   * Làm gì: Giả lập thanh toán tiền mặt tại quầy thu ngân (paymentsCreate) cho một bản ghi ghi danh lớp học.
   * Được gọi ở: Các ca kiểm thử thanh toán tại quầy trong suite Sell classes: pay
   * @param enrollmentId ID bản ghi ghi danh cần thanh toán
   * @param amount Số tiền thanh toán (VNĐ)
   * @returns Promise kết quả tạo bản ghi thanh toán từ handler paymentsCreate
   */
  const payDesk = (enrollmentId: string, amount: number) =>
    withTx((sql) =>
      paymentsCreate(sql, jsonReq("POST", { ref_type: "enrollment", ref_id: enrollmentId, method: "cash", amount_vnd: amount }), mgr),
    );

  /**
   * Làm gì: Kiểm tra yêu cầu chuyển khoản ngân hàng (enrollmentTransfer):
   * gia hạn thời gian giữ chỗ thêm 120 phút (2 giờ) và đưa khoản thanh toán vào danh sách chờ duyệt tại quầy thu ngân.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu thời hạn giữ chỗ không được gia hạn hoặc không xuất hiện trong danh sách chờ
   */
  it("SC-transfer: a transfer request extends the hold and shows on the desk list", async () => {
    // Bước 1: Import các handler yêu cầu chuyển khoản và danh sách chờ thanh toán tại quầy
    const { enrollmentTransfer } = await import("./handlers/classes.ts");
    const { paymentsPending } = await import("./handlers/desk.ts");
    // Bước 2: Tạo lớp học và thực hiện giữ chỗ cho hội viên
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(20);
    const id = await holdFor(classId, m);
    // Bước 3: Hội viên gửi yêu cầu thanh toán chuyển khoản ngân hàng qua enrollmentTransfer
    const res = await withTx((sql) => enrollmentTransfer(sql, id, m));
    assert.equal(res.status, 200);
    // Bước 4: Kiểm tra thời hạn hold_until được gia hạn thêm khoảng 120 phút và ghi nhận thời điểm transfer_requested_at
    const row = (
      await db.query<{ ok: boolean; req: string | null }>(
        `select hold_until between now() + interval '119 minutes' and now() + interval '121 minutes' as ok,
                transfer_requested_at as req from enrollments where id = $1`,
        [id],
      )
    ).rows[0];
    assert.equal(row.ok, true);
    assert.ok(row.req);
    // Bước 5: Kiểm tra khoản chờ thanh toán xuất hiện trong danh sách chờ duyệt của thu ngân (/v1/payments/pending)
    const pend = await withTx((sql) => paymentsPending(sql, new Request("http://localhost/v1/payments/pending"), mgr));
    const hit = (pend.body as any).awaiting.find((r: any) => r.kind === "enrollment" && r.id === id);
    assert.ok(hit);
    assert.equal(hit.amount_vnd, 300000);
  });

  /**
   * Làm gì: Kiểm tra thanh toán tiền mặt tại quầy: xác nhận chỗ học (status='confirmed', xóa hold_until),
   * ghi nhận bản ghi thanh toán (payments) ở trạng thái posted, và tự động xuất hóa đơn (invoices + invoice_lines).
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu chỗ học không được xác nhận, thiếu payment hoặc thiếu dòng hóa đơn
   */
  it("SC-desk-pay: cash at the desk confirms the seat, posts a payment, issues an invoice", async () => {
    // Bước 1: Tạo lớp học, giữ chỗ cho hội viên và thanh toán tiền mặt 300.000 VNĐ tại quầy
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(21);
    const id = await holdFor(classId, m);
    await payDesk(id, 300000);
    // Bước 2: Kiểm tra bản ghi enrollments đã được xác nhận (confirmed) và xóa thời hạn giữ chỗ (hold_until = null)
    const e = (await db.query<{ status: string; hold_until: string | null }>("select status, hold_until from enrollments where id = $1", [id])).rows[0];
    assert.equal(e.status, "confirmed");
    assert.equal(e.hold_until, null);
    // Bước 3: Kiểm tra bản ghi payments được tạo với ref_type='enrollment' và trạng thái 'posted'
    const pays = await db.query<{ id: string }>("select id from payments where ref_type = 'enrollment' and ref_id = $1 and status = 'posted'", [id]);
    assert.equal(pays.rows.length, 1);
    // Bước 4: Kiểm tra hóa đơn và chi tiết hóa đơn (invoice_lines) tự động phát hành đúng nội dung lớp học
    const lines = await db.query<{ description: string }>(
      `select il.description from invoice_lines il join invoices i on i.id = il.invoice_id where i.payment_id = $1`,
      [pays.rows[0].id],
    );
    assert.equal(lines.rows.length, 1);
    assert.ok(lines.rows[0].description.startsWith("Khoá badminton"));
  });

  /**
   * Làm gì: Kiểm tra tính idempotent của hàm quyết toán thanh toán (settleEnrollment):
   * quyết toán lần 1 trả về outcome='confirmed', quyết toán lần 2 trả về outcome='already' mà không tăng thừa sĩ số lớp.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu quyết toán lần 2 bị lỗi hoặc làm sai lệch sĩ số lớp
   */
  it("SC-settle-idempotent: settling twice confirms once and keeps the count", async () => {
    // Bước 1: Import hàm quyết toán thanh toán ghi danh lớp học
    const { settleEnrollment } = await import("./handlers/classes.ts");
    // Bước 2: Tạo lớp học và giữ chỗ cho hội viên
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(22);
    const id = await holdFor(classId, m);
    // Bước 3: Quyết toán lần 1 xác nhận thành công (confirmed); quyết toán lần 2 trả về đã xử lý (already)
    assert.equal((await withTx((sql) => settleEnrollment(sql, id))).outcome, "confirmed");
    assert.equal((await withTx((sql) => settleEnrollment(sql, id))).outcome, "already");
    // Bước 4: Xác nhận sĩ số lớp học vẫn giữ nguyên là 1, không bị tăng trùng
    const c = (await db.query<{ enrolled_count: number }>("select enrolled_count from classes where id = $1", [classId])).rows[0];
    assert.equal(c.enrolled_count, 1);
  });

  /**
   * Làm gì: Xử lý tình huống thanh toán muộn khi chỗ đã bị người khác lấy mất:
   * tiền được ghi nhận nhưng hội viên không được vào lớp (outcome='late_no_seat'), ghi log kiểm toán để quản lý hoàn tiền.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu người thanh toán muộn vẫn chiếm chỗ hoặc không ghi audit log
   */
  it("SC-settle-late-full: money for an expired hold whose seat was retaken is flagged, not seated", async () => {
    // Bước 1: Import hàm settleEnrollment
    const { settleEnrollment } = await import("./handlers/classes.ts");
    // Bước 2: Tạo lớp học 1 chỗ và 2 hội viên m1, m2; m1 giữ chỗ ban đầu
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const m1 = await seedMember(23);
    const m2 = await seedMember(24);
    // Lấy ID bản ghi giữ chỗ của hội viên m1
    const id1 = await holdFor(classId, m1);
    // Bước 3: Giả lập ca quét hết hạn: m1 hết hạn giữ chỗ và bị hủy, chỗ trống được trả lại cho lớp
    // Stand-in for the expiry sweep (Task 5): the hold lapses and gives its seat back.
    await db.query("update enrollments set hold_until = now() - interval '1 minute' where id = $1", [id1]);
    await db.query("update enrollments set status = 'cancelled' where id = $1", [id1]);
    await db.query("update classes set enrolled_count = enrolled_count - 1 where id = $1", [classId]);
    // Bước 4: Hội viên m2 nhanh tay giữ chỗ trống duy nhất của lớp
    const id2 = await holdFor(classId, m2);
    assert.equal((await db.query<{ status: string }>("select status from enrollments where id = $1", [id2])).rows[0].status, "hold");
    // Bước 5: Quyết toán khoản tiền đến muộn của m1 -> kết quả late_no_seat vì lớp đã đầy
    const res = await withTx((sql) => settleEnrollment(sql, id1));
    assert.equal(res.outcome, "late_no_seat");
    // Bước 6: Xác nhận sĩ số lớp vẫn là 1 và hệ thống ghi log kiểm toán 'enrollment_paid_no_seat' để hoàn tiền
    const c = (await db.query<{ enrolled_count: number }>("select enrolled_count from classes where id = $1", [classId])).rows[0];
    assert.equal(c.enrolled_count, 1);
    const a = await db.query("select 1 from audit_logs where action = 'enrollment_paid_no_seat' and entity_id = $1", [id1]);
    assert.equal(a.rows.length, 1);
  });

  /**
   * Làm gì: Xử lý tình huống thanh toán muộn nhưng lớp học vẫn còn chỗ trống:
   * hệ thống phục hồi giữ chỗ và xác nhận vào lớp cho hội viên (outcome='late_confirmed').
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu hội viên không được chấp nhận vào lớp khi vẫn còn chỗ
   */
  it("SC-late-confirmed: money for an expired hold with a free seat still seats the member", async () => {
    // Bước 1: Import hàm settleEnrollment
    const { settleEnrollment } = await import("./handlers/classes.ts");
    // Bước 2: Tạo lớp học sức chứa 2 chỗ, hội viên giữ chỗ ban đầu
    const classId = await seedClass({ price: 300000, capacity: 2 });
    const m = await seedMember(25);
    const id = await holdFor(classId, m);
    // Bước 3: Giả lập hết hạn giữ chỗ và trả lại chỗ trống về cho lớp học
    await db.query("update enrollments set status = 'cancelled' where id = $1", [id]);
    await db.query("update classes set enrolled_count = enrolled_count - 1 where id = $1", [classId]);
    // Bước 4: Tiền thanh toán muộn về tới khi lớp còn chỗ trống -> quyết toán thành công với kết quả late_confirmed
    assert.equal((await withTx((sql) => settleEnrollment(sql, id))).outcome, "late_confirmed");
    // Bước 5: Sĩ số lớp học được cộng lại chính xác thành 1 học viên
    const c = (await db.query<{ enrolled_count: number }>("select enrolled_count from classes where id = $1", [classId])).rows[0];
    assert.equal(c.enrolled_count, 1);
  });

  /**
   * Làm gì: Kiểm tra nguyên tắc bảo toàn giá: thu ngân bắt buộc phải thu đúng mức giá đã khóa
   * tại thời điểm hội viên bấm giữ chỗ, kể cả khi quản lý đã thay đổi giá lớp học sau đó.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu thu ngân thu được theo giá mới đã đổi hoặc không thu được giá cũ
   */
  it("SC-locked-price: the desk must take the price locked at hold time", async () => {
    // Bước 1: Tạo lớp học giá 300.000 VNĐ và hội viên thực hiện giữ chỗ (khóa giá 300.000 VNĐ)
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(26);
    const id = await holdFor(classId, m);
    // Bước 2: Quản lý đổi giá lớp học thành 250.000 VNĐ
    await withTx((sql) => classesPatch(sql, classId, jsonReq("PATCH", { price_vnd: 250000 }), mgr));
    // Bước 3: Thu ngân thu theo giá mới 250.000 VNĐ bị từ chối; phải thu đúng mức giá đã khóa 300.000 VNĐ
    await assert.rejects(() => payDesk(id, 250000), (e: any) => e.extra?.field === "amount_vnd");
    await payDesk(id, 300000);
  });

  /**
   * Làm gì: Kiểm tra quy tắc đối soát số tiền: thanh toán tại quầy phải khớp chính xác từng đồng
   * với giá trị giữ chỗ; sai lệch dù chỉ 1 đồng cũng bị từ chối và không ghi nhận thanh toán.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu hệ thống chấp nhận số tiền không khớp hoặc thay đổi trạng thái giữ chỗ
   */
  it("SC-amount-mismatch: a desk payment for a seat must equal its price to the đồng, or nothing is posted", async () => {
    // Bước 1: Tạo lớp học và giữ chỗ với mức giá 300.000 VNĐ
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(29);
    const id = await holdFor(classId, m);
    // Bước 2: Thử thanh toán với các mức tiền sai lệch (1 VNĐ, 299.999 VNĐ, 300.001 VNĐ) -> đều bị từ chối
    for (const wrong of [1, 299999, 300001]) {
      await assert.rejects(() => payDesk(id, wrong), (e: any) => e.extra?.field === "amount_vnd");
    }
    // Bước 3: Đảm bảo không có bản ghi thanh toán nào được ghi và trạng thái giữ chỗ vẫn nguyên vẹn
    const posted = await db.query("select 1 from payments where ref_type = 'enrollment' and ref_id = $1", [id]);
    assert.equal(posted.rows.length, 0);
    assert.equal((await db.query<{ status: string }>("select status from enrollments where id = $1", [id])).rows[0].status, "hold");
    // Bước 4: Thanh toán đúng chính xác 300.000 VNĐ thành công
    await payDesk(id, 300000);
  });

  /**
   * Làm gì: Kiểm tra chống spam yêu cầu chuyển khoản: hội viên không thể gửi yêu cầu chuyển khoản
   * lần thứ hai cho cùng một bản ghi giữ chỗ (trả về lỗi 409 Conflict) và thời hạn giữ chỗ không bị đổi.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu hệ thống cho phép gia hạn giữ chỗ nhiều lần bằng cách spam request
   */
  it("SC-transfer-repeat: a second transfer request is refused and the hold is unchanged", async () => {
    // Bước 1: Import hàm enrollmentTransfer
    const { enrollmentTransfer } = await import("./handlers/classes.ts");
    // Bước 2: Giữ chỗ lớp học và gửi yêu cầu chuyển khoản lần thứ nhất thành công
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(28);
    const id = await holdFor(classId, m);
    await withTx((sql) => enrollmentTransfer(sql, id, m));
    // Bước 3: Gửi yêu cầu chuyển khoản lần thứ hai bị từ chối với mã 409 Conflict; thời hạn hold_until không đổi
    const before = (await db.query<{ h: string }>("select hold_until::text as h from enrollments where id = $1", [id])).rows[0].h;
    await assert.rejects(() => withTx((sql) => enrollmentTransfer(sql, id, m)), (e: any) => e.status === 409);
    const after = (await db.query<{ h: string }>("select hold_until::text as h from enrollments where id = $1", [id])).rows[0].h;
    assert.equal(after, before);
  });

  /**
   * Làm gì: Kiểm tra quy tắc nghiệp vụ BR-28: bản ghi giữ chỗ đã hết hạn không được phép
   * gửi yêu cầu thanh toán chuyển khoản ngân hàng.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu hệ thống cho phép chuyển khoản cho giữ chỗ đã quá hạn
   */
  it("SC-expired-transfer: a lapsed hold cannot ask for a transfer (BR-28)", async () => {
    // Bước 1: Import hàm enrollmentTransfer
    const { enrollmentTransfer } = await import("./handlers/classes.ts");
    // Bước 2: Tạo lớp học và thực hiện giữ chỗ
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(27);
    const id = await holdFor(classId, m);
    // Bước 3: Cập nhật thời hạn giữ chỗ lùi về quá khứ để giả lập đã hết hạn
    await db.query("update enrollments set hold_until = now() - interval '1 minute' where id = $1", [id]);
    // Bước 4: Yêu cầu chuyển khoản bị từ chối theo đúng quy tắc nghiệp vụ BR-28
    await assert.rejects(() => withTx((sql) => enrollmentTransfer(sql, id, m)), (e: any) => e.extra?.br === "BR-28");
  });
});

/**
 * Làm gì: Giả lập thanh toán thành công: chuyển trạng thái ghi danh sang confirmed và xóa thời hạn hold_until.
 * Được gọi ở: Các ca kiểm thử thanh toán trực tuyến trong tx.test.ts
 * @param enrollmentId ID bản ghi ghi danh lớp học cần xác nhận
 * @returns Promise<void>
 */
/** Stands in for a confirmed payment: turns a held seat into a confirmed one. */
async function confirmHold(enrollmentId: string) {
  // Cập nhật trạng thái enrollment thành confirmed và xóa thời hạn giữ chỗ
  await db.query("update enrollments set status = 'confirmed', hold_until = null where id = $1", [enrollmentId]);
}

// Suite kiểm tra thanh toán trực tuyến cổng thanh toán (PayOS / VietQR) cho việc ghi danh lớp học
describe("Sell classes: online", () => {
  /**
   * Làm gì: Đăng ký giữ chỗ lớp học cho người dùng m trong transaction.
   * Được gọi ở: Các ca kiểm thử trong suite Sell classes: online
   * @param classId ID lớp học
   * @param m Đối tượng người dùng ghi danh
   * @returns Kết quả trả về từ classesEnroll
   */
  const enrol = (classId: string, m: any) =>
    withTx((sql) => classesEnroll(sql, classId, new Request("http://localhost"), m));
  // Định nghĩa tài khoản nhân viên quản lý (manager) mẫu
  const mgr = { id: "00000000-0000-0000-0000-000000000001", role: "manager", full_name: "Quan ly" } as any;
  /**
   * Làm gì: Tiện ích đăng ký giữ chỗ và trả về trực tiếp enrollmentId.
   * Được gọi ở: Các ca kiểm thử trong suite Sell classes: online
   * @param classId ID lớp học
   * @param m Người dùng ghi danh
   * @returns ID bản ghi enrollment vừa giữ chỗ
   */
  const holdFor = async (classId: string, m: any) => ((await enrol(classId, m)).body as any).enrollment.id as string;
  /**
   * Làm gì: Gửi request tạo link thanh toán trực tuyến qua cổng PayOS cho bản ghi ghi danh lớp học (/v1/payments/online).
   * Được gọi ở: Các ca kiểm thử trong suite Sell classes: online
   * @param enrollmentId ID bản ghi ghi danh cần tạo link thanh toán
   * @param u Người dùng yêu cầu tạo link
   * @returns Kết quả HTTP response từ handler onlineCreate
   */
  const linkFor = (enrollmentId: string, u: any) =>
    withTx((sql) =>
      onlineCreate(
        sql,
        new Request("http://localhost/v1/payments/online", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ref_type: "enrollment", ref_id: enrollmentId }),
        }),
        u,
      ),
    );
  // Biến đếm tạo mã đơn hàng duy nhất cho mock tạo link thanh toán trực tuyến
  let orderSeq = 0;
  /**
   * Làm gì: Cài đặt mock function ghi đè logic tạo liên kết thanh toán payOS, trả về link giả lập với orderCode tăng dần.
   * Được gọi ở: các ca kiểm thử SC-online-* trong suite "Sell classes: online"
   * @returns void
   */
  const useMockLink = () =>
    setOverridePaymentLinkCreator(async (args) => {
      orderSeq += 1;
      return {
        orderCode: args.orderCode,
        checkoutUrl: `https://pay.mock/checkout/sc${orderSeq}`,
        qrCode: "data:image/png;base64,mock",
        paymentLinkId: `link_sc_${orderSeq}`,
        expiredAt: Math.floor(Date.now() / 1000) + 900,
      };
    });
  after(() => setOverridePaymentLinkCreator(null));

  /**
   * Làm gì: Kiểm tra luồng tạo liên kết thanh toán online cho suất giữ chỗ: chỉ chính chủ mới tạo được link với đúng giá đã khóa, người khác bị từ chối 403, và suất giữ chỗ quá hạn bị từ chối theo BR-28.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu quyền hạn hoặc số tiền thanh toán không khớp kỳ vọng
   */
  it("SC-online-create: owner links their hold at the locked price; others and lapsed holds are refused", async () => {
    // Bước 1: Kích hoạt mock link thanh toán, khởi tạo lớp học giá 300.000đ và 2 tài khoản hội viên (chính chủ và người khác).
    useMockLink();
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(40);
    const other = await seedMember(41);
    const id = await holdFor(classId, m);
    // Bước 2: Tạo suất giữ chỗ (hold); người khác cố tạo link thanh toán cho suất này phải bị chặn 403 Forbidden.
    await assert.rejects(() => linkFor(id, other), (e: any) => e.status === 403);
    // Bước 3: Chính chủ tạo link thanh toán thành công (201 Created); kiểm tra số tiền 300.000đ và user_id trong bảng payments.
    const res = await linkFor(id, m);
    assert.equal(res.status, 201);
    assert.equal((res.body as any).amount_vnd, 300000);
    const pay = (await db.query<{ amount_vnd: number; user_id: string }>("select amount_vnd, user_id from payments where id = $1", [(res.body as any).payment_id])).rows[0];
    assert.equal(pay.amount_vnd, 300000);
    assert.equal(pay.user_id, m.id);

    // Bước 4: Kiểm tra quy tắc BR-28: tạo suất giữ chỗ mới nhưng cập nhật hold_until về quá khứ; tạo link thanh toán phải bị từ chối.
    const m2 = await seedMember(42);
    const id2 = await holdFor(await seedClass({ price: 300000, capacity: 5 }), m2);
    await db.query("update enrollments set hold_until = now() - interval '1 minute' where id = $1", [id2]);
    await assert.rejects(() => linkFor(id2, m2), (e: any) => e.extra?.br === "BR-28");
  });

  /**
   * Làm gì: Kiểm tra background job expireOnlineLinks hủy liên kết thanh toán đang chờ (pending) khi suất giữ chỗ lớp học bị quá hạn.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu trạng thái thanh toán không chuyển từ pending sang expired
   */
  it("SC-online-expire: a pending link for a lapsed hold is cancelled by the job", async () => {
    // Bước 1: Chuẩn bị mock thanh toán, lớp học, hội viên và tạo suất giữ chỗ kèm link thanh toán online ở trạng thái pending.
    useMockLink();
    const { expireOnlineLinks } = await import("./handlers/online.ts");
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(43);
    const id = await holdFor(classId, m);
    const res = await linkFor(id, m);
    const payId = (res.body as any).payment_id as string;
    // Bước 2: Chạy expireOnlineLinks khi suất giữ chỗ còn hạn; trạng thái thanh toán vẫn phải là pending.
    await withTx((sql) => expireOnlineLinks(sql));
    let st = (await db.query<{ status: string }>("select status::text as status from payments where id = $1", [payId])).rows[0].status;
    assert.equal(st, "pending");
    // Bước 3: Cập nhật hold_until về quá khứ để giả lập suất giữ chỗ quá hạn, sau đó chạy lại job expireOnlineLinks.
    await db.query("update enrollments set hold_until = now() - interval '1 minute' where id = $1", [id]);
    await withTx((sql) => expireOnlineLinks(sql));
    // Bước 4: Xác minh thanh toán trong bảng payments đã được cập nhật thành expired.
    st = (await db.query<{ status: string }>("select status::text as status from payments where id = $1", [payId])).rows[0].status;
    assert.equal(st, "expired");
  });

  /**
   * Làm gì: Kiểm tra quyết toán (settle) thanh toán online: xác nhận ghi danh (confirmed), tạo duy nhất một hóa đơn, tăng sĩ số lớp và đảm bảo tính bất biến (idempotent) khi gọi lặp lại.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu ghi danh chưa xác nhận, hóa đơn bị trùng lặp hoặc sĩ số sai
   */
  it("SC-online-settle: a paid link confirms the seat, invoices once, and a repeat does nothing", async () => {
    // Bước 1: Khởi tạo lớp học, hội viên, tạo suất giữ chỗ và link thanh toán online.
    useMockLink();
    const { settleOnline } = await import("./handlers/online.ts");
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(44);
    const id = await holdFor(classId, m);
    const res = await linkFor(id, m);
    const payId = (res.body as any).payment_id as string;
    /**
     * Làm gì: Giả lập webhook hoặc callback quyết toán giao dịch bằng cách khóa dòng payment và gọi settleOnline.
     * Được gọi ở: test "SC-online-settle: a paid link confirms the seat, invoices once, and a repeat does nothing"
     * @returns Kết quả quyết toán từ settleOnline
     */
    const settle = () =>
      withTx(async (sql) => {
        const pay = await sql.query<any>(
          `select id, code, user_id, amount_vnd, status::text as status, ref_type, ref_id, provider_order_code from payments where id = $1 for update`,
          [payId],
        );
        return settleOnline(sql, pay[0], { amountPaid: 300000, transactionId: "TX-SC", providerStatus: "PAID" });
      });
    // Bước 2: Thực hiện quyết toán lần đầu và gọi lặp lại lần 2 để kiểm tra tính bất biến (idempotent); cả hai lần đều trả về posted: true.
    assert.equal((await settle()).posted, true);
    assert.equal((await settle()).posted, true);
    // Bước 3: Kiểm tra trạng thái enrollment chuyển sang confirmed và hóa đơn được xuất với mô tả bắt đầu bằng "Khoá badminton".
    const e = (await db.query<{ status: string }>("select status::text as status from enrollments where id = $1", [id])).rows[0];
    assert.equal(e.status, "confirmed");
    const invs = await db.query<{ description: string }>(
      `select il.description from invoice_lines il join invoices i on i.id = il.invoice_id where i.payment_id = $1`,
      [payId],
    );
    assert.equal(invs.rows.length, 1);
    assert.ok(invs.rows[0].description.startsWith("Khoá badminton"));
    // Bước 4: Kiểm tra sĩ số lớp học (enrolled_count) đã được tăng lên 1.
    const c = (await db.query<{ enrolled_count: number }>("select enrolled_count from classes where id = $1", [classId])).rows[0];
    assert.equal(c.enrolled_count, 1);
  });

  /**
   * Làm gì: Kiểm tra xử lý thanh toán về muộn (late payment) khi suất giữ chỗ đã bị hủy và người khác đã lấy chỗ: giao dịch vẫn ghi nhận posted và xuất hóa đơn phục vụ đối soát.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu giao dịch thanh toán không được posted hoặc hóa đơn không được tạo
   */
  it("SC-online-late: money for a retaken seat stays posted and is invoiced", async () => {
    // Bước 1: Tạo lớp học chỉ có 1 chỗ trống, học viên m1 đăng ký giữ chỗ và lấy link thanh toán.
    useMockLink();
    const { settleOnline } = await import("./handlers/online.ts");
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const m1 = await seedMember(45);
    const m2 = await seedMember(46);
    const id1 = await holdFor(classId, m1);
    const payId = ((await linkFor(id1, m1)).body as any).payment_id as string;
    // Bước 2: Giả lập suất giữ chỗ của m1 hết hạn và bị hủy; học viên m2 đăng ký lấy chỗ trống duy nhất đó.
    // Stand-in for the expiry sweep: the hold lapses, gives its seat back, another member takes it.
    await db.query("update enrollments set hold_until = now() - interval '1 minute', status = 'cancelled' where id = $1", [id1]);
    await db.query("update classes set enrolled_count = enrolled_count - 1 where id = $1", [classId]);
    await holdFor(classId, m2);
    // Bước 3: Khoản thanh toán của m1 về muộn; thực hiện quyết toán giao dịch qua settleOnline.
    const out = await withTx(async (sql) => {
      const pay = await sql.query<any>(
        `select id, code, user_id, amount_vnd, status::text as status, ref_type, ref_id, provider_order_code from payments where id = $1 for update`,
        [payId],
      );
      return settleOnline(sql, pay[0], { amountPaid: 300000, transactionId: "TX-LATE", providerStatus: "PAID" });
    });
    // Bước 4: Xác minh thanh toán vẫn thành công (status = 'posted') và hóa đơn đã được lập đầy đủ để nhân viên đối soát hoàn tiền.
    assert.equal(out.posted, true);
    const st = (await db.query<{ status: string }>("select status::text as status from payments where id = $1", [payId])).rows[0].status;
    assert.equal(st, "posted");
    const n = (await db.query("select 1 from invoices where payment_id = $1", [payId])).rows.length;
    assert.equal(n, 1);
  });
});

// Suite kiểm thử vòng đời đăng ký lớp học: danh sách chờ (waitlist), giữ chỗ (hold), hủy chỗ và hết hạn giữ chỗ.
describe("Sell classes: lifecycle", () => {
  /**
   * Làm gì: Gửi yêu cầu đăng ký tham gia lớp học dưới quyền của hội viên m qua API classesEnroll.
   * Được gọi ở: helper holdFor trong suite "Sell classes: lifecycle"
   * @param classId Mã ID của lớp học
   * @param m Thông tin hội viên thực hiện đăng ký
   * @returns Kết quả response từ classesEnroll
   */
  const enrol = (classId: string, m: any) =>
    withTx((sql) => classesEnroll(sql, classId, new Request("http://localhost"), m));
  /**
   * Làm gì: Đăng ký lớp học và trích xuất mã ID của bản ghi enrollment vừa tạo.
   * Được gọi ở: các test trong suite "Sell classes: lifecycle"
   * @param classId Mã ID của lớp học
   * @param m Thông tin hội viên
   * @returns Mã ID của enrollment
   */
  const holdFor = async (classId: string, m: any) => ((await enrol(classId, m)).body as any).enrollment.id as string;
  /**
   * Làm gì: Gửi yêu cầu hủy đăng ký hoặc rời danh sách chờ lớp học qua API enrollmentDelete.
   * Được gọi ở: các test SC-waitlist-*, SC-release, SC-leave-confirmed
   * @param enrollmentId Mã ID của enrollment cần hủy
   * @param m Thông tin hội viên thực hiện hủy
   * @returns Kết quả response từ enrollmentDelete
   */
  const leave = (enrollmentId: string, m: any) => withTx((sql) => enrollmentDelete(sql, enrollmentId, m));
  /**
   * Làm gì: Truy vấn trạng thái (status) hiện tại của bản ghi enrollment từ database.
   * Được gọi ở: các test trong suite "Sell classes: lifecycle"
   * @param enrollmentId Mã ID của enrollment
   * @returns Chuỗi trạng thái của enrollment (hold, waitlisted, confirmed, cancelled, v.v.)
   */
  const statusOf = async (enrollmentId: string) =>
    (await db.query<{ status: string }>("select status::text as status from enrollments where id = $1", [enrollmentId])).rows[0].status;
  /**
   * Làm gì: Truy vấn số lượng học viên đã ghi danh (enrolled_count) của một lớp học từ database.
   * Được gọi ở: các test trong suite "Sell classes: lifecycle"
   * @param classId Mã ID của lớp học
   * @returns Số lượng học viên đã ghi danh
   */
  const countOf = async (classId: string) =>
    (await db.query<{ n: number }>("select enrolled_count as n from classes where id = $1", [classId])).rows[0].n;
  /** A scheduled session starting in an hour, so the class is inside the cancel cutoff. */
  const soonSession = async (classId: string, courtId: string) => {
    // Tạo ca chiếm dụng sân (occupancy) và buổi học (session) bắt đầu sau 1 giờ để rơi vào khoảng thời gian cutoff hủy.
    const occ = (
      await db.query<{ id: string }>(
        `insert into occupancies (court_id, start_at, end_at, kind, ref_id)
         values ($1, now() + interval '1 hour', now() + interval '2 hours', 'session', $2) returning id`,
        [courtId, classId],
      )
    ).rows[0].id;
    await db.query(
      `insert into sessions (class_id, court_id, start_at, end_at, status, occupancy_id)
       values ($1, $2, now() + interval '1 hour', now() + interval '2 hours', 'scheduled', $3)`,
      [classId, courtId, occ],
    );
  };
  /**
   * Làm gì: Tạo bản ghi sân cầu lông mới ở trạng thái sẵn sàng (ready) nếu chưa tồn tại.
   * Được gọi ở: test SC-release, SC-leave-confirmed
   * @param id Mã UUID của sân
   * @returns Mã UUID của sân
   */
  const quietCourt = async (id: string) => {
    await db.query(
      `insert into courts (id, court_code, sport, status) values ($1, $2, 'badminton', 'ready') on conflict (id) do nothing`,
      [id, "LC-" + id.slice(-4)],
    );
    return id;
  };
  /**
   * Làm gì: Lấy bản ghi lời mời nhận chỗ (waitlist offer) đang chờ xử lý (pending) của một enrollment.
   * Được gọi ở: các test SC-waitlist-hold, SC-waitlist-hold-unpriced, SC-waitlist-left, SC-expire-job
   * @param enrollmentId Mã ID của enrollment
   * @returns Bản ghi offer chứa id hoặc undefined nếu không có
   */
  const pendingOffer = async (enrollmentId: string) =>
    (await db.query<{ id: string }>("select id from waitlist_offers where enrollment_id = $1 and status = 'pending'", [enrollmentId])).rows[0];

  /**
   * Làm gì: Kiểm tra luồng nhận suất từ danh sách chờ (waitlist offer): học viên trước rời lớp thì người kế tiếp nhận offer, chấp nhận offer sẽ chuyển sang hold với giá đã khóa mà không cần gói tập.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu trạng thái, giá tiền hoặc thời hạn giữ chỗ không chính xác
   */
  it("SC-waitlist-hold: accepting an offer takes a hold at the locked price, with no plan needed", async () => {
    // Bước 1: Khởi tạo lớp học sức chứa 1, học viên a giữ chỗ trước, học viên b đăng ký sau rơi vào waitlisted.
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const a = await seedMember(60);
    const b = await seedMember(61);
    const idA = await holdFor(classId, a);
    const idB = await holdFor(classId, b);
    assert.equal(await statusOf(idB), "waitlisted");
    // Bước 2: Học viên a rời lớp; kiểm tra hệ thống tự động phát sinh offer cho học viên b đang ở danh sách chờ.
    await leave(idA, a);
    const offer = await pendingOffer(idB);
    assert.ok(offer);
    // Bước 3: Học viên b chấp nhận lời mời (waitlistAccept) thành công (200 OK).
    const res = await withTx((sql) => waitlistAccept(sql, offer.id, b));
    assert.equal(res.status, 200);
    // Bước 4: Kiểm tra enrollment của b chuyển thành hold, đúng giá 300.000đ, thời gian hold_until đúng cài đặt và sĩ số lớp là 1.
    const holdMinutes = (await db.query<{ m: number }>("select class_hold_minutes as m from center_settings where id = 1")).rows[0].m;
    const row = (
      await db.query<{ status: string; price_vnd: number; ok: boolean; pos: number | null }>(
        `select status::text as status, price_vnd, waitlist_pos as pos,
                hold_until between now() + ($2::int - 1) * interval '1 minute' and now() + ($2::int + 1) * interval '1 minute' as ok
           from enrollments where id = $1`,
        [idB, holdMinutes],
      )
    ).rows[0];
    assert.equal(row.status, "hold");
    assert.equal(row.price_vnd, 300000);
    assert.equal(row.pos, null);
    assert.equal(row.ok, true);
    assert.equal(await countOf(classId), 1);
  });

  /**
   * Làm gì: Kiểm tra quy tắc nghiệp vụ BR-53: từ chối chấp nhận lời mời từ waitlist nếu lớp học đã bị xóa giá niêm yết (price_vnd = null).
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu không ném lỗi BR-53 hoặc trạng thái enrollment bị thay đổi
   */
  it("SC-waitlist-hold-unpriced: accepting an offer for a class that lost its price gives BR-53", async () => {
    // Bước 1: Tạo lớp học có giá, học viên a giữ chỗ, học viên b vào waitlist và được nhận offer khi a rời lớp.
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const a = await seedMember(62);
    const b = await seedMember(63);
    const idA = await holdFor(classId, a);
    const idB = await holdFor(classId, b);
    await leave(idA, a);
    const offer = await pendingOffer(idB);
    // Bước 2: Cập nhật giá lớp học về null để kiểm tra tình huống lớp không còn giá niêm yết.
    await db.query("update classes set price_vnd = null where id = $1", [classId]);
    // Bước 3: Học viên b chấp nhận offer phải bị từ chối với lỗi BR-53; trạng thái enrollment vẫn là waitlisted.
    await assert.rejects(() => withTx((sql) => waitlistAccept(sql, offer.id, b)), (e: any) => e.extra?.br === "BR-53");
    assert.equal(await statusOf(idB), "waitlisted");
  });

  /**
   * Làm gì: Kiểm tra trường hợp học viên đã hủy rời khỏi danh sách chờ (cancelled) thì không thể chấp nhận lời mời tham gia lớp học nữa.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu request không bị từ chối với mã HTTP 409 Conflict
   */
  it("SC-waitlist-left: accepting an offer after leaving the waitlist is refused", async () => {
    // Bước 1: Tạo lớp học sức chứa 1, học viên a giữ chỗ và sau đó hủy để học viên b trong waitlist nhận được offer.
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const a = await seedMember(69);
    const b = await seedMember(70);
    const idA = await holdFor(classId, a);
    const idB = await holdFor(classId, b);
    await leave(idA, a);
    const offer = await pendingOffer(idB);
    assert.ok(offer);
    // Bước 2: Học viên b chủ động rời khỏi danh sách chờ trước khi chấp nhận offer.
    await leave(idB, b);
    // Bước 3: Thử chấp nhận offer; hệ thống phải từ chối 409 Conflict, enrollment ở trạng thái cancelled và sĩ số về 0.
    await assert.rejects(() => withTx((sql) => waitlistAccept(sql, offer.id, b)), (e: any) => e.status === 409);
    assert.equal(await statusOf(idB), "cancelled");
    assert.equal(await countOf(classId), 0);
  });

  /**
   * Làm gì: Kiểm tra giải phóng suất giữ chỗ (hold): học viên hủy suất giữ chỗ sẽ giải phóng chỗ ngay lập tức và bỏ qua điều kiện cancel cutoff sát giờ học.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu không giải phóng được chỗ hoặc thời hạn giữ chỗ không bị xóa
   */
  it("SC-release: releasing a hold frees the seat and skips the cancel cutoff", async () => {
    // Bước 1: Khởi tạo sân, lớp học và buổi học diễn ra trong vòng 1 giờ tới (nằm trong khoảng thời gian cancel cutoff).
    const court = await quietCourt("10000000-0000-0000-0000-0000000c0007");
    const classId = await seedClass({ price: 300000, capacity: 3, courtId: court });
    await soonSession(classId, court);
    // Bước 2: Học viên thực hiện giữ chỗ (hold); kiểm tra sĩ số lớp tăng lên 1.
    const m = await seedMember(64);
    const id = await holdFor(classId, m);
    assert.equal(await countOf(classId), 1);
    // Bước 3: Học viên hủy suất giữ chỗ; kiểm tra thao tác thành công (200 OK) bỏ qua cancel cutoff, enrollment chuyển thành cancelled và sĩ số về 0.
    const res = await leave(id, m);
    assert.equal(res.status, 200);
    assert.equal(await statusOf(id), "cancelled");
    assert.equal(await countOf(classId), 0);
    // Bước 4: Xác minh trường hold_until trong database đã được đặt lại thành null.
    const h = (await db.query<{ hold_until: string | null }>("select hold_until from enrollments where id = $1", [id])).rows[0];
    assert.equal(h.hold_until, null);
  });

  /**
   * Làm gì: Kiểm tra việc hủy suất giữ chỗ (hold) sẽ tự động hủy link thanh toán payOS đang chờ (chuyển sang expired).
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu link thanh toán không chuyển sang trạng thái expired khi hủy giữ chỗ
   */
  it("SC-release-cancels-link: releasing a hold cancels its pending payOS link", async () => {
    // Bước 1: Cấu hình mock tạo link thanh toán payOS với mã định danh tăng dần.
    let seq = 0;
    setOverridePaymentLinkCreator(async (args) => {
      seq += 1;
      return {
        // Bước 2: Tạo lớp học, học viên đăng ký giữ chỗ và tạo link thanh toán online ở trạng thái pending.
        orderCode: args.orderCode,
        checkoutUrl: `https://pay.mock/checkout/lc${seq}`,
        qrCode: "data:image/png;base64,mock",
        paymentLinkId: `link_lc_${seq}`,
        expiredAt: Math.floor(Date.now() / 1000) + 900,
      };
    });
    try {
      const classId = await seedClass({ price: 300000, capacity: 3 });
      const m = await seedMember(65);
      const id = await holdFor(classId, m);
      const link = await withTx((sql) =>
        onlineCreate(
          sql,
          new Request("http://localhost/v1/payments/online", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ref_type: "enrollment", ref_id: id }),
          }),
          m,
        ),
      );
      const payId = (link.body as any).payment_id as string;
      const st = async () => (await db.query<{ status: string }>("select status::text as status from payments where id = $1", [payId])).rows[0].status;
      assert.equal(await st(), "pending");
      // Bước 3: Học viên hủy suất giữ chỗ; kiểm tra trạng thái payment tương ứng tự động chuyển sang expired.
      await leave(id, m);
      assert.equal(await st(), "expired");
    } finally {
      setOverridePaymentLinkCreator(null);
    }
  });

  /**
   * Làm gì: Kiểm tra job quét hết hạn giữ chỗ (expireEnrollmentHolds): tự động hủy các suất giữ chỗ quá hạn, giải phóng chỗ trống và tạo offer cho người tiếp theo trong waitlist.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu suất giữ chỗ không bị hủy, sĩ số không giảm hoặc không tạo offer cho waitlist
   */
  it("SC-expire-job: a lapsed hold is cancelled, its seat freed and offered to the waitlist", async () => {
    // Bước 1: Chuẩn bị dữ liệu: lớp học sức chứa 1, học viên a giữ chỗ, học viên b trong danh sách chờ.
    const { expireEnrollmentHolds } = await import("../data/jobs.ts");
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const a = await seedMember(66);
    const b = await seedMember(67);
    const idA = await holdFor(classId, a);
    const idB = await holdFor(classId, b);
    await expireEnrollmentHolds(); // other tests may have left lapsed holds; ours is still live
    assert.equal(await statusOf(idA), "hold");
    // Bước 2: Cập nhật hold_until của học viên a về 1 phút trước để giả lập suất giữ chỗ đã hết hạn.
    await db.query("update enrollments set hold_until = now() - interval '1 minute' where id = $1", [idA]);
    // Bước 3: Chạy job expireEnrollmentHolds; kiểm tra suất của a bị hủy (cancelled), sĩ số về 0 và b nhận được pending offer.
    assert.ok((await expireEnrollmentHolds()) >= 1);
    assert.equal(await statusOf(idA), "cancelled");
    assert.equal(await countOf(classId), 0);
    assert.ok(await pendingOffer(idB));
    // Bước 4: Chạy lại job lần 2 để kiểm tra tính an toàn: không được trừ trùng lặp sĩ số lớp học.
    await expireEnrollmentHolds(); // a second sweep must not decrement again
    assert.equal(await statusOf(idA), "cancelled");
    assert.equal(await countOf(classId), 0);
  });

  /**
   * Làm gì: Kiểm tra hủy suất học đã xác nhận (confirmed): hủy sát giờ học phải tuân theo giới hạn thời gian (cancel cutoff BR-24) và không tự động hoàn tiền.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu vi phạm BR-24 không bị chặn hoặc xuất hiện bản ghi hoàn tiền sai quy định
   */
  it("SC-leave-confirmed: a confirmed seat still obeys the cutoff and no refund row appears", async () => {
    // Bước 1: Khởi tạo sân, lớp học và buổi học diễn ra trong vòng 1 giờ tới (nằm trong khoảng cutoff hủy).
    const court = await quietCourt("10000000-0000-0000-0000-0000000c0006");
    const classId = await seedClass({ price: 300000, capacity: 3, courtId: court });
    await soonSession(classId, court);
    // Bước 2: Học viên đăng ký giữ chỗ và được xác nhận thanh toán (confirmed).
    const m = await seedMember(68);
    const id = await holdFor(classId, m);
    await confirmHold(id);
    // Bước 3: Học viên yêu cầu hủy chỗ; kiểm tra hệ thống từ chối do vi phạm quy tắc cancel cutoff BR-24.
    await assert.rejects(() => leave(id, m), (e: any) => e.extra?.br === "BR-24");
    // Bước 4: Xác minh suất học vẫn giữ nguyên trạng thái confirmed và không phát sinh bản ghi hoàn tiền trong bảng payments.
    assert.equal(await statusOf(id), "confirmed");
    const n = (await db.query<{ n: number }>("select count(*)::int as n from payments where ref_type = 'enrollment' and ref_id = $1", [id])).rows[0].n;
    assert.equal(n, 0);
  });
});

// Suite kiểm thử điểm danh lớp học bán vé lẻ (Sell classes): không trừ buổi trong gói tập và không phát sinh phụ phí.
describe("Sell classes: attendance", () => {
  /**
   * Làm gì: Kiểm tra logic điểm danh lớp học bán lẻ (sell class): điểm danh có mặt (present) không trừ số buổi gói tập của hội viên và không tạo phụ phí buổi học.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu buổi tập trong gói bị trừ hoặc xuất hiện phụ phí sai quy định
   */
  it("SC-attendance-no-charge: marking present neither spends a plan session nor writes a charge", async () => {
    // Bước 1: Khởi tạo sân, lớp học, học viên kèm gói tập hoạt động (còn 3 buổi) và enrollment đã xác nhận thanh toán.
    const court = "10000000-0000-0000-0000-0000000c0008";
    await db.query(
      `insert into courts (id, court_code, sport, status) values ($1, 'SA-0008', 'badminton', 'ready') on conflict (id) do nothing`,
      [court],
    );
    const classId = await seedClass({ price: 300000, capacity: 3, courtId: court });
    const m = await seedPlainUser(92);
    const manager = { id: "00000000-0000-0000-0000-000000000001", role: "manager", full_name: "Sell Manager" } as any;
    const subId = (
      await db.query<{ id: string }>(
        `insert into subscriptions (user_id, plan_id, start_on, end_on, status, session_left)
         values ($1, '20000000-0000-0000-0000-000000000002', current_date - 1, current_date + 30, 'active', 3)
         returning id`,
        [m.id],
      )
    ).rows[0].id;
    await db.query(
      `insert into enrollments (class_id, user_id, status, price_vnd) values ($1, $2, 'confirmed', 300000)`,
      [classId, m.id],
    );
    // Bước 2: Tạo lịch chiếm dụng sân (occupancies) và buổi học (sessions) của lớp học.
    const occ = (
      await db.query<{ id: string }>(
        `insert into occupancies (court_id, start_at, end_at, kind, ref_id)
         values ($1, now() - interval '1 hour', now() + interval '1 hour', 'session', $2) returning id`,
        [court, classId],
      )
    ).rows[0].id;
    const sessionId = (
      await db.query<{ id: string }>(
        `insert into sessions (class_id, court_id, start_at, end_at, status, occupancy_id)
         values ($1, $2, now() - interval '1 hour', now() + interval '1 hour', 'scheduled', $3) returning id`,
        [classId, court, occ],
      )
    ).rows[0].id;
    // Bước 3: Quản lý (manager) thực hiện điểm danh có mặt (present) cho học viên qua API sessionAttendancePost.
    const req = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ user_id: m.id, result: "present" }] }),
    });
    const res = await withTx((sql) => sessionAttendancePost(sql, sessionId, req, manager));
    assert.equal(res.status, 200);
    // Bước 4: Xác minh số buổi gói tập vẫn là 3, không tạo bản ghi phụ phí trong session_charges và kết quả điểm danh là present.
    const left = (await db.query<{ n: number }>("select session_left as n from subscriptions where id = $1", [subId])).rows[0].n;
    assert.equal(left, 3);
    const charges = (
      await db.query<{ n: number }>("select count(*)::int as n from session_charges where session_id = $1 and user_id = $2", [sessionId, m.id])
    ).rows[0].n;
    assert.equal(charges, 0);
    const marked = (await db.query<{ result: string }>("select result::text as result from attendance where session_id = $1 and user_id = $2", [sessionId, m.id])).rows[0];
    assert.equal(marked.result, "present");
  });
});

// Suite kiểm thử các tình huống biên và hoàn thiện nghiệp vụ bán lớp học: hoàn tiền khi hủy lớp, hủy link thanh toán và xử lý ngoại lệ.
describe("Sell classes: final fixes", () => {
  /**
   * Làm gì: Tạo đối tượng Request HTTP với body dạng JSON và header Content-Type tương ứng.
   * Được gọi ở: các helper payDesk, classesPatch và paymentsApproveRefund trong suite "Sell classes: final fixes"
   * @param method Phương thức HTTP (GET, POST, PATCH, v.v.)
   * @param body Dữ liệu payload gửi kèm
   * @returns Đối tượng Request HTTP
   */
  const jsonReq = (method: string, body: unknown) =>
    new Request("http://localhost", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  /**
   * Làm gì: Gửi yêu cầu đăng ký tham gia lớp học cho hội viên m qua API classesEnroll.
   * Được gọi ở: helper holdFor trong suite "Sell classes: final fixes"
   * @param classId Mã ID của lớp học
   * @param m Thông tin hội viên đăng ký
   * @returns Kết quả response từ classesEnroll
   */
  const enrol = (classId: string, m: any) =>
    withTx((sql) => classesEnroll(sql, classId, new Request("http://localhost"), m));
  const mgr = { id: "00000000-0000-0000-0000-000000000001", role: "manager", full_name: "Quan ly" } as any;
  /**
   * Làm gì: Đăng ký lớp học và lấy mã ID của bản ghi enrollment vừa tạo.
   * Được gọi ở: các test trong suite "Sell classes: final fixes"
   * @param classId Mã ID của lớp học
   * @param m Thông tin hội viên
   * @returns Mã ID của enrollment
   */
  const holdFor = async (classId: string, m: any) => ((await enrol(classId, m)).body as any).enrollment.id as string;
  /**
   * Làm gì: Giả lập thanh toán học phí bằng tiền mặt tại quầy lễ tân qua API paymentsCreate.
   * Được gọi ở: test SC-cancel-refund và các test thanh toán tại quầy
   * @param enrollmentId Mã ID của enrollment
   * @param amount Số tiền thanh toán (VND)
   * @returns Kết quả response từ paymentsCreate
   */
  const payDesk = (enrollmentId: string, amount: number) =>
    withTx((sql) =>
      paymentsCreate(sql, jsonReq("POST", { ref_type: "enrollment", ref_id: enrollmentId, method: "cash", amount_vnd: amount }), mgr),
    );
  /**
   * Làm gì: Tạo yêu cầu thanh toán trực tuyến (payOS payment link) cho suất đăng ký lớp học.
   * Được gọi ở: các test thanh toán online trong suite "Sell classes: final fixes"
   * @param enrollmentId Mã ID của enrollment
   * @param u Thông tin người dùng tạo link
   * @returns Kết quả response từ onlineCreate
   */
  const linkFor = (enrollmentId: string, u: any) =>
    withTx((sql) =>
      onlineCreate(
        sql,
        new Request("http://localhost/v1/payments/online", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ref_type: "enrollment", ref_id: enrollmentId }),
        }),
        u,
      ),
    );
  /**
   * Làm gì: Khóa dòng payment bằng SELECT ... FOR UPDATE và gọi settleOnline để quyết toán giao dịch thanh toán online.
   * Được gọi ở: các test quyết toán thanh toán trong suite "Sell classes: final fixes"
   * @param payId Mã ID bản ghi payment
   * @param txn Mã giao dịch đối soát từ nhà cung cấp
   * @returns Kết quả quyết toán từ settleOnline
   */
  const settleLink = (payId: string, txn: string) =>
    withTx(async (sql) => {
      const { settleOnline } = await import("./handlers/online.ts");
      const pay = await sql.query<any>(
        `select id, code, user_id, amount_vnd, status::text as status, ref_type, ref_id, provider_order_code from payments where id = $1 for update`,
        [payId],
      );
      return settleOnline(sql, pay[0], { amountPaid: 300000, transactionId: txn, providerStatus: "PAID" });
    });
  /**
   * Làm gì: Truy vấn trạng thái (status) của bản ghi enrollment từ database.
   * Được gọi ở: các test trong suite "Sell classes: final fixes"
   * @param enrollmentId Mã ID của enrollment
   * @returns Chuỗi trạng thái của enrollment
   */
  const statusOf = async (enrollmentId: string) =>
    (await db.query<{ status: string }>("select status::text as status from enrollments where id = $1", [enrollmentId])).rows[0].status;
  /**
   * Làm gì: Truy vấn số lượng học viên đã ghi danh (enrolled_count) của một lớp học.
   * Được gọi ở: các test trong suite "Sell classes: final fixes"
   * @param classId Mã ID của lớp học
   * @returns Số học viên đã ghi danh
   */
  const countOf = async (classId: string) =>
    (await db.query<{ enrolled_count: number }>("select enrolled_count from classes where id = $1", [classId])).rows[0].enrolled_count;
  /**
   * Làm gì: Truy vấn các lý do cảnh báo ngoại lệ thanh toán lớp học (class_payment_exception) từ bảng outbox.
   * Được gọi ở: các test kiểm tra ghi nhận ngoại lệ thanh toán lớp học
   * @param paymentId Mã ID của bản ghi payment
   * @returns Mảng các chuỗi lý do ngoại lệ
   */
  const staffFlags = async (paymentId: string) =>
    (
      await db.query<{ reason: string }>(
        "select payload->>'reason' as reason from outbox where template = 'class_payment_exception' and payload->>'payment_id' = $1",
        [paymentId],
      )
    ).rows.map((r) => r.reason);
  /**
   * Làm gì: Truy vấn thông tin chi tiết trạng thái thanh toán và mã đơn hàng của nhà cung cấp từ bảng payments.
   * Được gọi ở: các test kiểm tra trạng thái liên kết thanh toán
   * @param payId Mã ID của bản ghi payment
   * @returns Bản ghi chứa status, provider_status và provider_order_code
   */
  const linkRow = async (payId: string) =>
    (
      await db.query<{ status: string; ps: string; code: string }>(
        "select status::text as status, provider_status as ps, provider_order_code::text as code from payments where id = $1",
        [payId],
      )
    ).rows[0];

  let seq = 0;
  let lastExpires: number | undefined;
  const withdrawn: number[] = [];
  // Thiết lập mock tạo và hủy payment link cho toàn bộ suite "Sell classes: final fixes".
  before(() => {
    setOverridePaymentLinkCreator(async (args: any) => {
      seq += 1;
      lastExpires = args.expiresInSeconds;
      return {
        orderCode: args.orderCode,
        checkoutUrl: `https://pay.mock/checkout/ff${seq}`,
        qrCode: "data:image/png;base64,mock",
        paymentLinkId: `link_ff_${seq}`,
        expiredAt: Math.floor(Date.now() / 1000) + 900,
      };
    });
    setOverridePaymentLinkCanceller(async (orderCode: number) => {
      withdrawn.push(orderCode);
    });
  });
  after(() => {
    setOverridePaymentLinkCreator(null);
    setOverridePaymentLinkCanceller(null);
  });

  /**
   * Làm gì: Kiểm tra luồng hoàn tiền khi lớp học bị hủy: tính toán số tiền thực thu trừ đi khoản đã hoàn trước đó, tạo bản ghi hoàn tiền refund_pending và ghi thông báo outbox cho học viên.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu số tiền hoàn trả hoặc thông báo outbox không chính xác
   */
  it("SC-cancel-refund: cancelling a class owes the paid tuition until the desk hands it over", async () => {
    // Bước 1: Khởi tạo lớp học học phí 300.000đ, học viên đóng tiền tại quầy, sau đó giả lập đã hoàn một phần 100.000đ trước đó.
    const { paymentsPayOutRefund, paymentsApproveRefund } = await import("./handlers/desk.ts");
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(84);
    const id = await holdFor(classId, m);
    await payDesk(id, 300000);
    await db.query(
      "insert into payments (code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id) values ('PAY-SC84', $1, 'cash', -100000, 0, 'posted', 'enrollment', $2)",
      [m.id, id],
    );
    // Bước 2: Quản lý hủy lớp học với lý do "Coach is away"; hệ thống tự động tính số tiền còn nợ (200.000đ) để tạo yêu cầu hoàn tiền.
    await withTx((sql) => classesPatch(sql, classId, jsonReq("PATCH", { status: "cancelled", reason: "Coach is away" }), mgr));
    // Bước 3: Truy vấn bản ghi thanh toán ở trạng thái refund_pending được tạo tự động cho học viên.
    const row = (
      await db.query<{ id: string; amount_vnd: number; status: string; shift_id: string | null }>(
        "select id, amount_vnd, status::text as status, shift_id from payments where ref_id = $1 and status = 'refund_pending'",
        [id],
      )
    ).rows[0];
    assert.equal(row.amount_vnd, -200000);
    assert.equal(row.shift_id, null);
    // Bước 4: Kiểm tra thông báo outbox gửi cho học viên với số tiền hoàn 200.000đ.
    const told = await db.query<{ payload: any }>(
      "select payload from outbox where user_id = $1 and template = 'class_changed' and payload->>'class_id' = $2",
      [m.id, classId],
    );
    assert.equal(told.rows[0].payload.refund_vnd, 200000);
    // Bước 5: Quản lý phê duyệt yêu cầu hoàn tiền (paymentsApproveRefund), trạng thái vẫn là refund_pending chờ xuất quỹ tiền mặt.
    const approved = await withTx((sql) => paymentsApproveRefund(sql, row.id, jsonReq("POST", {}), mgr));
    assert.equal(approved.body.status, "refund_pending");
    // Bước 6: Lễ tân mở ca thu ngân (cashier_shifts) theo quy định BR-44 và thực hiện chi tiền mặt (paymentsPayOutRefund); giao dịch chuyển sang posted.
    const desk = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist" } as any;
    const open = await db.query<{ id: string }>("select id from cashier_shifts where receptionist_id = $1 and closed_at is null", [desk.id]);
    const shiftId = open.rows[0]?.id ?? (await db.query<{ id: string }>("insert into cashier_shifts (receptionist_id) values ($1) returning id", [desk.id])).rows[0].id;
    await withTx((sql) => paymentsPayOutRefund(sql, row.id, desk));
    const paid = (await db.query<{ status: string; shift_id: string }>("select status::text as status, shift_id from payments where id = $1", [row.id])).rows[0];
    assert.equal(paid.status, "posted");
    assert.equal(paid.shift_id, shiftId);
    // Bước 7: Chặn không cho phép chi tiền hoàn lần 2 để tránh chi trùng, sau đó đóng ca thu ngân để dọn dẹp.
    await assert.rejects(() => withTx((sql) => paymentsPayOutRefund(sql, row.id, desk)));
    await db.query("update cashier_shifts set closed_at = now() where id = $1", [shiftId]);
  });

  /**
   * Làm gì: Kiểm tra quy tắc BR-44: cả quản lý và lễ tân đều không thể chi tiền hoàn trả nếu không có ca thu ngân đang mở.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu yêu cầu chi tiền không bị từ chối với lỗi BR-44
   */
  it("SC-cancel-refund-manager: neither a manager nor a receptionist can pay without a till", async () => {
    // Bước 1: Khởi tạo lớp học giá 300.000đ, học viên đăng ký giữ chỗ và thanh toán tại quầy.
    const { paymentsPayOutRefund } = await import("./handlers/desk.ts");
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(85);
    const id = await holdFor(classId, m);
    await payDesk(id, 300000);
    // Bước 2: Quản lý hủy lớp học để kích hoạt tự động sinh khoản hoàn tiền ở trạng thái refund_pending.
    await withTx((sql) => classesPatch(sql, classId, jsonReq("PATCH", { status: "cancelled", reason: "Coach is away" }), mgr));
    const row = (await db.query<{ id: string }>("select id from payments where ref_id = $1 and status = 'refund_pending'", [id])).rows[0];
    const desk = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist" } as any;
    // Bước 3: Đóng toàn bộ ca thu ngân đang mở của lễ tân để giả lập tình huống không có két tiền (till).
    await db.query("update cashier_shifts set closed_at = now() where receptionist_id = $1 and closed_at is null", [desk.id]);
    // Bước 4: Kiểm tra cả lễ tân lẫn quản lý khi gọi paymentsPayOutRefund đều bị từ chối với mã lỗi BR-44.
    await assert.rejects(
      () => withTx((sql) => paymentsPayOutRefund(sql, row.id, desk)),
      (e: any) => e.extra?.br === "BR-44",
    );
    await assert.rejects(() => withTx((sql) => paymentsPayOutRefund(sql, row.id, mgr)), (e: any) => e.extra?.br === "BR-44");
    // Bước 5: Xác minh khoản hoàn tiền trong bảng payments vẫn ở trạng thái refund_pending và shift_id vẫn là null.
    const paid = (await db.query<{ status: string; shift_id: string | null }>("select status::text as status, shift_id from payments where id = $1", [row.id])).rows[0];
    assert.equal(paid.status, "refund_pending");
    assert.equal(paid.shift_id, null);
  });

  /**
   * Làm gì: Kiểm tra khi hủy lớp học thì các suất giữ chỗ và link thanh toán bị hủy, nếu tiền về muộn thì chỉ gắn cờ cảnh báo chứ không xếp chỗ.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu suất giữ chỗ không bị hủy hoặc tiền thanh toán muộn không được gắn cờ class_cancelled
   */
  it("SC-cancel-class-hold: cancelling a class ends its holds and links, and a late payment is flagged, not seated", async () => {
    // Bước 1: Khởi tạo lớp học, học viên, tạo suất giữ chỗ (hold) và tạo link thanh toán trực tuyến payOS.
    const { settleEnrollment } = await import("./handlers/classes.ts");
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(80);
    const id = await holdFor(classId, m);
    const payId = ((await linkFor(id, m)).body as any).payment_id as string;
    // Giả lập học viên đã bấm yêu cầu chuyển khoản, sau đó quản lý hủy lớp học với lý do "Coach is away".
    await db.query("update enrollments set transfer_requested_at = now() where id = $1", [id]);
    await withTx((sql) => classesPatch(sql, classId, jsonReq("PATCH", { status: "cancelled", reason: "Coach is away" }), mgr));
    // Bước 2: Xác minh trạng thái enrollment thành cancelled, xóa hold_until, link thanh toán payOS bị hết hạn (expired) và gửi thông báo outbox.
    const row = (
      await db.query<{ status: string; hold_until: string | null; req: string | null }>(
        "select status::text as status, hold_until, transfer_requested_at as req from enrollments where id = $1",
        [id],
      )
    ).rows[0];
    assert.equal(row.status, "cancelled");
    assert.equal(row.hold_until, null);
    assert.equal(row.req, null);
    assert.equal(await countOf(classId), 0);
    const link = await linkRow(payId);
    assert.equal(link.status, "expired");
    assert.equal(link.ps, "CLASS_CANCELLED");
    assert.ok(withdrawn.includes(Number(link.code)));
    const told = await db.query("select 1 from outbox where user_id = $1 and payload->>'class_id' = $2", [m.id, classId]);
    assert.ok(told.rows.length >= 1);

    // Money that arrives anyway (paid at payOS before the cancel landed) is flagged, not seated.
    // Bước 3: Giả lập tiền thanh toán từ payOS đến muộn sau khi lớp đã hủy; settleEnrollment không xếp chỗ mà ghi audit log và gắn cờ class_cancelled.
    const out = await withTx((sql) => settleEnrollment(sql, id, { paymentId: payId }));
    assert.equal(out.outcome, "class_cancelled");
    assert.equal(await statusOf(id), "cancelled");
    assert.equal(await countOf(classId), 0);
    const a = await db.query("select 1 from audit_logs where action = 'enrollment_paid_class_cancelled' and entity_id = $1", [id]);
    assert.equal(a.rows.length, 1);
    const flags = await staffFlags(payId);
    assert.ok(flags.length >= 1);
    assert.ok(flags.every((r) => r === "class_cancelled"));
  });

  /**
   * Làm gì: Kiểm tra quy tắc BR-18: lớp học đã bị hủy sẽ từ chối mọi hình thức thanh toán hoặc xác nhận tiếp tục (tạo link online, chuyển khoản, nộp tiền tại quầy).
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu một trong các phương thức thanh toán không ném lỗi BR-18
   */
  it("SC-cancel-class-refusals: a cancelled class refuses links, transfer requests and desk payments (BR-18)", async () => {
    // Bước 1: Khởi tạo lớp học, học viên và tạo suất giữ chỗ ban đầu.
    const { enrollmentTransfer } = await import("./handlers/classes.ts");
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(81);
    const id = await holdFor(classId, m);
    // The class is cancelled behind the hold's back: every way in must still refuse.
    // Bước 2: Cập nhật trạng thái lớp học thành cancelled trực tiếp trong database.
    await db.query("update classes set status = 'cancelled' where id = $1", [classId]);
    // Bước 3: Xác minh cả 3 cổng thanh toán (tạo link online, yêu cầu chuyển khoản, nộp tiền tại quầy) đều từ chối với lỗi BR-18.
    const isBr18 = (e: any) => e.extra?.br === "BR-18";
    await assert.rejects(() => linkFor(id, m), isBr18);
    await assert.rejects(() => withTx((sql) => enrollmentTransfer(sql, id, m)), isBr18);
    await assert.rejects(() => payDesk(id, 300000), isBr18);
    assert.equal(await statusOf(id), "hold");
  });

  /**
   * Làm gì: Kiểm tra khi học viên tự giải phóng suất giữ chỗ thì link thanh toán bị thu hồi; nếu tiền vẫn về qua link đó thì không xếp chỗ lại và gắn cờ released.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu link không bị hủy hoặc thanh toán muộn không được gắn cờ released
   */
  it("SC-release-link: releasing a hold withdraws its link, and money on that link never re-seats the member", async () => {
    // Bước 1: Khởi tạo lớp học, học viên, tạo suất giữ chỗ và lấy link thanh toán payOS.
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(82);
    const id = await holdFor(classId, m);
    const payId = ((await linkFor(id, m)).body as any).payment_id as string;
    // Bước 2: Học viên chủ động hủy giữ chỗ qua enrollmentDelete; link payOS bị chuyển sang expired với lý do RELEASED.
    await withTx((sql) => enrollmentDelete(sql, id, m));
    const link = await linkRow(payId);
    assert.equal(link.status, "expired");
    assert.equal(link.ps, "RELEASED");
    assert.ok(withdrawn.includes(Number(link.code)));
    assert.equal(await countOf(classId), 0);

    // Bước 3: Giả lập tiền thanh toán vẫn về qua settleLink; giao dịch ghi nhận posted nhưng enrollment giữ nguyên cancelled và gắn cờ cảnh báo released.
    const out = await settleLink(payId, "TX-FF-REL");
    assert.equal(out.posted, true);
    assert.equal(await statusOf(id), "cancelled");
    assert.equal(await countOf(classId), 0);
    const a = await db.query("select 1 from audit_logs where action = 'enrollment_paid_released' and entity_id = $1", [id]);
    assert.equal(a.rows.length, 1);
    const flags = await staffFlags(payId);
    assert.ok(flags.length >= 1);
    assert.ok(flags.every((r) => r === "released"));
  });

  /**
   * Làm gì: Kiểm tra đối với lớp học miễn phí, khi học viên trong hàng đợi chấp nhận lời mời thì được xác nhận chỗ ngay mà không cần qua bước thanh toán.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu suất đăng ký không chuyển sang confirmed hoặc sĩ số lớp không chính xác
   */
  it("SC-waitlist-free: accepting an offer for a free class confirms the seat at once", async () => {
    // Bước 1: Tạo lớp học miễn phí (giá 0 VND, sức chứa 1); học viên A được xác nhận ngay (confirmed), học viên B rơi vào danh sách chờ (waitlisted).
    const classId = await seedClass({ price: 0, capacity: 1 });
    const a = await seedMember(83);
    const b = await seedMember(84);
    const idA = await holdFor(classId, a);
    assert.equal(await statusOf(idA), "confirmed");
    const idB = await holdFor(classId, b);
    assert.equal(await statusOf(idB), "waitlisted");
    // Bước 2: Học viên A hủy đăng ký, hệ thống tự động sinh lời mời chờ xử lý (pending offer) cho học viên B trong danh sách chờ.
    await withTx((sql) => enrollmentDelete(sql, idA, a));
    const offer = (
      await db.query<{ id: string }>("select id from waitlist_offers where enrollment_id = $1 and status = 'pending'", [idB])
    ).rows[0];
    assert.ok(offer);
    // Bước 3: Học viên B chấp nhận lời mời tham gia lớp học qua API waitlistAccept.
    const res = await withTx((sql) => waitlistAccept(sql, offer.id, b));
    assert.equal((res.body as any).status, "confirmed");
    // Bước 4: Kiểm tra trạng thái của học viên B chuyển thẳng sang confirmed, xóa hạn giữ chỗ hold_until và sĩ số lớp tăng lên 1.
    const row = (
      await db.query<{ status: string; hold_until: string | null }>(
        "select status::text as status, hold_until from enrollments where id = $1",
        [idB],
      )
    ).rows[0];
    assert.equal(row.status, "confirmed");
    assert.equal(row.hold_until, null);
    assert.equal(await countOf(classId), 1);
  });

  /**
   * Làm gì: Kiểm tra khi học viên đã thanh toán tại quầy thì link online bị thu hồi, nếu tiền online vẫn về sau đó sẽ được ghi nhận nhưng bị gắn cờ duplicate.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu link online không bị hủy hoặc giao dịch đóng trùng không được gắn cờ duplicate
   */
  it("SC-desk-then-online: the desk withdraws the open link, and money on it later is flagged to staff", async () => {
    // Bước 1: Khởi tạo lớp học, học viên, tạo suất giữ chỗ và lấy link thanh toán online.
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(85);
    const id = await holdFor(classId, m);
    const payId = ((await linkFor(id, m)).body as any).payment_id as string;
    // Bước 2: Học viên thanh toán tiền mặt tại quầy lễ tân; link online bị thu hồi với mã PAID_AT_DESK và suất học được confirmed.
    await payDesk(id, 300000);
    const link = await linkRow(payId);
    assert.equal(link.status, "expired");
    assert.equal(link.ps, "PAID_AT_DESK");
    assert.ok(withdrawn.includes(Number(link.code)));
    assert.equal(await statusOf(id), "confirmed");

    // Bước 3: Tiền online đổ về sau đó qua settleLink; giao dịch ghi nhận posted nhưng không tăng sĩ số trùng, ghi audit log enrollment_paid_twice và gắn cờ duplicate.
    const out = await settleLink(payId, "TX-FF-DUP");
    assert.equal(out.posted, true);
    assert.equal(await statusOf(id), "confirmed");
    assert.equal(await countOf(classId), 1);
    const a = await db.query("select 1 from audit_logs where action = 'enrollment_paid_twice' and entity_id = $1", [id]);
    assert.equal(a.rows.length, 1);
    const flags = await staffFlags(payId);
    assert.ok(flags.length >= 1);
    assert.ok(flags.every((r) => r === "duplicate"));
  });

  /**
   * Làm gì: Kiểm tra thời hạn hết hạn của link thanh toán payOS không bao giờ vượt quá thời gian giữ chỗ còn lại của học viên.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu thời hạn link thanh toán vượt quá thời gian giữ chỗ
   */
  it("SC-link-expiry: a seat link never outlives the hold", async () => {
    // Bước 1: Khởi tạo lớp học, học viên và tạo suất giữ chỗ.
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(86);
    const id = await holdFor(classId, m);
    // Bước 2: Thiết lập thời hạn giữ chỗ chỉ còn 5 phút (300 giây) kể từ hiện tại.
    await db.query("update enrollments set hold_until = now() + interval '5 minutes' where id = $1", [id]);
    // Bước 3: Tạo link thanh toán và kiểm tra thời hạn expiresInSeconds của payOS được giới hạn chính xác trong khoảng 280 - 300 giây.
    await linkFor(id, m);
    assert.ok(lastExpires !== undefined && lastExpires <= 300 && lastExpires >= 280, `expires in ${lastExpires}`);
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho việc loại bỏ quyền lợi giờ sân khỏi gói tập: hội viên chỉ được hưởng giá ưu đãi, không dùng quota, hủy đơn cũ không hoàn tiền.
 * Được gọi ở: test runner (node --test)
 * @returns void
 */
describe("Remove plans: courts", () => {
  const receptionistUser = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist", full_name: "Lễ tân RP" } as any;
  const courtId = "10000000-0000-0000-0000-000000000008";
  const testDate = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);

  /**
   * Làm gì: Dọn dẹp các lịch đặt sân, ca học và occupancy cũ trong ngày kiểm thử để tránh xung đột dữ liệu từ seed demo.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   */
  before(async () => {
    // The demo seed books most of court 8 on these days; clear the test day as Round 6 does.
    await db.query(`update court_bookings set occupancy_id = null, status = 'cancelled' where court_id = $1 and (start_at at time zone 'Asia/Ho_Chi_Minh')::date = $2::date`, [courtId, testDate]);
    await db.query(`update sessions set occupancy_id = null, status = 'cancelled' where court_id = $1 and (start_at at time zone 'Asia/Ho_Chi_Minh')::date = $2::date`, [courtId, testDate]);
    await db.query(`delete from occupancies where court_id = $1 and (start_at at time zone 'Asia/Ho_Chi_Minh')::date = $2::date`, [courtId, testDate]);
  });

  /**
   * Làm gì: Tạo tài khoản người dùng mẫu với vai trò hội viên (member) phục vụ cho các ca test đặt sân.
   * Được gọi ở: các ca test trong suite "Remove plans: courts" (tx.test.ts)
   * @param id Mã định danh UUID của người dùng
   * @param name Họ và tên đầy đủ của người dùng
   * @returns Đối tượng thông tin người dùng mẫu chứa id, role và full_name
   */
  async function seedMember(id: string, name: string): Promise<any> {
    const phone = "+8490" + id.replace(/-/g, "").slice(-7);
    await db.query(
      `insert into users (id, phone, full_name, name_normalized, role, password_hash)
       values ($1, $2, $3, $4, 'member', 'hash')
       on conflict (id) do nothing`,
      [id, phone, name, name.toLowerCase()],
    );
    return { id, role: "member", full_name: name } as any;
  }

  /**
   * Làm gì: Khởi tạo gói tập mẫu và cấp gói đăng ký (subscription) đang hoạt động kèm số giờ thuê sân cho người dùng.
   * Được gọi ở: các ca test trong suite "Remove plans: courts" (tx.test.ts)
   * @param userId Mã định danh UUID của người dùng nhận gói
   * @param courtHoursLeft Số giờ thuê sân ban đầu của gói hội viên
   * @returns Promise<void>
   */
  async function seedPlanSubscription(userId: string, courtHoursLeft: number): Promise<void> {
    const planId = (
      await db.query<{ id: string }>(
        `insert into membership_plans (name, duration_days, court_hours, court_discount_pct, price_vnd, is_on_sale)
         values ('Remove plans RP', 30, 5, 20, 500000, true)
         returning id`,
      )
    ).rows[0].id;
    await db.query(
      `insert into subscriptions (user_id, plan_id, start_on, end_on, status, court_hours_left)
       values ($1, $2, current_date - 1, current_date + 30, 'active', $3)`,
      [userId, planId, courtHoursLeft],
    );
  }

  /**
   * Làm gì: Tạo đối tượng Request HTTP POST tới endpoint /v1/bookings để yêu cầu giữ chỗ sân theo khung giờ chỉ định.
   * Được gọi ở: các ca test trong suite "Remove plans: courts" (tx.test.ts)
   * @param start Chuỗi thời gian bắt đầu dạng HH:mm (ví dụ "09:00")
   * @param body Dữ liệu bổ sung truyền vào body của request
   * @returns Đối tượng Request sẵn sàng gửi vào handler bookingsHold
   */
  function holdReq(start: string, body: Record<string, unknown> = {}): Request {
    return new Request("http://localhost/v1/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ court_id: courtId, start_at: `${testDate}T${start}:00.000+07:00`, ...body }),
    });
  }

  // RP-full-price: a plan with a 20% court discount and hours left no longer changes the price.
  /**
   * Làm gì: Kiểm tra hội viên có gói active chỉ cần trả phí hội viên cố định (30.000đ), không bị trừ giờ thuê sân của gói tập và không có trường plan_hours_left.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu giá sân, trạng thái membership hoặc số giờ sân trong gói không khớp kỳ vọng
   */
  it("RP-member-fee: a member covered on the day pays the member fee and the hold has no plan hours", async () => {
    // Bước 1: Khởi tạo hội viên và cấp gói đăng ký có 5 giờ sân.
    const member = await seedMember("00000000-0000-0000-0000-000000000241", "Member RP1");
    await seedPlanSubscription(member.id, 5);

    // Bước 2: Giữ chỗ sân lúc 09:00; xác minh giá là 30.000đ (phí hội viên), membership.covered = true và không có trường plan_hours_left.
    const res = await withTx(async (sql) => bookingsHold(sql, holdReq("09:00"), member));
    assert.equal(res.status, 201);
    const body = res.body as any;
    assert.equal(body.price, 30000);
    assert.equal(body.membership.covered, true);
    assert.equal("plan_hours_left" in body, false);

    // Bước 3: Lễ tân mở ca thu ngân và thanh toán tiền mặt cho đơn đặt sân qua paymentsCreate.
    const shift = (await db.query<{ id: string }>("insert into cashier_shifts (receptionist_id) values ($1) returning id", [receptionistUser.id])).rows[0];
    const paid = await withTx(async (sql) =>
      paymentsCreate(
        sql,
        new Request("http://localhost/v1/payments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ref_type: "booking", ref_id: body.booking.id, method: "cash", amount_vnd: body.due_now_vnd }),
        }),
        receptionistUser,
      ),
    );
    assert.equal(paid.status, 201);
    await db.query("update cashier_shifts set closed_at = now() where id = $1", [shift.id]);

    // Bước 4: Đóng ca thu ngân và kiểm tra số giờ sân trong bảng subscriptions vẫn giữ nguyên 5 giờ (không bị trừ).
    const sub = (await db.query<{ court_hours_left: number }>(
      "select court_hours_left from subscriptions where user_id = $1",
      [member.id],
    )).rows[0];
    assert.equal(Number(sub.court_hours_left), 5);
  });

  // RP-no-quota: "quota" is no longer a way to pay for a court.
  /**
   * Làm gì: Kiểm tra phương thức thanh toán bằng hạn mức gói tập (quota) đã bị loại bỏ, xác nhận giữ chỗ bằng method "quota" sẽ bị từ chối với lỗi 422.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu hệ thống không trả về lỗi HTTP 422 ở trường method
   */
  it("RP-no-quota: confirming a hold with method quota is rejected with 422 on method", async () => {
    // Bước 1: Khởi tạo hội viên có gói tập và thực hiện giữ chỗ sân lúc 10:00.
    const member = await seedMember("00000000-0000-0000-0000-000000000242", "Member RP2");
    await seedPlanSubscription(member.id, 5);
    const hold = await withTx(async (sql) => bookingsHold(sql, holdReq("10:00"), member));
    const bookingId = (hold.body as any).booking.id;

    // Bước 2: Xác nhận giữ chỗ bằng method "quota" đã bị bãi bỏ; kiểm tra hệ thống từ chối với lỗi 422 Unprocessable Entity ở trường method.
    await assert.rejects(
      async () =>
        withTx(async (sql) =>
          bookingsConfirm(
            sql,
            bookingId,
            new Request(`http://localhost/v1/bookings/${bookingId}/confirm`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ method: "quota" }),
            }),
            member,
          ),
        ),
      (err: any) => {
        assert.equal(err.status, 422);
        assert.equal(err.extra?.field, "method");
        return true;
      },
    );
  });

  // RP-old-quota-cancel: a booking paid with plan hours before plans went can still be cancelled,
  // but nothing is refunded and no subscription or payment row is touched.
  /**
   * Làm gì: Kiểm tra khi hủy đơn đặt sân cũ từng thanh toán bằng hạn mức gói tập (quota), hệ thống không hoàn tiền và không hoàn lại giờ vào gói tập.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu hệ thống hoàn tiền hoặc thay đổi số giờ trong gói đăng ký
   */
  it("RP-old-quota-cancel: cancelling an old quota booking refunds nothing and leaves the plan alone", async () => {
    // Bước 1: Khởi tạo dữ liệu giả lập cho đơn đặt sân cũ đã từng thanh toán bằng 1 giờ quota (quota_hours = 1, paid_vnd = 0).
    const member = await seedMember("00000000-0000-0000-0000-000000000243", "Member RP3");
    await seedPlanSubscription(member.id, 0);
    const bookingId = "30000000-0000-0000-0000-000000000241";
    const occId = (
      await db.query<{ id: string }>(
        `insert into occupancies (id, court_id, start_at, end_at, kind, ref_id)
         values (gen_random_uuid(), $1, '2026-12-20 08:00:00+07', '2026-12-20 09:00:00+07', 'booking', $2)
         returning id`,
        [courtId, bookingId],
      )
    ).rows[0].id;
    await db.query(
      `insert into court_bookings (id, court_id, user_id, start_at, end_at, status, price_vnd, deposit_vnd, paid_vnd, code, channel, quota_hours, occupancy_id)
       values ($1, $2, $3, '2026-12-20 08:00:00+07', '2026-12-20 09:00:00+07', 'confirmed', 100000, 0, 0, 'BK-RP-OLD', 'app', 1, $4)`,
      [bookingId, courtId, member.id, occId],
    );

    // Bước 2: Thực hiện hủy đơn đặt sân qua bookingsCancel; xác minh thao tác thành công và trường refund là null.
    const res = await withTx(async (sql) => bookingsCancel(sql, bookingId, member));
    assert.equal(res.status, 200);
    assert.equal((res.body as any).refund, null);

    // Bước 3: Xác minh không có bản ghi thanh toán hoàn tiền nào được tạo và số giờ sân trong bảng subscriptions vẫn là 0.
    const payments = (await db.query<{ n: number }>("select count(*)::int as n from payments where ref_id = $1", [bookingId])).rows[0];
    assert.equal(payments.n, 0);
    const sub = (await db.query<{ court_hours_left: number }>(
      "select court_hours_left from subscriptions where user_id = $1",
      [member.id],
    )).rows[0];
    assert.equal(Number(sub.court_hours_left), 0);
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho việc bán và thanh toán gói hội viên: kiểm tra ràng buộc vai trò, yêu cầu xác thực và xử lý đơn hàng không tồn tại.
 * Được gọi ở: test runner (node --test)
 * @returns void
 */
describe("Remove plans: sales", () => {
  const receptionist = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist", full_name: "Lễ tân RP-sales" } as any;

  // RP-no-sub-payment: subscription is an accepted ref_type; an order that does not exist is refused and nothing is posted.
  /**
   * Làm gì: Kiểm tra paymentsCreate chấp nhận ref_type là subscription nhưng từ chối với lỗi 404 nếu mã đơn không tồn tại và không tạo giao dịch thanh toán.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu lỗi trả về không phải 404 NOT_FOUND hoặc có bản ghi payment được tạo
   */
  it("RP-no-sub-payment: paymentsCreate accepts ref_type subscription but refuses an unknown plan order with 404 and posts nothing", async () => {
    // The desk needs an open shift first (BR-44); without one the request is refused
    // before ref_type is read, which is what made the old expectation unreachable.
    // Bước 1: Mở ca thu ngân cho lễ tân để thỏa mãn quy tắc BR-44 trước khi tạo thanh toán.
    const shift = (
      await db.query<{ id: string }>("insert into cashier_shifts (receptionist_id) values ($1) returning id", [receptionist.id])
    ).rows[0];
    const missingId = "50000000-0000-0000-0000-000000000299";
    // Bước 2: Gửi yêu cầu thanh toán cho gói đăng ký không tồn tại; kiểm tra trả về lỗi 404 NOT_FOUND chứ không phải lỗi ref_type.
    try {
      await assert.rejects(
        async () =>
          withTx(async (sql) =>
            paymentsCreate(
              sql,
              new Request("http://localhost/v1/payments", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ref_type: "subscription", ref_id: missingId, method: "cash", amount_vnd: 500000 }),
              }),
              receptionist,
            ),
          ),
        (err: any) => {
          assert.equal(err.status, 404);
          assert.equal(err.code, "NOT_FOUND");
          assert.notEqual(err.extra?.field, "ref_type", "subscription must stay an accepted ref_type");
          return true;
        },
      );
      // Bước 3: Xác minh không có bản ghi thanh toán nào được ghi vào bảng payments và đóng ca thu ngân trong finally.
      const n = (
        await db.query<{ n: number }>("select count(*)::int as n from payments where ref_type = 'subscription' and ref_id = $1", [missingId])
      ).rows[0].n;
      assert.equal(n, 0, "a refused plan payment writes no money");
    } finally {
      await db.query("update cashier_shifts set closed_at = now() where id = $1", [shift.id]);
    }
  });

  // RP-no-plan-route: POST /v1/subscriptions exists and requires authentication.
  /**
   * Làm gì: Kiểm tra endpoint POST /v1/subscriptions tồn tại trong router và yêu cầu xác thực, từ chối request không có phiên với mã lỗi 401.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu request chưa xác thực không trả về HTTP 401 hoặc làm tăng số bản ghi subscriptions
   */
  it("RP-no-plan-route: POST /v1/subscriptions exists and refuses an unauthenticated caller with 401", async () => {
    // handleApi starts the 15 s job loop unless it already runs; that interval would keep the test process alive.
    // Thiết lập cờ __arena3Jobs__ để ngăn handleApi kích hoạt job loop ngầm 15s làm tiến trình test không thể thoát.
    (globalThis as any).__arena3Jobs__ = true;
    // Bước 1: Ghi nhận số lượng bản ghi subscriptions hiện tại trong database.
    const before = (await db.query<{ n: number }>("select count(*)::int as n from subscriptions")).rows[0].n;
    // Bước 2: Gửi request POST /v1/subscriptions mà không có header xác thực người dùng.
    const res = await handleApi(
      new Request("http://localhost/v1/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan_id: "20000000-0000-0000-0000-000000000001" }),
      }),
    );
    // Bước 3: Xác minh API trả về mã lỗi 401 Unauthorized và số lượng gói subscriptions không thay đổi.
    assert.equal(res.status, 401);
    const after = (await db.query<{ n: number }>("select count(*)::int as n from subscriptions")).rows[0].n;
    assert.equal(after, before, "an unauthenticated request creates no order");
  });

  // RP-sub-target: staff may only issue a plan order to a member.
  /**
   * Làm gì: Kiểm tra subscriptionsCreate từ chối khi user_id không tồn tại hoặc đối tượng nhận gói không phải là hội viên (member).
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu lỗi trả về không đúng trường user_id hoặc mã 403 Forbidden
   */
  it("RP-sub-target: subscriptionsCreate refuses a missing target user (field user_id) and a non-member target (403)", async () => {
    const { subscriptionsCreate } = await import("./handlers/plans.ts");
    /**
     * Làm gì: Hàm helper gửi request tạo gói đăng ký cho người dùng chỉ định dưới quyền của nhân viên lễ tân.
     * @param userId Mã ID của người dùng nhận gói
     * @returns Kết quả thực thi từ handler subscriptionsCreate
     */
    const call = (userId: string) =>
      withTx((sql) =>
        subscriptionsCreate(
          sql,
          new Request("http://localhost/v1/subscriptions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ plan_id: "20000000-0000-0000-0000-000000000002", user_id: userId }),
          }),
          receptionist,
        ),
      );
    // Bước 1: Kiểm tra từ chối khi user_id không tồn tại trong hệ thống (ném lỗi validation ở trường user_id).
    await assert.rejects(call("50000000-0000-0000-0000-000000000298"), (e: any) => {
      assert.equal(e.extra?.field, "user_id");
      return true;
    });
    // Bước 2: Kiểm tra từ chối với mã lỗi 403 Forbidden khi gán gói hội viên cho tài khoản không mang vai trò member (lễ tân).
    await assert.rejects(call(receptionist.id), (e: any) => {
      assert.equal(e.status, 403);
      return true;
    });
  });

  // RP-old-link: a payOS link raised for a plan order that has since gone is refused, nothing is posted or activated.
  /**
   * Làm gì: Kiểm tra khi thanh toán trực tuyến cho đơn gói đăng ký không còn tồn tại, hệ thống từ chối (404), rollback giao dịch và không kích hoạt gói.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu giao dịch không bị từ chối với lỗi 404 NOT_FOUND
   */
  it("RP-old-link: a paid link for a plan order that no longer exists is refused (404) and posts and activates nothing", async () => {
    const { settleOnline } = await import("./handlers/online.ts");
    // Bước 1: Khởi tạo thông tin thanh toán online giả lập liên kết tới đơn subscription không tồn tại.
    const pay = {
      id: "40000000-0000-0000-0000-000000000299",
      code: "PAY-RP-OLD-LINK",
      user_id: "00000000-0000-0000-0000-000000000004",
      amount_vnd: 500000,
      status: "pending",
      ref_type: "subscription",
      ref_id: "50000000-0000-0000-0000-000000000299",
      provider_order_code: 987654321,
    } as any;
    // Seed the real pending link row so "nothing posted" is checked against a row that exists.
    // Bước 2: Lưu bản ghi thanh toán ở trạng thái pending để đối chiếu kiểm tra rollback sau này.
    await db.query(
      `insert into payments (id, code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, provider_order_code)
       values ($1, $2, $3, 'transfer', $4, 0, 'pending', 'subscription', $5, $6)`,
      [pay.id, pay.code, pay.user_id, pay.amount_vnd, pay.ref_id, pay.provider_order_code],
    );
    // Bước 3: Đếm số gói active ban đầu và gọi settleOnline; kiểm tra giao dịch bị từ chối với mã lỗi 404 NOT_FOUND.
    const activeBefore = (await db.query<{ n: number }>("select count(*)::int as n from subscriptions where status = 'active'")).rows[0].n;
    // The current code raises NOT_FOUND here and the transaction rolls back. Whether a late
    // callback should instead be recorded as ignored is an open product decision (see handoff).
    await assert.rejects(
      withTx(async (sql) => settleOnline(sql, pay, { amountPaid: 500000, transactionId: "TX-RP-OLD", providerStatus: "PAID" })),
      (e: any) => {
        assert.equal(e.status, 404);
        assert.equal(e.code, "NOT_FOUND");
        return true;
      },
    );
    // Bước 2: Xác minh giao dịch rollback hoàn toàn — thanh toán không chuyển posted, vẫn giữ pending và không kích hoạt subscription nào
    const posted = (
      await db.query<{ n: number }>("select count(*)::int as n from payments where id = $1 and status = 'posted'", [pay.id])
    ).rows[0];
    assert.equal(posted.n, 0);
    const still = (await db.query<any>("select status::text as status, provider_txn_id from payments where id = $1", [pay.id])).rows[0];
    assert.equal(still.status, "pending", "the update to posted was rolled back");
    assert.equal(still.provider_txn_id, null);
    const activeAfter = (await db.query<{ n: number }>("select count(*)::int as n from subscriptions where status = 'active'")).rows[0].n;
    assert.equal(activeAfter, activeBefore, "nothing was activated");
  });
});

// Suite kiểm thử các luồng đọc dữ liệu sau khi loại bỏ gói tập: cổng check-in và báo cáo hội viên hoạt động.
describe("Remove plans: reads", () => {
  const receptionist = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist", full_name: "Lễ tân RP-reads" } as any;
  const manager = { id: "00000000-0000-0000-0000-000000000001", role: "manager", full_name: "Quản lý RP-reads" } as any;
  const planId = "20000000-0000-0000-0000-000000000002";
  const ictToday = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

  /**
   * Làm gì: Tạo tài khoản hội viên giả lập trong bảng users để phục vụ kiểm thử check-in và báo cáo.
   * Được gọi ở: tx.test.ts (các ca kiểm thử RP-gate-no-plan, RP-gate-booking, RP-report-active)
   * @param id Mã UUID định danh của hội viên
   * @param name Họ và tên đầy đủ của hội viên
   * @returns Đối tượng hội viên chứa id, role ('member') và full_name
   */
  async function seedMember(id: string, name: string): Promise<any> {
    // Sinh số điện thoại duy nhất từ 7 ký tự cuối của UUID để tránh trùng lặp
    const phone = "+8491" + id.replace(/-/g, "").slice(-7);
    // Chèn bản ghi hội viên vào bảng users, bỏ qua nếu ID đã tồn tại
    await db.query(
      `insert into users (id, phone, full_name, name_normalized, role, password_hash)
       values ($1, $2, $3, $4, 'member', 'hash')
       on conflict (id) do nothing`,
      [id, phone, name, name.toLowerCase()],
    );
    return { id, role: "member", full_name: name } as any;
  }

  /**
   * Làm gì: Tạo bản ghi gói tập (subscription) có trạng thái 'active' cho hội viên trong database.
   * Được gọi ở: tx.test.ts (RP-gate-no-plan, RP-report-active)
   * @param userId Mã UUID của hội viên sở hữu gói tập
   * @param start Ngày bắt đầu có hiệu lực (định dạng YYYY-MM-DD)
   * @param end Ngày kết thúc hiệu lực (định dạng YYYY-MM-DD)
   * @returns Không trả về giá trị (Promise<void>)
   */
  async function seedSubscription(userId: string, start: string, end: string): Promise<void> {
    // Chèn gói tập mới với trạng thái active vào bảng subscriptions
    await db.query(
      `insert into subscriptions (user_id, plan_id, start_on, end_on, status)
       values ($1, $2, $3::date, $4::date, 'active')`,
      [userId, planId, start, end],
    );
  }

  /**
   * Làm gì: Tạo bản ghi sân cầu lông mới với trạng thái sẵn sàng ('ready') để phục vụ kiểm thử đặt sân.
   * Được gọi ở: tx.test.ts (RP-gate-booking, RP-report-active)
   * @param id Mã UUID định danh của sân
   * @param code Mã hiển thị của sân (court_code)
   * @returns Mã UUID của sân vừa được tạo
   */
  async function seedCourt(id: string, code: string): Promise<string> {
    // Chèn sân cầu lông vào bảng courts nếu chưa tồn tại
    await db.query(
      `insert into courts (id, court_code, sport, status) values ($1, $2, 'badminton', 'ready') on conflict (id) do nothing`,
      [id, code],
    );
    return id;
  }

  /**
   * Làm gì: Tạo bản ghi chiếm chỗ sân (occupancies) và đơn đặt sân đã xác nhận (court_bookings) thời lượng 1 giờ.
   * Được gọi ở: tx.test.ts (RP-gate-booking, RP-report-active)
   * @param bookingId Mã UUID của lịch đặt sân
   * @param courtId Mã UUID của sân cầu lông
   * @param userId Mã UUID của hội viên đặt sân
   * @param startAt Thời điểm bắt đầu chơi (chuỗi ISO datetime)
   * @param code Mã tham chiếu đặt sân (code)
   * @returns Không trả về giá trị (Promise<void>)
   */
  async function seedBooking(bookingId: string, courtId: string, userId: string, startAt: string, code: string): Promise<void> {
    // Bước 1: Tính thời gian kết thúc ca chơi (cộng thêm 1 giờ) và tạo bản ghi chiếm sân (occupancies)
    const endAt = new Date(new Date(startAt).getTime() + 3600_000).toISOString();
    const occId = (
      await db.query<{ id: string }>(
        `insert into occupancies (id, court_id, start_at, end_at, kind, ref_id)
         values (gen_random_uuid(), $1, $2, $3, 'booking', $4)
         returning id`,
        [courtId, startAt, endAt, bookingId],
      )
    ).rows[0].id;
    // Bước 2: Tạo đơn đặt sân đã xác nhận (confirmed) liên kết với bản ghi chiếm sân vừa tạo
    await db.query(
      `insert into court_bookings (id, court_id, user_id, start_at, end_at, status, price_vnd, deposit_vnd, paid_vnd, code, channel, occupancy_id)
       values ($1, $2, $3, $4, $5, 'confirmed', 100000, 0, 0, $6, 'app', $7)`,
      [bookingId, courtId, userId, startAt, endAt, code, occId],
    );
  }

  /**
   * Làm gì: Kiểm tra luồng check-in qua cổng sau khi loại bỏ gói tập: hội viên chỉ có subscription mà không có lịch đặt sân hôm nay sẽ không được qua cổng, và hệ thống không hiển thị cảnh báo gói tập.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu hội viên được cho phép qua cổng hoặc trả về cảnh báo về gói tập
   */
  // RP-gate-no-plan: an active subscription alone lets nobody in, and the gate no longer talks about plans.
  it("RP-gate-no-plan: a member with only a subscription and nothing today is not entitled, and no plan warnings", async () => {
    // Bước 1: Tạo hội viên có gói tập subscription active nhưng không có lịch đặt sân nào hôm nay
    const member = await seedMember("00000000-0000-0000-0000-000000000301", "Member RP-gate-1");
    await seedSubscription(member.id, "2026-01-01", "2099-12-31");
    // Bước 2: Lễ tân thực hiện check-in qua cổng cho hội viên tại /v1/gate/checkin
    const { gateCheckin } = await import("./handlers/checkin.ts");
    const res = await withTx((sql) =>
      gateCheckin(
        sql,
        new Request("http://localhost/v1/gate/checkin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ member_id: member.id, reason: "forgot" }),
        }),
        receptionist,
      ),
    );
    // Bước 3: Xác minh hội viên bị từ chối (allowed=false), yêu cầu ghi đè (needs_override=true) và không có cảnh báo về gói tập
    const body = res.body as any;
    assert.equal(body.allowed, false);
    assert.equal(body.needs_override, true);
    assert.equal("plans" in body, false);
    const planKinds = ["no_plan", "frozen", "expired", "scheduled", "expiring", "no_sessions"];
    assert.deepEqual(
      body.warnings.filter((w: { kind: string }) => planKinds.includes(w.kind)),
      [],
    );
  });

  /**
   * Làm gì: Kiểm tra hội viên có lịch đặt sân đã xác nhận (confirmed) trong ngày hôm nay sẽ được quyền qua cổng check-in.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu hội viên không được phép qua cổng hoặc danh sách đặt sân hôm nay không khớp
   */
  // RP-gate-booking: a court booked today is enough to walk through the gate.
  it("RP-gate-booking: a member with a confirmed booking today is entitled", async () => {
    // Bước 1: Khởi tạo hội viên, sân và một lịch đặt sân hôm nay ở trạng thái confirmed
    const member = await seedMember("00000000-0000-0000-0000-000000000302", "Member RP-gate-2");
    const courtId = await seedCourt("10000000-0000-0000-0000-0000000000a2", "RPG2");
    await seedBooking("30000000-0000-0000-0000-000000000302", courtId, member.id, `${ictToday}T10:00:00+07:00`, "BKRPG2");
    // Bước 2: Gọi API check-in qua cổng cho hội viên
    const { gateCheckin } = await import("./handlers/checkin.ts");
    const res = await withTx((sql) =>
      gateCheckin(
        sql,
        new Request("http://localhost/v1/gate/checkin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ member_id: member.id, reason: "forgot" }),
        }),
        receptionist,
      ),
    );
    // Bước 3: Xác minh hội viên được phép qua cổng (allowed=true), không cần override và có đúng 1 booking hôm nay
    const body = res.body as any;
    assert.equal(body.allowed, true);
    assert.equal(body.needs_override, false);
    assert.equal(body.today.bookings.length, 1);
  });

  /**
   * Làm gì: Kiểm tra báo cáo hội viên hoạt động: chỉ tính hội viên có lịch đặt sân trong khoảng thời gian báo cáo, không tính hội viên chỉ có gói tập subscription.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu số lượng active members không đúng hoặc báo cáo vẫn chứa các trường về gói tập
   */
  // RP-report-active: a subscription no longer makes anyone an active member; a booking in range does.
  it("RP-report-active: active members count bookings in range, not subscriptions", async () => {
    // Bước 1: Tạo 2 hội viên: booker có lịch đặt sân trong tháng 1/2099 và subOnly chỉ có gói tập active
    const booker = await seedMember("00000000-0000-0000-0000-000000000303", "Member RP-report-1");
    const subOnly = await seedMember("00000000-0000-0000-0000-000000000304", "Member RP-report-2");
    const courtId = await seedCourt("10000000-0000-0000-0000-0000000000a3", "RPR3");
    await seedBooking("30000000-0000-0000-0000-000000000303", courtId, booker.id, "2099-01-10T10:00:00+07:00", "BKRPR3");
    await seedSubscription(subOnly.id, "2098-12-01", "2099-12-31");
    // Bước 2: Lấy dữ liệu báo cáo hội viên qua membersReportBody trong khoảng thời gian chỉ định
    const { membersReportBody } = await import("./handlers/reports.ts");
    const body = await withTx((sql) => membersReportBody(sql, "2099-01-01", "2099-01-31", null));
    // Bước 3: Xác minh chỉ có 1 hội viên active (người đặt sân) và không còn các trường expiring hay plans_ended
    assert.equal(body.members.active, 1);
    assert.equal("expiring" in body.members, false);
    assert.equal("plans_ended" in body.members, false);
  });
});


/**
 * The desk side of a support request: closing it, and answering it once.
 *
 * Covers the three things the F6 audit found here — a closed request that the
 * member's screen still called "Waiting", a second answer written over the
 * first, and Close happily reporting success on a ticket that was already
 * closed or never existed.
 */
describe("ticket lifecycle", () => {
  const desk = { id: "00000000-0000-0000-0000-0000000000d1", role: "receptionist" } as any;
  const memberId = "00000000-0000-0000-0000-0000000000d2";
  const missingId = "99999999-9999-4999-8999-999999999991";

  before(async () => {
    // Chuẩn bị dữ liệu ban đầu: tạo tài khoản lễ tân và tài khoản hội viên
    await db.query(
      `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
       values ($1, '0987000401', 'Desk D1', 'desk d1', 'receptionist', 'active', 'hash'),
              ($2, '0987000402', 'Member D2', 'member d2', 'member', 'active', 'hash')
       on conflict (id) do nothing`,
      [desk.id, memberId],
    );
  });

  /**
   * Làm gì: Tạo nhanh một ticket hỗ trợ mới của hội viên trong bảng tickets để phục vụ kiểm thử.
   * Được gọi ở: tx.test.ts (các ca kiểm thử trong suite "ticket lifecycle")
   * @param body Nội dung yêu cầu hỗ trợ (mặc định phản ánh đèn sân hỏng)
   * @returns Mã UUID của ticket vừa được tạo
   */
  async function newTicket(body = "the lights in BC2 are out") {
    // Chèn ticket mới vào database và trả về ID vừa sinh
    return (
      await db.query<{ id: string }>(`insert into tickets (user_id, body) values ($1,$2) returning id`, [
        memberId,
        body,
      ])
    ).rows[0].id;
  }

  /**
   * Làm gì: Tạo Request giả lập cho endpoint trả lời ticket POST /v1/tickets/:id/reply.
   * Được gọi ở: tx.test.ts (các ca kiểm thử trả lời ticket)
   * @param id Mã UUID của ticket cần phản hồi
   * @param text Nội dung phản hồi của nhân viên lễ tân
   * @returns Đối tượng Request với header JSON và body chứa reply
   */
  function replyReq(id: string, text: string) {
    return new Request(`http://localhost/v1/tickets/${id}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply: text }),
    });
  }

  /**
   * Làm gì: Truy vấn đếm số lượng bản ghi (COUNT) thỏa mãn điều kiện trong database.
   * Được gọi ở: tx.test.ts (kiểm tra số lượng bản ghi audit_logs và outbox)
   * @param sql Câu lệnh SQL truy vấn với count(*)::int as n
   * @param params Mảng tham số truyền vào câu lệnh SQL
   * @returns Số lượng bản ghi đếm được
   */
  const countOf = async (sql: string, params: unknown[]) =>
    (await db.query<{ n: number }>(sql, params)).rows[0].n;

  /**
   * Làm gì: Kiểm tra tính bất biến (idempotent) khi đóng ticket: bấm đóng nhiều lần đều trả về 200 nhưng chỉ ghi 1 audit log và gửi 1 thông báo outbox.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu status không phải 200 hoặc audit log/outbox bị trùng lặp
   */
  it("closes once however many times the button is pressed", async () => {
    // Bước 1: Tạo một ticket hỗ trợ mới
    const id = await newTicket();
    // Bước 2: Đóng ticket lần đầu qua opsH.ticketClose, kiểm tra HTTP 200
    await withTx(async (sql) => {
      assert.equal((await opsH.ticketClose(sql, id, desk)).status, 200);
    });
    // Second press still answers ok — the caller wanted it closed and it is.
    // Bước 3: Đóng ticket lần thứ hai vẫn trả về HTTP 200, nhưng chỉ ghi đúng 1 audit log và 1 outbox nhờ dedupe_key
    await withTx(async (sql) => {
      assert.equal((await opsH.ticketClose(sql, id, desk)).status, 200);
    });
    assert.equal(
      await countOf(`select count(*)::int as n from audit_logs where action = 'ticket_close' and entity_id = $1`, [id]),
      1,
    );
    assert.equal(
      await countOf(`select count(*)::int as n from outbox where dedupe_key = $1`, [`ticket_closed|${id}`]),
      1,
    );
  });

  /**
   * Làm gì: Kiểm tra việc đóng một ticket không tồn tại sẽ bị từ chối với mã lỗi 404 Not Found.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu không ném lỗi hoặc status không phải 404
   */
  it("refuses to close a request that is not there", async () => {
    // Cố gắng đóng ticket với ID không tồn tại trong database, kỳ vọng lỗi HTTP 404
    await assert.rejects(
      async () => withTx(async (sql) => opsH.ticketClose(sql, missingId, desk)),
      (e: any) => {
        assert.equal(e.status, 404);
        return true;
      },
    );
  });

  /**
   * Làm gì: Kiểm tra khi đóng ticket thì trạng thái cập nhật thành 'closed' và tạo thông báo ticket_closed trong outbox cho hội viên.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu status không phải 'closed' hoặc thông báo outbox sai template/người nhận
   */
  it("tells the member their request is no longer waiting", async () => {
    // Bước 1: Tạo ticket và thực hiện đóng ticket bởi lễ tân
    const id = await newTicket("duplicate of the one I just sent");
    await withTx(async (sql) => opsH.ticketClose(sql, id, desk));
    // Bước 2: Kiểm tra trạng thái ticket chuyển sang 'closed' và trường reply vẫn là null
    const row = (
      await db.query<{ status: string; reply: string | null }>(`select status, reply from tickets where id = $1`, [id])
    ).rows[0];
    assert.equal(row.status, "closed");
    // No answer was written, so the Support badge reads this as "Closed" —
    // judging by `reply` alone was what left it saying "Waiting" for good.
    assert.equal(row.reply, null);
    // Bước 3: Xác minh thông báo 'ticket_closed' được đẩy vào bảng outbox gửi cho đúng hội viên
    const note = (
      await db.query<{ template: string; user_id: string }>(
        `select template, user_id from outbox where dedupe_key = $1`,
        [`ticket_closed|${id}`],
      )
    ).rows[0];
    assert.equal(note.template, "ticket_closed");
    assert.equal(note.user_id, memberId);
  });

  /**
   * Làm gì: Kiểm tra nghiệp vụ từ chối trả lời lần hai (409 Conflict) để tránh ghi đè câu trả lời đã gửi trước đó cho hội viên.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu cho phép trả lời lần 2 hoặc nội dung câu trả lời/outbox bị ghi đè
   */
  it("refuses a second answer instead of writing over the first", async () => {
    // Bước 1: Tạo ticket và gửi câu trả lời đầu tiên qua opsH.ticketReply, kiểm tra HTTP 200
    const id = await newTicket();
    await withTx(async (sql) => {
      assert.equal((await opsH.ticketReply(sql, id, replyReq(id, "Fixed on Tuesday."), desk)).status, 200);
    });
    // Bước 2: Cố gắng gửi câu trả lời thứ hai cho cùng ticket, kỳ vọng hệ thống từ chối với lỗi HTTP 409 Conflict
    await assert.rejects(
      async () => withTx(async (sql) => opsH.ticketReply(sql, id, replyReq(id, "Actually Wednesday."), desk)),
      (e: any) => {
        assert.equal(e.status, 409);
        return true;
      },
    );
    // Bước 3: Xác minh câu trả lời trong database giữ nguyên câu đầu tiên và chỉ gửi đúng 1 thông báo outbox
    const row = (await db.query<{ reply: string }>(`select reply from tickets where id = $1`, [id])).rows[0];
    assert.equal(row.reply, "Fixed on Tuesday.");
    // One answer, one notification: the dedupe key no longer carries the clock.
    assert.equal(
      await countOf(`select count(*)::int as n from outbox where dedupe_key = $1`, [`ticket_replied|${id}`]),
      1,
    );
  });

  /**
   * Làm gì: Kiểm tra lễ tân vẫn có thể gửi phản hồi cho một ticket đã đóng trước đó nếu ticket đó chưa từng có phản hồi.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu không cho phép gửi phản hồi hoặc nội dung lưu sai
   */
  it("still answers a request the desk closed without a reply", async () => {
    // Bước 1: Tạo ticket rồi lễ tân đóng ticket mà không kèm phản hồi
    const id = await newTicket();
    await withTx(async (sql) => opsH.ticketClose(sql, id, desk));
    // Otherwise Close would be a trap: the request would be unanswerable.
    // Bước 2: Gửi phản hồi sau khi ticket đã đóng, kiểm tra phản hồi thành công (HTTP 200)
    await withTx(async (sql) => {
      assert.equal((await opsH.ticketReply(sql, id, replyReq(id, "Sorted, sorry for the wait."), desk)).status, 200);
    });
    // Bước 3: Xác minh nội dung phản hồi đã được lưu đúng vào database
    const row = (await db.query<{ reply: string }>(`select reply from tickets where id = $1`, [id])).rows[0];
    assert.equal(row.reply, "Sorted, sorry for the wait.");
  });

  /**
   * Làm gì: Kiểm tra việc gửi câu trả lời cho ticket không tồn tại sẽ bị từ chối với mã lỗi 404 Not Found.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu không ném lỗi hoặc status không phải 404
   */
  it("refuses to answer a request that is not there", async () => {
    // Gửi câu trả lời cho ticket ID không tồn tại, kỳ vọng hệ thống ném lỗi HTTP 404
    await assert.rejects(
      async () => withTx(async (sql) => opsH.ticketReply(sql, missingId, replyReq(missingId, "Hello?"), desk)),
      (e: any) => {
        assert.equal(e.status, 404);
        return true;
      },
    );
  });
});

/**
 * Switching F6 off has to stop the module without taking away what people
 * already have. Every F6 write route answers 403 BR-52; the reads that hold a
 * member's own history, and the desk's queue of requests already in, keep
 * working — a manager turning a module off is not deleting anybody's past.
 */
describe("F6 flag gate", () => {
  const member = { id: "00000000-0000-0000-0000-0000000000f1", role: "member" } as any;
  const desk = { id: "00000000-0000-0000-0000-0000000000f2", role: "receptionist" } as any;

  before(async () => {
    // Chuẩn bị tài khoản hội viên và lễ tân để kiểm thử phân quyền feature flag F6
    await db.query(
      `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
       values ($1, '0987000501', 'Member F1', 'member f1', 'member', 'active', 'hash'),
              ($2, '0987000502', 'Desk F2', 'desk f2', 'receptionist', 'active', 'hash')
       on conflict (id) do nothing`,
      [member.id, desk.id],
    );
  });

  /**
   * Làm gì: Bật hoặc tắt feature flag F6 (chức năng ticket và trợ lý chat/RTC) trong bảng feature_flags.
   * Được gọi ở: tx.test.ts (các ca kiểm thử trong suite "F6 flag gate")
   * @param enabled Trạng thái bật (true) hoặc tắt (false) của flag F6
   * @returns Không trả về giá trị (Promise<void>)
   */
  async function setF6(enabled: boolean) {
    // Cập nhật hoặc chèn trạng thái flag F6 vào bảng feature_flags
    await db.query(
      `insert into feature_flags (key, enabled) values ('F6', $1)
       on conflict (key) do update set enabled = excluded.enabled`,
      [enabled],
    );
  }

  /**
   * Làm gì: Kiểm tra ngoại lệ ném ra khi tính năng bị khóa bởi feature flag F6 (HTTP 403, mã quy tắc BR-52).
   * Được gọi ở: tx.test.ts (các assert.rejects trong test suite F6)
   * @param e Đối tượng lỗi được ném ra từ API handler
   * @returns Luôn trả về true nếu các assertion điều kiện lỗi đều thỏa mãn
   */
  const isOff = (e: any) => {
    assert.equal(e.status, 403);
    assert.equal(e.extra?.br, "BR-52");
    assert.equal(e.extra?.flag, "F6");
    return true;
  };

  /**
   * Làm gì: Tạo Request giả lập phương thức POST kèm payload JSON cho các bài test API.
   * Được gọi ở: tx.test.ts (các ca kiểm thử gọi route F6)
   * @param url Đường dẫn endpoint cần gọi (ví dụ "/v1/tickets")
   * @param body Dữ liệu payload gửi kèm
   * @returns Đối tượng Request chuẩn của Fetch API
   */
  function post(url: string, body: unknown) {
    return new Request(`http://localhost${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /**
   * Làm gì: Kiểm tra khi tắt flag F6 thì tất cả các route ghi/chat mới bị từ chối với lỗi 403 (BR-52), nhưng các route đọc lịch sử cũ của hội viên và hàng đợi của lễ tân vẫn hoạt động.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu route tạo mới không bị chặn hoặc route xem lịch sử bị lỗi
   */
  it("refuses the module's own routes and keeps the reads that hold history", async () => {
    // Bước 1: Tắt feature flag F6
    await setF6(false);
    try {
      // Bước 2: Xác minh các route tạo dữ liệu mới hoặc realtime (ticket, assistant chat, list conversations, rtc poll, rtc signal) đều bị chặn với mã 403 (BR-52)
      await assert.rejects(
        async () => withTx((sql) => opsH.ticketsCreate(sql, post("/v1/tickets", { body: "lights out" }), member)),
        isOff,
      );
      await assert.rejects(
        async () => withTx((sql) => opsH.assistantChat(sql, post("/v1/assistant", { message: "opening hours?" }), member)),
        isOff,
      );
      await assert.rejects(async () => withTx((sql) => chatH.listConversations(sql, member)), isOff);
      await assert.rejects(
        async () =>
          withTx((sql) =>
            chatH.rtcPollHandler(sql, member, new Request("http://localhost/api/rtc?room=r&peer=" + member.id)),
          ),
        isOff,
      );
      await assert.rejects(
        async () => withTx((sql) => chatH.rtcSignalHandler(sql, member, post("/api/rtc", { op: "leave", room: "r" }))),
        isOff,
      );

      // Bước 3: Xác minh các route đọc lịch sử (tickets của tôi, hàng đợi vé của lễ tân) vẫn được phép truy cập (HTTP 200)
      // Still readable: the member's own requests and replies (FR-S04)...
      const mine = await withTx((sql) =>
        opsH.ticketsMine(sql, new Request("http://localhost/v1/tickets/mine"), member),
      );
      assert.equal(mine.status, 200);
      // ...and the queue the desk still has to work through.
      const queue = await withTx((sql) => opsH.ticketsList(sql, new Request("http://localhost/v1/tickets"), desk));
      assert.equal(queue.status, 200);
    // Dọn dẹp: Khôi phục bật lại flag F6 để tránh ảnh hưởng các test case khác
    } finally {
      await setF6(true);
    }
  });

  /**
   * Làm gì: Kiểm tra các route của module F6 hoạt động bình thường trở lại (201 Created, 200 OK) sau khi bật lại feature flag F6.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu tạo ticket thất bại hoặc danh sách cuộc trò chuyện không phải là mảng
   */
  it("lets the same routes through once the flag is back on", async () => {
    // Bước 1: Bật lại feature flag F6
    await setF6(true);
    // Bước 2: Tạo ticket mới thành công với mã phản hồi HTTP 201 Created
    const res = await withTx((sql) =>
      opsH.ticketsCreate(sql, post("/v1/tickets", { body: "the net on BC2 sags" }), member),
    );
    assert.equal(res.status, 201);
    // This one returns its body directly rather than a {status, body} pair.
    // Bước 3: Lấy danh sách cuộc trò chuyện thành công, trả về mảng conversations
    const convs = await withTx((sql) => chatH.listConversations(sql, member));
    assert.ok(Array.isArray(convs.conversations));
  });
});

/**
 * `POST /assistant` runs outside a transaction (the model call must not hold
 * one), so its `ticket:` branch opens a short one of its own. A ticket and its
 * audit row commit together: if the audit write fails after the ticket was
 * saved, nothing is left behind, so the member's retry does not hand the desk
 * the same request twice.
 */
describe("assistant ticket is written atomically", () => {
  const member = { id: "00000000-0000-0000-0000-0000000000f3", role: "member", full_name: "Member F3" } as any;
  // The route's own connection: no transaction around the handler, as with `authedRead`.
  const plain = () =>
    Object.assign(async () => {
      throw new Error("tagged template not used here");
    }, { query: async (text: string, params: unknown[] = []) => (await db.query(text, params)).rows }) as any;
  const ask = (message: string) =>
    new Request("http://localhost/v1/assistant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
  const count = async () =>
    Number((await db.query<{ n: number }>(`select count(*)::int as n from tickets where user_id = $1`, [member.id])).rows[0]!.n);

  before(async () => {
    await db.query(
      `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
       values ($1, '0987000503', 'Member F3', 'member f3', 'member', 'active', 'hash')
       on conflict (id) do nothing`,
      [member.id],
    );
    await db.query(
      `insert into feature_flags (key, enabled) values ('F6', true)
       on conflict (key) do update set enabled = excluded.enabled`,
    );
  });

  it("leaves no ticket when the audit write fails, and exactly one on the retry", async () => {
    clearLimits();
    const before = await count();
    await db.query(`alter table audit_logs rename to audit_logs_off`);
    try {
      await assert.rejects(async () => opsH.assistantChat(plain(), ask("ticket: lights out on BC2"), member));
    } finally {
      await db.query(`alter table audit_logs_off rename to audit_logs`);
    }
    assert.equal(await count(), before, "the failed attempt must not leave a ticket");

    const res = await opsH.assistantChat(plain(), ask("ticket: lights out on BC2"), member);
    assert.equal(res.status, 200);
    assert.equal(await count(), before + 1);
    const audit = await db.query<{ n: number }>(
      `select count(*)::int as n from audit_logs where actor_id = $1 and action = 'assistant'`,
      [member.id],
    );
    assert.equal(Number(audit.rows[0]!.n), 1);
  });

  it("answers the desk hand-off in the member's language", async () => {
    clearLimits();
    const say = async (body: Record<string, unknown>) => {
      const req = new Request("http://local/v1/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return ((await opsH.assistantChat(plain(), req, member)) as { body: { reply: string } }).body.reply;
    };
    assert.match(await say({ message: "ticket: đèn sân CL-04 chập chờn" }), /^Đã mở yêu cầu .+ Tài khoản › Hỗ trợ\.$/);
    assert.match(await say({ message: "ticket: lights flicker on CL-04" }), /^Opened request .+ Account › Support\.$/);
    // No words to go by: the screen's language decides.
    assert.equal(await say({ message: "ticket:", lang: "vi" }), "Hãy viết điều cần báo sau ticket: để tôi chuyển cho quầy lễ tân.");
    assert.equal(await say({ message: "ticket:" }), "Tell me what happened after ticket: and I'll pass it to the front desk.");
  });
});

/**
 * The relay has to charge a caller for a request it rejects.
 *
 * The per-room budget cannot be charged until the room is known, so a request
 * missing that parameter skips it entirely. Without a ceiling charged earlier,
 * that is an unlimited loop: each attempt still costs a `requireFlag` query
 * before being thrown out.
 */
describe("rtc signalling quota covers rejected requests", () => {
  const user = { id: "00000000-0000-0000-0000-0000000000e1", role: "member" } as any;

  before(async () => {
    // Chuẩn bị tài khoản hội viên để kiểm thử hạn ngạch (quota) WebRTC signalling
    await db.query(
      `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
       values ($1, '0987000601', 'Member E1', 'member e1', 'member', 'active', 'hash')
       on conflict (id) do nothing`,
      [user.id],
    );
  });

  /**
   * Làm gì: Kiểm tra request poll WebRTC không hợp lệ (thiếu phòng) vẫn bị tính vào rate limit endpoint để ngăn chặn tấn công spam làm nghẽn hệ thống.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu request sai không bị trừ hạn mức hoặc request vượt ngưỡng không trả về 429
   */
  it("charges a poll with no room, so it cannot be repeated forever", async () => {
    // Bước 1: Xóa các giới hạn cũ và tạo hàm sinh request poll thiếu tham số phòng (room)
    clearLimits();
    const bare = () => new Request("http://localhost/api/rtc");
    // Fill the bucket to one below the ceiling directly, rather than driving
    // two thousand requests through the database to get there.
    // Bước 2: Làm đầy bộ đếm đến mức sát trần (ceiling - 1) để chuẩn bị kịch bản vượt giới hạn
    for (let i = 0; i < LIMITS.rtcEndpoint.limit - 1; i += 1) {
      takeLimit(`rtc:${user.id}`, LIMITS.rtcEndpoint);
    }
    // Invalid, and rejected as such — but it has to be charged on the way out.
    // Bước 3: Gửi request không hợp lệ — request bị từ chối (400 hoặc 422) nhưng vẫn bị trừ vào hạn ngạch endpoint
    await assert.rejects(
      async () => withTx((sql) => chatH.rtcPollHandler(sql, user, bare())),
      (e: any) => e.status === 422 || e.status === 400,
    );
    // Which is why the next one is refused instead of reaching the database again.
    // Bước 4: Request tiếp theo ngay lập tức bị chặn với mã 429 Too Many Requests do đã chạm trần giới hạn
    await assert.rejects(
      async () => withTx((sql) => chatH.rtcPollHandler(sql, user, bare())),
      (e: any) => {
        assert.equal(e.status, 429);
        return true;
      },
    );
    clearLimits();
  });

  /**
   * Làm gì: Kiểm tra thao tác rời phòng (teardown / op: 'leave') không bị giới hạn bởi hạn ngạch phòng (per-room budget), luôn cho phép thoát phòng sạch sẽ kể cả khi đã hết quota.
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   * @throws AssertionError nếu thao tác leave bị chặn do hết hạn ngạch phòng
   */
  it("leaves teardown out of the per-room budget", async () => {
    // Bước 1: Xóa giới hạn cũ và làm cạn kiệt toàn bộ hạn ngạch tín hiệu của phòng (rtcSignal limit)
    clearLimits();
    const room = "99999999-9999-4999-8999-999999999992";
    // Exhaust the room budget the way a long negotiation would.
    for (let i = 0; i < LIMITS.rtcSignal.limit; i += 1) {
      takeLimit(`rtc:${user.id}:${room}`, LIMITS.rtcSignal);
    }
    // A leave must still get through: the client fires it on teardown and
    // ignores the result, so a refusal strands the peer in the roster.
    // Bước 2: Gửi tín hiệu rời phòng ('leave') khi dọn dẹp kết nối WebRTC
    const res = await withTx((sql) =>
      chatH.rtcSignalHandler(
        sql,
        user,
        new Request("http://localhost/api/rtc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "leave", room, peer: user.id }),
        }),
      ),
    );
    // Bước 3: Xác minh yêu cầu rời phòng vẫn thành công ({ ok: true }) dù hạn ngạch của phòng đã cạn
    assert.deepEqual(res, { ok: true });
    clearLimits();
  });
});
