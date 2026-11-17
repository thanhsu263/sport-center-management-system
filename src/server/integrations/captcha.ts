/**
 * Tích hợp dịch vụ xác minh captcha Cloudflare Turnstile ở phía server.
 * Dùng để kiểm tra tính hợp lệ của captcha token từ client, bảo vệ các endpoint nhạy cảm (như gửi OTP đăng ký, quên mật khẩu) khỏi bot và spam tự động.
 */
import { err } from "../controllers/errors";

/** Fail closed when enabled; an unset secret preserves local/demo behaviour. */
/**
 * Làm gì: Xác minh token Cloudflare Turnstile với API Cloudflare siteverify để đảm bảo request gửi từ người dùng thật; nếu chưa cấu hình TURNSTILE_SECRET_KEY thì bỏ qua (dành cho local/demo).
 * Được gọi ở: src/server/controllers/handlers/auth.ts (hàm guardOtpSend trong luồng đăng ký tài khoản và quên mật khẩu).
 * @param token Chuỗi token captcha nhận từ client gửi lên để xác thực.
 * @param ip Địa chỉ IP của client (tùy chọn) để Cloudflare hỗ trợ đánh giá rủi ro.
 * @returns Không trả về giá trị (Promise<void>) nếu captcha hợp lệ hoặc khi tính năng captcha chưa được cấu hình.
 * @throws Lỗi validation 400 (err.validation) nếu token không hợp lệ, xác minh thất bại hoặc không kết nối được tới Cloudflare (chế độ fail closed).
 */
export async function verifyCaptcha(token: unknown, ip?: string): Promise<void> {
  // Bước 1: Kiểm tra khóa bí mật TURNSTILE_SECRET_KEY; nếu chưa cấu hình thì bỏ qua kiểm tra để thuận tiện phát triển ở local hoặc môi trường demo.
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return;
  // Bước 2: Kiểm tra sơ bộ token; từ chối ngay nếu không phải chuỗi ký tự, rỗng hoặc vượt quá 2048 ký tự để chặn payload rác.
  const rejected = () => err.validation("Complete the human verification and try again.", { field: "captcha" });
  if (typeof token !== "string" || !token.trim() || token.length > 2048) throw rejected();
  // Bước 3: Gửi request xác minh POST tới endpoint Cloudflare siteverify với thời gian timeout tối đa 10 giây để tránh treo request.
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    // Bước 4: Kiểm tra kết quả phản hồi; nếu Cloudflare trả về HTTP 200 và success: true thì xác nhận người dùng thật thành công.
    if (response.ok && (await response.json()).success === true) return;
  } catch {
    // Unavailable verification must never authorize a write or email.
  }
  // Bước 5: Cơ chế fail-closed: nếu Cloudflare từ chối xác minh hoặc gặp sự cố mạng/timeout, luôn ném lỗi validation để chặn request gửi OTP.
  throw rejected();
}
