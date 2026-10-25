-- ---------------------------------------------------------------------------
-- Migration 0030: Fix F-07 (Idempotency key scoped per user) and F-04 (member code sequence collision)
-- ---------------------------------------------------------------------------

-- 1. F-07: Scope idempotency_keys by (user_id, key)
UPDATE idempotency_keys SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
ALTER TABLE idempotency_keys ALTER COLUMN user_id SET DEFAULT '00000000-0000-0000-0000-000000000000';
ALTER TABLE idempotency_keys ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE idempotency_keys DROP CONSTRAINT IF EXISTS idempotency_keys_pkey;
ALTER TABLE idempotency_keys DROP CONSTRAINT IF EXISTS idempotency_keys_user_key;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_user_key UNIQUE (user_id, key);
ALTER TABLE idempotency_keys ALTER COLUMN response_code DROP NOT NULL;
ALTER TABLE idempotency_keys ALTER COLUMN response_body DROP NOT NULL;

-- 2. F-04: Fix next_member_code to prevent collisions and avoid lpad truncation past 9999
CREATE OR REPLACE FUNCTION next_member_code() RETURNS VARCHAR
LANGUAGE plpgsql AS $$
DECLARE v_y INT := EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Ho_Chi_Minh'));
DECLARE v_n INT;
DECLARE candidate VARCHAR;
BEGIN
  INSERT INTO code_counters(kind, yyyy, n) VALUES ('member', v_y, 1)
  ON CONFLICT (kind, yyyy) DO UPDATE SET n = code_counters.n + 1
  RETURNING code_counters.n INTO v_n;

  LOOP
    candidate := 'A3-' || v_y::text || '-' || CASE WHEN v_n < 10000 THEN lpad(v_n::text, 4, '0') ELSE v_n::text END;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM users WHERE member_code = candidate);
    v_n := v_n + 1;
    UPDATE code_counters SET n = v_n WHERE kind = 'member' AND yyyy = v_y;
  END LOOP;

  RETURN candidate;
END $$;
