import { Link, createFileRoute } from "@tanstack/react-router";
import {
  Banknote,
  Clock,
  FileText,
  HandCoins,
  Hourglass,
  Image,
  LandPlot,
  Layers,
  PiggyBank,
  Repeat,
  Settings,
  Tag,
  TrendingUp,
  Trophy,
  Undo2,
  UserCog,
  UserPlus,
  Wallet,
  Wrench,
} from "lucide-react";
import { CardTitle } from "@/components/section";
import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const CHART_METHOD_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
];
import { CourtGrid, type Court, type OccSlot } from "@/components/court-grid";
import { Shell, money, when } from "@/components/shell";
import { PageHero } from "@/components/page-hero";
import { SportThumbnail } from "@/components/sports-ui";
import { CapacityPanel, ExportButtons, MembersPanel } from "@/components/report-panels";
import { Button, ButtonAnchor, ButtonLink, Card, DateField, LoadError, Select, Seg, Skeleton, Stat, type Trend } from "@/components/ui";
import { CountUp, Reveal, Stagger, StaggerItem, motion } from "@/components/motion";
import { GLBackground, SplitText, SpotlightCard } from "@/components/fx";
import { t } from "@/lib/i18n";
import { addDaysISO, formatDate, methodLabel, sourceLabel, todayISO } from "@/lib/arena3/labels";
import { useRead } from "@/lib/use-read";

export const Route = createFileRoute("/manager/")({
  component: Page,
});

type Rev = {
  from: string;
  to: string;
  totals: { revenue_vnd: number; gross_vnd?: number; refund_vnd: number; quota_hours: number };
  by_source: Record<string, number>;
  refunds_by_source?: Record<string, number>;
  by_shift?: Array<{
    shift_id: string | null;
    cashier: string | null;
    opened_at: string | null;
    closed_at: string | null;
    takings_vnd: number;
    refunds_vnd: number;
    count: number;
  }>;
  by_method: Record<string, number>;
  /** One row per ICT day in the window, including days with no takings. */
  by_day?: Array<{ day: string; revenue_vnd: number }>;
  /** The window just before this one, same length and same method filter. */
  prev?: Pick<Rev, "from" | "to" | "totals" | "by_source">;
};

type Occ = { date: string; items: Array<{ court_code: string; minutes: number; pct: number }> };

function monthStart(iso: string) {
  return `${iso.slice(0, 7)}-01`;
}

/**
 * This period against the one before it.
 *
 * `upIsGood` is asked for rather than assumed. These three tiles sit in a row
 * and two of them mean opposite things: revenue rising is the centre having a
 * good week, refunds rising is the centre having a bad one. A single colour
 * rule keyed on the sign would paint a week of refunds green.
 */
function delta(cur: number, prev: number, upIsGood: boolean): Trend {
  if (prev === 0 && cur === 0) return { pct: 0, label: t("Same as the previous period"), good: null };
  if (prev === 0) return { pct: null, label: t("New this period"), good: upIsGood };
  const pct = Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10;
  const sign = pct > 0 ? "+" : "";
  return {
    pct,
    label: t("{pct}% vs the previous period", { pct: `${sign}${pct}` }),
    good: pct === 0 ? null : pct > 0 === upIsGood,
  };
}

/**
 * Axis ticks in the shortest form that is still unambiguous.
 *
 * Full VND on an axis is six to nine digits per tick, which crowds them into
 * each other; the tooltip carries the exact figure.
 */
function compactVnd(v: number): string {
  if (!v) return "0";
  if (Math.abs(v) >= 1_000_000) return `${Math.round(v / 100_000) / 10}tr`;
  if (Math.abs(v) >= 1_000) return `${Math.round(v / 1_000)}k`;
  return String(v);
}

/** One tooltip skin for every chart on the page, in the app's own surface. */
const TOOLTIP = {
  formatter: (v: unknown) => money(Number(v ?? 0)),
  contentStyle: {
    background: "var(--color-surface)",
    border: "1px solid var(--color-line)",
    borderRadius: 12,
    fontSize: 12,
  },
  labelStyle: { color: "var(--color-muted)", fontSize: 12 },
} as const;

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const body = rows
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";"))
    .join("\r\n");
  const blob = new Blob(["\uFEFF" + body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function Page() {
  const today = todayISO();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [period, setPeriod] = useState("today");
  const [method, setMethod] = useState("");
  // The server returns the previous window of the same length alongside, with
  // the same method filter, so the comparison is always like for like.
  const revRead = useRead<Rev>(`/reports/revenue?from=${from}&to=${to}${method ? `&method=${method}` : ""}`);
  // Court usage and the map are about the last day of the window only, so a window the server
  // refuses leaves them standing.
  const occRead = useRead<Occ>(`/reports/occupancy?date=${to}`);
  const mapRead = useRead<{ courts: Court[]; slots: OccSlot[] }>(`/occupancy?date=${to}`);
  const staffRead = useRead<{ items: Array<{ role: string; status: string }> }>("/staff?limit=100");
  const rev = revRead.data;
  const prev = rev?.prev ?? null;
  const occ = occRead.data;
  const map = mapRead.data;
  const activeReceptionists = staffRead.data?.items.filter((s) => s.role === "receptionist" && s.status === "active") ?? [];
  const activeCoaches = staffRead.data?.items.filter((s) => s.role === "coach" && s.status === "active") ?? [];
  const hasLoadedStaff = !!staffRead.data;
  const missingReceptionist = hasLoadedStaff && activeReceptionists.length === 0;
  const missingCoach = hasLoadedStaff && activeCoaches.length === 0;
  // A window the server refuses (backwards, far too long) is said once, where the numbers would
  // be, with the date box it is about marked. Asking again gets the same words, so there is no
  // "Try again", and nothing counted from the window is shown as if it were zero.
  const revError = revRead.error;
  const refused = revError?.refused === true;
  const faulty = (f: "from" | "to") => refused && (revError?.field ? revError.field === f : true);
  const dayError = occRead.error ?? mapRead.error;
  const [chartReady, setChartReady] = useState(false);
  useEffect(() => setChartReady(true), []);

  function applyPeriod(p: string) {
    setPeriod(p);
    if (p === "today") {
      setFrom(today);
      setTo(today);
    } else if (p === "week") {
      setFrom(addDaysISO(today, -6));
      setTo(today);
    } else if (p === "month") {
      setFrom(monthStart(today));
      setTo(today);
    }
  }

  const chartData = Object.entries(rev?.by_method ?? {}).map(([k, v]) => ({
    name: methodLabel(k),
    vnd: v,
  }));
  // Biggest first: a magnitude comparison is read down the list, and leaving it
  // in map order makes the reader do the sorting themselves.
  const sourceData = Object.entries(rev?.by_source ?? {})
    .map(([k, v]) => ({ name: sourceLabel(k), vnd: v }))
    .sort((a, b) => b.vnd - a.vnd);
  const trendData = (rev?.by_day ?? []).map((d) => ({
    day: d.day.slice(8) + "/" + d.day.slice(5, 7),
    vnd: d.revenue_vnd,
  }));
  // One day is a point, not a trend — the tiles above already say that number.
  const showTrend = trendData.length > 1;

  return (
    <Shell role="manager">
      <PageHero
        slot="banner.manager"
        title={t("Reports")}
        subtitle={t("Revenue = payments taken − refunds. Court usage for {date}.", { date: formatDate(to) })}
        stats={[
          { label: t("Revenue"), value: rev ? money(rev.totals.revenue_vnd) : "..." },
          { label: t("Refunds"), value: rev ? money(rev.totals.refund_vnd ?? 0) : "0 đ" },
          { label: t("Plan hours used"), value: rev?.totals.quota_hours ?? 0 },
        ]}
      />
      <section aria-label={t("Quick actions")} className="mb-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Link
            to="/manager/courts"
            className="group relative overflow-hidden rounded-[var(--radius-xl)] border border-line bg-surface p-4 shadow-[var(--shadow-border)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-soft)]"
          >
            <div className="flex items-center gap-3">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-surface-2 text-fg border border-line">
                <LandPlot className="size-6 text-accent" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-fg transition-colors group-hover:text-accent-2">{t("Courts & map")}</p>
                <p className="truncate text-xs text-muted">{t("Inspect courts & status")}</p>
              </div>
            </div>
          </Link>
          <Link
            to="/manager/sports"
            className="group relative overflow-hidden rounded-[var(--radius-xl)] border border-line bg-surface p-4 shadow-[var(--shadow-border)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-soft)]"
          >
            <div className="flex items-center gap-3">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-surface-2 text-fg border border-line">
                <Trophy className="size-6 text-accent" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-fg transition-colors group-hover:text-accent-2">{t("Sports")}</p>
                <p className="truncate text-xs text-muted">{t("Prefixes, rules & colors")}</p>
              </div>
            </div>
          </Link>
          <Link
            to="/manager/staff"
            className="group relative overflow-hidden rounded-[var(--radius-xl)] border border-line bg-surface p-4 shadow-[var(--shadow-border)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-soft)]"
          >
            <div className="flex items-center gap-3">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-surface-2 text-fg border border-line">
                <UserCog className="size-6 text-accent" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-fg transition-colors group-hover:text-accent-2">{t("Staff management")}</p>
                <p className="truncate text-xs text-muted">{t("Coaches & receptionists")}</p>
              </div>
            </div>
          </Link>
          <Link
            to="/manager/media"
            className="group relative overflow-hidden rounded-[var(--radius-xl)] border border-line bg-surface p-4 shadow-[var(--shadow-border)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-soft)]"
          >
            <div className="flex items-center gap-3">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-surface-2 text-fg border border-line">
                <Image className="size-6 text-accent" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-fg transition-colors group-hover:text-accent-2">{t("Media & banners")}</p>
                <p className="truncate text-xs text-muted">{t("Site photos & slots")}</p>
              </div>
            </div>
          </Link>
        </div>
      </section>
      <GLBackground
        variant="dotgrid"
        position="fixed"
        className="-z-[1]"
        color="#3f7d20"
        gap={32}
        dot={1.5}
        radius={130}
        opacity={0.22}
      />
      {missingReceptionist ? (
        <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 border-warn/30 bg-warn/10 p-4">
          <div className="flex items-center gap-3">
            <UserPlus className="size-5 shrink-0 text-warn" />
            <div>
              <p className="font-semibold text-fg">{t("No active receptionist, add one now")}</p>
              <p className="text-xs text-muted">
                {t("Add a receptionist now so the front desk can operate and check players in.")}
              </p>
            </div>
          </div>
          <ButtonAnchor
            href="/manager/staff?create=1&role=receptionist"
            variant="outline"
            size="sm"
            className="border-warn/40 text-fg hover:bg-warn/20"
          >
            {t("Add staff")}
          </ButtonAnchor>
        </Card>
      ) : null}
      {missingCoach ? (
        <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 border-warn/30 bg-warn/10 p-4">
          <div className="flex items-center gap-3">
            <UserPlus className="size-5 shrink-0 text-warn" />
            <div>
              <p className="font-semibold text-fg">{t("No active coaches, add one now")}</p>
              <p className="text-xs text-muted">
                {t("Add a coach now to schedule classes and assign students.")}
              </p>
            </div>
          </div>
          <ButtonAnchor
            href="/manager/staff?create=1&role=coach"
            variant="outline"
            size="sm"
            className="border-warn/40 text-fg hover:bg-warn/20"
          >
            {t("Add staff")}
          </ButtonAnchor>
        </Card>
      ) : null}
      {/* Everything the manager runs besides the numbers. Phones reach the same pages from the
          bottom bar's More sheet, so the strip is for screens with room for it. */}
      <nav aria-label={t("Quick links")} className="mb-5 hidden flex-wrap gap-2 md:flex">
        {(
          [
            { to: "/manager/courts" as const, label: t("Courts"), Icon: LandPlot },
            { to: "/manager/media" as const, label: t("Media"), Icon: Image },
            { to: "/manager/staff" as const, label: t("Staff"), Icon: UserCog },
            { href: "/manager/staff?create=1", label: t("Add staff"), Icon: UserPlus },
            { to: "/manager/plans" as const, label: t("Plans"), Icon: Wallet },
            { to: "/manager/promos" as const, label: t("Promos"), Icon: Tag },
            { to: "/manager/prices" as const, label: t("Pricing"), Icon: Settings },
            { to: "/desk/series" as const, label: t("Fixed bookings"), Icon: Repeat },
            { to: "/manager/commission" as const, label: t("Commission"), Icon: HandCoins },
            { to: "/manager/invoices" as const, label: t("E-invoices"), Icon: FileText },
            { to: "/desk/maintenance" as const, label: t("Maintenance"), Icon: Wrench },
          ] as const
        ).map((a) =>
          "href" in a ? (
            <ButtonAnchor key={a.label} href={a.href} variant="outline" size="sm">
              <a.Icon aria-hidden="true" className="size-4 text-muted" strokeWidth={1.75} />
              {a.label}
            </ButtonAnchor>
          ) : (
            <ButtonLink key={a.label} to={a.to} variant="outline" size="sm">
              <a.Icon aria-hidden="true" className="size-4 text-muted" strokeWidth={1.75} />
              {a.label}
            </ButtonLink>
          ),
        )}
      </nav>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Seg
          value={period}
          onChange={applyPeriod}
          options={[
            { value: "today", label: t("Today") },
            { value: "week", label: t("7 days") },
            { value: "month", label: t("This month") },
            { value: "custom", label: t("Custom") },
          ]}
        />
      {period === "custom" ? (
        <>
        <span className="text-2xs text-muted">{t("From")}</span>
        <DateField
          required
          value={from}
          max={to}
          onChange={(v) => {
            setPeriod("custom");
            setFrom(v);
          }}
          invalid={faulty("from")}
          aria-describedby={faulty("from") ? "report-error" : undefined}
          aria-label={t("From date")}
        />
        <span className="text-2xs text-muted">{t("To")}</span>
        <DateField
          required
          value={to}
          min={from}
          onChange={(v) => {
            setPeriod("custom");
            setTo(v);
          }}
          invalid={faulty("to")}
          aria-describedby={faulty("to") ? "report-error" : undefined}
          aria-label={t("To date")}
        />
        </>
      ) : null}
        <div className="w-full min-w-0 sm:w-52">
          <Select aria-label={t("Payment method")} value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="">{t("All methods")}</option>
            {["cash", "transfer", "card", "gateway", "quota"].map((m) => (
              <option key={m} value={m}>
                {methodLabel(m)}
              </option>
            ))}
          </Select>
        </div>
        <ExportButtons kind="revenue" from={from} to={to} extra={{ method }} disabled={refused} />
        <Button
          variant="outline"
          size="sm"
          disabled={!rev}
          onClick={() => {
            if (!rev) return;
            downloadCsv(`arena3-report-${from}_${to}.csv`, [
              [t("From"), formatDate(from), t("To"), formatDate(to)],
              [
                t("Revenue"),
                rev.totals.revenue_vnd,
                t("Refunds"),
                rev.totals.refund_vnd ?? 0,
                t("Plan hours used"),
                rev.totals.quota_hours,
              ],
              [],
              [t("Method"), t("Amount")],
              ...Object.entries(rev.by_method).map(([k, v]) => [methodLabel(k), v]),
              [],
              [t("Source"), t("Amount")],
              ...Object.entries(rev.by_source).map(([k, v]) => [sourceLabel(k), v]),
              [],
              [t("Court"), t("Minutes"), "%"],
              ...(occ?.items ?? []).map((c) => [c.court_code, c.minutes, c.pct]),
            ]);
          }}
        >
          {t("Export CSV")}
        </Button>
      </div>
      {revError ? (
        <LoadError id="report-error" message={revError.message} onRetry={refused ? undefined : revRead.reload} />
      ) : !rev ? (
        <div className="grid gap-3 md:grid-cols-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : (
        <Stagger className="grid gap-3 md:grid-cols-3" gap={0.08}>
          <StaggerItem>
          <Stat
            label={t("Revenue")}
            icon={Banknote}
            note={t("Payments taken, minus refunds")}
            value={money(rev.totals.revenue_vnd)}
            trend={prev ? delta(rev.totals.revenue_vnd, prev.totals.revenue_vnd, true) : undefined}
          />
          </StaggerItem>
          <StaggerItem>
          <Stat
            label={t("Refunds")}
            icon={Undo2}
            note={t("Money handed back to members")}
            value={money(rev.totals.refund_vnd ?? 0)}
            trend={prev ? delta(rev.totals.refund_vnd ?? 0, prev.totals.refund_vnd ?? 0, false) : undefined}
          />
          </StaggerItem>
          <StaggerItem>
          <Stat
            label={t("Plan hours used")}
            icon={Hourglass}
            note={t("Court hours members drew from their plans")}
            value={rev.totals.quota_hours}
            trend={prev ? delta(rev.totals.quota_hours, prev.totals.quota_hours, true) : undefined}
          />
          </StaggerItem>
        </Stagger>
      )}

      {showTrend ? (
        <Reveal className="mt-6">
          <SpotlightCard className="rounded-[var(--radius-xl)]" size={520} strength={0.09}>
            <Card className="relative z-[2]">
<CardTitle icon={TrendingUp} title={t("Revenue per day")} hint={t("Each point is one day's takings, after refunds.")} />
              {chartReady ? (
                <div className="mt-3 h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={trendData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.28} />
                          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid vertical={false} stroke="var(--color-line)" strokeDasharray="2 4" />
                      <XAxis
                        dataKey="day"
                        tick={{ fontSize: 12 }}
                        stroke="var(--color-muted)"
                        tickLine={false}
                        minTickGap={16}
                      />
                      <YAxis
                        tick={{ fontSize: 12 }}
                        stroke="var(--color-muted)"
                        tickLine={false}
                        axisLine={false}
                        width={44}
                        tickFormatter={compactVnd}
                      />
                      <Tooltip {...TOOLTIP} labelFormatter={(l) => t("Day {d}", { d: String(l) })} />
                      <Area
                        type="monotone"
                        dataKey="vnd"
                        name={t("Revenue")}
                        stroke="var(--color-accent)"
                        strokeWidth={2}
                        fill="url(#revFill)"
                        dot={false}
                        activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--color-surface)" }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <Skeleton className="mt-3 h-56" />
              )}
            </Card>
          </SpotlightCard>
        </Reveal>
      ) : null}

      {/* Counted from the window: until it has answered (or when it was refused) these say nothing,
          rather than "Nothing recorded yet." about a period that was never read. */}
      {!rev ? (
        revError ? null : <Skeleton className="mt-6 h-52" />
      ) : (
      <Reveal className="mt-6 grid gap-3 md:grid-cols-2">
        <SpotlightCard className="rounded-[var(--radius-xl)]" size={380} strength={0.09}>
        <Card className="relative z-[2] h-full">
          <CardTitle icon={Wallet} title={t("By payment method")} hint={t("How members paid: cash, transfer, card or online.")} />
          {chartReady && chartData.length ? (
            <div className="mt-3 h-52">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--color-line)" strokeDasharray="2 4" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} stroke="var(--color-muted)" tickLine={false} />
                  <YAxis
                    tick={{ fontSize: 12 }}
                    stroke="var(--color-muted)"
                    tickLine={false}
                    axisLine={false}
                    width={44}
                    tickFormatter={compactVnd}
                  />
                  <Tooltip {...TOOLTIP} cursor={{ fill: "var(--color-wood)", opacity: 0.5 }} />
                  <Bar dataKey="vnd" name={t("Revenue")} radius={[4, 4, 0, 0]} maxBarSize={44}>
                    {chartData.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={CHART_METHOD_COLORS[index % CHART_METHOD_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted">{t("Nothing recorded yet.")}</p>
          )}
        </Card>
        </SpotlightCard>
        <SpotlightCard className="rounded-[var(--radius-xl)]" size={380} strength={0.09}>
        <Card className="relative z-[2] h-full">
          <CardTitle icon={Layers} title={t("By source")} hint={t("What the money was for: court rental or plans.")} />
          {chartReady && sourceData.length ? (
            <div className="mt-3 h-52">
              <ResponsiveContainer width="100%" height="100%">
                {/* Horizontal: the category names are words, and sideways
                    labels are the commonest reason a bar chart goes unread. */}
                <BarChart
                  layout="vertical"
                  data={sourceData}
                  margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                >
                  <CartesianGrid horizontal={false} stroke="var(--color-line)" strokeDasharray="2 4" />
                  <XAxis
                    type="number"
                    tick={{ fontSize: 12 }}
                    stroke="var(--color-muted)"
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={compactVnd}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fontSize: 12 }}
                    stroke="var(--color-muted)"
                    tickLine={false}
                    axisLine={false}
                    width={92}
                  />
                  <Tooltip {...TOOLTIP} cursor={{ fill: "var(--color-wood)", opacity: 0.5 }} />
                  <Bar dataKey="vnd" name={t("Revenue")} fill="var(--color-accent)" radius={[0, 4, 4, 0]} maxBarSize={22} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted">{t("Nothing recorded yet.")}</p>
          )}
        </Card>
        </SpotlightCard>
      </Reveal>
      )}

      {rev ? (
        <Reveal className="mt-6 grid gap-3 md:grid-cols-2">
          <Card>
            <CardTitle icon={PiggyBank} title={t("Where the money came from")} hint={t("The same revenue split by what was sold, with refunds shown.")} />
            {Object.keys(rev.by_source).length || Object.keys(rev.refunds_by_source ?? {}).length ? (
              <table className="mt-3 w-full text-sm">
                <thead className="text-left text-2xs text-muted">
                  <tr>
                    <th className="pb-1 font-medium">{t("Source")}</th>
                    <th className="pb-1 text-right font-medium">{t("Taken")}</th>
                    <th className="pb-1 text-right font-medium">{t("Refunded")}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...new Set([...Object.keys(rev.by_source), ...Object.keys(rev.refunds_by_source ?? {})])].map((k) => (
                    <tr key={k} className="border-t border-line/60">
                      <td className="py-1.5">{sourceLabel(k)}</td>
                      <td className="py-1.5 text-right tabular-nums">{money(rev.by_source[k] ?? 0)}</td>
                      <td className="py-1.5 text-right tabular-nums">{money(rev.refunds_by_source?.[k] ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="mt-3 text-sm text-muted">
                {t("Nothing taken in this period yet. Takings appear here once reception records a payment.")}
              </p>
            )}
            <p className="mt-3 text-xs text-muted">
              {t("Class places come out of a plan and gear hire is not charged as a payment, so neither has a line of its own.")}
            </p>
          </Card>
          <Card>
            <CardTitle icon={Clock} title={t("By cashier shift")} hint={t("Takings for each shift a cashier opened at the desk.")} />
            {rev.by_shift?.length ? (
              <table className="mt-3 w-full text-sm">
                <thead className="text-left text-2xs text-muted">
                  <tr>
                    <th className="pb-1 font-medium">{t("Shift")}</th>
                    <th className="pb-1 text-right font-medium">{t("Taken")}</th>
                    <th className="pb-1 text-right font-medium">{t("Refunded")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rev.by_shift.map((s) => (
                    <tr key={s.shift_id ?? "none"} className="border-t border-line/60">
                      <td className="py-1.5">
                        {s.shift_id ? (
                          <>
                            <span className="font-medium">{s.cashier ?? t("Reception")}</span>
                            <span className="block text-xs text-muted">
                              {s.opened_at ? when(s.opened_at) : ""}
                              {s.closed_at ? ` - ${when(s.closed_at)}` : ` - ${t("still open")}`}
                            </span>
                          </>
                        ) : (
                          <span className="text-muted">{t("Not taken at the desk (online)")}</span>
                        )}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{money(s.takings_vnd)}</td>
                      <td className="py-1.5 text-right tabular-nums">{money(s.refunds_vnd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="mt-3 text-sm text-muted">{t("No payments in this period, so there are no shifts to show.")}</p>
            )}
          </Card>
        </Reveal>
      ) : null}

      {/* These two ask for the same window, so a refusal is already said above. */}
      {refused ? null : (
        <>
          <CapacityPanel from={from} to={to} />
          <MembersPanel from={from} to={to} />
        </>
      )}

      <SplitText
        as="h2"
        text={t("Court usage · {date}", { date: formatDate(to) })}
        className="mt-8 font-display text-2xl"
      />
      {dayError ? (
        <div className="mt-3">
          <LoadError
            message={dayError.message}
            onRetry={
              dayError.refused
                ? undefined
                : () => {
                    occRead.reload();
                    mapRead.reload();
                  }
            }
          />
        </div>
      ) : (
        <>
      {!occ ? <Skeleton className="mt-3 h-24" /> : null}
      <Stagger className="mt-3 grid gap-2 md:grid-cols-2" gap={0.05}>
        {(occ?.items ?? []).map((c) => (
          <StaggerItem key={c.court_code}>
          <Card className="p-4">
            <div className="flex justify-between text-sm">
              <span className="font-medium">{c.court_code}</span>
              <span className="tabular-nums">
                <CountUp to={c.pct} duration={0.9} suffix="%" />
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-wood">
              <motion.div
                className="h-full bg-accent"
                initial={{ width: 0 }}
                whileInView={{ width: `${Math.min(100, c.pct)}%` }}
                viewport={{ once: true, margin: "-40px" }}
                transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
              />
            </div>
          </Card>
          </StaggerItem>
        ))}
      </Stagger>
      {map ? (
        <div className="mt-4">
          <CourtGrid date={to} courts={map.courts} slots={map.slots} defaultShowPast />
        </div>
      ) : (
        <Skeleton className="mt-4 h-64" />
      )}
        </>
      )}
    </Shell>
  );
}
