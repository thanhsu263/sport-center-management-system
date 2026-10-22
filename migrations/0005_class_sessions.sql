-- Generate upcoming sessions for the seeded open class (0003 timezone was fragile).
DO $$
DECLARE
  sid uuid;
  oid uuid;
  tstart timestamptz;
  d date;
  v_class uuid := '60000000-0000-0000-0000-000000000001';
  v_court uuid := '10000000-0000-0000-0000-000000000008';
  v_coach uuid := '00000000-0000-0000-0000-000000000003';
BEGIN
  FOR d IN
    SELECT gs::date FROM generate_series(
      (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
      (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 14,
      interval '1 day'
    ) gs
  LOOP
    IF EXTRACT(DOW FROM d) NOT IN (1, 3, 5) THEN
      CONTINUE;
    END IF;
    tstart := (d::timestamp + interval '18 hours') AT TIME ZONE 'Asia/Ho_Chi_Minh';
    IF tstart <= now() THEN
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM sessions s WHERE s.class_id = v_class AND s.start_at = tstart) THEN
      CONTINUE;
    END IF;
    sid := gen_random_uuid();
    BEGIN
      oid := occupancy_attach(v_court, tstart, tstart + interval '90 minutes', 'session', sid, NULL);
      INSERT INTO sessions (id, class_id, court_id, start_at, end_at, status, occupancy_id)
      VALUES (sid, v_class, v_court, tstart, tstart + interval '90 minutes', 'scheduled', oid);
      INSERT INTO coach_occupancies (coach_id, session_id, start_at, end_at)
      VALUES (v_coach, sid, tstart, tstart + interval '90 minutes');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
END $$;
