-- Publish Sunday beginner class and materialize sessions for the next 14 days
-- including today (even if the slot already started), so occupancy is never "empty Sunday".
UPDATE classes
   SET status = 'open'
 WHERE id = '30000000-0000-0000-0000-000000000006'
   AND status = 'draft';

DO $$
DECLARE
  r RECORD;
  d DATE;
  v_start TIMESTAMPTZ;
  v_end   TIMESTAMPTZ;
  sid UUID;
  oid UUID;
  bydays TEXT[];
  dow INT;
  hh INT;
  match BOOLEAN;
BEGIN
  FOR r IN SELECT * FROM classes WHERE status = 'open' LOOP
    bydays := regexp_split_to_array(regexp_replace(r.rrule, '.*BYDAY=([A-Z,]+).*', '\1'), ',');
    hh := (regexp_replace(r.rrule, '.*BYHOUR=([0-9]+).*', '\1'))::INT;
    FOR d IN SELECT generate_series(
      (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
      (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 13,
      interval '1 day'
    )::date LOOP
      dow := EXTRACT(ISODOW FROM d)::INT;
      match := dow IN (
        SELECT CASE v
          WHEN 'MO' THEN 1 WHEN 'TU' THEN 2 WHEN 'WE' THEN 3
          WHEN 'TH' THEN 4 WHEN 'FR' THEN 5 WHEN 'SA' THEN 6
          WHEN 'SU' THEN 7
        END
        FROM unnest(bydays) AS v
      );
      CONTINUE WHEN NOT match;
      v_start := (d::timestamp + (hh * interval '1 hour')) AT TIME ZONE 'Asia/Ho_Chi_Minh';
      v_end := v_start + (r.duration_min * interval '1 minute');
      IF EXISTS (SELECT 1 FROM sessions s WHERE s.class_id = r.id AND s.start_at = v_start) THEN
        CONTINUE;
      END IF;
      sid := gen_random_uuid();
      BEGIN
        oid := occupancy_attach(r.court_id, v_start, v_end, 'session', sid, NULL);
        INSERT INTO sessions (id, class_id, court_id, start_at, end_at, status, occupancy_id)
        VALUES (sid, r.id, r.court_id, v_start, v_end, 'scheduled', oid);
        INSERT INTO coach_occupancies (coach_id, session_id, start_at, end_at)
        VALUES (r.coach_id, sid, v_start, v_end);
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Bỏ buổi % %: %', r.id, v_start, SQLERRM;
      END;
    END LOOP;
  END LOOP;
END $$;
