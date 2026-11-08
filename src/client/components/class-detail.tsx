import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { Badge, Button, Field, Input, LoadError, Modal, Select, Skeleton, StatusBadge } from "@/components/ui";
import { hhmm, initials, money, useSessionUser, when } from "@/components/shell";
import { Cover } from "@/components/media";
import { apiPatch, apiPost } from "@/lib/arena3/client";
import { formatDate, kindLabel, levelLabel, rruleLabel, sportLabel } from "@/lib/arena3/labels";
import { scrollBehavior } from "@/lib/calm";
import { locale, t, tk, tServer } from "@/lib/i18n";
import { useRead } from "@/lib/use-read";
import { HighlightBadge, useLive } from "@/lib/use-live";

/** "Tue 21 Oct" in the centre's timezone. */
export function sessionDay(iso: string) {
  return new Date(iso).toLocaleDateString(locale(), {
    timeZone: "Asia/Ho_Chi_Minh",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

type ClassDetail = {
  class: {
    id: string;
    code: string;
    sport: string;
    level: string;
    status: string;
    capacity: number;
    enrolled_count: number;
    rrule: string;
    duration_min: number;
    start_on: string;
    end_on: string;
    court_code: string;
    coach_id: string;
    coach_name: string;
    assistant_name: string | null;
  };
  sessions: Array<{
    id: string;
    start_at: string;
    end_at: string;
    status: string;
    court_code: string;
    headcount: number;
  }>;
  roster: Array<{ id: string; full_name: string; member_code: string | null; phone: string; status: string }>;
};

/** What the manager is in the middle of doing to the class. */
type Action =
  | { kind: "cancel-session" | "move-session"; sessionId: string; label: string; startAt: string }
  | { kind: "coach" | "capacity" | "cancel-class" };

/** A `datetime-local` value is the centre's wall clock, which is always UTC+7. */
const toIctIso = (local: string) => `${local}:00+07:00`;
const toLocalInput = (iso: string) => new Date(new Date(iso).getTime() + 7 * 3600000).toISOString().slice(0, 16);

/**
 * One class opened up: when it meets, where, who teaches it and who is in it.
 * Shared by the manager's class list and the desk, which see the same thing.
 * With `manage` (the manager only) it also cancels or moves a session, changes
 * the coach, edits the capacity or cancels the class.
 */
export function ClassDetailModal({
  classId,
  onClose,
  manage = false,
  onChanged,
}: {
  classId: string | null;
  onClose: () => void;
  manage?: boolean;
  onChanged?: () => void;
}) {
  const { data, error, reload } = useRead<ClassDetail>(classId ? `/classes/${classId}` : null);
  useLive(classId ? `class:${classId}` : null, reload);
  useLive("classes", reload);
  const [action, setAction] = useState<Action | null>(null);

  // Another class never starts with a half-filled form from the last one.
  useEffect(() => {
    setAction(null);
  }, [classId]);

  const changed = useCallback(() => {
    setAction(null);
    reload();
    onChanged?.();
  }, [onChanged, reload]);

  const navigate = useNavigate();
  const user = useSessionUser();
  const [messagingCoach, setMessagingCoach] = useState(false);

  async function handleMessageCoach() {
    if (!c?.coach_id || messagingCoach) return;
    setMessagingCoach(true);
    try {
      const res = await apiPost<{ conversation: { id: string } }>("/conversations", { recipient_id: c.coach_id });
      onClose();
      navigate({ to: "/chat", search: { conv: res.conversation.id } });
    } catch (e: any) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Cannot message this coach"));
    } finally {
      setMessagingCoach(false);
    }
  }

  const c = data?.class;
  const confirmed = data?.roster.filter((r) => r.status === "confirmed") ?? [];
  const waiting = data?.roster.filter((r) => r.status === "waitlisted") ?? [];
  const upcoming = data?.sessions.filter((s) => s.status === "scheduled") ?? [];
  const past = data?.sessions.filter((s) => s.status !== "scheduled") ?? [];

  return (
    <Modal
      open={!!classId}
      onClose={onClose}
      title={c ? `${sportLabel(c.sport)} · ${levelLabel(c.level)}` : t("Class")}
      footer={
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {t("Close")}
          </Button>
        </div>
      }
    >
      {error ? (
        <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
      ) : !c || !data ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="grid gap-5">
          <div className="flex items-center gap-3">
            <Cover
              slot={"coach." + c.coach_id}
              fallbackInitials={initials(c.coach_name)}
              className="size-12 shrink-0 rounded-full border border-line"
              initialsClassName="text-sm font-bold"
              alt={c.coach_name}
            />
            <div className="min-w-0 flex-1 grid gap-1 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium tabular-nums">{c.code}</span>
                <StatusBadge status={c.status} />
                <Badge tone="muted">
                  <HighlightBadge value={c.enrolled_count}>
                    {t("{n}/{cap} enrolled", { n: c.enrolled_count, cap: c.capacity })}
                  </HighlightBadge>
                </Badge>
              </div>
              <p className="text-muted">
                {t("Coach {name}", { name: c.coach_name })}
                {c.assistant_name ? ` · ${t("assisted by {name}", { name: c.assistant_name })}` : ""} · {c.court_code}
              </p>
              <p className="text-muted">
                {rruleLabel(c.rrule, c.duration_min)} · {formatDate(c.start_on)} - {formatDate(c.end_on)}
              </p>
            </div>
            {c.coach_id && user && user.id !== c.coach_id ? (
              <Button
                size="sm"
                variant="outline"
                disabled={messagingCoach}
                onClick={() => void handleMessageCoach()}
                className="shrink-0 flex items-center gap-1.5"
              >
                <MessageSquare className="size-4" />
                <span>{t("Message coach")}</span>
              </Button>
            ) : null}
          </div>

          <section>
            <h3 className="text-2xs font-medium text-muted">
              {t("Sessions · {n} to come", { n: upcoming.length })}
            </h3>
            {data.sessions.length ? (
              <ul className="mt-2 grid max-h-56 gap-1 overflow-y-auto text-sm">
                {[...upcoming, ...past].map((s) => (
                  <li
                    key={s.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] bg-wood/60 px-3 py-2"
                  >
                    <span className="tabular-nums">
                      {sessionDay(s.start_at)} · {hhmm(s.start_at)}-{hhmm(s.end_at)}
                    </span>
                    <span className="flex items-center gap-2 text-muted">
                      {s.court_code} · <span className="tabular-nums">{s.headcount}</span>/{c.capacity}
                      {s.status !== "scheduled" ? <StatusBadge status={s.status} /> : null}
                      {manage && s.status === "scheduled" && new Date(s.start_at) > new Date() && c.status !== "cancelled" ? (
                        <>
                          {(["move-session", "cancel-session"] as const).map((kind) => (
                            <Button
                              key={kind}
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setAction({
                                  kind,
                                  sessionId: s.id,
                                  startAt: s.start_at,
                                  label: `${sessionDay(s.start_at)} · ${hhmm(s.start_at)}`,
                                })
                              }
                            >
                              {kind === "move-session" ? t("Move") : t("Cancel")}
                            </Button>
                          ))}
                        </>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted">
                {c.status === "draft"
                  ? t("No sessions yet. They are created when the class is published.")
                  : t("No sessions on the calendar.")}
              </p>
            )}
          </section>

          <section>
            <h3 className="text-2xs font-medium text-muted">
              {t("Students · {n}", { n: confirmed.length })}
            </h3>
            {confirmed.length ? (
              <ul className="mt-2 grid max-h-48 gap-1 overflow-y-auto text-sm">
                {confirmed.map((r) => (
                  <li key={r.id} className="flex flex-wrap justify-between gap-2 px-1">
                    <span className="font-medium">{r.full_name}</span>
                    <span className="tabular-nums text-muted">
                      {r.member_code ?? "-"} · {r.phone}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted">{t("Nobody has enrolled yet.")}</p>
            )}
            {waiting.length ? (
              <p className="mt-2 text-sm text-muted">{t("Waiting list: {names}", { names: waiting.map((r) => r.full_name).join(", ") })}</p>
            ) : null}
          </section>

          {manage && c.status !== "cancelled" ? (
            <section className="grid gap-3 border-t border-line pt-4">
              <h3 className="text-2xs font-medium text-muted">{t("Manage this class")}</h3>
              {action ? (
                <ActionForm classData={c} action={action} onDone={changed} onBack={() => setAction(null)} />
              ) : (
                <div className="flex flex-wrap gap-2">
                  {c.status !== "draft" ? (
                    <>
                      <Button size="sm" variant="outline" onClick={() => setAction({ kind: "coach" })}>
                        {t("Change coach")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setAction({ kind: "capacity" })}>
                        {t("Edit capacity")}
                      </Button>
                    </>
                  ) : null}
                  <Button size="sm" variant="outline" onClick={() => setAction({ kind: "cancel-class" })}>
                    {t("Cancel class")}
                  </Button>
                </div>
              )}
            </section>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

const ACTION_COPY = {
  "cancel-session": { title: tk("Cancel this session"), go: tk("Cancel session"), needsReason: true },
  "move-session": { title: tk("Move this session"), go: tk("Move session"), needsReason: false },
  coach: { title: tk("Change the coach for every session still to come"), go: tk("Change coach"), needsReason: false },
  capacity: { title: tk("Edit capacity"), go: tk("Save capacity"), needsReason: false },
  "cancel-class": { title: tk("Cancel the whole class"), go: tk("Cancel class"), needsReason: true },
} as const;

/** The one form behind every manager action on a class: it asks only for what that action needs. */
function ActionForm({
  classData,
  action,
  onDone,
  onBack,
}: {
  classData: ClassDetail["class"];
  action: Action;
  onDone: () => void;
  onBack: () => void;
}) {
  const [reason, setReason] = useState("");
  const [start, setStart] = useState(action.kind === "move-session" ? toLocalInput(action.startAt) : "");
  const coachRead = useRead<{ items: Array<{ id: string; full_name: string }> }>(
    action.kind === "coach" ? "/staff?role=coach&status=active" : null,
  );
  const coaches = (coachRead.data?.items ?? []).filter((x) => x.id !== classData.coach_id);
  const [coachId, setCoachId] = useState("");
  const [capacity, setCapacity] = useState(String(classData.capacity));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);

  const copy = ACTION_COPY[action.kind];

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (action.kind === "cancel-session") {
        const r = await apiPost<{ notified: number; refunded: number }>(`/sessions/${action.sessionId}/cancel`, { reason });
        toast.success(t("Session cancelled: {told} told, {back} given a session back", { told: r.notified, back: r.refunded }));
      } else if (action.kind === "move-session") {
        if (!start) throw Object.assign(new Error(t("Pick the new start time.")), { field: "start_at" });
        await apiPost(`/sessions/${action.sessionId}/reschedule`, {
          start_at: toIctIso(start),
          ...(reason ? { reason } : {}),
        });
        toast.success(t("Session moved: members and coaches were told"));
      } else if (action.kind === "coach") {
        if (!coachId) throw Object.assign(new Error(t("Choose the new coach.")), { field: "coach_id" });
        await apiPost(`/classes/${classData.id}/coach`, { coach_id: coachId, ...(reason ? { reason } : {}) });
        toast.success(t("Coach changed"));
      } else if (action.kind === "capacity") {
        await apiPatch(`/classes/${classData.id}`, { capacity: Number(capacity) });
        toast.success(t("Capacity saved"));
      } else {
        await apiPatch(`/classes/${classData.id}`, { status: "cancelled", reason });
        toast.success(t("Class cancelled: everyone enrolled was told"));
      }
      onDone();
    } catch (e) {
      const x = e as { message?: string; field?: string; body?: { field?: string } };
      setError({ field: x.body?.field ?? x.field, message: x.message ? tServer(x.message) : t("That did not work") });
    } finally {
      setBusy(false);
    }
  }

  const reasonLabel =
    action.kind === "move-session"
      ? t("Reason (needed if it starts within 12 hours)")
      : action.kind === "coach"
        ? t("Reason (optional)")
        : t("Reason");
  const at = (field: string) => (error?.field === field ? error.message : undefined);
  return (
    <div
      className="grid gap-3 rounded-[var(--radius-sm)] bg-wood/60 p-3"
      ref={(el) => el?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() })}
    >
      <p className="text-sm font-medium">
        {t(copy.title)}
        {"label" in action ? <span className="text-muted"> · {action.label}</span> : null}
      </p>
      {action.kind === "move-session" ? (
        <Field label={t("New start")} hint={at("start_at")}>
          <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
      ) : null}
      {action.kind === "coach" ? (
        coachRead.error ? (
          <LoadError
            message={coachRead.error.message}
            onRetry={coachRead.error.refused ? undefined : coachRead.reload}
          />
        ) : (
          <Field label={t("New coach")} hint={at("coach_id")}>
            <Select value={coachId} onChange={(e) => setCoachId(e.target.value)}>
              <option value="">{t("Choose…")}</option>
              {coaches.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.full_name}
                </option>
              ))}
            </Select>
          </Field>
        )
      ) : null}
      {action.kind === "capacity" ? (
        <Field label={t("Capacity ({n} enrolled)", { n: classData.enrolled_count })} hint={at("capacity")}>
          <Input type="number" min={1} max={200} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
        </Field>
      ) : (
        <Field label={reasonLabel} hint={at("reason")}>
          <Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
        </Field>
      )}
      {error && !["start_at", "coach_id", "capacity", "reason"].includes(error.field ?? "") ? (
        <p role="alert" className="text-sm text-danger">
          {error.message}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onBack} disabled={busy}>
          {t("Back")}
        </Button>
        <Button
          size="sm"
          variant={action.kind.startsWith("cancel") ? "danger" : "primary"}
          onClick={submit}
          disabled={busy || (copy.needsReason && !reason.trim()) || (action.kind === "coach" && !!coachRead.error)}
        >
          {t(copy.go)}
        </Button>
      </div>
    </div>
  );
}

type OccDetail =
  | {
      kind: "booking";
      booking: {
        id: string;
        code: string;
        status: string;
        channel: string;
        start_at: string;
        end_at: string;
        price_vnd: number;
        discount_pct: number;
        paid_vnd: number;
        hold_until: string | null;
        awaiting_transfer: boolean;
        court_code: string;
        sport: string;
      };
      customer: { type: "member" | "guest"; name: string | null; phone: string | null; member_code: string | null };
    }
  | {
      kind: "session";
      session: {
        id: string;
        class_id: string;
        start_at: string;
        end_at: string;
        status: string;
        court_code: string;
        sport: string;
        level: string;
        capacity: number;
        enrolled_count: number;
        coach_name: string;
      };
    }
  | { kind: "maintenance"; maintenance: { reason: string | null; court_code: string; start_at: string; end_at: string } };

/**
 * Whose hour is this? Opened from a taken cell on the court map.
 */
export function OccupancyDetailModal({
  target,
  onClose,
  onOpenClass,
}: {
  target: { kind: string; ref: string } | null;
  onClose: () => void;
  onOpenClass?: (classId: string) => void;
}) {
  const { data, error, reload } = useRead<OccDetail>(
    target ? `/occupancy/detail?kind=${encodeURIComponent(target.kind)}&ref=${encodeURIComponent(target.ref)}` : null,
  );

  const title =
    data?.kind === "booking"
      ? t("Booking {code}", { code: data.booking.code })
      : data?.kind === "session"
        ? t("Class session")
        : data?.kind === "maintenance"
          ? t("Court out of service")
          : target
            ? kindLabel(target.kind)
            : t("Details");

  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title={title}
      footer={
        <div className="flex justify-end gap-2">
          {data?.kind === "session" && onOpenClass ? (
            <Button variant="outline" onClick={() => onOpenClass(data.session.class_id)}>
              {t("Open the class")}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            {t("Close")}
          </Button>
        </div>
      }
    >
      {error ? (
        <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
      ) : !data ? (
        <Skeleton className="h-32" />
      ) : data.kind === "booking" ? (
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted">{t("Customer")}</dt>
          <dd className="font-medium">
            {data.customer.name ?? "-"}{" "}
            <Badge tone={data.customer.type === "member" ? "accent" : "muted"}>
              {data.customer.type === "member" ? t("Member") : t("Walk-in")}
            </Badge>
          </dd>
          <dt className="text-muted">{t("Phone")}</dt>
          <dd className="tabular-nums">
            {data.customer.phone ?? "-"}
            {data.customer.member_code ? ` · ${data.customer.member_code}` : ""}
          </dd>
          <dt className="text-muted">{t("Court")}</dt>
          <dd>
            {data.booking.court_code} · {sportLabel(data.booking.sport)}
          </dd>
          <dt className="text-muted">{t("Time")}</dt>
          <dd className="tabular-nums">
            {sessionDay(data.booking.start_at)} · {hhmm(data.booking.start_at)}-{hhmm(data.booking.end_at)}
          </dd>
          <dt className="text-muted">{t("Amount")}</dt>
          <dd className="tabular-nums">
            {money(data.booking.price_vnd)}
            {data.booking.discount_pct ? ` (−${data.booking.discount_pct}%)` : ""} ·{" "}
            {t("paid {amount}", { amount: money(data.booking.paid_vnd) })}
          </dd>
          <dt className="text-muted">{t("Status")}</dt>
          <dd>
            <StatusBadge status={data.booking.status} />
            {data.booking.status === "hold" && data.booking.hold_until ? (
              <span className="ml-2 text-muted">
                {data.booking.awaiting_transfer ? `${t("waiting for the bank transfer")} · ` : ""}
                {t("held until {time}", { time: hhmm(data.booking.hold_until) })}
              </span>
            ) : null}
          </dd>
          <dt className="text-muted">{t("Booked via")}</dt>
          <dd className="capitalize">{data.booking.channel}</dd>
        </dl>
      ) : data.kind === "session" ? (
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted">{t("Class")}</dt>
          <dd className="font-medium">
            {sportLabel(data.session.sport)} · {levelLabel(data.session.level)}
          </dd>
          <dt className="text-muted">{t("Coach")}</dt>
          <dd>{data.session.coach_name}</dd>
          <dt className="text-muted">{t("Court")}</dt>
          <dd>{data.session.court_code}</dd>
          <dt className="text-muted">{t("Time")}</dt>
          <dd className="tabular-nums">
            {sessionDay(data.session.start_at)} · {hhmm(data.session.start_at)}-{hhmm(data.session.end_at)}
          </dd>
          <dt className="text-muted">{t("Students")}</dt>
          <dd className="tabular-nums">
            {data.session.enrolled_count}/{data.session.capacity}
          </dd>
        </dl>
      ) : (
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted">{t("Court")}</dt>
          <dd>{data.maintenance.court_code}</dd>
          <dt className="text-muted">{t("Time")}</dt>
          <dd className="tabular-nums">
            {when(data.maintenance.start_at)} - {hhmm(data.maintenance.end_at)}
          </dd>
          <dt className="text-muted">{t("Reason")}</dt>
          <dd>{data.maintenance.reason ?? t("No reason recorded.")}</dd>
        </dl>
      )}
    </Modal>
  );
}
