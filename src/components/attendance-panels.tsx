import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePageState } from "@/lib/use-page-state";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Card,
  DateField,
  EmptyState,
  Field,
  FilterChip,
  Input,
  LoadError,
  Modal,
  Pagination,
  Select,
  Skeleton,
  Stat,
} from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { ExportButtons } from "@/components/report-panels";
import { ApiClientError, apiGet, apiPost } from "@/lib/arena3/client";
import { addDaysISO, formatDate, sportLabel, todayISO } from "@/lib/arena3/labels";
import { scrollBehavior } from "@/lib/calm";
import { t, tk, tServer } from "@/lib/i18n";
import { readError, useRead, type ReadError } from "@/lib/use-read";

type Counts = { present: number; late: number; absent: number; excused: number; rate_pct: number | null };

type Report = {
  from: string;
  to: string;
  totals: Counts;
  classes: Array<Counts & { class_id: string; class_code: string; sport: string; coach: string; students: number }>;
  coaches: Array<Counts & { coach_id: string; coach: string; classes: number }>;
  students: Array<Counts & { user_id: string; full_name: string; member_code: string | null; class_code: string; sport: string }>;
};

const pct = (v: number | null) => (v === null ? "-" : `${v}%`);

/**
 * Attendance rate = (present + late) ÷ (sessions marked − excused). Excused
 * absences are not held against anyone, and nothing here is a penalty (BR-32).
 */
export function AttendancePanel({ canExport }: { canExport: boolean }) {
  const [from, setFrom] = useState(() => addDaysISO(todayISO(), -29));
  const [to, setTo] = useState(todayISO);
  const [view, setView] = useState<"class" | "coach" | "student">("class");
  const { data, error, reload } = useRead<Report>(`/reports/attendance?from=${from}&to=${to}`);
  // The server names the date it will not take; a refusal it does not name (a 422) blames both.
  const faulty = (field: "from" | "to") => error?.refused === true && (error.field ? error.field === field : true);
  const errorId = "attendance-error";

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t("From")}>
          <DateField
            required
            value={from}
            max={to}
            onChange={setFrom}
            invalid={faulty("from")}
            aria-describedby={faulty("from") ? errorId : undefined}
            aria-label={t("From")}
          />
        </Field>
        <Field label={t("To")}>
          <DateField
            required
            value={to}
            min={from}
            onChange={setTo}
            invalid={faulty("to")}
            aria-describedby={faulty("to") ? errorId : undefined}
            aria-label={t("To")}
          />
        </Field>
        <Select value={view} onChange={(e) => setView(e.target.value as typeof view)} aria-label={t("Group by")}>
          <option value="class">{t("By class")}</option>
          <option value="coach">{t("By coach")}</option>
          <option value="student">{t("By student")}</option>
        </Select>
        {canExport ? <ExportButtons kind="attendance" from={from} to={to} /> : null}
      </div>

      {error ? (
        <LoadError id={errorId} message={error.message} onRetry={error.refused ? undefined : reload} />
      ) : !data ? (
        <Skeleton className="h-48" />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label={t("Attendance rate")} value={pct(data.totals.rate_pct)} />
            <Stat label={t("Present or late")} value={String(data.totals.present + data.totals.late)} />
            <Stat label={t("Absent")} value={String(data.totals.absent)} />
            <Stat label={t("Excused (not counted)")} value={String(data.totals.excused)} />
          </div>
          {view === "class" ? (
            <Table
              head={[t("Class"), t("Coach"), t("Students"), t("Present"), t("Late"), t("Absent"), t("Excused"), t("Rate")]}
              rows={data.classes.map((c) => [
                `${c.class_code} · ${sportLabel(c.sport)}`,
                c.coach,
                c.students,
                c.present,
                c.late,
                c.absent,
                c.excused,
                pct(c.rate_pct),
              ])}
            />
          ) : view === "coach" ? (
            <Table
              head={[t("Coach"), t("Classes"), t("Present"), t("Late"), t("Absent"), t("Excused"), t("Rate")]}
              rows={data.coaches.map((c) => [c.coach, c.classes, c.present, c.late, c.absent, c.excused, pct(c.rate_pct)])}
            />
          ) : (
            <Table
              head={[t("Student"), t("Class"), t("Present"), t("Late"), t("Absent"), t("Excused"), t("Rate")]}
              rows={data.students.map((s) => [
                `${s.full_name}${s.member_code ? ` (${s.member_code})` : ""}`,
                s.class_code,
                s.present,
                s.late,
                s.absent,
                s.excused,
                pct(s.rate_pct),
              ])}
            />
          )}
        </>
      )}
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: Array<Array<string | number>> }) {
  if (!rows.length) return <EmptyState title={t("No marked sessions in this window")} hint={t("Pick a longer range.")} />;
  return (
    <Card className="overflow-x-auto p-0" role="region" aria-label={t("Attendance table, scrolls sideways")} tabIndex={0}>
      <table className="w-full min-w-[34rem] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            {head.map((h) => (
              <th key={h} className="px-4 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line/60 last:border-0">
              {r.map((c, j) => (
                <td key={j} className="px-4 py-2 tabular-nums">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

type RiskItem = {
  user_id: string;
  full_name: string;
  member_code: string | null;
  phone: string | null;
  plan_end_on: string | null;
  reasons: Array<{ kind: string; message: string }>;
  attendance_pct: number | null;
  last_seen_at: string | null;
  contacted: boolean;
  last_contact: { at: string; outcome: string; note: string | null; by: string } | null;
  avatar_url?: string | null;
};

const CHANNELS = [
  { value: "phone", label: tk("Phone call") },
  { value: "zalo", label: tk("Zalo") },
  { value: "sms", label: tk("SMS") },
  { value: "in_person", label: tk("In person") },
];
const OUTCOMES = [
  { value: "reached", label: tk("Spoke to them") },
  { value: "will_return", label: tk("Will come back") },
  { value: "reschedule", label: tk("Wants another time") },
  { value: "leaving", label: tk("Leaving") },
  { value: "no_answer", label: tk("No answer") },
];
const outcomeLabel = (v: string) => {
  const l = OUTCOMES.find((o) => o.value === v)?.label;
  return l ? t(l) : v;
};

type RiskKind = "streak" | "idle" | "expiring";
type RiskFilter = "todo" | "done" | "all" | RiskKind;
type RiskSort = "priority" | "plan_end" | "last_seen" | "name";

const SORTS: Array<{ value: RiskSort; label: string }> = [
  { value: "priority", label: tk("Most urgent first") },
  { value: "plan_end", label: tk("Plan ends soonest") },
  { value: "last_seen", label: tk("Away the longest") },
  { value: "name", label: tk("Name A-Z") },
];

/** The short word a receptionist reads in a table cell; the long sentence stays in the tooltip. */
function reasonChip(kind: string, idleDays: number | null) {
  if (kind === "streak") return t("Absent in a row");
  if (kind === "idle") return t("No visit {n}+ days", { n: idleDays ?? 14 });
  return t("Plan ending · low attendance");
}

/** Members who may be drifting away, with what has already been done about it (FR-TRN-09). */
export function AtRiskPanel({ canContact = true }: { canContact?: boolean }) {
  const [items, setItems] = useState<RiskItem[] | null>(null);
  const [idleDays, setIdleDays] = useState<number | null>(null);
  const [target, setTarget] = useState<RiskItem | null>(null);
  const [form, setForm] = useState({ channel: "phone", outcome: "reached", note: "" });
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [filter, setFilter] = useState<RiskFilter>("todo");
  const [sort, setSort] = useState<RiskSort>("priority");
  const [q, setQ] = useState("");
  const { offset, setOffset, pageSize, setPageSize, reset } = usePageState("at-risk", 25);
  const top = useRef<HTMLDivElement>(null);

  const [loadError, setLoadError] = useState<ReadError | null>(null);

  const load = useCallback(async () => {
    const r = await apiGet<{ items: RiskItem[]; idle_days: number }>("/at-risk");
    setItems(r.items);
    setIdleDays(r.idle_days);
  }, []);
  // The first read says why it failed on the panel itself, with a button to ask again; a refresh after
  // saving a contact keeps the list that is already on screen and reports through `save`'s toast.
  const firstLoad = useCallback(() => {
    setLoadError(null);
    void load().catch((e: unknown) => setLoadError(readError(e)));
  }, [load]);
  useEffect(firstLoad, [firstLoad]);

  async function save() {
    if (!target) return;
    setBusy(true);
    setFieldError(null);
    try {
      await apiPost("/contacts", {
        user_id: target.user_id,
        reason: target.reasons[0]?.kind ?? "other",
        channel: form.channel,
        outcome: form.outcome,
        note: form.note,
      });
      toast.success(t("Contact saved"));
      setTarget(null);
      setForm({ channel: "phone", outcome: "reached", note: "" });
      await load();
    } catch (e) {
      if (e instanceof ApiClientError && e.body.field) setFieldError(tServer(e.message));
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      setBusy(false);
    }
  }

  const counts = useMemo(() => {
    const c = { all: 0, todo: 0, done: 0, streak: 0, idle: 0, expiring: 0 };
    for (const m of items ?? []) {
      c.all++;
      if (m.contacted) c.done++;
      else c.todo++;
      for (const r of m.reasons) if (r.kind in c) c[r.kind as RiskKind]++;
    }
    return c;
  }, [items]);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    const rows = (items ?? []).filter((m) => {
      if (filter === "todo" && m.contacted) return false;
      if (filter === "done" && !m.contacted) return false;
      if (filter === "streak" || filter === "idle" || filter === "expiring") {
        if (!m.reasons.some((r) => r.kind === filter)) return false;
      }
      if (!term) return true;
      return [m.full_name, m.member_code, m.phone].some((v) => v?.toLowerCase().includes(term));
    });
    // The server already returns "most urgent first"; only the other orders need work here.
    if (sort === "plan_end") rows.sort((a, b) => (a.plan_end_on ?? "9999").localeCompare(b.plan_end_on ?? "9999"));
    if (sort === "last_seen") rows.sort((a, b) => (a.last_seen_at ?? "").localeCompare(b.last_seen_at ?? ""));
    if (sort === "name") rows.sort((a, b) => a.full_name.localeCompare(b.full_name));
    return rows;
  }, [items, filter, sort, q]);

  // A new search, filter or sort starts from the first page; a stale offset would show an empty one.
  useEffect(reset, [filter, sort, q, reset]);
  const page = shown.slice(offset, offset + pageSize);
  const goTo = (o: number) => {
    setOffset(o);
    top.current?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  };

  if (!items)
    return loadError ? (
      <LoadError message={loadError.message} onRetry={firstLoad} />
    ) : (
      <div className="grid gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    );

  const chips: Array<{ value: RiskFilter; label: string; count: number; tone?: "hold" }> = [
    { value: "todo", label: t("To call"), count: counts.todo, tone: "hold" },
    { value: "done", label: t("Already contacted"), count: counts.done },
    { value: "all", label: t("Everyone"), count: counts.all },
    { value: "streak", label: t("Absent in a row"), count: counts.streak },
    { value: "idle", label: t("No visit {n}+ days", { n: idleDays ?? 14 }), count: counts.idle },
    { value: "expiring", label: t("Plan ending soon"), count: counts.expiring },
  ];

  return (
    <div className="grid gap-3" ref={top}>
      <details className="group rounded-[var(--radius-lg)] bg-surface px-4 py-3 text-sm shadow-[var(--shadow-border)]">
        <summary className="cursor-pointer py-3 font-medium marker:text-muted sm:py-0.5">{t("Who ends up on this list?")}</summary>
        <p className="mt-2 text-muted">
          {t(
            "Three things put someone here: absent three sessions running, no visit for {n}+ days on a live plan, or a plan ending soon with low attendance. Contacting them is a courtesy call, never a penalty.",
            { n: idleDays ?? "-" },
          )}
        </p>
      </details>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0" role="group" aria-label={t("Filter the list")}>
        {chips.map((c) => (
          <FilterChip key={c.value} active={filter === c.value} onClick={() => setFilter(c.value)} label={c.label} count={c.count} tone={c.tone} />
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_14rem]">
        <Input placeholder={t("Search name, phone or member code")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("Search the list")} />
        <Select value={sort} onChange={(e) => setSort(e.target.value as RiskSort)} aria-label={t("Sort the list")}>
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {t(s.label)}
            </option>
          ))}
        </Select>
      </div>

      {!items.length ? (
        <EmptyState title={t("Nobody is at risk")} hint={t("Everyone with a plan has been in recently.")} />
      ) : !shown.length ? (
        <EmptyState
          title={filter === "todo" && !q ? t("Everyone on the list has been contacted") : t("Nobody matches")}
          hint={filter === "todo" && !q ? t("Nice work. Switch to “Already contacted” to review the calls.") : t("Loosen the filter or check the spelling.")}
        >
          {filter !== "all" || q ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setFilter("all");
                setQ("");
              }}
            >
              {t("Show everyone")}
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <>
          <Card className="overflow-hidden p-0">
            <ul className="divide-y divide-line/70">
              {page.map((m) => (
                <li key={m.user_id} className="grid gap-x-4 gap-y-1.5 px-4 py-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.5fr)_8.5rem_auto] md:items-center">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="size-8 shrink-0">
                      <UserAvatar name={m.full_name} url={m.avatar_url} />
                    </div>
                    <div className="min-w-0">
                      <p className="break-words font-medium">
                        {m.full_name} <span className="text-xs font-normal tabular-nums text-muted">{m.member_code}</span>
                      </p>
                      <p className="break-words text-xs text-muted">
                        {m.phone ? (
                          <a href={`tel:${m.phone}`} className="tabular-nums hover:underline">
                            {m.phone}
                          </a>
                        ) : (
                          t("no phone")
                        )}
                        {m.last_seen_at ? ` · ${t("last seen {date}", { date: formatDate(m.last_seen_at) })}` : ` · ${t("never seen")}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5" title={m.reasons.map((r) => tServer(r.message)).join(" ")}>
                    {m.reasons.map((r) => (
                      <Badge key={r.kind} tone={r.kind === "streak" ? "danger" : r.kind === "idle" ? "hold" : "muted"}>
                        {reasonChip(r.kind, idleDays)}
                      </Badge>
                    ))}
                  </div>
                  <div className="text-xs text-muted md:text-right">
                    <p>{m.plan_end_on ? t("Plan ends {date}", { date: formatDate(m.plan_end_on) }) : t("No live plan")}</p>
                    {m.attendance_pct !== null ? <p className="tabular-nums">{t("Attendance {pct}%", { pct: m.attendance_pct })}</p> : null}
                  </div>
                  <div className="flex items-center gap-2 md:justify-end">
                    <Badge tone={m.contacted ? "muted" : "hold"}>{m.contacted ? t("Contacted") : t("Not contacted")}</Badge>
                    {canContact ? (
                      <Button size="sm" variant={m.contacted ? "ghost" : "outline"} onClick={() => setTarget(m)}>
                        {t("Log a contact")}
                      </Button>
                    ) : null}
                  </div>
                  {m.last_contact ? (
                    <p className="text-xs text-muted md:col-span-4">
                      {formatDate(m.last_contact.at)} · {m.last_contact.by}: {outcomeLabel(m.last_contact.outcome)}
                      {m.last_contact.note ? ` · ${m.last_contact.note}` : ""}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
          <Pagination offset={offset} total={shown.length} pageSize={pageSize} onChange={goTo} onPageSizeChange={setPageSize} label={t("At-risk pages")} />
        </>
      )}

      <Modal
        open={target !== null}
        onClose={() => setTarget(null)}
        title={target ? t("Contact {name}", { name: target.full_name }) : ""}
        footer={
          <>
            <Button variant="ghost" onClick={() => setTarget(null)}>
              {t("Cancel")}
            </Button>
            <Button disabled={busy} onClick={() => void save()}>
              {busy ? t("Saving…") : t("Save")}
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <Field label={t("How")}>
            <Select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
              {CHANNELS.map((c) => (
                <option key={c.value} value={c.value}>
                  {t(c.label)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("What happened")} hint={fieldError ?? undefined}>
            <Select value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })}>
              {OUTCOMES.map((c) => (
                <option key={c.value} value={c.value}>
                  {t(c.label)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("Note (optional)")}>
            <Input value={form.note} maxLength={300} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
