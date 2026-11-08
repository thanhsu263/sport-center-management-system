import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { ScrollSmoother } from "gsap/ScrollSmoother";
import { ScrollTrigger, motionOff, registerGsap } from "@/lib/gsap";
import { useCalm } from "@/lib/calm";

registerGsap(ScrollTrigger, ScrollSmoother);

/** Room the fixed header takes at the top, so an anchor lands below it rather than under it. */
const HEADER_OFFSET = 72;
const useIso = typeof window === "undefined" ? useEffect : useLayoutEffect;

type Scroller = { scrollToId: (id: string) => void };
const Ctx = createContext<Scroller>({ scrollToId: () => undefined });

/** Scroll the landing to a section, through the smoother when there is one. */
export const useLandingScroll = () => useContext(Ctx);

/**
 * Momentum scrolling for the landing, and only the landing.
 *
 * `ScrollSmoother` keeps the window's own scroll (so ScrollTrigger, the keyboard and find-in-page
 * all still work) and eases a transformed copy of the content towards it. That transform is why
 * the header and anything `position: fixed` live outside `content`, and why modals portal to
 * `<body>`. It is created in a probe rendered as the first child: React runs child layout effects
 * before their parents and earlier siblings before later ones, so the smoother exists before any
 * scene builds a ScrollTrigger, and pins inside it get the transform pin type they need.
 *
 * Under reduced motion there is no smoother at all: the same markup scrolls
 * natively, `data-speed` / `data-lag` do nothing, and anchors jump as usual.
 */
export function LandingSmoother({ header, children }: { header: ReactNode; children: ReactNode }) {
  const calm = useCalm();
  const calmRef = useRef(calm);
  calmRef.current = calm;
  const smoother = useRef<ScrollSmoother | null>(null);

  const scrollToId = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (smoother.current) smoother.current.scrollTo(el, true, `top ${HEADER_OFFSET}px`);
    else el.scrollIntoView({ behavior: motionOff(calmRef.current) ? "auto" : "smooth", block: "start" });
  }, []);

  // In-page links (#schedule, #plans…) anywhere on the page, the header included.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href^="#"]');
      const id = a?.getAttribute("href")?.slice(1);
      if (!a || !id || !smoother.current || !document.getElementById(id)) return;
      // No hash in the URL: the router reacts to a hash change with its own `scrollIntoView`,
      // which would scroll the clipped wrapper underneath the smoother.
      e.preventDefault();
      scrollToId(id);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [scrollToId]);

  return (
    <Ctx.Provider value={{ scrollToId }}>
      {header}
      <div id="smooth-wrapper">
        <div id="smooth-content">
          <SmootherBoot calm={calm} smoother={smoother} />
          {/* Clears the fixed header, so the hero starts where it did when the header was sticky. */}
          <div aria-hidden className="h-16" />
          {children}
        </div>
      </div>
    </Ctx.Provider>
  );
}

function SmootherBoot({ calm, smoother }: { calm: boolean; smoother: { current: ScrollSmoother | null } }) {
  const probe = useRef<HTMLSpanElement>(null);

  useIso(() => {
    const content = probe.current?.closest<HTMLElement>("#smooth-content");
    const wrapper = content?.parentElement;
    if (!content || !wrapper || motionOff(calm)) return;
    const s = ScrollSmoother.create({
      wrapper,
      content,
      smooth: 1.1,
      effects: true,
      // Touch keeps the platform's own scrolling; smoothing a finger feels like lag.
      smoothTouch: false,
    });
    smoother.current = s;
    // The wrapper clips, but the browser can still scroll it: to bring a focused element into
    // view (Tab through the page) or for a hash. The smoother would then add its own offset on
    // top and the page would sit twice as far down. Hand any such scroll to the smoother instead.
    const onWrapperScroll = () => {
      const y = wrapper.scrollTop;
      if (!y) return;
      wrapper.scrollTop = 0;
      s.scrollTo(s.scrollTop() + y, false);
    };
    wrapper.addEventListener("scroll", onWrapperScroll);
    // Keyboard focus that lands outside the view (Tab, Shift+Tab, a skip link) is brought into it;
    // the browser cannot do that on its own through a transformed, clipped content box.
    const onFocus = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el || !content.contains(el)) return;
      const r = el.getBoundingClientRect();
      if (r.top >= HEADER_OFFSET && r.bottom <= window.innerHeight) return;
      s.scrollTo(el, true, "center center");
    };
    content.addEventListener("focusin", onFocus);
    // Arriving on /#plans should land on the plans, not on the hero.
    const id = location.hash.slice(1);
    if (id && document.getElementById(id)) {
      requestAnimationFrame(() => s.scrollTo(`#${id}`, false, `top ${HEADER_OFFSET}px`));
    }
    return () => {
      wrapper.removeEventListener("scroll", onWrapperScroll);
      content.removeEventListener("focusin", onFocus);
      s.kill();
      smoother.current = null;
    };
  }, [calm]);

  // The schedule grid, the coach filter and late images all change the page's height after the
  // triggers below them were measured; re-measure once things settle.
  useEffect(() => {
    const content = probe.current?.closest<HTMLElement>("#smooth-content");
    if (!content || typeof ResizeObserver === "undefined") return;
    let t = 0;
    let last = content.offsetHeight;
    const ro = new ResizeObserver(() => {
      if (Math.abs(content.offsetHeight - last) < 2) return;
      last = content.offsetHeight;
      window.clearTimeout(t);
      t = window.setTimeout(() => ScrollTrigger.refresh(), 160);
    });
    ro.observe(content);
    return () => {
      ro.disconnect();
      window.clearTimeout(t);
    };
  }, []);

  return <span ref={probe} hidden />;
}
