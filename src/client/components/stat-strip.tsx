/**
 * File: src/client/components/stat-strip.tsx
 * Vai trò: Thành phần giao diện dải thẻ thống kê (Stat Strip / KPI Cards) dùng chung.
 * Phục vụ các trang Dashboard quản trị (manager.*) và bàn lễ tân (desk.*)
 * hiển thị nhanh các chỉ số trọng yếu (doanh thu, lượt đặt sân, hội viên, xu hướng tăng giảm).
 */
import { type ComponentType } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/client/lib/cn";
import { CountUp, useReducedMotionAfterMount } from "./motion";

/**
 * Kiểu dữ liệu mô tả từng thẻ chỉ số thống kê (KPI item) trong dải StatStrip.
 * Chứa nhãn (label), giá trị (value), tiền tố/hậu tố, xu hướng tăng giảm (trend), icon và cờ trạng thái trực tiếp (live).
 */
export type StatItem = {
  id?: string;
  label: string;
  value: number | string;
  prefix?: string;
  suffix?: string;
  trend?: {
    direction: "up" | "down" | "flat";
    pct: number;
    label?: string;
    good?: boolean;
  };
  icon?: ComponentType<{ className?: string }>;
  detail?: string;
  live?: boolean;
};

/**
 * Làm gì: Hiển thị dải thẻ thống kê (KPI cards) theo bố cục lưới responsive (2, 3 hoặc 4 cột).
 * Hỗ trợ hiệu ứng số nhảy (CountUp), nhãn xu hướng (trend % tăng/giảm), icon và chấm xung nhịp trực tiếp (live pulse).
 * Được gọi ở: desk.courts.tsx, manager.courts.tsx, manager.classes.tsx, manager.members.tsx,
 * manager.plans.tsx, manager.prices.tsx, manager.promos.tsx, manager.settings.tsx,
 * manager.staff.tsx, manager.media.tsx (hoặc re-export qua src/client/components/ui/index.tsx).
 * @param props Các thuộc tính giao diện:
 * - stats, items: Danh sách thẻ chỉ số (StatItem[]), hỗ trợ cả 2 tên prop để tương thích ngược.
 * - columns: Số cột hiển thị ở desktop (2 | 3 | 4, mặc định là 4).
 * - className: Lớp CSS tùy biến bổ sung cho thẻ bọc container.
 * @returns JSX.Element Lưới các thẻ chỉ số thống kê hoàn chỉnh kèm hiệu ứng số động.
 */
export function StatStrip({
  stats,
  items,
  className,
  columns = 4,
}: {
  stats?: StatItem[];
  items?: StatItem[];
  className?: string;
  columns?: 2 | 3 | 4;
}) {
  // Bước 1: Chuẩn hóa dữ liệu đầu vào và kiểm tra chế độ giảm chuyển động của hệ điều hành
  // Hỗ trợ cả 2 prop `stats` và `items` để tương thích ngược; nếu bật reduced motion thì tắt animation CountUp
  const list = stats ?? items ?? [];
  const reduced = useReducedMotionAfterMount();

  // Bước 2: Thiết lập class lưới responsive tùy theo số cột mong muốn (columns: 2, 3 hoặc 4 cột)
  const colClass =
    columns === 2
      ? "grid-cols-1 sm:grid-cols-2"
      : columns === 3
        ? "grid-cols-1 sm:grid-cols-3"
        : "grid-cols-2 lg:grid-cols-4";

  // Bước 3: Render giao diện lưới chứa các thẻ thống kê (card) kèm hiệu ứng động
  return (
    <div className={cn("grid gap-3 sm:gap-4", colClass, className)}>
      {list.map((s, idx) => {
        const Icon = s.icon;
        const trend = s.trend;
        const isUp = trend?.direction === "up";
        const isDown = trend?.direction === "down";
        // By default, up is positive (green), unless good === false (e.g. cancellations)
        const isPositive =
          trend &&
          ((isUp && trend.good !== false) || (isDown && trend.good === false));

        return (
          <div
            key={s.id ?? idx}
            className="flex flex-col justify-between rounded-[var(--radius-lg)] border border-line bg-surface p-3.5 sm:p-4 shadow-[var(--shadow-soft)] transition-colors hover:border-line-strong"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted">
                {s.live ? (
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
                  </span>
                ) : null}
                {s.label}
              </span>
              {Icon ? <Icon className="size-4 shrink-0 text-subtle" /> : null}
            </div>

            <div className="mt-2 flex items-baseline justify-between gap-2">
              <div className="font-display text-2xl font-bold tracking-tight text-fg sm:text-3xl">
                {s.prefix}
                {typeof s.value === "number" && !reduced ? (
                  <CountUp to={s.value} duration={0.9} />
                ) : (
                  s.value
                )}
                {s.suffix}
              </div>

              {trend ? (
                <div
                  className={cn(
                    "flex items-center gap-0.5 rounded-[var(--radius-pill)] px-2 py-0.5 text-2xs font-semibold",
                    isPositive
                      ? "bg-accent/10 text-accent-2 dark:text-accent"
                      : isDown
                        ? "bg-danger/10 text-danger"
                        : "bg-wood text-muted",
                  )}
                  title={trend.label ?? "so với tuần trước"}
                >
                  {isUp ? (
                    <ArrowUpRight className="size-3" strokeWidth={2.5} />
                  ) : isDown ? (
                    <ArrowDownRight className="size-3" strokeWidth={2.5} />
                  ) : (
                    <Minus className="size-3" strokeWidth={2.5} />
                  )}
                  <span>
                    {isUp ? "+" : isDown ? "-" : ""}
                    {Math.abs(trend.pct)}%
                  </span>
                </div>
              ) : null}
            </div>

            {s.detail ? (
              <div className="mt-1 text-2xs text-subtle">{s.detail}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
