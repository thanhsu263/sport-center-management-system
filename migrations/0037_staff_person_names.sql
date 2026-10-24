-- Staff accounts carried job titles as names ('Arena3 Manager', 'Front Desk 1', ...).
-- Give them person names. Only rows still holding the seeded title change, so a name
-- a manager has already edited stays as it is.

UPDATE users SET full_name = 'Phạm Quốc Bảo', name_normalized = 'pham quoc bao'
WHERE id = '00000000-0000-0000-0000-000000000001' AND full_name = 'Arena3 Manager';

UPDATE users SET full_name = 'Trần Thu Hà', name_normalized = 'tran thu ha'
WHERE id = '00000000-0000-0000-0000-000000000002' AND full_name = 'Front Desk 1';

UPDATE users SET full_name = 'Đỗ Minh Quân', name_normalized = 'do minh quan'
WHERE id = '00000000-0000-0000-0000-000000000003' AND full_name = 'Coach Minh Quan';

UPDATE users SET full_name = 'Lê Văn Phúc', name_normalized = 'le van phuc'
WHERE id = '00000000-0000-0000-0000-000000000015' AND full_name = 'Front Desk 2';

UPDATE site_assets SET alt_en = 'Photo of coach Đỗ Minh Quân', alt_vi = 'Ảnh HLV Đỗ Minh Quân'
WHERE slot = 'coach.00000000-0000-0000-0000-000000000003' AND alt_en = 'Coach Minh Quan';
