/**
 * File: src/client/components/landing/pricing.tsx
 * Vai trò: Phân đoạn bảng giá (PricingScene) trên Landing Page của trung tâm thể thao.
 * Vị trí trong app: Hiển thị tại trang chủ (src/routes/index.tsx trong component Home, route "/"),
 * trực quan hóa khung giờ mở cửa, giờ thấp điểm (off-peak) và giờ cao điểm (peak) qua thanh tiến trình động (GSAP) cùng bảng giá chi tiết theo từng môn.
 */
import { useRef } from "react";
import { Cover, HeroVideo } from "@/client/components/media";
import { SpotlightCard } from "@/client/components/fx";
import { money } from "@/client/components/shell";
import type { CatalogPrice } from "@/shared/arena3/contracts";
import { sportLabel } from "@/shared/arena3/labels";
import { gsap, useScene } from "@/client/lib/gsap";
import { t } from "@/client/lib/i18n";
import { useSports } from "@/client/components/sports-ui";
import { rise } from "./tweens";
import { useVenue } from "./util";

/**
 * Peak and off-peak, shown as a day rather than only told.
 *
 * Above the price table sits the opening day (the centre's hours from its settings), drawn from its price
 * sheet: the off-peak stretch fills first, then the peak stretch in the accent colour, and a
 * light runs along it once. "Off-peak until 17:00" becomes something you can see at a glance.
 */
/**
 * Làm gì: Hiển thị phân đoạn bảng giá trên trang chủ, gồm thanh biểu diễn trực quan các khung giờ trong ngày (giờ thường vs giờ cao điểm) và bảng so sánh giá thuê sân theo từng bộ môn.
 * Được gọi ở: src/routes/index.tsx (trong component Home, route "/").
 * Các props quan trọng:
 * - weekday: Danh sách bảng giá ngày trong tuần (CatalogPrice[]) của các môn thể thao để trích xuất quy tắc giờ cao điểm và giá theo từng môn.
 * @returns Thẻ JSX section chứa thanh timeline hoạt họa và bảng giá chi tiết kèm video minh họa.
 */
export function PricingScene({ weekday }: { weekday: CatalogPrice[] }) {
  // Bước 1: Khởi tạo ref DOM gốc, lấy danh mục môn thể thao và thông tin giờ mở/đóng cửa trung tâm từ VenueContext.
  const root = useRef<HTMLElement>(null);
  const { sports } = useSports();
  const { open: OPEN_HOUR, close: CLOSE_HOUR } = useVenue();
  // Tìm quy tắc giờ cao điểm (is_peak) trong bảng giá ngày thường; nếu không có thì mặc định từ 17:00 đến khi đóng cửa.
  const peakRule = weekday.find((p) => p.is_peak);
  const peakFrom = peakRule ? Number(peakRule.start_local.slice(0, 2)) : 17;
  const peakTo = peakRule ? Number(peakRule.end_local.slice(0, 2)) : CLOSE_HOUR;
  // Tính tổng số giờ hoạt động trong ngày, làm cơ sở quy đổi mốc giờ sang tỷ lệ phần trăm (0% - 100%) trên thanh timeline.
  const span = CLOSE_HOUR - OPEN_HOUR;
  /**
   * Làm gì: Quy đổi một mốc giờ cụ thể thành tỷ lệ phần trăm khoảng cách (0% - 100%) trên thanh timeline hoạt động trong ngày.
   * Được gọi ở: Thuộc tính style (left, width) của các phân đoạn thanh giờ (dòng 64, 69) và nhãn mốc giờ (dòng 83).
   * @param h Mốc giờ cần quy đổi (từ OPEN_HOUR đến CLOSE_HOUR).
   * @returns Tỷ lệ phần trăm từ 0 đến 100.
   */
  const pct = (h: number) => ((h - OPEN_HOUR) / span) * 100;

  // Bước 2: Thiết lập hiệu ứng chuyển động GSAP ScrollTrigger cho phân đoạn bảng giá khi cuộn vào khung nhìn.
  useScene(root, ({ motion }) => {
    const el = root.current;
    // Bỏ qua toàn bộ hoạt ảnh nếu phần tử chưa gắn vào DOM hoặc người dùng bật chế độ giảm chuyển động (prefers-reduced-motion).
    if (!motion || !el) return;
    // Kích hoạt hiệu ứng trượt từ dưới lên (rise) cho khối tiêu đề và các hàng của bảng giá (stagger để hiện lần lượt từng hàng).
    rise(el, "[data-rise]");
    rise(el, "[data-row]", { y: 14, stagger: 0.07 });
    // Khởi tạo timeline GSAP cho thanh giờ: kích hoạt khi phần tử [data-day] cuộn tới 85% chiều cao khung nhìn viewport và chỉ chạy 1 lần.
    const q = gsap.utils.selector(el);
    const tl = gsap.timeline({ scrollTrigger: { trigger: q("[data-day]")[0], start: "top 85%", once: true } });
    // Hoạt họa thanh timeline: dải giờ thấp điểm lấp đầy trước, dải giờ cao điểm nối tiếp, sau đó các vạch mốc giờ và nhãn trồi lên.
    tl.fromTo(q("[data-seg-off]"), { scaleX: 0 }, { scaleX: 1, duration: 0.9, ease: "arena" })
      .fromTo(q("[data-seg-peak]"), { scaleX: 0 }, { scaleX: 1, duration: 0.7, ease: "arena" }, "-=0.15")
      .fromTo(q("[data-tick]"), { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.4, stagger: 0.05 }, "-=0.5")
      // Hiệu ứng vệt sáng ([data-sweep]) quét dọc qua thanh thời gian một lần tạo điểm nhấn thị giác rồi mờ dần.
      .fromTo(q("[data-sweep]"), { xPercent: -100, autoAlpha: 1 }, { xPercent: 260, duration: 1.3, ease: "power2.inOut" }, "-=0.2")
      .to(q("[data-sweep]"), { autoAlpha: 0, duration: 0.2 });
  });

  // Bước 3: Render giao diện phân đoạn gồm 2 cột: cột trái là thanh timeline và bảng giá, cột phải là video/ảnh sân.
  return (
    <section ref={root} className="mx-auto max-w-6xl px-4 pb-20">
      <div className="grid gap-8 md:grid-cols-[1.1fr_0.9fr]">
        <div>
          <p data-rise className="kicker text-2xs text-muted">
            {t("Court rental")}
          </p>
          <h2 data-rise className="mt-2 font-display text-4xl">
            {t("Peak / off-peak")}
          </h2>
          <p data-rise className="mt-3 text-muted">
            {t("Mon-Fri before 17:00 is off-peak. Weekends use weekend prices. Each court is paid per booking at that price.")}
          </p>

          {/* The opening day as a bar. */}
          <figure data-day className="mt-6" aria-label={t("Opening hours, off-peak and peak")}>
            <div className="relative h-3 overflow-hidden rounded-full bg-wood">
              <div
                data-seg-off
                className="absolute inset-y-0 left-0 origin-left bg-accent/35"
                style={{ width: `${pct(peakFrom)}%` }}
              />
              <div
                data-seg-peak
                className="absolute inset-y-0 origin-left bg-accent"
                style={{ left: `${pct(peakFrom)}%`, width: `${pct(peakTo) - pct(peakFrom)}%` }}
              />
              <div
                data-sweep
                aria-hidden
                className="pointer-events-none invisible absolute inset-y-0 left-0 w-1/3 bg-linear-to-r from-transparent via-white/70 to-transparent"
              />
            </div>
            <figcaption className="relative mt-2 h-8 text-2xs tabular-nums text-muted">
              {[OPEN_HOUR, peakFrom, peakTo].map((h, i) => (
                <span
                  key={h}
                  data-tick
                  className="absolute -translate-x-1/2 whitespace-nowrap first:translate-x-0 last:-translate-x-full"
                  style={{ left: `${pct(h)}%` }}
                >
                  {String(h).padStart(2, "0")}:00
                  <span className="block text-subtle">{i === 0 ? t("Off-peak") : i === 1 ? t("Peak") : ""}</span>
                </span>
              ))}
            </figcaption>
          </figure>

          <div data-rise>
            <SpotlightCard
              className="mt-4 overflow-hidden rounded-[var(--radius-xl)] bg-surface shadow-[var(--shadow-border)]"
              strength={0.1}
              size={380}
            >
              <table className="relative z-[2] w-full text-sm">
                <thead className="kicker text-left text-2xs text-muted">
                  <tr className="border-b border-line">
                    <th className="px-4 py-3 font-medium">{t("Sport")}</th>
                    <th className="px-4 py-3 font-medium">{t("Off-peak")}</th>
                    <th className="px-4 py-3 font-medium">{t("Peak")}</th>
                  </tr>
                </thead>
                <tbody>
                  {sports.map((s) => {
                    // Bước 4: Duyệt qua từng môn thể thao đang mở để tra cứu giá thuê sân giờ thấp điểm (!is_peak) và giờ cao điểm (is_peak).
                    const sport = s.code;
                    const off = weekday.find((p) => p.sport === sport && !p.is_peak);
                    const peak = weekday.find((p) => p.sport === sport && p.is_peak);
                    return (
                      <tr
                        key={sport}
                        data-row
                        className="border-b border-line transition-colors duration-200 last:border-0 hover:bg-wood/60"
                      >
                        <td className="px-4 py-3.5 font-medium">{sportLabel(sport)}</td>
                        <td className="px-4 py-3.5 tabular-nums">{off ? money(off.price_vnd) : "-"}</td>
                        <td className="px-4 py-3.5 font-medium tabular-nums text-accent-2">
                          {peak ? money(peak.price_vnd) : "-"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </SpotlightCard>
          </div>
        </div>

        <div data-rise>
          <Cover slot="landing.pricing.image" alt="" className="min-h-64 rounded-[var(--radius-xl)] md:min-h-full">
            {/* Half-way down the page: it must not compete with the hero for bandwidth on first load. */}
            <HeroVideo slot="landing.pricing.video" posterSlot="landing.pricing.image" />
          </Cover>
        </div>
      </div>
    </section>
  );
}
