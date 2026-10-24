-- Customer care: somebody at the desk answers, and the member reads it.
--
-- A `ticket:` message opened a row and the member was told "Reception replies
-- during opening hours." Reception could not reply — the desk screen had one
-- button, Close — and the member had nowhere to look if they had. The promise
-- in that sentence was the only part of customer care that existed.
--
-- The reply lives on the ticket rather than in a messages table on purpose.
-- What this desk actually does is answer a question once: "the lights in BC2
-- are fixed", "your refund went back on Tuesday". A thread schema would model a
-- conversation nobody is having, and every screen would then have to render an
-- empty one.
--
-- Additive only: three nullable columns and one index. Existing tickets keep
-- their meaning — no reply is exactly what they have.

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reply TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS replied_by UUID REFERENCES users(id);

-- The member's Support tab reads their own tickets newest first, and the desk
-- queue reads the open ones. Both are a handful of rows out of a table that
-- only grows.
CREATE INDEX IF NOT EXISTS tickets_user_created_idx ON tickets (user_id, created_at DESC);
