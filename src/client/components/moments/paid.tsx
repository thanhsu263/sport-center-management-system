/**
 * File: src/client/components/moments/paid.tsx
 * Vai trò: Cung cấp các component hiệu ứng thị giác (moments) đặc biệt khi thanh toán hoặc tạo đơn đặt sân thành công.
 * Vị trí trong app: Chạy ở client, được nhúng trong src/routes/app.book.tsx (xác nhận đặt sân) và src/routes/pay.return.tsx (kết quả thanh toán trực tuyến qua payOS/VNPay).
 * Gồm:
 * - PaidMark: Biểu tượng dấu tick thành công kèm hiệu ứng pháo hạt văng (confetti burst bằng GSAP physics2D).
 * - ScrambleCode: Hiệu ứng giải mã chữ (scramble text) nhảy ký tự ngẫu nhiên trước khi dừng ở mã đặt chỗ (booking code).
 * Cả hai đều tuân thủ nguyên tắc giảm chuyển động (reduced motion qua hook useCalm).
 */
import { useRef } from "react";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { Physics2DPlugin } from "gsap/Physics2DPlugin";
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin";
import { gsap, motionOff, registerGsap, useGSAP } from "@/client/lib/gsap";
import { useCalm } from "@/client/lib/calm";
import { cn } from "@/client/lib/cn";

// Đăng ký các plugin GSAP: DrawSVGPlugin (vẽ viền SVG), Physics2DPlugin (mô phỏng hạt nổ bay và rơi tự do theo trọng lực), ScrambleTextPlugin (hiệu ứng giải mã ký tự ngẫu nhiên)
registerGsap(DrawSVGPlugin, Physics2DPlugin, ScrambleTextPlugin);

// Số lượng hạt confetti (chấm tròn nhỏ) văng ra xung quanh khi thanh toán được xác nhận thành công
const DOTS = 14;

/**
 * The money landed. A ring and a tick draw themselves, and a handful of cobalt and volt specks
 * burst out of it once and fall away under gravity. Shown only when a payment is confirmed (a
 * plan hour taken, a court paid, an online payment posted), never for a click or a hold: the
 * burst has to keep meaning "paid" (CLAUDE.md, rule 2). With motion off it is just the tick.
 */
/**
 * Làm gì: Hiển thị biểu tượng đánh dấu thanh toán thành công (PaidMark) gồm vòng tròn và dấu tick tự vẽ, kèm hiệu ứng nổ tung các hạt màu sắc (confetti burst) rơi theo trọng lực.
 * Được gọi ở:
 * - src/routes/app.book.tsx: component BookingFlow (khi đặt sân thành công bằng giờ gói hoặc đã thanh toán)
 * - src/routes/pay.return.tsx: component PayReturn (khi thanh toán online qua cổng thanh toán được đối soát thành công)
 * @param className Class CSS tùy biến bổ sung kích thước hoặc khoảng cách (mặc định size-11).
 * @returns Khối JSX span chứa icon SVG dấu tick và các hạt hiệu ứng.
 */
export function PaidMark({ className }: { className?: string }) {
  // Bước 1: Khởi tạo ref trỏ tới phần tử DOM gốc và lấy trạng thái giảm chuyển động từ hook useCalm
  const root = useRef<HTMLSpanElement>(null);
  const calm = useCalm();
  useGSAP(
    () => {
      const el = root.current;
      // Bước 2: Dừng hoạt ảnh nếu chưa mount DOM hoặc người dùng bật chế độ giảm chuyển động (motionOff), chỉ hiển thị dấu tick tĩnh
      if (!el || motionOff(calm)) return;
      // Bước 3: Tạo bộ chọn phần tử con scoped selector và khởi tạo timeline chạy đồng bộ các nhánh chuyển động
      const q = gsap.utils.selector(el);
      const tl = gsap.timeline();
      // Bước 4: Hoạt ảnh phóng to nhẹ cả khối (scale 0.8 -> 1), vẽ vòng tròn bao quanh bằng DrawSVG, sau đó vẽ dấu tick từ giây 0.4
      tl.fromTo(el, { scale: 0.8 }, { scale: 1, duration: 0.55, ease: "arena" }, 0)
        .fromTo(q("[data-ring]"), { drawSVG: "0%" }, { drawSVG: "100%", duration: 0.55, ease: "arena" }, 0)
        .fromTo(q("[data-tick]"), { drawSVG: "0%" }, { drawSVG: "100%", duration: 0.35, ease: "arena" }, 0.4);
      // Bước 5: Kích hoạt hiệu ứng pháo hoa hạt (confetti burst) từ giây 0.5: các hạt văng ngẫu nhiên mọi hướng (0-360 độ) và rơi dần theo gia tốc trọng lực (gravity: 280)
      q("[data-dot]").forEach((dot) => {
        tl.fromTo(
          dot,
          { x: 0, y: 0, autoAlpha: 1, scale: 1 },
          {
            autoAlpha: 0,
            scale: 0.3,
            duration: 1.1,
            ease: "power1.in",
            physics2D: { velocity: gsap.utils.random(80, 180), angle: gsap.utils.random(0, 360), gravity: 280 },
          },
          0.5,
        );
      });
    },
    { scope: root, dependencies: [calm], revertOnUpdate: true },
  );
  // Bước 6: Render khối span chứa icon SVG vòng tròn, dấu tick và 14 hạt màu (xen kẽ màu volt vàng-xanh và màu accent xanh dương)
  return (
    <span ref={root} aria-hidden className={cn("relative inline-grid size-11 shrink-0 place-items-center text-accent", className)}>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-full"
      >
        <circle data-ring cx="12" cy="12" r="9" />
        <path data-tick d="M7.8 12.4l3 3 5.6-6.2" />
      </svg>
      {Array.from({ length: DOTS }, (_, i) => (
        <span
          key={i}
          data-dot
          className={cn(
            "pointer-events-none absolute left-1/2 top-1/2 -ml-[3px] -mt-[3px] size-1.5 rounded-full opacity-0",
            i % 3 === 0 ? "bg-volt" : "bg-accent",
          )}
        />
      ))}
    </span>
  );
}

/**
 * A booking code arriving: it decodes into place, character by character, the moment it is
 * issued. Keyed by the code, so a new code is a new element (GSAP rewrites the text node).
 */
/**
 * Làm gì: Hiển thị mã đặt sân (booking code) với hiệu ứng giải mã ký tự (ScrambleText) chạy lướt qua các ký tự ngẫu nhiên trước khi dừng lại ở mã thật.
 * Được gọi ở: src/routes/app.book.tsx (thẻ tóm tắt thông tin giữ sân và mã booking đã xác nhận).
 * @param code Chuỗi mã đặt chỗ cần hiển thị (ví dụ: "BK-8X2Y").
 * @param className Class CSS tùy biến cho thẻ span (ví dụ màu chữ, cỡ chữ).
 * @returns Khối JSX span chứa mã đặt sân với font chữ mono cố định độ rộng số (tabular-nums).
 */
export function ScrambleCode({ code, className }: { code: string; className?: string }) {
  // Bước 1: Khởi tạo ref gắn với thẻ span và đọc tùy chọn giảm chuyển động từ hook useCalm
  const ref = useRef<HTMLSpanElement>(null);
  const calm = useCalm();
  useGSAP(
    () => {
      const el = ref.current;
      // Bước 2: Dừng hoạt ảnh nếu chưa gắn DOM hoặc người dùng bật giảm chuyển động (motionOff), giữ nguyên mã code tĩnh
      if (!el || motionOff(calm)) return;
      // Bước 3: Chạy hiệu ứng ScrambleText trong 1 giây, xáo trộn qua tập ký tự in hoa và chữ số (A-Z, 0-9) với tốc độ 0.6 trước khi hiển thị đúng mã code
      gsap.to(el, { duration: 1, scrambleText: { text: code, chars: "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789", speed: 0.6 } });
      // Cleanup: Đảm bảo khi component unmount hoặc cập nhật, nội dung text của phần tử luôn được khôi phục về đúng mã code gốc
      return () => {
        el.textContent = code;
      };
    },
    { scope: ref, dependencies: [code, calm], revertOnUpdate: true },
  );
  // Bước 4: Render thẻ span định dạng font mono tabular-nums; gán key={code} để mỗi khi mã code đổi sẽ mount lại phần tử mới kích hoạt lại hoạt ảnh
  return (
    <span key={code} ref={ref} className={cn("font-mono tabular-nums", className)}>
      {code}
    </span>
  );
}
