import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Copy, Upload } from "lucide-react";
import { toast } from "sonner";
import { Shell, initials, when } from "@/components/shell";
import { Cover } from "@/components/media";
import { PageHero } from "@/components/page-hero";
import { StatStrip } from "@/components/stat-strip";
import { RowActions } from "@/components/row-actions";
import { SportBadge, useSports } from "@/components/sports-ui";
import { Badge, Button, Card, EmptyState, Field, Input, LoadError, Modal, Select, Skeleton, Pagination } from "@/components/ui";
import { ApiClientError, apiPost, apiPatch } from "@/lib/arena3/client";
import { roleLabel, sportLabel } from "@/lib/arena3/labels";
import { cn } from "@/lib/cn";
import { t, tServer, tData } from "@/lib/i18n";
import { usePageState } from "@/lib/use-page-state";
import { useRead } from "@/lib/use-read";

export const Route = createFileRoute("/manager/staff")({ component: Page });

type Staff = {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  role: string;
  status: string;
  must_change_password: boolean;
  created_at: string;
  sports: string[] | null;
  open_sessions: number;
  issued_by: string | null;
  issued_at: string | null;
};

type Issued = { name: string; phone: string; password: string; why: string };

function Page() {
  const searchParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const initialCreating = searchParams?.get("create") === "1" || searchParams?.get("create") === "true";
  const initialRole = searchParams?.get("role") || "receptionist";
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(initialCreating);
  const [createRole] = useState(initialRole);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [editing, setEditing] = useState<Staff | null>(null);

  // Typing waits a beat so one search is one request.
  const [term, setTerm] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const qs = new URLSearchParams();
  if (role) qs.set("role", role);
  if (status) qs.set("status", status);
  if (term) qs.set("q", term);
  const filtered = !!(role || status || term);
  const { offset, setOffset, pageSize, setPageSize, reset } = usePageState("manager.staff", 25);
  useEffect(reset, [role, status, term, reset]);
  qs.set("limit", String(pageSize));
  qs.set("offset", String(offset));
  // The list on screen stays (dimmed) while a new filter loads; a failed read replaces it with the reason.
  const read = useRead<{ items: Staff[]; total: number }>(`/staff?${qs}`, { keepPrevious: true });
  const items = read.data?.items ?? null;
  const allStaffRead = useRead<{ items: Staff[] }>("/staff?limit=100");
  const allStaff = allStaffRead.data?.items ?? [];

  const roleCounts = {
    "": allStaff.length,
    receptionist: allStaff.filter((s) => s.role === "receptionist").length,
    coach: allStaff.filter((s) => s.role === "coach").length,
    manager: allStaff.filter((s) => s.role === "manager").length,
  };

  const ROLES = [
    { value: "", label: t("All roles"), count: roleCounts[""] },
    { value: "receptionist", label: t("Receptionist"), count: roleCounts.receptionist },
    { value: "coach", label: t("Coach"), count: roleCounts.coach },
    { value: "manager", label: t("Manager"), count: roleCounts.manager },
  ];

  const statItems = [
    { label: t("Total coaches"), value: roleCounts.coach },
    { label: t("Total receptionists"), value: roleCounts.receptionist },
    { label: t("Must change password"), value: allStaff.filter((s) => s.must_change_password).length },
    { label: t("Open sessions"), value: allStaff.reduce((sum, s) => sum + s.open_sessions, 0) },
  ];

  async function act(s: Staff, what: "lock" | "unlock" | "reset" | "revoke") {
    try {
      if (what === "lock" || what === "unlock") {
        await apiPatch(`/staff/${s.id}`, { status: what === "lock" ? "locked" : "active" });
        toast.success(
          what === "lock"
            ? t("{name} is locked out", { name: s.full_name })
            : t("{name} can sign in again", { name: s.full_name }),
        );
      } else if (what === "reset") {
        const r = await apiPost<{ temp_password: string }>(`/staff/${s.id}/reset-password`);
        setIssued({
          name: s.full_name,
          phone: s.phone,
          password: r.temp_password,
          why: t("Password reset. Every open session for this account was signed out."),
        });
      } else {
        const r = await apiPost<{ revoked: number }>(`/staff/${s.id}/revoke-sessions`);
        toast.success(
          r.revoked
            ? t("Signed {name} out of {n} session(s)", { name: s.full_name, n: r.revoked })
            : t("No open sessions"),
        );
      }
      read.reload();
      allStaffRead.reload();
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    }
  }

  return (
    <Shell role="manager">
      <PageHero
        slot="banner.manager"
        title={t("Staff")}
        subtitle={t("Receptionist and coach logins are issued here and nowhere else. Members sign themselves up.")}
      />
      <StatStrip className="mb-6" items={statItems} />
      <div className="mb-4 flex flex-wrap gap-2">
        {ROLES.map((r) => (
          <button
            key={r.value}
            type="button"
            onClick={() => setRole(r.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
              role === r.value
                ? "bg-accent text-accent-fg shadow-[var(--shadow-accent)]"
                : "border border-line bg-surface text-muted hover:bg-wood hover:text-fg",
            )}
          >
            <span>{r.label}</span>
            <span
              className={cn(
                "rounded-full px-1.5 py-0.2 text-2xs font-semibold tabular-nums",
                role === r.value ? "bg-accent-fg/20 text-accent-fg" : "bg-wood text-muted",
              )}
            >
              {r.count}
            </span>
          </button>
        ))}
      </div>
      <Card className="mb-4 grid gap-3 md:grid-cols-[1.8fr_1fr_auto]">
        <Input aria-label={t("Search staff")} placeholder={t("Search name, phone or email")} value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label={t("Status")} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t("Any status")}</option>
          <option value="active">{t("Active")}</option>
          <option value="locked">{t("Locked")}</option>
        </Select>
        <Button onClick={() => setCreating(true)}>{t("Add staff")}</Button>
      </Card>

      <div aria-busy={read.stale} className={cn("transition-opacity", read.stale && "opacity-60")}>
      {read.error ? (
        <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />
      ) : !items ? (
        <Skeleton className="h-40" />
      ) : !items.length ? (
        <EmptyState
          title={filtered ? t("Nobody matches those filters") : t("No staff accounts yet")}
          hint={filtered ? t("Clear a filter to see everyone.") : t("Add the first receptionist or coach to give them a login.")}
        >
          {!filtered ? <Button onClick={() => setCreating(true)}>{t("Add staff")}</Button> : null}
        </EmptyState>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {items.map((s) => {
            const managed = s.role === "receptionist" || s.role === "coach";
            return (
              <Card key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="flex items-center gap-3.5 min-w-0">
                  {s.role === "coach" ? (
                    <Cover
                      slot={"coach." + s.id}
                      fallbackInitials={initials(s.full_name)}
                      className="size-14 shrink-0 rounded-full border border-line"
                      initialsClassName="text-base font-bold"
                    />
                  ) : (
                    <div className="grid size-14 shrink-0 place-items-center rounded-full border border-line bg-wood text-base font-bold text-fg">
                      {initials(s.full_name)}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {tData(s.full_name)}
                      <Badge tone={s.role === "manager" ? "ink" : "accent"}>{roleLabel(s.role)}</Badge>
                      {s.status !== "active" ? <Badge tone="danger">{t("Locked")}</Badge> : null}
                      {s.must_change_password ? <Badge tone="hold">{t("Must change password")}</Badge> : null}
                    </p>
                    <p className="text-sm tabular-nums text-muted">
                      {s.phone}
                      {s.email ? ` · ${s.email}` : ""}
                    </p>
                    {s.role === "coach" && s.sports?.length ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {s.sports.map((sp) => (
                          <SportBadge key={sp} sport={sp} className="text-xs" />
                        ))}
                      </div>
                    ) : null}
                    <p className="mt-1 text-xs text-muted">
                      {s.issued_at
                        ? t("Issued by {name} · {when}", { name: s.issued_by ?? "-", when: when(s.issued_at) })
                        : t("Seeded account")}{" "}
                      · {s.open_sessions === 1 ? t("1 open session") : t("{n} open sessions", { n: s.open_sessions })}
                    </p>
                  </div>
                </div>
                {managed ? (
                  <RowActions
                    primary={{
                      label: t("Role"),
                      onClick: () => setEditing(s),
                    }}
                    secondary={[
                      {
                        label: t("Reset password"),
                        onClick: () => void act(s, "reset"),
                      },
                      {
                        label: t("Sign out everywhere"),
                        disabled: !s.open_sessions,
                        onClick: () => void act(s, "revoke"),
                      },
                      s.status === "active"
                        ? {
                            label: t("Lock"),
                            danger: true,
                            confirm: t("Are you sure you want to lock this account?"),
                            onClick: () => void act(s, "lock"),
                          }
                        : {
                            label: t("Unlock"),
                            onClick: () => void act(s, "unlock"),
                          },
                    ]}
                  />
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
      <Pagination
        offset={offset}
        total={read.data?.total ?? 0}
        pageSize={pageSize}
        onChange={setOffset}
        onPageSizeChange={setPageSize}
        label={t("Staff pages")}
      />
      </div>

      <CreateModal
        open={creating}
        defaultRole={createRole}
        onClose={() => setCreating(false)}
        onDone={(i) => {
          setCreating(false);
          setIssued(i);
          read.reload();
        }}
      />
      <RoleModal
        staff={editing}
        onClose={() => setEditing(null)}
        onDone={() => {
          setEditing(null);
          read.reload();
        }}
      />
      <Modal
        open={!!issued}
        onClose={() => setIssued(null)}
        title={t("Hand this over now")}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                if (issued) {
                  navigator.clipboard.writeText(issued.password);
                  toast.success(t("Copied to clipboard"));
                }
              }}
            >
              <Copy className="mr-1.5 size-4" />
              {t("Copy")}
            </Button>
            <Button onClick={() => setIssued(null)}>{t("Done")}</Button>
          </div>
        }
      >
        {issued ? (
          <div className="grid gap-3 text-sm">
            <p>{issued.why}</p>
            <dl className="grid grid-cols-[6rem_1fr] items-center gap-y-2">
              <dt className="text-muted">{t("Account")}</dt>
              <dd className="font-medium">{issued.name}</dd>
              <dt className="text-muted">{t("Sign in with")}</dt>
              <dd className="tabular-nums">{issued.phone}</dd>
              <dt className="text-muted">{t("Temporary password")}</dt>
              <dd className="flex items-center gap-2">
                <span className="select-all rounded-[var(--radius-sm)] border border-line bg-wood px-2 py-1 font-mono text-base font-semibold">
                  {issued.password}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    navigator.clipboard.writeText(issued.password);
                    toast.success(t("Copied to clipboard"));
                  }}
                  title={t("Copy")}
                >
                  <Copy className="size-4" />
                </Button>
              </dd>
            </dl>
            <p className="text-xs text-muted">
              {t("This is the only time it is shown. They will be asked to choose their own at first sign-in.")}
            </p>
          </div>
        ) : null}
      </Modal>
    </Shell>
  );
}

function SportPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { sports } = useSports();
  const allChoices = [...sports.map((s) => s.code), "all"];
  return (
    <div className="flex flex-wrap gap-2">
      {allChoices.map((s) => {
        const on = value.includes(s);
        return (
          <button
            key={s}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== s) : [...value, s])}
            className={`rounded-full px-3 py-1 text-sm ${on ? "bg-accent text-accent-fg" : "bg-wood text-muted"}`}
          >
            {s === "all" ? t("Any sport") : sportLabel(s)}
          </button>
        );
      })}
    </div>
  );
}

function CreateModal({
  open,
  defaultRole = "receptionist",
  onClose,
  onDone,
}: {
  open: boolean;
  defaultRole?: string;
  onClose: () => void;
  onDone: (i: Issued) => void;
}) {
  const [f, setF] = useState({ full_name: "", phone: "", email: "", role: defaultRole });
  const [sports, setSports] = useState<string[]>([]);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fe, setFe] = useState<{ field: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const bad = (field: string) => (fe?.field === field ? fe.message : undefined);

  useEffect(() => {
    if (open) {
      setF({ full_name: "", phone: "", email: "", role: defaultRole });
      setSports([]);
      setAvatarFile(null);
      setAvatarPreview(null);
      setFe(null);
    }
  }, [open, defaultRole]);

  async function submit() {
    setFe(null);
    setBusy(true);
    try {
      const r = await apiPost<{ staff: Staff; temp_password: string }>("/staff", {
        ...f,
        email: f.email || undefined,
        sports: f.role === "coach" ? sports : undefined,
      });
      if (avatarFile && f.role === "coach") {
        const fd = new FormData();
        fd.append("slot", `coach.${r.staff.id}`);
        fd.append("file", avatarFile);
        try {
          await apiPost("/manager/site-assets/upload", fd);
        } catch {
          toast.error(t("Staff created, but avatar upload failed"));
        }
      }
      setF({ full_name: "", phone: "", email: "", role: "receptionist" });
      setSports([]);
      setAvatarFile(null);
      setAvatarPreview(null);
      onDone({
        name: r.staff.full_name,
        phone: r.staff.phone,
        password: r.temp_password,
        why: t("{role} account created.", { role: roleLabel(r.staff.role) }),
      });
    } catch (e) {
      if (e instanceof ApiClientError && (e.body?.field || e.body?.br === "BR-01")) {
        setFe({ field: (e.body?.field as string) || "phone", message: tServer(e.message) });
      } else {
        toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("Add staff")}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {t("Create account")}
          </Button>
        </div>
      }
    >
      <div className="grid gap-3">
        <Field label={t("Role")}>
          <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="receptionist">{t("Receptionist")}</option>
            <option value="coach">{t("Coach")}</option>
          </Select>
        </Field>
        <Field label={t("Full name")} hint={bad("full_name")}>
          <Input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} />
        </Field>
        <Field label={t("Phone")} hint={bad("phone")}>
          <Input inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </Field>
        <Field label={t("Email (optional)")} hint={bad("email")}>
          <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        {f.role === "coach" ? (
          <>
            <Field label={t("Sports they teach")} hint={bad("sports")}>
              <SportPicker value={sports} onChange={setSports} />
            </Field>
            <Field label={t("Avatar")}>
              <div className="flex items-center gap-4">
                <div className="relative size-16 shrink-0 overflow-hidden rounded-full border border-line bg-wood flex items-center justify-center">
                  {avatarPreview ? (
                    <img src={avatarPreview} alt={t("Avatar")} className="size-full object-cover" />
                  ) : (
                    <span className="font-display font-bold text-muted text-sm">
                      {initials(f.full_name) || "HLV"}
                    </span>
                  )}
                </div>
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        setAvatarFile(file);
                        setAvatarPreview(URL.createObjectURL(file));
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="mr-1.5 size-4" />
                    {avatarFile ? t("Change photo") : t("Upload avatar")}
                  </Button>
                  <p className="mt-1 text-2xs text-muted">JPEG, PNG, WebP &lt; 2MB</p>
                </div>
              </div>
            </Field>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

function RoleModal({ staff, onClose, onDone }: { staff: Staff | null; onClose: () => void; onDone: () => void }) {
  const [role, setRole] = useState("receptionist");
  const [sports, setSports] = useState<string[]>([]);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fe, setFe] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (staff) {
      setRole(staff.role);
      setSports(staff.sports ?? []);
      setAvatarFile(null);
      setAvatarPreview(null);
      setFe(null);
    }
  }, [staff]);

  async function save() {
    if (!staff) return;
    setBusy(true);
    try {
      await apiPatch(`/staff/${staff.id}`, { role, sports: role === "coach" ? sports : undefined });
      if (avatarFile && role === "coach") {
        const fd = new FormData();
        fd.append("slot", `coach.${staff.id}`);
        fd.append("file", avatarFile);
        try {
          await apiPost("/manager/site-assets/upload", fd);
        } catch {
          toast.error(t("Staff updated, but avatar upload failed"));
        }
      }
      toast.success(t("{name} is now {role}. They were signed out.", { name: staff.full_name, role: roleLabel(role).toLowerCase() }));
      onDone();
    } catch (e) {
      setFe(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!staff}
      onClose={onClose}
      title={staff ? t("Role · {name}", { name: staff.full_name }) : t("Role")}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button disabled={busy} onClick={() => void save()}>{t("Save")}</Button>
        </div>
      }
    >
      <div className="grid gap-3">
        <Field label={t("Role")}>
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="receptionist">{t("Receptionist")}</option>
            <option value="coach">{t("Coach")}</option>
          </Select>
        </Field>
        {role === "coach" ? (
          <>
            <Field label={t("Sports they teach")}>
              <SportPicker value={sports} onChange={setSports} />
            </Field>
            {staff ? (
              <Field label={t("Avatar")}>
                <div className="flex items-center gap-4">
                  <div className="relative size-16 shrink-0 overflow-hidden rounded-full border border-line bg-wood flex items-center justify-center">
                    {avatarPreview ? (
                      <img src={avatarPreview} alt={t("Avatar")} className="size-full object-cover" />
                    ) : (
                      <Cover
                        slot={"coach." + staff.id}
                        fallbackInitials={initials(staff.full_name)}
                        className="size-full"
                        initialsClassName="text-sm font-bold"
                      />
                    )}
                  </div>
                  <div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          setAvatarFile(file);
                          setAvatarPreview(URL.createObjectURL(file));
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="mr-1.5 size-4" />
                      {avatarFile ? t("Change photo") : t("Upload avatar")}
                    </Button>
                    <p className="mt-1 text-2xs text-muted">JPEG, PNG, WebP &lt; 2MB</p>
                  </div>
                </div>
              </Field>
            ) : null}
          </>
        ) : null}
        {fe ? <p className="text-sm text-danger">{fe}</p> : null}
        <p className="text-xs text-muted">{t("Changing the role signs them out so the new permissions apply at the next sign-in.")}</p>
      </div>
    </Modal>
  );
}
