/**
 * File: src/server/auth/verify.server.ts
 * Vai trò: Xác thực phiên đăng nhập (session) của người dùng ở phía server (server-only).
 * Vị trí trong app: Trích xuất user id và email an toàn từ request cookie hoặc bearer token; được gọi bởi authMiddleware trong src/server/auth/middleware.ts để bảo vệ các server functions và SSR loaders.
 */
import { getRequest } from "@tanstack/react-start/server";
import { gateIdentityEnabled } from "./gate-identity.server.ts";
import { auth, authConfigured } from "./server";

/**
 * Server-side session resolution (server-only).
 *
 * Because this app runs its OWN Better Auth at same-origin `/api/auth/*`, the
 * session cookie is sent with every request to this app — server functions AND
 * SSR loaders included. So we resolve the user straight from the request cookies
 * via `auth.api.getSession` (no client-minted JWT needed). Never trust a
 * client-supplied user id — only the result of this verification.
 */

/** True when a real database is configured server-side. */
const databaseConfigured = Boolean(process.env.DATABASE_URL?.trim());

/** Re-export so callers can branch on it without importing `server.ts`. */
export { authConfigured };

// Cảnh báo bảo mật: Nếu có database thật nhưng tắt auth, requireUserId sẽ từ chối mọi request (fail closed) để tránh dùng chung dev-user gây lộ dữ liệu giữa các người dùng.
if (databaseConfigured && !authConfigured) {
  console.error(
    "[auth] DATABASE_URL is set but auth is disabled (VITE_AUTH_ENABLED=false) " +
      "— requireUserId() will reject every request (fail closed) rather than " +
      "share one dev user on a real database.",
  );
}

/** Dev fallback user id, used only when auth is disabled (VITE_AUTH_ENABLED=false). */
/**
 * Làm gì: Định danh người dùng mặc định (dev-user) khi tắt auth (VITE_AUTH_ENABLED=false) trong môi trường dev không có database.
 * Được gọi ở: src/server/auth/verify.server.ts (hàm requireUserId).
 */
export const DEV_USER_ID = "dev-user";

/**
 * Thrown by `requireUserId` when the caller has no valid session. Carries
 * `status: 401`; the message is a stable contract — match
 * `err.message === "Unauthorized"` client-side to send the visitor to sign-in.
 */
/**
 * Làm gì: Lớp lỗi 401 Unauthorized ném ra khi người dùng chưa đăng nhập hoặc không có session hợp lệ.
 * Được gọi ở: src/server/auth/verify.server.ts (hàm requireUserId); client bắt lỗi qua err.message === "Unauthorized" để chuyển hướng đăng nhập.
 */
export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

// Kiểu dữ liệu chứa thông tin người dùng cơ bản (id và email) sau khi xác thực session thành công.
export type VerifiedUser = { id: string; email: string | null };

/**
 * Resolve the signed-in user from the current request, or `null` when auth isn't
 * configured / nobody is signed in. Safe to call from server functions and SSR
 * loaders.
 *
 * `bearerToken` is for the LIVE PREVIEW: the app runs in a partitioned iframe
 * whose cookies don't reach the server, so `authMiddleware` forwards the session
 * as a bearer token, which we present as `Authorization: Bearer …` (the `bearer`
 * plugin resolves it). When deployed no token is passed and the cookie is used.
 */
/**
 * Làm gì: Xác thực và lấy thông tin người dùng từ request hiện tại; trả về null nếu chưa đăng nhập hoặc tính năng auth tắt.
 * Được gọi ở: src/server/auth/verify.server.ts (hàm requireUserId); các server functions hoặc SSR loaders cần kiểm tra người dùng mà không bắt buộc đăng nhập.
 * @param bearerToken Token ủy quyền tùy chọn, dùng cho môi trường live preview trong iframe bị cô lập cookie.
 * @returns Object VerifiedUser chứa id và email của người dùng nếu session hợp lệ, ngược lại trả về null.
 */
export async function getSessionUser(
  bearerToken?: string,
): Promise<VerifiedUser | null> {
  // Bước 1: Kiểm tra tính năng auth hoặc gate identity; nếu cả hai đều tắt thì bỏ qua và trả về null.
  if (!authConfigured && !gateIdentityEnabled()) return null;
  // Bước 2: Lấy đối tượng Request từ ngữ cảnh server của TanStack Start; nếu không có request thì không thể đọc cookie.
  const request = getRequest();
  if (!request) return null;
  // Bước 3: Lấy headers từ request; nếu có bearerToken (môi trường preview iframe), gắn vào header Authorization để plugin bearer phân giải.
  let headers = request.headers;
  if (bearerToken) {
    headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${bearerToken}`);
  }
  // Bước 4: Gọi Better Auth API để xác thực và lấy thông tin session dựa trên headers (cookie hoặc Bearer token).
  const session = await auth.api.getSession({ headers });
  // Bước 5: Kiểm tra kết quả session; nếu không có user thì trả về null, ngược lại trả về id và email đã chuẩn hóa.
  if (!session?.user) return null;
  return { id: session.user.id, email: session.user.email ?? null };
}

/**
 * Resolve the current user id for a server function, or throw when unauthorized.
 * Prefer `authMiddleware` (`./middleware`), which calls this for you.
 * - Auth enabled -> the verified session user id; throws
 *   `UnauthorizedError` when signed out. Works in the sandbox preview too (real
 *   sign-in via the baked preview client).
 * - Auth disabled (`VITE_AUTH_ENABLED=false`) + `DATABASE_URL` set -> throw (fail
 *   closed): one shared dev user on a real database would let every visitor
 *   read/write everyone's rows.
 * - Auth disabled + no database -> the shared dev user id.
 */
/**
 * Làm gì: Lấy id của người dùng đã xác thực cho server function; ném UnauthorizedError nếu chưa đăng nhập hoặc ném Error nếu cấu hình không an toàn.
 * Được gọi ở: src/server/auth/middleware.ts (authMiddleware.server); các server functions cần bắt buộc có user id.
 * @param bearerToken Token ủy quyền tùy chọn truyền từ client (dành cho môi trường sandbox preview).
 * @returns Chuỗi id của người dùng đã xác thực (hoặc DEV_USER_ID khi tắt auth và không kết nối database thật).
 * @throws {Error} Khi tắt auth nhưng có DATABASE_URL (ngăn dùng chung dev-user trên database thật).
 * @throws {UnauthorizedError} Khi bật auth nhưng request không có session người dùng hợp lệ.
 */
export async function requireUserId(bearerToken?: string): Promise<string> {
  // Bước 1: Xử lý khi tính năng auth tắt; nếu có DATABASE_URL thì từ chối (fail closed), nếu không có database thì dùng DEV_USER_ID.
  if (!authConfigured && !gateIdentityEnabled()) {
    // Ngăn chặn lỗi bảo mật: Dùng chung một dev-user trên database thật sẽ cho phép mọi người dùng truy cập và ghi đè dữ liệu của nhau.
    if (databaseConfigured) {
      throw new Error(
        "Auth is disabled (VITE_AUTH_ENABLED=false) but DATABASE_URL is set — " +
          "refusing to fall back to the shared dev user against a real database.",
      );
    }
    return DEV_USER_ID;
  }
  // Bước 2: Gọi getSessionUser để xác thực phiên đăng nhập từ cookie hoặc bearerToken.
  const user = await getSessionUser(bearerToken);
  // Bước 3: Nếu không có session hợp lệ, ném UnauthorizedError (HTTP 401) để yêu cầu client đăng nhập.
  if (!user) throw new UnauthorizedError();
  // Bước 4: Trả về user id đã được xác thực thành công.
  return user.id;
}
