/**
 * Every stretch of court time that is or was taken, as one row source.
 *
 * `occupancies` only holds what is live: when a booking completes or a class
 * session is marked done, its occupancy row is deleted. Reports and the court
 * map read past days too, so finished play is added back from the source
 * tables. A released row has `occupancy_id` null, so nothing is counted twice.
 */
export const PLAYED_SQL = `(
  select id, court_id, start_at, end_at, kind::text as kind, ref_id from occupancies
  union all
  select id, court_id, start_at, end_at, 'booking', id from court_bookings
   where status = 'completed' and occupancy_id is null
  union all
  select id, court_id, start_at, end_at, 'session', id from sessions
   where status = 'done' and occupancy_id is null
)`;
