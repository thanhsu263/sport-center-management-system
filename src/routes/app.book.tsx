import { createFileRoute, Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { Landmark, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { MonthCalendar, useAvailability } from "@/components/availability-calendar";
import { CourtGrid, DateStrip, freeHours, type Court, type OccSlot } from "@/components/court-grid";
import { HoldTimer, sportPhoto } from "@/components/media";
import { HoldCountdown } from "@/components/moments/hold-countdown";
import { PaidMark, ScrambleCode } from "@/components/moments/paid";
import { CancelBookingDialog } from "@/components/cancel-booking";
import { PayOnlineButton } from "@/components/pay-online";
import { MemberTransferModal, useCentreBank, type CentreBank } from "@/components/transfer-qr-modal";
import { Shell, money, when } from "@/components/shell";
import { Button, Card, ContextLayout, DateField, Input, LoadError, PageHero, Seg, Skeleton, SportThumbnail, StatusBadge } from "@/components/ui";
import { StarBorder } from "@/components/fx";
import { apiGet, apiPost, openInvoice, ApiClientError } from "@/lib/arena3/client";
import { addDaysISO, todayISO, sportLabel } from "@/lib/arena3/labels";
import { locale, t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { useRead } from "@/lib/use-read";
import { useLive } from "@/lib/use-live";
import { useSports } from "@/components/sports-ui";
import { DEFAULT_VENUE, hoursOf, venueFrom, type Venue, type VenueRaw } from "@/lib/venue";

export const Route = createFileRoute("/app/book")({
  validateSearch: (s: Record<string, unknown>): { sport?: string } => ({
    sport: typeof s.sport === "string" && s.sport.trim() ? s.sport.trim() : undefined,
  }),
  component: Page,
});

/** The closest still-free hours on the same sport, nearest to what they wanted. */
function nearestFree(
  data: { courts: Court[]; slots: OccSlot[] },
  wanted: Court,
  hour: number,
  date: string,
  hours: readonly number[],
) {
  const sameSport = data.courts.filter((c) => c.sport === wanted.sport);
  return freeHours(sameSport, data.slots, date, Date.now(), true, hours)
    .sort(
      (a, b) =>
        Math.abs(a.hour - hour) - Math.abs(b.hour - hour) ||
        Number(b.court.court_code === wanted.court_code) -
          Number(a.court.court_code === wanted.court_code),
    )
    .slice(0, 3);
}

/** One of the member's own upcoming court bookings (M-04). */
type MyBooking = {
  id: string;
  code: string;
  status: string;
  start_at: string;
  end_at: string;
  court_id: string;
  court_code: string;
  sport: string;
  can_move: boolean;
  paid_vnd?: number;
  price_vnd?: number;
  series_id?: string | null;
};

type Hold = {
  booking: { id: string; code: string; hold_until?: string };
  price: number;
  /** What is asked up front when only a deposit is due; equals the price otherwise. */
  due_now_vnd?: number;
  deposit_vnd?: number;
  hold_until: string;
  /** Which slot this is, carried from the tap so the card can name it. */
  court_code?: string;
  hour?: number;
  promo?: { code: string; name: string; discount_vnd: number } | null;
  /** Court hours on a plan that covers this sport and is live today (BR-12, BR-13). */
  plan_hours_left?: number;
};

/** A hold that was refused, and — when another hour would help — where to go instead. */
type Taken = {
  message: string;
  alts: { court: Court; hour: number }[];
  /** False when the refusal was about the member, not the slot. */
  canRetry: boolean;
};

function Page() {
  const { sports } = useSports();
  const searchSport = Route.useSearch().sport;
  const [date, setDate] = useState(todayISO);
  const [sport, setSport] = useState(searchSport ?? "");
  useEffect(() => {
    if (!sport && sports.length > 0) {
      setSport(sports[0].code);
    }
  }, [sport, sports]);
  // The day on screen. A day the server will not show comes back as `error` (not a grid of grey
  // blocks behind a toast), and a late reply for an earlier date never lands on a later one.
  const { data, error, reload } = useRead<{ courts: Court[]; slots: OccSlot[] }>(`/occupancy?date=${date}`);
  const [hold, setHold] = useState<Hold | null>(null);
  // Typed before tapping a slot: the hold is priced when it is made, so the code goes with it.
  const [promoCode, setPromoCode] = useState("");
  const [promoOpen, setPromoOpen] = useState(false);
  // Refusals and clash warnings appear above the grid; a tap deep in the grid must still see them.
  const notices = useRef<HTMLDivElement>(null);
  const [overlap, setOverlap] = useState<{ court: Court; hour: number; message: string } | null>(null);
  // Week strip or whole month — both show how many slots each day has left.
  const [view, setView] = useState<"week" | "month">("week");
  const [refresh, setRefresh] = useState(0);
  const avail = useAvailability(sport, refresh);
  const [mine, setMine] = useState<MyBooking[] | null>(null);
  const [windowHours, setWindowHours] = useState(2);
  const [showAllMine, setShowAllMine] = useState(false);
  type MySub = {
    plan_name: string;
    sport_scope: string;
    court_hours_left: string | number;
    end_on: string;
  };
  const [mySubs, setMySubs] = useState<MySub[]>([]);

  // The booking being moved: the grid's next tap lands on it instead of making a new hold.
  const [moving, setMoving] = useState<MyBooking | null>(null);
  const [moveError, setMoveError] = useState("");
  const [cancelId, setCancelId] = useState<string | null>(null);
  async function loadMine() {
    try {
      const r = await apiGet<{ items: MyBooking[]; window_hours: number }>("/me/bookings");
      setMine(r.items);
      setWindowHours(r.window_hours);
    } catch {
      // Keep the list that is already on screen
    }
    try {
      const me = await apiGet<{ subscriptions?: MySub[] }>("/me");
      if (Array.isArray(me.subscriptions)) {
        setMySubs(me.subscriptions);
      }
    } catch {
      // Ignore if /me subscriptions unavailable
    }
  }
  const [taken, setTaken] = useState<Taken | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (taken || overlap) notices.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [taken, overlap]);
  // Leave the online button out entirely when the centre has no payOS set up,
  // rather than offering one that errors.
  const [onlineOn, setOnlineOn] = useState(false);
  // The centre's hours and hold length come with the same answer, for the grid and the copy.
  const [venue, setVenue] = useState<Venue>(DEFAULT_VENUE);
  useEffect(() => {
    void apiGet<{ capabilities?: { online_payment?: boolean }; venue?: VenueRaw }>("/flags")
      .then((r) => {
        setOnlineOn(Boolean(r.capabilities?.online_payment));
        setVenue(venueFrom(r.venue));
      })
      .catch(() => setOnlineOn(false));
  }, []);
  // Sticks around after the toast has gone. A receipt people paid for should
  // not be something you have four seconds to notice.
  const [receipt, setReceipt] = useState<string | null>(null);
  // A transfer the member has promised but reception has not yet found.
  const [pending, setPending] = useState<{ amount: number; until: string; code: string } | null>(null);
  // The centre's own account for VietQR. Without one the transfer option is left out entirely,
  // rather than asking for money with nowhere to send it (B-5).
  const { bank } = useCentreBank();
  const bankOn = bank?.configured === true;
  const [transferOpen, setTransferOpen] = useState<"hold" | "pending" | null>(null);

  /** Ask again for the day on screen and for everything counted from it. */
  function load() {
    reload();
    setRefresh((n) => n + 1);
    void loadMine();
  }

  useLive("courts", load);

  async function moveTo(court: Court, hour: number, confirmOverlap = false) {
    if (!moving) return;
    const start = `${date}T${String(hour).padStart(2, "0")}:00:00+07:00`;
    setBusy(true);
    setMoveError("");
    try {
      await apiPost(
        `/bookings/${moving.id}/reschedule`,
        { start_at: start, court_id: court.id, ...(confirmOverlap ? { confirm_overlap: true } : {}) },
      );
      toast.success(
        t("Moved {code} to {court} · {time}", {
          code: moving.code,
          court: court.court_code,
          time: `${String(hour).padStart(2, "0")}:00`,
        }),
      );
      setMoving(null);
      setOverlap(null);
      load();
    } catch (e) {
      if (e instanceof ApiClientError && e.body.requires_confirm && !confirmOverlap) {
        setOverlap({ court, hour, message: e.body.message });
      } else {
        setMoveError(e instanceof Error ? e.message : t("Could not move that booking"));
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  function startMove(b: MyBooking) {
    setMoving(b);
    setMoveError("");
    setHold(null);
    setTaken(null);
    setSport(b.sport);
    // Open the booking's own day: most changes are another hour the same day.
    setDate(
      new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(b.start_at)),
    );
  }
  // Opening a day also refreshes the counts on the strip and the member's own list.
  useEffect(() => {
    setRefresh((n) => n + 1);
    void loadMine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  async function holdSlot(court: Court, hour: number, confirmOverlap = false) {
    const start = `${date}T${String(hour).padStart(2, "0")}:00:00+07:00`;
    setBusy(true);
    try {
      const res = await apiPost<Hold>(
        "/bookings",
        {
          court_id: court.id,
          start_at: start,
          ...(confirmOverlap ? { confirm_overlap: true } : {}),
          ...(promoCode.trim() ? { promo_code: promoCode.trim() } : {}),
        },
        true,
      );
      setHold({ ...res, court_code: court.court_code, hour });
      setOverlap(null);
      setTaken(null);
      toast.success(t("Holding {court} · {code}", { court: court.court_code, code: res.booking.code }));
      load();
    } catch (e) {
      if (e instanceof ApiClientError && e.body.requires_confirm && !confirmOverlap) {
        setOverlap({ court, hour, message: e.body.message });
      } else {
        // Two people reaching for the same 19:00 on a Saturday is the system
        // working, not breaking — but a red toast saying "slot unavailable"
        // leaves the member to start the search again from nothing. Offer the
        // nearest hours that are still open instead, closest first.
        const message = e instanceof Error ? e.message : t("Could not hold that slot");
        // Only when another hour would actually help. A member who has used up
        // their two holds for the day, or whose balance is over the limit, is
        // not going to get anywhere by tapping a different court — offering
        // three of them would just be three more refusals.
        const aboutTheSlot =
          !(e instanceof ApiClientError) ||
          e.body.code === "CONFLICT_SLOT" ||
          e.body.br === "BR-06" ||
          e.body.br === "BR-07";
        // Re-read the day before suggesting anything: the grid on screen is
        // the one that just turned out to be wrong.
        const fresh = aboutTheSlot
          ? await apiGet<{ courts: Court[]; slots: OccSlot[] }>(`/occupancy?date=${date}`).catch(
              () => null,
            )
          : null;
        if (aboutTheSlot) reload();
        setTaken({
          message,
          alts: fresh ? nearestFree(fresh, court, hour, date, hoursOf(venue)) : [],
          canRetry: aboutTheSlot,
        });
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirmPay(method: "quota" | "transfer") {
    if (!hold) return;
    setBusy(true);
    try {
      // The endpoint issues an invoice and hands back its id. Dropping that on
      // the floor is why a member could pay and never see a receipt — nothing
      // in the UI ever mentioned one existed.
      const res = await apiPost<{
        invoice_id?: string;
        awaiting_transfer?: boolean;
        hold_until?: string;
      }>(`/bookings/${hold.booking.id}/confirm`, { method }, true);
      setHold(null);
      load();
      // A transfer is not a booking yet. Saying "Booking confirmed" here would
      // be the app telling a member their court is theirs while reception has
      // not found a single dong of it in the bank.
      if (res.awaiting_transfer) {
        setPending({ amount: hold.due_now_vnd ?? hold.price, until: res.hold_until ?? hold.hold_until, code: hold.booking.code });
        toast.success(t("Transfer noted"), {
          description: t("Your court is held while reception checks the bank."),
        });
        return;
      }
      if (res.invoice_id) {
        setReceipt(res.invoice_id);
        toast.success(method === "quota" ? t("One plan hour deducted") : t("Booking confirmed"), {
          description: t("Your receipt is ready."),
          action: {
            label: t("Open receipt"),
            onClick: () => void openInvoice(res.invoice_id!),
          },
        });
      } else {
        toast.success(method === "quota" ? t("One plan hour deducted") : t("Booking confirmed"));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Could not confirm the booking"));
    } finally {
      setBusy(false);
    }
  }

  // Sentences that wrap a live component: the translation carries a {placeholder}
  // and the component is dropped in between the two halves.
  const [heldBefore, heldAfter] = t(
    "Reception confirms it against the bank, usually the same day. We hold the slot for another {timer}; after that it goes back on the grid.",
  ).split("{timer}");
  const [keptBefore, keptAfter] = t("It is also kept in {link}.").split("{link}");

  // How many courts the member already has on the day on screen: said before they tap, not after.
  const dayKey = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(iso));
  const onThisDay = (mine ?? []).filter(
    (b) => (b.status === "confirmed" || b.status === "in_use" || b.status === "hold") && dayKey(b.start_at) === date,
  ).length;

  const myCourts = mine?.length && !moving ? (
    <Card className="p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{t("Your upcoming courts")}</h2>
        <span className="text-xs tabular-nums text-muted">{mine.length}</span>
      </div>
      <ul className="divide-y divide-line">
        {(showAllMine ? mine : mine.slice(0, 4)).map((b) => (
          <li key={b.id} className="py-2.5" title={b.code}>
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm">
                <span className="font-semibold">{b.court_code}</span>
                <span className="block text-muted">{when(b.start_at)}</span>
              </span>
              {/* Confirmed is the normal case; only a state that needs attention gets a badge. */}
              {b.status !== "confirmed" ? <StatusBadge status={b.status} /> : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3">
              {b.can_move ? (
                <button type="button" onClick={() => startMove(b)} className="hit text-sm font-medium text-accent-2 hover:underline">
                  {t("Change time")}
                </button>
              ) : b.status === "confirmed" ? (
                <span className="text-xs text-muted">{t("Within {n}h: can't move", { n: windowHours })}</span>
              ) : null}
              {b.status === "confirmed" || b.status === "hold" ? (
                <button type="button" onClick={() => setCancelId(b.id)} className="hit text-sm text-muted hover:text-danger">
                  {t("Cancel")}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {mine.length > 4 ? (
        <button
          type="button"
          onClick={() => setShowAllMine((v) => !v)}
          className="hit mt-1 text-sm font-medium text-accent-2 hover:underline"
        >
          {showAllMine ? t("Show fewer") : t("Show all {n}", { n: mine.length })}
        </button>
      ) : null}
    </Card>
  ) : null;

  const planQuotaCard = (
    <Card className="p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{t("Plan quota")}</h2>
        <Link to="/app/plans" className="text-xs font-medium text-accent-2 hover:underline">
          {t("Order a plan")}
        </Link>
      </div>
      {mySubs.length > 0 ? (
        <ul className="divide-y divide-line">
          {mySubs.map((sub, idx) => (
            <li key={idx} className="py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-fg">{sub.plan_name}</span>
                <span className="rounded-[var(--radius-pill)] bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent-2">
                  {sub.court_hours_left} {t("hours")}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {sportLabel(sub.sport_scope)} · {t("Ends {date}", { date: sub.end_on })}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted leading-relaxed">
          {t("No active plan. Buy a plan to get free court hours and member discounts.")}
        </p>
      )}
    </Card>
  );

  const bestFreeDays = Object.entries(avail ?? {})
    .filter(([d, info]) => d >= todayISO() && info.free > 0)
    .sort((a, b) => b[1].free - a[1].free)
    .slice(0, 4);

  const bestFreeHoursCard = bestFreeDays.length > 0 ? (
    <Card className="p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{t("Best free hours this week")}</h2>
        <span className="text-xs text-muted">{t("Tap to book")}</span>
      </div>
      <div className="grid gap-2">
        {bestFreeDays.map(([d, info]) => {
          const dateObj = new Date(d);
          const dayName = new Intl.DateTimeFormat(locale() === "vi" ? "vi-VN" : "en-US", {
            weekday: "short",
            month: "numeric",
            day: "numeric",
          }).format(dateObj);

          return (
            <button
              key={d}
              type="button"
              onClick={() => setDate(d)}
              className={cn(
                "flex w-full cursor-pointer items-center justify-between rounded-[var(--radius-md)] border p-2.5 text-left text-xs transition-colors hover:bg-wood/50",
                date === d ? "border-accent bg-accent/5 font-medium" : "border-line bg-surface",
              )}
            >
              <div className="flex items-center gap-2">
                <SportThumbnail sport={sport || sports[0]?.code || "all"} className="size-7 rounded" />
                <div>
                  <span className="font-semibold text-fg capitalize">{dayName}</span>
                  <span className="block text-2xs text-muted">{sportLabel(sport || "all")}</span>
                </div>
              </div>
              <span className="rounded-[var(--radius-pill)] bg-accent/10 px-2 py-0.5 text-2xs font-semibold text-accent-2">
                {info.free} {t("free hours")}
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  ) : null;

  const tomorrowISO = addDaysISO(todayISO(), 1);
  const tomorrowFree = avail?.[tomorrowISO]?.free ?? 0;
  const isTodayNearFull = date === todayISO() && (avail?.[todayISO()]?.free ?? 0) < 4;

  return (
    <Shell role="member">
      {(() => {
        const courtsForSport = (data?.courts ?? []).filter((c) => !sport || c.sport === sport);
        const freeSlotList = data ? freeHours(courtsForSport, data.slots, date, Date.now(), true, hoursOf(venue)) : [];
        const nextFreeHour = freeSlotList.length > 0 ? `${String(freeSlotList[0].hour).padStart(2, "0")}:00` : null;

        return (
          <PageHero
            slot={sport ? sportPhoto(sport) : "banner.book"}
            title={t("Book a court")}
            subtitle={t("Tap a free hour. We hold it for {n} minutes while you pay.", { n: venue.holdMinutes })}
            fallbackSpot="court"
            stats={[
              {
                label: t("Free hours today"),
                value: avail?.[date]?.free ?? 0,
                live: true,
              },
              {
                label: t("Courts in service"),
                value: data?.courts?.length ?? 0,
              },
              {
                label: t("Next free hour"),
                value: nextFreeHour ?? t("Full"),
              },
            ]}
          />
        );
      })()}

      {isTodayNearFull ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-accent/40 bg-accent/10 p-3.5 shadow-[var(--shadow-soft)]">
          <div className="flex items-center gap-2.5">
            <Sparkles className="size-5 text-accent-2" />
            <div>
              <p className="text-sm font-semibold text-fg">
                {t("Tomorrow has {n} free hours", { n: tomorrowFree })}
              </p>
              <p className="text-xs text-muted">
                {t("Today is almost fully booked. Book tomorrow for more options.")}
              </p>
            </div>
          </div>
          <Button size="sm" onClick={() => setDate(tomorrowISO)}>
            {t("Switch to tomorrow")}
          </Button>
        </div>
      ) : null}

      <ContextLayout
        context={
          <>
            {myCourts}
            {planQuotaCard}
            {bestFreeHoursCard}
          </>
        }
      >
        <div className="min-w-0">
          <div className="grid gap-3">
            {view === "week" ? (
              <DateStrip value={date} onChange={setDate} avail={avail} />
            ) : (
              <MonthCalendar value={date} onChange={setDate} avail={avail} />
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Seg
                value={sport}
                onChange={setSport}
                options={[
                  { value: "", label: t("All") },
                  ...sports
                    .filter((s) => !data?.courts || data.courts.some((c) => c.sport === s.code))
                    .map((s) => ({ value: s.code, label: sportLabel(s.code) })),
                ]}
              />
              <Seg
                value={view}
                onChange={(v) => setView(v === "month" ? "month" : "week")}
                options={[
                  { value: "week", label: t("Week") },
                  { value: "month", label: t("Month") },
                ]}
              />
              <DateField
                required
                value={date}
                onChange={setDate}
                invalid={error?.refused === true}
                aria-label={t("Pick another date")}
                className="hidden sm:flex"
              />
            </div>
            {promoOpen || promoCode ? (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={promoCode}
                  onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
                  placeholder={t("Promo code (optional)")}
                  aria-label={t("Promo code")}
                  autoCapitalize="characters"
                  maxLength={32}
                  className="h-11 w-full sm:h-9 sm:w-48"
                />
                <span className="text-xs text-muted">{t("Applied to the next hour you hold.")}</span>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setPromoOpen(true)}
                className="hit w-fit text-sm font-medium text-accent-2 hover:underline"
              >
                {t("Have a promo code?")}
              </button>
            )}
          </div>

          <div ref={notices} className="scroll-mt-20">
            {onThisDay > 0 && !moving ? (
              <p className="mt-3 text-sm text-muted">
                {onThisDay === 1
                  ? t("You already have 1 court on this day.")
                  : t("You already have {n} courts on this day.", { n: onThisDay })}
              </p>
            ) : null}
            {moving ? (
              <Card className="mt-4 border border-accent/30 bg-accent/5">
                <p className="text-sm font-medium">
                  {t("Moving {code} (now {court}, {when})", {
                    code: moving.code,
                    court: moving.court_code,
                    when: when(moving.start_at),
                  })}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {t(
                    "Tap a free slot below. You keep the same sport and price; the old hour is freed the moment the new one is yours.",
                  )}
                </p>
                {moveError ? (
                  <p role="alert" className="mt-2 text-sm text-danger">
                    {moveError}
                  </p>
                ) : null}
                <div className="mt-3">
                  <Button size="sm" variant="outline" onClick={() => (setMoving(null), setMoveError(""))}>
                    {t("Keep it where it is")}
                  </Button>
                </div>
              </Card>
            ) : null}
            <AnimatePresence>
              {pending ? (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <Card className="mt-4 border border-hold/30 bg-hold/5">
                    <div className="flex flex-wrap items-center gap-3">
                      <Landmark className="size-5 shrink-0 text-hold" strokeWidth={1.75} />
                      <div className="min-w-[12rem] flex-1">
                        <p className="text-sm font-medium">
                          {t("Transfer {amount}. Your court is held meanwhile.", { amount: money(pending.amount) })}
                        </p>
                        <p className="text-xs text-muted">
                          {heldBefore}
                          <HoldTimer until={pending.until} onExpire={() => setPending(null)} />
                          {heldAfter}
                        </p>
                      </div>
                      {bankOn ? (
                        <Button size="sm" variant="outline" onClick={() => setTransferOpen("pending")}>
                          {t("Transfer details")}
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => setPending(null)} aria-label={t("Dismiss")}>
                        {t("Got it")}
                      </Button>
                    </div>
                  </Card>
                </motion.div>
              ) : null}
              {receipt ? (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <Card className="mt-4 flex flex-wrap items-center gap-3 border border-accent/30 bg-accent/5">
                    <PaidMark />
                    <div className="min-w-[10rem] flex-1">
                      <p className="text-sm font-medium">{t("Booking confirmed. Your receipt is ready.")}</p>
                      <p className="text-xs text-muted">
                        {keptBefore}
                        <Link to="/account" className="text-accent-2 underline">
                          {t("Account settings → Receipts")}
                        </Link>
                        {keptAfter}
                      </p>
                    </div>
                    <Button size="sm" onClick={() => void openInvoice(receipt)}>
                      {t("Open receipt")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setReceipt(null)} aria-label={t("Dismiss")}>
                      {t("Dismiss")}
                    </Button>
                  </Card>
                </motion.div>
              ) : null}
              {taken ? (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <Card className="mt-4 border border-hold/30 bg-hold/5" role="alert">
                    <p className="text-sm font-medium">{taken.message}</p>
                    {!taken.canRetry ? (
                      <>
                        <p className="mt-1 text-xs text-muted">
                          {t("Pick another day, or ask the front desk when you are at the centre.")}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button size="sm" variant="outline" onClick={() => (setTaken(null), setDate(addDaysISO(date, 1)))}>
                            {t("Next day")}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setTaken(null)}>
                            {t("Dismiss")}
                          </Button>
                        </div>
                      </>
                    ) : taken.alts.length ? (
                      <>
                        <p className="mt-1 text-xs text-muted">
                          {t("Nearest hours still open on this sport. Tap one to hold it.")}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {taken.alts.map((a) => (
                            <Button
                              key={`${a.court.id}-${a.hour}`}
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => void holdSlot(a.court, a.hour)}
                            >
                              {a.court.court_code} · {String(a.hour).padStart(2, "0")}:00
                            </Button>
                          ))}
                          <Button size="sm" variant="ghost" onClick={() => setTaken(null)}>
                            {t("Dismiss")}
                          </Button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="mt-1 text-xs text-muted">
                          {t("Nothing else is free for this sport today. Try another date above, or another sport.")}
                        </p>
                        <div className="mt-3">
                          <Button size="sm" variant="ghost" onClick={() => setTaken(null)}>
                            {t("Dismiss")}
                          </Button>
                        </div>
                      </>
                    )}
                  </Card>
                </motion.div>
              ) : null}
              {overlap ? (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <Card className="mt-4 border border-hold/30 bg-hold/5" role="alert">
                    <p className="text-sm">{overlap.message}</p>
                    <p className="mt-1 text-xs text-muted">
                      {t("Your class enrolment stays put. This is only a clash warning.")}
                    </p>
                    <div className="mt-3 flex gap-2">
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void (moving
                            ? moveTo(overlap.court, overlap.hour, true)
                            : holdSlot(overlap.court, overlap.hour, true))
                        }
                      >
                        {moving ? t("Move it anyway") : t("Hold it anyway")}
                      </Button>
                      <Button variant="outline" onClick={() => setOverlap(null)}>
                        {t("Never mind")}
                      </Button>
                    </div>
                  </Card>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>

          <AnimatePresence>
            {hold ? (
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="sticky top-16 z-20 mt-4"
              >
                {/* Sticky: the countdown is the one thing on this page that stops being true while
                    you look away, so scrolling the grid for another court must not push it off screen. */}
                <Card className="flex flex-wrap items-center justify-between gap-4 border border-accent/40 shadow-[var(--shadow-soft)]">
                  <div className="min-w-[13rem] flex-1">
                    <HoldCountdown until={hold.hold_until} onExpire={() => setHold(null)} />
                    <p className="mt-2 text-sm text-muted">
                      {hold.court_code ? (
                        <span className="font-semibold text-fg">
                          {hold.court_code}
                          {hold.hour != null ? ` · ${String(hold.hour).padStart(2, "0")}:00` : ""}
                        </span>
                      ) : null}{" "}
                      {/* The booking code is born here; it decodes into place. */}
                      {hold.booking.code ? (
                        <>
                          · <ScrambleCode code={hold.booking.code} className="text-xs text-subtle" />{" "}
                        </>
                      ) : null}
                      · <span className="text-lg font-semibold tabular-nums text-fg">{money(hold.price)}</span>
                      {hold.promo ? (
                        <span className="ml-2 text-xs text-accent-2">
                          {hold.promo.code}: −{money(hold.promo.discount_vnd)}
                        </span>
                      ) : null}
                    </p>
                    {hold.due_now_vnd != null && hold.due_now_vnd < hold.price ? (
                      <p className="mt-1 text-xs text-muted">
                        {t("Peak hour: pay a {deposit} deposit now, the other {rest} at the desk when you arrive.", {
                          deposit: money(hold.due_now_vnd),
                          rest: money(hold.price - hold.due_now_vnd),
                        })}
                      </p>
                    ) : null}
                  </div>
                  {(() => {
                    // Only the ways this member can actually pay are offered (B-4), and only the first
                    // of them, the one most people take, gets the bright border.
                    const hours = hold.plan_hours_left ?? 0;
                    const primary = hours >= 1 ? "quota" : onlineOn ? "online" : bankOn ? "transfer" : null;
                    const lift = (key: string, node: ReactNode) =>
                      key === primary ? <StarBorder speed={4} key={key}>{node}</StarBorder> : <span key={key}>{node}</span>;
                    if (!primary) {
                      return (
                        <p className="max-w-sm text-sm text-muted">
                          {t("Paying in the app is not set up yet. Book this court at the front desk instead.")}
                        </p>
                      );
                    }
                    return (
                      <div className="flex flex-wrap gap-2">
                        {hours >= 1
                          ? lift(
                              "quota",
                              <Button disabled={busy} onClick={() => void confirmPay("quota")}>
                                {t("Use plan hours ({n} left)", { n: hours })}
                              </Button>,
                            )
                          : null}
                        {/* Online payment settles the slot at once (payOS confirms the money first). A bank
                            transfer only promises it: the court stays on hold until reception finds it. */}
                        {onlineOn
                          ? lift(
                              "online",
                              <PayOnlineButton
                                refType="booking"
                                refId={hold.booking.id}
                                label={t("Pay online")}
                                size="md"
                                variant={primary === "online" ? "primary" : "outline"}
                                onPaid={() => {
                                  setHold(null);
                                  load();
                                  toast.success(t("Paid. Your court is confirmed and the receipt is in your account."));
                                }}
                              />,
                            )
                          : null}
                        {/* Opens the account, QR and reference first; "I have transferred" comes after. */}
                        {bankOn
                          ? lift(
                              "transfer",
                              <Button
                                variant={primary === "transfer" ? "primary" : "outline"}
                                disabled={busy}
                                onClick={() => setTransferOpen("hold")}
                              >
                                {t("Bank transfer")}
                              </Button>,
                            )
                          : null}
                      </div>
                    );
                  })()}
                </Card>
              </motion.div>
            ) : null}
          </AnimatePresence>

          {bankOn && transferOpen === "hold" && hold ? (
            <MemberTransferModal
              open
              onClose={() => setTransferOpen(null)}
              bank={bank as CentreBank & { configured: true }}
              amountVnd={hold.due_now_vnd ?? hold.price}
              bookingCode={hold.booking.code}
              busy={busy}
              onTransferred={() => {
                setTransferOpen(null);
                void confirmPay("transfer");
              }}
            />
          ) : null}
          {bankOn && transferOpen === "pending" && pending ? (
            <MemberTransferModal
              open
              onClose={() => setTransferOpen(null)}
              bank={bank as CentreBank & { configured: true }}
              amountVnd={pending.amount}
              bookingCode={pending.code}
              busy={false}
            />
          ) : null}

          <div className="mt-4">
            {error ? (
              <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
            ) : data ? (
              <CourtGrid
                date={date}
                courts={data.courts}
                slots={data.slots}
                sport={sport || undefined}
                onPick={(c, h) => void (moving ? moveTo(c, h) : holdSlot(c, h))}
                // A member cannot hold an hour that has started, and the header reads the same count
                // as the day strip above it (B-3).
                startedIsPast
                freeCount={avail?.[date]?.free}
                hours={hoursOf(venue)}
                onRefresh={load}
                // A sold-out sport hands back the two controls at the top of this page.
                onPickSport={setSport}
                onPickDate={setDate}
              />
            ) : (
              <div className="grid gap-2">
                <Skeleton className="h-16" />
                <Skeleton className="h-72" />
              </div>
            )}
          </div>
        </div>
      </ContextLayout>
      <CancelBookingDialog
        bookingId={cancelId}
        open={cancelId != null}
        onClose={() => setCancelId(null)}
        onDone={load}
      />
    </Shell>
  );
}
