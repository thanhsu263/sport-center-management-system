import { useState } from "react";
import { Award } from "lucide-react";
import { toast } from "sonner";
import { Badge, Button, ButtonAnchor, Card } from "@/client/components/ui";
import { SectionTitle } from "@/client/components/section";
import { apiPost } from "@/client/arena3/client";
import { formatDate, levelLabel, sportLabel } from "@/shared/arena3/labels";
import { t, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";

type Completion = {
  enrollment_id: string;
  sport: string;
  level: string;
  coach_name: string;
  start_on: string;
  end_on: string;
  sessions: number;
  attended: number;
  remaining: number;
  code: string | null;
  eligible: boolean;
};

/**
 * A member's completion certificates: one per finished class they attended enough of.
 * Classes still running show how far along the member is, so the bar is known before it ends.
 */
export function CertificatesSection() {
  const read = useRead<{ share: number; items: Completion[] }>("/me/certificates");
  const [busy, setBusy] = useState<string | null>(null);
  const items = read.data?.items ?? [];
  if (!items.length) return null;
  const pct = Math.round((read.data?.share ?? 0.8) * 100);

  async function claim(c: Completion) {
    setBusy(c.enrollment_id);
    try {
      const r = await apiPost<{ code: string }>(`/me/certificates/${c.enrollment_id}`);
      toast.success(t("Certificate issued"));
      read.reload();
      window.open(`/verify/${r.code}`, "_blank", "noopener");
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <SectionTitle text={t("Certificates")} className="font-display text-2xl" />
      <p className="mt-1 text-sm text-muted">
        {t("Attend at least {pct}% of a class's sessions to earn its certificate when it ends.", { pct })}
      </p>
      <div className="mt-3 grid gap-2">
        {items.map((c) => {
          const done = c.remaining === 0;
          return (
            <Card key={c.enrollment_id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="flex min-w-0 gap-3">
                <Award className={c.eligible || c.code ? "mt-0.5 size-5 shrink-0 text-accent-2" : "mt-0.5 size-5 shrink-0 text-muted"} aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {sportLabel(c.sport)} · {levelLabel(c.level)}
                  </p>
                  <p className="text-xs text-muted">
                    {formatDate(c.start_on)} – {formatDate(c.end_on)} · {c.coach_name}
                  </p>
                  <p className="mt-1 text-xs tabular-nums text-muted">
                    {t("Attended {a} of {n} sessions", { a: c.attended, n: c.sessions })}
                    {!done ? ` · ${t("{n} still to come", { n: c.remaining })}` : ""}
                  </p>
                </div>
              </div>
              {c.code ? (
                <ButtonAnchor size="sm" variant="outline" href={`/verify/${c.code}`} target="_blank" rel="noopener">
                  {t("View certificate")}
                </ButtonAnchor>
              ) : c.eligible ? (
                <Button size="sm" disabled={busy === c.enrollment_id} onClick={() => void claim(c)}>
                  {t("Get certificate")}
                </Button>
              ) : done ? (
                <Badge tone="muted">{t("Below {pct}% attendance", { pct })}</Badge>
              ) : (
                <Badge tone="muted">{t("Class still running")}</Badge>
              )}
            </Card>
          );
        })}
      </div>
    </section>
  );
}
