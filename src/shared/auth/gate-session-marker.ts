/**
 * Client-readable marker for gate-materialized sessions ("Sign in with Grok"
 * zero-click sessions minted by `gate-session.server.ts`). Signing out of a
 * gate session is a no-op — the next request re-materializes it from
 * `x-grok-identity` — so `UserButton` uses this to hide its sign-out control.
 * `__Host-` prefixed like the other auth cookies: browsers reject a `__Host-`
 * cookie carrying a `Domain`, so an untrusted sibling `*.grok.me` app cannot
 * plant a parent-domain copy that the host-only clear could never expire.
 * Client-safe: no server imports.
 */
export const GATE_SESSION_MARKER_COOKIE = "__Host-grok_gate_session";

/**
 * Làm gì: Kiểm tra xem cookie đánh dấu phiên đăng nhập qua cổng Grok (GATE_SESSION_MARKER_COOKIE) có tồn tại trên trình duyệt hay không để giao diện UserButton ẩn nút đăng xuất.
 * Được gọi ở: src/client/auth/gates.tsx (component UserButton).
 * @returns true nếu tìm thấy cookie đánh dấu phiên trong document.cookie, ngược lại false (hoặc khi chạy ở phía server).
 */
export function hasGateSessionMarker(): boolean {
  // Bước 1: Kiểm tra môi trường thực thi; nếu đang render phía server (không có đối tượng document) thì trả về false để đảm bảo an toàn SSR.
  if (typeof document === "undefined") return false;
  // Bước 2: Đọc document.cookie, tách từng cặp cookie theo dấu chấm phẩy và kiểm tra xem có cookie nào bắt đầu bằng GATE_SESSION_MARKER_COOKIE hay không.
  return document.cookie
    .split(";")
    .some((pair) => pair.trim().startsWith(`${GATE_SESSION_MARKER_COOKIE}=`));
}
