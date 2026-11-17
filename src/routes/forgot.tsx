/**
 * File: src/routes/forgot.tsx
 * Vai trò: Định nghĩa route và giao diện trang Quên mật khẩu (/forgot) cho hội viên trong hệ thống Arena 3.
 * Vị trí trong app:
 * - URL: /forgot, được liên kết từ trang Đăng nhập (/login) khi người dùng bấm "Quên mật khẩu".
 * - Luồng hoạt động gồm 2 bước:
 *   + Bước 1: Nhập số điện thoại kèm Captcha để yêu cầu mã OTP gửi về email đã đăng ký.
 *   + Bước 2: Nhập mã OTP và thiết lập mật khẩu mới (gửi xác thực qua API /auth/otp/verify).
 * - Đảm bảo an toàn thông tin: không tiết lộ tài khoản có tồn tại hay không và che bớt địa chỉ email nhận mã.
 */
import { Captcha, useCaptcha } from "@/client/components/captcha";
import { OtpInput, OtpResend } from "@/client/components/otp-input";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, Field, Input } from "@/client/components/ui";
import { AnimatePresence, motion } from "@/client/components/motion";
import { ApiClientError, apiPost } from "@/client/arena3/client";
import { LangSwitch } from "@/client/components/lang-switch";
import { t, tServer } from "@/client/lib/i18n";

/**
 * Recover an account with a code sent to the email on file.
 *
 * The server side of this existed and had nothing in front of it: a member who
 * forgot their password had no route back in except asking the front desk to
 * do it for them, which is both a support burden and a worse answer than a
 * code only they can read.
 *
 * Two deliberate choices about what this screen does NOT reveal:
 *
 *  - It never says whether a phone number has an account. The wording after
 *    step one is the same either way, because "no account with that number"
 *    turns this page into a way of finding out who is a member here.
 *  - It never shows the email address it sent to in full. The server returns a
 *    masked form (`ng****@example.com`), enough to remind the owner which inbox
 *    to open and not enough to hand a stranger an address.
 */

/**
 * Làm gì: Khai báo route /forgot trong hệ thống TanStack Router, liên kết URL /forgot với component Forgot.
 * Được gọi ở: TanStack Router (src/routeTree.gen.ts, URL: /forgot); hội viên bấm liên kết từ src/routes/login.tsx.
 * @returns Đối tượng Route cấu hình cho đường dẫn /forgot.
 */
export const Route = createFileRoute("/forgot")({ component: Forgot });

/** Puts a styled node where a translated sentence has its single placeholder. */
const SLOT = "";
/**
 * Làm gì: Chèn một React node vào vị trí ký tự phân tách SLOT (" ") trong chuỗi văn bản đã dịch.
 * Được gọi ở: src/routes/forgot.tsx (trong component Forgot, hiển thị email che sentTo và mã demoOtp).
 * @param text Chuỗi văn bản đã dịch có chứa ký tự phân tách SLOT.
 * @param node ReactNode cần chèn vào vị trí giữa hai phần văn bản (thẻ span hiển thị email hoặc mã OTP).
 * @returns Đoạn JSX Fragment chứa phần văn bản đầu, React node được tạo kiểu và phần văn bản cuối.
 */
const slot = (text: string, node: ReactNode) => {
  const [a, b] = text.split(SLOT);
  return (
    <>
      {a}
      {node}
      {b}
    </>
  );
};

/**
 * Làm gì: Component giao diện chính của trang Quên mật khẩu (/forgot), quản lý form 2 bước và xử lý logic khôi phục mật khẩu.
 * Được gọi ở: src/routes/forgot.tsx (gán vào Route tại route /forgot).
 * @returns Khung giao diện (JSX) trang Quên mật khẩu gồm Card, form chuyển bước mượt mà và các thông báo phản hồi.
 */
function Forgot() {
  const navigate = useNavigate();
  const captcha = useCaptcha();
  const [resendAt, setResendAt] = useState(0);
  // Quản lý trạng thái form: bước hiện tại ('phone' hoặc 'reset'), thông tin SĐT, mã OTP và mật khẩu mới.
  const [step, setStep] = useState<"phone" | "reset">("phone");
  const [phone, setPhone] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [demoOtp, setDemoOtp] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  // Why the last attempt on this step failed, and which input it is about, kept on the form until
  // the next one: a toast fades after a few seconds, and "that code is not right" is a line a
  // person reads twice.
  const [error, setError] = useState<{ message: string; field: string | null } | null>(null);
  /** For an input: marked invalid, and tied to the message, when the last attempt faulted it. */
  /**
   * Làm gì: Trả về thuộc tính trợ năng (aria-invalid, aria-describedby) cho input khi trường đó bị đánh dấu lỗi từ server.
   * Được gọi ở: src/routes/forgot.tsx (trong component Forgot, gắn vào các trường Input phone, password, confirm).
   * @param name Tên trường nhập liệu cần kiểm tra lỗi ('phone' | 'password' | 'confirm').
   * @returns Object chứa thuộc tính aria nếu trường bị lỗi, hoặc object rỗng khi hợp lệ.
   */
  const faulted = (name: string) =>
    error?.field === name ? ({ "aria-invalid": true, "aria-describedby": "forgot-error" } as const) : {};

  // Kiểm tra mật khẩu nhập lại: chỉ báo lỗi mismatch khi người dùng đã bắt đầu gõ vào ô confirm.
  const mismatch = confirm.length > 0 && confirm !== password;
  // Kiểm tra quy tắc mật khẩu (BR-02): tối thiểu 8 ký tự, phải bao gồm cả chữ cái và chữ số.
  const tooWeak =
    password.length > 0 && !(password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password));

  /**
   * Làm gì: Gửi yêu cầu cấp mã OTP khôi phục mật khẩu qua API /auth/password/forgot kèm số điện thoại và token Captcha.
   * Được gọi ở: src/routes/forgot.tsx (sự kiện onSubmit của form bước 1 và callback onResend của component OtpResend ở bước 2).
   * @param e Sự kiện FormEvent khi submit form (tùy chọn, không truyền khi bấm gửi lại mã).
   * @returns Promise<void> cập nhật state sang bước 'reset' nếu thành công, hoặc lưu thông báo lỗi nếu thất bại.
   */
  async function requestCode(e?: FormEvent) {
    // Bước 1: Ngăn hành vi submit form mặc định, xóa lỗi cũ và bật trạng thái bận (busy).
    e?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Bước 2: Gọi API POST /auth/password/forgot gửi số điện thoại và token Captcha để yêu cầu mã OTP.
      const res = await apiPost<{ sent_to?: string | null; otp?: string }>("/auth/password/forgot", {
        phone, captcha_token: captcha.token, website: captcha.website,
      });
      // Bước 3: Lưu email đã che (sent_to), mã OTP demo (nếu có) và chuyển giao diện sang bước 'reset'.
      setSentTo(res.sent_to ?? null);
      setDemoOtp(res.otp ?? null);
      setStep("reset");
      setOtp("");
      // Đặt thời gian đếm ngược 60 giây trước khi cho phép gửi lại mã OTP (rate limiting phía client).
      setResendAt(Date.now() + 60_000);
    } catch (err) {
      // Bước 4: Xử lý lỗi trả về từ API; ưu tiên thông báo được dịch từ server (tServer) và đánh dấu trường lỗi.
      setError({
        message: err instanceof Error ? tServer(err.message) : t("Could not send a code"),
        field: err instanceof ApiClientError ? (err.body.field ?? null) : null,
      });
    } finally {
      // Bước 5: Luôn reset Captcha để làm mới token cho lần gửi tiếp theo và tắt trạng thái busy.
      captcha.reset();
      setBusy(false);
    }
  }

  /**
   * Làm gì: Xác thực mã OTP và cập nhật mật khẩu mới cho tài khoản hội viên qua API /auth/otp/verify.
   * Được gọi ở: src/routes/forgot.tsx (sự kiện onSubmit của form bước 2 'reset').
   * @param e Sự kiện FormEvent khi người dùng gửi form đặt lại mật khẩu.
   * @returns Promise<void> điều hướng về /login nếu thành công, hoặc hiển thị lỗi nếu OTP sai / không hợp lệ.
   */
  async function reset(e: FormEvent) {
    // Bước 1: Ngăn submit mặc định và xóa thông báo lỗi trước đó.
    e.preventDefault();
    setError(null);
    // Bước 2: Kiểm tra xác nhận mật khẩu ở client; nếu không khớp thì gán lỗi cho trường 'confirm' và dừng sớm.
    if (password !== confirm) {
      setError({ message: t("The two passwords do not match."), field: "confirm" });
      return;
    }
    // Bước 3: Bật trạng thái bận (busy) và gọi API /auth/otp/verify để xác thực OTP và đổi mật khẩu mới.
    setBusy(true);
    try {
      await apiPost("/auth/otp/verify", { phone, otp, purpose: "reset", password });
      // Bước 4: Đổi mật khẩu thành công: hiển thị thông báo toast và điều hướng hội viên sang trang đăng nhập (/login).
      toast.success(t("Password changed. Sign in with the new one."));
      void navigate({ to: "/login" });
    } catch (err) {
      // Bước 5: Bắt lỗi nếu mã OTP sai, hết hạn hoặc mật khẩu không thỏa mãn quy tắc nghiệp vụ của server.
      setError({
        message: err instanceof Error ? tServer(err.message) : t("That code is not right"),
        field: err instanceof ApiClientError ? (err.body.field ?? null) : null,
      });
    } finally {
      // Bước 6: Tắt trạng thái bận khi hoàn tất request (dù thành công hay thất bại).
      setBusy(false);
    }
  }

  // Bước 7: Render giao diện: Card trung tâm chứa form 2 bước có hiệu ứng trượt (motion), nút đổi ngôn ngữ và liên kết đăng nhập.
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto grid min-h-dvh max-w-md place-items-center px-4">
      <Card className="relative w-full p-6">
        <LangSwitch className="absolute right-4 top-4" />
        <h1 className="pr-28 font-display text-3xl">{t("Forgot your password")}</h1>
        <p className="mt-1 text-xs font-medium tabular-nums text-muted">
          {t("Step {n} of {total}", { n: step === "phone" ? 1 : 2, total: 2 })}
        </p>

        <AnimatePresence mode="wait">
          {step === "phone" ? (
            <motion.form
              key="phone"
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="mt-6 grid gap-4"
              onSubmit={requestCode}
            >
              <Captcha state={captcha} />
              <p className="text-sm text-muted">
                {t("Enter the phone number on your account. We will email a code to the address we hold for it.")}
              </p>
              <Field label={t("Phone")}>
                <Input
                  required
                  value={phone}
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="0901 234 567"
                  onChange={(e) => setPhone(e.target.value)}
                  {...faulted("phone")}
                />
              </Field>
              {error ? (
                <p id="forgot-error" role="alert" className="text-sm text-danger">
                  {error.message}
                </p>
              ) : null}
              <Button type="submit" disabled={busy || !phone} className="w-full">
                {busy ? t("Sending…") : t("Send the code")}
              </Button>
            </motion.form>
          ) : (
            <motion.form
              key="reset"
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 12 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="mt-6 grid gap-4"
              onSubmit={reset}
            >
              {/*
                Same wording whether or not that number has an account — this
                page must not be usable to find out who is a member here.
              */}
              <p className="rounded-[var(--radius-md)] bg-wood px-3 py-2 text-sm">
                {sentTo ? (
                  <>
                    {slot(t("If that number has an account, a code is on its way to {email}. It expires in 5 minutes.", { email: SLOT }), <span className="font-medium">{sentTo}</span>)}
                  </>
                ) : (
                  <>
                    {t("If that number has an account with an email on file, a code is on its way. It expires in 5 minutes.")}
                  </>
                )}
              </p>
              <p className="text-sm text-muted">
                {t("No email on your account, or can't open it? Ask the front desk to reset your password. They will give you a temporary one.")}
              </p>
              {demoOtp ? (
                <p className="rounded-[var(--radius-md)] border border-hold/40 px-3 py-2 text-sm text-hold">
                  {slot(t("Demo build: the code is {code}.", { code: SLOT }), <span className="font-medium tabular-nums">{demoOtp}</span>)}
                </p>
              ) : null}

              <OtpInput value={otp} onChange={setOtp} invalid={error?.field === "otp"} errorId="forgot-error" />
              <Field label={t("New password")} hint={tooWeak ? t("At least 8 characters, letters and digits.") : undefined}>
                <div className="relative">
                  <Input
                    required
                    type={show ? "text" : "password"}
                    value={password}
                    autoComplete="new-password"
                    onChange={(e) => setPassword(e.target.value)}
                    className="pr-12"
                    {...faulted("password")}
                    aria-invalid={tooWeak || error?.field === "password" ? true : undefined}
                  />
                  <button
                    type="button"
                    className="absolute right-0 top-0 grid size-11 place-items-center text-muted hover:text-fg"
                    onClick={() => setShow((v) => !v)}
                    aria-label={show ? t("Hide password") : t("Show password")}
                  >
                    {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </Field>
              <Field label={t("Confirm password")} hint={mismatch ? t("The two passwords do not match.") : undefined}>
                <Input
                  required
                  type={show ? "text" : "password"}
                  value={confirm}
                  autoComplete="new-password"
                  onChange={(e) => setConfirm(e.target.value)}
                  {...faulted("confirm")}
                  aria-invalid={mismatch || error?.field === "confirm" ? true : undefined}
                />
              </Field>
              {error ? (
                <p id="forgot-error" role="alert" className="text-sm text-danger">
                  {error.message}
                </p>
              ) : null}
              <Button
                type="submit"
                disabled={busy || !otp || !password || mismatch || tooWeak}
                className="w-full"
              >
                {busy ? t("Changing…") : t("Change the password")}
              </Button>
              <Captcha state={captcha} />
              <OtpResend until={resendAt} disabled={busy} onResend={() => void requestCode()} />
            </motion.form>
          )}
        </AnimatePresence>

        <p className="mt-6 text-sm text-muted">
          {t("Remembered it?")}{" "}
          <Link to="/login" className="hit text-accent-2 underline underline-offset-2">
            {t("Sign in")}
          </Link>
        </p>
      </Card>
    </main>
  );
}
