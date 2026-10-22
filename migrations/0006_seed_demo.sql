-- Arena3 slice 1 — demo data after 0003_seed (BR/BC plans, coaches, members, classes).
-- Password: ChangeMe!a3 (same scrypt hash as 0003 — no pgcrypto in PGLite).
-- occupancy_attach takes 6 args. Session gen uses inner EXCEPTION (savepoint).

UPDATE users
   SET phone = '+84901119999', email = 'quan.hlv@arena3.local'
 WHERE id = '00000000-0000-0000-0000-000000000003'
   AND phone = '+84900000003';

UPDATE users
   SET member_code = 'A3-2026-0099'
 WHERE id = '00000000-0000-0000-0000-000000000004'
   AND member_code = 'A3-2026-0001';

INSERT INTO membership_plans (
  id, name, sport_scope, duration_days, session_quota, court_hours,
  court_discount_pct, price_vnd, is_on_sale, carry_over_hours
) VALUES
  ('20000000-0000-0000-0000-000000000004', 'Bóng rổ 30 ngày',     'basketball', 30, NULL, 2, 10,  900000, true,  false),
  ('20000000-0000-0000-0000-000000000005', 'Bóng chuyền 30 ngày', 'volleyball', 30, NULL, 2, 10,  850000, true,  false),
  ('20000000-0000-0000-0000-000000000006', 'All-access 90 ngày',  'all',        90, NULL, 12, 20, 3900000, true,  false),
  ('20000000-0000-0000-0000-000000000007', 'Bóng rổ 8 buổi',      'basketball', NULL, 8,  0, 10, 1100000, true,  false),
  ('20000000-0000-0000-0000-000000000008', 'Học thử (ẩn)',        'all',        7,    1,  0,  0,       0, false, false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (
  id, member_code, full_name, name_normalized, phone, email,
  role, status, password_hash, must_change_password,
  date_of_birth, guardian_name, guardian_phone,
  health_notes, pii_consent_at
) VALUES
  ('00000000-0000-0000-0000-000000000011', NULL,
   'Nguyễn Minh Khoa', 'nguyen minh khoa', '+84901110011', 'khoa.hlv@arena3.local',
   'coach', 'active', 'scrypt$16384$8$1$YXJlbmEzLXNlZWQtc2FsdDAx$axaSnV-o4ii8w0VPbDo0H8xnqyciiffPfWSOqPngAxA', true,
   '1994-03-12', NULL, NULL, 'HLV cầu lông — chấn thương vai trái cũ, hạn chế smash quá tải', now()),
  ('00000000-0000-0000-0000-000000000012', NULL,
   'Trần Thị Lan', 'tran thi lan', '+84901110012', 'lan.hlv@arena3.local',
   'coach', 'active', 'scrypt$16384$8$1$YXJlbmEzLXNlZWQtc2FsdDAx$axaSnV-o4ii8w0VPbDo0H8xnqyciiffPfWSOqPngAxA', true,
   '1996-07-21', NULL, NULL, NULL, now()),
  ('00000000-0000-0000-0000-000000000013', NULL,
   'Phạm Đức Anh', 'pham duc anh', '+84901110013', 'anh.hlv@arena3.local',
   'coach', 'active', 'scrypt$16384$8$1$YXJlbmEzLXNlZWQtc2FsdDAx$axaSnV-o4ii8w0VPbDo0H8xnqyciiffPfWSOqPngAxA', true,
   '1992-11-02', NULL, NULL, NULL, now()),
  ('00000000-0000-0000-0000-000000000014', NULL,
   'Lê Quốc Việt', 'le quoc viet', '+84901110014', 'viet.hlv@arena3.local',
   'coach', 'active', 'scrypt$16384$8$1$YXJlbmEzLXNlZWQtc2FsdDAx$axaSnV-o4ii8w0VPbDo0H8xnqyciiffPfWSOqPngAxA', true,
   '1990-01-18', NULL, NULL, NULL, now()),
  ('00000000-0000-0000-0000-000000000015', NULL,
   'Lễ tân ca 2', 'le tan ca 2', '+84900000003', 'letan2@arena3.local',
   'receptionist', 'active', 'scrypt$16384$8$1$YXJlbmEzLXNlZWQtc2FsdDAx$axaSnV-o4ii8w0VPbDo0H8xnqyciiffPfWSOqPngAxA', true,
   '2000-05-09', NULL, NULL, NULL, now()),
  ('00000000-0000-0000-0000-000000000101', 'A3-2026-0001',
   'Nguyễn Văn Nam', 'nguyen van nam', '+84901230101', 'nam.nguyen@example.com',
   'member', 'active', 'scrypt$16384$8$1$YXJlbmEzLXNlZWQtc2FsdDAx$axaSnV-o4ii8w0VPbDo0H8xnqyciiffPfWSOqPngAxA', false,
   '1998-04-15', NULL, NULL, 'Mục tiêu: giảm cân, trình độ cầu lông mới', now()),
  ('00000000-0000-0000-0000-000000000102', 'A3-2026-0002',
   'Trần Mỹ Linh', 'tran my linh', '+84901230102', 'linh.tran@example.com',
   'member', 'active', 'scrypt$16384$8$1$YXJlbmEzLXNlZWQtc2FsdDAx$axaSnV-o4ii8w0VPbDo0H8xnqyciiffPfWSOqPngAxA', false,
   '2001-09-30', NULL, NULL, 'Đau gối phải khi chạy nhiều', now()),
  ('00000000-0000-0000-0000-000000000103', 'A3-2026-0003',
   'Phạm Hoàng Long', 'pham hoang long', '+84901230103', 'long.pham@example.com',
   'member', 'active', 'scrypt$16384$8$1$YXJlbmEzLXNlZWQtc2FsdDAx$axaSnV-o4ii8w0VPbDo0H8xnqyciiffPfWSOqPngAxA', false,
   '1995-12-08', NULL, NULL, 'Cầu lông nâng cao, chuẩn bị giải nội bộ', now()),
  ('00000000-0000-0000-0000-000000000104', 'A3-2026-0004',
   'Lê Thị Hạnh', 'le thi hanh', '+84901230104', 'hanh.le@example.com',
   'member', 'active', 'scrypt$16384$8$1$YXJlbmEzLXNlZWQtc2FsdDAx$axaSnV-o4ii8w0VPbDo0H8xnqyciiffPfWSOqPngAxA', false,
   '1999-02-14', NULL, NULL, NULL, now()),
  ('00000000-0000-0000-0000-000000000105', 'A3-2026-0005',
   'Đỗ Minh Tuấn', 'do minh tuan', '+84901230105', 'tuan.do@example.com',
   'member', 'active', 'scrypt$16384$8$1$YXJlbmEzLXNlZWQtc2FsdDAx$axaSnV-o4ii8w0VPbDo0H8xnqyciiffPfWSOqPngAxA', false,
   '1993-06-03', NULL, NULL, 'Bóng rổ trung bình', now()),
  ('00000000-0000-0000-0000-000000000106', 'A3-2026-0006',
   'Võ Thanh Hà', 'vo thanh ha', '+84901230106', 'ha.vo@example.com',
   'member', 'active', 'scrypt$16384$8$1$YXJlbmEzLXNlZWQtc2FsdDAx$axaSnV-o4ii8w0VPbDo0H8xnqyciiffPfWSOqPngAxA', false,
   '2002-08-19', NULL, NULL, NULL, now()),
  ('00000000-0000-0000-0000-000000000107', 'A3-2026-0007',
   'Bùi Gia Bảo', 'bui gia bao', '+84901230107', 'bao.bui@example.com',
   'member', 'active', 'scrypt$16384$8$1$YXJlbmEzLXNlZWQtc2FsdDAx$axaSnV-o4ii8w0VPbDo0H8xnqyciiffPfWSOqPngAxA', false,
   '2012-01-22', 'Bùi Văn Thành', '+84908880007', 'Vị thành niên — phụ huynh đã đồng ý', now()),
  ('00000000-0000-0000-0000-000000000108', 'A3-2026-0008',
   'Hoàng Nhật Minh', 'hoang nhat minh', '+84901230108', 'minh.hoang@example.com',
   'member', 'active', 'scrypt$16384$8$1$YXJlbmEzLXNlZWQtc2FsdDAx$axaSnV-o4ii8w0VPbDo0H8xnqyciiffPfWSOqPngAxA', false,
   '1997-10-11', NULL, NULL, NULL, now()),
  ('00000000-0000-0000-0000-000000000109', 'A3-2026-0009',
   'Ngô Phương Anh', 'ngo phuong anh', '+84901230109', 'anh.ngo@example.com',
   'member', 'active', 'scrypt$16384$8$1$YXJlbmEzLXNlZWQtc2FsdDAx$axaSnV-o4ii8w0VPbDo0H8xnqyciiffPfWSOqPngAxA', false,
   '2003-03-27', NULL, NULL, 'Bóng chuyền mới', now()),
  ('00000000-0000-0000-0000-000000000110', 'A3-2026-0010',
   'Đặng Quốc Khánh', 'dang quoc khanh', '+84901230110', 'khanh.dang@example.com',
   'member', 'active', 'scrypt$16384$8$1$YXJlbmEzLXNlZWQtc2FsdDAx$axaSnV-o4ii8w0VPbDo0H8xnqyciiffPfWSOqPngAxA', false,
   '1991-05-05', NULL, NULL, NULL, now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO code_counters (kind, yyyy, n) VALUES ('member', 2026, 10)
ON CONFLICT (kind, yyyy) DO UPDATE SET n = GREATEST(code_counters.n, 10);

INSERT INTO coach_sports (user_id, sport) VALUES
  ('00000000-0000-0000-0000-000000000011', 'badminton'),
  ('00000000-0000-0000-0000-000000000012', 'badminton'),
  ('00000000-0000-0000-0000-000000000013', 'basketball'),
  ('00000000-0000-0000-0000-000000000014', 'volleyball')
ON CONFLICT DO NOTHING;

INSERT INTO subscriptions (
  id, user_id, plan_id, sport_scope, start_on, end_on, status,
  court_hours_left, session_left
)
SELECT * FROM (VALUES
  ('21000000-0000-0000-0000-000000000101'::uuid,
   '00000000-0000-0000-0000-000000000101'::uuid,
   (SELECT id FROM membership_plans WHERE name = 'All-access 30 ngày' LIMIT 1),
   'all'::sport_kind, DATE '2026-09-01', DATE '2026-10-01', 'active'::sub_status, 3.0, NULL::int),
  ('21000000-0000-0000-0000-000000000102'::uuid,
   '00000000-0000-0000-0000-000000000102'::uuid,
   (SELECT id FROM membership_plans WHERE name = 'Cầu lông 30 ngày' LIMIT 1),
   'badminton'::sport_kind, DATE '2026-08-17', DATE '2026-09-16', 'active'::sub_status, 1.0, NULL),
  ('21000000-0000-0000-0000-000000000103'::uuid,
   '00000000-0000-0000-0000-000000000103'::uuid,
   '20000000-0000-0000-0000-000000000006'::uuid,
   'all'::sport_kind, DATE '2026-08-01', DATE '2026-10-30', 'active'::sub_status, 10.0, NULL),
  ('21000000-0000-0000-0000-000000000104'::uuid,
   '00000000-0000-0000-0000-000000000104'::uuid,
   (SELECT id FROM membership_plans WHERE name = 'Cầu lông 10 buổi' LIMIT 1),
   'badminton'::sport_kind, DATE '2026-09-01', DATE '2026-12-01', 'active'::sub_status, 0.0, 6),
  ('21000000-0000-0000-0000-000000000105'::uuid,
   '00000000-0000-0000-0000-000000000105'::uuid,
   '20000000-0000-0000-0000-000000000004'::uuid,
   'basketball'::sport_kind, DATE '2026-09-05', DATE '2026-10-05', 'active'::sub_status, 2.0, NULL),
  ('21000000-0000-0000-0000-000000000106'::uuid,
   '00000000-0000-0000-0000-000000000106'::uuid,
   (SELECT id FROM membership_plans WHERE name = 'Cầu lông 30 ngày' LIMIT 1),
   'badminton'::sport_kind, DATE '2026-07-01', DATE '2026-07-31', 'expired'::sub_status, 0.0, NULL),
  ('21000000-0000-0000-0000-000000000107'::uuid,
   '00000000-0000-0000-0000-000000000107'::uuid,
   (SELECT id FROM membership_plans WHERE name = 'Cầu lông 30 ngày' LIMIT 1),
   'badminton'::sport_kind, DATE '2026-09-13', DATE '2026-10-13', 'pending'::sub_status, 0.0, NULL),
  ('21000000-0000-0000-0000-000000000108'::uuid,
   '00000000-0000-0000-0000-000000000108'::uuid,
   '20000000-0000-0000-0000-000000000005'::uuid,
   'volleyball'::sport_kind, DATE '2026-09-10', DATE '2026-10-10', 'active'::sub_status, 2.0, NULL),
  ('21000000-0000-0000-0000-000000000109'::uuid,
   '00000000-0000-0000-0000-000000000109'::uuid,
   '20000000-0000-0000-0000-000000000007'::uuid,
   'basketball'::sport_kind, DATE '2026-09-12', DATE '2026-12-12', 'active'::sub_status, 0.0, 8),
  ('21000000-0000-0000-0000-000000000110'::uuid,
   '00000000-0000-0000-0000-000000000110'::uuid,
   (SELECT id FROM membership_plans WHERE name = 'All-access 30 ngày' LIMIT 1),
   'all'::sport_kind, DATE '2026-09-13', DATE '2026-10-13', 'active'::sub_status, 4.0, NULL)
) AS v(id, user_id, plan_id, sport_scope, start_on, end_on, status, court_hours_left, session_left)
WHERE plan_id IS NOT NULL
ON CONFLICT (id) DO NOTHING;

INSERT INTO payments (id, code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by, created_at)
SELECT
  ('22000000-0000-0000-0000-000000000' || substr(s.id::text, 34, 3))::uuid,
  'PAY-20260913-' || substr(s.id::text, 34, 3),
  s.user_id,
  'cash',
  p.price_vnd,
  0,
  'posted',
  'subscription',
  s.id,
  '00000000-0000-0000-0000-000000000002',
  TIMESTAMPTZ '2026-09-13 09:00:00+07'
FROM subscriptions s
JOIN membership_plans p ON p.id = s.plan_id
WHERE s.id::text LIKE '21000000-0000-0000-0000-0000000001%'
  AND s.status = 'active'
ON CONFLICT (id) DO NOTHING;

INSERT INTO invoices (id, code, payment_id, buyer_name, issued_at)
SELECT
  ('23000000-0000-0000-0000-000000000' || substr(pay.code, 14, 3))::uuid,
  'INV-20260913-' || substr(pay.code, 14, 3),
  pay.id,
  u.full_name,
  pay.created_at
FROM payments pay
JOIN users u ON u.id = pay.user_id
WHERE pay.ref_type = 'subscription'
  AND pay.code LIKE 'PAY-20260913-%'
  AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.payment_id = pay.id);

INSERT INTO classes (
  id, sport, level, coach_id, assistant_id, court_id,
  capacity, enrolled_count, rrule, duration_min, start_on, end_on, status
) VALUES
  ('30000000-0000-0000-0000-000000000001', 'badminton', 'beginner',
   '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000012',
   '10000000-0000-0000-0000-000000000001',
   12, 0, 'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18', 90,
   DATE '2026-09-01', DATE '2026-12-31', 'open'),
  ('30000000-0000-0000-0000-000000000002', 'badminton', 'intermediate',
   '00000000-0000-0000-0000-000000000012', NULL,
   '10000000-0000-0000-0000-000000000003',
   12, 0, 'FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=19', 90,
   DATE '2026-09-01', DATE '2026-12-31', 'open'),
  ('30000000-0000-0000-0000-000000000003', 'badminton', 'advanced',
   '00000000-0000-0000-0000-000000000011', NULL,
   '10000000-0000-0000-0000-000000000005',
   10, 0, 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=8', 90,
   DATE '2026-09-01', DATE '2026-12-31', 'open'),
  ('30000000-0000-0000-0000-000000000004', 'basketball', 'beginner',
   '00000000-0000-0000-0000-000000000013', NULL,
   '10000000-0000-0000-0000-000000000010',
   16, 0, 'FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=17', 90,
   DATE '2026-09-01', DATE '2026-12-31', 'open'),
  ('30000000-0000-0000-0000-000000000005', 'volleyball', 'intermediate',
   '00000000-0000-0000-0000-000000000014', NULL,
   '10000000-0000-0000-0000-000000000011',
   14, 0, 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=16', 90,
   DATE '2026-09-01', DATE '2026-12-31', 'open'),
  ('30000000-0000-0000-0000-000000000006', 'badminton', 'beginner',
   '00000000-0000-0000-0000-000000000012', NULL,
   '10000000-0000-0000-0000-000000000002',
   12, 0, 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9', 90,
   DATE '2026-09-01', DATE '2026-12-31', 'draft')
ON CONFLICT (id) DO NOTHING;

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
  FOR r IN SELECT * FROM classes WHERE id::text LIKE '30000000-0000-0000-0000-00000000000%' AND status = 'open' LOOP
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
      IF v_start <= now() THEN
        CONTINUE;
      END IF;
      IF EXISTS (SELECT 1 FROM sessions s WHERE s.class_id = r.id AND s.start_at = v_start) THEN
        CONTINUE;
      END IF;
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
        RAISE NOTICE 'Bỏ buổi % %: %', r.id, v_start, SQLERRM;
      END;
    END LOOP;
  END LOOP;
END $$;

DO $$
BEGIN
  BEGIN PERFORM enrollment_confirm('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101'); EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM enrollment_confirm('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000102'); EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM enrollment_confirm('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000104'); EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM enrollment_confirm('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000103'); EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM enrollment_confirm('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000103'); EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM enrollment_confirm('30000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000105'); EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM enrollment_confirm('30000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000109'); EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM enrollment_confirm('30000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000108'); EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM enrollment_confirm('30000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000110'); EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

DO $$
DECLARE
  bid UUID;
  oid UUID;
  court UUID := '10000000-0000-0000-0000-000000000004';
  d date := (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  t0 TIMESTAMPTZ := (d::timestamp + interval '20 hours') AT TIME ZONE 'Asia/Ho_Chi_Minh';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM court_bookings
    WHERE user_id = '00000000-0000-0000-0000-000000000101' AND start_at = t0
  ) THEN
    bid := gen_random_uuid();
    oid := occupancy_attach(court, t0, t0 + interval '1 hour', 'booking', bid, NULL);
    INSERT INTO court_bookings (
      id, code, court_id, user_id, start_at, end_at, status, channel,
      price_vnd, discount_pct, vat_rate, occupancy_id, quota_hours
    ) VALUES (
      bid, 'CRT-20260913-0001', court,
      '00000000-0000-0000-0000-000000000101',
      t0, t0 + interval '1 hour', 'confirmed', 'app',
      140000, 15, 0, oid, 1
    );
    UPDATE subscriptions
       SET court_hours_left = GREATEST(court_hours_left - 1, 0)
     WHERE id = '21000000-0000-0000-0000-000000000101';
    INSERT INTO payments (code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by)
    VALUES ('PAY-20260913-B01', '00000000-0000-0000-0000-000000000101',
            'quota', 0, 0, 'posted', 'booking', bid,
            '00000000-0000-0000-0000-000000000002');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Booking demo: %', SQLERRM;
END $$;
