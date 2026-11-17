/**
 * File: src/client/components/coach-ui.tsx
 * Vai trò: Cung cấp các thành phần giao diện (UI) dùng chung cho các màn hình làm việc của huấn luyện viên (coach).
 * Vị trí trong app:
 * - Chứa component StepTabs: thanh điều hướng dạng tab phân bước hoặc tab chuyển màn hình con cho HLV.
 * - Được sử dụng trong quy trình điểm danh buổi tập (/coach/attendance) và màn hình hồ sơ học viên (/coach/student/:id).
 */
import { cn } from "@/client/lib/cn";

/**
 * Làm gì: Hiển thị thanh tab điều hướng phân bước (StepTabs) hoặc tab danh mục cho các màn hình làm việc của huấn luyện viên.
 * Hỗ trợ đánh số thứ tự từng bước (khi numbered=true) hoặc hiển thị dạng tab thông thường căn giữa (khi numbered=false), làm nổi bật bước đang chọn.
 * Được gọi ở:
 * - src/routes/coach.attendance.tsx: component AttendanceSession tại route /coach/attendance (chuyển đổi giữa bước điểm danh "register" và đánh giá "evaluate").
 * - src/routes/coach.student.$id.tsx: component StudentDetailPage tại route /coach/student/:id (chuyển đổi giữa các tab "progress", "notes", "history").
 * @param value Mã định danh (key) của tab hoặc bước hiện đang được kích hoạt.
 * @param onChange Hàm callback nhận vào mã value mới khi huấn luyện viên nhấn chọn tab khác.
 * @param steps Danh sách các bước hoặc tab cần hiển thị, mỗi mục gồm mã value và nhãn hiển thị label.
 * @param numbered Cờ tùy chọn xác định có hiển thị huy hiệu số thứ tự 1, 2, 3... hay không (mặc định là true).
 * @returns Khung JSX container (div role="tablist") chứa các nút bấm tab điều hướng.
 */
/**
 * Numbered steps for a long job split into short screens: only the chosen step is on the page,
 * the others are one tap away. The number says "there is an order", the tick says "done".
 */
export function StepTabs({
  value,
  onChange,
  steps,
  numbered = true,
}: {
  value: string;
  onChange: (v: string) => void;
  steps: { value: string; label: string }[];
  numbered?: boolean;
}) {
  return (
    <div role="tablist" className="flex flex-wrap gap-1.5">
      {steps.map((s, i) => {
        const active = s.value === value;
        return (
          <button
            key={s.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(s.value)}
            className={cn(
              numbered ? "min-w-[9.5rem]" : "min-w-[6.5rem] justify-center",
              "flex min-h-12 flex-1 items-center gap-2.5 rounded-[var(--radius-md)] border px-3 text-left text-sm font-medium transition-colors duration-150",
              active
                ? "border-accent bg-accent/10 text-accent-2"
                : "border-line bg-surface text-muted hover:bg-wood hover:text-fg",
            )}
          >
            {numbered ? (
              <span
                aria-hidden
                className={cn(
                  "grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold tabular-nums",
                  active ? "bg-accent text-accent-fg" : "bg-wood text-muted",
                )}
              >
                {i + 1}
              </span>
            ) : null}
            <span className="min-w-0 leading-tight">{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}
