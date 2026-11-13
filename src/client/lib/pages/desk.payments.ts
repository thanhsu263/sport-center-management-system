import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { money, useSessionUser } from "@/client/components/shell";
import { apiGet, apiPost, openInvoice } from "@/client/arena3/client";
import type { PaymentCreateResponse, TransferConfirmResponse, TransferRejectResponse } from "@/shared/arena3/contracts";
import { t, tk, tServer } from "@/client/lib/i18n";
import { usePageState } from "@/client/lib/use-page-state";
import { useRead } from "@/client/lib/use-read";


type Order = {
  id: string;
  ordered_on: string;
  end_on: string;
  user_id: string;
  full_name: string;
  phone: string;
  member_code: string | null;
  plan_name: string;
  price_vnd: number;
  paid_vnd: number;
  plan_id: string;
  /** A code the member already put on the order in the app. */
  promo_code: string | null;
  promo_discount_vnd: number;
};


type Refund = {
  id: string;
  code: string;
  amount_vnd: number;
  created_at: string;
  ref_type: string;
  ref_id: string;
  member_name: string | null;
  member_code: string | null;
  raised_by: string | null;
  centre_owed?: boolean;
};


/** A payment that has been posted — money the centre has actually taken. */
type Receipt = {
  id: string;
  code: string;
  method: string;
  amount_vnd: number;
  created_at: string;
  ref_type: string;
  member_name: string | null;
  member_code: string | null;
  buyer_phone: string | null;
  taken_by: string | null;
  invoice_id: string | null;
  /** 'manual' — a person asserted it. 'auto' — the gateway confirmed it. */
  capture_mode: "manual" | "auto" | null;
  provider: string | null;
};


/** A court held open against a promise to transfer, with nothing posted yet. */
type Awaiting = {
  id: string;
  code: string;
  price_vnd: number;
  deposit_vnd: number;
  start_at: string;
  end_at: string;
  transfer_requested_at: string;
  hold_until: string;
  court_code: string;
  sport: string;
  member_name: string | null;
  member_code: string | null;
  phone: string | null;
};


/** A class seat held against a promise to transfer. */
type AwaitingSeat = {
  kind: "enrollment";
  id: string;
  member_name: string | null;
  member_code: string | null;
  phone: string | null;
  sport: string;
  level: string;
  amount_vnd: number;
  hold_until: string;
  transfer_requested_at: string;
};


type Queue = {
  awaiting: Array<Awaiting | AwaitingSeat>;
  orders: Order[];
  refunds: Refund[];
  /** One page of the receipts in the window, after the method and search filters. */
  receipts: Receipt[];
  receipts_total: number;
  days: number;
};


// `gateway` is one of the five values `pay_method` allows, so a payment taken
// online was reachable only under "All" — and reconciliation is exactly the job
// where a method you cannot isolate is the one you need.
const METHODS = [
  { value: "all", label: tk("All") },
  { value: "cash", label: tk("Cash") },
  { value: "card", label: tk("Card") },
  { value: "transfer", label: tk("Transfer") },
  { value: "gateway", label: tk("Online") },
] as const;


function methodLabel(m: string) {
  const label = (
    {
      cash: tk("Cash"),
      card: tk("Card"),
      transfer: tk("Bank transfer"),
      gateway: tk("Online gateway"),
      quota: tk("Plan hours"),
    } as Record<string, string>
  )[m];
  return label ? t(label) : m;
}


/** Whole days between an ICT date string and today, floored at zero. */
function daysWaiting(dateOnly: string) {
  const then = new Date(`${dateOnly}T00:00:00+07:00`).getTime();
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

export function useDeskPayments() {
  const me = useSessionUser();
  const isManager = me?.role === "manager";
  const [days, setDays] = useState("7");
  const [payMethod, setPayMethod] = useState("all");
  const [receiptQuery, setReceiptQuery] = useState("");
  const receiptPaging = usePageState("desk.receipts", 25);
  // Typing waits a beat, so one search is one request.
  const [receiptTerm, setReceiptTerm] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setReceiptTerm(receiptQuery.trim()), 250);
    return () => clearTimeout(timer);
  }, [receiptQuery]);
  // Whether this centre has payOS set up at all. Read once: the button must be
  // absent rather than present-and-broken when it has not been configured.
  const [onlineOn, setOnlineOn] = useState(false);
  useEffect(() => {
    void apiGet<{ capabilities?: { online_payment?: boolean } }>("/flags")
      .then((r) => setOnlineOn(Boolean(r.capabilities?.online_payment)))
      .catch(() => setOnlineOn(false));
  }, []);
  // A manager signs refunds off here and never runs a till, so only the desk asks about one — and
  // only once it is known who is asking.
  const shiftRead = useRead<{ shift: { id: string } | null; totals?: { cash: number } | null }>(me && !isManager ? "/shifts/current?optional=1" : null);
  // undefined = not known (still asking, or the question failed); null = asked, and no till is open.
  const shift = shiftRead.data === null ? undefined : shiftRead.data.shift;
  // Method and busy flag are per-order: the desk works one member at a time,
  // but a slow network should never grey out the whole queue.
  const [method, setMethod] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [promo, setPromo] = useState<Record<string, { code: string; discount_vnd: number } | null>>({});

  // Every refresh here runs straight after a mutation, and `reload()` never joins a read that was
  // already in flight: two rows actioned in quick succession would otherwise let the second one adopt
  // the first one's older answer and redraw a row that has just been paid for.
  const receiptParams = new URLSearchParams({
    days,
    receipt_limit: String(receiptPaging.pageSize),
    receipt_offset: String(receiptPaging.offset),
  });
  if (payMethod !== "all") receiptParams.set("receipt_method", payMethod);
  if (receiptTerm) receiptParams.set("receipt_q", receiptTerm);
  const read = useRead<Queue>(`/payments/pending?${receiptParams}`);
  // Only the receipts depend on the window. The last answer stays on screen while another window is
  // being asked for, so the transfers, orders and refunds do not vanish and come back with each tap.
  const [last, setLast] = useState<Queue | null>(null);
  useEffect(() => {
    if (read.data) setLast(read.data);
    else if (read.error) setLast(null);
  }, [read.data, read.error]);
  const data = read.error ? null : (read.data ?? last);

  const awaiting = data?.awaiting ?? [];
  const orders = data?.orders ?? [];
  const allRefunds = data?.refunds ?? [];
  const refunds = allRefunds.filter((r) => !r.centre_owed);
  const payouts = allRefunds.filter((r) => r.centre_owed);
  // The server filters and pages the receipts across the whole window, so every row in it can be
  // reached when the list is read back against a bank statement; this is one page of them.
  const receiptPage = data?.receipts ?? [];
  const { reset: resetReceipts } = receiptPaging;
  useEffect(resetReceipts, [payMethod, days, receiptTerm, resetReceipts]);
  // Per-row flooring, not a floor on the total: one over-paid order must not
  // quietly cancel out what another member still has to pay.
  const toCollect = orders.reduce((sum, o) => sum + Math.max(0, o.price_vnd - o.paid_vnd), 0);

  // A receptionist without an open till cannot post anything; saying so once at
  // the top beats a row of buttons that each fail the same way when pressed.
  const canTake = isManager || !!shift;
  // Only "no till" is known to be the reason; while the answer is still coming (or failed) the button keeps its own words.
  const noTill = !isManager && shift === null;

  /**
   * Refresh after a mutation that has already succeeded.
   *
   * It does not wait for the answer or throw. Once the server has taken the money, a failed refresh
   * is a stale screen, not a failed payment — letting it reach the caller's `catch` would put
   * "Payment did not go through" on top of a payment that went through perfectly, which is the one
   * lie this screen must not tell. If the refresh itself fails the queue is replaced by the reason
   * and a "Try again" button, rather than leaving rows on screen that may already be paid.
   */
  function refresh() {
    read.reload();
  }

  // What the desk is charging for an order: list price, less any code the member
  // already applied, less one the desk typed in. Partial payments are not taken (BR-19).
  const dueOf = useCallback(
    (o: Order) => o.price_vnd - (promo[o.id]?.discount_vnd ?? o.promo_discount_vnd),
    [promo],
  );

  const [transferTarget, setTransferTarget] = useState<Order | null>(null);

  async function takePayment(o: Order, forceMethod?: string) {
    const activeMethod = forceMethod ?? (method[o.id] ?? "cash");
    if (!forceMethod && activeMethod === "transfer") {
      setTransferTarget(o);
      return;
    }
    const due = dueOf(o);
    setBusy(o.id);
    try {
      const res = await apiPost<PaymentCreateResponse>(
        "/payments",
        {
          ref_type: "subscription",
          ref_id: o.id,
          method: activeMethod,
          amount_vnd: due,
          ...(promo[o.id]?.code ? { promo_code: promo[o.id]!.code } : {}),
        },
        true,
      );
      toast.success(t("Paid: {name} is on {plan}", { name: o.full_name, plan: o.plan_name }));
      // The money is taken the moment that POST returns, so the queue is
      // refreshed before anything else is attempted. Printing is the step most
      // likely to fail — a blocked popup is enough — and a failed print must
      // not leave a paid row sitting here inviting somebody to charge it twice.
      refresh();
      if (res.invoice?.id) {
        try {
          await openInvoice(res.invoice.id);
        } catch {
          toast.warning(t("Paid, but the receipt did not open. Reprint it from the member's profile."));
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Payment did not go through"));
    } finally {
      setBusy(null);
    }
  }

  async function decline(o: Order) {
    setBusy(o.id);
    try {
      await apiPost(`/subscriptions/${o.id}/decline`);
      toast.success(t("Order cleared from the queue"));
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Could not clear that order"));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Reconcile one awaited transfer.
   *
   * Confirming posts the money and prints the receipt; rejecting hands the
   * court straight back to whoever wants it next. Both are staff judgements
   * made against the bank statement, which is why neither is a member action.
   */
  async function settleTransfer(a: Awaiting, received: boolean) {
    setBusy(a.id);
    try {
      const res = await apiPost<TransferConfirmResponse | TransferRejectResponse>(
        `/bookings/${a.id}/${received ? "transfer-confirm" : "transfer-reject"}`,
      );
      toast.success(
        received ? t("Confirmed: {court} is booked", { court: a.court_code }) : t("Slot released back to the grid"),
      );
      refresh();
      if ("invoice_id" in res) {
        try {
          await openInvoice(res.invoice_id);
        } catch {
          toast.warning(t("Confirmed, but the receipt did not open. Reprint it from the profile."));
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Could not settle that transfer"));
    } finally {
      setBusy(null);
    }
  }

  /** Money for a class seat found on the statement: posts it, which confirms the seat. */
  async function confirmSeat(a: AwaitingSeat) {
    setBusy(a.id);
    try {
      const res = await apiPost<PaymentCreateResponse>(
        "/payments",
        { ref_type: "enrollment", ref_id: a.id, method: method[a.id] ?? "transfer", amount_vnd: a.amount_vnd },
        true,
      );
      toast.success(t("Confirmed: {name} has the seat", { name: a.member_name ?? t("Walk-in") }));
      refresh();
      if (res.invoice?.id) {
        try {
          await openInvoice(res.invoice.id);
        } catch {
          toast.warning(t("Confirmed, but the receipt did not open. Reprint it from the profile."));
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Could not settle that transfer"));
    } finally {
      setBusy(null);
    }
  }

  async function settleRefund(r: Refund, approve: boolean) {
    setBusy(r.id);
    try {
      await apiPost(`/payments/${r.id}/${approve ? "approve-refund" : "reject-refund"}`);
      toast.success(approve ? t("Refund approved") : t("Refund rejected"));
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      setBusy(null);
    }
  }

  async function payOut(r: Refund) {
    setBusy(r.id);
    try {
      await apiPost(`/payments/${r.id}/pay-out-refund`);
      toast.success(t("Refund paid out"));
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      setBusy(null);
    }
  }

  const statItems = [
    { label: t("Waiting payments"), value: orders.length + awaiting.length },
    { label: t("Amount to collect"), value: money(toCollect) },
    { label: t("Current shift"), value: shift ? t("Shift open") : t("No open shift") },
    { label: t("Cash in till"), value: shiftRead.data?.totals?.cash ? money(shiftRead.data.totals.cash) : "0 đ" },
  ];
  return {
    isManager, days, setDays, payMethod, setPayMethod, receiptQuery, setReceiptQuery,
    receiptPaging, onlineOn, shiftRead, method, setMethod, busy, setPromo, read, data, awaiting,
    orders, refunds, payouts, receiptPage, toCollect, canTake, noTill, refresh, dueOf,
    transferTarget, setTransferTarget, takePayment, decline, settleTransfer, confirmSeat,
    settleRefund, payOut, statItems,
  };
}

export { METHODS, methodLabel, daysWaiting };
