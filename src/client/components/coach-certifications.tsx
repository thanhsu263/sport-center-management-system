import { useState } from "react";
import { Award, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge, Button, DateField, Field, Input, Modal, Skeleton } from "@/client/components/ui";
import { ApiClientError, apiDelete, apiPost } from "@/client/arena3/client";
import { formatDate } from "@/shared/arena3/labels";
import { t, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";

export type Certification = {
  id: string;
  coach_id: string;
  name: string;
  issuer: string | null;
  issued_on: string | null;
  expires_on: string | null;
  expired?: boolean;
};

/** One line under a certification: who issued it and until when it holds. */
export function certificationLine(c: Certification) {
  const parts: string[] = [];
  if (c.issuer) parts.push(c.issuer);
  if (c.issued_on) parts.push(formatDate(c.issued_on));
  if (c.expires_on) parts.push(t("valid until {date}", { date: formatDate(c.expires_on) }));
  return parts.join(" · ");
}

const EMPTY = { name: "", issuer: "", issued_on: "", expires_on: "" };

/** A coach's certifications: the list, adding one, removing one. For the manager or the coach. */
export function CertificationsModal({
  coachId,
  coachName,
  onClose,
}: {
  coachId: string | null;
  coachName: string;
  onClose: () => void;
}) {
  const read = useRead<{ items: Certification[] }>(coachId ? `/coaches/${coachId}/certifications` : null);
  const [f, setF] = useState(EMPTY);
  const [fe, setFe] = useState<{ field?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!coachId) return;
    setBusy(true);
    setFe(null);
    try {
      await apiPost(`/coaches/${coachId}/certifications`, f);
      setF(EMPTY);
      toast.success(t("Certification added"));
      read.reload();
    } catch (e) {
      setFe({
        field: e instanceof ApiClientError ? e.body.field : undefined,
        message: e instanceof Error ? tServer(e.message) : t("Something went wrong"),
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove(c: Certification) {
    try {
      await apiDelete(`/certifications/${c.id}`);
      toast.success(t("Certification removed"));
      read.reload();
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    }
  }

  const hint = (field: string) => (fe?.field === field ? fe.message : undefined);
  const items = read.data?.items;

  return (
    <Modal
      open={!!coachId}
      onClose={onClose}
      title={t("Certifications · {name}", { name: coachName })}
      footer={
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {t("Done")}
          </Button>
        </div>
      }
    >
      <div className="grid gap-4">
        {read.error ? (
          <p className="text-sm text-danger">{read.error.message}</p>
        ) : !items ? (
          <Skeleton className="h-16" />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted">{t("No certifications yet.")}</p>
        ) : (
          <ul className="grid gap-2">
            {items.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-3 rounded-lg border border-line p-3">
                <div className="flex min-w-0 gap-2.5">
                  <Award className="mt-0.5 size-4 shrink-0 text-accent-2" aria-hidden />
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {c.name}
                      {c.expired ? <Badge tone="danger">{t("Expired")}</Badge> : null}
                    </p>
                    {certificationLine(c) ? <p className="text-xs text-muted">{certificationLine(c)}</p> : null}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("Remove {name}", { name: c.name })}
                  onClick={() => void remove(c)}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-3 border-t border-line pt-4">
          <p className="text-sm font-medium">{t("Add a certification")}</p>
          <Field label={t("Name")} hint={hint("name")}>
            <Input
              value={f.name}
              maxLength={120}
              placeholder={t("e.g. BWF Level 1 Coach")}
              onChange={(e) => setF({ ...f, name: e.target.value })}
            />
          </Field>
          <Field label={t("Issued by")} hint={hint("issuer")}>
            <Input value={f.issuer} maxLength={120} onChange={(e) => setF({ ...f, issuer: e.target.value })} />
          </Field>
          <div className="grid items-start gap-3 sm:grid-cols-2">
            <Field label={t("Issued on")} hint={hint("issued_on")}>
              <DateField value={f.issued_on} onChange={(v) => setF({ ...f, issued_on: v })} invalid={!!hint("issued_on")} />
            </Field>
            <Field label={t("Expires on")} hint={hint("expires_on") ?? t("Leave empty if it does not expire.")} tone={hint("expires_on") ? "danger" : "muted"}>
              <DateField
                value={f.expires_on}
                min={f.issued_on || undefined}
                onChange={(v) => setF({ ...f, expires_on: v })}
                invalid={!!hint("expires_on")}
              />
            </Field>
          </div>
          {fe && !fe.field ? <p className="text-sm text-danger">{fe.message}</p> : null}
          <div className="flex justify-end">
            <Button disabled={busy || !f.name.trim()} onClick={() => void add()}>
              {t("Add")}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
