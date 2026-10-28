import { createFileRoute } from "@tanstack/react-router";
import { SectionTitle } from "@/components/section";
import { useEffect, useMemo, useState } from "react";
import { Shell } from "@/components/shell";
import { Badge, Button, Card, DateField, EmptyState, Input, LoadError, Pagination, Skeleton } from "@/components/ui";
import { Stagger, StaggerItem } from "@/components/motion";
import { roleLabel } from "@/lib/arena3/labels";
import { cn } from "@/lib/cn";
import { locale, t, tk } from "@/lib/i18n";
import { usePageState } from "@/lib/use-page-state";
import { useRead } from "@/lib/use-read";

export const Route = createFileRoute("/manager/audit")({
  component: Page,
});

type Entry = {
  id: number;
  at: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
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

// The action names are written for the handlers that record them. Known ones get a
// friendly, translatable label; a new one falls back to its own name, tidied.
const ACTION_LABEL: Record<string, string> = {
  adjust_points: tk("Adjust points"),
  assistant: tk("Assistant question"),
  attendance: tk("Attendance recorded"),
  attendance_correct: tk("Attendance corrected"),
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

function Page() {
  const { offset, setOffset, pageSize, setPageSize, reset } = usePageState("manager.audit", 50);
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [entity, setEntity] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
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

  return (
    <Shell
      role="manager"
      title={t("Audit")}
      subtitle={t("Who changed what, newest first. Hiding an entry only tidies this screen; the log itself is never edited.")}
    >
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <select
          value={action}
          onChange={(e) => pick(setAction)(e.target.value)}
          className={selectCls}
          aria-label={t("Filter by action")}
        >
          <option value="">{t("All actions")}</option>
          {choices.actions.map((a) => (
            <option key={a} value={a}>
              {actionLabel(a)}
            </option>
          ))}
        </select>
        <select
          value={actor}
          onChange={(e) => pick(setActor)(e.target.value)}
          className={selectCls}
          aria-label={t("Filter by person")}
        >
          <option value="">{t("Anyone")}</option>
          {choices.actors.map((a) => (
            <option key={a.id} value={a.id}>
              {a.full_name} · {roleLabel(a.role)}
            </option>
          ))}
        </select>
        <select
          value={entity}
          onChange={(e) => pick(setEntity)(e.target.value)}
          className={selectCls}
          aria-label={t("Filter by what was changed")}
        >
          <option value="">{t("Anything")}</option>
          {choices.entities.map((a) => (
            <option key={a} value={a}>
              {entityLabel(a)}
            </option>
          ))}
        </select>
        <label className="grid gap-0.5 text-2xs text-muted">
          {t("From")}
          <DateField value={from} max={to || undefined} onChange={(v) => pick(setFrom)(v)} aria-label={t("From")} className="sm:h-10" />
        </label>
        <label className="grid gap-0.5 text-2xs text-muted">
          {t("To")}
          <DateField value={to} min={from || undefined} onChange={(v) => pick(setTo)(v)} aria-label={t("To")} className="sm:h-10" />
        </label>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("Search this list")}
          aria-label={t("Search the log")}
          className="max-w-[12rem]"
        />
        {filtered ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              reset();
              setAction("");
              setActor("");
              setEntity("");
              setFrom("");
              setTo("");
              setQ("");
            }}
          >
            {t("Clear filters")}
          </Button>
        ) : null}
        <span className="ml-auto text-2xs text-muted">
          {read.error ? "" : data && !read.stale ? t("{n} entries", { n: data.total.toLocaleString(locale()) }) : t("Loading")}
        </span>
      </div>
      {hiddenHere ? (
        <p className="mb-3 text-xs text-muted">
          {t("{n} hidden on this screen.", { n: hiddenHere })}{" "}
          <button type="button" className="underline" onClick={() => setShowHidden((v) => !v)}>
            {showHidden ? t("Hide them again") : t("Show them")}
          </button>
          {" · "}
          <button type="button" className="underline" onClick={restoreAll}>
            {t("Restore all")}
          </button>
        </p>
      ) : null}

      <SectionTitle text={tk("Activity")} className="mb-3 font-display text-2xl" />

      <div aria-busy={read.stale} className={cn("transition-opacity", read.stale && "opacity-60")}>
      {read.error ? (
        <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />
      ) : !data ? (
        <div className="grid gap-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : rows.length ? (
        <Stagger className="grid gap-1.5" gap={0.02}>
          {rows.map((e) => {
            const isOpen = open === e.id;
            const before = isOpen ? detail(e.before) : null;
            const after = isOpen ? detail(e.after) : null;
            return (
              <StaggerItem key={e.id}>
                <Card className={`p-0 ${hidden.includes(e.id) ? "opacity-60" : ""}`}>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : e.id)}
                    className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left"
                  >
                    <Badge tone={toneFor(e.action)}>{actionLabel(e.action)}</Badge>
                    <span className="text-sm font-medium">{e.actor_name ?? t("System")}</span>
                    {e.actor_role ? (
                      <span className="text-2xs text-muted">{roleLabel(e.actor_role)}</span>
                    ) : null}
                    <span className="text-sm text-muted">{entityLabel(e.entity)}</span>
                    <span className="ml-auto text-xs tabular-nums text-muted">{when(e.at)}</span>
                  </button>
                  {isOpen ? (
                    <div className="grid gap-2 border-t border-line px-3 py-2 text-xs">
                      {e.entity_id ? (
                        <p className="text-muted">
                          {t("Record")}: <span className="font-mono">{e.entity_id}</span>
                        </p>
                      ) : null}
                      {before || after ? (
                        <div className="grid gap-2 md:grid-cols-2">
                          {before ? (
                            <div>
                              <p className="mb-1 text-muted">{t("Before")}</p>
                              <pre className="max-h-48 overflow-auto rounded-[var(--radius-sm)] bg-wood p-2">{before}</pre>
                            </div>
                          ) : null}
                          {after ? (
                            <div>
                              <p className="mb-1 text-muted">{t("After")}</p>
                              <pre className="max-h-48 overflow-auto rounded-[var(--radius-sm)] bg-wood p-2">{after}</pre>
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <p className="text-muted">{t("No before/after was recorded for this entry.")}</p>
                      )}
                      {!hidden.includes(e.id) ? (
                        <div>
                          <Button size="sm" variant="ghost" onClick={() => hide(e.id)}>
                            {t("Hide from this screen")}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </Card>
              </StaggerItem>
            );
          })}
        </Stagger>
      ) : (
        <EmptyState
          title={filtered ? t("Nothing matches that") : t("Nothing recorded yet")}
          hint={
            filtered
              ? t("Clear the filters, or widen the dates.")
              : t("Entries appear here as staff take payments, change prices and refund.")
          }
        />
      )}
      {!read.error ? (
        <Pagination
          offset={offset}
          total={data?.total ?? 0}
          pageSize={pageSize}
          onChange={(o) => {
            setOpen(null);
            setOffset(o);
          }}
          onPageSizeChange={setPageSize}
          label={t("Audit pages")}
        />
      ) : null}
      </div>
    </Shell>
  );
}
