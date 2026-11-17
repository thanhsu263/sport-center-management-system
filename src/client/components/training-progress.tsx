/**
 * Module: training-progress.tsx
 * Vai trò trong ứng dụng: Tập hợp các component UI hiển thị tiến độ tập luyện của hội viên, gồm vòng tròn tiến độ (ActivityRings), chuỗi ngày tập liên tục (WorkoutStreak), thẻ cột mốc kỹ năng (NextMilestoneCard) và huy hiệu đếm ngược đến buổi tập tiếp theo (SessionCountdown).
 * Vị trí sử dụng: Được tích hợp tại trang quản lý luyện tập của hội viên (/app/train) và trang tổng quan của huấn luyện viên (/coach).
 */
import { useEffect, useState } from "react";
import { Flame, Trophy, Clock } from "lucide-react";
import { cn } from "@/client/lib/cn";
import { t } from "@/client/lib/i18n";
import { useReducedMotionAfterMount } from "./motion";

/**
 * Làm gì: Hiển thị vòng tròn tiến độ tập luyện SVG (Activity Rings) trực quan hóa tỷ lệ phần trăm số buổi tập hoàn thành so với mục tiêu đề ra.
 * Được gọi ở: src/routes/app.train.tsx (trang quản lý luyện tập của hội viên, route /app/train).
 * @param pct Tỷ lệ % tiến độ có thể truyền trực tiếp từ bên ngoài (0-100); nếu không truyền sẽ tự động tính từ sessionsDone và sessionsGoal.
 * @param sessionsDone Số buổi tập học viên đã hoàn thành (mặc định 0).
 * @param sessionsGoal Mục tiêu số buổi tập cần đạt trong kỳ.
 * @param className Tùy biến class CSS Tailwind cho khối bao quanh vòng tròn tiến độ.
 * @returns JSX.Element Vòng tròn tiến độ SVG kèm nhãn số phần trăm hoặc số buổi hoàn thành ở chính giữa.
 */
export function ActivityRings({
  pct,
  sessionsDone = 0,
  sessionsGoal,
  className,
}: {
  pct?: number | null;
  sessionsDone?: number;
  sessionsGoal?: number | null;
  className?: string;
}) {
  // Bước 1: Kiểm tra cài đặt giảm hiệu ứng chuyển động của hệ điều hành (prefers-reduced-motion) để tắt animation trên vòng tròn SVG nếu người dùng yêu cầu.
  const reduced = useReducedMotionAfterMount();
  // Bước 2: Thiết lập thông số hình học SVG với bán kính radius = 42 và chu vi circumference = 2 * π * r để làm cơ sở tính toán stroke-dashoffset.
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  // Bước 3: Xác định tỷ lệ % hoàn thành (displayPct). Nếu có đặt mục tiêu thì tính theo tỷ lệ hoàn thành (tối đa 100%), nếu không có mục tiêu nhưng đã tập ít nhất 1 buổi thì hiển thị đầy 100%.
  const hasGoal = sessionsGoal != null && sessionsGoal > 0;
  const displayPct = hasGoal
    ? (pct ?? Math.min(100, Math.round((sessionsDone / sessionsGoal) * 100)))
    : sessionsDone > 0
      ? 100
      : 0;
  // Bước 4: Tính khoảng bù viền nét vẽ (strokeDashoffset) tương ứng với displayPct để vòng tròn SVG lấp đầy theo chiều kim đồng hồ khi tiến độ tăng.
  const strokeDashoffset = circumference - (displayPct / 100) * circumference;

  // Bước 5: Render vòng tròn SVG (xoay -90 độ để điểm bắt đầu ở vị trí 12 giờ) gồm đường ray nền mờ và đường tiến độ có hiệu ứng chuyển động, cùng nhãn thông số ở giữa.
  return (
    <div className={cn("flex flex-col items-center justify-center p-4 text-center sm:p-5", className)}>
      <div className="relative flex items-center justify-center size-28 sm:size-32">
        <svg className="size-full -rotate-90 transform" viewBox="0 0 100 100">
          {/* Background Track */}
          <circle
            cx="50"
            cy="50"
            r={radius}
            className="stroke-line"
            strokeWidth="9"
            fill="transparent"
          />
          {/* Progress Ring */}
          <circle
            cx="50"
            cy="50"
            r={radius}
            className={cn("stroke-accent", reduced ? "" : "transition-all duration-1000 ease-out")}
            strokeWidth="9"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            fill="transparent"
          />
        </svg>

        {/* Center content */}
        <div className="absolute flex flex-col items-center justify-center">
          {hasGoal ? (
            <>
              <span className="font-display text-xl font-bold text-fg sm:text-2xl">{displayPct}%</span>
              <span className="text-2xs text-muted font-medium">{t("Goal")}</span>
            </>
          ) : (
            <>
              <span className="font-display text-xl font-bold text-fg sm:text-2xl">{sessionsDone}</span>
              <span className="text-2xs text-muted font-medium">{t("Sessions")}</span>
            </>
          )}
        </div>
      </div>

      <p className="mt-2.5 text-xs font-semibold text-fg">
        {hasGoal
          ? t("{done} of {goal} sessions", { done: sessionsDone, goal: sessionsGoal })
          : t("{n} completed sessions", { n: sessionsDone })}
      </p>
    </div>
  );
}

/**
 * Làm gì: Hiển thị thẻ chuỗi ngày tập luyện liên tiếp (workout streak) kèm dải 7 nút tròn biểu thị các ngày trong tuần (T2 đến CN).
 * Được gọi ở: src/routes/app.train.tsx (trang hội viên /app/train - khối thống kê chuỗi ngày tập).
 * @param days Số ngày tập luyện liên tiếp hiện tại (mặc định 0).
 * @param activeDays Mảng 7 phần tử boolean ứng với 7 ngày trong tuần từ Thứ Hai đến Chủ Nhật, đánh dấu true nếu ngày đó có buổi tập.
 * @param className Tùy biến class CSS Tailwind cho thẻ bọc ngoài.
 * @returns JSX.Element Thẻ thống kê chuỗi ngày tập với biểu tượng ngọn lửa và dải 7 nút trạng thái tuần.
 */
export function WorkoutStreak({
  days = 0,
  activeDays = [false, false, false, false, false, false, false],
  className,
}: {
  days?: number;
  activeDays?: boolean[];
  className?: string;
}) {
  // Bước 1: Khởi tạo danh sách ký tự viết tắt đại diện cho 7 ngày trong tuần từ Thứ Hai đến Chủ Nhật (hỗ trợ đa ngôn ngữ qua hàm t).
  const weekDays = [t("M"), t("T"), t("W"), t("T"), t("F"), t("S"), t("S")];

  // Bước 2: Render thẻ thông tin gồm icon ngọn lửa, tổng số ngày streak và dải 7 nút tròn đánh dấu ngày có tập (dấu tick màu nổi bật) hoặc chưa tập (dấu chấm).
  return (
    <div className={cn("flex flex-col justify-between rounded-[var(--radius-lg)] border border-line bg-surface p-4 shadow-[var(--shadow-soft)]", className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="grid size-8 place-items-center rounded-full bg-hold/15 text-hold">
            <Flame className="size-4.5" strokeWidth={2.2} />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-fg sm:text-sm">{t("Workout streak")}</h4>
            <p className="text-2xs text-muted">
              {days > 0 ? t("{n} days in a row", { n: days }) : t("Train regularly to build a streak!")}
            </p>
          </div>
        </div>
        <span className="font-display text-lg font-bold text-hold sm:text-xl">
          {days} {t("days")}
        </span>
      </div>

      {/* 7-day pill strip */}
      <div className="mt-3.5 flex items-center justify-between gap-1">
        {weekDays.map((d, i) => (
          <div key={i} className="flex flex-col items-center gap-1.5">
            <span className="text-2xs font-medium text-muted">{d}</span>
            <div
              className={cn(
                "size-6 sm:size-7 rounded-full flex items-center justify-center text-2xs font-semibold transition-colors",
                activeDays[i]
                  ? "bg-accent text-accent-fg shadow-[var(--shadow-accent)]"
                  : "bg-wood/60 text-muted",
              )}
            >
              {activeDays[i] ? "✓" : "·"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Làm gì: Hiển thị thẻ thông tin cột mốc kỹ năng tiếp theo của hội viên, hoặc gợi ý đăng ký lớp học nếu chưa có cột mốc.
 * Được gọi ở: src/routes/app.train.tsx (trang hội viên /app/train - khối thông tin cấp độ và cột mốc kỹ năng).
 * @param target Tên cấp độ kỹ năng hiện tại hoặc cột mốc tiếp theo (ví dụ: Beginner, Intermediate); null hoặc undefined nếu chưa tham gia lớp nào.
 * @param className Tùy biến class CSS Tailwind cho thẻ bọc ngoài.
 * @returns JSX.Element Thẻ gợi ý đăng ký lớp (khi chưa có target) hoặc thẻ tiến trình đánh giá cấp độ kỹ năng từ huấn luyện viên.
 */
export function NextMilestoneCard({
  target,
  className,
}: {
  target?: string | null;
  className?: string;
}) {
  // Bước 1: Xử lý trường hợp hội viên chưa có cấp độ mục tiêu (chưa đăng ký lớp nào) -> Render thẻ kêu gọi tham gia lớp học để mở khóa cột mốc kỹ năng.
  if (!target) {
    return (
      <div className={cn("flex flex-col justify-between rounded-[var(--radius-lg)] border border-line bg-surface p-4 shadow-[var(--shadow-soft)]", className)}>
        <div className="flex items-center gap-2">
          <div className="grid size-8 place-items-center rounded-full bg-accent/15 text-accent-2">
            <Trophy className="size-4.5" strokeWidth={2} />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-fg sm:text-sm">{t("Skill milestones")}</h4>
            <p className="text-2xs text-muted">{t("Enrol in a class to unlock milestones.")}</p>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between">
          <p className="text-2xs text-muted">{t("Learn techniques with coach")}</p>
          <a
            href="/app/classes"
            className="inline-flex items-center justify-center rounded-[var(--radius-md)] bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition-colors hover:opacity-90"
          >
            {t("Explore classes")}
          </a>
        </div>
      </div>
    );
  }

  // Bước 2: Xử lý trường hợp đã có cấp độ mục tiêu -> Render thẻ hiển thị cấp độ hiện tại và thông báo về quy trình huấn luyện viên đánh giá sau mỗi buổi học.
  return (
    <div className={cn("flex flex-col justify-between rounded-[var(--radius-lg)] border border-line bg-surface p-4 shadow-[var(--shadow-soft)]", className)}>
      <div className="flex items-center gap-2">
        <div className="grid size-8 place-items-center rounded-full bg-accent/15 text-accent-2">
          <Trophy className="size-4.5" strokeWidth={2} />
        </div>
        <div>
          <h4 className="text-xs font-semibold text-fg sm:text-sm">{t("Next milestone")}</h4>
          <p className="text-2xs text-muted">{t("Current level: {level}", { level: target })}</p>
        </div>
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between text-2xs font-medium text-muted mb-1.5">
          <span>{t("Progress")}</span>
          <span className="font-semibold text-accent-2">{t("Coach assessment")}</span>
        </div>
        <p className="text-xs text-muted">
          {t("Your coach reviews and updates your level after class sessions.")}
        </p>
      </div>
    </div>
  );
}

/**
 * Làm gì: Hiển thị huy hiệu (pill badge) đếm ngược thời gian còn lại đến khi buổi tập tiếp theo bắt đầu, tự động cập nhật mỗi 30 giây.
 * Được gọi ở:
 * - src/routes/app.train.tsx (danh sách các buổi tập sắp tới của hội viên).
 * - src/routes/coach.index.tsx (thẻ thông tin buổi dạy kế tiếp của huấn luyện viên).
 * @param startAt Chuỗi thời gian bắt đầu buổi tập (định dạng ISO string hợp lệ để khởi tạo Date).
 * @param className Tùy biến class CSS Tailwind cho huy hiệu.
 * @returns JSX.Element Huy hiệu đếm ngược chứa biểu tượng đồng hồ (Clock) và chuỗi văn bản thời gian còn lại.
 */
export function SessionCountdown({
  startAt,
  className,
}: {
  startAt: string;
  className?: string;
}) {
  // Bước 1: Khởi tạo state lưu chuỗi văn bản đếm ngược hiển thị trên giao diện (ví dụ: "in 2h 15m", "Starting now").
  const [left, setLeft] = useState<string>("");

  // Bước 2: Kích hoạt hook useEffect để tính toán thời gian đếm ngược và duy trì chu kỳ cập nhật định kỳ.
  useEffect(() => {
    /**
     * Làm gì: Tính toán khoảng thời gian chênh lệch từ thời điểm hiện tại đến giờ bắt đầu buổi tập và định dạng chuỗi hiển thị tương ứng.
     * Được gọi ở: useEffect trong SessionCountdown (chạy ngay lần đầu khi mount và lặp lại mỗi 30 giây qua setInterval).
     * @returns void
     */
    function update() {
      // Bước 2.1: Tính chênh lệch mili-giây giữa giờ bắt đầu và thời điểm hiện tại. Nếu buổi tập đã đến hoặc đã qua giờ bắt đầu thì hiển thị trạng thái bắt đầu ngay.
      const diff = new Date(startAt).getTime() - Date.now();
      if (diff <= 0) {
        setLeft(t("Starting now"));
        return;
      }
      // Bước 2.2: Quy đổi thời gian chênh lệch còn lại ra số giờ và số phút (3.600.000 ms = 1 giờ, 60.000 ms = 1 phút).
      const hrs = Math.floor(diff / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      // Bước 2.3: Định dạng chuỗi hiển thị: từ 48 giờ trở lên hiển thị theo ngày, từ 1 đến 47 giờ hiển thị cả giờ và phút, dưới 1 giờ chỉ hiển thị số phút.
      // Under two days, hours read better than "in 1 days".
      if (hrs >= 48) {
        const days = Math.floor(hrs / 24);
        setLeft(t("in {n} days", { n: days }));
      } else if (hrs > 0) {
        setLeft(t("in {h}h {m}m", { h: hrs, m: mins }));
      } else {
        setLeft(t("in {m} minutes", { m: mins }));
      }
    }
    // Bước 2.4: Gọi hàm update() ngay lập tức để hiển thị kết quả đếm ngược ngay khi component vừa mount mà không phải chờ chu kỳ interval đầu tiên.
    update();
    // Bước 2.5: Đặt lịch gọi update() định kỳ mỗi 30.000 ms (30 giây) để cập nhật đếm ngược, đồng thời đăng ký hàm dọn dẹp clearInterval khi component unmount nhằm tránh rò rỉ bộ nhớ.
    const interval = setInterval(update, 30000);
    return () => clearInterval(interval);
  }, [startAt]);

  // Bước 3: Render huy hiệu bo tròn (pill) chứa biểu tượng Clock và chuỗi thời gian còn lại.
  return (
    <div className={cn("inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent-2", className)}>
      <Clock className="size-3.5" />
      <span>{left}</span>
    </div>
  );
}
