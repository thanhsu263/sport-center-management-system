import {
  useState,
  useRef,
  useEffect,
  type ComponentType,
} from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/cn";

export type RowActionItem = {
  label: string;
  onClick: () => void;
  icon?: ComponentType<{ className?: string }>;
  danger?: boolean;
  disabled?: boolean;
  confirm?: string;
  confirmMessage?: string;
};

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
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const PrimaryIcon = primary?.icon;

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
