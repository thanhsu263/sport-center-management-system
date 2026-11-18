/**
 * Mục đích: Màn hình điểm danh và điều hành buổi học dành cho huấn luyện viên (coach) và quản lý (manager).
 * Vị trí trong app: Route `/coach/attendance`. Cho phép chọn buổi tập từ lịch dạy, thực hiện điểm danh học viên
 * (hỗ trợ quy tắc khóa sổ sau 2 giờ BR-35), ghi nhận kết quả đánh giá (Results), xem giáo án (Plan) và giao bài tập (Homework).
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MapPin, Users } from "lucide-react";
import { useState } from "react";
import { StepTabs } from "@/client/components/coach-ui";
import { sessionDay } from "@/client/components/class-detail";
import { HomeworkPanel, PlanPanel, ResultsPanel } from "@/client/components/coach-training";
import { Shell, hhmm, useSessionUser } from "@/client/components/shell";
import {
  Badge,
  Card,
  EmptyState,
  Field,
  LoadError,
  Select,
  Skeleton,
} from "@/client/components/ui";
import { levelLabel, sportLabel } from "@/shared/arena3/labels";
import { t } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";
import { HighlightBadge, useLive } from "@/client/lib/use-live";
import { RegisterPanel, type RegisterData, type SessionRow } from "@/client/components/register-panel";

/**
 * Làm gì: Định nghĩa route `/coach/attendance` trong TanStack Router; xác thực search param session để chọn đúng buổi học cần điểm danh.
 * Được gọi ở: URL `/coach/attendance` (được điều hướng từ src/routes/coach.index.tsx qua nút điểm danh, hoặc menu trong src/client/components/shell.tsx).
 * @returns Đối tượng Route cấu hình cho đường dẫn `/coach/attendance` gắn với component Page.
 */
export const Route = createFileRoute("/coach/attendance")({
  validateSearch: (search: Record<string, unknown>): { session?: string } => ({
    session: typeof search.session === "string" ? search.session : undefined,
  }),
  component: Page,
});


/**
 * Làm gì: Component trang chính hiển thị màn hình điểm danh và điều hành buổi tập cho huấn luyện viên hoặc quản lý; xử lý chọn buổi học, cờ tính năng F4/F5, các tab thao tác và đồng bộ dữ liệu thời gian thực.
 * Được gọi ở: Thuộc tính component của Route tại route `/coach/attendance`.
 * @returns Giao diện điểm danh và điều hành buổi học bọc trong component Shell.
 */
function Page() {
  // Bước 1: Khởi tạo router hook, đọc search param 'session', lấy thông tin người dùng và tải danh sách lịch dạy (/coach/schedule) cùng cờ tính năng (/flags).
  const { session: sessionParam } = Route.useSearch();
  const navigate = useNavigate();
  const user = useSessionUser();
  const scheduleRead = useRead<{ items: SessionRow[] }>("/coach/schedule");
  const flagsRead = useRead<{ flags: Record<string, boolean> }>("/flags");
  const items = scheduleRead.data?.items ?? null;
  // A flags read that fails leaves the features on, as it always did; the register's own read then
  // says so if attendance really is off.
  const flags = flagsRead.data?.flags ?? {};
  const flagsReady = flagsRead.data !== null || flagsRead.error !== null;
  // The tab belongs to the session it was picked on, so choosing another session starts at the
  // register again without anything having to remember to reset it.
  const [picked, setPicked] = useState({ id: "", step: "register" });

  // Bước 2: Xác định buổi học đang chọn (open) theo thứ tự ưu tiên: session từ URL -> buổi sắp diễn ra -> buổi đầu tiên trong lịch.
  // The session in the address bar (from a schedule card) is the one whose register is on screen;
  // with none chosen, the next one to come.
  const open =
    items?.find((s) => s.id === sessionParam) ??
    items?.find((s) => s.status === "scheduled") ??
    items?.[0] ??
    null;

  // Bước 3: Kiểm tra cờ F4, quyền hạn manager và xác định đường dẫn API tải danh sách điểm danh (/sessions/:id/attendance hoặc fallback roster lớp).
  const f4 = flags.F4 !== false;
  const isManager = user?.role === "manager";
  // The register is asked for here, not in the panel, so the header can say it has closed. The answer
  // follows the path: switching session drops the old roll at once instead of leaving it on screen
  // under the new session's time.
  const registerPath =
    open && flagsReady
      ? f4
        ? `/sessions/${open.id}/attendance`
        : `/classes/${open.class_id}/roster`
      : null;
  const register = useRead<RegisterData>(registerPath);
  // Lắng nghe sự kiện realtime "attendance" qua WebSocket/SSE để tự động làm mới danh sách điểm danh và lịch khi có cập nhật.
  useLive("attendance", () => {
    register.reload();
    scheduleRead.reload();
  });
  // After the lock only a manager may correct a register, and must say why (BR-35).
  const locked = !!register.data?.session?.locked;

  // Bước 4: Thiết lập các tab quy trình (điểm danh, kết quả, giáo án, bài tập). Nếu cờ F4 bị tắt thì chỉ cho phép thực hiện bước điểm danh ("register").
  const steps = [
    { value: "register", label: t("Attendance") },
    { value: "results", label: t("Results") },
    { value: "plan", label: t("Session plan") },
    { value: "homework", label: t("Homework") },
  ];
  const step = picked.id === open?.id ? picked.step : "register";
  const current = f4 ? step : "register";

  // Bước 5: Render giao diện trang gồm thẻ thông tin buổi học, bộ chuyển đổi buổi học, thanh tab quy trình và panel nội dung tương ứng.
  return (
    <Shell
      role="coach"
      title={t("Attendance")}
      subtitle={t("Pick a session, mark who came, then plan the next one.")}
    >
      {scheduleRead.error ? (
        <LoadError
          message={scheduleRead.error.message}
          onRetry={scheduleRead.error.refused ? undefined : scheduleRead.reload}
        />
      ) : !items ? (
        <Skeleton className="h-24" />
      ) : !items.length ? (
        <EmptyState
          title={t("No sessions to take a register for")}
          hint={t("Sessions appear here once a class you teach is published.")}
        />
      ) : (
        <div className="mx-auto grid max-w-3xl gap-5">
          <Card className="grid gap-4 p-4 sm:p-5">
            {open ? (
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
                <div>
                  <p className="text-sm text-muted">{sessionDay(open.start_at)}</p>
                  <p className="figure text-3xl tabular-nums">
                    {hhmm(open.start_at)}
                    <span className="text-muted">-{hhmm(open.end_at)}</span>
                  </p>
                </div>
                <div className="grid gap-1 text-sm sm:justify-items-end">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone="accent">{sportLabel(open.sport)}</Badge>
                    <Badge tone="muted">{levelLabel(open.level)}</Badge>
                    {locked ? <Badge tone="hold">{t("Locked")}</Badge> : null}
                  </p>
                  <p className="flex items-center gap-4 text-muted tabular-nums">
                    <span className="inline-flex items-center gap-1.5">
                      <MapPin aria-hidden className="size-4" />
                      {t("Court {court}", { court: open.court_code })}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Users aria-hidden className="size-4" />
                      <HighlightBadge value={open.enrolled_count}>{open.enrolled_count}</HighlightBadge>/{open.capacity}
                    </span>
                  </p>
                </div>
              </div>
            ) : null}
            <Field label={t("Change session")}>
              <Select
                value={open?.id ?? ""}
                onChange={(e) =>
                  void navigate({ to: "/coach/attendance", search: { session: e.target.value } })
                }
              >
                {items.map((s) => (
                  <option key={s.id} value={s.id}>
                    {sessionDay(s.start_at)} · {hhmm(s.start_at)} · {sportLabel(s.sport)} {levelLabel(s.level)} · {t("Court")} {s.court_code}
                  </option>
                ))}
              </Select>
            </Field>
          </Card>

          {open && f4 ? (
            <StepTabs
              value={current}
              onChange={(value) => setPicked({ id: open.id, step: value })}
              steps={steps}
            />
          ) : null}

          {open && current === "register" ? (
            <RegisterPanel
              // A new session, or the same one asked for another way, starts from a clean sheet: no
              // marks, reason or "Saved" carried over from the roll that was open before.
              key={registerPath ?? "pending"}
              session={open}
              f4={f4}
              read={register}
              isManager={isManager}
            />
          ) : null}

          {open && f4 && current === "results" ? (
            <ResultsPanel sessionId={open.id} cancelled={open.status === "cancelled"} />
          ) : null}
          {open && f4 && current === "plan" ? (
            <PlanPanel
              session={open}
              f5={flags.F5 !== false}
              onPickSession={(id) => {
                // Chỉ chuyển khi buổi đó có trong lịch, và giữ nguyên tab Giáo án để form đang sửa không mất
                if (!items.some((s) => s.id === id)) return;
                setPicked({ id, step: "plan" });
                void navigate({ to: "/coach/attendance", search: { session: id } });
              }}
            />
          ) : null}
          {open && f4 && current === "homework" ? <HomeworkPanel classId={open.class_id} /> : null}
        </div>
      )}
    </Shell>
  );
}
