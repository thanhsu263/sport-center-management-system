-- Bank transfers waiting to be reconciled.
--
-- Until now, a member who chose "Bank transfer" got a posted payment and a
-- confirmed booking the instant they tapped it: the centre's books said the
-- money had arrived before anyone had looked at the bank. There was no state
-- for "asked to pay, has not paid yet", and so no queue for the desk to work.
--
-- No payment row is written while the transfer is outstanding, deliberately:
-- an unpaid transfer is not a payment, and inventing a row for it would put
-- money the centre does not have into every revenue report, the subscription
-- debt view and the refundable-amount ledger. The booking simply stays on
-- `hold` — which already blocks the slot and already has an expiry sweeper —
-- and carries the moment the member said they would transfer.
--
-- Additive only: one nullable column, one settings column with a default and
-- one partial index. Nothing existing changes meaning, so this is safe to run
-- against live data on deploy.

ALTER TABLE court_bookings ADD COLUMN IF NOT EXISTS transfer_requested_at TIMESTAMPTZ;

-- A five-minute hold is the right pressure on someone standing at a card
-- reader and the wrong pressure on someone opening a banking app, so a
-- transfer buys the slot a longer clock of its own.
ALTER TABLE center_settings
  ADD COLUMN IF NOT EXISTS transfer_hold_minutes INT NOT NULL DEFAULT 120;

-- The desk reads this queue on every visit to the payments screen; it is a
-- handful of rows out of every booking the centre has ever taken.
CREATE INDEX IF NOT EXISTS bookings_awaiting_transfer_idx
  ON court_bookings (transfer_requested_at)
  WHERE status = 'hold' AND transfer_requested_at IS NOT NULL;
