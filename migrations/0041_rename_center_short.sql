-- The centre is now called Lê Long Sport. Only text still holding the name 0039 wrote
-- changes, so a legal name or caption a manager has already edited stays.

UPDATE center_settings SET legal_name = 'Lê Long Sport'
WHERE legal_name = 'Lê Long Sport Center';

UPDATE site_assets
SET alt_en = replace(alt_en, 'Lê Long Sport Center', 'Lê Long Sport'),
    alt_vi = replace(alt_vi, 'Lê Long Sport Center', 'Lê Long Sport')
WHERE alt_en LIKE '%Lê Long Sport Center%' OR alt_vi LIKE '%Lê Long Sport Center%';

UPDATE media_library
SET alt_en = replace(alt_en, 'Lê Long Sport Center', 'Lê Long Sport'),
    alt_vi = replace(alt_vi, 'Lê Long Sport Center', 'Lê Long Sport'),
    credit = replace(credit, 'Lê Long Sport Center', 'Lê Long Sport')
WHERE alt_en LIKE '%Lê Long Sport Center%' OR alt_vi LIKE '%Lê Long Sport Center%' OR credit LIKE '%Lê Long Sport Center%';
