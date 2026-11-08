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
function render(template: string, payload: Record<string, unknown>): { subject: string; text: string } {
  switch (template) {
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
    case "payment_receipt":
      return {
        subject: "Arena3 — biên nhận thanh toán",
        text: `Cảm ơn bạn. Chúng tôi đã nhận ${payload.amount_vnd}đ. Hóa đơn có trong mục Biên nhận của tài khoản.`,
      };
    case "sub_expiring":
      return {
        subject: "Arena3 — gói tập sắp hết hạn",
        text: `Gói tập của bạn hết hạn vào ${payload.end_on} (còn ${payload.days} ngày).`,
      };
    default:
      return {
        subject: `Arena3 — ${template}`,
        text: JSON.stringify(payload),
      };
  }
}

/** Logs and reports success. The default when nothing is configured. */
const consoleTransport = {
  async send(m: Message): Promise<SendResult> {
    const { subject } = render(m.template, m.payload);
    console.info(`[notify:${m.channel}] -> ${m.to ?? "(in-app)"} :: ${subject}`);
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
function smtpSettings() {
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  if (!host || !user || !pass) return null;
  return { host, port, secure: port === 465, auth: { user, pass } };
}

let mailer: Transporter | null = null;
let etherealUrlLogged = false;

async function getMailer(): Promise<Transporter | null> {
  if (mailer) return mailer;
  const settings = smtpSettings();
  if (settings) {
    mailer = nodemailer.createTransport(settings);
    return mailer;
  }
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
  return null;
}

const emailTransport = {
  async send(m: Message): Promise<SendResult> {
    if (!m.to) return { sent: false, detail: "no email address on file" };
    const transport = await getMailer();
    if (!transport) return consoleTransport.send(m);
    const { subject, text } = render(m.template, m.payload);
    const info = await transport.sendMail({
      from: process.env.MAIL_FROM?.trim() || "Arena3 <no-reply@arena3.local>",
      to: m.to,
      subject,
      text,
    });
    // Ethereal does not deliver; it stores. The preview URL is the whole point.
    const preview = nodemailer.getTestMessageUrl(info);
    if (preview) console.info(`[notify:email] read it at ${preview}`);
    return { sent: true, detail: preview || info.messageId };
  },
};

/** In-app notifications are already stored; delivery is the member opening the app. */
const inappTransport = {
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
export async function deliver(m: Message): Promise<SendResult> {
  try {
    if (m.channel === "inapp") return await inappTransport.send();
    if (m.channel === "email") return await emailTransport.send(m);
    return await consoleTransport.send(m);
  } catch (e) {
    return { sent: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Whether OTPs can be emailed, i.e. whether a real transport is configured. */
export function emailConfigured(): boolean {
  return smtpSettings() !== null || process.env.MAIL_TRANSPORT === "ethereal";
}
