import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SectionTitle } from "@/components/section";
import { Shell, money, when } from "@/components/shell";
import { Badge, Button, Card, EmptyState, Field, LoadError, MoneyInput, Skeleton, Stat } from "@/components/ui";
import { Reveal } from "@/components/motion";
import { apiPatch, apiPost } from "@/lib/arena3/client";
import { t, tServer } from "@/lib/i18n";
import { useRead } from "@/lib/use-read";

export const Route = createFileRoute("/manager/commission")({ component: Page });

type Row = {
  coach_id: string;
  coach_name: string;
  per_session_vnd: number;
  per_student_vnd: number;
  sessions: number;
  students: number;
  amount_vnd: number;
  payout_status: "closed" | "paid" | null;
  paid_at: string | null;
};
type Report = { period: string; current: string; items: Row[]; total_vnd: number };

function shiftMonth(p: string, by: number) {
  const [y, m] = p.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function Page() {
  // null asks for "this month": the server says which one that is, and the answer names it.
  const [asked, setAsked] = useState<string | null>(null);
  const [rates, setRates] = useState<Record<string, { s: string; p: string }>>({});
  const [busy, setBusy] = useState(false);
  const read = useRead<Report>(`/commission${asked ? `?period=${asked}` : ""}`);
  const data = read.data;
  const period = data?.period ?? asked;

  // The rate boxes start from what the server holds and are the person's to edit from there.
  useEffect(() => {
    if (!data) return;
    setRates(Object.fromEntries(data.items.map((x) => [x.coach_id, { s: String(x.per_session_vnd), p: String(x.per_student_vnd) }])));
  }, [data]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      read.reload();
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      setBusy(false);
    }
  }

  const ended = data ? data.period < data.current : false;
  const open = data?.items.filter((r) => !r.payout_status && r.sessions > 0).length ?? 0;

  return (
    <Shell
      role="manager"
      title={t("Coach commission")}
      subtitle={t("Paid per class taught plus a little for each student who turned up. Close the month, then mark it paid.")}
    >
      <Reveal from="down">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className="min-w-11" aria-label={t("Previous month")} disabled={!period} onClick={() => period && setAsked(shiftMonth(period, -1))}>
            ←
          </Button>
          <span className="min-w-28 text-center font-display text-xl tabular-nums">{period ?? "…"}</span>
          <Button variant="outline" size="sm" className="min-w-11" aria-label={t("Next month")} disabled={!period || !data || period >= data.current} onClick={() => period && setAsked(shiftMonth(period, 1))}>
            →
          </Button>
          {ended && open > 0 ? (
            <Button
              className="ml-auto"
              disabled={busy}
              onClick={() => void run(() => apiPost("/commission/close", { period }), t("Month closed. The figures are now locked."))}
            >
              {t("Close this month")}
            </Button>
          ) : null}
        </div>
      </Reveal>

      {read.error ? (
        <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />
      ) : !data ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <Stat label={t("To pay this month")} value={money(data.total_vnd)} />
            <Stat label={t("Classes taught")} value={String(data.items.reduce((a, r) => a + r.sessions, 0))} />
            <Stat label={t("Students counted")} value={String(data.items.reduce((a, r) => a + r.students, 0))} />
          </div>
          {!ended ? <p className="mb-3 text-xs text-muted">{t("This month is still running, so these figures can still change.")}</p> : null}

          <SectionTitle text={t("Coaches")} className="mb-3 font-display text-2xl" />
          {data.items.length === 0 ? (
            <EmptyState title={t("No coaches yet")} hint={t("Add a coach under Staff.")} />
          ) : (
            <div className="grid gap-3">
              {data.items.map((r) => {
                const rate = rates[r.coach_id] ?? { s: String(r.per_session_vnd), p: String(r.per_student_vnd) };
                const frozen = !!r.payout_status;
                return (
                  <Card key={r.coach_id} className="grid gap-3 p-4 md:grid-cols-[1.2fr_1fr_1.4fr_auto] md:items-end">
                    <div>
                      <p className="font-medium">{r.coach_name}</p>
                      <p className="text-xs text-muted">
                        {t("{n} classes", { n: r.sessions })} · {t("{n} students", { n: r.students })}
                      </p>
                      <p className="mt-1">
                        {r.payout_status === "paid" ? (
                          <Badge tone="accent">
                            {t("Paid")} {r.paid_at ? when(r.paid_at) : ""}
                          </Badge>
                        ) : r.payout_status === "closed" ? (
                          <Badge tone="hold">{t("Closed, not paid")}</Badge>
                        ) : (
                          <Badge tone="muted">{t("Open")}</Badge>
                        )}
                      </p>
                    </div>
                    <div className="font-display text-2xl tabular-nums">{money(r.amount_vnd)}</div>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label={t("Per class")}>
                        <MoneyInput
                          disabled={frozen}
                          value={rate.s}
                          onChange={(v) => setRates((m) => ({ ...m, [r.coach_id]: { ...rate, s: v } }))}
                        />
                      </Field>
                      <Field label={t("Per student")}>
                        <MoneyInput
                          disabled={frozen}
                          value={rate.p}
                          onChange={(v) => setRates((m) => ({ ...m, [r.coach_id]: { ...rate, p: v } }))}
                        />
                      </Field>
                    </div>
                    <div className="flex gap-2">
                      {!frozen ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => apiPatch(`/commission/rates/${r.coach_id}`, { per_session_vnd: Number(rate.s), per_student_vnd: Number(rate.p) }),
                              t("Rates saved"),
                            )
                          }
                        >
                          {t("Save rates")}
                        </Button>
                      ) : null}
                      {r.payout_status === "closed" ? (
                        <Button size="sm" disabled={busy} onClick={() => void run(() => apiPost(`/commission/pay/${r.coach_id}`, { period }), t("Marked as paid"))}>
                          {t("Mark paid")}
                        </Button>
                      ) : null}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}
    </Shell>
  );
}
