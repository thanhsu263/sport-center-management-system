/**
 * File: src/client/components/theme-toggle.tsx
 * Vai trò: Nút chuyển đổi giao diện sáng/tối (Light/Dark mode) dạng icon tròn cho ứng dụng.
 * Vị trí trong app: Được gắn trên thanh điều hướng đầu trang landing (SiteHeader trong src/client/components/landing/header.tsx), xuất hiện ở cả thanh điều hướng desktop và menu mobile dạng sheet; tương tác với theme context qua hook useTheme.
 */
import { Moon, Sun } from "lucide-react";
import { cn } from "@/client/lib/cn";
import { t } from "@/client/lib/i18n";
import { useTheme } from "@/client/lib/theme";

/** A round light/dark switch for the public pages, beside the language switch. */
/**
 * Làm gì: Nút bấm tròn chuyển đổi nhanh giữa giao diện sáng (light) và tối (dark); tự động đổi icon Moon/Sun và cập nhật nhãn trợ năng tương ứng.
 * Được gọi ở: src/client/components/landing/header.tsx: component SiteHeader (trên thanh điều hướng desktop và menu mobile dạng sheet của trang landing).
 * @param className Class CSS tùy biến bổ sung để định kiểu hoặc căn chỉnh vị trí nút bấm.
 * @returns Khối JSX nút bấm tròn (button) chuyển đổi theme.
 */
export function ThemeIconToggle({ className }: { className?: string }) {
  // Bước 1: Lấy theme hiện tại từ hook useTheme; xác định nhãn (label) mục tiêu để hiển thị trong aria-label và tooltip (đang sáng thì gợi ý "Dark mode" và ngược lại).
  const [theme, set] = useTheme();
  const light = theme === "light";
  const label = light ? t("Dark mode") : t("Light mode");
  // Bước 2: Render nút bấm dạng viên thuốc (pill), hiển thị icon Moon khi đang ở theme sáng hoặc Sun khi đang ở theme tối để trực quan hóa thao tác.
  return (
    <button
      type="button"
      onClick={() => set(light ? "dark" : "light")}
      aria-label={label}
      title={label}
      className={cn(
        "grid size-11 place-items-center rounded-[var(--radius-pill)] text-muted transition-colors duration-150 hover:bg-wood hover:text-fg",
        className,
      )}
    >
      {light ? <Moon aria-hidden="true" className="size-5" strokeWidth={1.75} /> : <Sun aria-hidden="true" className="size-5" strokeWidth={1.75} />}
    </button>
  );
}
