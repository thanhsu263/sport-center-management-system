/**
 * File: src/client/components/my-attendance.tsx
 * Vai trò: Component hiển thị bảng tổng kết và lịch sử điểm danh các buổi học của riêng hội viên (chức năng M-05).
 * Vị trí trong app: Nhúng trong trang lớp học của hội viên (/app/classes - src/routes/app.classes.tsx tại mục #attendance); tự động tải dữ liệu cá nhân qua hook useRead từ endpoint GET /me/attendance.
 */
import { when } from "@/client/components/shell";
import { Badge, Card, EmptyState, LoadError, Skeleton } from "@/client/components/ui";
import { levelLabel, sportLabel } from "@/shared/arena3/labels";
import { SectionTitle } from "@/client/components/section";
import { ClipboardCheck } from "lucide-react";
import { t, tk } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";

// Cấu trúc một dòng điểm danh buổi học: mã buổi, thời gian bắt đầu, môn thể thao, trình độ, mã sân và kết quả do huấn luyện viên đánh dấu.
type Row = {
  session_id: string;
  start_at: string;
  sport: string;
  level: string;
  court_code: string;
  result: "present" | "late" | "absent" | "excused" | null;
};
// Dữ liệu điểm danh trả về từ API /me/attendance: danh sách các buổi học (items) và tổng số lượng theo từng trạng thái điểm danh (counts).
type Attendance = { items: Row[]; counts: Record<"present" | "late" | "absent" | "excused", number> };

/**
 * Làm gì: Cấu hình danh sách các trạng thái điểm danh (có mặt, đi muộn, vắng mặt, có phép), kèm nhãn dịch đa ngôn ngữ và tone màu hiển thị Badge.
 * Được gọi ở: Nội bộ component MyAttendance (dùng để hiển thị các huy hiệu thống kê tổng số lượng và gắn nhãn trạng thái cho từng buổi học).
 */
const RESULTS = [
  { key: "present", label: tk("Present"), tone: "accent" },
  { key: "late", label: tk("Late"), tone: "hold" },
  { key: "absent", label: tk("Absent"), tone: "danger" },
  { key: "excused", label: tk("Excused"), tone: "muted" },
] as const;

/**
 * The member's own record of finished class sessions (M-05): what the coach
 * marked each one — present, late, absent or excused — and nothing about anyone
 * else. A session the coach has not marked yet says so rather than guessing.
 */
/**
 * Làm gì: Hiển thị bảng tổng hợp và danh sách kết quả điểm danh cá nhân của hội viên cho các buổi học đã diễn ra (chức năng M-05).
 * Được gọi ở: src/routes/app.classes.tsx (component Page tại route /app/classes, phần #attendance).
 * @returns Khối JSX <section> hiển thị các huy hiệu tổng kết số buổi và danh sách chi tiết điểm danh từng buổi học.
 */
export function MyAttendance() {
  // Bước 1: Gọi API GET /me/attendance qua hook useRead để tải danh sách các buổi học đã diễn ra và số liệu thống kê chuyên cần của hội viên.
  // Endpoint này chỉ trả về dữ liệu của chính hội viên đang đăng nhập (M-05), đảm bảo không lộ thông tin người khác.
  const { data, error, reload } = useRead<Attendance>("/me/attendance");

  // Bước 2: Render giao diện khu vực điểm danh gồm tiêu đề SectionTitle và xử lý các trạng thái: lỗi (LoadError), đang tải (Skeleton), chưa có buổi học nào (EmptyState), hoặc danh sách buổi học kèm huy hiệu tổng kết.
  return (
    <section aria-labelledby="my-attendance" className="mt-10">
      <SectionTitle id="my-attendance" icon={ClipboardCheck} text={t("My attendance")} className="mb-3" />
      {error ? (
        <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
      ) : !data ? (
        <Skeleton className="h-24" />
      ) : !data.items.length ? (
        <EmptyState
          title={t("No finished sessions yet")}
          hint={t("After each class your coach marks you present, late, absent or excused, and the marks show up here.")}
        />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            {RESULTS.map((r) => (
              <Badge key={r.key} tone={r.tone}>
                {t(r.label)} · {data.counts[r.key] ?? 0}
              </Badge>
            ))}
          </div>
          <Card className="divide-y divide-line p-0">
            {data.items.map((row) => {
              const r = RESULTS.find((x) => x.key === row.result);
              return (
                <div key={row.session_id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <span className="text-sm">
                    <span className="font-medium">
                      {sportLabel(row.sport)} · {levelLabel(row.level)}
                    </span>
                    <span className="block text-xs text-muted">
                      {when(row.start_at)} · {row.court_code}
                    </span>
                  </span>
                  {r ? <Badge tone={r.tone}>{t(r.label)}</Badge> : <Badge tone="muted">{t("Not marked yet")}</Badge>}
                </div>
              );
            })}
          </Card>
        </>
      )}
    </section>
  );
}
