-- 0028_demo_fill.sql — the court map drained a second time.
--
-- 0025 seeded one book-ahead week from the day it ran (05/10). A migration runs
-- once, so a week later every one of those bookings had reached its hour, the
-- no-show sweep had marked it no_show and dropped its court hold, and nothing
-- came after it: the grid was empty from today on, and the revenue report had
-- no receipts after the last seed day.
--
-- The refill is now a function the job loop calls every hour (jobs.ts), so the
-- window moves with the clock instead of being pinned to a migration date:
--   * each slot it sells has a sale time two hours to a week before its hour,
--     and is only put on the books once that time has passed. Tomorrow is
--     nearly full, the far end of the week fills in run by run, and every
--     receipt is dated when it was taken: no week of advance sales towering
--     over the day the filler happened to run;
--   * days since the filler last sold anything (up to 14) are caught up the
--     same way — their hours already played, so completed bookings;
--   * CRT-F bookings the sweep turned into no-shows are put back to completed,
--     except about one in twelve, so the no-show list still has something on it.
--     (0025 already did this for the older CRT-…-U seed.)
--
-- Only while feature_flags DEMO_FILL is on. A centre running on real data
-- switches it off: UPDATE feature_flags SET enabled = false WHERE key = 'DEMO_FILL';
--
-- Idempotent. Booking codes are CRT-F + MMDD + court + hour, as in 0025, so a
-- slot is only ever filled once. Receipts are PAY-YYYYMMDD-9xxx, continuing the
-- 9xxx band of that day so they never meet next_doc_code.

CREATE OR REPLACE FUNCTION demo_fill_calendar() RETURNS INT
LANGUAGE plpgsql AS $$
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
  v_user UUID;
  v_past BOOLEAN;
  v_created TIMESTAMPTZ;
  v_day TEXT;
  v_n INT;
  thresh INT;
  last_sold TIMESTAMPTZ;
  from_day DATE;
  today DATE := (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  rec_id UUID := '00000000-0000-0000-0000-000000000002';
  added INT := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM feature_flags WHERE key = 'DEMO_FILL' AND enabled) THEN
    RETURN 0;
  END IF;

  -- Same coin as the played hours below, so the hourly re-run never flips the
  -- no-shows it chose to keep.
  UPDATE court_bookings
     SET status = 'completed'
   WHERE status = 'no_show'
     AND code LIKE 'CRT-F%'
     AND end_at < now()
     AND abs(hashtext(code)) % 12 <> 0;

  SELECT array_agg(id ORDER BY member_code) INTO members
    FROM users WHERE role = 'member' AND status = 'active';
  m_total := COALESCE(array_length(members, 1), 0);
  IF m_total = 0 THEN RETURN 0; END IF;

  -- Pick up where the last run stopped: the newest receipt for a filled slot.
  SELECT max(p.created_at) INTO last_sold
    FROM payments p
    JOIN court_bookings b ON b.id = p.ref_id
   WHERE p.ref_type = 'booking' AND b.code LIKE 'CRT-F%';
  from_day := greatest(today - 14,
    least(today, COALESCE((last_sold AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, today)));

  FOR d IN SELECT generate_series(from_day, today + 6, interval '1 day')::date LOOP
    FOR v_court IN SELECT id, court_code, sport FROM courts WHERE status = 'ready' ORDER BY court_code LOOP
      FOR hh IN 6..21 LOOP
        v_at := (d::timestamp + (hh * interval '1 hour')) AT TIME ZONE 'Asia/Ho_Chi_Minh';
        -- The hour under way is neither played nor bookable.
        CONTINUE WHEN v_at <= now() AND v_at + interval '1 hour' > now();
        v_past := v_at < now();

        thresh := CASE WHEN hh >= 17 THEN 7 WHEN hh >= 11 THEN 5 ELSE 3 END;
        CONTINUE WHEN abs(hashtext(v_court.court_code || to_char(d, 'YYYYMMDD') || hh::text)) % 10 >= thresh;

        v_code := 'CRT-F' || to_char(d, 'MMDD') || replace(v_court.court_code, '-', '') || lpad(hh::text, 2, '0');
        v_created := v_at - ((120 + abs(hashtext(v_code || '@')) % 9960) * interval '1 minute');
        CONTINUE WHEN v_created > now();
        CONTINUE WHEN EXISTS (SELECT 1 FROM court_bookings WHERE code = v_code);

        -- A played hour has no court hold left to clash on, so check what was
        -- really there: a booking or a class on that court at that hour.
        CONTINUE WHEN v_past AND (
          EXISTS (SELECT 1 FROM court_bookings b
                   WHERE b.court_id = v_court.id
                     AND b.status IN ('confirmed','in_use','completed','no_show')
                     AND b.start_at < v_at + interval '1 hour' AND b.end_at > v_at)
          OR EXISTS (SELECT 1 FROM sessions s
                      WHERE s.court_id = v_court.id
                        AND s.status <> 'cancelled'
                        AND s.start_at < v_at + interval '1 hour' AND s.end_at > v_at)
        );

        v_price := CASE v_court.sport
          WHEN 'badminton'  THEN CASE WHEN hh >= 17 THEN 140000 ELSE  80000 END
          WHEN 'basketball' THEN CASE WHEN hh >= 17 THEN 500000 ELSE 300000 END
          ELSE                   CASE WHEN hh >= 17 THEN 400000 ELSE 250000 END
        END;
        v_user := members[1 + (abs(hashtext(v_code)) % m_total)];

        bid := gen_random_uuid();
        BEGIN
          IF v_past THEN
            oid := NULL;
          ELSE
            oid := occupancy_attach(v_court.id, v_at, v_at + interval '1 hour', 'booking', bid, NULL);
          END IF;
          INSERT INTO court_bookings (
            id, code, court_id, user_id, start_at, end_at, status, channel,
            price_vnd, discount_pct, vat_rate, occupancy_id, quota_hours, paid_vnd
          ) VALUES (
            bid, v_code, v_court.id, v_user,
            v_at, v_at + interval '1 hour',
            CASE
              WHEN NOT v_past THEN 'confirmed'
              WHEN abs(hashtext(v_code)) % 12 = 0 THEN 'no_show'
              ELSE 'completed'
            END::booking_status,
            CASE WHEN abs(hashtext(v_code)) % 3 = 0 THEN 'desk' ELSE 'app' END,
            v_price, 0, 0, oid, 0, v_price
          );

          v_day := to_char(v_created AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYYMMDD');
          -- 0025 numbered a day's band without a cap, so it can already run
          -- past 9999.
          SELECT COALESCE(max(split_part(code, '-', 3)::int), 9000) + 1 INTO v_n
            FROM payments WHERE code ~ ('^PAY-' || v_day || '-(9[0-9]{3}|[1-9][0-9]{4,})$');
          INSERT INTO payments (
            code, user_id, method, amount_vnd, vat_rate, status,
            ref_type, ref_id, created_by, created_at
          ) VALUES (
            'PAY-' || v_day || '-' || v_n::text,
            v_user,
            (ARRAY['cash','transfer','card','gateway']::pay_method[])[1 + (abs(hashtext(v_code)) % 4)],
            v_price, 0, 'posted', 'booking', bid,
            rec_id,
            v_created
          );
          added := added + 1;
        EXCEPTION WHEN OTHERS THEN
          -- A class or a real booking already holds the slot: leave it to them.
          NULL;
        END;
      END LOOP;
    END LOOP;
  END LOOP;
  RETURN added;
END $$;

INSERT INTO feature_flags (key, enabled) VALUES ('DEMO_FILL', true)
ON CONFLICT (key) DO NOTHING;

SELECT demo_fill_calendar();
