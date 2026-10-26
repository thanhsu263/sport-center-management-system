import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { toast } from "sonner";
import { Button, Modal } from "./ui";
import { money } from "./shell";
import { apiPost } from "@/lib/arena3/client";
import { t, tServer } from "@/lib/i18n";
import { useLive } from "@/lib/use-live";

/**
 * Take an online payment through payOS.
 *
 * Built for the counter first, because that is how this centre actually works:
 * the customer is standing at the desk, reception raises the link, and the
 * customer scans the QR off reception's screen with their banking app. The same
 * component serves a member paying on their own phone — there the QR is beside
 * the point, so a "Open payment page" button is offered as well.
 *
 * Nothing here decides that money arrived. The dialog polls
 * `/payments/online/:id/verify`, which asks payOS, and only payOS's answer
 * posts the payment. Reception has no "received" button to press and no way to
 * mark this paid by hand — that is the whole difference between this and the
 * cash button beside it.
 */

type Raised = {
  payment_id: string;
  payment_code: string;
  order_code: number;
  amount_vnd: number;
  checkout_url: string;
  qr_code: string;
  expires_at: number | null;
  /** "desk" when reception raised it, "member" when the payer did. */
  raised_by?: "desk" | "member";
};

type Phase = "idle" | "raising" | "waiting" | "paid" | "failed";

/** How often to ask payOS. Fast enough to feel live at a counter queue. */
const POLL_MS = 3000;

export function PayOnlineButton({
  refType,
  refId,
  label,
  size = "sm",
  variant = "outline",
  onPaid,
}: {
  refType: "booking" | "subscription";
  refId: string;
  label?: string;
  size?: "sm" | "md";
  variant?: "primary" | "outline" | "ghost";
  /** Called once, after payOS confirms. Refresh the list from here. */
  onPaid?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [raised, setRaised] = useState<Raised | null>(null);
  const [qrPng, setQrPng] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (timer.current !== null) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  async function raise() {
    setPhase("raising");
    setNote(null);
    try {
      const res = await apiPost<Raised>("/payments/online", { ref_type: refType, ref_id: refId }, true);
      setRaised(res);
      // payOS hands back a VietQR payload string, not a picture. Rendering it
      // here keeps the payload out of the API response and off the network a
      // second time.
      if (res.qr_code) {
        setQrPng(
          await QRCode.toDataURL(res.qr_code, {
            width: 512,
            margin: 1,
            errorCorrectionLevel: "M",
            color: { dark: "#141c12", light: "#fffaf2" },
          }),
        );
      }
      setPhase("waiting");
    } catch (e) {
      setPhase("idle");
      toast.error(e instanceof Error ? tServer(e.message) : t("Could not start the payment"));
    }
  }

  // Verify with payOS and update status
  const checkPayment = useCallback(async () => {
    if (!raised) return;
    try {
      const r = await apiPost<{ status: string; detail?: string }>(
        `/payments/online/${raised.payment_id}/verify`,
      );
      if (r.status === "posted") {
        stopPolling();
        setPhase("paid");
        onPaid?.();
      } else if (r.status === "expired" || r.status === "failed") {
        stopPolling();
        setPhase("failed");
        setNote(r.status === "expired" ? t("The link expired.") : t("The customer cancelled."));
      } else if (r.status === "underpaid") {
        setNote(t("Not the full amount yet: {detail}", { detail: tServer(r.detail ?? "") }));
      }
    } catch {
      // A poll that fails is not a payment that failed; keep asking.
    }
  }, [raised, onPaid, stopPolling]);

  // Realtime SSE push triggers immediate verification
  useLive(phase === "waiting" && raised ? `payment:${raised.payment_id}` : null, () => {
    void checkPayment();
  });

  // Poll as fallback while the dialog is open and unpaid.
  useEffect(() => {
    if (phase !== "waiting" || !raised) return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      await checkPayment();
    };
    timer.current = window.setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => {
      stopped = true;
      stopPolling();
    };
  }, [phase, raised, checkPayment, stopPolling]);

  function close() {
    stopPolling();
    setPhase("idle");
    setRaised(null);
    setQrPng(null);
    setNote(null);
  }

  return (
    <>
      <Button size={size} variant={variant} onClick={() => void raise()} disabled={phase === "raising"}>
        {phase === "raising" ? t("Starting…") : (label ?? t("Pay online"))}
      </Button>

      <Modal
        open={phase === "waiting" || phase === "paid" || phase === "failed"}
        onClose={close}
        title={phase === "paid" ? t("Paid") : phase === "failed" ? t("Not paid") : t("Scan to pay")}
        footer={
          <Button variant={phase === "paid" ? "primary" : "outline"} onClick={close}>
            {phase === "paid" ? t("Done") : t("Close")}
          </Button>
        }
      >
        {phase === "waiting" && raised ? (
          <div className="grid gap-3 text-center">
            {/*
              The same dialog serves the counter and a member's own phone, and
              the instruction is not the same in both. Reception is being told
              what to say to somebody standing in front of them; a member is
              being told what to do.
            */}
            <p className="text-sm text-muted">
              {raised.raised_by === "member"
                ? t("Scan this with your banking app, or open the payment page below.")
                : t("Ask the customer to scan this with their banking app.")}
            </p>
            {qrPng ? (
              <img
                src={qrPng}
                alt={t("Payment QR code")}
                className="mx-auto size-64 rounded-[var(--radius-md)] border border-line bg-surface"
              />
            ) : (
              <div className="mx-auto grid size-64 place-items-center rounded-[var(--radius-md)] border border-line text-sm text-muted">
                {t("No QR: use the payment page")}
              </div>
            )}
            <p className="font-display text-3xl tabular-nums">{money(raised.amount_vnd)}</p>
            <p className="text-2xs text-muted">{raised.payment_code}</p>
            <p className="text-sm text-muted">
              {raised.raised_by === "member"
                ? t("We are waiting for your bank. Do not pay twice: this confirms by itself.")
                : t("Waiting for the bank to confirm. This posts by itself. There is nothing to press.")}
            </p>
            {note ? <p className="text-sm text-hold">{note}</p> : null}
            <a
              href={raised.checkout_url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-sm underline underline-offset-4"
            >
              {t("Open the payment page instead")}
            </a>
          </div>
        ) : null}

        {phase === "paid" && raised ? (
          <div className="grid gap-2 text-center">
            <p className="font-display text-3xl tabular-nums">{money(raised.amount_vnd)}</p>
            <p className="text-sm text-muted">
              {raised.raised_by === "member"
                ? t("Paid. Your court is confirmed and the receipt is in your account.")
                : t("Confirmed by payOS and posted automatically. The receipt is on the member’s account.")}
            </p>
          </div>
        ) : null}

        {phase === "failed" ? (
          <div className="grid gap-2 text-center">
            <p className="text-sm">{note ?? t("The payment did not go through.")}</p>
            <p className="text-sm text-muted">{t("Nothing was taken. Try again, or take payment at the till.")}</p>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
