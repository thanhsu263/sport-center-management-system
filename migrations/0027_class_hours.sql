-- 0027_class_hours.sql — a 90-minute class on a 60-minute court.
--
-- Every open class ran 90 minutes and finished at :30. The court grid is
-- hourly, and the hold is the whole slots the class touches, so 18:00–19:30
-- kept the court until 20:00. The next class at 19:00 (same coach) was skipped
-- when sessions were generated: CL-10 has none, and CL-07 is missing the days
-- its coach is still inside the 18:00 class. The advertised hour never happens.
--
-- A class now runs for whole court hours. Existing 90-minute classes become
-- one hour. Future sessions that have not started, and the coach and court
-- holds that belong to them, shrink to that hour. Holds only get shorter, so
-- the overlap trigger cannot newly fire. Sessions already under way are left
-- as they were taught. Missing hours in the next fortnight are then filled;
-- a court that is already booked at that hour is skipped.

UPDATE classes SET duration_min = 60 WHERE duration_min = 90;

ALTER TABLE classes ALTER COLUMN duration_min SET DEFAULT 60;

UPDATE sessions s
   SET end_at = s.start_at + interval '60 minutes'
  FROM classes c
 WHERE s.class_id = c.id
   AND c.duration_min = 60
   AND s.status = 'scheduled'
   AND s.start_at > now()
   AND s.end_at > s.start_at + interval '60 minutes';

UPDATE coach_occupancies co
   SET end_at = s.end_at
  FROM sessions s
  JOIN classes c ON c.id = s.class_id
 WHERE co.session_id = s.id
   AND c.duration_min = 60
   AND s.status = 'scheduled'
   AND s.start_at > now()
   AND co.end_at > s.end_at;

UPDATE occupancies o
   SET end_at = s.end_at
  FROM sessions s
  JOIN classes c ON c.id = s.class_id
 WHERE s.occupancy_id = o.id
   AND c.duration_min = 60
   AND s.status = 'scheduled'
   AND s.start_at > now()
   AND o.end_at > s.end_at;

-- One session per open class on each of its weekdays, through the next 14 days.
DO $$
DECLARE
  r RECORD;
  d DATE;
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  sid UUID;
  oid UUID;
  bydays TEXT[];
  dow INT;
  hh INT;
BEGIN
  FOR r IN SELECT * FROM classes WHERE status = 'open' LOOP
    bydays := regexp_split_to_array(regexp_replace(r.rrule, '.*BYDAY=([A-Z,]+).*', '\1'), ',');
    hh := (regexp_replace(r.rrule, '.*BYHOUR=([0-9]+).*', '\1'))::INT;
    FOR d IN SELECT generate_series(CURRENT_DATE, CURRENT_DATE + 14, interval '1 day')::date LOOP
      dow := EXTRACT(ISODOW FROM d)::INT;
      CONTINUE WHEN dow NOT IN (
        SELECT CASE v
          WHEN 'MO' THEN 1 WHEN 'TU' THEN 2 WHEN 'WE' THEN 3
          WHEN 'TH' THEN 4 WHEN 'FR' THEN 5 WHEN 'SA' THEN 6
          WHEN 'SU' THEN 7
        END
        FROM unnest(bydays) AS v
      );
      v_start := (d::timestamp + (hh * interval '1 hour')) AT TIME ZONE 'Asia/Ho_Chi_Minh';
      v_end := v_start + (r.duration_min * interval '1 minute');
      CONTINUE WHEN v_start <= now();
      CONTINUE WHEN (v_start AT TIME ZONE 'Asia/Ho_Chi_Minh')::date < r.start_on
             OR (v_start AT TIME ZONE 'Asia/Ho_Chi_Minh')::date > r.end_on;
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM sessions s
         WHERE s.class_id = r.id AND (s.start_at = v_start OR s.original_start_at = v_start)
      );
      sid := gen_random_uuid();
      BEGIN
        oid := occupancy_attach(r.court_id, v_start, v_end, 'session', sid, NULL);
        INSERT INTO sessions (id, class_id, court_id, start_at, end_at, status, occupancy_id)
        VALUES (sid, r.id, r.court_id, v_start, v_end, 'scheduled', oid);
        INSERT INTO coach_occupancies (coach_id, session_id, start_at, end_at)
        VALUES (r.coach_id, sid, v_start, v_end);
        IF r.assistant_id IS NOT NULL THEN
          INSERT INTO coach_occupancies (coach_id, session_id, start_at, end_at)
          VALUES (r.assistant_id, sid, v_start, v_end);
        END IF;
      EXCEPTION WHEN SQLSTATE '23P01' THEN
        NULL;
      END;
    END LOOP;
  END LOOP;
END $$;
