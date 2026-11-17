/**
 * Quản lý tài khoản nhân viên hệ thống (Manager, Receptionist, Coach).
 * Cung cấp các API nghiệp vụ để Manager tạo nhân viên, cấp mật khẩu tạm,
 * cập nhật trạng thái/vai trò, gán môn thể thao cho HLV, và thu hồi phiên đăng nhập.
 * Mọi thay đổi đều được ghi lại vào nhật ký kiểm toán (audit log) để đối soát.
 */
import { randomInt } from "node:crypto";
import type { Sql } from "@/server/data/db";
import { hashPassword } from "../../services/crypto";
import { err } from "../errors";
import { audit, pageOf, readJson, str } from "../helpers";
import { isValidVnPhone, normalizePhone, unaccentVi } from "../../services/phone";
import { avatarUrlSql, requireRole, withAvatarUrl, type PublicUser } from "../session";
import { one, q } from "../tx";
import { pageParams } from "../validate";
import { getActiveSportCodes } from "./sports";

/**
 * Staff accounts (R-01…R-03).
 *
 * There is no system-admin role: the manager is the one who hands out the
 * manager, receptionist and coach logins, and the only way a staff account comes to
 * exist. Registration is member-only (`auth.register` hard-codes the role), so
 * nothing on a public page can produce one.
 *
 * Every change is written to the audit log with the manager as actor, which is
 * how "who issued this account, and when" is answered.
 */

const MANAGED_ROLES = ["receptionist", "coach", "manager"] as const;
type ManagedRole = (typeof MANAGED_ROLES)[number];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A temporary password: letters and digits, no look-alikes, never reused. */
/**
 * Làm gì: Tạo mật khẩu tạm thời ngẫu nhiên gồm các chữ cái và chữ số dễ phân biệt (không chứa ký tự dễ nhầm lẫn như 0, O, 1, I, l).
 * Được gọi ở:
 * - src/server/controllers/handlers/staff.ts (trong staffCreate và staffResetPassword)
 * - src/server/controllers/handlers/members.ts (trong membersResetPassword)
 * @returns Chuỗi mật khẩu tạm gồm 12 ký tự ngẫu nhiên theo định dạng xxxx-xxxxxxxx.
 */
export function tempPassword(): string {
  // Bỏ qua các ký tự dễ gây nhầm lẫn thị giác (chữ O, số 0, chữ I hoa, chữ l thường, số 1).
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const pick = (set: string, n: number) =>
    Array.from({ length: n }, () => set[randomInt(set.length)]).join("");
  return `${pick(letters, 4)}-${pick(digits, 3)}${pick(letters, 3)}${pick(digits, 2)}`;
}

/**
 * Làm gì: Xác thực và ép kiểu giá trị đầu vào về vai trò nhân viên hợp lệ (manager, receptionist, coach).
 * Được gọi ở: src/server/controllers/handlers/staff.ts (trong staffCreate và staffPatch).
 * @param v Giá trị vai trò nhận từ request body cần kiểm tra.
 * @param field Tên trường dữ liệu để gắn vào thông báo lỗi nếu không hợp lệ (mặc định là "role").
 * @returns Vai trò nhân viên hợp lệ thuộc kiểu ManagedRole.
 * @throws Lỗi validation (400) nếu giá trị không thuộc danh sách MANAGED_ROLES.
 */
function managedRole(v: unknown, field = "role"): ManagedRole {
  if (!MANAGED_ROLES.includes(v as ManagedRole)) {
    throw err.field(field, "Choose manager, receptionist or coach.");
  }
  return v as ManagedRole;
}

/**
 * Làm gì: Xác thực danh sách môn thể thao của huấn luyện viên, bảo đảm các mã môn đều đang hoạt động và loại bỏ phần tử trùng lặp.
 * Được gọi ở: src/server/controllers/handlers/staff.ts (trong staffCreate và updateStaffRole).
 * @param sql Kết nối database để truy vấn danh sách môn thể thao hợp lệ.
 * @param v Dữ liệu danh sách môn thể thao nhận từ request body.
 * @returns Mảng danh sách mã môn thể thao duy nhất và hợp lệ.
 * @throws Lỗi validation (400) nếu môn thể thao không tồn tại hoặc không còn hoạt động trong hệ thống.
 */
async function sportList(sql: Sql, v: unknown): Promise<string[]> {
  const list = Array.isArray(v) ? v.map(String) : [];
  // Chỉ chấp nhận các môn thể thao đang ở trạng thái kích hoạt (active = true).
  const valid = await getActiveSportCodes(sql, true);
  const bad = list.find((s) => !valid.includes(s));
  if (bad) throw err.field("sports", `${bad} is not a sport we run.`);
  return [...new Set(list)];
}

type StaffRow = {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  role: string;
  status: string;
  must_change_password: boolean;
  avatar_url: string | null;
  created_at: string;
  sports: string[] | null;
  open_sessions: number;
  issued_by: string | null;
  issued_at: string | null;
};

// Câu lệnh SQL chuẩn lấy thông tin nhân viên kèm môn dạy, số phiên đang mở và người tạo từ audit_logs.
const STAFF_SELECT = `
  select u.id, u.full_name, u.phone, u.email, u.role, u.status, u.must_change_password,
         ${avatarUrlSql("u")},
         u.created_at::text,
         (select array_agg(cs.sport::text order by cs.sport) from coach_sports cs where cs.user_id = u.id) as sports,
         (select count(*)::int from sessions_auth sa where sa.user_id = u.id and sa.expires_at > now()) as open_sessions,
         (select a.name from (
            select coalesce(m.full_name, 'System') as name
              from audit_logs al left join users m on m.id = al.actor_id
             where al.entity = 'user' and al.entity_id = u.id and al.action = 'create_staff'
             order by al.at desc limit 1) a) as issued_by,
         (select al.at::text from audit_logs al
           where al.entity = 'user' and al.entity_id = u.id and al.action = 'create_staff'
           order by al.at desc limit 1) as issued_at
    from users u`;

/**
 * Làm gì: Tải thông tin chi tiết một tài khoản nhân viên từ database theo ID, kèm theo URL ảnh đại diện đã chuẩn hóa.
 * Được gọi ở: src/server/controllers/handlers/staff.ts (trong managedTarget, staffCreate, staffPatch, staffResetPassword, staffRevokeSessions).
 * @param sql Kết nối database để thực hiện truy vấn.
 * @param id Mã định danh (UUID) của nhân viên cần tải thông tin.
 * @returns Bản ghi StaffRow chứa thông tin nhân viên kèm avatar_url.
 * @throws Lỗi not found (404) nếu tài khoản không tồn tại.
 */
async function loadStaff(sql: Sql, id: string): Promise<StaffRow> {
  const row = await one<StaffRow>(sql, `${STAFF_SELECT} where u.id = $1`, [id]);
  if (!row) throw err.notFound("That account does not exist.");
  return withAvatarUrl(row);
}

/** Managers can manage staff accounts, never their own account. */
/**
 * Làm gì: Kiểm tra và tải thông tin nhân viên mục tiêu, bảo đảm Manager không tự chỉnh sửa tài khoản của chính mình và chỉ thao tác trên các vai trò nhân viên.
 * Được gọi ở: src/server/controllers/handlers/staff.ts (trong staffPatch, staffResetPassword, staffRevokeSessions).
 * @param sql Kết nối database để thực hiện truy vấn.
 * @param id Mã định danh của nhân viên mục tiêu.
 * @param manager Thông tin người dùng Manager đang thực hiện yêu cầu.
 * @returns Thông tin tài khoản nhân viên mục tiêu (StaffRow).
 * @throws Lỗi forbidden (403) nếu Manager tự sửa tài khoản của chính mình hoặc tài khoản không phải vai trò nhân viên.
 * @throws Lỗi not found (404) nếu tài khoản không tồn tại.
 */
async function managedTarget(sql: Sql, id: string, manager: PublicUser): Promise<StaffRow> {
  const row = await loadStaff(sql, id);
  // Manager không được tự thao tác trên tài khoản của chính mình để tránh vô tình tự khóa hoặc hạ quyền.
  if (row.id === manager.id) throw err.forbidden("You cannot change your own account here.");
  if (!MANAGED_ROLES.includes(row.role as ManagedRole)) {
    throw err.forbidden("Only manager, receptionist and coach accounts are managed from this screen.");
  }
  return row;
}

/**
 * Làm gì: Thu hồi toàn bộ các phiên đăng nhập đang hoạt động của người dùng bằng cách gán revoked_at = now().
 * Được gọi ở:
 * - src/server/controllers/handlers/staff.ts (trong staffResetPassword, staffRevokeSessions, updateStaffStatus, updateStaffRole)
 * - src/server/controllers/handlers/members.ts (trong membersResetPassword)
 * - src/server/controllers/tx.test.ts
 * @param sql Kết nối database để cập nhật bảng sessions_auth.
 * @param userId Mã định danh của người dùng cần thu hồi phiên đăng nhập.
 * @returns Số lượng phiên đăng nhập đã bị thu hồi.
 */
export async function revoke(sql: Sql, userId: string): Promise<number> {
  // Đánh dấu revoked_at = now() cho tất cả session chưa bị thu hồi của user để vô hiệu hóa token ngay lập tức.
  const gone = await q<{ id: string }>(sql, `update sessions_auth set revoked_at = now() where user_id = $1 and revoked_at is null returning id`, [userId]);
  return gone.length;
}

/**
 * Làm gì: Lấy danh sách tài khoản nhân viên có phân trang, lọc theo vai trò, trạng thái hoặc tìm kiếm họ tên, số điện thoại, email.
 * Được gọi ở: Route GET /api/staff (hoặc GET /v1/staff) qua file src/server/controllers/router.ts.
 * @param sql Kết nối database để thực hiện truy vấn.
 * @param request Request từ client chứa URL query params (role, status, q, limit, offset).
 * @param user Thông tin người dùng hiện tại (yêu cầu vai trò manager).
 * @returns Đối tượng HTTP status 200 kèm body chứa danh sách nhân viên và metadata phân trang.
 * @throws Lỗi forbidden (403) nếu người dùng không phải manager.
 * @throws Lỗi validation (400) nếu tham số role hoặc status không hợp lệ.
 */
export async function staffList(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn - chỉ Manager mới được phép xem danh sách nhân viên.
  requireRole(user, ["manager"]);
  // Bước 2: Đọc và xác thực các bộ lọc từ query parameters (role, status, từ khóa tìm kiếm q).
  const url = new URL(request.url);
  const role = url.searchParams.get("role");
  const status = url.searchParams.get("status");
  const text = (url.searchParams.get("q") ?? "").trim();
  const params: unknown[] = [];
  // Giới hạn phạm vi chỉ trong các vai trò nhân viên, không lẫn tài khoản hội viên (member).
  const where: string[] = [`u.role in ('receptionist','coach','manager')`];
  if (role) {
    if (!["receptionist", "coach", "manager"].includes(role)) throw err.field("role", "Unknown role.");
    params.push(role);
    where.push(`u.role = $${params.length}::user_role`);
  }
  if (status) {
    if (!["active", "locked", "disabled"].includes(status)) throw err.field("status", "Unknown status.");
    params.push(status);
    where.push(`u.status = $${params.length}::user_status`);
  }
  if (text) {
    // Tìm kiếm theo tên không dấu (name_normalized) hoặc số điện thoại, email.
    params.push(`%${unaccentVi(text)}%`, `%${text}%`);
    where.push(`(u.name_normalized ilike $${params.length - 1} or u.phone ilike $${params.length} or u.email ilike $${params.length})`);
  }
  // Bước 3: Đọc tham số phân trang với giới hạn tối đa 200 bản ghi mỗi trang.
  const { limit, offset } = pageParams(request, { def: 200, max: 200 });
  const filter = where.join(" and ");
  // Bước 4: Thực thi truy vấn lấy danh sách nhân viên kèm window function count(*) over() để tính tổng số dòng.
  const rows = await q<StaffRow & { total: number }>(
    sql,
    `${STAFF_SELECT.replace(/^\s*select /, "select count(*) over ()::int as total, ")} where ${filter}
      order by u.role, u.full_name limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, limit, offset],
  );
  // Bước 5: Chuẩn hóa URL ảnh đại diện và đóng gói dữ liệu phân trang trả về cho client.
  const body = await pageOf(rows.map(withAvatarUrl), { limit, offset }, async () =>
    Number((await q<{ n: number }>(sql, `select count(*)::int as n from users u where ${filter}`, params))[0]?.n ?? 0),
  );
  return { status: 200, body };
}

/**
 * Làm gì: Tạo tài khoản nhân viên mới (manager, receptionist, coach), sinh mật khẩu tạm, gắn môn dạy cho HLV và ghi audit log.
 * Được gọi ở: Route POST /api/staff (hoặc POST /v1/staff) qua file src/server/controllers/router.ts.
 * @param sql Kết nối database để thực thi các câu lệnh chèn dữ liệu.
 * @param request Request từ client chứa body JSON (full_name, phone, email, role, sports).
 * @param user Thông tin người dùng hiện tại (yêu cầu vai trò manager).
 * @returns Đối tượng HTTP status 201 kèm thông tin nhân viên vừa tạo và mật khẩu tạm temp_password.
 * @throws Lỗi forbidden (403) nếu người dùng không phải manager.
 * @throws Lỗi validation (400) nếu thiếu họ tên, SĐT/email không hợp lệ hoặc HLV không có môn thể thao.
 * @throws Lỗi conflict BR-01 (409) nếu số điện thoại hoặc email đã được sử dụng.
 */
export async function staffCreate(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn - chỉ Manager mới có quyền tạo tài khoản nhân viên mới.
  requireRole(user, ["manager"]);
  // Bước 2: Đọc và xác thực thông tin đầu vào (họ tên, số điện thoại, email, vai trò).
  const body = await readJson(request);
  const full_name = str(body.full_name);
  const phone = normalizePhone(str(body.phone) ?? "");
  const email = str(body.email) ?? null;
  const role = managedRole(body.role);
  if (!full_name) throw err.field("full_name", "Full name is required.");
  if (!isValidVnPhone(phone)) throw err.field("phone", "That phone number is not valid.");
  if (email && !EMAIL_RE.test(email)) throw err.field("email", "That email address is not valid.");
  // Huấn luyện viên bắt buộc phải phụ trách ít nhất một môn thể thao hợp lệ đang hoạt động.
  const sports = role === "coach" ? await sportList(sql, body.sports) : [];
  if (role === "coach" && !sports.length) {
    throw err.field("sports", "Pick at least one sport this coach can teach.");
  }
  // Bước 3: Kiểm tra quy tắc nghiệp vụ BR-01 - số điện thoại hoặc email không được trùng với tài khoản đã có.
  const dup = await one(sql, `select 1 from users where phone = $1 or ($2::text is not null and email = $2)`, [
    phone,
    email,
  ]);
  if (dup) throw err.br("BR-01", "That phone or email already has an account.", { field: "phone" });

  // Bước 4: Sinh mật khẩu tạm và tạo tài khoản mới ở trạng thái active (bắt buộc đổi mật khẩu ở lần đầu đăng nhập).
  const tmp = tempPassword();
  const row = await one<{ id: string }>(
    sql,
    `insert into users (full_name, name_normalized, phone, email, role, status, password_hash, must_change_password)
     values ($1,$2,$3,$4,$5::user_role,'active',$6,true) returning id`,
    [full_name, unaccentVi(full_name), phone, email, role, hashPassword(tmp)],
  );
  // Bước 5: Lưu danh sách môn thể thao phụ trách của HLV vào bảng coach_sports.
  for (const s of sports) {
    await sql.query(`insert into coach_sports (user_id, sport) values ($1, $2)`, [row!.id, s]);
  }
  // Tạo sẵn vị trí ảnh đại diện HLV trong bảng site_assets để sẵn sàng hiển thị trên web.
  if (role === "coach") {
    await ensureCoachAsset(sql, row!.id, full_name);
  }
  // Bước 6: Ghi nhật ký kiểm toán (audit log) ghi nhận Manager nào đã cấp tài khoản này và vào thời điểm nào.
  await audit(sql, user.id, "create_staff", "user", row!.id, null, { role, phone, sports });
  // Bước 7: Trả về HTTP 201 cùng dữ liệu nhân viên mới và mật khẩu tạm để Manager gửi cho nhân viên.
  return { status: 201, body: { staff: await loadStaff(sql, row!.id), temp_password: tmp } };
}

/**
 * Làm gì: Cập nhật trạng thái (active/locked), vai trò hoặc môn dạy của nhân viên; bảo đảm luôn còn ít nhất một manager hoạt động.
 * Được gọi ở: Route PATCH /api/staff/:id (hoặc PATCH /v1/staff/:id) qua file src/server/controllers/router.ts.
 * @param sql Kết nối database trong giao dịch.
 * @param id Mã định danh của nhân viên cần cập nhật.
 * @param request Request từ client chứa body JSON (status, role, sports).
 * @param user Thông tin người dùng hiện tại (yêu cầu vai trò manager).
 * @returns Đối tượng HTTP status 200 kèm thông tin nhân viên sau khi cập nhật.
 * @throws Lỗi forbidden (403) nếu không phải manager hoặc tự cập nhật tài khoản của chính mình.
 * @throws Lỗi not found (404) nếu không tìm thấy nhân viên.
 * @throws Lỗi validation (400) nếu không có trường nào cần cập nhật.
 * @throws Lỗi conflictState (409) nếu thao tác làm mất tài khoản manager hoạt động cuối cùng.
 */
export async function staffPatch(sql: Sql, id: string, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn Manager.
  requireRole(user, ["manager"]);
  // Serialize role/status changes across different targets, not just one user.
  // The transaction holds this lock through the count, update and audit.
  // Dùng khóa advisory cấp transaction để tránh race condition khi nhiều Manager cùng cập nhật vai trò/trạng thái đồng thời.
  await sql.query(`select pg_advisory_xact_lock(hashtext('arena3:staff-manager-count'))`);
  // Bước 2: Xác thực nhân viên mục tiêu (không được tự sửa tài khoản của chính mình).
  const target = await managedTarget(sql, id, user);
  // Bước 3: Đọc dữ liệu cập nhật từ request body và chụp lại trạng thái trước khi thay đổi.
  const body = await readJson(request);
  const nextStatus = str(body.status);
  const nextRole = body.role === undefined ? null : managedRole(body.role);
  if (!nextStatus && !nextRole && body.sports === undefined) {
    throw err.field("status", "Nothing to change.");
  }
  const before = { role: target.role, status: target.status, sports: target.sports ?? [] };

  // Bước 4: Bảo đảm an toàn hệ thống - không cho phép khóa hoặc hạ quyền tài khoản Manager hoạt động cuối cùng.
  if (target.role === "manager" && target.status === "active" &&
      ((nextRole !== null && nextRole !== "manager") || (!!nextStatus && nextStatus !== "active"))) {
    const remaining = await one<{ n: number }>(sql,
      `select count(*)::int as n from users where role = 'manager' and status = 'active' and id <> $1`, [id]);
    if (!remaining?.n) throw err.conflictState("At least one active manager must remain.");
  }

  // Bước 5: Cập nhật trạng thái (active/locked) nếu có yêu cầu.
  if (nextStatus) await updateStaffStatus(sql, id, user, target, before, nextStatus);
  // Bước 6: Cập nhật vai trò hoặc môn dạy phụ trách nếu có thay đổi.
  if (nextRole || body.sports !== undefined) {
    await updateStaffRole(sql, id, user, target, before, nextRole, body);
  }
  // Bước 7: Trả về thông tin chi tiết nhân viên sau khi cập nhật thành công.
  return { status: 200, body: { staff: await loadStaff(sql, id) } };
}

/**
 * Làm gì: Đặt lại mật khẩu nhân viên thành mật khẩu tạm thời ngẫu nhiên, mở khóa tài khoản, thu hồi toàn bộ session cũ và ghi audit log.
 * Được gọi ở: Route POST /api/staff/:id/reset-password qua file src/server/controllers/router.ts.
 * @param sql Kết nối database để cập nhật mật khẩu và bảng liên quan.
 * @param id Mã định danh của nhân viên cần đặt lại mật khẩu.
 * @param user Thông tin người dùng hiện tại (yêu cầu vai trò manager).
 * @returns Đối tượng HTTP status 200 kèm thông tin nhân viên và mật khẩu tạm temp_password.
 * @throws Lỗi forbidden (403) nếu không phải manager hoặc tự đặt lại mật khẩu cho chính mình.
 * @throws Lỗi not found (404) nếu không tìm thấy nhân viên.
 */
export async function staffResetPassword(sql: Sql, id: string, user: PublicUser) {
  // Bước 1: Kiểm tra quyền Manager và xác thực tài khoản nhân viên mục tiêu.
  requireRole(user, ["manager"]);
  await managedTarget(sql, id, user);
  // Bước 2: Sinh mật khẩu tạm mới ngẫu nhiên.
  const tmp = tempPassword();
  // Bước 3: Cập nhật hash mật khẩu mới, bật cờ bắt buộc đổi mật khẩu và mở khóa tài khoản (reset số lần đăng nhập sai).
  await sql.query(
    `update users set password_hash = $1, must_change_password = true, failed_logins = 0, locked_until = null
      where id = $2`,
    [hashPassword(tmp), id],
  );
  // Bước 4: Thu hồi toàn bộ phiên đăng nhập cũ để buộc người dùng phải đăng nhập lại với mật khẩu mới.
  const revoked = await revoke(sql, id);
  // Bước 5: Ghi nhật ký kiểm toán và trả về thông tin nhân viên kèm mật khẩu tạm.
  await audit(sql, user.id, "reset_staff_password", "user", id, null, { sessions_revoked: revoked });
  return { status: 200, body: { staff: await loadStaff(sql, id), temp_password: tmp } };
}

/**
 * Làm gì: Đăng xuất cưỡng chế nhân viên bằng cách thu hồi toàn bộ các phiên làm việc đang hoạt động và ghi audit log.
 * Được gọi ở: Route POST /api/staff/:id/revoke-sessions qua file src/server/controllers/router.ts.
 * @param sql Kết nối database để cập nhật bảng sessions_auth.
 * @param id Mã định danh của nhân viên cần thu hồi phiên làm việc.
 * @param user Thông tin người dùng hiện tại (yêu cầu vai trò manager).
 * @returns Đối tượng HTTP status 200 kèm số phiên bị thu hồi và thông tin nhân viên.
 * @throws Lỗi forbidden (403) nếu không phải manager hoặc tự thu hồi phiên của chính mình từ API này.
 * @throws Lỗi not found (404) nếu không tìm thấy nhân viên.
 */
export async function staffRevokeSessions(sql: Sql, id: string, user: PublicUser) {
  // Bước 1: Kiểm tra quyền Manager và xác thực tài khoản nhân viên mục tiêu.
  requireRole(user, ["manager"]);
  await managedTarget(sql, id, user);
  // Bước 2: Thu hồi toàn bộ phiên đăng nhập đang hoạt động trong bảng sessions_auth.
  const revoked = await revoke(sql, id);
  // Bước 3: Ghi nhật ký kiểm toán hành động thu hồi phiên và trả về số lượng phiên đã thu hồi.
  await audit(sql, user.id, "revoke_staff_sessions", "user", id, null, { sessions_revoked: revoked });
  return { status: 200, body: { revoked, staff: await loadStaff(sql, id) } };
}

/**
 * Làm gì: Cập nhật trạng thái nhân viên (active hoặc locked); nếu khóa thì thu hồi ngay lập tức mọi phiên làm việc và ghi audit log.
 * Được gọi ở: src/server/controllers/handlers/staff.ts (trong staffPatch).
 * @param sql Kết nối database để cập nhật bảng users.
 * @param id Mã định danh của nhân viên cần đổi trạng thái.
 * @param user Thông tin người dùng manager thực hiện thao tác.
 * @param target Thông tin nhân viên hiện tại trước khi đổi.
 * @param before Snapshot dữ liệu trước thay đổi phục vụ audit log.
 * @param nextStatus Trạng thái mới ("active" hoặc "locked").
 * @throws Lỗi validation (400) nếu trạng thái không phải active hoặc locked.
 */
async function updateStaffStatus(sql: Sql, id: string, user: PublicUser, target: StaffRow, before: { role: string; status: string; sports: string[] }, nextStatus: string) {
  // Bước 1: Kiểm tra tính hợp lệ của trạng thái mới (chỉ chấp nhận active hoặc locked).
  if (!["active", "locked"].includes(nextStatus)) throw err.field("status", "Use active or locked.");
  // Bước 2: Cập nhật trạng thái và mở khóa các giới hạn đăng nhập sai nếu có.
  if (nextStatus !== target.status) {
    await sql.query(
      `update users set status = $1::user_status, failed_logins = 0, locked_until = null where id = $2`,
      [nextStatus, id],
    );
    // A locked account must stop working now, not when its token expires.
    // Tài khoản bị khóa phải dừng hoạt động ngay lập tức thay vì đợi token hết hạn.
    if (nextStatus === "locked") await revoke(sql, id);
    // Bước 3: Ghi nhật ký kiểm toán với hành vi tương ứng (lock_staff hoặc unlock_staff).
    await audit(sql, user.id, nextStatus === "locked" ? "lock_staff" : "unlock_staff", "user", id, before, {
      status: nextStatus,
    });
  }
}

/**
 * Làm gì: Cập nhật vai trò nhân viên và môn thể thao phụ trách; kiểm tra HLV không còn lớp học đang mở, thu hồi session cũ và ghi audit log.
 * Được gọi ở: src/server/controllers/handlers/staff.ts (trong staffPatch).
 * @param sql Kết nối database để cập nhật bảng users và coach_sports.
 * @param id Mã định danh của nhân viên cần đổi vai trò.
 * @param user Thông tin người dùng manager thực hiện thao tác.
 * @param target Thông tin nhân viên hiện tại trước khi đổi.
 * @param before Snapshot dữ liệu trước thay đổi phục vụ audit log.
 * @param nextRole Vai trò mới cần cập nhật, hoặc null nếu giữ nguyên vai trò hiện tại.
 * @param body Request body chứa danh sách môn thể thao sports nếu cập nhật môn dạy.
 * @throws Lỗi validation (400) nếu vai trò là coach nhưng không chọn môn thể thao nào.
 * @throws Lỗi conflictState (409) nếu HLV vẫn còn lớp học đang mở hoặc bản nháp.
 */
async function updateStaffRole(sql: Sql, id: string, user: PublicUser, target: StaffRow, before: { role: string; status: string; sports: string[] }, nextRole: ManagedRole | null, body: Record<string, unknown>) {
  // Bước 1: Xác định vai trò mới và xác thực danh sách môn thể thao nếu vai trò là HLV.
  const role = nextRole ?? (target.role as ManagedRole);
  const sports = role === "coach" ? await sportList(sql, body.sports ?? target.sports ?? []) : [];
  if (role === "coach" && !sports.length) {
    throw err.field("sports", "Pick at least one sport this coach can teach.");
  }
  // Bước 2: Kiểm tra ràng buộc khi hủy vai trò HLV - ngăn chặn nếu HLV vẫn còn lớp học đang mở hoặc bản nháp.
  if (role !== "coach" && target.role === "coach") {
    const classes = await one<{ n: number }>(
      sql,
      `select count(*)::int as n from classes
        where (coach_id = $1 or assistant_id = $1) and status in ('draft','open')`,
      [id],
    );
    if ((classes?.n ?? 0) > 0) {
      throw err.conflictState("This coach still has classes running. Reassign them before changing the role.");
    }
  }
  // Bước 3: Cập nhật vai trò mới trong bảng users và thu hồi phiên làm việc cũ (vì quyền hạn gắn liền với session khi đăng nhập).
  if (role !== target.role) {
    await sql.query(`update users set role = $1::user_role where id = $2`, [role, id]);
    // The permissions behind an open session were decided at sign-in.
    await revoke(sql, id);
  // Bước 4: Đồng bộ danh sách môn thể thao phụ trách trong coach_sports và bảo đảm slot ảnh HLV.
  }
  if (role === "coach") {
    await sql.query(`delete from coach_sports where user_id = $1`, [id]);
    for (const s of sports) {
      await sql.query(`insert into coach_sports (user_id, sport) values ($1, $2)`, [id, s]);
    }
    await ensureCoachAsset(sql, id, target.full_name);
  } else {
    await sql.query(`delete from coach_sports where user_id = $1`, [id]);
  }
  // Bước 5: Ghi nhật ký kiểm toán ghi nhận thay đổi vai trò hoặc môn thể thao.
  if (role !== target.role || body.sports !== undefined) {
    await audit(sql, user.id, "change_staff_role", "user", id, before, { role, sports });
  }
}

/**
 * Làm gì: Khởi tạo sẵn một vị trí lưu ảnh đại diện (slot coach.<id>) trong bảng site_assets cho HLV nếu chưa tồn tại.
 * Được gọi ở: src/server/controllers/handlers/staff.ts (trong staffCreate và updateStaffRole).
 * @param sql Kết nối database để chèn bản ghi vào site_assets.
 * @param id Mã định danh của huấn luyện viên.
 * @param full_name Họ tên đầy đủ của huấn luyện viên để sinh thẻ mô tả ảnh (alt text) song ngữ.
 */
async function ensureCoachAsset(sql: Sql, id: string, full_name: string) {
  // Khởi tạo slot ảnh 'coach.<id>' với version = 1; dùng ON CONFLICT DO NOTHING để không ghi đè nếu slot đã tồn tại.
  await sql.query(
    `insert into site_assets (slot, kind, alt_en, alt_vi, enabled, version)
     values ($1, 'image', $2, $3, true, 1)
     on conflict (slot) do nothing`,
    [
      `coach.${id}`,
      `Photo of coach ${full_name}`,
      `Ảnh HLV ${full_name}`,
    ],
  );
}
