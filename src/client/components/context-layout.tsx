import { type ReactNode } from "react";
import { cn } from "@/lib/cn";

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
  if (!context) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-6 xl:flex-row xl:items-start xl:gap-8",
        reverseOnMobile && "flex-col-reverse",
        className,
      )}
    >
      {/* Main column: expands to fill remaining width */}
      <div className="min-w-0 flex-1">{children}</div>

      {/* Context column: fixed 320-360px on desktop (>=1280px), full width below 1280px */}
      <aside
        className={cn(
          "w-full shrink-0 xl:w-[340px] xl:max-w-[360px] flex flex-col gap-5",
          contextClassName,
        )}
      >
        {context}
      </aside>
    </div>
  );
}

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
