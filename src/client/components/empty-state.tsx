/**
 * File: src/client/components/empty-state.tsx
 * Vai trò: Component giao diện hiển thị trạng thái rỗng (empty state) khi không có dữ liệu, danh sách trống hoặc kết quả lọc không tìm thấy.
 * Vị trí trong app: Thuộc tầng Client UI, được tái sử dụng trên toàn bộ các trang (Member, Desk, Coach, Manager) để thông báo cho người dùng kèm hình minh họa và nút kêu gọi hành động (call-to-action).
 */
import { type ComponentType, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "@/client/lib/cn";
import { Spot, type SpotName } from "./illustrations";
import { useAsset } from "./media";
import { t } from "@/client/lib/i18n";

/**
 * Làm gì: Định nghĩa cấu trúc dữ liệu cho nút bấm hoặc liên kết điều hướng (call-to-action) trong component EmptyState.
 * Được gọi ở: src/client/components/empty-state.tsx (prop action của EmptyState), src/client/components/ui/index.tsx (re-export).
 * Các thuộc tính:
 * - label: Nhãn văn bản hiển thị trên nút hoặc liên kết.
 * - onClick: Hàm xử lý sự kiện bấm chuột (nếu là dạng button).
 * - to: Đường dẫn điều hướng của TanStack Router (nếu là dạng Link chuyển trang).
 * - icon: Component biểu tượng tùy chọn hiển thị phía trước nhãn.
 */
export type EmptyStateAction = {
  label: string;
  onClick?: () => void;
  to?: string;
  icon?: ComponentType<{ className?: string }>;
};

/**
 * Làm gì: Component hiển thị giao diện trạng thái rỗng (empty state) với hình minh họa/asset động, tiêu đề, mô tả và nút kêu gọi hành động khi danh sách hoặc phân vùng chưa có dữ liệu.
 * Được gọi ở:
 * - Các trang nghiệp vụ: src/routes/account.tsx, src/routes/coach.classes.tsx, src/routes/desk.gate.tsx, src/routes/manager.courts.tsx...
 * - Các component: src/client/components/attendance-panels.tsx, src/client/components/coach-training.tsx
 * - Re-export tại src/client/components/ui/index.tsx
 * Các props quan trọng:
 * - title: Tiêu đề trạng thái rỗng (tự động dịch qua i18n nếu truyền chuỗi string).
 * - hint: Gợi ý phụ ngắn gọn (tự động dịch qua i18n nếu không truyền description).
 * - description: Nội dung mô tả chi tiết giải thích trạng thái dữ liệu trống.
 * - action: Cấu hình nút bấm EmptyStateAction hoặc ReactNode tùy biến.
 * - art / spot: Tên icon minh họa dạng Spot vector (dự phòng khi không có ảnh asset).
 * - assetSlot: Tên vị trí cấu hình hình ảnh động lấy từ useAsset.
 * - children: Phần tử React bổ sung hiển thị bên dưới khu vực hành động.
 * - className: Lớp CSS tùy biến bổ sung cho khung bọc ngoài cùng.
 * @returns Khối JSX giao diện trạng thái rỗng được căn giữa với đường viền nét đứt.
 */
export function EmptyState({
  title,
  hint,
  description,
  action,
  art,
  spot,
  assetSlot,
  children,
  className,
}: {
  title: string | ReactNode;
  hint?: string;
  description?: ReactNode;
  action?: EmptyStateAction | ReactNode;
  art?: SpotName;
  spot?: SpotName;
  assetSlot?: string;
  children?: ReactNode;
  className?: string;
}) {
  // Bước 1: Tra cứu asset hình ảnh động theo vị trí (assetSlot) được cấu hình trong hệ thống Media.
  const asset = useAsset(assetSlot);
  // Bước 2: Chuẩn hóa nút hành động (action) - phân biệt object cấu hình EmptyStateAction với ReactNode tùy biến.
  // Kiểm tra thuộc tính "label" để nhận diện action là object cấu hình thay vì React element thông thường.
  const isActionObj = Boolean(action && typeof action === "object" && "label" in (action as object));
  const actionObj = isActionObj ? (action as EmptyStateAction) : undefined;
  const ActionIcon = actionObj?.icon;
  // Bước 3: Xác định hình minh họa, nội dung mô tả và tiêu đề hiển thị.
  // Ưu tiên prop spot, fallback về art (prop cũ để tương thích ngược), mặc định là icon "empty".
  const effectiveSpot = spot ?? art ?? "empty";
  // Ưu tiên description truyền vào; nếu không có thì dịch chuỗi hint qua hàm t() để hỗ trợ đa ngôn ngữ.
  const effectiveDesc = description ?? (hint ? t(hint) : undefined);
  // Tự động dịch tiêu đề qua hàm t() nếu là chuỗi string; giữ nguyên nếu đã là ReactNode tùy biến.
  const effectiveTitle = typeof title === "string" ? t(title) : title;

  // Bước 4: Render giao diện thẻ rỗng với hình minh họa (ảnh asset hoặc vector Spot), tiêu đề, mô tả và nút thao tác.
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-[var(--radius-xl)] border border-dashed border-line-strong/70 bg-surface/40 p-8 text-center transition-colors sm:p-12",
        className,
      )}
    >
      {asset.enabled && asset.url ? (
        <div className="mb-4 h-28 w-44 overflow-hidden rounded-[var(--radius-lg)] border border-line shadow-[var(--shadow-soft)] sm:h-36 sm:w-56">
          <img
            src={asset.url}
            alt={asset.alt || ""}
            className="h-full w-full object-cover"
          />
        </div>
      ) : (
        <div className="mb-4 grid size-16 place-items-center rounded-full bg-wood text-accent-text">
          <Spot name={effectiveSpot} className="h-10 w-10 text-accent-text" />
        </div>
      )}

      <h3 className="font-display text-lg font-bold text-fg sm:text-xl">
        {effectiveTitle}
      </h3>

      {effectiveDesc ? (
        <p className="mt-1.5 max-w-md text-xs leading-relaxed text-muted sm:text-sm">
          {effectiveDesc}
        </p>
      ) : null}

      {action ? (
        <div className="mt-5">
          {actionObj ? (
            actionObj.to ? (
              <Link
                to={actionObj.to}
                className="inline-flex items-center gap-2 rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-xs font-semibold text-accent-fg shadow-[var(--shadow-accent)] transition-colors hover:bg-accent-hover sm:text-sm"
              >
                {ActionIcon ? <ActionIcon className="size-4" /> : null}
                {actionObj.label}
              </Link>
            ) : (
              <button
                type="button"
                onClick={actionObj.onClick}
                className="inline-flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-xs font-semibold text-accent-fg shadow-[var(--shadow-accent)] transition-colors hover:bg-accent-hover sm:text-sm"
              >
                {ActionIcon ? <ActionIcon className="size-4" /> : null}
                {actionObj.label}
              </button>
            )
          ) : (
            (action as ReactNode)
          )}
        </div>
      ) : null}

      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}
