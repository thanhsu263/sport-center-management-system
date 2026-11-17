/**
 * Tệp này quản lý trạng thái giảm chuyển động (reduced motion / calm mode) trên toàn bộ ứng dụng.
 * Vai trò trong ứng dụng:
 * - Theo dõi tùy chọn prefers-reduced-motion từ hệ điều hành của người dùng theo thời gian thực.
 * - Cung cấp hook useCalm và hàm isCalm để các component (video nền, hiệu ứng WebGL/sparks, ticker, GSAP, Motion) tự động vô hiệu hóa hoạt ảnh phức tạp, tránh say chuyển động và tiết kiệm GPU.
 * - Cung cấp hàm scrollBehavior điều chỉnh hành vi cuộn trang (cuộn tức thì "auto" hoặc cuộn mượt "smooth") đồng bộ với cài đặt chuyển động.
 */
import { useSyncExternalStore } from "react";

/**
 * Calm means the device asked for reduced motion. Looping video, shaders and
 * the ticker follow `useCalm()`. One-shot transitions keep Motion's own hook,
 * so a preference change does not remount a form mid-typing.
 */
const QUERY = "(prefers-reduced-motion: reduce)";

let system = false;
const subscribers = new Set<() => void>();
/**
 * Làm gì: Kích hoạt tất cả các hàm callback đã đăng ký trong subscribers để thông báo cho các component khi tùy chọn chuyển động thay đổi.
 * Được gọi ở: Listener sự kiện change của MediaQueryList (dòng 25 trong tệp này).
 * @returns Không trả về giá trị (void).
 */
const emit = () => subscribers.forEach((f) => f());

if (typeof window !== "undefined") {
  // The pause button is gone. A choice saved under it would stay on forever.
  try {
    localStorage.removeItem("arena3.calm");
  } catch {
    /* storage blocked */
  }
  // Lấy trạng thái giảm chuyển động từ hệ thống và đăng ký lắng nghe sự kiện thay đổi theo thời gian thực
  const mq = window.matchMedia?.(QUERY);
  system = mq?.matches === true;
  mq?.addEventListener?.("change", (e) => {
    system = e.matches;
    emit();
  });
}

/**
 * Làm gì: Đăng ký một hàm callback vào danh sách subscribers và trả về hàm dọn dẹp để hủy đăng ký; dùng cho React useSyncExternalStore.
 * Được gọi ở: Hook useCalm (dòng 35 trong tệp này) thông qua useSyncExternalStore.
 * @param f Hàm callback thông báo cho React render lại khi trạng thái chuyển động thay đổi.
 * @returns Hàm dọn dẹp để xóa callback khỏi Set subscribers.
 */
const subscribe = (f: () => void) => {
  subscribers.add(f);
  return () => void subscribers.delete(f);
};

/** True when nothing should move by itself. */
/**
 * Làm gì: Hook React lắng nghe trạng thái giảm chuyển động (prefers-reduced-motion) bằng useSyncExternalStore, đảm bảo đồng bộ và tránh lỗi hydration giữa SSR và client.
 * Được gọi ở:
 * - src/client/components/landing/hero.tsx (component Hero)
 * - src/client/components/landing/ticker.tsx (component ClassTicker)
 * - src/client/components/landing/smoother.tsx (component SmootherRoot)
 * - src/client/components/media.tsx (component HeroVideo, Cover)
 * - src/client/components/motion.tsx (component MotionConfigRoot)
 * - src/client/lib/gsap.ts (hook useScene)
 * @returns true nếu thiết bị yêu cầu giảm chuyển động (prefers-reduced-motion), false nếu cho phép chuyển động bình thường (hoặc khi render phía server).
 */
export const useCalm = (): boolean => useSyncExternalStore(subscribe, () => system, () => false);

/** For event handlers, where a hook cannot be called. */
/**
 * Làm gì: Lấy nhanh trạng thái giảm chuyển động hiện tại một cách đồng bộ mà không cần gọi hook React; dùng cho event handler hoặc hàm tiện ích bên ngoài React lifecycle.
 * Được gọi ở:
 * - src/client/components/fx.tsx (hàm onClick xử lý hiệu ứng tia lửa/sparks)
 * - src/client/lib/calm.ts (hàm scrollBehavior)
 * @returns true nếu thiết bị đang bật chế độ giảm chuyển động, ngược lại false.
 */
export const isCalm = (): boolean => system;

/** `behavior` for `scrollIntoView` / `scrollTo`: instant when calm. */
/**
 * Làm gì: Xác định thuộc tính behavior cho scrollTo hoặc scrollIntoView, tự động chuyển thành "auto" (cuộn tức thì) khi bật calm mode để tránh say chuyển động.
 * Được gọi ở:
 * - src/routes/app.assistant.tsx (hàm cuộn hộp thoại tin nhắn trợ lý ảo)
 * - src/routes/chat.tsx (hàm cuộn danh sách tin nhắn chat)
 * @returns "auto" nếu thiết bị bật giảm chuyển động, "smooth" nếu chuyển động bình thường.
 */
export const scrollBehavior = (): ScrollBehavior => (isCalm() ? "auto" : "smooth");
