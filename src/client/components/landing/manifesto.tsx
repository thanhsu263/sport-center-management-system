/**
 * File: src/client/components/landing/manifesto.tsx
 * Vai trò: Phân đoạn tuyên ngôn (Manifesto) giới thiệu giá trị cốt lõi và phương châm hoạt động của trung tâm Lê Long Sport.
 * Vị trí trong app: Được nhúng trên trang chủ (src/routes/index.tsx, route "/"), hiển thị giữa ClassTicker và StepsScene,
 * kết hợp GSAP ScrollTrigger và SplitText để tạo hiệu ứng chữ từ mờ chuyển sang rõ dần theo tiến độ cuộn trang của người dùng.
 */
import { useRef } from "react";
import { SplitText } from "gsap/SplitText";
import { ScrollTrigger, gsap, registerGsap, useScene } from "@/client/lib/gsap";
import { t } from "@/client/lib/i18n";

// Đăng ký các plugin ScrollTrigger và SplitText với GSAP một lần duy nhất ở cấp module trước khi render component.
registerGsap(ScrollTrigger, SplitText);

/**
 * The one paragraph on the page worth slowing down for, set on a blue court seen from the
 * baseline. Its words resolve out of a blur at whatever pace the reader scrolls (scrubbed, not
 * triggered), and finish well before the text leaves so the last words stay readable for a while.
 */
/**
 * Làm gì: Hiển thị phân đoạn tuyên ngôn (manifesto) giới thiệu quy trình học và luyện tập tại trung tâm, tạo điểm nhấn thị giác bằng hiệu ứng làm rõ từng từ theo thanh cuộn chuột.
 * Được gọi ở: src/routes/index.tsx (trong component LandingPage tại route "/").
 * @returns Khối section JSX chứa văn bản tuyên ngôn với hiệu ứng chữ rõ dần khi cuộn trang.
 */
export function Manifesto() {
  // Bước 1: Khởi tạo ref tham chiếu phần tử DOM gốc và lấy văn bản tuyên ngôn theo ngôn ngữ hiện tại (hàm t).
  const root = useRef<HTMLElement>(null);
  const text = t(
    "Every class here has a coach, a level and a fixed timetable. Pick the one that fits, enrol in the app, and each session lands in your schedule. The courts are yours to practise on in between.",
  );
  // Bước 2: Thiết lập hiệu ứng chuyển động GSAP (ScrollTrigger + SplitText) tự động dọn dẹp khi component unmount.
  useScene(
    root,
    ({ motion }) => {
      const p = root.current?.querySelector("p");
      // Bỏ qua hiệu ứng nếu người dùng bật chế độ giảm chuyển động (prefers-reduced-motion) hoặc chưa tìm thấy thẻ <p>.
      if (!motion || !p) return;
      // Tách đoạn văn thành các từ riêng biệt (SplitText) để áp dụng hiệu ứng hoạt họa độc lập cho từng từ.
      SplitText.create(p, {
        type: "words",
        autoSplit: true,
        onSplit: (self) =>
          // Tạo hiệu ứng chuyển từ mờ (blur 3px, opacity 0.5) sang rõ nét hoàn toàn theo tiến trình cuộn trang; stagger 0.12s và scrub 0.6s giúp chữ hiển thị mượt mà và người dùng kịp đọc trước khi đoạn văn rời màn hình.
          gsap.fromTo(
            self.words,
            // Unread words stay at half strength: 3:1 against the page at this size, never invisible.
            { opacity: 0.5, filter: "blur(3px)", y: 6 },
            {
              opacity: 1,
              filter: "blur(0px)",
              y: 0,
              ease: "none",
              stagger: 0.12,
              scrollTrigger: { trigger: p, start: "top 82%", end: "bottom 62%", scrub: 0.6 },
            },
          ),
      });
    },
    [text],
  );
  // Bước 3: Render phân đoạn giao diện gồm nền dải màu xanh sân bóng (gradient), lớp phối cảnh sân (court-perspective) và đoạn văn bản tuyên ngôn.
  return (
    <section
      ref={root}
      aria-label={t("What Lê Long Sport is for")}
      className="relative overflow-hidden bg-gradient-to-b from-[#1d58c4] to-court text-white"
    >
      <div aria-hidden className="court-perspective opacity-70" />
      <div className="relative mx-auto max-w-4xl px-4 py-24 sm:py-32">
        <p key={text} className="font-display text-3xl leading-snug sm:text-[2.6rem] sm:leading-[1.2]">
          {text}
        </p>
      </div>
    </section>
  );
}
