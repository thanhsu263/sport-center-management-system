import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";
import { useCalm } from "@/lib/calm";
import { sportPhoto } from "@/lib/arena3/media";
import { t, useLang } from "@/lib/i18n";
import { ArenaMark, CourtBackdrop } from "./mark";

export { sportPhoto };

export type PublicSiteAsset = {
  slot: string;
  kind: "image" | "video";
  url: string;
  alt_en: string;
  alt_vi: string;
  enabled: boolean;
  width?: number | null;
  height?: number | null;
};

type SiteAssetsContextType = {
  assets: Map<string, PublicSiteAsset>;
  refresh: () => Promise<void>;
};

const SiteAssetsContext = createContext<SiteAssetsContextType | null>(null);

export function SiteAssetsProvider({
  children,
  initialAssets,
}: {
  children: ReactNode;
  initialAssets?: PublicSiteAsset[];
}) {
  const [assetMap, setAssetMap] = useState<Map<string, PublicSiteAsset>>(() => {
    const map = new Map<string, PublicSiteAsset>();
    if (initialAssets) {
      for (const a of initialAssets) {
        map.set(a.slot, a);
      }
    }
    return map;
  });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/v1/site-assets");
      if (!res.ok) return;
      const data = (await res.json()) as { items?: PublicSiteAsset[] };
      if (Array.isArray(data.items)) {
        const next = new Map<string, PublicSiteAsset>();
        for (const it of data.items) {
          next.set(it.slot, it);
        }
        setAssetMap(next);
      }
    } catch {
      // Network/offline: keep current asset map
    }
  }, []);

  useEffect(() => {
    if (!initialAssets || initialAssets.length === 0) {
      void refresh();
    }
  }, [initialAssets, refresh]);

  const value = useMemo(() => ({ assets: assetMap, refresh }), [assetMap, refresh]);

  return <SiteAssetsContext.Provider value={value}>{children}</SiteAssetsContext.Provider>;
}

export type AssetResult = {
  url: string;
  alt: string;
  enabled: boolean;
  kind?: "image" | "video";
};

export function useAsset(slot?: string | null): AssetResult {
  const ctx = useContext(SiteAssetsContext);
  const lang = useLang();
  if (!slot || !ctx) {
    return { url: "", alt: "", enabled: true };
  }
  const item = ctx.assets.get(slot);
  if (!item) {
    return { url: "", alt: "", enabled: true };
  }
  const alt = lang === "vi" ? (item.alt_vi || item.alt_en || "") : (item.alt_en || item.alt_vi || "");
  return {
    url: item.url ?? "",
    alt,
    enabled: item.enabled,
    kind: item.kind,
  };
}

export function useSportPhoto(sport: string): AssetResult {
  return useAsset(sportPhoto(sport));
}

export function Cover({
  slot,
  src,
  alt,
  className,
  imgClassName,
  scrim = "auto",
  style,
  children,
  eager = false,
  fallbackInitials,
  initialsClassName,
}: {
  slot?: string;
  src?: string;
  alt?: string;
  className?: string;
  imgClassName?: string;
  scrim?: "auto" | "media" | "hero" | "none";
  style?: CSSProperties;
  children?: ReactNode;
  /** The one picture above the fold: fetched first instead of when it scrolls near. */
  eager?: boolean;
  fallbackInitials?: string;
  initialsClassName?: string;
}) {
  const asset = useAsset(slot);
  const effectiveUrl = src ?? asset.url;
  const effectiveAlt = alt !== undefined ? alt : asset.alt;
  const enabled = slot ? asset.enabled : true;

  const showScrim = scrim === "media" || scrim === "hero" || (scrim === "auto" && children != null);

  return (
    <div className={cn("relative overflow-hidden bg-wood", className)} style={style}>
      {enabled && effectiveUrl ? (
        <img
          src={effectiveUrl}
          alt={effectiveAlt}
          aria-hidden={!effectiveAlt ? true : undefined}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          fetchPriority={eager ? "high" : undefined}
          className={cn("absolute inset-0 z-0 size-full object-cover", imgClassName)}
        />
      ) : fallbackInitials ? (
        <div
          className={cn(
            "absolute inset-0 z-0 flex select-none items-center justify-center bg-wood font-display font-bold text-muted",
            initialsClassName ?? "text-xl sm:text-2xl",
          )}
        >
          {fallbackInitials}
        </div>
      ) : null}
      {showScrim ? (
        <div
          className={cn(
            "pointer-events-none absolute inset-0 z-[1]",
            scrim === "hero" ? "hero-scrim" : "media-scrim",
          )}
        />
      ) : null}
      {children ? <div className="relative z-[2] size-full">{children}</div> : null}
    </div>
  );
}

/** A wide photo strip at the top of a screen: it says whose screen this is before any word is read. */
export function PhotoBanner({
  slot,
  src,
  className,
  focus = "50% 50%",
}: {
  slot?: string;
  src?: string;
  className?: string;
  /** CSS object-position: where in the photo the strip should stay centred (faces, not feet). */
  focus?: string;
}) {
  const asset = useAsset(slot);
  if (slot && !asset.enabled) return null;
  return (
    <Cover
      slot={slot}
      src={src}
      alt=""
      scrim="none"
      className={cn("h-32 rounded-[var(--radius-lg)] sm:h-44", className)}
      imgClassName="[object-position:var(--focus)]"
      style={{ "--focus": focus } as CSSProperties}
    />
  );
}

/** Solid 82% ink bar — captions never sit on the photo itself (Stitch/WCAG). */
export function MediaCaption({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("absolute inset-x-0 bottom-0 caption-bar px-4 py-3", className)}>
      {children}
    </div>
  );
}

export function PassCard({
  slot,
  plan,
  sport,
  endOn,
  benefits,
  code,
}: {
  slot?: string;
  plan: string;
  sport: string;
  endOn: string;
  /** What this plan actually grants — never a court-hours figure for a plan without court hours. */
  benefits: string[];
  code?: string | null;
}) {
  const asset = useAsset(slot);
  const showCustomBg = slot && asset.enabled && asset.url;

  return (
    <article className="group relative overflow-hidden rounded-[var(--radius-xl)] bg-pass p-6 text-pass-fg transition-transform duration-300 hover:-translate-y-0.5">
      <span className="sweep pointer-events-none absolute inset-0" aria-hidden />
      {showCustomBg ? (
        <img
          src={asset.url}
          alt=""
          aria-hidden
          className="pointer-events-none absolute inset-0 size-full object-cover opacity-20"
        />
      ) : (
        <CourtBackdrop className="pointer-events-none absolute -right-10 -bottom-8 h-56 w-56 text-pass-fg opacity-[0.16] [mask-image:radial-gradient(120%_115%_at_100%_100%,#000_18%,transparent_70%)]" />
      )}
      <div className="relative flex flex-col gap-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <span className="inline-block rounded-[var(--radius-sm)] border border-pass-fg/20 bg-volt/15 px-2.5 py-1 text-xs font-bold text-volt">
              {t("Membership pass")}
            </span>
            <p className="mt-3 font-display text-2xl tracking-tight">{plan}</p>
          </div>
          {code ? (
            <div className="text-right">
              <p className="text-xs font-medium text-pass-muted">{t("Member code")}</p>
              <p className="font-mono text-sm font-semibold tracking-wider">{code}</p>
            </div>
          ) : null}
        </div>
        <div className="grid grid-cols-3 gap-3 border-t border-pass-fg/15 pt-4">
          <div>
            <p className="text-xs text-pass-muted">{t("Sport")}</p>
            <p className="mt-0.5 text-sm font-semibold">{sport}</p>
          </div>
          <div>
            <p className="text-xs text-pass-muted">{t("Includes")}</p>
            {benefits.map((b) => (
              <p key={b} className="mt-0.5 text-sm font-semibold tabular-nums">
                {b}
              </p>
            ))}
          </div>
          <div className="text-right">
            <p className="text-xs text-pass-muted">{t("Valid through")}</p>
            <p className="mt-0.5 text-sm font-semibold tabular-nums">{endOn}</p>
          </div>
        </div>
      </div>
    </article>
  );
}

const BootReady = createContext<(() => void) | null>(null);
// True once the cover is gone. Outside a BootGate there is no cover, so it is always open.
const BootOpen = createContext(true);

/** Whether the BootGate around this component has lifted, for intros that must be seen. */
export function useBootOpen() {
  return useContext(BootOpen);
}

/**
 * Covers the page until the hero video can play. The cover is a blank ground
 * for the first moment; the mark only appears once the wait is actually slow,
 * and a file that never arrives still lets the page open.
 */
export function BootGate({ children }: { children: ReactNode }) {
  const calm = useCalm();
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);
  const signal = useCallback(() => setReady(true), []);

  useEffect(() => {
    if (calm) {
      setReady(true);
      return;
    }
    const show = window.setTimeout(() => setSlow(true), 400);
    const cap = window.setTimeout(() => setReady(true), 12_000);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(cap);
    };
  }, [calm]);

  return (
    <BootReady.Provider value={signal}>
      <BootOpen.Provider value={ready}>
        <div aria-hidden={ready ? undefined : true} inert={ready ? undefined : true}>
          {children}
        </div>
      </BootOpen.Provider>
      {ready ? null : (
        <div className="fixed inset-0 z-[60] bg-bg" aria-busy="true">
          {slow ? (
            <div className="grid h-full place-items-center text-muted" role="status">
              <div className="flex flex-col items-center gap-3">
                <ArenaMark />
                <p className="font-display text-lg">{t("Opening Lê Long Sport Center")}</p>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </BootReady.Provider>
  );
}

/**
 * A muted, looping background video that only fetches once it is near the
 * viewport — and never before the page has painted.
 */
export function HeroVideo({
  slot,
  posterSlot,
  src,
  poster,
  className,
  priority = false,
}: {
  slot?: string;
  posterSlot?: string;
  src?: string;
  poster?: string;
  className?: string;
  priority?: boolean;
}) {
  const videoAsset = useAsset(slot);
  const inferredPosterSlot =
    posterSlot ??
    (slot === "landing.hero.video"
      ? "landing.hero.image"
      : slot === "landing.pricing.video"
      ? "landing.pricing.image"
      : slot === "auth.login.video"
      ? "auth.login.image"
      : undefined);
  const posterAsset = useAsset(inferredPosterSlot);

  const effectiveSrc = src ?? videoAsset.url;
  const effectivePoster = poster ?? posterAsset.url;
  const videoEnabled = slot ? videoAsset.enabled : true;

  const ref = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  const calm = useCalm();
  const signal = useContext(BootReady);
  const [wanted, setWanted] = useState(priority);

  useEffect(() => {
    if (near && !calm) setWanted(true);
  }, [near, calm]);

  useEffect(() => {
    if (!priority) return;
    const v = ref.current;
    if (calm) {
      if (v) {
        v.pause();
        v.removeAttribute("src");
        v.load();
      }
      signal?.();
      return;
    }
    if (!v) {
      signal?.();
      return;
    }
    const done = () => signal?.();
    if (v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      done();
      return;
    }
    v.addEventListener("canplay", done);
    v.addEventListener("error", done);
    return () => {
      v.removeEventListener("canplay", done);
      v.removeEventListener("error", done);
    };
  }, [priority, calm, signal]);

  useEffect(() => {
    const v = ref.current;
    if (!v || !wanted) return;
    if (calm) v.pause();
    else void v.play().catch(() => undefined);
  }, [calm, wanted]);

  useEffect(() => {
    const el = ref.current;
    if (!el || near || priority) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const empty = (n: HTMLElement) => {
      const r = n.getBoundingClientRect();
      return r.width === 0 || r.height === 0;
    };
    let target: HTMLElement = el;
    while (empty(target) && target.parentElement) {
      target = target.parentElement;
    }
    if (empty(target)) {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: "400px" },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [near, priority]);

  // When video slot is disabled, fall back to the poster image
  if (!videoEnabled) {
    if (!effectivePoster) return null;
    return (
      <img
        src={effectivePoster}
        alt={posterAsset.alt}
        aria-hidden={!posterAsset.alt ? true : undefined}
        className={cn("absolute inset-0 size-full object-cover", className)}
      />
    );
  }

  return (
    <video
      ref={ref}
      className={cn("absolute inset-0 size-full object-cover", className)}
      src={wanted && effectiveSrc ? effectiveSrc : undefined}
      poster={effectivePoster}
      autoPlay={!calm}
      muted
      loop
      playsInline
      preload={priority ? "auto" : "none"}
      aria-hidden
    />
  );
}

function secsLeft(until: string) {
  return Math.max(0, Math.floor((new Date(until).getTime() - Date.now()) / 1000));
}

export function HoldTimer({ until, onExpire }: { until: string; onExpire?: () => void }) {
  const [left, setLeft] = useState(() => secsLeft(until));
  const fired = useRef(false);
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;
  useEffect(() => {
    fired.current = false;
    const tick = () => {
      const n = secsLeft(until);
      setLeft(n);
      if (n <= 0 && !fired.current) {
        fired.current = true;
        expireRef.current?.();
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [until]);
  const m = Math.floor(left / 60);
  const s = String(left % 60).padStart(2, "0");
  return (
    <span className="tabular-nums">
      {m}:{s}
    </span>
  );
}
