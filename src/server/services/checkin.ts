/**
 * Check-in tokens (SRS v1.4.1 FR-TRN-02, FR-CRT-07, BR-30).
 *
 * A token is `base64url(payload).base64url(hmac)`: signed with a server secret,
 * short-lived, and never stored in a readable form. Three kinds:
 *
 *  - `member`  — a member's own door code. 60 seconds, single use (the jti is
 *                recorded when scanned, so a photographed code is worthless).
 *  - `booking` — the same for one court booking.
 *  - `desk`    — the code displayed at the front desk for optional self
 *                check-in. 30 seconds, reusable inside that window (many members
 *                scan the same screen), and only honoured when the centre has
 *                switched self check-in on.
 *
 * There is deliberately no location in a token: GPS is not used (see SRS §3.5).
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { err } from "../controllers/errors.ts";

export type CheckinKind = "member" | "booking" | "desk";

/**
 * Làm gì: Cấu hình thời gian sống (TTL tính bằng giây) cho từng loại mã QR check-in: 60s cho hội viên và ca đặt sân, 30s cho mã quầy lễ tân.
 * Được gọi ở: src/server/services/checkin.ts (hàm signCheckinToken), tests/src/server/services/arena3.test.ts (test runner: node --test).
 */
export const CHECKIN_TTL_SECONDS: Record<CheckinKind, number> = {
  member: 60,
  booking: 60,
  desk: 30,
};

type Payload = { k: CheckinKind; s: string; j: string; e: number };

export type VerifiedToken = { kind: CheckinKind; sub: string; jti: string; expiresAt: number };

/**
 * A dev constant keeps local runs working. In production it would be a key
 * anyone can read in the repository, so there the QR codes refuse to work until
 * CHECKIN_SECRET (or OTP_SECRET) is set.
 */
function secret(): string {
  const set = process.env.CHECKIN_SECRET?.trim() || process.env.OTP_SECRET?.trim();
  if (set) return set;
  if (process.env.NODE_ENV === "production") throw new Error("CHECKIN_SECRET is not set");
  return "arena3-dev-checkin-secret";
}

/**
 * Làm gì: Kiểm tra biến môi trường CHECKIN_SECRET (hoặc OTP_SECRET) đã được thiết lập để ký mã check-in hay chưa.
 * Được gọi ở: Module kiểm tra cấu hình hệ thống hoặc health check khi khởi động ứng dụng.
 * @returns true nếu hệ thống đã cấu hình secret key cho check-in, ngược lại trả về false.
 */
export function checkinSecretConfigured(): boolean {
  return Boolean(process.env.CHECKIN_SECRET?.trim() || process.env.OTP_SECRET?.trim());
}

/**
 * Làm gì: Tạo mã băm HMAC-SHA256 cho chuỗi dữ liệu (payload base64url) bằng secret key của hệ thống để chống giả mạo token check-in.
 * Được gọi ở: src/server/services/checkin.ts (trong các hàm signCheckinToken và verifyCheckinToken).
 * @param body Chuỗi dữ liệu payload dạng base64url cần băm tạo chữ ký.
 * @returns Buffer chứa chữ ký số nhị phân HMAC-SHA256.
 */
function mac(body: string): Buffer {
  return createHmac("sha256", secret()).update(body).digest();
}

/**
 * Làm gì: Tạo và ký token check-in có thời hạn ngắn (TTL), nhúng mã jti ngẫu nhiên dùng 1 lần để chống gian lận quét lại mã QR cũ.
 * Được gọi ở: handlers/checkin.ts (các hàm meCheckinToken, meBookingCheckinToken, deskCheckinCode), src/server/services/arena3.test.ts.
 * @param kind Loại mã check-in ("member" cho hội viên, "booking" cho ca đặt sân, "desk" cho quầy lễ tân).
 * @param sub Mã định danh đối tượng (user_id của hội viên, booking_id của ca đặt, hoặc "front-desk").
 * @param now Thời điểm tạo mã tính theo timestamp milliseconds (mặc định Date.now()).
 * @returns Object chứa token định dạng base64url body.hmac, thời điểm hết hạn ISO (expires_at) và thời gian sống tính bằng giây (ttl_seconds).
 */
export function signCheckinToken(kind: CheckinKind, sub: string, now = Date.now()) {
  // Bước 1: Tính thời điểm hết hạn (Unix timestamp tính bằng giây) theo thời gian sống (TTL) của từng loại mã.
  const exp = Math.floor(now / 1000) + CHECKIN_TTL_SECONDS[kind];
  // Bước 2: Tạo payload nhỏ gọn; trường 'j' (jti ngẫu nhiên) đảm bảo mỗi mã tạo ra là duy nhất và chỉ dùng 1 lần (BR-30).
  const payload: Payload = { k: kind, s: sub, j: randomUUID(), e: exp };
  // Bước 3: Mã hóa payload JSON sang chuỗi base64url và tính chữ ký HMAC-SHA256 để chống giả mạo token.
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const token = `${body}.${mac(body).toString("base64url")}`;
  // Bước 4: Trả về chuỗi token ghép dạng body.hmac kèm thời điểm hết hạn ISO và thời gian sống (TTL).
  return { token, expires_at: new Date(exp * 1000).toISOString(), ttl_seconds: CHECKIN_TTL_SECONDS[kind] };
}

/**
 * Làm gì: Xác thực chữ ký HMAC và hạn dùng của mã QR check-in, bóc tách payload để lấy thông tin định danh hội viên hoặc ca đặt sân.
 * Được gọi ở: handlers/checkin.ts (hàm deskScan khi lễ tân quét mã, hàm meSelfCheckin khi hội viên tự quét mã quầy), src/server/services/arena3.test.ts.
 * @param raw Chuỗi dữ liệu quét được từ mã QR (chuỗi token body.sig hoặc URL chứa tham số ?d=...).
 * @param now Thời điểm kiểm tra tính theo timestamp milliseconds (mặc định Date.now()).
 * @returns Đối tượng VerifiedToken gồm kind (loại mã), sub (ID hội viên/ca đặt), jti (mã duy nhất) và expiresAt (thời điểm hết hạn ms).
 * @throws ApiError lỗi 422 BR-30 nếu mã không hợp lệ, sai chữ ký, cấu trúc payload hỏng hoặc mã đã hết hạn.
 */
export function verifyCheckinToken(raw: unknown, now = Date.now()): VerifiedToken {
  // Bước 1: Khởi tạo hàm tiện ích ném lỗi BR-30 chuẩn và kiểm tra dữ liệu đầu vào bắt buộc phải là chuỗi ký tự.
  const bad = (m: string) => err.br("BR-30", m, { field: "token" });
  if (typeof raw !== "string") throw bad("That code is not valid.");
  // Bước 2: Chuẩn hóa chuỗi và bóc tách token (xử lý trường hợp máy quét trả về URL chứa tham số ?d=...).
  // The scanner may hand back a URL that carries the token (the desk code does).
  const text = raw.trim();
  const token = text.includes("=") && text.includes("?") ? (new URL(text, "http://x").searchParams.get("d") ?? "") : text;
  // Bước 3: Phân tách token thành 2 phần payload và signature ngăn cách bởi dấu chấm; từ chối nếu không đúng định dạng.
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw bad("That code is not valid.");
  // Bước 4: Kiểm tra chữ ký HMAC.
  // Dùng timingSafeEqual để so sánh dữ liệu nhị phân với thời gian không đổi, chống tấn công dò thời gian (timing attack).
  const given = Buffer.from(parts[1], "base64url");
  const want = mac(parts[0]);
  if (given.length !== want.length || !timingSafeEqual(given, want)) throw bad("That code is not valid.");
  // Bước 5: Giải mã payload từ base64url sang UTF-8 và parse JSON thành đối tượng Payload.
  let p: Payload;
  try {
    p = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Payload;
  } catch {
    throw bad("That code is not valid.");
  }
  // Bước 6: Kiểm tra cấu trúc payload và tính hợp lệ của các trường bắt buộc (kind, sub, jti).
  if (!p || !["member", "booking", "desk"].includes(p.k) || typeof p.s !== "string" || typeof p.j !== "string") {
    throw bad("That code is not valid.");
  }
  // Bước 7: Kiểm tra thời hạn hiệu lực theo quy tắc BR-30; đổi giây sang milliseconds để so sánh với thời điểm hiện tại.
  if (typeof p.e !== "number" || p.e * 1000 < now) {
    throw bad("That code has expired — ask the member to refresh it.");
  }
  // Bước 8: Trả về đối tượng VerifiedToken với thông tin đã được kiểm thực thành công.
  return { kind: p.k, sub: p.s, jti: p.j, expiresAt: p.e * 1000 };
}
