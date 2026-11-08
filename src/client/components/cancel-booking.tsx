import { useEffect, useState } from "react";
import { toast } from "sonner";
import { money } from "@/components/shell";
import { Badge, Button, Check, LoadError, Modal, Skeleton } from "@/components/ui";
import { apiGet, apiPost } from "@/lib/arena3/client";
import { cn } from "@/lib/cn";
import { t, tServer } from "@/lib/i18n";
import { readError, type ReadError } from "@/lib/use-read";

type Quote = {
  hours_left: number;
  refund_pct: number;
  paid_vnd: number;
  refund_vnd: number;
  fee_vnd: number;
  waived: boolean;
  tiers: { hours: number; refund_pct: number }[];
  quota_hours: number;
};

/**
 * Cancel a court booking, with the price of doing it said out loud first.
 *
 * The refund depends on how close the start is (the centre's own tiers), so the
 * quote is read from the server before the button is pressed — the member never
 * finds the fee out afterwards. Staff get a "waive the fee" tick for the cases
 * that are not the customer's doing (centre closed, flood, accident).
 */
export function CancelBookingDialog({
  bookingId,
  open,
  onClose,
  onDone,
  staff = false,
}: {
  bookingId: string | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  staff?: boolean;
}) {
  // A quote is only good for the booking and the tick it was asked for; it stays on screen while the next one is on its way.
  const [asked, setAsked] = useState<{ booking: string; waive: boolean; quote: Quote } | null>(null);
  const [failure, setFailure] = useState<ReadError | null>(null);
  const [waive, setWaive] = useState(false);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);

  // Opening again starts from nothing: no old figures, no old tick.
  useEffect(() => {
    if (open) return;
    setAsked(null);
    setFailure(null);
    setWaive(false);
  }, [open]);

  // Re-quotes when staff tick the waiver, so the figures on screen are the ones that will apply.
  useEffect(() => {
    if (!open || !bookingId) return;
    let live = true;
    setFailure(null);
    apiGet<Quote>(`/bookings/${bookingId}/cancel-quote${staff ? `?waive=${waive ? 1 : 0}` : ""}`).then(
      (quote) => {
        if (live) setAsked({ booking: bookingId, waive, quote });
      },
      (e: unknown) => {
        if (live) setFailure(readError(e));
      },
    );
    return () => {
      live = false;
    };
  }, [open, bookingId, staff, waive, round]);

  const current = asked && asked.booking === bookingId ? asked : null;
  const quote = current?.quote ?? null;
  // Cancelling is only offered against figures that match what is ticked right now.
  const fresh = current !== null && current.waive === waive && !failure;
  const retry = failure && !failure.refused ? () => setRound((n) => n + 1) : undefined;

  async function go() {
    if (!bookingId) return;
    setBusy(true);
    try {
      await apiPost(`/bookings/${bookingId}/cancel`, staff ? { waive } : {});
      toast.success(t("Booking cancelled"));
      onDone();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      setBusy(false);
    }
  }

  const tiers = quote ? [...quote.tiers].sort((a, b) => b.hours - a.hours) : [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("Cancel this booking?")}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("Keep it")}
          </Button>
          <Button onClick={() => void go()} disabled={busy || !fresh}>
            {busy ? t("Cancelling…") : t("Yes, cancel")}
          </Button>
        </>
      }
    >
      {!quote ? (
        failure ? (
          <LoadError message={failure.message} onRetry={retry} />
        ) : (
          <Skeleton className="h-28" />
        )
      ) : (
        <div className="grid gap-3 text-sm">
          {failure ? <LoadError message={failure.message} onRetry={retry} /> : null}
          <div
            aria-busy={!fresh && !failure}
            className={cn("grid gap-3 transition-opacity duration-150", !fresh && "opacity-60")}
          >
            {quote.paid_vnd === 0 ? (
              <p>{t("Nothing has been paid on this booking, so nothing is charged.")}</p>
            ) : quote.quota_hours > 0 ? (
              <p>
                {quote.refund_pct >= 50
                  ? t("Your plan hour goes back to your balance.")
                  : t("Too close to the start: the plan hour is not given back.")}
              </p>
            ) : (
              <>
                <p>
                  {t("Starts in {h} hours. You paid {paid}.", {
                    h: String(Math.max(0, Math.floor(quote.hours_left))),
                    paid: money(quote.paid_vnd),
                  })}
                </p>
                <div className="rounded-[var(--radius-md)] bg-wood/60 p-3">
                  <div className="flex items-center justify-between">
                    <span>{t("Refund")}</span>
                    <span className="font-display text-xl tabular-nums">{money(quote.refund_vnd)}</span>
                  </div>
                  {quote.fee_vnd > 0 ? (
                    <div className="mt-1 flex items-center justify-between text-danger">
                      <span>{t("Late-cancel fee kept")}</span>
                      <span className="tabular-nums">{money(quote.fee_vnd)}</span>
                    </div>
                  ) : null}
                  {quote.waived ? <Badge tone="accent" className="mt-2">{t("Fee waived")}</Badge> : null}
                </div>
              </>
            )}
            <ul className="grid gap-1 text-xs text-muted">
              {tiers.map((tier) => (
                <li key={tier.hours} className="flex justify-between gap-3">
                  <span>{tier.hours > 0 ? t("{n}h or more before start", { n: tier.hours }) : t("Any later than that")}</span>
                  <span className="tabular-nums">{t("{pct}% back", { pct: tier.refund_pct })}</span>
                </li>
              ))}
            </ul>
          </div>
          {staff ? (
            <Check
              checked={waive}
              onChange={(e) => setWaive(e.target.checked)}
              label={t("Waive the fee")}
              hint={t("For cancellations that are not the customer's doing: centre closed, flood, accident.")}
            />
          ) : null}
        </div>
      )}
    </Modal>
  );
}
