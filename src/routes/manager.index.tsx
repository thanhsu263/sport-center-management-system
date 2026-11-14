import { createFileRoute } from "@tanstack/react-router";
import { Banknote, Clock, Layers, PiggyBank, TrendingUp, Undo2, UserPlus, Wallet } from "lucide-react";
import { CardTitle } from "@/client/components/section";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Shell, money, when } from "@/client/components/shell";
import { PageHero } from "@/client/components/page-hero";
import { CapacityPanel, ExportButtons, MembersPanel } from "@/client/components/report-panels";
import { Button, ButtonAnchor, Card, DateField, LoadError, Select, Seg, Skeleton, Stat } from "@/client/components/ui";
import { CountUp, Reveal, Stagger, StaggerItem, motion } from "@/client/components/motion";
import { GLBackground, SplitText, SpotlightCard } from "@/client/components/fx";
import { t } from "@/client/lib/i18n";
import { formatDate, methodLabel, sourceLabel } from "@/shared/arena3/labels";
import { useManagerOverview, delta, compactVnd, TOOLTIP, downloadCsv } from "@/client/lib/pages/manager.index";


export const Route = createFileRoute("/manager/")({
  component: Page,
});

function Page() {
  const {
    from, setFrom, to, setTo, period, setPeriod, method, setMethod, revRead, occRead, mapRead, rev,
    prev, occ, missingReceptionist, missingCoach, revError, refused, faulty, dayError,
    chartReady, applyPeriod, chartData, sourceData, trendData, showTrend,
  } = useManagerOverview();

  return (
    <Shell role="manager">
      <PageHero
        slot="banner.manager"
        title={t("Reports")}
        subtitle={t("Revenue = payments taken − refunds. Court usage for {date}.", { date: formatDate(to) })}

      />
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
            downloadCsv(`lelong-report-${from}_${to}.csv`, [
              [t("From"), formatDate(from), t("To"), formatDate(to)],
              [
                t("Revenue"),
                rev.totals.revenue_vnd,
                t("Refunds"),
                rev.totals.refund_vnd ?? 0,
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
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : (
        <Stagger className="grid gap-3 md:grid-cols-2" gap={0.08}>
          <StaggerItem>
          <Stat
            label={t("Revenue")}
            icon={Banknote}
            note={t("Payments taken, minus refunds")}
            glass
            value={money(rev.totals.revenue_vnd)}
            trend={prev ? delta(rev.totals.revenue_vnd, prev.totals.revenue_vnd, true) : undefined}
          />
          </StaggerItem>
          <StaggerItem>
          <Stat
            label={t("Refunds")}
            icon={Undo2}
            note={t("Money handed back to members")}
            glass
            value={money(rev.totals.refund_vnd ?? 0)}
            trend={prev ? delta(rev.totals.refund_vnd ?? 0, prev.totals.refund_vnd ?? 0, false) : undefined}
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
                    {chartData.map((d, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill="var(--color-accent)"
                        fillOpacity={d.vnd === Math.max(...chartData.map((x) => x.vnd)) ? 1 : 0.45}
                      />
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
              {t("Class places are sold separately and gear hire is posted as a payment, so both appear as sources above (Class seat, Equipment hire). Plan hours used are not money and are not in these totals.")}
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
        </>
      )}

      {/* The whole-day court × hour grid sits last: it is the detail behind the numbers above. */}
      {refused ? null : <CapacityPanel from={from} to={to} part="busy" />}
    </Shell>
  );
}
