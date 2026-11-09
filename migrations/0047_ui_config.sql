-- 0047_ui_config.sql: the menus and list lengths a manager sets, instead of numbers in the code.

-- Each role's tabs (which pages, in what order, which sit in the phone's bottom bar, plus any
-- links the centre adds) and how many items the short lists show. Empty means "as shipped":
-- every key falls back to the default in src/lib/ui-config.ts on its own.
alter table center_settings add column if not exists ui_config jsonb not null default '{}'::jsonb;
