import { createServerFn } from "@tanstack/react-start";

export type CatalogPlan = {
  id: string;
  name: string;
  sport_scope: string;
  duration_days: number | null;
  session_quota: number | null;
  court_hours: number;
  court_discount_pct: number;
  price_vnd: number;
};

export type CatalogClass = {
  id: string;
  sport: string;
  level: string;
  capacity: number;
  enrolled_count: number;
  court_code: string;
  coach_name: string;
  rrule: string;
  duration_min: number;
};

export type CatalogPrice = {
  sport: string;
  day_kind: string;
  start_local: string;
  end_local: string;
  price_vnd: number;
  is_peak: boolean;
  court_id?: string | null;
};

export type CatalogCourt = {
  id: string;
  court_code: string;
  sport: string;
  status: string;
};

export type CatalogSlot = {
  court_id: string;
  start: string;
  end: string;
  kind: string;
};

/**
 * Today's court schedule, for somebody who has not signed in.
 *
 * The first question a visitor has is "is there a court free at seven tonight",
 * and until now the only way to answer it was to create an account — which is
 * the wrong way round: nobody buys a membership to find out whether the place
 * has room for them. This is the same occupancy the booking grid draws, minus
 * the one thing that is nobody else's business: `ref_id`, the booking or
 * enrolment the hour belongs to. What is left is when the building is busy,
 * which is what a sign on the door would say anyway.
 */
export const getPublicAvailability = createServerFn({ method: "POST" })
  .inputValidator((input: { date?: string } | undefined) => {
    const date = input?.date ?? "";
    return { date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "" };
  })
  .handler(async ({ data }) => {
    const { getSql } = await import("@/lib/db");
    const { ictDateString, ictDateTime } = await import("./time");
    const sql = await getSql();
    const date = data.date || ictDateString();
    const start = ictDateTime(date, "00:00");
    const end = new Date(ictDateTime(date, "23:59").getTime() + 60_000);
    const [courts, slots] = await Promise.all([
      sql.query<CatalogCourt>(
        `select id, court_code, sport, status
           from courts
          where retired_at is null
          order by sort_order nulls last, court_code`,
      ),
      sql.query<{ court_id: string; start_at: string | Date; end_at: string | Date; kind: string }>(
        `select court_id, start_at, end_at, kind
           from occupancies
          where start_at < $2 and end_at > $1
          order by court_id, start_at`,
        [start.toISOString(), end.toISOString()],
      ),
    ]);
    return {
      date,
      courts,
      // Normalised here rather than left to the serializer: the two drivers
      // this runs on (pg and PGlite) hand back timestamps in different shapes,
      // and every reader of this downstream does `new Date(slot.start)`.
      slots: slots.map<CatalogSlot>((r) => ({
        court_id: r.court_id,
        start: new Date(r.start_at).toISOString(),
        end: new Date(r.end_at).toISOString(),
        kind: r.kind,
      })),
    };
  });

export const getPublicCatalog = createServerFn({ method: "POST" }).handler(async () => {
  const { getSql } = await import("@/lib/db");
  const sql = await getSql();
  const [plans, classes, prices, venueRows, coaches] = await Promise.all([
    sql.query<CatalogPlan>(
      `select id, name, sport_scope, duration_days, session_quota, court_hours,
              court_discount_pct, price_vnd
         from membership_plans
        where is_on_sale = true
        order by price_vnd`,
    ),
    sql.query<CatalogClass>(
      `select id, sport, level, capacity, enrolled_count, rrule, duration_min, court_code, coach_name
         from (
           select distinct on (cl.court_id, cl.sport, cl.level, cl.rrule)
                  cl.id, cl.sport, cl.level, cl.capacity, cl.enrolled_count, cl.rrule, cl.duration_min,
                  c.court_code, u.full_name as coach_name
             from classes cl
             join courts c on c.id = cl.court_id
             join users u on u.id = cl.coach_id
            where cl.status = 'open'
            order by cl.court_id, cl.sport, cl.level, cl.rrule, cl.enrolled_count desc, cl.start_on
         ) s
        order by court_code, rrule`,
    ),
    sql.query<CatalogPrice>(
      `select sport, court_id, day_kind, start_local::text, end_local::text, price_vnd, is_peak
         from price_rules
        order by sport, day_kind, start_local`,
    ),
    sql.query<{ open_time: string; close_time: string; hold_minutes: number }>(
      `select open_time::text, close_time::text, hold_minutes from center_settings where id = 1`,
    ),
    sql.query<{ id: string; name: string; sports: string[] }>(
      `select u.id, u.full_name as name,
              coalesce(array_remove(array_agg(cs.sport::text), null), '{}') as sports
         from users u
         left join coach_sports cs on cs.user_id = u.id
        where u.role = 'coach' and u.status = 'active'
        group by u.id, u.full_name
        order by u.full_name`,
    ),
  ]);
  // Opening hours and hold length for the landing's copy and grid (see src/lib/venue.ts).
  return { plans, classes, prices, venue: venueRows[0] ?? null, coaches };
});
