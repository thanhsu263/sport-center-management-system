/**
 * Tuyến đường (route) màn hình danh sách lớp học dành cho bộ phận lễ tân (/desk/classes).
 * Cho phép nhân viên lễ tân tra cứu thông tin các lớp học thể thao (môn học, trình độ, HLV, sân tập, sĩ số, lịch lặp rrule)
 * để giải đáp thắc mắc cho hội viên và khách vãng lai tại quầy (nghiệp vụ D-07).
 * Hỗ trợ đồng bộ dữ liệu thời gian thực và xem chi tiết danh sách học viên/ca học qua ClassDetailModal.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ClassDetailModal } from "@/client/components/class-detail";
import { Shell } from "@/client/components/shell";
import { Button, Card, EmptyState, LoadError, ShowMore, Skeleton, StatusBadge } from "@/client/components/ui";
import { Stagger, StaggerItem } from "@/client/components/motion";
import { t } from "@/client/lib/i18n";
import { levelLabel, rruleLabel, sportLabel } from "@/shared/arena3/labels";
import { useRead } from "@/client/lib/use-read";
import { HighlightBadge, useLive } from "@/client/lib/use-live";

/**
 * Làm gì: Định nghĩa route cho màn hình danh sách lớp học của lễ tân tại đường dẫn /desk/classes, gắn kết với component Page.
 * Được gọi ở: URL /desk/classes (TanStack Router, đăng ký trong src/routeTree.gen.ts).
 * @returns Đối tượng route được cấu hình cho TanStack Router.
 */
export const Route = createFileRoute("/desk/classes")({
  component: Page,
});

// Cấu trúc dữ liệu của từng lớp học trong danh sách trả về từ endpoint /classes.
type Row = {
  id: string;
  code: string;
  sport: string;
  level: string;
  status: string;
  court_code: string;
  coach_name: string;
  enrolled_count: number;
  capacity: number;
  rrule?: string;
  duration_min?: number;
};

/** The same classes the manager sees, so the desk can answer "who is in it, and when?" (D-07). */
/**
 * Làm gì: Component trang hiển thị danh sách lớp học cho lễ tân, hỗ trợ phân trang client, cập nhật realtime và mở modal xem chi tiết học viên/buổi học.
 * Được gọi ở: src/routes/desk.classes.tsx (thuộc tính component của Route tại URL /desk/classes).
 * @returns Giao diện Shell lễ tân chứa lưới thẻ lớp học, trạng thái tải/lỗi và modal chi tiết.
 */
function Page() {
  // Bước 1: Tải danh sách lớp học từ API /classes và đăng ký kênh realtime "classes" để tự động cập nhật khi có thay đổi dữ liệu
  const read = useRead<{ items: Row[] }>("/classes");
  useLive("classes", read.reload);
  // Dữ liệu danh sách lớp: null khi đang tải lần đầu, mảng rỗng nếu chưa có lớp học nào mở
  const items = read.data?.items ?? null;
  // Bước 2: Khởi tạo state lưu ID lớp học để mở modal chi tiết (detail) và giới hạn số lượng thẻ hiển thị ban đầu (limit: 8 lớp)
  const [detail, setDetail] = useState<string | null>(null);
  const [limit, setLimit] = useState(8);

  // Bước 3: Render giao diện khung Shell với vai trò receptionist:
  // - Hiển thị LoadError nếu xảy ra lỗi tải, Skeleton khi đang tải dữ liệu, hoặc EmptyState nếu không có lớp nào mở.
  // - Hiển thị danh sách lớp học dạng lưới 2 cột kèm hiệu ứng chuyển động Stagger; mỗi Card thể hiện mã lớp, môn, cấp độ, HLV, sân, sĩ số và lịch lặp.
  // - Phân trang phía client với ShowMore (tăng 8 lớp mỗi lần bấm) và mở ClassDetailModal khi chọn xem buổi học & học viên.
  return (
    <Shell role="receptionist" title={t("Classes")} subtitle={t("Open a class to see its sessions, court, coach and who is enrolled.")}>
      {read.error ? (
        <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />
      ) : !items ? (
        <Skeleton className="h-36" />
      ) : !items.length ? (
        <EmptyState title={t("No classes are open")} hint={t("The manager publishes classes from the Classes screen.")} />
      ) : (
        <Stagger className="grid gap-3 md:grid-cols-2" gap={0.06}>
          {items.slice(0, limit).map((c) => (
            <StaggerItem key={c.id}>
              <Card className="h-full">
                <div className="flex items-center justify-between gap-2">
                  <StatusBadge status={c.status} />
                  <span className="text-2xs tabular-nums text-muted">{c.code}</span>
                </div>
                <h2 className="mt-2 font-display text-2xl">
                  {sportLabel(c.sport)} · {levelLabel(c.level)}
                </h2>
                <p className="text-sm text-muted">
                  {c.coach_name} · {c.court_code} ·{" "}
                  <span className="tabular-nums">
                    <HighlightBadge value={c.enrolled_count}>{c.enrolled_count}</HighlightBadge>/{c.capacity}
                  </span>
                </p>
                {c.rrule ? <p className="text-sm">{rruleLabel(c.rrule, c.duration_min)}</p> : null}
                <Button className="mt-3" variant="outline" onClick={() => setDetail(c.id)}>
                  {t("Sessions & students")}
                </Button>
              </Card>
            </StaggerItem>
          ))}
        </Stagger>
      )}
      {items?.length ? <ShowMore shown={Math.min(limit, items.length)} total={items.length} step={8} onMore={() => setLimit((n) => n + 8)} /> : null}
      <ClassDetailModal classId={detail} onClose={() => setDetail(null)} />
    </Shell>
  );
}
