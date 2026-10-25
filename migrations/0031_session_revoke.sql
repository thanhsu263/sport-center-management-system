-- 0031_session_revoke.sql: Add revoked_at to sessions_auth for session revocation
ALTER TABLE sessions_auth ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
