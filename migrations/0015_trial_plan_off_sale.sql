-- Fixes P1 #3 from the 2026-09-27 live-check report: the "Trial (hidden)"
-- plan (0003/0006 seed: is_on_sale = false, price 0, meant to be invisible)
-- was found is_on_sale = true in production and appearing in GET /v1/plans
-- for ordinary members — a data drift from the seeded default, not a code
-- bug (plansList already filters on is_on_sale for non-managers).
--
-- Idempotent: re-applies the seeded default regardless of how the live row
-- drifted, and is safe to run whether or not the drift actually happened on
-- this database.
UPDATE membership_plans
   SET is_on_sale = false
 WHERE id = '20000000-0000-0000-0000-000000000008';
