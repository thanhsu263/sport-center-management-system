/**
 * File: src/client/components/fx.tsx
 * Vai trò: Thư viện hiệu ứng giao diện (FX layer) dùng chung cho toàn bộ ứng dụng Arena3.
 * Vị trí trong app: Chạy ở client, cung cấp các hiệu ứng tương tác chuột (SpotlightCard, GlareHover, Magnet), hiệu ứng chữ (ShinyText, SplitText, DecryptedText) và phông nền WebGL shader lazy-load. Tự động giản lược khi bật prefers-reduced-motion để đảm bảo hiệu năng và khả năng tiếp cận (accessibility).
 */
import {
  motion,
  useMotionTemplate,
  useMotionValue,
  useSpring,
  useTransform,
} from "motion/react";
import {
  Suspense,
  lazy,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ElementType,
  type ReactNode,
} from "react";
import { cn } from "@/client/lib/cn";
import { useReducedMotionAfterMount } from "@/client/components/motion";
import { isCalm, useCalm } from "@/client/lib/calm";

/**
 * Arena3's effect layer.
 *
 * The vocabulary is borrowed from React Bits, but every piece here is written
 * against our own stack and palette rather than pasted in: the hover and pointer
 * effects run on `motion`, and the WebGL backgrounds live in `./gl` behind a
 * lazy import so `ogl` never lands in the main bundle. GSAP lives elsewhere:
 * `@/client/lib/gsap`, the landing scenes and the app moments (CLAUDE.md, rule 3).
 *
 * Two rules hold everywhere in this file:
 *   1. `prefers-reduced-motion` collapses the effect to a plain element, once
 *      mounted (`useReducedMotionAfterMount`, so hydration matches the server).
 *      Nothing here is load-bearing for content. The things that loop on their
 *      own, the shader backgrounds, also follow `useCalm()` (`@/client/lib/calm`) live,
 *      and CSS stops the rest.
 *   2. Pointer effects check `pointerType === "mouse"`. A spotlight that chases
 *      a finger is just a smear, and most of Arena3's traffic is on a phone.
 */

/* ── plumbing ────────────────────────────────────────────────────── */

/** `useLayoutEffect` that stays quiet during SSR. */
/**
 * Làm gì: Cung cấp hook useLayoutEffect an toàn cho cả SSR và Client.
 * Được gọi ở: Nội bộ file src/client/components/fx.tsx (trong component SplitText).
 * @returns Hook useEffect khi chạy phía server để tránh cảnh báo SSR, hoặc useLayoutEffect khi chạy phía client để đo layout đồng bộ.
 */
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** True once the component has mounted in the browser. Gates client-only work. */
/**
 * Làm gì: Hook theo dõi trạng thái đã mount vào DOM của component phía client.
 * Được gọi ở: Nội bộ file src/client/components/fx.tsx (trong các component StarBorder và GLBackground).
 * @returns Giá trị boolean: false trong lần render đầu / SSR, true sau khi component đã mount thành công ở trình duyệt.
 */
function useMounted() {
  const [mounted, setMounted] = useState(false);
  // Trì hoãn gán mounted = true sau render đầu tiên để khớp SSR markup, tránh lỗi hydration mismatch.
  useEffect(() => setMounted(true), []);
  return mounted;
}

/** True while `ref` is anywhere near the viewport. Used to park idle canvases. */
/**
 * Làm gì: Hook kiểm tra phần tử DOM có đang nằm gần khung nhìn (viewport) hay không bằng IntersectionObserver.
 * Được gọi ở: Nội bộ file src/client/components/fx.tsx (trong component GLBackground).
 * @param ref Tham chiếu React ref trỏ tới phần tử DOM cần quan sát.
 * @param margin Khoảng đệm ngoài viewport (rootMargin, mặc định 200px) để kích hoạt sớm trước khi phần tử lọt hẳn vào màn hình.
 * @returns Giá trị boolean: true nếu phần tử nằm trong hoặc gần khung nhìn, false nếu ở xa.
 */
function useNearViewport(ref: React.RefObject<HTMLElement | null>, margin = "200px") {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    // Bỏ qua nếu chưa gắn ref hoặc môi trường không hỗ trợ IntersectionObserver (SSR).
    if (!el || typeof IntersectionObserver === "undefined") return;
    // rootMargin mở rộng thêm 200px để tải hoặc đánh thức canvas WebGL trước khi người dùng cuộn tới.
    const io = new IntersectionObserver((entries) => setNear(entries[0]?.isIntersecting ?? false), {
      rootMargin: margin,
    });
    io.observe(el);
    // Ngắt quan sát khi component unmount để tránh rò rỉ bộ nhớ (memory leak).
    return () => io.disconnect();
  }, [ref, margin]);
  return near;
}

/* ── pointer-reactive surfaces ───────────────────────────────────── */

/**
 * Card with a soft radial highlight that follows the cursor.
 *
 * The glow is a sibling layer rather than a background on the card itself, so it
 * composites over whatever the card already paints — photos, tables, gradients.
 */
/**
 * Làm gì: Thẻ bọc (Card container) với hiệu ứng quầng sáng tròn (radial spotlight) di chuyển mượt mà bám theo con trỏ chuột.
 * Được gọi ở: Các trang quản trị và người dùng như src/routes/account.tsx, app.classes.tsx, app.index.tsx, desk.courts.tsx, manager.index.tsx, login.tsx, register.tsx.
 * @param children Nội dung hiển thị bên trong thẻ card.
 * @param className Lớp CSS tùy biến áp dụng cho thẻ bọc.
 * @param color Màu quầng sáng (nhận giá trị màu CSS hợp lệ, mặc định dùng biến CSS var(--color-accent)).
 * @param strength Độ mờ đục đỉnh điểm của quầng sáng (từ 0 đến 1, mặc định 0.14).
 * @param size Đường kính quầng sáng tính bằng pixel (mặc định 320px).
 * @param as Thẻ HTML đóng vai trò làm wrapper (mặc định là "div").
 * @returns Phần tử JSX bọc nội dung cùng lớp quầng sáng radial gradient phản hồi theo chuyển động chuột.
 */
export function SpotlightCard({
  children,
  className,
  color = "var(--color-accent)",
  strength = 0.14,
  size = 320,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  /** Colour of the highlight. Any CSS colour `color-mix` accepts. */
  color?: string;
  /** Peak opacity of the highlight, 0–1. */
  strength?: number;
  /** Diameter of the highlight in px. */
  size?: number;
  as?: ElementType;
}) {
  // Bước 1: Khởi tạo tham chiếu DOM, trạng thái bật tắt và các MotionValue tọa độ (x, y).
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotionAfterMount();
  const [on, setOn] = useState(false);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  // Spring the position so a fast flick across the card trails rather than snaps.
  const sx = useSpring(x, { stiffness: 260, damping: 32, mass: 0.4 });
  const sy = useSpring(y, { stiffness: 260, damping: 32, mass: 0.4 });
  // Dùng color-mix trong không gian Oklab tạo dải màu gradient tự nhiên, sắc nét mà không bị đục màu khi hòa trộn.
  const bg = useMotionTemplate`radial-gradient(${size}px circle at ${sx}px ${sy}px, color-mix(in oklab, ${color} 100%, transparent), transparent 68%)`;

  // Bước 2: Trả về thẻ thuần không hiệu ứng nếu người dùng bật tùy chọn prefers-reduced-motion.
  if (reduced) return <Tag className={className}>{children}</Tag>;

  // Bước 3: Render thẻ wrapper với các sự kiện chuột (bỏ qua touch di động) để di chuyển và hiển thị quầng sáng.
  return (
    <Tag
      ref={ref}
      className={cn("relative isolate", className)}
      onPointerMove={(e: React.PointerEvent) => {
        if (e.pointerType !== "mouse") return;
        const r = ref.current?.getBoundingClientRect();
        if (!r) return;
        x.set(e.clientX - r.left);
        y.set(e.clientY - r.top);
      }}
      onPointerEnter={(e: React.PointerEvent) => {
        if (e.pointerType !== "mouse") return;
        // Seed the position before fading in, or the glow springs across the
        // card from wherever the last visitor left it.
        const r = ref.current?.getBoundingClientRect();
        if (r) {
          x.jump(e.clientX - r.left);
          y.jump(e.clientY - r.top);
        }
        setOn(true);
      }}
      onPointerLeave={() => setOn(false)}
    >
      <motion.span
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[1] rounded-[inherit]"
        style={{ background: bg }}
        animate={{ opacity: on ? strength : 0 }}
        transition={{ duration: 0.28 }}
      />
      {children}
    </Tag>
  );
}

/**
 * Diagonal band of light that sweeps across a surface once on hover.
 *
 * Distinct from the `.sweep` utility on buttons: this one is wide, slow and
 * angled, meant for photographs and large panels rather than pill controls.
 */
/**
 * Làm gì: Hiệu ứng vệt sáng chéo (glare/shine) quét qua bề mặt phần tử một lần khi rê chuột (hover).
 * Được gọi ở: src/routes/app.classes.tsx, app.pass.tsx, app.plans.tsx, app.points.tsx, manager.plans.tsx (trên ảnh bìa và thẻ gói dịch vụ).
 * @param children Nội dung hiển thị bên trong khung hiệu ứng.
 * @param className Lớp CSS tùy biến cho thẻ bao ngoài.
 * @param angle Góc nghiêng của vệt sáng theo độ (mặc định 16 độ).
 * @param duration Thời gian quét qua tính bằng giây (mặc định 0.85s).
 * @param opacity Độ trong suốt đỉnh của vệt sáng (mặc định 0.35).
 * @returns Phần tử JSX chứa nội dung và dải sáng lướt qua khi hover chuột.
 */
export function GlareHover({
  children,
  className,
  angle = 16,
  duration = 0.85,
  opacity = 0.35,
}: {
  children: ReactNode;
  className?: string;
  angle?: number;
  duration?: number;
  opacity?: number;
}) {
  // Bước 1: Khởi tạo state key (tăng giá trị để restart animation nếu chuột vào lại) và cờ playing.
  const reduced = useReducedMotionAfterMount();
  const [key, setKey] = useState(0);
  const [playing, setPlaying] = useState(false);

  // Bước 2: Bỏ qua hiệu ứng hoạt họa nếu người dùng yêu cầu giảm chuyển động (prefers-reduced-motion).
  if (reduced) return <div className={className}>{children}</div>;

  // Bước 3: Render thẻ wrapper và dải sáng motion.span lướt ngang từ -40% đến 130%.
  return (
    <div
      className={cn("relative isolate overflow-hidden", className)}
      onPointerEnter={(e) => {
        if (e.pointerType !== "mouse") return;
        // Bump the key so a re-entry restarts the sweep instead of being
        // swallowed while the previous one is still running.
        setKey((k) => k + 1);
        setPlaying(true);
      }}
    >
      {children}
      <motion.span
        key={key}
        aria-hidden
        className="pointer-events-none absolute inset-y-[-40%] z-[3] w-1/3"
        style={{
          rotate: angle,
          background: `linear-gradient(90deg, transparent, rgba(255,248,238,${opacity}), transparent)`,
          filter: "blur(6px)",
        }}
        initial={{ left: "-40%" }}
        animate={playing ? { left: "130%" } : { left: "-40%" }}
        transition={{ duration, ease: [0.16, 1, 0.3, 1] }}
        onAnimationComplete={() => setPlaying(false)}
      />
    </div>
  );
}

/**
 * Pulls its child a little way toward the cursor while the cursor is within
 * `radius` px. Used sparingly on primary CTAs — it makes the target feel eager,
 * but on more than one or two elements a page starts to feel unstable.
 */
/**
 * Làm gì: Hiệu ứng nam châm (magnet) hút nhẹ phần tử con về phía con trỏ chuột khi chuột tiến vào phạm vi bán kính quy định.
 * Được gọi ở: src/routes/app.assistant.tsx (nút gửi tin nhắn trợ lý), src/routes/login.tsx, src/routes/register.tsx (các nút CTA chính).
 * @param children Phần tử con nhận hiệu ứng hút từ tính.
 * @param className Lớp CSS cho phần tử chuyển động bên trong (motion.span).
 * @param radius Bán kính vùng cảm ứng từ tính tính bằng pixel (mặc định 130px).
 * @param pull Tỉ lệ dịch chuyển theo khoảng cách con trỏ (0 đến 1, mặc định 0.32 = dịch 32% khoảng cách).
 * @param wrapperClassName Lớp CSS cho thẻ span bao ngoài cố định vị trí.
 * @param off Tắt lực hút (ví dụ khi nút đang bị khóa) và đưa phần tử về chỗ cũ.
 * @returns Thẻ JSX bao quanh phần tử với hiệu ứng dịch chuyển tọa độ phản hồi theo chuột.
 */
export function Magnet({
  children,
  className,
  radius = 130,
  pull = 0.32,
  speed = 1,
  wrapperClassName,
  off = false,
}: {
  children: ReactNode;
  className?: string;
  /** A disabled button has nothing to offer the pointer, so it stays where it is. */
  off?: boolean;
  /** How close the pointer must get, in px, before the child reacts. */
  radius?: number;
  /** Fraction of the pointer offset the child travels. */
  pull?: number;
  /** Spring speed multiplier: 1 is the house default, below 1 drifts more slowly. */
  speed?: number;
  wrapperClassName?: string;
}) {
  // Bước 1: Khởi tạo giá trị tọa độ x, y và bộ lò xo useSpring tạo quán tính đàn hồi mượt mà.
  const ref = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotionAfterMount();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  // speed < 1 lowers stiffness and raises mass, so the child follows the pointer more lazily.
  const spring = { stiffness: 220 * speed, damping: 18, mass: 0.35 / speed };
  const sx = useSpring(x, spring);
  const sy = useSpring(y, spring);

  // Bước 2: Đăng ký sự kiện pointermove trên window để đón đầu chuyển động trước khi chuột chạm vào phần tử.
  useEffect(() => {
    if (reduced) return;
    if (off) {
      x.set(0);
      y.set(0);
      return;
    }
    // Tracked on the window, not the element: the point of a magnet is that it
    // reacts *before* the pointer arrives.
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      // Dùng Math.hypot tính khoảng cách Euclidean từ con trỏ tới tâm phần tử; nếu trong bán kính thì hút theo tỉ lệ pull.
      if (Math.hypot(dx, dy) < radius) {
        x.set(dx * pull);
        y.set(dy * pull);
      } else {
        x.set(0);
        y.set(0);
      }
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [radius, pull, reduced, off, x, y]);

  // Bước 3: Trả về thẻ tĩnh nếu người dùng bật giảm chuyển động để tránh gây chóng mặt/mất tập trung.
  if (reduced) return <span className={wrapperClassName}>{children}</span>;

  // Bước 4: Render thẻ con gắn tọa độ lò xo sx, sy tạo cảm giác hút vật lý sống động.
  return (
    <span ref={ref} className={cn("inline-block", wrapperClassName)}>
      <motion.span className={cn("inline-block", className)} style={{ x: sx, y: sy }}>
        {children}
      </motion.span>
    </span>
  );
}

/* ── text ────────────────────────────────────────────────────────── */

/** A travelling sheen across text. Pure CSS, so it costs nothing to leave on. */
/**
 * Làm gì: Hiệu ứng ánh kim lướt qua dòng chữ (pure CSS sheen animation), tạo điểm nhấn thị giác mà không tiêu tốn tài nguyên JS.
 * Được gọi ở: src/routes/app.assistant.tsx, app.index.tsx, login.tsx (các tiêu đề và nhãn huy hiệu nổi bật).
 * @param children Nội dung văn bản cần áp dụng hiệu ứng lấp lánh.
 * @param className Lớp CSS bổ sung cho thẻ span.
 * @param speed Chu kỳ quét qua của vệt sáng tính bằng giây (mặc định 4.5s).
 * @param disabled Cờ vô hiệu hóa hiệu ứng ánh kim (mặc định false).
 * @returns Thẻ span chứa class CSS .shiny-text kèm biến thời lượng --shiny-duration.
 */
export function ShinyText({
  children,
  className,
  speed = 4.5,
  disabled = false,
}: {
  children: ReactNode;
  className?: string;
  /** Seconds per pass. */
  speed?: number;
  disabled?: boolean;
}) {
  // Bỏ qua hiệu ứng nếu bị tắt qua prop disabled, trả về thẻ span tĩnh bình thường.
  if (disabled) return <span className={className}>{children}</span>;
  // Truyền tốc độ qua CSS variable --shiny-duration để điều khiển keyframes animation trong stylesheet.
  return (
    <span
      className={cn("shiny-text", className)}
      style={{ "--shiny-duration": `${speed}s` } as CSSProperties}
    >
      {children}
    </span>
  );
}

/**
 * Splits a headline into characters or words and rises them into place.
 *
 * The movement is a CSS animation, staggered by a per-unit `animation-delay`;
 * the only thing JavaScript decides is *when* to start it, via an
 * IntersectionObserver. See the `.split-unit` rules in `styles.css` for why the
 * animation itself is not a tween.
 *
 * The observer is what keeps this usable for the landing page's section
 * headings, which should hold still until they are scrolled to; anything
 * already on screen at mount intersects immediately and plays at once.
 */
/**
 * Làm gì: Tách dòng tiêu đề thành từng từ hoặc từng ký tự và tạo hiệu ứng nhô lên (rise-in) so le từng ký tự khi cuộn tới màn hình.
 * Được gọi ở: src/routes/app.index.tsx, login.tsx, manager.index.tsx, register.tsx (các tiêu đề chào mừng và tiêu đề trang chính).
 * @param text Chuỗi văn bản cần hiển thị hiệu ứng.
 * @param className Lớp CSS cho thẻ bọc ngoài.
 * @param splitBy Chế độ phân tách: "chars" (từng ký tự) hoặc "words" (từng từ, mặc định "chars").
 * @param stagger Độ trễ lệch pha giữa các ký tự liên tiếp tính bằng giây (mặc định 0.028s).
 * @param duration Thời gian diễn ra hiệu ứng nhô lên của mỗi ký tự tính bằng giây (mặc định 0.8s).
 * @param delay Thời gian chờ trước khi bắt đầu hiệu ứng ký tự đầu tiên tính bằng giây (mặc định 0s).
 * @param distance Khoảng cách dịch chuyển ban đầu theo phần trăm chiều cao (mặc định 118%).
 * @param margin Ngưỡng biên cuộn rootMargin để kích hoạt trước khi phần tử vào hẳn tầm mắt.
 * @param as Thẻ HTML dùng làm thẻ bọc (mặc định "span").
 * @returns Phần tử JSX chứa bản sao văn bản ẩn cho trình đọc màn hình và các khối ký tự hoạt họa.
 */
export function SplitText({
  text,
  className,
  splitBy = "chars",
  stagger = 0.028,
  duration = 0.8,
  delay = 0,
  distance = 118,
  margin = "0px 0px -12% 0px",
  as: Tag = "span",
}: {
  text: string;
  className?: string;
  splitBy?: "chars" | "words";
  stagger?: number;
  duration?: number;
  delay?: number;
  distance?: number;
  /** How far into the viewport the heading must come before it plays. */
  margin?: string;
  as?: ElementType;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotionAfterMount();
  const [shown, setShown] = useState(false);

  // Bước 1: Đo đạc vị trí phần tử trong layout; nếu đã nằm trong viewport thì hiển thị ngay lập tức không cần đợi observer.
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el || reduced || shown) return;

    // Measured rather than observed for the first answer. An
    // IntersectionObserver only delivers once the page is actually being
    // painted, so a heading that is plainly on screen would sit at opacity 0
    // for as long as the tab is not drawing — and a `getBoundingClientRect`
    // read costs nothing here, because layout has just happened anyway.
    // A viewport with no height is a page that is laid out but not being shown
    // — there is no scroll position to wait for, so there is nothing to reveal
    // on. Treat it as visible rather than leaving the text at opacity 0.
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const r = el.getBoundingClientRect();
    if (!vh || (r.bottom > 0 && r.top < vh * 0.88)) {
      setShown(true);
      return;
    }

    // Bước 2: Thiết lập IntersectionObserver cho phần tử ở dưới trang để chỉ kích hoạt hiệu ứng khi người dùng cuộn tới.
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: margin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduced, shown, margin]);

  // Reduced motion (and the server render) get the plain string — no wrapper
  // spans at all, so screen readers and text selection behave normally.
  // Bước 3: Nếu bật reduced motion, trả về chuỗi văn bản nguyên bản để hỗ trợ bộ đọc màn hình và bôi đen chọn chữ dễ dàng.
  if (reduced) return <Tag className={className}>{text}</Tag>;

  // Graphemes, not code points, so a Vietnamese letter and its tone marks stay in one unit.
  // Bước 4: Dùng Intl.Segmenter tách theo grapheme để không tách rời nguyên âm và dấu thanh tiếng Việt (tránh lỗi font/dấu).
  const graphemes = (w: string): string[] =>
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(w), (g) => g.segment)
      : Array.from(w);
  // Chuẩn hóa chuỗi dạng NFC để ghép các dấu tổ hợp và tách mảng theo khoảng trắng giữ nguyên cấu trúc từ.
  const words = text.normalize("NFC").split(/(\s+)/);
  // Whitespace is not a unit, so it must not consume a stagger step — otherwise
  // a word-split headline pauses in its own gaps and arrives unevenly.
  // Bước 5: Khởi tạo bộ đếm bước (step) và hàm tạo thẻ bọc span cho từng ký tự kèm animation-delay tính theo stagger.
  let step = 0;
  const unit = (u: string, key: number | string) => (
    // The mask is `overflow-hidden` on an inline-block; spaces stay outside it or the gap collapses.
    <span key={key} aria-hidden className="inline-block overflow-hidden align-bottom py-[0.28em] -my-[0.28em]">
      <span className="split-unit" style={{ "--split-delay": `${delay + step++ * stagger}s` } as CSSProperties}>
        {u}
      </span>
    </span>
  );

  // Bước 6: Render thẻ chứa với bản sao văn bản ẩn .sr-only cho trợ năng (accessibility) và các ký tự hoạt họa.
  return (
    <Tag
      ref={ref}
      className={cn("inline-block", className)}
      data-split-shown={shown ? "true" : undefined}
      style={
        {
          "--split-distance": `${distance}%`,
          "--split-duration": `${duration}s`,
        } as CSSProperties
      }
    >
      {/* aria-label is not allowed on a generic span/p; the real string is read
          from this hidden copy while the animated units stay aria-hidden. */}
      <span className="sr-only">{text}</span>
      {words.map((w, i) =>
        /^\s+$/.test(w) ? (
          <span key={i} aria-hidden>
            {" "}
          </span>
        ) : splitBy === "words" ? (
          unit(w, i)
        ) : (
          // Each word is one unbreakable box, so a line can only wrap at a space — otherwise the
          // break can fall between two letter boxes and strand a space at the start of a line.
          <span key={i} aria-hidden className="inline-block whitespace-nowrap">
            {graphemes(w).map((g, j) => unit(g, j))}
          </span>
        ),
      )}
    </Tag>
  );
}

/**
 * Scramble-in text: characters cycle through junk before settling.
 *
 * Only ever decorative — the real string is in `aria-label`, and the animation
 * runs once when the element scrolls in.
 */
/**
 * Làm gì: Hiệu ứng chữ giải mã (scramble-in text) ngẫu nhiên hóa các ký tự trước khi khóa dần vào chuỗi văn bản thực tế.
 * Được gọi ở: Component thư viện hiệu ứng dùng chung (src/client/components/fx.tsx) cho các màn hình cần tạo phong cách công nghệ / cyberpunk.
 * @param text Chuỗi văn bản mục tiêu hiển thị sau khi giải mã.
 * @param className Lớp CSS cho thẻ span bọc ngoài.
 * @param speed Tốc độ làm mới khung hình xáo trộn ký tự tính bằng mili-giây (mặc định 45ms).
 * @param charset Bảng ký tự ngẫu nhiên dùng để xáo trộn (mặc định là chữ hoa và chữ số A-Z, 0-9).
 * @returns Thẻ span chứa chuỗi văn bản đang xáo trộn và thuộc tính aria-label bảo đảm khả năng tiếp cận.
 */
export function DecryptedText({
  text,
  className,
  speed = 45,
  charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
}: {
  text: string;
  className?: string;
  /** ms between scramble frames. */
  speed?: number;
  charset?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotionAfterMount();
  const [shown, setShown] = useState(text);

  useEffect(() => {
    const el = ref.current;
    // Bước 1: Thoát sớm nếu phần tử chưa mount, người dùng bật chế độ giảm chuyển động (reduced motion) hoặc trình duyệt không hỗ trợ IntersectionObserver.
    if (!el || reduced || typeof IntersectionObserver === "undefined") return;
    let timer: ReturnType<typeof setInterval> | undefined;
    // Bước 2: Khởi tạo IntersectionObserver theo dõi; khi phần tử hiển thị tối thiểu 40% trong viewport thì mới kích hoạt hiệu ứng giải mã ký tự.
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        // Ngắt quan sát ngay sau lần hiển thị đầu tiên để hiệu ứng giải mã chỉ chạy duy nhất một lần.
        io.disconnect();
        let frame = 0;
        // Bước 3: Lặp qua từng khung hình (frame); sau mỗi 2 frame chốt thêm một ký tự thật từ trái sang phải, các ký tự còn lại xáo trộn ngẫu nhiên.
        timer = setInterval(() => {
          frame += 1;
          // One more character locks in per frame; everything to its right is junk.
          const locked = Math.floor(frame / 2);
          if (locked >= text.length) {
            setShown(text);
            clearInterval(timer);
            return;
          }
          setShown(
            text
              .split("")
              .map((c, i) =>
                i < locked || c === " " ? c : charset[Math.floor(Math.random() * charset.length)],
              )
              .join(""),
          );
        }, speed);
      },
      { threshold: 0.4 },
    );
    // Bắt đầu quan sát phần tử trong viewport.
    io.observe(el);
    // Bước 4: Dọn dẹp tài nguyên khi unmount hoặc khi dependencies thay đổi (ngắt observer và xóa timer interval).
    return () => {
      io.disconnect();
      if (timer) clearInterval(timer);
    };
  }, [text, speed, charset, reduced]);

  return (
    <span ref={ref} className={className}>
      <span className="sr-only">{text}</span>
      <span aria-hidden>{reduced ? text : shown}</span>
    </span>
  );
}

/* ── scroll-linked ───────────────────────────────────────────────── */

/**
 * Progressive blur at one edge of a scroll container — the content dissolves
 * instead of being chopped off by a hard mask.
 *
 * Built from a few stacked `backdrop-filter` layers, each masked to a narrower
 * band, because CSS has no gradient blur of its own.
 */
/**
 * Làm gì: Tạo hiệu ứng mờ dần (progressive blur) đa tầng ở cạnh trên hoặc dưới của container cuộn, giúp nội dung tan biến mềm mại thay vì bị cắt đột ngột.
 * Được gọi ở: src/client/components/fx.tsx (component tiện ích xuất khẩu cho các khối nội dung dạng cuộn).
 * @param side Cạnh hiển thị hiệu ứng làm mờ ("top" hoặc "bottom", mặc định "bottom").
 * @param height Chiều cao của vùng làm mờ (mặc định "6rem").
 * @param strength Độ mờ của lớp trong cùng tính bằng pixel; các lớp tiếp theo tăng dần theo lũy thừa (mặc định 2).
 * @param position Kiểu định vị của lớp phủ ("absolute" theo container cha hoặc "fixed" theo viewport, mặc định "absolute").
 * @param className Lớp CSS tùy biến bổ sung.
 * @returns JSX.Element chứa các lớp backdrop-filter xếp chồng tạo hiệu ứng gradient blur.
 */
export function GradualBlur({
  side = "bottom",
  height = "6rem",
  strength = 2,
  position = "absolute",
  className,
}: {
  side?: "top" | "bottom";
  height?: string;
  /** Blur radius of the innermost layer, in px; layers step up from there. */
  strength?: number;
  /** `fixed` pins the veil to the viewport edge rather than the parent box. */
  position?: "absolute" | "fixed";
  className?: string;
}) {
  // Xếp 5 lớp backdrop-filter với bán kính mờ tăng dần theo hàm lũy thừa để mô phỏng gradient blur mượt mà (do CSS không hỗ trợ gradient blur tự nhiên).
  const layers = 5;
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none inset-x-0 z-[4]",
        position === "fixed" ? "fixed" : "absolute",
        side === "bottom" ? "bottom-0" : "top-0",
        className,
      )}
      style={{ height }}
    >
      {Array.from({ length: layers }, (_, i) => {
        const from = (i / layers) * 100;
        const to = ((i + 1) / layers) * 100;
        const dir = side === "bottom" ? "to top" : "to bottom";
        return (
          <div
            key={i}
            className="absolute inset-0"
            style={{
              backdropFilter: `blur(${strength * (i + 1) ** 1.4}px)`,
              WebkitBackdropFilter: `blur(${strength * (i + 1) ** 1.4}px)`,
              maskImage: `linear-gradient(${dir}, rgba(0,0,0,1) ${from}%, rgba(0,0,0,0) ${to}%)`,
              WebkitMaskImage: `linear-gradient(${dir}, rgba(0,0,0,1) ${from}%, rgba(0,0,0,0) ${to}%)`,
            }}
          />
        );
      })}
    </div>
  );
}

/* ── composite widgets ───────────────────────────────────────────── */

/**
 * macOS-style dock: icons swell as the cursor passes over them.
 *
 * Pointer-only by design — there is no cursor to magnify toward on a phone, so
 * on touch this renders as an ordinary row of targets at full tap size.
 */
/**
 * Làm gì: Hiển thị thanh dock icon điều hướng kiểu macOS; tự động phóng to mượt mà các biểu tượng khi con trỏ chuột lướt qua.
 * Được gọi ở: src/client/components/fx.tsx (component xuất khẩu phục vụ thanh điều hướng dạng dock).
 * @param items Danh sách các mục hiển thị gồm key, label, icon, active và callback onSelect.
 * @param className Lớp CSS tùy biến cho thanh dock.
 * @param size Kích thước cơ bản của icon ở trạng thái nghỉ (pixel, mặc định 44).
 * @param magnify Kích thước phóng đại tối đa cộng thêm khi chuột ở tâm icon (pixel, mặc định 22).
 * @param radius Khoảng cách bán kính ngang kích hoạt hiệu ứng phóng to (pixel, mặc định 120).
 * @returns JSX.Element thanh dock điều hướng co giãn theo chuột.
 */
export function Dock({
  items,
  className,
  size = 44,
  magnify = 22,
  radius = 120,
}: {
  items: { key: string; label: string; icon: ReactNode; active?: boolean; onSelect?: () => void }[];
  className?: string;
  /** Resting icon box size in px. */
  size?: number;
  /** Extra px at full magnification. */
  magnify?: number;
  /** Horizontal falloff distance in px. */
  radius?: number;
}) {
  // Khởi tạo tọa độ X của chuột bằng dương vô cực để toàn bộ icon ở kích thước nghỉ; chỉ kích hoạt khi rê chuột thực tế (pointerType === "mouse").
  const mouseX = useMotionValue(Number.POSITIVE_INFINITY);
  return (
    <div
      className={cn("flex items-end gap-1.5", className)}
      onPointerMove={(e) => {
        if (e.pointerType !== "mouse") return;
        mouseX.set(e.clientX);
      }}
      onPointerLeave={() => mouseX.set(Number.POSITIVE_INFINITY)}
    >
      {items.map(({ key, ...it }) => (
        <DockItem key={key} mouseX={mouseX} size={size} magnify={magnify} radius={radius} {...it} />
      ))}
    </div>
  );
}

/**
 * Làm gì: Hiển thị một nút icon trong thanh Dock, tính toán khoảng cách từ tâm nút tới con trỏ chuột và co giãn kích thước bằng lò xo vật lý (spring physics).
 * Được gọi ở: src/client/components/fx.tsx (component Dock, render từng item trong danh sách).
 * @param mouseX MotionValue chứa tọa độ trục X hiện tại của con trỏ chuột.
 * @param size Kích thước nghỉ cơ bản của nút (pixel).
 * @param magnify Độ phóng đại tối đa cộng thêm khi chuột chạm đúng tâm nút (pixel).
 * @param radius Bán kính vùng tác động xung quanh tâm nút (pixel).
 * @param label Nhãn văn bản hiển thị trên tooltip và aria-label.
 * @param icon Biểu tượng ReactNode hiển thị giữa nút.
 * @param active Cờ đánh dấu mục đang được kích hoạt/chọn.
 * @param onSelect Hàm callback thực thi khi người dùng click vào nút.
 * @returns JSX.Element nút bấm co giãn theo vị trí chuột.
 */
function DockItem({
  mouseX,
  size,
  magnify,
  radius,
  label,
  icon,
  active,
  onSelect,
}: {
  mouseX: ReturnType<typeof useMotionValue<number>>;
  size: number;
  magnify: number;
  radius: number;
  label: string;
  icon: ReactNode;
  active?: boolean;
  onSelect?: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const reduced = useReducedMotionAfterMount();

  // Bước 1: Tính khoảng cách theo phương ngang từ con trỏ chuột đến tâm điểm của nút icon.
  const distance = useTransform(mouseX, (v) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return Number.POSITIVE_INFINITY;
    return Math.abs(v - (r.left + r.width / 2));
  });
  // Bước 2: Ánh xạ khoảng cách thành kích thước mục tiêu; càng gần tâm nút càng phóng to, giới hạn trong khoảng [size, size + magnify].
  const target = useTransform(distance, [0, radius], [size + magnify, size], { clamp: true });
  // Bước 3: Áp dụng hiệu ứng lò xo (spring physics) để thay đổi kích thước mượt mà, đàn hồi tự nhiên.
  const width = useSpring(target, { stiffness: 340, damping: 26, mass: 0.35 });

  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      aria-label={label}
      aria-current={active}
      className="group relative grid shrink-0 place-items-center"
      style={{ height: size + magnify }}
    >
      <motion.span
        className={cn(
          "grid aspect-square place-items-center rounded-[var(--radius-pill)] transition-colors duration-200",
          active ? "bg-accent text-accent-fg shadow-[var(--shadow-accent)]" : "bg-wood text-muted group-hover:text-fg",
        )}
        style={reduced ? { width: size, height: size } : { width, height: width }}
      >
        {icon}
      </motion.span>
      <span className="pointer-events-none absolute -top-1 left-1/2 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-[var(--radius-pill)] bg-fg px-2 py-1 text-2xs text-bg opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        {label}
      </span>
    </button>
  );
}

/**
 * Pill with a light travelling round its border. Reserved for the single most
 * important control on a screen — it stops meaning "look here" if it is used twice.
 */
/**
 * Làm gì: Bọc phần tử nút bấm bằng đường viền hình viên thuốc có vệt sáng chạy vòng quanh liên tục; dùng riêng cho nút kêu gọi hành động (CTA) quan trọng nhất trên mỗi màn hình.
 * Được gọi ở:
 *   - src/routes/account.tsx (nút nạp tiền và đổi mật khẩu)
 *   - src/routes/app.book.tsx (nút xác nhận giữ sân chính)
 *   - src/routes/desk.courts.tsx (nút chuyển trạng thái bảo trì sân)
 *   - src/routes/desk.index.tsx (nút tác vụ bàn quầy tiếp tân)
 *   - src/routes/desk.payments.tsx (nút tạo giao dịch / xác nhận thanh toán)
 *   - src/routes/manager.prices.tsx (nút lưu cấu hình giá)
 * @param children Nội dung hiển thị bên trong viền phát sáng.
 * @param className Lớp CSS tùy biến cho thẻ bao ngoài.
 * @param innerClassName Lớp CSS tùy biến cho thẻ chứa nội dung bên trong.
 * @param speed Thời gian vệt sáng hoàn thành một vòng viền (giây, mặc định 5s).
 * @returns JSX.Element khối nút với viền phát sáng chuyển động.
 */
export function StarBorder({
  children,
  className,
  innerClassName,
  speed = 5,
}: {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
  /** Seconds per lap. */
  speed?: number;
}) {
  // Sinh ID ngẫu nhiên hợp lệ trong CSS selector (bỏ dấu hai chấm) để gắn biến tùy chỉnh thời lượng animation.
  const id = useId().replace(/:/g, "");
  return (
    <span
      className={cn("star-border relative inline-block rounded-[var(--radius-pill)] p-px", className)}
      style={{ "--star-duration": `${speed}s`, "--star-id": id } as CSSProperties}
    >
      <span className={cn("relative z-[1] block rounded-[var(--radius-pill)]", innerClassName)}>
        {children}
      </span>
    </span>
  );
}

/**
 * Full-viewport click feedback: a short burst of lines radiating from the
 * pointer. Drawn on one shared canvas rather than per-element DOM nodes.
 *
 * Mounted once at the app root.
 */
/**
 * Làm gì: Hiển thị phản hồi khi click chuột dưới dạng chùm tia lửa phát ra từ con trỏ; toàn bộ hiệu ứng vẽ trên một thẻ canvas 2D phủ toàn viewport để tối ưu hiệu năng và không rác DOM.
 * Được gọi ở: src/routes/__root.tsx (mount một lần duy nhất tại root layout của ứng dụng).
 * @param color Màu sắc của tia lửa dạng chuỗi CSS (mặc định "#3f7d20").
 * @param count Số lượng tia lửa phát ra trong mỗi lần click (mặc định 8).
 * @param length Chiều dài tối đa của tia lửa (pixel, mặc định 13).
 * @param duration Thời gian tồn tại của tia lửa trước khi tan biến (mili-giây, mặc định 380ms).
 * @returns JSX.Element thẻ canvas cố định phủ toàn màn hình (hoặc null nếu giảm chuyển động).
 */
export function ClickSpark({
  color = "#3f7d20",
  count = 8,
  length = 13,
  duration = 380,
}: {
  color?: string;
  count?: number;
  length?: number;
  duration?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotionAfterMount();
  const mounted = useMounted();

  useEffect(() => {
    // Bước 1: Bỏ qua hiệu ứng nếu người dùng bật chế độ giảm chuyển động hoặc component chưa mount trên client.
    if (reduced || !mounted) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    let sparks: { x: number; y: number; angle: number; born: number }[] = [];
    let raf = 0;

    // Bước 2: Thiết lập kích thước canvas theo độ phân giải màn hình (dpr tối đa 2x) để nét vẽ sắc nét trên màn hình Retina.
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    // Bước 3: Vòng lặp vẽ tia lửa bằng requestAnimationFrame; tính độ dài và độ mờ theo hàm easeOutCubic để tạo hiệu ứng nổ nhẹ rồi dừng hẳn vòng lặp khi không còn tia lửa.
    const draw = (now: number) => {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      sparks = sparks.filter((s) => now - s.born < duration);
      for (const s of sparks) {
        const t = (now - s.born) / duration;
        // easeOutCubic on distance, linear fade — the burst reads as a pop.
        const eased = 1 - (1 - t) ** 3;
        const r0 = 6 + eased * length;
        const r1 = r0 + length * 0.55 * (1 - t);
        ctx.globalAlpha = 1 - t;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.6;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(s.x + Math.cos(s.angle) * r0, s.y + Math.sin(s.angle) * r0);
        ctx.lineTo(s.x + Math.cos(s.angle) * r1, s.y + Math.sin(s.angle) * r1);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // Park the loop entirely when nothing is on screen; this canvas covers the
      // whole viewport and must not cost a frame while the user is reading.
      raf = sparks.length ? requestAnimationFrame(draw) : 0;
    };

    // Bước 4: Lắng nghe sự kiện click chuột, sinh góc bắn ngẫu nhiên và thêm các tia lửa mới vào danh sách chờ vẽ.
    const onClick = (e: MouseEvent) => {
      // Reduced motion silences this too: a click still happened, but sparks are motion.
      if (isCalm()) return;
      const now = performance.now();
      const jitter = Math.random() * Math.PI;
      for (let i = 0; i < count; i++) {
        sparks.push({ x: e.clientX, y: e.clientY, angle: jitter + (i / count) * Math.PI * 2, born: now });
      }
      if (!raf) raf = requestAnimationFrame(draw);
    };

    // Bước 5: Đăng ký lắng nghe sự kiện click và thay đổi kích thước cửa sổ; hủy đăng ký và dừng animation loop khi unmount.
    window.addEventListener("click", onClick);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("resize", resize);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [color, count, length, duration, reduced, mounted]);

  if (reduced || !mounted) return null;
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[60]"
    />
  );
}

/* ── WebGL backgrounds ───────────────────────────────────────────── */

// Tải lười (lazy load) các shader WebGL từ module ./gl; đảm bảo thư viện OGL không bị gộp vào bundle JavaScript chính để tối ưu thời gian tải trang ban đầu.
const Aurora = lazy(() => import("./gl").then((m) => ({ default: m.Aurora })));
const Silk = lazy(() => import("./gl").then((m) => ({ default: m.Silk })));
const Threads = lazy(() => import("./gl").then((m) => ({ default: m.Threads })));
const DotGrid = lazy(() => import("./gl").then((m) => ({ default: m.DotGrid })));
const Court = lazy(() => import("./gl").then((m) => ({ default: m.Court })));
const HallFlow = lazy(() => import("./gl").then((m) => ({ default: m.HallFlow })));

/** `flow` redraws the `<video>` in the same `[data-media]` box, so mount it inside that box. */
/**
 * Danh sách tên các biến thể nền WebGL shader: aurora (cực quang), silk (lụa sóng), threads (sợi chỉ), dotgrid (lưới điểm), court (sân thể thao 3D), flow (dòng chảy).
 */
export type GLVariant = "aurora" | "silk" | "threads" | "dotgrid" | "court" | "flow";

/**
 * Drops a live shader behind a section.
 *
 * The real work is deferred three ways, because a booking app cannot afford a
 * WebGL context on the critical path: `ogl` is a lazy chunk, the canvas only
 * mounts on the client, and it only renders while the section is near the
 * viewport. Reduced motion skips it entirely and falls back to `fallback`.
 */
/**
 * Làm gì: Hiển thị phông nền WebGL shader động phía sau các khối nội dung; trì hoãn tải OGL qua dynamic import, chỉ vẽ khi ở gần viewport và fallback về hình ảnh/giao diện tĩnh khi giảm chuyển động.
 * Được gọi ở:
 *   - src/client/components/landing/hero.tsx (hero banner trang chủ)
 *   - src/client/components/landing/steps.tsx (khối các bước tính năng)
 *   - src/routes/app.assistant.tsx (màn hình trợ lý AI)
 *   - src/routes/desk.index.tsx (bàn tiếp tân trung tâm)
 *   - src/routes/desk.payments.tsx (quản lý thanh toán quầy)
 *   - src/routes/login.tsx & src/routes/register.tsx (trang đăng nhập, đăng ký tài khoản)
 *   - src/routes/manager.index.tsx (bảng điều khiển quản lý tổng)
 * @param variant Tên biến thể hiệu ứng nền WebGL ("aurora" | "silk" | "threads" | "dotgrid" | "court" | "flow").
 * @param className Lớp CSS tùy biến cho container bao ngoài.
 * @param fallback Giao diện tĩnh thay thế hiển thị trong lúc tải, khi ngoài viewport hoặc khi bật giảm chuyển động.
 * @param position Kiểu định vị của khung nền ("absolute" bên trong khối cha hoặc "fixed" cố định toàn trang).
 * @param props Các thuộc tính tùy biến dành riêng cho từng loại shader (colors, speed, amplitude, scale, gap, drive...).
 * @returns JSX.Element chứa lớp nền WebGL động hoặc fallback tĩnh.
 */
export function GLBackground({
  variant,
  className,
  fallback,
  position = "absolute",
  ...props
}: {
  variant: GLVariant;
  className?: string;
  /** Static stand-in shown before load, off-screen, and under reduced motion. */
  fallback?: ReactNode;
  /** `fixed` pins the canvas to the viewport, for a whole-page field. */
  position?: "absolute" | "fixed";
  colors?: string[];
  color?: string;
  amplitude?: number;
  speed?: number;
  opacity?: number;
  scale?: number;
  gap?: number;
  dot?: number;
  radius?: number;
  /** `court` only: live dials (scroll tilt, free-hours glow), mutated by the page. */
  drive?: { current: { tilt: number; glow: number } };
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Bước 1: Xác định cờ live dựa trên 3 điều kiện: đã mount ở client, đang ở gần viewport (IntersectionObserver) và không bật giảm chuyển động (useCalm); chỉ khi live = true mới dựng WebGL để tiết kiệm GPU.
  const reduced = useCalm();
  const mounted = useMounted();
  const near = useNearViewport(ref);
  const live = mounted && near && !reduced;

  // Bước 2: Ánh xạ biến thể variant sang component shader tương ứng (mặc định là DotGrid nếu không khớp các tên khác).
  const Comp =
    variant === "aurora"
      ? Aurora
      : variant === "silk"
        ? Silk
        : variant === "threads"
          ? Threads
          : variant === "court"
            ? Court
            : variant === "flow"
              ? HallFlow
              : DotGrid;

  return (
    <div
      ref={ref}
      aria-hidden
      className={cn(
        "pointer-events-none inset-0 overflow-hidden",
        position === "fixed" ? "fixed" : "absolute",
        className,
      )}
    >
      {fallback}
      {live ? (
        <Suspense fallback={null}>
          <Comp {...props} />
        </Suspense>
      ) : null}
    </div>
  );
}
