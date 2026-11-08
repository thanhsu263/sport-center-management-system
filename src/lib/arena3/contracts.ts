/**
 * The shapes the API sends, shared by the handlers and the screens.
 *
 * Types only, on purpose: the client imports this file with `import type`, so
 * nothing here may pull in server code. Every row type describes what arrives
 * over the wire after `JSON.stringify`, not what `pg` hands the server:
 *
 * - `timestamptz` is a `Date` on the server and an ISO string once sent, so
 *   it is typed as `string` here (the handlers already treat it that way).
 * - `numeric` (`vat_rate`, `quota_hours`) has no type parser, so `pg` returns
 *   it as text. Read it with `Number(...)`.
 * - `int8` is parsed to a number in `tx.ts`; `date` and `interval` stay text.
 *
 * The column lists the handlers select live in `columns.ts` and are checked
 * against these types there, and against the real tables in `tx.test.ts`.
 */

/** What a handler hands the router: an HTTP status and the JSON body. */
export type Reply<T> = { status: number; body: T };

/** ISO 8601 text of a `timestamptz`. */
export type Iso = string;
/** A Postgres `numeric`, which arrives as text. */
export type Numeric = string;

export type Role = "manager" | "coach" | "receptionist" | "member";
export type BookingStatus = "hold" | "confirmed" | "in_use" | "completed" | "cancelled" | "no_show";
export type PayMethod = "cash" | "transfer" | "card" | "gateway" | "quota";
export type PayStatus = "posted" | "refund_pending" | "refund_rejected" | "pending" | "expired" | "failed";

/** The signed-in person as every endpoint returns them: no password hash, ever. */
export type PublicUser = {
  id: string;
  member_code: string | null;
  full_name: string;
  phone: string;
  email: string | null;
  role: Role;
  status: string;
  date_of_birth: string | null;
  health_notes: string | null;
  must_change_password: boolean;
  avatar_url: string | null;
};

/** One `court_bookings` row. */
export type Booking = {
  id: string;
  code: string;
  court_id: string;
  /** Null for a walk-in guest. */
  user_id: string | null;
  guest_name: string | null;
  guest_phone: string | null;
  start_at: Iso;
  end_at: Iso;
  status: BookingStatus;
  channel: string;
  price_vnd: number;
  discount_pct: number;
  vat_rate: Numeric;
  hold_until: Iso | null;
  occupancy_id: string | null;
  quota_hours: Numeric;
  transfer_requested_at: Iso | null;
  promo_id: string | null;
  promo_discount_vnd: number;
  series_id: string | null;
  deposit_vnd: number;
  paid_vnd: number;
  cancel_refund_pct: number | null;
  cancel_fee_vnd: number | null;
};

/** One `payments` row. A refund is a row with a negative amount. */
export type Payment = {
  id: string;
  code: string;
  user_id: string | null;
  shift_id: string | null;
  method: PayMethod;
  amount_vnd: number;
  vat_rate: Numeric;
  status: PayStatus;
  ref_type: string;
  ref_id: string;
  created_by: string | null;
  created_at: Iso;
  capture_mode: string;
  provider: string | null;
  provider_order_code: number | null;
  provider_txn_id: string | null;
  provider_status: string | null;
  paid_at: Iso | null;
  promo_id: string | null;
  discount_vnd: number;
};

/** One `invoices` row. */
export type Invoice = {
  id: string;
  code: string;
  payment_id: string;
  buyer_name: string;
  buyer_tax_code: string | null;
  issued_at: Iso;
  form_no: string | null;
  serial_no: string | null;
  buyer_address: string | null;
  seller_legal_name: string | null;
  seller_tax_code: string | null;
  seller_address: string | null;
  subtotal_vnd: number | null;
  vat_rate: Numeric | null;
  vat_vnd: number | null;
  total_vnd: number | null;
  buyer_phone: string | null;
  exported_at: Iso | null;
};

export type CancelTier = { hours: number; refund_pct: number };

// ---- Booking flow -------------------------------------------------------

/** `GET /me/bookings`: the member's live bookings, soonest first. */
export type MyBooking = Pick<
  Booking,
  "id" | "code" | "status" | "start_at" | "end_at" | "price_vnd" | "paid_vnd" | "deposit_vnd" | "series_id" | "quota_hours" | "court_id"
> & {
  court_code: string;
  sport: string;
  /** Far enough out that the member may still move it themselves. */
  can_move: boolean;
};

/** A coming session of a class the member is enrolled in (confirmed seat), for their schedule. */
export type MyClassSession = {
  id: string;
  class_id: string;
  start_at: Iso;
  end_at: Iso;
  sport: string;
  level: string;
  court_code: string;
  coach_name: string;
};

export type MeBookingsResponse = {
  window_hours: number;
  cancel_tiers: CancelTier[];
  items: MyBooking[];
  /** Upcoming class sessions, soonest first. */
  class_sessions: MyClassSession[];
};

/** `POST /bookings`: the slot is held and the clock is running. */
export type HoldResponse = {
  booking: Booking;
  hold_until: Iso;
  price: number;
  deposit_vnd: number;
  due_now_vnd: number;
  list_price: number;
  membership: { covered: boolean; end_on: string | null };
  promo: { code: string; name: string; discount_vnd: number } | null;
};

/** A held booking that money (or plan hours) has turned into a confirmed one. */
export type SettledBooking = {
  booking: Booking;
  payment: Payment;
  invoice_id: string;
};

/** A member said "I'll transfer": still on hold, waiting on reception to see the money. */
export type AwaitingTransfer = {
  booking: Booking;
  payment: null;
  invoice_id: null;
  awaiting_transfer: true;
  hold_until: Iso;
  amount_vnd: number;
};

/** `POST /bookings/:id/confirm`. Tell the two apart with `"awaiting_transfer" in res`. */
export type ConfirmResponse = SettledBooking | AwaitingTransfer;

/** `POST /bookings/:id/transfer-confirm`. */
export type TransferConfirmResponse = SettledBooking;

/** `POST /bookings/:id/transfer-reject`. */
export type TransferRejectResponse = { booking_id: string; released: true };

/** What cancelling would cost at this moment. */
export type CancelQuote = {
  hours_left: number;
  refund_pct: number;
  paid_vnd: number;
  refund_vnd: number;
  fee_vnd: number;
  /** The centre cancelled, or an emergency: the customer loses nothing. */
  waived: boolean;
};

/** `GET /bookings/:id/cancel-quote`. */
export type CancelQuoteResponse = CancelQuote & { tiers: CancelTier[]; quota_hours: number };

/** `POST /bookings/:id/cancel`. A hold is let go with nothing to refund. */
export type CancelResponse =
  | { refund: null; booking_id: string }
  | {
      /** A cash refund row, plan hours handed back, or nothing owed. */
      refund: Payment | { kind: "quota"; hours: number } | null;
      refundable: boolean;
      quote: CancelQuote;
    };

/** `POST /bookings/:id/collect-balance`. */
export type CollectBalanceResponse = {
  booking: Booking;
  payment_id: string;
  invoice_id: string;
  amount_vnd: number;
};

/** `POST /bookings/:id/reschedule`. */
export type RescheduleResponse = { booking: Booking };

/** `POST /bookings/:id/check-in`. */
export type CheckInResponse = { status: "in_use" };

/** `POST /walk-in`: a guest paid at the desk and has the court now. */
export type WalkInResponse = SettledBooking;

/** `GET /bookings/:id`. */
export type BookingResponse = Booking;

// ---- Desk ---------------------------------------------------------------

/** `POST /payments`: money taken at the desk, with its receipt. */
export type PaymentCreateResponse = { payment: Payment; invoice: Invoice };
