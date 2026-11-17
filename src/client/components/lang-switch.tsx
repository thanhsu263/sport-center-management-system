/**
 * File: src/client/components/lang-switch.tsx
 * Vai trò: Component nút chuyển đổi ngôn ngữ (EN | VI) trên giao diện người dùng.
 * Vị trí trong app: Được gắn trên các trang xác thực (login, register, forgot password, verify code) để người dùng thay đổi ngôn ngữ hiển thị giữa tiếng Anh và tiếng Việt qua hệ thống i18n.
 */
import { Globe } from "lucide-react";
import { cn } from "@/client/lib/cn";
import { setLang, t, useLang, type Lang } from "@/client/lib/i18n";

// Danh sách cấu hình các ngôn ngữ hỗ trợ: mã ngôn ngữ (value), nhãn ngắn (short) và tên hiển thị đầy đủ (full).
const OPTIONS: { value: Lang; short: string; full: string }[] = [
  { value: "en", short: "EN", full: "English" },
  { value: "vi", short: "VI", full: "Tiếng Việt" },
];

/** EN | VI toggle. Names stay in their own language so it can be found whichever one is on. */
/**
 * Làm gì: Component nút gạt (toggle) chuyển đổi qua lại giữa tiếng Anh (EN) và tiếng Việt (VI) cho giao diện người dùng.
 * Được gọi ở:
 * - src/routes/login.tsx (trang Đăng nhập)
 * - src/routes/register.tsx (trang Đăng ký tài khoản)
 * - src/routes/forgot.tsx (trang Quên mật khẩu)
 * - src/routes/verify.$code.tsx (trang Xác thực mã kích hoạt)
 * Các props:
 * - className: Lớp CSS tùy biến bổ sung cho khung bọc ngoài (thường dùng để định vị như absolute).
 * @returns Khối JSX thanh gạt chọn ngôn ngữ với biểu tượng quả địa cầu Globe và các nút bấm EN / VI.
 */
export function LangSwitch({ className }: { className?: string }) {
  // Bước 1: Lấy mã ngôn ngữ hiện tại ("en" | "vi") từ hook useLang để xác định nút nào đang được kích hoạt.
  const lang = useLang();
  // Bước 2: Render khung nhóm (role="group") gồm biểu tượng Globe và danh sách nút bấm tương ứng với từng ngôn ngữ.
  // Khi click vào nút, gọi setLang để cập nhật ngôn ngữ toàn ứng dụng và lưu vào localStorage.
  return (
    <div
      role="group"
      aria-label={t("Language")}
      className={cn("inline-flex h-12 items-center gap-0.5 rounded-full bg-surface p-0.5 shadow-[var(--shadow-border)] sm:h-9", className)}
    >
      <Globe aria-hidden="true" className="ml-1.5 hidden size-3.5 shrink-0 text-muted sm:block" />
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          lang={o.value}
          title={o.full}
          aria-label={o.full}
          aria-pressed={lang === o.value}
          onClick={() => setLang(o.value)}
          className={cn(
            "h-11 min-w-11 rounded-full px-2 text-xs font-semibold tracking-wide transition-colors sm:h-8 sm:min-w-9",
            lang === o.value ? "bg-accent text-accent-fg" : "text-muted hover:text-fg",
          )}
        >
          {o.short}
        </button>
      ))}
    </div>
  );
}
