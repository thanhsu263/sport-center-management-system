-- Phase A/B of the scope benchmark (docs/Arena3-Scope-Benchmark.md):
--   deposit + tiered late-cancel, fixed weekly bookings, day pass, loyalty points,
--   coach commission, maintenance work orders, e-invoice export.
-- Forward-only, additive, idempotent. Every money flow still ends in a `payments` row;
-- every court a customer or a work order takes still goes through `occupancies`.

-- ---------------------------------------------------------------------------
-- Settings. All of it is editable by the manager (Settings screen).
-- ---------------------------------------------------------------------------
ALTER TABLE center_settings ADD COLUMN IF NOT EXISTS deposit_pct INT NOT NULL DEFAULT 30;
ALTER TABLE center_settings ADD COLUMN IF NOT EXISTS deposit_peak_only BOOLEAN NOT NULL DEFAULT true;
-- Cancel tiers: the first tier whose `hours` the booking still has in hand wins.
-- Default mirrors what Vietnamese pickleball venues publish: 24h+ free, 4–24h half, under 4h nothing.
ALTER TABLE center_settings ADD COLUMN IF NOT EXISTS cancel_tiers JSONB NOT NULL
  DEFAULT '[{"hours":24,"refund_pct":100},{"hours":4,"refund_pct":50},{"hours":0,"refund_pct":0}]'::jsonb;
ALTER TABLE center_settings ADD COLUMN IF NOT EXISTS series_min_weeks INT NOT NULL DEFAULT 4;
ALTER TABLE center_settings ADD COLUMN IF NOT EXISTS series_max_weeks INT NOT NULL DEFAULT 12;
ALTER TABLE center_settings ADD COLUMN IF NOT EXISTS series_discount_pct INT NOT NULL DEFAULT 10;
ALTER TABLE center_settings ADD COLUMN IF NOT EXISTS loyalty_earn_vnd INT NOT NULL DEFAULT 10000;
ALTER TABLE center_settings ADD COLUMN IF NOT EXISTS loyalty_redeem_vnd INT NOT NULL DEFAULT 100;
ALTER TABLE center_settings ADD COLUMN IF NOT EXISTS day_pass_vnd INT NOT NULL DEFAULT 60000;

DO $$ BEGIN
  ALTER TABLE center_settings ADD CONSTRAINT deposit_pct_range CHECK (deposit_pct BETWEEN 0 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Fixed weekly bookings (đặt cố định).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_series (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(24) NOT NULL UNIQUE,
  user_id UUID REFERENCES users(id),
  guest_name VARCHAR(120),
  guest_phone VARCHAR(20),
  court_id UUID NOT NULL REFERENCES courts(id),
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_local TIME NOT NULL,
  weeks INT NOT NULL CHECK (weeks > 0),
  starts_on DATE NOT NULL,
  discount_pct INT NOT NULL DEFAULT 0,
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_series_user ON booking_series (user_id);

ALTER TABLE court_bookings ADD COLUMN IF NOT EXISTS series_id UUID REFERENCES booking_series(id);
-- deposit_vnd: what must be paid to confirm (0 = the whole price).
-- paid_vnd:    what has really been collected so far — refunds are worked out from this.
ALTER TABLE court_bookings ADD COLUMN IF NOT EXISTS deposit_vnd INT NOT NULL DEFAULT 0;
ALTER TABLE court_bookings ADD COLUMN IF NOT EXISTS paid_vnd INT NOT NULL DEFAULT 0;
ALTER TABLE court_bookings ADD COLUMN IF NOT EXISTS cancel_refund_pct INT;
ALTER TABLE court_bookings ADD COLUMN IF NOT EXISTS cancel_fee_vnd INT;
CREATE INDEX IF NOT EXISTS court_bookings_series ON court_bookings (series_id) WHERE series_id IS NOT NULL;

-- Bookings paid before this migration were paid in full (cash/transfer/online), never by deposit.
UPDATE court_bookings
   SET paid_vnd = price_vnd
 WHERE paid_vnd = 0 AND price_vnd > 0 AND COALESCE(quota_hours, 0) = 0
   AND status IN ('confirmed','in_use','completed','no_show');

-- ---------------------------------------------------------------------------
-- Day pass (vé ngày).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS day_passes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(24) NOT NULL UNIQUE,
  user_id UUID REFERENCES users(id),
  guest_name VARCHAR(120) NOT NULL,
  guest_phone VARCHAR(20),
  valid_on DATE NOT NULL,
  price_vnd INT NOT NULL CHECK (price_vnd >= 0),
  status VARCHAR(8) NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','used','void')),
  payment_id UUID REFERENCES payments(id),
  issued_by UUID REFERENCES users(id),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS day_passes_valid_on ON day_passes (valid_on);

-- ---------------------------------------------------------------------------
-- Loyalty (tích điểm). Points EARNED are always derived from the net spend in
-- `payments` (a refund is a negative payment, so it takes the points back by itself).
-- Only what is SPENT or adjusted by hand is stored here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loyalty_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  points INT NOT NULL CHECK (points <> 0),
  reason VARCHAR(16) NOT NULL CHECK (reason IN ('redeem','bonus','correction')),
  note TEXT,
  promo_id UUID REFERENCES promotions(id),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loyalty_adjustments_user ON loyalty_adjustments (user_id);

-- ---------------------------------------------------------------------------
-- Coach commission (hoa hồng HLV): a fee per session taught plus a bonus per student present.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coach_rates (
  coach_id UUID PRIMARY KEY REFERENCES users(id),
  per_session_vnd INT NOT NULL DEFAULT 150000 CHECK (per_session_vnd >= 0),
  per_student_vnd INT NOT NULL DEFAULT 10000 CHECK (per_student_vnd >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO coach_rates (coach_id)
SELECT id FROM users WHERE role = 'coach'
ON CONFLICT (coach_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS coach_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id UUID NOT NULL REFERENCES users(id),
  period CHAR(7) NOT NULL,
  sessions INT NOT NULL,
  students INT NOT NULL,
  amount_vnd INT NOT NULL,
  status VARCHAR(8) NOT NULL DEFAULT 'closed' CHECK (status IN ('closed','paid')),
  closed_by UUID REFERENCES users(id),
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  UNIQUE (coach_id, period)
);

-- ---------------------------------------------------------------------------
-- Maintenance work orders (phiếu bảo trì).
-- A work order that blocks a court flips the court to `maintenance` while it is open.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(24) NOT NULL UNIQUE,
  court_id UUID REFERENCES courts(id),
  title VARCHAR(160) NOT NULL,
  description TEXT,
  priority VARCHAR(8) NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','urgent')),
  status VARCHAR(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  blocks_court BOOLEAN NOT NULL DEFAULT false,
  assignee VARCHAR(120),
  cost_vnd INT NOT NULL DEFAULT 0 CHECK (cost_vnd >= 0),
  resolution TEXT,
  reported_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS work_orders_status ON work_orders (status, created_at DESC);

-- ---------------------------------------------------------------------------
-- E-invoice export: remember that an invoice has been handed to the accountant / provider.
-- ---------------------------------------------------------------------------
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS exported_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- Demo rows so the new screens are not empty (markers: 'seed-0024').
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO work_orders (code, court_id, title, description, priority, status, blocks_court, assignee, cost_vnd, resolution, created_at, closed_at)
  SELECT 'WO-SEED-001', (SELECT id FROM courts ORDER BY court_code LIMIT 1),
         'Thay lưới sân bị rách', 'seed-0024 · Lưới góc phải bị đứt, cần thay trước giờ cao điểm.',
         'normal', 'done', false, 'Anh Tùng (kỹ thuật)', 180000, 'Đã thay lưới mới.', now() - interval '6 days', now() - interval '5 days'
   WHERE EXISTS (SELECT 1 FROM courts)
  ON CONFLICT (code) DO NOTHING;
  INSERT INTO work_orders (code, court_id, title, description, priority, status, blocks_court, assignee, created_at)
  SELECT 'WO-SEED-002', (SELECT id FROM courts ORDER BY court_code LIMIT 1 OFFSET 1),
         'Đèn khu B chớp tắt', 'seed-0024 · Hai bóng đèn phía cuối sân nhấp nháy khi bật.',
         'urgent', 'in_progress', false, 'Anh Tùng (kỹ thuật)', now() - interval '1 day'
   WHERE (SELECT count(*) FROM courts) > 1
  ON CONFLICT (code) DO NOTHING;
  INSERT INTO work_orders (code, court_id, title, description, priority, status, blocks_court, created_at)
  SELECT 'WO-SEED-003', NULL,
         'Máy bơm nước phòng thay đồ', 'seed-0024 · Áp lực nước yếu ở phòng thay đồ nữ.',
         'low', 'open', false, now() - interval '3 hours'
  ON CONFLICT (code) DO NOTHING;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'seed-0024 work orders skipped: %', SQLERRM;
END $$;
