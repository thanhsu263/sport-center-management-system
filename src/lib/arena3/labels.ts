import { t, tk } from "./translator.ts";

/**
 * Label tables are module-scope, so they hold English (marked with `tk`) and translate when a
 * property is read: `LEVEL_LABEL[x]` returns the text in the language that is on at that moment.
 */
function lazyLabels(record: Record<string, string>): Record<string, string> {
  return new Proxy(record, {
    get(target, key, receiver) {
      const v = Reflect.get(target, key, receiver);
      return typeof key === "string" && typeof v === "string" ? t(v) : v;
    },
  });
}

export const SPORT_LABEL: Record<string, string> = lazyLabels({
  badminton: tk("Badminton"),
  basketball: tk("Basketball"),
  volleyball: tk("Volleyball"),
  all: tk("All 3 sports"),
});

export const ROLE_LABEL: Record<string, string> = lazyLabels({
  manager: tk("Manager"),
  receptionist: tk("Front desk"),
  coach: tk("Coach"),
  member: tk("Member"),
});

export const LEVEL_LABEL: Record<string, string> = lazyLabels({
  beginner: tk("Beginner"),
  intermediate: tk("Intermediate"),
  advanced: tk("Advanced"),
  team: tk("Team"),
  new: tk("Beginner"),
  tb: tk("Intermediate"),
  nc: tk("Advanced"),
});

export const STATUS_LABEL: Record<string, string> = lazyLabels({
  confirmed: tk("Confirmed"),
  hold: tk("On hold"),
  in_use: tk("Playing"),
  cancelled: tk("Cancelled"),
  completed: tk("Completed"),
  noshow: tk("No-show"),
  active: tk("Active"),
  pending: tk("Unpaid"),
  expired: tk("Expired"),
  frozen: tk("Frozen"),
  draft: tk("Draft"),
  published: tk("Published"),
  archived: tk("Archived"),
  open: tk("Open"),
  closed: tk("Closed"),
  waitlisted: tk("Waitlisted"),
  present: tk("Present"),
  late: tk("Late"),
  absent: tk("Absent"),
  excused: tk("Excused"),
  out: tk("Checked out"),
  returned: tk("Returned"),
  // Class sessions: a finished one used to show the raw word "done".
  done: tk("Session done"),
  scheduled: tk("Scheduled"),
});

export const KIND_LABEL: Record<string, string> = lazyLabels({
  hold: tk("Hold"),
  booking: tk("Booking"),
  session: tk("Class"),
  maintenance: tk("Maintenance"),
});

/**
 * What one hour on one court is doing, as the grid paints it.
 *
 * An occupancy row only says *what was sold*; this is what the centre needs to
 * *run* the day. "Booked" and "In use" are the same booking an hour apart, and
 * telling them apart is the difference between a court reception can prepare
 * and a court someone is standing on. "Maintenance" and "Closed" are not sales
 * states at all — they are the building saying no.
 */
export const SLOT_STATE_LABEL: Record<string, string> = lazyLabels({
  free: tk("Free"),
  hold: tk("On hold"),
  booked: tk("Booked"),
  in_use: tk("In use"),
  class: tk("Class"),
  maintenance: tk("Maintenance"),
  closed: tk("Closed"),
  past: tk("Already passed"),
});

export function slotStateLabel(s: string) {
  return SLOT_STATE_LABEL[s] ?? s;
}

export const DAY_KIND_LABEL: Record<string, string> = lazyLabels({
  weekday: tk("Weekday"),
  weekend: tk("Weekend"),
  holiday: tk("Holiday"),
});

const BYDAY: Record<string, string> = {
  MO: tk("Mon"),
  TU: tk("Tue"),
  WE: tk("Wed"),
  TH: tk("Thu"),
  FR: tk("Fri"),
  SA: tk("Sat"),
  SU: tk("Sun"),
};

/**
 * What a subscription actually gives its holder, in the words the member reads.
 * Driven by the plan's own grants: a session pack has no court hours to show,
 * and a court-hours pack has no sessions, so each line appears only for a plan
 * that carries it.
 */
export function planBenefits(s: {
  plan_court_hours?: number | null;
  plan_session_quota?: number | null;
  court_hours_left: string | number;
  session_left?: number | null;
  court_discount_pct?: number | null;
}): string[] {
  const out: string[] = [];
  if ((s.plan_court_hours ?? 0) > 0) out.push(t("{n} court hours left", { n: Number(s.court_hours_left) }));
  if (s.plan_session_quota != null) out.push(t("{n} sessions left", { n: s.session_left ?? 0 }));
  if ((s.court_discount_pct ?? 0) > 0) out.push(t("{n}% off courts", { n: s.court_discount_pct ?? 0 }));
  return out.length ? out : [t("Membership")];
}

export function sportLabel(s: string) {
  return SPORT_LABEL[s] ?? s;
}

const CODE_SPORT: Record<string, string> = { badminton: "BAD", basketball: "BAS", volleyball: "VOL" };
const CODE_LEVEL: Record<string, string> = { beginner: "BEG", intermediate: "INT", advanced: "ADV", team: "SQD" };

/**
 * A short, stable code for a class — "BAD-BEG-1F3A".
 *
 * Classes carry no code of their own, and "Beginner" on its own does not say
 * which of the three beginner badminton classes a coach or the desk means.
 * Sport and level make it readable aloud; the last four characters of the id
 * make it unique. Derived rather than stored: no schema change, and it can
 * never drift from the row it names.
 */
export function classCode(sport: string, level: string, id: string) {
  const sp = CODE_SPORT[sport] ?? sport.slice(0, 3).toUpperCase();
  const lv = CODE_LEVEL[level.toLowerCase()] ?? level.slice(0, 3).toUpperCase();
  return `${sp}-${lv}-${id.replace(/-/g, "").slice(-4).toUpperCase()}`;
}

export function roleLabel(s: string) {
  return ROLE_LABEL[s] ?? s;
}

export function levelLabel(s: string) {
  return LEVEL_LABEL[s.toLowerCase()] ?? s;
}

export function statusLabel(s: string) {
  return STATUS_LABEL[s] ?? s;
}

export function kindLabel(s: string) {
  return KIND_LABEL[s] ?? s;
}

export function statusTone(s: string): "ink" | "accent" | "hold" | "muted" | "danger" {
  if (s === "hold" || s === "pending" || s === "waitlisted") return "hold";
  if (s === "cancelled" || s === "expired" || s === "noshow" || s === "frozen") return "danger";
  if (s === "confirmed" || s === "active" || s === "published" || s === "in_use" || s === "completed") return "accent";
  return "muted";
}

export const METHOD_LABEL: Record<string, string> = lazyLabels({
  cash: tk("Cash"),
  transfer: tk("Bank transfer"),
  card: tk("Card"),
  gateway: tk("Online gateway"),
  quota: tk("Plan hours"),
});

/**
 * Payment methods in Vietnamese, for the printed invoice only.
 *
 * The interface is in English; an invoice is a Vietnamese document that gets
 * filed, so it does not borrow the UI's wording.
 */
export const METHOD_LABEL_VI: Record<string, string> = {
  cash: "Tiền mặt",
  transfer: "Chuyển khoản",
  card: "Thẻ",
  gateway: "Cổng thanh toán",
  quota: "Trừ giờ trong gói",
};

export function methodLabelVi(s: string) {
  return METHOD_LABEL_VI[s] ?? s;
}

export const SOURCE_LABEL: Record<string, string> = lazyLabels({
  court: tk("Court rental"),
  booking: tk("Court rental"),
  class: tk("Class"),
  membership: tk("Plan"),
  subscription: tk("Plan"),
  walk_in: tk("Walk-in"),
  other: tk("Other"),
});

export function methodLabel(s: string) {
  return METHOD_LABEL[s] ?? s;
}

export function sourceLabel(s: string) {
  return SOURCE_LABEL[s] ?? s;
}

/** What a payment or refund was raised against, in words the desk uses. */
export function refTypeLabel(r: string) {
  const label = (
    {
      subscription: tk("Plan"),
      booking: tk("Booking"),
      day_pass: tk("Day pass"),
      walkin: tk("Walk-in"),
      equipment: tk("Equipment hire"),
    } as Record<string, string>
  )[r];
  return label ? t(label) : r;
}

const MONTH_SHORT = [
  tk("Jan"),
  tk("Feb"),
  tk("Mar"),
  tk("Apr"),
  tk("May"),
  tk("Jun"),
  tk("Jul"),
  tk("Aug"),
  tk("Sep"),
  tk("Oct"),
  tk("Nov"),
  tk("Dec"),
];

/** 2026-09-17 → 17 Sep 2026 */
export function formatDate(iso: string) {
  const day = iso.slice(0, 10);
  const [y, m, d] = day.split("-");
  if (!y || !m || !d) return iso;
  const month = MONTH_SHORT[Number(m) - 1];
  if (!month) return iso;
  return `${Number(d)} ${t(month)} ${y}`;
}

export function addDaysISO(iso: string, days: number) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + days));
  return dt.toISOString().slice(0, 10);
}

export function weekdayShort(iso: string) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  return t([tk("Sun"), tk("Mon"), tk("Tue"), tk("Wed"), tk("Thu"), tk("Fri"), tk("Sat")][dt.getUTCDay()] ?? "");
}

export function todayISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const DAY_ORDER = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** Weekday codes in calendar order, unknown tokens dropped. Click order is not kept. */
function orderedDays(raw: string): string[] {
  const seen = new Set(
    raw
      .split(",")
      .map((d) => d.trim())
      .filter((d) => DAY_ORDER.includes(d)),
  );
  return DAY_ORDER.filter((d) => seen.has(d));
}

function clock(mins: number): string {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=18 → Mon, Wed · 18:00. With a duration, the end is on the label too. */
export function rruleLabel(rrule: string, durationMin?: number) {
  const parts = Object.fromEntries(
    rrule.split(";").map((p) => {
      const [k, v] = p.split("=");
      return [k ?? "", v ?? ""];
    }),
  );
  const codes = orderedDays(parts.BYDAY ?? "");
  const days =
    codes.length === 7
      ? t("Every day")
      : codes
          .map((d) => t(BYDAY[d]!))
          .filter(Boolean)
          .join(", ");
  const hour = parts.BYHOUR != null && parts.BYHOUR !== "" ? Number(parts.BYHOUR) : NaN;
  const start = Number.isFinite(hour) ? clock(hour * 60) : "";
  const range = start && durationMin && durationMin > 0 ? `${start}–${clock(hour * 60 + durationMin)}` : start;
  if (days && range) return `${days} · ${range}`;
  if (days) return days;
  return rrule;
}

export function composeWeeklyRrule(days: string[], hour: number) {
  const byday = orderedDays(days.join(",")).join(",") || "MO";
  return `FREQ=WEEKLY;BYDAY=${byday};BYHOUR=${hour}`;
}

export function parseWeeklyRrule(rrule: string): { days: string[]; hour: number } {
  const parts = Object.fromEntries(
    rrule.split(";").map((p) => {
      const [k, v] = p.split("=");
      return [k ?? "", v ?? ""];
    }),
  );
  const days = (parts.BYDAY ?? "MO")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  return { days, hour: Number(parts.BYHOUR ?? 18) };
}
