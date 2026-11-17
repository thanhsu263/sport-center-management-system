/**
 * File: src/client/components/moments/hold-countdown.tsx
 * Vai trò: Hiển thị bộ đếm thời gian và vòng tròn SVG đếm ngược khi giữ chỗ (hold) sân hoặc lớp học.
 * Vị trí trong app: Chạy ở client, được nhúng trong src/routes/app.book.tsx (giữ sân) và src/routes/app.classes.tsx (giữ chỗ lớp học) để cảnh báo thời gian hoàn tất thủ tục trước khi chỗ bị hủy.
 */
import { useEffect, useRef, useState } from "react";
import { CustomEase } from "gsap/CustomEase";
import { CustomWiggle } from "gsap/CustomWiggle";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { gsap, motionOff, registerGsap, useGSAP } from "@/client/lib/gsap";
import { useCalm } from "@/client/lib/calm";
import { cn } from "@/client/lib/cn";
import { t } from "@/client/lib/i18n";

// Đăng ký các plugin GSAP cần thiết: CustomEase (gia tốc tùy biến), CustomWiggle (hiệu ứng rung lắc), DrawSVGPlugin (vẽ đường viền SVG)
registerGsap(CustomEase, CustomWiggle, DrawSVGPlugin);

// Cờ ghi nhớ hiệu ứng rung lắc (CustomWiggle 'hold-shake') đã được đăng ký với GSAP hay chưa, tránh tạo trùng lặp
let shakeReady = false;

/**
 * Làm gì: Tính số giây còn lại từ thời điểm hiện tại đến mốc thời gian hết hạn giữ chỗ (until).
 * Được gọi ở: Nội bộ component HoldCountdown (khởi tạo state left, ref total và hàm tick đếm ngược).
 * @param until Chuỗi thời gian ISO chỉ mốc hết hạn giữ chỗ (hold_until).
 * @returns Số giây nguyên còn lại (không âm, tối thiểu là 0).
 */
function secsLeft(until: string) {
  return Math.max(0, Math.floor((new Date(until).getTime() - Date.now()) / 1000));
}

/**
 * A hold, drawn as something running out: a ring that empties as the five minutes go, with the
 * time beside it. The ring follows the real clock (it is re-aimed every quarter second), not a
 * tween left to run on its own, so a phone that slept or a tab left in the background shows the
 * true time the moment it is looked at again. When the last minute starts, the dial shakes once
 * and turns red: that is the point at which a member needs to be told, not informed.
 *
 * GSAP only (CLAUDE.md, rule 3); with motion off the ring simply jumps to each value.
 */
export function HoldCountdown({
  until,
  onExpire,
  className,
  label,
}: {
  until: string;
  onExpire?: () => void;
  className?: string;
  /** What is being held; defaults to the court wording. */
  label?: string;
}) {
  // Bước 1: Khởi tạo các ref và state quản lý đồng hồ đếm ngược và hiệu ứng hoạt ảnh
  const root = useRef<HTMLDivElement>(null);
  const calm = useCalm();
  const [left, setLeft] = useState(() => secsLeft(until));
  // Lưu tổng số giây ban đầu của phiên giữ chỗ (tối thiểu 1s để tránh lỗi chia cho 0 khi tính phần trăm)
  const total = useRef(Math.max(1, secsLeft(until)));
  const fired = useRef(false);
  // Cập nhật callback onExpire mới nhất vào ref để setInterval luôn gọi đúng bản mới nhất mà không gây re-subscribe
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;
  const aim = useRef<(p: number) => void>(() => undefined);

  // Bước 2: Thiết lập vòng lặp đếm ngược thời gian thực (real-time clock) cập nhật mỗi 250ms
  useEffect(() => {
    fired.current = false;
    total.current = Math.max(1, secsLeft(until));
    // Hàm tick kiểm tra đồng hồ thực tế; chu kỳ 250ms (4 lần/giây) giúp đồng bộ ngay khi thiết bị thức dậy (sleep/wake)
    const tick = () => {
      const n = secsLeft(until);
      setLeft(n);
      // Khi hết thời gian giữ chỗ (n <= 0), kích hoạt onExpire duy nhất một lần qua cờ fired
      if (n <= 0 && !fired.current) {
        fired.current = true;
        expireRef.current?.();
      }
    };
    // Chạy tick ngay lần đầu để đồng bộ giao diện tức thì mà không cần đợi 250ms
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [until]);

  // Bước 3: Khởi tạo hiệu ứng vẽ vòng tròn SVG (DrawSVGPlugin) rút ngắn dần theo thời gian thực
  const { contextSafe } = useGSAP(
    () => {
      const ring = root.current?.querySelector("[data-ring]");
      if (!ring) return;
      // One drawing from full to empty, scrubbed to wherever the clock says it should be.
      const drain = gsap.fromTo(ring, { drawSVG: "0% 100%" }, { drawSVG: "0% 0%", ease: "none", duration: 1, paused: true });
      const still = motionOff(calm);
      const proxy = { p: 0 };
      // quickTo giúp làm mượt tiến trình (0.35s) giữa các lần tick 250ms, tránh cảm giác giật khấc
      const glide = gsap.quickTo(proxy, "p", { duration: 0.35, ease: "none", onUpdate: () => void drain.progress(proxy.p) });
      // Nếu người dùng bật chế độ giảm chuyển động (still = true), gán trực tiếp tiến trình thay vì lướt mượt
      aim.current = (p) => {
        if (still) {
          proxy.p = p;
          drain.progress(p);
        } else glide(p);
      };
      aim.current(1 - secsLeft(until) / total.current);
      return () => {
        aim.current = () => undefined;
      };
    },
    { scope: root, dependencies: [calm, until], revertOnUpdate: true },
  );

  // Bước 4: Cập nhật tỷ lệ hoàn thành của vòng tròn SVG mỗi khi số giây còn lại (left) thay đổi
  useEffect(() => {
    aim.current(Math.min(1, 1 - left / total.current));
  }, [left]);

  // Bước 5: Xử lý cảnh báo khẩn cấp khi thời gian còn dưới hoặc bằng 60 giây (1 phút cuối)
  const urgent = left <= 60;
  const wasUrgent = useRef(urgent);
  useEffect(() => {
    // Chỉ kích hoạt hiệu ứng rung lắc đúng khoảnh khắc bắt đầu bước vào phút cuối (crossed = true)
    const crossed = urgent && !wasUrgent.current;
    wasUrgent.current = urgent;
    if (!crossed || motionOff(calm)) return;
    contextSafe(() => {
      // Đăng ký CustomWiggle 7 nhịp và xoay mặt đồng hồ [data-dial] 9 độ trong 0.8s để cảnh báo thị giác
      if (!shakeReady) {
        CustomWiggle.create("hold-shake", { wiggles: 7, type: "easeOut" });
        shakeReady = true;
      }
      gsap.fromTo(root.current?.querySelector("[data-dial]") ?? [], { rotation: 0 }, { rotation: 9, duration: 0.8, ease: "hold-shake" });
    })();
  }, [urgent, calm, contextSafe]);

  // Bước 6: Định dạng số phút (m) và số giây (s) thành chuỗi mm:ss hiển thị trên giao diện
  const m = Math.floor(left / 60);
  const s = String(left % 60).padStart(2, "0");

  // Bước 7: Render giao diện gồm vòng tròn SVG đếm ngược và nhãn trạng thái cảnh báo
  return (
    <div ref={root} className={cn("flex items-center gap-3", className)}>
      <span data-dial aria-hidden className="relative grid size-12 shrink-0 place-items-center">
        <svg viewBox="0 0 48 48" className="absolute inset-0 size-full -rotate-90" fill="none" strokeWidth="4">
          <circle cx="24" cy="24" r="20" className="stroke-wood" />
          <circle
            data-ring
            cx="24"
            cy="24"
            r="20"
            strokeLinecap="round"
            className={cn("transition-[stroke] duration-300", urgent ? "stroke-danger" : "stroke-accent")}
          />
        </svg>
        <span className={cn("size-1.5 rounded-full", urgent ? "bg-danger" : "bg-accent")} />
      </span>
      <div className="min-w-0">
        <span className="kicker block text-2xs text-muted">{urgent ? t("Hold expiring") : (label ?? t("Holding your court"))}</span>
        <span
          className={cn("font-display text-xl tabular-nums", urgent ? "text-danger" : "text-accent-2")}
          role="timer"
          aria-live={urgent ? "polite" : "off"}
        >
          {m}:{s}
        </span>
      </div>
    </div>
  );
}
