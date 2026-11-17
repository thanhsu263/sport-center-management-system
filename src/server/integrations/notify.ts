/**
 * File: src/server/integrations/notify.ts
 * Module chuyển phát thông báo (notifications) của hệ thống Arena3.
 * Đóng vai trò là tầng tích hợp vận chuyển (transport layer) cho thông báo email và in-app.
 * Nhận thông điệp từ tiến trình hàng đợi outbox hoặc gọi trực tiếp (như gửi mã OTP đăng ký),
 * sau đó điều hướng đến đúng dịch vụ bên ngoài (SMTP thực tế hoặc hòm thư test Ethereal).
 */
import nodemailer, { type Transporter } from "nodemailer";

/**
 * Where a notification actually goes.
 *
 * Until now the dispatcher had one branch — `console.info("[sms-stub]")` — and
 * then marked the row sent, so every notification the centre "sent" went
 * nowhere and said it had arrived. This is the seam that fixes that: one
 * interface, several transports, chosen by configuration rather than by
 * editing the job.
 *
 * There is no SMS transport, on purpose. Sending branded SMS to a Vietnamese
 * number requires a sender-ID registration that only a registered company can
 * obtain, so it is out of scope for this system; email is the channel that
 * actually reaches somebody. Adding one later means writing a transport with
 * this same shape and a branch in `deliver` — nothing else here changes.
 */

export type Channel = "inapp" | "email";

export type Message = {
  channel: Channel;
  template: string;
  /** Email address. Null for in-app, which has no address. */
  to: string | null;
  payload: Record<string, unknown>;
};

export type SendResult = { sent: boolean; detail?: string };

/** Rendered subject and body for a template. */
/**
 * Làm gì: Tạo tiêu đề (subject) và nội dung văn bản (text) cho thông báo dựa vào tên template và dữ liệu payload truyền vào.
 * Được gọi ở: Nội bộ file này tại consoleTransport.send() (dòng 66) và emailTransport.send() (dòng 125).
 * @param template Tên mẫu thông báo ("otp", "payment_receipt", "sub_expiring", ...).
 * @param payload Dữ liệu biến động dùng để điền vào nội dung thông báo.
 * @returns Đối tượng chứa subject (tiêu đề) và text (nội dung chi tiết).
 * @throws Không ném lỗi (trả về fallback JSON nếu template không khớp).
 */
function render(template: string, payload: Record<string, unknown>): { subject: string; text: string } {
  switch (template) {
    // Mẫu OTP: gửi mã xác thực đăng ký hoặc đăng nhập tài khoản (hết hạn sau 5 phút).
    case "otp":
      return {
        subject: `Arena3 — mã xác thực ${payload.otp}`,
        text: [
          `Mã xác thực của bạn là: ${payload.otp}`,
          "",
          "Mã có hiệu lực trong 5 phút và chỉ dùng được một lần.",
          "Nếu bạn không yêu cầu mã này, hãy bỏ qua email — tài khoản của bạn vẫn an toàn.",
          "Arena3 không bao giờ hỏi mã này qua điện thoại hay tin nhắn.",
        ].join("\n"),
      };
    // Mẫu payment_receipt: biên nhận xác nhận trung tâm đã nhận tiền thanh toán.
    case "payment_receipt":
      return {
        subject: "Arena3 — biên nhận thanh toán",
        text: `Cảm ơn bạn. Chúng tôi đã nhận ${payload.amount_vnd}đ. Hóa đơn có trong mục Biên nhận của tài khoản.`,
      };
    // Mẫu sub_expiring: cảnh báo gói tập sắp hết hạn để hội viên chủ động gia hạn.
    case "sub_expiring":
      return {
        subject: "Arena3 — gói tập sắp hết hạn",
        text: `Gói tập của bạn hết hạn vào ${payload.end_on} (còn ${payload.days} ngày).`,
      };
    // Fallback cho các template khác: chuyển toàn bộ payload thành chuỗi JSON để không bị mất dữ liệu.
    default:
      return {
        subject: `Arena3 — ${template}`,
        text: JSON.stringify(payload),
      };
  }
}

/** Logs and reports success. The default when nothing is configured. */
/**
 * Làm gì: Bộ chuyển phát giả lập (stub transport), chỉ ghi log thông báo ra console thay vì gửi thật; dùng khi chưa cấu hình email hoặc kênh không xác định.
 * Được gọi ở: deliver() (khi không rõ channel) và emailTransport.send() (khi chưa cấu hình mailer).
 */
const consoleTransport = {
  /**
   * Làm gì: Giả lập việc gửi thông báo bằng cách in thông tin và tiêu đề ra console log; luôn báo thành công.
   * Được gọi ở: deliver() (dòng 157) và emailTransport.send() (dòng 124).
   * @param m Đối tượng thông điệp Message cần chuyển phát.
   * @returns Đối tượng { sent: true, detail: "logged" }.
   * @throws Không ném lỗi.
   */
  async send(m: Message): Promise<SendResult> {
    // Bước 1: Render nội dung theo template để lấy tiêu đề in ra log console.
    const { subject } = render(m.template, m.payload);
    console.info(`[notify:${m.channel}] -> ${m.to ?? "(in-app)"} :: ${subject}`);
    // Bước 2: Báo thành công với chi tiết 'logged' để caller (outbox job) coi như thông báo đã gửi xong.
    return { sent: true, detail: "logged" };
  },
};

/**
 * SMTP configuration, or null.
 *
 * `MAIL_TRANSPORT=ethereal` asks nodemailer for a throwaway inbox and prints a
 * URL where the message can be read — no signup, no credentials, and mail that
 * can actually be opened during development. Anything else needs real SMTP
 * settings.
 */
/**
 * Làm gì: Đọc và kiểm tra các thông số cấu hình SMTP từ biến môi trường (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS).
 * Được gọi ở: getMailer() (dòng 94) và emailConfigured() (dòng 165) trong file này.
 * @returns Đối tượng cấu hình kết nối SMTP cho nodemailer, hoặc null nếu thiếu thông tin bắt buộc.
 * @throws Không ném lỗi.
 */
function smtpSettings() {
  // Bước 1: Đọc thông tin kết nối từ env; mặc định cổng 587 (chuẩn STARTTLS) nếu không chỉ định.
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  // Bước 2: Kiểm tra tính đầy đủ; nếu thiếu một trong ba thông tin (host, user, pass) thì xem như chưa cấu hình SMTP.
  if (!host || !user || !pass) return null;
  // Bước 3: Xác định chế độ bảo mật: cổng 465 dùng SSL/TLS trực tiếp (secure: true), các cổng khác như 587 dùng STARTTLS (secure: false).
  return { host, port, secure: port === 465, auth: { user, pass } };
}

let mailer: Transporter | null = null;
let etherealUrlLogged = false;

/**
 * Làm gì: Khởi tạo và lưu cache đối tượng Transporter của nodemailer theo cấu hình SMTP thật hoặc tự tạo tài khoản Ethereal test inbox dùng trong môi trường dev.
 * Được gọi ở: emailTransport.send() (dòng 123) trong file này.
 * @returns Đối tượng Transporter sẵn sàng gửi mail hoặc null nếu không có cấu hình email.
 * @throws Có thể ném lỗi mạng nếu nodemailer thất bại khi tạo tài khoản test Ethereal.
 */
async function getMailer(): Promise<Transporter | null> {
  // Bước 1: Tận dụng transporter đã tạo trong bộ nhớ (singleton pattern) để tái sử dụng kết nối.
  if (mailer) return mailer;
  // Bước 2: Kiểm tra cấu hình SMTP thật từ biến môi trường; nếu có thì tạo transporter kết nối máy chủ mail thật.
  const settings = smtpSettings();
  if (settings) {
    mailer = nodemailer.createTransport(settings);
    return mailer;
  }
  // Bước 3: Nếu được cấu hình biến MAIL_TRANSPORT=ethereal, tạo tài khoản test Ethereal miễn phí để lập trình viên xem mail trên web.
  if (process.env.MAIL_TRANSPORT === "ethereal") {
    // Within one process nodemailer caches the account, so restarting the
    // server is what gives a fresh inbox.
    const account = await nodemailer.createTestAccount();
    mailer = nodemailer.createTransport({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      auth: { user: account.user, pass: account.pass },
    });
    if (!etherealUrlLogged) {
      console.info(`[notify] Ethereal inbox ready — sign in at https://ethereal.email/login`);
      console.info(`[notify]   user: ${account.user}`);
      console.info(`[notify]   pass: ${account.pass}`);
      etherealUrlLogged = true;
    }
    return mailer;
  }
  // Bước 4: Không có bất kỳ cấu hình email nào -> trả về null để caller fallback sang ghi log console.
  return null;
}

/**
 * Làm gì: Bộ chuyển phát thông báo qua email, sử dụng nodemailer để gửi qua SMTP thật hoặc hòm thư test Ethereal.
 * Được gọi ở: deliver() (dòng 156) trong file này khi channel là "email".
 */
const emailTransport = {
  /**
   * Làm gì: Gửi email thực tế đến địa chỉ người nhận bằng nodemailer; in URL xem trước nếu dùng Ethereal.
   * Được gọi ở: deliver() (dòng 156) trong file này.
   * @param m Thông điệp Message chứa địa chỉ nhận (to), template và dữ liệu payload.
   * @returns Kết quả { sent: boolean, detail?: string } chứa URL preview hoặc messageId nếu thành công.
   * @throws Có thể ném lỗi từ nodemailer (được bắt và bọc lại trong try/catch của deliver()).
   */
  async send(m: Message): Promise<SendResult> {
    // Bước 1: Kiểm tra địa chỉ email người nhận; nếu không có thì trả về thất bại ngay để không gửi mù.
    if (!m.to) return { sent: false, detail: "no email address on file" };
    // Bước 2: Lấy transporter gửi mail; nếu hệ thống chưa cấu hình gửi mail thì chuyển sang ghi log console.
    const transport = await getMailer();
    if (!transport) return consoleTransport.send(m);
    // Bước 3: Tạo tiêu đề và nội dung email từ template và dữ liệu payload.
    const { subject, text } = render(m.template, m.payload);
    // Bước 4: Gửi email qua nodemailer; dùng địa chỉ MAIL_FROM từ env hoặc mặc định no-reply@arena3.local.
    const info = await transport.sendMail({
      from: process.env.MAIL_FROM?.trim() || "Arena3 <no-reply@arena3.local>",
      to: m.to,
      subject,
      text,
    });
    // Ethereal does not deliver; it stores. The preview URL is the whole point.
    // Bước 5: Nếu đang dùng tài khoản Ethereal, lấy đường link xem email trực tiếp trên trình duyệt để debug.
    const preview = nodemailer.getTestMessageUrl(info);
    if (preview) console.info(`[notify:email] read it at ${preview}`);
    return { sent: true, detail: preview || info.messageId };
  },
};

/** In-app notifications are already stored; delivery is the member opening the app. */
/**
 * Làm gì: Bộ chuyển phát thông báo trong ứng dụng (in-app notification).
 * Được gọi ở: deliver() (dòng 155) trong file này khi channel là "inapp".
 */
const inappTransport = {
  /**
   * Làm gì: Xác nhận thông báo in-app đã sẵn sàng; thông báo đã được lưu trong DB từ trước nên chỉ cần đánh dấu thành công.
   * Được gọi ở: deliver() (dòng 155) khi m.channel === "inapp".
   * @returns Đối tượng { sent: true, detail: "stored" }.
   * @throws Không ném lỗi.
   */
  async send(): Promise<SendResult> {
    return { sent: true, detail: "stored" };
  },
};

/**
 * Deliver one message.
 *
 * Never throws: a transport that fails returns `{ sent: false }` so the caller
 * can leave the row unsent and count the attempt, rather than losing the
 * message to an exception.
 */
/**
 * Làm gì: Hàm điều hướng chính để gửi thông báo; chọn đúng transport (inapp, email, console) và đảm bảo không bao giờ ném lỗi để bảo vệ tiến trình gọi.
 * Được gọi ở:
 * - src/server/controllers/handlers/auth.ts: trong deliverOtp() để gửi mã OTP xác thực email.
 * - src/server/data/jobs.ts: trong job worker notifyFlush() để gửi các thông báo tồn đọng trong bảng outbox.
 * @param m Thông điệp Message cần gửi (chứa channel, template, to, payload).
 * @returns Kết quả chuyển phát { sent: boolean, detail?: string }.
 * @throws Không bao giờ ném lỗi (toàn bộ ngoại lệ được bắt trong try/catch và trả về { sent: false, detail }).
 */
export async function deliver(m: Message): Promise<SendResult> {
  // Bước 1: Phân luồng gửi thông báo theo kênh (in-app, email hoặc console).
  try {
    if (m.channel === "inapp") return await inappTransport.send();
    if (m.channel === "email") return await emailTransport.send(m);
    return await consoleTransport.send(m);
  // Bước 2: Bắt toàn bộ lỗi (mạng, cấu hình, lỗi SMTP) và trả về sent: false để caller đếm số lần thử (attempts) trong outbox mà không bị crash.
  } catch (e) {
    return { sent: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Whether OTPs can be emailed, i.e. whether a real transport is configured. */
/**
 * Làm gì: Kiểm tra xem hệ thống đã được cấu hình dịch vụ gửi email hoạt động hay chưa (SMTP thật hoặc Ethereal).
 * Được gọi ở: Các module kiểm tra tính sẵn sàng của tính năng gửi OTP hoặc các kịch bản kiểm thử (test).
 * @returns true nếu có cấu hình gửi email khả dụng; ngược lại trả về false.
 * @throws Không ném lỗi.
 */
export function emailConfigured(): boolean {
  return smtpSettings() !== null || process.env.MAIL_TRANSPORT === "ethereal";
}
