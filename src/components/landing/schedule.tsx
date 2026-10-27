import { useRef } from "react";
import { CourtGrid, DateStrip, type Court as GridCourt } from "@/components/court-grid";
import { Button, ButtonLink, Card, Seg, Skeleton } from "@/components/ui";
import { money } from "@/components/shell";
import type { CatalogCourt, CatalogPrice, CatalogSlot } from "@/lib/arena3/catalog";
import { sportLabel } from "@/lib/arena3/labels";
import { gsap, useScene } from "@/lib/gsap";
import { t } from "@/lib/i18n";
import { useSports } from "@/components/sports-ui";
import { SplitHeading } from "./kit";
import { rise } from "./tweens";
import { priceFor, wdLabel } from "./util";
import { useVenue } from "./util";
import { hoursOf } from "@/lib/venue";

export type Picked = { court: GridCourt; hour: number };

/**
 * The live grid, on the public page. The heading and controls arrive like every other section;
 * the grid itself never animates: its colours are the message (DESIGN.md, "The Light Finds the
 * Court Rule"), and nothing is allowed over its cells.
 */
export function ScheduleScene({
  sched,
  date,
  onDate,
  sport,
  onSport,
  busy,
  picked,
  onPick,
  prices,
}: {
  sched: { date: string; courts: CatalogCourt[]; slots: CatalogSlot[] };
  date: string;
  onDate: (d: string) => void;
  sport: string;
  onSport: (s: string) => void;
  busy: boolean;
  picked: Picked | null;
  onPick: (p: Picked | null) => void;
  prices: CatalogPrice[];
}) {
  const venue = useVenue();
  const root = useRef<HTMLElement>(null);
  const { sports } = useSports();
  useScene(root, ({ motion }) => {
    if (motion && root.current) rise(root.current, "[data-rise]", { stagger: 0.07 });
  });

  return (
    <section ref={root} id="schedule" className="mx-auto max-w-6xl scroll-mt-20 px-4 pb-20">
      <p data-rise className="kicker text-2xs text-muted">
        {t("Live availability")}
      </p>
      <h2 className="mt-2 font-display text-4xl sm:text-5xl">
        <SplitHeading text={t("When is a court free?")} />
      </h2>
      <p data-rise className="mt-3 max-w-lg text-muted">
        {t("Free and booked hours for every court. Tap a free hour to hold it for {n} minutes while you sign in. You do not pay to hold it.", {
          n: venue.holdMinutes,
        })}
      </p>

      <div className="mt-7 grid gap-3">
        <div data-rise>
          <DateStrip value={date} onChange={onDate} />
        </div>
        <div data-rise>
          <Seg
            value={sport}
            onChange={(v) => {
              onSport(v);
              onPick(null);
            }}
            options={[
              { value: "", label: t("All") },
              ...sports
                .filter((s) => sched.courts.some((c) => c.sport === s.code))
                .map((s) => ({ value: s.code, label: sportLabel(s.code) })),
            ]}
          />
        </div>
      </div>

      {picked ? (
        <PickedCard
          key={`${picked.court.id}-${picked.hour}-${date}`}
          picked={picked}
          date={date}
          prices={prices}
          onClear={() => onPick(null)}
        />
      ) : null}

      <div className="mt-4">
        {busy ? (
          <div className="grid gap-2">
            <Skeleton className="h-8" />
            <Skeleton className="h-72" />
          </div>
        ) : (
          <CourtGrid
            startedIsPast
            hours={hoursOf(venue)}
            date={sched.date}
            courts={sched.courts}
            slots={sched.slots}
            sport={sport || undefined}
            onPick={(court, hour) => onPick({ court, hour })}
            onPickSport={(s) => {
              onSport(s);
              onPick(null);
            }}
            onPickDate={onDate}
            legendCompact
            selected={picked ? { courtId: picked.court.id, hour: picked.hour } : null}
          />
        )}
      </div>
    </section>
  );
}

/**
 * What a tap on a free hour gets you, before you are asked for anything: the slot named, priced
 * and dated, so signing in is a step towards something specific rather than a toll gate. It opens
 * out of nothing each time a different hour is picked.
 */
function PickedCard({
  picked,
  date,
  prices,
  onClear,
}: {
  picked: Picked;
  date: string;
  prices: CatalogPrice[];
  onClear: () => void;
}) {
  const venue = useVenue();
  const root = useRef<HTMLDivElement>(null);
  useScene(root, ({ motion }) => {
    const el = root.current;
    if (!motion || !el) return;
    gsap.fromTo(el, { height: 0, autoAlpha: 0 }, { height: "auto", autoAlpha: 1, duration: 0.45 });
    gsap.fromTo(el.querySelectorAll("[data-pick-part]"), { y: 10, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.5, stagger: 0.06, delay: 0.12 });
  });
  const p = priceFor(prices, picked.court.sport, date, picked.hour);
  return (
    <div ref={root} className="overflow-hidden">
      <Card className="mt-4 flex flex-wrap items-center gap-4 border border-accent/30">
        <div data-pick-part className="min-w-[13rem] flex-1">
          <p className="kicker text-2xs text-muted">
            {sportLabel(picked.court.sport)} · {picked.court.court_code}
          </p>
          <p className="mt-1 font-display text-2xl tabular-nums">
            {String(picked.hour).padStart(2, "0")}:00-{String(picked.hour + 1).padStart(2, "0")}:00
            <span className="ml-2 text-muted">
              {wdLabel(date)} {Number(date.slice(8, 10))}
            </span>
          </p>
          <p className="mt-1 text-sm text-muted">
            {p ? t("{price} for the hour", { price: money(p) }) : t("Priced at the desk")} ·{" "}
            {t("held {n} minutes once you sign in", { n: venue.holdMinutes })}
          </p>
        </div>
        <div data-pick-part className="flex flex-wrap gap-2">
          <ButtonLink to="/login">{t("Sign in & hold it")}</ButtonLink>
          <ButtonLink to="/register" variant="outline">
            {t("Create an account")}
          </ButtonLink>
          <Button variant="ghost" onClick={onClear}>
            {t("Pick another")}
          </Button>
        </div>
      </Card>
    </div>
  );
}
