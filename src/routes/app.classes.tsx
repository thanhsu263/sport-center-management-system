import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Cover, MediaCaption, sportPhoto } from "@/components/media";
import { MyAttendance } from "@/components/my-attendance";
import { Shell, when } from "@/components/shell";
import { Badge, Button, ButtonLink, Card, EmptyState, LoadError, Modal, PageHero, Seg, Select, ShowMore, Skeleton, SportBadge, useSports } from "@/components/ui";
import { Lift, Stagger, StaggerItem, motion } from "@/components/motion";
import { GlareHover, SpotlightCard } from "@/components/fx";
import { cn } from "@/lib/cn";
import { apiDelete, apiPost } from "@/lib/arena3/client";
import { levelLabel, parseWeeklyRrule, rruleLabel, sportLabel } from "@/lib/arena3/labels";
import { locale, t } from "@/lib/i18n";
import { useRead } from "@/lib/use-read";
import { HighlightBadge, useLive } from "@/lib/use-live";

export const Route = createFileRoute("/app/classes")({
  validateSearch: (s: Record<string, unknown>): { sport?: string } => ({
    sport: typeof s.sport === "string" && s.sport.trim() ? s.sport.trim() : undefined,
  }),
  component: Page,
});

type Cl = {
  id: string;
  sport: string;
  level: string;
  capacity: number;
  enrolled_count: number;
  court_code: string;
  coach_name: string;
  rrule: string;
  duration_min: number;
  status: string;
};

type Enr = {
  id: string;
  class_id: string;
  status: string;
  waitlist_pos: number | null;
  /** The class's next scheduled session, and the last moment leaving is allowed (BR-24). */
  next_session_at?: string | null;
  leave_until?: string | null;
};
/** What enrolling in a sport would take, from the plan enrolment picks (BR-19, BR-20). */
type Access = { covered: boolean; session_left: number | null };
type Offer = { id: string; class_id: string; expires_at: string; sport: string; level: string };

function Page() {
  const classesRead = useRead<{ items: Cl[] }>("/classes");
  const meRead = useRead<{ enrollments?: Enr[]; offers?: Offer[]; class_access?: Record<string, Access> }>("/me");
  // The list is only shown once the member's own enrolments are known too: without them every class would read "Enrol".
  const items = classesRead.data && meRead.data ? classesRead.data.items : null;
  const mine = meRead.data?.enrollments ?? [];
  const offers = meRead.data?.offers ?? [];
  const failure = classesRead.error ?? meRead.error;
  const [sport, setSport] = useState(Route.useSearch().sport ?? "");
  const load = () => {
    classesRead.reload();
    meRead.reload();
  };
  useLive("classes", load);

  const sports = useSports();
  const [limit, setLimit] = useState(6);
  // The member's own classes come first (C-4): they are what someone opens this page to manage.
  const enrolledIds = new Set(mine.map((e) => e.class_id));
  // Narrowing by coach, weekday and part of the day saves scrolling through every class.
  const [coach, setCoach] = useState("");
  const [day, setDay] = useState("");
  const [part, setPart] = useState("");
  const coachNames = [...new Set((items ?? []).filter((c) => !sport || c.sport === sport).map((c) => c.coach_name))].sort((a, b) =>
    a.localeCompare(b, "vi"),
  );
  const matching = (items ?? [])
    .filter((c) => !sport || c.sport === sport)
    .filter((c) => !coach || c.coach_name === coach)
    .filter((c) => {
      if (!day && !part) return true;
      const p = parseWeeklyRrule(c.rrule);
      if (day && !p.days.includes(day)) return false;
      if (part === "morning") return p.hour < 12;
      if (part === "afternoon") return p.hour >= 12 && p.hour < 17;
      if (part === "evening") return p.hour >= 17;
      return true;
    })
    .sort((a, b) => Number(enrolledIds.has(b.id)) - Number(enrolledIds.has(a.id)));
  const shown = matching.slice(0, limit);
  useEffect(() => setLimit(6), [sport, coach, day, part]);
  const byClass = Object.fromEntries(mine.map((e) => [e.class_id, e]));
  const access = meRead.data?.class_access ?? {};
  // Leaving a class (or the waitlist) is asked twice: one tap used to give the seat away.
  const [leaving, setLeaving] = useState<{ enr: Enr; cls: Cl } | null>(null);
  const [leaveBusy, setLeaveBusy] = useState(false);
  async function leave() {
    if (!leaving || leaveBusy) return;
    setLeaveBusy(true);
    try {
      await apiDelete(`/enrollments/${leaving.enr.id}`);
      toast.success(leaving.enr.status === "waitlisted" ? t("Left the waitlist") : t("Enrolment cancelled"));
      setLeaving(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Could not cancel"));
    } finally {
      setLeaveBusy(false);
    }
  }

  return (
    <Shell role="member">
      <PageHero
        slot="banner.classes"
        title={t("Classes")}
        subtitle={t("Enrol by sport. When a class is full you join a first-come waitlist.")}
        fallbackSpot="whistle"
        stats={[
          {
            label: t("Active classes"),
            value: items?.length ?? 0,
          },
          {
            label: t("Your enrolments"),
            value: mine.length,
            live: mine.length > 0,
          },
          {
            label: t("Sports"),
            value: sports.length,
          },
        ]}
      />
      {offers.length ? (
        <Card className="mb-4 border border-hold/30 bg-hold/5">
          <p className="text-sm font-medium">{t("A waitlist seat opened up")}</p>
          {offers.map((o) => (
            <div key={o.id} className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">
                {t("{sport} · {level}: claim before {time}", {
                  sport: sportLabel(o.sport),
                  level: levelLabel(o.level),
                  time: new Date(o.expires_at).toLocaleTimeString(locale(), {
                    timeZone: "Asia/Ho_Chi_Minh",
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  }),
                })}
              </p>
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    await apiPost(`/waitlist/${o.id}/accept`);
                    toast.success(t("Seat claimed"));
                    load();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : t("This offer has expired"));
                  }
                }}
              >
                {t("Claim seat")}
              </Button>
            </div>
          ))}
        </Card>
      ) : null}
      <div className="mb-4">
        <Seg
          value={sport}
          onChange={setSport}
          options={[
            { value: "", label: t("All") },
            ...sports.map((s) => ({
              value: s.code,
              label: locale() === "vi" ? s.name_vi : s.name_en,
            })),
          ]}
        />
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <Select aria-label={t("Coach")} value={coach} onChange={(e) => setCoach(e.target.value)}>
            <option value="">{t("All coaches")}</option>
            {coachNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
          <Select aria-label={t("Day")} value={day} onChange={(e) => setDay(e.target.value)}>
            <option value="">{t("Any day")}</option>
            {[
              ["MO", t("Mon")],
              ["TU", t("Tue")],
              ["WE", t("Wed")],
              ["TH", t("Thu")],
              ["FR", t("Fri")],
              ["SA", t("Sat")],
              ["SU", t("Sun")],
            ].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
          <Select aria-label={t("Time of day")} value={part} onChange={(e) => setPart(e.target.value)}>
            <option value="">{t("Any time")}</option>
            <option value="morning">{t("Morning (before 12:00)")}</option>
            <option value="afternoon">{t("Afternoon (12:00-17:00)")}</option>
            <option value="evening">{t("Evening (from 17:00)")}</option>
          </Select>
        </div>
      </div>
      {failure ? (
        <LoadError message={failure.message} onRetry={failure.refused ? undefined : load} />
      ) : !items ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : (
        <Stagger className="grid gap-3 md:grid-cols-2" gap={0.07}>
          {shown.map((c) => {
            const full = c.enrolled_count >= c.capacity;
            const pct = Math.min(100, Math.round((c.enrolled_count / Math.max(1, c.capacity)) * 100));
            const enr = byClass[c.id];
            return (
              <StaggerItem key={c.id} className="h-full">
              <Lift className="h-full">
              <SpotlightCard className="h-full rounded-[var(--radius-xl)]" size={340} strength={0.11}>
              <Card interactive className="relative z-[2] flex h-full flex-col overflow-hidden p-0">
                <GlareHover>
                  <Cover slot={sportPhoto(c.sport)} alt="" scrim="none" className="h-28 sm:h-32">
                    <MediaCaption className="flex items-end justify-between">
                      <SportBadge sport={c.sport} className="bg-surface/90 text-fg backdrop-blur-xs" />
                      <p className="tabular-nums text-sm font-semibold">
                        <HighlightBadge value={c.enrolled_count}>{c.enrolled_count}</HighlightBadge>/{c.capacity}
                      </p>
                    </MediaCaption>
                  </Cover>
                </GlareHover>
                <div className="flex flex-1 flex-col p-5">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-display text-2xl">{levelLabel(c.level)}</h2>
                    <span className="rounded-[var(--radius-pill)] border border-line bg-wood/50 px-2 py-0.5 text-2xs font-medium text-muted">
                      {c.court_code}
                    </span>
                  </div>
                  <div className="mt-2.5 flex items-center gap-2.5 border-t border-line/60 pt-2.5">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent/10 font-bold text-xs text-accent-2 border border-accent/20">
                      {c.coach_name ? c.coach_name.split(" ").slice(-2).map((w) => w[0]).join("").toUpperCase() : "HLV"}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-fg">{c.coach_name}</p>
                      <p className="text-2xs text-muted">{rruleLabel(c.rrule, c.duration_min)}</p>
                    </div>
                  </div>
                  <div className="mt-4 flex items-baseline justify-between gap-2 text-2xs">
                    <span className="text-muted">{full ? t("Full") : t("{n} seats left", { n: c.capacity - c.enrolled_count })}</span>
                    <span className="tabular-nums text-subtle">{pct}%</span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-wood">
                    <motion.div
                      className={cn("h-full rounded-full", full ? "bg-danger" : pct >= 80 ? "bg-hold" : "bg-accent")}
                      initial={{ width: 0 }}
                      animate={{ width: `${pct}%` }}
                      transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                    />
                  </div>
                  {/* `mt-auto` pins the action to the bottom of the card. The
                      cards in a row stretch to the tallest one, and without it
                      each button sat directly under its own text — so a row of
                      four classes showed four buttons at four heights. */}
                  <div className="mt-auto pt-5">
                  {enr?.status === "confirmed" ? (
                    (() => {
                      const locked = !!enr.leave_until && Date.now() >= new Date(enr.leave_until).getTime();
                      return (
                        <div className="grid gap-2">
                          <Badge tone="accent" className="w-fit">
                            {t("You are in this class")}
                          </Badge>
                          {locked ? (
                            <p className="text-xs text-muted">
                              {t("Leaving closes {hours} hours before a session. The next one starts {when}; ask the front desk if you cannot come.", {
                                hours: Math.round((new Date(enr.next_session_at!).getTime() - new Date(enr.leave_until!).getTime()) / 3600000),
                                when: when(enr.next_session_at!),
                              })}
                            </p>
                          ) : null}
                          <Button
                            className="w-full"
                            variant="ghost"
                            disabled={locked}
                            onClick={() => setLeaving({ enr, cls: c })}
                          >
                            {t("Leave class…")}
                          </Button>
                        </div>
                      );
                    })()
                  ) : enr?.status === "waitlisted" ? (
                    <div className="grid gap-2">
                      {/* The position is a status, not part of the button that leaves (C-1). */}
                      <Badge tone="hold" className="w-fit">
                        {t("Waitlist position #{pos}", { pos: enr.waitlist_pos ?? "-" })}
                      </Badge>
                      <Button className="w-full" variant="ghost" onClick={() => setLeaving({ enr, cls: c })}>
                        {t("Leave the waitlist…")}
                      </Button>
                    </div>
                  ) : (
                    (() => {
                      // Said before the tap, not after (C-2, C-3): whether the member can enrol, and what
                      // it costs them. The server applies the same rules (BR-19, BR-20).
                      const a = access[c.sport];
                      if (!a?.covered) {
                        return (
                          <div className="grid gap-2">
                            <p className="text-sm text-muted">{t("Needs a {sport} plan", { sport: sportLabel(c.sport).toLowerCase() })}</p>
                            <ButtonLink to="/app/plans" variant="outline" className="w-full">
                              {t("See plans")}
                            </ButtonLink>
                          </div>
                        );
                      }
                      if (a.session_left != null && a.session_left <= 0) {
                        return (
                          <div className="grid gap-2">
                            <p className="text-sm text-muted">{t("Your plan has no sessions left")}</p>
                            <ButtonLink to="/app/plans" variant="outline" className="w-full">
                              {t("Renew")}
                            </ButtonLink>
                          </div>
                        );
                      }
                      return (
                        <div className="grid gap-2">
                          <p className="text-xs text-muted">
                            {a.session_left == null
                              ? t("Included in your plan")
                              : t("Uses 1 of your {n} sessions", { n: a.session_left })}
                          </p>
                          <Button
                            className="w-full"
                            variant={full ? "outline" : "primary"}
                            onClick={async () => {
                              try {
                                const r = await apiPost<{ waitlisted?: boolean }>(`/classes/${c.id}/enroll`, {});
                                toast.success(r.waitlisted ? t("Added to the waitlist") : t("You are enrolled"));
                                load();
                              } catch (e) {
                                toast.error(e instanceof Error ? e.message : t("Could not enrol"));
                              }
                            }}
                          >
                            {full ? t("Join the waitlist") : t("Enrol")}
                          </Button>
                        </div>
                      );
                    })()
                  )}
                  </div>
                </div>
              </Card>
              </SpotlightCard>
              </Lift>
              </StaggerItem>
            );
          })}
          {!shown.length && (coach || day || part) ? (
            <EmptyState assetSlot="empty.default" title={t("No class matches these filters")} hint={t("Change the coach, day or time above.")} />
          ) : !shown.length ? (
            <EmptyState assetSlot="empty.default" title={t("No open classes")} hint={t("The manager publishes the weekly timetable.")} />
          ) : null}
        </Stagger>
      )}
      {items ? <ShowMore shown={shown.length} total={matching.length} step={6} onMore={() => setLimit((n) => n + 6)} /> : null}
      <Modal
        open={!!leaving}
        onClose={() => (leaveBusy ? undefined : setLeaving(null))}
        title={
          leaving?.enr.status === "waitlisted"
            ? t("Leave the waitlist for {cls}?", { cls: leaving ? `${sportLabel(leaving.cls.sport)} ${levelLabel(leaving.cls.level)}` : "" })
            : t("Leave {cls}?", { cls: leaving ? `${sportLabel(leaving.cls.sport)} ${levelLabel(leaving.cls.level)}` : "" })
        }
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => setLeaving(null)} disabled={leaveBusy}>
              {t("Stay")}
            </Button>
            <Button variant="danger" onClick={() => void leave()} disabled={leaveBusy}>
              {leaving?.enr.status === "waitlisted" ? t("Leave the waitlist") : t("Leave class")}
            </Button>
          </div>
        }
      >
        <p className="text-sm text-muted">
          {leaving?.enr.status === "waitlisted"
            ? t("You lose your place in the queue. Joining again puts you at the back.")
            : t("Your seat goes to the next person on the waitlist.")}
        </p>
      </Modal>
      <MyAttendance />
    </Shell>
  );
}
