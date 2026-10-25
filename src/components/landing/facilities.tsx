import { useRef } from "react";
import { Cover, MediaCaption } from "@/components/media";
import { GlareHover } from "@/components/fx";
import { cn } from "@/lib/cn";
import { gsap, useScene } from "@/lib/gsap";
import { useCalm } from "@/lib/calm";
import { t, useLang } from "@/lib/i18n";
import { useSports } from "@/components/sports-ui";
import type { CatalogCourt } from "@/lib/arena3/catalog";
import { rise } from "./tweens";

/**
 * The building, walked through sideways.
 *
 * On a computer with motion on, the section holds and the scroll carries you along the hall:
 * the main hall first, then each area the schedule can sell,
 * each caption arriving as its photo reaches the middle. On a phone, and
 * with motion off, it is a plain grid: the page itself never scrolls sideways (DESIGN.md, Layout).
 */
export function FacilitiesScene({ courts }: { courts?: CatalogCourt[] } = {}) {
  const root = useRef<HTMLElement>(null);
  const still = useCalm();
  const { sports } = useSports();
  const lang = useLang();

  const getCode = (sport: string) => {
    if (!courts) return "";
    const sorted = courts
      .filter((c) => c.sport === sport && c.status !== "retired")
      .map((c) => c.court_code)
      .sort();
    if (sorted.length === 0) return "";
    return sorted.length > 2 ? `${sorted[0]}…${sorted[sorted.length - 1]}` : sorted.join(", ");
  };

  const totalCourts = courts ? courts.filter((c) => c.status !== "retired").length : 16;

  // Named against the court codes and gear the schedule actually uses, so the page and the grid
  // describe the same building.
  const facilities = [
    ...sports.map((s) => ({
      code: getCode(s.code),
      name: lang === "vi" ? `Sân ${s.name_vi}` : `${s.name_en} courts`,
      slot: `sport.${s.code}`,
      note: t("Indoor hall with air conditioning and court lighting."),
    })),
    {
      code: t("Reception"),
      name: t("Front desk"),
      slot: "landing.facilities.reception",
      note: t("Open during all opening hours. You can rent rackets, shuttlecocks and balls and pay for them with the court."),
    },
  ];

  useScene(root, ({ motion, desktop }) => {
    const el = root.current;
    if (!motion || !el) return;
    rise(el, "[data-rise]");
    const track = el.querySelector<HTMLElement>("[data-htrack]");
    if (!desktop || !track) {
      rise(el, "[data-panel]", { stagger: 0.1 });
      return;
    }
    const distance = () => Math.max(0, track.scrollWidth - track.clientWidth);
    const ride = gsap.to(track.firstElementChild, {
      x: () => -distance(),
      ease: "none",
      scrollTrigger: {
        trigger: el,
        start: "top top+=72",
        end: () => `+=${distance()}`,
        pin: true,
        scrub: 0.8,
        invalidateOnRefresh: true,
      },
    });
    // Each caption arrives as its photo reaches the middle of the track.
    gsap.utils.toArray<HTMLElement>("[data-caption]", el).forEach((cap) => {
      gsap.fromTo(cap, { y: 30, autoAlpha: 0 }, {
        y: 0,
        autoAlpha: 1,
        duration: 0.6,
        scrollTrigger: { trigger: cap.closest("[data-panel]"), containerAnimation: ride, start: "left 70%", once: true },
      });
    });
  });

  return (
    <section ref={root} id="facilities" className="mx-auto max-w-6xl scroll-mt-20 px-4 pb-20">
      <p data-rise className="kicker text-2xs text-muted">
        {t("The building")}
      </p>
      <h2 data-rise className="mt-2 max-w-xl font-display text-4xl sm:text-5xl">
        {t("The hall and the front desk")}
      </h2>
      <p data-rise className="mt-3 max-w-lg text-muted">
        {t("Courts, classes and equipment hire are in one building. You pay for them together at reception.")}
      </p>

      {/* On md+ with motion, a viewport onto one long row; otherwise a grid. */}
      {/* The ride runs edge to edge: the viewport spans the window, and the row starts in line with
          the heading, so panels slide out past the window's edge rather than at the column's. */}
      <div
        data-htrack={still ? undefined : ""}
        className={cn("mt-8", !still && "md:mx-[calc(50%-50vw)] md:overflow-hidden")}
      >
        <div
          className={cn(
            "grid gap-4 sm:grid-cols-2",
            still ? "lg:grid-cols-4" : "md:flex md:w-max md:px-[max(1rem,calc((100vw-72rem)/2+1rem))]",
          )}
        >
          <div data-panel className={cn("sm:col-span-2", still ? "lg:col-span-4" : "md:w-[min(46rem,70vw)] md:shrink-0")}>
            <GlareHover className="h-full rounded-[var(--radius-xl)]" duration={1.1}>
              <Cover
                slot="landing.facilities.hall"
                alt={t("The main hall at Lê Long Sport Center")}
                className={cn(
                  "group rounded-[var(--radius-xl)] shadow-[var(--shadow-border)]",
                  still ? "aspect-[16/9] sm:aspect-[16/7]" : "aspect-[16/9] md:aspect-auto md:h-[26rem]",
                )}
                imgClassName="transition-transform duration-[1100ms] ease-[var(--ease-smooth)] group-hover:scale-[1.04]"
              >
                <MediaCaption>
                  <div data-caption>
                    <p className="kicker text-2xs text-on-media-muted">{t("Main hall")}</p>
                    <p className="athletic mt-1.5 text-4xl sm:text-5xl">
                      {totalCourts === 16 ? t("Sixteen playing surfaces") : t("{count} playing surfaces", { count: totalCourts })}
                    </p>
                    <p className="mt-2 max-w-md text-sm text-on-media-muted">
                      {t("Nine-metre ceiling, sprung wooden floor and lighting for evening play.")}
                    </p>
                  </div>
                </MediaCaption>
              </Cover>
            </GlareHover>
          </div>
          {facilities.map((f) => (
            <div key={f.name} data-panel className={cn(!still && "md:w-[19rem] md:shrink-0")}>
              <Cover
                slot={f.slot}
                alt={f.name}
                scrim="media"
                className={cn(
                  "group lift rounded-[var(--radius-xl)] shadow-[var(--shadow-border)]",
                  still ? "aspect-[4/5]" : "aspect-[4/5] md:aspect-auto md:h-[26rem]",
                )}
                imgClassName="transition-transform duration-[900ms] ease-[var(--ease-smooth)] group-hover:scale-[1.07]"
              >
                <MediaCaption>
                  <div data-caption>
                    <p className="kicker text-2xs text-on-media-muted">{f.code}</p>
                    <p className="athletic mt-1.5 text-2xl">{f.name}</p>
                    <p className="mt-2 text-sm text-on-media-muted">{f.note}</p>
                  </div>
                </MediaCaption>
              </Cover>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
