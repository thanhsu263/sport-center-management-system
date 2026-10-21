-- Migration 0034: Manager sports management
-- Create sports table, seed standard sports, alter 10 sport columns to TEXT with foreign keys.

CREATE TABLE IF NOT EXISTS sports (
  code              TEXT PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_-]{1,23}$'),
  name_en           VARCHAR(40) NOT NULL,
  name_vi           VARCHAR(40) NOT NULL,
  court_prefix      CHAR(2) UNIQUE CHECK (court_prefix ~ '^[A-Z]{2}$'),
  color_key         TEXT NOT NULL DEFAULT 'leaf',
  glyph_key         TEXT NOT NULL DEFAULT 'generic',
  is_scope_all      BOOLEAN NOT NULL DEFAULT false,
  max_players       INT NOT NULL DEFAULT 4,
  slot_duration_min INT NOT NULL DEFAULT 60,
  sort_order        INT NOT NULL DEFAULT 100,
  enabled           BOOLEAN NOT NULL DEFAULT true,
  retired_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed existing sports
INSERT INTO sports (code, name_en, name_vi, court_prefix, color_key, glyph_key, is_scope_all, max_players, slot_duration_min, sort_order)
VALUES
  ('all', 'All sports', 'Tất cả bộ môn', NULL, 'slate', 'generic', true, 4, 60, 0),
  ('badminton', 'Badminton', 'Cầu lông', 'CL', 'leaf', 'badminton', false, 4, 60, 10),
  ('basketball', 'Basketball', 'Bóng rổ', 'BR', 'clay', 'basketball', false, 10, 60, 20),
  ('volleyball', 'Volleyball', 'Bóng chuyền', 'BC', 'sun', 'volleyball', false, 12, 60, 30)
ON CONFLICT (code) DO NOTHING;

-- Alter 10 sport columns from sport_kind enum to TEXT idempotently, and add FK constraints

-- 1. courts.sport
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'courts' AND column_name = 'sport' AND udt_name = 'sport_kind'
  ) THEN
    ALTER TABLE courts ALTER COLUMN sport TYPE TEXT USING sport::text;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'courts_sport_fkey') THEN
    ALTER TABLE courts ADD CONSTRAINT courts_sport_fkey FOREIGN KEY (sport) REFERENCES sports(code);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'courts_sport_not_all') THEN
    ALTER TABLE courts ADD CONSTRAINT courts_sport_not_all CHECK (sport <> 'all');
  END IF;
END $$;

-- 2. membership_plans.sport_scope
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'membership_plans' AND column_name = 'sport_scope' AND udt_name = 'sport_kind'
  ) THEN
    ALTER TABLE membership_plans ALTER COLUMN sport_scope TYPE TEXT USING sport_scope::text;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_plans_sport_scope_fkey') THEN
    ALTER TABLE membership_plans ADD CONSTRAINT membership_plans_sport_scope_fkey FOREIGN KEY (sport_scope) REFERENCES sports(code);
  END IF;
END $$;

-- 3. subscriptions.sport_scope
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'subscriptions' AND column_name = 'sport_scope' AND udt_name = 'sport_kind'
  ) THEN
    ALTER TABLE subscriptions ALTER COLUMN sport_scope TYPE TEXT USING sport_scope::text;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_sport_scope_fkey') THEN
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_sport_scope_fkey FOREIGN KEY (sport_scope) REFERENCES sports(code);
  END IF;
END $$;

-- 4. price_rules.sport
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'price_rules' AND column_name = 'sport' AND udt_name = 'sport_kind'
  ) THEN
    ALTER TABLE price_rules ALTER COLUMN sport TYPE TEXT USING sport::text;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'price_rules_sport_fkey') THEN
    ALTER TABLE price_rules ADD CONSTRAINT price_rules_sport_fkey FOREIGN KEY (sport) REFERENCES sports(code);
  END IF;
END $$;

-- 5. promotions.sport
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'promotions' AND column_name = 'sport' AND udt_name = 'sport_kind'
  ) THEN
    ALTER TABLE promotions ALTER COLUMN sport TYPE TEXT USING sport::text;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promotions_sport_fkey') THEN
    ALTER TABLE promotions ADD CONSTRAINT promotions_sport_fkey FOREIGN KEY (sport) REFERENCES sports(code);
  END IF;
END $$;

-- 6. classes.sport
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'classes' AND column_name = 'sport' AND udt_name = 'sport_kind'
  ) THEN
    ALTER TABLE classes ALTER COLUMN sport TYPE TEXT USING sport::text;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'classes_sport_fkey') THEN
    ALTER TABLE classes ADD CONSTRAINT classes_sport_fkey FOREIGN KEY (sport) REFERENCES sports(code);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'classes_sport_not_all') THEN
    ALTER TABLE classes ADD CONSTRAINT classes_sport_not_all CHECK (sport <> 'all');
  END IF;
END $$;

-- 7. equipment_items.sport
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'equipment_items' AND column_name = 'sport' AND udt_name = 'sport_kind'
  ) THEN
    ALTER TABLE equipment_items ALTER COLUMN sport TYPE TEXT USING sport::text;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'equipment_items_sport_fkey') THEN
    ALTER TABLE equipment_items ADD CONSTRAINT equipment_items_sport_fkey FOREIGN KEY (sport) REFERENCES sports(code);
  END IF;
END $$;

-- 8. member_levels.sport
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'member_levels' AND column_name = 'sport' AND udt_name = 'sport_kind'
  ) THEN
    ALTER TABLE member_levels ALTER COLUMN sport TYPE TEXT USING sport::text;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'member_levels_sport_fkey') THEN
    ALTER TABLE member_levels ADD CONSTRAINT member_levels_sport_fkey FOREIGN KEY (sport) REFERENCES sports(code);
  END IF;
END $$;

-- 9. progress_reviews.sport
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'progress_reviews' AND column_name = 'sport' AND udt_name = 'sport_kind'
  ) THEN
    ALTER TABLE progress_reviews ALTER COLUMN sport TYPE TEXT USING sport::text;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'progress_reviews_sport_fkey') THEN
    ALTER TABLE progress_reviews ADD CONSTRAINT progress_reviews_sport_fkey FOREIGN KEY (sport) REFERENCES sports(code);
  END IF;
END $$;

-- 10. coach_sports.sport
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'coach_sports' AND column_name = 'sport' AND udt_name = 'sport_kind'
  ) THEN
    ALTER TABLE coach_sports ALTER COLUMN sport TYPE TEXT USING sport::text;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coach_sports_sport_fkey') THEN
    ALTER TABLE coach_sports ADD CONSTRAINT coach_sports_sport_fkey FOREIGN KEY (sport) REFERENCES sports(code);
  END IF;
END $$;
