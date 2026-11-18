/**
 * Quản lý các nghiệp vụ vận hành (operations) của trung tâm thể thao Arena 3.
 * Bao gồm: cấu hình hệ thống & feature flags, tài khoản chuyển khoản ngân hàng, đóng băng & mở đóng băng gói tập,
 * tiếp nhận & dồn hàng đợi danh sách chờ lớp học (waitlist), danh mục & thủ tục cho thuê dụng cụ thể thao.
 * Được gọi bởi router chính (src/server/controllers/router.ts) để phục vụ các API điều hành và nghiệp vụ quầy lễ tân.
 */
import type { Sql } from "@/server/data/db";
import { assertMembershipOutlastsClass, hasRunningClass } from "../../services/membership";
import { err } from "../errors";
import { flagsMap, requireFlag, type FlagKey } from "../../services/flags";
import { assertNoClassClash, assertUnderClassLimit, audit, enqueue, enqueueReceipt, getSettings, issueInvoice, nextCode, pageOf, readJson, str } from "../helpers";
import { limit, RULES } from "../ratelimit";
import { avatarUrlSql, requireRole, withAvatarUrl, type PublicUser } from "../session";
import { isValidVnPhone, normalizePhone } from "../../services/phone";
import { generateAssistantReply, type ChatTurn } from "../../integrations/gemini";
import { COACHES } from "../../../shared/arena3/coaches";
import { ATTENDANCE_LOCK_HOURS, PLAN_PHASES, INTENSITIES, attendanceLocked, isAttResult, isTicketMessage, ticketBody } from "../../services/rules";
import { checkAbsentStreaks, sessionScope } from "./training";
import { openShift, pickMethod } from "./extras";
import { addDays, ictDateString } from "../../../shared/arena3/time";
import { one, withTx } from "../tx";
import { MAX_BOT_TURN, MAX_QUESTION, parseHistory, signReply } from "../../services/assistant-thread";
import { payosConfigured } from "../../integrations/payos";
import { centreBank } from "../../integrations/bank";
import { pageParams, parseInteger } from "../validate";
import { getActiveSportCodes } from "./sports";
import { uiConfigFrom } from "@/shared/ui-config";

/**
 * Làm gì: Lấy thông tin cấu hình công khai của cơ sở (giờ mở/đóng cửa, thời gian giữ chỗ), danh sách feature flags, cấu hình menu giao diện và khả năng thanh toán trực tuyến.
 * Được gọi ở: src/server/controllers/router.ts (route GET /flags); hàm flagsPatch trong file này.
 * @param sql Kết nối cơ sở dữ liệu PostgreSQL.
 * @returns Đối tượng HTTP status 200 và body chứa thông tin venue, flags, ui, capabilities.
 */
export async function flagsGet(sql: Sql) {
  // Bước 1: Đọc cài đặt cấu hình hệ thống từ bảng settings trong cơ sở dữ liệu.
  const settings = await getSettings(sql);
  // Bước 2: Tổng hợp và trả về cấu hình cơ sở, feature flags, menu UI và trạng thái tích hợp cổng thanh toán.
  return {
    status: 200,
    body: {
      // Opening hours and the hold length as the manager set them, for the copy and grids that
      // used to write "06:00-22:00" and "five minutes" in by hand. Not personal, not secret.
      venue: { open_time: settings.open_time, close_time: settings.close_time, hold_minutes: settings.hold_minutes },
      flags: await flagsMap(sql),
      // Each role's menu and the short lists' lengths, as the manager set them.
      ui: uiConfigFrom(settings.ui_config),
      /*
       * Whether online payment can be offered at all.
       *
       * Not a feature flag a manager toggles — it is simply whether the centre
       * has put payOS credentials in the environment. The screens need to know
       * so they can leave the button out rather than offer one that fails, and
       * only the answer crosses the wire; the keys themselves never leave the
       * server.
       */
      capabilities: { online_payment: payosConfigured(), bank_transfer: centreBank() !== null },
    },
  };
}

/**
 * The centre's bank account for a VietQR transfer, for signed-in people only: the booking card
 * shows it to the member who is paying, the desk box to the customer at the counter.
 */
/**
 * Làm gì: Lấy thông tin tài khoản ngân hàng của trung tâm để phục vụ thanh toán qua mã VietQR.
 * Được gọi ở: src/server/controllers/router.ts (route GET /bank-transfer).
 * @param user Thông tin người dùng đang đăng nhập (yêu cầu vai trò member, receptionist hoặc manager).
 * @returns Đối tượng HTTP status 200 và body chứa thông tin ngân hàng đã cấu hình hoặc thông báo chưa thiết lập.
 * @throws Lỗi 403 (forbidden) nếu người dùng không thuộc các vai trò được phép.
 */
export async function bankTransferGet(user: PublicUser) {
  // Bước 1: Kiểm tra quyền truy cập (chỉ cho phép hội viên, lễ tân hoặc quản lý đã đăng nhập).
  requireRole(user, ["member", "receptionist", "manager"]);
  // Bước 2: Lấy thông tin tài khoản ngân hàng từ cấu hình hệ thống (centreBank).
  const bank = centreBank();
  // Bước 3: Trả về trạng thái cấu hình và thông tin chi tiết tài khoản ngân hàng nếu đã thiết lập.
  return {
    status: 200,
    body: bank
      ? { configured: true, bin: bank.bin, account_no: bank.accountNo, account_name: bank.accountName, bank_name: bank.bankName }
      : { configured: false },
  };
}

/**
 * Làm gì: Cập nhật trạng thái bật/tắt của các feature flags (F4, F5, F6) và ghi nhận vào nhật ký kiểm toán.
 * Được gọi ở: src/server/controllers/router.ts (route PATCH /flags).
 * @param sql Kết nối cơ sở dữ liệu PostgreSQL.
 * @param request HTTP Request chứa payload JSON danh sách cờ tính năng cần thay đổi.
 * @param user Người thực hiện yêu cầu (bắt buộc vai trò manager).
 * @returns Kết quả từ hàm flagsGet sau khi đã cập nhật cờ mới.
 * @throws Lỗi 403 (forbidden) nếu không phải manager; lỗi 400 nếu dữ liệu JSON không hợp lệ.
 */
export async function flagsPatch(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền quản lý (chỉ manager mới được phép thay đổi cờ tính năng).
  requireRole(user, ["manager"]);
  // Bước 2: Đọc dữ liệu JSON từ body của request gửi lên.
  const b = await readJson(request);
  // Bước 3: Lặp qua các cờ được phép thay đổi (F4, F5, F6) và lưu vào bảng feature_flags (upsert trên khóa key).
  for (const key of ["F4", "F5", "F6"] as FlagKey[]) {
    if (typeof b[key] === "boolean") {
      await sql.query(`insert into feature_flags (key, enabled) values ($1,$2)
        on conflict (key) do update set enabled = excluded.enabled`, [key, b[key]]);
    }
  }
  // Bước 4: Ghi nhật ký kiểm toán (audit log) để lưu vết lịch sử thay đổi cấu hình hệ thống.
  await audit(sql, user.id, "patch_flags", "flags", null, null, b);
  // Bước 5: Gọi flagsGet để trả về toàn bộ cấu hình mới nhất sau khi cập nhật.
  return flagsGet(sql);
}

/**
 * Làm gì: Đóng băng (tạm dừng) gói tập của hội viên trong một số ngày nhất định, tự động kéo dài ngày hết hạn tương ứng và ghi audit log.
 * Được gọi ở: src/server/controllers/router.ts (route POST /subscriptions/:id/freeze).
 * @param sql Kết nối cơ sở dữ liệu PostgreSQL.
 * @param id Định danh (UUID) của gói tập cần đóng băng trong bảng subscriptions.
 * @param request HTTP Request chứa JSON body với số ngày đóng băng (days: mặc định 7 ngày, từ 1 đến 90 ngày).
 * @param user Người dùng thực hiện thao tác (yêu cầu vai trò manager hoặc receptionist).
 * @returns Đối tượng HTTP status 200 và body chứa thông tin gói tập sau khi cập nhật.
 * @throws Lỗi 403 nếu không đủ quyền; lỗi 404 nếu không tìm thấy gói tập; lỗi 400 (BR-14) nếu gói không active hoặc hội viên đang có lớp học diễn ra; lỗi 400 (BR-15) nếu vượt quá giới hạn ngày đóng băng trong năm.
 */
export async function subscriptionFreeze(sql: Sql, id: string, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền thực hiện (chỉ manager hoặc receptionist mới được quyền đóng băng gói tập).
  requireRole(user, ["manager", "receptionist"]);
  // Bước 2: Đọc dữ liệu từ request và xác thực số ngày đóng băng (mặc định 7 ngày nếu để trống, cho phép từ 1 đến 90 ngày).
  const b = await readJson(request);
  const raw = b.days;
  let days: number;
  if (raw === undefined || raw === null || raw === "") {
    days = 7;
  } else {
    days = parseInteger("days", "Freeze length", raw, -Infinity, Infinity);
    if (days < 1 || days > 90) throw err.validation("Freeze length must be 1–90 days.");
  }
  // Bước 3: Lấy cấu hình giới hạn đóng băng của trung tâm và khóa dòng gói tập để cập nhật (SELECT FOR UPDATE tránh race condition).
  const settings = await getSettings(sql);
  const sub = await one<{
    id: string;
    status: string;
    frozen_days: number;
    end_on: string;
    user_id: string;
  }>(sql, `select id, status, frozen_days, end_on::text, user_id from subscriptions where id = $1 for update`, [id]);
  // Bước 4: Kiểm tra quy tắc nghiệp vụ: gói tập phải active (BR-14), hội viên không có lớp đang/sắp học (BR-14), và không vượt số ngày đóng băng tối đa/năm (BR-15).
  if (!sub) throw err.notFound();
  if (sub.status !== "active") throw err.br("BR-14", "Only an active plan can be frozen.");
  if (await hasRunningClass(sql, sub.user_id)) {
    throw err.br("BR-14", "This member has a class running or coming up, so the plan cannot be frozen.");
  }
  if (sub.frozen_days + days > settings.freeze_max_days_year) {
    throw err.br("BR-15", `Over the limit of ${settings.freeze_max_days_year} freeze days a year.`);
  }
  // Bước 5: Kéo dài ngày hết hạn tương ứng với số ngày đóng băng và chuyển trạng thái gói tập sang 'frozen'.
  const end = addDays(sub.end_on, days);
  await sql.query(
    `update subscriptions set status = 'frozen', frozen_days = frozen_days + $2, end_on = $3 where id = $1`,
    [id, days, end],
  );
  // Bước 6: Ghi nhật ký kiểm toán (audit log) và trả về thông tin gói tập vừa được cập nhật.
  await audit(sql, user.id, "freeze_sub", "subscription", id, sub, { days, end });
  return { status: 200, body: await one(sql, `select id, user_id, plan_id, start_on::text, end_on::text, status, frozen_days, court_hours_left, session_left from subscriptions where id = $1`, [id]) };
}

/**
 * Làm gì: Mở đóng băng (kích hoạt lại) gói tập của hội viên; hoàn trả số ngày chưa sử dụng vào hạn mức năm nếu mở sớm hơn dự kiến và điều chỉnh lại ngày hết hạn thực tế.
 * Được gọi ở: src/server/controllers/router.ts (route POST /subscriptions/:id/unfreeze).
 * @param sql Kết nối cơ sở dữ liệu PostgreSQL.
 * @param id Định danh (UUID) của gói tập cần mở đóng băng.
 * @param user Người dùng thực hiện (yêu cầu vai trò manager hoặc receptionist).
 * @returns Đối tượng HTTP status 200 và body chứa thông tin gói tập sau khi mở đóng băng.
 * @throws Lỗi 403 nếu không đủ quyền; lỗi 404 nếu không tìm thấy gói tập; lỗi 409 (conflictState) nếu gói không ở trạng thái frozen.
 */
export async function subscriptionUnfreeze(sql: Sql, id: string, user: PublicUser) {
  // Bước 1: Kiểm tra quyền thực hiện (chỉ manager hoặc receptionist mới được mở đóng băng gói tập).
  requireRole(user, ["manager", "receptionist"]);
  // Bước 2: Khóa bản ghi gói tập trong DB (SELECT FOR UPDATE) và kiểm tra trạng thái phải là 'frozen'.
  const sub = await one<{ id: string; status: string; end_on: string; frozen_days: number }>(
    sql,
    `select id, status, end_on::text, frozen_days from subscriptions where id = $1 for update`,
    [id],
  );
  if (!sub) throw err.notFound();
  if (sub.status !== "frozen") throw err.conflictState("That plan is not frozen.");

  // Bước 3: Tra cứu bản ghi audit log của lần đóng băng gần nhất để lấy thời điểm đóng băng và ngày hết hạn ban đầu.
  const lastFreeze = await one<{ at: string; before: any; after: any }>(
    sql,
    `select at::text, before, after from audit_logs
      where action = 'freeze_sub' and entity = 'subscription' and entity_id = $1
      order by at desc limit 1`,
    [id],
  );

  // Bước 4: Tính toán số ngày đóng băng thực tế; nếu mở sớm hơn dự kiến, hoàn lại các ngày chưa dùng vào quỹ ngày đóng băng năm và tính lại end_on.
  let newEndOn = sub.end_on;
  // Freeze charges the whole requested length up front. Days not used come back
  // onto the yearly allowance; a freeze with no audit row is left as stored.
  let frozenDays = sub.frozen_days;
  if (lastFreeze && lastFreeze.before?.end_on && lastFreeze.after?.days) {
    const freezeDate = String(lastFreeze.at).slice(0, 10);
    const today = ictDateString();
    const dFreeze = new Date(freezeDate);
    const dToday = new Date(today);
    const maxDays = Number(lastFreeze.after.days) || 0;
    const actualDays = Math.min(maxDays, Math.max(0, Math.round((dToday.getTime() - dFreeze.getTime()) / (86400 * 1000))));
    const unused = Math.max(0, maxDays - actualDays);
    frozenDays = Math.max(0, sub.frozen_days - unused);
    const originalEndOn = String(lastFreeze.before.end_on).slice(0, 10);
    newEndOn = addDays(originalEndOn, actualDays);
  }

  // Bước 5: Cập nhật gói tập về trạng thái 'active', lưu ngày hết hạn thực tế và số ngày đóng băng đã khấu trừ.
  await sql.query(
    `update subscriptions set status = 'active', end_on = $2, frozen_days = $3 where id = $1`,
    [id, newEndOn, frozenDays],
  );
  // Bước 6: Ghi nhật ký kiểm toán (audit log) và trả về thông tin gói tập sau khi kích hoạt lại.
  await audit(sql, user.id, "unfreeze_sub", "subscription", id, sub, { end_on: newEndOn, frozen_days: frozenDays });
  return { status: 200, body: await one(sql, `select id, user_id, plan_id, start_on::text, end_on::text, status, frozen_days, court_hours_left, session_left from subscriptions where id = $1`, [id]) };
}

/**
 * Làm gì: Hội viên chấp nhận lời mời vào lớp từ danh sách chờ (waitlist offer), chuyển đơn đăng ký sang trạng thái giữ chỗ (hold) hoặc xác nhận (confirmed nếu miễn phí).
 * Được gọi ở: src/server/controllers/router.ts (route POST /waitlist/:offerId/accept); kiểm thử trong tx.test.ts.
 * @param sql Kết nối cơ sở dữ liệu PostgreSQL.
 * @param offerId Định danh (UUID) của lời mời trong bảng waitlist_offers.
 * @param user Người dùng đang đăng nhập (bắt buộc vai trò member và phải là chủ sở hữu đơn đăng ký).
 * @returns Đối tượng HTTP status 200 và body chứa trạng thái đơn đăng ký ({ ok: true, status: "confirmed" | "hold" }).
 * @throws Lỗi 403 nếu không phải hội viên hoặc không sở hữu đơn; lỗi 404 nếu không tìm thấy lời mời/lớp/đơn; lỗi 400 (BR-21) nếu lớp đã kín chỗ; lỗi 400 (BR-23) nếu lời mời hết hạn; lỗi 400 (BR-53) nếu lớp chưa mở bán; lỗi 409 nếu trạng thái không hợp lệ hoặc trùng lịch học.
 */
export async function waitlistAccept(sql: Sql, offerId: string, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hội viên (chỉ member mới có thể nhận lời mời danh sách chờ).
  requireRole(user, ["member"]);
  // Bước 2: Khóa dòng lời mời và kiểm tra trạng thái: phải là 'pending' và chưa hết hạn (BR-23).
  const offer = await one<{
    id: string;
    enrollment_id: string;
    status: string;
    expires_at: string;
  }>(sql, `select * from waitlist_offers where id = $1 for update`, [offerId]);
  if (!offer) throw err.notFound();
  if (offer.status === "skipped") throw err.br("BR-21", "The class just filled up.");
  if (offer.status !== "pending") throw err.conflictState();
  if (new Date(offer.expires_at) < new Date()) throw err.br("BR-23", "That offer has expired.");
  // Same lock order as enrollment_hold: the class first, then the enrolment.
  // Bước 3: Lấy class_id từ đơn đăng ký, sau đó khóa dòng lớp học trước rồi mới khóa đơn đăng ký (tuân thủ thứ tự khóa để tránh deadlock).
  const pre = await one<{ class_id: string }>(sql, `select class_id from enrollments where id = $1`, [offer.enrollment_id]);
  if (!pre) throw err.notFound();
  const cl = await one<{ enrolled_count: number; capacity: number; price_vnd: number | null; start_on: string; end_on: string }>(
    sql,
    `select enrolled_count, capacity, price_vnd, start_on::text as start_on, end_on::text as end_on from classes where id = $1 for update`,
    [pre.class_id],
  );
  if (!cl) throw err.notFound();
  const enr = await one<{ id: string; class_id: string; user_id: string; status: string }>(
    sql,
    `select * from enrollments where id = $1 for update`,
    [offer.enrollment_id],
  );
  // Bước 4: Xác thực người nhận lời mời đúng là chủ sở hữu đơn đăng ký và vẫn đang ở trạng thái 'waitlisted'.
  if (!enr || enr.user_id !== user.id) throw err.forbidden();
  if (enr.status !== "waitlisted") throw err.conflictState("You are no longer on the waitlist for this class.");
  // Bước 5: Kiểm tra các quy tắc nghiệp vụ: không trùng lịch học (assertNoClassClash), lớp chưa đầy (BR-21), lớp đã mở bán (BR-53), chưa vượt số lớp tối đa và gói tập còn hạn tới khi lớp kết thúc.
  await assertNoClassClash(sql, user.id, enr.class_id);
  if (cl.enrolled_count >= cl.capacity) throw err.br("BR-21", "The class just filled up.");
  if (cl.price_vnd == null) throw err.br("BR-53", "This class is not open for sale yet.");
  const settings = await getSettings(sql);
  // The seat is held, not confirmed: payment confirms it, and the price is locked now.
  // A free class has nothing to pay, so the seat is confirmed at once (as classesEnroll does).
  await assertUnderClassLimit(sql, user.id, enr.class_id, settings.max_active_classes);
  await assertMembershipOutlastsClass(sql, user.id, cl.end_on);
  // Bước 6: Cập nhật đơn đăng ký: nếu lớp miễn phí thì xác nhận ngay ('confirmed'), nếu có phí thì chuyển sang giữ chỗ ('hold') và tính hạn chót thanh toán (hold_until).
  const total = cl.price_vnd;
  const free = total === 0;
  await sql.query(
    `update enrollments
        set status = $4::enroll_status, waitlist_pos = null, price_vnd = $2,
            hold_until = case when $5::boolean then null else now() + ($3::int * interval '1 minute') end
      where id = $1`,
    [enr.id, total, settings.class_hold_minutes, free ? "confirmed" : "hold", free],
  );
  // Bước 7: Tăng số lượng học viên của lớp, đánh dấu lời mời là 'accepted', và dồn lại thứ tự hàng đợi (compactWaitlist).
  await sql.query(
    `update classes set enrolled_count = enrolled_count + 1 where id = $1 and enrolled_count < capacity`,
    [enr.class_id],
  );
  await sql.query(`update waitlist_offers set status = 'accepted' where id = $1`, [offerId]);
  await compactWaitlist(sql, enr.class_id);
  return { status: 200, body: { ok: true, status: free ? "confirmed" : "hold" } };
}

/** Renumber a class's waitlist 1..n (two-step, see migration 0052). */
/**
 * Làm gì: Đánh số lại thứ tự hàng đợi (waitlist_pos) từ 1 đến n cho một lớp học thông qua stored procedure waitlist_compact trong DB.
 * Được gọi ở: Hàm waitlistAccept (dòng 204); src/server/controllers/handlers/classes.ts (khi hủy suất chờ); src/server/data/jobs.ts (job quét dọn định kỳ).
 * @param sql Kết nối cơ sở dữ liệu PostgreSQL.
 * @param classId Định danh (UUID) của lớp học cần sắp xếp lại danh sách chờ.
 * @returns Không trả về dữ liệu (Promise<void>).
 */
export async function compactWaitlist(sql: Sql, classId: string) {
  // Gọi stored procedure waitlist_compact trong DB để dồn lại thứ tự 1..n, lấp đầy khoảng trống khi có người rời hàng.
  await sql.query(`select waitlist_compact($1::uuid)`, [classId]);
}

/**
 * Làm gì: Tự động gửi lời mời vào lớp cho các hội viên đang ở đầu danh sách chờ khi lớp có chỗ trống mới phát sinh (do hủy đăng ký, hết hạn giữ chỗ hoặc tăng sức chứa).
 * Được gọi ở: src/server/controllers/handlers/classes.ts (khi hủy đăng ký hoặc tăng sức chứa); src/server/data/jobs.ts (job xử lý hết hạn giữ chỗ/lời mời); tx.test.ts.
 * @param sql Kết nối cơ sở dữ liệu PostgreSQL.
 * @param classId Định danh (UUID) của lớp học có chỗ trống cần mời.
 * @returns Không trả về dữ liệu (Promise<void>).
 */
export async function inviteWaitlist(sql: Sql, classId: string) {
  // Bước 1: Khóa dòng lớp học để kiểm tra số chỗ trống thực tế (capacity - enrolled_count).
  const cl = await one<{ capacity: number; enrolled_count: number }>(
    sql,
    `select capacity, enrolled_count from classes where id = $1 for update`,
    [classId],
  );
  if (!cl) return;
  const open = cl.capacity - cl.enrolled_count;
  if (open <= 0) return;
  // Bước 2: Đếm số lời mời đang chờ phản hồi ('pending') còn hiệu lực để tính số chỗ trống khả dụng thực tế.
  const pending = await one<{ n: number }>(
    sql,
    `select count(*)::int as n
       from waitlist_offers o
       join enrollments e on e.id = o.enrollment_id
      where e.class_id = $1 and e.status = 'waitlisted' and o.status = 'pending' and o.expires_at > now()`,
    [classId],
  );
  const room = open - (pending?.n ?? 0);
  if (room <= 0) return;
  // Bước 3: Lấy danh sách hội viên tiếp theo trong hàng đợi ('waitlisted') chưa có lời mời pending, sắp xếp theo waitlist_pos.
  const next = await sql.query<{ id: string; user_id: string }>(
    `select e.id, e.user_id from enrollments e
      where e.class_id = $1 and e.status = 'waitlisted'
        and not exists (
          select 1 from waitlist_offers o
           where o.enrollment_id = e.id and o.status = 'pending' and o.expires_at > now()
        )
      order by e.waitlist_pos nulls last, e.id
      limit $2`,
    [classId, room],
  );
  if (next.length === 0) return;
  // Bước 4: Đọc thời hạn phản hồi lời mời từ cấu hình hệ thống (mặc định 2 giờ).
  const settings = await getSettings(sql);
  const hours = settings.waitlist_offer_hours || 2;
  // Bước 5: Tạo bản ghi lời mời (waitlist_offers) và gửi thông báo in-app (enqueue) đến từng hội viên được mời.
  for (const row of next) {
    const offer = await one<{ id: string }>(
      sql,
      `insert into waitlist_offers (enrollment_id, expires_at, status)
       values ($1, now() + ($2 * interval '1 hour'), 'pending')
       returning id`,
      [row.id, hours],
    );
    await enqueue(
      sql,
      "inapp",
      "waitlist_offer",
      row.user_id,
      { offer_id: offer!.id, class_id: classId },
      `wl|${offer!.id}`,
    );
  }
}

/**
 * Làm gì: Lấy danh sách toàn bộ các loại thiết bị, dụng cụ thể thao trong trung tâm, sắp xếp theo tên.
 * Được gọi ở: src/server/controllers/router.ts (route GET /equipment).
 * @param sql Kết nối cơ sở dữ liệu PostgreSQL.
 * @returns Đối tượng HTTP status 200 và body chứa danh sách thiết bị ({ items }).
 */
export async function equipmentList(sql: Sql) {
  // Truy vấn toàn bộ danh mục dụng cụ từ bảng equipment_items, sắp xếp theo tên để hiển thị trên giao diện.
  const items = await sql.query(`select * from equipment_items order by name`);
  return { status: 200, body: { items } };
}

/**
 * Làm gì: Biểu thức chính quy (Regex) kiểm tra định dạng mã SKU của dụng cụ: dài 2-24 ký tự, bắt đầu bằng chữ hoa hoặc số, cho phép dấu gạch nối.
 * Được gọi ở: Hàm equipmentCreate (dòng 280) để validate mã thiết bị trước khi lưu.
 */
const SKU_RE = /^[A-Z0-9][A-Z0-9-]{1,23}$/;

/** A new line on the gear shelf, so a sport the manager has just added can have gear to hire. */
/**
 * Làm gì: Tạo mới một loại dụng cụ/thiết bị thể thao cho thuê, kiểm tra tính hợp lệ của mã SKU, môn thể thao, số lượng tồn kho và giá thuê.
 * Được gọi ở: src/server/controllers/router.ts (route POST /equipment).
 * @param sql Kết nối cơ sở dữ liệu PostgreSQL.
 * @param request HTTP Request chứa payload JSON thông tin thiết bị (name, sku, sport, stock, rent_vnd).
 * @param user Thông tin người dùng đang đăng nhập (bắt buộc vai trò manager).
 * @returns Đối tượng HTTP status 201 và body chứa thông tin thiết bị vừa tạo ({ ok: true, item }).
 * @throws Lỗi 403 nếu không phải manager; lỗi 400 (validation) nếu tên trống, tên > 80 ký tự, sai định dạng SKU, trùng SKU, môn thể thao không tồn tại, hoặc số lượng/giá thuê không hợp lệ.
 */
export async function equipmentCreate(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền quản lý (chỉ manager mới được tạo loại dụng cụ mới).
  requireRole(user, ["manager"]);
  // Bước 2: Đọc dữ liệu từ request body và xác thực tên thiết bị, mã SKU theo định dạng SKU_RE.
  const b = await readJson(request);
  const name = (str(b.name) ?? "").trim();
  if (!name) throw err.field("name", "Enter the gear's name.");
  if (name.length > 80) throw err.field("name", "Keep the name to 80 characters or fewer.");
  const sku = (str(b.sku) ?? "").trim().toUpperCase();
  if (!SKU_RE.test(sku)) throw err.field("sku", "Use 2 to 24 letters, digits or dashes for the code.");
  // Bước 3: Kiểm tra môn thể thao gắn với dụng cụ (nếu có) phải thuộc danh mục môn đang hoạt động tại trung tâm.
  const sport = str(b.sport) || null;
  if (sport && !(await getActiveSportCodes(sql)).includes(sport)) {
    throw err.field("sport", "Choose a sport the centre offers.");
  }
  // Bước 4: Xác thực số lượng tồn kho ban đầu (0-9999), giá thuê lượt (0-100 triệu VNĐ) và đảm bảo mã SKU không bị trùng lặp.
  const stock = parseInteger("stock", "Stock", b.stock ?? 0, 0, 9999);
  const rent_vnd = parseInteger("rent_vnd", "Hire price", b.rent_vnd ?? 0, 0, 100_000_000);
  if (await one(sql, `select 1 from equipment_items where sku = $1`, [sku])) {
    throw err.field("sku", "Another gear item already uses that code.");
  }
  // Bước 5: Chèn bản ghi thiết bị mới vào bảng equipment_items, ghi audit log và trả về thông tin vừa tạo.
  const item = await one<{ id: string }>(
    sql,
    `insert into equipment_items (sku, name, sport, stock, rent_vnd) values ($1,$2,$3,$4,$5) returning *`,
    [sku, name, sport, stock, rent_vnd],
  );
  await audit(sql, user.id, "equipment.create", "equipment_item", item!.id, null, item);
  return { status: 201, body: { ok: true, item } };
}

/**
 * Làm gì: Thực hiện cho thuê dụng cụ thể thao cho hội viên hoặc khách vãng lai, trừ tồn kho, tạo phiếu mượn (thời hạn 3 giờ) và ghi nhận thanh toán/xuất hóa đơn tại quầy.
 * Được gọi ở: src/server/controllers/router.ts (route POST /equipment/loans).
 * @param sql Kết nối cơ sở dữ liệu PostgreSQL.
 * @param request HTTP Request chứa JSON body gồm item_id, qty, method, user_id (nếu là hội viên), phone (nếu là khách lẻ), booking_id (tùy chọn).
 * @param user Nhân viên thực hiện giao dịch (yêu cầu vai trò receptionist hoặc manager).
 * @returns Đối tượng HTTP status 201 và body chứa thông tin lượt mượn ({ loan, rent_vnd, invoice_id }).
 * @throws Lỗi 403 nếu không đủ quyền; lỗi 404 nếu không tìm thấy dụng cụ; lỗi 400 (validation) nếu thiếu thông tin, số điện thoại không hợp lệ, hoặc tài khoản hội viên không active; lỗi 400 (BR-50) nếu số lượng trong kho không đủ; lỗi 400 nếu ca làm việc chưa mở.
 */
export async function equipmentLoan(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền truy cập (chỉ receptionist hoặc manager mới được lập phiếu cho thuê dụng cụ).
  requireRole(user, ["receptionist", "manager"]);
  // Bước 2: Đọc dữ liệu từ request body và kiểm tra mã thiết bị, số lượng mượn (1-99), phương thức thanh toán.
  const b = await readJson(request);
  const item_id = str(b.item_id);
  if (!item_id) throw err.field("item_id", "Choose the gear to rent out.");
  const qty = parseInteger("qty", "Quantity", b.qty ?? 1, 1, 99);
  const method = pickMethod(b.method);

  // A member rents against their account — the phone on the loan is theirs, so
  // the loan list can name them. A guest has only the number they give.
  const memberId = str(b.user_id);
  let phone: string;
  let buyer = "Khách lẻ";
  // Bước 3: Xác định đối tượng thuê: nếu là hội viên thì kiểm tra tài khoản active; nếu là khách vãng lai thì chuẩn hóa và xác thực số điện thoại Việt Nam.
  if (memberId) {
    const m = await one<{ phone: string; status: string; full_name: string }>(
      sql,
      `select phone, status, full_name from users where id = $1 and role = 'member'`,
      [memberId],
    );
    if (!m) throw err.field("user_id", "That member account was not found.");
    if (m.status !== "active") throw err.field("user_id", "That member account is not active.");
    phone = m.phone;
    buyer = m.full_name;
  } else {
    phone = normalizePhone(str(b.phone) ?? "");
    if (!phone) throw err.field("phone", "Enter the guest's phone number, or pick a member.");
    if (!isValidVnPhone(phone)) throw err.field("phone", "That phone number is not valid.");
  }

  // Bước 4: Khóa dòng thiết bị (SELECT FOR UPDATE) để kiểm tra tồn kho, ném lỗi BR-50 nếu không đủ số lượng cho thuê.
  const item = await one<{ stock: number; rent_vnd: number; name: string }>(
    sql,
    `select stock, rent_vnd, name from equipment_items where id = $1 for update`,
    [item_id],
  );
  if (!item) throw err.notFound();
  if (item.stock < qty) {
    throw err.br("BR-50", `Only ${item.stock} ${item.name} left — you asked for ${qty}.`, { available: item.stock });
  }
  // Gear is charged at the counter like any other sale, so the till must be open first.
  // Bước 5: Kiểm tra ca trực của nhân viên tại quầy thu ngân (bắt buộc phải mở ca trực trước khi giao dịch).
  const shiftId = await openShift(sql, user);
  // Bước 6: Giảm số lượng tồn kho của thiết bị và tạo bản ghi mượn trong bảng equipment_loans (hạn trả mặc định 3 giờ).
  await sql.query(`update equipment_items set stock = stock - $2 where id = $1`, [item_id, qty]);
  const loan = await one(
    sql,
    `insert into equipment_loans (item_id, booking_id, phone, qty, due_at)
     values ($1,$2,$3,$4, now() + interval '3 hours')
     returning *`,
    [item_id, str(b.booking_id) ?? null, phone, qty],
  );
  // Bước 7: Tính tiền thuê thiết bị (rent_vnd * số lượng); nếu có thu phí (> 0 VNĐ), tạo phiếu thanh toán gắn với ca trực hiện tại.
  const rentVnd = item.rent_vnd * qty;
  let invoiceId: string | null = null;
  if (rentVnd > 0) {
    const settings = await getSettings(sql);
    const userId = memberId ?? null;
    const pay = await one<{ id: string }>(
      sql,
      `insert into payments (code, user_id, shift_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by)
       values ($1,$2,$3,$4,$5,$6,'posted','equipment',$7,$8) returning id`,
      [await nextCode(sql, "PAY"), userId, shiftId, method, rentVnd, Number(settings.vat_rate), (loan as { id: string }).id, user.id],
    );
    // Tạo hóa đơn điện tử cho khoản tiền thuê thiết bị
    invoiceId = await issueInvoice(sql, {
      paymentId: pay!.id,
      buyerName: buyer,
      buyerPhone: userId ? null : phone,
      amountVnd: rentVnd,
      vatRate: Number(settings.vat_rate ?? 0),
      description: `Thuê thiết bị — ${item.name} × ${qty}`,
      unit: "lượt",
      settings,
    });
    // Đưa thông báo biên lai thanh toán vào hàng đợi để gửi cho khách hàng
    await enqueueReceipt(sql, userId, { payment_id: pay!.id, invoice_id: invoiceId, amount_vnd: rentVnd, method });
  }
  // Ghi audit log sự kiện cho mượn/thuê thiết bị để theo dõi vết hoạt động
  await audit(sql, user.id, "loan_out", "equipment", item_id, null, loan);
  return { status: 201, body: { loan, rent_vnd: rentVnd, invoice_id: invoiceId } };
}

/**
 * Làm gì: Xử lý trả thiết bị đã mượn/thuê, cộng hoàn lại số lượng tồn kho và cập nhật trạng thái phiếu mượn thành 'returned'.
 * Được gọi ở: src/server/controllers/router.ts (route POST /api/equipment/loans/:id/return)
 * @param sql Kết nối database (PostgreSQL client)
 * @param id ID của phiếu mượn thiết bị (equipment_loans.id)
 * @param user Thông tin người thực hiện (yêu cầu vai trò receptionist hoặc manager)
 * @returns Object phản hồi { status: 200, body: { ok: true } }
 * @throws err.notFound khi không tìm thấy phiếu mượn, err.conflictState khi phiếu mượn không ở trạng thái 'out'
 */
export async function equipmentReturn(sql: Sql, id: string, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn (chỉ lễ tân hoặc quản lý được nhận trả thiết bị)
  requireRole(user, ["receptionist", "manager"]);
  // Bước 2: Tìm phiếu mượn và khóa dòng bằng FOR UPDATE để chống tranh chấp dữ liệu khi trả đồng thời
  const loan = await one<{ id: string; item_id: string; qty: number; status: string }>(
    sql,
    `select * from equipment_loans where id = $1 for update`,
    [id],
  );
  // Kiểm tra phiếu mượn có tồn tại và đang ở trạng thái chưa trả ('out')
  if (!loan) throw err.notFound();
  if (loan.status !== "out") throw err.conflictState();
  // Lock the item row so a return and a rental cannot interleave on the count.
  await sql.query(`select 1 from equipment_items where id = $1 for update`, [loan.item_id]);
  // Bước 3: Đổi trạng thái phiếu mượn thành 'returned' và lưu thời gian trả thực tế
  await sql.query(
    `update equipment_loans set status = 'returned', returned_at = now() where id = $1`,
    [id],
  );
  // Bước 4: Hoàn trả số lượng thiết bị vào kho (tăng stock)
  await sql.query(`update equipment_items set stock = stock + $2 where id = $1`, [loan.item_id, loan.qty]);
  // Bước 5: Ghi audit log hoàn trả và phản hồi thành công
  await audit(sql, user.id, "loan_return", "equipment", loan.item_id, null, { loan_id: id, qty: loan.qty });
  return { status: 200, body: { ok: true } };
}

/**
 * Làm gì: Lấy danh sách các phiếu mượn/thuê thiết bị đang chưa trả (status = 'out') kèm thông tin hội viên và thiết bị, sắp xếp theo thời hạn trả (due_at).
 * Được gọi ở: src/server/controllers/router.ts (route GET /api/equipment/loans)
 * @param sql Kết nối database (PostgreSQL client)
 * @param user Thông tin người thực hiện (yêu cầu vai trò receptionist hoặc manager)
 * @returns Object phản hồi chứa danh sách các phiếu mượn đang chưa trả
 * @throws err.forbidden khi người dùng không đủ quyền hạn
 */
export async function loansOpen(sql: Sql, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn (chỉ lễ tân hoặc quản lý được xem danh sách mượn)
  requireRole(user, ["receptionist", "manager"]);
  // Bước 2: Truy vấn các phiếu mượn đang mở ('out'), kết nối với bảng equipment_items và users
  const items = await sql.query(
    `select l.*, i.name, i.sku,
            m.full_name as member_name, m.member_code
       from equipment_loans l
       join equipment_items i on i.id = l.item_id
       left join users m on m.phone = l.phone and m.role = 'member'
      where l.status = 'out'
      order by l.due_at`,
  );
  return { status: 200, body: { items } };
}

/**
 * Làm gì: Lấy danh sách học viên và kết quả điểm danh của một buổi học, tính toán thời hạn và trạng thái khóa sổ (BR-35).
 * Được gọi ở: src/server/controllers/router.ts (route GET /api/sessions/:id/attendance)
 * @param sql Kết nối database (PostgreSQL client)
 * @param sessionId ID của buổi học cần lấy danh sách điểm danh
 * @param user Thông tin người gọi (yêu cầu vai trò coach hoặc manager)
 * @returns Object phản hồi chứa thông tin buổi học (thời gian, trạng thái khóa) và danh sách học viên kèm kết quả điểm danh
 * @throws err.forbidden khi không đủ quyền hạn hoặc HLV xem lớp của người khác (BR-45), err.featureDisabled khi cờ F4 bị tắt
 */
export async function sessionAttendanceGet(sql: Sql, sessionId: string, user: PublicUser) {
  // Bước 1: Xác thực quyền hạn (coach hoặc manager) và kiểm tra cờ tính năng quản lý lớp học (F4)
  requireRole(user, ["coach", "manager"]);
  await requireFlag(sql, "F4");
  // BR-45: a coach reads the register of their own classes only.
  // Bước 2: Lấy thông tin buổi học và kiểm tra quyền phụ trách lớp của HLV (BR-45)
  const scope = await sessionScope(sql, sessionId, user);
  // Bước 3: Xác định thời điểm khóa sổ điểm danh (sau 2 giờ kể từ khi buổi học kết thúc)
  const session = {
    id: scope.id,
    class_id: scope.class_id,
    status: scope.status,
    start_at: scope.start_at,
    end_at: scope.end_at,
    locked: attendanceLocked(new Date(scope.end_at).getTime(), Date.now(), scope.status),
    lock_at: new Date(new Date(scope.end_at).getTime() + ATTENDANCE_LOCK_HOURS * 3_600_000).toISOString(),
  };
  // Bước 4: Lấy danh sách học viên đã ghi danh thành công ('confirmed') kèm kết quả điểm danh nếu đã có
  const roster = await sql.query(
    `select u.id, u.full_name, u.member_code, u.health_notes,
            ${avatarUrlSql("u")},
            a.result, a.at
       from enrollments e
       join users u on u.id = e.user_id
       left join attendance a on a.session_id = $1 and a.user_id = u.id and a.kind = 'session'
      where e.class_id = $2 and e.status = 'confirmed'
      order by u.full_name`,
    [sessionId, session.class_id],
  );
  // Bước 5: Bổ sung avatarUrl cho từng học viên và trả về kết quả
  return { status: 200, body: { session, items: roster.map(withAvatarUrl) } };
}

/**
 * A member's own attendance (M-05): one line per session of the classes they
 * are in that has already run, with the mark the coach gave — present, late,
 * absent or excused — or null when none has been recorded. Only the caller's
 * own rows; there is no id parameter to point it at somebody else.
 */
export async function meAttendance(sql: Sql, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hội viên (member) và cờ tính năng F4
  requireRole(user, ["member"]);
  await requireFlag(sql, "F4");
  // Bước 2: Truy vấn tối đa 60 buổi học đã qua của các lớp mà hội viên đã ghi danh thành công ('confirmed')
  const items = await sql.query<{
    session_id: string;
    start_at: string;
    end_at: string;
    sport: string;
    level: string;
    court_code: string;
    result: string | null;
  }>(
    `select s.id as session_id, s.start_at, s.end_at, cl.sport::text as sport, cl.level,
            c.court_code, a.result::text as result
       from sessions s
       join classes cl on cl.id = s.class_id
       join courts c on c.id = s.court_id
       left join attendance a on a.session_id = s.id and a.user_id = $1 and a.kind = 'session'
      where s.start_at < now()
        and s.status <> 'cancelled'
        and (a.id is not null
             or exists (select 1 from enrollments e
                         where e.class_id = cl.id and e.user_id = $1 and e.status = 'confirmed'))
      order by s.start_at desc
      limit 60`,
    [user.id],
  );
  // Bước 3: Thống kê số lượng theo từng kết quả điểm danh (present, late, absent, excused)
  const counts = { present: 0, late: 0, absent: 0, excused: 0 } as Record<string, number>;
  for (const r of items) if (r.result && r.result in counts) counts[r.result]++;
  return { status: 200, body: { items, counts } };
}

/**
 * Làm gì: Lưu hoặc cập nhật kết quả điểm danh cho học viên trong buổi học, kiểm tra điều kiện khóa sổ (BR-35) và phát hiện chuỗi vắng liên tiếp (BR-36).
 * Được gọi ở: src/server/controllers/router.ts (route POST /api/sessions/:id/attendance), src/server/controllers/tx.test.ts
 * @param sql Kết nối database (PostgreSQL client)
 * @param sessionId ID của buổi học cần điểm danh
 * @param request HTTP Request chứa danh sách items (kết quả điểm danh) và reason (lý do sửa khi đã khóa sổ)
 * @param user Thông tin người gọi (yêu cầu vai trò coach hoặc manager)
 * @returns Object phản hồi chứa thông tin buổi học và danh sách điểm danh sau khi cập nhật
 * @throws err.forbidden khi không đủ quyền hạn, err.conflictState khi buổi học đã bị hủy, err.field khi dữ liệu không hợp lệ hoặc buổi học chưa bắt đầu, err.br khi vi phạm quy tắc khóa sổ (BR-35)
 */
export async function sessionAttendancePost(sql: Sql, sessionId: string, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn (coach/manager), cờ tính năng F4 và kiểm tra buổi học chưa bị hủy
  requireRole(user, ["coach", "manager"]);
  await requireFlag(sql, "F4");
  const session = await sessionScope(sql, sessionId, user);
  if (session.status === "cancelled") throw err.conflictState("That session was cancelled.");
  // Bước 2: Đọc dữ liệu từ request body và kiểm tra danh sách items không được rỗng
  const b = await readJson(request);
  const raw = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : [];
  if (raw.length === 0) throw err.field("items", "Nothing to save.");

  // BR-35: the register closes two hours after the session. Past that only a
  // manager may correct it, and must say why — the reason is kept in the audit.
  // Bước 3: Kiểm tra khóa sổ điểm danh (BR-35); nếu đã quá 2 giờ thì chỉ quản lý được sửa và bắt buộc nhập lý do
  let reason: string | null = null;
  if (attendanceLocked(new Date(session.end_at).getTime(), Date.now(), session.status)) {
    if (user.role !== "manager") {
      throw err.br("BR-35", "This register closed 2 hours after the session. Ask a manager to correct it.");
    }
    reason = (str(b.reason) ?? "").trim();
    if (reason.length < 3) throw err.field("reason", "Say why this closed register is being changed.");
  }

  // Bước 4: Xác thực từng dòng điểm danh: kết quả hợp lệ và học viên phải thuộc danh sách lớp
  const marks = new Map<string, string>();
  for (const [i, it] of raw.entries()) {
    const uid = str(it.user_id);
    if (!uid || !/^[0-9a-f-]{36}$/i.test(uid)) throw err.field("user_id", `Row ${i + 1}: missing student.`, { index: i });
    const result = str(it.result) ?? "present";
    if (!isAttResult(result)) {
      throw err.field("result", `Row ${i + 1}: result must be present, late, absent or excused.`, { index: i });
    }
    const enrolled = await one(
      sql,
      `select 1 as ok from enrollments where class_id = $1 and user_id = $2 and status = 'confirmed'`,
      [session.class_id, uid],
    );
    if (!enrolled) throw err.field("user_id", `Row ${i + 1}: that student is not in this class.`, { index: i });
    marks.set(uid, result);
  }

  // Bước 5: Chặn điểm danh trước khi buổi học chính thức bắt đầu
  if (new Date(session.start_at).getTime() > Date.now()) {
    throw err.field("session_id", "Cannot mark attendance for a session that has not started.");
  }

  // Bước 6: Lưu kết quả điểm danh trước đó để kiểm toán (audit), xóa bản ghi cũ và lưu điểm danh mới
  const before: Record<string, string | null> = {};
  for (const [uid, result] of marks) {
    const prev = await one<{ result: string | null }>(
      sql,
      `select result::text as result from attendance where session_id = $1 and user_id = $2 and kind = 'session' limit 1`,
      [session.id, uid],
    );
    before[uid] = prev?.result ?? null;
    await sql.query(`delete from attendance where session_id = $1 and user_id = $2 and kind = 'session'`, [session.id, uid]);
    await sql.query(
      `insert into attendance (kind, user_id, session_id, result) values ('session', $1, $2, $3::att_result)`,
      [uid, session.id, result],
    );
  }

  // Bước 7: Ghi audit log lịch sử điểm danh (hoặc hiệu chỉnh điểm danh nếu sau giờ khóa sổ)
  await audit(
    sql,
    user.id,
    reason ? "attendance_correct" : "attendance",
    "session",
    session.id,
    before,
    { marks: Object.fromEntries(marks), ...(reason ? { reason } : {}) },
  );
  // BR-36: only a fresh absence can start or extend a streak.
  // Bước 8: Kiểm tra chuỗi vắng liên tiếp (BR-36) để cảnh báo nguy cơ học viên bỏ học
  const absent = [...marks].filter(([, r]) => r === "absent").map(([uid]) => uid);
  await checkAbsentStreaks(sql, session.class_id, absent);
  // Bước 9: Đọc lại toàn bộ danh sách điểm danh đã cập nhật để trả về cho client
  const res = await sessionAttendanceGet(sql, session.id, user);
  return {
    status: 200,
    body: {
      ...res.body,
    },
  };
}

/**
 * Làm gì: Lấy danh sách giáo án tập luyện thực tế (không phải mẫu), áp dụng phân quyền hiển thị theo vai trò (hội viên chỉ thấy giáo án của lớp mình, HLV thấy giáo án mình tạo hoặc phụ trách).
 * Được gọi ở: src/server/controllers/router.ts (route GET /api/training-plans)
 * @param sql Kết nối database (PostgreSQL client)
 * @param request HTTP Request chứa query params (class_id, mine)
 * @param user Thông tin người dùng hiện tại (member, coach, manager, ...)
 * @returns Object phản hồi chứa danh sách tối đa 60 giáo án phù hợp
 * @throws err.featureDisabled khi cờ tính năng F4 bị tắt
 */
export async function trainingList(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra cờ tính năng quản lý lớp học (F4)
  await requireFlag(sql, "F4");
  // Bước 2: Đọc các tham số lọc từ query URL (class_id và cờ mine)
  const url = new URL(request.url);
  const classId = url.searchParams.get("class_id");
  const mine = url.searchParams.get("mine") === "1";
  // Bước 3: Truy vấn giáo án theo điều kiện phân quyền: hội viên chỉ xem được giáo án đã xuất bản của lớp mình; HLV xem giáo án mình tạo hoặc lớp mình phụ trách
  const items = await sql.query(
    `select p.*, s.start_at as session_start
       from training_plans p
       left join sessions s on s.id = p.session_id
      where not p.is_template
        and ($1::uuid is null or p.class_id = $1)
        and (
          case
            when $2::boolean then
              p.published = true
              and (p.user_id = $3
                   or (p.user_id is null and p.class_id is null)
                   or (p.user_id is null and p.class_id in (
                         select class_id from enrollments where user_id = $3 and status = 'confirmed')))
            when $4::text = 'coach' then
              p.created_by = $3
              or p.class_id in (select id from classes where coach_id = $3 or assistant_id = $3)
            else true
          end
        )
      order by coalesce(s.start_at, p.created_at) desc, p.id
      limit 60`,
    [classId && /^[0-9a-f-]{36}$/i.test(classId) ? classId : null, mine || user.role === "member", user.id, user.role],
  );
  return { status: 200, body: { items } };
}

/**
 * Làm gì: Gợi ý các khối bài tập trong giáo án buổi tập bằng AI (Gemini) theo môn thể thao, trình độ và mục tiêu; tự động dự phòng về bài tập chuẩn nếu AI lỗi hoặc không trả JSON hợp lệ.
 * Được gọi ở: src/server/controllers/router.ts (route POST /api/training-plans/suggest), src/server/controllers/tx.test.ts
 * @param sql Kết nối database (PostgreSQL client)
 * @param request HTTP Request chứa sport, level, goal và prompt (yêu cầu bổ sung của HLV)
 * @param user Người thực hiện (yêu cầu vai trò coach hoặc manager)
 * @returns Object phản hồi chứa payload kế hoạch bài tập gợi ý và cờ boolean ai cho biết có dùng AI hay không
 * @throws err.forbidden khi không đủ quyền hạn, err.featureDisabled khi cờ tính năng AI trợ lý (F5) bị tắt
 */
export async function trainingSuggest(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn (coach/manager) và kiểm tra cờ tính năng trợ lý AI (F5)
  requireRole(user, ["coach", "manager"]);
  await requireFlag(sql, "F5");
  // Bước 2: Đọc dữ liệu đầu vào (môn thể thao, cấp độ, mục tiêu và yêu cầu bổ sung của HLV)
  const b = await readJson(request);
  const activeSports = await getActiveSportCodes(sql);
  const sport = str(b.sport) ?? activeSports[0] ?? "general";
  const level = str(b.level) ?? "beginner";
  const goal = str(b.goal) ?? "core technique";
  // Bộ bài tập mẫu mặc định theo từng cấp độ dùng làm phương án dự phòng khi AI không khả dụng
  const defaultDrills: Record<string, string[]> = {
    beginner: ["Warm-up & footwork 8′", "Fundamental technique drills 12′", "Targeted control practice 10′", "Practice game to 11"],
    intermediate: ["Movement off the step 12′", "Speed & rally exchanges 10′", "Court coverage & defense 8′", "Set to 21"],
    advanced: ["High-power attack drills 10′", "Cross-court tactics", "Low defence transitions", "Umpired match play"],
  };
  const list = defaultDrills[level] ?? defaultDrills.beginner;
  // The coach's own instructions, if any. Capped and stripped of control characters before it reaches the model.
  // Làm sạch prompt của HLV: loại bỏ ký tự điều khiển lạ và giới hạn tối đa 500 ký tự
  const prompt = (str(b.prompt) ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500);
  const text = (value: unknown, max: number) => (str(value) ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
  const vietnamese = /[\u00c0-\u1ef9]/i.test(`${prompt} ${goal}`);
  // Chuẩn hóa từng khối bài tập (thời lượng 3-45 phút, giai đoạn, cường độ, mô tả song ngữ Anh-Việt)
  const cleanBlocks = (items: Record<string, unknown>[]) => items.map((x, i) => {
    const title = text(x.title, 60);
    const duration = Number(x.minutes);
    const minutes = Number.isFinite(duration) ? Math.min(45, Math.max(3, Math.round(duration) || 10)) : 10;
    const inferredPhase = i === 0 ? "warm-up" : i === items.length - 1 ? "cool-down" : "technique";
    const phase = PLAN_PHASES.find((phase) => phase === text(x.phase, 40))
      ?? PLAN_PHASES.find((phase) => phase === inferredPhase) ?? PLAN_PHASES[0];
    const intensity = INTENSITIES.find((intensity) => intensity === text(x.intensity, 40)) ?? "medium";
    return {
      order: i + 1, title, minutes, phase, intensity,
      description: text(x.description, 600) || (vietnamese ? `Thực hiện ${title} trong ${minutes} phút, giữ đúng kỹ thuật và nghỉ ngắn giữa các lượt.` : `Perform ${title} for ${minutes} minutes, keeping good form with short rests between rounds.`),
      equipment: text(x.equipment, 200) || (vietnamese ? "Dụng cụ phù hợp môn tập và đồng hồ bấm giờ." : "Sport-appropriate equipment and a timer."),
      target: text(x.target, 200) || (vietnamese ? `Hoàn thành ${minutes} phút tập đúng kỹ thuật.` : `Complete ${minutes} minutes with correct technique.`),
    };
  });
  // Phân tích mảng khối bài tập từ AI thành danh sách đã làm sạch; null nếu không dùng được
  const parseBlocks = (parsed: unknown) => {
    if (!Array.isArray(parsed)) return null;
    const clean = cleanBlocks(parsed
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
      .filter((x) => text(x.title, 60))
      .slice(0, 8));
    return clean.length >= 2 ? clean : null;
  };
  const parseReply = (raw: string): unknown => {
    const body = raw.replace(/^```(?:json)?\s*|\s*```$/g, "");
    return JSON.parse(body.slice(body.indexOf("["), body.lastIndexOf("]") + 1));
  };

  // Bước 3: Nếu có class_id, đọc hồ sơ học viên của lớp (ẩn danh: không gửi tên cho AI)
  const classId = str(b.class_id);
  let learners: string[] = [];
  let cls: { id: string; coach_id: string; assistant_id: string | null; sport: string; level: string } | null = null;
  if (classId && /^[0-9a-f-]{36}$/i.test(classId)) {
    cls = await one(sql, `select id, coach_id, assistant_id, sport::text as sport, level from classes where id = $1`, [classId]) ?? null;
    if (!cls) throw err.notFound("Class not found.");
    if (user.role !== "manager" && cls.coach_id !== user.id && cls.assistant_id !== user.id) throw err.forbidden("That class is not yours.");
    const rows = await sql.query<{ goal: string | null; level: string | null; health: string | null; age: number | null; pct: number | null; present: number; total: number }>(
      `select tp.goal, ml.level, u.health_notes as health,
              extract(year from age(u.date_of_birth))::int as age,
              (select round(avg(r.plan_pct))::int from session_results r join sessions s on s.id = r.session_id
                where r.user_id = u.id and s.class_id = $1) as pct,
              (select count(*)::int from attendance a where a.user_id = u.id and a.kind = 'session' and a.result::text in ('present','late')) as present,
              (select count(*)::int from attendance a where a.user_id = u.id and a.kind = 'session' and a.result is not null) as total
         from enrollments e join users u on u.id = e.user_id
         left join training_profiles tp on tp.user_id = u.id
         left join member_levels ml on ml.user_id = u.id and ml.sport::text = $2
        where e.class_id = $1 and e.status = 'confirmed'
        order by e.id limit 30`,
      [cls.id, cls.sport],
    );
    learners = rows.map((r, i) => [
      `Student ${i + 1}:`,
      r.age != null ? `age ${r.age}` : null,
      `level ${r.level ?? cls!.level}`,
      r.goal ? `goal ${r.goal}` : null,
      r.pct != null ? `avg plan completion ${r.pct}%` : null,
      r.total ? `attendance ${r.present}/${r.total}` : null,
      r.health ? `health note: ${text(r.health, 120)}` : null,
    ].filter(Boolean).join(" "));
  }
  const learnerRules = learners.length
    ? [`Learners in this class (anonymised):\n${learners.join("\n")}`, "Adapt drills, intensity and rest to these learners: respect every health note, give easier options for weaker or younger learners, and work towards their goals."]
    : [];
  const blockRules = [
    `Each block must contain title (short drill name, max 60 chars), minutes (whole number 3-45), phase (exactly one of ${PLAN_PHASES.join("| ")}), intensity (exactly one of ${INTENSITIES.join("| ")}), description (short instructions for running the drill, max 600 chars), equipment (max 200 chars), target (measurable goal, max 200 chars).`,
    "Use warm-up for the first block and cool-down for the last block when available in phase values.",
    "Keep drills safe for the level. Answer in the language the coach writes in.",
  ];
  // Tên mẫu có thể kèm số phút ("Warm-up 8′"): tách ra làm thời lượng để tên không bị lặp số phút
  const fallback = () => cleanBlocks(list.map((raw, i) => {
    const m = raw.match(/^(.*?)\s*(\d+)′$/);
    return m ? { title: m[1], minutes: Number(m[2]) } : { title: raw, minutes: 10 + i };
  }));
  const meta = (blocks: ReturnType<typeof cleanBlocks>) => ({
    sport, level, goal, source: "ai", generated_on: ictDateString(),
    ...(prompt ? { prompt } : {}),
    blocks,
    note: "A coach reviews this before it goes out. AI never overwrites a published plan.",
  });

  // Chế độ "course": gợi ý cho mọi buổi sắp tới chưa có giáo án; không lưu gì, HLV duyệt từng buổi
  if (str(b.mode) === "course") {
    if (!cls) throw err.field("class_id", "class_id is required for a course suggestion.");
    const sessions = await sql.query<{ id: string; start_at: string; end_at: string }>(
      `select s.id, s.start_at, s.end_at from sessions s
        where s.class_id = $1 and s.status = 'scheduled' and s.start_at > now()
          and not exists (select 1 from training_plans p where p.session_id = s.id)
        order by s.start_at limit 12`,
      [cls.id],
    );
    if (!sessions.length) return { status: 200, body: { sessions: [], ai: false, learners: learners.length } };
    const minutesOf = (x: { start_at: string; end_at: string }) => Math.round((new Date(x.end_at).getTime() - new Date(x.start_at).getTime()) / 60_000);
    const system = [
      `You plan a progressive course of ${sessions.length} training sessions for a sports coach.`,
      `Sport: ${sport}. Level: ${level}. Focus: ${goal}.`,
      ...learnerRules,
      `Reply with ONLY a JSON array of exactly ${sessions.length} objects in session order, no prose, no code fence. Each object: {"title": short session title (max 80 chars), "blocks": array of 3 to 8 blocks}.`,
      ...blockRules,
      "Each session builds on the one before: vary the drills and raise difficulty gradually. Fit each session to its length.",
    ].join("\n");
    const ask = [
      prompt ? `Coach instructions: ${prompt}` : `Plan the course for a ${level} ${sport} class on ${goal}.`,
      `Session lengths in minutes, in order: ${sessions.map(minutesOf).join(", ")}.`,
    ].join("\n");
    const reply = await generateAssistantReply(system, [{ role: "user", text: ask }], { maxOutputTokens: 16384, json: true });
    let drafts: { title: string; blocks: ReturnType<typeof cleanBlocks> | null }[] = [];
    if (reply) {
      try {
        const parsed = parseReply(reply.text);
        if (Array.isArray(parsed)) {
          drafts = parsed.map((x) => {
            const o = x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
            return { title: text(o.title, 80), blocks: parseBlocks(o.blocks) };
          });
        }
      } catch {
        // Not JSON: every session falls back to the standard drills.
      }
    }
    const items = sessions.map((x, i) => {
      const d = drafts[i];
      return { session_id: x.id, start_at: x.start_at, end_at: x.end_at, title: d?.title || "", ai: !!d?.blocks, payload: meta(d?.blocks ?? fallback()) };
    });
    return { status: 200, body: { sessions: items, ai: items.some((x) => x.ai), learners: learners.length } };
  }

  // Chế độ "session" (mặc định): gợi ý cho một buổi
  let blocks = fallback();
  let usedAi = false;
  const system = [
    "You plan one training session for a sports coach.",
    `Sport: ${sport}. Level: ${level}. Focus: ${goal}.`,
    ...learnerRules,
    "Reply with ONLY a JSON array of 3 to 8 blocks, no prose, no code fence.",
    ...blockRules,
    "Total time 45-120 minutes.",
  ].join("\n");
  const ask = prompt ? `Coach instructions: ${prompt}` : `Plan a ${level} ${sport} session on ${goal}.`;
  const reply = await generateAssistantReply(system, [{ role: "user", text: ask }], { maxOutputTokens: 4096, json: true });
  if (reply) {
    try {
      const clean = parseBlocks(parseReply(reply.text));
      if (clean) {
        blocks = clean;
        usedAi = true;
      }
    } catch {
      // A reply that is not JSON falls back to the standard drills.
    }
  }
  return { status: 200, body: { payload: meta(blocks), ai: usedAi, learners: learners.length } };
}

// ticketBody() moved to ../rules — a Unicode-hardened version (zero-width
// characters, the full-width "：" an IME can produce) that still collapses
// repeated "ticket:" prefixes the same way. Re-exported here so nothing
// importing it from this module has to change.
export { ticketBody };

/**
 * The budget for opening a support request.
 *
 * One bucket for both doors into the queue — the support form and a `ticket:`
 * message to the assistant — because to reception they are the same row.
 * Counting them separately would let one member post a full allowance through
 * each, which is the hole the assistant route was: it was covered only by
 * `RULES.assistant`, and twenty a minute is a model-call budget, not a
 * someone-has-to-read-this budget.
 *
 * Callers charge this before the insert, so a burst is refused rather than
 * queued behind however long the write takes. A failed insert therefore costs
 * the member one of their three: the alternative, `reset()` on error, empties
 * the whole bucket and would let a real burst through on the back of one
 * unlucky write.
 */
function ticketQuota(userId: string): void {
  limit(`ticket:${userId}`, RULES.ticketCreate, "requests");
  limit(`ticket:${userId}:hour`, RULES.ticketCreateHourly, "requests");
}

/**
 * Làm gì: Trợ lý AI trả lời câu hỏi của hội viên (POST /v1/assistant). Tin nhắn bắt đầu bằng "ticket:" thì mở phiếu hỗ trợ cho lễ tân
 * (phiếu và audit ghi chung một transaction ngắn); câu hỏi thường thì gửi DATA BLOCK cùng lịch sử đã ký cho model,
 * model không trả lời được thì dùng câu trả lời theo quy tắc (ruleReply).
 * Được gọi ở: src/server/controllers/router.ts, route POST /v1/assistant qua `authedRead`, nên không giữ transaction trong lúc chờ model.
 * @returns { reply, source, sig? }: sig là chữ ký HMAC của câu trả lời từ model, để lần hỏi sau gửi lại làm ngữ cảnh.
 */
export async function assistantChat(sql: Sql, request: Request, user: PublicUser) {
  await requireFlag(sql, "F6");
  const body = await readJson(request);
  const message = (str(body.message) ?? "").trim().slice(0, MAX_QUESTION);
  if (message.length < 2) throw err.validation("Type a question first.");
  // Rule-based and desk replies follow the member's language, as the model's do:
  // Vietnamese words in the message, or the app shown in Vietnamese.
  const vi = VI_TEXT.test(message) || body.lang === "vi";
  // The ceiling on the endpoint itself (FR-A03), charged before the branch
  // below rather than inside it: every turn costs a `requireFlag` query whether
  // or not it reaches the model, so a turn that goes to the desk still has to
  // be counted somewhere. A `ticket:` turn pays this and the desk's own,
  // tighter budget.
  limit(`ai:${user.id}`, RULES.assistant, "questions");

  // Only a marker at the very start goes to the desk (FR-S01). Matching
  // "complaint", "feedback", "khiếu nại" or "góp ý" anywhere in the message
  // turned "Is there a feedback form?" into a support request, so the one
  // question the assistant was asked went unanswered.
  if (isTicketMessage(message)) {
    const note = ticketBody(message);
    // "ticket:" and nothing else. Opening a blank request would put a row at the
    // desk that nobody can answer, so ask for the rest before writing anything.
    if (note.length < 2) {
      return {
        status: 200,
        body: {
          reply: vi
            ? "Hãy viết điều cần báo sau ticket: để tôi chuyển cho quầy lễ tân."
            : "Tell me what happened after ticket: and I'll pass it to the front desk.",
          source: "rules" as const,
        },
      };
    }
    // Twenty a minute is a model-call budget; reception reads these by hand.
    // After the blank check, so asking for the rest of a sentence costs only
    // the endpoint ceiling above, not a slot in the desk's queue.
    ticketQuota(user.id);
    // The route runs outside a transaction so the model call below holds no
    // connection. The ticket and its audit row commit together here: had the
    // audit failed after the ticket was saved, the member would see an error,
    // send again, and the desk would get the same request twice.
    const t = await withTx(async (tx) => {
      const row = await one<{ id: string }>(
        tx,
        `insert into tickets (user_id, body) values ($1,$2) returning id`,
        [user.id, note],
      );
      await audit(tx, user.id, "assistant", "chat", user.id, null, { q: note.slice(0, 200), source: "ticket" });
      return row;
    });
    return {
      status: 200,
      body: {
        // Where to read the answer, not just that one is coming: the request
        // used to vanish into a confirmation, and Account › Support is the
        // only screen that has it and its reply.
        reply: vi
          ? `Đã mở yêu cầu ${t!.id.slice(0, 8)} gửi quầy lễ tân. Lễ tân trả lời trong giờ mở cửa — bạn xem yêu cầu và câu trả lời ở Tài khoản › Hỗ trợ.`
          : `Opened request ${t!.id.slice(0, 8)} for the front desk. Reception replies during opening hours — you will find it, and the reply, under Account › Support.`,
        source: "rules" as const,
      },
    };
  }

  const q = message.toLowerCase();

  const settings = await getSettings(sql);
  const classes = await sql.query<{
    sport: string;
    level: string;
    rrule: string;
    enrolled_count: number;
    capacity: number;
    coach_name: string | null;
    price_vnd: number | null;
  }>(
    `select cl.sport, cl.level, cl.rrule, cl.enrolled_count, cl.capacity, cl.price_vnd, u.full_name as coach_name
       from classes cl
       left join users u on u.id = cl.coach_id
      where cl.status = 'open'
      order by cl.sport, cl.level`,
  );
  const onSale = classes.filter((c): c is typeof c & { price_vnd: number } => c.price_vnd !== null).sort((a, b) => a.price_vnd - b.price_vnd);
  const todayBookings = await sql.query<{ court_code: string; start_at: string; status: string }>(
    `select c.court_code, b.start_at::text, b.status
       from court_bookings b join courts c on c.id = b.court_id
      where b.user_id = $1
        and b.status in ('hold','confirmed')
        and b.start_at >= now() - interval '12 hours'
        and b.start_at < now() + interval '7 days'
      order by b.start_at
      limit 20`,
    [user.id],
  );
  const subs = await sql.query<{
    plan: string; start_on: string; end_on: string; status: string;
    court_hours_left: string; session_left: number | null; days_left: number;
  }>(
    `select p.name as plan, s.start_on::text, s.end_on::text, s.status::text,
            s.court_hours_left::text, s.session_left,
            (s.end_on - (now() at time zone 'Asia/Ho_Chi_Minh')::date)::int as days_left
       from subscriptions s join membership_plans p on p.id = s.plan_id
      where s.user_id = $1
      -- Live plans first, then the latest expired one so "my plan ran out on…" can be answered.
      order by (s.status = 'expired'), s.end_on desc
      limit 4`,
    [user.id],
  );
  const myClasses = await sql.query<{ sport: string; level: string; status: string; waitlist_pos: number | null; next_at: string | null }>(
    `select cl.sport::text, cl.level::text, e.status::text, e.waitlist_pos,
            (select min(se.start_at)::text from sessions se
              where se.class_id = cl.id and se.status = 'scheduled' and se.start_at >= now()) as next_at
       from enrollments e join classes cl on cl.id = e.class_id
      where e.user_id = $1 and e.status in ('confirmed','waitlisted')
      order by cl.sport, cl.level`,
    [user.id],
  );
  const recentAtt = await sql.query<{ kind: string; result: string | null; at: string; label: string | null }>(
    `select a.kind::text, a.result::text, a.at::text, cl.sport || ' ' || cl.level as label
       from attendance a
       left join sessions se on se.id = a.session_id
       left join classes cl on cl.id = se.class_id
      where a.user_id = $1
      order by a.at desc
      limit 5`,
    [user.id],
  );

  const facts = [
    `Centre: ${centreName(settings)}. Open ${settings.open_time.slice(0, 5)}–${settings.close_time.slice(0, 5)} ICT every day.`,
    `Court holds last ${settings.hold_minutes} minutes. A customer who cancels a court or a class, or does not show up, gets no refund. If the centre cancels, the money comes back in cash at the desk. One membership covers every sport; plans differ only by length. A member whose plan is active on the day of the booking pays ${settings.member_court_fee_vnd.toLocaleString("en-US")}đ an hour for a court at any time; with no active plan that day the court costs its list price. A class charges tuition, and can be joined only when the membership ends after the class ends; otherwise buy or extend a plan first.`,
    `Waitlists are first-come; an offer stands for ${settings.waitlist_offer_hours}h. Under-${settings.minor_age}s cannot book or enrol on their own.`,
    // The screens by the names the member actually sees. Without these the model
    // made up steps and rules ("cancel at least 2 hours before") that the app does not have.
    `How to, in the app (Vietnamese menu name in brackets):
• Book a court: Book (Đặt sân) → pick a court and a free hour → hold → pay at the desk before the hold runs out.
• Cancel a court booking: open it under Book (Đặt sân) or on Home (Trang chủ) → Cancel (Huỷ). Possible any time before it starts, never after; no refund.
• Change the time of a court booking: Book (Đặt sân) → Change time (Đổi giờ) on that booking. Possible until ${settings.cancel_court_hours} hours before it starts, to a free slot of the same price, at no charge; closer to the start, or to a slot priced differently, the only way is to cancel (no refund) and book again.
• Join or leave a class: Classes (Lớp học). Attendance is under Classes → Attendance.
• Plans and their dates: Plans (Gói tập). Check-in QR code: Pass (Mã QR). Notifications: Notifications (Thông báo).
• Support requests and the desk's replies: Account › Support (Tài khoản › Hỗ trợ).
There is no cancellation deadline, fee or notice period other than what is written here.`,
    `Classes on sale:\n${onSale.map((c) => `• ${c.sport} ${c.level} · coach ${c.coach_name ?? "—"} · ${c.price_vnd.toLocaleString("en-US")}đ`).join("\n") || "—"}`,
    `Open classes:\n${classes.map((c) => `• ${c.sport} ${c.level} · coach ${c.coach_name ?? "—"} · ${c.enrolled_count}/${c.capacity}`).join("\n") || "No classes are open."}`,
    `Coaches:\n${COACHES.map((c) => `• ${c.name} — ${c.title}. ${c.blurb}`).join("\n")}`,
    `Member asking: ${user.full_name} (${user.member_code ?? "no member code yet"}).`,
    `Today's date (ICT): ${ictDateString()}.`,
    `Member's plans:\n${subs.map((s) => `• ${s.plan} · ${s.status} · ${s.start_on} → ${s.end_on} (${s.days_left} days left)`).join("\n") || "No plan ever bought."}`,
    `Member's classes:\n${myClasses.map((c) => `• ${c.sport} ${c.level} · ${c.status}${c.waitlist_pos !== null ? ` #${c.waitlist_pos}` : ""} · next session ${c.next_at ?? "none scheduled"}`).join("\n") || "Not enrolled in any class."}`,
    `Court bookings, next 7 days:\n${todayBookings.map((b) => `• ${b.court_code} ${b.start_at} (${b.status})`).join("\n") || "Nothing booked."}`,
    `Recent attendance:\n${recentAtt.map((a) => `• ${a.at} ${a.kind}${a.label ? ` ${a.label}` : ""}${a.result ? ` · ${a.result}` : ""}`).join("\n") || "No records."}`,
  ].join("\n\n");

  const system = `You are the ${centreName(settings)} front-desk assistant inside the member app. Reply in the language of the member's latest message (Vietnamese if they write in Vietnamese, otherwise English), keep it short (2–8 sentences), and stay strictly inside the DATA BLOCK.
No medical advice, no discounts beyond the listed prices, never invent a free slot.
Only name coaches and classes that appear in the data block.
Never state a rule, deadline, fee or step that is not in the DATA BLOCK. If the answer is not there, say you do not know and tell them to ask the desk or start a message with "ticket:" followed by what happened.
Walk them through the app with the screen names in "How to"; when replying in Vietnamese use the Vietnamese names. Payment is taken at the desk for each court booking or class they buy in the app.
Answer only the member's latest message; earlier turns are context.

DATA BLOCK:
${facts}`;

  const history = parseHistory(body.history, user.id);
  const turns: ChatTurn[] = [...history, { role: "user", text: message }];

  const ai = await generateAssistantReply(system, turns);
  const reply = (ai?.text ?? ruleReply(q, settings, onSale, classes, vi)).slice(0, MAX_BOT_TURN);
  const source = ai?.source ?? "rules";

  await audit(sql, user.id, "assistant", "chat", user.id, null, {
    q: message.slice(0, 200),
    source,
  });
  // Only a model's answer is sealed for the thread. A rule-based fallback fed
  // back as the model's own words taught it to repeat the canned line.
  const sig = ai ? signReply(user.id, message, reply) : undefined;
  return { status: 200, body: { reply, source, ...(sig ? { sig } : {}) } };
}

/**
 * What the assistant calls the centre when it talks to a member.
 *
 * Read from `center_settings` rather than written into the prompt: the centre
 * was renamed to Lê Long Sport (migration 0041) and the assistant carried on
 * introducing itself as Arena3 — to the one audience that would notice. The
 * fallback matches the invoice header's (`desk.ts`), so a blank row never
 * leaves a member reading "undefined".
 */
/**
 * Làm gì: Lấy tên hiển thị của trung tâm thể thao từ cấu hình hệ thống, dự phòng tên mặc định nếu chưa cấu hình.
 * Được gọi ở: ops.ts (trong assistantChat và ruleReply).
 * @param settings Đối tượng chứa tên pháp lý của trung tâm (legal_name).
 * @returns Tên trung tâm đã được cắt khoảng trắng thừa hoặc chuỗi mặc định "Lê Long Sport".
 */
function centreName(settings: { legal_name: string | null }): string {
  // `||`, not `??`: a settings row saved with the field cleared holds "", and
  // `??` would hand that straight to the member as " is open 06:00-22:00".
  return settings.legal_name?.trim() || "Lê Long Sport";
}

/** Letters only Vietnamese uses (đ, ơ, ư, ă, â, ê, ô and the tone marks): a message with them is Vietnamese. */
const VI_TEXT = /[đơưăâêô]|[̀-̣]|[Ạ-ỹ]|[àáãèéìíòóõùúýỳ]/i;

/**
 * Làm gì: Trả lời câu hỏi theo tập luật từ khóa (fallback) khi mô hình AI bên ngoài không khả dụng hoặc lỗi.
 * Được gọi ở: ops.ts (trong assistantChat).
 * @param q Câu hỏi của hội viên đã được chuyển thành chữ thường.
 * @param settings Thông tin cài đặt trung tâm (giờ mở/đóng cửa, thời gian giữ sân, thời hạn ưu đãi waitlist).
 * @param onSale Danh sách lớp học đang mở bán kèm mức giá (VND).
 * @param classes Danh sách lớp học đang tuyển học viên kèm sĩ số đã ghi danh và sức chứa.
 * @param vi Trả lời bằng tiếng Việt (hội viên viết tiếng Việt hoặc đang dùng giao diện tiếng Việt).
 * @returns Chuỗi văn bản trả lời phù hợp với nhóm chủ đề phát hiện được từ câu hỏi.
 */
function ruleReply(
  q: string,
  settings: Awaited<ReturnType<typeof getSettings>>,
  onSale: Array<{ sport: string; level: string; price_vnd: number }>,
  classes: Array<{ sport: string; level: string; enrolled_count: number; capacity: number }>,
  vi = false,
): string {
  const centre = centreName(settings);
  const open = `${settings.open_time.slice(0, 5)}–${settings.close_time.slice(0, 5)}`;
  // Bước 1: Khớp từ khóa hỏi về học phí, giá tiền -> Liệt kê danh sách lớp đang bán hoặc hướng dẫn hỏi quầy.
  if (/price|cost|how much|fee|giá/.test(q)) {
    const list = onSale.map((c) => `• ${c.sport} ${c.level}: ${c.price_vnd.toLocaleString("en-US")}đ`).join("\n");
    if (!onSale.length) return vi ? "Hiện chưa có lớp nào niêm yết giá — vui lòng hỏi quầy lễ tân." : "No class has a price listed right now — ask the desk.";
    return vi
      ? `Các lớp đang mở bán:\n${list}\nĐăng ký trong ứng dụng rồi thanh toán tại quầy.`
      : `Classes on sale:\n${list}\nPay at the desk after you enrol in the app.`;
  }
  // Bước 2: Khớp từ khóa hỏi về giờ hoạt động -> Cung cấp giờ mở/đóng cửa, thời gian giữ sân và chính sách hủy sân.
  if (/hour|open|close|what time|giờ|mở cửa/.test(q)) {
    return vi
      ? `${centre} mở cửa ${open} hằng ngày (giờ Việt Nam). Sân được giữ chỗ trong ${settings.hold_minutes} phút. Huỷ sân không được hoàn tiền.`
      : `${centre} is open ${open} every day (ICT). Court holds last ${settings.hold_minutes} minutes. Cancelling a court gives no refund.`;
  }
  // Bước 3: Khớp từ khóa hỏi về lớp học, huấn luyện viên -> Cung cấp danh sách lớp mở và sĩ số hiện tại.
  if (/class|coach|lesson|lớp|hlv/.test(q)) {
    const list = classes.map((c) => `• ${c.sport} ${c.level} (${c.enrolled_count}/${c.capacity})`).join("\n");
    if (!classes.length) return vi ? "Hiện chưa có lớp nào mở — vui lòng hỏi quầy lễ tân." : "No classes are open right now — ask the desk.";
    return vi ? `Các lớp đang mở:\n${list}` : `Open classes:\n${list}`;
  }
  // Bước 4: Khớp từ khóa hỏi về đặt sân, giữ chỗ hoặc hủy lịch -> Giải thích quy định giữ chỗ và chính sách hoàn tiền.
  if (/cancel|book|hold|hủy|huỷ|đặt sân/.test(q)) {
    return vi
      ? `Đặt sân trong ứng dụng thì chỗ được giữ ${settings.hold_minutes} phút. Huỷ sân hoặc lớp không được hoàn tiền, nên hãy kiểm tra giờ trước. Nếu trung tâm huỷ, bạn được hoàn tiền mặt tại quầy. Vắng mặt không được hoàn tiền.`
      : `Book in the app and the slot is held for ${settings.hold_minutes} minutes. Cancelling a court or a class gives no refund, so check the time first. If the centre cancels, you get the money back in cash at the desk. No-shows are not refunded.`;
  }
  // Bước 5: Khớp từ khóa hỏi về danh sách chờ khi lớp đầy -> Hướng dẫn cơ chế xếp hàng và thời hạn nhận suất trống.
  if (/waitlist|full|queue|chờ|đầy/.test(q)) {
    return vi
      ? `Lớp đã đầy thì bạn vào danh sách chờ theo thứ tự đăng ký. Khi có chỗ trống, bạn nhận lời mời giữ trong ${settings.waitlist_offer_hours} giờ — xác nhận trong ứng dụng.`
      : `When a class is full you join a first-come waitlist. If a seat frees up you get an offer that stands for ${settings.waitlist_offer_hours}h — claim it in the app.`;
  }
  // Bước 6: Phản hồi mặc định khi không khớp luật nào -> Tóm tắt các chủ đề hỗ trợ và gợi ý cú pháp "ticket:".
  return vi
    ? `Tôi có thể giúp về lịch, lớp học, huấn luyện viên, đặt và huỷ sân, danh sách chờ tại ${centre}. Bắt đầu tin nhắn bằng ticket: để gửi ghi chú cho quầy lễ tân. Tôi không đưa lời khuyên y tế.`
    : `I can help with the timetable, classes, coaches, booking and cancelling, and waitlists at ${centre}. Start a message with ticket: to send a note to the desk. I do not give medical advice.`;
}


/**
 * Làm gì: Tiếp nhận và tạo mới một yêu cầu hỗ trợ (ticket) từ hội viên gửi tới quầy lễ tân.
 * Được gọi ở:
 *   - src/server/controllers/router.ts (route POST /v1/tickets).
 *   - Màn hình Tài khoản /app/account (src/routes/account.tsx), tab Hỗ trợ (Support), form gửi ticket mới.
 *   - Test runner (node --test): src/server/controllers/tx.test.ts.
 * @param sql Kết nối database trong transaction do router mở.
 * @param request HTTP Request POST /v1/tickets chứa body JSON { body: string }.
 * @param user Thông tin hội viên đang đăng nhập (PublicUser).
 * @returns Phản hồi HTTP 201 kèm thông tin bản ghi ticket vừa tạo trong bảng tickets.
 * @throws Lỗi 403 nếu tính năng F6 bị tắt; Lỗi 422 nếu nội dung rỗng hoặc dưới 2 ký tự; Lỗi 429 nếu vượt hạn mức gửi ticket.
 */
export async function ticketsCreate(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra cờ tính năng F6, đảm bảo hệ thống hỗ trợ ticket của trung tâm đang hoạt động.
  await requireFlag(sql, "F6");
  // Bước 2: Đọc dữ liệu từ request, lọc bỏ tiền tố "ticket:" (nếu có) và giới hạn tối đa 2000 ký tự.
  // Same stripping as the assistant route: a member who typed "ticket:" into
  // the support box is repeating the habit the assistant taught them.
  const body = ticketBody(str((await readJson(request)).body) ?? "").slice(0, 2000);
  // Kiểm tra độ dài nội dung: từ chối nếu dưới 2 ký tự để tránh tạo yêu cầu rỗng lên quầy lễ tân.
  if (body.length < 2) throw err.validation("The message is empty.");
  // Bước 3: Áp dụng hạn ngạch rate limit tạo ticket (tối đa 3 ticket/phút và giới hạn theo giờ) trước khi ghi DB.
  ticketQuota(user.id);
  // Bước 4: Lưu ticket mới vào bảng tickets với trạng thái mặc định 'open' và trả về mã HTTP 201 Created.
  const row = await one(sql, `insert into tickets (user_id, body) values ($1,$2) returning *`, [user.id, body]);
  return { status: 201, body: row };
}

/**
 * The member's own side of customer care.
 *
 * Closed tickets come back too. A request that has been answered is the most
 * useful row on this screen — it is the answer — and hiding it the moment the
 * desk replies would mean the reply is only ever seen if the member happens to
 * be looking when the notification lands.
 */
/**
 * Làm gì: Lấy danh sách phân trang các ticket yêu cầu hỗ trợ của chính hội viên đang đăng nhập, kèm câu trả lời từ lễ tân (nếu có).
 * Được gọi ở:
 *   - src/server/controllers/router.ts (route GET /v1/tickets/mine).
 *   - Màn hình Tài khoản /app/account (src/routes/account.tsx), tab Hỗ trợ (Support).
 *   - Test runner (node --test): src/server/controllers/tx.test.ts.
 * @param sql Kết nối database trong transaction do router mở.
 * @param request HTTP Request GET /v1/tickets/mine chứa tham số phân trang query string (limit, offset).
 * @param user Thông tin hội viên đang đăng nhập (PublicUser).
 * @returns Phản hồi HTTP 200 dạng phân trang { items, total, limit, offset } danh sách ticket của hội viên.
 */
export async function ticketsMine(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Đọc tham số phân trang từ request (mặc định 50 bản ghi, tối đa 100 bản ghi mỗi trang).
  const { limit: take, offset } = pageParams(request, { def: 50, max: 100 });
  // Bước 2: Truy vấn danh sách ticket của hội viên (kèm cả ticket đã đóng để hội viên đọc lại câu trả lời).
  const rows = await sql.query<{ total: number } & Record<string, unknown>>(
    `select t.id, t.body, t.status, t.created_at, t.reply, t.replied_at,
            s.full_name as replied_by_name, count(*) over ()::int as total
       from tickets t
       left join users s on s.id = t.replied_by
      where t.user_id = $1
      order by t.created_at desc
      limit $2 offset $3`,
    [user.id, take, offset],
  );
  // Bước 3: Đóng gói kết quả theo định dạng phân trang chuẩn (pageOf) kèm tổng số lượng bản ghi.
  const body = await pageOf(rows, { limit: take, offset }, async () =>
    ((await one<{ n: number }>(sql, `select count(*)::int as n from tickets where user_id = $1`, [user.id]))?.n ?? 0),
  );
  return { status: 200, body };
}

/**
 * Làm gì: Lấy danh sách phân trang toàn bộ ticket hỗ trợ dành cho quầy lễ tân và quản lý; mặc định chỉ hiển thị các ticket đang mở (open).
 * Được gọi ở:
 *   - src/server/controllers/router.ts (route GET /v1/tickets).
 *   - Màn hình Quầy lễ tân /desk (src/routes/desk.index.tsx), danh sách Ticket.
 *   - Test runner (node --test): src/server/controllers/tx.test.ts.
 * @param sql Kết nối database trong transaction do router mở.
 * @param request HTTP Request GET /v1/tickets với query params (status=all | open, limit, offset).
 * @param user Thông tin nhân viên đang đăng nhập (PublicUser).
 * @returns Phản hồi HTTP 200 dạng phân trang { items, total, limit, offset } danh sách ticket kèm thông tin người gửi.
 * @throws Lỗi 403 nếu người dùng không có vai trò receptionist hoặc manager.
 */
export async function ticketsList(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn, chỉ nhân viên quầy (receptionist) hoặc quản lý (manager) mới được xem danh sách này.
  requireRole(user, ["receptionist", "manager"]);
  // Bước 2: Kiểm tra bộ lọc trạng thái: nếu status=all thì lấy cả ticket đã đóng, mặc định chỉ lấy ticket đang mở ('open').
  // The desk works the open queue, but wants to be able to read back what it
  // told somebody last week without opening the database.
  const all = new URL(request.url).searchParams.get("status") === "all";
  // Bước 3: Đọc tham số phân trang từ URL request (mặc định 50 bản ghi, tối đa 100).
  const { limit: take, offset } = pageParams(request, { def: 50, max: 100 });
  // Bước 4: Truy vấn danh sách ticket kèm thông tin hội viên gửi (tên, SĐT, mã hội viên) và nhân viên đã trả lời.
  const rows = await sql.query<{ total: number } & Record<string, unknown>>(
    `select t.id, t.body, t.status, t.created_at, t.reply, t.replied_at,
            u.full_name, u.phone, u.member_code,
            s.full_name as replied_by_name, count(*) over ()::int as total
       from tickets t
       left join users u on u.id = t.user_id
       left join users s on s.id = t.replied_by
      where ($1::bool or t.status = 'open')
      order by t.status = 'open' desc, t.created_at desc
      limit $2 offset $3`,
    [all, take, offset],
  );
  // Bước 5: Đóng gói kết quả theo định dạng phân trang chuẩn (pageOf).
  const body = await pageOf(rows, { limit: take, offset }, async () =>
    ((await one<{ n: number }>(sql, `select count(*)::int as n from tickets where ($1::bool or status = 'open')`, [all]))?.n ?? 0),
  );
  return { status: 200, body };
}

/**
 * Reception answers, and the member is told there is an answer.
 *
 * Replying closes the ticket in the same statement rather than leaving that as
 * a second button: an answered request that stays in the open queue is one a
 * colleague will answer again. Reopening is the member's move — they send
 * another note — which is also the honest signal that the first answer did not
 * land.
 *
 * So each request carries exactly one answer. A second attempt is refused
 * rather than written over the first, which is what used to happen and left
 * nobody able to see what the member had already been told.
 */
/**
 * Làm gì: Tiếp nhận câu trả lời từ lễ tân cho một ticket, cập nhật nội dung phản hồi, đóng ticket, gửi thông báo in-app cho hội viên và ghi audit log.
 * Được gọi ở:
 *   - src/server/controllers/router.ts (route POST /v1/tickets/:id/reply).
 *   - Màn hình Quầy lễ tân /desk (src/routes/desk.index.tsx), modal phản hồi ticket.
 *   - Test runner (node --test): src/server/controllers/tx.test.ts.
 * @param sql Kết nối database trong transaction do router mở.
 * @param id Mã UUID của ticket cần phản hồi.
 * @param request HTTP Request POST /v1/tickets/:id/reply chứa JSON { reply: string }.
 * @param user Thông tin nhân viên lễ tân/quản lý đang đăng nhập (PublicUser).
 * @returns Phản hồi HTTP 200 kèm bản ghi ticket đã được cập nhật câu trả lời.
 * @throws Lỗi 403 nếu không phải receptionist hoặc manager; Lỗi 404 nếu không tìm thấy ticket; Lỗi 409 nếu ticket đã được trả lời trước đó; Lỗi 422 nếu nội dung trả lời rỗng hoặc dưới 2 ký tự.
 */
export async function ticketReply(sql: Sql, id: string, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn, chỉ receptionist hoặc manager mới có quyền trả lời ticket.
  requireRole(user, ["receptionist", "manager"]);
  // Bước 2: Đọc nội dung phản hồi từ request body, cắt khoảng trắng và giới hạn tối đa 2000 ký tự.
  const reply = (str((await readJson(request)).reply) ?? "").trim().slice(0, 2000);
  // Kiểm tra hợp lệ: bắt buộc nội dung phản hồi phải có ít nhất 2 ký tự.
  if (reply.length < 2) throw err.validation("Write a reply first.");
  // Bước 3: Khóa bản ghi ticket (SELECT ... FOR UPDATE) để ngăn chặn tranh chấp khi hai nhân viên cùng trả lời.
  const t = await one<{ id: string; user_id: string | null; status: string; reply: string | null }>(
    sql,
    `select id, user_id, status, reply from tickets where id = $1 for update`,
    [id],
  );
  if (!t) throw err.notFound();
  // Bước 4: Kiểm tra trạng thái ticket: từ chối nếu ticket đã có câu trả lời trước đó (mỗi yêu cầu chỉ có một câu trả lời duy nhất).
  // An answer already sent is not overwritten. It is what the member was told
  // and what they can still read on their Support screen; replacing it would
  // leave no record that the first answer was ever given. 409 rather than 422:
  // the reply the desk typed is fine, the ticket is simply past this point.
  //
  // A ticket closed *without* an answer is still answerable — `ticketClose`
  // leaves exactly that state, and refusing it would turn Close into a trap
  // that swallows the request.
  if (t.reply) {
    throw err.conflictState("That request has already been answered. The member can reply to reopen it.");
  }
  // Bước 5: Cập nhật câu trả lời, ghi nhận thời điểm, nhân viên trả lời và tự động chuyển trạng thái ticket sang 'closed'.
  const row = await one(
    sql,
    `update tickets
        set reply = $2, replied_at = now(), replied_by = $3, status = 'closed'
      where id = $1
      returning *`,
    [id, reply, user.id],
  );
  // Bước 6: Nếu ticket thuộc về một hội viên đã đăng ký, gửi thông báo in-app kèm mã khóa tránh gửi lặp.
  // A ticket raised by a walk-in the desk typed in has nobody to notify.
  if (t.user_id) {
    await enqueue(
      sql,
      "inapp",
      "ticket_replied",
      t.user_id,
      { ticket_id: id, reply: reply.slice(0, 200) },
      // Keyed on the ticket alone. It used to carry `Date.now()`, which made
      // every call a new key and so turned `enqueue`'s `on conflict do nothing`
      // into a no-op — it was there for a second answer to the same ticket,
      // which the guard above no longer allows. One request, one answer, one
      // notification, even if Send is double-tapped.
      `ticket_replied|${id}`,
    );
  }
  // Bước 7: Ghi lại nhật ký kiểm toán (audit log) ghi nhận nhân viên đã trả lời ticket.
  await audit(sql, user.id, "ticket_reply", "ticket", id);
  return { status: 200, body: { ticket: row } };
}

/**
 * Reception closes a request without writing an answer.
 *
 * Used for the ones that need no reply — a duplicate, something already fixed,
 * a note the member followed up in person. The member is still told: their
 * Support screen showed "Waiting" for as long as the row existed, so closing
 * in silence meant the wait simply never visibly ended.
 *
 * Closing leaves `reply` null, which `ticketReply` reads as "still answerable":
 * the desk can change its mind and write back.
 */
/**
 * Làm gì: Đóng yêu cầu hỗ trợ mà không cần gửi câu trả lời (dùng khi ticket trùng lặp, đã giải quyết trực tiếp tại quầy hoặc không cần phản hồi).
 * Được gọi ở:
 *   - src/server/controllers/router.ts (route POST /v1/tickets/:id/close).
 *   - Màn hình Quầy lễ tân /desk (src/routes/desk.index.tsx), nút đóng ticket.
 *   - Test runner (node --test): src/server/controllers/tx.test.ts.
 * @param sql Kết nối database trong transaction do router mở.
 * @param id Mã UUID của ticket cần đóng.
 * @param user Thông tin nhân viên lễ tân/quản lý đang đăng nhập (PublicUser).
 * @returns Phản hồi HTTP 200 { ok: true }.
 * @throws Lỗi 403 nếu không phải receptionist hoặc manager; Lỗi 404 nếu không tìm thấy ticket.
 */
export async function ticketClose(sql: Sql, id: string, user: PublicUser) {
  // Bước 1: Kiểm tra phân quyền, chỉ nhân viên quầy (receptionist) hoặc quản lý (manager) mới được đóng ticket.
  requireRole(user, ["receptionist", "manager"]);
  // Bước 2: Khóa dòng ticket (SELECT ... FOR UPDATE) để đồng bộ trạng thái khi có thao tác đồng thời.
  const t = await one<{ id: string; user_id: string | null; status: string }>(
    sql,
    `select id, user_id, status from tickets where id = $1 for update`,
    [id],
  );
  if (!t) throw err.notFound();
  // Xử lý idempotent: nếu ticket đã đóng từ trước, trả về ok ngay mà không gửi trùng thông báo hay ghi thêm audit log.
  // Already closed. Answering `ok` is right — the caller wanted it closed and
  // it is — but a second audit row and a second notification are not: two
  // clicks on one button are still one decision.
  if (t.status === "closed") return { status: 200, body: { ok: true } };
  // Bước 3: Cập nhật trạng thái ticket thành 'closed' (giữ nguyên reply là null để lễ tân có thể trả lời sau nếu cần).
  await sql.query(`update tickets set status = 'closed' where id = $1`, [id]);
  // Bước 4: Nếu ticket thuộc về hội viên, gửi thông báo in-app báo ticket đã được đóng (dùng idempotency key để tránh trùng lặp).
  // A request the desk typed in for a walk-in has nobody to notify.
  if (t.user_id) {
    // Keyed on the ticket, not the moment: closing happens once.
    await enqueue(sql, "inapp", "ticket_closed", t.user_id, { ticket_id: id }, `ticket_closed|${id}`);
  }
  // Bước 5: Ghi nhật ký kiểm toán (audit log) ghi nhận nhân viên đã đóng ticket.
  await audit(sql, user.id, "ticket_close", "ticket", id);
  return { status: 200, body: { ok: true } };
}
