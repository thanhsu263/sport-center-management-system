import { createFileRoute } from "@tanstack/react-router";
import { CalendarPlus, Repeat } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { SectionTitle } from "@/components/section";
import { Shell, money, when, useSessionUser } from "@/components/shell";
import {
  Badge,
  Button,
  Card,
  Check,
  DateField,
  EmptyState,
  Field,
  Input,
  LoadError,
  Modal,
  Seg,
  Select,
  Skeleton,
} from "@/components/ui";
import { Reveal, Stagger, StaggerItem } from "@/components/motion";
import { TillNotice, useTillOpen } from "@/components/till-notice";
import { ApiClientError, apiGet, apiPost } from "@/lib/arena3/client";
import { addDaysISO, formatDate, sportLabel, todayISO } from "@/lib/arena3/labels";
import { t, tServer } from "@/lib/i18n";
import { useRead } from "@/lib/use-read";

export const Route = createFileRoute("/desk/series")({ component: Page });

type Court = { id: string; court_code: string; sport: string; status: string };
type Line = { date: string; start_at: string; list_vnd: number; price_vnd: number; is_peak: boolean; available: boolean; reason?: string };
type Preview = {
  court_code: string;
  customer: { name: string; phone: string; is_member: boolean };
  discount_pct: number;
  min_weeks: number;
  lines: Line[];
  booked: number;
  skipped: number;
  list_total_vnd: number;
  total_vnd: number;
};
type Series = {
  id: string;
  code: string;
  weekday: number;
  start_local: string;
  weeks: number;
  starts_on: string;
  discount_pct: number;
  status: string;
  court_code: string;
  customer: string;
  phone: string;
  remaining: number;
  next_at: string | null;
};
/** The few centre settings the form needs: how long a block may run and when the doors are open. */
type Cfg = {
  series_min_weeks: number;
  series_max_weeks: number;
  open_time: string;
  close_time: string;
  slot_minutes: number;
};

const FALLBACK: Cfg = { series_min_weeks: 4, series_max_weeks: 12, open_time: "06:00", close_time: "22:00", slot_minutes: 60 };

function minutes(hhmm: string) {
  const [h = 0, m = 0] = hhmm.slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

/** Every start time a slot can begin at, from opening time to the last slot that still ends before closing. */
function startTimes(cfg: Cfg) {
  const out: string[] = [];
  const step = cfg.slot_minutes > 0 ? cfg.slot_minutes : 60;
  for (let m = minutes(cfg.open_time); m + step <= minutes(cfg.close_time); m += step) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  }
  return out;
}

/** The week counts offered as buttons: all of them when there are few, else a handful of round ones. */
function weekChoices(min: number, max: number) {
  if (max - min < 9) return Array.from({ length: max - min + 1 }, (_, i) => min + i);
  return [...new Set([min, 8, 12, 16, 24, max])].filter((n) => n >= min && n <= max).sort((a, b) => a - b);
}

function weekdayName(w: number) {
  return [t("Sunday"), t("Monday"), t("Tuesday"), t("Wednesday"), t("Thursday"), t("Friday"), t("Saturday")][w] ?? "";
}

function weekdayOf(iso: string) {
  const [y = 1970, m = 1, d = 1] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function Page() {
  const user = useSessionUser();
  const role = user?.role === "manager" ? "manager" : "receptionist";
  const form = useRef<HTMLFormElement>(null);
  const courtsRead = useRead<{ items: Court[] }>("/courts");
  const seriesRead = useRead<{ items: Series[] }>("/series");
  const courts = useMemo(() => (courtsRead.data?.items ?? []).filter((x) => x.status === "ready"), [courtsRead.data]);
  // null = not known yet (still asking, or the question failed) — never an empty list.
  const list = seriesRead.data?.items ?? null;
  const [cfg, setCfg] = useState<Cfg>(FALLBACK);
  const [courtId, setCourtId] = useState("");
  const [date, setDate] = useState(todayISO());
  const [time, setTime] = useState("19:00");
  const [weeks, setWeeks] = useState(8);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [method, setMethod] = useState("cash");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ field?: string; message: string } | null>(null);
  const [stopping, setStopping] = useState<Series | null>(null);
  const tillOpen = useTillOpen(role === "receptionist");

  useEffect(() => {
    setCourtId((cur) => cur || courts[0]?.id || "");
  }, [courts]);
  useEffect(() => {
    // The limits are the manager's to change, so they are read, not hard-coded. Failing to read
    // them is not fatal: the server still enforces the real ones when the weeks are checked.
    void apiGet<Partial<Cfg>>("/settings")
      .then((s) =>
        setCfg({
          series_min_weeks: Number(s.series_min_weeks ?? FALLBACK.series_min_weeks),
          series_max_weeks: Number(s.series_max_weeks ?? FALLBACK.series_max_weeks),
          open_time: String(s.open_time ?? FALLBACK.open_time),
          close_time: String(s.close_time ?? FALLBACK.close_time),
          slot_minutes: Number(s.slot_minutes ?? FALLBACK.slot_minutes),
        }),
      )
      .catch(() => undefined);
  }, []);

  const times = startTimes(cfg);
  const choices = weekChoices(cfg.series_min_weeks, Math.max(cfg.series_min_weeks, cfg.series_max_weeks));
  // Keep the picks inside what the centre allows once the settings arrive.
  useEffect(() => {
    setWeeks((w) => Math.min(Math.max(w, choices[0] ?? w), choices[choices.length - 1] ?? w));
    setTime((cur) => (times.includes(cur) ? cur : times.includes("19:00") ? "19:00" : (times[0] ?? cur)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg]);

  /** Any change to the form makes the checked weeks out of date, so the result is cleared with it. */
  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPreview(null);
      setErr(null);
    };

  const body = () => ({
    court_id: courtId,
    first_date: date,
    start_local: time,
    weeks,
    phone,
    guest_name: name || undefined,
    method,
  });

  function fail(e: unknown) {
    const next =
      e instanceof ApiClientError
        ? { field: e.body.field, message: tServer(e.message) }
        : { message: e instanceof Error ? tServer(e.message) : t("Something went wrong") };
    setErr(next);
    // Put the cursor on the field that needs fixing instead of leaving it on the button.
    const el = next.field ? form.current?.elements.namedItem(next.field) : null;
    if (el instanceof HTMLElement) requestAnimationFrame(() => el.focus());
  }

  async function check(e?: FormEvent) {
    e?.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      setPreview(await apiPost<Preview>("/series/preview", body()));
    } catch (error) {
      setPreview(null);
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  async function book() {
    setErr(null);
    setBusy(true);
    try {
      const r = await apiPost<{ booked: number; skipped: unknown[]; total_vnd: number }>("/series", body(), true);
      toast.success(t("{n} weeks booked · {amount}", { n: r.booked, amount: money(r.total_vnd) }));
      setPreview(null);
      setPhone("");
      setName("");
      seriesRead.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  const fieldErr = (f: string) => (err?.field === f ? err.message : undefined);
  const running = (list ?? []).filter((s) => s.status === "active" && s.remaining > 0);
  const ended = (list ?? []).filter((s) => !(s.status === "active" && s.remaining > 0));
  const last = addDaysISO(date, 7 * (weeks - 1));

  return (
    <Shell
      role={role}
      title={t("Fixed weekly bookings")}
      subtitle={t("Same court, same hour, every week. Paid up front for the whole block at a discount.")}
    >
      {tillOpen ? null : <TillNotice />}
      <Reveal from="down">
        <Card className="mb-4">
          <SectionTitle text={t("Set up a fixed booking")} icon={CalendarPlus} className="mb-4" />
          {/* Without the courts the form cannot be filled in, so say why before the person tries. */}
          {courtsRead.error ? (
            <div className="mb-4">
              <LoadError
                message={courtsRead.error.message}
                onRetry={courtsRead.error.refused ? undefined : courtsRead.reload}
              />
            </div>
          ) : null}
          <form ref={form} onSubmit={(e) => void check(e)} className="grid gap-5">
            <fieldset className="m-0 min-w-0 border-0 p-0">
              <legend className="kicker mb-2 p-0 text-2xs text-muted">{t("Customer")}</legend>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label={t("Phone")} hint={fieldErr("phone")}>
                  <Input
                    name="phone"
                    inputMode="tel"
                    autoComplete="off"
                    placeholder={t("09xx xxx xxx")}
                    value={phone}
                    aria-invalid={fieldErr("phone") ? true : undefined}
                    onChange={(e) => edit(setPhone)(e.target.value)}
                  />
                </Field>
                <Field
                  label={t("Name (for a guest)")}
                  hint={fieldErr("guest_name") ?? t("Only for a guest. A member is found by their phone number.")}
                  tone={fieldErr("guest_name") ? "danger" : "muted"}
                >
                  <Input
                    name="guest_name"
                    autoComplete="off"
                    value={name}
                    aria-invalid={fieldErr("guest_name") ? true : undefined}
                    onChange={(e) => edit(setName)(e.target.value)}
                  />
                </Field>
              </div>
            </fieldset>

            <fieldset className="m-0 min-w-0 border-0 p-0">
              <legend className="kicker mb-2 p-0 text-2xs text-muted">{t("Court and time")}</legend>
              <div className="grid gap-3 md:grid-cols-3">
                <Field label={t("Court")} hint={fieldErr("court_id")}>
                  <Select
                    name="court_id"
                    value={courtId}
                    disabled={!courts.length}
                    onChange={(e) => edit(setCourtId)(e.target.value)}
                  >
                    {courts.length ? (
                      courts.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.court_code} · {sportLabel(c.sport)}
                        </option>
                      ))
                    ) : (
                      <option value="">{courtsRead.data ? t("No courts") : courtsRead.error ? "-" : t("Loading")}</option>
                    )}
                  </Select>
                </Field>
                <Field label={t("First date")} hint={fieldErr("first_date")}>
                  <DateField value={date} onChange={edit(setDate)} aria-label={t("First date")} />
                </Field>
                <Field label={t("Start time")} hint={fieldErr("start_local")}>
                  <Select name="start_local" value={time} onChange={(e) => edit(setTime)(e.target.value)}>
                    {times.map((h) => (
                      <option key={h}>{h}</option>
                    ))}
                  </Select>
                </Field>
              </div>
            </fieldset>

            <fieldset className="m-0 min-w-0 border-0 p-0">
              <legend className="kicker mb-2 p-0 text-2xs text-muted">{t("Weeks")}</legend>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Seg
                  value={String(weeks)}
                  onChange={(v) => edit(setWeeks)(Number(v))}
                  options={choices.map((n) => ({ value: String(n), label: String(n) }))}
                />
                <p className="text-sm text-muted">
                  {t("Every {day} at {time} for {n} weeks, {from} to {to}", {
                    day: weekdayName(weekdayOf(date)),
                    time,
                    n: weeks,
                    from: formatDate(date),
                    to: formatDate(last),
                  })}
                </p>
              </div>
              {fieldErr("weeks") ? (
                <p role="alert" className="mt-1.5 text-sm text-danger">
                  {fieldErr("weeks")}
                </p>
              ) : null}
            </fieldset>

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={busy || !courtId || !phone.trim()}>
                {busy ? t("Checking…") : t("Check the weeks")}
              </Button>
              {err && !err.field ? (
                <p role="alert" className="text-sm text-danger">
                  {err.message}
                </p>
              ) : null}
            </div>
          </form>
        </Card>
      </Reveal>

      {preview ? (
        <Reveal>
          <Card className="mb-6 border border-accent/30">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-display text-xl">
                  {preview.court_code} · {time} · {preview.customer.name}
                </p>
                <p className="text-xs text-muted">
                  {preview.customer.is_member ? t("Member") : t("Guest")} · {preview.customer.phone} ·{" "}
                  {t("{pct}% off for a fixed booking", { pct: preview.discount_pct })}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted line-through tabular-nums">{money(preview.list_total_vnd)}</p>
                <p className="font-display text-2xl tabular-nums">{money(preview.total_vnd)}</p>
                <p className="text-xs text-muted">{t("{n} weeks", { n: preview.booked })}</p>
              </div>
            </div>
            <ul className="mt-3 grid gap-1 text-sm sm:grid-cols-2">
              {preview.lines.map((l) => (
                <li
                  key={l.date}
                  className={`flex items-center justify-between gap-2 rounded-[var(--radius-sm)] px-3 py-1.5 ${l.available ? "bg-wood/50" : "bg-danger/10 text-danger"}`}
                >
                  <span>{formatDate(l.date)}</span>
                  <span className="tabular-nums">
                    {l.available ? money(l.price_vnd) : l.reason === "past" ? t("In the past") : t("Already taken: skipped")}
                  </span>
                </li>
              ))}
            </ul>
            {preview.skipped > 0 ? (
              <p className="mt-2 text-xs text-hold">{t("{n} week(s) are taken and will be left out; you are only charged for the rest.", { n: preview.skipped })}</p>
            ) : null}
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <Field label={t("Paid by")}>
                <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                  <option value="cash">{t("Cash")}</option>
                  <option value="card">{t("Card")}</option>
                  <option value="transfer">{t("Bank transfer")}</option>
                </Select>
              </Field>
              <Button onClick={() => void book()} disabled={busy || preview.booked === 0 || !tillOpen}>
                {tillOpen ? t("Take {amount} and book", { amount: money(preview.total_vnd) }) : t("Open a shift first")}
              </Button>
              <Button variant="outline" onClick={() => setPreview(null)}>
                {t("Change")}
              </Button>
            </div>
          </Card>
        </Reveal>
      ) : null}

      <SectionTitle text={t("Running now")} icon={Repeat} className="mb-3" />
      {seriesRead.error ? (
        <LoadError
          message={seriesRead.error.message}
          onRetry={seriesRead.error.refused ? undefined : seriesRead.reload}
        />
      ) : !list ? (
        <Skeleton className="h-24" />
      ) : running.length === 0 ? (
        <EmptyState
          title={list.length ? t("None running right now") : t("No fixed bookings yet")}
          hint={t("Fill in the form above to set one up for a regular.")}
        />
      ) : (
        <Stagger className="grid gap-2 md:grid-cols-2" gap={0.04}>
          {running.map((s) => (
            <StaggerItem key={s.id}>
              <SeriesCard s={s} onStop={() => setStopping(s)} />
            </StaggerItem>
          ))}
        </Stagger>
      )}

      {ended.length > 0 ? (
        <>
          <SectionTitle text={t("Ended")} className="mb-3 mt-8" />
          <div className="grid gap-2 md:grid-cols-2">
            {ended.map((s) => (
              <SeriesCard key={s.id} s={s} />
            ))}
          </div>
        </>
      ) : null}

      <StopDialog
        series={stopping}
        onClose={() => setStopping(null)}
        onDone={() => {
          setStopping(null);
          seriesRead.reload();
        }}
      />
    </Shell>
  );
}

function SeriesCard({ s, onStop }: { s: Series; onStop?: () => void }) {
  const live = s.status === "active" && s.remaining > 0;
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div>
        <p className="font-medium">
          {s.court_code} · {weekdayName(s.weekday)} {s.start_local.slice(0, 5)}
        </p>
        <p className="text-xs text-muted">
          {s.customer} · {s.phone} · <span className="font-mono">{s.code}</span>
        </p>
        <p className="mt-1 text-xs text-muted">
          {live
            ? t("{n} of {total} weeks to go", { n: s.remaining, total: s.weeks }) + (s.next_at ? ` · ${t("next")} ${when(s.next_at)}` : "")
            : s.status === "cancelled"
              ? t("Cancelled")
              : t("Finished")}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Badge tone={live ? "accent" : "muted"}>-{s.discount_pct}%</Badge>
        {live && onStop ? (
          <Button size="sm" variant="outline" onClick={onStop}>
            {t("Stop")}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

/** Stopping a block cancels every week still to come, so it is said out loud and confirmed first. */
function StopDialog({ series, onClose, onDone }: { series: Series | null; onClose: () => void; onDone: () => void }) {
  const [waive, setWaive] = useState(false);
  const [busy, setBusy] = useState(false);
  // The dialog fades out after `series` is cleared; keep what it showed so the text does not blink away.
  const [shown, setShown] = useState<Series | null>(null);
  useEffect(() => {
    if (!series) return;
    setShown(series);
    setWaive(false);
  }, [series]);
  const s = series ?? shown;

  async function go() {
    if (!series) return;
    setBusy(true);
    try {
      const r = await apiPost<{ cancelled: number; refunded_vnd: number }>(`/series/${series.id}/cancel`, { waive });
      toast.success(t("{n} weeks cancelled · refunded {amount}", { n: r.cancelled, amount: money(r.refunded_vnd) }));
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!series}
      onClose={onClose}
      title={t("Stop this fixed booking?")}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("Keep it")}
          </Button>
          <Button variant="danger" onClick={() => void go()} disabled={busy}>
            {busy ? t("Stopping…") : t("Yes, stop it")}
          </Button>
        </>
      }
    >
      {s ? (
        <div className="grid gap-3 text-sm">
          <p className="font-medium">
            {s.court_code} · {weekdayName(s.weekday)} {s.start_local.slice(0, 5)} · {s.customer}
          </p>
          <p>{t("{n} weeks are still to come. Each one is refunded by the normal cancellation rules.", { n: s.remaining })}</p>
          <Check
            checked={waive}
            onChange={(e) => setWaive(e.target.checked)}
            label={t("Waive the fee")}
            hint={t("For cancellations that are not the customer's doing: centre closed, flood, accident.")}
          />
        </div>
      ) : null}
    </Modal>
  );
}
