import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Award, CalendarDays, ChevronRight, ClipboardCheck, MapPin, Users } from "lucide-react";
import { sessionDay } from "@/client/components/class-detail";
import { ArenaIcon, SportIcon } from "@/client/components/arena-icons";
import { Shell, hhmm } from "@/client/components/shell";
import { UserAvatar } from "@/client/components/user-avatar";
import { PageHero } from "@/client/components/page-hero";
import { SportBadge } from "@/client/components/sports-ui";
import { SessionCountdown } from "@/client/components/training-progress";
import { SpotlightCard } from "@/client/components/fx";
import { cn } from "@/client/lib/cn";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  LoadError,
  Skeleton,
  StatusBadge,
} from "@/client/components/ui";
import { levelLabel, sportLabel } from "@/shared/arena3/labels";
import { locale, t } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";
import { useLimits } from "@/client/lib/use-centre";
import { AddToCalendar, MinSizeBadge } from "@/client/components/class-extras";
import { CertificationsModal } from "@/client/components/coach-certifications";
import { getStoredUser } from "@/client/arena3/client";

export const Route = createFileRoute("/coach/")({
  component: Page,
});

export type CoachSession = {
  id: string;
  start_at: string;
  end_at: string;
  level: string;
  sport: string;
  court_code: string;
  enrolled_count: number;
  capacity: number;
  min_enrolled?: number | null;
  class_id: string;
  class_code: string;
  status: string;
};

/** The centre's calendar day of an instant, for grouping — "2026-10-21". */
function dayKey(iso: string) {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
}

function dayName(iso: string) {
  const today = dayKey(new Date().toISOString());
  const tomorrow = dayKey(new Date(Date.now() + 864e5).toISOString());
  const k = dayKey(iso);
  if (k === today) return t("Today");
  if (k === tomorrow) return t("Tomorrow");
  return sessionDay(iso);
}

/** Students still missing before a scheduled session reaches its minimum; 0 when it will run. */
function shortBy(s: CoachSession) {
  if (!s.min_enrolled || s.status !== "scheduled") return 0;
  return Math.max(0, s.min_enrolled - s.enrolled_count);
}

function Page() {
  const navigate = useNavigate();
  const read = useRead<{ items: CoachSession[] }>("/coach/schedule");
  // null = not answered yet (or failed); [] = the centre really has nothing for this coach.
  const items = read.data?.items ?? null;

  const [certsOpen, setCertsOpen] = useState(false);
  // Two weeks of sessions is a wall; the next few days answer "what am I teaching", the rest on demand.
  const [daysShown, setDaysShown] = useState(DAYS_STEP);
  const me = getStoredUser();

  const take = (id: string) => void navigate({ to: "/coach/attendance", search: { session: id } });

  // The first session still to come is the one to act on; everything else is a timeline under it.
  const next = items?.find(
    (s) => s.status === "scheduled" && new Date(s.end_at).getTime() > Date.now(),
  );
  const rest = (items ?? []).filter((s) => s.id !== next?.id);
  const days = new Map<string, CoachSession[]>();
  for (const s of rest) {
    const k = dayKey(s.start_at);
    days.set(k, [...(days.get(k) ?? []), s]);
  }
  const short = (items ?? []).filter((s) => shortBy(s) > 0);

  return (
    <Shell role="coach">
      <PageHero
        slot="banner.coach"
        display
        title={t("Schedule")}
        subtitle={t("Every session you teach, by day. Tap one to take its register.")}
        stats={[
          { label: t("Upcoming sessions"), value: items?.length ?? 0 },
          { label: t("Enrolled students"), value: items ? items.reduce((s, x) => s + x.enrolled_count, 0) : 0 },
        ]}
        action={
          me ? (
            <Button variant="outline" size="sm" onClick={() => setCertsOpen(true)}>
              <Award className="mr-1.5 size-4" aria-hidden />
              {t("My certifications")}
            </Button>
          ) : null
        }
      />
      <CertificationsModal
        coachId={certsOpen && me ? me.id : null}
        coachName={me?.full_name ?? ""}
        onClose={() => setCertsOpen(false)}
      />
      {read.error ? (
        <LoadError
          message={read.error.message}
          onRetry={read.error.refused ? undefined : read.reload}
        />
      ) : !items ? (
        <div className="grid gap-3">
          <Skeleton className="h-44" />
          <Skeleton className="h-32" />
        </div>
      ) : !items.length ? (
        <EmptyState
          title={t("No sessions coming up")}
          hint={t(
            "When the manager publishes a class with you as coach, its sessions appear here.",
          )}
        />
      ) : (
        <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[1.4fr_1fr] lg:items-start">
          <div className="grid gap-8">
            {next ? (
              <section aria-label={t("Next session")}>
                <div className="mb-2 flex items-center justify-between">
                  <p className="inline-flex items-center gap-1.5 font-mono text-2xs font-semibold uppercase tracking-[0.18em] text-accent-2">
                    <ArenaIcon name="whistle" motion="wiggle" className="size-5" />
                    {t("Next session")}
                  </p>
                  <SessionCountdown startAt={next.start_at} />
                </div>
                <SpotlightCard className="next-free rounded-[var(--radius-xl)]" size={420} strength={0.08}>
                  <Card className="relative z-[2] grid gap-5 border border-accent/40 bg-accent/[0.05] p-5 sm:p-6">
                    <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                      <CalendarDays aria-hidden className="size-4" />
                      <span className="font-semibold text-fg">{dayName(next.start_at)}</span>
                      <span aria-hidden>·</span>
                      <span>{sessionDay(next.start_at)}</span>
                    </div>
                    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
                      <p className="font-athletic text-6xl leading-none tabular-nums sm:text-7xl">
                        <span className="lime-glow-text">{hhmm(next.start_at)}</span>
                        <span className="ml-2 align-top font-mono text-base font-medium normal-case text-muted">
                          –{hhmm(next.end_at)}
                        </span>
                      </p>
                      <div className="flex items-center gap-2">
                        <SportBadge sport={next.sport} />
                        <Badge tone="muted">{levelLabel(next.level)}</Badge>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                      <span className="inline-flex items-center gap-1.5">
                        <MapPin aria-hidden className="size-4 text-muted" />
                        {t("Court {court}", { court: next.court_code })}
                      </span>
                      <span className="inline-flex items-center gap-1.5 tabular-nums">
                        <Users aria-hidden className="size-4 text-muted" />
                        {t("{enrolled}/{capacity} students", {
                          enrolled: next.enrolled_count,
                          capacity: next.capacity,
                        })}
                      </span>
                      <MinSizeBadge enrolled={next.enrolled_count} min={next.min_enrolled} />
                      <AddToCalendar
                        event={{
                          title: `${sportLabel(next.sport)} · ${levelLabel(next.level)} · ${next.class_code}`,
                          start: next.start_at,
                          end: next.end_at,
                          location: `Lê Long Sport · ${t("Court {court}", { court: next.court_code })}`,
                        }}
                      />
                    </div>
                    {/* Fill against capacity; the tick marks the minimum that makes the class run. */}
                    <div aria-hidden className="relative h-2 overflow-hidden rounded-full bg-line/60">
                      <div
                        className={`h-full rounded-full transition-[width] duration-700 ${
                          next.enrolled_count >= (next.min_enrolled ?? 0) ? "bg-accent" : "bg-clay"
                        }`}
                        style={{ width: `${Math.min(100, (next.enrolled_count / Math.max(1, next.capacity)) * 100)}%` }}
                      />
                      {(next.min_enrolled ?? 0) > 0 ? (
                        <span
                          className="absolute inset-y-0 w-0.5 bg-fg/70"
                          style={{ left: `${Math.min(100, ((next.min_enrolled ?? 0) / Math.max(1, next.capacity)) * 100)}%` }}
                        />
                      ) : null}
                    </div>
                    <NextSessionStudents sessionId={next.id} />
                    <Button
                      size="lg"
                      className="w-full sm:w-auto sm:justify-self-start"
                      onClick={() => take(next.id)}
                    >
                      <ClipboardCheck aria-hidden className="size-5" />
                      {t("Take register")}
                    </Button>
                  </Card>
                </SpotlightCard>
              </section>
            ) : null}

            <CoachWeeklyStrip items={items} />

            {rest.length ? (
              <section aria-label={t("Coming up")} className="grid gap-6">
                <p className="font-mono text-2xs font-semibold uppercase tracking-[0.18em] text-muted">
                  {t("Coming up")}
                </p>
                {[...days.entries()].slice(0, daysShown).map(([k, list]) => (
                  <div key={k}>
                    <h2 className="mb-2 flex items-baseline justify-between gap-3 font-display text-lg font-bold tracking-tight">
                      {dayName(list[0]!.start_at)}
                      <span className="font-mono text-2xs font-semibold uppercase tracking-wider text-muted">
                        {list.length}
                      </span>
                    </h2>
                    <ol className="grid gap-2">
                      {list.map((s) => (
                        <TimelineRow key={s.id} s={s} onOpen={() => take(s.id)} />
                      ))}
                    </ol>
                  </div>
                ))}
                {days.size > daysShown ? (
                  <div>
                    <Button variant="outline" onClick={() => setDaysShown((n) => n + DAYS_STEP)}>
                      {t("Show more days")}
                    </Button>
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>

          <aside className="grid gap-6 lg:sticky lg:top-24">
            <BelowMinimum list={short} onOpen={take} />
          </aside>
        </div>
      )}
    </Shell>
  );
}

const DAYS_STEP = 4;

function TimelineRow({ s, onOpen }: { s: CoachSession; onOpen: () => void }) {
  const need = shortBy(s);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "group flex min-h-16 w-full items-center gap-4 rounded-[var(--radius-lg)] border bg-surface py-3 pl-4 pr-3 text-left transition-colors hover:border-accent/40 hover:bg-wood/60",
          need ? "border-clay/40" : "border-line",
        )}
      >
        <span
          aria-hidden
          className={cn("h-10 w-1 shrink-0 rounded-full", need ? "bg-clay" : "bg-accent/60")}
        />
        <span className="w-14 shrink-0 font-mono text-base font-semibold tabular-nums sm:w-16">
          {hhmm(s.start_at)}
          <span className="block text-xs font-normal text-muted">{hhmm(s.end_at)}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 font-semibold">
              <SportIcon sport={s.sport} className="size-4 text-accent" />
              {sportLabel(s.sport)}
            </span>
            <Badge tone="muted">{levelLabel(s.level)}</Badge>
            {s.status !== "scheduled" ? <StatusBadge status={s.status} /> : null}
          </span>
          <span className="mt-0.5 block text-sm text-muted tabular-nums">
            {t("Court {court} · {enrolled}/{capacity} students", {
              court: s.court_code,
              enrolled: s.enrolled_count,
              capacity: s.capacity,
            })}
          </span>
        </span>
        {need ? (
          <span className="shrink-0 rounded-md border border-clay/50 bg-clay/15 px-2 py-0.5 font-mono text-2xs font-semibold uppercase text-clay">
            {t("Needs {n}", { n: need })}
          </span>
        ) : null}
        <ChevronRight aria-hidden className="size-5 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" />
      </button>
    </li>
  );
}

/** Sessions that will not run unless more students enrol: the one thing a coach can still change. */
function BelowMinimum({ list, onOpen }: { list: CoachSession[]; onOpen: (id: string) => void }) {
  const { coach_below_min } = useLimits();
  return (
    <section aria-label={t("Below minimum")}>
      <p className="mb-2 font-mono text-2xs font-semibold uppercase tracking-[0.18em] text-muted">
        {t("Below minimum")}
      </p>
      <Card className={cn("p-4", list.length ? "border-clay/40" : "")}>
        {list.length ? (
          <>
            <p className="mb-3 text-sm text-muted">
              {t("These sessions only run if more students enrol.")}
            </p>
            <ul className="grid gap-2">
              {list.slice(0, coach_below_min).map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(s.id)}
                    className="flex w-full items-center justify-between gap-3 rounded-[var(--radius-md)] px-2 py-1.5 text-left text-sm hover:bg-wood/60"
                  >
                    <span className="min-w-0 truncate">
                      <span className="font-semibold">{sportLabel(s.sport)}</span>{" "}
                      <span className="text-muted">
                        · {dayName(s.start_at)} {hhmm(s.start_at)}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-2xs font-semibold uppercase text-clay">
                      {t("Needs {n}", { n: shortBy(s) })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-muted">{t("Every session has enough students to run.")}</p>
        )}
      </Card>
    </section>
  );
}

function NextSessionStudents({ sessionId }: { sessionId: string }) {
  const read = useRead<{ items: Array<{ id: string; full_name: string; member_code: string | null; avatar_url?: string | null }> }>(
    `/sessions/${sessionId}/attendance`
  );
  const students = read.data?.items ?? [];

  return (
    <div className="mt-2 border-t border-line/50 pt-3">
      <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-muted">
        {t("Enrolled students")} ({students.length})
      </p>
      {students.length === 0 ? (
        <p className="text-xs text-muted">{t("No students enrolled yet")}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {students.map((st) => (
            <div
              key={st.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-wood/40 px-2.5 py-1 text-xs"
              title={st.member_code ? `${st.full_name} (${st.member_code})` : st.full_name}
            >
              <div className="size-5 shrink-0">
                <UserAvatar name={st.full_name} url={st.avatar_url} />
              </div>
              <span className="font-medium">{st.full_name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The next seven days as bars: each column's height is how many sessions the coach teaches that
 * day, so a busy week reads at a glance before anything is opened. Today is outlined.
 */
function CoachWeeklyStrip({ items }: { items: CoachSession[] }) {
  const sessionDays = new Map<string, number>();
  for (const s of items) {
    const k = dayKey(s.start_at);
    sessionDays.set(k, (sessionDays.get(k) ?? 0) + 1);
  }
  const daysList: Array<{ date: string; dayName: string; dayNum: number; count: number }> = [];

  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getTime() + i * 864e5);
    const key = dayKey(d.toISOString());
    daysList.push({
      date: key,
      dayName: d.toLocaleDateString(locale(), { weekday: "short", timeZone: "Asia/Ho_Chi_Minh" }),
      dayNum: Number(key.slice(8)),
      count: sessionDays.get(key) ?? 0,
    });
  }
  const busiest = Math.max(1, ...daysList.map((d) => d.count));

  return (
    <section aria-label={t("Weekly schedule")}>
      <p className="mb-2 font-mono text-2xs font-semibold uppercase tracking-[0.18em] text-muted">
        {t("Weekly schedule")}
      </p>
      <div className="grid grid-cols-7 gap-1.5 rounded-[var(--radius-xl)] border border-line bg-surface p-2 shadow-[var(--shadow-border)]">
        {daysList.map((d, i) => (
          <div
            key={d.date}
            className={cn(
              "flex flex-col items-center gap-1.5 rounded-[var(--radius-lg)] px-1 pb-2 pt-2.5 text-center",
              i === 0 ? "border border-accent/40 bg-accent/10" : "border border-transparent",
            )}
          >
            <span className="text-2xs uppercase text-muted">{d.dayName}</span>
            <span className={cn("font-athletic text-lg leading-none", i === 0 && "text-accent")}>{d.dayNum}</span>
            <span className="flex h-12 w-full items-end justify-center" aria-hidden>
              <span
                className={cn("w-3 rounded-full", d.count ? (i === 0 ? "bg-accent" : "bg-accent-2/70") : "h-1 bg-line")}
                style={d.count ? { height: `${Math.round((d.count / busiest) * 100)}%`, minHeight: "0.5rem" } : undefined}
              />
            </span>
            <span className="font-mono text-2xs tabular-nums text-muted">
              {d.count ? d.count : "·"}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
