/**
 * File: src/client/components/row-actions.tsx
 * Vai trò: Cung cấp component RowActions dùng chung trên giao diện bảng hoặc danh sách quản lý.
 * Hỗ trợ hiển thị nút thao tác chính (primary action) và menu dropdown ba chấm chứa các thao tác phụ (secondary actions)
 * kèm tính năng xác nhận (confirm dialog) trước khi thực hiện hành động.
 */
import {
  useState,
  useRef,
  useEffect,
  type ComponentType,
} from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/client/lib/cn";

/**
 * Kiểu dữ liệu định nghĩa một mục thao tác phụ trong menu dropdown của RowActions.
 * Bao gồm tên hiển thị (label), hàm xử lý (onClick), icon, trạng thái vô hiệu hóa (disabled),
 * đánh dấu thao tác nguy hiểm (danger như xóa hoặc khóa) và thông báo xác nhận trước khi thực hiện (confirm/confirmMessage).
 */
export type RowActionItem = {
  label: string;
  onClick: () => void;
  icon?: ComponentType<{ className?: string }>;
  danger?: boolean;
  disabled?: boolean;
  confirm?: string;
  confirmMessage?: string;
};

/**
 * Làm gì: Hiển thị cụm nút thao tác trên từng dòng của bảng dữ liệu, gồm nút bấm chính (primary) và menu thả xuống ba chấm chứa các thao tác phụ (secondary).
 * Được gọi ở:
 * - src/routes/manager.courts.tsx (CourtsManagementPage - danh sách sân bãi)
 * - src/routes/manager.staff.tsx (StaffManagementPage - danh sách nhân viên)
 * - src/client/components/ui/index.tsx (re-export component UI dùng chung)
 * @param props.primary Cấu hình nút thao tác chính hiển thị trực tiếp (label, onClick, icon, disabled, title).
 * @param props.secondary Danh sách các mục thao tác phụ gom trong menu dropdown ba chấm (RowActionItem[]).
 * @param props.className Lớp CSS tùy biến mở rộng cho vùng chứa (container).
 * @returns Khối JSX chứa nút bấm chính và/hoặc menu hành động phụ.
 */
export function RowActions({
  primary,
  secondary,
  className,
}: {
  primary?: {
    label: string;
    onClick: () => void;
    icon?: ComponentType<{ className?: string }>;
    disabled?: boolean;
    title?: string;
  };
  secondary?: RowActionItem[];
  className?: string;
}) {
  // Bước 1: Khởi tạo state open để quản lý đóng/mở menu dropdown và ref menuRef để theo dõi vùng DOM của menu
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Bước 2: Đăng ký sự kiện click chuột bên ngoài và nhấn phím Escape để tự động đóng dropdown menu
  useEffect(() => {
    // Bỏ qua đăng ký sự kiện khi menu đang đóng nhằm tối ưu hiệu năng và tránh lắng nghe thừa thãi
    if (!open) return;
    /**
     * Làm gì: Đóng menu dropdown nếu người dùng nhấp chuột ra ngoài phạm vi của menu.
     * Được gọi ở: Sự kiện mousedown gắn trên document khi dropdown mở.
     * @param event Sự kiện chuột mousedown từ người dùng.
     * @returns Không trả về giá trị (void).
     */
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    /**
     * Làm gì: Đóng menu dropdown khi người dùng nhấn phím Escape để hỗ trợ thao tác bàn phím (accessibility/a11y).
     * Được gọi ở: Sự kiện keydown gắn trên document khi dropdown mở.
     * @param event Sự kiện bàn phím từ người dùng.
     * @returns Không trả về giá trị (void).
     */
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    // Lắng nghe sự kiện click chuột và phím bấm trên toàn document khi menu mở
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    // Hủy đăng ký các sự kiện khi dropdown đóng hoặc component bị unmount để tránh rò rỉ bộ nhớ (memory leak)
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  // Bước 3: Trích xuất component icon của nút hành động chính (nếu có) để render linh hoạt
  const PrimaryIcon = primary?.icon;

  // Bước 4: Render nút chính (primary) và nút menu ba chấm (secondary) kèm dropdown xác nhận thao tác nguy hiểm
  return (
    <div className={cn("relative inline-flex items-center gap-1.5", className)}>
      {primary ? (
        <button
          type="button"
          onClick={primary.onClick}
          disabled={primary.disabled}
          title={primary.title}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] border border-line bg-surface px-2.5 py-1 text-xs font-medium text-fg shadow-[var(--shadow-border)] transition-colors hover:bg-wood hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          {PrimaryIcon ? <PrimaryIcon className="size-3.5 text-muted" /> : null}
          <span>{primary.label}</span>
        </button>
      ) : null}

      {secondary && secondary.length > 0 ? (
        <div ref={menuRef} className="relative inline-block text-left">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-haspopup="true"
            aria-label="Thao tác khác"
            className={cn(
              "inline-flex size-7 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] border border-line bg-surface text-muted transition-colors hover:bg-wood hover:text-fg focus:outline-none focus:ring-1 focus:ring-accent",
              open && "bg-wood text-fg border-line-strong",
            )}
          >
            <MoreHorizontal className="size-4" />
          </button>

          {open ? (
            <div
              role="menu"
              className="absolute right-0 top-full z-50 mt-1 min-w-[140px] origin-top-right rounded-[var(--radius-md)] border border-line bg-surface p-1 shadow-[var(--shadow-soft)] animate-in fade-in zoom-in-95 duration-100"
            >
              {secondary.map((item, idx) => {
                const ItemIcon = item.icon;
                const handleClick = () => {
                  setOpen(false);
                  const confirmMsg = item.confirmMessage ?? item.confirm;
                  if (confirmMsg) {
                    if (window.confirm(confirmMsg)) {
                      item.onClick();
                    }
                  } else {
                    item.onClick();
                  }
                };

                return (
                  <button
                    key={idx}
                    type="button"
                    role="menuitem"
                    disabled={item.disabled}
                    onClick={handleClick}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 rounded-[var(--radius-xs)] px-2.5 py-1.5 text-left text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                      item.danger
                        ? "text-danger hover:bg-danger/10"
                        : "text-fg hover:bg-wood",
                    )}
                  >
                    {ItemIcon ? (
                      <ItemIcon
                        className={cn("size-3.5", item.danger ? "text-danger" : "text-muted")}
                      />
                    ) : null}
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
