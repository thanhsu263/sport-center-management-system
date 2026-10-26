import { when } from "@/components/shell";
import { Badge, Card, EmptyState, LoadError, Skeleton } from "@/components/ui";
import { levelLabel, sportLabel } from "@/lib/arena3/labels";
import { SectionTitle } from "@/components/section";
import { ClipboardCheck } from "lucide-react";
import { t, tk } from "@/lib/i18n";
import { useRead } from "@/lib/use-read";

type Row = {
  session_id: string;
  start_at: string;
  sport: string;
  level: string;
  court_code: string;
  result: "present" | "late" | "absent" | "excused" | null;
};
type Attendance = { items: Row[]; counts: Record<"present" | "late" | "absent" | "excused", number> };

const RESULTS = [
  { key: "present", label: tk("Present"), tone: "accent" },
  { key: "late", label: tk("Late"), tone: "hold" },
  { key: "absent", label: tk("Absent"), tone: "danger" },
  { key: "excused", label: tk("Excused"), tone: "muted" },
] as const;

/**
 * The member's own record of finished class sessions (M-05): what the coach
 * marked each one — present, late, absent or excused — and nothing about anyone
 * else. A session the coach has not marked yet says so rather than guessing.
 */
export function MyAttendance() {
  const { data, error, reload } = useRead<Attendance>("/me/attendance");

  return (
    <section aria-labelledby="my-attendance" className="mt-10">
      <SectionTitle id="my-attendance" icon={ClipboardCheck} text={t("My attendance")} className="mb-3" />
      {error ? (
        <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
      ) : !data ? (
        <Skeleton className="h-24" />
      ) : !data.items.length ? (
        <EmptyState
          title={t("No finished sessions yet")}
          hint={t("After each class your coach marks you present, late, absent or excused, and the marks show up here.")}
        />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            {RESULTS.map((r) => (
              <Badge key={r.key} tone={r.tone}>
                {t(r.label)} · {data.counts[r.key] ?? 0}
              </Badge>
            ))}
          </div>
          <Card className="divide-y divide-line p-0">
            {data.items.map((row) => {
              const r = RESULTS.find((x) => x.key === row.result);
              return (
                <div key={row.session_id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <span className="text-sm">
                    <span className="font-medium">
                      {sportLabel(row.sport)} · {levelLabel(row.level)}
                    </span>
                    <span className="block text-xs text-muted">
                      {when(row.start_at)} · {row.court_code}
                    </span>
                  </span>
                  {r ? <Badge tone={r.tone}>{t(r.label)}</Badge> : <Badge tone="muted">{t("Not marked yet")}</Badge>}
                </div>
              );
            })}
          </Card>
        </>
      )}
    </section>
  );
}
