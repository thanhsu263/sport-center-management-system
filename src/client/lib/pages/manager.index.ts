import { useEffect, useState } from "react";
import { type Court, type OccSlot } from "@/client/components/court-grid";
import { money } from "@/client/components/shell";
import { type Trend } from "@/client/components/ui";
import { t } from "@/client/lib/i18n";
import { addDaysISO, methodLabel, sourceLabel, todayISO } from "@/shared/arena3/labels";
import { useRead } from "@/client/lib/use-read";


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
  itemStyle: { color: "var(--color-fg)", fontWeight: 600 },
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

export function useManagerOverview() {
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
  return {
    from, setFrom, to, setTo, period, setPeriod, method, setMethod, revRead, occRead, mapRead, rev,
    prev, occ, map, missingReceptionist, missingCoach, revError, refused, faulty, dayError,
    chartReady, applyPeriod, chartData, sourceData, trendData, showTrend,
  };
}

export { delta, compactVnd, TOOLTIP, downloadCsv };
