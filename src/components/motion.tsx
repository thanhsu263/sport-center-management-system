import { locale } from "@/lib/i18n";
import {
  AnimatePresence,
  MotionConfig,
  motion,
  useInView,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
  type MotionProps,
  type Variants,
} from "motion/react";
import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ElementType,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";
import { useCalm } from "@/lib/calm";

/**
 * Shared motion vocabulary for Arena3.
 *
 * Every primitive here degrades to a plain, fully-visible element when the
 * visitor asks for reduced motion — content never depends on an animation
 * having run. (`useCalm()` in `@/lib/calm` follows the same device setting live
 * without swapping elements: see `MotionProvider`.)
 */

/**
 * The device's reduced-motion setting, but only once the component has mounted.
 *
 * The server cannot know the setting, so it always renders the moving version. If the first
 * client render already chose the still version (a plain `<div>` instead of a spotlight, whole
 * text instead of split words), hydration would not match the server's HTML and React would
 * throw the page away and rebuild it. Answering "no" until mounted keeps hydration exact; the
 * still version takes over one render later.
 */
export function useReducedMotionAfterMount(): boolean {
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted && !!reduced;
}

export const EASE_SMOOTH = [0.22, 1, 0.36, 1] as const;
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/** Wrap a subtree so every nested transition shares the house easing. */
export function MotionProvider({ children }: { children: ReactNode }) {
  // "always" once the device asks for reduced motion (read live by useCalm), "user" otherwise.
  // Slides become fades and nothing remounts, so the setting changing never costs typed text.
  const calm = useCalm();
  return (
    <MotionConfig reducedMotion={calm ? "always" : "user"} transition={{ duration: 0.5, ease: EASE_SMOOTH }}>
      {children}
    </MotionConfig>
  );
}

type RevealProps = {
  children: ReactNode;
  className?: string;
  /** Direction the element travels in from. */
  from?: "up" | "down" | "left" | "right" | "none";
  delay?: number;
  duration?: number;
  /** Travel distance in px. */
  distance?: number;
  /** Re-run the animation every time it scrolls back into view. */
  repeat?: boolean;
  as?: ElementType;
};

/** Fade + slide an element in the first time it scrolls into view. */
export function Reveal({
  children,
  className,
  from = "up",
  delay = 0,
  duration = 0.6,
  distance = 22,
  repeat = false,
  as = "div",
}: RevealProps) {
  const reduced = useReducedMotionAfterMount();
  const Tag = motion[as as "div"] ?? motion.div;

  const offset =
    from === "up"
      ? { y: distance }
      : from === "down"
        ? { y: -distance }
        : from === "left"
          ? { x: -distance }
          : from === "right"
            ? { x: distance }
            : {};

  if (reduced) return <div className={className}>{children}</div>;

  return (
    <Tag
      className={className}
      initial={{ opacity: 0, ...offset }}
      whileInView={{ opacity: 1, x: 0, y: 0 }}
      viewport={{ once: !repeat, amount: 0.2, margin: "0px 0px -80px 0px" }}
      transition={{ duration, delay, ease: EASE_SMOOTH }}
    >
      {children}
    </Tag>
  );
}

const staggerParent: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.075, delayChildren: 0.05 } },
};

const staggerChild: Variants = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { duration: 0.55, ease: EASE_SMOOTH } },
};

/**
 * Each item animates itself rather than waiting to be told to.
 *
 * Variant propagation was the obvious way to build this and it does not
 * survive contact with a filter: motion resolves a child's variant when the
 * child mounts, and a parent that has already finished its cascade has no
 * label change left to broadcast. Swapping the sport on Classes remounts the
 * whole list into exactly that state, so every replacement card sat at
 * `opacity: 0` and the list looked wiped.
 *
 * So `Stagger` publishes only the two facts an item needs — has the container
 * been seen, and how long should this one wait — and the item drives its own
 * `animate`. Whenever an item mounts, it animates in.
 */
const StaggerCtx = createContext<{ inView: boolean; delay: number }>({ inView: true, delay: 0 });

/** Parent for a list whose children should cascade in. Pair with `<StaggerItem>`. */
export function Stagger({
  children,
  className,
  delay = 0,
  gap = 0.075,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  gap?: number;
}) {
  const reduced = useReducedMotionAfterMount();
  const ref = useRef<HTMLDivElement>(null);
  // `amount: 0` because most of these lists are filled by a fetch: the
  // container is empty and therefore zero-height when the observer first
  // looks at it, and a ratio threshold can never be met by a box with no area.
  const observed = useInView(ref, { once: true, amount: 0, margin: "0px 0px -60px 0px" });

  // The observer does not reliably deliver a first callback for a container
  // that mounts already on screen — which is every one of these lists, since
  // they mount when their fetch lands. Without this the cards sat at
  // `opacity: 0` until something happened to scroll the page. Measuring once
  // after mount answers the same question directly.
  const [onScreenAtMount, setOnScreenAtMount] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) setOnScreenAtMount(true);
  }, []);

  const inView = observed || onScreenAtMount;

  if (reduced) return <div className={className}>{children}</div>;

  return (
    <div ref={ref} className={className}>
      {Children.map(children, (child, i) =>
        isValidElement(child) ? (
          // Capped so a long list does not leave its tail waiting several
          // seconds — past a dozen items the offsets are indistinguishable.
          <StaggerCtx.Provider value={{ inView, delay: delay + Math.min(i, 12) * gap }}>
            {child}
          </StaggerCtx.Provider>
        ) : (
          child
        ),
      )}
    </div>
  );
}

export function StaggerItem({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & MotionProps) {
  const reduced = useReducedMotionAfterMount();
  const { inView, delay } = useContext(StaggerCtx);
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 20 }}
      animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
      transition={{ duration: 0.55, ease: EASE_SMOOTH, delay }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

export { staggerParent, staggerChild };

/** Count a number up once it enters the viewport. */
export function CountUp({
  to,
  duration = 1.4,
  suffix = "",
  prefix = "",
  format,
  className,
}: {
  to: number;
  duration?: number;
  suffix?: string;
  prefix?: string;
  format?: (n: number) => string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const reduced = useReducedMotionAfterMount();
  const [value, setValue] = useState(reduced ? to : 0);

  useEffect(() => {
    if (reduced) {
      setValue(to);
      return;
    }
    if (!inView) return;
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / (duration * 1000));
      // easeOutCubic — fast start, gentle settle.
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(to * eased);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [inView, to, duration, reduced]);

  const shown = format ? format(value) : Math.round(value).toLocaleString(locale());
  return (
    <span ref={ref} className={cn("tabular-nums", className)}>
      {prefix}
      {shown}
      {suffix}
    </span>
  );
}

/** Subtle 3D tilt toward the pointer. Pointer-only; never fires on touch. */
export function Tilt({
  children,
  className,
  max = 7,
}: {
  children: ReactNode;
  className?: string;
  max?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotionAfterMount();
  const rx = useSpring(useMotionValue(0), { stiffness: 220, damping: 22 });
  const ry = useSpring(useMotionValue(0), { stiffness: 220, damping: 22 });

  if (reduced) return <div className={className}>{children}</div>;

  return (
    <motion.div
      ref={ref}
      className={cn("[transform-style:preserve-3d]", className)}
      style={{ rotateX: rx, rotateY: ry, perspective: 800 }}
      onPointerMove={(e) => {
        if (e.pointerType !== "mouse") return;
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        ry.set(px * max * 2);
        rx.set(-py * max * 2);
      }}
      onPointerLeave={() => {
        rx.set(0);
        ry.set(0);
      }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Lift-on-hover wrapper for cards and tiles. No whileTap here on purpose: Motion makes any
 * element with a press gesture keyboard-focusable (tabindex=0), which turned every card into
 * a nameless Tab stop.
 */
export function Lift({
  children,
  className,
  amount = -4,
  ...rest
}: { children: ReactNode; className?: string; amount?: number } & MotionProps) {
  const reduced = useReducedMotionAfterMount();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      whileHover={{ y: amount }}
      transition={{ type: "spring", stiffness: 320, damping: 26 }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/** Fade/slide route content in on mount. Used by the app shells. */
export function PageIn({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & ComponentPropsWithoutRef<"div">) {
  const reduced = useReducedMotionAfterMount();
  if (reduced) {
    return (
      <div className={className} {...rest}>
        {children}
      </div>
    );
  }
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: EASE_SMOOTH }}
    >
      {children}
    </motion.div>
  );
}

export {
  AnimatePresence,
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
  useInView,
  useMotionValueEvent,
};
