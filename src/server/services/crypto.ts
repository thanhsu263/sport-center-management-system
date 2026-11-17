/**
 * Dịch vụ mật mã học và bảo mật dữ liệu cốt lõi cho backend hệ thống Arena3.
 * Cung cấp các tiện ích băm và xác thực mật khẩu người dùng (thuật toán scrypt chống tấn công phần cứng),
 * sinh token ngẫu nhiên bảo mật (CSPRNG), tính mã băm SHA-256 cho cache idempotency và bearer token,
 * tạo mã OTP 6 số ngẫu nhiên không thiên vị (rejection sampling) và băm HMAC OTP challenge.
 * Đóng vai trò là nền tảng bảo mật cho toàn bộ module xác thực tài khoản và quản lý phiên người dùng.
 */
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Cấu hình tham số chuẩn cho thuật toán scrypt (khuyến nghị OWASP): N=16384 (độ phức tạp CPU/bộ nhớ 2^14), r=8 (kích thước khối), p=1 (độ song song), keylen=32 bytes (độ dài khóa băm 256-bit). Cấu hình này giúp chống tấn công brute-force bằng GPU/ASIC.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

/**
 * Làm gì: Băm mật khẩu người dùng dạng plain text bằng thuật toán scrypt với salt ngẫu nhiên 16 bytes. Chuỗi kết quả đóng gói đầy đủ thông số scrypt, salt và hash để lưu trữ an toàn trong DB.
 * Được gọi ở:
 * - src/server/controllers/handlers/auth.ts (hàm handleRegister, handleResetPassword, handleChangePassword)
 * - src/server/controllers/handlers/members.ts (hàm handleCreateMember, handleResetMemberPassword)
 * - src/server/controllers/handlers/staff.ts (hàm handleCreateStaff, handleResetStaffPassword)
 * @param plain Mật khẩu gốc dạng chuỗi (plain text) người dùng nhập vào
 * @returns Chuỗi định dạng lưu trữ DB: `scrypt$N$r$p$salt$hash`
 * @throws Không ném lỗi
 */
export function hashPassword(plain: string): string {
  // Bước 1: Sinh chuỗi salt ngẫu nhiên 16 bytes (128 bits) bằng CSPRNG, mã hóa base64url để mỗi mật khẩu có một salt duy nhất (chống tấn công Rainbow Table)
  const salt = randomBytes(16).toString("base64url");
  // Bước 2: Băm mật khẩu kết hợp salt bằng hàm scryptSync với độ dài khóa băm 32 bytes (256 bits)
  const hash = scryptSync(plain, Buffer.from(salt, "base64url"), SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  }).toString("base64url");
  // Bước 3: Đóng gói thuật toán, các tham số chi phí N/r/p, salt và hash thành một chuỗi duy nhất để lưu trữ vào database
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${hash}`;
}

/**
 * Làm gì: Xác thực mật khẩu người dùng nhập vào có khớp với chuỗi hash scrypt đã lưu trong cơ sở dữ liệu hay không. Sử dụng timingSafeEqual để chống tấn công Timing Attack.
 * Được gọi ở:
 * - src/server/controllers/handlers/auth.ts (hàm handleLogin, handleChangePassword)
 * - src/server/controllers/session.ts (re-export cho auth/session)
 * - src/server/controllers/tx.test.ts (kiểm thử xác thực mật khẩu tạm thời)
 * @param plain Mật khẩu dạng plain text người dùng nhập vào để kiểm tra
 * @param stored Chuỗi hash đã lưu trong DB (định dạng `scrypt$N$r$p$salt$hash`)
 * @returns true nếu mật khẩu trùng khớp; false nếu sai mật khẩu hoặc định dạng stored hash không hợp lệ
 * @throws Không ném lỗi
 */
export function verifyPassword(plain: string, stored: string): boolean {
  // Bước 1: Phân tách chuỗi lưu trữ và kiểm tra tiền tố thuật toán ("scrypt") cùng số lượng thành phần (đúng 6 phần)
  const parts = stored.split("$");
  if (parts[0] !== "scrypt" || parts.length !== 6) return false;
  // Bước 2: Trích xuất các tham số cấu hình N, r, p, chuỗi salt và giá trị hash kỳ vọng đã lưu trong DB
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4]!;
  const expected = Buffer.from(parts[5]!, "base64url");
  // Bước 3: Băm mật khẩu người dùng nhập vào với đúng salt và các tham số N, r, p đã trích xuất
  const actual = scryptSync(plain, Buffer.from(salt, "base64url"), expected.length, { N, r, p });
  // Bước 4: Kiểm tra độ dài trước khi so sánh; nếu khác độ dài thì từ chối ngay lập tức
  if (actual.length !== expected.length) return false;
  // So sánh hai Buffer bằng timingSafeEqual với thời gian không đổi để ngăn chặn kẻ tấn công đo thời gian CPU nhằm đoán từng byte mật khẩu (Timing Attack)
  return timingSafeEqual(actual, expected);
}

/**
 * Làm gì: Tính mã băm SHA-256 của chuỗi đầu vào và trả về chuỗi biểu diễn dạng hexadecimal (64 ký tự).
 * Được gọi ở:
 * - src/server/controllers/helpers.ts (idempotency key cache cho API request)
 * - src/server/controllers/session.ts (hàm createSession, findSessionByToken)
 * - src/server/controllers/handlers/auth.ts (hàm extractBearerHash)
 * @param value Chuỗi ký tự cần băm
 * @returns Chuỗi băm hex 64 ký tự của value
 * @throws Không ném lỗi
 */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Làm gì: Sinh chuỗi token ngẫu nhiên an toàn bằng CSPRNG (randomBytes), mã hóa dạng base64url để an toàn khi dùng trong URL hoặc HTTP header.
 * Được gọi ở:
 * - src/server/controllers/session.ts (hàm createSession sinh session token)
 * - src/server/controllers/handlers/auth.ts (hàm handleRegister sinh mật khẩu tạm thời khi đăng ký)
 * @param bytes Số byte ngẫu nhiên cần sinh (mặc định 32 bytes = 256 bits entropy)
 * @returns Chuỗi token ngẫu nhiên định dạng base64url
 * @throws Không ném lỗi
 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * A six-digit OTP from the CSPRNG.
 *
 * `Math.random()` is a fast non-cryptographic PRNG whose internal state can be
 * recovered from a handful of outputs, so an attacker who has seen a few codes
 * can predict the next one. `randomBytes` is already used for session tokens
 * three lines up; the code that guards an account registration deserves the
 * same source.
 *
 * Rejection sampling rather than a plain modulo: 2^32 is not a multiple of
 * 900000, so `% 900000` alone would make the low codes measurably likelier.
 */
/**
 * Làm gì: Sinh mã xác thực OTP gồm 6 chữ số ngẫu nhiên an toàn (CSPRNG), phân phối xác suất đồng đều bằng kỹ thuật rejection sampling.
 * Được gọi ở:
 * - src/server/controllers/handlers/auth.ts (hàm sendOtp trong luồng đăng ký tài khoản và đặt lại mật khẩu)
 * - src/server/controllers/tx.test.ts (test runner)
 * @returns Chuỗi 6 chữ số từ "100000" đến "999999"
 * @throws Không ném lỗi
 */
export function randomOtp(): string {
  // Bước 1: Thiết lập không gian 900.000 mã (100000-999999) và tính ngưỡng chặn trên limit để loại bỏ phần dư thiên vị (rejection sampling)
  const RANGE = 900000;
  const limit = Math.floor(0xffffffff / RANGE) * RANGE;
  // Bước 2: Sinh số nguyên không dấu 32-bit từ 4 bytes CSPRNG; loại bỏ và sinh lại nếu giá trị rơi vào vùng thiên vị (>= limit)
  let n = randomBytes(4).readUInt32BE(0);
  while (n >= limit) n = randomBytes(4).readUInt32BE(0);
  // Bước 3: Lấy modulo RANGE rồi cộng 100000 để đảm bảo kết quả luôn là chuỗi đúng 6 chữ số
  return String(100000 + (n % RANGE));
}

/**
 * Keyed hash of an OTP, for storing a challenge.
 *
 * A six-digit code has only 900,000 possible values, so an unkeyed digest of
 * one is not a one-way function in any useful sense: the whole space hashes in
 * well under a second, and anybody who can read `otp_challenges` can invert
 * every row at once. HMAC under a server-side secret means the table alone is
 * not enough.
 *
 * `OTP_SECRET` unset falls back to a constant, which is no worse than what this
 * replaced — but it is a development posture, and `assertOtpSecret` refuses it
 * in production rather than letting it ship quietly.
 */
/**
 * Làm gì: Băm mã OTP bằng thuật toán HMAC-SHA256 kết hợp secret key phía server để lưu trữ challenge an toàn vào bảng otp_challenges.
 * Được gọi ở:
 * - src/server/controllers/handlers/auth.ts (hàm sendOtp khi tạo challenge, hàm verifyOtp khi xác thực mã OTP)
 * - src/server/controllers/tx.test.ts (test runner)
 * @param otp Mã OTP 6 chữ số cần băm
 * @returns Chuỗi mã băm HMAC định dạng hex
 * @throws Không ném lỗi
 */
export function hashOtp(otp: string): string {
  // Dùng HMAC kèm OTP_SECRET phía server để bảo vệ: vì OTP 6 số chỉ có 900.000 khả năng nên nếu băm thường sẽ bị dò ra ngay; secret ngăn kẻ có bản sao DB đảo ngược mã OTP
  return createHmac("sha256", process.env.OTP_SECRET || "arena3-dev-otp-secret")
    .update(otp)
    .digest("hex");
}

/** Whether OTP challenges are being keyed by a real secret. */
/**
 * Làm gì: Kiểm tra biến môi trường OTP_SECRET đã được thiết lập giá trị thực tế hay chưa, đảm bảo hệ thống không dùng secret mặc định khi triển khai production.
 * Được gọi ở: Dùng để kiểm tra trạng thái cấu hình bí mật OTP của server.
 * @returns true nếu OTP_SECRET đã được cấu hình và không rỗng; ngược lại false
 * @throws Không ném lỗi
 */
export function otpSecretConfigured(): boolean {
  return Boolean(process.env.OTP_SECRET?.trim());
}
