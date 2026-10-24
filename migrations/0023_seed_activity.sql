-- 0023_seed_activity.sql — a few weeks of real-looking activity for the demo centre.
--
-- Until now the centre had members, plans and a month of bookings, but nothing a
-- coach or the front desk produces: no register had ever been taken, no gate
-- visit logged, no promo code, ticket, loan, shift or audit row existed, so
-- those screens opened empty. This adds them.
--
-- Additive and idempotent, like 0011. Every block is wrapped in its own
-- EXCEPTION handler: a schema surprise skips that block with a NOTICE and never
-- fails the migration (this file runs on every deploy).
--
-- Remove it again with one statement per table keyed on the markers used below
-- ('seed-0023' in notes / dedupe keys / audit "after", codes ending -T0nn).

-- ------------------------------------------------------- past class sessions
-- Three weeks of sessions that already happened, for every open class. They
-- carry no occupancy (a finished session holds no court), as the table requires.
DO $$
DECLARE
  r RECORD;
  d DATE;
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  bydays TEXT[];
  hh INT;
  dow INT;
BEGIN
  FOR r IN SELECT * FROM classes WHERE status = 'open' LOOP
    bydays := regexp_split_to_array(regexp_replace(r.rrule, '.*BYDAY=([A-Z,]+).*', '\1'), ',');
    hh := (regexp_replace(r.rrule, '.*BYHOUR=([0-9]+).*', '\1'))::INT;
    FOR d IN SELECT generate_series(CURRENT_DATE - 21, CURRENT_DATE, interval '1 day')::date LOOP
      dow := EXTRACT(ISODOW FROM d)::INT;
      CONTINUE WHEN dow NOT IN (
        SELECT CASE v WHEN 'MO' THEN 1 WHEN 'TU' THEN 2 WHEN 'WE' THEN 3 WHEN 'TH' THEN 4
                      WHEN 'FR' THEN 5 WHEN 'SA' THEN 6 WHEN 'SU' THEN 7 END
          FROM unnest(bydays) AS v
      );
      v_start := (d::timestamp + (hh * interval '1 hour')) AT TIME ZONE 'Asia/Ho_Chi_Minh';
      v_end := v_start + (r.duration_min * interval '1 minute');
      CONTINUE WHEN v_end > now();
      CONTINUE WHEN v_start < r.start_on::timestamptz;
      CONTINUE WHEN EXISTS (SELECT 1 FROM sessions s WHERE s.class_id = r.id AND s.start_at = v_start);
      BEGIN
        INSERT INTO sessions (class_id, court_id, start_at, end_at, status, occupancy_id)
        VALUES (r.id, r.court_id, v_start, v_end, 'done', NULL);
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE '0023 sessions skipped: %', SQLERRM;
      END;
    END LOOP;
  END LOOP;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE '0023 sessions block: %', SQLERRM;
END $$;

-- ----------------------------------------------------------- class registers
-- A register for every finished session that has none: mostly present, some
-- late, a few absent or excused. One in eleven students never turns up, so the
-- "absent three in a row" call list has people on it.
DO $$
BEGIN
  INSERT INTO attendance (kind, user_id, session_id, result, at, checked_by)
  SELECT 'session', e.user_id, s.id,
         (CASE
            WHEN (abs(hashtext(e.user_id::text)) % 11) = 0 THEN 'absent'
            WHEN b < 70 THEN 'present'
            WHEN b < 82 THEN 'late'
            WHEN b < 92 THEN 'absent'
            ELSE 'excused'
          END)::att_result,
         s.start_at + interval '5 minutes',
         c.coach_id
    FROM sessions s
    JOIN classes c ON c.id = s.class_id
    JOIN enrollments e ON e.class_id = s.class_id AND e.status = 'confirmed'
    CROSS JOIN LATERAL (SELECT abs(hashtext(s.id::text || e.user_id::text)) % 100 AS b) h
   WHERE s.status = 'done'
     AND s.start_at > now() - interval '22 days'
     AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.session_id = s.id AND a.kind = 'session');
EXCEPTION WHEN OTHERS THEN RAISE NOTICE '0023 registers block: %', SQLERRM;
END $$;

-- What the coach wrote down for roughly half of the students who showed up.
DO $$
BEGIN
  INSERT INTO session_results (session_id, user_id, plan_pct, metrics, note, recorded_by)
  SELECT a.session_id, a.user_id,
         60 + (abs(hashtext(a.id::text)) % 41),
         '{}'::jsonb,
         (ARRAY['Footwork improving','Good smash timing','Needs more stamina','Strong net play',
                'Serve is consistent now','Great attitude today'])[1 + (abs(hashtext(a.user_id::text)) % 6)],
         a.checked_by
    FROM attendance a
   WHERE a.kind = 'session' AND a.result IN ('present','late')
     AND a.session_id IS NOT NULL AND a.checked_by IS NOT NULL
     AND abs(hashtext(a.id::text)) % 2 = 0
  ON CONFLICT (session_id, user_id) DO NOTHING;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE '0023 results block: %', SQLERRM;
END $$;

-- ---------------------------------------------------------- gate check-ins
-- Visits at the turnstile over the last two weeks. Every fourth member has none
-- at all, which is what puts them on the "haven't visited" list.
DO $$
DECLARE
  m RECORD;
  k INT;
  v_at TIMESTAMPTZ;
BEGIN
  FOR m IN SELECT id, row_number() OVER (ORDER BY member_code) AS n
             FROM users WHERE role = 'member' AND status = 'active' LOOP
    CONTINUE WHEN m.n % 4 = 0;
    FOR k IN 1..(1 + m.n % 5) LOOP
      v_at := date_trunc('day', now()) - ((k * 2 + m.n % 3) * interval '1 day')
              + ((6 + (m.n + k) % 12) * interval '1 hour') + ((m.n * 7) % 50) * interval '1 minute';
      CONTINUE WHEN v_at > now();
      CONTINUE WHEN EXISTS (SELECT 1 FROM attendance a
                             WHERE a.user_id = m.id AND a.kind = 'gate' AND a.at = v_at);
      INSERT INTO attendance (kind, user_id, at, method, flagged, checked_by)
      VALUES ('gate', m.id, v_at, CASE WHEN (m.n + k) % 6 = 0 THEN 'manual' ELSE 'qr' END, false,
              '00000000-0000-0000-0000-000000000002');
    END LOOP;
  END LOOP;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE '0023 gate block: %', SQLERRM;
END $$;

-- ---------------------------------------------------------------- promotions
DO $$
BEGIN
  INSERT INTO promotions (code, name, kind, value, max_discount_vnd, min_order_vnd, starts_at, ends_at,
                          max_uses, max_per_member, applies_to, stackable, status, created_by)
  VALUES
    ('WELCOME10', 'Welcome — 10% off your first booking', 'percent', 10, 30000, 0,
     now() - interval '30 days', now() + interval '60 days', 500, 1, ARRAY['court'], false, 'active',
     '00000000-0000-0000-0000-000000000001'),
    ('SUMMER50K', 'Summer — 50,000đ off a plan', 'amount', 50000, NULL, 300000,
     now() - interval '10 days', now() + interval '30 days', 100, 1, ARRAY['plan'], false, 'active',
     '00000000-0000-0000-0000-000000000001'),
    ('VIP15', 'Members'' day — 15% off courts', 'percent', 15, 60000, 100000,
     now() - interval '5 days', now() + interval '14 days', NULL, 2, ARRAY['court'], false, 'active',
     '00000000-0000-0000-0000-000000000001'),
    ('TET2026', 'Tet campaign (paused)', 'percent', 20, 100000, 0,
     now() + interval '60 days', now() + interval '90 days', 200, 1, ARRAY['plan','court'], false, 'paused',
     '00000000-0000-0000-0000-000000000001')
  ON CONFLICT DO NOTHING;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE '0023 promotions block: %', SQLERRM;
END $$;

-- --------------------------------------------- today's trading and its promos
-- Six finished one-hour bookings from earlier today, so "today" on the manager
-- report and the front desk is not zero. The first three used WELCOME10.
DO $$
DECLARE
  members UUID[];
  m_total INT;
  courts UUID[];
  c_total INT;
  i INT;
  v_at TIMESTAMPTZ;
  v_bid UUID;
  v_pay UUID;
  v_code TEXT := to_char(now() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYYMMDD');
  v_price INT := 100000;
  v_disc INT;
  v_promo UUID;
  v_user UUID;
  v_methods pay_method[] := ARRAY['cash','transfer','card','gateway','cash','transfer']::pay_method[];
BEGIN
  SELECT array_agg(id ORDER BY member_code) INTO members FROM users WHERE role = 'member' AND status = 'active';
  SELECT array_agg(id ORDER BY court_code) INTO courts FROM courts WHERE sport = 'badminton' AND status = 'ready';
  m_total := COALESCE(array_length(members, 1), 0);
  c_total := COALESCE(array_length(courts, 1), 0);
  IF m_total = 0 OR c_total = 0 THEN RETURN; END IF;
  SELECT id INTO v_promo FROM promotions WHERE upper(code) = 'WELCOME10';

  FOR i IN 1..6 LOOP
    v_at := (date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') + ((5 + i) * interval '1 hour'))
            AT TIME ZONE 'Asia/Ho_Chi_Minh';
    CONTINUE WHEN v_at + interval '1 hour' > now();
    CONTINUE WHEN EXISTS (SELECT 1 FROM court_bookings WHERE code = 'CRT-' || v_code || '-T' || lpad(i::text, 3, '0'));
    v_user := members[1 + (i * 3) % m_total];
    v_disc := CASE WHEN i <= 3 AND v_promo IS NOT NULL THEN 10000 ELSE 0 END;
    v_bid := gen_random_uuid();
    v_pay := gen_random_uuid();
    BEGIN
      INSERT INTO court_bookings (id, code, court_id, user_id, start_at, end_at, status, channel,
                                  price_vnd, discount_pct, vat_rate, occupancy_id, quota_hours,
                                  promo_id, promo_discount_vnd)
      VALUES (v_bid, 'CRT-' || v_code || '-T' || lpad(i::text, 3, '0'), courts[1 + (i % c_total)], v_user,
              v_at, v_at + interval '1 hour', 'completed', CASE WHEN i % 2 = 0 THEN 'desk' ELSE 'app' END,
              v_price - v_disc, 0, 0, NULL, 0,
              CASE WHEN v_disc > 0 THEN v_promo END, v_disc);
      INSERT INTO payments (id, code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id,
                            created_by, created_at, promo_id, discount_vnd)
      VALUES (v_pay, 'PAY-' || v_code || '-T' || lpad(i::text, 3, '0'), v_user, v_methods[i],
              v_price - v_disc, 0, 'posted', 'booking', v_bid,
              '00000000-0000-0000-0000-000000000002', v_at,
              CASE WHEN v_disc > 0 THEN v_promo END, v_disc);
      IF v_disc > 0 THEN
        INSERT INTO promotion_redemptions (promo_id, user_id, payment_id, discount_vnd, created_at)
        VALUES (v_promo, v_user, v_pay, v_disc, v_at);
      END IF;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE '0023 today booking %: %', i, SQLERRM;
    END;
  END LOOP;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE '0023 today block: %', SQLERRM;
END $$;

-- ------------------------------------------------------------ cashier shifts
-- Three closed shifts from the last three days (never an open one: opening a
-- shift is something the receptionist should be able to try for themselves).
DO $$
DECLARE i INT; v_open TIMESTAMPTZ;
BEGIN
  FOR i IN 1..3 LOOP
    v_open := (date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - (i * interval '1 day') + interval '7 hours')
              AT TIME ZONE 'Asia/Ho_Chi_Minh';
    CONTINUE WHEN EXISTS (SELECT 1 FROM cashier_shifts WHERE receptionist_id = '00000000-0000-0000-0000-000000000002' AND opened_at = v_open);
    INSERT INTO cashier_shifts (receptionist_id, opened_at, closed_at, cash_declared_vnd)
    VALUES ('00000000-0000-0000-0000-000000000002', v_open, v_open + interval '8 hours', 1200000 + i * 185000);
  END LOOP;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE '0023 shifts block: %', SQLERRM;
END $$;

-- -------------------------------------------------------------------- tickets
DO $$
DECLARE
  members UUID[];
  m_total INT;
  rec RECORD;
  i INT := 0;
BEGIN
  SELECT array_agg(id ORDER BY member_code) INTO members FROM users WHERE role = 'member' AND status = 'active';
  m_total := COALESCE(array_length(members, 1), 0);
  IF m_total = 0 THEN RETURN; END IF;
  FOR rec IN SELECT * FROM (VALUES
    ('The lights on court CL-03 flicker in the evening.', 'closed', 'Thanks — the lamp was replaced on Tuesday.'),
    ('Can I move my Saturday class to Sunday this week?', 'closed', 'Yes, we moved you to the Sunday 15:00 group.'),
    ('I paid by transfer but my plan still shows pending.', 'closed', 'Found it: confirmed and your plan is now active.'),
    ('Do you rent out rackets for children?', 'replied', 'Yes, junior rackets are 25,000đ per hour at the desk.'),
    ('The shower on the ground floor has no hot water.', 'open', NULL),
    ('Is there parking for motorbikes after 21:00?', 'open', NULL)
  ) AS x(body, status, reply) LOOP
    i := i + 1;
    CONTINUE WHEN EXISTS (SELECT 1 FROM tickets WHERE body = rec.body);
    INSERT INTO tickets (user_id, body, status, created_at, reply, replied_at, replied_by)
    VALUES (members[1 + (i * 5) % m_total], rec.body, rec.status, now() - (i * interval '19 hours'),
            rec.reply, CASE WHEN rec.reply IS NOT NULL THEN now() - (i * interval '17 hours') END,
            CASE WHEN rec.reply IS NOT NULL THEN '00000000-0000-0000-0000-000000000002'::uuid END);
  END LOOP;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE '0023 tickets block: %', SQLERRM;
END $$;

-- ----------------------------------------------------------- equipment loans
DO $$
DECLARE
  items UUID[];
  i INT;
  v_status loan_status;
BEGIN
  SELECT array_agg(id ORDER BY id) INTO items FROM equipment_items;
  IF items IS NULL THEN RETURN; END IF;
  FOR i IN 1..8 LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM equipment_loans WHERE phone = '+8490700000' || i);
    v_status := CASE WHEN i IN (1, 2, 3) THEN 'out' WHEN i = 8 THEN 'lost' ELSE 'returned' END;
    INSERT INTO equipment_loans (item_id, phone, qty, status, due_at, returned_at)
    VALUES (items[1 + i % array_length(items, 1)], '+8490700000' || i, 1 + i % 3, v_status,
            CASE WHEN i = 1 THEN now() - interval '2 hours'      -- overdue
                 WHEN i IN (2, 3) THEN now() + interval '1 hour'  -- still out, due soon
                 ELSE now() - (i * interval '1 day') END,
            CASE WHEN v_status = 'returned' THEN now() - (i * interval '1 day') - interval '30 minutes' END);
  END LOOP;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE '0023 loans block: %', SQLERRM;
END $$;

-- ------------------------------------------------- training: levels, notes ...
DO $$
DECLARE
  m RECORD;
BEGIN
  FOR m IN SELECT id, row_number() OVER (ORDER BY member_code) AS n
             FROM users WHERE role = 'member' AND status = 'active' LOOP
    INSERT INTO training_profiles (user_id, goal)
    VALUES (m.id, (ARRAY['weight','technique','compete','fun'])[1 + m.n % 4])
    ON CONFLICT (user_id) DO NOTHING;
    INSERT INTO member_levels (user_id, sport, level, assessed_by)
    VALUES (m.id, 'badminton', (ARRAY['beginner','intermediate','advanced'])[1 + m.n % 3],
            '00000000-0000-0000-0000-000000000003')
    ON CONFLICT (user_id, sport) DO NOTHING;
    IF m.n % 3 = 0 AND NOT EXISTS (SELECT 1 FROM coach_notes WHERE user_id = m.id AND body LIKE '%(seed-0023)') THEN
      INSERT INTO coach_notes (user_id, coach_id, body, created_at)
      VALUES (m.id, '00000000-0000-0000-0000-000000000003',
              (ARRAY['Quick learner, ready to move up a level soon.','Watch the right shoulder on overhead shots.',
                     'Comes early and warms up properly.','Prefers doubles drills — pair with a stronger partner.'])[1 + m.n % 4]
              || ' (seed-0023)',
              now() - ((m.n % 20) * interval '1 day'));
    END IF;
    IF m.n % 5 = 0 AND NOT EXISTS (SELECT 1 FROM progress_reviews WHERE user_id = m.id AND comment LIKE '%(seed-0023)') THEN
      INSERT INTO progress_reviews (user_id, sport, coach_id, period_weeks, technique, fitness, attitude, comment, created_at)
      VALUES (m.id, 'badminton', '00000000-0000-0000-0000-000000000003', 4,
              2 + m.n % 4, 2 + (m.n + 1) % 4, 3 + m.n % 3,
              'Steady progress over the last four weeks. (seed-0023)',
              now() - ((m.n % 12) * interval '1 day'));
    END IF;
  END LOOP;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE '0023 training block: %', SQLERRM;
END $$;

-- Homework for the first three open classes, with some ticked off.
DO $$
DECLARE
  c RECORD;
  v_hw UUID;
  i INT := 0;
BEGIN
  FOR c IN SELECT id, coach_id FROM classes WHERE status = 'open' ORDER BY id LIMIT 3 LOOP
    i := i + 1;
    CONTINUE WHEN EXISTS (SELECT 1 FROM homework WHERE class_id = c.id AND body LIKE '%(seed-0023)');
    INSERT INTO homework (coach_id, class_id, title, body, checklist, due_on)
    VALUES (c.coach_id, c.id,
            (ARRAY['Footwork ladder x3','Shadow swings, 50 reps','Core plank routine'])[i],
            'Do this twice before the next session. (seed-0023)',
            '["Warm up 5 minutes","Main set","Cool down and stretch"]'::jsonb,
            CURRENT_DATE + 4)
    RETURNING id INTO v_hw;
    INSERT INTO homework_recipients (homework_id, user_id, done_items, completed_at)
    SELECT v_hw, e.user_id,
           CASE WHEN abs(hashtext(e.user_id::text)) % 3 = 0 THEN '["Warm up 5 minutes","Main set","Cool down and stretch"]'::jsonb
                WHEN abs(hashtext(e.user_id::text)) % 3 = 1 THEN '["Warm up 5 minutes"]'::jsonb
                ELSE '[]'::jsonb END,
           CASE WHEN abs(hashtext(e.user_id::text)) % 3 = 0 THEN now() - interval '1 day' END
      FROM enrollments e WHERE e.class_id = c.id AND e.status = 'confirmed'
    ON CONFLICT DO NOTHING;
  END LOOP;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE '0023 homework block: %', SQLERRM;
END $$;

-- --------------------------------------------------------------- contact log
-- Calls the desk made to members who had gone quiet.
DO $$
DECLARE m RECORD; i INT := 0;
BEGIN
  FOR m IN SELECT id FROM users WHERE role = 'member' AND status = 'active' ORDER BY member_code OFFSET 3 LIMIT 5 LOOP
    i := i + 1;
    CONTINUE WHEN EXISTS (SELECT 1 FROM contact_log WHERE user_id = m.id AND note LIKE '%(seed-0023)');
    INSERT INTO contact_log (user_id, reason, channel, outcome, note, created_by, created_at)
    VALUES (m.id, 'idle', 'phone', (ARRAY['reached','no_answer','reached','promised','reached'])[i],
            (ARRAY['Was away on a trip, will be back next week.','No answer, try again tomorrow.',
                   'Asked about switching to evening classes.','Said they will come on Saturday.',
                   'Happy with the plan, just busy at work.'])[i] || ' (seed-0023)',
            '00000000-0000-0000-0000-000000000002', now() - (i * interval '36 hours'));
  END LOOP;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE '0023 contact block: %', SQLERRM;
END $$;

-- ----------------------------------------------------------------- audit log
-- A trail of what staff did over the last week, so the audit screen shows one.
DO $$
DECLARE
  rec RECORD;
  i INT := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM audit_logs WHERE after @> '{"seed":"0023"}'::jsonb) THEN RETURN; END IF;
  FOR rec IN SELECT * FROM (VALUES
    ('00000000-0000-0000-0000-000000000001', 'create_promo',      'promotion'),
    ('00000000-0000-0000-0000-000000000001', 'replace_prices',    'price_rule'),
    ('00000000-0000-0000-0000-000000000001', 'create_class',      'class'),
    ('00000000-0000-0000-0000-000000000002', 'create_payment',    'payment'),
    ('00000000-0000-0000-0000-000000000002', 'gate_checkin',      'user'),
    ('00000000-0000-0000-0000-000000000002', 'ticket_reply',      'ticket'),
    ('00000000-0000-0000-0000-000000000002', 'loan_out',          'equipment_loan'),
    ('00000000-0000-0000-0000-000000000002', 'close_shift',       'cashier_shift'),
    ('00000000-0000-0000-0000-000000000001', 'patch_court',       'court'),
    ('00000000-0000-0000-0000-000000000001', 'create_member',     'user'),
    ('00000000-0000-0000-0000-000000000002', 'transfer_confirm',  'payment'),
    ('00000000-0000-0000-0000-000000000001', 'change_coach',      'class'),
    ('00000000-0000-0000-0000-000000000002', 'cancel_booking',    'court_booking'),
    ('00000000-0000-0000-0000-000000000002', 'loan_return',       'equipment_loan'),
    ('00000000-0000-0000-0000-000000000001', 'freeze_sub',        'subscription'),
    ('00000000-0000-0000-0000-000000000002', 'contact_logged',    'user'),
    ('00000000-0000-0000-0000-000000000001', 'patch_flags',       'feature_flag'),
    ('00000000-0000-0000-0000-000000000002', 'refund_pending',    'payment')
  ) AS x(actor, action, entity) LOOP
    i := i + 1;
    INSERT INTO audit_logs (at, actor_id, action, entity, entity_id, before, after)
    VALUES (now() - (i * interval '7 hours'), rec.actor::uuid, rec.action, rec.entity,
            gen_random_uuid(), NULL, jsonb_build_object('seed', '0023'));
  END LOOP;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE '0023 audit block: %', SQLERRM;
END $$;
