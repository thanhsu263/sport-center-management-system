/**
 * File: src/client/components/context-layout.tsx
 * Vai trò: Cung cấp layout 2 cột responsive (ContextLayout) và thẻ ngữ cảnh (ContextCard).
 * Vị trí trong app:
 * - ContextLayout chia giao diện thành cột chính (mở rộng chiếm không gian còn lại) và cột phụ ngữ cảnh sidebar (cố định trên màn hình desktop xl >= 1280px, xếp dọc trên mobile).
 * - ContextCard chuẩn hóa giao diện các thẻ thông tin phụ ở cột sidebar (tiêu đề, phụ đề, badge, nút thao tác).
 * - Được re-export tại src/client/components/ui/index.tsx và sử dụng trong trang đặt sân (src/routes/app.book.tsx).
 */
import { type ReactNode } from "react";
import { cn } from "@/client/lib/cn";

/**
 * Làm gì: Layout 2 cột responsive chia màn hình thành khu vực nội dung chính và cột ngữ cảnh sidebar phụ trợ.
 * Cột context cố định độ rộng trên desktop (xl >= 1280px) và tự động xếp chồng trên màn hình nhỏ.
 * Được gọi ở: src/routes/app.book.tsx (component BookPage - route /app/book), re-export tại src/client/components/ui/index.tsx
 * @param children Nội dung chính của trang (chiếm toàn bộ phần không gian mở rộng còn lại).
 * @param context Nội dung ngữ cảnh phụ ở sidebar (như tóm tắt sân đã chọn, lớp học, thông tin gói tập).
 * @param className Tùy chỉnh class CSS cho container bọc ngoài cùng.
 * @param contextClassName Tùy chỉnh class CSS riêng cho cột aside chứa context.
 * @param reverseOnMobile Đảo ngược thứ tự đưa cột context lên trên nội dung chính trên màn hình nhỏ (mặc định false).
 * @returns JSX.Element Layout 2 cột responsive hoàn chỉnh.
 */
export function ContextLayout({
  children,
  context,
  className,
  contextClassName,
  reverseOnMobile = false,
}: {
  children: ReactNode;
  context?: ReactNode;
  className?: string;
  contextClassName?: string;
  reverseOnMobile?: boolean;
}) {
  // Bước 1: Nếu không truyền context (sidebar), chỉ render nội dung chính mà không cần chia cột
  if (!context) {
    return <div className={className}>{children}</div>;
  }

  // Bước 2: Render bố cục 2 cột responsive (cột chính co giãn flex-1, cột aside có chiều rộng cố định trên desktop)
  return (
    <div
      className={cn(
        "flex w-full min-w-0 flex-col gap-6 xl:flex-row xl:items-start xl:gap-8",
        reverseOnMobile && "flex-col-reverse",
        className,
      )}
    >
      {/* Main column: expands to fill remaining width */}
      <div className="w-full min-w-0 flex-1">{children}</div>

      {/* Context column: fixed 320-360px on desktop (>=1280px), full width below 1280px */}
      <aside
        className={cn(
          "flex w-full min-w-0 shrink-0 flex-col gap-5 xl:w-[340px] xl:max-w-[360px]",
          contextClassName,
        )}
      >
        {context}
      </aside>
    </div>
  );
}

/**
 * Làm gì: Thẻ hiển thị một khối thông tin ngữ cảnh với header (tiêu đề, phụ đề, badge, nút thao tác) và phần thân.
 * Chuẩn hóa giao diện cho các khối widget tóm tắt đặt trong cột context của ContextLayout.
 * Được gọi ở: Re-export tại src/client/components/ui/index.tsx để các trang nghiệp vụ sử dụng trong sidebar.
 * @param title Tiêu đề chính của thẻ context.
 * @param subtitle Dòng mô tả hoặc phụ đề giải thích thêm nằm dưới tiêu đề.
 * @param badge Huy hiệu trạng thái hoặc nhãn phụ hiển thị cạnh tiêu đề.
 * @param action Nút bấm hoặc component thao tác nhanh ở góc trên bên phải header.
 * @param children Nội dung chi tiết bên trong thân thẻ.
 * @param className Tùy chỉnh class CSS cho thẻ bọc ngoài.
 * @returns JSX.Element Khối card hoàn chỉnh với header tùy chọn và phần thân thẻ.
 */
export function ContextCard({
  title,
  subtitle,
  badge,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-lg)] border border-line bg-surface p-4 shadow-[var(--shadow-soft)] transition-colors",
        className,
      )}
    >
      {title || subtitle || badge || action ? (
        <div className="mb-3 flex items-start justify-between gap-2 border-b border-line/60 pb-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {title ? (
                <h3 className="font-display text-sm font-bold text-fg sm:text-base">
                  {title}
                </h3>
              ) : null}
              {badge}
            </div>
            {subtitle ? (
              <p className="mt-0.5 text-xs text-muted leading-snug">{subtitle}</p>
            ) : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </div>
  );
}
