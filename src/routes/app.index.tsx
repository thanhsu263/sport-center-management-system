import { createFileRoute, Link } from "@tanstack/react-router";
import { SectionTitle } from "@/client/components/section";
import { ArrowRight, QrCode, Star, Ticket, Wallet } from "lucide-react";
import { AssistantMark } from "@/client/components/mark";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { NotificationList, type Notification } from "@/client/components/notifications";
import { CancelBookingDialog } from "@/client/components/cancel-booking";
import { PayOnlineButton } from "@/client/components/pay-online";
import { freeHours, useNowMinute, type Court, type OccSlot } from "@/client/components/court-grid";
import { Shell, hhmm } from "@/client/components/shell";
import { Button, ButtonLink, Card, LoadError, Skeleton, StatusBadge } from "@/client/components/ui";
import { CountUp, Lift, Reveal, Stagger, StaggerItem, useReducedMotionAfterMount } from "@/client/components/motion";
import { ShinyText, SplitText, SpotlightCard } from "@/client/components/fx";
import { apiGet, apiPost, getStoredUser } from "@/client/arena3/client";
import { formatDate, levelLabel, sportLabel, statusLabel, todayISO } from "@/shared/arena3/labels";
import { cn } from "@/client/lib/cn";
import { t, tData, tk, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";
import { useLimits } from "@/client/lib/use-centre";
import { DEFAULT_VENUE, hoursOf, venueFrom, type Venue, type VenueRaw } from "@/client/lib/venue";
import { AddToCalendar } from "@/client/components/class-extras";

export const Route = createFileRoute("/app/")({
  component: Page,
});

type Me = {
  user: { full_name: string; member_code: string | null };
  subscriptions: Array<{
    id: string;
    status: string;
    end_on: string;
    plan_name: string;
  }>;
  inbox: Notification[];
  offers?: Array<{ id: string; expires_at: string; sport: string; level: string }>;
  enrollments?: Array<{ id: string; status: string; waitlist_pos: number | null; sport: string; level: string }>;
  today: {
    bookings: Array<{
      id: string;
      code: string;
      start_at: string;
      end_at: string;
      status: string;
      court_code: string;
    }>;
    classes: Array<{
      id: string;
      start_at: string;
      end_at: string;
      level: string;
      sport: string;
      court_code: string;
      coach_name: string;
    }>;
  };
};

type Points = {
  points: number;
  earned: number;
  tier: "bronze" | "silver" | "gold";
  next_tier: { key: string; need: number } | null;
};

type Event = {
  id: string;
  start: string;
  end: string;
  kind: string;
  title: string;
  meta: string;
  bookingId: string | null;
  status: string;
};

const tierName = (k: string) => (k === "gold" ? t("Gold") : k === "silver" ? t("Silver") : t("Bronze"));

function Page() {
  const { data, error, reload } = useRead<Me>("/me");
  // The server's copy, with notifications marked read here as the member opens them.
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    setMe(data);
  }, [data]);
  const [cancelId, setCancelId] = useState<string | null>(null);
  // Whether the centre takes payment online at all, and its hours for the free-court strip.
  const [onlineOn, setOnlineOn] = useState(false);
  const [venue, setVenue] = useState<Venue>(DEFAULT_VENUE);
  useEffect(() => {
    void apiGet<{ capabilities?: { online_payment?: boolean }; venue?: VenueRaw }>("/flags")
      .then((r) => {
        setOnlineOn(Boolean(r.capabilities?.online_payment));
        setVenue(venueFrom(r.venue));
      })
      .catch(() => setOnlineOn(false));
  }, []);
  const now = useNowMinute();
  const u = getStoredUser();
  const live = me?.subscriptions.filter((s) => s.status === "active") ?? [];
  const frozen = me?.subscriptions.filter((s) => s.status === "frozen") ?? [];
  const expiring = live.filter((s) => {
    const d = daysUntil(s.end_on);
    return Number.isFinite(d) && d >= 0 && d <= 7;
  });
  const greet = u?.full_name.split(" ").slice(-1)[0] ?? "";
  const events: Event[] = [
    ...(me?.today.classes ?? []).map((c) => ({
      id: `c-${c.id}`,
      start: c.start_at,
      end: c.end_at,
      kind: tk("Class"),
      title: `${sportLabel(c.sport)} · ${c.court_code}`,
      meta: c.coach_name,
      bookingId: null as string | null,
      status: "confirmed",
    })),
    ...(me?.today.bookings ?? []).map((b) => ({
      id: `b-${b.id}`,
      start: b.start_at,
      end: b.end_at,
      kind: tk("Court"),
      title: b.court_code,
      meta: b.code,
      bookingId: b.id,
      status: b.status,
    })),
  ].sort((a, b) => a.start.localeCompare(b.start));
  // The one lime card is whatever the member walks onto court for next; the rest of today sits under it.
  const nextIdx = now ? events.findIndex((ev) => new Date(ev.end).getTime() > now) : events.length ? 0 : -1;
  const next = nextIdx >= 0 ? events[nextIdx] : undefined;
  const later = events.filter((_, i) => i !== nextIdx);

  const actions = (ev: Event, onLime = false) => (
    <>
      {/*
        A held court can be paid for from here, not only from the screen it was
        booked on. The booking page keeps the hold in component state, so
        refreshing or walking away left the member with a court they could see,
        could cancel, and had no way to pay for.
      */}
      {onlineOn && ev.bookingId && ev.status === "hold" ? (
        <PayOnlineButton refType="booking" refId={ev.bookingId} label={t("Pay online")} onPaid={reload} />
      ) : null}
      {ev.bookingId && (ev.status === "hold" || ev.status === "confirmed") ? (
        <Button
          size="sm"
          variant="outline"
          className={onLime ? "border-accent-fg/30 bg-transparent text-accent-fg hover:bg-accent-fg/10" : undefined}
          onClick={() => setCancelId(ev.bookingId ?? null)}
        >
          {t("Cancel")}
        </Button>
      ) : null}
    </>
  );

  return (
    <Shell role="member">
      <div className="mb-6 flex items-end justify-between gap-3">
        <div>
          <ShinyText className="shiny-muted mb-1 block font-mono text-2xs font-bold uppercase tracking-wider" speed={6}>
            {t(greetingFor(now))}
          </ShinyText>
          <SplitText
            as="h1"
            text={t("Welcome back, {name}", { name: greet })}
            stagger={0.02}
            duration={0.6}
            className="font-display text-3xl font-bold tracking-tight sm:text-5xl"
          />
        </div>
        {/* One filled action per view: with nothing booked, the empty card below carries it instead. */}
        {next ? (
          <ButtonLink to="/app/book" className="shrink-0 shadow-[var(--shadow-accent)]">
            {t("Book a court")}
          </ButtonLink>
        ) : null}
      </div>

      {/* A seat on the waitlist that is ours for a few minutes: clay, because it runs out. */}
      {(me?.offers ?? []).map((o) => (
        <OfferCard key={o.id} offer={o} onDone={reload} />
      ))}

      {frozen.length ? (
        <Card className="mb-4">
          <p className="text-sm font-medium">{t("Frozen plans")}</p>
          <p className="mt-1 text-sm text-muted">
            {t("{plans}. Ask the desk to unfreeze.", {
              plans: frozen
                .map((s) => t("{plan} · new end date {date}", { plan: tData(s.plan_name), date: formatDate(s.end_on) }))
                .join(" · "),
            })}
          </p>
        </Card>
      ) : null}

      {expiring.length ? (
        <Card className="mb-4 border border-hold/30 bg-hold/5">
          <p className="text-sm font-medium text-fg">{t("Plans expiring soon")}</p>
          <p className="mt-1 text-sm text-muted">
            {t("{plans}. Renew to keep your class seats.", {
              plans: expiring
                .map((s) =>
                  t("{plan}: {n} days left (until {date})", {
                    plan: tData(s.plan_name),
                    n: daysUntil(s.end_on),
                    date: formatDate(s.end_on),
                  }),
                )
                .join(" · "),
            })}
          </p>
          <ButtonLink to="/app/plans" size="sm" className="mt-3">
            {t("Renew")}
          </ButtonLink>
        </Card>
      ) : null}

      {error ? (
        <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
      ) : !me ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      ) : (
        <div className="grid gap-4 *:min-w-0 lg:grid-cols-[1.25fr_1fr]">
          {/* Next up comes first: it is the one thing on this page that changes what you do next. */}
          <Reveal className="lg:row-span-2">
            {next ? (
              <div className="next-free relative h-full overflow-hidden rounded-[var(--radius-xl)] bg-accent p-5 text-accent-fg sm:p-6">
                <div className="flex items-center justify-between gap-2 font-mono text-2xs font-bold uppercase tracking-wider">
                  <span>{t("Next up · today")}</span>
                  <span>{t(next.kind)}</span>
                </div>
                <p className="font-athletic mt-4 text-6xl leading-none tabular-nums sm:text-7xl">{hhmm(next.start)}</p>
                <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-lg font-bold">
                    {next.title}
                    <span className="font-normal opacity-70"> · {hhmm(next.start)}–{hhmm(next.end)}</span>
                  </p>
                  <span className="rounded-md bg-accent-fg px-2 py-0.5 font-mono text-2xs font-bold uppercase tracking-wider text-accent">
                    {statusLabel(next.status)}
                  </span>
                </div>
                <p className="mt-1 font-mono text-xs opacity-70">{next.meta}</p>
                <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-accent-fg/15 pt-4">
                  {next.status === "confirmed" && new Date(next.end) > new Date() ? (
                    <AddToCalendar
                      onLime
                      event={{ title: `${t(next.kind)} · ${next.title}`, start: next.start, end: next.end, details: next.meta, location: "Lê Long Sport" }}
                    />
                  ) : null}
                  <div className="ml-auto flex flex-wrap gap-2">
                    {actions(next, true)}
                    {/* Confirmed means the next step is the gate: the pass is one tap away. */}
                    {next.status === "confirmed" ? (
                      <ButtonLink
                        to="/app/pass"
                        size="sm"
                        className="bg-accent-fg text-accent hover:bg-accent-fg/90"
                      >
                        <QrCode className="size-4" aria-hidden />
                        {t("Show pass")}
                      </ButtonLink>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : (
              <Card className="flex h-full flex-col justify-between gap-6 p-6">
                <div>
                  <p className="font-mono text-2xs font-bold uppercase tracking-wider text-muted">{t("Next up · today")}</p>
                  <p className="font-display mt-3 text-3xl font-bold tracking-tight">{t("Nothing on the calendar.")}</p>
                  <p className="mt-1 text-sm text-muted">{t("Pick a free hour below, or join a class.")}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <ButtonLink to="/app/book" size="sm" className="shadow-[var(--shadow-accent)]">
                    {t("Book a court")}
                  </ButtonLink>
                  <ButtonLink to="/app/classes" size="sm" variant="outline">
                    {t("Join a class")}
                  </ButtonLink>
                </div>
              </Card>
            )}
          </Reveal>

          <PointsTile />
          <FreeTodayTile venue={venue} now={now} />

          {later.length ? (
            <div className="lg:col-span-2">
              <div className="mb-3 flex items-baseline justify-between">
                <SectionTitle text={t("Later today")} className="font-display text-lg tracking-tight" />
                <span className="text-xs text-muted">
                  {events.length === 1 ? t("1 session booked") : t("{n} sessions booked", { n: events.length })}
                </span>
              </div>
              <Stagger className="grid gap-3 sm:grid-cols-2" gap={0.06}>
                {later.map((ev) => (
                  <StaggerItem key={ev.id}>
                    <div className="h-full rounded-[var(--radius-lg)] border border-line bg-surface px-4 py-3 transition-colors duration-200 hover:border-line-strong">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-2xs font-bold uppercase tracking-wider text-muted">{t(ev.kind)}</span>
                        <StatusBadge status={ev.status} />
                      </div>
                      <p className="mt-2 font-display text-xl tracking-tight">
                        <span className="tabular-nums">{hhmm(ev.start)}</span> · {ev.title}
                      </p>
                      <div className="mt-1 flex min-h-8 items-center justify-between gap-2">
                        <p className="font-mono text-xs text-muted">{ev.meta}</p>
                        <div className="flex gap-2">{actions(ev)}</div>
                      </div>
                    </div>
                  </StaggerItem>
                ))}
              </Stagger>
            </div>
          ) : null}

          <div className="hidden lg:col-span-2 lg:block">
            <SectionTitle text={t("Quick actions")} className="font-display text-lg tracking-tight" />
            <Stagger className="mt-3 grid grid-cols-4 gap-3" gap={0.06}>
              {(
                [
                  { to: "/app/classes" as const, label: t("Classes"), Icon: Ticket },
                  { to: "/app/plans" as const, label: t("Plans"), Icon: Wallet },
                  { to: "/app/points" as const, label: t("Points"), Icon: Star },
                  { to: "/app/assistant" as const, label: t("Ask AI"), Icon: AssistantMark },
                ] as const
              ).map((a) => (
                <StaggerItem key={a.to}>
                  <Lift>
                    <SpotlightCard className="h-full rounded-[var(--radius-lg)]" size={200} strength={0.08}>
                      <Link
                        to={a.to}
                        className="group relative z-[2] flex h-full items-center gap-3 rounded-[var(--radius-lg)] border border-line bg-surface/85 px-4 py-3.5 transition-colors duration-200 hover:border-accent/40"
                      >
                        <span className="grid size-10 place-items-center rounded-[var(--radius-sm)] bg-wood text-accent transition-colors duration-200 group-hover:bg-accent group-hover:text-accent-fg">
                          <a.Icon className="size-5" strokeWidth={1.75} />
                        </span>
                        <span className="text-sm font-semibold tracking-tight text-fg">{a.label}</span>
                        <ArrowRight className="ml-auto size-4 text-muted transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-accent" />
                      </Link>
                    </SpotlightCard>
                  </Lift>
                </StaggerItem>
              ))}
            </Stagger>
          </div>
        </div>
      )}

      <div className="mt-10 flex items-end justify-between gap-3">
        <SectionTitle text={t("Notifications")} className="font-display text-2xl" />
        <Link to="/app/notifications" className="hit text-sm underline">
          {t("Open inbox")}
        </Link>
      </div>
      {me && me.inbox.length ? (
        <NotificationList
          items={me.inbox}
          limit={4}
          onRead={(ids) =>
            setMe((m) =>
              m
                ? {
                    ...m,
                    inbox: m.inbox.map((n) =>
                      ids.includes(n.id) && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n,
                    ),
                  }
                : m,
            )
          }
        />
      ) : null}
      {me && !me.inbox.length ? <p className="mt-3 text-sm text-muted">{t("Nothing here yet.")}</p> : null}
      <CancelBookingDialog
        bookingId={cancelId}
        open={cancelId != null}
        onClose={() => setCancelId(null)}
        onDone={reload}
      />
    </Shell>
  );
}

/** Until the client clock arrives (`now` is 0) the kicker stays neutral, so hydration matches. */
function greetingFor(now: number) {
  if (!now) return tk("Member");
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "numeric" }).format(now));
  return h < 12 ? tk("Good morning") : h < 18 ? tk("Good afternoon") : tk("Good evening");
}

/**
 * Seconds left on a deadline. It ticks every second, or once a minute when the member asked for
 * less motion: the number still tells the truth, it just stops flickering.
 */
function useSecondsLeft(iso: string) {
  const reduced = useReducedMotionAfterMount();
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, reduced ? 60_000 : 1000);
    return () => clearInterval(id);
  }, [iso, reduced]);
  return left;
}

function OfferCard({
  offer,
  onDone,
}: {
  offer: { id: string; expires_at: string; sport: string; level: string };
  onDone: () => void;
}) {
  const left = useSecondsLeft(offer.expires_at);
  const mm = left == null ? "--" : String(Math.floor(left / 60)).padStart(2, "0");
  const ss = left == null ? "--" : String(left % 60).padStart(2, "0");
  return (
    <div className="mb-4 flex flex-wrap items-center gap-4 rounded-[var(--radius-xl)] border border-clay/45 bg-clay/12 px-5 py-4">
      <div className="min-w-0 flex-1">
        <p className="font-mono text-2xs font-bold uppercase tracking-wider text-clay">{t("A waitlist seat opened up")}</p>
        <p className="mt-1 text-lg font-bold">
          {sportLabel(offer.sport)} · {levelLabel(offer.level)}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <span
          aria-label={t("Time left")}
          className={cn("font-display text-3xl tabular-nums", left != null && left < 60 ? "text-clay" : "text-fg")}
        >
          {left == null || left > 3600 ? hhmm(offer.expires_at) : `${mm}:${ss}`}
        </span>
        <Button
          size="sm"
          disabled={left === 0}
          onClick={async () => {
            try {
              const r = await apiPost<{ status?: string }>(`/waitlist/${offer.id}/accept`);
              toast.success(r?.status === "confirmed" ? t("You are enrolled") : t("Seat held. Pay before the timer runs out."));
              onDone();
            } catch (e) {
              toast.error(e instanceof Error ? tServer(e.message) : t("Offer expired"));
            }
          }}
        >
          {t("Claim seat")}
        </Button>
      </div>
    </div>
  );
}

/** The points balance as a ring toward the next tier: the ring is the distance left, not decoration. */
function PointsTile() {
  const { data } = useRead<Points>("/me/points?limit=1&offset=0");
  const reduced = useReducedMotionAfterMount();
  const need = data?.next_tier?.need ?? 0;
  const pct = !data ? 0 : data.next_tier ? Math.min(100, (data.earned / Math.max(1, data.earned + need)) * 100) : 100;
  const r = 42;
  const c = 2 * Math.PI * r;
  return (
    <Link
      to="/app/points"
      className="group flex items-center gap-5 rounded-[var(--radius-xl)] border border-line bg-surface p-5 transition-colors duration-200 hover:border-accent/40"
    >
      <div className="relative grid size-24 shrink-0 place-items-center">
        <svg className="absolute inset-0 size-full -rotate-90" viewBox="0 0 100 100" aria-hidden>
          <circle cx="50" cy="50" r={r} className="stroke-line" strokeWidth="8" fill="none" />
          <circle
            cx="50"
            cy="50"
            r={r}
            className={cn("stroke-accent drop-shadow-[0_0_6px_rgb(212_245_60/0.55)]", !reduced && "transition-[stroke-dashoffset] duration-1000 ease-out")}
            strokeWidth="8"
            strokeLinecap="round"
            fill="none"
            strokeDasharray={c}
            strokeDashoffset={c - (pct / 100) * c}
          />
        </svg>
        <span className="font-display text-xl font-bold tabular-nums">
          {data ? <CountUp to={data.points} format={(n) => Math.round(n).toLocaleString()} /> : "–"}
        </span>
      </div>
      <div className="min-w-0">
        <p className="font-mono text-2xs font-bold uppercase tracking-wider text-muted">{t("Points")}</p>
        <p className="mt-1 text-lg font-bold">{data ? tierName(data.tier) : "…"}</p>
        <p className="mt-0.5 text-sm text-muted">
          {data?.next_tier
            ? t("{n} more to {tier}", { n: need.toLocaleString(), tier: tierName(data.next_tier.key) })
            : data
              ? t("Top tier")
              : ""}
        </p>
      </div>
      <ArrowRight className="ml-auto size-4 shrink-0 text-muted transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-accent" />
    </Link>
  );
}

/** The next free hours today, earliest first: each chip opens the booking grid on that sport. */
function FreeTodayTile({ venue, now }: { venue: Venue; now: number }) {
  const { member_free_hours } = useLimits();
  const { data } = useRead<{ courts: Court[]; slots: OccSlot[] }>(`/occupancy?date=${todayISO()}`);
  const free = data && now ? freeHours(data.courts, data.slots, todayISO(), now, true, hoursOf(venue)) : null;
  return (
    <div className="rounded-[var(--radius-xl)] border border-line bg-surface p-5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-mono text-2xs font-bold uppercase tracking-wider text-muted">{t("Free courts today")}</p>
        <Link to="/app/book" className="hit text-xs font-semibold text-accent underline-offset-4 hover:underline">
          {t("All")} →
        </Link>
      </div>
      {free == null ? (
        <Skeleton className="mt-3 h-14" />
      ) : free.length ? (
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {free.slice(0, member_free_hours).map((f, i) => (
            <Link
              key={`${f.court.id}-${f.hour}`}
              to="/app/book"
              search={{ sport: f.court.sport }}
              className={cn(
                "flex min-w-16 shrink-0 flex-col items-center rounded-[var(--radius-md)] border px-3 py-2 transition-colors duration-200",
                i === 0
                  ? "border-accent/60 bg-accent/10 text-fg"
                  : "border-line bg-wood/50 text-fg hover:border-line-strong",
              )}
            >
              <span className="font-display text-base font-bold tabular-nums">{String(f.hour).padStart(2, "0")}:00</span>
              <span className="font-mono text-2xs text-muted">{f.court.court_code}</span>
            </Link>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted">{t("Every court is taken for the rest of today.")}</p>
      )}
    </div>
  );
}

function daysUntil(iso: string) {
  const a = Date.parse(`${todayISO()}T00:00:00+07:00`);
  const b = Date.parse(`${iso.slice(0, 10)}T00:00:00+07:00`);
  return Math.round((b - a) / 86400000);
}
