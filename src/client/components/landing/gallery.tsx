/**
 * Component GalleryScene hiển thị bộ sưu tập hình ảnh các sân tập và trận đấu trên Landing Page.
 * Tệp này nằm tại src/client/components/landing/gallery.tsx và được gọi trực tiếp trong trang chủ src/routes/index.tsx.
 * Sử dụng thư viện GSAP (ScrollTrigger, useScene, quickTo) tạo hiệu ứng cuộn quán tính uốn cong và đàn hồi khung ảnh.
 */
import { useRef } from "react";
import { Cover } from "@/client/components/media";
import { t } from "@/client/lib/i18n";
import { ScrollTrigger, gsap, useScene } from "@/client/lib/gsap";
import { rise } from "./tweens";

/**
 * Photos of the halls. A hard scroll bends the frames a little in the direction of travel and
 * they spring back when you stop, so the wall of photos feels like it has weight. Without motion
 * the grid simply sits still.
 */
export function GalleryScene() {
  // Bước 1: Khởi tạo ref trỏ đến phần tử DOM gốc <section> để GSAP tính toán phạm vi hiệu ứng và cuộn
  const root = useRef<HTMLElement>(null);
  // Bước 2: Thiết lập kịch bản animation GSAP với hiệu ứng trồi lên (rise) và uốn cong theo vận tốc cuộn
  useScene(root, ({ motion }) => {
    const el = root.current;
    // Bỏ qua hiệu ứng nếu người dùng bật chế độ giảm chuyển động (prefers-reduced-motion) hoặc phần tử DOM chưa sẵn sàng
    if (!motion || !el) return;
    // Kích hoạt tween trồi lên so le (stagger 0.08s) cho các phần tử có thuộc tính [data-rise]
    rise(el, "[data-rise]", { stagger: 0.08 });

    // The bend lives on an inner wrapper, so it never fights the rise or the hover lift.
    const warps = el.querySelectorAll("[data-warp]");
    // Dùng gsap.quickTo để tối ưu hiệu năng biến dạng (skew/stretch) liên tục theo từng khung hình cuộn
    const skew = gsap.quickTo(warps, "skewY", { duration: 0.6, ease: "power3.out" });
    const stretch = gsap.quickTo(warps, "scaleY", { duration: 0.6, ease: "power3.out" });
    let rest = 0;
    // Bước 3: Tạo ScrollTrigger theo dõi vận tốc cuộn của trang để uốn cong và đàn hồi lưới ảnh theo quán tính
    ScrollTrigger.create({
      trigger: el,
      start: "top bottom",
      end: "bottom top",
      onUpdate: (self) => {
        // Chuẩn hóa vận tốc cuộn về dải [-1, 1] (chia 3000 để giảm độ nhạy) tránh biến dạng khung hình quá mức
        const v = gsap.utils.clamp(-1, 1, self.getVelocity() / 3000);
        // Nghiêng góc tối đa 3 độ ngược chiều cuộn và kéo giãn nhẹ tối đa 4% tạo cảm giác có trọng lượng vật lý
        skew(v * -3);
        stretch(1 + Math.abs(v) * 0.04);
        // Đặt hẹn giờ 90ms để đàn hồi khung ảnh về trạng thái phẳng ban đầu ngay khi người dùng dừng cuộn
        clearTimeout(rest);
        rest = window.setTimeout(() => {
          skew(0);
          stretch(1);
        }, 90);
      },
    });
    // Dọn dẹp timer khi component unmount hoặc effect chạy lại để tránh rò rỉ bộ nhớ
    return () => clearTimeout(rest);
  });

  // Bước 4: Khai báo danh sách 8 media slot tương ứng với các ảnh chụp sân bãi thực tế trên landing page
  const slots = [
    "landing.gallery.1",
    "landing.gallery.2",
    "landing.gallery.3",
    "landing.gallery.4",
    "landing.gallery.5",
    "landing.gallery.6",
    "landing.gallery.7",
    "landing.gallery.8",
  ];

  // Bước 5: Render cấu trúc giao diện lưới ảnh 2 cột (mobile) và 4 cột (desktop) kèm hiệu ứng hover nâng nhẹ
  return (
    <section ref={root} className="mx-4 my-20 md:mx-auto md:max-w-6xl">
      <div data-rise className="mb-8 text-center">
        <p className="font-mono text-2xs uppercase tracking-widest text-accent-text">
          {t("Photos")}
        </p>
        <h2 className="athletic mt-2 text-4xl text-fg sm:text-5xl">
          {t("Courts and matches")}
        </h2>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        {slots.map((slot) => (
          <div
            key={slot}
            data-rise
            className="group relative overflow-hidden rounded-[var(--radius-lg)] border border-line bg-wood shadow-[var(--shadow-soft)] transition-transform duration-300 hover:-translate-y-1"
          >
            <div data-warp className="origin-center will-change-transform">
              <Cover
                slot={slot}
                className="aspect-[4/3] w-full"
                imgClassName="transition-transform duration-500 group-hover:scale-105"
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
