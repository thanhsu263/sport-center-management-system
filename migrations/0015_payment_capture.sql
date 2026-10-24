-- Make it explicit how a payment was captured, and give the gateway somewhere
-- to record itself.
--
-- Two separate problems land in the same table.
--
-- 1. Every payment row until now meant "a member of staff says this money was
--    taken". A payment gateway means something different: "the provider's own
--    API says this money moved." Those are not the same claim and must not look
--    the same in the till, in the report, or on the receipt. `capture_mode`
--    keeps them apart — `manual` is a human's word, `auto` is a machine's.
--
-- 2. A gateway payment exists BEFORE the money arrives. `pay_status` only had
--    'posted' and the two refund states, so there was no way to write down
--    "a link was issued and we are waiting". Revenue counts 'posted' only, so a
--    pending row must never reach a report.
--
-- The enum values are added here and deliberately not used anywhere in this
-- file: Postgres refuses to use a new enum label in the same transaction that
-- created it, and the migration runner wraps each file in one.

ALTER TYPE pay_status ADD VALUE IF NOT EXISTS 'pending';
ALTER TYPE pay_status ADD VALUE IF NOT EXISTS 'expired';
ALTER TYPE pay_status ADD VALUE IF NOT EXISTS 'failed';

-- The old constraint enumerated the statuses that may hold a positive amount,
-- so it rejected every new one. Restated the other way round — only a refund
-- may be negative — it does not need editing again the next time a status is
-- added. Compared as text so no new enum label is referenced in this
-- transaction.
--
-- 'posted' is left unconstrained on purpose: it is the terminal state for BOTH
-- an ordinary charge (amount_vnd >= 0) and an approved refund
-- (paymentsApproveRefund / the manager-direct path in paymentsRefund insert a
-- negative amount_vnd straight into 'posted' — there is no separate "refunded"
-- status). An earlier version of this constraint forced 'posted' to be >= 0,
-- which rejects every completed refund row already in the table.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS refund_amount_chk;
ALTER TABLE payments ADD CONSTRAINT refund_amount_chk CHECK (
  CASE
    WHEN status::text IN ('refund_pending', 'refund_rejected') THEN amount_vnd < 0
    WHEN status::text = 'posted' THEN true
    ELSE amount_vnd >= 0
  END
);

ALTER TABLE payments
  -- 'manual' — a person at the desk asserted this money was received.
  -- 'auto'   — confirmed against the provider's API, no human assertion.
  ADD COLUMN IF NOT EXISTS capture_mode        VARCHAR(8) NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS provider            VARCHAR(16),
  -- payOS requires a numeric order code within the JS safe-integer range and
  -- unique per merchant; this is the app's own `PAY-YYYYMMDD-NNNN` rendered as
  -- YYYYMMDDNNNN, so it is gapless, collision-free and traceable back.
  ADD COLUMN IF NOT EXISTS provider_order_code BIGINT,
  ADD COLUMN IF NOT EXISTS provider_txn_id     VARCHAR(64),
  ADD COLUMN IF NOT EXISTS provider_status     VARCHAR(32),
  ADD COLUMN IF NOT EXISTS paid_at             TIMESTAMPTZ;

ALTER TABLE payments DROP CONSTRAINT IF EXISTS capture_mode_chk;
ALTER TABLE payments ADD CONSTRAINT capture_mode_chk
  CHECK (capture_mode IN ('manual', 'auto'));

-- Look a payment up by the code we handed the provider.
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_order_code_idx
  ON payments (provider_order_code)
  WHERE provider_order_code IS NOT NULL;

-- The idempotency guarantee for the gateway.
--
-- A provider re-sends the same confirmation on retry, on a duplicate webhook
-- and on every poll — that is normal behaviour, not an error. Letting the
-- database refuse the second write is safer than any check the application
-- could make, because it holds even when two requests race.
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_txn_idx
  ON payments (provider, provider_txn_id)
  WHERE provider_txn_id IS NOT NULL;

-- Everything taken before today was taken by a person, at a till.
UPDATE payments SET capture_mode = 'manual' WHERE capture_mode IS NULL;
