import { useRef } from "react";
import type { CatalogClass } from "@/lib/arena3/catalog";
import { levelLabel, rruleLabel, sportLabel } from "@/lib/arena3/labels";
import { ScrollTrigger, gsap, useScene } from "@/lib/gsap";
import { useCalm } from "@/lib/calm";
import { t } from "@/lib/i18n";

/**
 * This week's classes, running past as a strip.
 *
 * It drifts on its own and the scroll wheel drives it: flick down and it speeds forward, scroll
 * back up and it runs the other way, then eases back to its own pace. It stops under the pointer
 * so a class can be read, and stops while off-screen. Under reduced motion it does not move at
 * all, and wraps onto as many rows as it needs so nothing is clipped.
 */
export function ClassTicker({ classes }: { classes: CatalogClass[] }) {
  const root = useRef<HTMLElement>(null);
  // `useCalm` already includes the device setting, and agrees with the server render during hydration.
  const still = useCalm();

  useScene(root, ({ motion }) => {
    const el = root.current;
    const track = el?.querySelector<HTMLElement>("[data-track]");
    const copy = track?.firstElementChild as HTMLElement | null;
    if (!motion || !el || !track || !copy) return;

    const base = 38; // px per second when the page is still
    let x = 0;
    let dir = 1;
    let boost = 0;
    let hover = false;
    let visible = false;
    const setX = gsap.quickSetter(track, "x", "px");

    const tick = (_time: number, dt: number) => {
      if (!visible || hover) return;
      const w = copy.offsetWidth;
      if (!w) return;
      x -= dir * base * (1 + boost) * (dt / 1000);
      x = gsap.utils.wrap(-w, 0, x);
      setX(x);
      boost *= 0.94;
    };
    gsap.ticker.add(tick);

    ScrollTrigger.create({
      trigger: el,
      start: "top bottom",
      end: "bottom top",
      onToggle: (self) => {
        visible = self.isActive;
      },
      onUpdate: (self) => {
        const v = self.getVelocity();
        if (Math.abs(v) < 30) return;
        dir = v < 0 ? -1 : 1;
        // A hard flick at most triples the pace, then it settles back.
        boost = Math.min(2, Math.abs(v) / 700);
      },
    });

    const enter = () => {
      hover = true;
    };
    const leave = () => {
      hover = false;
    };
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    return () => {
      gsap.ticker.remove(tick);
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
    };
  });

  const items = classes.map((c) => (
    <span key={c.id} className="mr-10 inline-flex items-center gap-3 whitespace-nowrap text-sm">
      <span className="athletic text-xl sm:text-2xl">{sportLabel(c.sport)}</span>
      <span className="kicker text-2xs text-muted">{levelLabel(c.level)}</span>
      <span className="tabular-nums text-accent-2">{rruleLabel(c.rrule, c.duration_min)}</span>
      <span className="text-subtle">{c.court_code}</span>
      <span className="text-muted">{c.coach_name}</span>
      <span aria-hidden className="size-1.5 rounded-full bg-accent/45" />
    </span>
  ));

  return (
    <section
      ref={root}
      aria-label={t("Classes running this week")}
      className="relative z-0 overflow-hidden border-y border-line bg-surface/80 py-5"
    >
      {still ? (
        <div className="mx-auto max-w-6xl px-4">
          <div className="flex flex-wrap items-center gap-y-3">{items}</div>
        </div>
      ) : (
        <div className="marquee">
          {/* Two copies, wrapped at one copy's width, so the seam is always off-screen. */}
          <div data-track className="flex w-max will-change-transform">
            <div className="flex shrink-0 items-center">{items}</div>
            <div className="flex shrink-0 items-center" aria-hidden>
              {items}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
