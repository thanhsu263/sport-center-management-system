-- Slice 2 ops: waitlist helpers, F4–F6 on, seed equipment.
UPDATE feature_flags SET enabled = true WHERE key IN ('F4', 'F5', 'F6');
INSERT INTO feature_flags (key, enabled) VALUES ('SMS', false)
ON CONFLICT (key) DO NOTHING;

INSERT INTO equipment_items (id, sku, name, sport, stock, rent_vnd) VALUES
  ('40000000-0000-0000-0000-000000000001', 'CL-RKT', 'Vợt cầu lông', 'badminton', 24, 30000),
  ('40000000-0000-0000-0000-000000000002', 'CL-SHU', 'Ống cầu', 'badminton', 40, 45000),
  ('40000000-0000-0000-0000-000000000003', 'BR-BAL', 'Bóng rổ', 'basketball', 12, 20000),
  ('40000000-0000-0000-0000-000000000004', 'BC-BAL', 'Bóng chuyền', 'volleyball', 10, 20000)
ON CONFLICT (id) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS attendance_session_user
  ON attendance (session_id, user_id) WHERE kind = 'session';

CREATE OR REPLACE FUNCTION enrollment_confirm(p_class UUID, p_user UUID) RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE v_id UUID; v_status enroll_status;
BEGIN
  PERFORM 1 FROM classes WHERE id = p_class FOR UPDATE;
  SELECT id, status INTO v_id, v_status
    FROM enrollments WHERE class_id = p_class AND user_id = p_user;
  IF v_status = 'confirmed' THEN
    RAISE EXCEPTION 'ALREADY_ENROLLED';
  END IF;
  UPDATE classes SET enrolled_count = enrolled_count + 1
   WHERE id = p_class AND enrolled_count < capacity AND status = 'open';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLASS_FULL';
  END IF;
  IF v_id IS NOT NULL THEN
    UPDATE enrollments SET status = 'confirmed', waitlist_pos = NULL WHERE id = v_id;
    RETURN v_id;
  END IF;
  INSERT INTO enrollments (class_id, user_id, status)
  VALUES (p_class, p_user, 'confirmed')
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION enrollment_waitlist(p_class UUID, p_user UUID) RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE v_id UUID; v_pos INT; v_status enroll_status;
BEGIN
  PERFORM 1 FROM classes WHERE id = p_class FOR UPDATE;
  SELECT id, status INTO v_id, v_status
    FROM enrollments WHERE class_id = p_class AND user_id = p_user;
  IF v_status = 'confirmed' THEN
    RAISE EXCEPTION 'ALREADY_ENROLLED';
  END IF;
  IF v_status = 'waitlisted' AND v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;
  SELECT COALESCE(MAX(waitlist_pos), 0) + 1 INTO v_pos
    FROM enrollments WHERE class_id = p_class AND status = 'waitlisted';
  IF v_id IS NOT NULL THEN
    UPDATE enrollments SET status = 'waitlisted', waitlist_pos = v_pos WHERE id = v_id;
    RETURN v_id;
  END IF;
  INSERT INTO enrollments (class_id, user_id, status, waitlist_pos)
  VALUES (p_class, p_user, 'waitlisted', v_pos)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
