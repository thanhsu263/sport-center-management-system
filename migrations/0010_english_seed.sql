-- 0010_english_seed.sql — the app UI is English, so translate the seeded display
-- strings the UI renders verbatim (plan names, gear names, staff placeholders,
-- health notes, centre address). Members' personal names are left alone — they
-- are names, not copy. Written as UPDATEs so existing databases move too; the
-- migration runner tracks names only, so this stays additive to 0003/0006/0008.

UPDATE center_settings
SET legal_name = 'Arena3 Sports Center',
    address = 'Ho Chi Minh City'
WHERE id = 1;

-- Membership plans (shown on /app/plans, the desk wizard and manager consoles).
UPDATE membership_plans SET name = 'All-access 30 days'   WHERE name = 'All-access 30 ngày';
UPDATE membership_plans SET name = 'Badminton 30 days'    WHERE name = 'Cầu lông 30 ngày';
UPDATE membership_plans SET name = 'Badminton 10 sessions' WHERE name = 'Cầu lông 10 buổi';
UPDATE membership_plans SET name = 'Basketball 30 days'   WHERE name = 'Bóng rổ 30 ngày';
UPDATE membership_plans SET name = 'Volleyball 30 days'   WHERE name = 'Bóng chuyền 30 ngày';
UPDATE membership_plans SET name = 'All-access 90 days'   WHERE name = 'All-access 90 ngày';
UPDATE membership_plans SET name = 'Basketball 8 sessions' WHERE name = 'Bóng rổ 8 buổi';
UPDATE membership_plans SET name = 'Trial (hidden)'       WHERE name = 'Học thử (ẩn)';

-- Gear catalogue (shown on /desk/gear).
UPDATE equipment_items SET name = 'Badminton racket' WHERE sku = 'CL-RKT';
UPDATE equipment_items SET name = 'Shuttle tube'     WHERE sku = 'CL-SHU';
UPDATE equipment_items SET name = 'Basketball'       WHERE sku = 'BR-BAL';
UPDATE equipment_items SET name = 'Volleyball'       WHERE sku = 'BC-BAL';

-- Staff accounts seeded with a job title instead of a name.
UPDATE users SET full_name = 'Arena3 Manager', name_normalized = 'arena3 manager'
WHERE id = '00000000-0000-0000-0000-000000000001';
UPDATE users SET full_name = 'Front Desk 1', name_normalized = 'front desk 1'
WHERE id = '00000000-0000-0000-0000-000000000002';
UPDATE users SET full_name = 'Coach Minh Quan', name_normalized = 'coach minh quan'
WHERE id = '00000000-0000-0000-0000-000000000003';
UPDATE users SET full_name = 'Front Desk 2', name_normalized = 'front desk 2'
WHERE id = '00000000-0000-0000-0000-000000000015';

-- Health notes (front desk reads these on the member page).
UPDATE users SET health_notes = 'Badminton coach — old left-shoulder injury, avoid heavy smash loads'
WHERE id = '00000000-0000-0000-0000-000000000011';
UPDATE users SET health_notes = 'Goal: lose weight. New to badminton'
WHERE id = '00000000-0000-0000-0000-000000000101';
UPDATE users SET health_notes = 'Right knee pain after long runs'
WHERE id = '00000000-0000-0000-0000-000000000102';
UPDATE users SET health_notes = 'Advanced badminton, prepping for the in-house tournament'
WHERE id = '00000000-0000-0000-0000-000000000103';
UPDATE users SET health_notes = 'Intermediate basketball'
WHERE id = '00000000-0000-0000-0000-000000000105';
UPDATE users SET health_notes = 'Minor — guardian consent on file'
WHERE id = '00000000-0000-0000-0000-000000000107';
UPDATE users SET health_notes = 'New to volleyball'
WHERE id = '00000000-0000-0000-0000-000000000109';
