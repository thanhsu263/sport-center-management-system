import { useEffect, useMemo, useState } from "react";
import { levelLabel, methodLabel, roleLabel, sportLabel, statusLabel } from "@/shared/arena3/labels";
import { formatVnd } from "@/shared/arena3/time";
import { locale, t, tk } from "@/client/lib/i18n";
import { usePageState } from "@/client/lib/use-page-state";
import { useRead } from "@/client/lib/use-read";


type Entry = {
  id: number;
  at: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  subject?: string | null;
  subject_vnd?: number | null;
  before?: unknown;
  after?: unknown;
};


type Actor = { id: string; full_name: string; role: string };

type AuditPage = { items: Entry[]; more: boolean; total: number; actions: string[]; entities: string[]; actors: Actor[] };


const HIDDEN_KEY = "arena3.audit.hidden";

const selectCls = "h-11 rounded-[var(--radius-sm)] border border-line bg-surface px-3 text-sm sm:h-10";


function readHidden(): number[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}


function detail(v: unknown): string | null {
  if (v == null) return null;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return null;
  }
}


// The before/after snapshots are rows as the handlers wrote them. A manager reads "Enabled: Yes → No",
// not two JSON blocks to compare by eye, so the change is worked out field by field here and the raw
// JSON stays one click away.
const FIELD_LABEL: Record<string, string> = {
  enabled: tk("Enabled"),
  status: tk("Status"),
  role: tk("Role"),
  capacity: tk("Capacity"),
  level: tk("Level"),
  sport: tk("Sport"),
  phone: tk("Phone"),
  email: tk("Email"),
  full_name: tk("Full name"),
  name: tk("Name"),
  name_en: tk("English name"),
  name_vi: tk("Vietnamese name"),
  note: tk("Note"),
  reason: tk("Reason"),
  points: tk("Points"),
  price_vnd: tk("Price"),
  amount_vnd: tk("Amount"),
  code: tk("Code"),
  court_code: tk("Court"),
  sort_order: tk("Sort order"),
  min_enrolled: tk("Minimum to run"),
  src_path: tk("Photo"),
  alt_en: tk("Photo description (English)"),
  alt_vi: tk("Photo description (Vietnamese)"),
  start_at: tk("Starts at"),
  end_at: tk("Ends at"),
  sessions: tk("Sessions cancelled"),
  members_refunded: tk("Members to refund"),
  refunded_vnd: tk("Total to refund"),
  refunded: tk("Refunded"),
  prepaid_returned: tk("Prepaid returned"),
  prepaid_kept_no_plan: tk("Prepaid kept, no plan"),
  method: tk("Method"),
  days: tk("Days"),
  frozen_days: tk("Days frozen"),
  end_on: tk("Ends on"),
  period: tk("Period"),
  closed: tk("Payouts closed"),
  qty: tk("Quantity"),
  title: tk("Title"),
  priority: tk("Priority"),
  weeks: tk("Weeks"),
  from: tk("From"),
  to: tk("To"),
  q: tk("Question"),
  credit_days: tk("Days credited"),
  kept: tk("Kept"),
};


function fieldLabel(key: string): string {
  const known = FIELD_LABEL[key];
  if (known) return t(known);
  // A nested field (`venue.open_hour`) or one nobody has named yet: its own name, tidied.
  // A menu item (`nav.member › /app/pass.dock`) keeps its link as written.
  const [head, ...rest] = key.split(" › ");
  const tidy = head.replace(/[._]+/g, " ").trim();
  const item = rest.join(" › ").replace(/\.(\w+)$/, " · $1");
  return tidy.charAt(0).toUpperCase() + tidy.slice(1) + (item ? ` › ${item}` : "");
}


function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}


/** A JSON text (a setting stored as a string) is read as the value it holds. */
function parsed(v: unknown): unknown {
  if (typeof v !== "string" || !/^\s*[[{]/.test(v)) return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}


/**
 * Nested settings are opened down to their leaves (`nav.member./app/pass.dock`), so a
 * change to one menu item shows as one line instead of two walls of JSON. Lists of
 * links are keyed by their `to`, so a removed item reads as removed, not as a shift.
 */
function flatten(v: Record<string, unknown>, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, raw] of Object.entries(v)) {
    const val = parsed(raw);
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlain(val)) flatten(val as Record<string, unknown>, key, out);
    else if (Array.isArray(val) && val.length && val.every((x) => isPlain(x) && typeof (x as { to?: unknown }).to === "string")) {
      for (const item of val as Array<Record<string, unknown>>) {
        const { to, ...rest } = item;
        if (Object.keys(rest).length) flatten(rest, `${key} › ${to as string}`, out);
        else out[`${key} › ${to as string}`] = true;
      }
    } else out[key] = val;
  }
  return out;
}


const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;


const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


/** Nothing worth a line: absent, blank, or an empty list. */
function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}


/** Ids mean nothing to a reader; they stay in the raw view. */
function isInternal(key: string, a: unknown, b: unknown): boolean {
  if (key === "seed") return true;
  return /(^|\.|_)id$/.test(key) || [a, b].some((v) => typeof v === "string" && UUID.test(v));
}


function showField(key: string, v: unknown): string {
  if (isEmpty(v)) return "—";
  const name = key.split(".").pop() ?? key;
  if (name.endsWith("_vnd") && typeof v === "number") return formatVnd(v);
  if (typeof v === "string") {
    if (name === "status" || name === "from_status") return statusLabel(v);
    if (name === "method") return methodLabel(v);
    if (name === "role") return roleLabel(v);
    if (name === "level") return levelLabel(v);
    if (name === "sport") return sportLabel(v);
  }
  if (Array.isArray(v)) return t("{n} items", { n: v.length });
  return showValue(v);
}


function showValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? t("Yes") : t("No");
  if (typeof v === "number") return v.toLocaleString(locale());
  if (typeof v === "string") return ISO_TIME.test(v) ? when(v) : v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}


type Change = { key: string; label: string; from: string | null; to: string };


/** The fields that differ between the two snapshots; a created or deleted row lists what it had. */
function changesOf(before: unknown, after: unknown): Change[] {
  if (before == null && after == null) return [];
  before = parsed(before);
  after = parsed(after);
  if (!isPlain(before ?? {}) || !isPlain(after ?? {})) {
    if (JSON.stringify(before) === JSON.stringify(after)) return [];
    return [{ key: "value", label: t("Value"), from: showValue(before), to: showValue(after) }];
  }
  const a = flatten((before ?? {}) as Record<string, unknown>);
  const b = flatten((after ?? {}) as Record<string, unknown>);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys
    .filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null))
    .filter((k) => !(isEmpty(a[k]) && isEmpty(b[k])) && !isInternal(k, a[k], b[k]))
    // A value with nothing before it is a plain fact of the action, not a change.
    .map((k) => ({ key: k, label: fieldLabel(k), from: isEmpty(a[k]) ? null : showField(k, a[k]), to: showField(k, b[k]) }));
}


// The action names are written for the handlers that record them. Known ones get a
// friendly, translatable label; a new one falls back to its own name, tidied.
const ACTION_LABEL: Record<string, string> = {
  adjust_points: tk("Adjust points"),
  assistant: tk("Assistant question"),
  attendance: tk("Attendance recorded"),
  attendance_correct: tk("Attendance corrected"),
  add_coach_certification: tk("Add coach certification"),
  avatar_removed: tk("Remove profile photo"),
  avatar_set: tk("Change profile photo"),
  collect_balance: tk("Collect balance"),
  create_court: tk("Create court"),
  create_sport: tk("Create sport"),
  delete_sport: tk("Delete sport"),
  issue_certificate: tk("Issue certificate"),
  login_google: tk("Sign in with Google"),
  refund_paid_out: tk("Refund paid out"),
  remove_coach_certification: tk("Remove coach certification"),
  replace_asset: tk("Replace site image"),
  restore_court: tk("Restore court"),
  restore_sport: tk("Restore sport"),
  retire_court: tk("Retire court"),
  retire_sport: tk("Retire sport"),
  revert_asset: tk("Restore default image"),
  sign_out_other_sessions: tk("Sign out other devices"),
  update_sport: tk("Update sport"),
  cancel_booking: tk("Cancel booking"),
  cancel_class: tk("Cancel class"),
  cancel_series: tk("Cancel fixed booking"),
  cancel_session: tk("Cancel session"),
  change_coach: tk("Change coach"),
  change_password: tk("Change password"),
  change_staff_role: tk("Change staff role"),
  close_commission: tk("Close commission period"),
  close_shift: tk("Close shift"),
  contact_logged: tk("Contact logged"),
  convert_membership: tk("Convert membership"),
  create_class: tk("Create class"),
  create_member: tk("Create member"),
  create_payment: tk("Create payment"),
  create_plan: tk("Create plan"),
  create_promo: tk("Create promo"),
  create_series: tk("Create fixed booking"),
  create_staff: tk("Create staff"),
  create_work_order: tk("Create work order"),
  decline_plan_order: tk("Decline plan order"),
  edit_class: tk("Edit class"),
  export_invoices: tk("Export e-invoices"),
  freeze_sub: tk("Freeze subscription"),
  gate_checkin: tk("Gate check-in"),
  gate_checkin_override: tk("Gate check-in override"),
  loan_out: tk("Loan out"),
  loan_return: tk("Loan return"),
  lock_staff: tk("Lock staff"),
  online_link: tk("Online payment link"),
  online_paid: tk("Online payment"),
  online_paid_webhook: tk("Online payment confirmed"),
  patch_court: tk("Update court"),
  patch_flags: tk("Update features"),
  patch_plan: tk("Update plan"),
  patch_promo: tk("Update promo"),
  patch_settings: tk("Update settings"),
  patch_work_order: tk("Update work order"),
  pause: tk("Pause"),
  pay_commission: tk("Pay commission"),
  put_plan_on_sale: tk("Put plan on sale"),
  redeem_points: tk("Redeem points"),
  refund: tk("Refund"),
  refund_approved: tk("Refund approved"),
  refund_pending: tk("Refund pending"),
  refund_rejected: tk("Refund rejected"),
  register: tk("Register"),
  replace_prices: tk("Replace prices"),
  reschedule_booking: tk("Reschedule booking"),
  reschedule_session: tk("Reschedule session"),
  reset_member_password: tk("Reset member password"),
  reset_staff_password: tk("Reset staff password"),
  resume: tk("Resume"),
  revoke_staff_sessions: tk("Revoke staff sessions"),
  sell_day_pass: tk("Sell day pass"),
  set_coach_rate: tk("Set coach rate"),
  student_level: tk("Student level"),
  ticket_close: tk("Close ticket"),
  ticket_reply: tk("Reply to ticket"),
  transfer_confirm: tk("Confirm transfer"),
  transfer_reject: tk("Reject transfer"),
  unfreeze_sub: tk("Unfreeze subscription"),
  unlock_staff: tk("Unlock staff"),
  update_member: tk("Update member"),
  use_day_pass: tk("Use day pass"),
  void_day_pass: tk("Void day pass"),
  walk_in: tk("Walk-in booking"),
  withdraw_plan_from_sale: tk("Withdraw plan from sale"),
};


function actionLabel(a: string): string {
  const known = ACTION_LABEL[a];
  if (known) return t(known);
  const words = a.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}


const ENTITY_LABEL: Record<string, string> = {
  attendance: tk("attendance"),
  booking: tk("booking"),
  booking_series: tk("fixed booking"),
  chat: tk("chat"),
  class: tk("class"),
  coach_payout: tk("coach commission"),
  court: tk("court"),
  day_pass: tk("day pass"),
  equipment: tk("equipment"),
  flags: tk("features"),
  invoice: tk("invoice"),
  payment: tk("payment"),
  plan: tk("plan"),
  price_rules: tk("price rules"),
  promotion: tk("promotion"),
  session: tk("session"),
  settings: tk("settings"),
  shift: tk("shift"),
  subscription: tk("subscription"),
  ticket: tk("ticket"),
  user: tk("user"),
  work_order: tk("work order"),
  // Older rows (and the seeded history) were written with the table's own name.
  sport: tk("sport"),
  feature_flag: tk("features"),
  site_asset: tk("site image"),
  enrollment: tk("enrollment"),
  price_rule: tk("price rules"),
  cashier_shift: tk("shift"),
  equipment_loan: tk("equipment loan"),
  court_booking: tk("booking"),
  membership_plan: tk("plan"),
};


/** A word a manager would use, never a table name: unknown ones lose their underscores. */
function entityLabel(e: string): string {
  const known = ENTITY_LABEL[e];
  return known ? t(known) : e.replace(/_/g, " ");
}


/**
 * Which actions deserve to catch the eye.
 *
 * A log where everything is the same weight is a log nobody scans. Money
 * leaving the centre and changes to what it charges are the two things a
 * manager is reading this page to find.
 */
function toneFor(action: string): "danger" | "hold" | "muted" {
  if (/refund|delete|reject|decline|cancel|lock|revoke|void/.test(action)) return "danger";
  if (/price|setting|flag|close_shift|freeze|plan|password|role|staff/.test(action)) return "hold";
  return "muted";
}


function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale(), {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

export function useManagerAudit() {
  const { offset, setOffset, pageSize, setPageSize, reset } = usePageState("manager.audit", 50);
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [entity, setEntity] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  // The entry whose raw JSON is showing under its field-by-field changes.
  const [raw, setRaw] = useState<number | null>(null);
  const [hidden, setHidden] = useState<number[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  // The pickers keep the full set once known, so filtering to one value does
  // not collapse its own menu down to that value.
  const [choices, setChoices] = useState<{ actions: string[]; entities: string[]; actors: Actor[] }>({
    actions: [],
    entities: [],
    actors: [],
  });

  useEffect(() => setHidden(readHidden()), []);

  // Typing waits a beat so one search is one request; any search or filter starts at page one.
  const [term, setTerm] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  useEffect(reset, [term, reset]);

  const qs = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
  if (term) qs.set("q", term);
  if (action) qs.set("action", action);
  if (actor) qs.set("actor", actor);
  if (entity) qs.set("entity", entity);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  // The entries already on screen stay (dimmed) while a filter or another page loads; a refused or
  // failed answer replaces them with the reason, never with a list that does not match the filters.
  const read = useRead<AuditPage>(`/audit?${qs}`, { keepPrevious: true });
  const data = useMemo(
    // A bigserial can arrive as a string; the hidden list compares numbers.
    () => (read.data ? { ...read.data, items: read.data.items.map((e) => ({ ...e, id: Number(e.id) })) } : null),
    [read.data],
  );

  useEffect(() => {
    if (!read.data || read.stale || action || actor || entity) return;
    setChoices({ actions: read.data.actions ?? [], entities: read.data.entities ?? [], actors: read.data.actors ?? [] });
  }, [read.data, read.stale, action, actor, entity]);

  function pick(set: (v: string) => void) {
    return (v: string) => {
      reset();
      setOpen(null);
      set(v);
    };
  }

  // Hiding only tucks a row out of this screen. The log is append-only and
  // nothing here removes an entry from it.
  function hide(id: number) {
    const next = [...new Set([...hidden, id])];
    setHidden(next);
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
    } catch {
      // Hidden for this visit is still fine when storage is unavailable.
    }
  }
  function restoreAll() {
    setHidden([]);
    setShowHidden(false);
    try {
      localStorage.removeItem(HIDDEN_KEY);
    } catch {
      // Nothing to clean up.
    }
  }

  // The search runs on the server across every page; only hidden entries are tucked away here.
  const rows = useMemo(
    () => (data?.items ?? []).filter((e) => showHidden || !hidden.includes(e.id)),
    [data, hidden, showHidden],
  );

  const hiddenHere = (data?.items ?? []).filter((e) => hidden.includes(e.id)).length;
  const filtered = !!(q || action || actor || entity || from || to);
  return {
    offset, setOffset, pageSize, setPageSize, reset, action, setAction, actor, setActor, entity,
    setEntity, from, setFrom, to, setTo, q, setQ, open, setOpen, raw, setRaw, hidden, showHidden,
    setShowHidden, choices, read, data, pick, hide, restoreAll, rows, hiddenHere, filtered,
  };
}

export { selectCls, detail, changesOf, actionLabel, entityLabel, toneFor, when };
