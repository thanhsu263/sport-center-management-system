-- ---------------------------------------------------------------------------
-- Drop day passes table and center_settings.day_pass_vnd column
-- Project owner decided to remove day passes entirely (AGENT-BUGFIX sec 8).
-- Legacy payment rows with ref_type = 'day_pass' and audit records are preserved.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS day_passes;
ALTER TABLE center_settings DROP COLUMN IF EXISTS day_pass_vnd;
