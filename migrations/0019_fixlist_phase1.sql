-- FIXLIST phase 1. Forward-only and additive: nothing here drops or rewrites
-- existing structure, and every statement tolerates being run on data that
-- already looks right.

-- B-03: a class holds the court for whole booking slots.
--
-- Sessions were seeded and materialised with the declared length — 90 minutes,
-- so 17:00 to 18:30 — and the court occupancy copied it. That left 18:30–19:00
-- as a sliver no 60-minute booking can use, and the 18:00 slot half taken. The
-- occupancy (not the session: its times are what the coach and members read)
-- is extended to the next slot boundary.
--
-- A row whose extension would collide with another occupancy is left as it
-- was; the overlap trigger stays the final guard either way.
UPDATE occupancies o
   SET end_at = to_timestamp(
         ceil(extract(epoch FROM o.end_at) / (cs.slot_minutes * 60.0)) * (cs.slot_minutes * 60.0)
       )
  FROM center_settings cs
 WHERE cs.id = 1
   AND o.kind = 'session'
   AND o.end_at > now()
   AND mod(extract(epoch FROM o.end_at)::bigint, (cs.slot_minutes * 60)::bigint) <> 0
   AND NOT EXISTS (
     SELECT 1 FROM occupancies x
      WHERE x.court_id = o.court_id
        AND x.id <> o.id
        AND tstzrange(x.start_at, x.end_at, '[)') && tstzrange(
              o.start_at,
              to_timestamp(ceil(extract(epoch FROM o.end_at) / (cs.slot_minutes * 60.0)) * (cs.slot_minutes * 60.0)),
              '[)')
   );

-- B-06 / D-03: a walk-in has no account, so the invoice is the only place their
-- name and phone can live. Nullable: a member's invoice is identified by the
-- account and needs no phone of its own.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS buyer_phone VARCHAR(20);

-- B-13: a notification can be read. The flag lives on the outbox row the inbox
-- view already reads; NULL means unread. The view is re-declared so `read_at`
-- appears in it — `SELECT *` froze the column list when the view was created.
-- The new column is last in the table, so the view's existing columns keep
-- their positions, which is what CREATE OR REPLACE VIEW requires.
ALTER TABLE outbox
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

CREATE OR REPLACE VIEW inbox AS
  SELECT * FROM outbox WHERE sent_at IS NOT NULL AND channel = 'inapp';
