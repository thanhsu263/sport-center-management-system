import { createFileRoute } from "@tanstack/react-router";
import { SectionTitle } from "@/client/components/section";
import { sessionDay } from "@/client/components/class-detail";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Shell, hhmm } from "@/client/components/shell";
import { Badge, Card, Check, EmptyState, LoadError, PageHero, Select, Skeleton } from "@/client/components/ui";
import { Lift, Stagger, StaggerItem, motion } from "@/client/components/motion";
import { SpotlightCard } from "@/client/components/fx";
import { ActivityRings, NextMilestoneCard, SessionCountdown, WorkoutStreak } from "@/client/components/training-progress";
import { apiPut } from "@/client/arena3/client";
import { addDaysISO, formatDate, levelLabel, sportLabel, todayISO } from "@/shared/arena3/labels";
import { t, tk } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";
import { AddToCalendar } from "@/client/components/class-extras";
import { CertificatesSection } from "@/client/components/member-certificates";

export const Route = createFileRoute("/app/train")({ component: Page });

const GOALS: Record<string, string> = {
  weight: tk("Lose weight"),
  technique: tk("Improve technique"),
  compete: tk("Compete"),
  fun: tk("Have fun"),
};
const METRIC_LABEL: Record<string, string> = {
  smash_count: tk("Smashes"),
  freethrow_pct: tk("Free throws"),
  serve_pct: tk("Serves in"),
};

type PlanBlock = { title: string; minutes: number; phase?: string };
type Plan = {
  id: string;
  title: string | null;
  payload: { goal?: string; blocks?: PlanBlock[]; note?: string };
};

type Progress = {
  goal: string | null;
  levels: Array<{ sport: string; level: string }>;
  next_sessions: Array<{
    id: string;
    start_at: string;
    end_at: string;
    sport: string;
    level: string;
    court_code: string;
    plans: Plan[];
  }>;
  results: Array<{
    session_id: string;
    plan_pct: number | null;
    metrics: Record<string, number> | null;
    note: string | null;
    start_at: string;
    sport: string;
  }>;
  reviews: Array<{
    id: string;
    sport: string;
    period_weeks: number;
    technique: number;
    fitness: number;
    attitude: number;
    comment: string | null;
    created_at: string;
    coach_name: string;
  }>;
  homework: Array<{
    id: string;
    title: string;
    body: string | null;
    checklist: string[];
    due_on: string | null;
    done_items: number[];
  }>;
};

const say = (e: unknown) => (e instanceof Error ? e.message : t("Something went wrong"));

function Page() {
  const { data, error, reload } = useRead<Progress>("/me/training");
  // The server's copy, with the member's ticks and goal shown here as soon as they are made.
  const [d, setD] = useState<Progress | null>(null);
  useEffect(() => {
    setD(data);
  }, [data]);

  async function setGoal(goal: string) {
    try {
      await apiPut("/me/training-goal", { goal: goal || null });
      setD((x) => (x ? { ...x, goal: goal || null } : x));
      toast.success(t("Goal saved"));
    } catch (e) {
      toast.error(say(e));
    }
  }

  async function tick(hw: Progress["homework"][number], index: number) {
    const done = hw.done_items.includes(index)
      ? hw.done_items.filter((i) => i !== index)
      : [...hw.done_items, index].sort((a, b) => a - b);
    // Show the tick at once; the server's answer says whether it finished the homework.
    setD((x) => x && { ...x, homework: x.homework.map((h) => (h.id === hw.id ? { ...h, done_items: done } : h)) });
    try {
      const r = await apiPut<{ completed: boolean }>(`/me/homework/${hw.id}`, { done_items: done });
      if (r.completed) {
        toast.success(t("Homework done. Nice work!"));
        setTimeout(() => setD((x) => x && { ...x, homework: x.homework.filter((h) => h.id !== hw.id) }), 700);
      }
    } catch (e) {
      toast.error(say(e));
      reload();
    }
  }

  return (
    <Shell role="member">
      <PageHero
        slot="banner.train"
        title={t("My progress")}
        subtitle={t("Your plans, homework and what your coach has noticed. AI only suggests; a coach approves what reaches you.")}
        fallbackSpot="chart"
        stats={[
          {
            label: t("Completed sessions"),
            value: d?.results?.length ?? 0,
          },
          {
            label: t("Upcoming sessions"),
            value: d?.next_sessions?.length ?? 0,
            live: Boolean(d?.next_sessions?.length),
          },
          {
            label: t("Homework left"),
            value: d?.homework?.length ?? 0,
          },
        ]}
      />
      {error ? (
        <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
      ) : !d ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="grid gap-8">
          <Card className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="kicker text-2xs text-muted">{t("Your goal")}</p>
              <Select className="mt-1.5" aria-label={t("Your goal")} value={d.goal ?? ""} onChange={(e) => void setGoal(e.target.value)}>
                <option value="">{t("Not set")}</option>
                {Object.entries(GOALS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {t(v)}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <p className="kicker text-2xs text-muted">{t("Your level")}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {d.levels.length ? (
                  d.levels.map((l) => (
                    <Badge key={l.sport} tone="accent">
                      {sportLabel(l.sport)} · {levelLabel(l.level)}
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-muted">{t("Your coach sets this after a few sessions.")}</span>
                )}
              </div>
            </div>
          </Card>

          {/* Activity Ring, Streak, Milestone */}
          {(() => {
            const realDone = d.results.length;
            const sessionDates = new Set(
              d.results.map((r) => {
                const dt = new Date(r.start_at);
                return new Intl.DateTimeFormat("en-CA", {
                  timeZone: "Asia/Ho_Chi_Minh",
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                }).format(dt);
              }),
            );
            const today = todayISO();
            const [y, m, dayNum] = today.split("-").map(Number);
            const todayDt = new Date(Date.UTC(y, (m ?? 1) - 1, dayNum ?? 1));
            const currentDayOfWeek = (todayDt.getUTCDay() + 6) % 7;
            const mondayISO = addDaysISO(today, -currentDayOfWeek);

            const activeDays: boolean[] = [];
            for (let i = 0; i < 7; i++) {
              const dayStr = addDaysISO(mondayISO, i);
              activeDays.push(sessionDates.has(dayStr));
            }

            let streak = 0;
            let checkDay = today;
            if (!sessionDates.has(checkDay)) {
              checkDay = addDaysISO(checkDay, -1);
            }
            while (sessionDates.has(checkDay)) {
              streak++;
              checkDay = addDaysISO(checkDay, -1);
            }

            const milestoneTarget = d.levels.length > 0 ? levelLabel(d.levels[0].level) : null;

            return (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Card className="p-0 flex items-center justify-center">
                  <ActivityRings sessionsDone={realDone} />
                </Card>
                <WorkoutStreak days={streak} activeDays={activeDays} />
                <NextMilestoneCard target={milestoneTarget} />
              </div>
            );
          })()}

          <section>
            <SectionTitle text={t("Up next")} className="font-display text-2xl" />
            {d.next_sessions.length ? (
              <Stagger className="mt-3 grid gap-3 md:grid-cols-2" gap={0.07}>
                {d.next_sessions.map((s) => (
                  <StaggerItem key={s.id} className="h-full">
                    <Lift className="h-full">
                      <SpotlightCard className="h-full rounded-[var(--radius-xl)]" size={320} strength={0.1}>
                        <Card interactive className="relative z-[2] h-full">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-2xs text-muted">
                              {sessionDay(s.start_at)} · {hhmm(s.start_at)} · {sportLabel(s.sport)} · {s.court_code}
                            </p>
                            <SessionCountdown startAt={s.start_at} />
                          </div>
                          <AddToCalendar
                            className="mt-1"
                            event={{
                              title: `${sportLabel(s.sport)} · ${levelLabel(s.level)}`,
                              start: s.start_at,
                              end: s.end_at,
                              location: `Lê Long Sport · ${t("Court {court}", { court: s.court_code })}`,
                            }}
                          />
                          {s.plans.length ? (
                            s.plans.map((p) => (
                              <div key={p.id} className="mt-3">
                                <h3 className="font-display text-xl">{p.title || p.payload.goal || t("Session plan")}</h3>
                                <ol className="mt-2 grid gap-1 text-sm">
                                  {(p.payload.blocks ?? []).map((b, i) => (
                                    <motion.li
                                      key={i}
                                      initial={{ opacity: 0, x: -8 }}
                                      whileInView={{ opacity: 1, x: 0 }}
                                      viewport={{ once: true }}
                                      transition={{ duration: 0.3, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}
                                    >
                                      {i + 1}. {b.title} <span className="tabular-nums text-muted">{b.minutes}′</span>
                                      {b.phase ? <span className="text-muted"> · {b.phase}</span> : null}
                                    </motion.li>
                                  ))}
                                </ol>
                                {p.payload.note ? <p className="mt-2 text-xs text-muted">{p.payload.note}</p> : null}
                              </div>
                            ))
                          ) : (
                            <p className="mt-3 text-sm text-muted">{t("Your coach hasn't posted a plan for this one yet.")}</p>
                          )}
                        </Card>
                      </SpotlightCard>
                    </Lift>
                  </StaggerItem>
                ))}
              </Stagger>
            ) : (
              <div className="mt-3">
                <EmptyState title={t("No sessions coming up")} hint={t("Join a class and its plans show up here.")} />
              </div>
            )}
          </section>

          <section>
            <SectionTitle text={t("Homework")}className="font-display text-2xl" />
            {d.homework.length ? (
              <div className="mt-3 grid gap-3">
                {d.homework.map((h) => (
                  <Card key={h.id}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="font-medium">{h.title}</h3>
                      <span className="text-xs text-muted">{h.due_on ? t("Due {date}", { date: formatDate(h.due_on) }) : t("No due date")}</span>
                    </div>
                    {h.body ? <p className="mt-1 whitespace-pre-wrap text-sm text-muted [overflow-wrap:anywhere]">{h.body}</p> : null}
                    <ul className="mt-3 grid gap-1">
                      {h.checklist.map((item, i) => (
                        <li key={i}>
                          <Check
                            checked={h.done_items.includes(i)}
                            onChange={() => void tick(h, i)}
                            label={<span className={h.done_items.includes(i) ? "text-muted line-through" : ""}>{item}</span>}
                          />
                        </li>
                      ))}
                    </ul>
                  </Card>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted">{t("Nothing to do right now.")}</p>
            )}
          </section>

          <section>
            <SectionTitle text={t("Coach reviews")}className="font-display text-2xl" />
            <div className="mt-3 grid gap-2">
              {d.reviews.length ? (
                d.reviews.map((r) => (
                  <Card key={r.id} className="p-4">
                    <p className="text-xs text-muted">
                      {t("{date} · {sport} · last {n} weeks · {coach}", {
                        date: formatDate(r.created_at),
                        sport: sportLabel(r.sport),
                        n: r.period_weeks,
                        coach: r.coach_name,
                      })}
                    </p>
                    <p className="mt-1 text-sm">
                      {t("Technique {a}/5 · Fitness {b}/5 · Attitude {c}/5", {
                        a: r.technique,
                        b: r.fitness,
                        c: r.attitude,
                      })}
                    </p>
                    {r.comment ? <p className="mt-1 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{r.comment}</p> : null}
                  </Card>
                ))
              ) : (
                <p className="text-sm text-muted">{t("No reviews yet.")}</p>
              )}
            </div>
          </section>

          <CertificatesSection />

          <section>
            <SectionTitle text={t("Recent sessions")}className="font-display text-2xl" />
            <div className="mt-3 grid gap-2">
              {d.results.length ? (
                d.results.map((r) => (
                  <Card key={r.session_id} className="p-4">
                    <p className="text-xs text-muted">
                      {formatDate(r.start_at)} · {sportLabel(r.sport)}
                    </p>
                    <p className="mt-1 text-sm">
                      {r.plan_pct == null ? t("Session logged") : t("{n}% of the plan", { n: r.plan_pct })}
                      {Object.entries(r.metrics ?? {}).map(([k, v]) => ` · ${METRIC_LABEL[k] ? t(METRIC_LABEL[k]) : k} ${v}`)}
                    </p>
                    {r.note ? <p className="mt-1 text-sm text-muted">{r.note}</p> : null}
                  </Card>
                ))
              ) : (
                <p className="text-sm text-muted">{t("Your coach's notes from each session appear here.")}</p>
              )}
            </div>
          </section>
        </div>
      )}
    </Shell>
  );
}
