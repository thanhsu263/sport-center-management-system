/**
 * Quản lý chứng chỉ trong hệ thống trung tâm thể thao Arena 3, bao gồm hai nhóm nghiệp vụ:
 * 1. Bằng cấp/chứng chỉ của huấn luyện viên (coach_certifications): hồ sơ công khai, danh sách quản lý theo HLV, thêm mới và xóa chứng chỉ.
 * 2. Chứng nhận hoàn thành lớp học của hội viên (class_certificates): kiểm tra điều kiện chuyên cần (>= 80% số buổi sau khi lớp kết thúc), cấp mã chứng nhận ngẫu nhiên không nhầm lẫn và xác thực chứng chỉ công khai theo mã code.
 */
import { randomBytes } from "node:crypto";
import type { Sql } from "@/server/data/db";
import { err } from "../errors";
import { audit, isUuid, readJson, str } from "../helpers";
import { requireRole, type PublicUser } from "../session";
import { one } from "../tx";

/** The share of a finished class's sessions a member must attend to earn its certificate. */
export const COMPLETION_SHARE = 0.8;

// ---- Coach certifications -------------------------------------------------

/** Every coach's certifications that have not expired, for the public coach profiles. */
/**
 * Làm gì: Lấy danh sách toàn bộ chứng chỉ còn hiệu lực của các huấn luyện viên đang hoạt động (active), phục vụ hiển thị trên hồ sơ HLV công khai.
 * Được gọi ở: src/server/controllers/router.ts qua route GET /api/coaches/certifications (hoặc /v1/coaches/certifications).
 * @param sql Kết nối cơ sở dữ liệu để truy vấn bảng coach_certifications và users.
 * @returns Phản hồi HTTP 200 với danh sách chứng chỉ gồm id, coach_id, name, issuer, issued_on, expires_on.
 * @throws Không chủ động ném lỗi; trả về mảng rỗng nếu không có chứng chỉ nào thỏa mãn.
 */
export async function coachCertificationsPublic(sql: Sql) {
  // Chỉ lấy chứng chỉ không có ngày hết hạn hoặc còn hạn tính đến ngày hiện tại, và HLV phải đang active.
  const items = await sql.query(
    `select cc.id, cc.coach_id, cc.name, cc.issuer, cc.issued_on::text, cc.expires_on::text
       from coach_certifications cc
       join users u on u.id = cc.coach_id and u.role = 'coach' and u.status = 'active'
      where cc.expires_on is null or cc.expires_on >= current_date
      order by cc.coach_id, cc.issued_on desc nulls last, cc.name`,
  );
  return { status: 200, body: { items } };
}

/** One coach's certifications, expired ones included, for whoever manages them. */
/**
 * Làm gì: Lấy danh sách tất cả chứng chỉ của một huấn luyện viên cụ thể (bao gồm cả chứng chỉ đã hết hạn) để phục vụ quản lý nội bộ.
 * Được gọi ở:
 *   - src/server/controllers/router.ts qua route GET /api/coaches/:id/certifications (authedRead).
 *   - Modal CertificationsModal (src/client/components/coach-certifications.tsx) khi xem danh sách chứng chỉ của HLV.
 * @param sql Kết nối cơ sở dữ liệu để truy vấn bảng coach_certifications.
 * @param coachId Mã UUID của huấn luyện viên cần lấy danh sách chứng chỉ.
 * @param user Thông tin người dùng đăng nhập; yêu cầu vai trò manager, coach hoặc receptionist.
 * @returns Phản hồi HTTP 200 với danh sách chứng chỉ, kèm cờ boolean 'expired' đánh dấu chứng chỉ đã hết hạn.
 * @throws Lỗi 403 nếu user không có quyền; lỗi 404 nếu coachId không phải định dạng UUID hợp lệ.
 */
export async function coachCertificationsList(sql: Sql, coachId: string, user: PublicUser) {
  // Bước 1: Kiểm tra phân quyền — chỉ manager, coach hoặc receptionist mới có quyền xem danh sách chứng chỉ quản lý.
  requireRole(user, ["manager", "coach", "receptionist"]);
  // Kiểm tra định dạng UUID của coachId để tránh lỗi truy vấn database.
  if (!isUuid(coachId)) throw err.notFound("No such coach.");
  // Bước 2: Truy vấn toàn bộ chứng chỉ của HLV; tính toán cờ 'expired' (true nếu ngày hết hạn trước ngày hiện tại).
  const items = await sql.query(
    `select id, coach_id, name, issuer, issued_on::text, expires_on::text,
            (expires_on is not null and expires_on < current_date) as expired
       from coach_certifications where coach_id = $1
      order by issued_on desc nulls last, name`,
    [coachId],
  );
  return { status: 200, body: { items } };
}

/**
 * Làm gì: Kiểm tra quyền quản lý chứng chỉ HLV: chỉ quản lý (manager) hoặc chính HLV đó mới được phép thêm hoặc xóa chứng chỉ của mình.
 * Được gọi ở: certificates.ts trong các hàm coachCertificationCreate (bước 1) và coachCertificationDelete (bước 3).
 * @param user Thông tin người dùng đang đăng nhập từ phiên làm việc (session).
 * @param coachId Mã UUID của huấn luyện viên sở hữu chứng chỉ.
 * @throws Lỗi 403 (forbidden) nếu người dùng không phải manager và cũng không phải chính HLV đó.
 */
function assertCanManage(user: PublicUser, coachId: string) {
  if (user.role === "manager") return;
  if (user.role === "coach" && user.id === coachId) return;
  throw err.forbidden("Only a manager or the coach can change these certifications.");
}

// Biểu thức chính quy kiểm tra định dạng ngày chuẩn ISO (YYYY-MM-DD) cho ngày cấp và ngày hết hạn.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Làm gì: Tạo mới một chứng chỉ chuyên môn cho huấn luyện viên sau khi xác thực quyền và tính hợp lệ của dữ liệu đầu vào.
 * Được gọi ở:
 *   - src/server/controllers/router.ts qua route POST /api/coaches/:id/certifications (authed transaction).
 *   - Nút thêm chứng chỉ trong CertificationsModal (src/client/components/coach-certifications.tsx).
 * @param sql Kết nối cơ sở dữ liệu trong transaction do router quản lý.
 * @param coachId Mã UUID của huấn luyện viên được thêm chứng chỉ.
 * @param request Request HTTP POST chứa body JSON gồm: name, issuer, issued_on, expires_on.
 * @param user Thông tin người dùng thực hiện thao tác (manager hoặc chính HLV đó).
 * @returns Phản hồi HTTP 201 kèm bản ghi chứng chỉ vừa tạo trong cơ sở dữ liệu.
 * @throws Lỗi 404 nếu coachId không hợp lệ hoặc user không phải role 'coach'; lỗi 403 nếu không có quyền quản lý; lỗi 400 nếu dữ liệu các trường không hợp lệ hoặc ngày hết hạn trước ngày cấp.
 */
export async function coachCertificationCreate(sql: Sql, coachId: string, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra mã coachId hợp lệ và xác minh quyền quản lý (chỉ manager hoặc chính HLV đó).
  if (!isUuid(coachId)) throw err.notFound("No such coach.");
  assertCanManage(user, coachId);
  // Bước 2: Kiểm tra tài khoản HLV có tồn tại trong hệ thống và đúng vai trò 'coach'.
  const coach = await one<{ role: string }>(sql, `select role from users where id = $1`, [coachId]);
  if (!coach || coach.role !== "coach") throw err.notFound("No such coach.");
  // Bước 3: Đọc và xác thực dữ liệu từ body JSON (tên chứng chỉ, đơn vị cấp, ngày cấp, ngày hết hạn).
  const b = await readJson(request);
  const name = str(b.name)?.trim();
  const issuer = str(b.issuer)?.trim() || null;
  const issued_on = str(b.issued_on) || null;
  const expires_on = str(b.expires_on) || null;
  if (!name || name.length > 120) throw err.field("name", "Name the certification (120 characters at most).");
  if (issuer && issuer.length > 120) throw err.field("issuer", "The issuer is 120 characters at most.");
  if (issued_on && !ISO_DATE.test(issued_on)) throw err.field("issued_on", "Pick the date it was issued.");
  if (expires_on && !ISO_DATE.test(expires_on)) throw err.field("expires_on", "Pick the date it expires.");
  // Quy tắc nghiệp vụ: ngày hết hạn không được xảy ra trước ngày cấp chứng chỉ.
  if (issued_on && expires_on && expires_on < issued_on) {
    throw err.field("expires_on", "It cannot expire before it was issued.");
  }
  // Bước 4: Thêm bản ghi chứng chỉ mới vào bảng coach_certifications.
  const row = await one<{ id: string }>(
    sql,
    `insert into coach_certifications (coach_id, name, issuer, issued_on, expires_on, created_by)
     values ($1, $2, $3, $4::date, $5::date, $6)
     returning id, coach_id, name, issuer, issued_on::text, expires_on::text`,
    [coachId, name, issuer, issued_on, expires_on, user.id],
  );
  // Bước 5: Ghi nhật ký kiểm toán (audit log) lưu vết thao tác tạo chứng chỉ HLV và trả về kết quả.
  await audit(sql, user.id, "add_coach_certification", "user", coachId, null, { name, issuer, issued_on, expires_on });
  return { status: 201, body: row };
}

/**
 * Làm gì: Xóa một chứng chỉ của huấn luyện viên khỏi cơ sở dữ liệu và ghi nhật ký kiểm toán.
 * Được gọi ở:
 *   - src/server/controllers/router.ts qua route DELETE /api/certifications/:id (authed transaction).
 *   - Nút xóa chứng chỉ trong CertificationsModal (src/client/components/coach-certifications.tsx).
 * @param sql Kết nối cơ sở dữ liệu trong transaction do router quản lý.
 * @param id Mã UUID của chứng chỉ cần xóa trong bảng coach_certifications.
 * @param user Thông tin người dùng thực hiện xóa (manager hoặc chính HLV sở hữu chứng chỉ).
 * @returns Phản hồi HTTP 200 với { ok: true }.
 * @throws Lỗi 404 nếu mã chứng chỉ không tồn tại hoặc sai định dạng UUID; lỗi 403 nếu không có quyền quản lý chứng chỉ này.
 */
export async function coachCertificationDelete(sql: Sql, id: string, user: PublicUser) {
  // Bước 1: Kiểm tra định dạng UUID của mã chứng chỉ cần xóa.
  if (!isUuid(id)) throw err.notFound("No such certification.");
  // Bước 2: Tìm chứng chỉ và khóa dòng với FOR UPDATE để tránh xung đột thao tác đồng thời.
  const row = await one<{ coach_id: string; name: string }>(
    sql,
    `select coach_id, name from coach_certifications where id = $1 for update`,
    [id],
  );
  if (!row) throw err.notFound("No such certification.");
  // Bước 3: Kiểm tra quyền quản lý — chỉ manager hoặc chính HLV sở hữu chứng chỉ mới được xóa.
  assertCanManage(user, row.coach_id);
  // Bước 4: Xóa chứng chỉ khỏi bảng coach_certifications và ghi nhật ký kiểm toán (audit log).
  await sql.query(`delete from coach_certifications where id = $1`, [id]);
  await audit(sql, user.id, "remove_coach_certification", "user", row.coach_id, { name: row.name }, null);
  return { status: 200, body: { ok: true } };
}

// ---- Member completion certificates ---------------------------------------

type Completion = {
  enrollment_id: string;
  class_id: string;
  sport: string;
  level: string;
  coach_name: string;
  start_on: string;
  end_on: string;
  sessions: number;
  attended: number;
  remaining: number;
  class_over: boolean;
  code: string | null;
  issued_at: string | null;
};

// A session counts once it has ended and was not cancelled; present or late counts as attended.
const COMPLETION_SQL = `
  select e.id as enrollment_id, cl.id as class_id, cl.sport::text as sport, cl.level, u.full_name as coach_name,
         cl.start_on::text, cl.end_on::text,
         cl.end_on < (now() at time zone 'Asia/Ho_Chi_Minh')::date as class_over,
         (select count(*)::int from sessions s
           where s.class_id = cl.id and s.status <> 'cancelled' and s.end_at <= now()) as sessions,
         (select count(*)::int from sessions s
           where s.class_id = cl.id and s.status <> 'cancelled' and s.end_at > now()) as remaining,
         (select count(distinct a.session_id)::int from attendance a
            join sessions s on s.id = a.session_id
           where a.kind = 'session' and a.user_id = e.user_id and s.class_id = cl.id
             and s.status <> 'cancelled' and a.result in ('present', 'late')) as attended,
         cc.code, cc.issued_at
    from enrollments e
    join classes cl on cl.id = e.class_id
    join users u on u.id = cl.coach_id
    left join class_certificates cc on cc.enrollment_id = e.id
   where e.user_id = $1 and e.status = 'confirmed' and cl.status <> 'cancelled'`;

/**
 * Làm gì: Kiểm tra hội viên đã đủ 4 điều kiện để nhận chứng nhận hoàn thành khóa học hay chưa:
 * 1. Lớp học đã qua ngày kết thúc (class_over).
 * 2. Không còn buổi học nào trong tương lai (remaining === 0).
 * 3. Lớp có ít nhất 1 buổi học hợp lệ đã kết thúc (sessions > 0).
 * 4. Tỷ lệ tham dự (attended / sessions) đạt từ 80% trở lên (COMPLETION_SHARE).
 * Được gọi ở: certificates.ts trong các hàm meCertificates (tính cờ eligible) và meCertificateIssue (xác thực trước khi cấp).
 * @param c Dữ liệu tiến độ học gồm sessions, attended, remaining và class_over.
 * @returns true nếu hội viên thỏa mãn tất cả điều kiện để nhận chứng nhận, ngược lại false.
 */
function earned(c: Pick<Completion, "sessions" | "attended" | "remaining" | "class_over">) {
  return c.class_over && c.remaining === 0 && c.sessions > 0 && c.attended / c.sessions >= COMPLETION_SHARE;
}

/** The member's classes with how far each is from a certificate, and the certificates earned. */
/**
 * Làm gì: Lấy danh sách các lớp học của hội viên kèm tiến độ tham gia từng lớp, trạng thái chứng nhận đã cấp và cờ đủ điều kiện nhận chứng nhận (eligible).
 * Được gọi ở:
 *   - src/server/controllers/router.ts qua route GET /api/me/certificates (authedRead).
 *   - Giao diện luyện tập của hội viên (src/client/components/member-certificates.tsx - CertificatesSection).
 *   - Test runner: src/server/controllers/tx.test.ts (kiểm thử danh sách chứng chỉ của hội viên).
 * @param sql Kết nối cơ sở dữ liệu để truy vấn danh sách lớp và điểm danh của hội viên.
 * @param user Thông tin hội viên đang đăng nhập; yêu cầu vai trò 'member'.
 * @returns Phản hồi HTTP 200 gồm tỷ lệ yêu cầu (share = 0.8) và danh sách lớp học kèm cờ eligible.
 * @throws Lỗi 403 nếu người dùng không phải vai trò 'member'.
 */
export async function meCertificates(sql: Sql, user: PublicUser) {
  // Bước 1: Yêu cầu quyền hội viên (member); các vai trò khác không thể truy vấn endpoint cá nhân này.
  requireRole(user, ["member"]);
  // Bước 2: Truy vấn danh sách lớp học đã xác nhận đăng ký (confirmed) và chưa bị hủy của hội viên.
  const rows = await sql.query<Completion>(`${COMPLETION_SQL} order by cl.end_on desc`, [user.id]);
  // Bước 3: Tính toán cờ eligible (đủ điều kiện) cho từng lớp qua hàm earned() và trả về cùng ngưỡng chuyên cần.
  return {
    status: 200,
    body: {
      share: COMPLETION_SHARE,
      items: rows.map((r) => ({ ...r, eligible: earned(r) })),
    },
  };
}

// Ten characters a person can read aloud: no 0/O or 1/I.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/**
 * Làm gì: Sinh ngẫu nhiên một mã chứng chỉ dài 10 ký tự từ bảng chữ cái an toàn (loại bỏ 0, O, 1, I để tránh nhầm lẫn khi đọc hoặc gõ).
 * Được gọi ở: certificates.ts trong hàm meCertificateIssue khi cấp chứng chỉ mới.
 * @returns Chuỗi ngẫu nhiên 10 ký tự viết hoa và số (ví dụ: "A3K9MNP2X7").
 */
function certCode(): string {
  const bytes = randomBytes(10);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** Issues the certificate for a finished class, once; asking again returns the same code. */
/**
 * Làm gì: Cấp chứng nhận hoàn thành lớp học cho hội viên nếu đủ điều kiện (lớp đã xong và tham dự >= 80% số buổi); nếu đã cấp trước đó thì trả lại mã cũ (idempotent).
 * Được gọi ở:
 *   - src/server/controllers/router.ts qua route POST /api/me/certificates/:enrollment_id (authed transaction).
 *   - Nút nhận chứng chỉ trong CertificatesSection (src/client/components/member-certificates.tsx).
 *   - Test runner: src/server/controllers/tx.test.ts (kiểm thử cấp mới và tính idempotent khi gọi lại).
 * @param sql Kết nối cơ sở dữ liệu trong transaction do router quản lý.
 * @param enrollmentId Mã đăng ký lớp học (enrollment_id) của hội viên.
 * @param user Thông tin hội viên đang đăng nhập; yêu cầu vai trò 'member'.
 * @returns Phản hồi HTTP 201 (cấp mới) hoặc 200 (nếu đã cấp trước đó) chứa mã code của chứng nhận.
 * @throws Lỗi 403 nếu không phải hội viên; lỗi 404 nếu không tìm thấy lượt đăng ký lớp; lỗi 409 (conflictState) nếu lớp chưa kết thúc hoặc chưa đạt 80% số buổi học.
 */
export async function meCertificateIssue(sql: Sql, enrollmentId: string, user: PublicUser) {
  // Bước 1: Xác thực vai trò hội viên và kiểm tra định dạng UUID của mã đăng ký enrollmentId.
  requireRole(user, ["member"]);
  if (!isUuid(enrollmentId)) throw err.notFound("No such class.");
  // Bước 2: Truy vấn thông tin đăng ký lớp học và tiến độ điểm danh của hội viên.
  const row = await one<Completion>(sql, `${COMPLETION_SQL} and e.id = $2`, [user.id, enrollmentId]);
  if (!row) throw err.notFound("No such class.");
  // Tính chất idempotent: nếu lớp đã được cấp mã chứng nhận trước đó thì trả về ngay mã code hiện tại.
  if (row.code) return { status: 200, body: { code: row.code } };
  // Bước 3: Kiểm tra điều kiện hoàn thành khóa học — từ chối nếu lớp chưa kết thúc hoặc tỷ lệ tham dự dưới 80%.
  if (!earned(row)) {
    throw err.conflictState(
      !row.class_over || row.remaining > 0
        ? "The class is not over yet."
        : `Attend at least ${Math.round(COMPLETION_SHARE * 100)}% of the sessions to earn this certificate.`,
    );
  }
  // Bước 4: Lưu chứng nhận vào bảng class_certificates với ON CONFLICT để đảm bảo an toàn khi có nhiều request đồng thời.
  const issued = await one<{ code: string }>(
    sql,
    `insert into class_certificates (enrollment_id, code, attended, sessions)
     values ($1, $2, $3, $4)
     on conflict (enrollment_id) do update set enrollment_id = excluded.enrollment_id
     returning code`,
    [enrollmentId, certCode(), row.attended, row.sessions],
  );
  // Bước 5: Ghi nhật ký kiểm toán (audit log) ghi nhận mã chứng chỉ được cấp cho hội viên và trả về kết quả.
  await audit(sql, user.id, "issue_certificate", "enrollment", enrollmentId, null, { code: issued?.code });
  return { status: 201, body: { code: issued?.code } };
}

/** Anyone holding the code can check the certificate: who, which class, when. */
/**
 * Làm gì: Xác thực mã chứng chỉ công khai: cho phép bất kỳ ai có mã tra cứu thông tin chứng nhận (tên hội viên, lớp học, môn thể thao, HLV, số buổi tham dự và ngày cấp).
 * Được gọi ở:
 *   - src/server/controllers/router.ts qua route GET /api/certificates/:code (hoặc /v1/certificates/:code, không cần đăng nhập).
 *   - Trang xác minh chứng chỉ công khai /verify/:code (src/routes/verify.$code.tsx).
 * @param sql Kết nối cơ sở dữ liệu để tra cứu thông tin chứng nhận.
 * @param code Mã chứng nhận cần xác thực do người dùng cung cấp từ URL.
 * @returns Phản hồi HTTP 200 kèm thông tin chi tiết của chứng nhận (code, attended, sessions, issued_at, member_name, sport, level, coach_name...).
 * @throws Lỗi 404 nếu mã chứng nhận sai định dạng (không phải 6-24 ký tự chữ số) hoặc không tìm thấy trong hệ thống.
 */
export async function certificateVerify(sql: Sql, code: string) {
  // Bước 1: Chuẩn hóa mã code (cắt khoảng trắng, chuyển chữ in hoa) và kiểm tra định dạng an toàn (6-24 ký tự A-Z, 0-9).
  const clean = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,24}$/.test(clean)) throw err.notFound("No certificate has that code.");
  // Bước 2: Truy vấn thông tin chứng chỉ từ bảng class_certificates liên kết với enrollments, classes và users.
  const row = await one(
    sql,
    `select cc.code, cc.attended, cc.sessions, cc.issued_at, m.full_name as member_name,
            cl.sport::text as sport, cl.level, cl.start_on::text, cl.end_on::text, co.full_name as coach_name
       from class_certificates cc
       join enrollments e on e.id = cc.enrollment_id
       join users m on m.id = e.user_id
       join classes cl on cl.id = e.class_id
       join users co on co.id = cl.coach_id
      where cc.code = $1`,
    [clean],
  );
  // Bước 3: Ném lỗi 404 nếu mã không tồn tại, ngược lại trả về đầy đủ thông tin chứng nhận để hiển thị công khai.
  if (!row) throw err.notFound("No certificate has that code.");
  return { status: 200, body: row };
}
