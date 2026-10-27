import { Navigate, createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { freeHours, useNowMinute } from "@/components/court-grid";
import { ClassTicker } from "@/components/landing/ticker";
import { ClassesScene, PlansScene } from "@/components/landing/plans";
import { ClosingCta, SiteFooter } from "@/components/landing/closing";
import { CoachesScene } from "@/components/landing/coaches";
import { CourtsScene } from "@/components/landing/courts";
import { FacilitiesScene } from "@/components/landing/facilities";
import { Hero, StatsBand } from "@/components/landing/hero";
import { LandingSmoother, useLandingScroll } from "@/components/landing/smoother";
import { Manifesto } from "@/components/landing/manifesto";
import { PricingScene } from "@/components/landing/pricing";
import { ScheduleScene, type Picked } from "@/components/landing/schedule";
import { GalleryScene } from "@/components/landing/gallery";
import { SiteHeader } from "@/components/landing/header";
import { StepsScene } from "@/components/landing/steps";
import { Testimonials } from "@/components/landing/testimonials";
import { VenueProvider, useVenueHour, wdLabel } from "@/components/landing/util";
import { hoursOf, venueFrom } from "@/lib/venue";
import { getStoredUser, getToken, homeFor } from "@/lib/arena3/client";
import { getPublicAvailability, getPublicCatalog } from "@/lib/arena3/catalog";
import { addDaysISO } from "@/lib/arena3/labels";
import { BootGate } from "@/components/media";
import { useSports } from "@/components/sports-ui";
import { t } from "@/lib/i18n";

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
  if (token && u) return <Navigate to={homeFor(u.role)} />;
  return (
    <BootGate>
      <main id="main-content" tabIndex={-1} className="min-h-dvh overflow-x-clip text-fg">
        <LandingSmoother header={<SiteHeader />}>
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
  const { plans, classes, prices, availability, venue: venueRaw, coaches: dbCoaches } = Route.useLoaderData();
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

  const freeBySport = (s: string) =>
    freeHours(sched.courts.filter((c) => c.sport === s), sched.slots, sched.date, now, true, hoursOf(venue)).length;
  // Guests book like members: an hour that has started is no longer on offer (BR-07).
  const schedFree = freeHours(sched.courts, sched.slots, sched.date, now, true, hoursOf(venue)).length;
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

  return (
    <VenueProvider value={venue}>
      <Hero isOpen={isOpen} freeHours={schedFree} day={schedDay} cheapestHour={cheapestHour} />
      <StatsBand freeHours={schedFree} day={schedDay} courts={sched.courts} />
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
      <PlansScene plans={plans} />
      <ClassesScene classes={classes} />
      <Testimonials />
      <GalleryScene />
      <ClosingCta />
      <SiteFooter />
    </VenueProvider>
  );
}
