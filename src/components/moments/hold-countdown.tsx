import { useEffect, useRef, useState } from "react";
import { CustomEase } from "gsap/CustomEase";
import { CustomWiggle } from "gsap/CustomWiggle";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { gsap, motionOff, registerGsap, useGSAP } from "@/lib/gsap";
import { useCalm } from "@/lib/calm";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

registerGsap(CustomEase, CustomWiggle, DrawSVGPlugin);

let shakeReady = false;

function secsLeft(until: string) {
  return Math.max(0, Math.floor((new Date(until).getTime() - Date.now()) / 1000));
}

/**
 * A hold, drawn as something running out: a ring that empties as the five minutes go, with the
 * time beside it. The ring follows the real clock (it is re-aimed every quarter second), not a
 * tween left to run on its own, so a phone that slept or a tab left in the background shows the
 * true time the moment it is looked at again. When the last minute starts, the dial shakes once
 * and turns red: that is the point at which a member needs to be told, not informed.
 *
 * GSAP only (CLAUDE.md, rule 3); with motion off the ring simply jumps to each value.
 */
export function HoldCountdown({
  until,
  onExpire,
  className,
}: {
  until: string;
  onExpire?: () => void;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const calm = useCalm();
  const [left, setLeft] = useState(() => secsLeft(until));
  const total = useRef(Math.max(1, secsLeft(until)));
  const fired = useRef(false);
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;
  const aim = useRef<(p: number) => void>(() => undefined);

  useEffect(() => {
    fired.current = false;
    total.current = Math.max(1, secsLeft(until));
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

  const { contextSafe } = useGSAP(
    () => {
      const ring = root.current?.querySelector("[data-ring]");
      if (!ring) return;
      // One drawing from full to empty, scrubbed to wherever the clock says it should be.
      const drain = gsap.fromTo(ring, { drawSVG: "0% 100%" }, { drawSVG: "0% 0%", ease: "none", duration: 1, paused: true });
      const still = motionOff(calm);
      const proxy = { p: 0 };
      const glide = gsap.quickTo(proxy, "p", { duration: 0.35, ease: "none", onUpdate: () => void drain.progress(proxy.p) });
      aim.current = (p) => {
        if (still) {
          proxy.p = p;
          drain.progress(p);
        } else glide(p);
      };
      aim.current(1 - secsLeft(until) / total.current);
      return () => {
        aim.current = () => undefined;
      };
    },
    { scope: root, dependencies: [calm, until], revertOnUpdate: true },
  );

  useEffect(() => {
    aim.current(Math.min(1, 1 - left / total.current));
  }, [left]);

  const urgent = left <= 60;
  const wasUrgent = useRef(urgent);
  useEffect(() => {
    const crossed = urgent && !wasUrgent.current;
    wasUrgent.current = urgent;
    if (!crossed || motionOff(calm)) return;
    contextSafe(() => {
      if (!shakeReady) {
        CustomWiggle.create("hold-shake", { wiggles: 7, type: "easeOut" });
        shakeReady = true;
      }
      gsap.fromTo(root.current?.querySelector("[data-dial]") ?? [], { rotation: 0 }, { rotation: 9, duration: 0.8, ease: "hold-shake" });
    })();
  }, [urgent, calm, contextSafe]);

  const m = Math.floor(left / 60);
  const s = String(left % 60).padStart(2, "0");

  return (
    <div ref={root} className={cn("flex items-center gap-3", className)}>
      <span data-dial aria-hidden className="relative grid size-12 shrink-0 place-items-center">
        <svg viewBox="0 0 48 48" className="absolute inset-0 size-full -rotate-90" fill="none" strokeWidth="4">
          <circle cx="24" cy="24" r="20" className="stroke-wood" />
          <circle
            data-ring
            cx="24"
            cy="24"
            r="20"
            strokeLinecap="round"
            className={cn("transition-[stroke] duration-300", urgent ? "stroke-danger" : "stroke-accent")}
          />
        </svg>
        <span className={cn("size-1.5 rounded-full", urgent ? "bg-danger" : "bg-accent")} />
      </span>
      <div className="min-w-0">
        <span className="kicker block text-2xs text-muted">{urgent ? t("Hold expiring") : t("Holding your court")}</span>
        <span
          className={cn("font-display text-xl tabular-nums", urgent ? "text-danger" : "text-accent-2")}
          role="timer"
          aria-live={urgent ? "polite" : "off"}
        >
          {m}:{s}
        </span>
      </div>
    </div>
  );
}
