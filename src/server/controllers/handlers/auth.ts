/**
 * File: src/server/controllers/handlers/auth.ts
 * Vai trò: Xử lý toàn bộ logic nghiệp vụ xác thực (authentication) và tài khoản người dùng trong hệ thống Arena 3.
 * Bao gồm: đăng ký hội viên, gửi và xác thực OTP qua email/SMS, đăng nhập kèm khóa chống brute-force,
 * đăng xuất xóa session, đặt lại mật khẩu, và quản lý thông tin cá nhân (/me).
 * Được gọi từ src/server/controllers/router.ts để phục vụ các API route liên quan đến /auth/* và /me/*.
 */
import { verifyCaptcha } from "../../integrations/captcha";
import type { Sql } from "@/server/data/db";
import { hashOtp, hashPassword, randomOtp, randomToken, verifyPassword } from "../../services/crypto";
import { err } from "../errors";
import { ageYears, audit, getSettings, pageOf, readJson, str } from "../helpers";
import { isValidVnPhone, normalizePhone, passwordOk, unaccentVi } from "../../services/phone";
import { limit, RULES, requestIp } from "../ratelimit";
import {
  findUserByLogin,
  issueSession,
  loadUser,
  toPublic,
  type PublicUser,
} from "../session";
import { KeepWrites, one } from "../tx";
import { pageParams } from "../validate";

/**
 * Whether the OTP may be handed straight back to whoever asked for it.
 *
 * There is no SMS transport (see SRS §1.3), so registration and password reset
 * returned the code in the response body to keep the demo usable. That makes
 * the OTP no barrier at all: anyone can register — or reset the password of —
 * any phone number they can type, because the challenge and its answer arrive
 * in the same reply.
 *
 * It stays on for local work, where the alternative is an unusable sign-up
 * form, and goes off the moment the app is running for real. `OTP_ECHO=1`
 * forces it back on for a staged demo, deliberately and in writing, rather
 * than by default.
 */
function mayEchoOtp(): boolean {
  if (process.env.OTP_ECHO === "1") return true;
  if (process.env.OTP_ECHO === "0") return false;
  return process.env.NODE_ENV !== "production";
}

/**
 * Get the code to the person asking for it.
 *
 * Email is the only channel this centre can actually reach somebody on: SMS to
 * a Vietnamese number needs a registered sender ID, which needs a registered
 * company (see `notify.ts`). Returning a masked address rather than a bare
 * boolean lets the sign-up screen say "check nam@example.com" — the single most
 * useful thing it can tell somebody staring at an empty code box — without
 * echoing an address back to whoever typed it.
 */
async function deliverOtp(email: string | null | undefined, otp: string): Promise<{ sentTo: string | null }> {
  if (!email) return { sentTo: null };
  const { deliver } = await import("../../integrations/notify");
  const result = await deliver({ channel: "email", template: "otp", to: email, payload: { otp } });
  if (!result.sent) {
    console.warn(`[otp] could not email the code: ${result.detail ?? "unknown"}`);
    return { sentTo: null };
  }
  // Che địa chỉ email (ví dụ: na***@domain.com) để gợi ý cho người dùng kiểm tra hòm thư mà không làm lộ toàn bộ email.
  const [name, domain] = email.split("@");
  const masked = name && domain ? `${name.slice(0, 2)}${"*".repeat(Math.max(1, name.length - 2))}@${domain}` : null;
  return { sentTo: masked };
}

/** A new member's details, checked and ready to store. */
export type SignupFields = {
  full_name: string;
  phone: string;
  email: string | null;
  password_hash: string;
  dob: string | null;
  guardian_name: string | null;
  guardian_phone: string | null;
};

/**
 * The sign-up rules shared by the form (`register`) and Google (`googleRegister`).
 *
 * `password: false` is for Google: the person never chose one, so the account
 * gets a random one nobody knows, and "Forgot password" sets a real one later.
 * `email` is passed in rather than read from the body because Google's is the
 * verified one and must not be swapped for whatever the form sent.
 */
export async function checkSignup(
  sql: Sql,
  body: Record<string, unknown>,
  opts: { email: string | null; password: boolean },
): Promise<SignupFields> {
  // Bước 1: Trích xuất và chuẩn hóa các trường thông tin đăng ký từ body request.
  const full_name = str(body.full_name);
  const phone = normalizePhone(str(body.phone) ?? "");
  const password = opts.password ? str(body.password) : randomToken();
  const dob = str(body.dob) ?? str(body.date_of_birth) ?? null;
  const email = opts.email;
  const pii = body.pii_consent === true;
  // `field` names the input at fault, so the form can mark it and not only say what went wrong.
  // Bước 2: Kiểm tra tính hợp lệ của họ tên và định dạng số điện thoại Việt Nam.
  if (!full_name) throw err.validation("Full name is required.", { field: "full_name" });
  if (!isValidVnPhone(phone)) throw err.validation("That phone number is not valid.", { field: "phone" });
  // Quy tắc BR-02: Mật khẩu cần tối thiểu 8 ký tự, bao gồm cả chữ và số (bỏ qua nếu đăng ký qua tài khoản Google).
  if (!password || (opts.password && !passwordOk(password))) {
    throw err.br("BR-02", "Password needs at least 8 characters, with letters and numbers.", { field: "password" });
  }
  // Quy tắc BR-04: Bắt buộc người dùng phải chấp thuận điều khoản và chính sách bảo vệ dữ liệu cá nhân (PII).
  if (!pii) throw err.br("BR-04", "You must accept the terms and the data-privacy notice.");
  // Bước 3: Kiểm tra tính hợp lệ của ngày sinh (YYYY-MM-DD), độ tuổi thực tế (0 - 120 tuổi).
  // Quy tắc BR-03: Nếu người đăng ký là trẻ vị thành niên (< minor_age), bắt buộc phải có thông tin người giám hộ.
  if (dob) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(`${dob}T00:00:00+07:00`))) {
      throw err.validation("Use a date like 2010-05-31.", { field: "dob" });
    }
    const settings = await getSettings(sql);
    const age = ageYears(dob);
    if (age < 0 || age > 120) throw err.validation("That date of birth is not possible.", { field: "dob" });
    if (age < settings.minor_age) {
      const gn = str(body.guardian_name);
      const gp = str(body.guardian_phone);
      if (!gn || !gp) throw err.br("BR-03", "A minor needs guardian details.", { field: "guardian_name" });
    }
  }
  // Bước 4: Kiểm tra trùng lặp tài khoản (BR-01: số điện thoại hoặc email đã được sử dụng trước đó).
  const exists = await one(sql, `select id from users where phone = $1 or (email is not null and lower(email) = lower($2))`, [
    phone,
    email,
  ]);
  if (exists) throw err.br("BR-01", "That phone or email already has an account.");
  // Bước 5: Băm mật khẩu bằng hàm băm mật mã an toàn và trả về dữ liệu hội viên đã sẵn sàng lưu vào cơ sở dữ liệu.
  return {
    full_name,
    phone,
    email,
    password_hash: hashPassword(password),
    dob,
    guardian_name: str(body.guardian_name) ?? null,
    guardian_phone: str(body.guardian_phone) ? normalizePhone(String(body.guardian_phone)) : null,
  };
}

/** Insert a checked member and sign them in. Both sign-up paths end here. */
export async function createMember(sql: Sql, f: SignupFields, action: string) {
  // Bước 1: Kiểm tra lại số điện thoại một lần nữa để đảm bảo tính duy nhất trước khi thêm vào cơ sở dữ liệu (BR-01).
  const existing = await one(sql, `select id from users where phone = $1`, [f.phone]);
  if (existing) throw err.br("BR-01", "That phone number already has an account.");
  // Bước 2: Sinh mã hội viên tự động tiếp theo qua hàm SQL next_member_code(), sau đó thêm bản ghi mới vào bảng users.
  const codeRow = await one<{ next_member_code: string }>(sql, `select next_member_code() as next_member_code`);
  const inserted = await one<{ id: string }>(
    sql,
    `insert into users
       (full_name, name_normalized, phone, email, role, status, password_hash,
        date_of_birth, guardian_name, guardian_phone, pii_consent_at, member_code)
     values ($1,$2,$3,$4,'member','active',$5,$6,$7,$8, now(), $9)
     returning id`,
    [
      f.full_name,
      unaccentVi(f.full_name),
      f.phone,
      f.email,
      f.password_hash,
      f.dob,
      f.guardian_name,
      f.guardian_phone,
      codeRow?.next_member_code,
    ],
  );
  // Bước 3: Nạp lại thông tin người dùng vừa được tạo và ghi nhật ký kiểm toán (audit log) để lưu vết hành vi hệ thống.
  const user = await loadUser(sql, inserted!.id);
  await audit(sql, user.id, action, "user", user.id, null, { phone: f.phone });
  // Bước 4: Tạo phiên làm việc (session token) cho hội viên mới và trả về kết quả đăng ký thành công.
  return { status: 200, body: await issueSession(sql, user) };
}

// Initial sends and resends share guards: restarting the form cannot bypass them.
/**
 * Làm gì: Kiểm tra các tầng bảo vệ chống lạm dụng gửi OTP: bẫy honeypot, xác minh captcha Cloudflare, và giới hạn tần suất (rate limit) theo IP/số điện thoại/email.
 * Được gọi ở: register (bước 2, dòng 192), forgot (bước 2, dòng 332).
 * @param request HTTP Request đến, dùng để lấy địa chỉ IP của client qua requestIp().
 * @param body Dữ liệu JSON gửi lên chứa captcha_token, phone, email và trường honeypot website.
 * @returns true nếu vượt qua các bước kiểm tra hợp lệ; false nếu phát hiện bot (điền vào trường honeypot).
 * @throws Lỗi 400 validation nếu captcha không hợp lệ; lỗi 429 rateLimited nếu vượt quá giới hạn tần suất gửi mã.
 */
async function guardOtpSend(request: Request, body: Record<string, unknown>) {
  // Kỹ thuật honeypot: trường "website" là trường ẩn với người dùng thật, nếu có dữ liệu tức là bot tự động điền form.
  if (body.website) return false;
  await verifyCaptcha(body.captcha_token, requestIp(request));
  // Giới hạn tần suất gửi OTP: kiểm tra theo địa chỉ IP của client để chống spam từ một máy chủ/mạng.
  limit(`otp-send:ip:${requestIp(request)}`, RULES.authSendIp);
  // Giới hạn tần suất gửi OTP: kiểm tra theo từng số điện thoại người nhận để tránh lãng phí chi phí viễn thông.
  limit(`otp-send:phone:${normalizePhone(str(body.phone) ?? "")}`, RULES.authSendIdentity);
  const email = str(body.email)?.trim().toLowerCase();
  if (email) limit(`otp-send:email:${email}`, RULES.authSendIdentity);
  return true;
}

/**
 * Làm gì: Tạo mới hoặc làm mới thử thách OTP trong bảng otp_challenges, áp dụng khóa advisory lock tránh race condition, kiểm tra thời gian chờ 60s và dọn dẹp mã cũ.
 * Được gọi ở: register (dòng 198), forgot (dòng 342).
 * @param sql Kết nối transaction PostgreSQL hiện tại.
 * @param phone Số điện thoại người nhận mã OTP.
 * @param purpose Mục đích tạo OTP (ví dụ: 'register' để đăng ký, 'reset' để đặt lại mật khẩu).
 * @param otp Chuỗi ký tự mã OTP ngẫu nhiên cần lưu.
 * @param payload Dữ liệu tạm thời cần lưu trữ cùng phiên OTP (ví dụ: thông tin đăng ký của thành viên).
 * @returns Bản ghi thử thách OTP (chứa id của otp_challenges).
 * @throws Lỗi 429 rateLimited nếu người dùng yêu cầu gửi lại mã trong thời gian làm nguội (dưới 60 giây).
 */
async function replaceChallenge(sql: Sql, phone: string, purpose: string, otp: string, payload: unknown) {
  // Serialize even the first insert, which has no row to lock yet.
  await sql.query(`select pg_advisory_xact_lock(hashtext($1))`, [`otp:${phone}:${purpose}`]);
  // Bước 1: Tìm thử thách OTP đang chờ gần nhất và kiểm tra xem có đang trong thời gian làm nguội (cooling 60 giây) không.
  const pending = await one<{ id: string; cooling: boolean }>(sql,
    `select id, expires_at > now() + interval '4 minutes' as cooling
       from otp_challenges where phone=$1 and purpose=$2 order by expires_at desc limit 1 for update`,
    [phone, purpose]);
  // Bắt buộc người dùng phải đợi tối thiểu 60 giây giữa các lần yêu cầu gửi lại mã (cooldown).
  if (pending?.cooling) throw err.rateLimited("Wait 60 seconds before requesting another code.");
  // Bước 2: Nếu đã có OTP trước đó, cập nhật hash mã mới, đặt lại số lần thử về 0 và gia hạn hiệu lực 5 phút.
  if (pending) {
    await sql.query(`update otp_challenges set otp_hash=$2, payload=$3::jsonb,
      expires_at=now() + interval '5 minutes', attempts=0 where id=$1`,
      [pending.id, hashOtp(otp), JSON.stringify(payload)]);
    await sql.query(`delete from otp_challenges where phone=$1 and purpose=$2 and id<>$3`, [phone, purpose, pending.id]);
    return pending;
  }
  // Bước 3: Nếu chưa có thử thách OTP nào, tạo mới bản ghi vào bảng otp_challenges với thời hạn 5 phút.
  return (await one<{ id: string }>(sql,
    `insert into otp_challenges (phone,purpose,otp_hash,payload,expires_at)
     values ($1,$2,$3,$4::jsonb,now() + interval '5 minutes') returning id`,
    [phone,purpose,hashOtp(otp),JSON.stringify(payload)]))!;
}

/**
 * Làm gì: Trả về phản hồi giả định thành công (HTTP 202) khi phát hiện bot kích hoạt honeypot, đánh lừa bot mà không gửi OTP thật.
 * Được gọi ở: guardOtpSend khi bị bot kích hoạt (dòng 192 trong register, dòng 332 trong forgot).
 * @returns Đối tượng phản hồi HTTP với status 202 và sent_to là null.
 */
const silentOtpSuccess = () => ({ status: 202, body: { sent_to: null } });

/**
 * Làm gì: Tiếp nhận yêu cầu đăng ký tài khoản hội viên: kiểm tra bảo mật, xác thực thông tin nghiệp vụ, tạo và gửi mã thử thách OTP qua email.
 * Được gọi ở: API route POST /auth/register (src/server/controllers/router.ts:135); test runner (src/server/controllers/tx.test.ts).
 * @param sql Kết nối transaction PostgreSQL.
 * @param request HTTP Request chứa payload JSON gồm thông tin đăng ký của người dùng.
 * @returns Phản hồi HTTP 202 Accepted chứa challenge_id, email che và mã OTP (nếu ở môi trường demo/staging).
 * @throws Lỗi validation nếu thiếu trường bắt buộc, lỗi BR-01 nếu tài khoản trùng lặp, hoặc lỗi BR-02/BR-03/BR-04 theo quy tắc nghiệp vụ.
 */
export async function register(sql: Sql, request: Request) {
  // Bước 1: Đọc và parse dữ liệu JSON từ body của request gửi lên.
  const body = await readJson(request);
  // Bước 2: Kiểm tra các lớp phòng vệ (honeypot, captcha, rate limit). Nếu dính honeypot thì âm thầm trả về 202.
  if (!await guardOtpSend(request, body)) return silentOtpSuccess();
  // Bước 3: Xác thực tính hợp lệ của thông tin đăng ký theo các quy tắc nghiệp vụ (BR-01..BR-04).
  const fields = await checkSignup(sql, body, {
    email: str(body.email)?.trim().toLowerCase() || null,
    password: true,
  });
  // Bước 4: Sinh mã OTP ngẫu nhiên 6 chữ số và lưu thử thách vào bảng otp_challenges.
  const otp = randomOtp();
  const row = await replaceChallenge(sql, fields.phone, "register", otp, { ...fields, pii_consent: true });
  const email = fields.email;
  // Sent, not queued. An OTP lives five minutes; waiting for the next pass of
  // the outbox dispatcher would spend a meaningful part of that on nothing.
  // Bước 5: Gửi mã OTP trực tiếp qua email người dùng (nếu có cung cấp email).
  const delivery = await deliverOtp(email, otp);
  // Bước 6: Kiểm tra cờ cho phép trả về mã OTP trong response (chỉ bật ở môi trường local/staging để tiện kiểm thử).
  const echo = mayEchoOtp();
  // Bước 7: Trả về mã trạng thái HTTP 202 Accepted cùng challenge_id để client chuyển sang màn hình nhập OTP.
  return {
    status: 202,
    body: {
      challenge_id: row!.id,
      ...(echo ? { otp, staging: true } : {}),
      sent_to: delivery.sentTo,
      message: echo
        ? "OTP (demo environment) — enter it to verify."
        : "We have sent you a verification code.",
    },
  };
}

/**
 * Làm gì: Xác thực mã OTP người dùng nhập để kích hoạt tài khoản hội viên mới (tạo user và cấp session) hoặc xác nhận đặt lại mật khẩu mới.
 * Được gọi ở: API route POST /auth/otp/verify (src/server/controllers/router.ts:138); test runner (src/server/controllers/tx.test.ts).
 * @param sql Kết nối transaction PostgreSQL.
 * @param request HTTP Request chứa payload JSON gồm phone, otp, purpose ('register' | 'reset') và password mới (nếu reset).
 * @returns Phản hồi HTTP 200 chứa session mới khi đăng ký thành công, hoặc { ok: true } khi đặt lại mật khẩu thành công.
 * @throws Lỗi validation nếu mã OTP sai hoặc hết hạn, lỗi rateLimited nếu nhập sai quá 5 lần, hoặc lỗi nghiệp vụ BR-02 nếu mật khẩu mới không hợp lệ.
 */
export async function verifyOtp(sql: Sql, request: Request) {
  // Bước 1: Đọc body request và áp dụng rate limit xác thực OTP theo cả địa chỉ IP và số điện thoại.
  const body = await readJson(request);
  limit(`otp-verify:ip:${requestIp(request)}`, RULES.authVerifyIp);
  limit(`otp-verify:phone:${normalizePhone(str(body.phone) ?? "")}`, RULES.authVerifyIdentity);
  // Bước 2: Chuẩn hóa số điện thoại và lấy các tham số đầu vào (mã OTP, mục đích register hoặc reset).
  const phone = normalizePhone(str(body.phone) ?? "");
  const otp = str(body.otp);
  const purpose = str(body.purpose) ?? "register";
  if (!phone || !otp) throw err.validation("Phone or OTP is missing.");
  // Bước 3: Tìm bản ghi thử thách OTP mới nhất trong DB và khóa dòng bằng 'for update' để chống race condition.
  const ch = await one<{
    id: string;
    otp_hash: string;
    payload: Record<string, unknown>;
    expires_at: string;
    attempts: number;
    purpose: string;
  }>(
    sql,
    `select id, otp_hash, payload, expires_at::text, attempts, purpose
       from otp_challenges
      where phone = $1 and purpose = $2
      order by expires_at desc limit 1
      for update`,
    [phone, purpose],
  );
  // Kiểm tra sự tồn tại của OTP, giới hạn số lần thử (khóa 15 phút nếu thử sai >= 5 lần), và hạn sử dụng (5 phút).
  if (!ch) throw err.validation("No OTP request is pending.", { field: "otp" });
  if (ch.attempts >= 5) throw err.rateLimited("Too many OTP attempts — locked for 15 minutes.");
  if (new Date(ch.expires_at) < new Date()) throw err.validation("That OTP has expired.", { field: "otp" });
  // So khớp hash của mã OTP. Nếu sai, tăng số lần thử (attempts) và ném KeepWrites để lưu số lần sai kể cả khi rollback.
  if (ch.otp_hash !== hashOtp(otp)) {
    await sql.query(`update otp_challenges set attempts = attempts + 1 where id = $1`, [ch.id]);
    throw new KeepWrites(err.validation("That OTP is not correct.", { field: "otp" }));
  }
  // Bước 4: Xử lý theo mục đích: Nếu là 'reset', cập nhật mật khẩu mới (BR-02), thu hồi các phiên đăng nhập cũ, và xóa thử thách OTP.
  if (purpose === "reset") {
    const newPw = str(body.password);
    if (!newPw || !passwordOk(newPw)) throw err.br("BR-02", "The new password is not valid.", { field: "password" });
    await sql.query(`update users set password_hash = $1, failed_logins = 0, locked_until = null where phone = $2`, [
      hashPassword(newPw),
      phone,
    ]);
    const u = await one<{ id: string }>(sql, `select id from users where phone = $1`, [phone]);
    if (u) await sql.query(`update sessions_auth set revoked_at = now() where user_id = $1 and revoked_at is null`, [u.id]);
    await sql.query(`delete from otp_challenges where id = $1`, [ch.id]);
    return { status: 200, body: { ok: true } };
  }
  // Bước 5: Nếu là 'register', xóa bản ghi thử thách OTP và gọi hàm createMember để tạo người dùng mới cùng phiên đăng nhập.
  const p = ch.payload ?? {};
  await sql.query(`delete from otp_challenges where id = $1`, [ch.id]);
  return createMember(
    sql,
    {
      full_name: String(p.full_name),
      phone,
      email: (p.email as string | null) ?? null,
      password_hash: String(p.password_hash),
      dob: (p.dob as string | null) ?? null,
      guardian_name: (p.guardian_name as string | null) ?? null,
      guardian_phone: (p.guardian_phone as string | null) ?? null,
    },
    "register",
  );
}

/**
 * Làm gì: Xác thực đăng nhập của người dùng qua số điện thoại/email và mật khẩu; tự động khóa tài khoản 15 phút nếu sai mật khẩu 5 lần; cấp session token khi thành công.
 * Được gọi ở: API route POST /auth/login (src/server/controllers/router.ts:141); test runner (src/server/controllers/tx.test.ts).
 * @param sql Kết nối transaction PostgreSQL.
 * @param request HTTP Request chứa payload JSON gồm định danh đăng nhập (login/phone/email) và mật khẩu (password).
 * @returns Phản hồi HTTP 200 chứa session token và thông tin công khai của người dùng (PublicUser).
 * @throws Lỗi 400 validation nếu thiếu thông tin, lỗi 401 unauth nếu sai tài khoản/mật khẩu hoặc tài khoản chưa kích hoạt, lỗi 429 rateLimited nếu tài khoản đang bị khóa.
 */
export async function login(sql: Sql, request: Request) {
  // Bước 1: Đọc body request và trích xuất định danh đăng nhập (email hoặc số điện thoại) cùng mật khẩu.
  const body = await readJson(request);
  const loginId = str(body.login) ?? str(body.phone) ?? str(body.email);
  const password = str(body.password);
  if (!loginId || !password) throw err.validation("Enter your login and password.");
  // Bước 2: Chuẩn hóa định danh (chuyển chữ thường nếu là email, chuẩn hóa định dạng số ĐT VN) và tìm tài khoản trong DB.
  const ident = loginId.includes("@") ? loginId.trim().toLowerCase() : normalizePhone(loginId);
  const user = await findUserByLogin(sql, ident);
  // Kiểm tra trạng thái tài khoản: bắt buộc phải tồn tại và có status là 'active'.
  if (!user) throw err.unauth("Wrong login or password.");
  if (user.status !== "active") throw err.unauth("This account is not active.");
  // Bước 3: Kiểm tra xem tài khoản có đang trong thời gian bị khóa tạm thời (locked_until) do nhập sai mật khẩu nhiều lần không.
  const locked = await one<{ locked_until: string | null; failed_logins: number }>(
    sql,
    `select locked_until::text, failed_logins from users where id = $1`,
    [user.id],
  );
  if (locked?.locked_until && new Date(locked.locked_until) > new Date()) {
    throw err.rateLimited("This account is locked for 15 minutes.");
  }
  // Bước 4: Kiểm tra mật khẩu bằng verifyPassword. Nếu sai, tăng failed_logins và tự động khóa 15 phút nếu sai từ 5 lần trở lên.
  if (!verifyPassword(password, user.password_hash)) {
    const fails = (locked?.failed_logins ?? 0) + 1;
    if (fails >= 5) {
      await sql.query(
        `update users set failed_logins = $1, locked_until = now() + interval '15 minutes' where id = $2`,
        [fails, user.id],
      );
      throw new KeepWrites(err.rateLimited("5 wrong passwords — locked for 15 minutes."));
    }
    await sql.query(`update users set failed_logins = $1 where id = $2`, [fails, user.id]);
    throw new KeepWrites(err.unauth("Wrong login or password."));
  }
  // Bước 5: Đăng nhập thành công, đặt lại failed_logins về 0 và gỡ bỏ trạng thái khóa của tài khoản.
  await sql.query(`update users set failed_logins = 0, locked_until = null where id = $1`, [user.id]);
  // Bước 6: Khởi tạo phiên làm việc mới (issueSession) và trả về session token cùng thông tin người dùng cho client.
  const session = await issueSession(sql, toPublic(user));
  return { status: 200, body: session };
}

/** sha256 of the bearer token on this request, or null. Never returned to the client. */
async function currentTokenHash(request: Request): Promise<string | null> {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!m) return null;
  const { sha256 } = await import("../../services/crypto");
  return sha256(m[1]!);
}

/**
 * Làm gì: Đăng xuất người dùng bằng cách xóa phiên làm việc hiện tại (bản ghi token hash trong bảng sessions_auth) ứng với Bearer token của request.
 * Được gọi ở: API route POST /auth/logout (src/server/controllers/router.ts:235).
 * @param sql Kết nối transaction PostgreSQL.
 * @param request HTTP Request chứa header Authorization mang Bearer token cần đăng xuất.
 * @param user Thông tin người dùng hiện tại đã xác thực từ session.
 * @returns Phản hồi HTTP 204 No Content thông báo đã đăng xuất thành công.
 */
export async function logout(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Băm chuỗi token từ header Authorization để tìm và xóa phiên làm việc tương ứng trong bảng sessions_auth.
  const hash = await currentTokenHash(request);
  if (hash) {
    await sql.query(`delete from sessions_auth where token_hash = $1 and user_id = $2`, [
      hash,
      user.id,
    ]);
  }
  // Bước 2: Trả về mã trạng thái HTTP 204 No Content biểu thị việc đăng xuất hoàn tất.
  return { status: 204, body: null };
}

/**
 * Làm gì: Khởi tạo quy trình đặt lại mật khẩu: kiểm tra rate limit, tạo mã thử thách OTP và gửi mã xác nhận đến email đã đăng ký của tài khoản.
 * Được gọi ở: API route POST /auth/password/forgot (src/server/controllers/router.ts:167); test runner (src/server/controllers/tx.test.ts).
 * @param sql Kết nối transaction PostgreSQL.
 * @param request HTTP Request chứa payload JSON gồm số điện thoại và captcha token.
 * @returns Phản hồi HTTP 202 Accepted chứa challenge_id, email che và mã OTP (nếu ở môi trường demo/staging).
 * @throws Lỗi validation nếu số điện thoại không hợp lệ; lỗi 429 rateLimited nếu gửi yêu cầu quá thường xuyên.
 */
export async function forgot(sql: Sql, request: Request) {
  // Bước 1: Đọc và parse dữ liệu JSON từ body của request gửi lên.
  const body = await readJson(request);
  // Bước 2: Kiểm tra giới hạn tần suất gửi OTP và xác minh captcha qua guardOtpSend; nếu vượt ngưỡng trả về silentOtpSuccess (202 giả lập) để tránh lộ thông tin số điện thoại.
  if (!await guardOtpSend(request, body)) return silentOtpSuccess();
  // Bước 3: Chuẩn hóa số điện thoại về định dạng chuẩn và xác thực đầu số di động Việt Nam hợp lệ qua isValidVnPhone.
  const phone = normalizePhone(str(body.phone) ?? "");
  if (!isValidVnPhone(phone)) throw err.validation("That phone number is not valid.", { field: "phone" });
  // Bước 4: Tìm tài khoản trong bảng users theo số điện thoại để lấy địa chỉ email gửi mã OTP đặt lại mật khẩu.
  const user = await one<{ id: string; email: string | null }>(
    sql,
    `select id, email from users where phone = $1`,
    [phone],
  );
  // Giới hạn tần suất gửi OTP theo từng email để chống hành vi làm phiền hoặc spam hòm thư người dùng.
  if (user?.email) limit(`otp-send:email:${user.email.trim().toLowerCase()}`, RULES.authSendIdentity);
  // Bước 5: Sinh mã OTP ngẫu nhiên 6 chữ số và tạo bản ghi thử thách (challenge) loại 'reset' vào bảng auth_challenges.
  const otp = randomOtp();
  const row = await replaceChallenge(sql, phone, "reset", otp, {});
  // Only a real account gets a message; the response looks the same either
  // way so this cannot be used to find out who has an account here.
  // Bước 6: Gửi mã OTP qua email nếu tài khoản có thật trong hệ thống; trả về sentTo đã được che bớt (masked).
  const delivery = user ? await deliverOtp(user.email, otp) : { sentTo: null };
  const echo = mayEchoOtp();
  // Bước 7: Trả về HTTP 202 Accepted kèm challenge_id; chỉ echo mã OTP trực tiếp trong môi trường dev/staging (mayEchoOtp).
  return {
    status: 202,
    body: {
      challenge_id: row!.id,
      ...(echo && user ? { otp, staging: true } : {}),
      sent_to: delivery.sentTo,
    },
  };
}

/**
 * Làm gì: Lấy thông tin tổng hợp của người dùng hiện tại (gói hội viên, hộp thư thông báo, lịch đặt sân và lớp học hôm nay, danh sách lớp đăng ký, lời mời hàng chờ và feature flags).
 * Được gọi ở: src/server/controllers/router.ts (route GET /v1/me hoặc GET /me); src/routes/app.index.tsx (màn hình chính dashboard); src/client/components/shell.tsx.
 * @param sql Kết nối database để thực hiện đồng thời các truy vấn.
 * @param user Thông tin người dùng đã xác thực từ token (PublicUser).
 * @returns Phản hồi HTTP 200 kèm body chứa toàn bộ dữ liệu tổng hợp cá nhân của người dùng.
 */
export async function meGet(sql: Sql, user: PublicUser) {
  // Seven independent reads. Awaited one at a time this was the slowest request
  // in the app — and it is on the critical path of every sign-in. Issued
  // together they each land on their own pooled connection, so the handler
  // costs one round trip instead of seven.
  // Bước 1: Thực thi song song 7 truy vấn độc lập qua Promise.all trên pool kết nối để giảm độ trễ (chỉ mất 1 round-trip).
  const [subs, inbox, today, classesToday, enrollments, offers, flags] = await Promise.all([
    // Truy vấn 1: Lấy danh sách gói hội viên của người dùng kèm số giờ thuê sân và số buổi tập còn lại, ưu tiên gói active.
    sql.query(
      `select s.id, s.plan_id, s.start_on::text, s.end_on::text, s.status,
              s.court_hours_left, s.session_left, p.name as plan_name, p.court_discount_pct,
              p.court_hours as plan_court_hours, p.session_quota as plan_session_quota
         from subscriptions s
         join membership_plans p on p.id = s.plan_id
        where s.user_id = $1
        order by s.status = 'active' desc, s.end_on desc`,
      [user.id],
    ),
    // Truy vấn 2: Lấy tối đa 30 thông báo mới nhất trong hộp thư cá nhân (inbox) của người dùng.
    sql.query(
      `select id, template, payload, sent_at, read_at from inbox
        where user_id = $1 order by sent_at desc limit 30`,
      [user.id],
    ),
    // Truy vấn 3: Lấy các lượt đặt sân trong ngày hôm nay theo múi giờ Việt Nam (Asia/Ho_Chi_Minh) có trạng thái hold, confirmed hoặc in_use.
    sql.query(
      `select b.id, b.code, b.start_at, b.end_at, b.status, b.court_id, c.court_code
         from court_bookings b join courts c on c.id = b.court_id
        where b.user_id = $1
          and (b.start_at at time zone 'Asia/Ho_Chi_Minh')::date
              = (now() at time zone 'Asia/Ho_Chi_Minh')::date
          and b.status in ('hold','confirmed','in_use')
        order by b.start_at`,
      [user.id],
    ),
    // Truy vấn 4: Lấy các buổi học của lớp người dùng đã đăng ký (confirmed) diễn ra trong ngày hôm nay.
    sql.query(
      `select s.id, s.start_at, s.end_at, cl.level, cl.sport, c.court_code, u.full_name as coach_name
         from sessions s
         join classes cl on cl.id = s.class_id
         join enrollments e on e.class_id = cl.id and e.user_id = $1 and e.status = 'confirmed'
         join courts c on c.id = s.court_id
         join users u on u.id = cl.coach_id
        where s.status = 'scheduled'
          and (s.start_at at time zone 'Asia/Ho_Chi_Minh')::date
              = (now() at time zone 'Asia/Ho_Chi_Minh')::date
        order by s.start_at`,
      [user.id],
    ),
    // Truy vấn 5: Lấy danh sách lớp đã đăng ký hoặc đang ở hàng chờ (waitlisted) kèm thời hạn được phép hủy lớp (leave_until) theo BR-24.
    sql.query(
      // `leave_until` is the last moment leaving is allowed (BR-24: cancel_class_hours before the
      // next session), worked out here with the same rule enrollmentDelete applies.
      `select e.id, e.status,
              case when e.status = 'waitlisted' then (select count(*) from enrollments w where w.class_id = e.class_id and w.status = 'waitlisted' and (w.waitlist_pos, w.id) <= (e.waitlist_pos, e.id)) end as waitlist_pos,
              e.class_id, cl.sport, cl.level, cl.rrule, c.court_code,
              nx.start_at as next_session_at,
              nx.start_at - make_interval(hours => st.cancel_class_hours) as leave_until
         from enrollments e
         join classes cl on cl.id = e.class_id
         join courts c on c.id = cl.court_id
         cross join (select cancel_class_hours from center_settings where id = 1) st
         left join lateral (
           select s.start_at from sessions s
            where s.class_id = e.class_id and s.status = 'scheduled' and s.start_at > now()
            order by s.start_at limit 1
         ) nx on true
        where e.user_id = $1 and e.status in ('confirmed','waitlisted')`,
      [user.id],
    ),
    // Truy vấn 6: Lấy danh sách lời mời nhận chỗ từ hàng chờ (waitlist offers) còn hiệu lực và đang chờ phản hồi.
    sql.query(
      `select o.id, o.expires_at, o.status, e.class_id, cl.sport, cl.level
         from waitlist_offers o
         join enrollments e on e.id = o.enrollment_id
         join classes cl on cl.id = e.class_id
        where e.user_id = $1 and o.status = 'pending' and o.expires_at > now()`,
      [user.id],
    ),
    // Truy vấn 7: Lấy toàn bộ danh sách cờ tính năng (feature_flags) đang được bật/tắt trong hệ thống.
    sql.query<{ key: string; enabled: boolean }>(`select key, enabled from feature_flags`),
  ]);
  // Bước 2: Tổng hợp dữ liệu từ 7 truy vấn và trả về cho client với mã trạng thái HTTP 200.
  return {
    status: 200,
    body: {
      user,
      subscriptions: subs,
      inbox,
      enrollments,
      offers,
      flags: Object.fromEntries(flags.map((f) => [f.key, f.enabled])),
      today: { bookings: today, classes: classesToday },
    },
  };
}

/**
 * Mark notifications read. One id, or every unread one when none is named.
 * Scoped to the caller: someone else's id simply matches nothing.
 */
/**
 * The inbox a page at a time, newest first. Without `?limit` the caller gets the newest 100 as
 * before; `?unread=1` keeps only what is still unread. `unread` always counts the whole inbox,
 * so the bell can ask for `?limit=1` and still be right.
 */
export async function meNotifications(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Đọc tham số phân trang limit và offset từ query string của request (mặc định và tối đa 100 mục mỗi trang).
  const { limit, offset } = pageParams(request, { def: 100, max: 100 });
  // Bước 2: Kiểm tra cờ unread=1 để xác định có lọc riêng các thông báo chưa đọc hay không.
  const onlyUnread = new URL(request.url).searchParams.get("unread") === "1";
  // Bước 3: Truy vấn danh sách thông báo theo phân trang, dùng count(*) over() để lấy tổng số thông báo phù hợp bộ lọc.
  const rows = await sql.query<{ total: number } & Record<string, unknown>>(
    `select id, template, payload, sent_at, read_at, count(*) over ()::int as total from inbox
      where user_id = $1 and (not $2::bool or read_at is null)
      order by sent_at desc limit $3 offset $4`,
    [user.id, onlyUnread, limit, offset],
  );
  // Bước 4: Đếm tổng số thông báo chưa đọc trong toàn bộ hộp thư để cập nhật số đếm trên biểu tượng chuông thông báo.
  const unread = await one<{ n: number }>(
    sql,
    `select count(*)::int as n from inbox where user_id = $1 and read_at is null`,
    [user.id],
  );
  // Bước 5: Đóng gói kết quả thành đối tượng phân trang chuẩn hóa thông qua helper pageOf.
  const page = await pageOf(rows, { limit, offset }, async () =>
    ((await one<{ n: number }>(
      sql,
      `select count(*)::int as n from inbox where user_id = $1 and (not $2::bool or read_at is null)`,
      [user.id, onlyUnread],
    ))?.n ?? 0),
  );
  // Bước 6: Trả về HTTP 200 kèm danh sách thông báo phân trang và số lượng thông báo chưa đọc.
  return { status: 200, body: { ...page, unread: unread?.n ?? 0 } };
}

/**
 * Làm gì: Đánh dấu thông báo trong hộp thư là đã đọc (đánh dấu một thông báo theo id cụ thể, hoặc toàn bộ thông báo chưa đọc nếu không truyền id).
 * Được gọi ở: src/server/controllers/router.ts (route POST /v1/me/notifications/read hoặc POST /me/notifications/read); src/client/components/notifications.tsx; src/client/components/shell.tsx.
 * @param sql Kết nối database để cập nhật thời điểm đọc trong bảng outbox.
 * @param request Yêu cầu HTTP chứa body JSON (tùy chọn thuộc tính id).
 * @param user Thông tin người dùng hiện tại từ token xác thực (PublicUser).
 * @returns Phản hồi HTTP 200 chứa số lượng thông báo đã được đánh dấu đọc ({ marked: number }).
 * @throws ApiError 400 nếu id thông báo truyền lên không phải định dạng UUID hợp lệ.
 */
export async function meNotificationsRead(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Đọc body JSON từ request, fallback về object rỗng nếu client không gửi body.
  const body = await readJson(request).catch(() => ({}) as Record<string, unknown>);
  // Bước 2: Kiểm tra id thông báo; nếu có truyền thì bắt buộc phải đúng định dạng UUID 36 ký tự.
  const id = str(body.id);
  if (id && !/^[0-9a-f-]{36}$/i.test(id)) throw err.field("id", "That notification id is not valid.");
  // Bước 3: Cập nhật read_at = now() trong bảng outbox cho kênh inapp của người dùng (nếu id là null thì cập nhật tất cả).
  const rows = await sql.query(
    `update outbox set read_at = now()
      where user_id = $1 and channel = 'inapp' and sent_at is not null and read_at is null
        and ($2::uuid is null or id = $2::uuid)
      returning id`,
    [user.id, id ?? null],
  );
  // Bước 4: Trả về HTTP 200 kèm số lượng bản ghi thông báo vừa được đánh dấu đã đọc.
  return { status: 200, body: { marked: rows.length } };
}

/**
 * Làm gì: Cập nhật thông tin hồ sơ của người dùng hiện tại (họ và tên, ghi chú sức khỏe cho hội viên).
 * Được gọi ở: src/server/controllers/router.ts (route PATCH /v1/me hoặc PATCH /me); src/routes/account.tsx.
 * @param sql Kết nối database để cập nhật bảng users.
 * @param request Yêu cầu HTTP chứa body JSON với các trường cần sửa (full_name, health_notes).
 * @param user Thông tin người dùng hiện tại từ token xác thực (PublicUser).
 * @returns Phản hồi HTTP 200 chứa thông tin người dùng mới nhất sau khi cập nhật ({ user: PublicUser }).
 * @throws ApiError 400 nếu cố thay đổi phone/email trực tiếp hoặc dữ liệu không hợp lệ; lỗi 429 nếu vượt giới hạn tần suất.
 */
export async function mePatch(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Đọc body JSON từ request.
  const body = await readJson(request);
  // Nghiệp vụ: Đổi số điện thoại hoặc email yêu cầu xác thực OTP qua luồng riêng, không được đổi trực tiếp tại API này.
  if (body.phone || body.email) {
    throw err.validation("Changing phone or email needs an OTP (slice 2).");
  }
  // Giới hạn tần suất cập nhật hồ sơ để chống lạm dụng gửi request sửa thông tin liên tục.
  limit(`profile:${user.id}`, RULES.profileUpdate, "profile updates");
  // Bước 2: Xác thực và chuẩn hóa họ và tên (bắt buộc nhập, tối đa 120 ký tự).
  let full_name = user.full_name;
  if (body.full_name !== undefined) {
    const name = typeof body.full_name === "string" ? body.full_name.trim() : "";
    if (!name) throw err.field("full_name", "Full name is required.");
    if (name.length > 120) throw err.field("full_name", "Full name must be at most 120 characters.");
    full_name = name;
  }
  // Health notes are read by coaches before a member's session; staff have none (D1).
  // Bước 3: Xác thực ghi chú sức khỏe (tối đa 1000 ký tự); chỉ áp dụng cho vai trò member (HLV sẽ xem trước buổi tập theo D1).
  let health_notes = user.health_notes;
  if (user.role === "member" && body.health_notes !== undefined) {
    const notes = typeof body.health_notes === "string" ? body.health_notes.trim() : "";
    if (notes.length > 1000) throw err.field("health_notes", "Health notes must be at most 1000 characters.");
    health_notes = notes || null;
  }
  // Bước 4: Cập nhật họ tên, họ tên bỏ dấu (name_normalized qua unaccentVi để tìm kiếm) và ghi chú sức khỏe vào bảng users.
  await sql.query(
    `update users set full_name = $1, name_normalized = $2, health_notes = $3 where id = $4`,
    [full_name, unaccentVi(full_name), health_notes ?? null, user.id],
  );
  // Bước 5: Tải lại thông tin người dùng đầy đủ từ DB qua loadUser và trả về HTTP 200.
  return { status: 200, body: { user: await loadUser(sql, user.id) } };
}

/**
 * Làm gì: Lấy thông tin hồ sơ chi tiết theo vai trò (thông tin người giám hộ cho hội viên, môn dạy và thù lao cho HLV, kèm số phiên đăng nhập khác).
 * Được gọi ở: src/server/controllers/router.ts (route GET /v1/me/profile hoặc GET /me/profile); src/routes/account.tsx.
 * @param sql Kết nối database để truy vấn dữ liệu chi tiết người dùng.
 * @param request Yêu cầu HTTP dùng để trích xuất token hash của phiên hiện tại.
 * @param user Thông tin người dùng hiện tại từ token xác thực (PublicUser).
 * @returns Phản hồi HTTP 200 chứa guardian, pii_consent_at, coach, other_sessions.
 */
export async function meProfile(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Băm mã token Bearer của request hiện tại để loại trừ khi đếm các phiên đăng nhập khác.
  const here = await currentTokenHash(request);

  // Chuẩn bị truy vấn thông tin người giám hộ và thời điểm đồng ý PII trong bảng users.
  const userQuery = sql.query<{
    guardian_name: string | null;
    guardian_phone: string | null;
    pii_consent_at: Date | string | null;
  }>(
    `select guardian_name, guardian_phone, pii_consent_at from users where id = $1`,
    [user.id],
  );

  // Chuẩn bị truy vấn đếm số lượng phiên đăng nhập khác còn hiệu lực và chưa bị thu hồi trong sessions_auth.
  const sessionsQuery = sql.query<{ n: number }>(
    `select count(*)::int as n from sessions_auth
      where user_id = $1 and revoked_at is null and expires_at > now()
        and ($2::text is null or token_hash <> $2)`,
    [user.id, here],
  );

  // Bước 2: Nhánh xử lý riêng cho HLV: truy vấn danh sách môn dạy (coach_sports) và định mức thù lao (coach_rates).
  if (user.role === "coach") {
    const coachSportsQuery = sql.query<{ sports: string[] | null }>(
      `select array_agg(sport::text order by sport) as sports from coach_sports where user_id = $1`,
      [user.id],
    );
    const coachRatesQuery = sql.query<{ per_session_vnd: number; per_student_vnd: number }>(
      `select per_session_vnd, per_student_vnd from coach_rates where coach_id = $1`,
      [user.id],
    );

    // Thực thi song song 3 truy vấn dành cho HLV qua Promise.all.
    const [sessionsRows, sportsRows, ratesRows] = await Promise.all([
      sessionsQuery,
      coachSportsQuery,
      coachRatesQuery,
    ]);

    const sportsRow = sportsRows[0];
    const ratesRow = ratesRows[0];
    const other_sessions = Number(sessionsRows[0]?.n ?? 0);

    // Trả về hồ sơ HLV: danh sách môn dạy, thù lao mỗi buổi (mặc định 150.000 VNĐ) và thù lao mỗi học viên (mặc định 10.000 VNĐ).
    return {
      status: 200,
      body: {
        guardian: null,
        pii_consent_at: null,
        coach: {
          sports: sportsRow?.sports ?? [],
          per_session_vnd: ratesRow?.per_session_vnd != null ? Number(ratesRow.per_session_vnd) : 150000,
          per_student_vnd: ratesRow?.per_student_vnd != null ? Number(ratesRow.per_student_vnd) : 10000,
        },
        other_sessions,
      },
    };
  }

  // Bước 3: Nhánh xử lý cho hội viên và nhân viên: thực thi song song truy vấn user và đếm phiên đăng nhập.
  const [userRows, sessionsRows] = await Promise.all([userQuery, sessionsQuery]);
  const uRow = userRows[0];
  const other_sessions = Number(sessionsRows[0]?.n ?? 0);

  // Bước 4: Trích xuất thông tin người giám hộ và thời điểm đồng ý điều khoản PII nếu là vai trò member.
  let guardian: { name: string | null; phone: string | null } | null = null;
  let pii_consent_at: string | null = null;

  if (user.role === "member" && uRow) {
    if (uRow.guardian_name || uRow.guardian_phone) {
      guardian = {
        name: uRow.guardian_name ?? null,
        phone: uRow.guardian_phone ?? null,
      };
    }
    if (uRow.pii_consent_at) {
      pii_consent_at = new Date(uRow.pii_consent_at).toISOString();
    }
  }

  // Bước 5: Trả về HTTP 200 kèm thông tin người giám hộ và số phiên đăng nhập khác đang hoạt động.
  return {
    status: 200,
    body: {
      guardian,
      pii_consent_at,
      coach: null,
      other_sessions,
    },
  };
}

/**
 * Làm gì: Thu hồi (đăng xuất) tất cả các phiên đăng nhập khác của người dùng hiện tại, ngoại trừ phiên trên thiết bị đang gửi yêu cầu.
 * Được gọi ở: src/server/controllers/router.ts (route POST /v1/me/sessions/sign-out-others hoặc POST /me/sessions/sign-out-others); src/routes/account.tsx.
 * @param sql Kết nối database để cập nhật bảng sessions_auth và ghi nhật ký audit.
 * @param request Yêu cầu HTTP chứa token Bearer của phiên hiện tại.
 * @param user Thông tin người dùng hiện tại từ token xác thực (PublicUser).
 * @returns Phản hồi HTTP 200 chứa số lượng phiên đăng nhập khác đã bị thu hồi ({ signed_out: number }).
 * @throws ApiError 401 nếu request không có Bearer token hợp lệ; lỗi 429 nếu thực hiện quá tần suất cho phép.
 */
export async function meSignOutOthers(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Lấy mã băm token của phiên hiện tại; từ chối 401 nếu không tìm thấy token hợp lệ.
  const here = await currentTokenHash(request);
  if (!here) throw err.unauth();
  // Giới hạn tần suất thao tác đăng xuất các thiết bị khác để chống spam request.
  limit(`signout:${user.id}`, RULES.profileUpdate, "profile updates");
  // Bước 2: Cập nhật revoked_at = now() cho tất cả các phiên trong sessions_auth của người dùng ngoại trừ phiên hiện tại (token_hash <> here).
  const revoked = await sql.query<{ id: string }>(
    `update sessions_auth set revoked_at = now()
      where user_id = $1 and revoked_at is null and token_hash <> $2
      returning id`,
    [user.id, here],
  );
  // Bước 3: Ghi nhật ký kiểm toán (audit log) ghi nhận hành động thu hồi các phiên đăng nhập khác.
  await audit(sql, user.id, "sign_out_other_sessions", "user", user.id);
  // Bước 4: Trả về HTTP 200 kèm số lượng phiên đăng nhập vừa bị thu hồi thành công.
  return { status: 200, body: { signed_out: revoked.length } };
}

/**
 * Change your own password.
 *
 * The current password is required even though the caller is already
 * authenticated — a session left open on a shared desk machine should not be
 * enough to lock the real owner out. Rate limited because the current-password
 * check is otherwise a free password oracle for whoever is sitting at that
 * machine.
 */
export async function mePassword(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Đọc body JSON và lấy mật khẩu hiện tại, mật khẩu mới cùng mật khẩu xác nhận.
  const body = await readJson(request);
  const current = str(body.current_password) ?? "";
  const next = str(body.new_password) ?? "";
  const confirm = str(body.confirm_password);
  // Bước 2: Xác thực tính hợp lệ của mật khẩu mới: bắt buộc nhập, khớp xác nhận, đủ độ phức tạp (>=8 ký tự, có chữ và số) và khác mật khẩu cũ.
  if (!current || !next) throw err.validation("current_password and new_password are required.");
  if (confirm !== undefined && confirm !== next) {
    throw err.validation("The two new passwords do not match.", { field: "confirm_password" });
  }
  // Giới hạn tần suất đổi mật khẩu để chống brute-force mật khẩu hiện tại thông qua oracle check.
  limit(`pw:${user.id}`, RULES.passwordChange, "password changes");
  if (!passwordOk(next)) {
    throw err.validation("Use at least 8 characters with a letter and a number.", { field: "new_password" });
  }
  if (next === current) {
    throw err.validation("Pick a password you have not used here before.", { field: "new_password" });
  }
  // Bước 3: Lấy password_hash từ bảng users và xác thực mật khẩu hiện tại qua verifyPassword.
  const row = await one<{ password_hash: string }>(sql, `select password_hash from users where id = $1`, [user.id]);
  if (!row || !verifyPassword(current, row.password_hash)) {
    throw err.validation("That is not your current password.", { field: "current_password" });
  }
  // Bước 4: Băm mật khẩu mới qua hashPassword, cập nhật vào bảng users, đồng thời reset must_change_password và số lần đăng nhập sai (failed_logins).
  await sql.query(
    `update users set password_hash = $1, must_change_password = false, failed_logins = 0, locked_until = null
      where id = $2`,
    [hashPassword(next), user.id],
  );
  // Every other device has to sign in again with the new password; this one stays signed in (D2).
  // Bước 5: Thu hồi tất cả các phiên đăng nhập khác trong sessions_auth theo quy tắc D2 (chỉ giữ lại phiên hiện tại).
  const here = await currentTokenHash(request);
  const revoked = await sql.query<{ id: string }>(
    `update sessions_auth set revoked_at = now()
      where user_id = $1 and revoked_at is null and ($2::text is null or token_hash <> $2)
      returning id`,
    [user.id, here],
  );
  // Bước 6: Ghi nhật ký kiểm toán (audit log) ghi nhận người dùng đã đổi mật khẩu thành công.
  await audit(sql, user.id, "change_password", "user", user.id);
  // Bước 7: Trả về HTTP 200 xác nhận thành công kèm số lượng phiên đăng nhập khác đã bị đăng xuất.
  return { status: 200, body: { ok: true, signed_out: revoked.length } };
}
