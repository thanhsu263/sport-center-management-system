/**
 * Module xử lý báo cáo và phân tích số liệu (Reports & Analytics) cho trung tâm thể thao Arena 3.
 * Đảm nhiệm tính toán công suất sân (court capacity - FR-CRT-09), thống kê hội viên & lớp học (FR-PAY-06),
 * và điều phối xuất các báo cáo ra file định dạng Excel (.xlsx) hoặc PDF (.pdf) (FR-PAY-07).
 */
import { PLAYED_SQL } from "./played";
import { pct1, summarizeCapacity, type CapacityCell } from "../../services/capacity";
import type { Sql } from "@/server/data/db";
import { err } from "../errors";
import { getSettings } from "../helpers";
import { classCode, formatDate, methodLabel, registerSportNames, sourceLabel, sportLabel } from "../../../shared/arena3/labels";
import { buildReportPdf, buildXlsx, type ReportDoc } from "../../data/report-files";
import { requireRole, type PublicUser } from "../session";
import { addDays, ictDateString } from "../../../shared/arena3/time";
import { one } from "../tx";
import { atRiskBody, attendanceReportBody } from "./attendance";
import { previousWindow, reportDay, revenueBody, revenueParams } from "./desk";
import { getActiveSportCodes } from "./sports";

/** Longest window a report will scan. A quarter, plus slack; a year is a trend, not a report. */
const MAX_DAYS = 93;

/**
 * Làm gì: Trích xuất và xác thực khoảng thời gian báo cáo (từ ngày from đến ngày to) và môn thể thao từ query parameters; đảm bảo thời gian hợp lệ và không vượt quá MAX_DAYS (93 ngày).
 * Được gọi ở: reportsCapacity (line 75), reportsMembers (line 148), reportDoc (line 175)
 * @param sql Đối tượng truy vấn cơ sở dữ liệu Sql
 * @param request Request HTTP chứa URL query parameters (?from=...&to=...&sport=...)
 * @returns Đối tượng chứa { from, to, sport } đã được chuẩn hóa và kiểm tra hợp lệ
 * @throws err.field("to", ...) nếu ngày kết thúc trước ngày bắt đầu
 * @throws err.field("from", ...) nếu khoảng thời gian dài hơn MAX_DAYS (93 ngày)
 * @throws err.field("sport", ...) nếu mã môn thể thao không tồn tại hoặc không hoạt động
 */
async function windowParams(sql: Sql, request: Request) {
  // Bước 1: Trích xuất khoảng ngày lọc từ URL, mặc định 7 ngày gần nhất (đến ngày hiện tại theo giờ ICT)
  const sp = new URL(request.url).searchParams;
  const to = reportDay(sp, "to", ictDateString());
  const from = reportDay(sp, "from", addDays(to, -6));
  // Bước 2: Kiểm tra tính hợp lệ của khoảng thời gian (from phải nhỏ hơn hoặc bằng to)
  if (from > to) throw err.field("to", "The end date is before the start date.");
  // 86,400,000 ms tương ứng 1 ngày (24 * 60 * 60 * 1000) để quy đổi khoảng cách mili-giây sang số ngày; chặn không vượt quá MAX_DAYS (93 ngày)
  if (Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1 > MAX_DAYS) {
    throw err.field("from", `Pick a period of at most ${MAX_DAYS} days.`);
  }
  // Bước 3: Lấy mã môn thể thao lọc và kiểm tra có nằm trong danh sách các môn đang hoạt động hay không
  const sport = sp.get("sport") || null;
  if (sport && !(await getActiveSportCodes(sql)).includes(sport)) throw err.field("sport", "Unknown sport.");
  return { from, to, sport };
}

// ---- court capacity (FR-CRT-09) ----------------------------------------------

/**
 * Làm gì: Tính toán số liệu công suất sử dụng sân (FR-CRT-09) trong khoảng ngày yêu cầu; thống kê tổng số phút mở/bán, tỷ lệ lấp đầy theo môn, theo khung giờ (heatmap) và doanh thu tách biệt giữa thuê sân lẻ vs học phí lớp.
 * Được gọi ở: reportsCapacity (line 76), capacityDocument (line 313)
 * @param sql Đối tượng truy vấn cơ sở dữ liệu Sql
 * @param from Ngày bắt đầu định dạng YYYY-MM-DD
 * @param to Ngày kết thúc định dạng YYYY-MM-DD
 * @param sport Mã môn thể thao cần lọc, hoặc null nếu thống kê tất cả các môn
 * @returns Dữ liệu tổng hợp công suất sử dụng sân chi tiết theo môn, theo giờ, theo từng sân và doanh thu
 */
export async function capacityBody(sql: Sql, from: string, to: string, sport: string | null) {
  // Bước 1: Đọc cấu hình giờ mở/đóng cửa trung tâm từ bảng settings và tính tổng số ngày trong kỳ báo cáo
  const settings = await getSettings(sql);
  // Lấy 2 ký tự đầu làm giờ mở/đóng cửa (HH); mặc định mở cửa 6h và đóng cửa 22h nếu chưa có cấu hình
  const openHour = Math.max(0, parseInt(String(settings.open_time).slice(0, 2), 10) || 6);
  const closeHour = Math.min(24, parseInt(String(settings.close_time).slice(0, 2), 10) || 22);
  const daysTotal = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1);

  // Bước 2: Truy vấn số phút sân đã bán (đặt sân hoặc buổi học) theo từng khung giờ và từng sân
  const cells = await loadCapacityCells(sql, from, to, sport, openHour, closeHour);
  // Bước 3: Lấy các khung giờ cao điểm (is_peak) từ bảng price_rules để tính riêng tỷ lệ lấp đầy giờ vàng
  const rules = await sql.query<{ sport: string; start_min: number; end_min: number }>(
    `select sport::text, start_min, end_min from price_rules where is_peak`,
  );
  // Bước 4: Tổng hợp dữ liệu công suất qua service summarizeCapacity (chia theo môn, theo giờ, theo sân)
  const { hours, courts, all, bySport, byHour } = summarizeCapacity(cells, rules, openHour, closeHour, daysTotal);
  // Bước 5: Lấy doanh thu từ revenueBody để đối chiếu giữa tiền thuê sân lẻ và học phí lớp học
  // Court rental against class tuition — the report is asked to keep them apart.
  const revenue = (await revenueBody(sql, from, to, null, false)).body.by_source as Record<string, number>;
  // Bước 6: Trả về kết quả tổng hợp công suất hoàn chỉnh cho API hoặc xuất file
  return {
    from,
    to,
    sport,
    days_total: daysTotal,
    open_hour: openHour,
    close_hour: closeHour,
    totals: { sold_min: all.sold, open_min: all.open, pct: pct1(all.sold, all.open) },
    by_sport: [...bySport.entries()].map(([sp, v]) => ({
      sport: sp,
      sold_min: v.sold,
      open_min: v.open,
      pct: pct1(v.sold, v.open),
      peak_pct: v.peakOpen ? pct1(v.peakSold, v.peakOpen) : null,
      offpeak_pct: v.offOpen ? pct1(v.offSold, v.offOpen) : null,
    })),
    by_hour: hours.map((h) => ({ hour: h, pct: pct1(byHour.get(h)?.sold ?? 0, byHour.get(h)?.open ?? 0) })),
    hours,
    courts,
    revenue_by_source: {
      court_vnd: revenue.booking ?? 0,
      // Class seats are paid as `enrollment`; `class` is kept for older rows.
      class_vnd: (revenue.enrollment ?? 0) + (revenue.class ?? 0),
    },
  };
}

/**
 * Làm gì: Handler xử lý yêu cầu API báo cáo công suất sân; kiểm tra quyền manager, trích xuất tham số và trả về kết quả JSON.
 * Được gọi ở: src/server/controllers/router.ts tại route GET /api/reports/capacity và GET /api/manager/capacity
 * @param sql Đối tượng truy vấn cơ sở dữ liệu Sql
 * @param request Request HTTP từ client chứa các query params
 * @param user Thông tin người dùng đang thực hiện request (yêu cầu role manager)
 * @returns Object phản hồi gồm HTTP status 200 và body chứa dữ liệu công suất
 * @throws err.forbidden nếu user không có vai trò manager
 * @throws err.field nếu tham số ngày hoặc môn thể thao không hợp lệ
 */
export async function reportsCapacity(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Xác thực quyền hạn - chỉ người quản lý (manager) mới có quyền xem báo cáo công suất sân
  requireRole(user, ["manager"]);
  // Bước 2: Đọc và kiểm tra tính hợp lệ của khoảng thời gian và môn thể thao từ query string
  const { from, to, sport } = await windowParams(sql, request);
  // Bước 3: Tính toán dữ liệu công suất sân và trả về HTTP status 200 kèm payload
  return { status: 200, body: await capacityBody(sql, from, to, sport) };
}

// ---- members and class sign-ups (FR-PAY-06) ------------------------------------

/**
 * Làm gì: Thống kê số lượng hội viên và đăng ký lớp học (FR-PAY-06); đếm hội viên mới, hội viên hoạt động, xu hướng tăng trưởng 12 tháng và danh sách lớp học kèm tỷ lệ lấp đầy/điểm danh.
 * Được gọi ở: reportsMembers (line 149), membersDocument (line 354)
 * @param sql Đối tượng truy vấn cơ sở dữ liệu Sql
 * @param from Ngày bắt đầu kỳ báo cáo định dạng YYYY-MM-DD
 * @param to Ngày kết thúc kỳ báo cáo định dạng YYYY-MM-DD
 * @param sport Mã môn thể thao cần lọc, hoặc null nếu thống kê tất cả các môn
 * @returns Object chứa số liệu hội viên mới/hoạt động, biểu đồ xu hướng 12 tháng và danh sách lớp học
 */
export async function membersReportBody(sql: Sql, from: string, to: string, sport: string | null) {
  // Bước 1: Đếm số hội viên mới tạo tài khoản và hội viên hoạt động (có đặt sân hợp lệ hoặc đăng ký lớp) trong kỳ
  // A member is active in the period if a court booked in it (confirmed, in use or done)
  // or holds a confirmed place in a class running in it. Enrolments carry no timestamp,
  // so "joined" for the trend uses the class's start month.
  const counts = await one<{ new_members: number; active_members: number }>(
    sql,
    `select
       (select count(*) from users u where u.role = 'member'
          and (u.created_at at time zone 'Asia/Ho_Chi_Minh')::date between $1::date and $2::date)::int as new_members,
       (select count(distinct x.user_id) from (
           select b.user_id from court_bookings b join courts c on c.id = b.court_id
            where b.status in ('confirmed','in_use','completed')
              and (b.start_at at time zone 'Asia/Ho_Chi_Minh')::date between $1::date and $2::date
              and ($3::text is null or c.sport = $3)
           union
           select e.user_id from enrollments e join classes cl on cl.id = e.class_id
            where e.status = 'confirmed' and cl.start_on <= $2::date and cl.end_on >= $1::date
              and ($3::text is null or cl.sport = $3)
         ) x)::int as active_members`,
    [from, to, sport],
  );
  // Bước 2: Tạo chuỗi 12 tháng liên tiếp kết thúc tại tháng của 'to' để thống kê xu hướng tăng trưởng
  // Twelve calendar months ending with the month of `to`, gapless.
  const trend = await sql.query<{ month: string; new_members: number; classes_joined: number }>(
    `with months as (
       select date_trunc('month', $1::date) - make_interval(months => g) as m
         from generate_series(0, 11) g
     )
     select to_char(m.m, 'YYYY-MM') as month,
            (select count(*) from users u where u.role = 'member'
               and date_trunc('month', u.created_at at time zone 'Asia/Ho_Chi_Minh') = m.m)::int as new_members,
            (select count(*) from enrollments e join classes cl on cl.id = e.class_id
              where e.status = 'confirmed' and date_trunc('month', cl.start_on) = m.m
                and ($2::text is null or cl.sport = $2))::int as classes_joined
       from months m order by m.m`,
    [to, sport],
  );
  // Bước 3: Kiểm tra xem trung tâm đã từng ghi nhận điểm danh buổi học nào chưa để quyết định hiển thị cột điểm danh (BR-52)
  const attendanceOn = (await one<{ n: number }>(sql, `select count(*)::int as n from attendance where kind = 'session' and result is not null`))!.n > 0;
  // Bước 4: Tải danh sách chi tiết các lớp học mở trong kỳ cùng số lượng ghi danh và tỷ lệ tham gia
  const classes = await loadMemberClasses(sql, from, to, sport);
  // Bước 5: Chuẩn hóa dữ liệu trả về, tính toán tỷ lệ lấp đầy lớp và tỷ lệ điểm danh
  return {
    from,
    to,
    sport,
    members: {
      new: counts!.new_members,
      active: counts!.active_members,
    },
    trend,
    attendance_on: attendanceOn,
    classes: classes.map((c) => ({
      id: c.id,
      code: classCode(c.sport, c.level, c.id),
      sport: c.sport,
      level: c.level,
      status: c.status,
      coach: c.coach,
      capacity: c.capacity,
      enrolled: c.enrolled,
      waitlisted: c.waitlisted,
      fill_pct: pct1(c.enrolled, c.capacity),
      // F4 off (or nothing marked yet) hides the column rather than printing 0% (BR-52).
      attendance_pct: attendanceOn && c.marked ? pct1(c.attended, c.marked) : null,
    })),
  };
}

/**
 * Làm gì: Handler xử lý yêu cầu API báo cáo hội viên và lớp học; kiểm tra quyền manager, trích xuất tham số và trả về dữ liệu thống kê.
 * Được gọi ở: src/server/controllers/router.ts tại route GET /api/reports/members
 * @param sql Đối tượng truy vấn cơ sở dữ liệu Sql
 * @param request Request HTTP từ client chứa các query params
 * @param user Thông tin người dùng đang thực hiện request (yêu cầu role manager)
 * @returns Object phản hồi gồm HTTP status 200 và body chứa dữ liệu báo cáo hội viên
 * @throws err.forbidden nếu user không có vai trò manager
 * @throws err.field nếu tham số ngày hoặc môn thể thao không hợp lệ
 */
export async function reportsMembers(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra phân quyền - chỉ người quản lý (manager) mới được xem báo cáo hội viên và lớp học
  requireRole(user, ["manager"]);
  // Bước 2: Trích xuất và xác thực khoảng thời gian báo cáo cùng bộ lọc môn thể thao
  const { from, to, sport } = await windowParams(sql, request);
  // Bước 3: Thu thập số liệu hội viên và trả về HTTP status 200 cùng payload
  return { status: 200, body: await membersReportBody(sql, from, to, sport) };
}

// ---- files (FR-PAY-07) ---------------------------------------------------------

// Danh sách các loại báo cáo được hệ thống hỗ trợ xuất file Excel và PDF (FR-PAY-07)
const KINDS = ["revenue", "capacity", "members", "attendance", "at-risk"] as const;

/**
 * Làm gì: Tạo danh sách các dòng thông tin bộ lọc (gồm khoảng thời gian và các bộ lọc phụ) để in lên phần đầu của tài liệu báo cáo xuất file.
 * Được gọi ở: attendanceDocument (line 219), revenueDocument (line 262), capacityDocument (line 319), membersDocument (line 360)
 * @param from Ngày bắt đầu định dạng YYYY-MM-DD
 * @param to Ngày kết thúc định dạng YYYY-MM-DD
 * @param extra Mảng các cặp [tên bộ lọc, giá trị] bổ sung (ví dụ: môn thể thao, phương thức thanh toán)
 * @returns Mảng các cặp [tên bộ lọc, giá trị] đã được định dạng ngày tháng để hiển thị trên file báo cáo
 */
function filterRows(from: string, to: string, extra: [string, string][]): [string, string][] {
  return [["Period", `${formatDate(from)} – ${formatDate(to)}`], ...extra];
}

/**
 * Làm gì: Điều phối và tạo cấu trúc tài liệu báo cáo (ReportDoc) dựa trên loại báo cáo yêu cầu (revenue, capacity, members, attendance, at-risk) để chuẩn bị xuất ra file Excel hoặc PDF.
 * Được gọi ở: reportsExport (line 400)
 * @param sql Đối tượng truy vấn cơ sở dữ liệu Sql
 * @param request Request HTTP từ client chứa các query params lọc
 * @param kind Loại báo cáo cần tạo ("revenue" | "capacity" | "members" | "attendance" | "at-risk")
 * @returns Cấu trúc dữ liệu báo cáo (ReportDoc) cùng khoảng thời gian from và to
 * @throws err.field nếu tham số ngày hoặc môn thể thao không hợp lệ
 */
export async function reportDoc(sql: Sql, request: Request, kind: string): Promise<{ doc: ReportDoc; from: string; to: string }> {
  // Bước 1: Nạp tên các môn thể thao vào bộ nhớ nhãn và lấy thời điểm tạo báo cáo theo giờ Việt Nam (ICT)
  registerSportNames(await sql.query<{ code: string; name: string }>("select code, name_en as name from sports"));
  const generated_at = new Date().toLocaleString("en-GB", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "medium", timeStyle: "short" });
  // Bước 2: Xử lý nhóm báo cáo điểm danh và hội viên có nguy cơ rời bỏ (mặc định lấy khung thời gian 30 ngày gần nhất)
  if (kind === "attendance" || kind === "at-risk") {
    const sp = new URL(request.url).searchParams;
    const to = reportDay(sp, "to", ictDateString());
    const from = reportDay(sp, "from", addDays(to, -29));
    // Điều hướng tạo tài liệu hội viên nguy cơ nghỉ tập hoặc tài liệu điểm danh chi tiết
    if (kind === "at-risk") {
      return atRiskDocument(sql, from, to, generated_at);
    }
    return attendanceDocument(sql, from, to, sp.get("sport") || null, generated_at);
  }
  // Bước 3: Xử lý nhóm báo cáo doanh thu (revenue)
  if (kind === "revenue") {
    return revenueDocument(sql, request, generated_at);
  }
  // Bước 4: Lấy khoảng ngày và môn thể thao cho các báo cáo công suất (capacity) hoặc hội viên (members)
  const { from, to, sport } = await windowParams(sql, request);
  const sportFilter: [string, string] = ["Sport", sport ? sportLabel(sport) : "All"];
  // Bước 5: Gọi hàm tạo tài liệu công suất sân hoặc tài liệu hội viên & lớp học
  if (kind === "capacity") {
    return capacityDocument(sql, from, to, sport, sportFilter, generated_at);
  }
  return membersDocument(sql, from, to, sport, sportFilter, generated_at);
}

/**
 * Làm gì: Xây dựng cấu trúc tài liệu báo cáo hội viên có nguy cơ rời bỏ (at-risk) gồm thông tin liên hệ, tỷ lệ điểm danh, lý do và lịch sử liên lạc để xuất file.
 * Được gọi ở: reportDoc (line 168)
 * @param sql Đối tượng truy vấn cơ sở dữ liệu Sql
 * @param from Ngày bắt đầu kỳ báo cáo (YYYY-MM-DD)
 * @param to Ngày kết thúc kỳ báo cáo (YYYY-MM-DD)
 * @param generated_at Chuỗi thời gian tạo báo cáo theo giờ ICT
 * @returns Cấu trúc ReportDoc chứa bảng danh sách hội viên có nguy cơ rời bỏ kèm ghi chú nghiệp vụ
 */
async function atRiskDocument(sql: Sql, from: string, to: string, generated_at: string): Promise<{ doc: ReportDoc; from: string; to: string }> {
  // Bước 1: Lấy danh sách hội viên có nguy cơ nghỉ tập từ service atRiskBody
  const d = await atRiskBody(sql, null);
  // Bước 2: Định dạng dữ liệu thành bảng gồm các cột thông tin liên hệ, lý do và lịch sử chăm sóc khách hàng
  return {
    from,
    to,
    doc: {
      title: "At-risk members",
      filters: [["As of", formatDate(ictDateString())], ["Idle threshold", `${d.idle_days} days`]],
      generated_at,
      sections: [
        {
          name: "At-risk members",
          columns: ["Member", "Code", "Phone", "Attendance %", "Reasons", "Contacted", "Last outcome"],
          rows: d.items.map((i) => [
            i.full_name,
            i.member_code,
            i.phone,
            i.attendance_pct,
            i.reasons.map((r) => r.message).join(" "),
            i.contacted ? "Yes" : "No",
            i.last_contact?.outcome ?? null,
          ]),
          note: "Listed so the front desk and coaches can call before they drift away. No fee or penalty applies.",
        },
      ],
    },
  };
}

/**
 * Làm gì: Xây dựng tài liệu báo cáo điểm danh hoàn chỉnh để xuất file, gồm 4 phần: Tổng quan, Thống kê theo lớp học, Thống kê theo huấn luyện viên, và Thống kê theo học viên.
 * Được gọi ở: reportDoc (line 170)
 * @param sql Đối tượng truy vấn cơ sở dữ liệu Sql
 * @param from Ngày bắt đầu kỳ báo cáo (YYYY-MM-DD)
 * @param to Ngày kết thúc kỳ báo cáo (YYYY-MM-DD)
 * @param sport Mã môn thể thao cần lọc, hoặc null nếu thống kê tất cả các môn
 * @param generated_at Chuỗi thời gian tạo báo cáo theo giờ ICT
 * @returns Cấu trúc ReportDoc chứa 4 bảng số liệu điểm danh chi tiết kèm công thức tính tỷ lệ
 */
async function attendanceDocument(sql: Sql, from: string, to: string, sport: string | null, generated_at: string): Promise<{ doc: ReportDoc; from: string; to: string }> {
  // Bước 1: Lấy số liệu thống kê điểm danh chi tiết từ service attendanceReportBody
  const d = await attendanceReportBody(sql, from, to, { sport, classId: null, coachScopeId: null });
  // Bước 2: Tạo cấu trúc tài liệu gồm 4 bảng số liệu: Tổng quan, theo lớp học, theo huấn luyện viên và theo từng học viên
  return {
    from,
    to,
    doc: {
      title: "Attendance report",
      filters: filterRows(from, to, [["Sport", sport ? sportLabel(sport) : "All"]]),
      generated_at,
      sections: [
        {
          name: "Summary",
          columns: ["Present", "Late", "Absent", "Excused", "Attendance %"],
          rows: [[d.totals.present, d.totals.late, d.totals.absent, d.totals.excused, d.totals.rate_pct]],
          note: "Attendance % = (Present + Late) ÷ (sessions marked − Excused).",
        },
        {
          name: "By class",
          columns: ["Class", "Sport", "Coach", "Students", "Present", "Late", "Absent", "Excused", "Attendance %"],
          rows: d.classes.map((c) => [c.class_code, sportLabel(c.sport), c.coach, c.students, c.present, c.late, c.absent, c.excused, c.rate_pct]),
        },
        {
          name: "By coach",
          columns: ["Coach", "Classes", "Present", "Late", "Absent", "Excused", "Attendance %"],
          rows: d.coaches.map((c) => [c.coach, c.classes, c.present, c.late, c.absent, c.excused, c.rate_pct]),
        },
        {
          name: "By student",
          columns: ["Student", "Code", "Class", "Present", "Late", "Absent", "Excused", "Attendance %"],
          rows: d.students.map((r) => [r.full_name, r.member_code, r.class_code, r.present, r.late, r.absent, r.excused, r.rate_pct]),
        },
      ],
    },
  };
}

/**
 * Làm gì: Xây dựng cấu trúc tài liệu ReportDoc cho báo cáo doanh thu (revenue), bao gồm bảng tổng quan so sánh đối soát với kỳ trước, phân bổ theo nguồn thu, theo phương thức thanh toán, theo ngày và theo ca thu ngân để xuất file Excel hoặc PDF (FR-PAY-05, FR-PAY-07).
 * Được gọi ở: reportDoc (line 173)
 * @param sql Đối tượng truy vấn cơ sở dữ liệu Sql
 * @param request Request HTTP từ client chứa các query params (from, to, method)
 * @param generated_at Chuỗi thời gian tạo báo cáo theo giờ ICT
 * @returns Cấu trúc ReportDoc chứa 5 bảng số liệu doanh thu chi tiết cùng khoảng thời gian from và to
 * @throws err.field nếu ngày kết thúc trước ngày bắt đầu hoặc phương thức thanh toán không hợp lệ
 */
async function revenueDocument(sql: Sql, request: Request, generated_at: string): Promise<{ doc: ReportDoc; from: string; to: string }> {
  // Bước 1: Trích xuất và xác thực các tham số bộ lọc (from, to, method) từ query string
  const { from, to, method } = revenueParams(request);
  // Bước 2: Truy vấn dữ liệu doanh thu chi tiết của kỳ hiện tại (cur)
  const cur = await revenueBody(sql, from, to, method);
  // Bước 3: Xác định chu kỳ trước liền kề có cùng độ dài (win) và lấy số liệu doanh thu kỳ trước (prev) để so sánh đối soát (FR-PAY-05)
  const win = previousWindow(from, to);
  const prev = await revenueBody(sql, win.from, win.to, method, false);
  // Rút gọn biến tổng số liệu kỳ này (t) và kỳ trước (p) để tính chênh lệch tăng trưởng
  const t = cur.body.totals;
  const p = prev.body.totals;
  // Hàm tính tỷ lệ % tăng/giảm giữa hai kỳ; nếu kỳ trước bằng 0 thì gán nhãn "new" nếu kỳ này phát sinh hoặc "same"
  const change = (a: number, b: number) => (b ? `${a >= b ? "+" : ""}${pct1(a - b, Math.abs(b))}%` : a ? "new" : "same");
  // Bước 4: Hợp nhất danh sách tất cả nguồn thu xuất hiện ở cả hai kỳ để không bỏ sót mục nào khi lập bảng
  const sources = new Set([...Object.keys(cur.body.by_source), ...Object.keys(prev.body.by_source)]);
  // Bước 5: Đóng gói tài liệu ReportDoc gồm 5 phần: Summary (tổng kết đối soát), By source (theo nguồn), By method (theo phương thức), By day (theo ngày), và By cashier shift (theo ca thu ngân)
  return {
    from,
    to,
    doc: {
      title: "Revenue report",
      filters: filterRows(from, to, [
        ["Payment method", method ? methodLabel(method) : "All"],
        ["Compared with", `${formatDate(win.from)} – ${formatDate(win.to)}`],
      ]),
      generated_at,
      sections: [
        {
          name: "Summary",
          columns: ["", "This period", "Previous period", "Change"],
          rows: [
            ["Revenue (taken − refunds)", t.revenue_vnd, p.revenue_vnd, change(t.revenue_vnd, p.revenue_vnd)],
            ["Taken", t.gross_vnd, p.gross_vnd, change(t.gross_vnd, p.gross_vnd)],
            ["Refunds", t.refund_vnd, p.refund_vnd, change(t.refund_vnd, p.refund_vnd)],
            ["Plan hours used", t.quota_hours, p.quota_hours, change(t.quota_hours, p.quota_hours)],
          ],
          note: "Amounts in VND. Revenue = payments taken − refunds.",
        },
        {
          name: "By source",
          columns: ["Source", "This period", "Previous period"],
          rows: [...sources].map((s) => [sourceLabel(s), cur.body.by_source[s] ?? 0, prev.body.by_source[s] ?? 0]),
          total: ["Total taken", t.gross_vnd, p.gross_vnd],
        },
        {
          name: "By method",
          columns: ["Method", "Taken"],
          rows: Object.entries(cur.body.by_method).map(([m, v]) => [methodLabel(m), v as number]),
          total: ["Total taken", t.gross_vnd],
        },
        {
          name: "By day",
          columns: ["Day", "Revenue"],
          rows: cur.body.by_day.map((d: { day: string; revenue_vnd: number }) => [d.day, d.revenue_vnd]),
        },
        {
          name: "By cashier shift",
          columns: ["Cashier", "Opened", "Taken", "Refunds", "Payments"],
          rows: cur.body.by_shift.map((s: { cashier: string | null; opened_at: string | null; takings_vnd: number; refunds_vnd: number; count: number }) => [
            s.cashier ?? "Online (no shift)",
            s.opened_at ? new Date(s.opened_at).toLocaleString("en-GB", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short" }) : "",
            s.takings_vnd,
            s.refunds_vnd,
            s.count,
          ]),
        },
      ],
    },
  };
}

/**
 * Làm gì: Xây dựng cấu trúc tài liệu ReportDoc cho báo cáo công suất sân (capacity), gồm bảng thống kê theo môn thể thao, theo từng sân, biểu đồ nhiệt (heatmap) theo khung giờ và so sánh doanh thu thuê sân lẻ với học phí lớp học (FR-CRT-09).
 * Được gọi ở: reportDoc (line 178)
 * @param sql Đối tượng truy vấn cơ sở dữ liệu Sql
 * @param from Ngày bắt đầu kỳ báo cáo (YYYY-MM-DD)
 * @param to Ngày kết thúc kỳ báo cáo (YYYY-MM-DD)
 * @param sport Mã môn thể thao cần lọc, hoặc null nếu thống kê tất cả các môn
 * @param sportFilter Cặp nhãn bộ lọc môn thể thao hiển thị ở phần tiêu đề ["Sport", tên môn]
 * @param generated_at Chuỗi thời gian tạo báo cáo theo giờ ICT
 * @returns Cấu trúc ReportDoc chứa 4 bảng công suất sân chi tiết cùng khoảng thời gian from và to
 */
async function capacityDocument(sql: Sql, from: string, to: string, sport: string | null, sportFilter: [string, string], generated_at: string): Promise<{ doc: ReportDoc; from: string; to: string }> {
  // Bước 1: Tính toán toàn bộ dữ liệu công suất sử dụng sân, giờ mở/đóng cửa và heatmap từ capacityBody (FR-CRT-09)
  const d = await capacityBody(sql, from, to, sport);
  // Bước 2: Đóng gói tài liệu ReportDoc gồm 4 bảng: By sport, By court, Heatmap, và Court rental vs class fees. Công thức Math.round(min / 6) / 10 quy đổi số phút sang số giờ và làm tròn 1 chữ số thập phân
  return {
    from,
    to,
    doc: {
      title: "Court capacity report",
      filters: filterRows(from, to, [sportFilter, ["Open hours", `${d.open_hour}:00 – ${d.close_hour}:00`]]),
      generated_at,
      sections: [
        {
          name: "By sport",
          columns: ["Sport", "Sold hours", "Open hours", "Used %", "Peak %", "Off-peak %"],
          rows: d.by_sport.map((s) => [sportLabel(s.sport), Math.round(s.sold_min / 6) / 10, Math.round(s.open_min / 6) / 10, s.pct, s.peak_pct, s.offpeak_pct]),
          total: ["All courts", Math.round(d.totals.sold_min / 6) / 10, Math.round(d.totals.open_min / 6) / 10, d.totals.pct, null, null],
          note: "Used % = hours sold (bookings and classes) ÷ hours open.",
        },
        {
          name: "By court",
          columns: ["Court", "Sport", "Sold hours", "Open hours", "Used %"],
          rows: d.courts.map((c) => [c.court_code, sportLabel(c.sport), Math.round(c.sold_min / 6) / 10, Math.round(c.open_min / 6) / 10, c.pct]),
        },
        {
          name: "Heatmap (used % by hour)",
          columns: ["Court", ...d.hours.map((h) => `${String(h).padStart(2, "0")}h`)],
          rows: d.courts.map((c) => [c.court_code, ...c.cells]),
          total: ["All courts", ...d.by_hour.map((h) => h.pct)],
        },
        {
          name: "Court rental vs class fees",
          columns: ["Source", "Taken (VND)"],
          rows: [
            ["Court rental", d.revenue_by_source.court_vnd],
            ["Class fees", d.revenue_by_source.class_vnd],
          ],
        },
      ],
    },
  };
}

/**
 * Làm gì: Xây dựng cấu trúc tài liệu ReportDoc cho báo cáo hội viên và lớp học (members), gồm số lượng hội viên mới/hoạt động, biểu đồ xu hướng 12 tháng và tình hình tuyển sinh/điểm danh của các lớp học (FR-PAY-06).
 * Được gọi ở: reportDoc (line 180)
 * @param sql Đối tượng truy vấn cơ sở dữ liệu Sql
 * @param from Ngày bắt đầu kỳ báo cáo (YYYY-MM-DD)
 * @param to Ngày kết thúc kỳ báo cáo (YYYY-MM-DD)
 * @param sport Mã môn thể thao cần lọc, hoặc null nếu thống kê tất cả các môn
 * @param sportFilter Cặp nhãn bộ lọc môn thể thao hiển thị ở phần tiêu đề ["Sport", tên môn]
 * @param generated_at Chuỗi thời gian tạo báo cáo theo giờ ICT
 * @returns Cấu trúc ReportDoc chứa 3 bảng số liệu hội viên và lớp học chi tiết cùng khoảng thời gian from và to
 */
async function membersDocument(sql: Sql, from: string, to: string, sport: string | null, sportFilter: [string, string], generated_at: string): Promise<{ doc: ReportDoc; from: string; to: string }> {
  // Bước 1: Lấy số liệu hội viên mới/hoạt động, xu hướng 12 tháng và danh sách lớp học từ membersReportBody (FR-PAY-06)
  const d = await membersReportBody(sql, from, to, sport);
  // Bước 2: Đóng gói ReportDoc gồm 3 bảng: Members (chỉ số hội viên), 12-month trend (xu hướng 12 tháng), và Classes (tình hình lớp học, sĩ số và tỷ lệ điểm danh)
  return {
    from,
    to,
    doc: {
      title: "Members and classes report",
      filters: filterRows(from, to, [sportFilter]),
      generated_at,
      sections: [
        {
          name: "Members",
          columns: ["Measure", "Value"],
          rows: [
            ["New members", d.members.new],
            ["Active members (a court or a class in the period)", d.members.active],
          ],
        },
        {
          name: "12-month trend",
          columns: ["Month", "New members", "Classes joined"],
          rows: d.trend.map((m) => [m.month, m.new_members, m.classes_joined]),
        },
        {
          name: "Classes",
          columns: ["Class", "Sport", "Coach", "Capacity", "Enrolled", "Waitlist", "Fill %", ...(d.attendance_on ? ["Attendance %"] : [])],
          rows: d.classes.map((c) => [
            c.code,
            sportLabel(c.sport),
            c.coach,
            c.capacity,
            c.enrolled,
            c.waitlisted,
            c.fill_pct,
            ...(d.attendance_on ? [c.attendance_pct] : []),
          ]),
        },
      ],
    },
  };
}

/**
 * Làm gì: Handler xử lý yêu cầu xuất báo cáo quản lý ra file Excel (.xlsx) hoặc PDF (.pdf); kiểm tra quyền manager, điều phối tạo tài liệu và trả về file đính kèm HTTP để tải về (FR-PAY-07, UC-22).
 * Được gọi ở: src/server/controllers/router.ts tại route GET /api/reports/:kind/export
 * @param sql Đối tượng truy vấn cơ sở dữ liệu Sql
 * @param request Request HTTP chứa URL và query parameters (?format=xlsx|pdf, &from=..., &to=...)
 * @param user Thông tin người dùng đang thực hiện request (yêu cầu role manager)
 * @param kind Loại báo cáo cần xuất ("revenue" | "capacity" | "members" | "attendance" | "at-risk")
 * @returns Response HTTP chứa dữ liệu nhị phân của file kèm headers MIME type và Content-Disposition đính kèm
 * @throws err.forbidden nếu user không có vai trò manager
 * @throws err.notFound nếu kind không nằm trong danh sách báo cáo được hỗ trợ (KINDS)
 * @throws err.field nếu tham số format không phải xlsx/pdf hoặc tham số bộ lọc ngày không hợp lệ
 */
export async function reportsExport(sql: Sql, request: Request, user: PublicUser, kind: string) {
  // Bước 1: Phân quyền - chỉ tài khoản có vai trò manager mới được phép xuất file báo cáo
  requireRole(user, ["manager"]);
  // Bước 2: Kiểm tra loại báo cáo (kind) yêu cầu phải nằm trong danh sách KINDS hệ thống hỗ trợ
  if (!(KINDS as readonly string[]).includes(kind)) throw err.notFound("Unknown report.");
  // Bước 3: Đọc định dạng xuất file từ query param format (mặc định là xlsx) và xác thực tính hợp lệ (chỉ nhận xlsx hoặc pdf)
  const format = new URL(request.url).searchParams.get("format") ?? "xlsx";
  if (format !== "xlsx" && format !== "pdf") throw err.field("format", "Use xlsx or pdf.");
  // Bước 4: Tạo cấu trúc tài liệu ReportDoc thống nhất tương ứng với loại báo cáo được yêu cầu
  const { doc, from, to } = await reportDoc(sql, request, kind);
  // Bước 5: Biên dịch ReportDoc thành dữ liệu nhị phân: gọi buildXlsx để tạo bảng tính Excel hoặc buildReportPdf để xuất tài liệu PDF (FR-PAY-07)
  const bytes = format === "xlsx" ? buildXlsx(doc) : await buildReportPdf(doc);
  // Bước 6: Trả về HTTP Response nhị phân với Content-Type tương ứng và header Content-Disposition để kích hoạt tải file trên trình duyệt
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      "content-type":
        format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf",
      "content-disposition": `attachment; filename="arena3-${kind}-${from}_${to}.${format}"`,
      "cache-control": "no-store",
    },
  });
}

/**
 * Làm gì: Truy vấn cơ sở dữ liệu tính toán số phút đã bán (đặt sân hoặc buổi học) và số ngày có khách đặt cho từng slot 1 giờ của mỗi sân trong khoảng ngày chỉ định (FR-CRT-09).
 * Được gọi ở: capacityBody (line 39)
 * @param sql Đối tượng truy vấn cơ sở dữ liệu Sql
 * @param from Ngày bắt đầu kỳ báo cáo (YYYY-MM-DD)
 * @param to Ngày kết thúc kỳ báo cáo (YYYY-MM-DD)
 * @param sport Mã môn thể thao cần lọc, hoặc null nếu lấy tất cả các môn
 * @param openHour Giờ mở cửa trung tâm (ví dụ: 6 là 06:00)
 * @param closeHour Giờ đóng cửa trung tâm (ví dụ: 22 là 22:00)
 * @returns Danh sách các ô công suất CapacityCell (gồm court_id, court_code, sport, hr, slots, sold_min, days_booked, days_total)
 */
async function loadCapacityCells(sql: Sql, from: string, to: string, sport: string | null, openHour: number, closeHour: number) {
  // "Sold" is a booking or a class session. A hold is unpaid, maintenance is not a sale.
  // Retired courts are hidden unless they have bookings/sessions in the requested window.
  // Bước 1: Thực thi câu lệnh SQL với các CTE (active_courts, days, slots, slot_occupancy) để tính chính xác số phút đã bán giao nhau với từng slot 1 giờ của mỗi sân
  return sql.query<CapacityCell>(
    `with active_courts as (
       select c.id as court_id, c.court_code, c.sport::text as sport, c.sort_order
         from courts c
        where ($3::text is null or c.sport::text = $3)
          and (
            (c.status = 'ready' and c.retired_at is null)
            or exists (
              select 1 from occupancies o
               where o.court_id = c.id
                 and o.kind in ('booking','session')
                 and o.start_at < ($2::date + interval '1 day') at time zone 'Asia/Ho_Chi_Minh'
                 and o.end_at > $1::date at time zone 'Asia/Ho_Chi_Minh'
            )
          )
     ),
     days as (
       select d.day::date as day
         from generate_series($1::date, $2::date, interval '1 day') as d(day)
     ),
     slots as (
       select c.court_id, c.court_code, c.sport, h.hr, d.day,
              (d.day::timestamp + make_interval(hours => h.hr)) at time zone 'Asia/Ho_Chi_Minh' as s_at
         from active_courts c
        cross join days d
        cross join generate_series($4::int, $5::int - 1) as h(hr)
     ),
     slot_occupancy as (
       select s.court_id, s.court_code, s.sport, s.hr, s.day,
              coalesce(sum(extract(epoch from (least(o.end_at, s.s_at + interval '1 hour') - greatest(o.start_at, s.s_at))) / 60)
                filter (where o.id is not null), 0)::int as sold_min
         from slots s
         left join ${PLAYED_SQL} o on o.court_id = s.court_id
           and o.kind in ('booking','session')
           and o.start_at < s.s_at + interval '1 hour' and o.end_at > s.s_at
         group by s.court_id, s.court_code, s.sport, s.hr, s.day, s.s_at
     )
     select s.court_id, s.court_code, s.sport, s.hr,
            count(*)::int as slots,
            sum(s.sold_min)::int as sold_min,
            count(*) filter (where s.sold_min > 0)::int as days_booked,
            count(*)::int as days_total
       from slot_occupancy s
      group by s.court_id, s.court_code, s.sport, s.hr
      order by s.court_code, s.hr`,
    [from, to, sport, openHour, closeHour],
  );
}

/**
 * Làm gì: Truy vấn thông tin các lớp học mở trong kỳ báo cáo, bao gồm sĩ số, số lượng học viên đã đăng ký/chờ, và tổng hợp số buổi điểm danh (có mặt, đi muộn) phục vụ báo cáo hội viên (FR-PAY-06, BR-52).
 * Được gọi ở: membersReportBody (line 118)
 * @param sql Đối tượng truy vấn cơ sở dữ liệu Sql
 * @param from Ngày bắt đầu kỳ báo cáo (YYYY-MM-DD)
 * @param to Ngày kết thúc kỳ báo cáo (YYYY-MM-DD)
 * @param sport Mã môn thể thao cần lọc, hoặc null nếu thống kê tất cả các môn
 * @returns Danh sách các lớp học cùng các chỉ số: capacity, enrolled, waitlisted, marked (đã điểm danh) và attended (có mặt/đi muộn)
 */
async function loadMemberClasses(sql: Sql, from: string, to: string, sport: string | null) {
  // Bước 1: Chạy truy vấn SQL lấy danh sách lớp học, tính số học viên ghi danh/chờ duyệt và tổng hợp kết quả điểm danh các buổi học trong kỳ
  return sql.query<{
    id: string;
    sport: string;
    level: string;
    status: string;
    coach: string;
    capacity: number;
    enrolled: number;
    waitlisted: number;
    marked: number;
    attended: number;
  }>(
    `select c.id, c.sport::text as sport, c.level, c.status::text as status, u.full_name as coach, c.capacity,
            (select count(*) from enrollments e where e.class_id = c.id and e.status = 'confirmed')::int as enrolled,
            (select count(*) from enrollments e where e.class_id = c.id and e.status = 'waitlisted')::int as waitlisted,
            (select count(*) from attendance a join sessions s on s.id = a.session_id
              where s.class_id = c.id and a.kind = 'session' and a.result is not null and a.result <> 'excused'
                and (s.start_at at time zone 'Asia/Ho_Chi_Minh')::date between $1::date and $2::date)::int as marked,
            (select count(*) from attendance a join sessions s on s.id = a.session_id
              where s.class_id = c.id and a.kind = 'session' and a.result in ('present','late')
                and (s.start_at at time zone 'Asia/Ho_Chi_Minh')::date between $1::date and $2::date)::int as attended
       from classes c join users u on u.id = c.coach_id
      where c.status in ('open','closed') and c.start_on <= $2::date and c.end_on >= $1::date
        and ($3::text is null or c.sport::text = $3)
      order by c.sport, c.level, c.id`,
    [from, to, sport],
  );
}
