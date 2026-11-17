/**
 * File: src/client/components/connection-banner.tsx
 * Vai trò: Thanh thông báo trạng thái kết nối mạng và phản hồi từ máy chủ ở phía client.
 * Vị trí trong app: Được nhúng ở đầu component Shell (src/client/components/shell.tsx) trên mọi trang,
 * cảnh báo người dùng khi mất kết nối mạng (offline), lỗi máy chủ (server/broken),
 * hoặc thông báo kết nối lại thành công (back) kèm nút bấm để tải lại trang.
 */
import { useRouterState } from "@tanstack/react-router";
import { CircleCheck, RefreshCw, ServerCrash, WifiOff, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/client/components/ui";
import { cn } from "@/client/lib/cn";
import { dismissBack, newScreen, retryNow, useLink } from "@/client/lib/connection";
import { t } from "@/client/lib/i18n";

/**
 * The one place that says the screen cannot reach its server, and how to get going again.
 *
 * It sits at the top of every signed-in page. Before it, a dropped signal left a page on grey blocks
 * with a toast that faded after a few seconds; now the page says what is wrong and offers a button
 * that opens the screen again.
 */
/**
 * Làm gì: Hiển thị banner trạng thái kết nối mạng hoặc lỗi phản hồi máy chủ ở đầu trang, cung cấp nút tải lại để mở lại màn hình.
 * Được gọi ở: src/client/components/shell.tsx (component Shell, nằm ngay trên phần nội dung chính của trang).
 * @returns Khối JSX thông báo trạng thái kết nối tương ứng hoặc null nếu đường truyền mạng ổn định ("ok").
 */
export function ConnectionBanner() {
  // Bước 1: Lắng nghe trạng thái kết nối từ store và khởi tạo state theo dõi quá trình thử lại kết nối (busy, missed).
  const link = useLink();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [busy, setBusy] = useState(false);
  const [missed, setMissed] = useState(false);

  // "This page could not load" is about one page; once another is on show it is stale.
  useEffect(() => {
    newScreen();
  }, [pathname]);

  // Bước 2: Nếu kết nối mạng và máy chủ bình thường (link === "ok"), ẩn banner (trả về null).
  if (link === "ok") return null;

  /**
   * Làm gì: Thử kết nối lại với máy chủ và tải lại dữ liệu màn hình hiện tại.
   * Được gọi ở: Nút "Reload page" khi vừa có mạng trở lại (link === "back") hoặc khi gặp lỗi kết nối.
   * @returns Không trả về giá trị (hàm async cập nhật state nội bộ).
   */
  async function retry() {
    // Bật cờ busy để hiển thị hiệu ứng xoay icon và gọi retryNow() thăm dò máy chủ qua /v1/health.
    setBusy(true);
    setMissed(false);
    const ok = await retryNow();
    setBusy(false);
    // On success the banner unmounts with the reload; on failure say that nothing changed.
    if (!ok) setMissed(true);
  }

  // Bước 3: Định nghĩa khung giao diện dùng chung (shell), ghim dính ở vị trí top-16 ngay dưới thanh điều hướng.
  const shell = "sticky top-16 z-10 mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-lg)] border px-4 py-3 text-sm shadow-[var(--shadow-border)]";

  // Bước 4: Nếu vừa có mạng trở lại (link === "back"), hiển thị banner màu xanh lá kèm nút tải lại trang và nút đóng.
  if (link === "back") {
    return (
      <div key="back" role="status" className={cn(shell, "border-success/30 bg-surface")}>
        <CircleCheck className="size-5 shrink-0 text-success" strokeWidth={1.75} aria-hidden="true" />
        <p className="min-w-0 flex-1 basis-48 font-medium">{t("You are connected again.")}</p>
        <Button size="sm" variant="outline" onClick={() => void retry()} disabled={busy}>
          <RefreshCw className="size-4" strokeWidth={1.75} aria-hidden="true" />
          {t("Reload page")}
        </Button>
        <button
          type="button"
          onClick={dismissBack}
          aria-label={t("Close")}
          className="-mr-2 grid size-11 place-items-center rounded-[var(--radius-sm)] text-muted hover:bg-wood hover:text-fg sm:size-9"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    );
  }

  // Bước 5: Xác định icon hiển thị, tiêu đề lỗi và gợi ý xử lý tùy theo từng loại sự cố ("offline", "broken", "server").
  const Icon = link === "offline" ? WifiOff : ServerCrash;
  const heading =
    link === "offline"
      ? t("You are offline.")
      : link === "broken"
        ? t("This page could not load.")
        : t("The server is not answering.");
  const hint = missed
    ? t("Still no answer. Check the connection and try once more.")
    : link === "offline"
      ? t("Check your Wi-Fi or mobile data, then reload this page.")
      : link === "broken"
        ? t("The server had a problem. Reload the page to try again.")
        : t("It may be restarting. Wait a moment, then reload this page.");
  // Bước 6: Render khối thông báo lỗi (role="alert") với viền màu hổ phách (border-hold) và nút tải lại kèm hiệu ứng animate-spin khi bận.
  return (
    <div key="down" role="alert" className={cn(shell, "border-hold/30 bg-surface")}>
      <Icon className="size-5 shrink-0 text-hold" strokeWidth={1.75} aria-hidden="true" />
      <div className="min-w-0 flex-1 basis-48">
        <p className="font-medium">{heading}</p>
        <p className="text-xs text-muted">{hint}</p>
      </div>
      <Button size="sm" variant="outline" onClick={() => void retry()} disabled={busy}>
        <RefreshCw className={cn("size-4", busy && "animate-spin")} strokeWidth={1.75} aria-hidden="true" />
        {busy ? t("Trying…") : t("Reload page")}
      </Button>
    </div>
  );
}
