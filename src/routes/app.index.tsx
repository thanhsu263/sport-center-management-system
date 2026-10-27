import { createFileRoute, Link } from "@tanstack/react-router";
import { SectionTitle } from "@/components/section";
import { Map, Star, Ticket, Wallet } from "lucide-react";
import { AssistantMark } from "@/components/mark";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PassCard } from "@/components/media";
import { NotificationList, type Notification } from "@/components/notifications";
import { CancelBookingDialog } from "@/components/cancel-booking";
import { PayOnlineButton } from "@/components/pay-online";
import { Shell, hhmm } from "@/components/shell";
import { Button, ButtonLink, Card, EmptyState, LoadError, Skeleton, StatusBadge } from "@/components/ui";
import { Lift, Reveal, Stagger, StaggerItem } from "@/components/motion";
import { GlareHover, ShinyText, SplitText, SpotlightCard } from "@/components/fx";
import { apiGet, apiPost, getStoredUser } from "@/lib/arena3/client";
import { formatDate, levelLabel, planBenefits, sportLabel, todayISO } from "@/lib/arena3/labels";
import { t, tk, tData } from "@/lib/i18n";
import { useRead } from "@/lib/use-read";

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
    court_hours_left: string | number;
    session_left: number | null;
    plan_court_hours: number;
    plan_session_quota: number | null;
    court_discount_pct: number;
    sport_scope: string;
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

function Page() {
  const { data, error, reload } = useRead<Me>("/me");
  // The server's copy, with notifications marked read here as the member opens them.
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    setMe(data);
  }, [data]);
  const [cancelId, setCancelId] = useState<string | null>(null);
  // Whether the centre takes payment online at all.
  const [onlineOn, setOnlineOn] = useState(false);
  useEffect(() => {
    void apiGet<{ capabilities?: { online_payment?: boolean } }>("/flags")
      .then((r) => setOnlineOn(Boolean(r.capabilities?.online_payment)))
      .catch(() => setOnlineOn(false));
  }, []);
  const u = getStoredUser();
  const live = me?.subscriptions.filter((s) => s.status === "active") ?? [];
  const frozen = me?.subscriptions.filter((s) => s.status === "frozen") ?? [];
  const first = live[0];
  const greet = u?.full_name.split(" ").slice(-1)[0] ?? "";
  const expiring = live.filter((s) => {
    const d = daysUntil(s.end_on);
    return Number.isFinite(d) && d >= 0 && d <= 7;
  });

  const events = [
    ...(me?.today.classes ?? []).map((c) => ({
      id: `c-${c.id}`,
      start: c.start_at,
      kind: tk("Class"),
      title: `${sportLabel(c.sport)} · ${c.court_code}`,
      meta: c.coach_name,
      bookingId: null as string | null,
      status: "confirmed",
    })),
    ...(me?.today.bookings ?? []).map((b) => ({
      id: `b-${b.id}`,
      start: b.start_at,
      kind: tk("Court"),
      title: b.court_code,
      meta: b.code,
      bookingId: b.id,
      status: b.status,
    })),
  ].sort((a, b) => a.start.localeCompare(b.start));

  return (
    <Shell role="member">
      <div className="mb-6 flex items-end justify-between gap-3">
        <div>
          <ShinyText
            className="shiny-muted mb-1 block text-xs font-semibold"
            speed={6}
          >
            {t("Member")}
          </ShinyText>
          <SplitText
            as="h1"
            text={t("Welcome back, {name}", { name: greet })}
            stagger={0.02}
            duration={0.6}
            className="font-display text-3xl font-medium tracking-tight sm:text-4xl"
          />
        </div>
        {u?.member_code ? (
          <span className="shrink-0 rounded-[var(--radius-sm)] border border-line bg-surface px-2.5 py-1 font-mono text-xs font-semibold text-muted">
            {u.member_code}
          </span>
        ) : null}
      </div>

      {(me?.offers ?? []).length ? (
        <Card className="mb-4 border border-hold/30 bg-hold/5">
          <p className="text-sm font-medium">{t("A waitlist seat opened up")}</p>
          {(me?.offers ?? []).map((o) => (
            <div key={o.id} className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">
                {sportLabel(o.sport)} · {levelLabel(o.level)}
              </p>
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    await apiPost(`/waitlist/${o.id}/accept`);
                    toast.success(t("Seat claimed"));
                    reload();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : t("Offer expired"));
                  }
                }}
              >
                {t("Claim seat")}
              </Button>
            </div>
          ))}
        </Card>
      ) : null}

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
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <Reveal className="order-2" delay={0.08}>
            {first ? (
              <GlareHover className="rounded-[var(--radius-xl)]" duration={1.1}>
                <PassCard
                  plan={first.plan_name}
                  sport={sportLabel(first.sport_scope)}
                  endOn={formatDate(first.end_on)}
                  benefits={planBenefits(first)}
                  code={u?.member_code}
                />
              </GlareHover>
            ) : (
              <div className="rounded-[var(--radius-xl)] bg-pass p-6 text-pass-fg">
                <div className="flex items-center justify-between">
                  <span className="inline-block rounded-[var(--radius-sm)] border border-pass-fg/20 bg-volt/15 px-2.5 py-1 text-xs font-bold text-volt">
                    {t("Membership pass")}
                  </span>
                </div>
                <div className="mt-4">
                  <EmptyState title={t("No active plan")} hint={t("Buy a plan to enrol in classes and book courts.")}>
                    <ButtonLink to="/app/plans" className="bg-volt text-night font-semibold hover:bg-volt/90">{t("Browse plans")}</ButtonLink>
                  </EmptyState>
                </div>
              </div>
            )}
          </Reveal>

          <div className="order-3 hidden md:col-span-2 md:block">
            <SectionTitle text={t("Quick actions")} className="font-display text-lg tracking-tight" />
            <Stagger className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5" gap={0.06}>
              {(
                [
                  { to: "/app/book" as const, label: t("Book a court"), Icon: Map },
                  { to: "/app/classes" as const, label: t("Classes"), Icon: Ticket },
                  { to: "/app/plans" as const, label: t("Plans"), Icon: Wallet },
                  { to: "/app/points" as const, label: t("Points"), Icon: Star },
                  { to: "/app/assistant" as const, label: t("Ask AI"), Icon: AssistantMark },
                ] as const
              ).map((a) => (
                <StaggerItem key={a.to}>
                  <Lift>
                    <SpotlightCard className="h-full rounded-[var(--radius-md)]" size={200} strength={0.12}>
                      <Link
                        to={a.to}
                        className="group relative z-[2] flex h-full flex-col items-center justify-center rounded-[var(--radius-md)] border border-line bg-surface/85 px-2 py-4 text-center transition-colors duration-200 hover:border-accent/40"
                      >
                        <span className="mb-2.5 grid size-12 place-items-center rounded-[var(--radius-sm)] bg-wood text-accent transition-colors duration-200 group-hover:bg-accent group-hover:text-accent-fg">
                          <a.Icon className="size-6" strokeWidth={1.75} />
                        </span>
                        <span className="text-xs font-semibold tracking-tight text-fg">{a.label}</span>
                      </Link>
                    </SpotlightCard>
                  </Lift>
                </StaggerItem>
              ))}
            </Stagger>
          </div>

          {/* Today comes first: it is the one thing on this page that changes what you do next. */}
          <Reveal className="order-1">
            <SpotlightCard className="h-full rounded-[var(--radius-xl)]" size={340} strength={0.1}>
            <Card className="relative z-[2] h-full">
              <div className="mb-3 flex items-baseline justify-between">
                <p className="font-display text-xl">{t("Today")}</p>
                <span className="text-xs text-muted">
                  {events.length === 1 ? t("1 session booked") : t("{n} sessions booked", { n: events.length })}
                </span>
              </div>
              {events.length ? (
                <Stagger className="grid gap-3" gap={0.06}>
                  {events.map((ev) => (
                    <StaggerItem key={ev.id}>
                      <div className="rounded-[var(--radius-md)] bg-wood/50 px-4 py-3 transition-colors duration-200 hover:bg-wood">
                        <div className="flex items-center justify-between gap-2">
                          <span className="rounded-full bg-accent px-2.5 py-0.5 text-2xs font-semibold text-accent-fg">
                            {t(ev.kind)}
                          </span>
                          <StatusBadge status={ev.status} />
                        </div>
                        <p className="mt-2 font-display text-xl tracking-tight">
                          {hhmm(ev.start)} · {ev.title}
                        </p>
                        {/* The action shares the reference line rather than
                            claiming a row of its own. A court booking and a
                            class sitting next to each other used to differ by
                            a whole button in height purely because one of them
                            can be cancelled. */}
                        <div className="mt-1 flex min-h-8 items-center justify-between gap-2">
                          <p className="font-mono text-xs text-muted">{ev.meta}</p>
                          {/*
                            A held court can be paid for from here, not only
                            from the screen it was booked on. The booking page
                            keeps the hold in component state, so refreshing or
                            walking away left the member with a court they
                            could see, could cancel, and had no way to pay for
                            — it simply sat blocking the slot until it expired.
                          */}
                          {onlineOn && ev.bookingId && ev.status === "hold" ? (
                            <PayOnlineButton
                              refType="booking"
                              refId={ev.bookingId}
                              label={t("Pay online")}
                              onPaid={reload}
                            />
                          ) : null}
                          {ev.bookingId && (ev.status === "hold" || ev.status === "confirmed") ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setCancelId(ev.bookingId ?? null)}
                            >
                              {t("Cancel")}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </StaggerItem>
                  ))}
                </Stagger>
              ) : (
                <div className="mt-2">
                  <p className="text-sm text-muted">{t("Nothing on the calendar.")}</p>
                  <div className="mt-3 flex gap-2">
                    <ButtonLink to="/app/book" size="sm">
                      {t("Book a court")}
                    </ButtonLink>
                    <ButtonLink to="/app/classes" size="sm" variant="outline">
                      {t("Join a class")}
                    </ButtonLink>
                  </div>
                </div>
              )}
            </Card>
            </SpotlightCard>
          </Reveal>
        </div>
      )}

      {live.length > 1 ? (
        <Stagger className="mt-4 grid gap-3 md:grid-cols-3" gap={0.07}>
          {live.slice(1).map((s) => {
            // Each pack opens the screen it is spent on, already narrowed to its
            // sport: court hours go to the court map, class sessions to classes.
            const sport = s.sport_scope === "all" ? undefined : s.sport_scope;
            const forCourts = s.plan_court_hours > 0 || s.plan_session_quota == null;
            return (
              <StaggerItem key={s.id}>
                <Link to={forCourts ? "/app/book" : "/app/classes"} search={{ sport }} className="block h-full">
                  <Card interactive className="h-full">
                    <p className="text-2xs text-muted">{sportLabel(s.sport_scope)}</p>
                    <p className="mt-1 font-medium text-fg">{tData(s.plan_name)}</p>
                    <p className="text-sm text-muted">{t("Until {date}", { date: formatDate(s.end_on) })}</p>
                    <p className="text-sm text-muted">{planBenefits(s).join(" · ")}</p>
                  </Card>
                </Link>
              </StaggerItem>
            );
          })}
        </Stagger>
      ) : null}

      <div className="mt-8 flex items-end justify-between gap-3">
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

function daysUntil(iso: string) {
  const a = Date.parse(`${todayISO()}T00:00:00+07:00`);
  const b = Date.parse(`${iso.slice(0, 10)}T00:00:00+07:00`);
  return Math.round((b - a) / 86400000);
}
