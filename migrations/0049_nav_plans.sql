-- 0049_nav_plans.sql: put Plans back in menus saved while plans were removed.
-- A saved menu replaces the default, so one saved then has no Plans tab. Add it once to each saved
-- member and manager menu that lacks it; a menu never saved already shows Plans by default.

update center_settings
   set ui_config = jsonb_set(ui_config, '{nav,member}',
         (ui_config #> '{nav,member}') || '[{"to": "/app/plans", "dock": false}]'::jsonb)
 where jsonb_typeof(ui_config #> '{nav,member}') = 'array'
   and not (ui_config #> '{nav,member}') @> '[{"to": "/app/plans"}]'::jsonb;

update center_settings
   set ui_config = jsonb_set(ui_config, '{nav,manager}',
         (ui_config #> '{nav,manager}') || '[{"to": "/manager/plans", "dock": false}]'::jsonb)
 where jsonb_typeof(ui_config #> '{nav,manager}') = 'array'
   and not (ui_config #> '{nav,manager}') @> '[{"to": "/manager/plans"}]'::jsonb;
