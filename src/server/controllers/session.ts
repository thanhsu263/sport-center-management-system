/**
 * File: src/server/controllers/session.ts
 * Vai trò: Quản lý phiên đăng nhập (session), xác thực người dùng (authentication) và phân quyền (authorization/RBAC).
 * Vị trí trong app: Đóng vai trò lớp bảo vệ trung tâm trong backend: cấp phát session token, trích xuất và kiểm tra token từ request header, chuẩn hóa đối tượng PublicUser và kiểm tra quyền hạn của người dùng trước khi thực thi nghiệp vụ.
 */
import type { Sql } from "@/server/data/db";
import { hashPassword, randomToken, sha256, verifyPassword } from "../services/crypto";
import type { PublicUser, Role } from "../../shared/arena3/contracts";
import { err } from "./errors";
import { one, q } from "./tx";

export type { PublicUser, Role } from "../../shared/arena3/contracts";

export type AuthUser = PublicUser & { password_hash: string };

/**
 * Làm gì: Tạo biểu thức SQL subquery để lấy số version ảnh đại diện (avatar_version) của user từ bảng user_avatars.
 * Được gọi ở: src/server/controllers/session.ts (hằng PUBLIC_COLS), src/server/controllers/handlers/checkin.ts, classes.ts, members.ts, ops.ts, staff.ts.
 * @param alias Tên alias của bảng user trong câu truy vấn SQL (mặc định là "users")
 * @returns Chuỗi SQL subquery để select cột avatar_version
 */
export function avatarUrlSql(alias = "users"): string {
  return `(select version from user_avatars a where a.user_id = ${alias}.id) as avatar_version`;
}

/**
 * Làm gì: Gắn thêm thuộc tính avatar_url vào đối tượng dữ liệu dựa trên avatar_version để client tự động bust cache ảnh mới.
 * Được gọi ở: Các handler trả về danh sách người dùng trong src/server/controllers/handlers/ (checkin.ts, classes.ts, members.ts, ops.ts, staff.ts).
 * @param row Bản ghi dữ liệu người dùng chứa id và avatar_version
 * @returns Bản ghi người dùng kèm trường avatar_url (chuỗi URL hoặc null)
 */
export function withAvatarUrl<T extends Record<string, any>>(
  row: T,
): T & { avatar_url: string | null } {
  // Lấy phiên bản avatar và tạo URL có tham số query ?v= để trình duyệt tự động cập nhật ảnh mới (cache busting)
  const v = row.avatar_version;
  const avatar_url = v != null && row.id != null ? `/v1/users/${row.id}/avatar?v=${v}` : null;
  return { ...row, avatar_url };
}

/**
 * Làm gì: Danh sách các cột an toàn được phép công khai khi truy vấn bảng users, loại trừ password_hash và kèm avatar_version.
 * Được gọi ở: src/server/controllers/session.ts (hàm loadUser, findUserByLogin), src/server/controllers/handlers/google.ts, members.ts.
 */
export const PUBLIC_COLS =
  `id, member_code, full_name, phone, email, role, status, date_of_birth, health_notes, must_change_password, ${avatarUrlSql("users")}`;

/**
 * Làm gì: Chuẩn hóa dữ liệu thô từ database thành đối tượng PublicUser an toàn, định dạng lại ngày sinh và đường dẫn avatar_url.
 * Được gọi ở: src/server/controllers/session.ts (hàm loadUser, authFromRequest), src/server/controllers/handlers/auth.ts, google.ts, members.ts, test runner (node --test trong src/server/controllers/tx.test.ts).
 * @param u Bản ghi người dùng thô lấy từ câu truy vấn database
 * @returns Đối tượng PublicUser chứa thông tin hồ sơ an toàn
 */
export function toPublic(u: Record<string, unknown>): PublicUser {
  return {
    id: String(u.id),
    member_code: (u.member_code as string | null) ?? null,
    full_name: String(u.full_name),
    phone: String(u.phone),
    email: (u.email as string | null) ?? null,
    role: u.role as Role,
    status: String(u.status),
    date_of_birth: u.date_of_birth ? String(u.date_of_birth).slice(0, 10) : null,
    health_notes: (u.health_notes as string | null) ?? null,
    must_change_password: Boolean(u.must_change_password),
    avatar_url: u.avatar_version != null ? `/v1/users/${u.id}/avatar?v=${u.avatar_version}` : null,
  };
}

/**
 * Làm gì: Tải thông tin người dùng từ database theo id và chuẩn hóa thành đối tượng PublicUser.
 * Được gọi ở: src/server/controllers/handlers/auth.ts (hàm getMe), src/server/controllers/handlers/avatar.ts (hàm updateAvatar).
 * @param sql Client kết nối cơ sở dữ liệu Postgres
 * @param id Mã định danh UUID của người dùng cần tải
 * @returns Thông tin công khai của người dùng dưới dạng PublicUser
 * @throws {HttpError} Lỗi 404 Not Found khi không tìm thấy người dùng trong database
 */
export async function loadUser(sql: Sql, id: string): Promise<PublicUser> {
  // Bước 1: Truy vấn người dùng theo id với danh sách cột an toàn PUBLIC_COLS
  const u = await one<Record<string, unknown>>(
    sql,
    `select ${PUBLIC_COLS} from users where id = $1`,
    [id],
  );
  // Bước 2: Ném lỗi 404 nếu không tìm thấy người dùng trong cơ sở dữ liệu
  if (!u) throw err.notFound();
  // Bước 3: Chuẩn hóa dữ liệu thô sang đối tượng PublicUser
  return toPublic(u);
}

import { limit, RULES } from "./ratelimit";

/**
 * Làm gì: Tìm tài khoản người dùng theo số điện thoại hoặc email (không phân biệt hoa thường) để phục vụ đăng nhập.
 * Được gọi ở: src/server/controllers/handlers/auth.ts (hàm login), test runner (node --test trong src/server/controllers/tx.test.ts).
 * @param sql Client kết nối cơ sở dữ liệu Postgres
 * @param login Số điện thoại hoặc email do người dùng nhập vào
 * @returns Bản ghi AuthUser chứa thông tin công khai kèm password_hash, hoặc null nếu không tìm thấy
 */
export async function findUserByLogin(sql: Sql, login: string) {
  // Bước 1: Cắt khoảng trắng thừa ở hai đầu thông tin đăng nhập
  const clean = login.trim();
  // Bước 2: Tìm user theo số điện thoại hoặc email (so sánh không phân biệt hoa thường) kèm password_hash để xác thực
  return one<AuthUser>(
    sql,
    `select ${PUBLIC_COLS}, password_hash from users
     where phone = $1 or (email is not null and lower(email) = lower($1)) limit 1`,
    [clean],
  );
}

/**
 * Làm gì: Cấp phiên đăng nhập mới: tạo ngẫu nhiên token, lưu mã băm sha256 vào database và trả về token rõ cùng thời hạn hết hạn.
 * Được gọi ở: src/server/controllers/handlers/auth.ts (hàm login, changePassword), src/server/controllers/handlers/google.ts (Google OAuth), test runner (node --test trong src/server/controllers/tx.test.ts).
 * @param sql Client kết nối cơ sở dữ liệu Postgres
 * @param user Thông tin người dùng được cấp phiên đăng nhập
 * @returns Đối tượng chứa token rõ, thời điểm hết hạn expires_at và thông tin user
 */
export async function issueSession(sql: Sql, user: PublicUser) {
  // Bước 1: Tạo ngẫu nhiên chuỗi token bảo mật cao
  const token = randomToken();
  // Hội viên duy trì đăng nhập 7 ngày (thuận tiện trên mobile), nhân viên chỉ 12 giờ để giảm thiểu rủi ro bảo mật
  const hours = user.role === "member" ? 24 * 7 : 12;
  // Bước 2: Tính toán thời điểm hết hạn của phiên làm việc
  const expires = new Date(Date.now() + hours * 3600 * 1000);
  // Bước 3: Lưu mã băm sha256 của token vào bảng sessions_auth (không lưu token rõ để tránh lộ khi DB bị rò rỉ)
  await sql.query(
    `insert into sessions_auth (user_id, token_hash, expires_at) values ($1,$2,$3)`,
    [user.id, sha256(token), expires.toISOString()],
  );
  // Bước 4: Trả về token rõ cho client cùng thời hạn hết hạn và thông tin người dùng
  return { token, expires_at: expires.toISOString(), user };
}

/**
 * EventSource cannot send headers, so the live update stream (GET /api/live) alone may carry
 * its token in the query string. Every other route needs the Authorization header, which keeps
 * tokens out of URLs, logs and Referer headers.
 */
function liveStreamToken(request: Request): string | null {
  if (request.method.toUpperCase() !== "GET") return null;
  const url = new URL(request.url);
  if (!/\/(api|v1)\/live\/?$/.test(url.pathname)) return null;
  return url.searchParams.get("token");
}

/**
 * Làm gì: Xác thực request qua Bearer token (hoặc query param cho SSE /live), kiểm tra phiên làm việc trong database và trạng thái tài khoản.
 * Được gọi ở: src/server/controllers/router.ts (middleware xác thực router), src/server/controllers/handlers/bookings.ts, src/routes/chat.tsx, test runner (node --test trong src/server/controllers/tx.test.ts).
 * @param sql Client kết nối cơ sở dữ liệu Postgres
 * @param request HTTP Request cần xác thực
 * @returns Thông tin PublicUser hợp lệ của phiên đăng nhập
 * @throws {HttpError} Lỗi 401 Unauthorized khi thiếu token, token không hợp lệ, phiên bị thu hồi, hết hạn hoặc tài khoản chưa kích hoạt
 * @throws {HttpError} Lỗi 429 Too Many Requests khi tài khoản đang trong thời gian bị khóa tạm thời
 */
export async function authFromRequest(sql: Sql, request: Request): Promise<PublicUser> {
  // Bước 1: Lấy token từ header Authorization (Bearer token) hoặc từ query string (dành riêng cho EventSource /live)
  const hdr = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(hdr);
  const token = m ? m[1] : liveStreamToken(request);
  // Không tìm thấy token nào trong request -> từ chối ngay với lỗi 401
  if (!token) throw err.unauth();
  // Bước 2: Tìm phiên trong bảng sessions_auth theo mã băm sha256 của token và join với bảng users
  const row = await one<{
    id: string;
    member_code: string | null;
    full_name: string;
    phone: string;
    email: string | null;
    role: Role;
    status: string;
    date_of_birth: string | null;
    health_notes: string | null;
    must_change_password: boolean;
    locked_until: string | null;
    expires_at: string;
    revoked_at: string | null;
    avatar_version: number | null;
  }>(
    sql,
    `select u.id, u.member_code, u.full_name, u.phone, u.email, u.role, u.status,
            u.date_of_birth, u.health_notes, u.must_change_password,
            (select version from user_avatars a where a.user_id = u.id) as avatar_version,
            s.expires_at, s.revoked_at, u.locked_until
       from sessions_auth s
       join users u on u.id = s.user_id
      where s.token_hash = $1`,
    [sha256(token)],
  );
  // Bước 3: Kiểm tra tính hợp lệ của phiên và trạng thái người dùng
  // Token không tồn tại trong database hoặc không khớp với phiên nào
  if (!row) throw err.unauth("That session is not valid.");
  // Phiên làm việc đã bị thu hồi (người dùng đã logout hoặc đổi mật khẩu ở nơi khác)
  if (row.revoked_at) {
    const url = new URL(request.url);
    // Vẫn áp dụng rate limit nếu đang cố đổi mật khẩu bằng token đã thu hồi để chống tấn công brute-force
    if (request.method.toUpperCase() === "POST" && /\/v1\/me\/password\/?$/.test(url.pathname)) {
      limit(`pw:${row.id}`, RULES.passwordChange, "password changes");
    }
    throw err.unauth("That session is not valid.");
  }
  // Phiên làm việc đã quá hạn sử dụng
  if (new Date(row.expires_at) < new Date()) throw err.unauth("Your session has expired.");
  // Tài khoản bị tạm dừng hoặc chưa được kích hoạt
  if (row.status !== "active") throw err.unauth("This account is not active.");
  // Tài khoản đang bị khóa tạm thời do nhập sai mật khẩu nhiều lần
  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    throw err.rateLimited("This account is locked.");
  }
  // Bước 4: Chuyển đổi dữ liệu sang định dạng PublicUser an toàn để chuyển tiếp cho handler
  return toPublic(row);
}

/**
 * Làm gì: Xác thực tùy chọn: trả về PublicUser nếu có token hợp lệ, hoặc trả về null nếu không có token hoặc token không hợp lệ (không ném lỗi).
 * Được gọi ở: src/server/controllers/router.ts (các route cho phép cả khách vãng lai lẫn thành viên), src/server/controllers/handlers/live.ts (kết nối SSE stream).
 * @param sql Client kết nối cơ sở dữ liệu Postgres
 * @param request HTTP Request có thể chứa hoặc không chứa token
 * @returns Đối tượng PublicUser nếu xác thực thành công, ngược lại trả về null
 */
export async function optionalAuth(sql: Sql, request: Request): Promise<PublicUser | null> {
  // Bước 1: Kiểm tra nhanh xem request có mang theo token hay không
  const hdr = request.headers.get("authorization") ?? "";
  // Nếu không có token, trả về null ngay mà không cần truy vấn DB
  if (!/^Bearer\s+/i.test(hdr) && !liveStreamToken(request)) return null;
  // Bước 2: Thử xác thực; nếu token lỗi, hết hạn hoặc không hợp lệ thì xem như khách vãng lai (trả về null)
  try {
    return await authFromRequest(sql, request);
  } catch {
    return null;
  }
}

/**
 * Làm gì: Kiểm tra phân quyền theo vai trò (Role-Based Access Control): kiểm tra vai trò của người dùng có thuộc danh sách cho phép hay không.
 * Được gọi ở: src/server/controllers/router.ts và 18 handlers trong src/server/controllers/handlers/ (attendance, bookings, classes, members, ops, staff, training,...).
 * @param user Thông tin người dùng hiện tại lấy từ phiên đăng nhập
 * @param roles Danh sách các vai trò (Role) được phép truy cập
 * @throws {HttpError} Lỗi 403 Forbidden nếu vai trò của người dùng không nằm trong danh sách cho phép
 */
export function requireRole(user: PublicUser, roles: Role[]) {
  // Ném lỗi 403 Forbidden nếu vai trò của người dùng không nằm trong danh sách cho phép
  if (!roles.includes(user.role)) throw err.forbidden();
}

/**
 * Làm gì: Danh sách các vai trò nhân viên trung tâm (manager, coach, receptionist) dùng cho các chức năng quản trị nội bộ.
 * Được gọi ở: src/server/controllers/router.ts (kiểm tra quyền truy cập các API nội bộ của nhân viên).
 */
export const staffRoles: Role[] = ["manager", "coach", "receptionist"];
/**
 * Làm gì: Danh sách các vai trò trực quầy lễ tân (manager, receptionist) phụ trách đón tiếp, check-in và thu ngân tại chỗ.
 * Được gọi ở: Các handler kiểm tra phân quyền cho nghiệp vụ tại quầy lễ tân.
 */
export const deskRoles: Role[] = ["manager", "receptionist"];

export { hashPassword, verifyPassword, q };
