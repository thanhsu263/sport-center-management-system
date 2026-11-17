/**
 * Quản lý và xử lý các background jobs (tác vụ chạy ngầm định kỳ) của hệ thống Arena3.
 * File này chứa các hàm nghiệp vụ tự động: cảnh báo ca trực quá giờ, nhắc lớp chưa đủ học viên tối thiểu,
 * giải phóng các giữ chỗ sân hết hạn (hold), đánh dấu khách không đến (no-show), tự động hoàn tất ca thuê sân,
 * cập nhật trạng thái gói tập hết hạn, gửi thông báo nhắc gia hạn gói tập và xả hàng đợi thông báo (outbox).
 * Được kích hoạt thông qua vòng lặp định kỳ startJobLoop từ router API.
 */
import { withTx } from "../controllers/tx";
import { elapsedAtLeast, ictDateString } from "../../shared/arena3/time";
import type { Sql } from "./db";
import { classCode } from "../../shared/arena3/labels";

// SQL tìm các ca trực thu ngân mở quá 16 tiếng chưa đóng (quên chốt ca) để báo quản lý; dedupe_key đảm bảo mỗi ca chỉ báo một lần cho mỗi manager.
const OVERDUE_SHIFT_DUE = `
  select s.id, s.receptionist_id, s.opened_at, manager.id as manager_id
    from cashier_shifts s
    join users manager on manager.role = 'manager' and manager.status = 'active'
   where s.closed_at is null and s.opened_at < now() - interval '16 hours'
     and not exists (
       select 1 from outbox o
        where o.dedupe_key = 'shift_overdue:' || s.id::text || ':' || manager.id::text
     )`;

/**
 * Làm gì: Quét các ca trực thu ngân mở quá 16 tiếng chưa đóng và tạo thông báo in-app (shift_overdue) gửi đến các quản lý (manager) đang hoạt động.
 * Được gọi ở: src/server/data/jobs.ts trong runDueJobs(); src/server/controllers/tx.test.ts.
 * @param sql Kết nối database (Sql client hoặc trong transaction).
 * @returns Số lượng bản ghi thông báo mới được chèn thành công vào bảng outbox.
 * @throws Lỗi cơ sở dữ liệu nếu truy vấn SELECT hoặc INSERT vào outbox thất bại.
 */
export async function notifyOverdueShifts(sql: Sql): Promise<number> {
  // Bước 1: Lấy danh sách ca trực mở quá 16 tiếng kèm danh sách manager đang active.
  const targets = await sql.query<{
    id: string; receptionist_id: string; opened_at: string; manager_id: string;
  }>(OVERDUE_SHIFT_DUE);
  // Bước 2: Duyệt từng ca trực và ghi thông báo in-app vào outbox; dedupe_key chống gửi trùng.
  let sent = 0;
  for (const shift of targets) {
    const inserted = await sql.query(
      `insert into outbox (channel, template, user_id, payload, dedupe_key, sent_at)
       values ('inapp', 'shift_overdue', $1, $2::jsonb, $3, now())
       on conflict (dedupe_key) do nothing returning id`,
      [shift.manager_id, JSON.stringify({
        shift_id: shift.id, receptionist_id: shift.receptionist_id, opened_at: shift.opened_at,
      }), `shift_overdue:${shift.id}:${shift.manager_id}`],
    );
    sent += inserted.length;
  }
  // Bước 3: Trả về số lượng thông báo thực tế được tạo mới.
  return sent;
}

// Shared by the due probe and the job so their eligibility cannot drift.
// Keep done sessions in the minimum: a later session is not another class start.
const CLASS_MINIMUM_DUE = `
  select cl.id, cl.sport, cl.level, cl.min_enrolled, seats.confirmed_count, manager.id as manager_id
    from classes cl
    cross join lateral (
      select min(start_at) as first_at from sessions
       where class_id = cl.id and status <> 'cancelled'
    ) first_session
    cross join lateral (
      select count(*)::int as confirmed_count from enrollments
       where class_id = cl.id and status = 'confirmed'
    ) seats
    join users manager on manager.role = 'manager' and manager.status = 'active'
   where cl.status = 'open' and seats.confirmed_count < cl.min_enrolled
     and first_session.first_at > now()
     and first_session.first_at <= now() + interval '24 hours'
     and not exists (
       select 1 from outbox o
        where o.dedupe_key = 'class_minimum:' || cl.id::text || ':' || manager.id::text
     )`;

/** Warn only; the manager decides whether to cancel. Run inside the job transaction. */
export async function notifyClassMinimums(sql: Sql): Promise<number> {
  // Bước 1: Lấy danh sách lớp sắp khai giảng trong 24 giờ tới nhưng chưa đạt sĩ số tối thiểu (min_enrolled).
  const targets = await sql.query<{
    id: string; sport: string; level: string; min_enrolled: number;
    confirmed_count: number; manager_id: string;
  }>(CLASS_MINIMUM_DUE);
  // Bước 2: Tạo thông báo in-app (template 'class_below_minimum') cho các manager; dedupe_key ngăn gửi trùng.
  let sent = 0;
  for (const c of targets) {
    const inserted = await sql.query(
      `insert into outbox (channel, template, user_id, payload, dedupe_key, sent_at)
       values ('inapp', 'class_below_minimum', $1, $2::jsonb, $3, now())
       on conflict (dedupe_key) do nothing returning id`,
      [c.manager_id, JSON.stringify({
        class_id: c.id, code: classCode(c.sport, c.level, c.id),
        confirmed_count: c.confirmed_count, min_enrolled: c.min_enrolled,
      }), `class_minimum:${c.id}:${c.manager_id}`],
    );
    sent += inserted.length;
  }
  // Bước 3: Trả về số lượng thông báo được tạo mới thành công.
  return sent;
}

/**
 * Làm gì: Quét các lượt đặt sân giữ chỗ tạm thời (status = 'hold') đã hết hạn giữ chỗ (hold_until < now()) và giải phóng sân, chuyển trạng thái sang 'cancelled'.
 * Được gọi ở: src/server/data/jobs.ts trong runDueJobs().
 * @returns Số lượng lượt đặt sân giữ chỗ đã được quét và xử lý hủy.
 * @throws Lỗi transaction database từ withTx nếu transaction thất bại.
 */
export async function expireHolds() {
  return withTx(async (sql) => {
    // Bước 1: Tìm các lượt đặt sân ở trạng thái 'hold' nhưng đã vượt quá thời hạn giữ chỗ (hold_until < now()).
    const rows = await sql.query<{ id: string }>(
      `select id from court_bookings where status = 'hold' and hold_until < now()`,
    );
    // Bước 2: Giải phóng từng lượt giữ chỗ qua occupancy_release_booking; bọc try/catch để lỗi của một đơn không làm gián đoạn cả lượt quét.
    for (const r of rows) {
      try {
        await sql.query(`select occupancy_release_booking($1::uuid, 'cancelled'::booking_status)`, [r.id]);
      } catch (e) {
        console.error("[job expire_holds]", r.id, e);
      }
    }
    // Bước 3: Trả về số lượng lượt đặt sân quá hạn đã xử lý.
    return rows.length;
  });
}

/**
 * Làm gì: Quét các đơn đặt sân đã xác nhận (status = 'confirmed') mà khách không đến nhận sân quá thời gian ân hạn (noshow_grace_minutes); chuyển sang 'no_show' và trả sân về trạng thái trống.
 * Được gọi ở: src/server/data/jobs.ts trong runDueJobs().
 * @returns Số lượng đơn đặt sân bị đánh dấu vắng mặt (no-show).
 * @throws Lỗi transaction database từ withTx nếu transaction thất bại.
 */
export async function markNoshow() {
  return withTx(async (sql) => {
    // Bước 1: Tìm các lượt đặt sân đã xác nhận nhưng giờ bắt đầu cộng thời gian ân hạn (noshow_grace_minutes) đã qua.
    const rows = await sql.query<{ id: string }>(
      `select b.id
         from court_bookings b
         join center_settings s on s.id = 1
        where b.status = 'confirmed'
          and b.start_at + (s.noshow_grace_minutes * interval '1 minute') < now()`,
    );
    // Bước 2: Gọi occupancy_release_booking chuyển sang 'no_show' và giải phóng lịch sân; bọc try/catch cho từng đơn.
    for (const r of rows) {
      try {
        await sql.query(`select occupancy_release_booking($1::uuid, 'no_show'::booking_status)`, [r.id]);
      } catch (e) {
        console.error("[job mark_noshow]", r.id, e);
      }
    }
    // Bước 3: Trả về số lượng đơn đặt sân bị đánh dấu no-show.
    return rows.length;
  });
}

/**
 * Làm gì: Quét các lượt đặt sân đang sử dụng (status = 'in_use') đã kết thúc quá 10 phút để tự động chuyển sang trạng thái hoàn tất ('completed') và đóng ca sử dụng sân.
 * Được gọi ở: src/server/data/jobs.ts trong runDueJobs().
 * @returns Số lượng lượt đặt sân được chuyển sang trạng thái completed.
 * @throws Lỗi transaction database từ withTx nếu transaction thất bại.
 */
export async function completeBookings() {
  return withTx(async (sql) => {
    // Bước 1: Tìm các lượt đặt sân đang dùng ('in_use') đã qua giờ kết thúc 10 phút (khoảng đệm sau giờ chơi để khách dọn sân).
    const rows = await sql.query<{ id: string }>(
      `select b.id
         from court_bookings b
         join center_settings s on s.id = 1
        where b.status = 'in_use'
          and b.end_at + interval '10 minutes' < now()`,
    );
    // Bước 2: Chuyển trạng thái sang 'completed' và kết thúc chiếm dụng sân qua occupancy_release_booking; bọc try/catch.
    for (const r of rows) {
      try {
        await sql.query(`select occupancy_release_booking($1::uuid, 'completed'::booking_status)`, [r.id]);
      } catch (e) {
        console.error("[job complete_bookings]", r.id, e);
      }
    }
    // Bước 3: Trả về số lượng lượt đặt sân đã hoàn tất.
    return rows.length;
  });
}

/**
 * Làm gì: Cập nhật trạng thái các gói hội viên (subscriptions) đang hoạt động ('active') sang hết hạn ('expired') khi ngày kết thúc (end_on) đã qua so với ngày hiện tại theo giờ ICT.
 * Được gọi ở: src/server/data/jobs.ts trong runDueJobs().
 * @returns Số lượng gói hội viên vừa được chuyển sang trạng thái expired.
 * @throws Lỗi transaction database từ withTx nếu câu lệnh SQL UPDATE thất bại.
 */
export async function subscriptionStatus() {
  return withTx(async (sql) => {
    // Bước 1: Chuyển status thành 'expired' cho các gói hội viên có ngày kết thúc (end_on) trước hôm nay theo múi giờ ICT.
    const rows = await sql.query(
      `update subscriptions
          set status = 'expired'
        where status = 'active'
          and end_on < (now() at time zone 'Asia/Ho_Chi_Minh')::date
        returning id`,
    );
    // Bước 2: Trả về số lượng gói hội viên vừa cập nhật hết hạn.
    return rows.length;
  });
}

/**
 * Làm gì: Quét các gói hội viên sắp hết hạn (trước 7 ngày, 3 ngày hoặc đúng hôm nay) và ghi thông báo in-app (sub_expiring) nhắc gia hạn vào outbox; dedupe_key chống gửi trùng trong ngày.
 * Được gọi ở: src/server/data/jobs.ts trong runDueJobs().
 * @returns Số lượng gói hội viên được quét để gửi thông báo nhắc hạn.
 * @throws Lỗi transaction database từ withTx nếu truy vấn hoặc ghi outbox thất bại.
 */
export async function expiryReminders() {
  return withTx(async (sql) => {
    // Bước 1: Lấy ngày hiện tại theo giờ ICT và tìm các gói hội viên có ngày hết hạn cách đúng 7 ngày, 3 ngày hoặc trong ngày hôm nay.
    const today = ictDateString();
    const targets = await sql.query<{ id: string; user_id: string; end_on: string }>(
      `select id, user_id, end_on::text
         from subscriptions
        where status = 'active'
          and end_on in (
            ($1::date + 7),
            ($1::date + 3),
            $1::date
          )`,
      [today],
    );
    // Bước 2: Duyệt từng gói, tính số ngày còn lại (chia 86.400.000 ms = 1 ngày) và tạo thông báo nhắc nhở kèm dedupe_key theo ngày.
    for (const t of targets) {
      const days = Math.round(
        (new Date(t.end_on).getTime() - new Date(today).getTime()) / 86400000,
      );
      const key = `${t.user_id}|${days}|${today}`;
      await sql.query(
        `insert into outbox (channel, template, user_id, payload, dedupe_key, sent_at)
         values ('inapp', 'sub_expiring', $1, $2::jsonb, $3, now())
         on conflict (dedupe_key) do nothing`,
        [t.user_id, JSON.stringify({ days, end_on: t.end_on }), key],
      );
    }
    // Bước 3: Trả về số lượng gói hội viên đã được quét để gửi nhắc nhở.
    return targets.length;
  });
}

/**
 * Hand queued notifications to their transport.
 *
 * Two things were wrong here. Everything was marked `sent_at = now()`
 * regardless — SMS was logged to the server console and email had no branch at
 * all, so a notification the centre believed it had sent had in fact gone
 * nowhere. And `attempts` was only incremented on the way past, which is to
 * say only on success: a transport that kept failing never counted a single
 * attempt, so the `attempts < 5` cap could not stop anything.
 *
 * Now a row is stamped sent only when the transport says it delivered;
 * otherwise the attempt is counted and the row stays in the queue until it
 * either goes out or hits the cap.
 */
export async function notifyFlush() {
  const { deliver } = await import("../integrations/notify");
  const { getSql } = await import("@/server/data/db");
  const sql = await getSql();
  // Bước 1: Lấy tối đa 50 thông báo chưa gửi (sent_at is null) và có số lần thử dưới 5 (attempts < 5) theo thứ tự tạo cũ nhất trước.
  const rows = await sql.query<{
    id: string;
    channel: string;
    template: string;
    payload: Record<string, unknown> | null;
    email: string | null;
    phone: string | null;
  }>(
    `select o.id, o.channel, o.template, o.payload, u.email, u.phone
       from outbox o
       left join users u on u.id = o.user_id
      where o.sent_at is null and o.attempts < 5
      order by o.created_at
      limit 50`,
  );
  let sent = 0;
  // Bước 2: Duyệt từng thông báo và chuyển cho bộ xử lý deliver (hỗ trợ in-app hoặc email).
  for (const r of rows) {
    const to = r.channel === "email" ? r.email : null;
    const result = await deliver({
      channel: r.channel as "inapp" | "email",
      template: r.template,
      to,
      payload: r.payload ?? {},
    });
    // Bước 3: Nếu gửi thành công, cập nhật sent_at và tăng attempts; nếu thất bại, giữ sent_at = null để thử lại và chỉ tăng attempts.
    if (result.sent) {
      await sql.query(`update outbox set sent_at = now(), attempts = attempts + 1 where id = $1`, [
        r.id,
      ]);
      sent += 1;
    } else {
      // Leave sent_at null so it is retried, but count the try so a
      // permanently failing message eventually stops.
      await sql.query(`update outbox set attempts = attempts + 1 where id = $1`, [r.id]);
      console.warn(`[notify] ${r.channel}/${r.template} not sent: ${result.detail ?? "unknown"}`);
    }
  }
  // Bước 4: Trả về số lượng thông báo đã gửi đi thành công trong lượt này.
  return sent;
}

/**
 * Withdraw payOS links whose court hold has lapsed.
 *
 * A live link outliving its slot means a customer can still pay for a court
 * somebody else now holds. Cancelling it at the gateway stops the money
 * arriving, which is a great deal simpler than refunding it afterwards.
 */
export async function expireGatewayLinks() {
  const { payosConfigured } = await import("../integrations/payos");
  // Bước 1: Bỏ qua nếu hệ thống chưa cấu hình tích hợp cổng thanh toán payOS
  if (!payosConfigured()) return 0;
  // Bước 2: Chạy trong transaction để quét và hủy các liên kết thanh toán trực tuyến quá hạn
  return withTx(async (sql) => {
    const { expireOnlineLinks } = await import("../controllers/handlers/online");
    return expireOnlineLinks(sql);
  });
}

/**
 * Làm gì: Hủy các lời mời vào danh sách chờ (waitlist) đã quá hạn nhưng học viên không thanh toán, giải phóng lượt và mời người tiếp theo.
 * Được gọi ở: src/server/data/jobs.ts (hàm runDueJobs); test runner (node --test trong src/server/controllers/tx.test.ts).
 * @returns Số lượng lời mời danh sách chờ đã hết hạn và được xử lý lại.
 * @throws Có thể quăng lỗi truy vấn nếu transaction cơ sở dữ liệu gặp sự cố.
 */
export async function waitlistExpire() {
  return withTx(async (sql) => {
    // Bước 1: Quét các lời mời danh sách chờ (waitlist_offers) đang ở trạng thái pending nhưng đã quá hạn (expires_at < now())
    const stale = await sql.query<{ id: string; enrollment_id: string; class_id: string }>(
      `select o.id, o.enrollment_id, e.class_id
         from waitlist_offers o
         join enrollments e on e.id = o.enrollment_id
        where o.status = 'pending' and o.expires_at < now()`,
    );
    // Bước 2: Duyệt từng lời mời quá hạn để hủy giữ chỗ và đẩy hàng chờ tiếp theo
    for (const r of stale) {
      // Class first, then the enrolment, as enrollmentDelete does.
      await sql.query(`select 1 from classes where id = $1 for update`, [r.class_id]);
      // Cập nhật trạng thái offer thành expired và hủy enrollment tương ứng
      await sql.query(`update waitlist_offers set status = 'expired' where id = $1`, [r.id]);
      await sql.query(
        `update enrollments set status = 'cancelled', waitlist_pos = null where id = $1 and status = 'waitlisted'`,
        [r.enrollment_id],
      );
      // Bước 3: Dồn lại số thứ tự danh sách chờ và gửi lời mời cho người tiếp theo
      const { compactWaitlist, inviteWaitlist } = await import("../controllers/handlers/ops");
      await compactWaitlist(sql, r.class_id);
      await inviteWaitlist(sql, r.class_id);
    }
    // Bước 4: Trả về số lượng lời mời quá hạn đã xử lý
    return stale.length;
  });
}

/**
 * Give back the seats of class holds nobody paid for, and offer them to the waitlist.
 * The `where` matches DUE_PROBE's expire_enrollment_holds clause exactly.
 * Class first, then enrolment, as everywhere else: each class is locked before
 * its enrolment, so a payment settling at the same moment queues behind this sweep.
 */
export async function expireEnrollmentHolds(): Promise<number> {
  return withTx(async (sql) => {
    // Bước 1: Lấy danh sách các lượt giữ chỗ lớp học (enrollments hold) đã quá thời hạn thanh toán (hold_until < now())
    const candidates = await sql.query<{ id: string; class_id: string }>(
      `select id, class_id from enrollments where status = 'hold' and hold_until < now()`,
    );
    const { inviteWaitlist } = await import("../controllers/handlers/ops");
    let n = 0;
    // Bước 2: Duyệt từng lượt giữ chỗ, khóa lớp học trước để đồng bộ thứ tự lock và tránh deadlock
    for (const c of candidates) {
      await sql.query(`select 1 from classes where id = $1 for update`, [c.class_id]);
      // Khóa dòng enrollment với skip locked để bỏ qua nếu luồng khác đang thanh toán hoặc đã hủy
      const [r] = await sql.query<{ id: string; class_id: string }>(
        `select id, class_id from enrollments
          where id = $1 and status = 'hold' and hold_until < now()
          for update skip locked`,
        [c.id],
      );
      if (!r) continue; // paid, released or locked by someone else since the first look
      // Bước 3: Hủy giữ chỗ, hoàn lại 1 suất trống cho lớp học và mời người tiếp theo trong danh sách chờ
      await sql.query(`update enrollments set status = 'cancelled', hold_until = null where id = $1 and status = 'hold'`, [r.id]);
      await sql.query(`update classes set enrolled_count = greatest(enrolled_count - 1, 0) where id = $1`, [r.class_id]);
      await inviteWaitlist(sql, r.class_id);
      n += 1;
    }
    // Bước 4: Trả về số lượng lượt giữ chỗ lớp học đã hủy thành công
    return n;
  });
}

/**
 * Làm gì: Tự động đóng điểm danh và hoàn tất các buổi học đã kết thúc quá 2 giờ, giải phóng lịch chiếm dụng của sân và HLV.
 * Được gọi ở: src/server/data/jobs.ts (hàm runDueJobs).
 * @returns Số lượng buổi học đã được giải phóng và chuyển sang trạng thái done.
 * @throws Lỗi từng buổi học được bắt nội bộ nên không quăng ra ngoài.
 */
export async function lockAttendance() {
  return withTx(async (sql) => {
    // Bước 1: Tìm các buổi học scheduled đã kết thúc quá 2 tiếng so với hiện tại
    const rows = await sql.query<{ id: string }>(
      `select id from sessions
        where status = 'scheduled' and end_at + interval '2 hours' < now()`,
    );
    // Bước 2: Gọi hàm SQL occupancy_release_session để chuyển trạng thái sang done và giải phóng tài nguyên chiếm dụng
    for (const r of rows) {
      try {
        await sql.query(`select occupancy_release_session($1::uuid, 'done'::session_status)`, [r.id]);
      } catch (e) {
        console.error("[job lock_attendance]", r.id, e);
      }
    }
    // Bước 3: Trả về tổng số lượng buổi học đã quét và xử lý
    return rows.length;
  });
}

/**
 * Làm gì: Tự động sinh các buổi học còn thiếu trong 14 ngày tới cho tất cả các lớp học đang mở (open).
 * Được gọi ở: src/server/data/jobs.ts (hàm runDueJobs, định kỳ mỗi 10 phút).
 * @returns Số lượng lớp học đã được sinh bổ sung buổi học thành công.
 * @throws Không quăng lỗi ra ngoài; lỗi ở từng lớp được bắt và ghi log riêng biệt.
 */
export async function generateSessions() {
  // Bước 1: Lấy danh sách ID của tất cả các lớp học đang ở trạng thái open
  const ids = await withTx(async (sql) =>
    sql.query<{ id: string }>(`select id from classes where status = 'open'`),
  );
  let n = 0;
  // Bước 2: Duyệt từng lớp học, mở transaction riêng để sinh các buổi học thiếu trong 14 ngày tới
  for (const r of ids) {
    try {
      await withTx(async (sql) => {
        const { materializeClassSessions } = await import("../controllers/handlers/classes");
        await materializeClassSessions(sql, r.id, null);
      });
      n += 1;
    } catch (e) {
      console.error("[job generate_sessions]", r.id, e);
    }
  }
  // Bước 3: Trả về tổng số lớp học đã tạo buổi thành công
  return n;
}

/**
 * Keep the demo court map and takings moving with the clock (0028).
 *
 * Seed bookings pinned to a migration date drain within a week: the no-show
 * sweep releases each one as its hour arrives. The SQL function refills the
 * book-ahead week and the days since it last ran, and does nothing unless
 * feature_flags DEMO_FILL is on.
 */
export async function demoFill() {
  return withTx(async (sql) => {
    // Gọi stored procedure demo_fill_calendar() để tự động điền lịch đặt sân giả lập nếu cờ DEMO_FILL bật
    const [row] = await sql.query<{ n: number }>(`select demo_fill_calendar() as n`);
    return row?.n ?? 0;
  });
}

/**
 * Làm gì: Khoảng thời gian định kỳ (10 phút) giữa các lần tự động sinh buổi học cho các lớp đang mở.
 * Được gọi ở: src/server/data/jobs.ts (hàm runDueJobs).
 */
export const GENERATE_SESSIONS_EVERY_MS = 10 * 60 * 1000;
/**
 * Làm gì: Khoảng thời gian định kỳ (1 giờ) giữa các lần chạy job bù lịch đặt sân mẫu cho môi trường demo.
 * Được gọi ở: src/server/data/jobs.ts (hàm runDueJobs).
 */
export const DEMO_FILL_EVERY_MS = 60 * 60 * 1000;

// Lưu cờ trạng thái vòng lặp và mốc thời gian chạy job trên globalThis để tránh khởi tạo trùng lặp khi HMR hoặc reload module
const g = globalThis as typeof globalThis & {
  __arena3Jobs__?: boolean;
  __arena3GenAt__?: number;
  __arena3DemoAt__?: number;
};

/**
 * One read that answers "does any job have work?" for all eight at once.
 *
 * Almost every pass has nothing to do, and the naive loop still paid full price
 * for that answer: eight `withTx` calls, each a BEGIN + scan + COMMIT. Against
 * Neon that is ~24 network round trips every 15 seconds — measured at ~7
 * seconds of chatter per pass, which every user request then queued behind.
 * One transaction-free `select` of eight `exists()` subqueries costs a single
 * round trip, and any job that does have work still runs in its own
 * transaction, so a failure in one can't roll back another.
 *
 * Each clause mirrors its job's own `where` exactly. Change one and you must
 * change the other, or the job will be skipped while it still has rows.
 */
const DUE_PROBE = `
  select
    exists(${OVERDUE_SHIFT_DUE}) as overdue_shift,
    exists(${CLASS_MINIMUM_DUE}) as class_minimum,
    exists(select 1 from court_bookings
            where status = 'hold' and hold_until < now())                              as expire_holds,
    exists(select 1 from court_bookings b join center_settings s on s.id = 1
            where b.status = 'confirmed'
              and b.start_at + (s.noshow_grace_minutes * interval '1 minute') < now())  as mark_noshow,
    exists(select 1 from court_bookings b join center_settings s on s.id = 1
            where b.status = 'in_use' and b.end_at + interval '10 minutes' < now())     as complete_bookings,
    exists(select 1 from outbox
            where sent_at is null and attempts < 5)                                     as notify_flush,
    exists(select 1 from payments p
            left join court_bookings b on p.ref_type = 'booking' and b.id = p.ref_id
            left join enrollments e on p.ref_type = 'enrollment' and e.id = p.ref_id
            where p.status::text = 'pending' and p.provider = 'payos'
              and (case when p.ref_type = 'enrollment'
                        then e.id is null or e.status::text <> 'hold' or e.hold_until < now()
                        else b.id is null or b.status <> 'hold' or b.hold_until < now() end)) as expire_links,
    exists(select 1 from waitlist_offers
            where status = 'pending' and expires_at < now())                            as waitlist_expire,
    exists(select 1 from enrollments
            where status = 'hold' and hold_until < now())                               as expire_enrollment_holds,
    exists(select 1 from sessions
            where status = 'scheduled' and end_at + interval '2 hours' < now())         as lock_attendance,
    exists(select 1 from subscriptions
            where status = 'active'
              and end_on < (now() at time zone 'Asia/Ho_Chi_Minh')::date)               as subscription_status,
    exists(select 1 from subscriptions
            where status = 'active'
              and end_on in ((now() at time zone 'Asia/Ho_Chi_Minh')::date + 7,
                             (now() at time zone 'Asia/Ho_Chi_Minh')::date + 3,
                             (now() at time zone 'Asia/Ho_Chi_Minh')::date))            as expiry_reminders
`;

type DueFlags = {
  overdue_shift: boolean;
  class_minimum: boolean;
  expire_holds: boolean;
  mark_noshow: boolean;
  complete_bookings: boolean;
  notify_flush: boolean;
  expire_links: boolean;
  waitlist_expire: boolean;
  expire_enrollment_holds: boolean;
  lock_attendance: boolean;
  subscription_status: boolean;
  expiry_reminders: boolean;
};

/**
 * Làm gì: Quét nhanh một lượt tất cả các tác vụ nền qua DUE_PROBE và kích hoạt các job có công việc cần xử lý.
 * Được gọi ở: src/server/data/jobs.ts (hàm startJobLoop).
 * @returns Promise<void>
 * @throws Không quăng ngoại lệ ra ngoài; toàn bộ lỗi được bắt trong khối try/catch và ghi log.
 */
export async function runDueJobs() {
  try {
    // Bước 1: Thực thi câu lệnh DUE_PROBE duy nhất kiểm tra đồng thời tất cả các job có việc cần làm hay không
    const { getSql } = await import("@/server/data/db");
    const sql = await getSql();
    const [due] = await sql.query<DueFlags>(DUE_PROBE);
    if (!due) return;
    // Bước 2: Kích hoạt các job riêng biệt tương ứng với cờ báo hiệu có dữ liệu cần xử lý (mỗi job chạy transaction riêng)
    if (due.overdue_shift) await withTx(notifyOverdueShifts);
    if (due.class_minimum) await withTx(notifyClassMinimums);
    if (due.expire_holds) await expireHolds();
    if (due.mark_noshow) await markNoshow();
    if (due.complete_bookings) await completeBookings();
    if (due.notify_flush) await notifyFlush();
    if (due.expire_links) await expireGatewayLinks();
    if (due.waitlist_expire) await waitlistExpire();
    if (due.expire_enrollment_holds) await expireEnrollmentHolds();
    if (due.lock_attendance) await lockAttendance();
    if (due.subscription_status) await subscriptionStatus();
    if (due.expiry_reminders) await expiryReminders();
    // Bước 3: Kiểm tra và kích hoạt các job định kỳ theo mốc thời gian đã trôi qua (sinh buổi học mới và điền lịch demo)
    const now = Date.now();
    if (elapsedAtLeast(g.__arena3GenAt__, now, GENERATE_SESSIONS_EVERY_MS)) {
      g.__arena3GenAt__ = now;
      await generateSessions();
    }
    if (elapsedAtLeast(g.__arena3DemoAt__, now, DEMO_FILL_EVERY_MS)) {
      g.__arena3DemoAt__ = now;
      await demoFill();
    }
  } catch (e) {
    console.error("[jobs]", e);
  }
}

/**
 * Làm gì: Bắt đầu vòng lặp chạy nền các tác vụ định kỳ của hệ thống với chu kỳ mỗi 15 giây.
 * Được gọi ở: src/server/controllers/router.ts (hàm createAppRouter khi khởi động server).
 * @returns void
 * @throws Không quăng ngoại lệ.
 */
export function startJobLoop() {
  // Bước 1: Kiểm tra cờ toàn cục để tránh đăng ký lặp nhiều vòng lặp khi reload module
  if (g.__arena3Jobs__) return;
  g.__arena3Jobs__ = true;
  // Bước 2: Chạy ngay một lượt đầu tiên và thiết lập timer định kỳ mỗi 15 giây (15.000 ms)
  void runDueJobs();
  setInterval(() => void runDueJobs(), 15_000);
}
