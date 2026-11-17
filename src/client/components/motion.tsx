/**
 * File: src/client/components/motion.tsx
 * Vai trò: Bộ thư viện hiệu ứng chuyển động (motion primitives) dùng chung cho toàn bộ giao diện Arena3.
 * Vị trí trong app: Cung cấp các React component (Reveal, Stagger, StaggerItem, Tilt, Lift, CountUp, PageIn) và hook kiểm soát animation, tối ưu hiệu năng và tự động tương thích với chế độ giảm chuyển động (reduced motion) của thiết bị.
 */
import { locale } from "@/client/lib/i18n";
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
import { cn } from "@/client/lib/cn";
import { useCalm } from "@/client/lib/calm";

/**
 * Shared motion vocabulary for Arena3.
 *
 * Every primitive here degrades to a plain, fully-visible element when the
 * visitor asks for reduced motion — content never depends on an animation
 * having run. (`useCalm()` in `@/client/lib/calm` follows the same device setting live
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
  // Bước 1: Đánh dấu component đã mount thành công trên trình duyệt (chỉ chạy ở phía client).
  useEffect(() => setMounted(true), []);
  // Bước 2: Chỉ áp dụng tùy chọn reduced-motion sau khi đã mount xong để tránh lỗi hydration mismatch giữa server và client.
  return mounted && !!reduced;
}

/**
 * Làm gì: Đường cong gia tốc chuyển động bezier mượt mà (cubic-bezier), tạo cảm giác tăng tốc nhanh lúc đầu và hãm chậm êm ái khi dừng.
 * Được gọi ở: MotionProvider, Reveal, StaggerItem, PageIn, src/client/components/ui/index.tsx, src/client/lib/gsap.ts.
 */
export const EASE_SMOOTH = [0.22, 1, 0.36, 1] as const;
/**
 * Làm gì: Đường cong chuyển động bezier ease-out chuẩn xác, dùng cho các thành phần cần xuất hiện dứt khoát và giảm tốc mượt mà.
 * Được gọi ở: Hằng số export dùng chung cho các hiệu ứng chuyển động trong ứng dụng.
 */
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

// Các thuộc tính cấu hình cho component Reveal: hướng trượt, độ trễ, thời lượng, cự ly và thẻ HTML đích.
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
  // Bước 1: Kiểm tra tùy chọn giảm chuyển động của thiết bị sau khi mount.
  const reduced = useReducedMotionAfterMount();
  // Bước 2: Chọn component motion tương ứng với thẻ HTML được truyền vào (mặc định là div).
  const Tag = motion[as as "div"] ?? motion.div;

  // Bước 3: Tính toán khoảng cách tọa độ dịch chuyển ban đầu (x hoặc y) tùy theo hướng xuất hiện (from).
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

  // Bước 4: Nếu người dùng bật reduced motion, trả về thẻ div thông thường không có animation.
  if (reduced) return <div className={className}>{children}</div>;

  // Bước 5: Render thẻ motion với hiệu ứng fade + slide khi phần tử cuộn vào viewport.
  // margin đáy -80px giúp hiệu ứng chỉ kích hoạt khi phần tử đã cuộn vào sâu trong màn hình 80px, tránh giật mép dưới.
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

/**
 * Làm gì: Cấu hình biến thể animation (Variants) cho container cha, tạo khoảng trễ so le (stagger) giữa các phần tử con.
 * Được gọi ở: Xuất khẩu tại file này (dòng 225) cho các component sử dụng Framer Motion theo mô hình cha-con.
 */
const staggerParent: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.075, delayChildren: 0.05 } },
};

/**
 * Làm gì: Cấu hình biến thể animation (Variants) cho từng phần tử con, kết hợp trượt nhẹ từ dưới lên (y: 20 -> 0) và tăng dần độ mờ (opacity: 0 -> 1).
 * Được gọi ở: Xuất khẩu tại file này (dòng 225) để áp dụng cho các item con bên trong container sử dụng staggerParent.
 */
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
  // Bước 1: Kiểm tra tùy chọn giảm chuyển động và khởi tạo ref tham chiếu tới phần tử container danh sách.
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
  // Bước 2: Đo đạc vị trí thực tế lúc vừa mount để kích hoạt hiển thị ngay nếu danh sách đã nằm trong khung nhìn.
  const [onScreenAtMount, setOnScreenAtMount] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) setOnScreenAtMount(true);
  }, []);

  // Bước 3: Kết hợp trạng thái quan sát qua IntersectionObserver và kết quả đo đạc lúc mount.
  const inView = observed || onScreenAtMount;

  // Bước 4: Trả về div tĩnh nếu thiết bị yêu cầu giảm chuyển động.
  if (reduced) return <div className={className}>{children}</div>;

  // Bước 5: Truyền trạng thái inView và tính toán độ trễ (delay) tăng dần cho từng phần tử con qua StaggerCtx.
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

/**
 * Làm gì: Phần tử con trong danh sách so le, tự động lấy trạng thái inView và độ trễ delay từ StaggerCtx để kích hoạt hiệu ứng xuất hiện độc lập.
 * Được gọi ở: notifications.tsx, account.tsx, app.index.tsx, app.classes.tsx, app.plans.tsx, app.train.tsx, coach.classes.tsx, desk.* (classes, gear, index, maintenance, member.$id, payments, series), manager.* (audit, classes, index, plans, prices, settings).
 * @param props Thuộc tính component gồm children, className và các MotionProps tùy biến khác.
 * @returns Thẻ motion.div có hiệu ứng trượt mờ so le, hoặc div tĩnh khi bật reduced motion.
 */
export function StaggerItem({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & MotionProps) {
  // Bước 1: Đọc cấu hình reduced motion và lấy trạng thái inView cùng độ trễ delay từ context cha (StaggerCtx).
  const reduced = useReducedMotionAfterMount();
  const { inView, delay } = useContext(StaggerCtx);
  // Bước 2: Bỏ qua animation nếu người dùng bật chế độ giảm chuyển động.
  if (reduced) return <div className={className}>{children}</div>;
  // Bước 3: Render thẻ motion.div tự động chạy hiệu ứng từ ẩn (opacity 0, y 20) sang hiện rõ khi inView bật true.
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
  // Bước 1: Khởi tạo ref và giám sát viewport (kích hoạt 1 lần khi phần tử xuất hiện tối thiểu 40% trên màn hình).
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const reduced = useReducedMotionAfterMount();
  const [value, setValue] = useState(reduced ? to : 0);

  // Bước 2: Hiệu ứng tăng số dần dần theo thời gian thực (requestAnimationFrame) kết hợp hàm nắn chuyển động easeOutCubic.
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

  // Bước 3: Định dạng số hiển thị theo format tùy chỉnh hoặc làm tròn số theo chuẩn ngôn ngữ địa phương (locale).
  const shown = format ? format(value) : Math.round(value).toLocaleString(locale());
  // Dùng class tabular-nums để chiều rộng các chữ số luôn bằng nhau, tránh hiện tượng co giật layout khi số đang đếm.
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
  // Bước 1: Khởi tạo giá trị xoay góc X và Y với cấu hình lò xo (useSpring) để chuyển động nghiêng có độ đàn hồi tự nhiên.
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotionAfterMount();
  const rx = useSpring(useMotionValue(0), { stiffness: 220, damping: 22 });
  const ry = useSpring(useMotionValue(0), { stiffness: 220, damping: 22 });

  // Bước 2: Bỏ qua hiệu ứng nghiêng 3D nếu người dùng yêu cầu giảm chuyển động.
  if (reduced) return <div className={className}>{children}</div>;

  // Bước 3: Render thẻ motion.div với thuộc tính 3D (perspective 800px).
  // Chỉ kích hoạt khi di chuột (pointerType === "mouse"), bỏ qua màn hình cảm ứng để không xung đột thao tác cuộn trang.
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
  // Bước 1: Bỏ qua hiệu ứng hover nếu người dùng bật chế độ giảm chuyển động.
  const reduced = useReducedMotionAfterMount();
  if (reduced) return <div className={className}>{children}</div>;
  // Bước 2: Render thẻ motion.div với chuyển động lò xo (spring) nhấc nhẹ theo trục Y khi di chuột vào (whileHover).
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
  // Bước 1: Kiểm tra tùy chọn giảm chuyển động để quyết định render div thường hay thẻ motion.
  const reduced = useReducedMotionAfterMount();
  if (reduced) {
    return (
      <div className={className} {...rest}>
        {children}
      </div>
    );
  }
  // Bước 2: Render thẻ motion.div với hiệu ứng hiện rõ dần và trượt nhẹ 10px từ dưới lên khi trang được tải.
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

// Xuất lại (re-export) các công cụ animation phổ biến từ motion/react để các component khác tiện sử dụng từ một nơi duy nhất.
export {
  AnimatePresence,
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
  useInView,
  useMotionValueEvent,
};
