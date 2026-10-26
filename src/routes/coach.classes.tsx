import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Users, Ticket, Calendar, CheckCircle } from "lucide-react";
import { ClassDetailModal } from "@/components/class-detail";
import { Shell } from "@/components/shell";
import { Badge, Button, Card, EmptyState, LoadError, ShowMore, Skeleton, StatusBadge } from "@/components/ui";
import { Stagger, StaggerItem, motion } from "@/components/motion";
import { SpotlightCard } from "@/components/fx";
import { SportIcon } from "@/components/arena-icons";
import { formatDate, levelLabel, rruleLabel, sportLabel } from "@/lib/arena3/labels";
import { t } from "@/lib/i18n";
import { useRead } from "@/lib/use-read";
import { HighlightBadge, useLive } from "@/lib/use-live";

export const Route = createFileRoute("/coach/classes")({
  component: Page,
});

type CoachClassRow = {
  id: string;
  code: string;
  sport: string;
  level: string;
  status: string;
  court_code: string;
  coach_name: string;
  enrolled_count: number;
  capacity: number;
  rrule?: string;
  duration_min?: number;
  start_on: string;
  end_on: string;
  upcoming_sessions_count: number;
};

function Page() {
  const read = useRead<{ items: CoachClassRow[]; total: number }>("/coach/classes");
  useLive("classes", read.reload);
  const items = read.data?.items ?? null;
  const [detail, setDetail] = useState<string | null>(null);
  const [limit, setLimit] = useState(8);

  const totalClasses = items?.length ?? 0;
  const openClasses = items?.filter((c) => c.status === "open").length ?? 0;
  const totalStudents = items?.reduce((sum, c) => sum + (c.enrolled_count || 0), 0) ?? 0;

  return (
    <Shell
      role="coach"
      title={t("Classes")}
      subtitle={t("Classes you teach: schedule, enrolled students, court and attendance details.")}
    >
      {read.error ? (
        <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />
      ) : !items ? (
        <div className="grid gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-44" />
        </div>
      ) : !items.length ? (
        <EmptyState
          title={t("No classes assigned")}
          hint={t("When the manager assigns you to teach a class, it will appear here.")}
        />
      ) : (
        <div className="grid gap-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card className="flex items-center gap-3 p-4">
              <div className="flex size-10 items-center justify-center rounded-[var(--radius-md)] bg-accent/15 text-accent">
                <Ticket className="size-5" />
              </div>
              <div>
                <p className="text-2xs font-medium uppercase text-muted">{t("Total Classes")}</p>
                <p className="figure text-2xl font-bold tabular-nums">{totalClasses}</p>
              </div>
            </Card>

            <Card className="flex items-center gap-3 p-4">
              <div className="flex size-10 items-center justify-center rounded-[var(--radius-md)] bg-accent-2/15 text-accent-2">
                <CheckCircle className="size-5" />
              </div>
              <div>
                <p className="text-2xs font-medium uppercase text-muted">{t("Open Classes")}</p>
                <p className="figure text-2xl font-bold tabular-nums">{openClasses}</p>
              </div>
            </Card>

            <Card className="flex items-center gap-3 p-4">
              <div className="flex size-10 items-center justify-center rounded-[var(--radius-md)] bg-wood text-fg">
                <Users className="size-5" />
              </div>
              <div>
                <p className="text-2xs font-medium uppercase text-muted">{t("Total Students")}</p>
                <HighlightBadge value={totalStudents}>
                  <p className="figure text-2xl font-bold tabular-nums">{totalStudents}</p>
                </HighlightBadge>
              </div>
            </Card>
          </div>

          <Stagger className="grid gap-4 md:grid-cols-2" gap={0.06}>
            {items.slice(0, limit).map((c) => {
              const pct = Math.min(100, Math.round(((c.enrolled_count || 0) / (c.capacity || 1)) * 100));
              const full = c.enrolled_count >= c.capacity;

              return (
                <StaggerItem key={c.id}>
                  <SpotlightCard className="h-full rounded-[var(--radius-xl)]" size={320} strength={0.08}>
                    <Card interactive className="flex h-full flex-col justify-between p-5">
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Badge tone="accent">
                              <SportIcon sport={c.sport} className="mr-1 size-3.5" />
                              {sportLabel(c.sport)}
                            </Badge>
                            <Badge tone="muted">{levelLabel(c.level)}</Badge>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-2xs font-mono text-muted">{c.code}</span>
                            <StatusBadge status={c.status} />
                          </div>
                        </div>

                        <h2 className="mt-3 font-display text-2xl">
                          {sportLabel(c.sport)} · {levelLabel(c.level)}
                        </h2>

                        <div className="mt-2 grid gap-1 text-sm text-muted">
                          <p className="flex items-center gap-1.5">
                            <Calendar className="size-4 shrink-0 text-muted" />
                            {c.rrule ? rruleLabel(c.rrule, c.duration_min) : t("Weekly schedule")}
                          </p>
                          <p>
                            {t("Court {court}", { court: c.court_code })} · {formatDate(c.start_on)} – {formatDate(c.end_on)}
                          </p>
                        </div>

                        <div className="mt-4">
                          <div className="flex items-baseline justify-between gap-2 text-xs">
                            <span className="text-muted">
                              <HighlightBadge value={c.enrolled_count}>
                                {t("{enrolled}/{capacity} students", {
                                  enrolled: c.enrolled_count,
                                  capacity: c.capacity,
                                })}
                              </HighlightBadge>
                            </span>
                            <span className="font-semibold tabular-nums text-fg">{pct}%</span>
                          </div>
                          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-wood">
                            <motion.div
                              className={`h-full rounded-full ${full ? "bg-hold" : "bg-accent"}`}
                              initial={{ width: 0 }}
                              animate={{ width: `${pct}%` }}
                              transition={{ duration: 0.6 }}
                            />
                          </div>
                        </div>
                      </div>

                      <div className="mt-5 flex items-center justify-between gap-2 border-t border-line pt-3">
                        <span className="text-xs text-muted">
                          {t("{n} upcoming sessions", { n: c.upcoming_sessions_count })}
                        </span>
                        <Button variant="outline" size="sm" onClick={() => setDetail(c.id)}>
                          {t("Sessions & students")}
                        </Button>
                      </div>
                    </Card>
                  </SpotlightCard>
                </StaggerItem>
              );
            })}
          </Stagger>

          {items.length > limit ? (
            <ShowMore
              shown={limit}
              total={items.length}
              step={8}
              onMore={() => setLimit((n) => n + 8)}
            />
          ) : null}

          <ClassDetailModal classId={detail} onClose={() => setDetail(null)} onChanged={read.reload} />
        </div>
      )}
    </Shell>
  );
}
