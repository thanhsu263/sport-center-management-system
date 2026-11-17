/**
 * File này định nghĩa các giao diện dự phòng mặc định khi xảy ra sự cố của TanStack Router:
 * - AppErrorComponent: hiển thị khi giao diện hoặc component con ném ra ngoại lệ chưa xử lý (unhandled error / crash).
 * - AppNotFoundComponent: hiển thị khi người dùng truy cập một URL không tồn tại trong hệ thống (404 Not Found).
 * Cả hai màn hình đều được tối giản tối đa, không dùng component kit phức tạp để đảm bảo luôn render được khi ứng dụng bị hỏng.
 */
import type { ErrorComponentProps } from "@tanstack/react-router";
import { Compass, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { getStoredUser, homeFor } from "@/client/arena3/client";
import { cn } from "@/client/lib/cn";
import { t, tk } from "@/client/lib/i18n";

// These two screens are what a person sees when the app itself has failed, so they lean on as little
// of it as they can: icons, the translator and the stored role, nothing from the component kit.

// Khóa dịch i18n cho câu thông báo lỗi chung khi không đọc được chi tiết lỗi.
const FALLBACK_MESSAGE = tk("An unexpected error occurred. Try reloading the page.");

/**
 * Làm gì: Trích xuất nội dung thông báo lỗi từ đối tượng error nhận được để hiển thị lên màn hình.
 * Được gọi ở: src/client/lib/error-component.tsx (component AppErrorComponent).
 * @param error Đối tượng lỗi bất kỳ do TanStack Router bắt được (Error, chuỗi string hoặc kiểu unknown).
 * @returns Chuỗi thông báo lỗi cụ thể nếu có, hoặc câu thông báo mặc định FALLBACK_MESSAGE.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return t(FALLBACK_MESSAGE);
}

/**
 * Where "Back to home" goes: the signed-in person's own home, or the front page.
 *
 * Read after mount, because local storage does not exist while the server renders. A plain link, so
 * it loads the page afresh instead of asking a router that may be the thing that broke.
 */
/**
 * Làm gì: Hook xác định đường dẫn trang chủ phù hợp với vai trò của người dùng (nếu đã đăng nhập) hoặc trang chủ mặc định ('/').
 * Được gọi ở: src/client/lib/error-component.tsx (các component AppErrorComponent và AppNotFoundComponent).
 * @returns Chuỗi đường dẫn URL trang chủ (ví dụ: '/app', '/coach', '/desk', '/manager' hoặc '/').
 */
function useHomePath(): string {
  const [home, setHome] = useState("/");
  // Chỉ đọc localStorage sau khi component đã mount trên client để tránh lỗi khi render phía server (SSR).
  useEffect(() => {
    const user = getStoredUser();
    // Cập nhật đường dẫn trang chủ theo vai trò (role) của tài khoản: admin/manager, coach, desk hay member.
    if (user) setHome(homeFor(user.role));
  }, []);
  return home;
}

// Lớp CSS tiện ích Tailwind dùng chung cho các nút bấm hành động (Reload, Back to home).
const button =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-lg)] px-5 text-sm font-medium";

/**
 * Làm gì: Component hiển thị giao diện báo lỗi tổng quát khi xảy ra ngoại lệ không mong muốn trong ứng dụng.
 * Được gọi ở: src/router.tsx (thuộc tính defaultErrorComponent khi khởi tạo createRouter).
 * @param error Đối tượng lỗi do TanStack Router bắt và truyền vào (chứa message và stack trace).
 * @returns Phần tử JSX biểu diễn toàn màn hình lỗi kèm nút tải lại trang và nút quay về trang chủ.
 */
export function AppErrorComponent({ error }: ErrorComponentProps) {
  // Bước 1: Lấy đường dẫn trang chủ tương ứng với vai trò của người dùng hiện tại.
  const home = useHomePath();
  // Bước 2: Render giao diện báo sự cố; dùng thẻ <a> thuần thay vì <Link> để tải lại trang mới hoàn toàn nếu router bị lỗi.
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-bg px-6 py-10 text-center text-fg"
    >
      <span className="text-danger" aria-hidden="true">
        <TriangleAlert className="size-10" strokeWidth={2} />
      </span>
      <div role="alert" className="grid justify-items-center gap-3">
        <h1 className="font-display text-2xl">{t("Something went wrong")}</h1>
        <p className="max-w-md text-sm text-muted">{t("This screen stopped working. Reloading usually fixes it.")}</p>
        {/* What the browser reported, for whoever has to look into it. */}
        <p className="max-w-md rounded-[var(--radius-sm)] bg-wood px-3 py-2 text-xs break-words text-muted">
          {errorMessage(error)}
        </p>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className={cn(button, "bg-accent text-accent-fg")}
        >
          <RefreshCw className="size-4" strokeWidth={1.75} aria-hidden="true" />
          {t("Reload page")}
        </button>
        <a href={home} className={cn(button, "border border-line-strong bg-surface text-fg")}>
          {t("Back to home")}
        </a>
      </div>
    </main>
  );
}

/**
 * The page for a URL that does not exist.
 *
 * Without one, TanStack renders its own `<p>Not Found</p>` — no styling, no
 * nav, and nothing to click. A mistyped address, a stale bookmark or a member
 * link that has since moved all landed a visitor on a blank white page with no
 * way back into the centre.
 */
/**
 * Làm gì: Component hiển thị màn hình 404 (Không tìm thấy trang) khi người dùng truy cập route không tồn tại.
 * Được gọi ở: src/router.tsx (thuộc tính defaultNotFoundComponent khi khởi tạo createRouter).
 * @returns Phần tử JSX giao diện 404 với thông báo và nút điều hướng quay về trang chủ.
 */
export function AppNotFoundComponent() {
  // Bước 1: Lấy đường dẫn trang chủ phù hợp với tài khoản hiện tại để dẫn lối quay về an toàn.
  const home = useHomePath();
  // Bước 2: Render giao diện 404 thông báo trang không tồn tại kèm nút quay về trang chủ.
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-bg px-6 py-10 text-center text-fg"
    >
      <span className="text-muted" aria-hidden="true">
        <Compass className="size-10" strokeWidth={1.5} />
      </span>
      <h1 className="font-display text-3xl">{t("This page isn’t here")}</h1>
      <p className="max-w-md text-sm text-muted">
        {t("The address may have changed, or the link that brought you here is out of date.")}
      </p>
      <a href={home} className={cn(button, "mt-2 bg-accent text-accent-fg")}>
        {t("Back to home")}
      </a>
    </main>
  );
}
