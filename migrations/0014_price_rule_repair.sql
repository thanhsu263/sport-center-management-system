-- Fixes P0 #1 from the 2026-09-27 live-check report: badminton/basketball/
-- volleyball price rules were overwritten via PUT /v1/price-rules with
-- vandalized values (99,999,999đ, 100,000,004đ, 0đ). Every row in
-- price_rules is fully determined by (sport, day_kind, time band), so the
-- safe repair is to replace the whole table with the known-good matrix
-- rather than patch individual rows whose state after the tampering isn't
-- fully known (a bad PUT can delete/replace rows the report never listed).
--
-- These are the same figures 0003_seed.sql shipped with; deploying this file
-- through the normal build/migrate pipeline (not a hand-run UPDATE against
-- the live database) so the fix is versioned and reviewable like any other
-- change.

DELETE FROM price_rules;

INSERT INTO price_rules (sport, day_kind, start_local, end_local, price_vnd, is_peak) VALUES
  ('badminton', 'weekday', '06:00', '17:00', 80000, false),
  ('badminton', 'weekday', '17:00', '22:00', 140000, true),
  ('badminton', 'weekend', '06:00', '08:00', 80000, false),
  ('badminton', 'weekend', '08:00', '22:00', 140000, true),
  ('basketball', 'weekday', '06:00', '17:00', 300000, false),
  ('basketball', 'weekday', '17:00', '22:00', 500000, true),
  ('basketball', 'weekend', '06:00', '08:00', 300000, false),
  ('basketball', 'weekend', '08:00', '22:00', 500000, true),
  ('volleyball', 'weekday', '06:00', '17:00', 250000, false),
  ('volleyball', 'weekday', '17:00', '22:00', 400000, true),
  ('volleyball', 'weekend', '06:00', '08:00', 250000, false),
  ('volleyball', 'weekend', '08:00', '22:00', 400000, true);

INSERT INTO price_rules (sport, day_kind, start_local, end_local, price_vnd, is_peak)
SELECT sport, 'holiday', start_local, end_local, price_vnd, is_peak
FROM price_rules WHERE day_kind = 'weekend';

-- Database-layer backstop for BR-34B: even if the API check in
-- priceRulesPut() is ever bypassed, no row can reach the table outside
-- (0, 5,000,000] đ per slot — ten times the dearest real rule above
-- (basketball peak, 500,000đ), and nowhere near the old vandalized values.
ALTER TABLE price_rules ADD CONSTRAINT price_rules_bound_chk
  CHECK (price_vnd > 0 AND price_vnd <= 5000000);
