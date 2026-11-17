/**
 * Giao diện và định tuyến trang thông báo cá nhân (/app/notifications) trong hệ thống Arena 3.
 * Dành cho hội viên (role: member) để theo dõi các thông báo như biên lai thanh toán, cập nhật lịch đặt sân và phản hồi từ quầy lễ tân.
 * Hỗ trợ phân trang 25 thông báo/trang, bộ lọc chỉ hiển thị tin chưa đọc và cập nhật trạng thái đã đọc theo thời gian thực (realtime).
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { NotificationList, type Notification } from "@/client/components/notifications";
import { Shell } from "@/client/components/shell";
import { Button, EmptyState, LoadError, Pagination, Skeleton } from "@/client/components/ui";
import { t } from "@/client/lib/i18n";
import { usePageState } from "@/client/lib/use-page-state";
import { useRead } from "@/client/lib/use-read";
import { useLive } from "@/client/lib/use-live";

/**
 * Làm gì: Khởi tạo định tuyến cho đường dẫn /app/notifications bằng TanStack Router, liên kết URL với component hiển thị Page.
 * Được gọi ở: URL /app/notifications (TanStack Router tự động đăng ký và nạp route khi hội viên truy cập).
 * @returns Route cấu hình cho đường dẫn /app/notifications.
 */
export const Route = createFileRoute("/app/notifications")({
  component: Page,
});

/** The member's inbox, apart from the account menu (G-08), a page at a time. */
/**
 * Làm gì: Component hiển thị hộp thư thông báo của hội viên; quản lý bộ lọc tin chưa đọc, phân trang dữ liệu và cập nhật trạng thái đã đọc tức thì (optimistic update).
 * Được gọi ở: src/routes/app.notifications.tsx trong Route (dòng 11).
 * @returns Phần tử JSX hiển thị hộp thư thông báo bọc trong khung Shell vai trò member.
 */
function Page() {
  // Bước 1: Khởi tạo state lọc tin chưa đọc và quản lý phân trang.
  // usePageState lưu vị trí trang theo key "notifications" vào sessionStorage/URL, mặc định 25 mục mỗi trang.
  const [onlyNew, setOnlyNew] = useState(false);
  const { offset, setOffset, pageSize, setPageSize, reset } = usePageState("notifications", 25);
  // Reset vị trí phân trang về đầu trang (offset = 0) mỗi khi người dùng chuyển đổi bộ lọc chỉ tin chưa đọc.
  useEffect(reset, [onlyNew, reset]);
  // Bước 2: Thiết lập query params và gọi API /me/notifications để tải danh sách thông báo.
  // Tham số keepPrevious: true giữ lại dữ liệu trang cũ khi đang tải trang mới để tránh giật giao diện.
  const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
  if (onlyNew) params.set("unread", "1");
  const { data, error, reload } = useRead<{ items: Notification[]; total: number; unread: number }>(
    `/me/notifications?${params}`,
    { keepPrevious: true },
  );
  // Lắng nghe sự kiện thông báo thời gian thực (SSE/WebSocket) để tự động gọi reload cập nhật danh sách mới nhất.
  useLive("notifications", reload);
  // Bước 3: Đồng bộ danh sách thông báo từ server vào local state items để hỗ trợ đánh dấu đã đọc tức thì (optimistic update).
  // The page is the server's copy, marked read here as the person opens things.
  const [items, setItems] = useState<Notification[] | null>(null);
  // Cập nhật lại local state items mỗi khi server trả về dữ liệu thông báo mới.
  useEffect(() => {
    setItems(data?.items ?? null);
  }, [data]);

  const total = data?.total ?? 0;
  // The toggle is worth showing once something has been read, or while it is on.
  const showToggle = onlyNew || (data ? data.unread < data.total : false);

  // Bước 4: Render giao diện hộp thư trong Shell vai trò member; xử lý các trạng thái lỗi, đang tải (skeleton) hoặc hiển thị danh sách.
  return (
    <Shell
      role="member"
      title={t("Notifications")}
      subtitle={t("Receipts, booking changes and replies from reception. Open one to read it.")}
    >
      {error ? (
        <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
      ) : !items ? (
        <Skeleton className="h-32" />
      ) : (
        <>
          {showToggle ? (
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => setOnlyNew((v) => !v)}>
                {onlyNew ? t("Show read ones too") : t("Hide read ones")}
              </Button>
            </div>
          ) : null}
          {!items.length ? (
            onlyNew ? (
              <EmptyState title={t("Nothing unread")} hint={t("Everything here has been read.")} />
            ) : (
              <EmptyState
                title={t("Nothing here yet")}
                hint={t("Receipts and booking updates will show up here as they happen.")}
              />
            )
          ) : (
            <>
              <NotificationList
                items={items}
                limit={pageSize}
                onRead={(ids) =>
                  setItems((cur) =>
                    (cur ?? []).map((n) =>
                      ids.includes(n.id) && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n,
                    ),
                  )
                }
              />
              <Pagination
                offset={offset}
                total={total}
                pageSize={pageSize}
                onChange={setOffset}
                onPageSizeChange={setPageSize}
                label={t("Notification pages")}
              />
            </>
          )}
        </>
      )}
    </Shell>
  );
}
