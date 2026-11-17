/**
 * File: src/client/lib/gsap.ts
 * Vai trò: Cổng tích hợp duy nhất (the one door) cho thư viện hoạt họa GSAP trong ứng dụng Arena3.
 * Vị trí trong app: Cung cấp điểm cấu hình tập trung cho GSAP (đăng ký plugin, easing curves chung), đồng thời cung cấp hook useScene và hàm motionOff để xây dựng các hiệu ứng cuộn trang (scroll story) ở Landing page và hoạt ảnh khoảnh khắc (app moments), tự động tôn trọng tùy chọn giảm chuyển động (reduced motion).
 */
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { CustomEase } from "gsap/CustomEase";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { type RefObject } from "react";
import { useCalm } from "@/client/lib/calm";

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

// Xác định môi trường client (trình duyệt) để đảm bảo các API DOM và plugin GSAP không bị gọi khi SSR trên server.
const client = typeof window !== "undefined";
// Tập hợp lưu trữ các plugin đã đăng ký để tránh việc gọi gsap.registerPlugin nhiều lần cho cùng một plugin.
const registered = new Set<object>();

/** Register plugins once, in the browser only. Each GSAP module lists the plugins it needs. */
/**
 * Làm gì: Đăng ký các plugin GSAP một lần duy nhất ở phía client, tự động bỏ qua nếu đang chạy SSR trên server hoặc plugin đã được nạp trước đó.
 * Được gọi ở:
 * - src/client/lib/gsap.ts (đăng ký useGSAP, ScrollTrigger, CustomEase).
 * - Các component landing: coaches.tsx, hero.tsx, kit.tsx, manifesto.tsx, smoother.tsx, tweens.ts.
 * - Các component moments: hold-countdown.tsx, paid.tsx, sport-glyph.tsx.
 * @param plugins Danh sách các plugin GSAP cần đăng ký (Flip, ScrollTrigger, SplitText, ScrambleTextPlugin, DrawSVGPlugin, MotionPathPlugin, MorphSVGPlugin...).
 */
export function registerGsap(...plugins: object[]) {
  // Bước 1: Thoát ngay nếu đang chạy ở môi trường server (SSR) vì GSAP chỉ hoạt động trên trình duyệt.
  if (!client) return;
  // Bước 2: Lọc lấy các plugin mới chưa từng được đăng ký trong Set registered.
  const fresh = plugins.filter((p) => !registered.has(p));
  // Không làm gì thêm nếu toàn bộ plugin truyền vào đều đã được đăng ký trước đó.
  if (!fresh.length) return;
  // Bước 3: Đăng ký các plugin mới với GSAP và lưu vào registered để không bị đăng ký lặp lại.
  gsap.registerPlugin(...fresh);
  fresh.forEach((p) => registered.add(p));
}

// Đăng ký trước bộ ba plugin nền tảng (useGSAP, ScrollTrigger, CustomEase) ngay khi module được nạp lần đầu.
registerGsap(useGSAP, ScrollTrigger, CustomEase);
// Thiết lập các thông số easing chuẩn và cấu hình mặc định cho GSAP trên môi trường trình duyệt.
if (client) {
  // The house easing (DESIGN.md: one curve for everything), shared with `motion`'s EASE_SMOOTH.
  CustomEase.create("arena", "0.22,1,0.36,1");
  // The softer exit curve the hero used for its first frames.
  CustomEase.create("arena-out", "0.16,1,0.3,1");
  gsap.defaults({ ease: "arena", duration: 0.6 });
}

/**
 * Làm gì: Tái xuất (re-export) đối tượng gsap, plugin ScrollTrigger và hook useGSAP đã được gắn sẵn cấu hình chuẩn của Arena3.
 * Được gọi ở: Các component hoạt họa ở landing page (hero, header, courts, ticker...) và các khoảnh khắc tương tác đặc biệt (moments).
 */
export { gsap, ScrollTrigger, useGSAP };

// Kiểu dữ liệu chứa các cờ ngữ cảnh (motion, desktop) truyền vào hàm dựng cảnh hoạt họa trong useScene.
export type SceneFlags = {
  /** Animate at all. False under reduced motion: show the end state instead. */
  motion: boolean;
  /** Wide enough for pinning and sideways scrubbing (768px and up). */
  desktop: boolean;
};

// Cấu hình các điều kiện media query cho gsap.matchMedia để phản hồi tương thích theo kích thước màn hình và tùy chọn giảm chuyển động.
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
/**
 * Làm gì: Hook quản lý vòng đời phân cảnh hoạt họa GSAP (scene) theo phạm vi một component DOM, tự động dọn dẹp (revert) khi unmount hoặc khi thay đổi breakpoint/tùy chọn giảm chuyển động.
 * Được gọi ở: Hầu hết các component Landing Page (src/client/components/landing/{closing, coaches, courts, facilities, gallery, header, hero, kit, manifesto, plans, pricing, schedule, shuttle3d, steps, testimonials, ticker}.tsx).
 * @param scope RefObject trỏ tới phần tử DOM gốc của component làm phạm vi (scope) cho các bộ chọn GSAP.
 * @param build Hàm dựng hoạt họa nhận SceneFlags ({ motion, desktop }) và có thể trả về hàm cleanup.
 * @param deps Mảng phụ thuộc bổ sung để khởi tạo lại scene khi thay đổi.
 */
export function useScene(
  scope: RefObject<HTMLElement | null>,
  build: (flags: SceneFlags) => void | (() => void),
  deps: unknown[] = [],
) {
  // Bước 1: Lấy trạng thái giảm chuyển động toàn cục từ hook useCalm.
  const calm = useCalm();
  // Bước 2: Dùng hook useGSAP để cô lập animation trong phạm vi component và dọn dẹp an toàn khi component unmount hoặc cập nhật.
  useGSAP(
    () => {
      // Thoát sớm nếu phần tử DOM mục tiêu chưa sẵn sàng.
      if (!scope.current) return;
      // Khởi tạo bộ quản lý media query cục bộ gắn với phần tử DOM scope.
      const mm = gsap.matchMedia(scope.current);
      // Đăng ký kịch bản phản hồi theo media query: tự động chạy lại hàm build khi thay đổi độ rộng màn hình hoặc tùy chọn giảm chuyển động.
      mm.add(QUERIES, (ctx) => {
        const c = ctx.conditions as Record<keyof typeof QUERIES, boolean>;
        // Chỉ bật hoạt ảnh (motion: true) khi người dùng không bật prefers-reduced-motion và ứng dụng không ở chế độ calm.
        return build({ motion: !c.reduce && !calm, desktop: c.desktop });
      });
      // Trả về hàm dọn dẹp để revert toàn bộ tweens, timelines và ScrollTriggers đã đăng ký khi rời khỏi breakpoint.
      return () => mm.revert();
    },
    { scope, dependencies: [calm, ...deps], revertOnUpdate: true },
  );
}

/** `true` when nothing may move by itself: the device asked for reduced motion. */
/**
 * Làm gì: Kiểm tra xem các chuyển động tự động có cần phải tắt hay không dựa trên cờ calm và thiết lập reduced-motion của hệ thống.
 * Được gọi ở:
 * - src/client/components/landing/{coaches, smoother, testimonials}.tsx
 * - src/client/components/moments/{hold-countdown, paid, sport-glyph}.tsx
 * @param calm Cờ boolean cho biết ứng dụng có đang ở chế độ giảm chuyển động (calm) hay không.
 * @returns true nếu cần tắt chuyển động tự động (giữ nguyên trạng thái tĩnh cuối cùng), ngược lại trả về false.
 */
export const motionOff = (calm: boolean) =>
  calm || (client && window.matchMedia(QUERIES.reduce).matches);
