/**
 * File: src/client/components/landing/shuttle3d.tsx
 * Vai trò: Quản lý và render hoạt cảnh 3D WebGL2 của quả cầu lông bay xuyên suốt trang landing page.
 * Vị trí trong app: Được gắn ngoài LandingSmoother tại src/routes/index.tsx (route "/"), chạy trên canvas cố định toàn màn hình (fixed inset-0 pointer-events-none) để không chặn tương tác của người dùng.
 */
import { useEffect, useRef, useState } from "react";
import { gsap, useScene } from "@/client/lib/gsap";
import { canShuttle3D, createShuttle3D, type Shuttle3D } from "./shuttle3d-gl";
import { drawScene, newSceneState } from "./shuttle3d-scene";

/** Flag on <html> while the 3D scene is drawing, so the hero can drop its 2D shuttle. */
/**
 * Làm gì: Tên class CSS ("shuttle-on") gắn vào thẻ <html> khi hoạt cảnh 3D đang render thành công, giúp ẩn quả cầu 2D tĩnh trong Hero section để tránh hiển thị trùng lặp.
 * Được gọi ở:
 * - src/styles.css: ẩn phần tử [data-shuttle] khi html có class shuttle-on
 * - src/client/components/landing/shuttle3d.tsx: bật/tắt class trong hàm frame và gỡ bỏ khi cleanup
 */
export const SHUTTLE_ON_CLASS = "shuttle-on";

/**
 * The landing's 3D scene: a shuttlecock served in the hero, hit by a racket, that turns into a
 * basketball and then a volleyball as the page scrolls. Raw WebGL2 on one fixed, click-through
 * canvas. It has to sit outside `#smooth-content` (a transformed ancestor would break `fixed`),
 * so it is mounted next to the header.
 *
 * `glow` is how much of the court is free today; it warms the feathers' lime rim light.
 * Under reduced motion it draws one still pose. Without WebGL2 it renders nothing and the hero
 * keeps its SVG serve.
 */
/**
 * Làm gì: Component React khởi tạo và điều khiển khung cảnh 3D quả cầu lông bằng WebGL2 trên canvas cố định, biến đổi hình dạng theo tiến trình cuộn trang và tương tác chuột.
 * Được gọi ở: src/routes/index.tsx (component Home, truyền vào prop header của LandingSmoother tại route "/").
 * @param glow Tỷ lệ giờ sân còn trống trong ngày (0.0 đến 1.0), làm ấm ánh sáng viền xanh chanh trên lông cầu (mặc định 0.8).
 * @returns Khối JSX chứa container cố định toàn màn hình và thẻ canvas WebGL2 khi trình duyệt hỗ trợ.
 */
export function ShuttleScene({ glow = 0.8 }: { glow?: number }) {
  // Bước 1: Khởi tạo các ref tham chiếu DOM (wrap, canvas), state kiểm tra hỗ trợ WebGL2 và ref lưu giá trị glow mới nhất.
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [supported, setSupported] = useState(false);
  const glowRef = useRef(glow);
  // Cập nhật ref trong mỗi lần render để vòng lặp GSAP luôn đọc được giá trị glow mới nhất mà không gây re-render.
  glowRef.current = glow;

  // Bước 2: Kiểm tra khả năng hỗ trợ WebGL2 trên client sau khi component mount để đồng nhất kết quả render với SSR.
  // Probe after mount so the server and the first client render match.
  useEffect(() => setSupported(canShuttle3D()), []);

  // Bước 3: Đăng ký hoạt cảnh 3D với GSAP thông qua hook useScene khi WebGL2 được hỗ trợ.
  useScene(
    wrap,
    ({ motion }) => {
      // Lấy phần tử canvas; nếu trình duyệt không hỗ trợ WebGL2 hoặc canvas chưa sẵn sàng thì hủy thao tác vẽ.
      const cv = canvas.current;
      if (!supported || !cv) return;
      // Khởi tạo engine WebGL2, nạp chương trình shader và các mô hình lưới (mesh) cho vợt, quả cầu và bóng.
      const L: Shuttle3D | null = createShuttle3D(cv);
      if (!L) return;
      // Khởi tạo đối tượng lưu trữ trạng thái khung cảnh (góc xoay rx, ry, yaw và tiến trình cuộn p).
      const S = newSceneState();
      const root = document.documentElement;
      // Tính toán tỷ lệ cuộn của trang web trong khoảng [0, 1] để điều khiển chuyển động và góc biến đổi của vật thể.
      const pageP = () => {
        const max = Math.max(1, root.scrollHeight - window.innerHeight);
        return Math.min(1, Math.max(0, window.scrollY / max));
      };
      let hidden = document.hidden;
      let clock = 0;
      // Hàm vẽ một khung hình 3D: tính toán khung nhìn, vùng cắt giới hạn (clip-path) và gọi drawScene.
      const frame = () => {
        const vw = window.innerWidth, vh = window.innerHeight;
        const slot = document.querySelector<HTMLElement>("[data-shuttle-stage]");
        const bounds = slot?.getBoundingClientRect();
        // 0 while the hero stage fills its half of the screen, 1 once it has scrolled away: the
        // shuttle then leaves the stage and keeps flying down the page margins.
        const hand = bounds ? 1 - Math.min(1, Math.max(0, bounds.bottom / (vh * 0.55))) : 1;
        cv.style.visibility = "visible";
        if (bounds && hand === 0) {
          // Clip the served scene (including racket ghosts) to its reserved area.
          cv.style.clipPath = `inset(${Math.max(0, bounds.top)}px ${Math.max(0, vw - bounds.right)}px ${Math.max(0, vh - bounds.bottom)}px ${Math.max(0, bounds.left)}px)`;
        } else {
          // Cut every on-screen court grid out of the canvas, so the ball never covers a cell.
          const holes = [...document.querySelectorAll<HTMLElement>("[data-no-fly]")]
            .map((n) => n.getBoundingClientRect())
            .filter((r) => r.bottom > 0 && r.top < vh && r.width > 0)
            .map((r) => `M${r.left} ${r.top}H${r.right}V${r.bottom}H${r.left}Z`);
          cv.style.clipPath = holes.length ? `path(evenodd, "M0 0H${vw}V${vh}H0Z${holes.join("")}")` : "none";
        }
        // Gọi hàm drawScene để vẽ vật thể 3D lên WebGL2 với tọa độ neo trên sân khấu Hero và thông số ánh sáng viền.
        const ok = drawScene(L, S, { time: clock, motion, glow: glowRef.current, hand,
          anchor: bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : undefined });
        // Bật/tắt class shuttle-on trên <html>: khi 3D vẽ thành công (ok = true), ẩn quả cầu 2D trong Hero để tránh trùng lặp.
        root.classList.toggle(SHUTTLE_ON_CLASS, ok);
      };

      // Bước 4: Xử lý riêng khi người dùng bật chế độ giảm chuyển động (prefers-reduced-motion): chỉ vẽ lại khung hình tĩnh khi cuộn hoặc đổi kích thước cửa sổ.
      if (!motion) {
        // One still pose, redrawn when the page scrolls or resizes. No loop.
        const still = () => { S.p = pageP(); frame(); };
        L.onRestore = still;
        still();
        window.addEventListener("scroll", still, { passive: true });
        window.addEventListener("resize", still);
        // Dọn dẹp tài nguyên khi unmount trong chế độ reduced-motion: gỡ sự kiện scroll/resize, bỏ class CSS và hủy context WebGL.
        return () => {
          window.removeEventListener("scroll", still);
          window.removeEventListener("resize", still);
          root.classList.remove(SHUTTLE_ON_CLASS);
          L.dispose();
        };
      }

      // Bước 5: Thiết lập tương tác trỏ chuột và vòng lặp hoạt ảnh liên tục qua ticker khi cho phép chuyển động đầy đủ.
      const ptr = { x: 0, y: 0, has: false };
      // Chuẩn hóa tọa độ con trỏ chuột về khoảng [-0.5, 0.5] từ tâm màn hình để nghiêng mô hình 3D theo góc nhìn.
      const onMove = (e: PointerEvent) => {
        ptr.x = e.clientX / window.innerWidth - 0.5;
        ptr.y = e.clientY / window.innerHeight - 0.5;
        ptr.has = true;
      };
      // Theo dõi trạng thái ẩn/hiện của tab để tạm dừng render khi tab chạy ngầm nhằm tiết kiệm pin và CPU.
      const onVis = () => { hidden = document.hidden; };
      window.addEventListener("pointermove", onMove, { passive: true });
      document.addEventListener("visibilitychange", onVis);
      // Vòng lặp cập nhật chuyển động mỗi frame qua gsap.ticker: tính toán độ trễ, nội suy góc quay và vẽ lại frame.
      const tick = (_t: number, dtMs: number) => {
        if (hidden) return;
        // Giới hạn bước thời gian dt tối đa 64ms (~15 FPS) để tránh bước nhảy góc quay đột ngột khi tab bị lag.
        const dt = Math.min(dtMs, 64) / 1000 * 60;
        clock += dtMs / 1000;
        // Nội suy mượt mà (lerp với hệ số ma sát k) cho góc quay theo con trỏ chuột và độ cuộn trang.
        const k = 1 - Math.pow(0.93, dt);
        S.ry += ((ptr.has ? ptr.x * 0.9 : 0) - S.ry) * k;
        S.rx += ((ptr.has ? ptr.y * 0.6 : 0) - S.rx) * k;
        S.p += (pageP() - S.p) * (1 - Math.pow(0.86, dt));
        // Tự động xoay nhẹ vật thể 3D quanh trục đứng theo thời gian.
        S.yaw += 0.009 * dt;
        frame();
      };
      gsap.ticker.add(tick);
      // Hủy đăng ký ticker, gỡ sự kiện chuột/visibility, xóa class CSS và giải phóng bộ nhớ WebGL khi unmount.
      return () => {
        gsap.ticker.remove(tick);
        window.removeEventListener("pointermove", onMove);
        document.removeEventListener("visibilitychange", onVis);
        root.classList.remove(SHUTTLE_ON_CLASS);
        L.dispose();
      };
    },
    [supported],
  );

  // Bước 6: Render thẻ div bọc trong suốt cố định toàn màn hình (pointer-events-none để không chặn click) và thẻ canvas WebGL2.
  return (
    <div ref={wrap} aria-hidden className="pointer-events-none fixed inset-0 z-[5]">
      {supported && <canvas ref={canvas} className="block h-full w-full" />}
    </div>
  );
}
