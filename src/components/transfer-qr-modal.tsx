import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button, Modal } from "./ui";
import { money } from "./shell";
import { apiPost } from "@/lib/arena3/client";
import { t, tServer } from "@/lib/i18n";
import { useRead } from "@/lib/use-read";
import { transferReference, vietQrPayload } from "@/lib/vietqr";

/** The centre's account as `/v1/bank-transfer` answers it. */
export type CentreBank = {
  configured: boolean;
  bin?: string;
  account_no?: string;
  account_name?: string;
  bank_name?: string;
};

/** The centre's bank account, or `configured: false` until the deploy sets BANK_* (see .env.example). */
export function useCentreBank() {
  const read = useRead<CentreBank>("/bank-transfer");
  return { bank: read.data, error: read.error };
}

const QR_STYLE = { width: 512, margin: 1, errorCorrectionLevel: "M" as const, color: { dark: "#141c12", light: "#ffffff" } };

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(t("{what} copied", { what }));
  } catch {
    toast.error(t("Could not copy. Select the text and copy it instead."));
  }
}

/**
 * The QR and the details beside it, built from one payload, so what the banking app reads and
 * what the person types by hand are the same account, amount and reference.
 */
export function VietQrPanel({
  bank,
  amountVnd,
  reference,
  buyerName,
}: {
  bank: CentreBank & { configured: true };
  amountVnd: number;
  reference: string;
  buyerName?: string;
}) {
  const ref = transferReference(reference);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSrc(null);
    try {
      const payload = vietQrPayload({ bin: bank.bin!, accountNo: bank.account_no! }, amountVnd, ref);
      void QRCode.toDataURL(payload, QR_STYLE).then((url) => live && setSrc(url));
    } catch {
      // An account the builder refuses never reaches here: the server only reports a valid one.
    }
    return () => {
      live = false;
    };
  }, [bank.bin, bank.account_no, amountVnd, ref]);

  return (
    <div className="grid gap-4 text-center">
      {src ? (
        <div className="relative mx-auto size-64 overflow-hidden rounded-[var(--radius-lg)] border border-line bg-white p-2 shadow-sm">
          <img src={src} alt={t("VietQR payment code")} className="size-full object-contain" />
        </div>
      ) : (
        <div className="mx-auto grid size-64 place-items-center rounded-[var(--radius-lg)] border border-line bg-surface text-sm text-muted">
          {t("Generating QR…")}
        </div>
      )}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 rounded-[var(--radius-md)] bg-wood/50 p-3 text-left text-sm">
        <dt className="text-muted">{t("Amount due")}</dt>
        <dd className="figure text-lg font-bold text-accent-2 tabular-nums">{money(amountVnd)}</dd>
        <dt className="text-muted">{t("Bank")}</dt>
        <dd className="font-semibold">{bank.bank_name}</dd>
        <dt className="text-muted">{t("Account number")}</dt>
        <dd className="flex items-center gap-2">
          <span className="font-mono font-semibold tracking-wide">{bank.account_no}</span>
          <CopyButton label={t("Copy the account number")} onClick={() => void copy(bank.account_no!, t("Account number"))} />
        </dd>
        <dt className="text-muted">{t("Account name")}</dt>
        <dd className="font-semibold">{bank.account_name}</dd>
        <dt className="text-muted">{t("Transfer reference")}</dt>
        <dd className="flex items-center gap-2">
          <span className="font-mono font-bold text-accent-2">{ref}</span>
          <CopyButton label={t("Copy the reference")} onClick={() => void copy(ref, t("Transfer reference"))} />
        </dd>
        {buyerName ? (
          <>
            <dt className="text-muted">{t("Customer")}</dt>
            <dd>{buyerName}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

function CopyButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-11 shrink-0 place-items-center rounded-[var(--radius-sm)] text-muted transition-colors duration-150 hover:bg-wood hover:text-fg sm:size-8"
    >
      <Copy aria-hidden className="size-4" />
    </button>
  );
}

type TransferQrModalProps = {
  open: boolean;
  onClose: () => void;
  amountVnd: number;
  code: string;
  title?: string;
  buyerName?: string;
  refType?: "booking" | "subscription";
  refId?: string;
  onConfirmManual: () => Promise<void>;
  onPaid?: () => void;
};

/**
 * The desk's QR box. A payOS code comes first when the centre has payOS (it confirms itself);
 * otherwise a VietQR for the centre's own account. With neither, it says the account is not
 * set up rather than showing one that is not the centre's.
 */
export function TransferQrModal({
  open,
  onClose,
  amountVnd,
  code,
  title,
  buyerName,
  refType,
  refId,
  onConfirmManual,
}: TransferQrModalProps) {
  const { bank } = useCentreBank();
  const [payosSrc, setPayosSrc] = useState<string | null>(null);
  const [triedPayos, setTriedPayos] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setPayosSrc(null);
      setTriedPayos(false);
      return;
    }
    let active = true;
    async function tryPayos() {
      if (refType && refId) {
        try {
          const res = await apiPost<{ qr_code: string; payment_id: string }>(
            "/payments/online",
            { ref_type: refType, ref_id: refId },
            true,
          );
          if (active && res.qr_code) setPayosSrc(await QRCode.toDataURL(res.qr_code, QR_STYLE));
        } catch {
          // payOS not set up or unavailable: the centre's own account below takes over.
        }
      }
      if (active) setTriedPayos(true);
    }
    void tryPayos();
    return () => {
      active = false;
    };
  }, [open, refType, refId]);

  async function handleConfirmManual() {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirmManual();
      toast.success(t("Payment confirmed and receipt generated"));
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Could not confirm payment"));
    } finally {
      setBusy(false);
    }
  }

  const reference = `ARENA3 ${code}`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title ?? t("Scan QR to pay · Bank transfer")}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("Close")}
          </Button>
          <Button variant="primary" onClick={handleConfirmManual} disabled={busy}>
            {busy ? t("Recording…") : t("Money received, confirm & print")}
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 text-center">
        <p className="text-sm text-muted">{t("Ask the customer to scan this QR code with their banking app.")}</p>
        {payosSrc ? (
          <>
            <div className="relative mx-auto size-64 overflow-hidden rounded-[var(--radius-lg)] border border-line bg-white p-2 shadow-sm">
              <img src={payosSrc} alt={t("VietQR payment code")} className="size-full object-contain" />
            </div>
            <p className="text-sm">
              <span className="text-muted">{t("Amount due")}: </span>
              <span className="figure font-bold tabular-nums text-accent-2">{money(amountVnd)}</span>
            </p>
            <p className="text-xs text-muted">{t("This code comes from payOS: the bank details are inside it, and the payment confirms itself.")}</p>
          </>
        ) : !triedPayos || !bank ? (
          <div className="mx-auto grid size-64 place-items-center rounded-[var(--radius-lg)] border border-line bg-surface text-sm text-muted">
            {t("Generating QR…")}
          </div>
        ) : bank.configured ? (
          <VietQrPanel bank={bank as CentreBank & { configured: true }} amountVnd={amountVnd} reference={reference} buyerName={buyerName} />
        ) : (
          <div className="rounded-[var(--radius-md)] border border-hold/30 bg-hold/5 p-4 text-left text-sm">
            <p className="font-medium">{t("The centre's bank account is not set up")}</p>
            <p className="mt-1 text-muted">
              {t("Ask the manager to add it before taking transfers. Cash and card still work.")}
            </p>
          </div>
        )}
        <p className="text-xs text-muted">
          {t("Once the customer completes the transfer, click 'Money received, confirm & print' below to post the payment and print their receipt.")}
        </p>
      </div>
    </Modal>
  );
}

/**
 * The member's transfer step on a held court: the QR and details for the centre's account with
 * the booking code as the reference, then "I have transferred", which keeps the court held
 * while reception finds the money (the existing pending-transfer flow).
 */
export function MemberTransferModal({
  open,
  onClose,
  bank,
  amountVnd,
  bookingCode,
  busy,
  onTransferred,
}: {
  open: boolean;
  onClose: () => void;
  bank: CentreBank & { configured: true };
  amountVnd: number;
  bookingCode: string;
  busy: boolean;
  /** Absent once the member has already said so: the box only shows the details again. */
  onTransferred?: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("Pay by bank transfer")}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("Close")}
          </Button>
          {onTransferred ? (
            <Button onClick={onTransferred} disabled={busy}>
              {t("I have transferred")}
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="grid gap-4">
        <p className="text-sm text-muted">
          {t("Scan with your banking app, or type the details in by hand. Keep the reference exactly as it is, so reception can find your transfer.")}
        </p>
        <VietQrPanel bank={bank} amountVnd={amountVnd} reference={`ARENA3 ${bookingCode}`} />
        <p className="text-xs text-muted">
          {t("A transfer is not a payment until reception finds it in the bank. Your court stays held meanwhile.")}
        </p>
      </div>
    </Modal>
  );
}
