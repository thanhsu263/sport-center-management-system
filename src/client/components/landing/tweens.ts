/**
 * Các hiệu ứng hoạt ảnh (tweens/animations) và hàm đếm số dùng chung cho Landing Page.
 * Cung cấp hàm định dạng tiền tệ khi đếm số (moneyCount), hiệu ứng đếm số tăng dần (countText)
 * và hiệu ứng cuộn xuất hiện so le theo hàng (rise) dựa trên thư viện GSAP và ScrollTrigger.
 */
import { money } from "@/client/components/shell";
import { ScrollTrigger, gsap, registerGsap } from "@/client/lib/gsap";

// Đăng ký plugin ScrollTrigger với GSAP để kích hoạt các hoạt ảnh điều khiển theo vị trí cuộn trang.
registerGsap(ScrollTrigger);

/** A price while it counts: whole thousands of đồng, so the figure never flickers through decimals. */
/**
 * Làm gì: Làm tròn số tiền đến hàng nghìn đồng và định dạng chuỗi VNĐ trong lúc chạy hiệu ứng đếm số, tránh nhấp nháy chữ số lẻ.
 * Được gọi ở: src/client/components/landing/courts.tsx (trong component CountTo định dạng giá thuê sân giờ thường và giờ cao điểm).
 * @param n Giá trị số tiền đang biến thiên trong animation.
 * @returns Chuỗi tiền tệ đã làm tròn và định dạng chuẩn VNĐ (ví dụ: "100.000 ₫").
 */
export const moneyCount = (n: number) => money(Math.round(n / 1000) * 1000);

/** Count `el`'s text from 0 to `to`. Returns the tween so a timeline can place it. */
/**
 * Làm gì: Tạo hiệu ứng hoạt ảnh số nhảy tăng dần từ 0 đến giá trị đích (to) trên phần tử DOM, hỗ trợ định dạng số và hậu tố tùy chỉnh.
 * Được gọi ở: src/client/components/landing/kit.tsx (trong hook useScene của component CountTo).
 * @param el Phần tử HTML hiển thị nội dung văn bản số.
 * @param to Giá trị số đích cần đếm tới.
 * @param opts Tùy chọn gồm format (hàm định dạng, mặc định làm tròn nguyên), suffix (hậu tố) và duration (thời lượng giây, mặc định 1.4s).
 * @returns Đối tượng Tween của GSAP để caller có thể điều khiển hoặc xếp vào timeline.
 */
export function countText(
  el: HTMLElement,
  to: number,
  { format = (n: number) => String(Math.round(n)), suffix = "", duration = 1.4 } = {},
) {
  // Bước 1: Khởi tạo đối tượng proxy chứa giá trị biến thiên bắt đầu từ 0 để GSAP tween.
  const o = { v: 0 };
  // Bước 2: Định nghĩa hàm paint cập nhật textContent của phần tử theo giá trị hiện thời kèm hậu tố.
  const paint = () => {
    el.textContent = `${format(o.v)}${suffix}`;
  };
  // Render ngay giá trị khởi đầu (0) để tránh giao diện bị nhấp nháy trước khi animation bắt đầu.
  paint();
  // Bước 3: Tạo và trả về tween GSAP; dùng ease power3.out để số nhảy nhanh ở đầu và hãm chậm êm ái khi về đích.
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
/**
 * Làm gì: Kích hoạt hiệu ứng cuộn trang xuất hiện dần (fade in) và trượt lên (slide up) cho các phần tử chỉ định; các phần tử cùng hàng sẽ xuất hiện so le từ trái sang phải.
 * Được gọi ở: Các cảnh Landing Page (src/client/components/landing/: closing.tsx, coaches.tsx, courts.tsx, facilities.tsx, gallery.tsx, plans.tsx, pricing.tsx, schedule.tsx, steps.tsx, testimonials.tsx).
 * @param scope Phần tử DOM bao ngoài làm phạm vi tìm kiếm.
 * @param selector Bộ chọn CSS để tìm các phần tử mục tiêu (mặc định "[data-rise]").
 * @param opts Tùy chọn gồm y (khoảng cách dịch chuyển dọc ban đầu theo px, mặc định 34) và stagger (độ trễ so le giữa các phần tử cùng hàng tính theo giây, mặc định 0.09s).
 * @returns Không trả về giá trị (void).
 */
export function rise(scope: Element, selector = "[data-rise]", { y = 34, stagger = 0.09 } = {}) {
  // Bước 1: Thu thập tất cả phần tử mục tiêu bên trong scope và chuyển đổi thành mảng HTMLElement.
  const els = gsap.utils.toArray<HTMLElement>(selector, scope);
  // Bước 2: Khởi tạo map lưu số lượng phần tử trên mỗi hàng để tính toán độ trễ (delay) so le từ trái sang phải.
  const perRow = new Map<number, number>();
  // Bước 3: Duyệt qua từng phần tử để phân nhóm hàng và gán hiệu ứng hoạt ảnh ScrollTrigger tương ứng.
  els.forEach((el) => {
    // Same row within a few pixels: measured before any of them is offset.
    const row = Math.round(el.getBoundingClientRect().top / 12);
    const i = perRow.get(row) ?? 0;
    perRow.set(row, i + 1);
    // Bước 4: Tạo hoạt ảnh fromTo riêng cho từng phần tử kèm trigger độc lập để dọn dẹp (revert) chuẩn xác khi unmount.
    gsap.fromTo(
      el,
      { autoAlpha: 0, y },
      {
        autoAlpha: 1,
        y: 0,
        duration: 0.85,
        // Giới hạn tối đa 6 bước trễ để các phần tử ở cuối hàng không bị chờ quá lâu.
        delay: Math.min(i, 6) * stagger,
        // Kích hoạt khi đỉnh phần tử chạm mốc 90% chiều cao viewport; once: true đảm bảo chỉ chạy một lần duy nhất.
        scrollTrigger: { trigger: el, start: "top 90%", once: true },
      },
    );
  });
}
