import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { CustomEase } from "gsap/CustomEase";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { type RefObject } from "react";
import { useCalm } from "@/lib/calm";

/**
 * The one door to GSAP.
 *
 * Arena3 runs two animation engines with separate jobs (CLAUDE.md, rule 3): `motion` for the
 * transitions inside the app, GSAP for the landing's scroll story and the few app moments that are
 * choreographed rather than transitioned (a hold running out, a payment landing). Every GSAP file
 * imports from here, so plugins are registered once, the house easing is the same curve `motion`
 * uses, and every scene goes through `useScene`, which is where reduced motion and the "Pause
 * animations" button are honoured.
 *
 * GSAP only ever runs in the browser. The imports are safe on the server; nothing is called there.
 */

const client = typeof window !== "undefined";
const registered = new Set<object>();

/** Register plugins once, in the browser only. Each GSAP module lists the plugins it needs. */
export function registerGsap(...plugins: object[]) {
  if (!client) return;
  const fresh = plugins.filter((p) => !registered.has(p));
  if (!fresh.length) return;
  gsap.registerPlugin(...fresh);
  fresh.forEach((p) => registered.add(p));
}

registerGsap(useGSAP, ScrollTrigger, CustomEase);
if (client) {
  // The house easing (DESIGN.md: one curve for everything), shared with `motion`'s EASE_SMOOTH.
  CustomEase.create("arena", "0.22,1,0.36,1");
  // The softer exit curve the hero used for its first frames.
  CustomEase.create("arena-out", "0.16,1,0.3,1");
  gsap.defaults({ ease: "arena", duration: 0.6 });
}

export { gsap, ScrollTrigger, useGSAP };

export type SceneFlags = {
  /** Animate at all. False under reduced motion: show the end state instead. */
  motion: boolean;
  /** Wide enough for pinning and sideways scrubbing (768px and up). */
  desktop: boolean;
};

const QUERIES = {
  // matchMedia only calls back while at least one condition matches. Without this one, a phone
  // with motion allowed matched none of the others and its scenes never ran at all.
  always: "all",
  desktop: "(min-width: 768px)",
  reduce: "(prefers-reduced-motion: reduce)",
} as const;

/**
 * Build a GSAP scene for a component.
 *
 * `build` runs inside a `gsap.matchMedia()` scoped to `scope`, so selectors stay inside the
 * component and everything it creates (tweens, timelines, ScrollTriggers, SplitText) is reverted
 * when the component unmounts, the breakpoint flips, or motion is switched off. When `motion` is
 * false a scene should create nothing: the markup is already in its finished state, so reverting
 * is all it takes, and nothing remounts (a field someone is typing in keeps its text).
 */
export function useScene(
  scope: RefObject<HTMLElement | null>,
  build: (flags: SceneFlags) => void | (() => void),
  deps: unknown[] = [],
) {
  const calm = useCalm();
  useGSAP(
    () => {
      if (!scope.current) return;
      const mm = gsap.matchMedia(scope.current);
      mm.add(QUERIES, (ctx) => {
        const c = ctx.conditions as Record<keyof typeof QUERIES, boolean>;
        return build({ motion: !c.reduce && !calm, desktop: c.desktop });
      });
      return () => mm.revert();
    },
    { scope, dependencies: [calm, ...deps], revertOnUpdate: true },
  );
}

/** `true` when nothing may move by itself: the device asked for reduced motion. */
export const motionOff = (calm: boolean) =>
  calm || (client && window.matchMedia(QUERIES.reduce).matches);
