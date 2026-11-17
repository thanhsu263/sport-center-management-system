/**
 * File: src/server/auth/isolation.server.ts
 * Vai trò: Bảo vệ ứng dụng trước các tấn công cross-site và cô lập sibling tenant trên cùng domain (*.grok.me) bằng Fetch Metadata.
 * Vị trí trong app: Chạy độc quyền ở server (.server.ts), được gọi tại authMiddleware và client.server.ts để từ chối các request dạng script mượn session cookie.
 */
import { getRequest } from "@tanstack/react-start/server";

/**
 * Fetch-Metadata sibling isolation — **server-only** (`.server.ts` suffix).
 *
 * MUST keep the `.server` suffix: this file imports `@tanstack/react-start/server`
 * (`getRequest` → Node `AsyncLocalStorage`). If it is imported from a dual
 * client/server module under a non-`.server` name, Vite ships it to the browser
 * and the app dies with: `AsyncLocalStorage is not a constructor`.
 *
 * Apps deployed on `*.grok.me` are "same-site" to each other but MUTUALLY
 * UNTRUSTED, and a `SameSite=Lax` session cookie IS sent on same-site
 * subrequests — so without this, a malicious sibling could make a SCRIPTED
 * (fetch/XHR/form-POST) request to this app's server functions and ride this
 * app's session cookie.
 *
 * We allow only: same-origin requests (this app's own client), non-browser
 * requests (SSR / server-to-server, which send no `Sec-Fetch-Site`), and
 * top-level GET navigations (how the OAuth callback and normal page loads
 * arrive). Every cross-site / same-site *scripted* request is rejected.
 * Together with `__Host-` cookies and Better Auth's `trustedOrigins`, this
 * closes the sibling-tenant attack surface. Enforced at the `authMiddleware`
 * chokepoint (see `middleware.ts`).
 */
/**
 * Làm gì: Định nghĩa lớp lỗi HTTP 403 Forbidden, ném ra khi phát hiện request cross-site hoặc sibling request dạng script không hợp lệ.
 * Được gọi ở: src/server/auth/isolation.server.ts (hàm assertSameSiteRequest ném ra); src/server/app-data/client.server.ts (hàm crossSiteBlockedResult bắt lỗi).
 */
export class CrossSiteRequestError extends Error {
  readonly status = 403;
  constructor() {
    super("Forbidden: cross-site request blocked");
    this.name = "CrossSiteRequestError";
  }
}

/** Throw `CrossSiteRequestError` for a scripted cross-site/sibling request. */
/**
 * Làm gì: Kiểm tra các header Fetch Metadata (sec-fetch-site, sec-fetch-mode, sec-fetch-dest) để chặn các request dạng script cross-site hoặc sibling tenant chiếm session cookie.
 * Được gọi ở: src/server/auth/middleware.ts (chốt chặn authMiddleware trước khi xử lý dữ liệu người dùng); src/server/app-data/client.server.ts (hàm crossSiteBlockedResult khi gọi connector tool).
 * @returns Không trả về giá trị (void) nếu request an toàn và được phép đi tiếp.
 * @throws {CrossSiteRequestError} Ném lỗi 403 Forbidden nếu phát hiện request dạng script cross-site hoặc từ ứng dụng lân cận không tin cậy.
 */
export function assertSameSiteRequest(): void {
  // Bước 1: Lấy HTTP request hiện tại từ context máy chủ qua getRequest(). Nếu không có context (ví dụ lúc build hoặc prerender) thì bỏ qua kiểm tra.
  const request = getRequest();
  if (!request) return; // no request context (e.g. build) — nothing to guard
  // Bước 2: Kiểm tra nguồn gốc qua header sec-fetch-site; cho phép các request an toàn gồm non-browser (không có header), cùng origin (same-origin), hoặc người dùng mở trực tiếp qua URL/bookmark (none).
  const h = request.headers;
  const site = h.get("sec-fetch-site");
  // Non-browser client (no header), the app's own origin, or a direct
  // (address-bar/bookmark) load are all fine.
  if (!site || site === "same-origin" || site === "none") return;
  // Bước 3: Cho phép ngoại lệ với điều hướng cấp cao nhất (top-level GET navigation như OAuth redirect); loại trừ thẻ <object> và <embed> nhằm ngăn chặn nhúng tài nguyên độc hại.
  // A top-level GET navigation (e.g. the broker's OAuth callback redirect) is
  // fine even when it's cross-site; scripted requests never set navigate mode.
  const dest = h.get("sec-fetch-dest");
  const isTopLevelGet =
    h.get("sec-fetch-mode") === "navigate" &&
    request.method === "GET" &&
    dest !== "object" &&
    dest !== "embed";
  if (isTopLevelGet) return;
  // Bước 4: Chặn và ném lỗi CrossSiteRequestError (403 Forbidden) đối với tất cả các request dạng script cross-site hoặc sibling-tenant còn lại.
  throw new CrossSiteRequestError();
}
