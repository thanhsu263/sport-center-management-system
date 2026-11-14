import { createFileRoute } from "@tanstack/react-router";
import { SectionTitle } from "@/client/components/section";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { toast } from "sonner";
import { Shell, hhmm, useSessionUser } from "@/client/components/shell";
import { UserAvatar } from "@/client/components/user-avatar";
import { QrScanner, tokenFromScan } from "@/client/components/qr-scanner";
import { PageHero } from "@/client/components/page-hero";
import { Badge, Button, Card, EmptyState, Field, Input, LoadError, Pagination, Select, Seg, Skeleton } from "@/client/components/ui";
import { ApiClientError, apiGet, apiPost } from "@/client/arena3/client";
import { sportLabel } from "@/shared/arena3/labels";
import { t, tk, tServer, tData } from "@/client/lib/i18n";
import { usePageState } from "@/client/lib/use-page-state";
import { readError, useRead } from "@/client/lib/use-read";
import { useLive } from "@/client/lib/use-live";

export const Route = createFileRoute("/desk/gate")({ component: Page });

type Result = {
  member: { id: string; full_name: string; member_code: string | null; avatar_url?: string | null };
  allowed: boolean;
  needs_override: boolean;
  flagged?: boolean;
  checked_in_at: string | null;
  duplicate: boolean;
  plans: Array<{ id: string; name: string; end_on: string; status: string }>;
  warnings: Array<{ kind: string; message: string }>;
  today: {
    bookings: Array<{ id: string; code: string; start_at: string; court_code: string }>;
    sessions: Array<{ id: string; start_at: string; sport: string; court_code: string }>;
  };
};

type Entry = {
  id: string;
  at: string;
  user_id: string;
  full_name: string;
  member_code: string | null;
  method: string | null;
  flagged: boolean;
  reason: string | null;
  avatar_url?: string | null;
};

/** What reception picks from when the code could not be used (BR-31). */
const MANUAL_REASONS = [
  { value: "no_phone", label: tk("Member has no phone with them") },
  { value: "dead_battery", label: tk("Phone battery is dead") },
  { value: "qr_failed", label: tk("Code would not scan") },
  { value: "forgot", label: tk("Forgot to open the app") },
  { value: "other", label: tk("Other") },
];

/** Why someone with no plan or booking may still come in. */
const OVERRIDE_REASONS = [
  { value: "renewing", label: tk("Paying at the desk right now") },
  { value: "guest_pass", label: tk("Guest pass") },
  { value: "manager_ok", label: tk("Manager approved") },
  { value: "expired_ok", label: tk("Just expired (grace)") },
  { value: "other", label: tk("Other") },
];

const METHOD_LABEL: Record<string, string> = { qr: tk("QR"), manual: tk("Manual"), self: tk("Self") };

/** The wording for a stored reason code, in the current language. */
function reasonLabel(code: string) {
  const hit = [...MANUAL_REASONS, ...OVERRIDE_REASONS].find((r) => r.value === code);
  return hit ? t(hit.label) : code.replace(/_/g, " ");
}

type Pending = { kind: "qr"; token: string } | { kind: "manual"; body: Record<string, unknown> };

function Page() {
  const user = useSessionUser();
  const [mode, setMode] = useState("qr");
  const [scan, setScan] = useState("");
  const [q, setQ] = useState("");
  const [reason, setReason] = useState("no_phone");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [overrideReason, setOverrideReason] = useState("renewing");
  const [error, setError] = useState<string | null>(null);
  const gatePage = usePageState("desk.gate", 25);
  const todayRead = useRead<{ items: Entry[]; total: number }>(
    `/desk/gate-checkins?limit=${gatePage.pageSize}&offset=${gatePage.offset}`,
    { keepPrevious: true },
  );
  useLive("attendance", () => {
    todayRead.reload();
  });
  const today = todayRead.data?.items ?? null;

  const refocus = (id: string) => setTimeout(() => document.getElementById(id)?.focus(), 0);

  async function send(p: Pending, override?: string) {
    setBusy(true);
    setError(null);
    try {
      const extra = override ? { override: true, override_reason: override } : {};
      const res =
        p.kind === "qr"
          ? await apiPost<Result>("/desk/scan", { token: p.token, ...extra })
          : await apiPost<Result>("/desk/gate-checkin", { ...p.body, ...extra });
      setResult(res);
      if (res.needs_override) {
        setPending(p);
        toast.warning(t("Needs override approval"));
      } else {
        setPending(null);
        setScan("");
        setQ("");
        toast.success(
          res.duplicate
            ? t("Already checked in: {name}", { name: res.member.full_name })
            : t("Checked in: {name}", { name: res.member.full_name }),
        );
        todayRead.reload();
      }
    } catch (err) {
      setResult(null);
      setPending(null);
      setError(err instanceof Error ? tServer(err.message) : t("Check-in failed"));
      toast.error(t("That check-in didn't go through"));
      if (err instanceof ApiClientError && err.body.field === "reason") setMode("manual");
    } finally {
      setBusy(false);
      refocus(p.kind === "qr" ? "gate-scan" : "gate-q");
    }
  }

  function submitScan(e: React.FormEvent) {
    e.preventDefault();
    const v = scan.trim();
    if (v) void send({ kind: "qr", token: tokenFromScan(v) });
  }

  function submitManual(e: React.FormEvent) {
    e.preventDefault();
    const v = q.trim();
    if (!v) return;
    // A phone number starts with a digit or +; a member code is letters first.
    const who = /^[+0-9][0-9 .-]{7,}$/.test(v) ? { phone: v.replace(/[ .-]/g, "") } : { code: v };
    void send({ kind: "manual", body: { ...who, reason } });
  }

  return (
    <Shell role={user?.role === "manager" ? "manager" : "receptionist"}>
      <PageHero
        slot="banner.gate"
        title={t("Gate & check-in")}
        subtitle={t("Scan a member's code to let them in. Type a phone number only when the code can't be used.")}
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,34rem)_minmax(0,1fr)]">
        <div className="grid content-start gap-4">
          <Card className="grid gap-3">
            <Seg
              value={mode}
              onChange={setMode}
              options={[
                { value: "qr", label: t("Scan code") },
                { value: "manual", label: t("Without a code") },
              ]}
            />
            {mode === "qr" ? (
              <form onSubmit={submitScan} className="grid gap-3">
                <QrScanner onCode={(c) => void send({ kind: "qr", token: tokenFromScan(c) })} hint={t("Hold the member's phone up to the camera.")} />
                <Field tone="muted" label={t("Scanner input")} hint={t("A handheld scanner types here. Focus stays on this box.")}>
                  <Input
                    id="gate-scan"
                    autoFocus
                    value={scan}
                    onChange={(e) => setScan(e.target.value)}
                    placeholder={t("Point the scanner at the member's phone")}
                    autoComplete="off"
                  />
                </Field>
                <div>
                  <Button type="submit" disabled={busy || !scan.trim()}>
                    {busy ? t("Checking…") : t("Check in")}
                  </Button>
                </div>
              </form>
            ) : (
              <form onSubmit={submitManual} className="grid gap-3">
                <Field label={t("Member code or phone")}>
                  <Input
                    id="gate-q"
                    autoFocus
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={t("A3-000123 or 0900 000 000")}
                  />
                </Field>
                <Field tone="muted" label={t("Why not the code?")} hint={t("Recorded with the visit so a manager can review it.")}>
                  <Select value={reason} onChange={(e) => setReason(e.target.value)}>
                    {MANUAL_REASONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {t(r.label)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div>
                  <Button type="submit" disabled={busy || !q.trim()}>
                    {busy ? t("Checking…") : t("Check in")}
                  </Button>
                </div>
              </form>
            )}
            <p className="text-xs text-muted">
              {t("This only records that they walked in. It never uses up a session or changes a plan.")}
            </p>
          </Card>

          <SelfCheckinCode />
        </div>

        <div aria-live="polite" className="grid content-start gap-4">
          {error ? (
            <Card className="border border-danger/30">
              <p className="text-sm text-danger">{error}</p>
            </Card>
          ) : null}
          {result ? (
            // Read from two metres away: lime means in, amber means already in, red means a reason is needed.
            <Card
              className={
                result.needs_override
                  ? "grid gap-3 border-2 border-danger/60"
                  : result.duplicate
                    ? "grid gap-3 border-2 border-hold/60"
                    : "next-free grid gap-3 border-2 border-accent bg-accent text-accent-fg"
              }
            >
              <p
                className={`font-mono text-xs font-semibold uppercase tracking-[0.18em] ${
                  result.needs_override ? "text-danger" : result.duplicate ? "text-hold" : "text-accent-fg/80"
                }`}
              >
                {result.needs_override
                  ? t("Nothing to enter on")
                  : result.duplicate
                    ? t("Already in at {time}", { time: hhmm(result.checked_in_at!) })
                    : t("In at {time}", { time: hhmm(result.checked_in_at!) })}
              </p>
              <div className="flex items-center gap-4">
                <div className="size-14 shrink-0">
                  <UserAvatar name={result.member.full_name} url={result.member.avatar_url} />
                </div>
                <div className="min-w-0">
                  <p className="font-athletic text-3xl leading-none sm:text-4xl">{result.member.full_name}</p>
                  <p
                    className={`mt-1 font-mono text-sm ${
                      result.needs_override || result.duplicate ? "text-muted" : "text-accent-fg/70"
                    }`}
                  >
                    {result.member.member_code}
                  </p>
                </div>
              </div>
              {result.flagged ? <Badge tone="hold">{t("Flagged for the manager")}</Badge> : null}
              {(result.warnings ?? []).map((w) => (
                <p
                  key={w.kind + w.message}
                  className={`rounded-[var(--radius-sm)] px-3 py-2 text-sm font-medium ${
                    result.needs_override || result.duplicate
                      ? "bg-hold/12 text-hold"
                      : "bg-accent-fg/10 text-accent-fg"
                  }`}
                >
                  {tServer(w.message)}
                </p>
              ))}
              {(result.plans ?? []).map((p) => (
                <p key={p.id} className="text-sm">
                  {tData(p.name)}
                  <span className="text-muted">
                    {" "}
                    · {t("until {date}", { date: p.end_on })}
                  </span>
                </p>
              ))}
              {result.today?.sessions?.length || result.today?.bookings?.length ? (
                <div className="text-base font-semibold">
                  <p
                    className={`kicker text-2xs ${
                      result.needs_override || result.duplicate ? "text-muted" : "text-accent-fg/70"
                    }`}
                  >
                    {t("Today")}
                  </p>
                  <ul className="mt-1 grid gap-1">
                    {(result.today?.sessions ?? []).map((s) => (
                      <li key={s.id}>
                        {hhmm(s.start_at)} · {t("{sport} class", { sport: sportLabel(s.sport) })} · {s.court_code}
                      </li>
                    ))}
                    {(result.today?.bookings ?? []).map((b) => (
                      <li key={b.id}>
                        {hhmm(b.start_at)} · {t("court {code}", { code: b.court_code })} <span className="opacity-70">({b.code})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm opacity-70">{t("Nothing booked for today.")}</p>
              )}
              {result.needs_override && pending ? (
                <div className="grid gap-3 rounded-[var(--radius-md)] border border-line p-3">
                  <p className="text-sm">
                    {t("There is no live plan, booking or class for them today. Let them in anyway only with a reason: it is recorded and the manager sees it.")}
                  </p>
                  <Field label={t("Reason")}>
                    <Select value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)}>
                      {OVERRIDE_REASONS.map((r) => (
                        <option key={r.value} value={r.value}>
                          {t(r.label)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className="flex gap-2">
                    <Button disabled={busy} onClick={() => void send(pending, overrideReason)}>
                      {t("Let them in")}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setPending(null);
                        setResult(null);
                      }}
                    >
                      {t("Send to the desk")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </Card>
          ) : !error ? (
            <div className="grid min-h-56 place-content-center gap-2 rounded-[var(--radius-xl)] border-2 border-dashed border-line p-8 text-center">
              <p className="font-athletic text-3xl text-muted">{t("Ready to scan")}</p>
              <p className="text-sm text-muted">{t("The member's name and today's plan show here, large enough to read from the desk.")}</p>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-10">
        <div className="flex items-baseline justify-between gap-2">
          <SectionTitle text={t("Through the gate today")} className="font-display text-2xl" />
          {todayRead.data ? (
            <span className="text-sm tabular-nums text-muted">
              {t("Today's check-ins")}: <span className="font-semibold text-fg">{todayRead.data.total}</span>
            </span>
          ) : null}
        </div>
        <div className="mt-3 grid gap-2">
          {todayRead.error ? (
            <LoadError
              message={todayRead.error.message}
              onRetry={todayRead.error.refused ? undefined : todayRead.reload}
            />
          ) : !today ? (
            <Skeleton className="h-16" />
          ) : !today.length ? (
            <EmptyState
              title={t("Nobody yet today")}
              hint={t("Check-ins appear here as they happen.")}
              action={
                <Button variant="outline" onClick={() => { setMode("manual"); refocus("gate-q"); }}>
                  {t("Check in without code")}
                </Button>
              }
            />
          ) : (
            today.map((row) => (
              <Card key={row.id} className="flex flex-wrap items-center justify-between gap-2 p-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="size-8 shrink-0">
                    <UserAvatar name={row.full_name} url={row.avatar_url} />
                  </div>
                  <p className="font-medium">
                    {row.full_name} <span className="text-xs text-muted">{row.member_code}</span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {row.flagged ? <Badge tone="hold">{t("Flagged")}</Badge> : null}
                  {row.method ? <Badge tone="muted">{METHOD_LABEL[row.method] ? t(METHOD_LABEL[row.method]) : row.method}</Badge> : null}
                  <span className="text-sm tabular-nums text-muted">{hhmm(row.at)}</span>
                </div>
                {row.reason ? (
                  <p className="w-full text-xs text-muted">
                    {t("Reason: {reason}", { reason: reasonLabel(row.reason) })}
                  </p>
                ) : null}
              </Card>
            ))
          )}
        </div>
        <Pagination
          offset={gatePage.offset}
          total={todayRead.data?.total ?? 0}
          pageSize={gatePage.pageSize}
          onChange={gatePage.setOffset}
          onPageSizeChange={gatePage.setPageSize}
          label={t("Check-in pages")}
        />
      </div>
    </Shell>
  );
}

/** The address a member's phone can open: VITE_PUBLIC_URL when set, else this page's own origin. */
function publicOrigin() {
  const env = (import.meta.env.VITE_PUBLIC_URL as string | undefined)?.replace(/\/+$/, "");
  return env || window.location.origin;
}

/** A phone cannot open "localhost": that address points at the phone itself. */
function phoneCannotReach() {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(publicOrigin());
}

/** The 30-second code members scan to check themselves in, when the centre allows it. */
function SelfCheckinCode() {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [img, setImg] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    // Closed: forget the old code, so opening it again never flashes one that has since run out.
    if (!open) {
      setEnabled(null);
      setImg(null);
      setProblem(null);
      return;
    }
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const draw = async () => {
      try {
        const res = await apiGet<{ enabled: boolean; token: string; expires_at: string }>("/desk/checkin-qr");
        if (stop) return;
        if (res.enabled) {
          const url = `${publicOrigin()}/app/pass?d=${encodeURIComponent(res.token)}`;
          const drawn = await QRCode.toDataURL(url, { margin: 1, width: 280, errorCorrectionLevel: "M" });
          if (stop) return;
          setImg(drawn);
        }
        setEnabled(res.enabled);
        setProblem(null);
        const wait = Math.max(5000, new Date(res.expires_at).getTime() - Date.now() - 4000);
        timer = setTimeout(() => void draw(), wait);
      } catch (e) {
        if (stop) return;
        setProblem(readError(e).message);
        timer = setTimeout(() => void draw(), 10000);
      }
    };
    void draw();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [open, round]);

  return (
    <Card className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="font-medium">{t("Self check-in code")}</p>
          <p className="text-xs text-muted">{t("Members scan this screen with their own phone. Changes every 30 seconds.")}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
          {open ? t("Hide") : t("Show")}
        </Button>
      </div>
      {open && problem ? (
        <LoadError
          message={problem}
          onRetry={() => {
            setProblem(null);
            setRound((n) => n + 1);
          }}
        />
      ) : null}
      {open && !problem && enabled === false ? (
        <p className="text-sm text-muted">{t("Self check-in is switched off. A manager can turn it on in Settings.")}</p>
      ) : null}
      {open && !problem && enabled !== false && !img ? <Skeleton className="mx-auto size-56" /> : null}
      {open && !problem && enabled && img && phoneCannotReach() ? (
        <p className="text-xs text-hold">
          {t("This screen is open on localhost, which a phone cannot reach. Open the desk at this computer's network address (for example http://192.168.1.10:8080), or set VITE_PUBLIC_URL.")}
        </p>
      ) : null}
      {open && !problem && enabled && img ? (
        <img src={img} alt={t("Self check-in code")} className="mx-auto size-56 rounded-[var(--radius-md)] bg-white p-2" />
      ) : null}
    </Card>
  );
}
