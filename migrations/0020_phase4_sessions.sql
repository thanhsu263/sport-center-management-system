-- Phase 4A — class lifecycle (SRS v1.4 §FR-CLS: cancel / move a session,
-- change the coach, close or cancel a class).
--
-- A moved session keeps the slot the schedule originally gave it in
-- `original_start_at`, so the nightly generator does not see "no session at
-- 18:00" and mint a second one next to the moved copy.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS original_start_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS change_reason TEXT;
ALTER TABLE classes ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

CREATE INDEX IF NOT EXISTS sessions_original_start_idx
  ON sessions (class_id, original_start_at)
  WHERE original_start_at IS NOT NULL;
