-- Self check-in is on by default: the desk shows its QR and members scan it with their phone.
ALTER TABLE center_settings ALTER COLUMN self_checkin_enabled SET DEFAULT true;
UPDATE center_settings SET self_checkin_enabled = true;
