/**
 * File: src/client/components/captcha.tsx
 * Vai trò: Cung cấp hook và component tích hợp xác thực chống bot (Cloudflare Turnstile CAPTCHA) và bẫy honeypot cho các biểu mẫu phía client.
 * Vị trí trong app: Được sử dụng ở các màn hình công khai nhạy cảm gồm Đăng ký (/register) và Quên mật khẩu (/forgot) để bảo vệ hệ thống trước tấn công tự động.
 */
import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";

// Định nghĩa kiểu dữ liệu tối giản cho SDK Cloudflare Turnstile gắn trên đối tượng window.
type Turnstile = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  remove: (id: string) => void;
};
declare global { interface Window { turnstile?: Turnstile } }
// Khóa site key công khai của Cloudflare Turnstile; nếu để trống trong biến môi trường thì tắt CAPTCHA (thuận tiện khi chạy dev/test cục bộ).
const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

/**
 * Làm gì: Hook quản lý trạng thái xác thực CAPTCHA gồm token từ Cloudflare Turnstile, giá trị honeypot và hàm reset để tải lại thử thách khi cần.
 * Được gọi ở:
 * - src/routes/forgot.tsx (ForgotPassword component tại route /forgot)
 * - src/routes/register.tsx (Register component tại route /register)
 * @returns Object chứa token, setToken, version, website, setWebsite và hàm reset để làm mới CAPTCHA.
 */
export function useCaptcha() {
  const [token, setToken] = useState("");
  const [version, setVersion] = useState(0);
  // website là trường honeypot ẩn: nếu bot tự động điền giá trị vào đây, server sẽ phát hiện và âm thầm hủy request.
  const [website, setWebsite] = useState("");
  return { token, setToken, version, website, setWebsite,
    // Hàm reset: xóa token cũ và tăng version để kích hoạt useEffect của Captcha dựng lại widget mới khi submit lỗi.
    reset: () => { setToken(""); setVersion((v) => v + 1); } };
}

/** Imported only by register and forgot; no script is loaded with the key unset. */
/**
 * Làm gì: Render widget Cloudflare Turnstile để xác minh người dùng thật và chèn trường input honeypot ẩn để ngăn chặn bot spam.
 * Được gọi ở:
 * - src/routes/forgot.tsx (ForgotPassword component tại route /forgot)
 * - src/routes/register.tsx (Register component tại route /register)
 * @param state Đối tượng trạng thái từ hook useCaptcha, chứa token, version, website và hàm reset.
 * @returns Khung JSX chứa input honeypot ẩn và container hiển thị widget Turnstile kèm thông báo lỗi khi không tải được.
 */
export function Captcha({ state }: { state: ReturnType<typeof useCaptcha> }) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const { setToken, version } = state;
  useEffect(() => {
    // Bước 1: Kiểm tra siteKey; nếu chưa cấu hình (môi trường dev/test) thì bỏ qua, không nạp Turnstile.
    if (!siteKey) return;
    // Bước 2: Chuẩn bị biến id lưu mã widget và cờ disposed để chống xung đột race condition nếu component unmount trước khi script nạp xong.
    let id: string | undefined;
    let disposed = false;
    setFailed(false);
    const script = document.createElement("script");
    // Bước 3: Định nghĩa hàm render widget Turnstile vào thẻ div host kèm các callback lưu token, xử lý khi token hết hạn hoặc gặp lỗi.
    const render = () => {
      if (disposed || !host.current || !window.turnstile) return;
      id = window.turnstile.render(host.current, {
        sitekey: siteKey, size: "compact", callback: setToken,
        "expired-callback": () => setToken(""),
        "error-callback": () => { setToken(""); setFailed(true); },
      });
    };
    // Bước 4: Khởi chạy widget: nếu script Turnstile đã có sẵn trên window thì render ngay, ngược lại tải script từ CDN Cloudflare.
    if (window.turnstile) render();
    else {
      // Tham số render=explicit yêu cầu Turnstile không tự động quét DOM mà chờ component chủ động gọi render.
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.onload = render;
      script.onerror = () => { if (!disposed) setFailed(true); };
      document.head.appendChild(script);
    }
    // Bước 5: Dọn dẹp (cleanup) khi unmount hoặc làm mới: hủy cờ disposed, gỡ widget Turnstile cũ khỏi DOM và xóa thẻ script.
    return () => {
      disposed = true;
      if (id) window.turnstile?.remove(id);
      script.remove();
    };
  }, [version, setToken]);
  // Render trường bẫy bot (honeypot) ẩn ngoài màn hình (-left-[10000px]) và container chứa widget Turnstile (nếu có siteKey).
  return <>
    <div aria-hidden="true" className="absolute -left-[10000px] size-px overflow-hidden">
      <label>{t("Leave this field empty")}<input name="website" tabIndex={-1} autoComplete="off"
        value={state.website} onChange={(e) => state.setWebsite(e.target.value)} /></label>
    </div>
    {siteKey ? <div className="min-w-0"><div ref={host} className="flex justify-center" />{failed ? <p role="alert" className="text-sm text-danger">
      {t("Human verification could not load. Try again.")}
      <button type="button" className="hit underline" onClick={state.reset}>{t("Try again")}</button>
    </p> : null}</div> : null}
  </>;
}
