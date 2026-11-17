/**
 * File: src/routes/alerts.tsx
 * Vai trò: Định nghĩa route và trang hiển thị danh sách cảnh báo vận hành (/alerts) dành cho nhân viên (manager, coach, receptionist).
 * Vị trí trong app:
 * - Route "/alerts" được bảo vệ bởi Guard, chỉ cho phép các vai trò nhân viên truy cập (hội viên có trang thông báo riêng tại /app/notifications).
 * - Được liên kết từ biểu tượng chuông thông báo trên thanh Shell (src/client/components/shell.tsx).
 * - Hiển thị các cảnh báo cần xử lý (như học viên vắng nhiều buổi liên tiếp), hỗ trợ phân trang và cập nhật realtime qua kết nối live SSE.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { NotificationList, type Notification } from "@/client/components/notifications";
import { Guard, Shell, useSessionUser } from "@/client/components/shell";
import { EmptyState, LoadError, Pagination, Skeleton } from "@/client/components/ui";
import { t } from "@/client/lib/i18n";
import { usePageState } from "@/client/lib/use-page-state";
import { useRead } from "@/client/lib/use-read";
import { useLive } from "@/client/lib/use-live";

/**
 * Làm gì: Khởi tạo route TanStack Router cho đường dẫn /alerts, áp dụng Guard để phân quyền cho nhân viên (manager, coach, receptionist).
 * Được gọi ở: /alerts (URL route được quản lý bởi TanStack Router; kích hoạt khi người dùng điều hướng hoặc bấm icon chuông trên Shell).
 * @returns Route configuration object của TanStack Router cho trang /alerts.
 */
export const Route = createFileRoute("/alerts")({
  component: () => (
    <Guard roles={["manager", "coach", "receptionist"]}>
      <Page />
    </Guard>
  ),
});

/** Staff alerts — a student on a run of absences, for one. Members have their own inbox. */
/**
 * Làm gì: Component trang hiển thị danh sách cảnh báo cho nhân viên, quản lý phân trang, tải dữ liệu thông báo từ server, lắng nghe realtime và cập nhật trạng thái đã đọc.
 * Được gọi ở: src/routes/alerts.tsx (component của Route /alerts).
 * @returns Giao diện trang cảnh báo bọc trong component Shell.
 */
function Page() {
  // Bước 1: Lấy thông tin user đăng nhập và khởi tạo phân trang (mặc định 25 mục/trang, lưu theo key "alerts").
  const user = useSessionUser();
  const { offset, setOffset, pageSize, setPageSize } = usePageState("alerts", 25);
  // Bước 2: Tải danh sách thông báo theo phân trang; giữ lại dữ liệu cũ (keepPrevious) khi đổi trang để tránh chớp màn hình.
  const { data, error, reload } = useRead<{ items: Notification[]; total: number }>(
    `/me/notifications?limit=${pageSize}&offset=${offset}`,
    { keepPrevious: true },
  );
  // Bước 3: Đăng ký lắng nghe sự kiện realtime qua SSE trên kênh "notifications" để tự động tải lại dữ liệu khi có cảnh báo mới.
  useLive("notifications", reload);
  // Bước 4: Khởi tạo state nội bộ để quản lý danh sách thông báo và đồng bộ với dữ liệu từ server.
  // The list is the server's copy, marked read here as the person opens things.
  const [items, setItems] = useState<Notification[] | null>(null);
  useEffect(() => {
    setItems(data?.items ?? null);
  }, [data]);

  // Bước 5: Render giao diện trong Shell với các trạng thái tương ứng: lỗi tải, đang tải (skeleton), danh sách rỗng, hoặc danh sách thông báo kèm bộ phân trang.
  return (
    <Shell role={user?.role ?? "coach"} title={t("Alerts")} subtitle={t("Things that need a look. Open one to read it.")}>
      {error ? (
        <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
      ) : !items ? (
        <Skeleton className="h-32" />
      ) : !items.length ? (
        <EmptyState title={t("Nothing here yet")} hint={t("You'll be told when a student misses three sessions in a row.")} />
      ) : (
        <>
          <NotificationList
            items={items}
            limit={pageSize}
            onRead={(ids) =>
              setItems((cur) =>
                (cur ?? []).map((n) => (ids.includes(n.id) && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n)),
              )
            }
          />
          <Pagination
            offset={offset}
            total={data?.total ?? 0}
            pageSize={pageSize}
            onChange={setOffset}
            onPageSizeChange={setPageSize}
            label={t("Alert pages")}
          />
        </>
      )}
    </Shell>
  );
}
