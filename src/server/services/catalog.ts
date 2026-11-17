/**
 * Dịch vụ cung cấp danh mục công khai (public catalog) và lịch sân trống cho khách vãng lai.
 * Phục vụ dữ liệu cho Landing Page (trang chủ "/") thông qua các Server Function của TanStack Start:
 * - getPublicAvailability: Tra cứu các ca bận/trống của từng sân theo ngày mà không yêu cầu đăng nhập, ẩn danh thông tin người đặt.
 * - getPublicCatalog: Tải danh mục tổng hợp gồm gói hội viên đang bán, lớp học mở, bảng giá theo khung giờ, giờ hoạt động và danh sách huấn luyện viên.
 */
import { createServerFn } from "@tanstack/react-start";

import type { CatalogPlan, CatalogClass, CatalogPrice, CatalogCourt, CatalogSlot } from "@/shared/arena3/contracts";

/**
 * Today's court schedule, for somebody who has not signed in.
 *
 * The first question a visitor has is "is there a court free at seven tonight",
 * and until now the only way to answer it was to create an account — which is
 * the wrong way round: nobody buys a membership to find out whether the place
 * has room for them. This is the same occupancy the booking grid draws, minus
 * the one thing that is nobody else's business: `ref_id`, the booking or
 * enrolment the hour belongs to. What is left is when the building is busy,
 * which is what a sign on the door would say anyway.
 */
/**
 * Làm gì: Tra cứu lịch bận và danh sách sân hoạt động theo ngày để hiển thị các ô giờ trống cho khách chưa đăng nhập trên Landing Page.
 * Được gọi ở: src/routes/index.tsx (loader của Route "/" khi tải trang, và useEffect khi người dùng chọn ngày xem lịch).
 * @param input Đối tượng chứa date (chuỗi ngày YYYY-MM-DD tùy chọn, mặc định lấy ngày hiện tại theo giờ ICT).
 * @returns Object chứa ngày tra cứu (date), danh sách sân (courts) và danh sách ca bận đã chuẩn hóa thời gian ISO (slots).
 * @throws Lỗi kết nối cơ sở dữ liệu nếu truy vấn SQL thất bại.
 */
export const getPublicAvailability = createServerFn({ method: "POST" })
  .inputValidator((input: { date?: string } | undefined) => {
    // Kiểm tra định dạng ngày YYYY-MM-DD; nếu không hợp lệ sẽ đặt chuỗi rỗng để handler dùng ngày hiện tại.
    const date = input?.date ?? "";
    return { date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "" };
  })
  .handler(async ({ data }) => {
    // Bước 1: Nạp kết nối database và xác định khoảng thời gian cả ngày [00:00, 24:00) theo múi giờ Việt Nam (ICT).
    const { getSql } = await import("@/server/data/db");
    const { ictDateString, ictDateTime } = await import("../../shared/arena3/time");
    const sql = await getSql();
    const date = data.date || ictDateString();
    // Lấy mốc bắt đầu (00:00) và kết thúc (24:00, cộng 1 phút sau 23:59) để bao quát trọn vẹn ngày được chọn theo giờ ICT.
    const start = ictDateTime(date, "00:00");
    const end = new Date(ictDateTime(date, "23:59").getTime() + 60_000);
    // Bước 2: Truy vấn song song danh sách sân đang hoạt động và các ca chiếm dụng trong ngày (ẩn danh thông tin đặt chỗ).
    const [courts, slots] = await Promise.all([
      sql.query<CatalogCourt>(
        `select id, court_code, sport, status
           from courts
          where retired_at is null
          order by sort_order nulls last, court_code`,
      ),
      sql.query<{ court_id: string; start_at: string | Date; end_at: string | Date; kind: string }>(
        `select court_id, start_at, end_at, kind
           from occupancies
          where start_at < $2 and end_at > $1
          order by court_id, start_at`,
        [start.toISOString(), end.toISOString()],
      ),
    ]);
    // Bước 3: Chuẩn hóa thời gian các ca bận về chuỗi ISO 8601 và trả về dữ liệu lịch sân cho client.
    return {
      date,
      courts,
      // Normalised here rather than left to the serializer: the two drivers
      // this runs on (pg and PGlite) hand back timestamps in different shapes,
      // and every reader of this downstream does `new Date(slot.start)`.
      slots: slots.map<CatalogSlot>((r) => ({
        court_id: r.court_id,
        start: new Date(r.start_at).toISOString(),
        end: new Date(r.end_at).toISOString(),
        kind: r.kind,
      })),
    };
  });

/**
 * Làm gì: Tải toàn bộ danh mục dịch vụ công khai cho Landing Page (gói hội viên, lớp học tiêu biểu, bảng giá, giờ hoạt động và danh sách huấn luyện viên).
 * Được gọi ở: src/routes/index.tsx (loader của Route "/" khi người dùng truy cập trang chủ).
 * @returns Object chứa danh sách plans, classes, prices, venue (giờ mở/đóng cửa và số phút giữ chỗ) và coaches.
 * @throws Lỗi kết nối cơ sở dữ liệu nếu truy vấn SQL thất bại.
 */
export const getPublicCatalog = createServerFn({ method: "POST" }).handler(async () => {
  // Bước 1: Khởi tạo kết nối database để chuẩn bị truy vấn danh mục.
  const { getSql } = await import("@/server/data/db");
  const sql = await getSql();
  // Bước 2: Tải song song 5 nhóm dữ liệu danh mục (gói hội viên, lớp học tiêu biểu, bảng giá, giờ mở/đóng cửa và HLV hoạt động).
  const [plans, classes, prices, venueRows, coaches] = await Promise.all([
    sql.query<CatalogPlan>(
      `select id, name, duration_days, session_quota, court_hours,
              court_discount_pct, price_vnd
         from membership_plans
        where is_on_sale = true
        order by price_vnd`,
    ),
    sql.query<CatalogClass>(
      `select id, sport, level, capacity, enrolled_count, rrule, duration_min, court_code, coach_name
         from (
           select distinct on (cl.court_id, cl.sport, cl.level, cl.rrule)
                  cl.id, cl.sport, cl.level, cl.capacity, cl.enrolled_count, cl.rrule, cl.duration_min,
                  c.court_code, u.full_name as coach_name
             from classes cl
             join courts c on c.id = cl.court_id
             join users u on u.id = cl.coach_id
            where cl.status = 'open'
            order by cl.court_id, cl.sport, cl.level, cl.rrule, cl.enrolled_count desc, cl.start_on
         ) s
        order by court_code, rrule`,
    ),
    sql.query<CatalogPrice>(
      `select sport, court_id, day_kind, start_local::text, end_local::text, price_vnd, is_peak
         from price_rules
        order by sport, day_kind, start_local`,
    ),
    sql.query<{ open_time: string; close_time: string; hold_minutes: number }>(
      `select open_time::text, close_time::text, hold_minutes from center_settings where id = 1`,
    ),
    // Active coaches of sports still on offer, minus any the manager switched off in Media, the
    // ones teaching the most open classes first.
    sql.query<{ id: string; name: string; sports: string[] }>(
      `select u.id, u.full_name as name, array_agg(distinct cs.sport::text) as sports
         from users u
         join coach_sports cs on cs.user_id = u.id
         join sports s on s.code = cs.sport::text and s.enabled and s.retired_at is null
        where u.role = 'coach' and u.status = 'active'
          and not exists (select 1 from site_assets a where a.slot = 'coach.' || u.id::text and not a.enabled)
        group by u.id, u.full_name
        order by (select count(*) from classes cl where cl.coach_id = u.id and cl.status = 'open') desc,
                 u.full_name`,
    ),
  ]);
  // Opening hours and hold length for the landing's copy and grid (see src/client/lib/venue.ts).
  // Bước 3: Đóng gói toàn bộ thông tin danh mục công khai và trả về cho Landing Page.
  return { plans, classes, prices, venue: venueRows[0] ?? null, coaches };
});
