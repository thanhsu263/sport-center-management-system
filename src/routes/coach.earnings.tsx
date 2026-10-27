import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SectionTitle } from "@/components/section";
import { Shell, money, when } from "@/components/shell";
import { Badge, Button, Card, EmptyState, LoadError, Skeleton, Stat } from "@/components/ui";
import { Reveal } from "@/components/motion";
import { levelLabel } from "@/lib/arena3/labels";
import { t } from "@/lib/i18n";
import { useRead } from "@/lib/use-read";

export const Route = createFileRoute("/coach/earnings")({ component: Page });

type Data = {
  period: string;
  current: string;
  summary: { sessions: number; students: number; amount_vnd: number; per_session_vnd: number; per_student_vnd: number; payout_status: string | null } | null;
  sessions: { id: string; start_at: string; level: string; court_code: string; students: number }[];
  history: { period: string; sessions: number; students: number; amount_vnd: number; status: string; paid_at: string | null }[];
};

function shiftMonth(p: string, by: number) {
  const [y, m] = p.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function Page() {
  // undefined = the month that is running now, whatever the centre calls it; the server answers with it.
  const [period, setPeriod] = useState<string | undefined>();
  const read = useRead<Data>(`/me/earnings${period ? `?period=${period}` : ""}`);
  const data = read.data;

  // The centre's current month, kept once it is known so the arrows keep working after a month fails to
  // load: a coach who lands on a month that would not open can still step to the next one.
  const [knownCurrent, setKnownCurrent] = useState<string | null>(null);
  useEffect(() => {
    if (data) setKnownCurrent(data.current);
  }, [data]);
  const current = data?.current ?? knownCurrent;
  const viewing = period ?? current;

  const s = data?.summary;
  return (
    <Shell
      role="coach"
      title={t("My earnings")}
      subtitle={t("What you earn for the classes you taught: a fee per class plus a little for each student who came.")}
    >
      <Reveal from="down">
        <div className="mb-4 flex items-center gap-2">
          <Button variant="outline" size="sm" className="min-w-11" aria-label={t("Previous month")} disabled={!viewing} onClick={() => viewing && setPeriod(shiftMonth(viewing, -1))}>
            ←
          </Button>
          <span className="min-w-28 text-center font-display text-xl tabular-nums">{viewing ?? "…"}</span>
          <Button variant="outline" size="sm" className="min-w-11" aria-label={t("Next month")} disabled={!viewing || !current || viewing >= current} onClick={() => viewing && setPeriod(shiftMonth(viewing, 1))}>
            →
          </Button>
        </div>
      </Reveal>

      {read.error ? (
        <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />
      ) : !data ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <div className="mb-2 grid gap-3 sm:grid-cols-3">
            <Stat label={t("Earned")} value={money(s?.amount_vnd ?? 0)} />
            <Stat label={t("Classes taught")} value={String(s?.sessions ?? 0)} />
            <Stat label={t("Students counted")} value={String(s?.students ?? 0)} />
          </div>
          <p className="mb-4 text-xs text-muted">
            {s
              ? t("Your rate: {a} per class and {b} per student.", { a: money(s.per_session_vnd), b: money(s.per_student_vnd) })
              : ""}{" "}
            {data.period >= data.current ? t("This month is still running, so the figure can still grow.") : ""}
          </p>

          <SectionTitle text={t("Classes this month")} className="mb-3 font-display text-2xl" />
          {data.sessions.length === 0 ? (
            <EmptyState title={t("No finished classes this month")} hint={t("A class counts once it is marked done.")} />
          ) : (
            <div className="mb-8 grid gap-2">
              {data.sessions.map((x) => (
                <Card key={x.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                  <span>
                    {when(x.start_at)} · {x.court_code} · {levelLabel(x.level)}
                  </span>
                  <span className="tabular-nums text-muted">{t("{n} students", { n: x.students })}</span>
                </Card>
              ))}
            </div>
          )}

          <SectionTitle text={t("Past months")} className="mb-3 font-display text-2xl" />
          {data.history.length === 0 ? (
            <p className="text-sm text-muted">{t("Nothing closed yet.")}</p>
          ) : (
            <div className="grid gap-2">
              {data.history.map((h) => (
                <Card key={h.period} className="flex items-center justify-between gap-3 p-3 text-sm">
                  <span className="tabular-nums">
                    {h.period} · {t("{n} classes", { n: h.sessions })}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums">{money(h.amount_vnd)}</span>
                    <Badge tone={h.status === "paid" ? "accent" : "hold"}>{h.status === "paid" ? t("Paid") : t("Closed, not paid")}</Badge>
                  </span>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </Shell>
  );
}
