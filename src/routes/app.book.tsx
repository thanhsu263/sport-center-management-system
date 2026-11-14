import { createFileRoute, Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { Landmark, Sparkles } from "lucide-react";
import { type ReactNode } from "react";
import { toast } from "sonner";
import { MonthCalendar } from "@/client/components/availability-calendar";
import { CourtGrid, freeHours } from "@/client/components/court-grid";
import { HoldTimer, sportPhoto } from "@/client/components/media";
import { HoldCountdown } from "@/client/components/moments/hold-countdown";
import { PaidMark, ScrambleCode } from "@/client/components/moments/paid";
import { CancelBookingDialog } from "@/client/components/cancel-booking";
import { PayOnlineButton } from "@/client/components/pay-online";
import { MemberTransferModal, type CentreBank } from "@/client/components/transfer-qr-modal";
import { Shell, money, when } from "@/client/components/shell";
import { Button, ButtonLink, Card, ContextLayout, Input, LoadError, PageHero, Seg, Skeleton, StatusBadge } from "@/client/components/ui";
import { StarBorder } from "@/client/components/fx";
import { openInvoice } from "@/client/arena3/client";
import { addDaysISO, levelLabel, todayISO, sportLabel } from "@/shared/arena3/labels";
import { t, tk } from "@/client/lib/i18n";
import { cn } from "@/client/lib/cn";
import { hoursOf } from "@/client/lib/venue";
import { AddToCalendar } from "@/client/components/class-extras";
import { useCourtBooking } from "@/client/lib/pages/app.book";


export const Route = createFileRoute("/app/book")({
  validateSearch: (s: Record<string, unknown>): { sport?: string } => ({
    sport: typeof s.sport === "string" && s.sport.trim() ? s.sport.trim() : undefined,
  }),
  component: Page,
});

const STEPS = [tk("Pick an hour"), tk("Held for you"), tk("Pay")] as const;

/** The three steps of a booking, with the one the member is on lit. */
function BookingSteps({ step }: { step: 1 | 2 | 3 }) {
  return (
    <ol aria-label={t("Booking steps")} className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < step ? "done" : n === step ? "now" : "todo";
        return (
          <li key={label} aria-current={state === "now" ? "step" : undefined} className="flex items-center gap-2">
            {i ? <span aria-hidden className="h-px w-4 bg-line-strong sm:w-8" /> : null}
            <span
              className={cn(
                "grid size-6 place-items-center rounded-[var(--radius-pill)] font-mono text-2xs font-bold tabular-nums transition-colors duration-200",
                state === "now" ? "bg-accent text-accent-fg" : state === "done" ? "bg-accent/15 text-accent-2" : "bg-wood text-muted",
              )}
            >
              {n}
            </span>
            <span className={cn("font-medium", state === "now" ? "text-fg" : "text-muted")}>{t(label)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Page() {
  const {
    limits, sports, date, setDate, sport, setSport, data, error, reload, hold, setHold, promoCode,
    setPromoCode, promoOpen, setPromoOpen, notices, overlap, setOverlap, avail, mine, myClasses,
    showAllClasses, setShowAllClasses, windowHours, showAllMine, setShowAllMine, mySubs, moving,
    setMoving, moveError, setMoveError, cancelId, setCancelId, taken, setTaken, busy, onlineOn,
    venue, receipt, setReceipt, pending, setPending, bank, bankOn, transferOpen, setTransferOpen,
    load, moveTo, startMove, holdSlot, confirmPay, heldBefore, heldAfter, keptBefore, keptAfter,
    onThisDay,
  } = useCourtBooking(Route.useSearch);

  const myCourts = mine?.length && !moving ? (
    <Card className="p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{t("Your upcoming courts")}</h2>
        <span className="text-xs tabular-nums text-muted">{mine.length}</span>
      </div>
      <ul className="divide-y divide-line">
        {(showAllMine ? mine : mine.slice(0, limits.member_bookings)).map((b) => (
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
              {b.status === "confirmed" || b.status === "hold" ? (
                <AddToCalendar
                  event={{
                    title: `${t("Court {court}", { court: b.court_code })} · ${sportLabel(b.sport)}`,
                    start: b.start_at,
                    end: b.end_at,
                    details: b.code,
                    location: "Lê Long Sport",
                  }}
                />
              ) : null}
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
      {mine.length > limits.member_bookings ? (
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

  // Sessions of the classes the member has a seat in: part of their schedule, booked through the class.
  const myClassesCard = myClasses.length && !moving ? (
    <Card className="p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{t("Your upcoming classes")}</h2>
        <span className="text-xs tabular-nums text-muted">{myClasses.length}</span>
      </div>
      <ul className="divide-y divide-line">
        {(showAllClasses ? myClasses : myClasses.slice(0, limits.member_bookings)).map((s) => (
          <li key={s.id} className="py-2.5">
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm">
                <span className="font-semibold">
                  {sportLabel(s.sport)} · {levelLabel(s.level)}
                </span>
                <span className="block text-muted">{when(s.start_at)}</span>
                <span className="block text-xs text-muted">
                  {s.court_code} · {s.coach_name}
                </span>
              </span>
              <span className="shrink-0 rounded-[var(--radius-pill)] bg-accent/10 px-2 py-0.5 text-2xs font-semibold text-accent-2">
                {t("Class")}
              </span>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-1 flex flex-wrap items-center gap-x-4">
        {myClasses.length > limits.member_bookings ? (
          <button
            type="button"
            onClick={() => setShowAllClasses((v) => !v)}
            className="hit text-sm font-medium text-accent-2 hover:underline"
          >
            {showAllClasses ? t("Show fewer") : t("Show all {n}", { n: myClasses.length })}
          </button>
        ) : null}
        <Link to="/app/classes" className="hit text-sm font-medium text-accent-2 hover:underline">
          {t("Manage classes")}
        </Link>
      </div>
    </Card>
  ) : null;

  const planQuotaCard = (
    <Card className="p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{t("My plan")}</h2>
        <Link to="/app/plans" className="text-xs font-medium text-accent-2 hover:underline">
          {t("Order a plan")}
        </Link>
      </div>
      {mySubs.length > 0 ? (
        <ul className="divide-y divide-line">
          {mySubs.map((sub, idx) => (
            <li key={idx} className="py-2 text-sm">
              <span className="font-medium text-fg">{sub.plan_name}</span>
              <p className="mt-0.5 text-xs text-muted">
                {t("Ends {date}", { date: sub.end_on })}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted leading-relaxed">
          {t("No active plan. See Plans for what each plan includes.")}
        </p>
      )}
    </Card>
  );

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
                label: t("Next free hour"),
                value: nextFreeHour ?? t("Full"),
              },
            ]}
          />
        );
      })()}

      {/* Where you are in the booking: pick an hour, it is held, you pay. */}
      <BookingSteps step={receipt || pending ? 3 : hold ? 2 : 1} />

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
            {myClassesCard}
            {planQuotaCard}
          </>
        }
      >
        <div className="min-w-0">
          <div className="grid min-w-0 grid-cols-1 gap-3 rounded-[var(--radius-lg)] border border-line bg-surface/50 p-3 sm:p-4">
            {/* One way to pick a day: the month, with how many slots each day has left. */}
            <MonthCalendar value={date} onChange={setDate} avail={avail} />
            <div className="flex min-w-0 flex-col items-start gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              <div className="w-full min-w-0 sm:w-auto sm:max-w-full">
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
              </div>
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
                    {/* Paid: the next thing the member needs is the code for the gate. */}
                    <ButtonLink to="/app/pass" size="sm">
                      {t("Show pass")}
                    </ButtonLink>
                    <Button size="sm" variant="outline" onClick={() => void openInvoice(receipt)}>
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
                    <div className="mt-3 flex flex-wrap gap-2">
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
                    <p className="mt-1 text-xs text-muted">
                      {hold.membership.covered && hold.membership.end_on
                        ? t("Member fee: your membership covers this day, through {date}.", { date: hold.membership.end_on })
                        : t("Normal price: no membership covers this day. Extend it to play at the member fee.")}
                    </p>
                    <p className="mt-1 text-xs text-muted">{t("No refund if you cancel or do not show up.")}</p>
                  </div>
                  {(() => {
                    // Only the ways this member can actually pay are offered (B-4), and only the first
                    // of them, the one most people take, gets the bright border.
                    const primary = onlineOn ? "online" : bankOn ? "transfer" : null;
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
