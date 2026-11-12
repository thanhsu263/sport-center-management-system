-- 0054_max_active_classes.sql: a member may be in at most this many classes at once (held or confirmed).
alter table center_settings add column if not exists max_active_classes int not null default 3
  check (max_active_classes between 1 and 50);
