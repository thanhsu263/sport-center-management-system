/**
 * Phase 4C — the F4 training module (SRS v1.4 §FR-TRN).
 *
 * Every route here sits behind the F4 flag (BR-52) and never touches money or a
 * membership's balance (BR-47): homework, results and reviews are the coach's
 * record of how a student is doing, nothing the till reads.
 *
 * Who may see a student: a manager sees everyone; a coach sees only students
 * enrolled in a class they lead or assist (BR-45). A student's health notes
 * only leave this module inside that scope (BR-46).
 */
import type { Sql } from "@/server/data/db";
import { err } from "../errors";
import { requireFlag } from "../../services/flags";
import { audit, enqueue, readJson, sqlPatch, str } from "../helpers";
import {
  ABSENT_STREAK_LIMIT,
  LEVELS,
  PLAN_PHASES,
  INTENSITIES,
  TRAINING_GOALS,
  absentStreak,
  homeworkComplete,
  normalizeChecklist,
  normalizeDone,
  validateMetrics,
} from "../../services/rules";
import { getActiveSportCodes } from "./sports";
import { requireRole, type PublicUser } from "../session";
import { addDays, ictDateString, ictDateTime } from "../../../shared/arena3/time";
import { one } from "../tx";

// Biểu thức chính quy kiểm tra định dạng chuỗi UUID (8-4-4-4-12 ký tự hex)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Biểu thức chính quy kiểm tra định dạng ngày chuỗi YYYY-MM-DD
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Số mili-giây trong một ngày (24 * 60 * 60 * 1000 = 86.400.000 ms)
const DAY_MS = 86_400_000;

/**
 * Làm gì: Trích xuất và kiểm tra một giá trị đầu vào phải là chuỗi UUID hợp lệ.
 * Được gọi ở: sessionResultsPut, homeworkCreate, trainingCreate, plansFromTemplate, plansDuplicateWeek, trainingPatch (src/server/controllers/handlers/training.ts).
 * @param v Giá trị thô nhận từ client (thường là string hoặc unknown).
 * @param field Tên trường dùng để gắn nhãn trong thông báo lỗi nếu không hợp lệ.
 * @returns Chuỗi UUID hợp lệ đã được chuẩn hóa.
 * @throws Lỗi 400 (Bad Request) dạng err.field nếu trường bị thiếu hoặc không đúng định dạng UUID.
 */
function uuidField(v: unknown, field: string): string {
  const s = str(v);
  if (!s || !UUID_RE.test(s)) throw err.field(field, `${field} is required.`);
  return s;
}

/**
 * Làm gì: Kiểm tra định dạng UUID của tham số ID trên đường dẫn URL (path parameter).
 * Được gọi ở: sessionScope, loadStudent, templateSave, planVersions, trainingPatch, meHomeworkPut (src/server/controllers/handlers/training.ts).
 * @param id Chuỗi ID truyền qua đường dẫn URL.
 * @returns Chuỗi UUID hợp lệ.
 * @throws Lỗi 404 (Not Found) nếu ID sai định dạng UUID để tránh lỗi cú pháp truy vấn SQL.
 */
function pathId(id: string): string {
  if (!UUID_RE.test(id)) throw err.notFound();
  return id;
}

/* ------------------------------------------------------------------ *
 * Scope                                                               *
 * ------------------------------------------------------------------ */

// Kiểu dữ liệu đại diện cho ban giảng dạy của lớp học gồm HLV chính và trợ giảng
type ClassStaff = { id: string; coach_id: string; assistant_id: string | null; status: string; sport: string };

/**
 * Làm gì: Tải thông tin nhân sự và trạng thái của lớp học để phục vụ việc kiểm tra phân quyền (HLV chính, trợ giảng).
 * Được gọi ở: homeworkCreate, trainingCreate, plansFromTemplate, plansDuplicateWeek, trainingPatch, classPlanWeek (src/server/controllers/handlers/training.ts).
 * @param sql Kết nối cơ sở dữ liệu (Sql).
 * @param classId ID của lớp học cần tra cứu.
 * @returns Bản ghi thông tin nhân sự của lớp (ClassStaff).
 * @throws Lỗi 404 (Not Found) nếu không tìm thấy lớp học trong bảng classes.
 */
async function loadClass(sql: Sql, classId: string): Promise<ClassStaff> {
  const cl = await one<ClassStaff>(
    sql,
    `select id, coach_id, assistant_id, status::text as status, sport::text as sport from classes where id = $1`,
    [classId],
  );
  if (!cl) throw err.notFound("Class not found.");
  return cl;
}

/** A coach works only the classes they lead or assist; a manager works them all. */
/**
 * Làm gì: Kiểm tra quyền phụ trách lớp học (BR-45): HLV chỉ được thao tác với lớp mình dạy chính hoặc trợ giảng, quản lý có quyền trên mọi lớp.
 * Được gọi ở: sessionScope, homeworkCreate, trainingCreate, plansFromTemplate, plansDuplicateWeek, trainingPatch, classPlanWeek (training.ts), enrollmentDelete (src/server/controllers/handlers/classes.ts).
 * @param cl Đối tượng chứa coach_id và assistant_id của lớp học.
 * @param user Thông tin người dùng đang thực hiện request (PublicUser).
 * @returns Không trả về giá trị (void) nếu hợp lệ.
 * @throws Lỗi 403 (Forbidden) nếu người dùng không phải quản lý và không phụ trách lớp này.
 */
export function assertClassStaff(cl: { coach_id: string; assistant_id: string | null }, user: PublicUser) {
  // Quản lý (manager) có toàn quyền truy cập và thao tác với mọi lớp học.
  if (user.role === "manager") return;
  // Huấn luyện viên chính hoặc trợ giảng được phân công cho lớp có quyền làm việc với lớp này (BR-45).
  if (cl.coach_id === user.id || cl.assistant_id === user.id) return;
  // Từ chối quyền truy cập nếu tài khoản không thuộc ban giảng dạy của lớp.
  throw err.forbidden("That class is not yours.");
}

/**
 * Load a session and check the caller may work it (BR-45).
 * Used by the attendance routes as well, so it lives here.
 */
/**
 * Làm gì: Tải thông tin buổi học kèm lớp học và xác thực quyền hạn làm việc của người dùng đối với buổi học đó (BR-45).
 * Được gọi ở: sessionAttendancePost, sessionAttendancePut (src/server/controllers/handlers/ops.ts), sessionResultsGet, sessionResultsPut (training.ts).
 * @param sql Kết nối cơ sở dữ liệu (Sql).
 * @param sessionId ID của buổi học cần kiểm tra phạm vi.
 * @param user Thông tin người dùng đang thực hiện thao tác.
 * @returns Thông tin chi tiết của buổi học (id, class_id, status, start_at, end_at, coach_id, assistant_id, sport).
 * @throws Lỗi 404 (Not Found) nếu không tìm thấy buổi học; lỗi 403 (Forbidden) nếu HLV không phụ trách lớp.
 */
export async function sessionScope(sql: Sql, sessionId: string, user: PublicUser) {
  // Bước 1: Truy vấn thông tin buổi học kết hợp với lớp học (HLV chính, trợ giảng, môn thể thao).
  const s = await one<{
    id: string;
    class_id: string;
    status: string;
    start_at: string;
    end_at: string;
    coach_id: string;
    assistant_id: string | null;
    sport: string;
  }>(
    sql,
    `select s.id, s.class_id, s.status::text as status, s.start_at, s.end_at,
            cl.coach_id, cl.assistant_id, cl.sport::text as sport
       from sessions s join classes cl on cl.id = s.class_id
      where s.id = $1`,
    [pathId(sessionId)],
  );
  // Bước 2: Báo lỗi 404 nếu không tìm thấy buổi học.
  if (!s) throw err.notFound();
  // Bước 3: Xác minh quyền hạn của người gọi đối với lớp học tương ứng (BR-45).
  assertClassStaff(s, user);
  return s;
}

/**
 * Làm gì: Kiểm tra một học viên có thuộc phạm vi quản lý của người dùng hay không (BR-45, BR-46).
 * Được gọi ở: loadStudent (src/server/controllers/handlers/training.ts).
 * @param sql Kết nối cơ sở dữ liệu (Sql).
 * @param studentId ID của học viên cần kiểm tra.
 * @param user Thông tin người dùng đang kiểm tra (coach hoặc manager).
 * @returns true nếu người dùng là manager hoặc là HLV/trợ giảng lớp học viên đang ghi danh; ngược lại false.
 */
async function studentInScope(sql: Sql, studentId: string, user: PublicUser): Promise<boolean> {
  // Quản lý (manager) có quyền xem và quản lý tất cả học viên trong hệ thống.
  if (user.role === "manager") return true;
  // HLV chỉ được xem học viên đang theo học (confirmed) trong lớp mình dạy chính hoặc trợ giảng (BR-45, BR-46).
  const row = await one(
    sql,
    `select 1 as ok from enrollments e join classes cl on cl.id = e.class_id
      where e.user_id = $1 and e.status = 'confirmed' and (cl.coach_id = $2 or cl.assistant_id = $2)
      limit 1`,
    [studentId, user.id],
  );
  return !!row;
}

// Kiểu dữ liệu thông tin cơ bản của học viên kèm ghi chú sức khỏe nhạy cảm (BR-46)
type Student = {
  id: string;
  full_name: string;
  member_code: string | null;
  date_of_birth: string | null;
  health_notes: string | null;
};

/**
 * Làm gì: Tải hồ sơ học viên (vai trò 'member') và kiểm tra quyền truy cập theo phạm vi quản lý (BR-45, BR-46).
 * Được gọi ở: studentProfile, studentLevelPut, studentNotePost, studentReviewPost (src/server/controllers/handlers/training.ts).
 * @param sql Kết nối cơ sở dữ liệu (Sql).
 * @param id ID của học viên cần tải hồ sơ.
 * @param user Thông tin người dùng đang yêu cầu dữ liệu.
 * @returns Thông tin học viên (Student) gồm họ tên, mã hội viên, ngày sinh, ghi chú sức khỏe.
 * @throws Lỗi 404 nếu không tìm thấy học viên; lỗi 403 nếu học viên không thuộc lớp do HLV này giảng dạy.
 */
async function loadStudent(sql: Sql, id: string, user: PublicUser): Promise<Student> {
  // Bước 1: Truy vấn thông tin học viên (role = 'member') từ bảng users theo ID.
  const u = await one<Student>(
    sql,
    `select id, full_name, member_code, date_of_birth::text as date_of_birth, health_notes
       from users where id = $1 and role = 'member'`,
    [pathId(id)],
  );
  // Bước 2: Báo lỗi 404 nếu không tìm thấy học viên trong hệ thống.
  if (!u) throw err.notFound("Student not found.");
  // Bước 3: Kiểm tra học viên có thuộc phạm vi phụ trách của HLV/quản lý hay không (BR-45, BR-46).
  if (!(await studentInScope(sql, u.id, user))) throw err.forbidden("That student is not in your classes.");
  return u;
}

/**
 * Làm gì: Kiểm tra giá trị đầu vào có thuộc danh sách chuỗi giá trị cho phép (whitelist) hay không.
 * Được gọi ở: meTrainingGoal, studentLevelPut, studentReviewPost, homeworkCreate, trainingCreate, trainingPatch (src/server/controllers/handlers/training.ts).
 * @param list Danh sách các giá trị chuỗi hợp lệ được chấp nhận.
 * @param v Giá trị thô nhận được từ client.
 * @param field Tên trường dữ liệu dùng để hiển thị lỗi khi không khớp.
 * @returns Giá trị chuỗi hợp lệ thuộc kiểu T.
 * @throws Lỗi 400 (Bad Request) dạng err.field nếu giá trị không nằm trong danh sách cho phép.
 */
function oneOf<T extends string>(list: readonly T[], v: unknown, field: string): T {
  const s = str(v);
  if (!s || !(list as readonly string[]).includes(s)) {
    throw err.field(field, `${field} must be one of: ${list.join(", ")}.`);
  }
  return s as T;
}

/* ------------------------------------------------------------------ *
 * Student profile (FR-TRN-03)                                         *
 * ------------------------------------------------------------------ */

/**
 * Làm gì: Lấy toàn bộ hồ sơ tập luyện của học viên gồm mục tiêu, trình độ thể thao, ghi chú HLV, đánh giá tiến độ, kết quả buổi tập, chuyên cần và bài tập về nhà (FR-TRN-03).
 * Được gọi ở: Route GET /v1/students/:id/profile (src/server/controllers/router.ts:670-671).
 * @param sql Kết nối cơ sở dữ liệu (Sql).
 * @param id ID của học viên cần xem hồ sơ.
 * @param user Thông tin người dùng đăng nhập (yêu cầu vai trò coach hoặc manager).
 * @returns Đối tượng HTTP response { status: 200, body: { student, goal, levels, notes, reviews, results, attendance, homework } }.
 * @throws Lỗi 403 nếu sai vai trò hoặc không phụ trách học viên; lỗi 404 nếu không tìm thấy; lỗi nếu cờ F4 tắt (BR-52).
 */
export async function studentProfile(sql: Sql, id: string, user: PublicUser) {
  // Bước 1: Xác thực quyền hạn (coach hoặc manager) và kiểm tra cờ tính năng F4 (BR-52).
  requireRole(user, ["coach", "manager"]);
  await requireFlag(sql, "F4");
  // Bước 2: Tải thông tin học viên và đảm bảo học viên thuộc phạm vi phụ trách (BR-45, BR-46).
  const student = await loadStudent(sql, id, user);
  // Bước 3: Lấy mục tiêu tập luyện (training_profiles) và trình độ từng môn thể thao (member_levels).
  const goal = await one<{ goal: string | null }>(sql, `select goal from training_profiles where user_id = $1`, [student.id]);
  const levels = await sql.query(
    `select sport::text as sport, level, updated_at from member_levels where user_id = $1 order by sport`,
    [student.id],
  );
  // Bước 4: Lấy danh sách 30 ghi chú gần nhất của HLV (coach_notes) và 20 đánh giá tiến độ định kỳ gần nhất (progress_reviews).
  const notes = await sql.query(
    `select n.id, n.body, n.created_at, c.full_name as coach_name
       from coach_notes n join users c on c.id = n.coach_id
      where n.user_id = $1 order by n.created_at desc limit 30`,
    [student.id],
  );
  const reviews = await sql.query(
    `select r.id, r.sport::text as sport, r.period_weeks, r.technique, r.fitness, r.attitude, r.comment,
            r.created_at, c.full_name as coach_name
       from progress_reviews r join users c on c.id = r.coach_id
      where r.user_id = $1 order by r.created_at desc limit 20`,
    [student.id],
  );
  // Bước 5: Lấy kết quả 20 buổi tập gần nhất (session_results) kèm thời gian và môn thể thao tương ứng.
  const results = await sql.query(
    `select r.session_id, r.plan_pct, r.metrics, r.note, r.recorded_at, s.start_at, cl.sport::text as sport
       from session_results r
       join sessions s on s.id = r.session_id
       join classes cl on cl.id = s.class_id
      where r.user_id = $1 order by s.start_at desc limit 20`,
    [student.id],
  );
  // Bước 6: Thống kê số lượt chuyên cần (có mặt, đi trễ, vắng mặt, có phép) từ bảng attendance.
  const counts = { present: 0, late: 0, absent: 0, excused: 0 } as Record<string, number>;
  const marks = await sql.query<{ result: string; n: number }>(
    `select result::text as result, count(*)::int as n from attendance
      where user_id = $1 and kind = 'session' and result is not null group by result`,
    [student.id],
  );
  for (const m of marks) if (m.result in counts) counts[m.result] = m.n;
  // Bước 7: Lấy 20 bài tập về nhà gần nhất được giao kèm trạng thái hoàn thành các mục (done_items).
  const homework = await sql.query(
    `select h.id, h.title, h.due_on::text as due_on, h.checklist, r.done_items, r.completed_at
       from homework_recipients r join homework h on h.id = r.homework_id
      where r.user_id = $1 order by h.created_at desc limit 20`,
    [student.id],
  );
  // Bước 8: Tổng hợp và trả về hồ sơ tập luyện đầy đủ của học viên.
  return {
    status: 200,
    body: { student, goal: goal?.goal ?? null, levels, notes, reviews, results, attendance: counts, homework },
  };
}

/**
 * Làm gì: Cho phép học viên (member) tự cập nhật hoặc xóa mục tiêu tập luyện cá nhân của mình.
 * Được gọi ở: Route PUT /v1/me/training-goal (src/server/controllers/router.ts:691-692).
 * @param sql Kết nối cơ sở dữ liệu (Sql).
 * @param request HTTP Request chứa body dạng JSON { goal: string | null }.
 * @param user Thông tin tài khoản hội viên đang đăng nhập (PublicUser).
 * @returns Đối tượng HTTP response { status: 200, body: { goal } }.
 * @throws Lỗi 403 nếu người dùng không phải hội viên (member); lỗi 400 nếu mục tiêu không hợp lệ; lỗi nếu cờ F4 tắt.
 */
export async function meTrainingGoal(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra vai trò hội viên (member) và cờ tính năng F4 đang bật (BR-52).
  requireRole(user, ["member"]);
  await requireFlag(sql, "F4");
  // Bước 2: Đọc body và xác thực mục tiêu tập luyện thuộc TRAINING_GOALS hoặc null (xóa mục tiêu).
  const b = await readJson(request);
  const goal = b.goal === null ? null : oneOf(TRAINING_GOALS, b.goal, "goal");
  // Bước 3: Thêm mới hoặc cập nhật (upsert) mục tiêu vào bảng training_profiles theo user_id.
  await sql.query(
    `insert into training_profiles (user_id, goal, updated_at) values ($1, $2, now())
     on conflict (user_id) do update set goal = excluded.goal, updated_at = now()`,
    [user.id, goal],
  );
  // Bước 4: Trả về mục tiêu tập luyện vừa được cập nhật thành công.
  return { status: 200, body: { goal } };
}

/**
 * Làm gì: Đánh giá và cập nhật trình độ môn thể thao của học viên, đồng thời ghi nhận vào nhật ký kiểm toán (audit log).
 * Được gọi ở: Route PUT /v1/students/:id/level (src/server/controllers/router.ts:673-674).
 * @param sql Kết nối cơ sở dữ liệu (Sql).
 * @param id ID của học viên được đánh giá trình độ.
 * @param request HTTP Request chứa JSON body { sport: string, level: string }.
 * @param user Thông tin HLV hoặc quản lý thực hiện đánh giá.
 * @returns Đối tượng HTTP response { status: 200, body: { sport, level } }.
 * @throws Lỗi 403 nếu sai vai trò/không phụ trách; lỗi 400 nếu sport hoặc level không hợp lệ; lỗi nếu cờ F4 tắt.
 */
export async function studentLevelPut(sql: Sql, id: string, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn (coach hoặc manager), cờ tính năng F4 và quyền truy cập học viên (BR-45, BR-46).
  requireRole(user, ["coach", "manager"]);
  await requireFlag(sql, "F4");
  const student = await loadStudent(sql, id, user);
  // Bước 2: Đọc body và xác thực môn thể thao đang hoạt động cùng trình độ hợp lệ (LEVELS: beginner, intermediate, advanced, pro).
  const b = await readJson(request);
  const sports = await getActiveSportCodes(sql);
  const sport = oneOf(sports, b.sport, "sport");
  const level = oneOf(LEVELS, b.level, "level");
  // Bước 3: Lấy trình độ trước đó để phục vụ việc ghi nhật ký kiểm toán (audit log).
  const before = await one(sql, `select level from member_levels where user_id = $1 and sport = $2`, [student.id, sport]);
  // Bước 4: Lưu hoặc cập nhật (upsert) trình độ mới vào bảng member_levels kèm người đánh giá (assessed_by).
  await sql.query(
    `insert into member_levels (user_id, sport, level, assessed_by, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (user_id, sport) do update
       set level = excluded.level, assessed_by = excluded.assessed_by, updated_at = now()`,
    [student.id, sport, level, user.id],
  );
  // Bước 5: Ghi nhật ký kiểm toán (audit log) ghi nhận việc thay đổi trình độ của học viên.
  await audit(sql, user.id, "student_level", "user", student.id, before, { sport, level });
  // Bước 6: Trả về môn thể thao và trình độ vừa được lưu.
  return { status: 200, body: { sport, level } };
}

/**
 * Làm gì: Thêm mới một ghi chú chuyên môn của HLV dành cho học viên (tối đa 2000 ký tự).
 * Được gọi ở: Route POST /v1/students/:id/notes (src/server/controllers/router.ts:676-677).
 * @param sql Kết nối cơ sở dữ liệu (Sql).
 * @param id ID của học viên cần thêm ghi chú.
 * @param request HTTP Request chứa JSON body { body: string }.
 * @param user Thông tin HLV hoặc quản lý tạo ghi chú.
 * @returns Đối tượng HTTP response { status: 201, body: { id, body, created_at } }.
 * @throws Lỗi 403 nếu sai vai trò/không phụ trách; lỗi 400 nếu ghi chú rỗng hoặc vượt quá 2000 ký tự.
 */
export async function studentNotePost(sql: Sql, id: string, request: Request, user: PublicUser) {
  // Bước 1: Xác thực quyền hạn (coach/manager), cờ F4 và tải học viên trong phạm vi phụ trách.
  requireRole(user, ["coach", "manager"]);
  await requireFlag(sql, "F4");
  const student = await loadStudent(sql, id, user);
  // Bước 2: Đọc nội dung ghi chú, loại bỏ khoảng trắng thừa và kiểm tra giới hạn độ dài (1 - 2000 ký tự).
  const body = (str((await readJson(request)).body) ?? "").trim();
  if (!body) throw err.field("body", "Write something first.");
  if (body.length > 2000) throw err.field("body", "Keep a note under 2000 characters.");
  // Bước 3: Lưu ghi chú vào bảng coach_notes và trả về bản ghi vừa tạo.
  const row = await one(
    sql,
    `insert into coach_notes (user_id, coach_id, body) values ($1,$2,$3) returning id, body, created_at`,
    [student.id, user.id, body],
  );
  return { status: 201, body: row };
}

/* ------------------------------------------------------------------ *
 * Reviews (FR-TRN-06) — append only                                   *
 * ------------------------------------------------------------------ */

/**
 * Làm gì: Kiểm tra và chuyển đổi giá trị đầu vào thành điểm đánh giá hợp lệ (số nguyên từ 1 đến 5).
 * Được gọi ở: studentReviewPost (src/server/controllers/handlers/training.ts) cho các tiêu chí technique, fitness, attitude.
 * @param v Giá trị thô nhận từ client (chuỗi hoặc số).
 * @param field Tên tiêu chí đánh giá (kỹ thuật, thể lực, thái độ) dùng để báo lỗi nếu sai.
 * @returns Điểm số nguyên từ 1 đến 5.
 * @throws Lỗi 400 (Bad Request) nếu điểm không phải số nguyên hoặc nằm ngoài khoảng 1 đến 5.
 */
function score(v: unknown, field: string): number {
  const n = typeof v === "string" && v !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 5) {
    throw err.field(field, `${field} is a score from 1 to 5.`);
  }
  return n;
}

/**
 * Làm gì: Tạo phiếu đánh giá tiến độ định kỳ (2 hoặc 4 tuần) cho học viên, lưu vĩnh viễn (append-only) và gửi thông báo in-app (FR-TRN-06).
 * Được gọi ở: Route POST /v1/students/:id/reviews (src/server/controllers/router.ts:679-680).
 * @param sql Kết nối cơ sở dữ liệu (Sql).
 * @param id ID của học viên được đánh giá.
 * @param request HTTP Request chứa JSON body { sport, period_weeks, technique, fitness, attitude, comment }.
 * @param user Thông tin HLV hoặc quản lý thực hiện đánh giá.
 * @returns Đối tượng HTTP response { status: 201, body: { id, created_at } }.
 * @throws Lỗi 403 nếu sai vai trò/không phụ trách; lỗi 400 nếu dữ liệu đánh giá sai chuẩn; lỗi 404 nếu không tìm thấy.
 */
export async function studentReviewPost(sql: Sql, id: string, request: Request, user: PublicUser) {
  // Bước 1: Xác thực vai trò coach/manager, cờ F4 và kiểm tra học viên thuộc phạm vi phụ trách.
  requireRole(user, ["coach", "manager"]);
  await requireFlag(sql, "F4");
  const student = await loadStudent(sql, id, user);
  // Bước 2: Đọc body và xác thực dữ liệu đánh giá (môn thể thao, chu kỳ 2 hoặc 4 tuần, điểm 1-5 và nhận xét tối đa 2000 ký tự).
  const b = await readJson(request);
  const sports = await getActiveSportCodes(sql);
  const sport = oneOf(sports, b.sport, "sport");
  const period = Number(b.period_weeks);
  if (period !== 2 && period !== 4) throw err.field("period_weeks", "A review covers 2 or 4 weeks.");
  const technique = score(b.technique, "technique");
  const fitness = score(b.fitness, "fitness");
  const attitude = score(b.attitude, "attitude");
  const comment = (str(b.comment) ?? "").trim();
  if (comment.length > 2000) throw err.field("comment", "Keep the comment under 2000 characters.");
  // Bước 3: Thêm bản ghi mới vào bảng progress_reviews (chỉ thêm mới, không ghi đè để lưu vết lịch sử tiến độ).
  const row = await one<{ id: string; created_at: string }>(
    sql,
    `insert into progress_reviews (user_id, sport, coach_id, period_weeks, technique, fitness, attitude, comment)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id, created_at`,
    [student.id, sport, user.id, period, technique, fitness, attitude, comment || null],
  );
  if (!row) throw err.notFound();
  // Bước 4: Đẩy thông báo trong ứng dụng (in-app notification) cho học viên với dedupe key theo mã đánh giá review:id.
  await enqueue(
    sql,
    "inapp",
    "review_added",
    student.id,
    { review_id: row.id, sport, coach_name: user.full_name, period_weeks: period },
    `review:${row.id}`,
  );
  // Bước 5: Trả về ID và thời gian tạo phiếu đánh giá thành công.
  return { status: 201, body: { id: row.id, created_at: row.created_at } };
}

/* ------------------------------------------------------------------ *
 * Session results (FR-TRN-05)                                         *
 * ------------------------------------------------------------------ */

/**
 * Làm gì: Lấy danh sách kết quả tập luyện và điểm danh của toàn bộ học viên trong một buổi học (FR-TRN-05).
 * Được gọi ở: Route GET /v1/sessions/:id/results (src/server/controllers/router.ts:664-665), sessionResultsPut (training.ts).
 * @param sql Kết nối cơ sở dữ liệu (Sql).
 * @param sessionId ID của buổi học cần xem kết quả.
 * @param user Thông tin HLV hoặc quản lý đang truy vấn.
 * @returns Đối tượng HTTP response { status: 200, body: { session: { id, class_id, status }, items } }.
 * @throws Lỗi 403 nếu HLV không phụ trách lớp của buổi học; lỗi 404 nếu buổi học không tồn tại.
 */
export async function sessionResultsGet(sql: Sql, sessionId: string, user: PublicUser) {
  // Bước 1: Xác thực vai trò (coach/manager), cờ tính năng F4 và kiểm tra quyền phụ trách buổi học (BR-45).
  requireRole(user, ["coach", "manager"]);
  await requireFlag(sql, "F4");
  const s = await sessionScope(sql, sessionId, user);
  // Bước 2: Truy vấn danh sách học viên đăng ký chính thức (confirmed) kèm kết quả điểm danh và đánh giá buổi tập.
  const items = await sql.query(
    `select u.id as user_id, u.full_name, u.member_code, a.result::text as attendance,
            r.plan_pct, r.metrics, r.note
       from enrollments e
       join users u on u.id = e.user_id
       left join attendance a on a.session_id = $1 and a.user_id = u.id and a.kind = 'session'
       left join session_results r on r.session_id = $1 and r.user_id = u.id
      where e.class_id = $2 and e.status = 'confirmed'
      order by u.full_name`,
    [s.id, s.class_id],
  );
  // Bước 3: Trả về thông tin buổi học kèm danh sách kết quả chi tiết của từng học viên.
  return { status: 200, body: { session: { id: s.id, class_id: s.class_id, status: s.status }, items } };
}

/**
 * Làm gì: Cập nhật kết quả tập luyện (tỷ lệ hoàn thành giáo án, chỉ số rèn luyện, ghi chú) cho các học viên trong một buổi học (FR-TRN-05).
 * Được gọi ở: Route PUT /v1/sessions/:id/results (src/server/controllers/router.ts:667-668).
 * @param sql Kết nối cơ sở dữ liệu (Sql).
 * @param sessionId ID của buổi học cần ghi nhận kết quả.
 * @param request HTTP Request chứa JSON body { items: Array<{ user_id, plan_pct, metrics, note }> }.
 * @param user Thông tin HLV hoặc quản lý thực hiện cập nhật.
 * @returns Đối tượng kết quả cập nhật thông qua hàm sessionResultsGet.
 * @throws Lỗi 403 nếu sai vai trò/không phụ trách; lỗi 409 nếu buổi học đã bị hủy; lỗi 400 nếu dữ liệu dòng không hợp lệ.
 */
export async function sessionResultsPut(sql: Sql, sessionId: string, request: Request, user: PublicUser) {
  // Bước 1: Xác thực quyền hạn (coach/manager), cờ tính năng F4 và kiểm tra quyền phụ trách buổi học.
  requireRole(user, ["coach", "manager"]);
  await requireFlag(sql, "F4");
  const s = await sessionScope(sql, sessionId, user);
  // Không cho phép ghi nhận kết quả nếu buổi học đã bị hủy (status = 'cancelled').
  if (s.status === "cancelled") throw err.conflictState("That session was cancelled.");
  // Bước 2: Đọc dữ liệu danh sách kết quả gửi lên và kiểm tra mảng items không được để trống.
  const b = await readJson(request);
  const items = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : null;
  if (!items || items.length === 0) throw err.field("items", "Nothing to save.");
  type Parsed = { uid: string; pct: number | null; metrics: Record<string, number>; note: string };
  const parsed: Parsed[] = [];
  // Bước 3: Duyệt và xác thực từng dòng kết quả (UUID học viên, % hoàn thành 0-100, chỉ số metrics và ghi chú dưới 1000 ký tự).
  for (const [i, it] of items.entries()) {
    const uid = uuidField(it.user_id, "user_id");
    let pct: number | null = null;
    if (it.plan_pct !== undefined && it.plan_pct !== null && it.plan_pct !== "") {
      const n = Number(it.plan_pct);
      if (!Number.isInteger(n) || n < 0 || n > 100) {
        throw err.field("plan_pct", `Row ${i + 1}: plan completion is a whole number from 0 to 100.`, { index: i });
      }
      pct = n;
    }
    const m = validateMetrics(it.metrics);
    if (!m.ok) throw err.field(m.field, `Row ${i + 1}: ${m.message}`, { index: i });
    const note = (str(it.note) ?? "").trim();
    if (note.length > 1000) throw err.field("note", `Row ${i + 1}: keep a note under 1000 characters.`, { index: i });
    // Đảm bảo học viên có tên trong danh sách đăng ký chính thức (confirmed) của lớp học này.
    const enrolled = await one(
      sql,
      `select 1 as ok from enrollments where class_id = $1 and user_id = $2 and status = 'confirmed'`,
      [s.class_id, uid],
    );
    if (!enrolled) throw err.field("user_id", `Row ${i + 1}: that student is not in this class.`, { index: i });
    parsed.push({ uid, pct, metrics: m.metrics, note });
  }
  // Bước 4: Lưu kết quả vào bảng session_results: xóa bản ghi nếu để trống toàn bộ, hoặc cập nhật (upsert) nếu có dữ liệu.
  for (const p of parsed) {
    const empty = p.pct === null && Object.keys(p.metrics).length === 0 && !p.note;
    // Nếu tất cả các trường đều trống thì xóa bản ghi kết quả đã lưu trước đó.
    if (empty) {
      await sql.query(`delete from session_results where session_id = $1 and user_id = $2`, [s.id, p.uid]);
      continue;
    }
    // Thêm mới hoặc cập nhật (upsert) kết quả buổi tập của học viên vào bảng session_results.
    await sql.query(
      `insert into session_results (session_id, user_id, plan_pct, metrics, note, recorded_by, recorded_at)
       values ($1,$2,$3,$4::jsonb,$5,$6, now())
       on conflict (session_id, user_id) do update
         set plan_pct = excluded.plan_pct, metrics = excluded.metrics, note = excluded.note,
             recorded_by = excluded.recorded_by, recorded_at = now()`,
      [s.id, p.uid, p.pct, JSON.stringify(p.metrics), p.note || null, user.id],
    );
  }
  // Bước 5: Truy vấn và trả về danh sách kết quả buổi tập cập nhật mới nhất cho client
  return sessionResultsGet(sql, s.id, user);
}

/* ------------------------------------------------------------------ *
 * Attendance side effects                                             *
 * ------------------------------------------------------------------ */

/**
 * BR-36: three absences in a row put the student on the manager's and the
 * coach's radar. Nothing is cancelled and nobody is un-enrolled — it is a nudge.
 *
 * The dedupe key carries the latest marked session, so saving the same register
 * twice is silent and a fourth absence raises a fresh alert.
 */
/**
 * Làm gì: Kiểm tra chuỗi vắng mặt liên tiếp của học viên trong lớp theo quy tắc BR-36. Nếu vắng từ 3 buổi liên tiếp trở lên (ABSENT_STREAK_LIMIT), hệ thống sẽ gửi thông báo in-app cho HLV và các quản lý để nhắc nhở mà không hủy lịch hay hủy ghi danh của học viên.
 * Được gọi ở: src/server/controllers/handlers/ops.ts (trong sessionAttendanceSave sau khi lưu điểm danh).
 * @param sql Kết nối cơ sở dữ liệu PostgreSQL hoặc transaction hiện tại.
 * @param classId Mã định danh ID của lớp học cần kiểm tra.
 * @param userIds Danh sách ID học viên vừa bị đánh dấu vắng mặt ('absent').
 * @returns Không có giá trị trả về (Promise<void>).
 */
export async function checkAbsentStreaks(sql: Sql, classId: string, userIds: string[]) {
  // Bước 1: Kiểm tra danh sách học viên, thoát sớm nếu rỗng
  if (userIds.length === 0) return;
  // Bước 2: Lấy thông tin lớp học (coach_id, assistant_id, môn thể thao) để chuẩn bị người nhận thông báo
  const cl = await one<{ coach_id: string; assistant_id: string | null; sport: string }>(
    sql,
    `select coach_id, assistant_id, sport::text as sport from classes where id = $1`,
    [classId],
  );
  if (!cl) return;
  // Bước 3: Duyệt từng học viên vắng mặt để tính toán chuỗi buổi vắng liên tiếp
  for (const uid of userIds) {
    // Lấy lịch sử điểm danh của học viên trong lớp, sắp xếp tăng dần theo thời gian bắt đầu (loại bỏ buổi đã hủy)
    const marks = await sql.query<{ session_id: string; result: string }>(
      `select s.id as session_id, a.result::text as result
         from attendance a join sessions s on s.id = a.session_id
        where a.user_id = $1 and a.kind = 'session' and s.class_id = $2
          and a.result is not null and s.status <> 'cancelled'
        order by s.start_at`,
      [uid, classId],
    );
    // Tính chuỗi vắng liên tiếp gần nhất; nếu chưa đạt ngưỡng ABSENT_STREAK_LIMIT (3 buổi) thì bỏ qua (BR-36)
    const streak = absentStreak(marks.map((m) => m.result));
    if (streak < ABSENT_STREAK_LIMIT) continue;
    const latest = marks[marks.length - 1].session_id;
    // Bước 4: Lấy họ tên học viên và tổng hợp danh sách người nhận thông báo (HLV chính, trợ giảng, toàn bộ manager active)
    const who = await one<{ full_name: string }>(sql, `select full_name from users where id = $1`, [uid]);
    const recipients = new Set<string>([cl.coach_id]);
    if (cl.assistant_id) recipients.add(cl.assistant_id);
    for (const m of await sql.query<{ id: string }>(`select id from users where role = 'manager' and status = 'active'`)) {
      recipients.add(m.id);
    }
    // Bước 5: Đưa thông báo vào hàng đợi in-app; dedupe key gắn session_id mới nhất để tránh gửi trùng khi lưu lại điểm danh
    for (const r of recipients) {
      await enqueue(
        sql,
        "inapp",
        "absent_streak",
        r,
        { class_id: classId, user_id: uid, member_name: who?.full_name ?? "A student", streak, sport: cl.sport },
        `absent:${classId}:${uid}:${latest}:${r}`,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * Homework (FR-TRN-07)                                                *
 * ------------------------------------------------------------------ */

/**
 * Làm gì: Tạo bài tập về nhà mới (FR-TRN-07) giao cho cả lớp học hoặc một học viên cụ thể, kèm checklist và hạn nộp, đồng thời gửi thông báo in-app đến từng người nhận.
 * Được gọi ở: src/server/controllers/router.ts (route POST /api/homework hoặc /v1/homework).
 * @param sql Kết nối cơ sở dữ liệu PostgreSQL hoặc transaction hiện tại.
 * @param request HTTP Request chứa payload JSON bài tập (title, body, checklist, due_on, class_id hoặc user_id).
 * @param user Thông tin người dùng đăng nhập (yêu cầu vai trò coach hoặc manager).
 * @returns Phản hồi HTTP 201 Created chứa ID bài tập và số lượng người nhận.
 * @throws Lỗi unauth 401 nếu chưa đăng nhập, forbidden 403 nếu sai vai trò hoặc cờ F4 tắt, field/validation 400 nếu dữ liệu không hợp lệ.
 */
export async function homeworkCreate(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn (chỉ coach hoặc manager) và cờ tính năng F4 (Training module)
  requireRole(user, ["coach", "manager"]);
  await requireFlag(sql, "F4");
  // Bước 2: Đọc và xác thực dữ liệu bài tập (tiêu đề tối đa 120 ký tự, mô tả tối đa 4000 ký tự, checklist tối đa 20 mục)
  const b = await readJson(request);
  const title = (str(b.title) ?? "").trim();
  if (!title) throw err.field("title", "Give the homework a title.");
  if (title.length > 120) throw err.field("title", "Keep the title under 120 characters.");
  const body = (str(b.body) ?? "").trim();
  if (body.length > 4000) throw err.field("body", "Keep the description under 4000 characters.");
  const checklist = normalizeChecklist(b.checklist);
  if (!checklist) throw err.field("checklist", "A checklist is up to 20 short items.");
  // Kiểm tra hạn nộp (due_on): đúng định dạng YYYY-MM-DD và không nằm trong quá khứ theo giờ ICT
  let dueOn: string | null = null;
  if (b.due_on !== undefined && b.due_on !== null && b.due_on !== "") {
    const d = str(b.due_on) ?? "";
    if (!DATE_RE.test(d) || Number.isNaN(ictDateTime(d, "00:00").getTime())) {
      throw err.field("due_on", "Use a date like 2026-10-12.");
    }
    if (d < ictDateString()) throw err.field("due_on", "The due date is already past.");
    dueOn = d;
  }
  // Bắt buộc chọn đúng 1 đối tượng: hoặc giao cho cả lớp (class_id), hoặc giao cho 1 học viên cụ thể (user_id)
  const classId = str(b.class_id) || null;
  const userId = str(b.user_id) || null;
  if ((classId === null) === (userId === null)) {
    throw err.field("class_id", "Choose either a class or one student.");
  }

  // Bước 3: Xác định danh sách học viên nhận bài tập (toàn bộ học viên confirmed trong lớp, hoặc 1 học viên cụ thể)
  let recipients: string[] = [];
  if (classId) {
    const cl = await loadClass(sql, uuidField(classId, "class_id"));
    assertClassStaff(cl, user);
    recipients = (
      await sql.query<{ user_id: string }>(
        `select user_id from enrollments where class_id = $1 and status = 'confirmed'`,
        [cl.id],
      )
    ).map((r) => r.user_id);
    if (recipients.length === 0) throw err.validation("This class has no confirmed students yet.");
  } else {
    const student = await loadStudent(sql, uuidField(userId, "user_id"), user);
    recipients = [student.id];
  }

  // Bước 4: Lưu thông tin bài tập vào bảng homework
  const hw = await one<{ id: string; created_at: string }>(
    sql,
    `insert into homework (coach_id, class_id, user_id, title, body, checklist, due_on)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7::date) returning id, created_at`,
    [user.id, classId, userId, title, body || null, JSON.stringify(checklist), dueOn],
  );
  if (!hw) throw err.notFound();
  // Bước 5: Tạo bản ghi homework_recipients cho từng học viên và gửi thông báo in-app với dedupe key tránh trùng lặp
  for (const uid of recipients) {
    await sql.query(`insert into homework_recipients (homework_id, user_id) values ($1,$2)`, [hw.id, uid]);
    await enqueue(
      sql,
      "inapp",
      "homework_assigned",
      uid,
      { homework_id: hw.id, title, due_on: dueOn, coach_name: user.full_name },
      `hw:${hw.id}:${uid}`,
    );
  }
  // Bước 6: Trả về mã 201 Created cùng ID bài tập và số lượng học viên được giao
  return { status: 201, body: { id: hw.id, recipients: recipients.length } };
}

/**
 * Làm gì: Lấy danh sách bài tập về nhà dành cho HLV/Quản lý (FR-TRN-07) kèm số học viên được giao và đã hoàn thành; Manager xem được toàn bộ, Coach chỉ xem được bài của mình (BR-45).
 * Được gọi ở: src/server/controllers/router.ts (route GET /api/homework hoặc /v1/homework).
 * @param sql Kết nối cơ sở dữ liệu PostgreSQL.
 * @param request HTTP Request có thể chứa query param class_id để lọc theo lớp cụ thể.
 * @param user Thông tin người dùng đăng nhập (yêu cầu vai trò coach hoặc manager).
 * @returns Phản hồi HTTP 200 chứa danh sách bài tập (tối đa 60 bài mới nhất).
 * @throws Lỗi unauth 401 nếu chưa đăng nhập, forbidden 403 nếu sai quyền hoặc cờ F4 tắt.
 */
export async function homeworkList(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn (coach hoặc manager) và cờ tính năng F4
  requireRole(user, ["coach", "manager"]);
  await requireFlag(sql, "F4");
  // Bước 2: Lấy tham số class_id từ query param nếu client muốn lọc bài tập theo lớp
  const classId = new URL(request.url).searchParams.get("class_id");
  // Bước 3: Truy vấn tối đa 60 bài tập mới nhất kèm thống kê hoàn thành; Manager xem tất cả, Coach chỉ xem bài do mình tạo
  const items = await sql.query(
    `select h.id, h.title, h.body, h.checklist, h.due_on::text as due_on, h.created_at, h.class_id, h.user_id,
            co.full_name as coach_name, st.full_name as student_name,
            (select count(*)::int from homework_recipients r where r.homework_id = h.id) as recipients,
            (select count(*)::int from homework_recipients r where r.homework_id = h.id and r.completed_at is not null) as completed
       from homework h
       join users co on co.id = h.coach_id
       left join users st on st.id = h.user_id
      where ($1::uuid is null or h.class_id = $1)
        and ($2::boolean or h.coach_id = $3)
      order by h.created_at desc
      limit 60`,
    [classId && UUID_RE.test(classId) ? classId : null, user.role === "manager", user.id],
  );
  // Bước 4: Trả về danh sách bài tập cho client
  return { status: 200, body: { items } };
}

/**
 * Làm gì: Lấy danh sách bài tập về nhà được giao cho hội viên đang đăng nhập (FR-TRN-07), ưu tiên hiển thị bài tập chưa hoàn thành lên trước.
 * Được gọi ở: src/server/controllers/router.ts (route GET /api/me/homework hoặc /v1/me/homework).
 * @param sql Kết nối cơ sở dữ liệu PostgreSQL.
 * @param user Thông tin người dùng đăng nhập (yêu cầu vai trò member).
 * @returns Phản hồi HTTP 200 chứa danh sách bài tập của hội viên (tối đa 60 bài).
 * @throws Lỗi unauth 401 nếu chưa đăng nhập, forbidden 403 nếu không phải member hoặc cờ F4 tắt.
 */
export async function meHomework(sql: Sql, user: PublicUser) {
  // Bước 1: Kiểm tra vai trò hội viên (member) và cờ tính năng F4
  requireRole(user, ["member"]);
  await requireFlag(sql, "F4");
  // Bước 2: Truy vấn danh sách bài tập của học viên (tối đa 60 bài), ưu tiên bài chưa xong lên trước (completed_at is null)
  const items = await sql.query(
    `select h.id, h.title, h.body, h.checklist, h.due_on::text as due_on, h.created_at,
            r.done_items, r.completed_at, co.full_name as coach_name
       from homework_recipients r
       join homework h on h.id = r.homework_id
       join users co on co.id = h.coach_id
      where r.user_id = $1
      order by (r.completed_at is not null), h.due_on nulls last, h.created_at desc
      limit 60`,
    [user.id],
  );
  // Bước 3: Trả về danh sách bài tập cho hội viên
  return { status: 200, body: { items } };
}

/**
 * Làm gì: Cập nhật tiến độ bài tập về nhà của hội viên (tích chọn mục checklist đã làm hoặc đánh dấu xong toàn bộ) (FR-TRN-07).
 * Được gọi ở: src/server/controllers/router.ts (route PUT /api/me/homework/:id hoặc /v1/me/homework/:id).
 * @param sql Kết nối cơ sở dữ liệu PostgreSQL hoặc transaction hiện tại.
 * @param id Mã định danh UUID của bài tập về nhà cần cập nhật.
 * @param request HTTP Request chứa payload JSON (done_items: mảng chỉ số mục đã làm, done: boolean hoàn thành).
 * @param user Thông tin người dùng đăng nhập (yêu cầu vai trò member).
 * @returns Phản hồi HTTP 200 chứa danh sách các mục checklist đã làm và trạng thái completed.
 * @throws Lỗi unauth 401 nếu chưa đăng nhập, forbidden 403 nếu không phải member/cờ F4 tắt, notFound 404 nếu bài tập không thuộc về học viên.
 */
export async function meHomeworkPut(sql: Sql, id: string, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra vai trò hội viên (member) và cờ tính năng F4
  requireRole(user, ["member"]);
  await requireFlag(sql, "F4");
  // Bước 2: Khóa dòng bản ghi người nhận bài tập (for update) để tránh xung đột dữ liệu khi cập nhật đồng thời
  const row = await one<{ checklist: unknown; completed_at: string | null }>(
    sql,
    `select h.checklist, r.completed_at
       from homework_recipients r join homework h on h.id = r.homework_id
      where r.homework_id = $1 and r.user_id = $2
      for update of r`,
    [pathId(id), user.id],
  );
  if (!row) throw err.notFound("That homework is not yours.");
  // Bước 3: Đọc dữ liệu gửi lên và chuẩn hóa danh sách các mục checklist đã làm (normalizeDone)
  const b = await readJson(request);
  const total = Array.isArray(row.checklist) ? row.checklist.length : 0;
  const done = normalizeDone(total, b.done_items);
  // Xác định hoàn thành nếu toàn bộ checklist đã xong hoặc học viên chủ động bấm hoàn thành (done === true)
  const complete = homeworkComplete(total, done, b.done === true);
  // Bước 4: Cập nhật danh sách done_items và thời điểm completed_at vào bảng homework_recipients
  await sql.query(
    `update homework_recipients
        set done_items = $3::jsonb,
            completed_at = case when $4::boolean then coalesce(completed_at, now()) else null end
      where homework_id = $1 and user_id = $2`,
    [id, user.id, JSON.stringify(done), complete],
  );
  // Bước 5: Trả về trạng thái tiến độ mới nhất của bài tập
  return { status: 200, body: { done_items: done, completed: complete } };
}

/* ------------------------------------------------------------------ *
 * Member progress (FR-TRN-08)                                         *
 * ------------------------------------------------------------------ */

/**
 * Làm gì: Lấy bức tranh tổng quan tiến độ tập luyện của hội viên (FR-TRN-08), bao gồm mục tiêu, trình độ môn, 3 buổi tập sắp tới kèm giáo án, tổng số buổi đã tham gia, 10 kết quả gần nhất, 10 đánh giá định kỳ và 10 bài tập chưa xong.
 * Được gọi ở: src/server/controllers/router.ts (route GET /api/me/training hoặc /v1/me/training), src/server/controllers/tx.test.ts, src/server/services/business-gaps.test.ts.
 * @param sql Kết nối cơ sở dữ liệu PostgreSQL.
 * @param user Thông tin hội viên đang đăng nhập (yêu cầu vai trò member).
 * @returns Phản hồi HTTP 200 chứa đối tượng dữ liệu tổng hợp tiến độ tập luyện của hội viên.
 * @throws Lỗi unauth 401 nếu chưa đăng nhập, forbidden 403 nếu không phải member hoặc cờ F4 tắt.
 */
export async function meTraining(sql: Sql, user: PublicUser) {
  // Bước 1: Kiểm tra vai trò hội viên (member) và cờ tính năng đào tạo F4
  requireRole(user, ["member"]);
  await requireFlag(sql, "F4");
  // Bước 2: Lấy mục tiêu tập luyện cá nhân (training_profiles) và trình độ theo từng môn thể thao (member_levels)
  const goal = await one<{ goal: string | null }>(sql, `select goal from training_profiles where user_id = $1`, [user.id]);
  const levels = await sql.query(
    `select sport::text as sport, level, updated_at from member_levels where user_id = $1 order by sport`,
    [user.id],
  );
  // Bước 3: Lấy tối đa 3 buổi tập sắp tới mà học viên đã ghi danh thành công và chưa kết thúc
  const upcoming = await sql.query<{
    id: string;
    class_id: string;
    start_at: string;
    end_at: string;
    sport: string;
    level: string;
    court_code: string;
  }>(
    `select s.id, s.class_id, s.start_at, s.end_at, cl.sport::text as sport, cl.level, c.court_code
       from sessions s
       join classes cl on cl.id = s.class_id
       join courts c on c.id = s.court_id
       join enrollments e on e.class_id = cl.id and e.user_id = $1 and e.status = 'confirmed'
      where s.status = 'scheduled' and s.end_at > now()
      order by s.start_at limit 3`,
    [user.id],
  );
  // Bước 4: Lấy kèm các giáo án đã xuất bản (published) liên quan trực tiếp đến từng buổi tập hoặc lớp học
  const next_sessions = [];
  for (const s of upcoming) {
    const plans = await sql.query(
      `select id, title, payload, session_id from training_plans
        where published = true
          and (session_id = $1
               or (session_id is null and (user_id = $2 or (user_id is null and class_id = $3))))
        order by (session_id is not null) desc, created_at desc
        limit 3`,
      [s.id, user.id, s.class_id],
    );
    next_sessions.push({ ...s, plans });
  }
  // Bước 5: Đếm tổng số buổi tập học viên đã thực sự tham gia (kết quả điểm danh 'present' hoặc 'late' trên các buổi không bị hủy)
  const attended = await one<{ count: number }>(sql,
    `select count(distinct a.session_id)::int as count from attendance a
      join sessions s on s.id = a.session_id
      where a.user_id = $1 and a.kind = 'session' and a.result in ('present', 'late')
        and s.status <> 'cancelled'`, [user.id]);
  // Bước 6: Lấy 10 kết quả buổi tập gần nhất kèm tỷ lệ hoàn thành giáo án và chỉ số đo lường
  const results = await sql.query(
    `select r.session_id, r.plan_pct, r.metrics, r.note, s.start_at, cl.sport::text as sport
       from session_results r
       join sessions s on s.id = r.session_id
       join classes cl on cl.id = s.class_id
      where r.user_id = $1 order by s.start_at desc limit 10`,
    [user.id],
  );
  // Bước 7: Lấy 10 đánh giá định kỳ gần nhất từ HLV (kỹ thuật, thể lực, thái độ)
  const reviews = await sql.query(
    `select r.id, r.sport::text as sport, r.period_weeks, r.technique, r.fitness, r.attitude, r.comment,
            r.created_at, c.full_name as coach_name
       from progress_reviews r join users c on c.id = r.coach_id
      where r.user_id = $1 order by r.created_at desc limit 10`,
    [user.id],
  );
  // Bước 8: Lấy 10 bài tập về nhà chưa hoàn thành (completed_at is null) gần nhất
  const homework = await sql.query(
    `select h.id, h.title, h.body, h.checklist, h.due_on::text as due_on, r.done_items
       from homework_recipients r join homework h on h.id = r.homework_id
      where r.user_id = $1 and r.completed_at is null
      order by h.due_on nulls last, h.created_at desc limit 10`,
    [user.id],
  );
  // Bước 9: Đóng gói và trả về toàn bộ dữ liệu tiến độ tập luyện tổng hợp cho hội viên
  return {
    status: 200,
    body: { goal: goal?.goal ?? null, levels, next_sessions, results, reviews, homework, completed_sessions: attended?.count ?? 0 },
  };
}

/* ------------------------------------------------------------------ *
 * Training plans (FR-TRN-04)                                          *
 * ------------------------------------------------------------------ */

// Cấu trúc một khối bài tập (block) trong giáo án tập luyện (FR-TRN-04, BR-49)
type Block = {
  order: number;
  title: string;
  minutes: number;
  phase?: string;
  intensity?: string;
  description?: string;
  equipment?: string;
  target?: string;
};

/** A block's free-text fields: trimmed, capped, and left out when empty. */
/**
 * Làm gì: Cắt khoảng trắng và kiểm tra độ dài các trường văn bản tự do của khối bài tập (block), trả về undefined nếu rỗng hoặc ném lỗi nếu vượt quá giới hạn ký tự.
 * Được gọi ở: src/server/controllers/handlers/training.ts (trong cleanPayload khi validate từng block).
 * @param b Đối tượng dữ liệu thô của khối bài tập (block).
 * @param key Tên trường văn bản cần kiểm tra ("description", "equipment" hoặc "target").
 * @param max Giới hạn số lượng ký tự tối đa cho phép của trường.
 * @param i Chỉ số thứ tự của block trong mảng (dùng để báo lỗi chi tiết theo vị trí).
 * @returns Chuỗi văn bản đã cắt khoảng trắng hoặc undefined nếu trường rỗng.
 * @throws Lỗi field 400 nếu độ dài văn bản vượt quá số ký tự max quy định.
 */
function blockText(b: Record<string, unknown>, key: "description" | "equipment" | "target", max: number, i: number) {
  // Cắt khoảng trắng đầu cuối; trả về undefined nếu rỗng để không lưu thuộc tính thừa
  const v = (str(b[key]) ?? "").trim();
  if (!v) return undefined;
  // Ném lỗi validation nếu văn bản vượt quá giới hạn ký tự quy định
  if (v.length > max) throw err.field("blocks", `Block ${i + 1}: keep ${key} under ${max} characters.`, { index: i });
  return v;
}

/**
 * Làm gì: Kiểm tra cấu trúc và chuẩn hóa dữ liệu giáo án tập luyện (FR-TRN-04, BR-49): xác thực danh sách blocks (1-12 block), thời lượng (1-180 phút), giai đoạn, cường độ, mô tả và giới hạn độ dài metadata.
 * Được gọi ở: src/server/controllers/handlers/training.ts (trong planCreate, planTemplateCreate, planPut).
 * @param raw Dữ liệu payload thô của giáo án gửi lên từ client.
 * @returns Đối tượng payload đã được chuẩn hóa và kiểm tra hợp lệ.
 * @throws Lỗi field 400 nếu thiếu blocks, sai số lượng blocks hoặc thuộc tính của từng block không hợp lệ.
 */
function cleanPayload(raw: unknown): Record<string, unknown> {
  // Bước 1: Kiểm tra cấu trúc dữ liệu payload phải là một JSON object hợp lệ
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw err.field("payload", "A plan needs its blocks.");
  }
  const p = raw as Record<string, unknown>;
  // Bước 2: Kiểm tra danh sách blocks (giáo án bắt buộc phải có từ 1 đến 12 khối bài tập)
  const rawBlocks = Array.isArray(p.blocks) ? (p.blocks as Record<string, unknown>[]) : [];
  if (rawBlocks.length === 0) throw err.field("blocks", "Add at least one block to the plan.");
  if (rawBlocks.length > 12) throw err.field("blocks", "A plan has at most 12 blocks.");
  // Bước 3: Duyệt qua từng block để chuẩn hóa và xác thực các thuộc tính theo quy tắc BR-49
  const blocks: Block[] = rawBlocks.map((b, i) => {
    const title = (str(b?.title) ?? "").trim();
    if (!title) throw err.field("blocks", `Block ${i + 1} needs a title.`, { index: i });
    if (title.length > 120) throw err.field("blocks", `Block ${i + 1}: keep the title under 120 characters.`, { index: i });
    // Thời lượng mỗi block phải là số nguyên dương từ 1 đến 180 phút
    const minutes = Number(b.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) {
      throw err.field("blocks", `Block ${i + 1}: minutes is a whole number from 1 to 180.`, { index: i });
    }
    const out: Block = { order: i + 1, title, minutes };
    // Type, intensity and description are part of a block (BR-49); only the
    // equipment and the measurable target are optional.
    // Giai đoạn bài tập (phase: khởi động, kỹ thuật...) và cường độ (intensity) là bắt buộc (BR-49)
    if (b.phase === undefined || b.phase === null || b.phase === "") {
      throw err.field("blocks", `Block ${i + 1} needs a type (warm-up, technique…).`, { index: i });
    }
    out.phase = oneOf(PLAN_PHASES, b.phase, "phase");
    if (b.intensity === undefined || b.intensity === null || b.intensity === "") {
      throw err.field("blocks", `Block ${i + 1} needs an intensity.`, { index: i });
    }
    out.intensity = oneOf(INTENSITIES, b.intensity, "intensity");
    // Mô tả chi tiết bài tập là bắt buộc (tối đa 600 ký tự); dụng cụ và mục tiêu đo lường là tùy chọn (tối đa 200 ký tự)
    const description = blockText(b, "description", 600, i);
    if (!description) throw err.field("blocks", `Block ${i + 1} needs a short description of how it runs.`, { index: i });
    const equipment = blockText(b, "equipment", 200, i);
    const target = blockText(b, "target", 200, i);
    if (description) out.description = description;
    if (equipment) out.equipment = equipment;
    if (target) out.target = target;
    return out;
  });
  // Bước 4: Giữ lại và giới hạn độ dài các trường metadata chung của giáo án (tối đa 400 ký tự mỗi trường)
  const out: Record<string, unknown> = { blocks };
  for (const k of ["sport", "level", "goal", "note", "generated_on"]) {
    const v = str(p[k]);
    if (v) out[k] = v.slice(0, 400);
  }
  return out;
}

/**
 * Làm gì: Tính tổng thời lượng (tính bằng phút) của toàn bộ các khối bài tập (blocks) trong giáo án.
 * Được gọi ở: src/server/controllers/handlers/training.ts (trong durationWarnings).
 * @param payload Đối tượng payload giáo án đã chuẩn hóa chứa danh sách blocks.
 * @returns Tổng số phút của tất cả các block cộng lại.
 */
function totalMinutes(payload: Record<string, unknown>): number {
  return ((payload.blocks as Block[]) ?? []).reduce((n, b) => n + b.minutes, 0);
}

/** Warn (never block) when the blocks and the session length are more than 15 minutes apart (FR-TRN-04). */
/**
 * Làm gì: Cảnh báo khi tổng thời lượng các block trong giáo án chênh lệch quá 15 phút so với thời lượng thực tế của buổi tập (FR-TRN-04); chỉ tạo cảnh báo chứ không chặn lưu giáo án.
 * Được gọi ở: src/server/controllers/handlers/training.ts (trong planCreate, planGet, planApplyTemplate).
 * @param sql Kết nối cơ sở dữ liệu PostgreSQL.
 * @param sessionId Mã ID của buổi tập liên kết với giáo án (nếu null thì bỏ qua).
 * @param payload Dữ liệu payload giáo án chứa danh sách các block bài tập.
 * @returns Mảng chứa thông tin cảnh báo nếu độ chênh lệch thời gian > 15 phút, hoặc mảng rỗng nếu hợp lệ.
 */
async function durationWarnings(sql: Sql, sessionId: string | null, payload: Record<string, unknown>) {
  // Bước 1: Thoát sớm nếu giáo án không gắn với buổi tập cụ thể nào trên lịch
  if (!sessionId) return [];
  // Bước 2: Lấy thời gian bắt đầu và kết thúc của buổi tập từ bảng sessions
  const s = await one<{ start_at: string; end_at: string }>(
    sql,
    `select start_at, end_at from sessions where id = $1`,
    [sessionId],
  );
  if (!s) return [];
  // Bước 3: Tính số phút thực tế của buổi tập và tổng số phút các block trong giáo án
  const sessionMinutes = Math.round((new Date(s.end_at).getTime() - new Date(s.start_at).getTime()) / 60_000);
  const total = totalMinutes(payload);
  // Cho phép dung sai chênh lệch trong khoảng 15 phút; nếu lệch nhiều hơn sẽ trả về cảnh báo (FR-TRN-04)
  if (Math.abs(total - sessionMinutes) <= 15) return [];
  return [
    {
      kind: "duration_mismatch",
      total_minutes: total,
      session_minutes: sessionMinutes,
      message: `The blocks add up to ${total} min but the session is ${sessionMinutes} min.`,
    },
  ];
}

/**
 * Làm gì: Gửi thông báo trong ứng dụng (inapp) cho học viên khi giáo án được xuất bản hoặc cập nhật (BR-48).
 * Được gọi ở: src/server/controllers/handlers/training.ts (trong trainingCreate và trainingPatch).
 * @param sql Đối tượng Sql kết nối cơ sở dữ liệu PostgreSQL.
 * @param plan Thông tin giáo án gồm id, class_id, user_id, session_id và title.
 * @param version Số phiên bản hiện tại của giáo án.
 * @param kind Loại sự kiện thông báo ("published" khi xuất bản lần đầu, "updated" khi cập nhật nội dung).
 * @returns Không trả về dữ liệu (Promise<void>).
 */
/** Tell the students a plan reaches that it is out, or that it has changed (BR-48). */
async function notifyPlan(
  sql: Sql,
  plan: { id: string; class_id: string | null; user_id: string | null; session_id: string | null; title: string | null },
  version: number,
  kind: "published" | "updated",
) {
  // Bước 1: Xác định danh sách học viên nhận tin: lấy user_id nếu là giáo án cá nhân, hoặc truy vấn tất cả học viên đã xác nhận (confirmed) trong lớp.
  const ids = plan.user_id
    ? [plan.user_id]
    : plan.class_id
      ? (
          await sql.query<{ user_id: string }>(
            `select user_id from enrollments where class_id = $1 and status = 'confirmed'`,
            [plan.class_id],
          )
        ).map((r) => r.user_id)
      : [];
  // Bước 2: Đẩy từng thông báo vào hàng đợi inapp notification với dedup key duy nhất để tránh gửi trùng lặp.
  for (const uid of ids) {
    await enqueue(
      sql,
      "inapp",
      "training_plan",
      uid,
      { plan_id: plan.id, title: plan.title, session_id: plan.session_id, version, change: kind },
      `training_plan:${plan.id}:${version}:${kind}:${uid}`,
    );
  }
}

/**
 * Làm gì: Tạo mới giáo án đào tạo (training plan) cho lớp học, học viên, buổi học hoặc tạo giáo án mẫu (FR-TRN-04).
 * Được gọi ở:
 * - URL: POST /v1/training-plans hoặc POST /api/training-plans
 * - Controller: src/server/controllers/router.ts (dòng 640)
 * - Frontend: src/client/components/coach-training.tsx (PlanPanel)
 * - Test runner: src/server/controllers/tx.test.ts
 * @param sql Đối tượng Sql kết nối cơ sở dữ liệu PostgreSQL trong transaction.
 * @param request Web Fetch API Request chứa body JSON thông tin giáo án (class_id, user_id, session_id, is_template, title, source, payload, published).
 * @param user Thông tin người dùng gửi yêu cầu (bắt buộc role 'coach' hoặc 'manager').
 * @returns Đối tượng chứa status 201 và body là giáo án vừa tạo kèm danh sách cảnh báo thời lượng (warnings).
 * @throws ApiError FORBIDDEN (403) nếu không có quyền hoặc lớp/học viên không thuộc phạm vi phụ trách.
 * @throws ApiError VALIDATION (400) nếu thiếu trường bắt buộc, tiêu đề quá 120 ký tự, môn/trình độ không hợp lệ.
 * @throws ApiError CONFLICT_STATE (409) nếu buổi học đã bị hủy.
 * @throws ApiError BR_VIOLATION (422) theo BR-48 nếu buổi học đã có kết quả đánh giá (session_results).
 */
export async function trainingCreate(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn HLV/quản lý và cờ tính năng F4 (BR-52).
  requireRole(user, ["coach", "manager"]);
  await requireFlag(sql, "F4");
  // Bước 2: Đọc dữ liệu JSON và xác định phạm vi giáo án (mẫu template, theo lớp, hoặc theo học viên).
  const b = await readJson(request);
  const classId = str(b.class_id) || null;
  const userId = str(b.user_id) || null;
  const sessionId = str(b.session_id) || null;
  const isTemplate = b.is_template === true;
  // Giáo án mẫu (template) là tài nguyên dùng chung, không gắn với lớp, học viên hay buổi học cụ thể; phải có môn và trình độ hợp lệ.
  if (isTemplate) {
    if (classId || userId || sessionId) throw err.field("class_id", "A template is not tied to a class, student or session.");
    const pl = (b.payload ?? {}) as Record<string, unknown>;
    const sports = await getActiveSportCodes(sql);
    oneOf(sports, pl.sport, "sport");
    oneOf(LEVELS, pl.level, "level");
  // Nếu không phải template, bắt buộc phải chọn lớp học hoặc học viên cụ thể.
  } else if (!classId && !userId) {
    throw err.field("class_id", "Choose a class or a student for this plan.");
  }
  // Bước 3: Kiểm tra quyền phụ trách: HLV chỉ được tạo giáo án cho lớp mình dạy hoặc học viên trong lớp của mình.
  if (classId) assertClassStaff(await loadClass(sql, uuidField(classId, "class_id")), user);
  if (userId) await loadStudent(sql, uuidField(userId, "user_id"), user);
  // Bước 4: Nếu gắn với một buổi học cụ thể, kiểm tra buổi học thuộc lớp, chưa bị hủy và chưa có kết quả (BR-48).
  if (sessionId) {
    if (!classId) throw err.field("session_id", "A session plan belongs to a class.");
    const s = await one<{ class_id: string; status: string }>(
      sql,
      `select class_id, status::text as status from sessions where id = $1`,
      [uuidField(sessionId, "session_id")],
    );
    if (!s || s.class_id !== classId) throw err.field("session_id", "That session is not in this class.");
    if (s.status === "cancelled") throw err.conflictState("That session was cancelled.");
    if (await one(sql, `select 1 as ok from session_results where session_id = $1 limit 1`, [uuidField(sessionId, "session_id")])) {
      throw err.br("BR-48", "That session already has results - a plan can no longer be added.");
    }
  }
  // Bước 5: Chuẩn hóa tiêu đề (tối đa 120 ký tự), xác định nguồn (ai hoặc coach), làm sạch payload và trạng thái xuất bản.
  const title = (str(b.title) ?? "").trim();
  if (title.length > 120) throw err.field("title", "Keep the title under 120 characters.");
  const source = str(b.source) === "ai" ? "ai" : "coach";
  const payload = cleanPayload(b.payload);
  const published = !isTemplate && b.published !== false;
  // Bước 6: Thêm giáo án mới vào bảng training_plans với phạm vi tương ứng (template, user hoặc class).
  const row = await one<{
    id: string;
    class_id: string | null;
    user_id: string | null;
    session_id: string | null;
    title: string | null;
  }>(
    sql,
    `insert into training_plans (scope, class_id, user_id, session_id, title, source, published, payload, created_by, is_template)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
     returning *`,
    [
      isTemplate ? "template" : userId ? "user" : "class",
      classId,
      userId,
      sessionId,
      title || null,
      source,
      published,
      JSON.stringify(payload),
      user.id,
      isTemplate,
    ],
  );
  // Bước 7: Nếu giáo án được xuất bản ngay (published = true), gửi thông báo inapp cho các học viên liên quan.
  if (row && published) await notifyPlan(sql, row, 1, "published");
  // Bước 8: Kiểm tra cảnh báo lệch thời lượng bài tập so với thời lượng buổi học (durationWarnings) và trả về HTTP 201.
  return { status: 201, body: { ...row, warnings: await durationWarnings(sql, sessionId, payload) } };
}

/**
 * Làm gì: Cập nhật giáo án đào tạo (xuất bản/hủy xuất bản, sửa tiêu đề, chỉnh sửa các khối bài tập).
 * Được gọi ở:
 * - URL: PATCH /v1/training-plans/:id hoặc PATCH /api/training-plans/:id
 * - Controller: src/server/controllers/router.ts (dòng 659)
 * - Frontend: src/client/components/coach-training.tsx (PlanPanel)
 * @param sql Đối tượng Sql kết nối cơ sở dữ liệu PostgreSQL trong transaction.
 * @param id ID của giáo án đào tạo cần chỉnh sửa (UUID).
 * @param request Web Fetch API Request chứa JSON các trường cần sửa (published, title, payload).
 * @param user Thông tin người dùng gửi yêu cầu (bắt buộc role 'coach' hoặc 'manager').
 * @returns Đối tượng chứa status 200 và body là giáo án sau cập nhật kèm cảnh báo thời lượng.
 * @throws ApiError NOT_FOUND (404) nếu không tìm thấy giáo án theo ID.
 * @throws ApiError FORBIDDEN (403) nếu không phải quản lý, tác giả giáo án hoặc HLV phụ trách lớp.
 * @throws ApiError VALIDATION (400) nếu tiêu đề quá 120 ký tự hoặc không có trường nào để cập nhật.
 * @throws ApiError CONFLICT_STATE (409) nếu cố xuất bản giáo án mẫu (template).
 * @throws ApiError BR_VIOLATION (422) theo BR-48 nếu buổi học đã có kết quả đánh giá (không cho phép sửa nội dung bài tập).
 */
/** Publish or unpublish a plan, or fix its title/blocks. Only its author, the class's coaches or a manager. */
export async function trainingPatch(sql: Sql, id: string, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn HLV/quản lý và cờ tính năng F4.
  requireRole(user, ["coach", "manager"]);
  await requireFlag(sql, "F4");
  // Bước 2: Khóa dòng giáo án bằng 'select for update' để tránh race condition khi có nhiều yêu cầu sửa đồng thời.
  const plan = await one<EditableTrainingPlan>(sql, `select * from training_plans where id = $1 for update`, [pathId(id)]);
  if (!plan) throw err.notFound();
  // Bước 3: Kiểm tra quyền chỉnh sửa: Quản lý sửa được tất cả; HLV chỉ sửa được giáo án do mình tạo hoặc thuộc lớp mình dạy.
  if (user.role !== "manager" && plan.created_by !== user.id) {
    if (plan.class_id) assertClassStaff(await loadClass(sql, plan.class_id), user);
    else throw err.forbidden("That plan is not yours.");
  }
  // Bước 4: Đọc dữ liệu yêu cầu và xây dựng câu lệnh UPDATE động qua sqlPatch (hỗ trợ sửa published, title, payload).
  const b = await readJson(request);
  const { sets, params, add } = sqlPatch([plan.id]);
  if (typeof b.published === "boolean") {
    add("published", b.published);
  }
  if (b.title !== undefined) {
    const title = (str(b.title) ?? "").trim();
    if (title.length > 120) throw err.field("title", "Keep the title under 120 characters.");
    add("title", title || null);
  }
  // Bước 5: Cập nhật nội dung payload bài tập, tự động lưu lịch sử phiên bản cũ và tăng version nếu giáo án đã công khai.
  const { newPayload, version } = await editTrainingPayload(sql, plan, b, user, add);
  if (sets.length === 0) throw err.field("published", "Nothing to change.");
  // Giáo án mẫu (template) chỉ dùng để nhân bản sang lớp/học viên, không xuất bản trực tiếp cho học sinh.
  if (plan.is_template && b.published === true) throw err.conflictState("A template is not published to students.");
  // Bước 6: Thực thi câu lệnh UPDATE trên bảng training_plans và lấy bản ghi sau cập nhật.
  const row = await one<{
    id: string;
    class_id: string | null;
    user_id: string | null;
    session_id: string | null;
    title: string | null;
    published: boolean;
    payload: Record<string, unknown>;
  }>(sql, `update training_plans set ${sets.join(", ")} where id = $1 returning *`, params);
  // Bước 7: Gửi thông báo inapp cho học viên nếu giáo án vừa được xuất bản hoặc nội dung bài tập đã thay đổi.
  if (row && !plan.is_template) {
    if (row.published && !plan.published) await notifyPlan(sql, row, version, "published");
    else if (row.published && newPayload) await notifyPlan(sql, row, version, "updated");
  }
  // Bước 8: Kiểm tra cảnh báo lệch thời lượng so với buổi học và trả về HTTP 200.
  const warnings = row ? await durationWarnings(sql, row.session_id, row.payload) : [];
  return { status: 200, body: { ...row, warnings } };
}

/**
 * Làm gì: Lấy danh sách các giáo án mẫu (templates) có thể tái sử dụng theo môn thể thao và trình độ (FR-TRN-04).
 * Được gọi ở:
 * - URL: GET /v1/training-plans/templates hoặc GET /api/training-plans/templates
 * - Controller: src/server/controllers/router.ts (dòng 647)
 * - Frontend: src/client/components/coach-training.tsx (PlanPanel)
 * @param sql Đối tượng Sql kết nối cơ sở dữ liệu PostgreSQL.
 * @param request Web Fetch API Request chứa query params (sport, level).
 * @param user Thông tin người dùng hiện tại (bắt buộc role 'coach' hoặc 'manager').
 * @returns Đối tượng chứa status 200 và body là danh sách tối đa 100 giáo án mẫu (items).
 * @throws ApiError FORBIDDEN (403) nếu người dùng không phải coach hoặc manager.
 */
/** Reusable plans by sport and level (FR-TRN-04). Coaches see all templates; they carry no student data. */
export async function templatesList(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn HLV/quản lý và cờ tính năng F4.
  requireRole(user, ["coach", "manager"]);
  await requireFlag(sql, "F4");
  // Bước 2: Lấy tham số lọc môn thể thao (sport) và trình độ (level) từ query params của request.
  const url = new URL(request.url);
  const sport = url.searchParams.get("sport");
  const level = url.searchParams.get("level");
  // Bước 3: Truy vấn danh sách giáo án mẫu (is_template = true), sắp xếp theo môn và trình độ, giới hạn tối đa 100 bản ghi.
  const items = await sql.query(
    `select id, title, payload, version, created_by, created_at from training_plans
      where is_template and ($1::text is null or payload->>'sport' = $1) and ($2::text is null or payload->>'level' = $2)
      order by payload->>'sport', payload->>'level', title nulls last limit 100`,
    [sport, level],
  );
  return { status: 200, body: { items } };
}

/**
 * Làm gì: Sao chép một giáo án hiện có thành giáo án mẫu (template) độc lập để tái sử dụng; bản gốc không bị thay đổi.
 * Được gọi ở:
 * - URL: POST /v1/training-plans/:id/save-template hoặc POST /api/training-plans/:id/save-template
 * - Controller: src/server/controllers/router.ts (dòng 653)
 * - Frontend: src/client/components/coach-training.tsx (PlanPanel: nút "Save as template")
 * @param sql Đối tượng Sql kết nối cơ sở dữ liệu PostgreSQL trong transaction.
 * @param id ID của giáo án gốc cần lưu thành mẫu (UUID).
 * @param request Web Fetch API Request chứa JSON tùy chọn (sport, level, title mới cho template).
 * @param user Thông tin người dùng gửi yêu cầu (bắt buộc role 'coach' hoặc 'manager').
 * @returns Đối tượng chứa status 201 và body là bản ghi giáo án mẫu mới tạo.
 * @throws ApiError NOT_FOUND (404) nếu không tìm thấy giáo án gốc.
 * @throws ApiError FORBIDDEN (403) nếu không phải quản lý, tác giả giáo án hoặc HLV phụ trách lớp của giáo án gốc.
 * @throws ApiError VALIDATION (400) nếu môn thể thao hoặc trình độ không hợp lệ.
 */
/** Save a plan as a template (a copy; the original is untouched). */
export async function templateSave(sql: Sql, id: string, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn HLV/quản lý và cờ tính năng F4.
  requireRole(user, ["coach", "manager"]);
  await requireFlag(sql, "F4");
  // Bước 2: Tải thông tin giáo án gốc và kiểm tra quyền truy cập (chỉ quản lý, người tạo hoặc HLV của lớp mới được lưu mẫu).
  const src = await one<{ title: string | null; payload: Record<string, unknown>; created_by: string | null; class_id: string | null }>(
    sql,
    `select title, payload, created_by, class_id from training_plans where id = $1`,
    [pathId(id)],
  );
  if (!src) throw err.notFound();
  if (user.role !== "manager" && src.created_by !== user.id) {
    if (src.class_id) assertClassStaff(await loadClass(sql, src.class_id), user);
    else throw err.forbidden("That plan is not yours.");
  }
  // Bước 3: Đọc dữ liệu yêu cầu, kế thừa payload từ giáo án gốc và xác thực môn thể thao, trình độ hợp lệ.
  const b = await readJson(request);
  const payload = { ...src.payload } as Record<string, unknown>;
  const sports = await getActiveSportCodes(sql);
  payload.sport = oneOf(sports, b.sport ?? payload.sport, "sport");
  // Lớp "mọi trình độ" hay giáo án AI có thể mang trình độ ngoài danh sách: lấy giá trị hợp lệ đầu tiên, không có thì "beginner"
  const cls = src.class_id ? await one<{ level: string }>(sql, `select level from classes where id = $1`, [src.class_id]) : undefined;
  payload.level =
    [b.level, payload.level, cls?.level]
      .map((v) => (typeof v === "string" ? v.trim().toLowerCase() : ""))
      .find((v): v is (typeof LEVELS)[number] => (LEVELS as readonly string[]).includes(v)) ?? "beginner";
  const title = (str(b.title) ?? src.title ?? "").trim().slice(0, 120);
  // Bước 4: Tạo bản ghi giáo án mẫu mới (scope = 'template', is_template = true, published = false) vào training_plans.
  const row = await one(
    sql,
    `insert into training_plans (scope, title, source, published, payload, created_by, is_template)
     values ('template',$1,'coach',false,$2::jsonb,$3,true) returning *`,
    [title || null, JSON.stringify(cleanPayload(payload)), user.id],
  );
  return { status: 201, body: row };
}

/**
 * Làm gì: Khởi tạo bản thảo giáo án mới cho một lớp học, học viên hoặc buổi học dựa trên giáo án mẫu có sẵn (FR-TRN-04).
 * Được gọi ở:
 * - URL: POST /v1/training-plans/from-template hoặc POST /api/training-plans/from-template
 * - Controller: src/server/controllers/router.ts (dòng 650)
 * - Frontend: src/client/components/coach-training.tsx (PlanPanel)
 * @param sql Đối tượng Sql kết nối cơ sở dữ liệu PostgreSQL trong transaction.
 * @param request Web Fetch API Request chứa body JSON (template_id, class_id, user_id, session_id).
 * @param user Thông tin người dùng gửi yêu cầu (bắt buộc role 'coach' hoặc 'manager').
 * @returns Đối tượng chứa status 201 và body là giáo án bản thảo mới tạo kèm cảnh báo thời lượng.
 * @throws ApiError NOT_FOUND (404) nếu giáo án mẫu (template_id) không tồn tại.
 * @throws ApiError VALIDATION (400) nếu không chọn lớp học hoặc học viên, hoặc buổi học không thuộc lớp đã chọn.
 * @throws ApiError FORBIDDEN (403) nếu HLV không phụ trách lớp hoặc học viên được chỉ định.
 * @throws ApiError BR_VIOLATION (422) theo BR-48 nếu buổi học đã có kết quả đánh giá (session_results).
 */
/** Start a draft for a class, student or session from a template (FR-TRN-04). */
export async function plansFromTemplate(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn HLV/quản lý và cờ tính năng F4.
  requireRole(user, ["coach", "manager"]);
  await requireFlag(sql, "F4");
  // Bước 2: Tải thông tin giáo án mẫu theo template_id và kiểm tra xem mẫu có tồn tại không.
  const b = await readJson(request);
  const tpl = await one<{ id: string; title: string | null; payload: Record<string, unknown> }>(
    sql,
    `select id, title, payload from training_plans where id = $1 and is_template`,
    [uuidField(b.template_id, "template_id")],
  );
  if (!tpl) throw err.notFound("That template does not exist.");
  // Bước 3: Xác thực đối tượng áp dụng (bắt buộc chọn lớp học hoặc học viên) và kiểm tra quyền phụ trách của HLV.
  const classId = str(b.class_id) || null;
  const userId = str(b.user_id) || null;
  const sessionId = str(b.session_id) || null;
  if (!classId && !userId) throw err.field("class_id", "Choose a class or a student for this plan.");
  if (classId) assertClassStaff(await loadClass(sql, uuidField(classId, "class_id")), user);
  if (userId) await loadStudent(sql, uuidField(userId, "user_id"), user);
  // Bước 4: Nếu gắn với một buổi học cụ thể, kiểm tra buổi học thuộc đúng lớp và chưa có kết quả đánh giá (BR-48).
  if (sessionId) {
    const s = await one<{ class_id: string }>(sql, `select class_id from sessions where id = $1`, [uuidField(sessionId, "session_id")]);
    if (!s || s.class_id !== classId) throw err.field("session_id", "That session is not in this class.");
    if (await one(sql, `select 1 as ok from session_results where session_id = $1 limit 1`, [sessionId])) {
      throw err.br("BR-48", "That session already has results — a plan can no longer be added.");
    }
  }
  // Bước 5: Chèn bản ghi giáo án mới dạng bản thảo (published = false) với parent_id trỏ về giáo án mẫu gốc.
  const row = await one<Record<string, unknown>>(
    sql,
    `insert into training_plans (scope, class_id, user_id, session_id, title, source, published, payload, created_by, parent_id)
     values ($1,$2,$3,$4,$5,'coach',false,$6::jsonb,$7,$8) returning *`,
    [userId ? "user" : "class", classId, userId, sessionId, tpl.title, JSON.stringify(tpl.payload), user.id, tpl.id],
  );
  // Bước 6: Kiểm tra cảnh báo lệch thời lượng so với buổi học và trả về HTTP 201.
  return { status: 201, body: { ...row, warnings: await durationWarnings(sql, sessionId, tpl.payload) } };
}

/**
 * Làm gì: Lấy danh sách các phiên bản lịch sử trước đây của giáo án đào tạo, sắp xếp theo thứ tự mới nhất trước.
 * Được gọi ở:
 * - URL: GET /v1/training-plans/:id/versions hoặc GET /api/training-plans/:id/versions
 * - Controller: src/server/controllers/router.ts (dòng 656)
 * - Frontend: src/client/components/coach-training.tsx (PlanPanel)
 * @param sql Đối tượng Sql kết nối cơ sở dữ liệu PostgreSQL.
 * @param id ID của giáo án đào tạo cần xem lịch sử phiên bản (UUID).
 * @param user Thông tin người dùng hiện tại (bắt buộc role 'coach' hoặc 'manager').
 * @returns Đối tượng chứa status 200 và body là danh sách các phiên bản cũ (items) từ bảng training_plan_versions.
 * @throws ApiError NOT_FOUND (404) nếu không tìm thấy giáo án theo ID.
 * @throws ApiError FORBIDDEN (403) nếu HLV không phải người tạo và không phụ trách lớp của giáo án đó.
 */
/** Earlier versions of a plan, newest first. */
export async function planVersions(sql: Sql, id: string, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn HLV/quản lý và cờ tính năng F4.
  requireRole(user, ["coach", "manager"]);
  await requireFlag(sql, "F4");
  // Bước 2: Tải thông tin giáo án và kiểm tra quyền truy cập (chỉ quản lý, người tạo hoặc HLV của lớp mới được xem lịch sử).
  const plan = await one<{ class_id: string | null; created_by: string | null }>(
    sql,
    `select class_id, created_by from training_plans where id = $1`,
    [pathId(id)],
  );
  if (!plan) throw err.notFound();
  if (user.role !== "manager" && plan.created_by !== user.id) {
    if (plan.class_id) assertClassStaff(await loadClass(sql, plan.class_id), user);
    else throw err.forbidden("That plan is not yours.");
  }
  // Bước 3: Truy vấn bảng training_plan_versions lấy toàn bộ các phiên bản cũ đã lưu, sắp xếp giảm dần theo version.
  const items = await sql.query(
    `select version, title, payload, edited_by, created_at from training_plan_versions
      where plan_id = $1 order by version desc`,
    [pathId(id)],
  );
  return { status: 200, body: { items } };
}

/**
 * Làm gì: Sao chép toàn bộ giáo án của các buổi học trong một tuần sang tuần tiếp theo (+7 ngày) cho cùng một lớp học.
 * Được gọi ở:
 * - URL: POST /v1/classes/:classId/plans/duplicate-week hoặc POST /api/classes/:classId/plans/duplicate-week
 * - Controller: src/server/controllers/router.ts (dòng 662)
 * - Frontend: src/client/components/coach-training.tsx
 * @param sql Đối tượng Sql kết nối cơ sở dữ liệu PostgreSQL trong transaction.
 * @param classId ID của lớp học cần sao chép giáo án (UUID).
 * @param request Web Fetch API Request chứa JSON { from: "YYYY-MM-DD" } là ngày bắt đầu tuần nguồn.
 * @param user Thông tin người dùng gửi yêu cầu (bắt buộc role 'coach' hoặc 'manager').
 * @returns Đối tượng chứa status 200 và body gồm số buổi đã sao chép (copied) và danh sách buổi bị bỏ qua (skipped).
 * @throws ApiError FORBIDDEN (403) nếu không có quyền hoặc không phụ trách lớp này.
 * @throws ApiError VALIDATION (400) nếu ngày 'from' không đúng định dạng YYYY-MM-DD.
 */
/**
 * Copy last week's session plans onto this week's sessions.
 *
 * `from` is any date in the source week (it covers that day and the six after).
 * A target session is left alone when it is cancelled, already past, already has
 * a plan, or already has results — the coach has started it and a copy must not
 * pile a second plan on top. Copies arrive as drafts so nothing reaches students
 * before the coach has looked at it.
 */
export async function plansDuplicateWeek(sql: Sql, classId: string, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn HLV/quản lý, cờ tính năng F4 và xác thực HLV phụ trách lớp học.
  requireRole(user, ["coach", "manager"]);
  await requireFlag(sql, "F4");
  const cl = await loadClass(sql, pathId(classId));
  assertClassStaff(cl, user);
  // Bước 2: Đọc và xác thực ngày bắt đầu tuần nguồn 'from' (định dạng YYYY-MM-DD theo giờ ICT).
  const from = str((await readJson(request)).from) ?? "";
  if (!DATE_RE.test(from) || Number.isNaN(ictDateTime(from, "00:00").getTime())) {
    throw err.field("from", "Use a date like 2026-10-05.");
  }
  // Khoảng thời gian tuần nguồn kéo dài 7 ngày kể từ 00:00 ngày 'from'.
  const start = ictDateTime(from, "00:00");
  const end = ictDateTime(addDays(from, 7), "00:00");
  // Bước 3: Tìm tất cả các buổi học trong tuần nguồn có giáo án gắn liền và không bị hủy.
  const sources = await sql.query<{ id: string; start_at: string }>(
    `select s.id, s.start_at from sessions s
      where s.class_id = $1 and s.status <> 'cancelled' and s.start_at >= $2 and s.start_at < $3
        and exists (select 1 from training_plans p where p.session_id = s.id)
      order by s.start_at`,
    [cl.id, start.toISOString(), end.toISOString()],
  );
  // Bước 4: Lặp qua từng buổi học nguồn, tìm buổi học tương ứng ở tuần sau (+7 ngày) và kiểm tra các điều kiện loại trừ.
  const skipped: { session_id: string; reason: string }[] = [];
  let copied = 0;
  for (const src of sources) {
    // Thời điểm bắt đầu của buổi học đích được tính bằng cách cộng thêm đúng 7 ngày (7 * 24 giờ).
    const targetStart = new Date(new Date(src.start_at).getTime() + 7 * DAY_MS);
    const target = await one<{ id: string; status: string; end_at: string }>(
      sql,
      `select id, status::text as status, end_at from sessions where class_id = $1 and start_at = $2`,
      [cl.id, targetStart.toISOString()],
    );
    // Bỏ qua nếu không tìm thấy buổi học tương ứng ở tuần kế tiếp.
    if (!target) {
      skipped.push({ session_id: src.id, reason: "no_session" });
      continue;
    }
    // Bỏ qua nếu buổi học đích đã bị hủy.
    if (target.status === "cancelled") {
      skipped.push({ session_id: target.id, reason: "cancelled" });
      continue;
    }
    // Bỏ qua nếu buổi học đích đã kết thúc trong quá khứ.
    if (new Date(target.end_at).getTime() < Date.now()) {
      skipped.push({ session_id: target.id, reason: "past" });
      continue;
    }
    // Bỏ qua nếu buổi học đích đã có kết quả đánh giá (BR-48 cấm thêm/sửa giáo án khi đã có kết quả).
    if (await one(sql, `select 1 as ok from session_results where session_id = $1 limit 1`, [target.id])) {
      skipped.push({ session_id: target.id, reason: "has_results" });
      continue;
    }
    // Bỏ qua nếu buổi học đích đã có giáo án từ trước (tránh ghi đè giáo án đã chuẩn bị).
    if (await one(sql, `select 1 as ok from training_plans where session_id = $1 limit 1`, [target.id])) {
      skipped.push({ session_id: target.id, reason: "has_plan" });
      continue;
    }
    // Bước 5: Sao chép giáo án sang buổi học đích dưới dạng bản thảo chưa xuất bản (published = false) để HLV duyệt lại.
    const n = await sql.query(
      `insert into training_plans (scope, class_id, user_id, session_id, title, source, published, payload, created_by)
       select scope, class_id, user_id, $2, title, source, false, payload, $3
         from training_plans where session_id = $1 and not is_template
       returning id`,
      [src.id, target.id, user.id],
    );
    copied += n.length;
  }
  // Bước 6: Trả về số lượng giáo án đã sao chép thành công và danh sách các buổi học bị bỏ qua kèm lý do.
  return { status: 200, body: { copied, skipped } };
}

// Cấu trúc dữ liệu giáo án phục vụ cập nhật trong trainingPatch và editTrainingPayload
type EditableTrainingPlan = {
    id: string;
    class_id: string | null;
    user_id: string | null;
    session_id: string | null;
    created_by: string | null;
    title: string | null;
    published: boolean;
    is_template: boolean;
    version: number;
    payload: Record<string, unknown>;
  };

/**
 * Làm gì: Xử lý cập nhật nội dung bài tập (payload) của giáo án, lưu lịch sử phiên bản cũ và tăng số version nếu đã xuất bản.
 * Được gọi ở: src/server/controllers/handlers/training.ts (trong hàm trainingPatch).
 * @param sql Đối tượng Sql kết nối cơ sở dữ liệu PostgreSQL trong transaction.
 * @param plan Bản ghi giáo án hiện tại trước khi sửa (EditableTrainingPlan).
 * @param b Dữ liệu request body nhận được từ client.
 * @param user Thông tin người dùng thực hiện cập nhật (lưu vào edited_by khi tạo version mới).
 * @param add Hàm add từ sqlPatch để thêm các trường cập nhật (payload, version) vào câu lệnh SQL.
 * @returns Đối tượng chứa payload mới đã làm sạch (newPayload) và số version mới.
 * @throws ApiError BR_VIOLATION (422) theo BR-48 nếu buổi học đã có kết quả đánh giá (session_results).
 */
async function editTrainingPayload(sql: Sql, plan: EditableTrainingPlan, b: Record<string, unknown>, user: PublicUser, add: ReturnType<typeof sqlPatch>["add"]) {
  let newPayload: Record<string, unknown> | null = null;
  let version = plan.version;
  // Bước 1: Kiểm tra xem client có gửi payload mới hay không; nếu có thì làm sạch dữ liệu payload bằng cleanPayload.
  if (b.payload !== undefined) {
    newPayload = cleanPayload(b.payload);
    // A session that already has results keeps the plan it was run with (BR-48).
    if (plan.session_id && (await one(sql, `select 1 as ok from session_results where session_id = $1 limit 1`, [plan.session_id]))) {
      throw err.br("BR-48", "That session already has results, so its plan can no longer change. Copy it to a new session instead.");
    }
    // Editing something students can already see makes a new version; the old one is kept.
    // Bước 2: Lưu bản chụp phiên bản cũ vào bảng training_plan_versions và tăng số version lên 1.
    if (plan.published && !plan.is_template) {
      await sql.query(
        `insert into training_plan_versions (plan_id, version, title, payload, edited_by)
         values ($1,$2,$3,$4::jsonb,$5) on conflict (plan_id, version) do nothing`,
        [plan.id, plan.version, plan.title, JSON.stringify(plan.payload), user.id],
      );
      version = plan.version + 1;
      add("version", version);
    }
    // Bước 3: Thêm payload mới vào danh sách cập nhật của câu lệnh SQL UPDATE dưới dạng jsonb.
    add("payload", JSON.stringify(newPayload), "::jsonb");
  }
  // Bước 4: Trả về payload mới và số version mới sau khi xử lý.
  return { newPayload, version };
}
