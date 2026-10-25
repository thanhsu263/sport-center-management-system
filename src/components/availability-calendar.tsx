import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/arena3/client";
import { cn } from "@/lib/cn";
import { addDaysISO, todayISO } from "@/lib/arena3/labels";
import { locale, t, tk } from "@/lib/i18n";

/**
 * One day of the calendar: how many court-slots are still free (M-03), and for a member how many
 * courts they already hold that day against the daily cap (BR-05).
 */
export type DayAvail = { date: string; free: number; total: number; bookable: boolean; mine?: number; cap?: number };
export type AvailMap = Record<string, DayAvail>;

const SPAN_DAYS = 62;

/**
 * Free-slot counts for the coming two months, in one request. `refreshKey`
 * changes whenever the member's own action could have changed them (a hold, a
 * move), so the calendar never keeps showing a slot they just took.
 */
export function useAvailability(sport: string, refreshKey: unknown): AvailMap | null {
  const [map, setMap] = useState<AvailMap | null>(null);
  useEffect(() => {
    let live = true;
    const q = sport ? `&sport=${encodeURIComponent(sport)}` : "";
    void apiGet<{ days: DayAvail[]; cap?: number }>(`/availability?from=${todayISO()}&days=${SPAN_DAYS}${q}`)
      .then((r) => {
        if (live) setMap(Object.fromEntries(r.days.map((d) => [d.date, { ...d, cap: r.cap }])));
      })
      .catch(() => {
        // The calendar is a convenience: without counts the day buttons still work.
        if (live) setMap({});
      });
    return () => {
      live = false;
    };
  }, [sport, refreshKey]);
  return map;
}

/**
 * "12 free" / "Full" / "You have 2" / nothing, for a day the member cannot book yet. "Full" means
 * the hall is full; a member at their own daily cap is told that instead (B-3, BR-05).
 */
export function availLabel(a: DayAvail | undefined): string {
  if (!a || !a.bookable) return "";
  if (a.cap != null && a.mine != null && a.mine >= a.cap) return t("You have {n}", { n: a.mine });
  return a.free > 0 ? t("{n} free", { n: a.free }) : t("Full");
}

const WEEKDAYS = [tk("Mon"), tk("Tue"), tk("Wed"), tk("Thu"), tk("Fri"), tk("Sat"), tk("Sun")];

function monthStart(iso: string) {
  return `${iso.slice(0, 7)}-01`;
}
function shiftMonth(iso: string, by: number) {
  const [y, m] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1 + by, 1));
  return dt.toISOString().slice(0, 10);
}
function monthTitle(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale(), {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * A month at a glance: every day says how many slots are left, so "any evening
 * next week" is one look instead of opening each day. A day that is past or not
 * yet open for booking is shown but cannot be picked.
 */
export function MonthCalendar({
  value,
  onChange,
  avail,
}: {
  value: string;
  onChange: (iso: string) => void;
  avail: AvailMap | null;
}) {
  const today = todayISO();
  const [month, setMonth] = useState(() => monthStart(value));
  // Follow the selected date when it moves to another month (date picker, strip).
  useEffect(() => setMonth(monthStart(value)), [value]);

  const cells = useMemo(() => {
    const first = month;
    const lead = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday first
    const next = shiftMonth(first, 1);
    const days = Math.round((Date.parse(next) - Date.parse(first)) / 86400000);
    return [
      ...Array.from({ length: lead }, () => null),
      ...Array.from({ length: days }, (_, i) => addDaysISO(first, i)),
    ];
  }, [month]);

  const known = avail !== null && Object.keys(avail).length > 0;
  const canPrev = month > monthStart(today);
  const canNext = shiftMonth(month, 1) <= addDaysISO(today, SPAN_DAYS - 1);

  return (
    <div className="rounded-[var(--radius-lg)] bg-surface p-3 shadow-[var(--shadow-border)]">
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          aria-label={t("Previous month")}
          disabled={!canPrev}
          onClick={() => setMonth(shiftMonth(month, -1))}
          className="grid size-11 place-items-center rounded-full hover:bg-wood disabled:opacity-30 sm:size-9"
        >
          <ChevronLeft className="size-4" />
        </button>
        <p className="font-display text-lg">{monthTitle(month)}</p>
        <button
          type="button"
          aria-label={t("Next month")}
          disabled={!canNext}
          onClick={() => setMonth(shiftMonth(month, 1))}
          className="grid size-11 place-items-center rounded-full hover:bg-wood disabled:opacity-30 sm:size-9"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-2xs font-medium text-muted">
        {WEEKDAYS.map((d) => (
          <span key={d}>{t(d)}</span>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((iso, i) => {
          if (!iso) return <span key={`pad-${i}`} />;
          const a = avail?.[iso];
          const past = iso < today;
          const open = !past && (known ? Boolean(a?.bookable) : true);
          const on = iso === value;
          const label = availLabel(a);
          return (
            <button
              key={iso}
              type="button"
              disabled={past || !open}
              onClick={() => onChange(iso)}
              aria-pressed={on}
              aria-label={`${iso}${label ? `, ${label}` : ""}`}
              className={cn(
                "flex min-h-14 flex-col items-center justify-center rounded-[var(--radius-md)] px-1 text-center transition-colors",
                on ? "bg-accent text-accent-fg" : open ? "bg-wood/60 hover:bg-wood" : "opacity-40",
              )}
            >
              <span className="font-display text-base tabular-nums leading-none">{Number(iso.slice(8, 10))}</span>
              <span
                className={cn(
                  "mt-1 text-2xs leading-none",
                  on ? "opacity-90" : a && a.free === 0 && open ? "text-muted line-through" : "text-accent-2",
                )}
              >
                {label || (past ? "" : "·")}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-2xs text-muted">
        {t("Numbers are free court-hours that day. Days further out open for booking as the date approaches.")}
      </p>
    </div>
  );
}
