-- seed.sql — Arena3 SDD 0.3 + demo coach/member so the preview is playable.
-- Manager login: +84900000001 / ChangeMe!a3 (cũng chấp nhận 0900000001)
-- Hash = scrypt of ChangeMe!a3 (app-side; no pgcrypto in preview).

INSERT INTO users (id, full_name, name_normalized, phone, email, role, status, password_hash, pii_consent_at, member_code)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Quản lý Arena3',
  'quan ly arena3',
  '+84900000001',
  'manager@arena3.local',
  'manager',
  'active',
  'scrypt$16384$8$1$YXJlbmEzLXNlZWQtc2FsdDAx$axaSnV-o4ii8w0VPbDo0H8xnqyciiffPfWSOqPngAxA',
  now(),
  NULL
) ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, full_name, name_normalized, phone, role, status, password_hash, pii_consent_at)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  'Lễ tân ca 1',
  'le tan ca 1',
  '+84900000002',
  'receptionist',
  'active',
  'scrypt$16384$8$1$YXJlbmEzLXNlZWQtc2FsdDAx$axaSnV-o4ii8w0VPbDo0H8xnqyciiffPfWSOqPngAxA',
  now()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, full_name, name_normalized, phone, email, role, status, password_hash, pii_consent_at)
VALUES (
  '00000000-0000-0000-0000-000000000003',
  'HLV Minh Quân',
  'hlv minh quan',
  '+84900000003',
  'coach@arena3.local',
  'coach',
  'active',
  'scrypt$16384$8$1$YXJlbmEzLXNlZWQtc2FsdDAx$axaSnV-o4ii8w0VPbDo0H8xnqyciiffPfWSOqPngAxA',
  now()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, member_code, full_name, name_normalized, phone, email, role, status, password_hash, pii_consent_at, date_of_birth)
VALUES (
  '00000000-0000-0000-0000-000000000004',
  'A3-2026-0001',
  'Nguyễn Thanh Hà',
  'nguyen thanh ha',
  '+84900000004',
  'ha@arena3.local',
  'member',
  'active',
  'scrypt$16384$8$1$YXJlbmEzLXNlZWQtc2FsdDAx$axaSnV-o4ii8w0VPbDo0H8xnqyciiffPfWSOqPngAxA',
  now(),
  '1996-04-12'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO coach_sports (user_id, sport) VALUES
  ('00000000-0000-0000-0000-000000000003', 'badminton')
ON CONFLICT DO NOTHING;

INSERT INTO courts (id, court_code, sport, status, convertible, pair_court_id) VALUES
  ('10000000-0000-0000-0000-000000000001', 'CL-01', 'badminton', 'ready', false, NULL),
  ('10000000-0000-0000-0000-000000000002', 'CL-02', 'badminton', 'ready', false, NULL),
  ('10000000-0000-0000-0000-000000000003', 'CL-03', 'badminton', 'ready', false, NULL),
  ('10000000-0000-0000-0000-000000000004', 'CL-04', 'badminton', 'ready', false, NULL),
  ('10000000-0000-0000-0000-000000000005', 'CL-05', 'badminton', 'ready', false, NULL),
  ('10000000-0000-0000-0000-000000000006', 'CL-06', 'badminton', 'ready', false, NULL),
  ('10000000-0000-0000-0000-000000000007', 'CL-07', 'badminton', 'ready', false, NULL),
  ('10000000-0000-0000-0000-000000000008', 'CL-08', 'badminton', 'ready', false, NULL),
  ('10000000-0000-0000-0000-000000000010', 'BR-01', 'basketball', 'ready', true, '10000000-0000-0000-0000-000000000011'),
  ('10000000-0000-0000-0000-000000000011', 'BC-01', 'volleyball', 'ready', true, '10000000-0000-0000-0000-000000000010')
ON CONFLICT (id) DO NOTHING;

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

INSERT INTO membership_plans (id, name, sport_scope, duration_days, session_quota, court_hours, court_discount_pct, price_vnd, is_on_sale) VALUES
  ('20000000-0000-0000-0000-000000000001', 'All-access 30 ngày', 'all', 30, NULL, 4, 15, 1500000, true),
  ('20000000-0000-0000-0000-000000000002', 'Cầu lông 30 ngày', 'badminton', 30, NULL, 2, 20, 800000, true),
  ('20000000-0000-0000-0000-000000000003', 'Cầu lông 10 buổi', 'badminton', NULL, 10, 0, 10, 1200000, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO subscriptions (id, user_id, plan_id, sport_scope, start_on, end_on, status, court_hours_left)
VALUES (
  '30000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000004',
  '20000000-0000-0000-0000-000000000002',
  'badminton',
  (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 5,
  (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 25,
  'active',
  2
) ON CONFLICT (id) DO NOTHING;

INSERT INTO payments (id, code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by)
VALUES (
  '40000000-0000-0000-0000-000000000001',
  'PAY-SEED-0001',
  '00000000-0000-0000-0000-000000000004',
  'cash',
  800000,
  0,
  'posted',
  'subscription',
  '30000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO invoices (id, code, payment_id, buyer_name)
VALUES (
  '50000000-0000-0000-0000-000000000001',
  'INV-SEED-0001',
  '40000000-0000-0000-0000-000000000001',
  'Nguyễn Thanh Hà'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO invoice_lines (invoice_id, description, qty, unit_vnd, amount_vnd)
VALUES (
  '50000000-0000-0000-0000-000000000001',
  'Cầu lông 30 ngày',
  1,
  800000,
  800000
);

INSERT INTO classes (
  id, sport, level, coach_id, court_id, capacity, enrolled_count,
  rrule, duration_min, start_on, end_on, status
) VALUES (
  '60000000-0000-0000-0000-000000000001',
  'badminton',
  'intermediate',
  '00000000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000008',
  12,
  1,
  'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18',
  90,
  (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
  (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 60,
  'open'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO enrollments (id, class_id, user_id, status)
VALUES (
  '70000000-0000-0000-0000-000000000001',
  '60000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000004',
  'confirmed'
) ON CONFLICT (class_id, user_id) DO NOTHING;

INSERT INTO code_counters(kind, yyyy, n) VALUES
  ('member', EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Ho_Chi_Minh'))::int, 1)
ON CONFLICT (kind, yyyy) DO NOTHING;

DO $$
DECLARE
  sid uuid;
  oid uuid;
  tstart timestamptz;
  tend timestamptz;
  v_class uuid := '60000000-0000-0000-0000-000000000001';
  v_court uuid := '10000000-0000-0000-0000-000000000008';
  v_coach uuid := '00000000-0000-0000-0000-000000000003';
BEGIN
  FOR tstart IN
    SELECT gs FROM generate_series(
      date_trunc('day', timezone('Asia/Ho_Chi_Minh', now())) + interval '18 hours',
      timezone('Asia/Ho_Chi_Minh', now()) + interval '14 days',
      interval '1 day'
    ) gs
    WHERE EXTRACT(DOW FROM gs) IN (1, 3, 5)
      AND (gs AT TIME ZONE 'Asia/Ho_Chi_Minh') > now()
  LOOP
    -- generate_series above is timestamp without tz in ICT wall clock; convert.
    tstart := tstart AT TIME ZONE 'Asia/Ho_Chi_Minh';
    tend := tstart + interval '90 minutes';
    sid := gen_random_uuid();
    BEGIN
      oid := occupancy_attach(v_court, tstart, tend, 'session', sid, NULL);
      INSERT INTO sessions (id, class_id, court_id, start_at, end_at, status, occupancy_id)
      VALUES (sid, v_class, v_court, tstart, tend, 'scheduled', oid)
      ON CONFLICT (class_id, start_at) DO NOTHING;
      INSERT INTO coach_occupancies (coach_id, session_id, start_at, end_at)
      VALUES (v_coach, sid, tstart, tend);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
END $$;
