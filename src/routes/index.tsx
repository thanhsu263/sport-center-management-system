import { Navigate, createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { freeHours, useNowMinute } from "@/client/components/court-grid";
import { ClassTicker } from "@/client/components/landing/ticker";
import { ClassesScene } from "@/client/components/landing/plans";
import { ClosingCta, SiteFooter } from "@/client/components/landing/closing";
import { CoachesScene } from "@/client/components/landing/coaches";
import { CourtsScene } from "@/client/components/landing/courts";
import { FacilitiesScene } from "@/client/components/landing/facilities";
import { Hero, StatsBand } from "@/client/components/landing/hero";
import { LandingSmoother, useLandingScroll } from "@/client/components/landing/smoother";
import { Manifesto } from "@/client/components/landing/manifesto";
import { PricingScene } from "@/client/components/landing/pricing";
import { ScheduleScene, type Picked } from "@/client/components/landing/schedule";
import type { NextFree } from "@/client/components/landing/hero";
import { GalleryScene } from "@/client/components/landing/gallery";
import { SiteHeader } from "@/client/components/landing/header";
import { ShuttleScene } from "@/client/components/landing/shuttle3d";
import { StepsScene } from "@/client/components/landing/steps";
import { Testimonials } from "@/client/components/landing/testimonials";
import { VenueProvider, priceFor, useVenueHour, wdLabel } from "@/client/components/landing/util";
import { hoursOf, venueFrom } from "@/client/lib/venue";
import { getStoredUser, getToken, homeFor } from "@/client/arena3/client";
import { getPublicAvailability, getPublicCatalog } from "@/server/services/catalog";
import { addDaysISO } from "@/shared/arena3/labels";
import { BootGate } from "@/client/components/media";
import { useSports } from "@/client/components/sports-ui";
import { t } from "@/client/lib/i18n";

export const Route = createFileRoute("/")({
  // Today's schedule loads with the page rather than behind a sign-in wall:
  // "is a court free tonight" is the question people arrive with, and making
  // them register to find out is the funnel running backwards.
  loader: async () => {
    const [catalog, availability] = await Promise.all([
      getPublicCatalog(),
      getPublicAvailability({ data: {} }),
    ]);
    return { ...catalog, availability };
  },
  component: Home,
});

function Home() {
  const token = getToken();
  const u = getStoredUser();
  const { availability } = Route.useLoaderData();
  const now = useNowMinute();
  // The shuttle's rim light follows how much of today's court is free.
  const free = freeHours(availability.courts, availability.slots, availability.date, now, true).length;
  const glow = Math.min(1, 0.35 + free / 48);
  if (token && u) return <Navigate to={homeFor(u.role)} />;
  return (
    <BootGate>
      <main id="main-content" tabIndex={-1} className="min-h-dvh overflow-x-clip text-fg">
        <LandingSmoother header={<><SiteHeader /><ShuttleScene glow={glow} /></>}>
          <Landing />
        </LandingSmoother>
      </main>
    </BootGate>
  );
}

/**
 * The public page, told as a scroll story (GSAP: components/landing/*).
 *
 * This component owns the data and the live schedule state that several sections share (today's
 * free-hour count shows in the hero, the counters, the court cards and the grid); each section is
 * its own scene with its own GSAP timeline, and none of them use `motion`.
 */
function Landing() {
  const { classes, prices, availability, venue: venueRaw, coaches: dbCoaches } = Route.useLoaderData();
  // The centre's own hours and hold length, for every section's copy and the grid.
  const venue = useMemo(() => venueFrom(venueRaw), [venueRaw]);
  const { scrollToId } = useLandingScroll();
  const hour = useVenueHour();
  const isOpen = hour == null ? null : hour >= venue.open && hour < venue.close;

  // ── Today's schedule, live on the page ──────────────────────────────
  const { sports } = useSports();
  const [schedSport, setSchedSport] = useState("");
  useEffect(() => {
    if (!schedSport && sports.length > 0) {
      setSchedSport(sports[0].code);
    }
  }, [schedSport, sports]);
  const [schedDate, setSchedDate] = useState(availability.date);
  const [sched, setSched] = useState(availability);
  const [schedBusy, setSchedBusy] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const now = useNowMinute();

  useEffect(() => {
    if (schedDate === sched.date) return;
    let alive = true;
    setSchedBusy(true);
    setPicked(null);
    getPublicAvailability({ data: { date: schedDate } })
      .then((r) => {
        if (alive) setSched(r);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setSchedBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [schedDate, sched.date]);

  // Guests book like members: an hour that has started is no longer on offer (BR-07).
  const schedFreeList = freeHours(sched.courts, sched.slots, sched.date, now, true, hoursOf(venue));
  const freeCounts = new Map<string, number>();
  for (const { court } of schedFreeList) {
    freeCounts.set(court.sport, (freeCounts.get(court.sport) ?? 0) + 1);
  }
  const freeBySport = (sport: string) => freeCounts.get(sport) ?? 0;
  const schedFree = schedFreeList.length;
  // Hours come out earliest first, so the first one is the next you could play. Until the clock
  // arrives (now = 0) nothing has been ruled out yet, so the offer waits for it.
  const first = now ? schedFreeList[0] : undefined;
  const nextFree: NextFree | null = first
    ? { ...first, price: priceFor(prices, first.court.sport, sched.date, first.hour) }
    : null;
  const schedDay =
    sched.date === availability.date
      ? t("today")
      : t("on {day}", { day: `${wdLabel(sched.date)} ${Number(sched.date.slice(8, 10))}` });
  const cheapestHour = Math.min(...prices.filter((p) => !p.court_id).map((p) => p.price_vnd));
  const weekday = prices.filter((p) => p.day_kind === "weekday" && !p.court_id);

  /*
   * After close, show tomorrow.
   *
   * Open the site at half past ten at night and every hour on today's grid has
   * already been played; a page whose headline offer is "0 free hours" and
   * whose grid is a wall of finished hours is telling the truth in the least
   * useful way there is. The first day with hours left is the one worth
   * showing. Deferred to an effect rather than decided during render because
   * the clock is not available until the client has mounted.
   */
  useEffect(() => {
    if (!now) return;
    if (schedDate !== availability.date) return;
    if (freeHours(availability.courts, availability.slots, availability.date, now, true, hoursOf(venue)).length > 0) return;
    setSchedDate(addDaysISO(availability.date, 1));
  }, [now, schedDate, availability, venue]);

  /** Jump to the schedule already filtered to the sport they tapped. */
  const showTimes = (s: string) => {
    setSchedSport(s);
    setPicked(null);
    scrollToId("schedule");
  };

  /** The hero's free hour, picked on the schedule so the next step is the hold. */
  const holdNext = (n: NextFree) => {
    setSchedSport(n.court.sport);
    setPicked({ court: n.court, hour: n.hour });
    scrollToId("schedule");
  };

  return (
    <VenueProvider value={venue}>
      <Hero
        isOpen={isOpen}
        freeHours={schedFree}
        openClasses={classes.length}
        day={schedDay}
        cheapestHour={cheapestHour}
        next={nextFree}
        onHold={holdNext}
      />
      <StatsBand courts={sched.courts} />
      <CourtsScene weekday={weekday} freeBySport={freeBySport} day={schedDay} onShowTimes={showTimes} courts={sched.courts} />
      <ScheduleScene
        sched={sched}
        date={schedDate}
        onDate={setSchedDate}
        sport={schedSport}
        onSport={setSchedSport}
        busy={schedBusy}
        picked={picked}
        onPick={setPicked}
        prices={prices}
      />
      {classes.length ? <ClassTicker classes={classes} /> : null}
      <Manifesto />
      <StepsScene />
      <CoachesScene dbCoaches={dbCoaches} />
      <FacilitiesScene courts={sched.courts} />
      <PricingScene weekday={weekday} />
      <ClassesScene classes={classes} />
      <Testimonials />
      <GalleryScene />
      <ClosingCta />
      <SiteFooter />
    </VenueProvider>
  );
}
