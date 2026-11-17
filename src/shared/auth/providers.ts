/**
 * The upstream identity providers this app offers for sign-in (via the broker).
 *
 * Source of truth for BOTH the server (`server.ts`, one `genericOAuth` provider
 * per entry) and the client (`client.ts` / sign-in buttons). Kept in its own
 * dependency-free module so the client can import it without pulling the
 * server-only Better Auth instance (and `pg`) into the browser bundle.
 *
 * Each app federates to the shared **auth broker** (`GROK_AUTH_ISSUER`), which
 * holds the real Google/X secrets. The app never sees them — it only knows its
 * own per-app client id/secret and which upstream to ask the broker for (`idp`).
 *
 * To add an upstream (e.g. GitHub) once the broker supports it: add one entry
 * here (`{ providerId: "grok-github", idp: "github", label: "GitHub" }`). The
 * `providerId` is this app's local id and the OAuth callback path segment
 * (`/api/auth/oauth2/callback/<providerId>`); `idp` is the hint the broker reads
 * to pick the upstream (Better Auth's id for X is still `twitter`).
 */
export type GrokProvider = {
  /** This app's local provider id; also the callback path segment. */
  providerId: string;
  /** Upstream hint the broker forwards to (Better Auth social id). */
  idp: string;
  /** Human label for the sign-in button. */
  label: string;
};

/**
 * Làm gì: Khai báo danh sách các nhà cung cấp định danh (IdP) được ứng dụng hỗ trợ để đăng nhập OAuth qua auth broker trung gian (Google, X).
 *   Đóng vai trò là nguồn dữ liệu chuẩn duy nhất (single source of truth) dùng chung cho cả server và client mà không kéo theo Better Auth hay pg vào bundle trình duyệt.
 * Được gọi ở:
 *   - src/client/auth/client.ts (re-export và tham chiếu trong hàm signIn).
 *   - src/client/auth/gates.tsx (component SignInButtons duyệt danh sách để render nút bấm đăng nhập).
 *   - src/server/auth/server.ts (cấu hình plugin genericOAuth và accountLinking.trustedProviders).
 * @returns Mảng readonly chứa các đối tượng GrokProvider (providerId, idp, label) dùng cho luồng xác thực OAuth.
 */
export const GROK_PROVIDERS: readonly GrokProvider[] = [
  { providerId: "grok-google", idp: "google", label: "Google" },
  { providerId: "grok-x", idp: "twitter", label: "X" },
];
