-- Invoice fields a Vietnamese sales invoice is expected to carry, plus a
-- backfill for the rows that were written before they existed.
--
-- Two things drove this. The printed invoice had no tax breakdown at all even
-- though `payments.vat_rate` was being recorded, and most seeded invoices had
-- no `invoice_lines` whatsoever, so the goods table printed as a heading over
-- empty space.
--
-- The seller block is copied onto each invoice rather than joined from
-- `center_settings`: when the centre changes its address or tax code next
-- year, invoices already issued must keep saying what they said at the time.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS form_no            VARCHAR(20),
  ADD COLUMN IF NOT EXISTS serial_no          VARCHAR(20),
  ADD COLUMN IF NOT EXISTS buyer_address      TEXT,
  ADD COLUMN IF NOT EXISTS seller_legal_name  VARCHAR(190),
  ADD COLUMN IF NOT EXISTS seller_tax_code    VARCHAR(20),
  ADD COLUMN IF NOT EXISTS seller_address     TEXT,
  ADD COLUMN IF NOT EXISTS subtotal_vnd       INT,
  ADD COLUMN IF NOT EXISTS vat_rate           NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS vat_vnd            INT,
  ADD COLUMN IF NOT EXISTS total_vnd          INT;

-- Đơn vị tính. A quantity without a unit is not a line an auditor can read.
ALTER TABLE invoice_lines
  ADD COLUMN IF NOT EXISTS unit VARCHAR(16);

-- Demo defaults so the tax fields have something to show. Only applied where
-- the centre has not set its own: a real deployment configures these in
-- Settings and this must not overwrite that.
UPDATE center_settings
   SET tax_code = COALESCE(tax_code, '0312345678'),
       vat_rate = CASE WHEN vat_rate = 0 THEN 8.00 ELSE vat_rate END
 WHERE id = 1;

-- ---------------------------------------------------------------------------
-- Backfill 1: give every invoice without a goods line one derived from what
-- was actually paid for.
-- ---------------------------------------------------------------------------
INSERT INTO invoice_lines (invoice_id, description, unit, qty, unit_vnd, amount_vnd)
SELECT
  i.id,
  CASE p.ref_type
    WHEN 'subscription' THEN
      COALESCE('Gói hội viên — ' || mp.name, 'Gói hội viên')
    WHEN 'booking' THEN
      COALESCE(
        'Thuê sân ' || c.court_code || ' — '
          || to_char(b.start_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY HH24:MI')
          || '–' || to_char(b.end_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI'),
        'Thuê sân')
    WHEN 'walkin'    THEN 'Vé lẻ vào cửa'
    WHEN 'equipment' THEN 'Thuê thiết bị'
    ELSE 'Dịch vụ tại trung tâm'
  END,
  CASE p.ref_type
    WHEN 'booking' THEN 'giờ'
    WHEN 'subscription' THEN 'gói'
    ELSE 'lượt'
  END,
  1,
  p.amount_vnd,
  p.amount_vnd
FROM invoices i
JOIN payments p ON p.id = i.payment_id
LEFT JOIN subscriptions s     ON p.ref_type = 'subscription' AND s.id = p.ref_id
LEFT JOIN membership_plans mp ON mp.id = s.plan_id
LEFT JOIN court_bookings b    ON p.ref_type = 'booking' AND b.id = p.ref_id
LEFT JOIN courts c            ON c.id = b.court_id
WHERE NOT EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id);

-- Existing lines predate the unit column.
UPDATE invoice_lines SET unit = 'lượt' WHERE unit IS NULL;

-- ---------------------------------------------------------------------------
-- Backfill 2: seller block and money columns.
--
-- Listed prices at the counter are tax-inclusive, so the amount taken IS the
-- payable total and the net is derived from it — not the other way round.
-- Rounding the net down and taking VAT as the remainder keeps
-- `subtotal + vat = total` exact, which a reconciliation will check.
-- ---------------------------------------------------------------------------
UPDATE invoices i
   SET seller_legal_name = COALESCE(i.seller_legal_name, cs.legal_name),
       seller_tax_code   = COALESCE(i.seller_tax_code, cs.tax_code),
       seller_address    = COALESCE(i.seller_address, cs.address),
       form_no           = COALESCE(i.form_no, '1'),
       serial_no         = COALESCE(i.serial_no, 'A3' || to_char(i.issued_at, 'YY') || 'E'),
       vat_rate          = COALESCE(i.vat_rate, p.vat_rate),
       total_vnd         = COALESCE(i.total_vnd, p.amount_vnd),
       subtotal_vnd      = COALESCE(
                             i.subtotal_vnd,
                             FLOOR(p.amount_vnd / (1 + COALESCE(p.vat_rate, 0) / 100.0))::INT
                           ),
       vat_vnd           = COALESCE(
                             i.vat_vnd,
                             p.amount_vnd
                               - FLOOR(p.amount_vnd / (1 + COALESCE(p.vat_rate, 0) / 100.0))::INT
                           )
  FROM center_settings cs, payments p
 WHERE cs.id = 1
   AND p.id = i.payment_id;
