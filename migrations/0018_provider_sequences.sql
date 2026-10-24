-- How far we have got with each payment provider.
--
-- **Read this before moving to a real database.** payOS remembers every order
-- code it has ever been given, forever, and refuses a repeat with error 231
-- ("Đơn thanh toán đã tồn tại"). That memory lives at payOS, not here — so any
-- counter on this side that can move backwards will eventually walk back over
-- ground payOS has already covered and every payment link will fail.
--
-- That is exactly what happened. Order codes were derived from the app's own
-- gapless document counter, the demo database was in memory, and each restart
-- reset the counter to zero. The first six codes of the day were already spent
-- at payOS from earlier testing, so the sequence could never get past them.
--
-- Two things fix it, and both are needed:
--
--   1. The order code is now taken from the clock (milliseconds since the
--      epoch), which cannot go backwards when a database is wiped or restored.
--   2. This table records the highest code actually issued, so a clock that
--      jumps back — a container with a bad time, a restored snapshot — still
--      cannot hand out a code twice.
--
-- **Migrating to the production database:** carry this table's row across.
-- `last_order_code` is the only piece of state that cannot be rebuilt from
-- anything else here, because the authority for it is payOS's records, not
-- ours. Copy it before the first payment is taken on the new database:
--
--     SELECT provider, last_order_code FROM provider_sequences;
--     -- then, on the new database:
--     INSERT INTO provider_sequences (provider, last_order_code, note)
--     VALUES ('payos', <the value you just read>, 'carried over from <where>')
--     ON CONFLICT (provider) DO UPDATE
--       SET last_order_code = GREATEST(provider_sequences.last_order_code,
--                                      EXCLUDED.last_order_code);
--
-- Getting this wrong is not silent: payment links simply stop being issued,
-- with error 231 in the server log.

CREATE TABLE IF NOT EXISTS provider_sequences (
  provider        VARCHAR(16) PRIMARY KEY,
  -- The highest order code handed to this provider. Never decreases.
  last_order_code BIGINT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Free text, for whoever reads this in six months wondering where a number
  -- that large came from.
  note            TEXT
);

-- Seeded with the highest code this project is known to have spent at payOS
-- during integration testing on 27–28 Sep 2026: connection checks used the
-- 99xxxxxxxxxx range and the counter-derived links used 2026092800xx. Starting
-- below either of those would collide immediately.
INSERT INTO provider_sequences (provider, last_order_code, note)
VALUES (
  'payos',
  990529062106,
  'Seeded from integration testing 27-28 Sep 2026. Highest code known spent at payOS before the allocator moved to clock time. Carry this row to the production database.'
)
ON CONFLICT (provider) DO NOTHING;
