import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Check, Clock, FileCheck2, MapPin, Users, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckDraw } from "@/client/components/arena-icons";
import { StepTabs } from "@/client/components/coach-ui";
import { sessionDay } from "@/client/components/class-detail";
import { HomeworkPanel, PlanPanel, ResultsPanel } from "@/client/components/coach-training";
import { Shell, hhmm, useSessionUser } from "@/client/components/shell";
import { UserAvatar } from "@/client/components/user-avatar";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  LoadError,
  Select,
  Skeleton,
} from "@/client/components/ui";
import { apiPost } from "@/client/arena3/client";
import { cn } from "@/client/lib/cn";
import { levelLabel, sportLabel } from "@/shared/arena3/labels";
import { t, tServer, tk, tData } from "@/client/lib/i18n";
import { useRead, type ReadError } from "@/client/lib/use-read";
import { HighlightBadge, useLive } from "@/client/lib/use-live";
import type { CoachSession } from "./coach.index.tsx";

export const Route = createFileRoute("/coach/attendance")({
  validateSearch: (search: Record<string, unknown>): { session?: string } => ({
    session: typeof search.session === "string" ? search.session : undefined,
  }),
  component: Page,
});

type SessionRow = CoachSession;

type AttRow = {
  id: string;
  full_name: string;
  member_code: string | null;
  health_notes: string | null;
  result: string | null;
  avatar_url?: string | null;
};

type AttMeta = { locked: boolean; lock_at: string | null; status: string };

/** What the register read brings back: the roll, and (attendance on) whether the register has closed. */
type RegisterData = { items: AttRow[]; session?: AttMeta };

// Colour and icon say the answer before the word does: green tick, amber clock, red cross, grey note.
const RESULTS = [
  {
    v: "present",
    l: tk("Present"),
    Icon: Check,
    on: "border-green-800 bg-green-700 text-white",
    off: "border-green-300 bg-green-50 text-green-800 hover:bg-green-100",
    dot: "bg-green-700",
  },
  {
    v: "late",
    l: tk("Late"),
    Icon: Clock,
    on: "border-amber-600 bg-amber-400 text-black",
    off: "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100",
    dot: "bg-amber-400",
  },
  {
    v: "absent",
    l: tk("Absent"),
    Icon: X,
    on: "border-red-700 bg-red-600 text-white",
    off: "border-red-300 bg-red-50 text-red-800 hover:bg-red-100",
    dot: "bg-red-600",
  },
  {
    v: "excused",
    l: tk("Excused"),
    Icon: FileCheck2,
    on: "border-earth bg-earth text-earth-fg",
    off: "border-earth/40 bg-wood text-earth hover:bg-wood/80",
    dot: "bg-earth",
  },
];

function Page() {
  const { session: sessionParam } = Route.useSearch();
  const navigate = useNavigate();
  const user = useSessionUser();
  const scheduleRead = useRead<{ items: SessionRow[] }>("/coach/schedule");
  const flagsRead = useRead<{ flags: Record<string, boolean> }>("/flags");
  const items = scheduleRead.data?.items ?? null;
  // A flags read that fails leaves the features on, as it always did; the register's own read then
  // says so if attendance really is off.
  const flags = flagsRead.data?.flags ?? {};
  const flagsReady = flagsRead.data !== null || flagsRead.error !== null;
  // The tab belongs to the session it was picked on, so choosing another session starts at the
  // register again without anything having to remember to reset it.
  const [picked, setPicked] = useState({ id: "", step: "register" });

  // The session in the address bar (from a schedule card) is the one whose register is on screen;
  // with none chosen, the next one to come.
  const open =
    items?.find((s) => s.id === sessionParam) ??
    items?.find((s) => s.status === "scheduled") ??
    items?.[0] ??
    null;

  const f4 = flags.F4 !== false;
  const isManager = user?.role === "manager";
  // The register is asked for here, not in the panel, so the header can say it has closed. The answer
  // follows the path: switching session drops the old roll at once instead of leaving it on screen
  // under the new session's time.
  const registerPath =
    open && flagsReady
      ? f4
        ? `/sessions/${open.id}/attendance`
        : `/classes/${open.class_id}/roster`
      : null;
  const register = useRead<RegisterData>(registerPath);
  useLive("attendance", () => {
    register.reload();
    scheduleRead.reload();
  });
  // After the lock only a manager may correct a register, and must say why (BR-35).
  const locked = !!register.data?.session?.locked;

  const steps = [
    { value: "register", label: t("Attendance") },
    { value: "results", label: t("Results") },
    { value: "plan", label: t("Session plan") },
    { value: "homework", label: t("Homework") },
  ];
  const step = picked.id === open?.id ? picked.step : "register";
  const current = f4 ? step : "register";

  return (
    <Shell
      role="coach"
      title={t("Attendance")}
      subtitle={t("Pick a session, mark who came, then plan the next one.")}
    >
      {scheduleRead.error ? (
        <LoadError
          message={scheduleRead.error.message}
          onRetry={scheduleRead.error.refused ? undefined : scheduleRead.reload}
        />
      ) : !items ? (
        <Skeleton className="h-24" />
      ) : !items.length ? (
        <EmptyState
          title={t("No sessions to take a register for")}
          hint={t("Sessions appear here once a class you teach is published.")}
        />
      ) : (
        <div className="mx-auto grid max-w-3xl gap-5">
          <Card className="grid gap-4 p-4 sm:p-5">
            {open ? (
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
                <div>
                  <p className="text-sm text-muted">{sessionDay(open.start_at)}</p>
                  <p className="figure text-3xl tabular-nums">
                    {hhmm(open.start_at)}
                    <span className="text-muted">-{hhmm(open.end_at)}</span>
                  </p>
                </div>
                <div className="grid gap-1 text-sm sm:justify-items-end">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone="accent">{sportLabel(open.sport)}</Badge>
                    <Badge tone="muted">{levelLabel(open.level)}</Badge>
                    {locked ? <Badge tone="hold">{t("Locked")}</Badge> : null}
                  </p>
                  <p className="flex items-center gap-4 text-muted tabular-nums">
                    <span className="inline-flex items-center gap-1.5">
                      <MapPin aria-hidden className="size-4" />
                      {t("Court {court}", { court: open.court_code })}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Users aria-hidden className="size-4" />
                      <HighlightBadge value={open.enrolled_count}>{open.enrolled_count}</HighlightBadge>/{open.capacity}
                    </span>
                  </p>
                </div>
              </div>
            ) : null}
            <Field label={t("Change session")}>
              <Select
                value={open?.id ?? ""}
                onChange={(e) =>
                  void navigate({ to: "/coach/attendance", search: { session: e.target.value } })
                }
              >
                {items.map((s) => (
                  <option key={s.id} value={s.id}>
                    {sessionDay(s.start_at)} · {hhmm(s.start_at)} · {sportLabel(s.sport)} {levelLabel(s.level)} · {t("Court")} {s.court_code}
                  </option>
                ))}
              </Select>
            </Field>
          </Card>

          {open && f4 ? (
            <StepTabs
              value={current}
              onChange={(value) => setPicked({ id: open.id, step: value })}
              steps={steps}
            />
          ) : null}

          {open && current === "register" ? (
            <RegisterPanel
              // A new session, or the same one asked for another way, starts from a clean sheet: no
              // marks, reason or "Saved" carried over from the roll that was open before.
              key={registerPath ?? "pending"}
              session={open}
              f4={f4}
              read={register}
              isManager={isManager}
            />
          ) : null}

          {open && f4 && current === "results" ? (
            <ResultsPanel sessionId={open.id} cancelled={open.status === "cancelled"} />
          ) : null}
          {open && f4 && current === "plan" ? (
            <PlanPanel session={open} f5={flags.F5 !== false} />
          ) : null}
          {open && f4 && current === "homework" ? <HomeworkPanel classId={open.class_id} /> : null}
        </div>
      )}
    </Shell>
  );
}

function RegisterPanel({
  session,
  f4,
  read,
  isManager,
}: {
  session: SessionRow;
  f4: boolean;
  read: { data: RegisterData | null; error: ReadError | null; reload: () => void };
  isManager: boolean;
}) {
  // Only what the coach changed; every other student shows what the server holds. A roll that has
  // not been marked yet starts with everyone present, as it always did.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const savingRef = useRef(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(savedTimer.current), []);

  if (read.error) {
    return (
      <LoadError
        message={read.error.message}
        onRetry={read.error.refused ? undefined : read.reload}
      />
    );
  }
  if (!read.data) return <Skeleton className="h-40" />;

  const rows = read.data.items;
  const meta = read.data.session ?? null;
  const locked = !!meta?.locked;
  const blocked = locked && !isManager;
  const cancelled = session.status === "cancelled" || meta?.status === "cancelled";
  // Nothing to mark: attendance is off, the session was cancelled, or the register has closed.
  const readOnly = !f4 || blocked || cancelled;
  const mark = (u: AttRow) => edits[u.id] ?? u.result ?? "present";

  if (!rows.length) {
    return (
      <p className="text-sm text-muted">
        {t("Nobody is enrolled in this session yet, so there is no register to take.")}
      </p>
    );
  }

  async function save() {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await apiPost(
        `/sessions/${session.id}/attendance`,
        {
          items: rows.map((u) => ({ user_id: u.id, result: mark(u) })),
          ...(locked ? { reason } : {}),
        },
      );
      toast.success(locked ? t("Register corrected") : t("Register saved"));
      setReason("");
      setJustSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setJustSaved(false), 2200);
      // The marks stay as they are: they are what the server now holds, so nothing flickers while
      // the fresh copy comes back.
      read.reload();
    } catch (e) {
      // Said next to the button, where the coach is looking, and the marks are kept so nothing is lost.
      setSaveError(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div>
      {!f4 ? (
        <p className="mb-3 rounded-[var(--radius-md)] bg-hold/10 px-3 py-2 text-sm">
          {t("Attendance is switched off (flag F4)")}
        </p>
      ) : null}
      {cancelled ? (
        <p className="mb-3 rounded-[var(--radius-md)] bg-hold/10 px-3 py-2 text-sm">
          {t("This session was cancelled, so there is nothing to record.")}
        </p>
      ) : null}
      {locked ? (
        <p className="mb-3 rounded-[var(--radius-md)] bg-hold/10 px-3 py-2 text-sm">
          {meta?.lock_at
            ? t("This register closed {day} at {time}.", {
                day: sessionDay(meta.lock_at),
                time: hhmm(meta.lock_at),
              })
            : t("This register closed after the session.")}{" "}
          {isManager
            ? t("You can still correct it: say why below.")
            : t("Ask a manager to correct it.")}
        </p>
      ) : null}
      {f4 ? (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p
            className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm tabular-nums"
            aria-live="polite"
          >
            {RESULTS.map((r) => (
              <span key={r.v} className="inline-flex items-center gap-1.5">
                <span aria-hidden className={cn("size-2.5 rounded-full", r.dot)} />
                {t(r.l)} <b>{rows.filter((u) => mark(u) === r.v).length}</b>
              </span>
            ))}
            <span className="text-muted">{t("of {n}", { n: rows.length })}</span>
          </p>
          {!readOnly ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEdits(Object.fromEntries(rows.map((u) => [u.id, "present"])))}
            >
              {t("Mark everyone present")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <Card className="overflow-hidden p-0">
        <ul className="divide-y divide-line">
          {rows.map((u) => (
            <li
              key={u.id}
              className={cn(
                "grid gap-2 px-4 py-3",
                f4 && "sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4",
              )}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="size-8 shrink-0">
                  <UserAvatar name={u.full_name} url={u.avatar_url} />
                </div>
                <div className="min-w-0">
                  <p className="font-medium">
                    {f4 ? (
                      <Link
                        to="/coach/student/$id"
                        params={{ id: u.id }}
                        className="tap underline-offset-4 hover:underline"
                      >
                        {u.full_name}
                      </Link>
                    ) : (
                      u.full_name
                    )}
                    <span className="ml-2 text-xs font-normal text-muted">{u.member_code}</span>
                  </p>
                  {u.health_notes ? (
                    <p className="mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm text-danger">
                      {tData(u.health_notes)}
                    </p>
                  ) : null}
                </div>
              </div>
              {f4 ? (
                // Named after the student, so a screen reader hears whose "Present" it is on.
                <div role="group" aria-label={u.full_name} className="grid grid-cols-4 gap-1 sm:w-[26rem]">
                  {RESULTS.map((r) => {
                    const on = mark(u) === r.v;
                    return (
                      <button
                        key={r.v}
                        type="button"
                        disabled={readOnly}
                        aria-pressed={on}
                        onClick={() => setEdits((m) => ({ ...m, [u.id]: r.v }))}
                        className={cn(
                          "inline-flex min-h-11 items-center justify-center gap-1 rounded-[var(--radius-sm)] border px-1 text-xs transition-colors duration-150 active:scale-95 disabled:opacity-60",
                          on ? cn(r.on, "font-bold shadow-sm") : cn(r.off, "font-medium"),
                        )}
                      >
                        <r.Icon
                          aria-hidden
                          className={cn("hidden size-3.5 shrink-0 sm:block", on && "ai-pop")}
                        />
                        <span className="truncate">{t(r.l)}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
      {locked && isManager ? (
        <div className="mt-3 max-w-md">
          <Field label={t("Reason for the correction")}>
            <Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      ) : null}
      {f4 ? (
        <div className="mt-4">
          <Button
            size="lg"
            className="w-full"
            disabled={readOnly || saving || (locked && reason.trim().length < 3)}
            onClick={save}
          >
            {justSaved ? <CheckDraw key="saved" className="size-5" /> : null}
            {justSaved ? t("Saved") : locked ? t("Save correction") : t("Save register")}
          </Button>
          {saveError ? (
            <p role="alert" className="mt-2 text-sm text-danger">
              {saveError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
