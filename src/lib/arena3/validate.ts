import { err } from "./errors.ts";

/**
 * Form validation that names the field.
 *
 * The settings screen used to send whatever the inputs held — `Number("")` is
 * `NaN`, which JSON turns into `null`, which a NOT NULL column refuses, which
 * surfaced as a blank "something went wrong". Every value is checked here
 * before it reaches SQL, and a bad one is a 400 that says which input to fix.
 */

/** Largest value an INT column holds. */
export const INT4_MAX = 2_147_483_647;

type IntRule = { kind: "int"; min: number; max: number };
type DecimalRule = { kind: "decimal"; min: number; max: number };
type TimeRule = { kind: "time" };
type TextRule = { kind: "text"; max: number };
type BoolRule = { kind: "bool" };
export type SettingRule = IntRule | DecimalRule | TimeRule | TextRule | BoolRule;

const int = (min: number, max: number): IntRule => ({ kind: "int", min, max });

/**
 * Every setting a manager may change, with the bounds the centre can live with.
 * `max` on the money columns is the INT limit: past it Postgres answers
 * "integer out of range", which is the manager's typo and not a server fault.
 */
export const SETTING_RULES: Record<string, SettingRule> = {
  open_time: { kind: "time" },
  close_time: { kind: "time" },
  hold_minutes: int(1, 120),
  book_ahead_days: int(1, 365),
  max_slots_per_day: int(1, 24),
  cancel_court_hours: int(0, 168),
  cancel_class_hours: int(0, 168),
  noshow_grace_minutes: int(0, 120),
  checkin_before_minutes: int(0, 240),
  self_checkin_enabled: { kind: "bool" },
  gate_dedup_minutes: int(1, 720),
  at_risk_idle_days: int(1, 90),
  refund_manager_vnd: int(0, INT4_MAX),
  minor_age: int(1, 100),
  vat_rate: { kind: "decimal", min: 0, max: 100 },
  freeze_max_days_year: int(0, 365),
  waitlist_offer_hours: int(1, 168),
  deposit_pct: int(0, 100),
  deposit_peak_only: { kind: "bool" },
  series_min_weeks: int(1, 52),
  series_max_weeks: int(1, 52),
  series_discount_pct: int(0, 50),
  loyalty_earn_vnd: int(1000, 10_000_000),
  loyalty_redeem_vnd: int(1, 100_000),
  // Column limits: legal_name VARCHAR(190), tax_code VARCHAR(20), address TEXT.
  legal_name: { kind: "text", max: 190 },
  tax_code: { kind: "text", max: 20 },
  address: { kind: "text", max: 500 },
};

export const SETTING_KEYS = Object.keys(SETTING_RULES);

/** Plain-language names, for messages a manager reads. */
const SETTING_LABEL: Record<string, string> = {
  open_time: "Opening time",
  close_time: "Closing time",
  hold_minutes: "Hold length",
  book_ahead_days: "Book-ahead window",
  max_slots_per_day: "Slots per day",
  cancel_court_hours: "Court cancellation window",
  cancel_class_hours: "Class cancellation window",
  noshow_grace_minutes: "No-show grace",
  checkin_before_minutes: "Check-in window",
  self_checkin_enabled: "Self check-in",
  gate_dedup_minutes: "Gate repeat window",
  at_risk_idle_days: "At-risk idle days",
  refund_manager_vnd: "Refund approval threshold",
  minor_age: "Minor age",
  vat_rate: "VAT rate",
  freeze_max_days_year: "Freeze cap",
  waitlist_offer_hours: "Waitlist offer window",
  deposit_pct: "Deposit",
  deposit_peak_only: "Deposit on peak slots only",
  series_min_weeks: "Fixed booking minimum weeks",
  series_max_weeks: "Fixed booking maximum weeks",
  series_discount_pct: "Fixed booking discount",
  loyalty_earn_vnd: "Spend per loyalty point",
  loyalty_redeem_vnd: "Value of a loyalty point",
  legal_name: "Legal name",
  tax_code: "Tax code",
  address: "Address",
};

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/**
 * A whole number from a JSON number or a numeric string. Anything else —
 * blank, `NaN`, `1e3`, `12.5`, `"abc"` — is rejected rather than coerced.
 */
export function parseInteger(field: string, label: string, v: unknown, min: number, max: number): number {
  if (isBlank(v)) throw err.field(field, `${label} is required.`);
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^-?\d+$/.test(v.trim())) n = Number(v.trim());
  else throw err.field(field, `${label} must be a whole number.`);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw err.field(field, `${label} must be a whole number.`);
  }
  if (n < min || n > max) {
    throw err.field(field, `${label} must be between ${min.toLocaleString("en-US")} and ${max.toLocaleString("en-US")}.`);
  }
  return n;
}

/**
 * `?limit=&offset=` for a paged list. Absent values fall back to `def` rows from the top, so a
 * caller that never asked for paging keeps the page it always got. Queries pair this with
 * `count(*) over ()` and answer `{ items, total, limit, offset }`.
 */
export function pageParams(
  request: Request,
  opts: { def: number; max: number; prefix?: string },
): { limit: number; offset: number } {
  const sp = new URL(request.url).searchParams;
  // A screen that pages two lists through one endpoint names one of them, e.g. `receipt_limit`.
  const key = (name: string) => `${opts.prefix ?? ""}${name}`;
  const rawLimit = sp.get(key("limit"));
  const rawOffset = sp.get(key("offset"));
  return {
    limit: rawLimit === null ? opts.def : parseInteger(key("limit"), "Page size", rawLimit, 1, opts.max),
    offset: rawOffset === null ? 0 : parseInteger(key("offset"), "Offset", rawOffset, 0, 1_000_000),
  };
}

function parseDecimal(field: string, label: string, v: unknown, min: number, max: number): number {
  if (isBlank(v)) throw err.field(field, `${label} is required.`);
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) n = Number(v.trim());
  else throw err.field(field, `${label} must be a number.`);
  if (!Number.isFinite(n)) throw err.field(field, `${label} must be a number.`);
  if (n < min || n > max) throw err.field(field, `${label} must be between ${min} and ${max}.`);
  // numeric(5,2): two decimals at most. Round here so 8.005 is not a surprise.
  return Math.round(n * 100) / 100;
}

/** `HH:MM` (seconds tolerated) on a 24-hour clock, normalised to `HH:MM`. */
export function parseClock(field: string, label: string, v: unknown): string {
  if (typeof v !== "string") throw err.field(field, `${label} must be a time like 06:00.`);
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(v.trim());
  if (!m) throw err.field(field, `${label} must be a time like 06:00.`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw err.field(field, `${label} must be a time like 06:00.`);
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * Check a settings patch and return only what should be written.
 *
 * Unknown keys are ignored, as before. A key that is present is always
 * validated — present-but-blank is an error for numbers (never a silent null)
 * and a deliberate "clear it" for the optional text fields.
 */
export function parseSettingsPatch(body: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const key of SETTING_KEYS) {
    if (body[key] === undefined) continue;
    const rule = SETTING_RULES[key];
    const label = SETTING_LABEL[key] ?? key;
    const v = body[key];
    if (rule.kind === "int") out[key] = parseInteger(key, label, v, rule.min, rule.max);
    else if (rule.kind === "decimal") out[key] = parseDecimal(key, label, v, rule.min, rule.max);
    else if (rule.kind === "time") out[key] = parseClock(key, label, v);
    else if (rule.kind === "bool") {
      if (typeof v !== "boolean") throw err.field(key, `${label} must be on or off.`);
      out[key] = v;
    }
    else {
      if (v === null || v === undefined) {
        out[key] = null;
        continue;
      }
      if (typeof v !== "string") throw err.field(key, `${label} must be text.`);
      const t = v.trim();
      if (t.length > rule.max) {
        throw err.field(key, `${label} must be at most ${rule.max} characters.`);
      }
      out[key] = t === "" ? null : t;
    }
  }
  return out;
}

/** Minutes after midnight for an `HH:MM` clock. */
export function clockMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Opening hours must describe a real day: close after open. Checked against the
 * stored values so that changing only one of the two is still caught.
 */
export function checkOpeningHours(open: string, close: string): void {
  if (clockMinutes(close) <= clockMinutes(open)) {
    throw err.field("close_time", "Closing time must be after opening time.");
  }
}
