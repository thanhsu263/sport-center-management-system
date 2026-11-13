import { Fragment, useEffect, useMemo, useState } from "react";
import { CalendarDays, Flame, Gauge, LayoutGrid, TrendingUp, UserPlus, Users } from "lucide-react";
import { CardTitle, SectionTitle } from "@/client/components/section";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { money } from "@/client/components/shell";
import { Badge, Button, Card, EmptyState, LoadError, Select, ShowMore, Skeleton, Stat } from "@/client/components/ui";
import { SportDot, useSports } from "@/client/components/sports-ui";
import { downloadReport } from "@/client/arena3/client";
import { levelLabel, sportLabel } from "@/shared/arena3/labels";
import { t, tk, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";
import { useLimits } from "@/client/lib/use-centre";
import { cn } from "@/client/lib/cn";

type Kind = "revenue" | "capacity" | "members" | "attendance" | "at-risk";

/** Excel and PDF of the report on screen, with the same filters it is showing. */
export function ExportButtons({
  kind,
  from,
  to,
  extra = {},
  disabled = false,
}: {
  kind: Kind;
  from: string;
  to: string;
  extra?: Record<string, string | null | undefined>;
  /** The period on screen is one the server refuses, so there is nothing to export. */
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState<"xlsx" | "pdf" | null>(null);
  async function go(format: "xlsx" | "pdf") {
    setBusy(format);
    try {
      const q = new URLSearchParams({ from, to, format });
      for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
      const name = await downloadReport(`/reports/${kind}/export?${q}`, `lelong-${kind}-${from}_${to}.${format}`);
      toast.success(t("Saved {name}", { name }));
    } catch (e) {
      toast.error(tServer((e as Error).message));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={disabled || busy !== null} onClick={() => void go("xlsx")}>
        {busy === "xlsx" ? t("Preparing…") : t("Export Excel")}
      </Button>
      <Button variant="outline" size="sm" disabled={disabled || busy !== null} onClick={() => void go("pdf")}>
        {busy === "pdf" ? t("Preparing…") : t("Export PDF")}
      </Button>
    </div>
  );
}

const hours = (min: number) => Math.round((min / 60) * 10) / 10;
const pctText = (v: number | null | undefined) => (v == null ? "-" : `${v}%`);

function SportSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { sports } = useSports();
  return (
    <div className="w-44">
      <Select aria-label={t("Sport")} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("All sports")}</option>
        {sports.map((s) => (
          <option key={s.code} value={s.code}>
            {sportLabel(s.code)}
          </option>
        ))}
      </Select>
    </div>
  );
}

// ---- capacity -------------------------------------------------------------------

type Capacity = {
  open_hour: number;
  close_hour: number;
  totals: { sold_min: number; open_min: number; pct: number };
  by_sport: Array<{
    sport: string;
    sold_min: number;
    open_min: number;
    pct: number;
    peak_pct: number | null;
    offpeak_pct: number | null;
  }>;
  by_hour: Array<{ hour: number; pct: number }>;
  hours: number[];
  courts: Array<{
    court_id: string;
    court_code: string;
    sport: string;
    pct: number;
    cells: number[];
    cell_details?: Array<{ hr: number; pct: number; days_booked: number; days_total: number }>;
  }>;
  revenue_by_source: { court_vnd: number; class_vnd: number };
};

/** Share of courts in play per hour, one labelled bar per hour; the peak hours are lit. */
function BusyBars({ hours: rows, peakPct }: { hours: Array<{ hour: number; pct: number }>; peakPct: number }) {
  const top = Math.max(1, ...rows.map((x) => x.pct));
  return (
    <div className="overflow-x-auto px-4 pb-4 pt-4" role="region" aria-label={t("Busy hours chart, scrolls sideways")} tabIndex={0}>
      <ol className="flex min-w-[560px] items-end gap-1.5">
        {rows.map((h) => {
          const peak = h.pct > 0 && h.pct >= (top * peakPct) / 100;
          const hh = `${String(h.hour).padStart(2, "0")}h`;
          return (
            <li key={h.hour} className="flex flex-1 flex-col items-center gap-1" title={`${hh} · ${Math.round(h.pct)}%`}>
              <span className={cn("text-2xs tabular-nums", peak ? "font-semibold text-fg" : "text-muted")}>
                {Math.round(h.pct)}%
              </span>
              <div className="flex h-36 w-full items-end rounded-t-[4px] bg-wood/40">
                <div
                  className={cn(
                    "w-full rounded-t-[4px] transition-[height] duration-500 motion-reduce:transition-none",
                    peak ? "bg-accent shadow-[0_0_14px_rgb(212_245_60/0.4)]" : "bg-accent/40",
                  )}
                  style={{ height: h.pct > 0 ? `${Math.max(3, (h.pct / top) * 100)}%` : "2px" }}
                />
              </div>
              <span className={cn("text-2xs tabular-nums", peak ? "font-semibold text-fg" : "text-muted")}>{hh}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** `summary` = totals and the per-sport table; `busy` = the whole-day court × hour grid, shown last on the page. */
export function CapacityPanel({ from, to, part = "summary" }: { from: string; to: string; part?: "summary" | "busy" }) {
  const [sport, setSport] = useState("");
  const q = new URLSearchParams({ from, to });
  if (sport) q.set("sport", sport);
  const limits = useLimits();
  const { data, error, reload } = useRead<Capacity>(`/reports/capacity?${q}`);

  const busiestSummary = useMemo(() => {
    if (!data?.by_hour?.length) return "";
    const sorted = [...data.by_hour]
      .filter((h) => h.pct > 0)
      .sort((a, b) => b.pct - a.pct);
    if (sorted.length === 0) return t("No bookings in this window");
    const top3 = sorted.slice(0, limits.report_peak_hours);
    const text = top3
      .map((h, idx) =>
        idx === 0
          ? `${String(h.hour).padStart(2, "0")}:00 (${Math.round(h.pct)}%)`
          : `${String(h.hour).padStart(2, "0")}:00`
      )
      .join(", ");
    return t("Busiest: {hours}", { hours: text });
  }, [data, limits.report_peak_hours]);

  return (
    <section className="mt-10" aria-labelledby={part === "summary" ? "cap-h" : "busy-h"}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        {part === "summary" ? (
          <SectionTitle
            id="cap-h"
            icon={LayoutGrid}
            text={tk("Court capacity")}
            hint={t("Share of open hours that were sold, as bookings or class sessions.")}
          />
        ) : (
          <SectionTitle id="busy-h" icon={Flame} text={t("Busy hours")} hint={t("The whole day, hour by hour, for every court.")} />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <SportSelect value={sport} onChange={setSport} />
          <ExportButtons kind="capacity" from={from} to={to} extra={{ sport }} />
        </div>
      </div>

      {error ? (
        <div className="mt-4">
          <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
        </div>
      ) : !data ? (
        <Skeleton className="mt-4 h-64" />
      ) : data.courts.length === 0 ? (
        <div className="mt-4">
          <EmptyState title={t("No courts to report on")} hint={t("Courts that are ready for play show up here.")} />
        </div>
      ) : (
        <>
          {part === "summary" && (
          <>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <Stat
              label={t("Hours sold")}
              value={`${hours(data.totals.sold_min)} h`}
              hint={t("of {n} h open", { n: hours(data.totals.open_min) })}
            />
            <Stat label={t("Used")} value={`${data.totals.pct}%`} icon={Gauge} note={t("Hours sold ÷ hours open")} />
            <Stat
              label={t("Court rental vs classes")}
              value={money(data.revenue_by_source.court_vnd)}
              hint={t("Class fees {amount}", { amount: money(data.revenue_by_source.class_vnd) })}
            />
          </div>

          <Card className="mt-3 overflow-x-auto p-0" role="region" aria-label={t("Court use table, scrolls sideways")} tabIndex={0}>
            <table className="w-full text-sm">
              <thead className="text-left text-2xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">{t("Sport")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("Sold")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("Used")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("Peak")}</th>
                  <th className="px-4 py-2 text-right font-medium">{t("Off-peak")}</th>
                </tr>
              </thead>
              <tbody>
                {data.by_sport.map((s) => (
                  <tr key={s.sport} className="border-t border-line/60">
                    <td className="px-4 py-2">{sportLabel(s.sport)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{hours(s.sold_min)} h</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.pct}%</td>
                    <td className="px-3 py-2 text-right tabular-nums">{pctText(s.peak_pct)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{pctText(s.offpeak_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          </>
          )}

          {part === "busy" && (
          <Card className="mt-4 p-0">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4">
              <CardTitle
                icon={Flame}
                title={t("When courts are busy ({from} – {to})", { from, to })}
                hint={t("Share of courts in play at each hour. The brightest bars are the peak.")}
              />
              {busiestSummary && (
                <div className="text-right">
                  <span className="inline-block rounded-full bg-surface px-3 py-1 text-xs font-medium text-fg border border-line">
                    {busiestSummary}
                  </span>
                </div>
              )}
            </div>

            <BusyBars hours={data.by_hour} peakPct={limits.report_peak_pct} />
          </Card>
          )}
        </>
      )}
    </section>
  );
}

// ---- members and class sign-ups -------------------------------------------------

type MembersReport = {
  members: {
    new: number;
    active: number;
  };
  trend: Array<{ month: string; new_members: number; classes_joined: number }>;
  attendance_on: boolean;
  classes: Array<{
    id: string;
    code: string;
    sport: string;
    level: string;
    status: string;
    coach: string;
    capacity: number;
    enrolled: number;
    waitlisted: number;
    fill_pct: number;
    attendance_pct: number | null;
  }>;
};

export function MembersPanel({ from, to }: { from: string; to: string }) {
  const [sport, setSport] = useState("");
  const [chartReady, setChartReady] = useState(false);
  useEffect(() => setChartReady(true), []);
  const q = new URLSearchParams({ from, to });
  if (sport) q.set("sport", sport);
  const { data, error, reload } = useRead<MembersReport>(`/reports/members?${q}`);
  // Only show the attendance column when at least one class has a figure for it.
  const showAttendance = !!data?.attendance_on && !!data?.classes.some((c) => c.attendance_pct != null);
  const CLASS_STEP = 12;
  const [classShown, setClassShown] = useState(CLASS_STEP);
  // Fullest first, so the classes that need a decision (full with a waitlist, or nearly empty) sit at the two ends.
  const classes = useMemo(
    () => [...(data?.classes ?? [])].sort((a, b) => b.fill_pct - a.fill_pct || b.waitlisted - a.waitlisted || a.code.localeCompare(b.code)),
    [data],
  );
  const classSummary = useMemo(() => {
    const full = classes.filter((c) => c.fill_pct >= 100).length;
    const low = classes.filter((c) => c.fill_pct < 40).length;
    const waiting = classes.reduce((n, c) => n + c.waitlisted, 0);
    return { full, low, waiting };
  }, [classes]);

  return (
    <section className="mt-10" aria-labelledby="mem-h">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectionTitle
          id="mem-h"
          icon={Users}
          text={tk("Members and class sign-ups")}
          hint={t("New members, participation and how full each class is.")}
        />
        <div className="flex flex-wrap items-center gap-2">
          <SportSelect value={sport} onChange={setSport} />
          <ExportButtons kind="members" from={from} to={to} extra={{ sport }} />
        </div>
      </div>

      {error ? (
        <div className="mt-4">
          <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
        </div>
      ) : !data ? (
        <Skeleton className="mt-4 h-64" />
      ) : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Stat label={t("New members")} value={data.members.new} icon={UserPlus} note={t("Signed up in this period")} />
            <Stat label={t("Participating members")} value={data.members.active} hint={t("With a booking or confirmed class in this period")} />
          </div>

          <Card className="mt-3">
            <CardTitle icon={TrendingUp} title={t("Last 12 months")} hint={t("New members by signup month; confirmed class places by class start month.")} />
            {chartReady ? (
              <div className="mt-3 h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--color-line)" strokeDasharray="2 4" />
                    <XAxis
                      dataKey="month"
                      tick={{ fontSize: 12 }}
                      stroke="var(--color-muted)"
                      tickLine={false}
                      tickFormatter={(m: string) => `${m.slice(5)}/${m.slice(2, 4)}`}
                    />
                    <YAxis
                      tick={{ fontSize: 12 }}
                      stroke="var(--color-muted)"
                      tickLine={false}
                      axisLine={false}
                      width={32}
                      allowDecimals={false}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "var(--color-surface)",
                        border: "1px solid var(--color-line)",
                        borderRadius: 12,
                        fontSize: 12,
                      }}
                      cursor={{ fill: "var(--color-wood)", opacity: 0.5 }}
                    />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="new_members" name={t("New members")} fill="var(--color-accent)" radius={[4, 4, 0, 0]} maxBarSize={18} />
                    <Bar dataKey="classes_joined" name={t("Confirmed class places")} fill="var(--color-line-strong)" radius={[4, 4, 0, 0]} maxBarSize={18} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <Skeleton className="mt-3 h-52" />
            )}
          </Card>

          <Card className="mt-3 p-0">
            <div className="flex flex-wrap items-end justify-between gap-3 px-4 pt-4">
              <CardTitle icon={CalendarDays} title={t("Classes running in this period")} hint={t("How full each class was.")} />
              {classes.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 text-2xs">
                  <span className="rounded-full border border-line px-2.5 py-1 tabular-nums text-muted">
                    {t("{n} classes", { n: classes.length })}
                  </span>
                  <span className="rounded-full bg-accent/15 px-2.5 py-1 font-medium tabular-nums text-accent">
                    {t("{n} full", { n: classSummary.full })}
                  </span>
                  {classSummary.waiting > 0 ? (
                    <span className="rounded-full bg-warn/15 px-2.5 py-1 font-medium tabular-nums text-warn">
                      {t("{n} waiting", { n: classSummary.waiting })}
                    </span>
                  ) : null}
                  <span className="rounded-full border border-line px-2.5 py-1 tabular-nums text-muted">
                    {t("{n} under 40%", { n: classSummary.low })}
                  </span>
                </div>
              ) : null}
            </div>
            {classes.length === 0 ? (
              <p className="px-4 pb-4 pt-2 text-sm text-muted">{t("No classes were running in this period.")}</p>
            ) : (
              <div className="overflow-x-auto" role="region" aria-label={t("Classes table, scrolls sideways")} tabIndex={0}>
                <table className="mt-3 w-full min-w-[560px] text-sm">
                  <thead className="text-left text-2xs text-muted">
                    <tr>
                      <th className="px-4 py-2 font-medium">{t("Class")}</th>
                      <th className="px-3 py-2 font-medium">{t("Coach")}</th>
                      <th className="w-[38%] px-3 py-2 font-medium">{t("Full")}</th>
                      <th className="px-3 py-2 text-right font-medium">{t("Waitlist")}</th>
                      {showAttendance ? <th className="px-4 py-2 text-right font-medium">{t("Attendance")}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {classes.slice(0, classShown).map((c) => {
                      const full = c.fill_pct >= 100;
                      const low = c.fill_pct < 40;
                      return (
                        <tr key={c.id} className="border-t border-line/50 transition-colors duration-150 hover:bg-fg/[0.03]">
                          <td className="px-4 py-2.5">
                            <span className="flex items-center gap-2 font-medium">
                              <SportDot sport={c.sport} />
                              {sportLabel(c.sport)} · {levelLabel(c.level)}
                            </span>
                            <span className="block pl-4 font-mono text-2xs text-muted">{c.code}</span>
                          </td>
                          <td className="px-3 py-2.5 text-muted">{c.coach}</td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-3">
                              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-fg/[0.07]" aria-hidden="true">
                                <div
                                  className={cn("h-full rounded-full", full ? "bg-accent" : low ? "bg-muted/50" : "bg-accent/55")}
                                  style={{ width: `${Math.min(100, c.fill_pct)}%` }}
                                />
                              </div>
                              <span className="w-24 shrink-0 text-right text-xs tabular-nums">
                                <span className={cn("font-medium", full ? "text-accent" : low ? "text-muted" : "text-fg")}>
                                  {c.enrolled}/{c.capacity}
                                </span>
                                <span className="ml-1.5 text-muted">{c.fill_pct}%</span>
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            {c.waitlisted > 0 ? <Badge tone="hold">{c.waitlisted}</Badge> : <span className="text-muted/50">·</span>}
                          </td>
                          {showAttendance ? (
                            <td className="px-4 py-2.5 text-right tabular-nums">{pctText(c.attendance_pct)}</td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="pb-4">
              <ShowMore shown={classShown} total={classes.length} step={CLASS_STEP} onMore={() => setClassShown((n) => n + CLASS_STEP)} />
            </div>
          </Card>
        </>
      )}
    </section>
  );
}
