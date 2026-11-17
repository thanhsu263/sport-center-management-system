/**
 * File: src/server/controllers/handlers/google.ts
 * Vai trò: Xử lý đăng nhập và liên kết tài khoản Google Identity Services (GIS).
 * Bao gồm: cung cấp Google Client ID cho client, xác minh JWT ID token từ Google,
 * đăng nhập tài khoản Arena 3 đã liên kết với Google, và liên kết/hủy liên kết Google trong hồ sơ cá nhân.
 * Được điều phối từ src/server/controllers/router.ts cho các route /auth/google và /me/google.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Sql } from "@/server/data/db";
import { err } from "../errors";
import { audit, readJson, str } from "../helpers";
import { PUBLIC_COLS, issueSession, toPublic, type PublicUser } from "../session";
import { one, q } from "../tx";

/**
 * "Continue with Google".
 *
 * The browser gets a Google ID token from Google Identity Services and posts it
 * here; we check its signature against Google's published keys, its audience
 * against our own client id, and that Google has verified the email.
 *
 * Google never creates an account and never signs anyone in on its own. A
 * signed-in person links their Google account from Account settings
 * (`googleLink`), which stores Google's subject id on their user row; after
 * that, and only then, `googleLogin` accepts a token whose subject matches.
 * An email that merely matches an account's email is not enough.
 *
 * Only the client id is needed (no secret): the ID token flow never trades a
 * code for tokens, so there is nothing for a secret to protect.
 */
/**
 * Làm gì: Lấy Google Client ID từ biến môi trường GOOGLE_CLIENT_ID để phục vụ xác thực phía frontend và backend.
 * Được gọi ở: src/server/controllers/handlers/google.ts (trong googleConfig, verifyGoogle, googleLinkGet).
 * @returns Chuỗi Google Client ID đã cắt khoảng trắng hoặc null nếu chưa được cấu hình.
 */
export function googleClientId(): string | null {
  return process.env.GOOGLE_CLIENT_ID?.trim() || null;
}

// Fetched once and cached by jose, refreshed when Google rotates its keys.
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

/**
 * Làm gì: Trả về Google Client ID để phía frontend khởi tạo và hiển thị nút Google Identity Services.
 * Được gọi ở: src/server/controllers/router.ts (route GET /auth/google hoặc GET /v1/auth/google); phía client từ GoogleButton và GoogleSignIn.
 * @returns Phản hồi HTTP 200 kèm body chứa client_id (chuỗi hoặc null).
 */
export function googleConfig() {
  return { status: 200, body: { client_id: googleClientId() } };
}

/** The verified email and name in a Google ID token, or a 401. */
/**
 * Làm gì: Xác thực Google ID token (JWT) gửi từ client bằng chữ ký công khai của Google và kiểm tra audience, email hợp lệ.
 * Được gọi ở: src/server/controllers/handlers/google.ts (trong googleLogin và googleLink).
 * @param credential Chuỗi JWT ID token do Google Identity Services trả về cho client.
 * @returns Đối tượng chứa subject ID duy nhất của Google (sub) và email đã chuẩn hóa chữ thường.
 * @throws ApiError 404 nếu chưa cấu hình GOOGLE_CLIENT_ID; 400 nếu thiếu credential; 401 nếu token không hợp lệ hoặc email chưa xác minh.
 */
async function verifyGoogle(credential: string | null | undefined): Promise<{ sub: string; email: string }> {
  // Bước 1: Kiểm tra hệ thống đã cấu hình Google Client ID và client có gửi credential token lên hay không.
  const clientId = googleClientId();
  if (!clientId) throw err.notFound("Google sign-in is not set up.");
  if (!credential) throw err.validation("The Google sign-in did not return a token.");
  // Bước 2: Xác minh chữ ký mật mã của token qua bộ khóa công khai của Google (googleKeys) và đối chiếu audience với clientId.
  try {
    const { payload } = await jwtVerify(credential, googleKeys, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: clientId,
    });
    // Bước 3: Đảm bảo Google đã xác minh quyền sở hữu email (email_verified) và token có đầy đủ subject id.
    if (payload.email_verified !== true || typeof payload.email !== "string" || !payload.sub) {
      throw new Error("unverified email");
    }
    // Chuẩn hóa email về chữ thường để đảm bảo tính nhất quán khi lưu và so khớp tài khoản.
    return { sub: payload.sub, email: payload.email.trim().toLowerCase() };
  } catch {
    // Quy đổi mọi lỗi JWT (sai chữ ký, hết hạn, thiếu claims) thành lỗi 401 unauth thân thiện cho người dùng.
    throw err.unauth("Google could not confirm who you are. Please try again.");
  }
}

/**
 * Làm gì: Đăng nhập vào hệ thống bằng tài khoản Google đã liên kết; cấp phiên đăng nhập (session) mới và ghi nhật ký audit.
 * Được gọi ở: src/server/controllers/router.ts (route POST /auth/google hoặc POST /v1/auth/google); phía client từ GoogleSignIn.
 * @param sql Kết nối transaction PostgreSQL hiện tại.
 * @param request HTTP Request chứa body JSON gồm credential (Google ID token).
 * @returns Phản hồi HTTP 200 kèm body chứa session token và thông tin PublicUser.
 * @throws ApiError 401 nếu Google account chưa liên kết với tài khoản Arena 3 nào hoặc tài khoản bị vô hiệu hóa.
 */
export async function googleLogin(sql: Sql, request: Request) {
  // Bước 1: Đọc body JSON từ request và giải mã, xác thực Google ID token để lấy sub và email.
  const body = await readJson(request);
  const google = await verifyGoogle(str(body.credential));
  // Bước 2: Tìm kiếm người dùng trong bảng users theo google_sub (định danh duy nhất từ Google).
  // Nghiệp vụ: Chỉ cho phép đăng nhập nếu tài khoản đã chủ động liên kết trước đó, không tự tạo tài khoản mới.
  const user = await one<Record<string, unknown>>(sql, `select ${PUBLIC_COLS} from users where google_sub = $1`, [
    google.sub,
  ]);
  // Bước 3: Nếu chưa liên kết google_sub, yêu cầu người dùng đăng nhập bằng mật khẩu rồi vào cài đặt để liên kết.
  if (!user) {
    throw err.unauth(
      "This Google account is not linked to an Arena3 account. Sign in with your password, then link Google in Account settings.",
    );
  }
  // Bước 4: Kiểm tra trạng thái tài khoản, chỉ cho phép tài khoản đang ở trạng thái 'active' đăng nhập.
  if (user.status !== "active") throw err.unauth("This account is not active.");
  // Bước 5: Ghi nhật ký kiểm toán (audit log) ghi nhận lượt đăng nhập thành công qua Google.
  await audit(sql, String(user.id), "login_google", "user", String(user.id));
  // Bước 6: Khởi tạo phiên đăng nhập mới (issueSession) và trả về session token cùng dữ liệu người dùng.
  return { status: 200, body: await issueSession(sql, toPublic(user)) };
}

/** Which Google account, if any, the signed-in person has linked. */
/**
 * Làm gì: Lấy thông tin tài khoản Google đã liên kết (google_email) và Google Client ID của người dùng hiện tại.
 * Được gọi ở: src/server/controllers/router.ts (route GET /me/google hoặc GET /v1/me/google); phía client từ GoogleLink trong src/routes/account.tsx.
 * @param sql Kết nối transaction PostgreSQL (chế độ đọc authedRead).
 * @param user Thông tin người dùng hiện tại đã được xác thực qua session.
 * @returns Phản hồi HTTP 200 kèm body chứa client_id và google_email (hoặc null nếu chưa liên kết).
 */
export async function googleLinkGet(sql: Sql, user: PublicUser) {
  // Truy vấn email Google đã liên kết từ bảng users theo id của người dùng hiện tại.
  const row = await one<{ google_email: string | null }>(sql, "select google_email from users where id = $1", [user.id]);
  return { status: 200, body: { client_id: googleClientId(), google_email: row?.google_email ?? null } };
}

/**
 * Làm gì: Liên kết tài khoản Google với tài khoản Arena 3 hiện tại của người dùng sau khi xác thực Google ID token.
 * Được gọi ở: src/server/controllers/router.ts (route POST /me/google hoặc POST /v1/me/google); phía client từ hàm link trong src/routes/account.tsx.
 * @param sql Kết nối transaction PostgreSQL hiện tại.
 * @param request HTTP Request chứa body JSON gồm credential (Google ID token).
 * @param user Thông tin người dùng hiện tại đang đăng nhập.
 * @returns Phản hồi HTTP 200 kèm body chứa google_email vừa liên kết.
 * @throws ApiError 409 conflict nếu tài khoản Google này đã được liên kết với một tài khoản Arena 3 khác.
 */
export async function googleLink(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Đọc body JSON và xác thực Google ID token để lấy subject ID (sub) và email.
  const body = await readJson(request);
  const google = await verifyGoogle(str(body.credential));
  // Bước 2: Kiểm tra xem tài khoản Google này (google_sub) đã được liên kết với tài khoản người dùng khác hay chưa.
  const taken = await one<{ id: string }>(sql, "select id from users where google_sub = $1 and id <> $2", [
    google.sub,
    user.id,
  ]);
  // Tránh một tài khoản Google bị dùng chung hoặc chiếm dụng bởi nhiều tài khoản Arena 3 khác nhau.
  if (taken) throw err.conflict("That Google account is already linked to another Arena3 account.");
  // Bước 3: Cập nhật google_sub và google_email vào bảng users cho người dùng hiện tại.
  await q(sql, "update users set google_sub = $1, google_email = $2 where id = $3", [google.sub, google.email, user.id]);
  // Bước 4: Ghi nhật ký kiểm toán (audit log) ghi nhận sự kiện liên kết tài khoản Google.
  await audit(sql, user.id, "google_link", "user", user.id);
  return { status: 200, body: { google_email: google.email } };
}

/**
 * Làm gì: Hủy liên kết tài khoản Google khỏi tài khoản Arena 3 của người dùng hiện tại.
 * Được gọi ở: src/server/controllers/router.ts (route DELETE /me/google hoặc DELETE /v1/me/google); phía client từ hàm unlink trong src/routes/account.tsx.
 * @param sql Kết nối transaction PostgreSQL hiện tại.
 * @param user Thông tin người dùng hiện tại đang đăng nhập.
 * @returns Phản hồi HTTP 200 kèm body { google_email: null }.
 */
export async function googleUnlink(sql: Sql, user: PublicUser) {
  // Bước 1: Đặt google_sub và google_email về null trong bảng users để xóa bỏ liên kết Google.
  await q(sql, "update users set google_sub = null, google_email = null where id = $1", [user.id]);
  // Bước 2: Ghi nhật ký kiểm toán (audit log) sự kiện hủy liên kết tài khoản Google.
  await audit(sql, user.id, "google_unlink", "user", user.id);
  return { status: 200, body: { google_email: null } };
}
