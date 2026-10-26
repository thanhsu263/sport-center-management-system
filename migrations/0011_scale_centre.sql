-- 0011_scale_centre.sql — two jobs.
--
-- 1. Indexes for the read paths the app hits on every screen. Up to now the
--    tables were small enough that a sequential scan was free; at the volume
--    seeded below they are not.
-- 2. Grow the demo centre from 10 courts / 10 members to 16 courts / 50, with
--    a month of trading behind it so the manager reports have something to
--    draw and the court map is not mostly empty.
--
-- Everything here is idempotent and additive: fixed UUIDs with ON CONFLICT DO
-- NOTHING, existence checks before generated rows, and savepointed EXCEPTION
-- blocks around anything that goes through occupancy_attach (which legitimately
-- refuses a slot that is already taken).
--
-- Members are seeded with unaccented names so `name_normalized` is just
-- lower(full_name) — there is no unaccent extension in PGLite, and a wrong
-- normalisation would quietly break the front-desk member search.

-- ---------------------------------------------------------------- indexes ---

-- `/me` today-bookings, member page history, desk lookups.
CREATE INDEX IF NOT EXISTS court_bookings_user_start_idx ON court_bookings (user_id, start_at);
CREATE INDEX IF NOT EXISTS court_bookings_start_idx ON court_bookings (start_at);
CREATE INDEX IF NOT EXISTS court_bookings_court_start_idx ON court_bookings (court_id, start_at);

-- `/me` subscriptions, plan screens, the debt view.
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions (user_id);

-- `/me` enrollments and class rosters. (class_id, user_id) is already unique,
-- so only the user-first direction is missing.
CREATE INDEX IF NOT EXISTS enrollments_user_idx ON enrollments (user_id);
CREATE INDEX IF NOT EXISTS waitlist_offers_enrollment_idx ON waitlist_offers (enrollment_id);

-- Session lists: coach schedule, class detail, "today" on the member home.
-- (class_id, start_at) is already unique from the table definition.
CREATE INDEX IF NOT EXISTS sessions_start_idx ON sessions (start_at);
CREATE INDEX IF NOT EXISTS sessions_court_start_idx ON sessions (court_id, start_at);
CREATE INDEX IF NOT EXISTS coach_occupancies_coach_start_idx ON coach_occupancies (coach_id, start_at);

-- Revenue report (date range) and receipt lookups.
CREATE INDEX IF NOT EXISTS payments_created_idx ON payments (created_at);
CREATE INDEX IF NOT EXISTS payments_user_idx ON payments (user_id);
CREATE INDEX IF NOT EXISTS payments_ref_idx ON payments (ref_type, ref_id);

-- The inbox view is outbox filtered by user and ordered by sent_at desc.
CREATE INDEX IF NOT EXISTS outbox_user_sent_idx ON outbox (user_id, sent_at DESC);

-- Audit list is "most recent first".
CREATE INDEX IF NOT EXISTS audit_logs_at_idx ON audit_logs (at DESC);

-- ----------------------------------------------------------------- courts ---
-- Four more badminton courts and a second convertible pair (BR-02 ↔ BC-02).
-- The pair references each other inside one statement on purpose: foreign keys
-- are checked at end of statement, which is how the BR-01/BC-01 pair is seeded.
INSERT INTO courts (id, court_code, sport, status, convertible, pair_court_id) VALUES
  ('10000000-0000-0000-0000-000000000009', 'CL-09', 'badminton',  'ready', false, NULL),
  ('10000000-0000-0000-0000-000000000012', 'CL-10', 'badminton',  'ready', false, NULL),
  ('10000000-0000-0000-0000-000000000013', 'CL-11', 'badminton',  'ready', false, NULL),
  ('10000000-0000-0000-0000-000000000014', 'CL-12', 'badminton',  'ready', false, NULL),
  ('10000000-0000-0000-0000-000000000015', 'BR-02', 'basketball', 'ready', true,  '10000000-0000-0000-0000-000000000016'),
  ('10000000-0000-0000-0000-000000000016', 'BC-02', 'volleyball', 'ready', true,  '10000000-0000-0000-0000-000000000015')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------- members ---
-- Forty more members (ids …111–…150). Same seeded password as every demo
-- account.
--
-- Member codes come from `next_member_code()` rather than being spelled out:
-- a database that has been open for sign-ups has already issued codes past
-- A3-2026-0010 from the shared counter, and a literal code walks straight into
-- `users_member_code_key`. Phone numbers and e-mails can collide the same way,
-- so each row is inserted on its own and a clash just drops that one member —
-- every block below reads the member list back out of `users`, so a centre
-- with 48 seeded members is as consistent as one with 50.
DO $$
DECLARE
  n INT;
  surnames TEXT[] := ARRAY['Nguyen','Tran','Le','Pham','Hoang','Phan','Vu','Dang','Bui','Do'];
  middles  TEXT[] := ARRAY['Van','Thi','Minh','Quoc'];
  givens   TEXT[] := ARRAY['An','Binh','Chi','Dung','Giang','Ha','Khanh','Linh','Mai','Nam','Phuc','Quynh'];
  v_name TEXT;
BEGIN
  FOR n IN 111..150 LOOP
    v_name := surnames[1 + (n % 10)] || ' ' || middles[1 + (n % 4)] || ' ' || givens[1 + (n % 12)];
    BEGIN
    INSERT INTO users (
      id, member_code, full_name, name_normalized, phone, email,
      role, status, password_hash, must_change_password,
      date_of_birth, pii_consent_at, created_at
    ) VALUES (
      ('00000000-0000-0000-0000-000000000' || lpad(n::text, 3, '0'))::uuid,
      next_member_code(),
      v_name,
      lower(v_name),
      '+84901230' || lpad(n::text, 3, '0'),
      'member' || n || '@example.com',
      'member', 'active',
      'scrypt$16384$8$1$YXJlbmEzLXNlZWQtc2FsdDAx$axaSnV-o4ii8w0VPbDo0H8xnqyciiffPfWSOqPngAxA',
      false,
      (DATE '1990-01-01' + ((n * 97) % 4000))::date,
      now(),
      now() - ((n - 110) * interval '3 days')
    )
    ON CONFLICT (id) DO NOTHING;
    EXCEPTION WHEN unique_violation THEN CONTINUE;
    END;
  END LOOP;
END $$;

-- --------------------------------------------- subscriptions and receipts ---
-- One live plan each, cycling through the catalogue, sold on a day inside the
-- last 30 so the revenue report has a month of subscription income.
DO $$
DECLARE
  n INT;
  v_plan RECORD;
  plans UUID[] := ARRAY[
    '20000000-0000-0000-0000-000000000001'::uuid,  -- All-access 30
    '20000000-0000-0000-0000-000000000002'::uuid,  -- Badminton 30
    '20000000-0000-0000-0000-000000000004'::uuid,  -- Basketball 30
    '20000000-0000-0000-0000-000000000005'::uuid,  -- Volleyball 30
    '20000000-0000-0000-0000-000000000003'::uuid,  -- Badminton 10 sessions
    '20000000-0000-0000-0000-000000000006'::uuid   -- All-access 90
  ];
  methods pay_method[] := ARRAY['cash','transfer','card','gateway']::pay_method[];
  v_sub UUID;
  v_pay UUID;
  v_start DATE;
  v_sold TIMESTAMPTZ;
BEGIN
  FOR n IN 111..150 LOOP
    v_sub := ('21000000-0000-0000-0000-000000000' || lpad(n::text, 3, '0'))::uuid;
    CONTINUE WHEN EXISTS (SELECT 1 FROM subscriptions WHERE id = v_sub);

    SELECT * INTO v_plan FROM membership_plans WHERE id = plans[1 + (n % 6)];
    CONTINUE WHEN NOT FOUND;

    -- Sold somewhere in the last 29 days, at a plausible hour of the day.
    v_start := CURRENT_DATE - ((n * 7) % 29);
    v_sold := (v_start::timestamp + ((9 + (n % 10)) * interval '1 hour')) AT TIME ZONE 'Asia/Ho_Chi_Minh';

    BEGIN
      INSERT INTO subscriptions (
        id, user_id, plan_id, sport_scope, start_on, end_on, status,
        court_hours_left, session_left
      ) VALUES (
        v_sub,
        ('00000000-0000-0000-0000-000000000' || lpad(n::text, 3, '0'))::uuid,
        v_plan.id,
        v_plan.sport_scope,
        v_start,
        v_start + COALESCE(v_plan.duration_days, 90),
        'active',
        GREATEST(v_plan.court_hours - (n % 3), 0),
        CASE WHEN v_plan.session_quota IS NULL THEN NULL
             ELSE GREATEST(v_plan.session_quota - (n % 4), 0) END
      );
    EXCEPTION WHEN OTHERS THEN
      -- A member already carrying a live plan for this scope: skip, don't fail.
      CONTINUE;
    END;

    v_pay := ('22000000-0000-0000-0000-000000000' || lpad(n::text, 3, '0'))::uuid;
    INSERT INTO payments (
      id, code, user_id, method, amount_vnd, vat_rate, status,
      ref_type, ref_id, created_by, created_at
    ) VALUES (
      v_pay,
      'PAY-SUB-' || lpad(n::text, 3, '0'),
      ('00000000-0000-0000-0000-000000000' || lpad(n::text, 3, '0'))::uuid,
      methods[1 + (n % 4)],
      v_plan.price_vnd,
      0, 'posted', 'subscription', v_sub,
      '00000000-0000-0000-0000-000000000002',
      v_sold
    )
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO invoices (code, payment_id, buyer_name, issued_at)
    SELECT 'INV-SUB-' || lpad(n::text, 3, '0'), v_pay, u.full_name, v_sold
      FROM users u
     WHERE u.id = ('00000000-0000-0000-0000-000000000' || lpad(n::text, 3, '0'))::uuid
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.payment_id = v_pay);

    INSERT INTO outbox (channel, template, user_id, payload, dedupe_key, sent_at)
    VALUES (
      'inapp', 'payment_receipt',
      ('00000000-0000-0000-0000-000000000' || lpad(n::text, 3, '0'))::uuid,
      jsonb_build_object('plan', v_plan.name, 'amount_vnd', v_plan.price_vnd),
      'seed-0011-receipt-' || n,
      v_sold
    )
    ON CONFLICT (dedupe_key) DO NOTHING;
  END LOOP;
END $$;

-- ---------------------------------------------------------------- classes ---
-- Six more classes, spread across the new courts and every coach, so the
-- timetable covers all seven days instead of clustering on two.
INSERT INTO classes (
  id, sport, level, coach_id, assistant_id, court_id,
  capacity, enrolled_count, rrule, duration_min, start_on, end_on, status
) VALUES
  ('30000000-0000-0000-0000-000000000007', 'badminton', 'beginner',
   '00000000-0000-0000-0000-000000000003', NULL,
   '10000000-0000-0000-0000-000000000009',
   14, 0, 'FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=17', 90,
   CURRENT_DATE - 30, CURRENT_DATE + 120, 'open'),
  ('30000000-0000-0000-0000-000000000008', 'badminton', 'intermediate',
   '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000012',
   '10000000-0000-0000-0000-000000000012',
   14, 0, 'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=19', 90,
   CURRENT_DATE - 30, CURRENT_DATE + 120, 'open'),
  ('30000000-0000-0000-0000-000000000009', 'badminton', 'advanced',
   '00000000-0000-0000-0000-000000000012', NULL,
   '10000000-0000-0000-0000-000000000013',
   12, 0, 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=15', 90,
   CURRENT_DATE - 30, CURRENT_DATE + 120, 'open'),
  ('30000000-0000-0000-0000-000000000010', 'badminton', 'beginner',
   '00000000-0000-0000-0000-000000000011', NULL,
   '10000000-0000-0000-0000-000000000014',
   16, 0, 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=10', 90,
   CURRENT_DATE - 30, CURRENT_DATE + 120, 'open'),
  ('30000000-0000-0000-0000-000000000011', 'basketball', 'intermediate',
   '00000000-0000-0000-0000-000000000013', NULL,
   '10000000-0000-0000-0000-000000000015',
   16, 0, 'FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=19', 90,
   CURRENT_DATE - 30, CURRENT_DATE + 120, 'open'),
  ('30000000-0000-0000-0000-000000000012', 'volleyball', 'beginner',
   '00000000-0000-0000-0000-000000000014', NULL,
   '10000000-0000-0000-0000-000000000016',
   14, 0, 'FREQ=WEEKLY;BYDAY=WE,SU;BYHOUR=17', 90,
   CURRENT_DATE - 30, CURRENT_DATE + 120, 'open')
ON CONFLICT (id) DO NOTHING;

-- Materialise sessions for the next 14 days for every open class (the six new
-- ones and the six from 0006/0009 — the latter are no-ops, their rows exist).
DO $$
DECLARE
  r RECORD;
  d DATE;
  v_start TIMESTAMPTZ;
  v_end   TIMESTAMPTZ;
  sid UUID;
  oid UUID;
  bydays TEXT[];
  dow INT;
  hh INT;
  match BOOLEAN;
BEGIN
  FOR r IN SELECT * FROM classes WHERE status = 'open' LOOP
    bydays := regexp_split_to_array(regexp_replace(r.rrule, '.*BYDAY=([A-Z,]+).*', '\1'), ',');
    hh := (regexp_replace(r.rrule, '.*BYHOUR=([0-9]+).*', '\1'))::INT;
    FOR d IN SELECT generate_series(CURRENT_DATE, CURRENT_DATE + 13, interval '1 day')::date LOOP
      dow := EXTRACT(ISODOW FROM d)::INT;
      match := dow IN (
        SELECT CASE v
          WHEN 'MO' THEN 1 WHEN 'TU' THEN 2 WHEN 'WE' THEN 3
          WHEN 'TH' THEN 4 WHEN 'FR' THEN 5 WHEN 'SA' THEN 6
          WHEN 'SU' THEN 7
        END
        FROM unnest(bydays) AS v
      );
      CONTINUE WHEN NOT match;
      v_start := (d::timestamp + (hh * interval '1 hour')) AT TIME ZONE 'Asia/Ho_Chi_Minh';
      v_end := v_start + (r.duration_min * interval '1 minute');
      CONTINUE WHEN v_start <= now();
      CONTINUE WHEN EXISTS (SELECT 1 FROM sessions s WHERE s.class_id = r.id AND s.start_at = v_start);
      sid := gen_random_uuid();
      BEGIN
        oid := occupancy_attach(r.court_id, v_start, v_end, 'session', sid, NULL);
        INSERT INTO sessions (id, class_id, court_id, start_at, end_at, status, occupancy_id)
        VALUES (sid, r.id, r.court_id, v_start, v_end, 'scheduled', oid);
        INSERT INTO coach_occupancies (coach_id, session_id, start_at, end_at)
        VALUES (r.coach_id, sid, v_start, v_end);
        IF r.assistant_id IS NOT NULL THEN
          INSERT INTO coach_occupancies (coach_id, session_id, start_at, end_at)
          VALUES (r.assistant_id, sid, v_start, v_end);
        END IF;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Skipped session % %: %', r.id, v_start, SQLERRM;
      END;
    END LOOP;
  END LOOP;
END $$;

-- ------------------------------------------------------------ enrollments ---
-- Fill every open class to two seats short of capacity, walking the member list
-- with a per-class offset so rosters differ instead of being the same faces.
DO $$
DECLARE
  r RECORD;
  members UUID[];
  total INT;
  idx INT;
  taken INT;
  guard INT;
BEGIN
  SELECT array_agg(id ORDER BY member_code) INTO members
    FROM users WHERE role = 'member' AND status = 'active';
  total := COALESCE(array_length(members, 1), 0);
  IF total = 0 THEN RETURN; END IF;

  idx := 0;
  FOR r IN SELECT * FROM classes WHERE status = 'open' ORDER BY id LOOP
    guard := 0;
    LOOP
      SELECT enrolled_count INTO taken FROM classes WHERE id = r.id;
      EXIT WHEN taken >= GREATEST(r.capacity - 2, 1);
      EXIT WHEN guard >= total;           -- every member already tried
      guard := guard + 1;
      idx := idx + 1;
      BEGIN
        PERFORM enrollment_confirm(r.id, members[1 + (idx % total)]);
      EXCEPTION WHEN OTHERS THEN
        NULL;                             -- already enrolled, or class filled up
      END;
    END LOOP;
  END LOOP;
END $$;

-- ------------------------------------------------ a month of court trading ---
-- Completed bookings for the last 30 days. Completed rows carry no occupancy by
-- design (booking_occ_sync), so this back-fill can never collide with a live
-- slot — it is pure trading history for the revenue report.
DO $$
DECLARE
  d DATE;
  i INT;
  seq INT;
  hh INT;
  v_court RECORD;
  v_courts UUID[];
  total INT;
  members UUID[];
  m_total INT;
  bid UUID;
  v_price INT;
  v_status booking_status;
  v_method pay_method;
  v_quota NUMERIC(4,1);
  v_at TIMESTAMPTZ;
  per_day INT;
BEGIN
  SELECT array_agg(id ORDER BY court_code) INTO v_courts FROM courts WHERE status = 'ready';
  SELECT array_agg(id ORDER BY member_code) INTO members
    FROM users WHERE role = 'member' AND status = 'active';
  total := COALESCE(array_length(v_courts, 1), 0);
  m_total := COALESCE(array_length(members, 1), 0);
  IF total = 0 OR m_total = 0 THEN RETURN; END IF;

  seq := 0;
  FOR d IN SELECT generate_series(CURRENT_DATE - 29, CURRENT_DATE, interval '1 day')::date LOOP
    -- Busier at the weekend, like the real thing.
    per_day := CASE WHEN EXTRACT(ISODOW FROM d)::INT >= 6 THEN 14 ELSE 8 END;
    FOR i IN 1..per_day LOOP
      seq := seq + 1;
      hh := 6 + ((i * 3 + EXTRACT(DAY FROM d)::INT) % 15);   -- 06:00–20:00
      v_at := (d::timestamp + (hh * interval '1 hour')) AT TIME ZONE 'Asia/Ho_Chi_Minh';
      CONTINUE WHEN v_at >= now();                            -- history only

      SELECT * INTO v_court FROM courts WHERE id = v_courts[1 + (seq % total)];
      v_price := CASE v_court.sport
        WHEN 'badminton'  THEN CASE WHEN hh >= 17 THEN 140000 ELSE  80000 END
        WHEN 'basketball' THEN CASE WHEN hh >= 17 THEN 500000 ELSE 300000 END
        ELSE                   CASE WHEN hh >= 17 THEN 400000 ELSE 250000 END
      END;
      v_status := CASE
        WHEN seq % 23 = 0 THEN 'cancelled'
        WHEN seq % 19 = 0 THEN 'no_show'
        ELSE 'completed'
      END::booking_status;

      bid := gen_random_uuid();
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM court_bookings
         WHERE code = 'CRT-' || to_char(d, 'YYYYMMDD') || '-H' || lpad(seq::text, 3, '0')
      );

      -- Every fifth booking is drawn from a membership quota: no cash, but the
      -- hours still show up under "quota" in the revenue report.
      v_quota := CASE WHEN seq % 5 = 0 THEN 1 ELSE 0 END;
      v_method := CASE WHEN v_quota > 0 THEN 'quota'
                       ELSE (ARRAY['cash','transfer','card','gateway']::pay_method[])[1 + (seq % 4)] END;

      INSERT INTO court_bookings (
        id, code, court_id, user_id, start_at, end_at, status, channel,
        price_vnd, discount_pct, vat_rate, occupancy_id, quota_hours
      ) VALUES (
        bid,
        'CRT-' || to_char(d, 'YYYYMMDD') || '-H' || lpad(seq::text, 3, '0'),
        v_court.id,
        members[1 + (seq % m_total)],
        v_at, v_at + interval '1 hour',
        v_status,
        CASE WHEN seq % 3 = 0 THEN 'desk' ELSE 'app' END,
        CASE WHEN v_quota > 0 THEN 0 ELSE v_price END,
        0, 0, NULL, v_quota
      );

      CONTINUE WHEN v_status = 'cancelled';

      INSERT INTO payments (
        code, user_id, method, amount_vnd, vat_rate, status,
        ref_type, ref_id, created_by, created_at
      ) VALUES (
        'PAY-' || to_char(d, 'YYYYMMDD') || '-H' || lpad(seq::text, 3, '0'),
        members[1 + (seq % m_total)],
        v_method,
        CASE WHEN v_quota > 0 THEN 0 ELSE v_price END,
        0, 'posted', 'booking', bid,
        '00000000-0000-0000-0000-000000000002',
        v_at
      )
      ON CONFLICT (code) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

-- ------------------------------------------------------ live court traffic ---
-- Confirmed bookings from now to the end of next week (book_ahead_days is 7),
-- walked court by court and hour by hour so the grid fills the way a real
-- centre does: evenings busy, mornings quiet. These take occupancy, so each row
-- is savepointed — a clash with a class session is simply skipped.
DO $$
DECLARE
  d DATE;
  hh INT;
  seq INT := 0;
  v_court RECORD;
  v_members UUID[];
  m_total INT;
  bid UUID;
  oid UUID;
  v_price INT;
  v_at TIMESTAMPTZ;
  v_paid TIMESTAMPTZ;
  v_code TEXT;
BEGIN
  SELECT array_agg(id ORDER BY member_code) INTO v_members
    FROM users WHERE role = 'member' AND status = 'active';
  m_total := COALESCE(array_length(v_members, 1), 0);
  IF m_total = 0 THEN RETURN; END IF;

  FOR d IN SELECT generate_series(CURRENT_DATE, CURRENT_DATE + 6, interval '1 day')::date LOOP
    FOR v_court IN SELECT * FROM courts WHERE status = 'ready' ORDER BY court_code LOOP
      FOR hh IN 6..20 LOOP
        seq := seq + 1;
        v_at := (d::timestamp + (hh * interval '1 hour')) AT TIME ZONE 'Asia/Ho_Chi_Minh';
        CONTINUE WHEN v_at <= now();

        -- Is this slot sold? Roughly 6 in 10 evening slots, 3 in 10 during the
        -- day. Genuinely random rather than a hash of the counters: any cheap
        -- arithmetic mixer over two variables that move together (seq advances
        -- with hh) collapses to a constant per court, and the grid comes out in
        -- solid stripes — whole courts booked solid next to whole courts empty.
        CONTINUE WHEN random() >= (CASE WHEN hh >= 17 THEN 0.6 ELSE 0.28 END);

        v_code := to_char(d, 'YYYYMMDD') || '-U' || lpad(seq::text, 4, '0');
        CONTINUE WHEN EXISTS (SELECT 1 FROM court_bookings WHERE code = 'CRT-' || v_code);

        v_price := CASE v_court.sport
          WHEN 'badminton'  THEN CASE WHEN hh >= 17 THEN 140000 ELSE  80000 END
          WHEN 'basketball' THEN CASE WHEN hh >= 17 THEN 500000 ELSE 300000 END
          ELSE                   CASE WHEN hh >= 17 THEN 400000 ELSE 250000 END
        END;
        -- Paid when the slot was booked, not all at once this second: a week of
        -- advance sales landing on today would tower over every other bar in the
        -- revenue chart.
        v_paid := now() - ((seq % 14) * interval '1 day') - ((seq % 90) * interval '7 minutes');

        bid := gen_random_uuid();
        BEGIN
          oid := occupancy_attach(v_court.id, v_at, v_at + interval '1 hour', 'booking', bid, NULL);
          INSERT INTO court_bookings (
            id, code, court_id, user_id, start_at, end_at, status, channel,
            price_vnd, discount_pct, vat_rate, occupancy_id, quota_hours
          ) VALUES (
            bid, 'CRT-' || v_code, v_court.id,
            v_members[1 + (seq % m_total)],
            v_at, v_at + interval '1 hour', 'confirmed',
            CASE WHEN seq % 3 = 0 THEN 'desk' ELSE 'app' END,
            v_price, 0, 0, oid, 0
          );
          INSERT INTO payments (
            code, user_id, method, amount_vnd, vat_rate, status,
            ref_type, ref_id, created_by, created_at
          ) VALUES (
            'PAY-' || v_code,
            v_members[1 + (seq % m_total)],
            (ARRAY['cash','transfer','card','gateway']::pay_method[])[1 + (seq % 4)],
            v_price, 0, 'posted', 'booking', bid,
            '00000000-0000-0000-0000-000000000002',
            v_paid
          );
          INSERT INTO outbox (channel, template, user_id, payload, dedupe_key, sent_at)
          VALUES (
            'inapp', 'booking_confirmed',
            v_members[1 + (seq % m_total)],
            jsonb_build_object('court', v_court.court_code, 'start_at', v_at),
            'seed-0011-booking-' || v_code,
            v_paid
          )
          ON CONFLICT (dedupe_key) DO NOTHING;
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'Skipped booking % %: %', v_court.court_code, v_at, SQLERRM;
        END;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;
