/**
 * File: src/server/auth/preview.ts
 * Vai trò: Định nghĩa các hằng số cấu hình OAuth client dùng chung cho môi trường xem trước trực tiếp (Live Preview).
 * Vị trí trong app: Chạy ở server (server-only), cung cấp thông tin xác thực dự phòng và danh sách host cho phép cho Better Auth trong src/server/auth/server.ts khi chưa có cấu hình production.
 */
/**
 * Shared LIVE-PREVIEW OAuth client (server-only — NEVER import from the client).
 *
 * The sandbox serves each live preview on a dynamic `https://*.grok-sandbox.com`
 * URL, which can't be pre-registered per app. The broker instead exposes ONE
 * shared "preview" client that accepts any
 * `https://*.grok-sandbox.com/api/auth/oauth2/callback/*`
 * (broker: `app-builder-deployer/auth/src/preview-oauth.ts`). Baking it here lets
 * the live preview do REAL sign-in — no demo/mock users — with no platform
 * injection. When deployed the deployer injects a per-app
 * `GROK_AUTH_*` that overrides these (see `server.ts`).
 *
 * These MUST equal the broker's `GROK_PREVIEW_CLIENT_ID` /
 * `GROK_PREVIEW_CLIENT_SECRET` (set in the broker's Vercel env; the broker stores
 * only the secret's `base64url(SHA-256)` hash). This is a dedicated, low-privilege
 * client (preview-only, `*.grok-sandbox.com`) — rotate it by regenerating the
 * broker env var and this constant together.
 */
/**
 * Làm gì: Client ID của OAuth client dùng chung cho môi trường Live Preview trong sandbox; khớp với cấu hình GROK_PREVIEW_CLIENT_ID trên auth broker.
 * Được gọi ở: src/server/auth/server.ts (biến grokClientId).
 */
export const PREVIEW_CLIENT_ID = "grok_preview";
/**
 * Làm gì: Client Secret của OAuth client dùng chung cho Live Preview; dùng để ký và xác thực yêu cầu OAuth với auth broker trong môi trường sandbox.
 * Được gọi ở: src/server/auth/server.ts (biến grokClientSecret).
 */
export const PREVIEW_CLIENT_SECRET =
  "8bcdb7fc5a33874ad933ca568918d5790388a0795e44c4d1dea691f801b17ec5";

/** The shared auth broker issuer (OIDC discovery lives under it). */
/**
 * Làm gì: Địa chỉ URL issuer mặc định của dịch vụ xác thực Grok auth broker, nơi cung cấp endpoint khám phá cấu hình OIDC discovery.
 * Được gọi ở: src/server/auth/server.ts (biến grokIssuer).
 */
export const GROK_ISSUER_DEFAULT = "https://auth.grok.me";

/**
 * Host patterns whose callbacks the preview client accepts. Better Auth derives
 * the live preview's real origin from the request host and validates it against
 * this list (wildcard-matched), so the OAuth `redirect_uri` becomes the concrete
 * `https://<preview-host>/api/auth/oauth2/callback/...` the broker allows.
 */
/**
 * Làm gì: Danh sách mẫu tên miền wildcard (*.grok-sandbox.com) được chấp nhận để Better Auth kiểm tra host và tạo redirect_uri callback hợp lệ trong Live Preview.
 * Được gọi ở: src/server/auth/server.ts (mảng previewAllowedHosts dùng cấu hình baseURL động cho Better Auth).
 */
export const PREVIEW_ALLOWED_HOSTS = ["*.grok-sandbox.com"] as const;
