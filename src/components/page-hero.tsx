import { type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useAsset } from "./media";
import { Spot, type SpotName } from "./illustrations";
import { CountUp, useReducedMotionAfterMount } from "./motion";
import { GLBackground } from "./fx";

export type PageHeroStat = {
  label: string;
  value: number | string;
  prefix?: string;
  suffix?: string;
  live?: boolean;
};

export function PageHero({
  slot,
  title,
  subtitle,
  badge,
  stats,
  action,
  fallbackSpot = "court",
  className,
}: {
  slot?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  stats?: PageHeroStat[];
  action?: ReactNode;
  fallbackSpot?: SpotName;
  className?: string;
}) {
  const asset = useAsset(slot);
  const reduced = useReducedMotionAfterMount();
  const hasImage = Boolean(asset.enabled && asset.url);

  return (
    <header
      className={cn(
        "relative mb-6 overflow-hidden rounded-[var(--radius-xl)] border transition-all duration-300",
        hasImage
          ? "border-night/20 bg-night text-[var(--color-on-media)] shadow-[var(--shadow-soft)]"
          : "border-line bg-gradient-to-r from-surface via-surface to-wood/40 text-fg shadow-[var(--shadow-border)]",
        // Desktop height 168px, mobile 112px (expandable when stats are present)
        "min-h-[112px] sm:min-h-[168px]",
        className,
      )}
    >
      {/* Background image & gradient overlay when asset slot is active */}
      {hasImage ? (
        <>
          <div className="absolute inset-0 z-0 overflow-hidden">
            <img
              src={asset.url}
              alt={asset.alt || ""}
              loading="eager"
              className={cn(
                "h-full w-full object-cover object-center",
                !reduced && "transition-transform duration-700 ease-out hover:scale-105",
              )}
            />
            {/* Scrim gradient layer for WCAG AA text contrast */}
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/65 to-black/30 dark:from-black/95 dark:via-black/75 dark:to-black/45"
            />
            {/* Soft dotgrid texture (disabled if reduced motion) */}
            {!reduced ? (
              <GLBackground
                variant="dotgrid"
                opacity={0.12}
                className="mix-blend-screen pointer-events-none"
              />
            ) : null}
          </div>
        </>
      ) : (
        /* Fallback decorative spot illustration when slot is off or empty */
        <div aria-hidden="true" className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 opacity-25 dark:opacity-15 sm:right-8">
          <Spot name={fallbackSpot} className="h-24 w-28 sm:h-32 sm:w-36" />
        </div>
      )}

      {/* Hero Content */}
      <div className="relative z-10 flex min-h-[112px] sm:min-h-[168px] flex-col justify-between p-4 sm:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 max-w-2xl">
            {badge ? <div className="mb-1.5">{badge}</div> : null}
            <h1
              className={cn(
                "font-display text-xl font-bold tracking-tight text-balance sm:text-2xl lg:text-3xl",
                hasImage ? "text-[var(--color-on-media)]" : "text-fg",
              )}
            >
              {title}
            </h1>
            {subtitle ? (
              <p
                className={cn(
                  "mt-1 text-xs leading-relaxed sm:text-sm max-w-xl",
                  hasImage ? "text-[var(--color-on-media-muted)]" : "text-muted",
                )}
              >
                {subtitle}
              </p>
            ) : null}
          </div>

          {action ? <div className="mt-2 shrink-0 sm:mt-0">{action}</div> : null}
        </div>

        {/* Live Metrics Row (CountUp) */}
        {stats && stats.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-white/10 pt-2.5 sm:mt-4 sm:gap-6 sm:pt-3">
            {stats.map((s, idx) => (
              <div key={idx} className="flex items-center gap-2 text-xs sm:text-sm">
                {s.live ? (
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-volt)] opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--color-volt)]" />
                  </span>
                ) : null}
                <span
                  className={cn(
                    "font-medium",
                    hasImage ? "text-[var(--color-on-media-muted)]" : "text-muted",
                  )}
                >
                  {s.label}:
                </span>
                <span
                  className={cn(
                    "font-semibold tracking-tight",
                    hasImage ? "text-[var(--color-on-media)]" : "text-fg",
                  )}
                >
                  {s.prefix}
                  {typeof s.value === "number" && !reduced ? (
                    <CountUp to={s.value} duration={0.8} />
                  ) : (
                    s.value
                  )}
                  {s.suffix}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </header>
  );
}
