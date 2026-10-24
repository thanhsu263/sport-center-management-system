-- 0026_fix_payment_codes.sql — 0025 stored PAY-FF1006CL0118.
--
-- The booking code is CRT-F1006CL0118. 'PAY-F' || substr(that, 5) keeps the
-- F, so the receipt is not a document number and the till cannot read it.
-- Rewrite those rows to PAY-YYYYMMDD-9xxx from the day the money was taken.
-- The 9xxx band stays clear of next_doc_code. A database whose 0025 already
-- emits that shape matches nothing here.
--
-- ponytail: one calendar day of these rows must stay under 1000, or the suffix
-- grows past 4 digits. varchar(24) still holds it; next_doc_code still does
-- not, until a real day reaches 9000 receipts.

UPDATE payments p
SET code = f.new_code
FROM (
  SELECT id,
         'PAY-' || to_char(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYYMMDD')
           || '-' || lpad((9000 + row_number() OVER (
             PARTITION BY (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
             ORDER BY created_at, id
           ))::text, 4, '0') AS new_code
  FROM payments
  WHERE code LIKE 'PAY-F%'
) f
WHERE p.id = f.id;
