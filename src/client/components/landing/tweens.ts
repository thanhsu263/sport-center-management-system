import { money } from "@/components/shell";
import { ScrollTrigger, gsap, registerGsap } from "@/lib/gsap";

registerGsap(ScrollTrigger);

/** A price while it counts: whole thousands of đồng, so the figure never flickers through decimals. */
export const moneyCount = (n: number) => money(Math.round(n / 1000) * 1000);

/** Count `el`'s text from 0 to `to`. Returns the tween so a timeline can place it. */
export function countText(
  el: HTMLElement,
  to: number,
  { format = (n: number) => String(Math.round(n)), suffix = "", duration = 1.4 } = {},
) {
  const o = { v: 0 };
  const paint = () => {
    el.textContent = `${format(o.v)}${suffix}`;
  };
  paint();
  return gsap.to(o, { v: to, duration, ease: "power3.out", onUpdate: paint, onComplete: paint });
}

/**
 * Elements marked `data-rise` fade up as they scroll in; several on the same row arrive a little
 * apart, left to right. Call from a scene's build, with motion on.
 *
 * One `fromTo` per element, created now and played by its own trigger, rather than a batch that
 * creates tweens later from a callback: everything then belongs to the scene's context from the
 * start, so reverting it (unmount, breakpoint, reduced motion switching on) always lands on the untouched
 * markup. The batch version could revert in an order that left the start state (hidden) behind.
 */
export function rise(scope: Element, selector = "[data-rise]", { y = 34, stagger = 0.09 } = {}) {
  const els = gsap.utils.toArray<HTMLElement>(selector, scope);
  const perRow = new Map<number, number>();
  els.forEach((el) => {
    // Same row within a few pixels: measured before any of them is offset.
    const row = Math.round(el.getBoundingClientRect().top / 12);
    const i = perRow.get(row) ?? 0;
    perRow.set(row, i + 1);
    gsap.fromTo(
      el,
      { autoAlpha: 0, y },
      {
        autoAlpha: 1,
        y: 0,
        duration: 0.85,
        delay: Math.min(i, 6) * stagger,
        scrollTrigger: { trigger: el, start: "top 90%", once: true },
      },
    );
  });
}
