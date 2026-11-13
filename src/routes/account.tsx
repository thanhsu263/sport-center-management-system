import { createFileRoute, useBlocker } from "@tanstack/react-router";
import { Check, Circle, Download, Eye, EyeOff, KeyRound, MonitorSmartphone, Receipt, UserRound } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Guard, Shell, money, useF6, useSessionUser, when } from "@/client/components/shell";
import { Badge, Button, Card, EmptyState, Field, Input, Label, LoadError, Pagination, Seg, Skeleton, Textarea } from "@/client/components/ui";
import { UserAvatar } from "@/client/components/user-avatar";
import { GoogleButton } from "@/client/components/google-sign-in";
import { Lift, Stagger, StaggerItem } from "@/client/components/motion";
import { SpotlightCard, StarBorder } from "@/client/components/fx";
import {
  ApiClientError,
  api,
  apiGet,
  apiPatch,
  apiPost,
  getStoredUser,
  homeFor,
  openInvoice,
  setStoredUser,
  type SessionUser,
} from "@/client/arena3/client";
import { formatDate, roleLabel, sportLabel } from "@/shared/arena3/labels";
import { usePageState } from "@/client/lib/use-page-state";
import { useRead } from "@/client/lib/use-read";
import { cn } from "@/client/lib/cn";
import { t, tk, tServer } from "@/client/lib/i18n";

export const Route = createFileRoute("/account")({ component: Page });

type MeProfile = {
  guardian: { name: string | null; phone: string | null } | null;
  pii_consent_at: string | null;
  coach: { sports: string[]; per_session_vnd: number; per_student_vnd: number } | null;
  other_sessions: number;
};

type Invoice = {
  id: string;
  code: string;
  issued_at: string;
  payment_code: string;
  method: string;
  amount_vnd: number;
  status: string;
  ref_type: string;
};

const METHOD: Record<string, string> = {
  cash: tk("Cash"),
  transfer: tk("Bank transfer"),
  card: tk("Card"),
};

const REF: Record<string, string> = {
  booking: tk("Court booking"),
  subscription: tk("Membership"),
  enrollment: tk("Class"),
  loan: tk("Equipment"),
  walkin: tk("Walk-in"),
};

function Page() {
  const user = useSessionUser();
  const [tab, setTab] = useState(() => (getStoredUser()?.must_change_password ? "security" : "profile"));

  return (
    <Guard roles={["member", "receptionist", "coach", "manager"]}>
      <Shell
        role={user?.role ?? "member"}
        title={t("Account settings")}
        subtitle={
          user?.role === "member" || !user
            ? t("Your details, your password, your receipts, and anything you have asked us.")
            : t("Your details, your password, and anything you have asked us.")
        }
      >
        <div className="mb-5">
          <Seg
            value={tab}
            onChange={setTab}
            options={[
              { value: "profile", label: t("Profile") },
              { value: "security", label: t("Security") },
              // Staff take payments, they do not make them: their receipts are
              // the centre's, and live under Payments (D-04).
              ...(user?.role === "member" || !user ? [{ value: "receipts", label: t("Receipts") }] : []),
              { value: "support", label: t("Support") },
            ]}
          />
        </div>
        {tab === "profile" ? <Profile user={user} /> : null}
        {tab === "security" ? <Security forced={!!user?.must_change_password} /> : null}
        {tab === "receipts" ? <Receipts /> : null}
        {tab === "support" ? <Support /> : null}
      </Shell>
    </Guard>
  );
}

function AvatarEditor({ user }: { user: SessionUser }) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }

    if (file.size > 2 * 1024 * 1024) {
      setError(t("The photo must be 2 MB or smaller."));
      setSelectedFile(null);
      setPreviewUrl(null);
      return;
    }

    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.type)) {
      setError(t("Use a JPEG, PNG or WebP photo."));
      setSelectedFile(null);
      setPreviewUrl(null);
      return;
    }

    setError(null);
    setConfirmRemove(false);
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
  }

  function cancelPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setSelectedFile(null);
    setError(null);
  }

  async function savePhoto() {
    if (!selectedFile) return;
    setError(null);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", selectedFile);
      const res = await api<{ user: SessionUser }>("/me/avatar", { method: "PUT", body: fd });
      setStoredUser(res.user);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setSelectedFile(null);
      toast.success(t("Photo updated."));
    } catch (e) {
      if (e instanceof ApiClientError && e.body?.message) {
        setError(tServer(e.body.message));
      } else if (e instanceof Error) {
        setError(e.message);
      } else {
        setError(t("Could not save your details"));
      }
    } finally {
      setBusy(false);
    }
  }

  async function doRemove() {
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ user: SessionUser }>("/me/avatar", { method: "DELETE" });
      setStoredUser(res.user);
      setConfirmRemove(false);
      toast.success(t("Photo removed."));
    } catch (e) {
      if (e instanceof ApiClientError && e.body?.message) {
        setError(tServer(e.body.message));
      } else if (e instanceof Error) {
        setError(e.message);
      } else {
        setError(t("Could not save your details"));
      }
    } finally {
      setBusy(false);
    }
  }

  const hasAvatar = Boolean(user.avatar_url);

  return (
    <div className="mb-6 grid gap-3 border-b border-line pb-6">
      <div className="flex flex-col gap-1.5">
        <label className="sr-only">
          {t("Profile photo")}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            onChange={onFileChange}
          />
        </label>
        <div className="flex flex-wrap items-center gap-4">
          <div className="relative size-20 shrink-0 overflow-hidden rounded-full bg-accent text-accent-fg shadow-sm">
            {previewUrl ? (
              <img
                src={previewUrl}
                alt={user.full_name}
                className="size-full rounded-full object-cover"
              />
            ) : (
              <UserAvatar
                url={user.avatar_url}
                name={user.full_name}
                className="size-20 bg-accent text-xl font-bold"
                initialsClassName="text-xl font-bold tracking-wide text-accent-fg"
              />
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-display text-xl">{user.full_name}</span>
                <Badge tone="accent">{roleLabel(user.role)}</Badge>
              </div>
              <div className="truncate text-sm text-muted">{user.email ?? user.phone}</div>
            </div>
            {previewUrl ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" type="button" disabled={busy} onClick={savePhoto}>
                  {busy ? t("Saving…") : t("Save photo")}
                </Button>
                <Button size="sm" variant="outline" type="button" disabled={busy} onClick={cancelPreview}>
                  {t("Cancel")}
                </Button>
              </div>
            ) : confirmRemove ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">{t("Remove your photo?")}</span>
                <Button size="sm" variant="danger" type="button" disabled={busy} onClick={doRemove}>
                  {busy ? t("Removing…") : t("Remove photo")}
                </Button>
                <Button size="sm" variant="outline" type="button" disabled={busy} onClick={() => setConfirmRemove(false)}>
                  {t("Cancel")}
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" type="button" onClick={() => fileInputRef.current?.click()}>
                  {t("Change photo")}
                </Button>
                {hasAvatar ? (
                  <Button size="sm" variant="ghost" type="button" onClick={() => setConfirmRemove(true)}>
                    {t("Remove photo")}
                  </Button>
                ) : null}
              </div>
            )}
            <p className="text-xs text-muted">{t("JPEG, PNG or WebP, up to 2 MB.")}</p>
          </div>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Profile({ user }: { user: SessionUser | null }) {
  const profileRead = useRead<MeProfile>("/me/profile");
  const [form, setForm] = useState({ full_name: "", health_notes: "" });
  const [saved, setSaved] = useState({ full_name: "", health_notes: "" });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ full_name?: string; health_notes?: string }>({});

  const isMember = user?.role === "member";
  const dirty =
    form.full_name.trim() !== saved.full_name.trim() ||
    (isMember && form.health_notes.trim() !== saved.health_notes.trim());

  useBlocker({
    shouldBlockFn: () => !busy && dirty && !window.confirm(t("You have unsaved changes. Leave without saving?")),
    enableBeforeUnload: () => dirty,
  });

  // Seed from the cached session the moment it arrives, then let /me correct it
  useEffect(() => {
    if (!user || loaded) return;
    const initial = { full_name: user.full_name, health_notes: user.health_notes ?? "" };
    setForm(initial);
    setSaved(initial);
    setLoaded(true);
  }, [user, loaded]);

  function discard() {
    setForm(saved);
    setError(null);
    setFieldErrors({});
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setBusy(true);
    try {
      const payload: { full_name: string; health_notes?: string } = {
        full_name: form.full_name,
      };
      if (isMember) {
        payload.health_notes = form.health_notes;
      }
      const res = await apiPatch<{ user: SessionUser }>("/me", payload);
      setStoredUser(res.user);
      const next = { full_name: res.user.full_name, health_notes: res.user.health_notes ?? "" };
      setForm(next);
      setSaved(next);
      toast.success(t("Saved."));
    } catch (e) {
      if (e instanceof ApiClientError && e.body?.field) {
        const f = e.body.field as "full_name" | "health_notes";
        const msg = e.body.message ? tServer(e.body.message) : e.message;
        if (f === "full_name" || f === "health_notes") {
          setFieldErrors({ [f]: msg });
          return;
        }
      }
      setError(e instanceof Error ? e.message : t("Could not save your details"));
    } finally {
      setBusy(false);
    }
  }

  if (!user) return <Skeleton className="h-72" />;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <SpotlightCard className="rounded-[var(--radius-xl)]" size={420} strength={0.09}>
        <Card className="relative z-[2] p-6">
          <div className="mb-5 flex items-center gap-2.5">
            <UserRound className="size-4 text-accent" strokeWidth={1.75} />
            <h2 className="font-display text-xl">{t("Your details")}</h2>
          </div>
          <AvatarEditor user={user} />
          <form className="grid gap-6" onSubmit={save}>
            <section className="grid gap-4">
              <Label>{t("Identity")}</Label>
              <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t("Full name")}
              tone={fieldErrors.full_name ? "danger" : undefined}
              hint={fieldErrors.full_name}
            >
              <Input
                required
                maxLength={120}
                value={form.full_name}
                onChange={(e) => {
                  setForm({ ...form, full_name: e.target.value });
                  if (fieldErrors.full_name) setFieldErrors({ ...fieldErrors, full_name: undefined });
                }}
                aria-invalid={fieldErrors.full_name ? true : undefined}
              />
            </Field>
            {user.member_code ? <ReadOnly label={t("Member code")} value={user.member_code} mono /> : null}
            <ReadOnly label={t("Phone")} value={user.phone} />
            <ReadOnly label={t("Email")} value={user.email ?? t("Not set")} />
            <ReadOnly
              label={t("Date of birth")}
              value={user.date_of_birth ? formatDate(user.date_of_birth) : t("Not set")}
            />
              </div>
              <p className="text-xs text-subtle">
                {t("Phone, email and date of birth are changed at the front desk: an OTP or an ID is needed.")}
              </p>
            </section>
            {isMember ? (
              <section className="grid gap-4 border-t border-line pt-6">
                <Label>{t("Health")}</Label>
              <Field
                label={t("Health notes")}
                tone={fieldErrors.health_notes ? "danger" : "muted"}
                hint={
                  fieldErrors.health_notes ??
                  t("Coaches see this before a session: injuries, asthma, anything they should know.")
                }
              >
                <Textarea
                  rows={3}
                  maxLength={1000}
                  value={form.health_notes}
                  placeholder={t("Nothing to declare")}
                  onChange={(e) => {
                    setForm({ ...form, health_notes: e.target.value });
                    if (fieldErrors.health_notes) setFieldErrors({ ...fieldErrors, health_notes: undefined });
                  }}
                  aria-invalid={fieldErrors.health_notes ? true : undefined}
                />
                {form.health_notes.length > 800 ? (
                  <div className="mt-1 text-right text-2xs tabular-nums text-subtle">
                    {form.health_notes.length} / 1000
                  </div>
                ) : null}
              </Field>
              </section>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            <div className="flex items-center gap-3 border-t border-line pt-5">
              <StarBorder speed={4}>
                <Button type="submit" disabled={busy || !dirty || !form.full_name.trim()}>
                  {busy ? t("Saving…") : t("Save changes")}
                </Button>
              </StarBorder>
              {dirty ? (
                <Button variant="ghost" type="button" disabled={busy} onClick={discard}>
                  {t("Discard")}
                </Button>
              ) : null}
            </div>
          </form>
        </Card>
      </SpotlightCard>

      <div className="flex flex-col gap-4">
        <GoogleLink />

        {profileRead.error ? (
          <LoadError
            message={profileRead.error.message}
            onRetry={profileRead.error.refused ? undefined : profileRead.reload}
          />
        ) : !profileRead.data ? (
          user.role === "member" || user.role === "coach" ? <Skeleton className="h-24" /> : null
        ) : (
          <>
            {user.role === "member" && profileRead.data.guardian ? (
              <Card className="h-fit p-6">
                <Label>{t("Guardian")}</Label>
                <dl className="mt-4 grid gap-4">
                  <Row
                    label={t("Name")}
                    value={profileRead.data.guardian.name ?? t("Not set")}
                  />
                  <Row
                    label={t("Phone")}
                    value={profileRead.data.guardian.phone ?? t("Not set")}
                    note={t("The front desk updates it.")}
                  />
                </dl>
                {profileRead.data.pii_consent_at ? (
                  <p className="mt-4 text-xs text-subtle">
                    {t("You agreed to how we use your data on {date}.", {
                      date: formatDate(profileRead.data.pii_consent_at),
                    })}
                  </p>
                ) : null}
              </Card>
            ) : null}

            {user.role === "coach" && profileRead.data.coach ? (
              <Card className="h-fit p-6">
                <Label>{t("Coaching")}</Label>
                <dl className="mt-4 grid gap-4">
                  <Row
                    label={t("Sports")}
                    value={
                      profileRead.data.coach.sports.length > 0
                        ? profileRead.data.coach.sports.map(sportLabel).join(", ")
                        : t("None yet")
                    }
                  />
                  <Row
                    label={t("Per session")}
                    value={money(profileRead.data.coach.per_session_vnd)}
                  />
                  <Row
                    label={t("Per student")}
                    value={money(profileRead.data.coach.per_student_vnd)}
                    note={t("The manager sets these on the Staff screen.")}
                  />
                </dl>
              </Card>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Linking Google is the only way Google sign-in starts working for an account:
 * the sign-in page never creates one, and a matching email alone is not enough.
 */
function GoogleLink() {
  const read = useRead<{ client_id: string | null; google_email: string | null }>("/me/google");
  const [busy, setBusy] = useState(false);
  if (!read.data?.client_id) return null;
  const linked = read.data.google_email;

  async function link(credential: string) {
    setBusy(true);
    try {
      await apiPost("/me/google", { credential });
      toast.success(t("Google is linked. You can now sign in with it."));
      read.reload();
    } catch (err) {
      toast.error(err instanceof Error ? tServer(err.message) : t("Could not link Google"));
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    setBusy(true);
    try {
      await api("/me/google", { method: "DELETE" });
      toast.success(t("Google is unlinked."));
      read.reload();
    } catch (err) {
      toast.error(err instanceof Error ? tServer(err.message) : t("Could not unlink Google"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="h-fit p-6">
      <Label>{t("Sign in with Google")}</Label>
      {linked ? (
        <div className="mt-4 grid gap-3">
          <Row label={t("Linked Google account")} value={linked} note={t("You can sign in with this Google account.")} />
          <div>
            <Button size="sm" variant="outline" type="button" disabled={busy} onClick={unlink}>
              {busy ? t("Unlinking…") : t("Unlink Google")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 grid gap-3">
          <p className="text-sm text-muted">
            {t("Link your Google account to sign in with it next time. Google cannot be used to create an account.")}
          </p>
          <GoogleButton clientId={read.data.client_id} text="signin_with" onCredential={link} />
        </div>
      )}
    </Card>
  );
}

function ReadOnly({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <Field label={label}>
      <Input
        readOnly
        tabIndex={-1}
        value={value}
        className={cn("cursor-default bg-bg text-muted focus:ring-0", mono && "font-mono tracking-wider")}
      />
    </Field>
  );
}

function Row({ label, value, note, mono }: { label: string; value: string; note?: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-2xs text-subtle">{label}</dt>
      <dd className={mono ? "mt-0.5 font-mono text-sm font-semibold tracking-wider" : "mt-0.5 text-sm"}>{value}</dd>
      {note ? <dd className="mt-1 text-xs text-subtle">{note}</dd> : null}
    </div>
  );
}

function Security({ forced }: { forced: boolean }) {
  const profileRead = useRead<MeProfile>("/me/profile");
  const [form, setForm] = useState({ current_password: "", new_password: "", confirm_password: "" });
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field: string | null } | null>(null);
  /** For an input: marked invalid, and tied to the message, when the server named it as the fault. */
  const faulted = (name: string) =>
    error?.field === name ? ({ "aria-invalid": true, "aria-describedby": "password-error" } as const) : {};

  const mismatch = form.confirm_password.length > 0 && form.confirm_password !== form.new_password;
  const tooWeak =
    form.new_password.length > 0 &&
    !(form.new_password.length >= 8 && /[A-Za-z]/.test(form.new_password) && /\d/.test(form.new_password));
  const ready = form.current_password.length > 0 && form.new_password.length > 0 && !mismatch && !tooWeak;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setError(null);
    setBusy(true);
    try {
      const res = await apiPost<{ ok: boolean; signed_out: number }>("/me/password", form);
      setForm({ current_password: "", new_password: "", confirm_password: "" });
      if (res.signed_out > 0) {
        toast.success(t("Password changed. Your other devices were signed out."));
      } else {
        toast.success(t("Password changed."));
      }
      profileRead.reload();
      const u = getStoredUser();
      if (u?.must_change_password) {
        setStoredUser({ ...u, must_change_password: false });
        // Let the menu and guard see the cleared flag.
        window.location.assign(homeFor(u.role));
      }
    } catch (e) {
      // The usual cause is a wrong current password; say so beside the button, where it stays, and
      // mark the box the server named.
      setError({
        message: e instanceof Error ? e.message : t("Could not change your password"),
        field: e instanceof ApiClientError ? (e.body.field ?? null) : null,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <SpotlightCard className="rounded-[var(--radius-xl)]" size={420} strength={0.09}>
        <Card className="relative z-[2] p-6">
          <div className="mb-5 flex items-center gap-2.5">
            <KeyRound className="size-4 text-accent" strokeWidth={1.75} />
            <h2 className="font-display text-xl">{t("Change password")}</h2>
          </div>
          {forced ? (
            <p className="mb-4 rounded-[var(--radius-md)] bg-wood px-3 py-2 text-sm">
              {t(
                "You signed in with a temporary password. Choose your own to continue, and enter the temporary one as the current password.",
              )}
            </p>
          ) : null}
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
            <div className="sm:col-span-2">
            <Field label={t("Current password")}>
              <Input
                required
                type={show ? "text" : "password"}
                autoComplete="current-password"
                value={form.current_password}
                onChange={(e) => setForm({ ...form, current_password: e.target.value })}
                {...faulted("current_password")}
              />
            </Field>
            </div>
            <Field
              label={t("New password")}
              hint={tooWeak ? t("At least 8 characters, with a letter and a number.") : undefined}
            >
              <div className="relative">
                <Input
                  required
                  type={show ? "text" : "password"}
                  autoComplete="new-password"
                  className="pr-12"
                  value={form.new_password}
                  onChange={(e) => setForm({ ...form, new_password: e.target.value })}
                  {...faulted("new_password")}
                  aria-invalid={tooWeak || error?.field === "new_password" ? true : undefined}
                />
                <button
                  type="button"
                  className="absolute right-0 top-0 grid size-11 place-items-center text-muted hover:text-fg"
                  onClick={() => setShow((v) => !v)}
                  aria-label={show ? t("Hide passwords") : t("Show passwords")}
                >
                  {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </Field>
            <Field
              label={t("Confirm new password")}
              hint={mismatch ? t("The two passwords do not match.") : undefined}
            >
              <Input
                required
                type={show ? "text" : "password"}
                autoComplete="new-password"
                value={form.confirm_password}
                onChange={(e) => setForm({ ...form, confirm_password: e.target.value })}
                {...faulted("confirm_password")}
                aria-invalid={mismatch || error?.field === "confirm_password" ? true : undefined}
              />
            </Field>
            <ul className="grid gap-1.5 rounded-[var(--radius-md)] bg-bg/60 p-3 text-xs sm:col-span-2" aria-label={t("Password rules")}>
              {[
                { ok: form.new_password.length >= 8, label: t("At least 8 characters") },
                { ok: /[A-Za-z]/.test(form.new_password), label: t("A letter") },
                { ok: /\d/.test(form.new_password), label: t("A number") },
                {
                  ok: form.confirm_password.length > 0 && form.confirm_password === form.new_password,
                  label: t("Both passwords match"),
                },
              ].map((r) => (
                <li key={r.label} className={cn("flex items-center gap-2", r.ok ? "text-accent" : "text-subtle")}>
                  {r.ok ? <Check className="size-3.5" /> : <Circle className="size-3.5" />}
                  {r.label}
                </li>
              ))}
            </ul>
            {error ? (
              <p id="password-error" role="alert" className="text-sm text-danger sm:col-span-2">
                {error.message}
              </p>
            ) : null}
            <div className="border-t border-line pt-5 sm:col-span-2">
              <Button type="submit" disabled={busy || !ready}>
                {busy ? t("Changing…") : t("Change password")}
              </Button>
            </div>
          </form>
        </Card>
      </SpotlightCard>

      <SignedInDevices
        otherSessions={profileRead.data ? profileRead.data.other_sessions : null}
        loading={!profileRead.data && !profileRead.error}
        onReload={profileRead.reload}
      />
    </div>
  );
}

function SignedInDevices({
  otherSessions,
  loading,
  onReload,
}: {
  otherSessions: number | null;
  loading: boolean;
  onReload: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  async function doSignOutOthers() {
    setSignOutError(null);
    setBusy(true);
    try {
      const res = await apiPost<{ signed_out: number }>("/me/sessions/sign-out-others");
      toast.success(t("Signed out {n} devices.", { n: res.signed_out }));
      setConfirming(false);
      onReload();
    } catch (e) {
      if (e instanceof ApiClientError && e.body?.message) {
        setSignOutError(tServer(e.body.message));
      } else if (e instanceof Error) {
        setSignOutError(e.message);
      } else {
        setSignOutError(t("Something went wrong"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <SpotlightCard className="rounded-[var(--radius-xl)]" size={420} strength={0.09}>
      <Card className="relative z-[2] p-6">
        <div className="mb-5 flex items-center gap-2.5">
          <MonitorSmartphone className="size-4 text-accent" strokeWidth={1.75} />
          <h2 className="font-display text-xl">{t("Signed-in devices")}</h2>
        </div>
        {loading ? (
          <Skeleton className="h-12" />
        ) : otherSessions === null || otherSessions === 0 ? (
          <p className="text-sm text-subtle">{t("Only this device is signed in.")}</p>
        ) : (
          <div className="grid gap-3">
            <p className="text-sm">
              {otherSessions === 1
                ? t("Signed in on 1 other device.")
                : t("Signed in on {n} other devices.", { n: otherSessions })}
            </p>
            {confirming ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-xs text-muted">
                  {t("Sign them out? They will need your password to sign in again.")}
                </span>
                <Button
                  size="sm"
                  variant="danger"
                  type="button"
                  disabled={busy}
                  onClick={doSignOutOthers}
                >
                  {t("Sign out")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(false);
                    setSignOutError(null);
                  }}
                >
                  {t("Cancel")}
                </Button>
              </div>
            ) : (
              <div className="pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => {
                    setConfirming(true);
                    setSignOutError(null);
                  }}
                >
                  {t("Sign out other devices")}
                </Button>
              </div>
            )}
            {signOutError ? (
              <p role="alert" className="text-sm text-danger">
                {signOutError}
              </p>
            ) : null}
          </div>
        )}
      </Card>
    </SpotlightCard>
  );
}

type Ticket = {
  id: string;
  body: string;
  status: string;
  created_at: string;
  reply: string | null;
  replied_at: string | null;
  replied_by_name: string | null;
};

/**
 * Customer care, from the member's side.
 *
 * Until now the only way to reach the desk was to start a message with
 * "ticket:" at the assistant, which opened a row nobody could answer and
 * pointed the member at no screen. Everything else in this app — a booking, a class, a receipt — can
 * be looked up afterwards; a complaint was the one thing you sent into silence.
 */
/**
 * The longest message the desk will take, and where the counter wakes up.
 *
 * The server's own number: `ticketsCreate` slices at 2000, so anything past it
 * was being dropped without a word to the person who typed it.
 */
const TICKET_MAX_CHARS = 2000;
const TICKET_COUNTER_FROM = TICKET_MAX_CHARS - 200;

function Support() {
  // The tab stays whatever the flag says: `GET /tickets/mine` is not gated, so
  // what a member has already asked and been told stays readable (FR-S04).
  // Switching a module off must not take their own history away from them. Only
  // the box that opens a new request goes, because `POST /tickets` now 403s.
  const f6 = useF6();
  const [items, setItems] = useState<Ticket[] | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const { offset, setOffset, pageSize, setPageSize } = usePageState("account.requests", 10);

  async function load() {
    const r = await apiGet<{ items: Ticket[]; total: number }>(`/tickets/mine?limit=${pageSize}&offset=${offset}`);
    setItems(r.items);
    setTotal(r.total);
    setLoadError(null);
  }

  function loadAgain() {
    setLoadError(null);
    void load().catch((e) => setLoadError(e instanceof Error ? e.message : t("Could not load your requests")));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps -- load reads the page it is asked for
  useEffect(loadAgain, [offset, pageSize]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (text.length < 2 || busy) return;
    setError(null);
    setBusy(true);
    try {
      await apiPost("/tickets", { body: text });
      setBody("");
      toast.success(t("Sent to the front desk"));
      // The list is asked for again on its own: if that fails it says so beside the list, and never
      // claims the message was not sent when it was. The new request is at the top of page one.
      if (offset === 0) loadAgain();
      else setOffset(0);
    } catch (e) {
      // The message the person typed stays in the box, and the reason stays on screen beside it.
      setError(e instanceof Error ? e.message : t("Could not send that"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-5">
      {!f6 ? (
        <Card className="p-5">
          <h2 className="font-display text-xl">{t("Ask the front desk")}</h2>
          <p className="mt-1 text-sm text-muted">
            {t("Sending new messages is switched off right now. Ask at reception — anything you sent before is still below.")}
          </p>
        </Card>
      ) : (
      <Card className="p-5">
        <h2 className="font-display text-xl">{t("Ask the front desk")}</h2>
        <p className="mt-1 text-sm text-muted">
          {t(
            "A question, a complaint, something broken on a court. Reception answers during opening hours and the reply shows up here.",
          )}
        </p>
        <form className="mt-3 grid gap-3" onSubmit={send}>
          <Field label={t("Your message")}>
            <Textarea
              rows={3}
              maxLength={TICKET_MAX_CHARS}
              value={body}
              aria-describedby={
                [error ? "support-error" : null, body.length >= TICKET_COUNTER_FROM ? "support-remaining" : null]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              onChange={(e) => setBody(e.target.value.slice(0, TICKET_MAX_CHARS))}
              placeholder={t("The lights over BC2 have been out since Tuesday…")}
            />
          </Field>
          {/* Same manners as the assistant's box: quiet until the limit is
              nearly in reach, then it says how much is left and finally what
              the ceiling actually is. The box used to just stop accepting
              typing with nothing on screen to explain why. */}
          {body.length >= TICKET_COUNTER_FROM ? (
            <p
              id="support-remaining"
              aria-live="polite"
              className={cn(
                "text-2xs tabular-nums",
                body.length >= TICKET_MAX_CHARS ? "text-danger" : "text-muted",
              )}
            >
              {body.length >= TICKET_MAX_CHARS
                ? t("That is the whole {max} characters. Shorten it, or send it in two.", { max: TICKET_MAX_CHARS })
                : t("{n} characters left", { n: TICKET_MAX_CHARS - body.length })}
            </p>
          ) : null}
          {error ? (
            <p id="support-error" role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <div>
            <StarBorder>
              <Button type="submit" disabled={busy || body.trim().length < 2}>
                {busy ? t("Sending…") : t("Send to reception")}
              </Button>
            </StarBorder>
          </div>
        </form>
      </Card>
      )}

      {loadError ? <LoadError message={loadError} onRetry={loadAgain} /> : null}
      {!items ? (
        loadError ? null : <Skeleton className="h-24" />
      ) : items.length === 0 ? (
        // Not while the list could not be refreshed: "nothing asked yet" would be a guess.
        loadError ? null : (
          <EmptyState title={t("Nothing asked yet")} hint={t("Anything you send the desk will be kept here with its reply.")} />
        )
      ) : (
        <Stagger className="grid gap-2.5" gap={0.05}>
          {items.map((tix) => (
            <StaggerItem key={tix.id}>
              <Card className="p-4">
                <div className="flex items-start justify-between gap-3">
                  {/* `break-words` is doing real work: this is text somebody
                      typed, and a long run without a space — a pasted URL, or
                      the "ticket:ticket:ticket:" that older rows still carry —
                      has nothing to wrap on and pushes the badge off the card. */}
                  <p className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm">{tix.body}</p>
                  {/* Three states, read off `status` and not off `reply`
                      alone. The desk can close a request without writing an
                      answer, and judging by `reply` showed those rows as
                      "Waiting" for good — the one thing the member could be
                      sure of was that nobody had got to it yet. */}
                  <Badge
                    tone={tix.reply ? "accent" : tix.status === "closed" ? "muted" : "hold"}
                    className="shrink-0"
                  >
                    {tix.reply ? t("Answered") : tix.status === "closed" ? t("Closed") : t("Waiting")}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted">{when(tix.created_at)}</p>
                {tix.reply ? (
                  /* Indented, tinted and signed at the top so the reply reads as somebody
                     else speaking, not as more of the member's own message. */
                  <div className="mt-3 ml-3 rounded-[var(--radius-md)] bg-accent/5 p-3 ring-1 ring-inset ring-accent/15">
                    <p className="text-2xs font-semibold text-accent-2">
                      {tix.replied_by_name ?? t("Reception")}
                      {tix.replied_at ? <span className="font-normal text-muted"> · {when(tix.replied_at)}</span> : null}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm">{tix.reply}</p>
                  </div>
                ) : null}
              </Card>
            </StaggerItem>
          ))}
        </Stagger>
      )}
      <Pagination
        offset={offset}
        total={total}
        pageSize={pageSize}
        onChange={setOffset}
        onPageSizeChange={setPageSize}
        label={t("Request pages")}
      />
    </div>
  );
}

function Receipts() {
  const [opening, setOpening] = useState<string | null>(null);
  const { offset, setOffset, pageSize, setPageSize } = usePageState("account.receipts", 10);
  // The receipts already on screen stay while another page loads, so paging does not flash empty.
  const read = useRead<{ items: Invoice[]; total: number }>(`/invoices?limit=${pageSize}&offset=${offset}`, {
    keepPrevious: true,
  });
  const items = read.data?.items ?? null;

  if (!items) {
    if (read.error) return <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />;
    return (
      <div className="grid gap-2">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title={t("No receipts yet")}
        hint={t("Every payment you make (court, class or membership) lands here as a PDF you can download.")}
      />
    );
  }

  return (
    <>
      <Stagger className="grid gap-2.5" gap={0.05}>
        {items.map((r) => (
          <StaggerItem key={r.id}>
            <Lift amount={-2}>
              <Card className="flex flex-wrap items-center gap-x-5 gap-y-3 p-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-md)] bg-wood text-muted">
                  <Receipt className="size-4" strokeWidth={1.75} />
                </span>
                <div className="min-w-[8rem] flex-1">
                  <p className="font-mono text-sm font-semibold tracking-wide">{r.code}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {REF[r.ref_type] ? t(REF[r.ref_type]) : r.ref_type} · {when(r.issued_at)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-display text-lg tabular-nums">{money(r.amount_vnd)}</p>
                  <p className="text-2xs text-subtle">{METHOD[r.method] ? t(METHOD[r.method]) : r.method}</p>
                </div>
                {r.status !== "posted" ? <Badge tone="danger">{t("Refunded")}</Badge> : null}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={opening === r.id}
                  onClick={async () => {
                    setOpening(r.id);
                    try {
                      await openInvoice(r.id);
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : t("Could not open that receipt"));
                    } finally {
                      setOpening(null);
                    }
                  }}
                >
                  <Download className="size-3.5" strokeWidth={2} />
                  {opening === r.id ? t("Opening…") : t("PDF")}
                </Button>
              </Card>
            </Lift>
          </StaggerItem>
        ))}
      </Stagger>
      <Pagination
        offset={offset}
        total={read.data?.total ?? 0}
        pageSize={pageSize}
        onChange={setOffset}
        onPageSizeChange={setPageSize}
        label={t("Receipt pages")}
      />
    </>
  );
}
