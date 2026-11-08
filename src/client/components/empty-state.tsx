import { type ComponentType, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/cn";
import { Spot, type SpotName } from "./illustrations";
import { useAsset } from "./media";
import { t } from "@/lib/i18n";

export type EmptyStateAction = {
  label: string;
  onClick?: () => void;
  to?: string;
  icon?: ComponentType<{ className?: string }>;
};

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
  const asset = useAsset(assetSlot);
  const isActionObj = Boolean(action && typeof action === "object" && "label" in (action as object));
  const actionObj = isActionObj ? (action as EmptyStateAction) : undefined;
  const ActionIcon = actionObj?.icon;
  const effectiveSpot = spot ?? art ?? "empty";
  const effectiveDesc = description ?? (hint ? t(hint) : undefined);
  const effectiveTitle = typeof title === "string" ? t(title) : title;

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
