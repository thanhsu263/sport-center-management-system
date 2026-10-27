import { createFileRoute } from "@tanstack/react-router";
import { SectionTitle } from "@/components/section";
import { PayOnlineButton } from "@/components/pay-online";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Shell, money, useSessionUser, when } from "@/components/shell";
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  DateField,
  EmptyState,
  Field,
  Input,
  LoadError,
  Modal,
  MoneyInput,
  Select,
  Skeleton,
  StatusBadge,
  Textarea,
} from "@/components/ui";
import { TransferQrModal } from "@/components/transfer-qr-modal";
import { Lift, Reveal, Stagger, StaggerItem } from "@/components/motion";
import { SpotlightCard } from "@/components/fx";
import { CancelBookingDialog } from "@/components/cancel-booking";
import { ApiClientError, apiPatch, apiPost, openInvoice } from "@/lib/arena3/client";
import { METHOD_LABEL, formatDate, refTypeLabel, sportLabel, statusLabel } from "@/lib/arena3/labels";
import { t, tServer, tData } from "@/lib/i18n";
import { useRead } from "@/lib/use-read";

export const Route = createFileRoute("/desk/member/$id")({
  component: Page,
});

type Payment = {
  id: string;
  code: string;
  method: string;
  amount_vnd: number;
  status: string;
  created_at: string;
  ref_type: string;
  invoice_id: string | null;
  /** What is left of this payment after everything already sent back. */
  refundable_vnd: number;
};

/** Digits only, so a typed "1.500.000" or "1,500,000" still means 1500000. */
function parseVnd(raw: string) {
  const digits = raw.replace(/\D/g, "");
  return digits ? Number(digits) : 0;
}

type Member = {
  user: { full_name: string; phone: string; member_code: string | null; date_of_birth: string | null };
  guardian: { name: string | null; phone: string | null };
  subscriptions: Array<{
    id: string;
    status: string;
    plan_name: string;
    end_on: string;
    sport_scope: string;
    court_hours_left: number;
    frozen_days?: number;
    /** What "Take payment" collects, worked out by the server: price less any code on the order. */
    due_vnd: number;
  }>;
  payments: Payment[];
  today: {
    bookings: Array<{ id: string; code: string; start_at: string; status: string; court_code: string; price_vnd: number; paid_vnd: number }>;
    classes: unknown[];
  };
};

function Page() {
  const { id } = Route.useParams();
  const me = useSessionUser();
  // null while it is being asked for, and also if the question failed — `read.error` says which.
  const read = useRead<Member>(`/members/${id}`);
  const data = read.data;
  const reload = read.reload;
  // Leave the online button out when the centre has no payOS keys, rather
  // than offering reception a button that errors in front of a customer.
  const flagsRead = useRead<{ capabilities?: { online_payment?: boolean } }>("/flags");
  const onlineOn = Boolean(flagsRead.data?.capabilities?.online_payment);
  const plansRead = useRead<{ items: Array<{ id: string; name: string; price_vnd: number }> }>("/plans");
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [transferSub, setTransferSub] = useState<Member["subscriptions"][number] | null>(null);
  const [subMethod, setSubMethod] = useState<Record<string, "cash" | "transfer">>({});
  // The payment a refund is being raised against, plus what the desk typed.
  const [refunding, setRefunding] = useState<Payment | null>(null);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refundBusy, setRefundBusy] = useState(false);
  const [refundErr, setRefundErr] = useState("");

  // One desk action at a time. A second tap on "Take payment" or "Check-in" while the first is still
  // being answered would be a double charge or a double check-in waiting to happen.
  const busyRef = useRef(false);
  const [working, setWorking] = useState(false);
  async function act(run: () => Promise<void>, fallback: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setWorking(true);
    try {
      await run();
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : fallback);
    } finally {
      busyRef.current = false;
      setWorking(false);
    }
  }

  // Profile correction (B-11): what the desk has typed, and which input the
  // server said was wrong.
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState({ full_name: "", phone: "", date_of_birth: "", guardian_name: "", guardian_phone: "" });
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState<{ field?: string; message: string } | null>(null);

  // Front-desk password reset: confirm first, then show the temporary password
  // once — it is not stored anywhere the desk can look it up again.
  const [resetStep, setResetStep] = useState<"closed" | "confirm" | "issued">("closed");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetErr, setResetErr] = useState("");
  const [tempPassword, setTempPassword] = useState("");

  function closeReset() {
    setResetStep("closed");
    setResetErr("");
    setTempPassword("");
  }

  async function resetPassword() {
    setResetBusy(true);
    setResetErr("");
    try {
      const r = await apiPost<{ temp_password: string }>(`/members/${id}/reset-password`);
      setTempPassword(r.temp_password);
      setResetStep("issued");
    } catch (e) {
      // Stays on the question, with the reason written under it: a toast would fade while the desk is
      // still looking at a button that appears to have done nothing.
      setResetErr(e instanceof Error ? tServer(e.message) : t("Could not reset the password"));
    } finally {
      setResetBusy(false);
    }
  }

  function openEdit() {
    if (!data) return;
    setEdit({
      full_name: data.user.full_name,
      phone: data.user.phone,
      date_of_birth: data.user.date_of_birth ?? "",
      guardian_name: data.guardian.name ?? "",
      guardian_phone: data.guardian.phone ?? "",
    });
    setEditErr(null);
    setEditing(true);
  }

  async function saveEdit() {
    setEditBusy(true);
    setEditErr(null);
    try {
      await apiPatch(`/members/${id}`, { ...edit, date_of_birth: edit.date_of_birth || null });
      toast.success(t("Profile updated"));
      setEditing(false);
      reload();
    } catch (e) {
      if (e instanceof ApiClientError) setEditErr({ field: e.body.field, message: tServer(e.message) });
      else setEditErr({ message: e instanceof Error ? tServer(e.message) : t("Could not save the profile") });
    } finally {
      setEditBusy(false);
    }
  }

  function openRefund(p: Payment) {
    setRefunding(p);
    // Pre-filled with the whole refundable amount, because a full refund is
    // what nearly every one of these is; a part refund is a deliberate edit.
    setRefundAmount(String(p.refundable_vnd));
    setRefundReason("");
    setRefundErr("");
  }

  async function submitRefund() {
    if (!refunding) return;
    const amount = parseVnd(refundAmount);
    if (amount <= 0 || amount > refunding.refundable_vnd) return;
    setRefundBusy(true);
    setRefundErr("");
    try {
      const res = await apiPost<{ payment: { status: string } }>(
        `/payments/${refunding.id}/refund`,
        { amount_vnd: amount, reason: refundReason.trim() },
        true,
      );
      // Above a receptionist's limit the server parks it instead of paying it.
      // Saying "Refunded" either way would have the desk hand over cash for a
      // refund no manager has signed off yet.
      toast.success(
        res.payment?.status === "refund_pending"
          ? t("Raised: a manager has to sign this off before the money moves")
          : t("Refunded {amount}", { amount: money(amount) }),
      );
      setRefunding(null);
      reload();
    } catch (e) {
      // Written inside the window the desk is looking at, where a toast would fade behind it.
      setRefundErr(e instanceof Error ? tServer(e.message) : t("Could not raise that refund"));
    } finally {
      setRefundBusy(false);
    }
  }

  const role = me?.role === "manager" ? "manager" : "receptionist";

  if (!data) {
    return (
      <Shell role={role} title={t("Member")}>
        {read.error?.refused ? (
          // An old link or a removed member: the server said no, so asking again would only bring the same words back.
          <EmptyState
            title={t("This member could not be opened")}
            hint={t("The link may be old, or the member may have been removed. Search for them again from the desk.")}
          >
            <ButtonLink to="/desk" variant="outline">
              {t("Back to the desk")}
            </ButtonLink>
          </EmptyState>
        ) : read.error ? (
          <LoadError message={read.error.message} onRetry={reload} />
        ) : (
          <Skeleton className="h-40" />
        )}
      </Shell>
    );
  }

  const refundTyped = parseVnd(refundAmount);
  const refundInvalid = !refunding
    ? ""
    : refundTyped <= 0
      ? t("Enter an amount.")
      : refundTyped > refunding.refundable_vnd
        ? t("Only {amount} of this payment is still refundable.", { amount: money(refunding.refundable_vnd) })
        : "";

  return (
    <Shell
      role={role}
      title={data.user.full_name}
      subtitle={[data.user.member_code, data.user.phone].filter(Boolean).join(" · ")}
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button size="sm" variant="outline" onClick={openEdit}>
          {t("Edit profile")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setResetErr("");
            setResetStep("confirm");
          }}
        >
          {t("Reset password")}
        </Button>
      </div>
      <Stagger className="grid gap-3 md:grid-cols-2" gap={0.07}>
        {data.subscriptions.map((s) => (
          <StaggerItem key={s.id} className="h-full">
          <Lift className="h-full">
          <SpotlightCard className="h-full rounded-[var(--radius-xl)]" size={320} strength={0.1}>
          <Card interactive className="relative z-[2] h-full">
            <StatusBadge status={s.status} />
            <h2 className="mt-2 font-display text-2xl">{tData(s.plan_name)}</h2>
            <p className="text-sm text-muted">
              {sportLabel(s.sport_scope)} · {t("through {date}", { date: formatDate(s.end_on) })} · {t("{n} court hours", { n: Number(s.court_hours_left) })}
            </p>
            {(s.status === "pending" || s.status === "active") && s.due_vnd > 0 ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Select
                  className="w-auto"
                  value={subMethod[s.id] ?? "cash"}
                  onChange={(e) => setSubMethod((m) => ({ ...m, [s.id]: e.target.value as "cash" | "transfer" }))}
                  aria-label={t("Payment method")}
                >
                  <option value="cash">{t("Cash")}</option>
                  <option value="transfer">{t("Bank transfer (VietQR)")}</option>
                </Select>
                <Button
                  disabled={working}
                  onClick={() => {
                    if ((subMethod[s.id] ?? "cash") === "transfer") {
                      setTransferSub(s);
                      return;
                    }
                    void act(async () => {
                      const res = await apiPost<{ invoice: { id: string } }>(
                        "/payments",
                        { ref_type: "subscription", ref_id: s.id, method: "cash", amount_vnd: s.due_vnd },
                        true,
                      );
                      toast.success(t("Payment recorded"));
                      reload();
                      if (res.invoice?.id) await openInvoice(res.invoice.id);
                    }, t("Something went wrong"));
                  }}
                >
                  {(subMethod[s.id] ?? "cash") === "transfer"
                    ? t("Show transfer QR · {amount}", { amount: money(s.due_vnd) })
                    : t("Take payment · {amount}", { amount: money(s.due_vnd) })}
                </Button>
                {onlineOn ? (
                  <PayOnlineButton
                    refType="subscription"
                    refId={s.id}
                    label={t("Online link")}
                    size="sm"
                    variant="ghost"
                    onPaid={reload}
                  />
                ) : null}
              </div>
            ) : null}
            {s.status === "active" ? (
              <Button
                className="mt-2"
                variant="outline"
                disabled={working}
                onClick={() =>
                  void act(async () => {
                    await apiPost(`/subscriptions/${s.id}/freeze`, { days: 7 });
                    toast.success(t("Frozen for 7 days: the end date moves out to match"));
                    reload();
                  }, t("Could not freeze the plan"))
                }
              >
                {t("Freeze for 7 days")}
              </Button>
            ) : null}
            {s.status === "frozen" ? (
              <Button
                className="mt-3"
                disabled={working}
                onClick={() =>
                  void act(async () => {
                    await apiPost(`/subscriptions/${s.id}/unfreeze`);
                    toast.success(t("Plan resumed"));
                    reload();
                  }, t("Something went wrong"))
                }
              >
                {t("Resume plan")}
              </Button>
            ) : null}
          </Card>
          </SpotlightCard>
          </Lift>
          </StaggerItem>
        ))}
      </Stagger>

      <SectionTitle text={t("Sell another plan")} className="mt-8 font-display text-2xl" />
      {plansRead.error ? (
        <div className="mt-3">
          <LoadError message={plansRead.error.message} onRetry={plansRead.error.refused ? undefined : plansRead.reload} />
        </div>
      ) : !plansRead.data ? (
        <Skeleton className="mt-3 h-11" />
      ) : plansRead.data.items.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{t("No plans on sale right now")}</p>
      ) : (
        <Reveal className="mt-3 flex flex-wrap gap-2">
          {plansRead.data.items.map((p) => (
            <Button
              key={p.id}
              variant="outline"
              disabled={working}
              onClick={() =>
                void act(async () => {
                  await apiPost("/subscriptions", { plan_id: p.id, user_id: id });
                  toast.success(t("Order created: take payment to activate"));
                  reload();
                }, t("Something went wrong"))
              }
            >
              {tData(p.name)} · {money(p.price_vnd)}
            </Button>
          ))}
        </Reveal>
      )}

      <SectionTitle text={t("Payments")} className="mt-8 font-display text-2xl" />
      <p className="mt-1 text-sm text-muted">
        {t("The last twenty movements on this member’s account. Refunds raised here go straight out if they are within your limit, and to a manager if they are not.")}
      </p>
      <Stagger className="mt-3 grid gap-2" gap={0.04}>
        {data.payments.map((p) => {
          const isRefund = p.amount_vnd < 0;
          return (
            <StaggerItem key={p.id}>
              <Card className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1 basis-56">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium tabular-nums">{money(Math.abs(p.amount_vnd))}</span>
                    {isRefund ? <Badge tone="danger">{t("Refund")}</Badge> : null}
                    {p.status === "refund_pending" ? <Badge tone="hold">{t("Awaiting a manager")}</Badge> : null}
                    {p.status === "refund_rejected" ? <Badge tone="muted">{t("Rejected")}</Badge> : null}
                  </div>
                  <p className="mt-1 break-words text-xs tabular-nums text-subtle">
                    {p.code} · {METHOD_LABEL[p.method] ? t(METHOD_LABEL[p.method]) : p.method} · {refTypeLabel(p.ref_type)} · {when(p.created_at)}
                  </p>
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {p.invoice_id ? (
                    <Button size="sm" variant="ghost" onClick={() => void openInvoice(p.invoice_id!)}>
                      {t("Receipt")}
                    </Button>
                  ) : null}
                  {!isRefund && p.status === "posted" && p.refundable_vnd > 0 ? (
                    <Button size="sm" variant="outline" onClick={() => openRefund(p)}>
                      {t("Refund")}
                    </Button>
                  ) : null}
                </div>
              </Card>
            </StaggerItem>
          );
        })}
        {!data.payments.length ? (
          <p className="text-sm text-muted">{t("Nothing has been taken from this member yet.")}</p>
        ) : null}
      </Stagger>

      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        title={t("Edit profile")}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(false)}>
              {t("Cancel")}
            </Button>
            <Button disabled={editBusy} onClick={() => void saveEdit()}>
              {editBusy ? t("Saving…") : t("Save changes")}
            </Button>
          </div>
        }
      >
        <div className="grid gap-4">
          <Field label={t("Full name")} hint={editErr?.field === "full_name" ? editErr.message : undefined}>
            <Input value={edit.full_name} onChange={(e) => setEdit({ ...edit, full_name: e.target.value })} />
          </Field>
          <Field label={t("Phone")} hint={editErr?.field === "phone" ? editErr.message : undefined}>
            <Input
              inputMode="tel"
              value={edit.phone}
              onChange={(e) => setEdit({ ...edit, phone: e.target.value })}
            />
          </Field>
          <Field label={t("Date of birth")} hint={editErr?.field === "date_of_birth" ? editErr.message : undefined}>
            <DateField
              value={edit.date_of_birth}
              onChange={(v) => setEdit({ ...edit, date_of_birth: v })}
              aria-label={t("Date of birth")}
            />
          </Field>
          <Field label={t("Guardian name")} hint={editErr?.field === "guardian_name" ? editErr.message : undefined}>
            <Input
              value={edit.guardian_name}
              onChange={(e) => setEdit({ ...edit, guardian_name: e.target.value })}
            />
          </Field>
          <Field label={t("Guardian phone")} hint={editErr?.field === "guardian_phone" ? editErr.message : undefined}>
            <Input
              inputMode="tel"
              value={edit.guardian_phone}
              onChange={(e) => setEdit({ ...edit, guardian_phone: e.target.value })}
            />
          </Field>
          {editErr && !["full_name", "phone", "date_of_birth", "guardian_name", "guardian_phone"].includes(editErr.field ?? "") ? (
            <p role="alert" className="text-sm text-danger">
              {editErr.message}
            </p>
          ) : null}
        </div>
      </Modal>

      <Modal
        open={!!refunding}
        onClose={() => setRefunding(null)}
        title={t("Raise a refund")}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRefunding(null)}>
              {t("Cancel")}
            </Button>
            <Button
              disabled={refundBusy || !!refundInvalid}
              onClick={() => void submitRefund()}
            >
              {refundBusy ? t("Working…") : t("Refund {amount}", { amount: money(refundTyped) })}
            </Button>
          </div>
        }
      >
        {refunding ? (
          <div className="grid gap-4">
            <p className="text-sm text-muted">
              {t("Against {code} · {amount} taken by {method} · {time}. {left} of it is still refundable.", {
                code: refunding.code,
                amount: money(Math.abs(refunding.amount_vnd)),
                method: METHOD_LABEL[refunding.method] ? t(METHOD_LABEL[refunding.method]) : refunding.method,
                time: when(refunding.created_at),
                left: money(refunding.refundable_vnd),
              })}
            </p>
            <Field label={t("Amount to refund")} hint={refundInvalid}>
              <MoneyInput
                value={refundAmount}
                onChange={(v) => {
                  setRefundAmount(v);
                  setRefundErr("");
                }}
                aria-label={t("Amount to refund in dong")}
              />
            </Field>
            <Field label={t("Reason")} tone="muted" hint={t("Kept on the audit trail for whoever signs it off.")}>
              <Textarea
                rows={3}
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
                placeholder={t("Court closed for maintenance, member cancelled in time, …")}
              />
            </Field>
            {me?.role !== "manager" ? (
              <p className="text-xs text-muted">
                {t("Above your limit this is parked for a manager instead of paid out. You will be told which happened.")}
              </p>
            ) : null}
            {refundErr ? (
              <p role="alert" className="text-sm text-danger">
                {refundErr}
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <SectionTitle text={t("Today")} className="mt-8 font-display text-2xl" />
      <Stagger className="mt-3 grid gap-2" gap={0.05}>
        {data.today.bookings.map((b) => (
          <StaggerItem key={b.id}>
          <Card className="flex flex-wrap items-center justify-between gap-2 p-4">
            <div>
              <p className="font-medium">
                {b.court_code} · {when(b.start_at)}
              </p>
              <p className="text-xs text-subtle">
                {b.code} · {statusLabel(b.status)}
              </p>
              {(b.status === "confirmed" || b.status === "in_use") && b.price_vnd > b.paid_vnd ? (
                <p className="mt-1 text-xs font-medium text-danger">
                  {t("Balance due at the desk: {amount}", { amount: money(b.price_vnd - b.paid_vnd) })}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
            {(b.status === "confirmed" || b.status === "in_use") && b.price_vnd > b.paid_vnd ? (
              <Button
                variant="outline"
                disabled={working}
                onClick={() =>
                  void act(async () => {
                    await apiPost(`/bookings/${b.id}/collect-balance`, { method: "cash" });
                    toast.success(t("Balance collected"));
                    reload();
                  }, t("Something went wrong"))
                }
              >
                {t("Collect balance (cash)")}
              </Button>
            ) : null}
            {b.status === "confirmed" ? (
              <Button variant="outline" onClick={() => setCancelId(b.id)}>
                {t("Cancel booking")}
              </Button>
            ) : null}
            {b.status === "confirmed" ? (
              <Button
                disabled={working}
                onClick={() =>
                  void act(async () => {
                    await apiPost(`/bookings/${b.id}/check-in`);
                    toast.success(t("Checked in: on court"));
                    reload();
                  }, t("Something went wrong"))
                }
              >
                {t("Check-in")}
              </Button>
            ) : (
              <StatusBadge status={b.status} />
            )}
            </div>
          </Card>
          </StaggerItem>
        ))}
        {!data.today.bookings.length ? (
          <p className="text-sm text-muted">{t("No bookings today.")}</p>
        ) : null}
      </Stagger>
      <CancelBookingDialog
        staff
        bookingId={cancelId}
        open={cancelId !== null}
        onClose={() => setCancelId(null)}
        onDone={() => {
          setCancelId(null);
          reload();
        }}
      />
      <Modal
        open={resetStep !== "closed"}
        onClose={closeReset}
        title={resetStep === "issued" ? t("Hand this over now") : t("Reset this member's password?")}
        footer={
          resetStep === "issued" ? (
            <div className="flex justify-end">
              <Button onClick={closeReset}>{t("Done")}</Button>
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={closeReset}>
                {t("Cancel")}
              </Button>
              <Button disabled={resetBusy} onClick={() => void resetPassword()}>
                {resetBusy ? t("Working…") : t("Reset password")}
              </Button>
            </div>
          )
        }
      >
        {resetStep === "issued" ? (
          <div className="grid gap-3 text-sm">
            <p>
              {t("Password reset. Every open session for this member was signed out, and they must choose a new password when they next sign in. This is shown once.")}
            </p>
            <dl className="grid grid-cols-[6rem_1fr] gap-y-1">
              <dt className="text-muted">{t("Account")}</dt>
              <dd className="font-medium">{data.user.full_name}</dd>
              <dt className="text-muted">{t("Sign in with")}</dt>
              <dd className="tabular-nums">{data.user.phone}</dd>
              <dt className="text-muted">{t("Temporary password")}</dt>
              <dd className="select-all font-mono text-base">{tempPassword}</dd>
            </dl>
          </div>
        ) : (
          <div className="grid gap-3">
            <p className="text-sm text-muted">
              {t("Check the member's identity first. This replaces their password with a temporary one and signs them out everywhere.")}
            </p>
            {resetErr ? (
              <p role="alert" className="text-sm text-danger">
                {resetErr}
              </p>
            ) : null}
          </div>
        )}
      </Modal>

      {transferSub ? (
        <TransferQrModal
          open={!!transferSub}
          onClose={() => setTransferSub(null)}
          amountVnd={transferSub.due_vnd}
          code={transferSub.id.slice(-6).toUpperCase()}
          buyerName={data.user.full_name}
          refType="subscription"
          refId={transferSub.id}
          onConfirmManual={async () => {
            const res = await apiPost<{ invoice: { id: string } }>(
              "/payments",
              { ref_type: "subscription", ref_id: transferSub.id, method: "transfer", amount_vnd: transferSub.due_vnd },
              true,
            );
            toast.success(t("Payment recorded"));
            reload();
            if (res.invoice?.id) await openInvoice(res.invoice.id);
          }}
        />
      ) : null}
    </Shell>
  );
}
