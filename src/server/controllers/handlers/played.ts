/**
 * Every stretch of court time that is or was taken, as one row source.
 *
 * `occupancies` only holds what is live: when a booking completes or a class
 * session is marked done, its occupancy row is deleted. Reports and the court
 * map read past days too, so finished play is added back from the source
 * tables. A released row has `occupancy_id` null, so nothing is counted twice.
 */
/**
 * Làm gì: Đoạn truy vấn SQL con (subquery) hợp nhất toàn bộ các khoảng thời gian sân thể thao đã hoặc đang bị chiếm dụng (đặt sân, lớp học, bảo trì).
 *   Bảng occupancies chỉ lưu các ca đang diễn ra; khi ca kết thúc, hàng tương ứng bị xóa. Subquery này union thêm các ca đã hoàn tất từ court_bookings và sessions (với điều kiện occupancy_id is null) để phục vụ tra cứu lịch sử và báo cáo mà không bị tính trùng lặp.
 * Được gọi ở:
 *   - src/server/controllers/handlers/bookings.ts: hàm occupancyGet (route GET /v1/occupancies).
 *   - src/server/controllers/handlers/desk.ts: hàm courtOccupancySummaryReportGet (route GET /v1/reports/court-occupancy).
 *   - src/server/controllers/handlers/reports.ts: hàm utilizationReportBody (route GET /v1/reports/utilization).
 */
export const PLAYED_SQL = `(
  select id, court_id, start_at, end_at, kind::text as kind, ref_id from occupancies
  union all
  select id, court_id, start_at, end_at, 'booking', id from court_bookings
   where status = 'completed' and occupancy_id is null
  union all
  select id, court_id, start_at, end_at, 'session', id from sessions
   where status = 'done' and occupancy_id is null
)`;
