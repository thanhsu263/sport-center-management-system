import { useRef } from "react";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { Physics2DPlugin } from "gsap/Physics2DPlugin";
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin";
import { gsap, motionOff, registerGsap, useGSAP } from "@/lib/gsap";
import { useCalm } from "@/lib/calm";
import { cn } from "@/lib/cn";

registerGsap(DrawSVGPlugin, Physics2DPlugin, ScrambleTextPlugin);

const DOTS = 14;

/**
 * The money landed. A ring and a tick draw themselves, and a handful of cobalt and volt specks
 * burst out of it once and fall away under gravity. Shown only when a payment is confirmed (a
 * plan hour taken, a court paid, an online payment posted), never for a click or a hold: the
 * burst has to keep meaning "paid" (CLAUDE.md, rule 2). With motion off it is just the tick.
 */
export function PaidMark({ className }: { className?: string }) {
  const root = useRef<HTMLSpanElement>(null);
  const calm = useCalm();
  useGSAP(
    () => {
      const el = root.current;
      if (!el || motionOff(calm)) return;
      const q = gsap.utils.selector(el);
      const tl = gsap.timeline();
      tl.fromTo(el, { scale: 0.8 }, { scale: 1, duration: 0.55, ease: "arena" }, 0)
        .fromTo(q("[data-ring]"), { drawSVG: "0%" }, { drawSVG: "100%", duration: 0.55, ease: "arena" }, 0)
        .fromTo(q("[data-tick]"), { drawSVG: "0%" }, { drawSVG: "100%", duration: 0.35, ease: "arena" }, 0.4);
      q("[data-dot]").forEach((dot) => {
        tl.fromTo(
          dot,
          { x: 0, y: 0, autoAlpha: 1, scale: 1 },
          {
            autoAlpha: 0,
            scale: 0.3,
            duration: 1.1,
            ease: "power1.in",
            physics2D: { velocity: gsap.utils.random(80, 180), angle: gsap.utils.random(0, 360), gravity: 280 },
          },
          0.5,
        );
      });
    },
    { scope: root, dependencies: [calm], revertOnUpdate: true },
  );
  return (
    <span ref={root} aria-hidden className={cn("relative inline-grid size-11 shrink-0 place-items-center text-accent", className)}>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-full"
      >
        <circle data-ring cx="12" cy="12" r="9" />
        <path data-tick d="M7.8 12.4l3 3 5.6-6.2" />
      </svg>
      {Array.from({ length: DOTS }, (_, i) => (
        <span
          key={i}
          data-dot
          className={cn(
            "pointer-events-none absolute left-1/2 top-1/2 -ml-[3px] -mt-[3px] size-1.5 rounded-full opacity-0",
            i % 3 === 0 ? "bg-volt" : "bg-accent",
          )}
        />
      ))}
    </span>
  );
}

/**
 * A booking code arriving: it decodes into place, character by character, the moment it is
 * issued. Keyed by the code, so a new code is a new element (GSAP rewrites the text node).
 */
export function ScrambleCode({ code, className }: { code: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const calm = useCalm();
  useGSAP(
    () => {
      const el = ref.current;
      if (!el || motionOff(calm)) return;
      gsap.to(el, { duration: 1, scrambleText: { text: code, chars: "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789", speed: 0.6 } });
      return () => {
        el.textContent = code;
      };
    },
    { scope: ref, dependencies: [code, calm], revertOnUpdate: true },
  );
  return (
    <span key={code} ref={ref} className={cn("font-mono tabular-nums", className)}>
      {code}
    </span>
  );
}
