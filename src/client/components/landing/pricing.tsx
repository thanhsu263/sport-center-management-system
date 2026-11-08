import { useRef } from "react";
import { Cover, HeroVideo } from "@/components/media";
import { SpotlightCard } from "@/components/fx";
import { money } from "@/components/shell";
import type { CatalogPrice } from "@/lib/arena3/catalog";
import { sportLabel } from "@/lib/arena3/labels";
import { gsap, useScene } from "@/lib/gsap";
import { t } from "@/lib/i18n";
import { useSports } from "@/components/sports-ui";
import { rise } from "./tweens";
import { useVenue } from "./util";

/**
 * Peak and off-peak, shown as a day rather than only told.
 *
 * Above the price table sits the opening day (the centre's hours from its settings), drawn from its price
 * sheet: the off-peak stretch fills first, then the peak stretch in the accent colour, and a
 * light runs along it once. "Off-peak until 17:00" becomes something you can see at a glance.
 */
export function PricingScene({ weekday }: { weekday: CatalogPrice[] }) {
  const root = useRef<HTMLElement>(null);
  const { sports } = useSports();
  const { open: OPEN_HOUR, close: CLOSE_HOUR } = useVenue();
  const peakRule = weekday.find((p) => p.is_peak);
  const peakFrom = peakRule ? Number(peakRule.start_local.slice(0, 2)) : 17;
  const peakTo = peakRule ? Number(peakRule.end_local.slice(0, 2)) : CLOSE_HOUR;
  const span = CLOSE_HOUR - OPEN_HOUR;
  const pct = (h: number) => ((h - OPEN_HOUR) / span) * 100;

  useScene(root, ({ motion }) => {
    const el = root.current;
    if (!motion || !el) return;
    rise(el, "[data-rise]");
    rise(el, "[data-row]", { y: 14, stagger: 0.07 });
    const q = gsap.utils.selector(el);
    const tl = gsap.timeline({ scrollTrigger: { trigger: q("[data-day]")[0], start: "top 85%", once: true } });
    tl.fromTo(q("[data-seg-off]"), { scaleX: 0 }, { scaleX: 1, duration: 0.9, ease: "arena" })
      .fromTo(q("[data-seg-peak]"), { scaleX: 0 }, { scaleX: 1, duration: 0.7, ease: "arena" }, "-=0.15")
      .fromTo(q("[data-tick]"), { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.4, stagger: 0.05 }, "-=0.5")
      .fromTo(q("[data-sweep]"), { xPercent: -100, autoAlpha: 1 }, { xPercent: 260, duration: 1.3, ease: "power2.inOut" }, "-=0.2")
      .to(q("[data-sweep]"), { autoAlpha: 0, duration: 0.2 });
  });

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
            {t("Mon-Fri before 17:00 is off-peak. Weekends use weekend prices. Members can use plan hours or get their plan discount.")}
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
