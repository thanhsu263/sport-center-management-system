-- 0033_manager_media_courts.sql
-- Manager-controlled site media assets and court lifecycle management.

CREATE TABLE IF NOT EXISTS site_assets (
  slot         VARCHAR(64) PRIMARY KEY,
  kind         VARCHAR(8)  NOT NULL CHECK (kind IN ('image','video')),
  src_path     TEXT,
  default_path TEXT,
  mime         VARCHAR(32),
  bytes        BYTEA,
  width        INT,
  height       INT,
  alt_en       TEXT NOT NULL DEFAULT '',
  alt_vi       TEXT NOT NULL DEFAULT '',
  enabled      BOOLEAN NOT NULL DEFAULT true,
  version      INT NOT NULL DEFAULT 1,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   UUID REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS site_asset_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot        VARCHAR(64) NOT NULL REFERENCES site_assets(slot),
  src_path    TEXT,
  mime        VARCHAR(32),
  bytes       BYTEA,
  width       INT,
  height      INT,
  replaced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  replaced_by UUID REFERENCES users(id)
);

ALTER TABLE courts ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;
ALTER TABLE courts ADD COLUMN IF NOT EXISTS display_name VARCHAR(40);
ALTER TABLE courts ADD COLUMN IF NOT EXISTS sort_order INT;

-- Seed default site media assets
INSERT INTO site_assets (slot, kind, src_path, default_path, alt_en, alt_vi) VALUES
  ('landing.hero.image', 'image', '/media/hall-courts.jpg', '/media/hall-courts.jpg', 'Arena3 multi-sport hall', 'Nhà thi đấu đa năng Arena3'),
  ('landing.hero.video', 'video', '/media/hall.mp4', '/media/hall.mp4', 'Arena3 atmosphere', 'Không khí Arena3'),
  ('landing.courts.badminton', 'image', '/media/badminton-smash.jpg', '/media/badminton-smash.jpg', 'Badminton court', 'Sân cầu lông'),
  ('landing.courts.basketball', 'image', '/media/basketball-action.jpg', '/media/basketball-action.jpg', 'Basketball court', 'Sân bóng rổ'),
  ('landing.courts.volleyball', 'image', '/media/volleyball-action.jpg', '/media/volleyball-action.jpg', 'Volleyball court', 'Sân bóng chuyền'),
  ('landing.facilities.badminton', 'image', '/media/badminton-court.jpg', '/media/badminton-court.jpg', 'Badminton facilities', 'Cơ sở vật chất cầu lông'),
  ('landing.facilities.basketball', 'image', '/media/basketball.jpg', '/media/basketball.jpg', 'Basketball facilities', 'Cơ sở vật chất bóng rổ'),
  ('landing.facilities.volleyball', 'image', '/media/volleyball.jpg', '/media/volleyball.jpg', 'Volleyball facilities', 'Cơ sở vật chất bóng chuyền'),
  ('landing.facilities.reception', 'image', '/media/reception.jpg', '/media/reception.jpg', 'Reception area', 'Khu vực lễ tân'),
  ('landing.facilities.hall', 'image', '/media/hall-courts.jpg', '/media/hall-courts.jpg', 'Main hall overview', 'Toàn cảnh cụm sân'),
  ('landing.pricing.image', 'image', '/media/court-detail.jpg', '/media/court-detail.jpg', 'Court surface detail', 'Chi tiết sàn thi đấu'),
  ('landing.pricing.video', 'video', '/media/smash.mp4', '/media/smash.mp4', 'Smash action', 'Pha đập bóng'),
  ('landing.closing', 'image', '/media/exterior.jpg', '/media/exterior.jpg', 'The Arena3 frontage at dusk', 'Mặt tiền Arena3 lúc hoàng hôn'),
  ('auth.login.image', 'image', '/media/reception.jpg', '/media/reception.jpg', 'Front desk', 'Quầy lễ tân'),
  ('auth.login.video', 'video', '/media/reception.mp4', '/media/reception.mp4', 'Front desk welcoming', 'Chào đón tại quầy lễ tân'),
  ('auth.register.image', 'image', '/media/athlete.jpg', '/media/athlete.jpg', 'Athlete training', 'Vận động viên tập luyện'),
  ('banner.book', 'image', '/media/hall-courts.jpg', '/media/hall-courts.jpg', 'Court booking', 'Đặt sân'),
  ('banner.classes', 'image', '/media/class-group.jpg', '/media/class-group.jpg', 'Classes', 'Lớp học'),
  ('banner.train', 'image', '/media/train-progress.jpg', '/media/train-progress.jpg', 'Training progress', 'Tiến độ tập luyện'),
  ('banner.coach', 'image', '/media/coach-whistle.jpg', '/media/coach-whistle.jpg', 'Coach dashboard', 'Bảng điều khiển HLV'),
  ('banner.gate', 'image', '/media/desk-gate.jpg', '/media/desk-gate.jpg', 'Check-in gate', 'Cổng check-in'),
  ('banner.manager', 'image', '/media/hall-courts.jpg', '/media/hall-courts.jpg', 'Manager dashboard', 'Bảng điều khiển quản lý'),
  ('sport.badminton', 'image', '/media/badminton-smash.jpg', '/media/badminton-smash.jpg', 'Badminton', 'Cầu lông'),
  ('sport.basketball', 'image', '/media/basketball-action.jpg', '/media/basketball-action.jpg', 'Basketball', 'Bóng rổ'),
  ('sport.volleyball', 'image', '/media/volleyball-action.jpg', '/media/volleyball-action.jpg', 'Volleyball', 'Bóng chuyền'),
  ('sport.all', 'image', '/media/hall-courts.jpg', '/media/hall-courts.jpg', 'All sports', 'Tất cả môn'),
  ('coach.00000000-0000-0000-0000-000000000011', 'image', '/media/coach-khoa.jpg', '/media/coach-khoa.jpg', 'Coach Nguyen Minh Khoa', 'HLV Nguyễn Minh Khoa'),
  ('coach.00000000-0000-0000-0000-000000000012', 'image', '/media/coach-lan.jpg', '/media/coach-lan.jpg', 'Coach Tran Thi Lan', 'HLV Trần Thị Lan'),
  ('coach.00000000-0000-0000-0000-000000000013', 'image', '/media/coach-anh.jpg', '/media/coach-anh.jpg', 'Coach Pham Duc Anh', 'HLV Phạm Đức Anh'),
  ('coach.00000000-0000-0000-0000-000000000014', 'image', '/media/coach-viet.jpg', '/media/coach-viet.jpg', 'Coach Le Quoc Viet', 'HLV Lê Quốc Việt'),
  ('coach.00000000-0000-0000-0000-000000000003', 'image', '/media/coach-drill.jpg', '/media/coach-drill.jpg', 'Coach Minh Quan', 'HLV Minh Quân')
ON CONFLICT (slot) DO NOTHING;

-- Update demo_fill_calendar to skip retired courts
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
    FOR v_court IN SELECT id, court_code, sport FROM courts WHERE status = 'ready' AND retired_at IS NULL ORDER BY court_code LOOP
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
