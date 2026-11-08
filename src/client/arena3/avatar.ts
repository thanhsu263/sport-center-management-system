import { type RefObject, useEffect, useState } from "react";
import { getToken } from "./client";

type CacheEntry = { src: string; refs: number };
const cache = new Map<string, CacheEntry>();

/**
 * Hook to fetch and cache an avatar image blob URL with Bearer token authentication.
 *
 * Uses reference counting so identical avatar URLs share one object URL, and revokes
 * the object URL when all referencing components unmount.
 *
 * If a targetRef is provided, avatar image fetching is deferred until the element
 * intersects the viewport (via IntersectionObserver).
 */
export function useAvatarSrc(
  url: string | null | undefined,
  targetRef?: RefObject<Element | null>,
): string | null {
  const [src, setSrc] = useState<string | null>(null);
  const [inView, setInView] = useState<boolean>(() => !targetRef || typeof IntersectionObserver === "undefined");

  useEffect(() => {
    if (!targetRef?.current || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const el = targetRef.current;
    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (cancelled) return;
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: "100px" },
    );
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [targetRef]);

  useEffect(() => {
    if (!url || !inView) {
      if (!inView) setSrc(null);
      return;
    }
    const token = getToken();
    if (!token) {
      setSrc(null);
      return;
    }

    let active = true;
    let refCounted = false;
    const ac = new AbortController();

    const existing = cache.get(url);
    if (existing) {
      existing.refs += 1;
      refCounted = true;
      setSrc(existing.src);
    } else {
      (async () => {
        try {
          const res = await fetch(url, {
            headers: { authorization: `Bearer ${token}` },
            signal: ac.signal,
          });
          if (!res.ok) {
            if (active) setSrc(null);
            return;
          }
          const blob = await res.blob();
          if (!active) return;
          let entry = cache.get(url);
          if (!entry) {
            entry = { src: URL.createObjectURL(blob), refs: 0 };
            cache.set(url, entry);
          }
          entry.refs += 1;
          refCounted = true;
          setSrc(entry.src);
        } catch {
          if (active) setSrc(null);
        }
      })();
    }

    return () => {
      active = false;
      ac.abort();
      if (refCounted) {
        const entry = cache.get(url);
        if (entry) {
          entry.refs -= 1;
          if (entry.refs <= 0) {
            URL.revokeObjectURL(entry.src);
            cache.delete(url);
          }
        }
      }
    };
  }, [url, inView]);

  return src;
}
