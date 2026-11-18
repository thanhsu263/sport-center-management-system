/**
 * Freeing a court's commitments when it goes out of service: shared by the maintenance
 * work orders (extras.ts) and the manager's court status switch (bookings.ts), so both
 * routes cancel and refund the same bookings and tell the same people.
 */
import type { Sql } from "@/server/data/db";
import { reconcileLoyaltyRefund } from "../../services/loyalty";
import { restoreIfFullyRefunded } from "../../services/promos";
import { err } from "../errors";
import { audit, enqueue, nextCode } from "../helpers";
import type { PublicUser } from "../session";
import { one } from "../tx";

/** Runs in the work-order transaction: a refusal leaves no ticket or side effects. */
/**
 * Làm gì: Xử lý giải phóng các cam kết sử dụng sân (lịch đặt sân và buổi dạy lớp) khi đóng sân để bảo trì.
 * Nếu chưa xác nhận (confirm = false), ném lỗi 409 cảnh báo số lượng lịch bị ảnh hưởng kèm chi tiết.
 * Khi đã xác nhận, tự động hủy lịch đặt sân, hoàn tiền 100% bằng tiền mặt tại quầy, thu hồi điểm thưởng và gửi thông báo in-app.
 * Được gọi ở:
 * - extras.ts: workOrdersCreate và workOrdersPatch (khi phiếu bảo trì có cờ blocks_court = true).
 * - bookings.ts: patchCourtStatus (khi quản lý chuyển sân đang mở sang bảo trì hoặc đóng).
 * @param sql Kết nối database trong transaction; rollback toàn bộ nếu có lỗi xảy ra.
 * @param courtId ID của sân thể thao bị đóng để bảo trì.
 * @param confirm Cờ xác nhận từ người dùng (true nếu đã đồng ý hủy các lịch bị ảnh hưởng).
 * @param user Thông tin nhân viên thực hiện thao tác.
 * @returns Không trả về giá trị (Promise<void>).
 * @throws Lỗi 409 yêu cầu xác nhận kèm danh sách lịch đặt và buổi học bị ảnh hưởng nếu confirm = false.
 */
export async function blockCourtCommitments(sql: Sql, courtId: string, confirm: boolean, user: PublicUser) {
  // Bước 1: Khóa dòng sân và tìm tất cả lượt đặt sân ('hold', 'confirmed') cùng các buổi học sắp tới chưa diễn ra.
  await sql.query(`select id from courts where id = $1 for update`, [courtId]);
  const bookings = await sql.query<{ id: string; code: string; start_at: string; user_id: string; paid_vnd: number }>(
    `select id, code, start_at, user_id, paid_vnd from court_bookings
      where court_id = $1 and status in ('hold','confirmed') and start_at >= now()
      order by start_at, id for update`, [courtId],
  );
  const sessions = await sql.query<{ id: string; class_id: string; start_at: string; coach_id: string }>(
    `select s.id, s.class_id, s.start_at, c.coach_id from sessions s join classes c on c.id = s.class_id
      where s.court_id = $1 and s.status = 'scheduled' and s.start_at >= now()
      order by s.start_at, s.id for update of s`, [courtId],
  );
  // Bước 2: Nếu phát hiện lịch bị ảnh hưởng mà client chưa xác nhận (confirm = false), chặn lại và trả danh sách để người dùng xác nhận.
  if (!confirm && (bookings.length || sessions.length)) {
    throw err.conflictState("This court has upcoming bookings or class sessions. Confirm before blocking it.", {
      requires_confirm: true,
      affected: {
        booking_count: bookings.length, session_count: sessions.length,
        bookings: bookings.slice(0, 5).map(({ id, code, start_at }) => ({ id, code, start_at })),
        sessions: sessions.slice(0, 5).map(({ id, start_at }) => ({ id, start_at })),
      },
    });
  }
  // Bước 3: Hủy từng lượt đặt sân bị ảnh hưởng: hoàn 100% tiền mặt không thu phí vì lỗi xuất phát từ phía cơ sở vật chất.
  for (const booking of bookings) {
    // Include earlier desk refunds in the cap, including cash still awaiting collection.
    await sql.query(`select id from users where id = $1 for update`, [booking.user_id]);
    const returned = await one<{ amount: number }>(sql,
      `select coalesce(-sum(amount_vnd), 0)::int as amount from payments
        where ref_type = 'booking' and ref_id = $1 and amount_vnd < 0 and status in ('posted','refund_pending')`, [booking.id]);
    // Trừ đi số tiền đã hoàn trước đó (nếu có) để tính số tiền hoàn trả còn lại chính xác.
    const refund = Math.max(0, booking.paid_vnd - (returned?.amount ?? 0));
    // Giải phóng trạng thái giữ chỗ (occupancy) của sân và cập nhật chính sách hoàn 100% (không tính phí hủy).
    await sql.query(`select occupancy_release_booking($1::uuid, 'cancelled'::booking_status)`, [booking.id]);
    await sql.query(`update court_bookings set cancel_refund_pct = 100, cancel_fee_vnd = 0 where id = $1`, [booking.id]);
    // Tạo giao dịch hoàn tiền mặt ở trạng thái 'refund_pending' (số tiền âm) để khách đến quầy nhận lại tiền.
    if (refund > 0) {
      await sql.query(
        `insert into payments (code,user_id,method,amount_vnd,vat_rate,status,ref_type,ref_id,created_by)
         values ($1,$2,'cash',$3,0,'refund_pending','booking',$4,$5)`,
        [await nextCode(sql, "PAY"), booking.user_id, -refund, booking.id, user.id],
      );
      // Thu hồi điểm thưởng tương ứng và khôi phục voucher/mã giảm giá nếu đơn được hoàn đủ 100%.
      await reconcileLoyaltyRefund(sql, booking.user_id);
      await restoreIfFullyRefunded(sql, "booking", booking.id);
    }
    // Gửi thông báo in-app cho khách hàng và ghi nhật ký kiểm toán với lý do 'court_maintenance'.
    await enqueue(sql, "inapp", "booking_cancelled", booking.user_id,
      { id: booking.id, fee_vnd: 0, refund_vnd: refund }, `booking_cancelled|${booking.id}`);
    await audit(sql, user.id, "cancel_booking", "booking", booking.id, null,
      { refund_pct: 100, fee_vnd: 0, refund_vnd: refund, reason: "court_maintenance" });
  }
  // Bước 4: Đối với các buổi học lớp, gửi thông báo in-app đến HLV phụ trách và tất cả quản lý để kịp thời sắp xếp đổi sân.
  if (sessions.length) {
    const managers = await sql.query<{ id: string }>(`select id from users where role = 'manager' and status = 'active'`);
    const activation = crypto.randomUUID();
    for (const session of sessions) {
      for (const recipient of new Set([...managers.map((m) => m.id), session.coach_id])) {
        await enqueue(sql, "inapp", "maintenance_session", recipient,
          { session_id: session.id, class_id: session.class_id, court_id: courtId, start_at: session.start_at },
          `maintenance_session|${activation}|${session.id}|${recipient}`);
      }
    }
    // Bước 5: Báo cho học viên của từng lớp bị ảnh hưởng: một thông báo mỗi lớp, nêu buổi sớm nhất và số buổi.
    // The sessions stay scheduled until staff move or cancel them, and those steps notify again.
    const byClass = new Map<string, { first: string; count: number }>();
    for (const session of sessions) {
      const cur = byClass.get(session.class_id);
      if (cur) cur.count += 1;
      else byClass.set(session.class_id, { first: session.start_at, count: 1 });
    }
    for (const [classId, info] of byClass) {
      const students = await sql.query<{ user_id: string; sport: string; level: string }>(
        `select e.user_id, c.sport, c.level from enrollments e join classes c on c.id = e.class_id
          where e.class_id = $1 and e.status in ('confirmed','hold')`,
        [classId],
      );
      for (const st of students) {
        await enqueue(sql, "inapp", "class_court_maintenance", st.user_id,
          { class_id: classId, sport: st.sport, level: st.level, court_id: courtId, start_at: info.first, session_count: info.count },
          `class_court_maintenance|${activation}|${classId}|${st.user_id}`);
      }
    }
  }
}
