/**
 * File: src/client/components/landing/kit.tsx
 * Vai trò: Chứa các UI component nhỏ dùng chung cho các phân đoạn (scenes) trên landing page.
 * Vị trí trong app: Cung cấp SplitHeading (tiêu đề trồi chữ theo dòng) và CountTo (số đếm tăng dần) cho các section landing page (hero, coaches, courts, plans, schedule, steps, testimonials).
 */
import { useRef, type ElementType } from "react";
import { SplitText } from "gsap/SplitText";
import { ScrollTrigger, gsap, registerGsap, useScene } from "@/client/lib/gsap";
import { cn } from "@/client/lib/cn";
import { countText } from "./tweens";

// Đăng ký các plugin GSAP cần thiết (ScrollTrigger để kích hoạt theo vị trí cuộn, SplitText để tách dòng/từ).
registerGsap(ScrollTrigger, SplitText);

/*
 * Small pieces every landing scene shares.
 *
 * Anything GSAP rewrites (a split heading, a counting number, scrambled text) is rendered with
 * `key={text}`. GSAP replaces the text node React put there; if React later tried to patch that
 * node it would be patching a node no longer in the page. Keyed, a new text means a new element.
 */

/**
 * A heading whose words rise out of a line mask as it scrolls into view.
 * Split by words and lines, never characters: Vietnamese tone marks must stay with their letter.
 */
/**
 * Làm gì: Hiển thị tiêu đề văn bản với hiệu ứng các từ trồi lên từ mask của dòng khi cuộn tới vị trí hiển thị.
 * Được gọi ở: Các component phân cảnh trên landing page:
 * - src/client/components/landing/coaches.tsx: CoachesScene
 * - src/client/components/landing/courts.tsx: CourtsScene
 * - src/client/components/landing/plans.tsx: PlansScene
 * - src/client/components/landing/schedule.tsx: ScheduleScene
 * - src/client/components/landing/steps.tsx: StepsScene
 * - src/client/components/landing/testimonials.tsx: TestimonialsScene
 * @param text Chuỗi văn bản tiêu đề cần hiển thị.
 * @param as Thẻ HTML làm phần tử bao bọc (mặc định là "span").
 * @param className Lớp CSS tùy biến bổ sung.
 * @param delay Thời gian trễ trước khi bắt đầu hiệu ứng (giây, mặc định 0).
 * @param stagger Khoảng thời gian trễ giữa các từ xuất hiện liên tiếp (giây, mặc định 0.06s).
 * @returns Phần tử JSX chứa tiêu đề kèm hiệu ứng cuộn GSAP SplitText.
 */
export function SplitHeading({
  text,
  as: Tag = "span",
  className,
  delay = 0,
  stagger = 0.06,
}: {
  text: string;
  as?: ElementType;
  className?: string;
  delay?: number;
  stagger?: number;
}) {
  // Bước 1: Khởi tạo ref gắn vào phần tử DOM tiêu đề cần tạo hiệu ứng.
  const ref = useRef<HTMLElement>(null);
  // Bước 2: Thiết lập hiệu ứng cuộn GSAP qua useScene (tự dọn dẹp khi unmount hoặc khi bật giảm chuyển động).
  useScene(
    ref,
    ({ motion }) => {
      const el = ref.current;
      // Bỏ qua hiệu ứng nếu người dùng bật chế độ giảm chuyển động (!motion) hoặc DOM chưa sẵn sàng.
      if (!motion || !el) return;
      // Tách chữ theo "words,lines" và mask theo dòng; không tách ký tự ("chars") để tránh làm vỡ dấu thanh tiếng Việt.
      SplitText.create(el, {
        type: "words,lines",
        mask: "lines",
        autoSplit: true,
        onSplit: (self) =>
          gsap.fromTo(self.words, { yPercent: 115 }, {
            yPercent: 0,
            duration: 0.85,
            stagger,
            delay,
            ease: "arena-out",
            scrollTrigger: { trigger: el, start: "top 90%", once: true },
          }),
      });
    },
    [text],
  );
  // Bước 3: Render thẻ wrapper với key={text} để React tạo mới element khi đổi text, tránh lỗi patch vào node GSAP đã thay đổi.
  return (
    <Tag key={text} ref={ref} className={cn("block", className)}>
      {text}
    </Tag>
  );
}

/** A number that counts up from zero the first time it scrolls into view. */
/**
 * Làm gì: Hiển thị con số tự động đếm tăng dần từ 0 lên giá trị đích khi phần tử cuộn vào màn hình lần đầu tiên.
 * Được gọi ở:
 * - src/client/components/landing/hero.tsx: hiển thị số liệu thống kê trong HeroScene
 * - src/client/components/landing/courts.tsx: hiển thị giá thuê sân theo khung giờ trong CourtsScene
 * @param value Giá trị số đích cần đếm tới.
 * @param format Hàm định dạng số hiển thị thành chuỗi (mặc định làm tròn thành số nguyên).
 * @param suffix Hậu tố đi kèm phía sau số (ví dụ: "+", "%", "đ").
 * @param className Lớp CSS tùy biến bổ sung.
 * @param duration Thời gian diễn ra hiệu ứng đếm (giây, mặc định 1.4s).
 * @returns Phần tử JSX span chứa chuỗi số đếm tăng dần khi cuộn.
 */
export function CountTo({
  value,
  format = (n: number) => String(Math.round(n)),
  suffix = "",
  className,
  duration = 1.4,
}: {
  value: number;
  format?: (n: number) => string;
  suffix?: string;
  className?: string;
  duration?: number;
}) {
  // Bước 1: Khởi tạo ref gắn vào thẻ span hiển thị số đếm.
  const ref = useRef<HTMLSpanElement>(null);
  // Bước 2: Khởi tạo scene GSAP xử lý animation đếm số khi cuộn vào tầm nhìn.
  useScene(
    ref,
    ({ motion }) => {
      const el = ref.current;
      // Bỏ qua animation nếu người dùng bật giảm chuyển động (!motion) hoặc DOM chưa sẵn sàng.
      if (!motion || !el) return;
      // Khởi tạo tween đếm số từ 0 đến value, tạm dừng ngay để chờ ScrollTrigger kích hoạt.
      const tween = countText(el, value, { format, suffix, duration });
      tween.pause();
      // Kích hoạt chạy tween khi đỉnh phần tử cuộn tới 92% viewport; once: true đảm bảo chỉ chạy 1 lần duy nhất.
      ScrollTrigger.create({ trigger: el, start: "top 92%", once: true, onEnter: () => void tween.play() });
      // Dọn dẹp khi unmount hoặc đổi giá trị: gán thẳng giá trị đích để tránh bị kẹt số dở dang.
      return () => {
        el.textContent = `${format(value)}${suffix}`;
      };
    },
    [value, suffix],
  );
  // Bước 3: Render thẻ span với font tabular-nums (độ rộng số cố định tránh giật layout) và key để ép React tạo mới DOM node.
  return (
    <span key={`${value}${suffix}`} ref={ref} className={cn("tabular-nums", className)}>
      {`${format(value)}${suffix}`}
    </span>
  );
}
