/**
 * File: src/routes/manager.attendance.tsx
 * Vai trò: Định nghĩa route và component trang Quản lý điểm danh (/manager/attendance) dành cho vai trò Quản lý (Manager).
 * Vị trí trong app:
 * - Route URL /manager/attendance được quản lý bởi TanStack Router, nằm dưới route layout cha /manager (kiểm tra quyền manager).
 * - Được liên kết trực tiếp trên thanh điều hướng chính (dock menu) của vai trò manager (cấu hình tại src/shared/ui-config.ts).
 * - Cung cấp 2 bảng điều khiển chính từ src/client/components/attendance-panels.tsx:
 *   + AttendancePanel: Thống kê tỷ lệ điểm danh theo lớp, HLV, học viên kèm tính năng xuất file báo cáo (canExport).
 *   + AtRiskPanel: Cảnh báo danh sách học viên có nguy cơ bỏ tập và ghi nhận lịch sử liên hệ chăm sóc.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { sessionDay } from "@/client/components/class-detail";
import { RegisterPanel, type RegisterData, type SessionRow } from "@/client/components/register-panel";
import { AtRiskPanel, AttendancePanel } from "@/client/components/attendance-panels";
import { Shell, hhmm } from "@/client/components/shell";
import { Badge, Card, EmptyState, Field, LoadError, Seg, Select, Skeleton } from "@/client/components/ui";
import { useLive } from "@/client/lib/use-live";
import { useRead } from "@/client/lib/use-read";
import { levelLabel, sportLabel } from "@/shared/arena3/labels";
import { t } from "@/client/lib/i18n";

/**
 * Làm gì: Định nghĩa route /manager/attendance trong TanStack Router, liên kết URL với component hiển thị Page.
 * Được gọi ở: URL /manager/attendance (TanStack Router quản lý; kích hoạt khi người dùng chọn mục Attendance trên thanh dock của manager).
 * @returns Đối tượng cấu hình route của TanStack Router cho đường dẫn /manager/attendance.
 */
export const Route = createFileRoute("/manager/attendance")({ component: Page });

/**
 * Làm gì: Component trang quản lý điểm danh của Manager, điều khiển chuyển đổi giữa tab tỷ lệ điểm danh và tab học viên có nguy cơ bỏ tập.
 * Được gọi ở: src/routes/manager.attendance.tsx (component của Route /manager/attendance).
 * @returns Element JSX hiển thị giao diện trang quản lý điểm danh bọc trong layout Shell.
 */
function Page() {
  // Bước 1: Khởi tạo state tab để lưu tab đang chọn, mặc định là "rate" (Tỷ lệ điểm danh).
  const [tab, setTab] = useState("rate");
  // Bước 2: Render giao diện trong khung Shell với bộ chuyển tab Seg; tab "rate" cho phép xuất báo cáo (canExport), tab "risk" hiển thị danh sách học viên có nguy cơ bỏ tập.
  return (
    <Shell
      role="manager"
      title={t("Attendance")}
      subtitle={t("How often members come, and who has stopped coming.")}
    >
      <div className="mb-4">
        <Seg
          value={tab}
          onChange={setTab}
          options={[
            { value: "rate", label: t("Attendance rate") },
            { value: "risk", label: t("At risk") },
            { value: "edit", label: t("Edit attendance") },
          ]}
        />
      </div>
      {tab === "rate" ? <AttendancePanel canExport /> : tab === "risk" ? <AtRiskPanel /> : <CorrectRegister />}
    </Shell>
  );
}

/**
 * Làm gì: Cho quản lý chọn một buổi học trong 14 ngày gần đây và sửa điểm danh; sổ đã khóa (quá 2 giờ sau buổi) vẫn sửa được nhưng phải ghi lý do (BR-35).
 * Được gọi ở: Page, tab "edit".
 */
function CorrectRegister() {
  const schedule = useRead<{ items: SessionRow[] }>("/coach/schedule");
  const items = schedule.data?.items ?? null;
  // Mặc định buổi gần nhất đã bắt đầu, vì chưa bắt đầu thì chưa điểm danh được.
  const started = items?.filter((s) => new Date(s.start_at).getTime() <= Date.now() && s.status !== "cancelled") ?? [];
  const [picked, setPicked] = useState("");
  const open = started.find((s) => s.id === picked) ?? started[0] ?? null;
  const register = useRead<RegisterData>(open ? `/sessions/${open.id}/attendance` : null);
  useLive("attendance", () => {
    register.reload();
    schedule.reload();
  });
  const locked = !!register.data?.session?.locked;

  if (schedule.error) {
    return <LoadError message={schedule.error.message} onRetry={schedule.error.refused ? undefined : schedule.reload} />;
  }
  if (!items) return <Skeleton className="h-24" />;
  if (!started.length) {
    return (
      <EmptyState
        title={t("No sessions to correct")}
        hint={t("Sessions from the last two weeks appear here once they have started.")}
      />
    );
  }
  return (
    <div className="mx-auto grid max-w-3xl gap-5">
      <Card className="grid gap-3 p-4 sm:p-5">
        <Field label={t("Session")}>
          <Select value={open?.id ?? ""} onChange={(e) => setPicked(e.target.value)}>
            {started.map((s) => (
              <option key={s.id} value={s.id}>
                {sessionDay(s.start_at)} · {hhmm(s.start_at)} · {sportLabel(s.sport)} {levelLabel(s.level)} · {t("Court")} {s.court_code}
              </option>
            ))}
          </Select>
        </Field>
        {open ? (
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <Badge tone="accent">{sportLabel(open.sport)}</Badge>
            <Badge tone="muted">{levelLabel(open.level)}</Badge>
            {locked ? <Badge tone="hold">{t("Locked")}</Badge> : null}
            <span className="tabular-nums">
              {open.enrolled_count}/{open.capacity}
            </span>
          </p>
        ) : null}
      </Card>
      {open ? (
        <RegisterPanel
          key={open.id}
          session={open}
          f4
          read={register}
          isManager
          studentLinks={false}
        />
      ) : null}
    </div>
  );
}
