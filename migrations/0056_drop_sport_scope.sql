-- 0056_drop_sport_scope.sql: a membership covers every sport, so plans and
-- subscriptions no longer carry a sport. Since 0051 every plan on sale and every
-- live subscription already had sport_scope = 'all', and the one-per-user indexes
-- replaced the per-scope ones. Dropping the column also drops its foreign key.
alter table subscriptions drop column if exists sport_scope;
alter table membership_plans drop column if exists sport_scope;
