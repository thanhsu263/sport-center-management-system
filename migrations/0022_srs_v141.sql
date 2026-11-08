-- SRS v1.4.1 (A3-SRS-001): QR check-in, no debt/deposit, no court convert,
-- promotions, attendance value (at-risk list), detailed training plans.
-- Forward-only.

-- ---------------------------------------------------------------------------
-- I2 — remove debt and deposit. A plan is either paid in full or it stays pending.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_subscription_debt;
ALTER TABLE center_settings DROP COLUMN IF EXISTS debt_limit_vnd;
ALTER TABLE center_settings DROP COLUMN IF EXISTS deposit_pct_activates;

-- ---------------------------------------------------------------------------
-- I5 — remove court convert (BR-37 "independent courts").
-- The 'convert' value stays in occ_kind (a Postgres enum value cannot be dropped
-- safely); nothing writes it any more.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS occupancy_release_convert(UUID);
DROP FUNCTION IF EXISTS occupancy_attach_convert(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID);
ALTER TABLE occupancies DROP CONSTRAINT IF EXISTS convert_group_chk;
DELETE FROM occupancies WHERE kind = 'convert';
ALTER TABLE occupancies DROP COLUMN IF EXISTS convert_group_id;
ALTER TABLE courts DROP CONSTRAINT IF EXISTS pair_distinct;
ALTER TABLE courts DROP COLUMN IF EXISTS pair_court_id;
ALTER TABLE courts DROP COLUMN IF EXISTS convertible;

-- ---------------------------------------------------------------------------
-- I1 — check-in by dynamic QR (FR-TRN-02, FR-CRT-07, BR-71, BR-72).
-- ---------------------------------------------------------------------------
ALTER TABLE center_settings ADD COLUMN IF NOT EXISTS self_checkin_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE center_settings ADD COLUMN IF NOT EXISTS gate_dedup_minutes INT NOT NULL DEFAULT 120;
ALTER TABLE center_settings ADD COLUMN IF NOT EXISTS at_risk_idle_days INT NOT NULL DEFAULT 14;

ALTER TABLE attendance ADD COLUMN IF NOT EXISTS method VARCHAR(8);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS flagged BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS checked_by UUID REFERENCES users(id);
CREATE INDEX IF NOT EXISTS attendance_gate_user ON attendance (user_id, at DESC) WHERE kind = 'gate';

-- A QR token is signed (HMAC) and lives 60 seconds. This table only remembers the
-- ones already scanned, so a photographed code cannot be used twice.
CREATE TABLE IF NOT EXISTS checkin_tokens (
  jti UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS checkin_tokens_used ON checkin_tokens (used_at);

-- ---------------------------------------------------------------------------
-- I4 — promotions (FR-PAY-03, BR-44, BR-45, BR-46, BR-70).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(24) NOT NULL,
  name VARCHAR(120) NOT NULL,
  kind VARCHAR(8) NOT NULL CHECK (kind IN ('percent','amount')),
  value INT NOT NULL CHECK (value > 0),
  max_discount_vnd INT CHECK (max_discount_vnd IS NULL OR max_discount_vnd > 0),
  min_order_vnd INT NOT NULL DEFAULT 0 CHECK (min_order_vnd >= 0),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ,
  max_uses INT CHECK (max_uses IS NULL OR max_uses > 0),
  max_per_member INT NOT NULL DEFAULT 1 CHECK (max_per_member > 0),
  applies_to TEXT[] NOT NULL DEFAULT ARRAY['plan','court'],
  sport sport_kind,
  plan_id UUID REFERENCES membership_plans(id),
  stackable BOOLEAN NOT NULL DEFAULT false,
  status VARCHAR(8) NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT promo_window CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT promo_percent_range CHECK (kind <> 'percent' OR value <= 100)
);
CREATE UNIQUE INDEX IF NOT EXISTS promotions_code_uq ON promotions (upper(code));

CREATE TABLE IF NOT EXISTS promotion_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_id UUID NOT NULL REFERENCES promotions(id),
  user_id UUID REFERENCES users(id),
  payment_id UUID NOT NULL UNIQUE REFERENCES payments(id),
  discount_vnd INT NOT NULL CHECK (discount_vnd >= 0),
  status VARCHAR(10) NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','restored')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  restored_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS promo_redemptions_promo ON promotion_redemptions (promo_id, user_id);

ALTER TABLE payments ADD COLUMN IF NOT EXISTS promo_id UUID REFERENCES promotions(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS discount_vnd INT NOT NULL DEFAULT 0;
-- The code is attached to the order when the order is priced; the redemption row
-- is written only when the money posts (BR-45).
ALTER TABLE court_bookings ADD COLUMN IF NOT EXISTS promo_id UUID REFERENCES promotions(id);
ALTER TABLE court_bookings ADD COLUMN IF NOT EXISTS promo_discount_vnd INT NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS promo_id UUID REFERENCES promotions(id);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS promo_discount_vnd INT NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- I3 — attendance has business value (FR-TRN-09, BR-73): who to call.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contact_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  reason VARCHAR(16) NOT NULL,
  channel VARCHAR(12) NOT NULL DEFAULT 'phone',
  outcome VARCHAR(16) NOT NULL DEFAULT 'reached',
  note TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_log_user ON contact_log (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- I6 — detailed training plans (FR-TRN-04, BR-74, BR-75).
-- Blocks live inside payload.blocks (jsonb); versions and templates are here.
-- ---------------------------------------------------------------------------
ALTER TABLE training_plans ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
ALTER TABLE training_plans ADD COLUMN IF NOT EXISTS is_template BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE training_plans ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES training_plans(id);
CREATE INDEX IF NOT EXISTS training_plans_template ON training_plans (is_template) WHERE is_template;

CREATE TABLE IF NOT EXISTS training_plan_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES training_plans(id) ON DELETE CASCADE,
  version INT NOT NULL,
  title VARCHAR(120),
  payload JSONB NOT NULL,
  edited_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version)
);
