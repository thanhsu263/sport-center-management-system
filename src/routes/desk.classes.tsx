import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ClassDetailModal } from "@/components/class-detail";
import { Shell } from "@/components/shell";
import { Button, Card, EmptyState, LoadError, ShowMore, Skeleton, StatusBadge } from "@/components/ui";
import { Stagger, StaggerItem } from "@/components/motion";
import { t } from "@/lib/i18n";
import { levelLabel, rruleLabel, sportLabel } from "@/lib/arena3/labels";
import { useRead } from "@/lib/use-read";
import { HighlightBadge, useLive } from "@/lib/use-live";

export const Route = createFileRoute("/desk/classes")({
  component: Page,
});

type Row = {
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
};

/** The same classes the manager sees, so the desk can answer "who is in it, and when?" (D-07). */
function Page() {
  const read = useRead<{ items: Row[] }>("/classes");
  useLive("classes", read.reload);
  const items = read.data?.items ?? null;
  const [detail, setDetail] = useState<string | null>(null);
  const [limit, setLimit] = useState(8);

  return (
    <Shell role="receptionist" title={t("Classes")} subtitle={t("Open a class to see its sessions, court, coach and who is enrolled.")}>
      {read.error ? (
        <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />
      ) : !items ? (
        <Skeleton className="h-36" />
      ) : !items.length ? (
        <EmptyState title={t("No classes are open")} hint={t("The manager publishes classes from the Classes screen.")} />
      ) : (
        <Stagger className="grid gap-3 md:grid-cols-2" gap={0.06}>
          {items.slice(0, limit).map((c) => (
            <StaggerItem key={c.id}>
              <Card className="h-full">
                <div className="flex items-center justify-between gap-2">
                  <StatusBadge status={c.status} />
                  <span className="text-2xs tabular-nums text-muted">{c.code}</span>
                </div>
                <h2 className="mt-2 font-display text-2xl">
                  {sportLabel(c.sport)} · {levelLabel(c.level)}
                </h2>
                <p className="text-sm text-muted">
                  {c.coach_name} · {c.court_code} ·{" "}
                  <span className="tabular-nums">
                    <HighlightBadge value={c.enrolled_count}>{c.enrolled_count}</HighlightBadge>/{c.capacity}
                  </span>
                </p>
                {c.rrule ? <p className="text-sm">{rruleLabel(c.rrule, c.duration_min)}</p> : null}
                <Button className="mt-3" variant="outline" onClick={() => setDetail(c.id)}>
                  {t("Sessions & students")}
                </Button>
              </Card>
            </StaggerItem>
          ))}
        </Stagger>
      )}
      {items?.length ? <ShowMore shown={Math.min(limit, items.length)} total={items.length} step={8} onMore={() => setLimit((n) => n + 8)} /> : null}
      <ClassDetailModal classId={detail} onClose={() => setDetail(null)} />
    </Shell>
  );
}
