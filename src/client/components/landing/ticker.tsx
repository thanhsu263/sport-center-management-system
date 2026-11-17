/**
 * Tệp này định nghĩa component ClassTicker hiển thị dải băng các lớp học trong tuần trên Landing Page.
 * Vai trò trong ứng dụng:
 * - Nằm trên trang chủ (src/routes/index.tsx, route "/"), hiển thị ngay dưới khu vực lịch đặt sân.
 * - Sử dụng GSAP ticker và ScrollTrigger để tạo hiệu ứng marquee cuộn ngang tự động, mượt mà và phản hồi theo tốc độ cuộn chuột.
 * - Hỗ trợ chế độ giảm chuyển động (useCalm / prefers-reduced-motion) để tự động chuyển sang bố cục dạng lưới tĩnh.
 */
import { useRef } from "react";
import type { CatalogClass } from "@/shared/arena3/contracts";
import { levelLabel, rruleLabel, sportLabel } from "@/shared/arena3/labels";
import { ScrollTrigger, gsap, useScene } from "@/client/lib/gsap";
import { useCalm } from "@/client/lib/calm";
import { t } from "@/client/lib/i18n";

/**
 * This week's classes, running past as a strip.
 *
 * It drifts on its own and the scroll wheel drives it: flick down and it speeds forward, scroll
 * back up and it runs the other way, then eases back to its own pace. It stops under the pointer
 * so a class can be read, and stops while off-screen. Under reduced motion it does not move at
 * all, and wraps onto as many rows as it needs so nothing is clipped.
 */
/**
 * Làm gì: Hiển thị dải băng chạy ngang (ticker/marquee) danh sách các lớp học trong tuần với hiệu ứng trôi mượt mà.
 * Được gọi ở: src/routes/index.tsx (component Home, route "/").
 * @param classes Danh sách các lớp học thể thao trong tuần (CatalogClass[]) lấy từ catalog public.
 * @returns Thẻ <section> chứa dải băng marquee các lớp học hoặc danh sách tĩnh khi bật chế độ giảm chuyển động.
 */
export function ClassTicker({ classes }: { classes: CatalogClass[] }) {
  // Bước 1: Khởi tạo ref trỏ đến phần tử DOM gốc và kiểm tra tùy chọn giảm chuyển động (prefers-reduced-motion)
  const root = useRef<HTMLElement>(null);
  // `useCalm` already includes the device setting, and agrees with the server render during hydration.
  const still = useCalm();

  // Bước 2: Thiết lập hiệu ứng chuyển động dải băng bằng GSAP và ScrollTrigger khi thiết bị cho phép chuyển động
  useScene(root, ({ motion }) => {
    const el = root.current;
    const track = el?.querySelector<HTMLElement>("[data-track]");
    const copy = track?.firstElementChild as HTMLElement | null;
    // Dừng khởi tạo nếu người dùng tắt hiệu ứng chuyển động hoặc thiếu các phần tử DOM cần thiết
    if (!motion || !el || !track || !copy) return;

    const base = 38; // px per second when the page is still
    let x = 0;
    let dir = 1;
    let boost = 0;
    let hover = false;
    let visible = false;
    // Dùng quickSetter để cập nhật trực tiếp thuộc tính x theo từng frame, tối ưu hiệu năng hơn gsap.set
    const setX = gsap.quickSetter(track, "x", "px");

    // Hàm tick được gọi ở mỗi khung hình (frame) bởi GSAP để cập nhật vị trí dải băng
    const tick = (_time: number, dt: number) => {
      if (!visible || hover) return;
      const w = copy.offsetWidth;
      if (!w) return;
      x -= dir * base * (1 + boost) * (dt / 1000);
      // Cuộn vòng tọa độ x trong khoảng [-w, 0] để tạo vòng lặp vô tận mượt mà mà không để lộ vết nối
      x = gsap.utils.wrap(-w, 0, x);
      setX(x);
      // Giảm dần gia tốc phụ sau mỗi khung hình (decay 6%) để dải băng từ từ trở về vận tốc ban đầu
      boost *= 0.94;
    };
    // Đăng ký hàm tick vào vòng lặp ticker của GSAP để chạy liên tục theo tốc độ làm tươi màn hình
    gsap.ticker.add(tick);

    // Tạo ScrollTrigger để theo dõi vị trí cuộn trang, tạm dừng khi ra ngoài màn hình và tăng tốc khi cuộn nhanh
    ScrollTrigger.create({
      trigger: el,
      start: "top bottom",
      end: "bottom top",
      onToggle: (self) => {
        visible = self.isActive;
      },
      onUpdate: (self) => {
        const v = self.getVelocity();
        // Bỏ qua ngưỡng vận tốc nhỏ (< 30) để tránh dải băng bị giật hoặc đảo chiều khi người dùng cuộn rất chậm
        if (Math.abs(v) < 30) return;
        dir = v < 0 ? -1 : 1;
        // A hard flick at most triples the pace, then it settles back.
        boost = Math.min(2, Math.abs(v) / 700);
      },
    });

    // Lắng nghe sự kiện con trỏ để tạm dừng dải băng khi người dùng hover đọc thông tin lớp học
    const enter = () => {
      hover = true;
    };
    const leave = () => {
      hover = false;
    };
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    // Dọn dẹp: hủy đăng ký hàm tick khỏi GSAP ticker và gỡ bỏ event listeners khi component unmount
    return () => {
      gsap.ticker.remove(tick);
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
    };
  });

  // Bước 3: Tạo danh sách các thẻ thông tin lớp học (môn thể thao, cấp độ, thời gian lặp, sân tập, HLV)
  const items = classes.map((c) => (
    <span key={c.id} className="mr-10 inline-flex items-center gap-3 whitespace-nowrap text-sm">
      <span className="athletic text-xl sm:text-2xl">{sportLabel(c.sport)}</span>
      <span className="kicker text-2xs text-muted">{levelLabel(c.level)}</span>
      <span className="tabular-nums text-accent-2">{rruleLabel(c.rrule, c.duration_min)}</span>
      <span className="text-subtle">{c.court_code}</span>
      <span className="text-muted">{c.coach_name}</span>
      <span aria-hidden className="size-1.5 rounded-full bg-accent/45" />
    </span>
  ));

  // Bước 4: Render giao diện dải băng marquee (nhân đôi nội dung để nối vòng lặp) hoặc hiển thị danh sách tĩnh khi giảm chuyển động
  return (
    <section
      ref={root}
      aria-label={t("Classes running this week")}
      className="relative z-0 overflow-hidden border-y border-line bg-surface/80 py-5"
    >
      {still ? (
        <div className="mx-auto max-w-6xl px-4">
          <div className="flex flex-wrap items-center gap-y-3">{items}</div>
        </div>
      ) : (
        <div className="marquee">
          {/* Two copies, wrapped at one copy's width, so the seam is always off-screen. */}
          <div data-track className="flex w-max will-change-transform">
            <div className="flex shrink-0 items-center">{items}</div>
            <div className="flex shrink-0 items-center" aria-hidden>
              {items}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
