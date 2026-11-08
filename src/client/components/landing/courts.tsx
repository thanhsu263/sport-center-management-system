import { useRef } from "react";
import { Cover, MediaCaption } from "@/components/media";
import { Button, Card } from "@/components/ui";
import { GlareHover } from "@/components/fx";
import type { CatalogCourt, CatalogPrice } from "@/lib/arena3/catalog";
import { sportLabel } from "@/lib/arena3/labels";
import { useScene } from "@/lib/gsap";
import { t } from "@/lib/i18n";
import { useSports } from "@/components/sports-ui";
import { CountTo, SplitHeading } from "./kit";
import { moneyCount, rise } from "./tweens";

/**
 * What the hall contains, every number in the open: courts per sport, off-peak and peak price,
 * and how many hours are still free on the day being shown. The prices count up from nothing as
 * the cards arrive, which is the one figure people compare across the sports.
 */
export function CourtsScene({
  weekday,
  freeBySport,
  day,
  onShowTimes,
  courts,
}: {
  weekday: CatalogPrice[];
  freeBySport: (sport: string) => number;
  day: string;
  onShowTimes: (sport: string) => void;
  courts?: CatalogCourt[];
}) {
  const root = useRef<HTMLElement>(null);
  const { sports: liveSports } = useSports();
  useScene(root, ({ motion }) => {
    if (motion && root.current) rise(root.current);
  });

  const sports = liveSports.map((s) => ({
    id: s.code,
    colorKey: s.color_key,
    slot: `sport.${s.code}`,
    note: t("Indoor hall with air conditioning and court lighting."),
  }));

  return (
    <section ref={root} id="courts" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20">
      <p data-rise className="kicker text-2xs text-muted">
        {t("Our sports")}
      </p>
      <h2 className="mt-2 font-display text-4xl sm:text-5xl">
        <SplitHeading text={t("Courts & pricing")} />
      </h2>
      <p data-rise className="mt-3 max-w-md text-muted">
        {t("Courts by sport, with hourly prices.")}
      </p>

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {sports.map((s) => {
          const off = weekday.find((p) => p.sport === s.id && !p.is_peak);
          const peak = weekday.find((p) => p.sport === s.id && p.is_peak);
          const openNow = freeBySport(s.id);
          const sportCourts = courts
            ? courts.filter((c) => c.sport === s.id && c.status !== "retired")
            : [];
          const count = sportCourts.length;
          const sortedCodes = sportCourts.map((c) => c.court_code).sort();
          const codes = sortedCodes.length > 2
            ? `${sortedCodes[0]}…${sortedCodes[sortedCodes.length - 1]}`
            : sortedCodes.join(", ");
          return (
            <div key={s.id} data-rise className="h-full">
              <Card
                className="lift flex h-full flex-col overflow-hidden p-0"
                style={{ borderTop: `3px solid var(--color-sport-${s.colorKey || s.id})` }}
              >
                <GlareHover>
                  <Cover
                    slot={s.slot}
                    alt={sportLabel(s.id)}
                    scrim="none"
                    className="group aspect-[4/3]"
                    imgClassName="transition-transform duration-[900ms] ease-[var(--ease-smooth)] group-hover:scale-[1.07]"
                  >
                    <MediaCaption>
                      <span
                        className="mb-1.5 inline-flex items-center rounded-[var(--radius-pill)] px-2.5 py-0.5 text-2xs font-bold text-white shadow-sm"
                        style={{ backgroundColor: `var(--color-sport-${s.colorKey || s.id})` }}
                      >
                        {sportLabel(s.id)}
                      </span>
                      <p className="athletic text-3xl sm:text-4xl">{sportLabel(s.id)}</p>
                      <p className="mt-1 text-sm text-on-media-muted">
                        {count === 1
                          ? t("1 court · {codes}", { codes })
                          : t("{n} courts · {codes}", { n: count, codes })}
                      </p>
                    </MediaCaption>
                  </Cover>
                </GlareHover>
                <div className="flex flex-1 flex-col p-5">
                  <dl className="grid grid-cols-2 gap-3 border-b border-line pb-4">
                    <div>
                      <dt className="kicker text-2xs text-muted">{t("Off-peak")}</dt>
                      <dd className="font-display text-2xl tabular-nums">
                        {off ? <CountTo value={off.price_vnd} format={moneyCount} duration={1.1} /> : "-"}
                      </dd>
                    </div>
                    <div>
                      <dt className="kicker text-2xs text-muted">{t("Peak")}</dt>
                      <dd className="font-display text-2xl tabular-nums text-accent-2">
                        {peak ? <CountTo value={peak.price_vnd} format={moneyCount} duration={1.1} /> : "-"}
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-4 flex-1 text-sm text-muted">{s.note}</p>
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <p className="text-xs tabular-nums text-muted">
                      {openNow ? t("{n} hours free", { n: openNow }) : t("Fully booked")}
                      <span className="text-subtle"> · {day}</span>
                    </p>
                    <Button size="sm" onClick={() => onShowTimes(s.id)}>
                      {t("See free times")}
                    </Button>
                  </div>
                </div>
              </Card>
            </div>
          );
        })}
      </div>
    </section>
  );
}
