import type { Sql } from "@/lib/db";
import { err } from "../errors";
import { getSettings } from "../helpers";
import { classCode, formatDate, methodLabel, sourceLabel, sportLabel } from "../labels";
import { buildReportPdf, buildXlsx, type ReportDoc } from "../report-files";
import { requireRole, type PublicUser } from "../session";
import { addDays, ictDateString } from "../time";
import { one } from "../tx";
import { atRiskBody, attendanceReportBody } from "./attendance";
import { previousWindow, reportDay, revenueBody, revenueParams } from "./desk";
import { getActiveSportCodes } from "./sports";

/** Longest window a report will scan. A quarter, plus slack; a year is a trend, not a report. */
const MAX_DAYS = 93;

async function windowParams(sql: Sql, request: Request) {
  const sp = new URL(request.url).searchParams;
  const to = reportDay(sp, "to", ictDateString());
  const from = reportDay(sp, "from", addDays(to, -6));
  if (from > to) throw err.field("to", "The end date is before the start date.");
  if (Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1 > MAX_DAYS) {
    throw err.field("from", `Pick a period of at most ${MAX_DAYS} days.`);
  }
  const sport = sp.get("sport") || null;
  if (sport && !(await getActiveSportCodes(sql)).includes(sport)) throw err.field("sport", "Unknown sport.");
  return { from, to, sport };
}

const pct1 = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

// ---- court capacity (FR-CRT-09) ----------------------------------------------

type CapacityCell = {
  court_id: string;
  court_code: string;
  sport: string;
  hr: number;
  slots: number;
  sold_min: number;
  days_booked: number;
  days_total: number;
};

export async function capacityBody(sql: Sql, from: string, to: string, sport: string | null) {
  const settings = await getSettings(sql);
  const openHour = Math.max(0, parseInt(String(settings.open_time).slice(0, 2), 10) || 6);
  const closeHour = Math.min(24, parseInt(String(settings.close_time).slice(0, 2), 10) || 22);
  const daysTotal = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1);

  // "Sold" is a booking or a class session. A hold is unpaid, maintenance is not a sale.
  // Retired courts are hidden unless they have bookings/sessions in the requested window.
  const cells = await sql.query<CapacityCell>(
    `with active_courts as (
       select c.id as court_id, c.court_code, c.sport::text as sport, c.sort_order
         from courts c
        where ($3::text is null or c.sport::text = $3)
          and (
            (c.status = 'ready' and c.retired_at is null)
            or exists (
              select 1 from occupancies o
               where o.court_id = c.id
                 and o.kind in ('booking','session')
                 and o.start_at < ($2::date + interval '1 day') at time zone 'Asia/Ho_Chi_Minh'
                 and o.end_at > $1::date at time zone 'Asia/Ho_Chi_Minh'
            )
          )
     ),
     days as (
       select d.day::date as day
         from generate_series($1::date, $2::date, interval '1 day') as d(day)
     ),
     slots as (
       select c.court_id, c.court_code, c.sport, h.hr, d.day,
              (d.day::timestamp + make_interval(hours => h.hr)) at time zone 'Asia/Ho_Chi_Minh' as s_at
         from active_courts c
        cross join days d
        cross join generate_series($4::int, $5::int - 1) as h(hr)
     ),
     slot_occupancy as (
       select s.court_id, s.court_code, s.sport, s.hr, s.day,
              coalesce((
                select coalesce(sum(extract(epoch from (least(o.end_at, s.s_at + interval '1 hour') - greatest(o.start_at, s.s_at))) / 60), 0)
                  from occupancies o
                 where o.court_id = s.court_id
                   and o.kind in ('booking','session')
                   and o.start_at < s.s_at + interval '1 hour' and o.end_at > s.s_at
              ), 0)::int as sold_min
         from slots s
     )
     select s.court_id, s.court_code, s.sport, s.hr,
            count(*)::int as slots,
            sum(s.sold_min)::int as sold_min,
            count(*) filter (where s.sold_min > 0)::int as days_booked,
            count(*)::int as days_total
       from slot_occupancy s
      group by s.court_id, s.court_code, s.sport, s.hr
      order by s.court_code, s.hr`,
    [from, to, sport, openHour, closeHour],
  );
  const rules = await sql.query<{ sport: string; start_min: number; end_min: number }>(
    `select sport::text, start_min, end_min from price_rules where is_peak`,
  );
  const isPeak = (sp: string, hr: number) =>
    rules.some((r) => r.sport === sp && r.start_min <= hr * 60 && r.end_min > hr * 60);

  const hours = Array.from({ length: Math.max(0, closeHour - openHour) }, (_, i) => openHour + i);
  const byCourt = new Map<
    string,
    {
      court_code: string;
      sport: string;
      sold: number;
      open: number;
      cells: Map<number, number>;
      days_booked: Map<number, number>;
    }
  >();
  const bySport = new Map<string, { sold: number; open: number; peakSold: number; peakOpen: number; offSold: number; offOpen: number }>();
  const byHour = new Map<number, { sold: number; open: number }>();
  for (const c of cells) {
    const open = c.slots * 60;
    const court = byCourt.get(c.court_id) ?? {
      court_code: c.court_code,
      sport: c.sport,
      sold: 0,
      open: 0,
      cells: new Map(),
      days_booked: new Map(),
    };
    court.sold += c.sold_min;
    court.open += open;
    court.cells.set(c.hr, pct1(c.sold_min, open));
    court.days_booked.set(c.hr, c.days_booked);
    byCourt.set(c.court_id, court);
    const sp = bySport.get(c.sport) ?? { sold: 0, open: 0, peakSold: 0, peakOpen: 0, offSold: 0, offOpen: 0 };
    sp.sold += c.sold_min;
    sp.open += open;
    if (isPeak(c.sport, c.hr)) {
      sp.peakSold += c.sold_min;
      sp.peakOpen += open;
    } else {
      sp.offSold += c.sold_min;
      sp.offOpen += open;
    }
    bySport.set(c.sport, sp);
    const hh = byHour.get(c.hr) ?? { sold: 0, open: 0 };
    hh.sold += c.sold_min;
    hh.open += open;
    byHour.set(c.hr, hh);
  }
  const courts = [...byCourt.entries()].map(([court_id, c]) => ({
    court_id,
    court_code: c.court_code,
    sport: c.sport,
    sold_min: c.sold,
    open_min: c.open,
    pct: pct1(c.sold, c.open),
    cells: hours.map((h) => c.cells.get(h) ?? 0),
    days_booked: hours.map((h) => c.days_booked.get(h) ?? 0),
    days_total: daysTotal,
    cell_details: hours.map((h) => ({
      hr: h,
      pct: c.cells.get(h) ?? 0,
      days_booked: c.days_booked.get(h) ?? 0,
      days_total: daysTotal,
    })),
  }));
  const all = courts.reduce((a, c) => ({ sold: a.sold + c.sold_min, open: a.open + c.open_min }), { sold: 0, open: 0 });
  // Court rental against class tuition — the report is asked to keep them apart.
  const revenue = (await revenueBody(sql, from, to, null)).body.by_source as Record<string, number>;
  return {
    from,
    to,
    sport,
    days_total: daysTotal,
    open_hour: openHour,
    close_hour: closeHour,
    totals: { sold_min: all.sold, open_min: all.open, pct: pct1(all.sold, all.open) },
    by_sport: [...bySport.entries()].map(([sp, v]) => ({
      sport: sp,
      sold_min: v.sold,
      open_min: v.open,
      pct: pct1(v.sold, v.open),
      peak_pct: v.peakOpen ? pct1(v.peakSold, v.peakOpen) : null,
      offpeak_pct: v.offOpen ? pct1(v.offSold, v.offOpen) : null,
    })),
    by_hour: hours.map((h) => ({ hour: h, pct: pct1(byHour.get(h)?.sold ?? 0, byHour.get(h)?.open ?? 0) })),
    hours,
    courts,
    revenue_by_source: { court_vnd: revenue.booking ?? 0, class_vnd: revenue.class ?? 0 },
  };
}

export async function reportsCapacity(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const { from, to, sport } = await windowParams(sql, request);
  return { status: 200, body: await capacityBody(sql, from, to, sport) };
}

// ---- members and class sign-ups (FR-PAY-06) ------------------------------------

export async function membersReportBody(sql: Sql, from: string, to: string, sport: string | null) {
  const counts = await one<{ new_members: number; active_members: number; expiring: number; renewed: number; ended: number }>(
    sql,
    `select
       (select count(*) from users u where u.role = 'member'
          and (u.created_at at time zone 'Asia/Ho_Chi_Minh')::date between $1::date and $2::date)::int as new_members,
       (select count(distinct s.user_id) from subscriptions s
         where s.status in ('active','frozen') and s.start_on <= $2::date and s.end_on >= $2::date
           and ($3::text is null or s.sport_scope::text = $3 or s.sport_scope::text = 'all'))::int as active_members,
       (select count(distinct s.user_id) from subscriptions s
         where s.status in ('active','frozen','expired') and s.end_on between $1::date and $2::date
           and ($3::text is null or s.sport_scope::text = $3 or s.sport_scope::text = 'all')
           and not exists (select 1 from subscriptions n where n.user_id = s.user_id
                             and n.status in ('active','frozen','pending') and n.end_on > $2::date))::int as expiring,
       (select count(*) from subscriptions s
         where s.status in ('active','frozen','expired') and s.end_on between $1::date and $2::date
           and ($3::text is null or s.sport_scope::text = $3 or s.sport_scope::text = 'all')
           and exists (select 1 from subscriptions n where n.user_id = s.user_id and n.id <> s.id
                         and n.status in ('active','frozen','expired','pending')
                         and n.start_on > s.start_on and n.start_on <= s.end_on + 30))::int as renewed,
       (select count(*) from subscriptions s
         where s.status in ('active','frozen','expired') and s.end_on between $1::date and $2::date
           and ($3::text is null or s.sport_scope::text = $3 or s.sport_scope::text = 'all'))::int as ended`,
    [from, to, sport],
  );
  // Twelve calendar months ending with the month of `to`, gapless.
  const trend = await sql.query<{ month: string; new_members: number; plans_started: number }>(
    `with months as (
       select date_trunc('month', $1::date) - make_interval(months => g) as m
         from generate_series(0, 11) g
     )
     select to_char(m.m, 'YYYY-MM') as month,
            (select count(*) from users u where u.role = 'member'
               and date_trunc('month', u.created_at at time zone 'Asia/Ho_Chi_Minh') = m.m)::int as new_members,
            (select count(*) from subscriptions s where s.status in ('active','frozen','expired')
               and date_trunc('month', s.start_on) = m.m
               and ($2::text is null or s.sport_scope::text = $2 or s.sport_scope::text = 'all'))::int as plans_started
       from months m order by m.m`,
    [to, sport],
  );
  const attendanceOn = (await one<{ n: number }>(sql, `select count(*)::int as n from attendance where kind = 'session' and result is not null`))!.n > 0;
  const classes = await sql.query<{
    id: string;
    sport: string;
    level: string;
    status: string;
    coach: string;
    capacity: number;
    enrolled: number;
    waitlisted: number;
    marked: number;
    attended: number;
  }>(
    `select c.id, c.sport::text as sport, c.level, c.status::text as status, u.full_name as coach, c.capacity,
            (select count(*) from enrollments e where e.class_id = c.id and e.status = 'confirmed')::int as enrolled,
            (select count(*) from enrollments e where e.class_id = c.id and e.status = 'waitlisted')::int as waitlisted,
            (select count(*) from attendance a join sessions s on s.id = a.session_id
              where s.class_id = c.id and a.kind = 'session' and a.result is not null and a.result <> 'excused'
                and (s.start_at at time zone 'Asia/Ho_Chi_Minh')::date between $1::date and $2::date)::int as marked,
            (select count(*) from attendance a join sessions s on s.id = a.session_id
              where s.class_id = c.id and a.kind = 'session' and a.result in ('present','late')
                and (s.start_at at time zone 'Asia/Ho_Chi_Minh')::date between $1::date and $2::date)::int as attended
       from classes c join users u on u.id = c.coach_id
      where c.status in ('open','closed') and c.start_on <= $2::date and c.end_on >= $1::date
        and ($3::text is null or c.sport::text = $3)
      order by c.sport, c.level, c.id`,
    [from, to, sport],
  );
  return {
    from,
    to,
    sport,
    members: {
      new: counts!.new_members,
      active: counts!.active_members,
      expiring: counts!.expiring,
      plans_ended: counts!.ended,
      plans_renewed: counts!.renewed,
      renewal_rate: counts!.ended ? pct1(counts!.renewed, counts!.ended) : null,
    },
    trend,
    attendance_on: attendanceOn,
    classes: classes.map((c) => ({
      id: c.id,
      code: classCode(c.sport, c.level, c.id),
      sport: c.sport,
      level: c.level,
      status: c.status,
      coach: c.coach,
      capacity: c.capacity,
      enrolled: c.enrolled,
      waitlisted: c.waitlisted,
      fill_pct: pct1(c.enrolled, c.capacity),
      // F4 off (or nothing marked yet) hides the column rather than printing 0% (BR-52).
      attendance_pct: attendanceOn && c.marked ? pct1(c.attended, c.marked) : null,
    })),
  };
}

export async function reportsMembers(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const { from, to, sport } = await windowParams(sql, request);
  return { status: 200, body: await membersReportBody(sql, from, to, sport) };
}

// ---- files (FR-PAY-07) ---------------------------------------------------------

const KINDS = ["revenue", "capacity", "members", "attendance", "at-risk"] as const;

function filterRows(from: string, to: string, extra: [string, string][]): [string, string][] {
  return [["Period", `${formatDate(from)} – ${formatDate(to)}`], ...extra];
}

export async function reportDoc(sql: Sql, request: Request, kind: string): Promise<{ doc: ReportDoc; from: string; to: string }> {
  const generated_at = new Date().toLocaleString("en-GB", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "medium", timeStyle: "short" });
  if (kind === "attendance" || kind === "at-risk") {
    const sp = new URL(request.url).searchParams;
    const to = reportDay(sp, "to", ictDateString());
    const from = reportDay(sp, "from", addDays(to, -29));
    if (kind === "at-risk") {
      const d = await atRiskBody(sql, null);
      return {
        from,
        to,
        doc: {
          title: "At-risk members",
          filters: [["As of", formatDate(ictDateString())], ["Idle threshold", `${d.idle_days} days`]],
          generated_at,
          sections: [
            {
              name: "At-risk members",
              columns: ["Member", "Code", "Phone", "Plan ends", "Attendance %", "Reasons", "Contacted", "Last outcome"],
              rows: d.items.map((i) => [
                i.full_name,
                i.member_code,
                i.phone,
                i.plan_end_on,
                i.attendance_pct,
                i.reasons.map((r) => r.message).join(" "),
                i.contacted ? "Yes" : "No",
                i.last_contact?.outcome ?? null,
              ]),
              note: "Listed so the front desk and coaches can call before the plan lapses. No fee or penalty applies.",
            },
          ],
        },
      };
    }
    const sport = sp.get("sport") || null;
    const d = await attendanceReportBody(sql, from, to, { sport, classId: null, coachScopeId: null });
    return {
      from,
      to,
      doc: {
        title: "Attendance report",
        filters: filterRows(from, to, [["Sport", sport ? sportLabel(sport) : "All"]]),
        generated_at,
        sections: [
          {
            name: "Summary",
            columns: ["Present", "Late", "Absent", "Excused", "Attendance %"],
            rows: [[d.totals.present, d.totals.late, d.totals.absent, d.totals.excused, d.totals.rate_pct]],
            note: "Attendance % = (Present + Late) ÷ (sessions marked − Excused).",
          },
          {
            name: "By class",
            columns: ["Class", "Sport", "Coach", "Students", "Present", "Late", "Absent", "Excused", "Attendance %"],
            rows: d.classes.map((c) => [c.class_code, sportLabel(c.sport), c.coach, c.students, c.present, c.late, c.absent, c.excused, c.rate_pct]),
          },
          {
            name: "By coach",
            columns: ["Coach", "Classes", "Present", "Late", "Absent", "Excused", "Attendance %"],
            rows: d.coaches.map((c) => [c.coach, c.classes, c.present, c.late, c.absent, c.excused, c.rate_pct]),
          },
          {
            name: "By student",
            columns: ["Student", "Code", "Class", "Present", "Late", "Absent", "Excused", "Attendance %"],
            rows: d.students.map((r) => [r.full_name, r.member_code, r.class_code, r.present, r.late, r.absent, r.excused, r.rate_pct]),
          },
        ],
      },
    };
  }
  if (kind === "revenue") {
    const { from, to, method } = revenueParams(request);
    const cur = await revenueBody(sql, from, to, method);
    const win = previousWindow(from, to);
    const prev = await revenueBody(sql, win.from, win.to, method);
    const t = cur.body.totals;
    const p = prev.body.totals;
    const change = (a: number, b: number) => (b ? `${a >= b ? "+" : ""}${pct1(a - b, Math.abs(b))}%` : a ? "new" : "same");
    const sources = new Set([...Object.keys(cur.body.by_source), ...Object.keys(prev.body.by_source)]);
    return {
      from,
      to,
      doc: {
        title: "Revenue report",
        filters: filterRows(from, to, [
          ["Payment method", method ? methodLabel(method) : "All"],
          ["Compared with", `${formatDate(win.from)} – ${formatDate(win.to)}`],
        ]),
        generated_at,
        sections: [
          {
            name: "Summary",
            columns: ["", "This period", "Previous period", "Change"],
            rows: [
              ["Revenue (taken − refunds)", t.revenue_vnd, p.revenue_vnd, change(t.revenue_vnd, p.revenue_vnd)],
              ["Taken", t.gross_vnd, p.gross_vnd, change(t.gross_vnd, p.gross_vnd)],
              ["Refunds", t.refund_vnd, p.refund_vnd, change(t.refund_vnd, p.refund_vnd)],
              ["Plan hours used", t.quota_hours, p.quota_hours, change(t.quota_hours, p.quota_hours)],
            ],
            note: "Amounts in VND. Revenue = payments taken − refunds.",
          },
          {
            name: "By source",
            columns: ["Source", "This period", "Previous period"],
            rows: [...sources].map((s) => [sourceLabel(s), cur.body.by_source[s] ?? 0, prev.body.by_source[s] ?? 0]),
            total: ["Total taken", t.gross_vnd, p.gross_vnd],
          },
          {
            name: "By method",
            columns: ["Method", "Taken"],
            rows: Object.entries(cur.body.by_method).map(([m, v]) => [methodLabel(m), v as number]),
            total: ["Total taken", t.gross_vnd],
          },
          {
            name: "By day",
            columns: ["Day", "Revenue"],
            rows: cur.body.by_day.map((d: { day: string; revenue_vnd: number }) => [d.day, d.revenue_vnd]),
          },
          {
            name: "By cashier shift",
            columns: ["Cashier", "Opened", "Taken", "Refunds", "Payments"],
            rows: cur.body.by_shift.map((s: { cashier: string | null; opened_at: string | null; takings_vnd: number; refunds_vnd: number; count: number }) => [
              s.cashier ?? "Online (no shift)",
              s.opened_at ? new Date(s.opened_at).toLocaleString("en-GB", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short" }) : "",
              s.takings_vnd,
              s.refunds_vnd,
              s.count,
            ]),
          },
        ],
      },
    };
  }
  const { from, to, sport } = await windowParams(sql, request);
  const sportFilter: [string, string] = ["Sport", sport ? sportLabel(sport) : "All"];
  if (kind === "capacity") {
    const d = await capacityBody(sql, from, to, sport);
    return {
      from,
      to,
      doc: {
        title: "Court capacity report",
        filters: filterRows(from, to, [sportFilter, ["Open hours", `${d.open_hour}:00 – ${d.close_hour}:00`]]),
        generated_at,
        sections: [
          {
            name: "By sport",
            columns: ["Sport", "Sold hours", "Open hours", "Used %", "Peak %", "Off-peak %"],
            rows: d.by_sport.map((s) => [sportLabel(s.sport), Math.round(s.sold_min / 6) / 10, Math.round(s.open_min / 6) / 10, s.pct, s.peak_pct, s.offpeak_pct]),
            total: ["All courts", Math.round(d.totals.sold_min / 6) / 10, Math.round(d.totals.open_min / 6) / 10, d.totals.pct, null, null],
            note: "Used % = hours sold (bookings and classes) ÷ hours open.",
          },
          {
            name: "By court",
            columns: ["Court", "Sport", "Sold hours", "Open hours", "Used %"],
            rows: d.courts.map((c) => [c.court_code, sportLabel(c.sport), Math.round(c.sold_min / 6) / 10, Math.round(c.open_min / 6) / 10, c.pct]),
          },
          {
            name: "Heatmap (used % by hour)",
            columns: ["Court", ...d.hours.map((h) => `${String(h).padStart(2, "0")}h`)],
            rows: d.courts.map((c) => [c.court_code, ...c.cells]),
            total: ["All courts", ...d.by_hour.map((h) => h.pct)],
          },
          {
            name: "Court rental vs class fees",
            columns: ["Source", "Taken (VND)"],
            rows: [
              ["Court rental", d.revenue_by_source.court_vnd],
              ["Class fees", d.revenue_by_source.class_vnd],
            ],
          },
        ],
      },
    };
  }
  const d = await membersReportBody(sql, from, to, sport);
  return {
    from,
    to,
    doc: {
      title: "Members and classes report",
      filters: filterRows(from, to, [sportFilter]),
      generated_at,
      sections: [
        {
          name: "Members",
          columns: ["Measure", "Value"],
          rows: [
            ["New members", d.members.new],
            ["Members with a live plan on the last day", d.members.active],
            ["Members whose plan ended with no new one", d.members.expiring],
            ["Plans that ended in the period", d.members.plans_ended],
            ["…of which renewed within 30 days", d.members.plans_renewed],
            ["Renewal rate %", d.members.renewal_rate],
          ],
        },
        {
          name: "12-month trend",
          columns: ["Month", "New members", "Plans started"],
          rows: d.trend.map((m) => [m.month, m.new_members, m.plans_started]),
        },
        {
          name: "Classes",
          columns: ["Class", "Sport", "Coach", "Capacity", "Enrolled", "Waitlist", "Fill %", ...(d.attendance_on ? ["Attendance %"] : [])],
          rows: d.classes.map((c) => [
            c.code,
            sportLabel(c.sport),
            c.coach,
            c.capacity,
            c.enrolled,
            c.waitlisted,
            c.fill_pct,
            ...(d.attendance_on ? [c.attendance_pct] : []),
          ]),
        },
      ],
    },
  };
}

export async function reportsExport(sql: Sql, request: Request, user: PublicUser, kind: string) {
  requireRole(user, ["manager"]);
  if (!(KINDS as readonly string[]).includes(kind)) throw err.notFound("Unknown report.");
  const format = new URL(request.url).searchParams.get("format") ?? "xlsx";
  if (format !== "xlsx" && format !== "pdf") throw err.field("format", "Use xlsx or pdf.");
  const { doc, from, to } = await reportDoc(sql, request, kind);
  const bytes = format === "xlsx" ? buildXlsx(doc) : await buildReportPdf(doc);
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      "content-type":
        format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf",
      "content-disposition": `attachment; filename="arena3-${kind}-${from}_${to}.${format}"`,
      "cache-control": "no-store",
    },
  });
}
