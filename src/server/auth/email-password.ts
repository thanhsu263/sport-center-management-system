/**
 * File: src/server/auth/email-password.ts
 * Vai trò: Quản lý cờ cấu hình bật/tắt tính năng đăng ký và đăng nhập cục bộ bằng email/mật khẩu qua Better Auth.
 * Vị trí trong app: Cung cấp điểm chuyển đổi an toàn cho server/auth/server.ts mà không cần chỉnh sửa trực tiếp file cấu hình hệ thống.
 */
/**
 * Local email/password sign-in (this app's Better Auth DB — not the broker).
 *
 * Off by default. To enable: set `emailAndPasswordEnabled` to `true` below,
 * then build sign-up / sign-in forms with `authClient.signUp.email` /
 * `authClient.signIn.email` from `@/client/auth/client` (see the auth skill).
 *
 * Do NOT edit `server.ts` for this — that file is frozen pre-wired config.
 */
/**
 * Làm gì: Cờ boolean cấu hình bật hoặc tắt tính năng đăng ký và đăng nhập bằng email/mật khẩu trong cơ sở dữ liệu Better Auth cục bộ (mặc định là false - tắt).
 * Được gọi ở: src/server/auth/server.ts (cấu hình tùy chọn emailAndPassword khi khởi tạo Better Auth instance).
 */
export const emailAndPasswordEnabled = false;
