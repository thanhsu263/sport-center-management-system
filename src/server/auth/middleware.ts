/**
 * File: src/server/auth/middleware.ts
 * Vai trò: Middleware xác thực danh tính người dùng cho các server function (createMiddleware của TanStack Start).
 * Vị trí trong app: Chạy ở cả hai đầu client (forward bearer token trong iframe preview) và server (chặn cross-site request, giải mã session/token lấy userId gán vào context).
 */
import { createMiddleware } from "@tanstack/react-start";

/**
 * Auth middleware for server functions — the standard way to get the caller's
 * verified user id. When deployed the session cookie is same-origin and rides
 * along automatically. In the live preview the client also forwards the bearer
 * token (partitioned cookies) via the `.client` hook below — call sites do not
 * thread it themselves.
 *
 *   import { createServerFn } from "@tanstack/react-start";
 *   import { getSql } from "@/server/data/db";
 *   import { authMiddleware } from "@/server/auth/middleware";
 *
 *   export const listTodos = createServerFn({ method: "GET" })
 *     .middleware([authMiddleware])
 *     .handler(async ({ context }) => {
 *       const sql = await getSql();
 *       return sql`select * from todos where user_id = ${context.userId}`;
 *     });
 *
 * Signed out with auth on (live preview included) -> throws `UnauthorizedError`
 * (see `verify.server.ts`). With auth disabled (`VITE_AUTH_ENABLED=false`, the
 * shipped default) it resolves the shared dev user — but throws instead when a
 * `DATABASE_URL` is also set, so an app without sign-in must not use this at
 * all. On the auth-on path, use it on every server function that touches
 * per-user data and scope every query by `context.userId`.
 */
/**
 * Làm gì: Middleware xác thực cho TanStack Start server functions; kiểm tra an toàn cùng nguồn (same-site) và trích xuất userId đã xác thực để gán vào context.
 * Được gọi ở: Truyền vào .middleware([authMiddleware]) của các server function (createServerFn) cần xác thực người dùng trước khi thao tác dữ liệu cá nhân.
 * @returns Middleware definition của TanStack Start cung cấp context { userId: string } cho server function handler.
 * @throws UnauthorizedError Khi chưa đăng nhập (khi bật auth) hoặc cấu hình database không hợp lệ.
 * @throws CrossSiteRequestError Khi phát hiện request cross-site hoặc sibling từ script độc hại.
 */
export const authMiddleware = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    // Live preview (partitioned iframe): the session rides a bearer token, not a
    // cookie, so forward it to the server. Null when deployed (cookie auth), so
    // this is a no-op there.
    // Bước 1: Nạp động hàm getBearerToken từ client module để đọc token từ sessionStorage (dành riêng cho Live Preview trong iframe).
    const { getBearerToken } = await import("../../client/auth/client");
    // Bước 2: Gửi bearerToken sang phía server qua sendContext; khi deploy thực tế (cookie auth) giá trị này là undefined.
    return next({ sendContext: { bearerToken: getBearerToken() ?? undefined } });
  })
  .server(async ({ next, context }) => {
    // ONLY import `*.server` modules here. This file is dual client/server
    // (bearer hook on the client). A plain `./isolation` path was renamed to
    // `isolation.server.ts` — keep this import in sync so image `tsc` resolves
    // it, and so Vite does not ship `@tanstack/react-start/server` to the browser.
    // Bước 1: Dynamic import các module phía server (isolation và verify) để tránh đóng gói mã server-only vào client bundle.
    const { assertSameSiteRequest } = await import("./isolation.server.ts");
    const { requireUserId } = await import("./verify.server.ts");
    // Bước 2: Kiểm tra bảo mật Same-Site qua Fetch-Metadata headers.
    // Reject scripted cross-site/sibling requests before touching per-user data.
    assertSameSiteRequest();
    // Bước 3: Xác thực phiên đăng nhập (từ cookie hoặc bearerToken) để lấy userId; ném UnauthorizedError nếu không hợp lệ.
    const userId = await requireUserId(context.bearerToken);
    // Bước 4: Chuyển tiếp context chứa userId đã xác thực tới handler tiếp theo của server function.
    return next({ context: { userId } });
  });
