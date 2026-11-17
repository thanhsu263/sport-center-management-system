/**
 * Attendance rate and the at-risk list (SRS v1.4.1 FR-TRN-09, BR-36, BR-32).
 *
 * Attendance carries no penalty and moves no balance (BR-32). Its use is here:
 * telling the centre who is drifting away while there is still time to call,
 * and which classes and coaches keep people coming.
 *
 * Rate = (Present + Late) / (sessions marked − Excused). A session nobody marked
 * is not counted at all, and an excused absence is left out of the denominator
 * rather than counted against the student.
 */
import type { Sql } from "@/server/data/db";
import { err } from "../errors";
import { requireFlag } from "../../services/flags";
import { audit, getSettings, readJson, str } from "../helpers";
import { classCode } from "../../../shared/arena3/labels";
import { absentStreak, ABSENT_STREAK_LIMIT } from "../../services/rules";
import { requireRole, type PublicUser } from "../session";
import { addDays, ictDateString, ictDateTime } from "../../../shared/arena3/time";
import { one } from "../tx";
import { reportDay } from "./desk";

import { getActiveSportCodes } from "./sports";

// Biểu thức chính quy kiểm tra định dạng chuỗi UUID hợp lệ (8-4-4-4-12 ký tự hex)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Giới hạn khoảng thời gian tối đa cho một báo cáo chuyên cần: 93 ngày (~1 quý)
const MAX_DAYS = 93;

/**
 * Làm gì: Danh sách các lý do liên hệ chăm sóc học viên có nguy cơ bỏ tập (vắng liên tiếp, không đến lâu ngày, sắp hết hạn gói, khác).
 * Được gọi ở: contactCreate (src/server/controllers/handlers/attendance.ts).
 */
export const CONTACT_REASONS = ["streak", "idle", "expiring", "other"] as const;
/**
 * Làm gì: Danh sách các kênh liên hệ với học viên (gọi điện, Zalo, tin nhắn SMS, gặp trực tiếp tại quầy).
 * Được gọi ở: contactCreate (src/server/controllers/handlers/attendance.ts).
 */
export const CONTACT_CHANNELS = ["phone", "zalo", "sms", "in_person"] as const;
/**
 * Làm gì: Danh sách các kết quả liên hệ chăm sóc học viên (đã trao đổi, sẽ đi tập lại, xin nghỉ hẳn, dời lịch, không nghe máy).
 * Được gọi ở: contactCreate (src/server/controllers/handlers/attendance.ts).
 */
export const CONTACT_OUTCOMES = ["reached", "will_return", "leaving", "reschedule", "no_answer"] as const;

/**
 * Làm gì: Tính tỷ lệ phần trăm làm tròn đến 1 chữ số thập phân (ví dụ 85.5%). Trả về null nếu mẫu số bằng 0.
 * Được gọi ở: rateOf (src/server/controllers/handlers/attendance.ts).
 * @param num Tử số (số lượt tham gia: present + late).
 * @param den Mẫu số (tổng số lượt điểm danh: present + late + absent).
 * @returns Tỷ lệ phần trăm dạng number (0.0 - 100.0) hoặc null nếu không có buổi học nào.
 */
const pct1 = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

/**
 * Làm gì: Kiểm tra giá trị đầu vào có thuộc danh sách chuỗi hợp lệ cho phép hay không, trả về fallback nếu để trống.
 * Được gọi ở: contactCreate (src/server/controllers/handlers/attendance.ts) để validate reason, channel, outcome.
 * @param list Danh sách các giá trị chuỗi hợp lệ (whitelist).
 * @param v Giá trị đầu vào cần kiểm tra (unknown từ request body).
 * @param field Tên trường dùng để báo lỗi nếu giá trị không hợp lệ.
 * @param fallback Giá trị mặc định nếu trường dữ liệu để trống.
 * @returns Chuỗi hợp lệ kiểu T.
 * @throws 400 nếu giá trị không thuộc whitelist và không có fallback hợp lệ.
 */
function oneOf<T extends string>(list: readonly T[], v: unknown, field: string, fallback?: T): T {
  const s = str(v);
  if (!s && fallback) return fallback;
  if (!s || !(list as readonly string[]).includes(s)) {
    throw err.field(field, `${field} must be one of: ${list.join(", ")}.`);
  }
  return s as T;
}

/**
 * Làm gì: Trích xuất và kiểm tra tính hợp lệ của các tham số khoảng thời gian và bộ lọc từ query string của request.
 * Được gọi ở: reportsAttendance (src/server/controllers/handlers/attendance.ts).
 * @param sql Kết nối database dùng để kiểm tra mã môn thể thao tồn tại.
 * @param request HTTP Request chứa query params (from, to, sport, class_id).
 * @returns Đối tượng chứa ngày bắt đầu from, ngày kết thúc to, mã môn sport và mã lớp classId.
 * @throws 400 nếu ngày kết thúc trước ngày bắt đầu, khoảng thời gian vượt quá 93 ngày, hoặc sport/class_id không hợp lệ.
 */
async function windowParams(sql: Sql, request: Request) {
  // Bước 1: Trích xuất khoảng ngày from/to từ query string (mặc định lấy 30 ngày gần nhất tính đến hôm nay).
  const sp = new URL(request.url).searchParams;
  const to = reportDay(sp, "to", ictDateString());
  const from = reportDay(sp, "from", addDays(to, -29));
  // Kiểm tra tính hợp lệ: ngày bắt đầu không được sau ngày kết thúc và không vượt quá giới hạn 93 ngày (~1 quý).
  if (from > to) throw err.field("to", "The end date is before the start date.");
  if (Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1 > MAX_DAYS) {
    throw err.field("from", `Pick a period of at most ${MAX_DAYS} days.`);
  }
  // Bước 2: Kiểm tra môn thể thao (sport) và mã lớp học (class_id) nếu client có gửi lên.
  const sport = sp.get("sport") || null;
  if (sport && !(await getActiveSportCodes(sql)).includes(sport)) throw err.field("sport", "Unknown sport.");
  const classId = sp.get("class_id");
  if (classId && !UUID_RE.test(classId)) throw err.field("class_id", "class_id is not valid.");
  return { from, to, sport, classId: classId || null };
}

// Thống kê số lượt có mặt, đi muộn, vắng mặt và vắng có phép của một học viên, lớp học hoặc HLV
type Counts = { present: number; late: number; absent: number; excused: number };
/**
 * Làm gì: Khởi tạo một đối tượng Counts với toàn bộ số lượt điểm danh bằng 0.
 * Được gọi ở: attendanceReportBody (src/server/controllers/handlers/attendance.ts).
 * @returns Đối tượng Counts với present = 0, late = 0, absent = 0, excused = 0.
 */
const emptyCounts = (): Counts => ({ present: 0, late: 0, absent: 0, excused: 0 });
/**
 * Làm gì: Tính tỷ lệ phần trăm chuyên cần (%) từ đối tượng Counts theo quy tắc BR-32 (không phạt vắng có phép).
 * Được gọi ở: attendanceReportBody, buildAtRiskItems (src/server/controllers/handlers/attendance.ts).
 * @param c Đối tượng Counts chứa số lượt present, late, absent.
 * @returns Tỷ lệ phần trăm dạng number (0.0 - 100.0) hoặc null nếu chưa có dữ liệu điểm danh.
 */
const rateOf = (c: Counts) => pct1(c.present + c.late, c.present + c.late + c.absent);
/**
 * Làm gì: Cộng dồn số lượt điểm danh từ đối tượng b vào đối tượng a (thay đổi trực tiếp đối tượng a).
 * Được gọi ở: attendanceReportBody (src/server/controllers/handlers/attendance.ts) khi gom nhóm theo lớp, HLV và toàn trung tâm.
 * @param a Đối tượng Counts đích sẽ nhận giá trị cộng dồn.
 * @param b Đối tượng Counts nguồn chứa số lượt cần cộng thêm.
 */
const add = (a: Counts, b: Counts) => {
  a.present += b.present;
  a.late += b.late;
  a.absent += b.absent;
  a.excused += b.excused;
};

// Cấu trúc một dòng kết quả điểm danh của học viên theo từng lớp truy vấn từ database
type AttRow = Counts & {
  user_id: string;
  full_name: string;
  member_code: string | null;
  class_id: string;
  sport: string;
  level: string;
  coach_id: string;
  coach: string;
};

/**
 * Làm gì: Tổng hợp báo cáo chuyên cần (attendance report) theo khoảng ngày. Quản lý xem toàn bộ trung tâm, huấn luyện viên chỉ xem các lớp mình dạy hoặc trợ giảng (FR-TRN-09).
 * Được gọi ở:
 *   - reportsAttendance (cùng file attendance.ts, phục vụ route GET /v1/reports/attendance)
 *   - attendanceDocument (src/server/controllers/handlers/reports.ts, khi xuất file PDF/Excel)
 * @param sql Kết nối database PostgreSQL.
 * @param from Ngày bắt đầu khoảng báo cáo (định dạng YYYY-MM-DD).
 * @param to Ngày kết thúc khoảng báo cáo (định dạng YYYY-MM-DD).
 * @param opts Bộ lọc tuỳ chọn gồm sport (môn thể thao), classId (lớp học), coachScopeId (mã HLV để giới hạn phạm vi).
 * @returns Báo cáo chuyên cần gồm totals (toàn trung tâm), students (từng học viên), classes (từng lớp) và coaches (từng HLV).
 */
/** The manager sees everyone; a coach only the classes they lead or assist (FR-TRN-09). */
export async function attendanceReportBody(
  sql: Sql,
  from: string,
  to: string,
  opts: { sport: string | null; classId: string | null; coachScopeId: string | null },
) {
  // Bước 1: Truy vấn tổng hợp số lượt điểm danh (present, late, absent, excused) theo từng học viên và lớp học trong khoảng ngày.
  // Chỉ đếm các buổi học (kind = 'session') đã được điểm danh và không bị hủy. Khoảng thời gian từ 00:00 ngày from đến 00:00 ngày to + 1.
  const rows = await sql.query<AttRow>(
    `select a.user_id, u.full_name, u.member_code, cl.id as class_id, cl.sport::text as sport, cl.level,
            cl.coach_id, co.full_name as coach,
            count(*) filter (where a.result = 'present')::int as present,
            count(*) filter (where a.result = 'late')::int as late,
            count(*) filter (where a.result = 'absent')::int as absent,
            count(*) filter (where a.result = 'excused')::int as excused
       from attendance a
       join sessions s on s.id = a.session_id
       join classes cl on cl.id = s.class_id
       join users u on u.id = a.user_id
       join users co on co.id = cl.coach_id
      where a.kind = 'session' and a.result is not null and s.status <> 'cancelled'
        and s.start_at >= $1 and s.start_at < $2
        and ($3::text is null or cl.sport::text = $3)
        and ($4::uuid is null or cl.id = $4)
        and ($5::uuid is null or cl.coach_id = $5 or cl.assistant_id = $5)
      group by a.user_id, u.full_name, u.member_code, cl.id, cl.sport, cl.level, cl.coach_id, co.full_name
      order by u.full_name`,
    [
      ictDateTime(from, "00:00").toISOString(),
      ictDateTime(addDays(to, 1), "00:00").toISOString(),
      opts.sport,
      opts.classId,
      opts.coachScopeId,
    ],
  );
  // Bước 2: Tạo danh sách học viên kèm mã hiển thị của lớp (classCode) và tỷ lệ chuyên cần cá nhân (rate_pct).
  const students = rows.map((r) => ({
    user_id: r.user_id,
    full_name: r.full_name,
    member_code: r.member_code,
    class_id: r.class_id,
    class_code: classCode(r.sport, r.level, r.class_id),
    sport: r.sport,
    present: r.present,
    late: r.late,
    absent: r.absent,
    excused: r.excused,
    rate_pct: rateOf(r),
  }));
  // Bước 3: Tạo Map để gom nhóm thống kê số lượt điểm danh theo lớp (byClass) và theo huấn luyện viên (byCoach).
  const byClass = new Map<string, { class_id: string; class_code: string; sport: string; coach: string; counts: Counts; students: Set<string> }>();
  const byCoach = new Map<string, { coach_id: string; coach: string; counts: Counts; classes: Set<string> }>();
  // Duyệt qua từng dòng kết quả để cộng dồn số liệu và tập hợp danh sách học viên của lớp, danh sách lớp của HLV.
  for (const r of rows) {
    const c = byClass.get(r.class_id) ?? {
      class_id: r.class_id,
      class_code: classCode(r.sport, r.level, r.class_id),
      sport: r.sport,
      coach: r.coach,
      counts: emptyCounts(),
      students: new Set<string>(),
    };
    add(c.counts, r);
    c.students.add(r.user_id);
    byClass.set(r.class_id, c);
    const k = byCoach.get(r.coach_id) ?? { coach_id: r.coach_id, coach: r.coach, counts: emptyCounts(), classes: new Set<string>() };
    add(k.counts, r);
    k.classes.add(r.class_id);
    byCoach.set(r.coach_id, k);
  }
  // Bước 4: Tính tổng số liệu toàn trung tâm và định dạng danh sách trả về, sắp xếp lớp và HLV theo tỷ lệ chuyên cần tăng dần (ưu tiên lớp có tỷ lệ thấp).
  const total = emptyCounts();
  for (const r of rows) add(total, r);
  return {
    from,
    to,
    totals: { ...total, rate_pct: rateOf(total) },
    students,
    classes: [...byClass.values()]
      .map((c) => ({
        class_id: c.class_id,
        class_code: c.class_code,
        sport: c.sport,
        coach: c.coach,
        students: c.students.size,
        ...c.counts,
        rate_pct: rateOf(c.counts),
      }))
      .sort((a, b) => (a.rate_pct ?? 101) - (b.rate_pct ?? 101)),
    coaches: [...byCoach.values()]
      .map((c) => ({ coach_id: c.coach_id, coach: c.coach, classes: c.classes.size, ...c.counts, rate_pct: rateOf(c.counts) }))
      .sort((a, b) => (a.rate_pct ?? 101) - (b.rate_pct ?? 101)),
  };
}

/**
 * Làm gì: Endpoint API xử lý yêu cầu lấy báo cáo chuyên cần. Chỉ cho phép manager hoặc coach truy cập khi cờ F4 đang bật.
 * Được gọi ở: GET /v1/reports/attendance (src/server/controllers/router.ts qua authedRead).
 * @param sql Kết nối database dạng chỉ đọc do router mở trong transaction.
 * @param request HTTP Request chứa query parameters (from, to, sport, class_id).
 * @param user Thông tin tài khoản người dùng đang đăng nhập (PublicUser).
 * @returns HTTP response { status: 200, body } chứa dữ liệu báo cáo chuyên cần.
 * @throws 401 nếu chưa đăng nhập, 403 nếu không đủ quyền hoặc cờ F4 tắt, 400 nếu tham số ngày/môn không hợp lệ.
 */
export async function reportsAttendance(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền truy cập (chỉ manager hoặc coach) và kiểm tra cờ tính năng F4 (Attendance & At-risk).
  requireRole(user, ["manager", "coach"]);
  await requireFlag(sql, "F4");
  // Bước 2: Đọc và kiểm tra các tham số lọc ngày, môn thể thao, lớp học từ query string.
  const { from, to, sport, classId } = await windowParams(sql, request);
  // Bước 3: Tạo nội dung báo cáo; nếu là coach thì giới hạn phạm vi trong các lớp họ dạy hoặc trợ giảng.
  const body = await attendanceReportBody(sql, from, to, {
    sport,
    classId,
    coachScopeId: user.role === "coach" ? user.id : null,
  });
  return { status: 200, body };
}

/* ------------------------------------------------------------------ *
 * At-risk list                                                        *
 * ------------------------------------------------------------------ */

// Cấu trúc lý do cảnh báo học viên có nguy cơ bỏ tập: "streak" (vắng liên tiếp) hoặc "idle" (quá lâu không đến)
type RiskReason = { kind: "streak" | "idle"; message: string };

// Thông tin chi tiết của một học viên trong danh sách có nguy cơ bỏ tập (At-risk list, FR-TRN-09, BR-36)
export type AtRiskItem = {
  user_id: string;
  full_name: string;
  member_code: string | null;
  phone: string | null;
  avatar_url: string | null;
  reasons: RiskReason[];
  attendance_pct: number | null;
  last_seen_at: string | null;
  contacted: boolean;
  last_contact: { at: string; outcome: string; note: string | null; by: string | null } | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Types dùng riêng cho atRiskBody và các hàm phụ của nó
// ─────────────────────────────────────────────────────────────────────────────

/** Dòng thành viên trả về từ truy vấn danh sách học viên có chỗ trong lớp đang mở. */
type AtRiskMemberRow = {
  user_id: string;
  full_name: string;
  member_code: string | null;
  phone: string | null;
  avatar_version: number | null;
  class_since: string | null;
  last_seen: string | null;
};

/** Dòng liên lạc gần đây (trong 14 ngày) lấy từ bảng contact_log. */
type AtRiskContactRow = {
  user_id: string;
  reason: string;
  outcome: string;
  note: string | null;
  created_at: string;
  by: string | null;
};

/** Tham số ngưỡng thời gian để xác định học viên "bỏ bê" (idle). */
type AtRiskThresholds = {
  idleDays: number;
  today: string;
  idleSince: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Các hàm phụ của atRiskBody
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Làm gì: đọc cài đặt trung tâm để lấy ngưỡng ngày bỏ bê (at_risk_idle_days),
 *   rồi tính ngày hôm nay và mốc "bỏ bê kể từ" (idleSince) theo giờ Việt Nam.
 * Được gọi ở: atRiskBody, bước 1.
 * @param sql Kết nối database do router mở sẵn.
 * @returns Bộ ba ngưỡng thời gian cần dùng ở các bước sau.
 */
async function loadAtRiskThresholds(sql: Sql): Promise<AtRiskThresholds> {
  const settings = await getSettings(sql);
  const idleDays = settings.at_risk_idle_days;
  const today = ictDateString();
  // idleSince là đầu ngày cách hôm nay idleDays ngày về trước (giờ ICT),
  // dùng để so sánh với last_seen dạng timestamptz trong DB.
  const idleSince = ictDateTime(addDays(today, -idleDays), "00:00").toISOString();
  return { idleDays, today, idleSince };
}

/**
 * Làm gì: lấy danh sách học viên có chỗ xác nhận (confirmed) trong lớp đang mở (open),
 *   kèm lần cuối họ được ghi nhận có mặt (cổng hoặc điểm danh buổi học).
 *   Vì sao lọc theo status = 'active': tài khoản bị khóa không cần gọi điện.
 * Được gọi ở: atRiskBody, bước 2.
 * @param sql Kết nối database do router mở sẵn.
 * @param scopeCoachId Mã coach để lọc chỉ lớp mình dạy; null = manager xem tất cả (FR-TRN-09).
 * @returns Danh sách dòng học viên theo thứ tự trả về của PostgreSQL.
 */
async function fetchAtRiskEnrolledMembers(
  sql: Sql,
  scopeCoachId: string | null,
): Promise<AtRiskMemberRow[]> {
  // Members with a confirmed place in an open class, and the sessions they have been marked on.
  return sql.query<AtRiskMemberRow>(
    `select u.id as user_id, u.full_name, u.member_code, u.phone,
            (select version from user_avatars a where a.user_id = u.id) as avatar_version,
            min(cl.start_on)::text as class_since,
            (select max(a.at) from attendance a
               where a.user_id = u.id and (a.kind = 'gate' or a.result in ('present','late'))) as last_seen
       from users u
       join enrollments e on e.user_id = u.id and e.status = 'confirmed'
       join classes cl on cl.id = e.class_id and cl.status = 'open'
      where u.role = 'member' and u.status = 'active'
        and ($1::uuid is null or cl.coach_id = $1 or cl.assistant_id = $1)
      group by u.id, u.full_name, u.member_code, u.phone`,
    [scopeCoachId],
  );
}

/**
 * Làm gì: tính chuỗi vắng liên tiếp (không có lý do) của từng cặp (học viên, lớp) trong 90 ngày gần nhất,
 *   rồi gom lại để lấy chuỗi dài nhất cho mỗi học viên. Chỉ giữ lại những người đạt hoặc vượt ngưỡng BR-36.
 *   Vì sao 90 ngày: đủ rộng để bắt chuỗi vắng thực tế mà không tốn truy vấn quá lâu.
 * Được gọi ở: atRiskBody, bước 3.
 * @param sql Kết nối database do router mở sẵn.
 * @param today Ngày hôm nay dạng YYYY-MM-DD từ loadAtRiskThresholds.
 * @param scopeCoachId Mã coach để lọc chỉ lớp mình dạy; null = tất cả.
 * @returns Map từ user_id → số buổi vắng liên tiếp nhiều nhất (chỉ những người đạt ngưỡng).
 */
async function computeAtRiskAbsentStreaks(
  sql: Sql,
  today: string,
  scopeCoachId: string | null,
): Promise<Map<string, number>> {
  // Bước 1: Truy vấn kết quả điểm danh các buổi học trong 90 ngày gần nhất của học viên có chỗ xác nhận (confirmed).
  // Absent streaks (a) include people who have since left the open classes — they are still on the roll.
  const streakRows = await sql.query<{ user_id: string; class_id: string; result: string }>(
    `select a.user_id, s.class_id, a.result::text as result
       from attendance a join sessions s on s.id = a.session_id
       join enrollments e on e.class_id = s.class_id and e.user_id = a.user_id and e.status = 'confirmed'
      where a.kind = 'session' and a.result is not null and s.status <> 'cancelled'
        and s.start_at >= $1 and ($2::uuid is null or s.class_id in (
              select id from classes where coach_id = $2 or assistant_id = $2))
      order by s.start_at`,
    [ictDateTime(addDays(today, -90), "00:00").toISOString(), scopeCoachId],
  );

  // Gom các kết quả điểm danh theo từng cặp (học viên, lớp).
  const perPair = new Map<string, { user_id: string; marks: string[] }>();
  for (const row of streakRows) {
    const pairKey = `${row.user_id}|${row.class_id}`;
    const entry = perPair.get(pairKey) ?? { user_id: row.user_id, marks: [] };
    entry.marks.push(row.result);
    perPair.set(pairKey, entry);
  }

  // Với mỗi cặp, tính chuỗi vắng cuối dãy; lấy chuỗi dài nhất cho từng học viên.
  const streakByUser = new Map<string, number>();
  for (const entry of perPair.values()) {
    const streakLength = absentStreak(entry.marks);
    if (streakLength >= ABSENT_STREAK_LIMIT) {
      const previousBest = streakByUser.get(entry.user_id) ?? 0;
      streakByUser.set(entry.user_id, Math.max(previousBest, streakLength));
    }
  }

  return streakByUser;
}

/**
 * Làm gì: lấy tỉ lệ điểm danh (present + late / tổng không tính excused) của mỗi học viên
 *   trong 60 ngày gần nhất để hiển thị bên cạnh từng dòng danh sách.
 *   Vì sao 60 ngày: đủ có ý nghĩa thống kê mà không dài quá mức.
 * Được gọi ở: atRiskBody, bước 4.
 * @param sql Kết nối database do router mở sẵn.
 * @param today Ngày hôm nay dạng YYYY-MM-DD từ loadAtRiskThresholds.
 * @returns Map từ user_id → Counts (present, late, absent, excused) trong 60 ngày.
 */
async function fetchAtRiskAttendanceRates(
  sql: Sql,
  today: string,
): Promise<Map<string, Counts>> {
  // Attendance share over the last 60 days, shown beside each row.
  const rateRows = await sql.query<{ user_id: string } & Counts>(
    `select a.user_id,
            count(*) filter (where a.result = 'present')::int as present,
            count(*) filter (where a.result = 'late')::int as late,
            count(*) filter (where a.result = 'absent')::int as absent,
            count(*) filter (where a.result = 'excused')::int as excused
       from attendance a join sessions s on s.id = a.session_id
      where a.kind = 'session' and a.result is not null and s.status <> 'cancelled' and s.start_at >= $1
      group by a.user_id`,
    [ictDateTime(addDays(today, -60), "00:00").toISOString()],
  );
  return new Map(rateRows.map((row) => [row.user_id, row]));
}

/**
 * Làm gì: với những học viên đang có chuỗi vắng nhưng không còn chỗ trong lớp mở nào
 *   (tức là không có trong danh sách fetchAtRiskEnrolledMembers), vẫn cần dữ liệu cơ bản
 *   để hiển thị dòng của họ. Hàm này bổ sung những người đó vào map.
 *   Vì sao: BR-36 áp dụng cả với người đã rời lớp — họ vẫn cần được gọi.
 * Được gọi ở: atRiskBody, bước 5.
 * @param sql Kết nối database do router mở sẵn.
 * @param byId Map học viên hiện có, sẽ được bổ sung thêm (thay đổi trực tiếp).
 * @param streakByUser Map chuỗi vắng từ computeAtRiskAbsentStreaks; dùng để tìm ai còn thiếu.
 */
async function supplementAtRiskStreakOnlyMembers(
  sql: Sql,
  byId: Map<string, AtRiskMemberRow>,
  streakByUser: Map<string, number>,
): Promise<void> {
  // A student on a streak who has no open class any more still needs the row.
  const missingUserIds = [...streakByUser.keys()].filter((userId) => !byId.has(userId));
  if (missingUserIds.length) {
    const extraMembers = await sql.query<AtRiskMemberRow>(
      `select u.id as user_id, u.full_name, u.member_code, u.phone,
              (select version from user_avatars a where a.user_id = u.id) as avatar_version,
              null::text as class_since,
              (select max(a.at) from attendance a
                 where a.user_id = u.id and (a.kind = 'gate' or a.result in ('present','late'))) as last_seen
         from users u where u.id = any($1::uuid[]) and u.role = 'member' and u.status = 'active'`,
      [missingUserIds],
    );
    for (const member of extraMembers) {
      byId.set(member.user_id, member);
    }
  }
}

/**
 * Làm gì: lấy tất cả liên lạc gần đây (trong 14 ngày) để kiểm tra học viên nào đã được gọi.
 *   Vì sao 14 ngày: đủ để không hiển thị "chưa liên lạc" ngay sau khi vừa gọi xong.
 * Được gọi ở: atRiskBody, bước 6.
 * @param sql Kết nối database do router mở sẵn.
 * @returns Danh sách dòng liên lạc, mới nhất trước.
 */
async function fetchAtRiskRecentContacts(sql: Sql): Promise<AtRiskContactRow[]> {
  return sql.query<AtRiskContactRow>(
    `select c.user_id, c.reason, c.outcome, c.note, c.created_at, u.full_name as by
       from contact_log c left join users u on u.id = c.created_by
      where c.created_at >= now() - interval '14 days' order by c.created_at desc`,
  );
}

/**
 * Làm gì: với một học viên cụ thể, xác định xem họ có lý do "bỏ bê" (idle) không.
 *   Quy tắc: học viên phải đã có chỗ đủ lâu (class_since <= today - idleDays) VÀ
 *   lần cuối ghi nhận có mặt (last_seen) phải trước mốc idleSince — hoặc chưa bao giờ đến.
 *   Vì sao tách thành hàm: điều kiện gốc là một biểu thức ternary lồng khó đọc.
 * Được gọi ở: buildAtRiskItems, trong vòng lặp qua từng học viên.
 * @param member Dòng học viên từ fetchAtRiskEnrolledMembers hoặc supplementAtRiskStreakOnlyMembers.
 * @param thresholds Ngưỡng thời gian từ loadAtRiskThresholds.
 * @returns true nếu học viên đủ điều kiện "bỏ bê".
 */
function isAtRiskIdle(member: AtRiskMemberRow, thresholds: AtRiskThresholds): boolean {
  const { idleDays, today, idleSince } = thresholds;

  // Học viên chưa có chỗ đủ lâu thì chưa tính là bỏ bê.
  const hasBeenEnrolledLongEnough =
    member.class_since != null && member.class_since <= addDays(today, -idleDays);
  if (!hasBeenEnrolledLongEnough) {
    return false;
  }

  // Chưa bao giờ đến (last_seen = null) cũng tính là bỏ bê.
  if (!member.last_seen) {
    return true;
  }

  // So sánh timestamp: last_seen phải trước mốc idleSince.
  const lastSeenTime = new Date(member.last_seen).getTime();
  const idleSinceTime = new Date(idleSince).getTime();
  return lastSeenTime < idleSinceTime;
}

/**
 * Làm gì: dựng danh sách AtRiskItem từ các dữ liệu đã tải, rồi sắp xếp theo thứ tự ưu tiên:
 *   chưa liên lạc trước, nhiều lý do hơn trước, cùng điều kiện thì xếp theo tên.
 *   Học viên không có lý do nào sẽ bị bỏ qua (không đưa vào danh sách).
 * Được gọi ở: atRiskBody, bước 7.
 * @param byId Map toàn bộ học viên cần kiểm tra (đã gộp cả streak-only từ bước 5).
 * @param streakByUser Map chuỗi vắng từ computeAtRiskAbsentStreaks.
 * @param rateByUser Map tỉ lệ điểm danh 60 ngày từ fetchAtRiskAttendanceRates.
 * @param contacts Danh sách liên lạc gần đây từ fetchAtRiskRecentContacts.
 * @param thresholds Ngưỡng thời gian từ loadAtRiskThresholds.
 * @returns Danh sách AtRiskItem đã sắp xếp.
 */
function buildAtRiskItems(
  byId: Map<string, AtRiskMemberRow>,
  streakByUser: Map<string, number>,
  rateByUser: Map<string, Counts>,
  contacts: AtRiskContactRow[],
  thresholds: AtRiskThresholds,
): AtRiskItem[] {
  const items: AtRiskItem[] = [];

  for (const member of byId.values()) {
    const reasons: RiskReason[] = [];

    // Lý do (a): vắng liên tiếp không có lý do (BR-36).
    const streakLength = streakByUser.get(member.user_id);
    if (streakLength) {
      reasons.push({ kind: "streak", message: `Absent ${streakLength} sessions in a row without an excuse.` });
    }

    // Lý do (b): có chỗ nhưng không đến lớp hoặc cổng suốt idleDays ngày.
    if (isAtRiskIdle(member, thresholds)) {
      reasons.push({ kind: "idle", message: `No visit or class in ${thresholds.idleDays}+ days.` });
    }

    // Không có lý do nào thì bỏ qua học viên này.
    if (reasons.length === 0) {
      continue;
    }

    const attendanceCounts = rateByUser.get(member.user_id);
    const attendancePct = attendanceCounts ? rateOf(attendanceCounts) : null;

    // Lọc ra các lần liên lạc khớp với lý do hiện tại (hoặc lý do "other" luôn tính).
    const relevantContacts = contacts.filter(
      (contact) =>
        contact.user_id === member.user_id &&
        reasons.some((reason) => reason.kind === contact.reason || contact.reason === "other"),
    );
    const mostRecentContact = relevantContacts[0] ?? null;

    items.push({
      user_id: member.user_id,
      full_name: member.full_name,
      member_code: member.member_code,
      phone: member.phone,
      avatar_url: member.avatar_version != null ? `/v1/users/${member.user_id}/avatar?v=${member.avatar_version}` : null,
      reasons,
      attendance_pct: attendancePct,
      last_seen_at: member.last_seen,
      contacted: relevantContacts.length > 0,
      last_contact: mostRecentContact
        ? { at: mostRecentContact.created_at, outcome: mostRecentContact.outcome, note: mostRecentContact.note, by: mostRecentContact.by }
        : null,
    });
  }

  // Not yet contacted first, then the most reasons, then name.
  items.sort(
    (a, b) =>
      Number(a.contacted) - Number(b.contacted) ||
      b.reasons.length - a.reasons.length ||
      a.full_name.localeCompare(b.full_name),
  );

  return items;
}

/**
 * Làm gì: tổng hợp danh sách học viên có nguy cơ bỏ học để trung tâm gọi điện kịp thời.
 *   Hai tín hiệu được kiểm tra cho mỗi học viên:
 *   (a) vắng liên tiếp ABSENT_STREAK_LIMIT buổi không có lý do (BR-36),
 *   (b) có chỗ trong lớp mở nhưng không đến lớp hoặc cổng suốt at_risk_idle_days ngày.
 *   Học viên "đã được liên lạc" vẫn hiển thị trong 14 ngày để xem lịch sử.
 *   Thứ tự các bước dưới đây là cố ý: truy vấn nào đứng trước chạy trước.
 * Được gọi ở:
 *   - atRiskList (cùng file), được gọi qua router.ts dòng 561:
 *     GET /v1/at-risk → authedRead → atRiskList → atRiskBody.
 *   - Màn hình /desk/at-risk (src/routes/desk.at-risk.tsx, component AtRiskPanel)
 *     và tab "At risk" trong /manager/attendance (src/routes/manager.attendance.tsx).
 * @param sql Kết nối database; authedRead mở transaction chỉ-đọc trước khi gọi.
 * @param scopeCoachId Mã UUID của coach đang đăng nhập (lọc theo lớp của họ), hoặc null nếu là manager (xem tất cả).
 * @returns Danh sách AtRiskItem đã sắp xếp và số ngày ngưỡng bỏ bê (để UI hiển thị).
 */
export async function atRiskBody(sql: Sql, scopeCoachId: string | null): Promise<{ items: AtRiskItem[]; idle_days: number }> {
  // Bước 1: đọc cài đặt ngưỡng và tính các mốc thời gian cần dùng.
  const thresholds = await loadAtRiskThresholds(sql);

  // Bước 2: lấy học viên đang có chỗ xác nhận trong lớp mở.
  const enrolledMembers = await fetchAtRiskEnrolledMembers(sql, scopeCoachId);
  const byId = new Map(enrolledMembers.map((member) => [member.user_id, member]));

  // Bước 3: tính chuỗi vắng liên tiếp trong 90 ngày (lý do BR-36).
  const streakByUser = await computeAtRiskAbsentStreaks(sql, thresholds.today, scopeCoachId);

  // Bước 4: lấy tỉ lệ điểm danh 60 ngày để hiển thị bên cạnh mỗi dòng.
  const rateByUser = await fetchAtRiskAttendanceRates(sql, thresholds.today);

  // Bước 5: bổ sung học viên đang có chuỗi vắng nhưng đã không còn chỗ trong lớp mở.
  await supplementAtRiskStreakOnlyMembers(sql, byId, streakByUser);

  // Bước 6: lấy lịch sử liên lạc gần đây (14 ngày) để đánh dấu "đã liên lạc".
  const contacts = await fetchAtRiskRecentContacts(sql);

  // Bước 7: dựng và sắp xếp danh sách cuối cùng.
  const items = buildAtRiskItems(byId, streakByUser, rateByUser, contacts, thresholds);

  return { items, idle_days: thresholds.idleDays };
}

/**
 * Làm gì: API endpoint lấy danh sách học viên có nguy cơ bỏ học (at-risk) kèm số ngày ngưỡng bỏ bê.
 *   Phân quyền dữ liệu theo vai trò: coach chỉ thấy học viên trong các lớp mình phụ trách; manager và receptionist xem toàn trung tâm.
 * Được gọi ở:
 *   - src/server/controllers/router.ts dòng 561 (route GET /v1/at-risk qua authedRead).
 * @param sql Kết nối database do router mở sẵn trong transaction chỉ-đọc.
 * @param user Thông tin người dùng đăng nhập lấy từ session token.
 * @returns Phản hồi HTTP 200 kèm danh sách học viên có nguy cơ (items) và ngưỡng ngày bỏ bê (idle_days).
 * @throws 403 nếu tài khoản không có vai trò phù hợp hoặc tính năng F4 đang bị tắt (SRS BR-52).
 */
export async function atRiskList(sql: Sql, user: PublicUser) {
  // Bước 1: Kiểm tra quyền truy cập và cờ tính năng F4 (chỉ manager, coach, receptionist).
  requireRole(user, ["manager", "coach", "receptionist"]);
  await requireFlag(sql, "F4");
  // Bước 2: Gọi atRiskBody; coach chỉ xem học viên lớp mình dạy, manager và lễ tân xem toàn trung tâm.
  return { status: 200, body: await atRiskBody(sql, user.role === "coach" ? user.id : null) };
}

/* ------------------------------------------------------------------ *
 * Contact log                                                         *
 * ------------------------------------------------------------------ */

/** "Contacted" — who called whom, why, and what came of it. Not a message sender. */
/**
 * Làm gì: ghi nhận một lần liên lạc (gọi điện, nhắn tin, gặp mặt) với học viên vào bảng contact_log,
 *   phục vụ việc theo dõi chăm sóc học viên có nguy cơ bỏ học (SRS v1.4.1 FR-TRN-09) và ghi audit log.
 * Được gọi ở:
 *   - src/server/controllers/router.ts dòng 564 (route POST /v1/contacts qua authed).
 *   - Modal chăm sóc học viên: src/client/components/attendance-panels.tsx (hàm submitContact).
 *   - Test luồng chăm sóc khách hàng: scripts/arena3-srs141-check.mjs dòng 364.
 * @param sql Kết nối database do router mở sẵn trong transaction ghi.
 * @param request HTTP request chứa body JSON: user_id, reason, channel, outcome, note.
 * @param user Thông tin nhân viên đang đăng nhập (manager, coach, receptionist).
 * @returns Phản hồi HTTP 201 kèm bản ghi contact_log vừa tạo.
 * @throws 403 nếu sai vai trò, tính năng F4 bị tắt, hoặc coach liên lạc với học viên ngoài lớp mình phụ trách.
 * @throws 404 nếu không tìm thấy học viên trong hệ thống (role = 'member').
 * @throws 422 nếu thiếu user_id, reason/channel/outcome không hợp lệ, hoặc note dài quá 500 ký tự.
 */
export async function contactCreate(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn và cờ tính năng F4 (chỉ manager, coach, receptionist được ghi nhận).
  requireRole(user, ["manager", "coach", "receptionist"]);
  await requireFlag(sql, "F4");
  // Bước 2: Đọc body request và xác thực học viên tồn tại trong hệ thống.
  const b = await readJson(request);
  const userId = str(b.user_id) ?? "";
  if (!UUID_RE.test(userId)) throw err.field("user_id", "Choose a member.");
  const member = await one<{ id: string }>(sql, `select id from users where id = $1 and role = 'member'`, [userId]);
  if (!member) throw err.notFound("Member not found.");
  // Bước 3: Nếu là coach, bắt buộc học viên phải thuộc lớp mình dạy chính hoặc trợ giảng.
  if (user.role === "coach") {
    const inScope = await one(
      sql,
      `select 1 as ok from enrollments e join classes cl on cl.id = e.class_id
        where e.user_id = $1 and e.status = 'confirmed' and (cl.coach_id = $2 or cl.assistant_id = $2) limit 1`,
      [userId, user.id],
    );
    if (!inScope) throw err.forbidden("That member is not in your classes.");
  }
  // Bước 4: Chuẩn hóa dữ liệu đầu vào (lý do, kênh liên lạc, kết quả cuộc gọi, ghi chú).
  const reason = oneOf(CONTACT_REASONS, b.reason, "reason", "other");
  const channel = oneOf(CONTACT_CHANNELS, b.channel, "channel", "phone");
  const outcome = oneOf(CONTACT_OUTCOMES, b.outcome, "outcome");
  const note = (str(b.note) ?? "").trim();
  if (note.length > 500) throw err.field("note", "Keep the note under 500 characters.");
  // Bước 5: Lưu thông tin liên lạc vào bảng contact_log.
  // created_by lưu id nhân viên thực hiện để truy vết trách nhiệm.
  const row = await one(
    sql,
    `insert into contact_log (user_id, reason, channel, outcome, note, created_by)
     values ($1,$2,$3,$4,$5,$6) returning *`,
    [userId, reason, channel, outcome, note || null, user.id],
  );
  // Ghi nhận nhật ký kiểm toán (audit log) để quản lý theo dõi lịch sử chăm sóc học viên.
  await audit(sql, user.id, "contact_logged", "user", userId, null, { reason, outcome });
  // Bước 6: Trả về HTTP 201 Created cùng dữ liệu bản ghi vừa tạo.
  return { status: 201, body: row };
}

/**
 * Làm gì: lấy lịch sử các lần liên lạc (tối đa 50 lần gần nhất) của một học viên cụ thể từ bảng contact_log.
 *   Coach chỉ được xem học viên thuộc lớp mình phụ trách; manager và receptionist xem được mọi học viên.
 * Được gọi ở:
 *   - src/server/controllers/router.ts dòng 567 (route GET /v1/members/:id/contacts qua authedRead).
 *   - Test kiểm tra lịch sử liên lạc: scripts/arena3-srs141-check.mjs dòng 370.
 * @param sql Kết nối database do router mở sẵn trong transaction chỉ-đọc.
 * @param memberId Mã UUID của học viên cần tra cứu lịch sử liên lạc.
 * @param user Thông tin tài khoản người dùng đăng nhập (manager, coach, receptionist).
 * @returns Phản hồi HTTP 200 kèm danh sách tối đa 50 bản ghi liên lạc (items).
 * @throws 403 nếu sai vai trò, tính năng F4 bị tắt, hoặc coach xem học viên ngoài lớp mình.
 * @throws 404 nếu memberId không đúng định dạng UUID.
 */
export async function contactList(sql: Sql, memberId: string, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn, cờ tính năng F4 và định dạng UUID của học viên.
  requireRole(user, ["manager", "coach", "receptionist"]);
  await requireFlag(sql, "F4");
  if (!UUID_RE.test(memberId)) throw err.notFound();
  // Bước 2: Kiểm tra phạm vi nếu là coach (chỉ được xem học viên lớp mình dạy hoặc trợ giảng).
  if (user.role === "coach") {
    // A coach reads about their own students only, the same limit as writing one.
    const inScope = await one(
      sql,
      `select 1 as ok from enrollments e join classes cl on cl.id = e.class_id
        where e.user_id = $1 and e.status = 'confirmed' and (cl.coach_id = $2 or cl.assistant_id = $2) limit 1`,
      [memberId, user.id],
    );
    if (!inScope) throw err.forbidden("That member is not in your classes.");
  }
  // Bước 3: Truy vấn 50 lần liên lạc gần nhất, kết hợp bảng users để lấy tên nhân viên thực hiện.
  const items = await sql.query(
    `select c.id, c.reason, c.channel, c.outcome, c.note, c.created_at, u.full_name as created_by_name
       from contact_log c left join users u on u.id = c.created_by
      where c.user_id = $1 order by c.created_at desc limit 50`,
    [memberId],
  );
  // Bước 4: Trả về HTTP 200 kèm danh sách lịch sử liên lạc.
  return { status: 200, body: { items } };
}
