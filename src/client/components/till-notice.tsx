import { useEffect, useState } from "react";
import { ButtonLink, Card } from "@/components/ui";
import { apiGet } from "@/lib/arena3/client";
import { t } from "@/lib/i18n";

/**
 * Whether this person can take money right now. A receptionist can only post a payment while their
 * own till shift is open; a manager is never held to that. While the answer is on its way, or if it
 * cannot be read, this says yes: the server enforces the rule either way, and a screen that greys
 * out on a slow network is worse than one that now and then shows the server's refusal.
 */
export function useTillOpen(isReceptionist: boolean): boolean {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (!isReceptionist) return;
    let live = true;
    void apiGet<{ shift: unknown }>("/shifts/current?optional=1", { background: true })
      .then((r) => {
        if (live) setOpen(!!r.shift);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [isReceptionist]);
  return open;
}

/** Why the pay button is off, and the one place that fixes it: the till is opened on the desk home. */
export function TillNotice() {
  return (
    <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 border border-hold/30 bg-hold/5 p-4">
      <p className="text-sm">{t("Open your cash shift first. Payments can’t be taken without one.")}</p>
      <ButtonLink to="/desk" variant="outline" size="sm">
        {t("Open shift at the front desk")}
      </ButtonLink>
    </Card>
  );
}
