import { PayOS } from "@payos/node";

/**
 * The payOS gateway, wrapped so the rest of the app never talks to it directly.
 *
 * Three things this file exists to guarantee:
 *
 *  - **The app runs without credentials.** payOS is optional. An unconfigured
 *    install must behave exactly as it did before — cash, card and bank
 *    transfer at the desk — not crash on boot or hide the till behind an
 *    error. Nothing here throws at import time.
 *  - **Order codes are derived, never invented.** payOS wants a number, unique
 *    per merchant, inside the JS safe-integer range. The usual
 *    `Date.now()`-based guess collides when two customers pay in the same
 *    millisecond; this app already has a gapless counter, so the code comes
 *    from there.
 *  - **Secrets stay server-side.** `process.env` only — no `VITE_` prefix, so
 *    the checksum key can never reach a browser bundle.
 */

export type PayosStatus = "PENDING" | "PAID" | "CANCELLED" | "EXPIRED" | "PROCESSING" | string;

/** Everything the gateway needs, or `null` when the centre has not set it up. */
function credentials() {
  const clientId = process.env.PAYOS_CLIENT_ID?.trim();
  const apiKey = process.env.PAYOS_API_KEY?.trim();
  const checksumKey = process.env.PAYOS_CHECKSUM_KEY?.trim();
  if (!clientId || !apiKey || !checksumKey) return null;
  return { clientId, apiKey, checksumKey };
}

/**
 * Test switch: with `PAYOS_TEST_AMOUNT=2000` every online payment is charged
 * that much at the gateway while the order keeps its real price. Unset (the
 * default) it does nothing, and an amount at or above the price is ignored, so
 * it can only ever lower what a customer is asked to pay. Remove it before
 * taking real money.
 */
export function gatewayAmount(priceVnd: number): number {
  const t = Number(process.env.PAYOS_TEST_AMOUNT?.trim());
  return Number.isInteger(t) && t >= 1000 && t < priceVnd ? t : priceVnd;
}

/** Whether online payment can be offered at all. */
export function payosConfigured(): boolean {
  return overridePaymentLinkCreator !== null || credentials() !== null;
}

let client: PayOS | null = null;
function payos(): PayOS {
  if (!client) {
    const creds = credentials();
    if (!creds) throw new Error("payOS is not configured");
    client = new PayOS(creds);
  }
  return client;
}

/**
 * The line that shows up on the bank statement, in nine characters.
 *
 * payOS caps the description at **9 characters** for a bank account that is
 * not itself linked to payOS, and silently truncating a longer string would
 * leave reception with a statement line that no longer identifies anything.
 * Vietnamese and punctuation are not accepted either.
 *
 * `PAY-20260927-0004` becomes `A3270004`: the centre, the day of the month and
 * the day's sequence number. That is unique within any month and short enough
 * to survive, and the full order code is still on the payOS record for
 * anything that needs the exact match.
 */
export function describeForGateway(paymentCode: string): string {
  const m = /^[A-Z]+-\d{6}(\d{2})-(\d+)$/.exec(paymentCode);
  if (m) return `A3${m[1]}${m[2]!.padStart(4, "0")}`.slice(0, 9);
  return paymentCode.replace(/[^A-Za-z0-9]/g, "").slice(0, 9).toUpperCase();
}

export type CreatedLink = {
  orderCode: number;
  checkoutUrl: string;
  qrCode: string;
  paymentLinkId: string;
  expiredAt: number | null;
};

/**
 * Issue a payment link.
 *
 * `expiredAt` is seconds since the epoch, not milliseconds — a link created
 * with a millisecond value is accepted and then never expires, which would
 * leave a court held open indefinitely.
 */
let overridePaymentLinkCreator: ((args: Parameters<typeof createPaymentLink>[0]) => Promise<CreatedLink>) | null = null;
/** @internal test-only */
export function setOverridePaymentLinkCreator(fn: ((args: any) => Promise<CreatedLink>) | null): void {
  overridePaymentLinkCreator = fn;
}

export async function createPaymentLink(args: {
  orderCode: number;
  amountVnd: number;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  expiresInSeconds?: number;
}): Promise<CreatedLink> {
  if (overridePaymentLinkCreator) {
    return overridePaymentLinkCreator(args);
  }
  const expiredAt = args.expiresInSeconds
    ? Math.floor(Date.now() / 1000) + args.expiresInSeconds
    : undefined;
  const res = await payos().paymentRequests.create({
    orderCode: args.orderCode,
    amount: gatewayAmount(args.amountVnd),
    description: args.description,
    returnUrl: args.returnUrl,
    cancelUrl: args.cancelUrl,
    ...(expiredAt ? { expiredAt } : {}),
  });
  return {
    orderCode: res.orderCode,
    checkoutUrl: res.checkoutUrl,
    qrCode: res.qrCode,
    paymentLinkId: res.paymentLinkId,
    expiredAt: res.expiredAt ?? null,
  };
}

export type LinkState = {
  status: PayosStatus;
  amountPaid: number;
  /** The bank's own reference for the transfer that settled this, if any. */
  transactionId: string | null;
};

/**
 * Ask payOS what actually happened.
 *
 * This is the only statement about a payment the app trusts. A customer
 * returning to `returnUrl` proves nothing — anyone can open that address — so
 * the decision to post money is always made from this answer or from a
 * signature-verified webhook, never from the browser coming back.
 */
export async function readPaymentLink(orderCode: number): Promise<LinkState> {
  const info = await payos().paymentRequests.get(orderCode);
  const txns = (info.transactions ?? []) as Array<{ reference?: string; amount?: number }>;
  return {
    status: info.status,
    amountPaid: Number(info.amountPaid ?? 0),
    transactionId: txns[0]?.reference ?? null,
  };
}

/** Withdraw a link whose hold has expired, so the customer cannot still pay it. */
export async function cancelPaymentLink(orderCode: number, reason: string): Promise<void> {
  await payos().paymentRequests.cancel(orderCode, reason.slice(0, 255));
}

export type VerifiedWebhook = {
  orderCode: number;
  amount: number;
  reference: string | null;
  code: string;
};

/**
 * Check a webhook body's signature and return its contents.
 *
 * Throws when the signature does not match, which is the only safe response: a
 * request that cannot be proved to come from payOS carries no information at
 * all, however plausible its contents look.
 */
export async function verifyWebhook(body: unknown): Promise<VerifiedWebhook> {
  const data = await payos().webhooks.verify(body as never);
  return {
    orderCode: Number(data.orderCode),
    amount: Number(data.amount),
    reference: (data as { reference?: string }).reference ?? null,
    code: (data as { code?: string }).code ?? "",
  };
}

/** Register this deployment's webhook URL with payOS. Needs a public address. */
export async function registerWebhook(url: string): Promise<void> {
  await payos().webhooks.confirm(url);
}
