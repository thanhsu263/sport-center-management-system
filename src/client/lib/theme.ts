/**
 * Quản lý chủ đề giao diện (theme: sáng/tối - light/dark) cho toàn bộ ứng dụng Arena 3.
 * Tệp này đảm nhận:
 * - Cung cấp đoạn mã THEME_BOOT chạy sớm trong thẻ <script> của __root.tsx để áp dụng theme từ localStorage trước khi trang kịp render, ngăn ngừa hiện tượng nhấp nháy sai màu giao diện (FOUC).
 * - Cung cấp hàm setTheme để cập nhật theme lên thẻ <html>, lưu vào localStorage và phát sự kiện đồng bộ qua Set listeners.
 * - Cung cấp React hook useTheme dùng chung trong các component (ThemeToggle, ThemeIconToggle,...) để theo dõi và chuyển đổi theme.
 */
import { useEffect, useState } from "react";

// Kiểu dữ liệu xác định hai chế độ giao diện được hỗ trợ: tối ("dark") hoặc sáng ("light").
export type Theme = "dark" | "light";
// Khóa lưu trữ theme trong localStorage và tập hợp callback lắng nghe sự thay đổi theme.
const KEY = "arena3:theme";
const listeners = new Set<(t: Theme) => void>();

/** Read before paint by the inline script in __root.tsx, so the page never flashes the wrong scheme. */
/**
 * Làm gì: Đoạn mã JavaScript inline thực thi sớm nhất trong thẻ <head> để đọc theme từ localStorage và gán vào dataset.theme của thẻ <html> trước khi trình duyệt hiển thị giao diện, tránh hiện tượng nhấp nháy giao diện sai màu (FOUC).
 * Được gọi ở: src/routes/__root.tsx (component RootComponent, render trong thẻ <script> của <head>).
 * @returns Chuỗi mã JavaScript thô (string) dùng cho dangerouslySetInnerHTML.
 */
export const THEME_BOOT = `try{var t=localStorage.getItem("${KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

/**
 * Làm gì: Xác định theme hiện tại bằng cách kiểm tra thuộc tính data-theme trên thẻ <html> của trình duyệt; mặc định là "dark" khi chạy ở môi trường server (SSR).
 * Được gọi ở: src/client/lib/theme.ts (hook useTheme trong useEffect khi component mount).
 * @returns Theme hiện tại ("dark" hoặc "light").
 */
function current(): Theme {
  // Khi render phía server (SSR), đối tượng document chưa tồn tại nên mặc định trả về theme tối ("dark")
  if (typeof document === "undefined") return "dark";
  // Đọc giá trị thuộc tính data-theme trên thẻ <html>; chỉ khi là "light" mới trả về "light", còn lại mặc định "dark"
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/**
 * Làm gì: Cập nhật theme mới cho toàn ứng dụng: đổi thuộc tính data-theme trên thẻ <html>, lưu tùy chọn vào localStorage và thông báo cho tất cả component đang lắng nghe.
 * Được gọi ở: src/client/lib/theme.ts (trả về trong hook useTheme), gián tiếp gọi từ ThemeToggle (shell.tsx) và ThemeIconToggle (theme-toggle.tsx).
 * @param next Chế độ giao diện mới muốn áp dụng ("dark" hoặc "light").
 * @returns Không trả về giá trị (void).
 */
export function setTheme(next: Theme) {
  // Bước 1: Cập nhật ngay thuộc tính data-theme trên thẻ <html> để CSS chuyển đổi màu sắc giao diện lập tức.
  document.documentElement.dataset.theme = next;
  // Bước 2: Lưu tùy chọn theme vào localStorage để duy trì cho những lần truy cập sau (bỏ qua nếu ở chế độ ẩn danh bị chặn storage).
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* private mode: the choice lasts this visit only */
  }
  // Bước 3: Phát thông báo tới toàn bộ các component đang đăng ký qua listeners để cập nhật lại React state.
  listeners.forEach((l) => l(next));
}

/** The scheme in use and a setter. Starts as "dark" on the server and settles after mount. */
/**
 * Làm gì: Hook React cung cấp trạng thái theme hiện tại và hàm cập nhật theme (setTheme), tự động lắng nghe và đồng bộ khi theme thay đổi ở bất kỳ đâu.
 * Được gọi ở:
 * - src/client/components/shell.tsx (component ThemeToggle).
 * - src/client/components/theme-toggle.tsx (component ThemeIconToggle).
 * @returns Mảng tuple gồm 2 phần tử: [theme hiện tại ("dark" | "light"), hàm setTheme để cập nhật].
 */
export function useTheme(): [Theme, (t: Theme) => void] {
  // Bước 1: Khởi tạo state nội bộ với giá trị "dark" để khớp với kết quả render phía server (SSR), tránh lỗi hydration.
  const [theme, set] = useState<Theme>("dark");
  // Bước 2: Sau khi mount ở client, đọc theme thực tế từ DOM và đăng ký callback vào Set listeners để đồng bộ thay đổi.
  useEffect(() => {
    set(current());
    listeners.add(set);
    // Hủy đăng ký listener khi component unmount để tránh rò rỉ bộ nhớ (memory leak)
    return () => {
      listeners.delete(set);
    };
  }, []);
  // Bước 3: Trả về tuple gồm theme hiện tại và hàm setTheme để component giao diện sử dụng
  return [theme, setTheme];
}
