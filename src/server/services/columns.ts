import type { Booking, Invoice, Payment } from "./contracts";

/**
 * Column lists for the rows the API sends whole, in place of `select *`.
 *
 * Each list is written as a `Record` over the row type, so a column the type
 * names but the list forgets (or the reverse) fails to compile. `tx.test.ts`
 * checks the same lists against the migrated tables, so a migration that adds
 * a column fails a test instead of quietly widening every response.
 */
function list<T>(cols: Record<keyof T, true>): string {
  return Object.keys(cols).join(", ");
}

export const BOOKING_COLS = list<Booking>({
  id: true,
  code: true,
  court_id: true,
  user_id: true,
  guest_name: true,
  guest_phone: true,
  start_at: true,
  end_at: true,
  status: true,
  channel: true,
  price_vnd: true,
  discount_pct: true,
  vat_rate: true,
  hold_until: true,
  occupancy_id: true,
  quota_hours: true,
  transfer_requested_at: true,
  promo_id: true,
  promo_discount_vnd: true,
  series_id: true,
  deposit_vnd: true,
  paid_vnd: true,
  cancel_refund_pct: true,
  cancel_fee_vnd: true,
});

export const PAYMENT_COLS = list<Payment>({
  id: true,
  code: true,
  user_id: true,
  shift_id: true,
  method: true,
  amount_vnd: true,
  vat_rate: true,
  status: true,
  ref_type: true,
  ref_id: true,
  created_by: true,
  created_at: true,
  capture_mode: true,
  provider: true,
  provider_order_code: true,
  provider_txn_id: true,
  provider_status: true,
  paid_at: true,
  promo_id: true,
  discount_vnd: true,
});

export const INVOICE_COLS = list<Invoice>({
  id: true,
  code: true,
  payment_id: true,
  buyer_name: true,
  buyer_tax_code: true,
  issued_at: true,
  form_no: true,
  serial_no: true,
  buyer_address: true,
  seller_legal_name: true,
  seller_tax_code: true,
  seller_address: true,
  subtotal_vnd: true,
  vat_rate: true,
  vat_vnd: true,
  total_vnd: true,
  buyer_phone: true,
  exported_at: true,
});
