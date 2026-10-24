-- Migration 0032: Subscription price lock at order time (F-20, SB-31)
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS price_vnd INTEGER;

UPDATE subscriptions s
   SET price_vnd = p.price_vnd
  FROM membership_plans p
 WHERE s.plan_id = p.id
   AND s.price_vnd IS NULL;
