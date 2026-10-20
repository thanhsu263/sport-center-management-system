-- Arena3 SDD v0.3.1 — PGLite/Neon compatible (no CREATE EXTENSION, no roles).
-- Occupancy overlap is enforced by trigger (btree_gist is not available in preview).

DO $$ BEGIN CREATE TYPE user_role AS ENUM ('manager','coach','receptionist','member'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE user_status AS ENUM ('active','locked','disabled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE sport_kind AS ENUM ('badminton','basketball','volleyball','all'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE sub_status AS ENUM ('pending','active','expired','frozen'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE court_status AS ENUM ('ready','maintenance','closed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE class_status AS ENUM ('draft','open','closed','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE session_status AS ENUM ('scheduled','done','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE enroll_status AS ENUM ('confirmed','waitlisted','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE booking_status AS ENUM ('hold','confirmed','in_use','completed','cancelled','no_show'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE pay_method AS ENUM ('cash','transfer','card','gateway','quota'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE pay_status AS ENUM ('posted','refund_pending','refund_rejected'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE occ_kind AS ENUM ('session','booking','hold','maintenance','convert'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE att_kind AS ENUM ('session','gate'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE att_result AS ENUM ('present','late','absent','excused'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE loan_status AS ENUM ('out','returned','lost'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE offer_status AS ENUM ('pending','accepted','expired','skipped'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS center_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  timezone TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  currency CHAR(3) NOT NULL DEFAULT 'VND',
  open_time TIME NOT NULL DEFAULT '06:00',
  close_time TIME NOT NULL DEFAULT '22:00',
  slot_minutes INT NOT NULL DEFAULT 60,
  hold_minutes INT NOT NULL DEFAULT 5,
  book_ahead_days INT NOT NULL DEFAULT 7,
  max_slots_per_day INT NOT NULL DEFAULT 2,
  cancel_court_hours INT NOT NULL DEFAULT 2,
  cancel_class_hours INT NOT NULL DEFAULT 4,
  noshow_grace_minutes INT NOT NULL DEFAULT 10,
  checkin_before_minutes INT NOT NULL DEFAULT 15,
  debt_limit_vnd INT NOT NULL DEFAULT 500000,
  refund_manager_vnd INT NOT NULL DEFAULT 1000000,
  freeze_max_days_year INT NOT NULL DEFAULT 30,
  minor_age INT NOT NULL DEFAULT 16,
  vat_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  round_vnd INT NOT NULL DEFAULT 1000,
  waitlist_offer_hours INT NOT NULL DEFAULT 2,
  deposit_pct_activates INT,
  tax_code VARCHAR(20),
  legal_name VARCHAR(190),
  address TEXT
);
INSERT INTO center_settings (id, legal_name, address, tax_code)
VALUES (1, 'Arena3 Sports Center', 'TP. Hồ Chí Minh', NULL)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_code VARCHAR(16) UNIQUE,
  full_name VARCHAR(120) NOT NULL,
  name_normalized VARCHAR(120) NOT NULL,
  phone VARCHAR(16) NOT NULL UNIQUE,
  email VARCHAR(190) UNIQUE,
  role user_role NOT NULL,
  status user_status NOT NULL DEFAULT 'active',
  password_hash TEXT NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT false,
  failed_logins INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  date_of_birth DATE,
  guardian_name VARCHAR(120),
  guardian_phone VARCHAR(16),
  national_id VARCHAR(20),
  pii_consent_at TIMESTAMPTZ,
  health_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_name_norm_idx ON users (name_normalized);

CREATE TABLE IF NOT EXISTS coach_sports (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  sport sport_kind NOT NULL,
  PRIMARY KEY (user_id, sport)
);

CREATE TABLE IF NOT EXISTS membership_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(80) NOT NULL,
  sport_scope sport_kind NOT NULL,
  duration_days INT,
  session_quota INT,
  court_hours INT NOT NULL DEFAULT 0,
  court_discount_pct INT NOT NULL DEFAULT 0 CHECK (court_discount_pct BETWEEN 0 AND 100),
  price_vnd INT NOT NULL CHECK (price_vnd >= 0),
  is_on_sale BOOLEAN NOT NULL DEFAULT true,
  carry_over_hours BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  plan_id UUID NOT NULL REFERENCES membership_plans(id),
  sport_scope sport_kind NOT NULL,
  start_on DATE NOT NULL,
  end_on DATE NOT NULL,
  status sub_status NOT NULL DEFAULT 'pending',
  court_hours_left NUMERIC(6,1) NOT NULL DEFAULT 0,
  session_left INT,
  frozen_days INT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS one_live_sub_per_scope ON subscriptions (user_id, sport_scope)
  WHERE status IN ('active','frozen');
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_sub_per_scope ON subscriptions (user_id, sport_scope)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS courts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  court_code VARCHAR(8) NOT NULL UNIQUE,
  sport sport_kind NOT NULL,
  status court_status NOT NULL DEFAULT 'ready',
  convertible BOOLEAN NOT NULL DEFAULT false,
  pair_court_id UUID REFERENCES courts(id),
  CONSTRAINT pair_distinct CHECK (pair_court_id IS NULL OR pair_court_id <> id)
);

CREATE TABLE IF NOT EXISTS occupancies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  court_id UUID NOT NULL REFERENCES courts(id),
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  kind occ_kind NOT NULL,
  ref_id UUID NOT NULL,
  convert_group_id UUID,
  reason TEXT,
  CONSTRAINT occ_range CHECK (end_at > start_at),
  CONSTRAINT convert_group_chk CHECK (
    (kind = 'convert' AND convert_group_id IS NOT NULL)
    OR (kind <> 'convert' AND convert_group_id IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS occ_kind_ref_court ON occupancies (kind, ref_id, court_id);
CREATE INDEX IF NOT EXISTS occupancies_day_idx ON occupancies (court_id, start_at);

CREATE OR REPLACE FUNCTION occupancies_prevent_overlap() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM occupancies o
    WHERE o.court_id = NEW.court_id
      AND o.id IS DISTINCT FROM NEW.id
      AND tstzrange(o.start_at, o.end_at, '[)') && tstzrange(NEW.start_at, NEW.end_at, '[)')
  ) THEN
    RAISE EXCEPTION 'CONFLICT_SLOT' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS occupancies_no_overlap ON occupancies;
CREATE TRIGGER occupancies_no_overlap
  BEFORE INSERT OR UPDATE ON occupancies
  FOR EACH ROW EXECUTE FUNCTION occupancies_prevent_overlap();

CREATE TABLE IF NOT EXISTS coach_occupancies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id UUID NOT NULL REFERENCES users(id),
  session_id UUID NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT coach_occ_range CHECK (end_at > start_at)
);

CREATE OR REPLACE FUNCTION coach_occupancies_prevent_overlap() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM coach_occupancies o
    WHERE o.coach_id = NEW.coach_id
      AND o.id IS DISTINCT FROM NEW.id
      AND tstzrange(o.start_at, o.end_at, '[)') && tstzrange(NEW.start_at, NEW.end_at, '[)')
  ) THEN
    RAISE EXCEPTION 'CONFLICT_SLOT' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS coach_occupancies_no_overlap ON coach_occupancies;
CREATE TRIGGER coach_occupancies_no_overlap
  BEFORE INSERT OR UPDATE ON coach_occupancies
  FOR EACH ROW EXECUTE FUNCTION coach_occupancies_prevent_overlap();

CREATE TABLE IF NOT EXISTS price_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sport sport_kind NOT NULL,
  court_id UUID REFERENCES courts(id),
  day_kind VARCHAR(16) NOT NULL CHECK (day_kind IN ('weekday','weekend','holiday')),
  start_local TIME NOT NULL,
  end_local TIME NOT NULL,
  price_vnd INT NOT NULL CHECK (price_vnd >= 0),
  is_peak BOOLEAN NOT NULL DEFAULT false,
  start_min INT GENERATED ALWAYS AS ((EXTRACT(HOUR FROM start_local)::int * 60) + EXTRACT(MINUTE FROM start_local)::int) STORED,
  end_min INT GENERATED ALWAYS AS ((EXTRACT(HOUR FROM end_local)::int * 60) + EXTRACT(MINUTE FROM end_local)::int) STORED,
  CONSTRAINT price_range CHECK (end_local > start_local)
);

CREATE TABLE IF NOT EXISTS classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sport sport_kind NOT NULL,
  level VARCHAR(24) NOT NULL,
  coach_id UUID NOT NULL REFERENCES users(id),
  assistant_id UUID REFERENCES users(id),
  court_id UUID NOT NULL REFERENCES courts(id),
  capacity INT NOT NULL CHECK (capacity > 0),
  enrolled_count INT NOT NULL DEFAULT 0,
  rrule TEXT NOT NULL,
  duration_min INT NOT NULL DEFAULT 90,
  start_on DATE NOT NULL,
  end_on DATE NOT NULL,
  status class_status NOT NULL DEFAULT 'draft',
  CONSTRAINT enrolled_cap CHECK (enrolled_count >= 0 AND enrolled_count <= capacity)
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES classes(id),
  court_id UUID NOT NULL REFERENCES courts(id),
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  status session_status NOT NULL DEFAULT 'scheduled',
  occupancy_id UUID UNIQUE REFERENCES occupancies(id),
  CONSTRAINT session_occ_sync CHECK (
    (status = 'scheduled' AND occupancy_id IS NOT NULL)
    OR (status IN ('done','cancelled') AND occupancy_id IS NULL)
  ),
  UNIQUE (class_id, start_at)
);

DO $$ BEGIN
  ALTER TABLE coach_occupancies
    ADD CONSTRAINT coach_occ_session_fk FOREIGN KEY (session_id) REFERENCES sessions(id) DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES classes(id),
  user_id UUID NOT NULL REFERENCES users(id),
  status enroll_status NOT NULL,
  waitlist_pos INT,
  UNIQUE (class_id, user_id),
  CONSTRAINT waitlist_pos_chk CHECK (
    (status = 'waitlisted' AND waitlist_pos IS NOT NULL)
    OR (status <> 'waitlisted' AND waitlist_pos IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS enrollments_waitlist_pos ON enrollments (class_id, waitlist_pos)
  WHERE waitlist_pos IS NOT NULL;

CREATE TABLE IF NOT EXISTS waitlist_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL REFERENCES enrollments(id),
  expires_at TIMESTAMPTZ NOT NULL,
  status offer_status NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS court_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(24) NOT NULL UNIQUE,
  court_id UUID NOT NULL REFERENCES courts(id),
  user_id UUID REFERENCES users(id),
  guest_name VARCHAR(120),
  guest_phone VARCHAR(16),
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  status booking_status NOT NULL,
  channel VARCHAR(12) NOT NULL,
  price_vnd INT NOT NULL,
  discount_pct INT NOT NULL DEFAULT 0,
  vat_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  hold_until TIMESTAMPTZ,
  occupancy_id UUID UNIQUE REFERENCES occupancies(id),
  quota_hours NUMERIC(4,1) NOT NULL DEFAULT 0,
  CONSTRAINT booking_guest CHECK (user_id IS NOT NULL OR (guest_name IS NOT NULL AND guest_phone IS NOT NULL)),
  CONSTRAINT booking_occ_sync CHECK (
    (status IN ('hold','confirmed','in_use') AND occupancy_id IS NOT NULL)
    OR (status IN ('completed','cancelled','no_show') AND occupancy_id IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS one_hold_per_user ON court_bookings (user_id)
  WHERE status = 'hold' AND user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_hold_per_guest_phone ON court_bookings (guest_phone)
  WHERE status = 'hold' AND guest_phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS cashier_shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receptionist_id UUID NOT NULL REFERENCES users(id),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  cash_declared_vnd INT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift ON cashier_shifts (receptionist_id)
  WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(24) NOT NULL UNIQUE,
  user_id UUID REFERENCES users(id),
  shift_id UUID REFERENCES cashier_shifts(id),
  method pay_method NOT NULL,
  amount_vnd INT NOT NULL,
  vat_rate NUMERIC(5,2) NOT NULL,
  status pay_status NOT NULL DEFAULT 'posted',
  ref_type VARCHAR(24) NOT NULL,
  ref_id UUID NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT refund_amount_chk CHECK (
    (status IN ('refund_pending','refund_rejected') AND amount_vnd < 0)
    OR status = 'posted'
  )
);

CREATE OR REPLACE VIEW v_subscription_debt AS
SELECT s.id AS subscription_id,
       mp.price_vnd - COALESCE(SUM(p.amount_vnd) FILTER (WHERE p.status = 'posted'), 0) AS debt_vnd
FROM subscriptions s
JOIN membership_plans mp ON mp.id = s.plan_id
LEFT JOIN payments p ON p.ref_type = 'subscription' AND p.ref_id = s.id
GROUP BY s.id, mp.price_vnd;

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(24) NOT NULL UNIQUE,
  payment_id UUID NOT NULL UNIQUE REFERENCES payments(id),
  buyer_name VARCHAR(120) NOT NULL,
  buyer_tax_code VARCHAR(20),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id),
  description TEXT NOT NULL,
  qty INT NOT NULL DEFAULT 1,
  unit_vnd INT NOT NULL,
  amount_vnd INT NOT NULL
);

CREATE TABLE IF NOT EXISTS equipment_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku VARCHAR(24) NOT NULL UNIQUE,
  name VARCHAR(80) NOT NULL,
  sport sport_kind,
  stock INT NOT NULL DEFAULT 0,
  rent_vnd INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS equipment_loans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES equipment_items(id),
  booking_id UUID REFERENCES court_bookings(id),
  phone VARCHAR(16) NOT NULL,
  qty INT NOT NULL,
  status loan_status NOT NULL DEFAULT 'out',
  due_at TIMESTAMPTZ NOT NULL,
  returned_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind att_kind NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  session_id UUID REFERENCES sessions(id),
  result att_result,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS training_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope VARCHAR(16) NOT NULL,
  class_id UUID REFERENCES classes(id),
  user_id UUID REFERENCES users(id),
  source VARCHAR(8) NOT NULL DEFAULT 'coach',
  published BOOLEAN NOT NULL DEFAULT false,
  payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  body TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id UUID,
  action VARCHAR(64) NOT NULL,
  entity VARCHAR(64) NOT NULL,
  entity_id UUID,
  before JSONB,
  after JSONB
);

CREATE TABLE IF NOT EXISTS feature_flags (
  key VARCHAR(16) PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO feature_flags(key, enabled) VALUES ('F4', false), ('F5', false), ('F6', false)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS code_counters (
  kind VARCHAR(16) NOT NULL,
  yyyy INT NOT NULL,
  n INT NOT NULL,
  PRIMARY KEY (kind, yyyy)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key VARCHAR(80) PRIMARY KEY,
  user_id UUID,
  method VARCHAR(8) NOT NULL,
  path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_code INT NOT NULL,
  response_body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions_auth (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS otp_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(16) NOT NULL,
  purpose VARCHAR(16) NOT NULL,
  otp_hash TEXT NOT NULL,
  payload JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel VARCHAR(12) NOT NULL,
  template VARCHAR(32) NOT NULL,
  user_id UUID REFERENCES users(id),
  payload JSONB NOT NULL,
  dedupe_key VARCHAR(160) NOT NULL UNIQUE,
  sent_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE VIEW inbox AS
  SELECT * FROM outbox WHERE sent_at IS NOT NULL AND channel = 'inapp';

CREATE OR REPLACE FUNCTION occupancy_attach(
  p_court UUID, p_start TIMESTAMPTZ, p_end TIMESTAMPTZ,
  p_kind occ_kind, p_ref UUID, p_reason TEXT DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v_id UUID;
BEGIN
  INSERT INTO occupancies (court_id, start_at, end_at, kind, ref_id, reason)
  VALUES (p_court, p_start, p_end, p_kind, p_ref, p_reason)
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION WHEN exclusion_violation THEN
  RAISE EXCEPTION 'CONFLICT_SLOT' USING ERRCODE = '23P01';
END $$;

CREATE OR REPLACE FUNCTION occupancy_confirm_hold(p_id UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE occupancies SET kind = 'booking' WHERE id = p_id AND kind = 'hold';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HOLD_EXPIRED_OR_BAD_KIND';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION occupancy_release_booking(p_booking UUID, p_terminal booking_status)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_occ UUID;
BEGIN
  IF p_terminal NOT IN ('cancelled','no_show','completed') THEN
    RAISE EXCEPTION 'BAD_TERMINAL';
  END IF;
  SELECT occupancy_id INTO v_occ FROM court_bookings WHERE id = p_booking FOR UPDATE;
  UPDATE court_bookings SET occupancy_id = NULL, status = p_terminal WHERE id = p_booking;
  IF v_occ IS NOT NULL THEN
    DELETE FROM occupancies WHERE id = v_occ;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION occupancy_release_session(p_session UUID, p_terminal session_status)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_occ UUID;
BEGIN
  IF p_terminal NOT IN ('done','cancelled') THEN
    RAISE EXCEPTION 'BAD_TERMINAL';
  END IF;
  SELECT occupancy_id INTO v_occ FROM sessions WHERE id = p_session FOR UPDATE;
  UPDATE sessions SET occupancy_id = NULL, status = p_terminal WHERE id = p_session;
  IF v_occ IS NOT NULL THEN
    DELETE FROM occupancies WHERE id = v_occ;
  END IF;
  DELETE FROM coach_occupancies WHERE session_id = p_session;
END $$;

CREATE OR REPLACE FUNCTION occupancy_release_convert(p_group UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM occupancies WHERE convert_group_id = p_group;
END $$;

CREATE OR REPLACE FUNCTION occupancy_attach_convert(
  p_court UUID, p_start TIMESTAMPTZ, p_end TIMESTAMPTZ, p_ref UUID
) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v_pair UUID; v_group UUID := gen_random_uuid(); v_id UUID;
BEGIN
  SELECT pair_court_id INTO v_pair FROM courts WHERE id = p_court;
  IF v_pair IS NULL THEN
    RAISE EXCEPTION 'COURT_NOT_CONVERTIBLE';
  END IF;
  INSERT INTO occupancies (court_id, start_at, end_at, kind, ref_id, convert_group_id)
  VALUES (p_court, p_start, p_end, 'convert', p_ref, v_group)
  RETURNING id INTO v_id;
  INSERT INTO occupancies (court_id, start_at, end_at, kind, ref_id, convert_group_id)
  VALUES (v_pair, p_start, p_end, 'convert', p_ref, v_group);
  RETURN v_id;
EXCEPTION WHEN exclusion_violation THEN
  DELETE FROM occupancies WHERE convert_group_id = v_group;
  RAISE EXCEPTION 'CONFLICT_SLOT' USING ERRCODE = '23P01';
END $$;

CREATE OR REPLACE FUNCTION booking_replace_hold(
  p_user UUID, p_phone VARCHAR, p_court UUID,
  p_start TIMESTAMPTZ, p_end TIMESTAMPTZ, p_booking UUID
) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v_old UUID;
BEGIN
  PERFORM 1 FROM courts WHERE id = p_court FOR UPDATE;
  SELECT id INTO v_old FROM court_bookings
  WHERE status = 'hold'
    AND (
      (p_user IS NOT NULL AND user_id = p_user)
      OR (p_phone IS NOT NULL AND guest_phone = p_phone)
    )
  FOR UPDATE;
  IF v_old IS NOT NULL THEN
    PERFORM occupancy_release_booking(v_old, 'cancelled');
  END IF;
  RETURN occupancy_attach(p_court, p_start, p_end, 'hold', p_booking, NULL);
END $$;

CREATE OR REPLACE FUNCTION normalize_phone(p TEXT) RETURNS VARCHAR
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p ~ '^\+84' THEN p
    WHEN p ~ '^84' THEN '+' || p
    WHEN p ~ '^0' THEN '+84' || substr(p, 2)
    ELSE p
  END
$$;

CREATE OR REPLACE FUNCTION next_member_code() RETURNS VARCHAR
LANGUAGE plpgsql AS $$
DECLARE y INT := EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Ho_Chi_Minh'));
DECLARE n INT;
BEGIN
  INSERT INTO code_counters(kind, yyyy, n) VALUES ('member', y, 1)
  ON CONFLICT (kind, yyyy) DO UPDATE SET n = code_counters.n + 1
  RETURNING n INTO n;
  RETURN 'A3-' || y::text || '-' || lpad(n::text, 4, '0');
END $$;

CREATE OR REPLACE FUNCTION next_doc_code(p_kind VARCHAR) RETURNS VARCHAR
LANGUAGE plpgsql AS $$
DECLARE ymd INT;
DECLARE n INT;
BEGIN
  ymd := to_char((now() AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYYMMDD')::INT;
  INSERT INTO code_counters(kind, yyyy, n) VALUES (p_kind, ymd, 1)
  ON CONFLICT (kind, yyyy) DO UPDATE SET n = code_counters.n + 1
  RETURNING n INTO n;
  RETURN p_kind || '-' || ymd::text || '-' || lpad(n::text, 4, '0');
END $$;

CREATE OR REPLACE FUNCTION enrollment_confirm(p_class UUID, p_user UUID) RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE v_id UUID;
BEGIN
  PERFORM 1 FROM classes WHERE id = p_class FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM enrollments WHERE class_id = p_class AND user_id = p_user AND status = 'confirmed'
  ) THEN
    RAISE EXCEPTION 'ALREADY_ENROLLED';
  END IF;
  UPDATE classes SET enrolled_count = enrolled_count + 1
  WHERE id = p_class AND enrolled_count < capacity AND status = 'open';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLASS_FULL';
  END IF;
  INSERT INTO enrollments (class_id, user_id, status)
  VALUES (p_class, p_user, 'confirmed')
  ON CONFLICT (class_id, user_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    UPDATE classes SET enrolled_count = enrolled_count - 1 WHERE id = p_class;
    RAISE EXCEPTION 'ALREADY_ENROLLED';
  END IF;
  RETURN v_id;
END $$;
