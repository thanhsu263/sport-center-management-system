-- 0025_fill_calendar.sql — the bookable window had drained.
--
-- Confirmed bookings only live until their start time: the no-show sweep then
-- releases the court, so a week after the last seed the grid is bare and the
-- class timetable has only the sessions that were materialised on that day.
-- This refills what a centre actually shows: classes on their weekly hours for
-- the next fortnight, and a lived-in court map for the book-ahead week
-- (evenings busy, mornings quieter, clashes with a class simply skipped).
--
-- Idempotent. Court codes start with CRT-F. Receipts are PAY-YYYYMMDD-9xxx,
-- in the 9xxx band so they never meet next_doc_code. A past seed booking
-- marked no-show only because its hour arrived (code CRT-…-U…) is put back to
-- completed, except about one in twelve, so the no-show list still has something on it.

-- ---------------------------------------------------------------- classes ---
-- One session per open class on each of its weekdays, today through 14 days.
DO $$
DECLARE
  r RECORD;
  d DATE;
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  sid UUID;
  oid UUID;
  bydays TEXT[];
  dow INT;
  hh INT;
BEGIN
  FOR r IN SELECT * FROM classes WHERE status = 'open' LOOP
    bydays := regexp_split_to_array(regexp_replace(r.rrule, '.*BYDAY=([A-Z,]+).*', '\1'), ',');
    hh := (regexp_replace(r.rrule, '.*BYHOUR=([0-9]+).*', '\1'))::INT;
    FOR d IN SELECT generate_series(CURRENT_DATE, CURRENT_DATE + 14, interval '1 day')::date LOOP
      dow := EXTRACT(ISODOW FROM d)::INT;
      CONTINUE WHEN dow NOT IN (
        SELECT CASE v
          WHEN 'MO' THEN 1 WHEN 'TU' THEN 2 WHEN 'WE' THEN 3
          WHEN 'TH' THEN 4 WHEN 'FR' THEN 5 WHEN 'SA' THEN 6
          WHEN 'SU' THEN 7
        END
        FROM unnest(bydays) AS v
      );
      v_start := (d::timestamp + (hh * interval '1 hour')) AT TIME ZONE 'Asia/Ho_Chi_Minh';
      v_end := v_start + (r.duration_min * interval '1 minute');
      CONTINUE WHEN v_start <= now();
      CONTINUE WHEN v_start::date < r.start_on OR v_start::date > r.end_on;
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
        RAISE NOTICE '0025 session skipped % %: %', r.court_id, v_start, SQLERRM;
      END;
    END LOOP;
  END LOOP;
END $$;

-- --------------------------------------------------------------- rosters ---
-- A class under four-fifths full gets members until it reaches that, or until
-- the member list runs out. Already-full classes are left with their last seats.
DO $$
DECLARE
  cl RECORD;
  mem RECORD;
  n INT;
  target INT;
BEGIN
  FOR cl IN
    SELECT id, capacity, enrolled_count
      FROM classes
     WHERE status = 'open' AND enrolled_count * 5 < capacity * 4
  LOOP
    target := floor(cl.capacity * 0.8);
    n := cl.enrolled_count;
    FOR mem IN
      SELECT u.id
        FROM users u
       WHERE u.role = 'member' AND u.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM enrollments e
            WHERE e.class_id = cl.id AND e.user_id = u.id AND e.status = 'confirmed'
         )
       ORDER BY u.member_code
    LOOP
      EXIT WHEN n >= target;
      BEGIN
        PERFORM enrollment_confirm(cl.id, mem.id);
        n := n + 1;
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END LOOP;
  END LOOP;
END $$;

-- -------------------------------------------------------------- bookings ---
-- Next 7 days, every ready court, 06:00–21:00. The hash is the coin-flip, so
-- a second run asks for the same slots and the code check makes it a no-op.
DO $$
DECLARE
  d DATE;
  hh INT;
  v_court RECORD;
  members UUID[];
  m_total INT;
  bid UUID;
  oid UUID;
  v_at TIMESTAMPTZ;
  v_code TEXT;
  v_price INT;
  thresh INT;
  rec_id UUID := '00000000-0000-0000-0000-000000000002';
  v_pay TEXT;
  v_created TIMESTAMPTZ;
  pay_day DATE;
  pay_n INT := 0;
BEGIN
  SELECT array_agg(id ORDER BY member_code) INTO members
    FROM users WHERE role = 'member' AND status = 'active';
  m_total := COALESCE(array_length(members, 1), 0);
  IF m_total = 0 THEN RETURN; END IF;

  FOR d IN SELECT generate_series(CURRENT_DATE, CURRENT_DATE + 6, interval '1 day')::date LOOP
    FOR v_court IN SELECT id, court_code, sport FROM courts WHERE status = 'ready' ORDER BY court_code LOOP
      FOR hh IN 6..21 LOOP
        v_at := (d::timestamp + (hh * interval '1 hour')) AT TIME ZONE 'Asia/Ho_Chi_Minh';
        CONTINUE WHEN v_at <= now();
        thresh := CASE WHEN hh >= 17 THEN 7 WHEN hh >= 11 THEN 5 ELSE 3 END;
        CONTINUE WHEN abs(hashtext(v_court.court_code || to_char(d, 'YYYYMMDD') || hh::text)) % 10 >= thresh;

        v_code := 'CRT-F' || to_char(d, 'MMDD') || replace(v_court.court_code, '-', '') || lpad(hh::text, 2, '0');
        CONTINUE WHEN EXISTS (SELECT 1 FROM court_bookings WHERE code = v_code);

        v_price := CASE v_court.sport
          WHEN 'badminton'  THEN CASE WHEN hh >= 17 THEN 140000 ELSE  80000 END
          WHEN 'basketball' THEN CASE WHEN hh >= 17 THEN 500000 ELSE 300000 END
          ELSE                   CASE WHEN hh >= 17 THEN 400000 ELSE 250000 END
        END;

        -- ponytail: 9xxx stays clear of next_doc_code (tens per day). Collides
        -- only if one calendar day ever posts 9000 real receipts.
        v_created := least(v_at - interval '1 day', now());
        IF pay_day IS DISTINCT FROM (v_created AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN
          pay_day := (v_created AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
          pay_n := 0;
        END IF;
        pay_n := pay_n + 1;
        v_pay := 'PAY-' || to_char(pay_day, 'YYYYMMDD') || '-' || lpad((9000 + pay_n)::text, 4, '0');

        bid := gen_random_uuid();
        BEGIN
          oid := occupancy_attach(v_court.id, v_at, v_at + interval '1 hour', 'booking', bid, NULL);
          INSERT INTO court_bookings (
            id, code, court_id, user_id, start_at, end_at, status, channel,
            price_vnd, discount_pct, vat_rate, occupancy_id, quota_hours, paid_vnd
          ) VALUES (
            bid, v_code, v_court.id,
            members[1 + (abs(hashtext(v_code)) % m_total)],
            v_at, v_at + interval '1 hour', 'confirmed',
            CASE WHEN abs(hashtext(v_code)) % 3 = 0 THEN 'desk' ELSE 'app' END,
            v_price, 0, 0, oid, 0, v_price
          );
          INSERT INTO payments (
            code, user_id, method, amount_vnd, vat_rate, status,
            ref_type, ref_id, created_by, created_at
          ) VALUES (
            v_pay,
            members[1 + (abs(hashtext(v_code)) % m_total)],
            (ARRAY['cash','transfer','card','gateway']::pay_method[])[1 + (abs(hashtext(v_code)) % 4)],
            v_price, 0, 'posted', 'booking', bid,
            rec_id,
            v_created
          );
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE '0025 booking skipped % %: %', v_court.court_code, v_at, SQLERRM;
        END;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

-- The forward seed aged into no-shows. Those hours were played; put them back,
-- and keep a thin slice so the no-show list is not wiped clean.
UPDATE court_bookings
   SET status = 'completed'
 WHERE status = 'no_show'
   AND code LIKE 'CRT-%-U%'
   AND end_at < now()
   AND abs(hashtext(id::text)) % 12 <> 0;
