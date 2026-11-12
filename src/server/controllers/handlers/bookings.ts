import { PLAYED_SQL } from "./played";
import type { Sql } from "@/server/data/db";
import { BOOKING_COLS, PAYMENT_COLS } from "../../services/columns";
import type { Booking, BookingResponse, CancelQuoteResponse, CancelResponse, CheckInResponse, CollectBalanceResponse, ConfirmResponse, HoldResponse, MeBookingsResponse, MyBooking, MyClassSession, Payment, Reply, RescheduleResponse, SettledBooking, TransferConfirmResponse, TransferRejectResponse, WalkInResponse } from "../../../shared/arena3/contracts";
import { ApiError, err, isConflictSlot } from "../errors";
import { audit, bookingBuyer, enqueue, enqueueReceipt, getSettings, issueInvoice, nextCode, num, readJson, str } from "../helpers";
import { isValidVnPhone, normalizePhone } from "../../services/phone";
import { memberCourtFee } from "../../services/membership";
import { dueNow, quoteCancel } from "../../services/policy";
import { applyDiscount, lookupPrice } from "../../services/pricing";
import { quotePromo, redeemForBooking, restoreIfFullyRefunded } from "../../services/promos";
import { requireRole, type PublicUser } from "../session";
import { addDays, ictClock, ictDateString, ictDateTime, ictMinutes, ictStamp, roundVnd } from "../../../shared/arena3/time";
import { one } from "../tx";
import { getActiveSportCodes } from "./sports";

async function courtById(sql: Sql, id: string) {
  const c = await one<{
    id: string;
    court_code: string;
    sport: string;
    status: string;
    display_name: string | null;
    sort_order: number | null;
    retired_at: string | null;
  }>(sql, `select id, court_code, sport, status, display_name, sort_order, retired_at from courts where id = $1`, [id]);
  if (!c) throw err.notFound("No such court.");
  return c;
}

function slotBounds(startAt: Date, slotMin: number) {
  const end = new Date(startAt.getTime() + slotMin * 60_000);
  return { start: startAt, end };
}

export function assertSlotGrid(
  start: Date,
  settings: { slot_minutes: number; open_time: string; close_time: string },
) {
  if (Number.isNaN(start.getTime())) {
    throw err.field("start_at", "That time is not valid.");
  }
  const date = ictDateString(start);
  const open = ictDateTime(date, settings.open_time.slice(0, 5));
  const close = ictDateTime(date, settings.close_time.slice(0, 5));
  if (start < open || start >= close) {
    throw err.br("BR-06", "That is outside opening hours.");
  }
  const [oh, om] = settings.open_time.split(":").map(Number);
  const openMinutes = oh * 60 + (om || 0);
  const startMin = ictMinutes(start);

  if (
    start.getUTCSeconds() !== 0 ||
    start.getUTCMilliseconds() !== 0 ||
    Math.abs(startMin - openMinutes) % settings.slot_minutes !== 0
  ) {
    throw err.field("start_at", "Start time must be aligned to the slot grid.");
  }
  const end = new Date(start.getTime() + settings.slot_minutes * 60_000);
  if (end > close) {
    throw err.field("start_at", "Slot would end after closing time.");
  }
}

async function assertBookWindow(
  start: Date,
  opts: { walkIn: boolean; settings: Awaited<ReturnType<typeof getSettings>> },
) {
  const now = new Date();
  if (!opts.walkIn && start < now) throw err.br("BR-07", "You cannot book a slot in the past.");
  if (opts.walkIn && start < now) {
    const remain = (start.getTime() + opts.settings.slot_minutes * 60_000 - now.getTime()) / 60_000;
    if (remain < 20) throw err.br("BR-07", "Walk-ins need at least 20 minutes left in the slot.");
  }
  assertSlotGrid(start, opts.settings);
  if (!opts.walkIn) {
    const ahead = opts.settings.book_ahead_days;
    const max = new Date(now.getTime() + ahead * 86400000);
    if (start > max) throw err.br("BR-05", `You can book at most ${ahead} days ahead.`);
  }
}

/** Whether this person already has a court overlapping that time. Back-to-back slots do not overlap; holds are left out because a new hold replaces the old one. */
export async function hasCourtOverlap(sql: Sql, userId: string, start: Date, end: Date, excludeId?: string) {
  const clash = await one(
    sql,
    `select 1 from court_bookings
      where user_id = $1 and status in ('confirmed','in_use')
        and start_at < $3 and end_at > $2
        and ($4::uuid is null or id <> $4::uuid)
      limit 1`,
    [userId, start.toISOString(), end.toISOString(), excludeId ?? null],
  );
  return !!clash;
}

/** One person, one court at a time. The lock makes two taps at the same moment queue up. */
async function assertNoCourtOverlap(sql: Sql, userId: string, start: Date, end: Date, excludeId?: string) {
  await sql.query(`select pg_advisory_xact_lock(hashtext($1))`, [userId]);
  if (await hasCourtOverlap(sql, userId, start, end, excludeId)) {
    throw err.br("BR-05", "You already have a court at that time.");
  }
}

async function overlapClass(sql: Sql, userId: string, start: Date, end: Date) {
  return one(
    sql,
    `select s.id, s.start_at, cl.level, c.court_code
       from sessions s
       join classes cl on cl.id = s.class_id
       join enrollments e on e.class_id = cl.id and e.user_id = $1 and e.status = 'confirmed'
       join courts c on c.id = s.court_id
      where s.status = 'scheduled'
        and tstzrange(s.start_at, s.end_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
      limit 1`,
    [userId, start.toISOString(), end.toISOString()],
  );
}

export async function occupancyGet(sql: Sql, request: Request) {
  const date = new URL(request.url).searchParams.get("date") ?? ictDateString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw err.validation("date YYYY-MM-DD.");
  const start = ictDateTime(date, "00:00");
  const end = new Date(ictDateTime(date, "23:59").getTime() + 60_000);
  const rows = await sql.query<{
    court_id: string;
    start_at: string;
    end_at: string;
    kind: string;
    ref_id: string;
  }>(
    `select court_id, start_at, end_at, kind, ref_id from ${PLAYED_SQL} o
      where start_at < $2 and end_at > $1
      order by court_id, start_at`,
    [start.toISOString(), end.toISOString()],
  );
  const courts = await sql.query(
    `select id, court_code, sport, status, display_name, sort_order from courts where retired_at is null order by sort_order nulls last, court_code`,
  );
  return {
    status: 200,
    body: {
      date,
      courts,
      slots: rows.map((r) => ({
        court_id: r.court_id,
        start: r.start_at,
        end: r.end_at,
        kind: r.kind,
        ref: r.ref_id,
      })),
    },
  };
}

/**
 * Which days still have a free slot (M-03).
 *
 * The court map answers one day at a time, so a member hunting for "any evening
 * this week" had to open seven of them. This answers the whole stretch in one
 * read: for each day, how many court-slots of the sport are still sellable
 * (ready courts, inside opening hours, not already taken, not in the past) out
 * of how many there are, and whether the day is inside the booking horizon.
 * Counts only — who holds what stays on the day view.
 */
export async function availabilityGet(sql: Sql, request: Request, user?: PublicUser | null) {
  const params = new URL(request.url).searchParams;
  const today = ictDateString();
  const from = params.get("from") ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw err.field("from", "from must be YYYY-MM-DD.");
  const days = Number(params.get("days") ?? 31);
  if (!Number.isInteger(days) || days < 1 || days > 62) throw err.field("days", "days must be 1 to 62.");
  const sport = params.get("sport");
  if (sport && !(await getActiveSportCodes(sql)).includes(sport)) {
    throw err.field("sport", "Unknown sport.");
  }
  const first = from < today ? today : from;
  const settings = await getSettings(sql);
  const courts = await sql.query<{ id: string }>(
    `select id from courts where status = 'ready' and retired_at is null and ($1::text is null or sport::text = $1) order by sort_order nulls last, court_code`,
    [sport],
  );
  const rangeStart = ictDateTime(first, "00:00");
  const rangeEnd = ictDateTime(addDays(first, days), "00:00");
  const occ = await sql.query<{ court_id: string; start_at: string; end_at: string }>(
    `select court_id, start_at, end_at from occupancies where start_at < $2 and end_at > $1`,
    [rangeStart.toISOString(), rangeEnd.toISOString()],
  );
  const byCourt = new Map<string, { s: number; e: number }[]>();
  for (const o of occ) {
    const list = byCourt.get(o.court_id) ?? [];
    list.push({ s: new Date(o.start_at).getTime(), e: new Date(o.end_at).getTime() });
    byCourt.set(o.court_id, list);
  }
  const now = Date.now();
  const horizon = now + settings.book_ahead_days * 86400000;
  const step = settings.slot_minutes * 60_000;
  // For a signed-in member, how many courts they already have each day.
  const mine = new Map<string, number>();
  if (user?.role === "member") {
    const rows = await sql.query<{ d: string; n: number }>(
      `select (start_at at time zone 'Asia/Ho_Chi_Minh')::date::text as d, count(*)::int as n
         from court_bookings
        where user_id = $1 and status in ('confirmed','in_use') and start_at >= $2 and start_at < $3
        group by 1`,
      [user.id, rangeStart.toISOString(), rangeEnd.toISOString()],
    );
    for (const r of rows) mine.set(r.d, Number(r.n));
  }
  const out: { date: string; free: number; total: number; bookable: boolean; mine?: number }[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(first, i);
    const open = ictDateTime(date, settings.open_time.slice(0, 5)).getTime();
    const close = ictDateTime(date, settings.close_time.slice(0, 5)).getTime();
    let total = 0;
    let free = 0;
    for (let t = open; t < close; t += step) {
      for (const c of courts) {
        total++;
        if (t < now || t > horizon) continue;
        const taken = (byCourt.get(c.id) ?? []).some((o) => o.s < t + step && o.e > t);
        if (!taken) free++;
      }
    }
    out.push({
      date,
      free,
      total,
      bookable: Boolean(total) && date <= ictDateString(new Date(horizon)),
      ...(user?.role === "member" ? { mine: mine.get(date) ?? 0 } : {}),
    });
  }
  return {
    status: 200,
    body: { from: first, sport: sport ?? null, days: out },
  };
}

/**
 * The member's own upcoming court bookings, each with whether it can still be
 * moved. The home screen only shows today's, which left no way to find a
 * booking next week in order to change it.
 */
export async function meBookings(sql: Sql, user: PublicUser): Promise<Reply<MeBookingsResponse>> {
  requireRole(user, ["member"]);
  const settings = await getSettings(sql);
  const rows = await sql.query<Omit<MyBooking, "can_move">>(
    `select b.id, b.code, b.status::text as status, b.start_at, b.end_at, b.price_vnd, b.paid_vnd, b.deposit_vnd, b.series_id, b.quota_hours,
            b.court_id, c.court_code, c.sport::text as sport
       from court_bookings b join courts c on c.id = b.court_id
      where b.user_id = $1 and b.status in ('hold','confirmed','in_use') and b.end_at > now()
      order by b.start_at
      limit 50`,
    [user.id],
  );
  // The classes the member is enrolled in run on courts too: their coming sessions sit beside the
  // courts they booked, so the member sees one schedule rather than half of it.
  const class_sessions = await sql.query<MyClassSession>(
    `select s.id, s.class_id, s.start_at, s.end_at, cl.sport::text as sport, cl.level, c.court_code,
            u.full_name as coach_name
       from sessions s
       join classes cl on cl.id = s.class_id
       join enrollments e on e.class_id = cl.id and e.user_id = $1 and e.status = 'confirmed'
       join courts c on c.id = s.court_id
       join users u on u.id = cl.coach_id
      where s.status = 'scheduled' and s.end_at > now()
      order by s.start_at
      limit 50`,
    [user.id],
  );
  const now = Date.now();
  return {
    status: 200,
    body: {
      window_hours: settings.cancel_court_hours,
      cancel_tiers: [],
      class_sessions,
      items: rows.map((r) => ({
        ...r,
        can_move:
          r.status === "confirmed" &&
          (new Date(r.start_at).getTime() - now) / 3600000 >= settings.cancel_court_hours,
      })),
    },
  };
}

/**
 * What is behind a taken cell on the court map (B-07).
 *
 * The grid only knows that an hour is occupied. At the counter the next
 * question is always "whose is it, what did they pay, and is it confirmed?", so
 * this answers it for the occupancy the desk clicked: a booking or hold (member
 * or walk-in, code, time, amount, status), a class session, or the reason a
 * court was taken out of service. Reception and the manager only — members see
 * that an hour is taken, never by whom.
 */
export async function occupancyDetail(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  const params = new URL(request.url).searchParams;
  const kind = params.get("kind") ?? "";
  const ref = params.get("ref") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(ref)) throw err.field("ref", "ref must be an id.");

  if (kind === "booking" || kind === "hold") {
    const b = await one<{
      id: string;
      code: string;
      status: string;
      channel: string;
      start_at: string;
      end_at: string;
      price_vnd: number;
      discount_pct: number;
      hold_until: string | null;
      transfer_requested_at: string | null;
      court_code: string;
      sport: string;
      user_id: string | null;
      member_name: string | null;
      member_code: string | null;
      member_phone: string | null;
      guest_name: string | null;
      guest_phone: string | null;
    }>(
      sql,
      `select b.id, b.code, b.status::text as status, b.channel, b.start_at, b.end_at, b.price_vnd,
              b.discount_pct, b.hold_until, b.transfer_requested_at,
              c.court_code, c.sport::text as sport,
              b.user_id, u.full_name as member_name, u.member_code, u.phone as member_phone,
              b.guest_name, b.guest_phone
         from court_bookings b
         join courts c on c.id = b.court_id
         left join users u on u.id = b.user_id
        where b.id = $1`,
      [ref],
    );
    if (!b) throw err.notFound("No such booking.");
    const paid = await one<{ paid_vnd: number }>(
      sql,
      `select coalesce(sum(amount_vnd) filter (where status in ('posted','refund_pending')), 0)::int as paid_vnd
         from payments where ref_type = 'booking' and ref_id = $1`,
      [b.id],
    );
    return {
      status: 200,
      body: {
        kind: "booking",
        booking: {
          id: b.id,
          code: b.code,
          status: b.status,
          channel: b.channel,
          start_at: b.start_at,
          end_at: b.end_at,
          price_vnd: b.price_vnd,
          discount_pct: b.discount_pct,
          paid_vnd: paid?.paid_vnd ?? 0,
          hold_until: b.hold_until,
          awaiting_transfer: Boolean(b.transfer_requested_at) && b.status === "hold",
          court_code: b.court_code,
          sport: b.sport,
        },
        customer: b.user_id
          ? { type: "member", id: b.user_id, name: b.member_name, phone: b.member_phone, member_code: b.member_code }
          : { type: "guest", id: null, name: b.guest_name, phone: b.guest_phone, member_code: null },
      },
    };
  }

  if (kind === "session") {
    const s = await one<{
      id: string;
      class_id: string;
      start_at: string;
      end_at: string;
      status: string;
      court_code: string;
      sport: string;
      level: string;
      capacity: number;
      enrolled_count: number;
      coach_name: string;
    }>(
      sql,
      `select s.id, s.class_id, s.start_at, s.end_at, s.status::text as status,
              c.court_code, cl.sport::text as sport, cl.level, cl.capacity, cl.enrolled_count,
              co.full_name as coach_name
         from sessions s
         join classes cl on cl.id = s.class_id
         join courts c on c.id = s.court_id
         join users co on co.id = cl.coach_id
        where s.id = $1`,
      [ref],
    );
    if (!s) throw err.notFound("No such session.");
    return { status: 200, body: { kind: "session", session: s } };
  }

  if (kind === "maintenance") {
    const o = await one<{ reason: string | null; court_code: string; start_at: string; end_at: string }>(
      sql,
      `select o.reason, c.court_code, o.start_at, o.end_at
         from occupancies o join courts c on c.id = o.court_id
        where o.kind = 'maintenance' and o.ref_id = $1 limit 1`,
      [ref],
    );
    if (!o) throw err.notFound();
    return { status: 200, body: { kind: "maintenance", maintenance: o } };
  }

  throw err.field("kind", "kind must be booking, hold, session or maintenance.");
}

export async function courtsList(sql: Sql) {
  const items = await sql.query(
    `select id, court_code, sport, status, display_name, sort_order, retired_at
       from courts
      where retired_at is null
      order by sort_order nulls last, court_code`,
  );
  return { status: 200, body: { items } };
}

const COURT_STATUSES = ["ready", "maintenance", "closed"] as const;

/**
 * Take a court out of service, put it back, or update court metadata.
 */
export async function courtsPatch(sql: Sql, id: string, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const b = await readJson(request);
  const cur = await courtById(sql, id);

  const status = str(b.status);

  const hasExtraFields =
    b.court_code !== undefined ||
    b.display_name !== undefined ||
    b.sort_order !== undefined ||
    b.sport !== undefined;

  // Preserve exact original behavior if only status is being patched (or no extra fields)
  if (!hasExtraFields) return patchCourtStatus(sql, id, user, b, cur, status);
  return patchCourtMetadata(sql, id, user, b, cur, status);
}

async function patchCourtStatus(sql: Sql, id: string, user: PublicUser, b: Record<string, unknown>, cur: Awaited<ReturnType<typeof courtById>>, status: string | undefined) {
  if (!status || !(COURT_STATUSES as readonly string[]).includes(status)) {
    throw err.validation(`status must be one of ${COURT_STATUSES.join(", ")}.`);
  }
  if (cur.status === status) return { status: 200, body: { court: cur, upcoming: 0 } };

  if (status === "closed" && cur.status !== "closed") {
    const remaining = await one<{ cnt: number }>(
      sql,
      `select count(*)::int as cnt from courts where sport = $1 and retired_at is null and status <> 'closed' and id <> $2`,
      [cur.sport, id],
    );
    if (!remaining || remaining.cnt === 0) {
      const activeClasses = await one<{ cnt: number }>(
        sql,
        `select count(*)::int as cnt from classes where sport = $1 and status = 'open'`,
        [cur.sport],
      );
      if ((activeClasses?.cnt ?? 0) > 0) {
        throw new ApiError(
          409,
          "CONFLICT_STATE",
          "Cannot close the last available court for a sport with active classes.",
        );
      }
    }
  }

  const reason = str(b.reason) ?? null;
  await sql.query(`update courts set status = $2 where id = $1`, [id, status]);
  const live = await one<{ n: number }>(
    sql,
    `select count(*)::int as n from occupancies where court_id = $1 and end_at > now()`,
    [id],
  );
  await audit(sql, user.id, "patch_court", "court", id, { from: cur.status, to: status, reason });
  const court = await one(
    sql,
    `select id, court_code, sport, status, display_name, sort_order, retired_at from courts where id = $1`,
    [id],
  );
  return { status: 200, body: { court, upcoming: live?.n ?? 0 } };
}

async function courtSportForPatch(sql: Sql, id: string, b: Record<string, unknown>, cur: Awaited<ReturnType<typeof courtById>>) {
  let nextSport = cur.sport;
  if (b.sport !== undefined) {
    const s = str(b.sport);
    const valid = await getActiveSportCodes(sql);
    if (!s || !valid.includes(s)) {
      throw err.field("sport", "Unknown sport.");
    }
    if (s !== cur.sport) {
      const futureOccupancies = await one<{ cnt: number }>(
        sql,
        `select count(*)::int as cnt from (
           select 1 from occupancies where court_id = $1 and end_at > now()
           union all
           select 1 from court_bookings where court_id = $1 and end_at > now() and status::text in ('hold', 'confirmed', 'in_use', 'paid')
         ) t`,
        [id],
      );
      if (futureOccupancies && futureOccupancies.cnt > 0) {
        throw new ApiError(
          409,
          "CONFLICT_STATE",
          "Cannot change court sport while it has upcoming bookings or classes.",
          { affected: futureOccupancies.cnt },
        );
      }
      nextSport = s;
    }
  }

  return nextSport;
}

async function patchCourtMetadata(sql: Sql, id: string, user: PublicUser, b: Record<string, unknown>, cur: Awaited<ReturnType<typeof courtById>>, status: string | undefined) {
  if (b.status !== undefined) {
    if (!status || !(COURT_STATUSES as readonly string[]).includes(status)) {
      throw err.validation(`status must be one of ${COURT_STATUSES.join(", ")}.`);
    }
  }

  let nextCourtCode = cur.court_code;
  if (b.court_code !== undefined) {
    const rawCode = str(b.court_code)?.trim().toUpperCase() || "";
    if (rawCode.length > 8 || !/^[A-Z]{2}-\d{2,3}$/.test(rawCode)) {
      throw err.field(
        "court_code",
        "Court code must match format like CL-01 or BR-12 (2 capital letters, dash, 2-3 digits).",
      );
    }
    if (rawCode !== cur.court_code) {
      const dup = await one(
        sql,
        `select 1 from courts where lower(court_code) = lower($1) and id <> $2`,
        [rawCode, id],
      );
      if (dup) {
        throw err.conflictSlot("That court code is already in use.");
      }
      nextCourtCode = rawCode;
    }
  }

  const nextSport = await courtSportForPatch(sql, id, b, cur);
  const nextStatus = status || cur.status;
  const nextDisplayName =
    b.display_name !== undefined ? str(b.display_name)?.trim() || null : cur.display_name;
  if (nextDisplayName && nextDisplayName.length > 40) {
    throw err.field("display_name", "Display name cannot exceed 40 characters.");
  }
  const nextSortOrder = b.sort_order !== undefined ? num(b.sort_order) ?? null : cur.sort_order;

  return saveCourtMetadata(sql, id, user, cur, nextCourtCode, nextSport, nextStatus, nextDisplayName, nextSortOrder);
}

async function saveCourtMetadata(sql: Sql, id: string, user: PublicUser, cur: Awaited<ReturnType<typeof courtById>>, nextCourtCode: string, nextSport: string, nextStatus: string, nextDisplayName: string | null, nextSortOrder: number | null) {
  await sql.query(
    `update courts
        set court_code = $1, sport = $2, status = $3, display_name = $4, sort_order = $5
      where id = $6`,
    [nextCourtCode, nextSport, nextStatus, nextDisplayName, nextSortOrder, id],
  );

  const live = await one<{ n: number }>(
    sql,
    `select count(*)::int as n from occupancies where court_id = $1 and end_at > now()`,
    [id],
  );

  await audit(
    sql,
    user.id,
    "patch_court",
    "court",
    id,
    {
      court_code: cur.court_code,
      sport: cur.sport,
      status: cur.status,
      display_name: cur.display_name,
      sort_order: cur.sort_order,
    },
    {
      court_code: nextCourtCode,
      sport: nextSport,
      status: nextStatus,
      display_name: nextDisplayName,
      sort_order: nextSortOrder,
    },
  );

  const court = await one(
    sql,
    `select id, court_code, sport, status, display_name, sort_order, retired_at from courts where id = $1`,
    [id],
  );
  return { status: 200, body: { court, upcoming: live?.n ?? 0 } };
}

export async function bookingsHold(sql: Sql, request: Request, user: PublicUser): Promise<Reply<HoldResponse>> {
  requireRole(user, ["member"]);
  const b = await readJson(request);
  const courtId = str(b.court_id);
  const startAt = str(b.start_at);
  if (!courtId || !startAt) throw err.validation("court_id and start_at are required.");
  const settings = await getSettings(sql);
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) throw err.field("start_at", "That time is not valid.");
  const { end } = slotBounds(start, settings.slot_minutes);
  await assertBookWindow(start, { walkIn: false, settings });
  const court = await courtById(sql, courtId);
  if (court.status !== "ready") throw err.br("BR-06", "That court is not available.");
  await assertNoCourtOverlap(sql, user.id, start, end);
  const overlap = await overlapClass(sql, user.id, start, end);
  if (overlap && b.confirm_overlap !== true) {
    throw err.br("BR-09", "This slot clashes with a class you are in. Confirm to hold it anyway.", {
      requires_confirm: true,
    });
  }
  const list = await lookupPrice(sql, { sport: court.sport, courtId, start });
  // A membership covering the play date fixes the price at the member fee, and no code applies to
  // it. Otherwise the list price, which a code can lower: priced into the hold so the member sees
  // what they will pay, and only counted when the money posts (BR-41).
  const covered = await memberCourtFee(sql, user.id, start, settings);
  const promoCode = covered ? null : str(b.promo_code);
  const promo = promoCode
    ? await quotePromo(sql, {
        code: promoCode,
        userId: user.id,
        scope: "court",
        sport: court.sport,
        orderVnd: list.price_vnd,
        listVnd: list.price_vnd,
      })
    : null;
  const price = covered ? covered.fee_vnd : promo ? promo.final_vnd : list.price_vnd;
  // Courts are paid in full up front.
  const deposit = 0;
  const bookingIdRow = await one<{ id: string }>(sql, `select gen_random_uuid() as id`);
  const bookingId = bookingIdRow!.id;
  const holdUntil = new Date(Date.now() + settings.hold_minutes * 60_000);
  let occId: string;
  try {
    const occ = await one<{ booking_replace_hold: string }>(
      sql,
      `select booking_replace_hold($1::uuid, null, $2::uuid, $3::timestamptz, $4::timestamptz, $5::uuid) as booking_replace_hold`,
      [user.id, courtId, start.toISOString(), end.toISOString(), bookingId],
    );
    occId = occ!.booking_replace_hold;
  } catch (e) {
    if (isConflictSlot(e)) throw err.conflictSlot("Someone just took that slot.");
    throw e;
  }
  const code = await nextCode(sql, "CRT");
  await sql.query(
    `insert into court_bookings
       (id, code, court_id, user_id, start_at, end_at, status, channel, price_vnd, discount_pct, vat_rate, hold_until, occupancy_id,
        promo_id, promo_discount_vnd, deposit_vnd)
     values ($1,$2,$3,$4,$5,$6,'hold','app',$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      bookingId,
      code,
      courtId,
      user.id,
      start.toISOString(),
      end.toISOString(),
      price,
      0,
      Number(settings.vat_rate),
      holdUntil.toISOString(),
      occId,
      promo?.promo_id ?? null,
      promo?.discount_vnd ?? 0,
      deposit,
    ],
  );
  const booking = await one<Booking>(sql, `select ${BOOKING_COLS} from court_bookings where id = $1`, [bookingId]);
  return {
    status: 201,
    body: {
      booking: booking!,
      hold_until: holdUntil.toISOString(),
      price,
      deposit_vnd: deposit,
      due_now_vnd: price,
      list_price: list.price_vnd,
      membership: { covered: !!covered, end_on: covered?.end_on ?? null },
      promo: promo ? { code: promo.code, name: promo.name, discount_vnd: promo.discount_vnd } : null,
    },
  };
}

/** What settling a hold reads off the booking, locked `for update` by every caller. */
const HELD_KEYS = [
  "id",
  "code",
  "user_id",
  "status",
  "hold_until",
  "transfer_requested_at",
  "occupancy_id",
  "court_id",
  "start_at",
  "end_at",
  "price_vnd",
  "deposit_vnd",
  "discount_pct",
  "vat_rate",
  "quota_hours",
] as const satisfies readonly (keyof Booking)[];
export const HELD_COLS = HELD_KEYS.join(", ");
/** A hold is always a member's: walk-ins are paid on the spot and never held. */
type HeldBooking = Omit<Pick<Booking, (typeof HELD_KEYS)[number]>, "user_id"> & { user_id: string };

/**
 * Turn a held booking into a paid, confirmed one: money in, slot locked,
 * invoice issued, member told.
 *
 * Shared by the member confirming at the moment of booking and by the desk
 * confirming a bank transfer hours later, because those two have to leave the
 * database in exactly the same state — a transfer reconciled at reception must
 * produce the same payment row and the same receipt as any other booking, or
 * the member ends up with a court and no proof they paid for it.
 */
export async function settleHeldBooking(
  sql: Sql,
  booking: HeldBooking,
  court: { court_code: string },
  opts: {
    method: string;
    payAmount: number;
    quotaHours: number;
    /** Whose name goes on the receipt. */
    buyerName: string;
    /** A guest booking's phone; null when the buyer is a member. */
    buyerPhone?: string | null;
    /** Who pressed the button — the member, or the receptionist. */
    actorId: string;
    /**
     * Settle against a payment row that already exists, instead of writing one.
     * Set by the payOS path, where the row was created as `pending` when the
     * link was issued.
     */
    existingPaymentId?: string;
  },
): Promise<SettledBooking> {
  // An online payment already has its row: it was written as `pending` when the
  // payOS link was issued, and the gateway's confirmation flipped it to
  // `posted`. Writing a second one here would double the day's takings.
  const pay = opts.existingPaymentId
    ? { id: opts.existingPaymentId }
    : await one<{ id: string }>(
        sql,
        `insert into payments (code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by, capture_mode)
         values ($1,$2,$3,$4,$5,'posted','booking',$6,$7,'manual') returning id`,
        [
          await nextCode(sql, "PAY"),
          booking.user_id,
          opts.method,
          opts.payAmount,
          Number(booking.vat_rate),
          booking.id,
          opts.actorId,
        ],
      );
  try {
    await sql.query(`select occupancy_confirm_hold($1::uuid)`, [booking.occupancy_id]);
  } catch {
    throw err.holdExpired();
  }
  // Plan hours carry no money, so no code applies; otherwise the code is spent now.
  if (opts.payAmount > 0) await redeemForBooking(sql, booking.id, booking.user_id, pay!.id);
  await sql.query(
    `update court_bookings
        set status = 'confirmed', quota_hours = $2,
            price_vnd = case when $3::int > 0 then price_vnd else 0 end,
            paid_vnd = $3,
            hold_until = null, transfer_requested_at = null,
            promo_id = case when $3::int > 0 then promo_id else null end,
            promo_discount_vnd = case when $3::int > 0 then promo_discount_vnd else 0 end
      where id = $1`,
    [booking.id, opts.quotaHours, opts.payAmount],
  );
  const settings = await getSettings(sql);
  const invoiceId = await issueInvoice(sql, {
    paymentId: pay!.id,
    buyerName: opts.buyerName,
    buyerPhone: opts.buyerPhone ?? null,
    amountVnd: opts.payAmount,
    vatRate: Number(booking.vat_rate ?? 0),
    description:
      `${opts.payAmount < booking.price_vnd ? "Cọc thuê sân" : "Thuê sân"} ${court.court_code} — ` +
      `${ictStamp(booking.start_at)}–${ictClock(booking.end_at)}`,
    unit: "giờ",
    settings,
  });
  await enqueue(
    sql,
    "inapp",
    "booking_confirmed",
    booking.user_id,
    { booking_id: booking.id, code: booking.code },
    `booking_confirmed|${booking.id}`,
  );
  // Paid with plan hours is still a transaction worth a record, but it is not a
  // receipt for money — there is nothing for the member to have been charged.
  if (opts.payAmount > 0) {
    await enqueueReceipt(sql, booking.user_id, {
      payment_id: pay!.id,
      invoice_id: invoiceId,
      amount_vnd: opts.payAmount,
      method: opts.method,
    });
  }
  const fresh = await one<Booking>(sql, `select ${BOOKING_COLS} from court_bookings where id = $1`, [booking.id]);
  const payment = await one<Payment>(sql, `select ${PAYMENT_COLS} from payments where id = $1`, [pay!.id]);
  return { booking: fresh!, payment: payment!, invoice_id: invoiceId };
}

/**
 * What a member is allowed to settle their own booking with.
 *
 * `transfer` only asks reception to go and look at the bank — it posts no money
 * itself. (`quota` used to spend plan hours; plans are gone.) Everything else means
 * "cash/card changed hands", which is a claim only somebody standing at the
 * till can make.
 *
 * Without this list `method` went from the request body straight into the
 * payment row, so a member could POST `{"method":"cash"}` and mark their own
 * booking paid for money nobody had collected. `gateway` is absent on purpose:
 * an online payment becomes real when payOS confirms it, never because a
 * client said so.
 */
const MEMBER_SETTLE_METHODS = new Set(["transfer"]);

export async function bookingsConfirm(
  sql: Sql,
  id: string,
  request: Request,
  user: PublicUser,
): Promise<Reply<ConfirmResponse>> {
  requireRole(user, ["member"]);
  const b = await readJson(request);
  const method = str(b.method) ?? "transfer";
  // Plans are gone, so there are no court hours to spend. Say so on the field.
  if (method === "quota") {
    throw new ApiError(422, "VALIDATION", "Court hours are no longer sold; pay the slot price.", { field: "method" });
  }
  if (!MEMBER_SETTLE_METHODS.has(method)) {
    throw err.forbidden(
      "Pay online, or pay at the front desk — a booking cannot be marked paid from the app.",
    );
  }
  const settings = await getSettings(sql);
  const booking = await one<HeldBooking>(
    sql,
    `select ${HELD_COLS} from court_bookings where id = $1 for update`,
    [id],
  );
  if (!booking) throw err.notFound();
  if (booking.user_id !== user.id) throw err.forbidden();
  if (booking.status !== "hold") throw err.conflictState("That booking is no longer on hold.");
  if (booking.transfer_requested_at) {
    throw err.conflictState("Reception is already checking the bank for this one.");
  }
  if (!booking.hold_until || new Date(booking.hold_until) < new Date()) {
    throw err.holdExpired();
  }
  const court = await courtById(sql, booking.court_id);

  /*
   * A bank transfer is a promise, not a payment.
   *
   * Nothing is posted and nothing is confirmed here: the slot stays on hold —
   * still blocking the court, still swept by expire_holds if the money never
   * arrives — on a longer clock, because five minutes is the wrong amount of
   * time to give somebody who has to open a banking app. Reception confirms it
   * against the statement, and only then does a payment row exist.
   */
  if (method === "transfer") {
    const until = new Date(Date.now() + settings.transfer_hold_minutes * 60_000);
    await sql.query(
      `update court_bookings set hold_until = $2, transfer_requested_at = now() where id = $1`,
      [booking.id, until.toISOString()],
    );
    await enqueue(
      sql,
      "inapp",
      "transfer_requested",
      user.id,
      { booking_id: booking.id, code: booking.code, amount_vnd: dueNow(booking) },
      `transfer_requested|${booking.id}`,
    );
    const fresh = await one<Booking>(sql, `select ${BOOKING_COLS} from court_bookings where id = $1`, [id]);
    return {
      status: 202,
      body: {
        booking: fresh!,
        payment: null,
        invoice_id: null,
        awaiting_transfer: true,
        hold_until: until.toISOString(),
        amount_vnd: dueNow(booking),
      },
    };
  }

  const settled = await settleHeldBooking(sql, booking, court, {
    method,
    payAmount: dueNow(booking),
    quotaHours: 0,
    buyerName: user.full_name,
    actorId: user.id,
  });
  return { status: 200, body: settled };
}

/**
 * Reception has seen the money land in the bank account.
 *
 * Staff-only on purpose: the member asking for this would be marking their own
 * transfer as received, which is the whole thing this queue exists to prevent.
 */
export async function bookingsTransferConfirm(
  sql: Sql,
  id: string,
  user: PublicUser,
): Promise<Reply<TransferConfirmResponse>> {
  requireRole(user, ["receptionist", "manager"]);
  const booking = await one<HeldBooking>(
    sql,
    `select ${HELD_COLS} from court_bookings where id = $1 for update`,
    [id],
  );
  if (!booking) throw err.notFound();
  if (!booking.transfer_requested_at) {
    throw err.conflictState("No transfer was requested for this booking.");
  }
  if (booking.status !== "hold") throw err.conflictState("That booking is no longer on hold.");
  // The hold is checked, not waived. A slot whose clock ran out has already
  // been handed back by the sweeper or is about to be, and confirming it would
  // sell a court that somebody else may already have booked.
  if (!booking.hold_until || new Date(booking.hold_until) < new Date()) {
    throw err.holdExpired();
  }
  const court = await courtById(sql, booking.court_id);
  const buyer = await bookingBuyer(sql, booking.id);
  const settled = await settleHeldBooking(sql, booking, court, {
    method: "transfer",
    payAmount: dueNow(booking),
    quotaHours: 0,
    buyerName: buyer.name,
    buyerPhone: buyer.phone,
    actorId: user.id,
  });
  await audit(sql, user.id, "transfer_confirm", "booking", booking.id);
  return { status: 200, body: settled };
}

/** The money never arrived, or arrived wrong. The slot goes back on sale. */
export async function bookingsTransferReject(
  sql: Sql,
  id: string,
  request: Request,
  user: PublicUser,
): Promise<Reply<TransferRejectResponse>> {
  requireRole(user, ["receptionist", "manager"]);
  const reason = str((await readJson(request)).reason) ?? null;
  const booking = await one<HeldBooking>(
    sql,
    `select ${HELD_COLS} from court_bookings where id = $1 for update`,
    [id],
  );
  if (!booking) throw err.notFound();
  if (!booking.transfer_requested_at) {
    throw err.conflictState("No transfer was requested for this booking.");
  }
  if (booking.status !== "hold") throw err.conflictState("That booking is no longer on hold.");
  await sql.query(`select occupancy_release_booking($1::uuid, 'cancelled'::booking_status)`, [id]);
  await sql.query(`update court_bookings set hold_until = null where id = $1`, [id]);
  await enqueue(
    sql,
    "inapp",
    "transfer_rejected",
    booking.user_id,
    { booking_id: booking.id, code: booking.code, reason },
    `transfer_rejected|${booking.id}`,
  );
  await audit(sql, user.id, "transfer_reject", "booking", booking.id, null, { reason });
  return { status: 200, body: { booking_id: id, released: true } };
}

const CANCEL_KEYS = [
  "id",
  "user_id",
  "status",
  "start_at",
  "price_vnd",
  "paid_vnd",
  "quota_hours",
  "court_id",
] as const satisfies readonly (keyof Booking)[];
type CancelRow = Pick<Booking, (typeof CANCEL_KEYS)[number]>;
const CANCEL_COLS = CANCEL_KEYS.join(", ");

/** A paid court that has already started is played, not cancellable: no refund math applies. */
const CANNOT_CANCEL_STARTED = "This booking has already started, so it cannot be cancelled.";
const hasStarted = (booking: CancelRow) => booking.status === "confirmed" && new Date(booking.start_at).getTime() <= Date.now();

/**
 * What cancelling a booking would cost, right now.
 *
 * Read-only, so the app can show "cancel now: refund 50%, lose 125,000đ" before
 * the member presses the button. Staff may ask for it waived (the centre cancelled,
 * a flood, an emergency): that is the force-majeure rule — never charge a customer
 * for something that is not their doing.
 */
export async function bookingsCancelQuote(
  sql: Sql,
  id: string,
  request: Request,
  user: PublicUser,
): Promise<Reply<CancelQuoteResponse>> {
  requireRole(user, ["member", "receptionist", "manager"]);
  const booking = await one<CancelRow>(sql, `select ${CANCEL_COLS} from court_bookings where id = $1`, [id]);
  if (!booking) throw err.notFound();
  if (user.role === "member" && booking.user_id !== user.id) throw err.forbidden();
  if (!["hold", "confirmed"].includes(booking.status)) {
    throw err.conflictState("A booking in this state cannot be cancelled.");
  }
  const settings = await getSettings(sql);
  if (hasStarted(booking)) throw err.conflictState(CANNOT_CANCEL_STARTED);
  const staff = user.role === "receptionist" || user.role === "manager";
  const waived = staff && new URL(request.url).searchParams.get("waive") === "1";
  const quote = quoteCancel({
    tiers: [],
    startAt: booking.start_at,
    paidVnd: booking.status === "hold" ? 0 : booking.paid_vnd,
    waived,
  });
  return {
    status: 200,
    body: { ...quote, tiers: [], quota_hours: Number(booking.quota_hours) || 0 },
  };
}

export async function bookingsCancel(
  sql: Sql,
  id: string,
  user: PublicUser,
  request?: Request,
): Promise<Reply<CancelResponse>> {
  requireRole(user, ["member", "receptionist", "manager"]);
  const body = request ? await readJson(request) : {};
  const booking = await one<CancelRow>(sql, `select ${CANCEL_COLS} from court_bookings where id = $1 for update`, [id]);
  if (!booking) throw err.notFound();
  if (user.role === "member" && booking.user_id !== user.id) throw err.forbidden();
  if (!["hold", "confirmed"].includes(booking.status)) {
    throw err.conflictState("A booking in this state cannot be cancelled.");
  }
  const settings = await getSettings(sql);
  if (booking.status === "hold") {
    await sql.query(`select occupancy_release_booking($1::uuid, 'cancelled'::booking_status)`, [id]);
    return { status: 200, body: { refund: null, booking_id: id } };
  }
  if (hasStarted(booking)) throw err.conflictState(CANNOT_CANCEL_STARTED);
  const staff = user.role === "receptionist" || user.role === "manager";
  const waived = staff && body.waive === true;
  const reason = str(body.reason) ?? null;
  const quote = quoteCancel({
    tiers: [],
    startAt: booking.start_at,
    paidVnd: booking.paid_vnd,
    waived,
  });
  await sql.query(`select occupancy_release_booking($1::uuid, 'cancelled'::booking_status)`, [id]);
  await sql.query(`update court_bookings set cancel_refund_pct = $2, cancel_fee_vnd = $3 where id = $1`, [
    id,
    quote.refund_pct,
    quote.fee_vnd,
  ]);
  let refund: Payment | null = null;
  const qh = Number(booking.quota_hours) || 0;
  if (qh > 0) {
    // Old bookings paid with plan hours. Plans no longer exist, so there is
    // nothing to give back: those hours are history, and no row is touched.
    refund = null;
  } else if (quote.refund_vnd > 0) {
    const payCode = await nextCode(sql, "PAY");
    const amount = -quote.refund_vnd;
    const needMgr = Math.abs(amount) >= settings.refund_manager_vnd;
    const st = needMgr ? "refund_pending" : "posted";
    refund =
      (await one<Payment>(
        sql,
        `insert into payments (code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by)
         values ($1,$2,'cash',$3,0,$4,'booking',$5,$6) returning ${PAYMENT_COLS}`,
        [payCode, booking.user_id, amount, st, id, user.id],
      )) ?? null;
    // A full refund gives the member their use of the code back (BR-41).
    if (quote.fee_vnd === 0) await restoreIfFullyRefunded(sql, "booking", id);
  }
  await enqueue(
    sql,
    "inapp",
    "booking_cancelled",
    booking.user_id,
    { id, fee_vnd: quote.fee_vnd, refund_vnd: quote.refund_vnd },
    `booking_cancelled|${id}`,
  );
  await audit(sql, user.id, "cancel_booking", "booking", id, null, {
    refund_pct: quote.refund_pct,
    fee_vnd: quote.fee_vnd,
    waived,
    reason,
  });
  return { status: 200, body: { refund, refundable: quote.refund_vnd > 0 || refund !== null, quote } };
}

/**
 * Take the rest of the price at the desk, usually when the customer turns up.
 * A deposit booking is confirmed with only part of the money in; this is the
 * other part, as a payment row of its own with its own invoice.
 */
export async function bookingsCollectBalance(
  sql: Sql,
  id: string,
  request: Request,
  user: PublicUser,
): Promise<Reply<CollectBalanceResponse>> {
  requireRole(user, ["receptionist", "manager"]);
  const b = await readJson(request);
  const method = str(b.method) ?? "cash";
  if (!["cash", "card", "transfer"].includes(method)) throw err.validation("Pick cash, card or transfer.");
  const booking = await one<CancelRow & Pick<Booking, "vat_rate">>(
    sql,
    `select ${CANCEL_COLS}, vat_rate from court_bookings where id = $1 for update`,
    [id],
  );
  if (!booking) throw err.notFound();
  if (!["confirmed", "in_use"].includes(booking.status)) {
    throw err.conflictState("Only a confirmed booking has a balance to collect.");
  }
  const due = booking.price_vnd - booking.paid_vnd;
  if (due <= 0) throw err.conflictState("Nothing left to pay on this booking.");
  let shiftId: string | null = null;
  if (user.role === "receptionist") {
    const shift = await one<{ id: string }>(
      sql,
      `select id from cashier_shifts where receptionist_id = $1 and closed_at is null`,
      [user.id],
    );
    if (!shift) throw err.br("BR-44", "Open a till shift before taking payment.");
    shiftId = shift.id;
  }
  const pay = await one<{ id: string }>(
    sql,
    `insert into payments (code, user_id, shift_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by)
     values ($1,$2,$3,$4,$5,$6,'posted','booking',$7,$8) returning id`,
    [await nextCode(sql, "PAY"), booking.user_id, shiftId, method, due, Number(booking.vat_rate), id, user.id],
  );
  await sql.query(`update court_bookings set paid_vnd = price_vnd where id = $1`, [id]);
  const court = await courtById(sql, booking.court_id);
  const buyer = await bookingBuyer(sql, id);
  const settings = await getSettings(sql);
  const invoiceId = await issueInvoice(sql, {
    paymentId: pay!.id,
    buyerName: buyer.name,
    buyerPhone: buyer.phone,
    amountVnd: due,
    vatRate: Number(booking.vat_rate ?? 0),
    description: `Thanh toán còn lại thuê sân ${court.court_code} — ${ictStamp(booking.start_at)}`,
    unit: "giờ",
    settings,
  });
  await enqueueReceipt(sql, booking.user_id, {
    payment_id: pay!.id,
    invoice_id: invoiceId,
    amount_vnd: due,
    method,
  });
  await audit(sql, user.id, "collect_balance", "booking", id, null, { amount_vnd: due, method });
  const fresh = await one<Booking>(sql, `select ${BOOKING_COLS} from court_bookings where id = $1`, [id]);
  return { status: 200, body: { booking: fresh!, payment_id: pay!.id, invoice_id: invoiceId, amount_vnd: due } };
}

/**
 * Move a confirmed booking to another slot (M-04).
 *
 * The same window as cancelling decides whether it is allowed — a change is
 * "cancel and rebook" without the member losing the court in between — and the
 * move is one transaction: the occupancy row is updated in place, so the old
 * slot is freed and the new one taken together, or neither happens. The overlap
 * trigger is still the last word. Money does not move: a slot that would cost a
 * different amount is refused rather than adjusted, because the SRS has no
 * formula for the difference; cancel and rebook is the path for that.
 */
export async function bookingsReschedule(
  sql: Sql,
  id: string,
  request: Request,
  user: PublicUser,
): Promise<Reply<RescheduleResponse>> {
  requireRole(user, ["member"]);
  const b = await readJson(request);
  const startAt = str(b.start_at);
  if (!startAt) throw err.field("start_at", "Pick the new time.");
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) throw err.field("start_at", "That time is not valid.");
  const settings = await getSettings(sql);
  const booking = await one<
    Pick<
      Booking,
      | "id"
      | "user_id"
      | "status"
      | "court_id"
      | "start_at"
      | "price_vnd"
      | "discount_pct"
      | "promo_discount_vnd"
      | "quota_hours"
      | "occupancy_id"
      | "code"
    >
  >(
    sql,
    `select id, user_id, status, court_id, start_at, price_vnd, discount_pct, promo_discount_vnd,
            quota_hours, occupancy_id, code
       from court_bookings where id = $1 for update`,
    [id],
  );
  if (!booking) throw err.notFound();
  if (booking.user_id !== user.id) throw err.forbidden();
  if (booking.status !== "confirmed" || !booking.occupancy_id) {
    throw err.conflictState("Only a confirmed booking that has not started can be moved.");
  }
  const hoursLeft = (new Date(booking.start_at).getTime() - Date.now()) / 3600000;
  if (hoursLeft < settings.cancel_court_hours) {
    throw err.conflictState(
      `A booking can only be moved up to ${settings.cancel_court_hours} hours before it starts.`,
      { window_hours: settings.cancel_court_hours },
    );
  }
  const oldCourt = await courtById(sql, booking.court_id);
  const courtId = str(b.court_id) ?? booking.court_id;
  const court = courtId === booking.court_id ? oldCourt : await courtById(sql, courtId);
  if (court.sport !== oldCourt.sport) {
    throw err.field("court_id", "A booking can only move to a court of the same sport.");
  }
  if (court.status !== "ready") throw err.br("BR-06", "That court is not available.");
  if (courtId === booking.court_id && start.getTime() === new Date(booking.start_at).getTime()) {
    throw err.field("start_at", "That is the slot you already have.");
  }
  const { end } = slotBounds(start, settings.slot_minutes);
  await assertBookWindow(start, { walkIn: false, settings });

  await assertNoCourtOverlap(sql, user.id, start, end, booking.id);
  const overlap = await overlapClass(sql, user.id, start, end);
  if (overlap && b.confirm_overlap !== true) {
    throw err.br("BR-09", "This slot clashes with a class you are in. Confirm to move it anyway.", {
      requires_confirm: true,
    });
  }
  // Plan hours pay for any slot; money only moves between slots of equal price.
  if (!(Number(booking.quota_hours) > 0)) {
    const list = await lookupPrice(sql, { sport: court.sport, courtId, start });
    const covered = await memberCourtFee(sql, user.id, start, settings);
    const price = covered
      ? covered.fee_vnd
      : applyDiscount(list.price_vnd, booking.discount_pct, settings.round_vnd) - (booking.promo_discount_vnd ?? 0);
    if (price !== booking.price_vnd) {
      throw err.conflictState(
        "That slot is priced differently from the one you paid for. Cancel this booking and book the new slot instead.",
        { paid_vnd: booking.price_vnd, new_price_vnd: price },
      );
    }
  }
  await sql.query(`select 1 from courts where id = $1 for update`, [courtId]);
  try {
    await sql.query(
      `update occupancies set court_id = $2, start_at = $3, end_at = $4 where id = $1`,
      [booking.occupancy_id, courtId, start.toISOString(), end.toISOString()],
    );
  } catch (e) {
    if (isConflictSlot(e)) throw err.conflictSlot("Someone just took that slot.");
    throw e;
  }
  await sql.query(
    `update court_bookings set court_id = $2, start_at = $3, end_at = $4 where id = $1`,
    [booking.id, courtId, start.toISOString(), end.toISOString()],
  );
  await enqueue(
    sql,
    "inapp",
    "booking_rescheduled",
    user.id,
    { booking_id: booking.id, code: booking.code, court_code: court.court_code, start_at: start.toISOString() },
    `booking_rescheduled|${booking.id}|${start.toISOString()}`,
  );
  await audit(sql, user.id, "reschedule_booking", "booking", booking.id, { start_at: booking.start_at, court_id: booking.court_id }, {
    start_at: start.toISOString(),
    court_id: courtId,
  });
  const fresh = await one<Booking>(sql, `select ${BOOKING_COLS} from court_bookings where id = $1`, [booking.id]);
  return { status: 200, body: { booking: fresh! } };
}

export async function bookingsCheckIn(sql: Sql, id: string, user: PublicUser): Promise<Reply<CheckInResponse>> {
  requireRole(user, ["receptionist", "manager"]);
  const settings = await getSettings(sql);
  const booking = await one<Pick<Booking, "id" | "status" | "start_at">>(
    sql,
    `select id, status, start_at from court_bookings where id = $1 for update`,
    [id],
  );
  if (!booking) throw err.notFound();
  if (booking.status !== "confirmed") throw err.conflictState("Only confirmed bookings can be checked in.");
  const start = new Date(booking.start_at).getTime();
  const now = Date.now();
  const min = start - settings.checkin_before_minutes * 60_000;
  const max = start + settings.noshow_grace_minutes * 60_000;
  if (now < min || now > max) {
    throw err.br("BR-11", "Outside the check-in window of −15/+10 minutes.");
  }
  await sql.query(`update court_bookings set status = 'in_use' where id = $1`, [id]);
  return { status: 200, body: { status: "in_use" } };
}

export async function walkIn(sql: Sql, request: Request, user: PublicUser): Promise<Reply<WalkInResponse>> {
  requireRole(user, ["receptionist", "manager"]);
  const b = await readJson(request);
  const courtId = str(b.court_id);
  const startAt = str(b.start_at);
  const guest_name = str(b.guest_name);
  const guest_phone_raw = str(b.guest_phone);
  const method = str(b.method) ?? "cash";
  if (!courtId || !startAt || !guest_name || !guest_phone_raw) {
    throw err.validation("Court, time, name or phone is missing.");
  }
  const ALLOWED_WALKIN_METHODS = ["cash", "card", "transfer"] as const;
  if (!ALLOWED_WALKIN_METHODS.includes(method as any)) {
    throw err.field("method", `Payment method must be one of ${ALLOWED_WALKIN_METHODS.join(", ")}.`);
  }
  const guest_phone = normalizePhone(guest_phone_raw);
  if (!isValidVnPhone(guest_phone)) throw err.validation("That phone number is not valid.", { field: "phone" });
  const settings = await getSettings(sql);
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) throw err.field("start_at", "That time is not valid.");
  const { end } = slotBounds(start, settings.slot_minutes);
  await assertBookWindow(start, { walkIn: true, settings });
  const court = await courtById(sql, courtId);
  if (court.status !== "ready") throw err.br("BR-06", "That court is not available.");
  if (user.role === "receptionist") {
    const shift = await one<{ id: string }>(
      sql,
      `select id from cashier_shifts where receptionist_id = $1 and closed_at is null`,
      [user.id],
    );
    if (!shift) throw err.br("BR-44", "Open a till shift before taking payment.");
    (b as { _shift?: string })._shift = shift.id;
  }
  const member = await one<{ id: string; full_name: string }>(
    sql,
    `select id, full_name from users where phone = $1`,
    [guest_phone],
  );
  const list = await lookupPrice(sql, { sport: court.sport, courtId, start });
  // A known member whose membership covers the date pays the member fee; everyone else the slot price.
  if (member) await assertNoCourtOverlap(sql, member.id, start, end);
  const covered = member ? await memberCourtFee(sql, member.id, start, settings) : null;
  const price = covered ? covered.fee_vnd : roundVnd(list.price_vnd, settings.round_vnd);
  const discount = 0;
  const bookingId = (await one<{ id: string }>(sql, `select gen_random_uuid() as id`))!.id;
  let occId: string;
  try {
    const occ = await one<{ id: string }>(
      sql,
      `select occupancy_attach($1::uuid, $2::timestamptz, $3::timestamptz, 'booking'::occ_kind, $4::uuid) as id`,
      [courtId, start.toISOString(), end.toISOString(), bookingId],
    );
    occId = occ!.id;
  } catch (e) {
    if (isConflictSlot(e)) throw err.conflictSlot("Someone just took that slot.");
    throw e;
  }
  const code = await nextCode(sql, "CRT");
  await sql.query(
    `insert into court_bookings
       (id, code, court_id, user_id, guest_name, guest_phone, start_at, end_at, status, channel,
        price_vnd, discount_pct, vat_rate, occupancy_id, paid_vnd)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed','walkin',$9,$10,$11,$12,$13)`,
    [
      bookingId,
      code,
      courtId,
      member?.id ?? null,
      guest_name,
      guest_phone,
      start.toISOString(),
      end.toISOString(),
      price,
      discount,
      Number(settings.vat_rate),
      occId,
      price,
    ],
  );
  const payCode = await nextCode(sql, "PAY");
  const shiftId = user.role === "receptionist" ? ((b as { _shift?: string })._shift ?? null) : null;
  const pay = await one<{ id: string }>(
    sql,
    `insert into payments (code, user_id, shift_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by)
     values ($1,$2,$3,$4,$5,$6,'posted','booking',$7,$8) returning id`,
    [
      payCode,
      member?.id ?? null,
      shiftId ?? null,
      method,
      price,
      Number(settings.vat_rate),
      bookingId,
      user.id,
    ],
  );
  const invoiceId = await issueInvoice(sql, {
    paymentId: pay!.id,
    buyerName: guest_name,
    buyerPhone: guest_phone,
    amountVnd: price,
    vatRate: Number(settings.vat_rate ?? 0),
    description: `Khách vãng lai — sân ${court.court_code} ${ictStamp(start)}`,
    unit: "lượt",
    settings,
  });
  await audit(sql, user.id, "walk_in", "booking", bookingId);
  const booking = await one<Booking>(sql, `select ${BOOKING_COLS} from court_bookings where id = $1`, [bookingId]);
  const payment = await one<Payment>(sql, `select ${PAYMENT_COLS} from payments where id = $1`, [pay!.id]);
  return { status: 201, body: { booking: booking!, payment: payment!, invoice_id: invoiceId } };
}

export async function bookingGet(sql: Sql, id: string, user: PublicUser): Promise<Reply<BookingResponse>> {
  requireRole(user, ["member", "receptionist", "manager"]);
  const b = await one<Booking>(sql, `select ${BOOKING_COLS} from court_bookings where id = $1`, [id]);
  if (!b) throw err.notFound();
  if (user.role === "member" && b.user_id !== user.id) throw err.forbidden();
  return { status: 200, body: b };
}
