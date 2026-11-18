-- 0057_invoice_adjustments.sql: a refund paid out issues an adjustment invoice
-- (hóa đơn điều chỉnh giảm) against the invoice that took the money.
--
-- Until now an invoice was only written when money came in. A refund left the
-- original invoice saying the full amount, so the centre's tax ledger overstated
-- revenue and VAT by every đồng it handed back. The adjustment is its own row,
-- tied to the refund payment (payments.id stays one-invoice-per-payment) and
-- pointing at the invoice it reduces. Its amounts are negative, so summing
-- invoices over a period gives the revenue the centre actually kept.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS kind VARCHAR(12) NOT NULL DEFAULT 'sale'
    CONSTRAINT invoices_kind_check CHECK (kind IN ('sale', 'adjustment')),
  ADD COLUMN IF NOT EXISTS adjusts_invoice_id UUID REFERENCES invoices(id);

CREATE INDEX IF NOT EXISTS invoices_adjusts_invoice_id_idx ON invoices (adjusts_invoice_id);
