import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { sportLabel } from "@/lib/arena3/labels";
import { locale } from "@/lib/i18n";
import { useSportPhoto } from "./media";

export type SportInfo = {
  code: string;
  name?: string;
  name_en: string;
  name_vi: string;
  court_prefix?: string | null;
  color_key?: string;
  glyph_key?: string;
  photo_url?: string;
};

function enrichSports(items: SportInfo[]): SportInfo[] {
  const isVi = locale() === "vi";
  return items.map((s) => ({
    ...s,
    name: isVi ? s.name_vi : s.name_en,
  }));
}

export type UseSportsResult = SportInfo[] & { sports: SportInfo[]; items: SportInfo[] };

function toResult(items: SportInfo[]): UseSportsResult {
  const arr = [...items] as UseSportsResult;
  arr.sports = arr;
  arr.items = arr;
  return arr;
}

let cachedSports: SportInfo[] | null = null;

export function invalidateSportsCache() {
  cachedSports = null;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("arena3:sports-changed"));
  }
}

export function useSports(): UseSportsResult {
  const [sports, setSports] = useState<UseSportsResult>(() => toResult(cachedSports ?? []));

  useEffect(() => {
    let cancelled = false;

    function load() {
      fetch("/v1/sports")
        .then((res) => {
          if (!res.ok) return null;
          return res.json() as Promise<{ items?: SportInfo[] }>;
        })
        .then((data) => {
          if (data && Array.isArray(data.items) && data.items.length > 0) {
            const enriched = enrichSports(data.items);
            cachedSports = enriched;
            if (!cancelled) setSports(toResult(enriched));
          }
        })
        .catch(() => {});
    }

    if (!cachedSports || cachedSports.length === 0) {
      load();
    } else {
      setSports(toResult(cachedSports));
    }

    const onSportsChanged = () => {
      load();
    };

    window.addEventListener("arena3:sports-changed", onSportsChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("arena3:sports-changed", onSportsChanged);
    };
  }, []);

  return sports;
}

export function SportDot({
  sport,
  colorKey,
  className,
}: {
  sport?: string | null;
  colorKey?: string | null;
  className?: string;
}) {
  const code = (sport || "").toLowerCase();
  const color = colorKey || code;
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2 rounded-full shrink-0", className)}
      style={{
        backgroundColor: color ? `var(--color-sport-${color}, var(--color-accent))` : "var(--color-accent)",
      }}
    />
  );
}

export function SportBadge({
  sport,
  colorKey,
  className,
  showDot = true,
}: {
  sport?: string | null;
  colorKey?: string | null;
  className?: string;
  showDot?: boolean;
}) {
  const code = (sport || "").toLowerCase();
  const label = sportLabel(code) || code;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] border border-line bg-surface/80 px-2 py-0.5 text-2xs font-medium text-fg shadow-[var(--shadow-border)]",
        className,
      )}
    >
      {showDot ? <SportDot sport={code} colorKey={colorKey} /> : null}
      <span>{label}</span>
    </span>
  );
}

export function SportThumbnail({
  sport,
  colorKey,
  className,
  alt,
}: {
  sport?: string | null;
  colorKey?: string | null;
  className?: string;
  alt?: string;
}) {
  const code = (sport || "").toLowerCase();
  const color = colorKey || code;
  const asset = useSportPhoto(code);
  const label = sportLabel(code) || code;

  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden rounded-[var(--radius-sm)] border border-line bg-wood/50",
        className,
      )}
    >
      {asset.enabled && asset.url ? (
        <img
          src={asset.url}
          alt={alt || label}
          className="h-full w-full object-cover"
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center font-bold text-2xs uppercase text-white"
          style={{
            backgroundColor: color ? `var(--color-sport-${color}, var(--color-accent))` : "var(--color-accent)",
          }}
        >
          {code.slice(0, 2)}
        </div>
      )}
    </div>
  );
}
