-- A court that costs 2,000đ an hour, for rehearsing a real payment.
--
-- payOS has no sandbox: the only way to watch money actually move is to move
-- some. Every real court here is priced between 140,000đ and 500,000đ, which
-- is a lot to spend proving that a QR code works — and the alternative people
-- reach for, editing a real court's price down and back up again, leaves the
-- price book wrong for as long as the test takes and wrong permanently if
-- anybody forgets the second half.
--
-- So this is a real court with a real price rule. Nothing in the application
-- knows it exists: booking it goes through the same `lookupPrice`, the same
-- member discount, the same hold, the same payment and the same invoice as
-- every other court. That is the point — a rehearsal is only worth anything if
-- it runs the machinery it is rehearsing.
--
-- Why 2,000đ survives the discount: `applyDiscount` rounds to the nearest
-- `round_vnd` (1,000), and the largest plan discount is 20%. 2,000 × 0.8 =
-- 1,600, which rounds back to 2,000. Every member, on every plan, pays exactly
-- 2,000đ here — so the figure on the QR is never a surprise.

INSERT INTO courts (id, court_code, sport, status, convertible)
VALUES ('00000000-0000-0000-0000-0000000000d0'::uuid, 'DEMO-01', 'badminton', 'ready', false)
ON CONFLICT (id) DO NOTHING;

-- Covers the whole opening day (06:00–22:00) on both kinds of day, so the
-- rehearsal works whenever somebody gets round to it. Court-specific rules win
-- over the sport-wide ones in `lookupPrice`, so this does not touch the real
-- badminton price book.
INSERT INTO price_rules (sport, court_id, day_kind, start_local, end_local, price_vnd, is_peak)
SELECT 'badminton', '00000000-0000-0000-0000-0000000000d0'::uuid, d.kind, '06:00', '22:00', 2000, false
  FROM (VALUES ('weekday'), ('weekend')) AS d(kind)
 WHERE NOT EXISTS (
   SELECT 1 FROM price_rules
    WHERE court_id = '00000000-0000-0000-0000-0000000000d0'::uuid
      AND day_kind = d.kind
 );
