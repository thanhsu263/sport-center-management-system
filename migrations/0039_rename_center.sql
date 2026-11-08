-- The centre is now called Lê Long Sport Center. Only text still holding the old
-- seeded name changes, so a legal name or caption a manager has already edited stays.

UPDATE center_settings SET legal_name = 'Lê Long Sport Center'
WHERE legal_name = 'Arena3 Sports Center';

UPDATE site_assets
SET alt_en = replace(alt_en, 'Arena3', 'Lê Long Sport Center'),
    alt_vi = replace(alt_vi, 'Arena3', 'Lê Long Sport Center')
WHERE alt_en LIKE '%Arena3%' OR alt_vi LIKE '%Arena3%';

UPDATE media_library
SET alt_en = replace(alt_en, 'Arena3', 'Lê Long Sport Center'),
    alt_vi = replace(alt_vi, 'Arena3', 'Lê Long Sport Center'),
    credit = replace(credit, 'Arena3', 'Lê Long Sport Center')
WHERE alt_en LIKE '%Arena3%' OR alt_vi LIKE '%Arena3%' OR credit LIKE '%Arena3%';
