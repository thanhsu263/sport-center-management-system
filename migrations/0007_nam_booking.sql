-- Nam's CL-04 20:00 booking (quota) — timezone-safe. Idempotent.
DO $$
DECLARE
  bid UUID;
  oid UUID;
  court UUID := '10000000-0000-0000-0000-000000000004';
  d date := (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  t0 TIMESTAMPTZ;
BEGIN
  t0 := (d::timestamp + interval '20 hours') AT TIME ZONE 'Asia/Ho_Chi_Minh';
  IF t0 <= now() THEN
    d := d + 1;
    t0 := (d::timestamp + interval '20 hours') AT TIME ZONE 'Asia/Ho_Chi_Minh';
  END IF;
  IF EXISTS (
    SELECT 1 FROM court_bookings
    WHERE user_id = '00000000-0000-0000-0000-000000000101' AND start_at = t0
  ) THEN
    RETURN;
  END IF;
  bid := gen_random_uuid();
  oid := occupancy_attach(court, t0, t0 + interval '1 hour', 'booking', bid, NULL);
  INSERT INTO court_bookings (
    id, code, court_id, user_id, start_at, end_at, status, channel,
    price_vnd, discount_pct, vat_rate, occupancy_id, quota_hours
  ) VALUES (
    bid, 'CRT-DEMO-NAM-2000', court,
    '00000000-0000-0000-0000-000000000101',
    t0, t0 + interval '1 hour', 'confirmed', 'app',
    140000, 15, 0, oid, 1
  );
  UPDATE subscriptions
     SET court_hours_left = GREATEST(court_hours_left - 1, 0)
   WHERE id = '21000000-0000-0000-0000-000000000101'
     AND court_hours_left >= 1;
  INSERT INTO payments (code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by)
  VALUES ('PAY-DEMO-NAM-Q01', '00000000-0000-0000-0000-000000000101',
          'quota', 0, 0, 'posted', 'booking', bid,
          '00000000-0000-0000-0000-000000000002')
  ON CONFLICT (code) DO NOTHING;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Nam booking: %', SQLERRM;
END $$;
