import type { Sql } from "@/lib/db";
import { ApiError, err, isConflictSlot } from "../errors";
import { audit, enqueue, enqueueReceipt, getSettings, issueInvoice, nextCode, num, readJson, str } from "../helpers";
import { depositFor } from "../policy";
import { applyDiscount, lookupPrice, memberDiscount } from "../pricing";
import { quotePromo, redeemForBooking } from "../promos";
import { requireRole, type PublicUser } from "../session";
import { addDays, ictClock, ictDateString, ictDateTime, ictMinutes, ictStamp } from "../time";
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
  sql: Sql,
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

async function countSlotsToday(sql: Sql, userId: string, start: Date) {
  const date = ictDateString(start);
  const row = await one<{ n: number }>(
    sql,
    `select count(*)::int as n from court_bookings
      where user_id = $1
        and status in ('confirmed','in_use')
        and (start_at at time zone 'Asia/Ho_Chi_Minh')::date = $2::date`,
    [userId, date],
  );
  return row?.n ?? 0;
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
    `select court_id, start_at, end_at, kind, ref_id from occupancies
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
  // For a signed-in member, how many courts they already hold each day, counted exactly as the
  // hold counts them (countSlotsToday), so the day strip can say "you have 2" before the tap
  // instead of "84 free" and a refusal after it (BR-05).
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
    body: { from: first, sport: sport ?? null, days: out, cap: settings.max_slots_per_day },
  };
}

/**
 * The member's own upcoming court bookings, each with whether it can still be
 * moved. The home screen only shows today's, which left no way to find a
 * booking next week in order to change it.
 */
export async function meBookings(sql: Sql, user: PublicUser) {
  requireRole(user, ["member"]);
  const settings = await getSettings(sql);
  const rows = await sql.query<{
    id: string;
    code: string;
    status: string;
    start_at: string;
    end_at: string;
    price_vnd: number;
    paid_vnd: number;
    deposit_vnd: number;
    series_id: string | null;
    quota_hours: string | number;
    court_id: string;
    court_code: string;
    sport: string;
  }>(
    `select b.id, b.code, b.status::text as status, b.start_at, b.end_at, b.price_vnd, b.paid_vnd, b.deposit_vnd, b.series_id, b.quota_hours,
            b.court_id, c.court_code, c.sport::text as sport
       from court_bookings b join courts c on c.id = b.court_id
      where b.user_id = $1 and b.status in ('hold','confirmed','in_use') and b.end_at > now()
      order by b.start_at
      limit 50`,
    [user.id],
  );
  const now = Date.now();
  return {
    status: 200,
    body: {
      window_hours: settings.cancel_court_hours,
      cancel_tiers: settings.cancel_tiers,
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
  if (!hasExtraFields) {
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
        const activeSubs = await one<{ cnt: number }>(
          sql,
          `select count(*)::int as cnt
             from subscriptions s
             join membership_plans p on p.id = s.plan_id
            where s.status = 'active' and (p.sport_scope = $1 or (p.sport_scope = 'all' and $1 in (select code from sports where enabled = true and not is_scope_all and retired_at is null)))`,
          [cur.sport],
        );
        const activeClasses = await one<{ cnt: number }>(
          sql,
          `select count(*)::int as cnt from classes where sport = $1 and status = 'open'`,
          [cur.sport],
        );
        if ((activeSubs?.cnt ?? 0) > 0 || (activeClasses?.cnt ?? 0) > 0) {
          throw new ApiError(
            409,
            "CONFLICT_STATE",
            "Cannot close the last available court for a sport with active plans or classes.",
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

  const nextStatus = status || cur.status;
  const nextDisplayName =
    b.display_name !== undefined ? str(b.display_name)?.trim() || null : cur.display_name;
  if (nextDisplayName && nextDisplayName.length > 40) {
    throw err.field("display_name", "Display name cannot exceed 40 characters.");
  }
  const nextSortOrder = b.sort_order !== undefined ? num(b.sort_order) ?? null : cur.sort_order;

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

export async function bookingsHold(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["member"]);
  const b = await readJson(request);
  const courtId = str(b.court_id);
  const startAt = str(b.start_at);
  if (!courtId || !startAt) throw err.validation("court_id and start_at are required.");
  const settings = await getSettings(sql);
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) throw err.field("start_at", "That time is not valid.");
  const { end } = slotBounds(start, settings.slot_minutes);
  await assertBookWindow(sql, start, { walkIn: false, settings });
  const court = await courtById(sql, courtId);
  if (court.status !== "ready") throw err.br("BR-06", "That court is not available.");
  const n = await countSlotsToday(sql, user.id, start);
  if (n >= settings.max_slots_per_day) throw err.br("BR-05", `You can hold at most ${settings.max_slots_per_day} slots a day.`);
  const overlap = await overlapClass(sql, user.id, start, end);
  if (overlap && b.confirm_overlap !== true) {
    throw err.br("BR-09", "This slot clashes with a class you are in. Confirm to hold it anyway.", {
      requires_confirm: true,
    });
  }
  const disc = await memberDiscount(sql, user.id, court.sport);
  const list = await lookupPrice(sql, { sport: court.sport, courtId, start });
  const planPrice = applyDiscount(list.price_vnd, disc.pct, settings.round_vnd);
  // A code is priced into the hold so the member sees what they will pay; the use
  // is only counted when the money posts (BR-41).
  const promoCode = str(b.promo_code);
  const promo = promoCode
    ? await quotePromo(sql, {
        code: promoCode,
        userId: user.id,
        scope: "court",
        sport: court.sport,
        orderVnd: planPrice,
        planDiscountPct: disc.pct,
        listVnd: list.price_vnd,
      })
    : null;
  const price = promo ? promo.final_vnd : planPrice;
  // A peak slot asks for a deposit up front; the rest is paid at the desk (deposit_vnd = 0 means pay in full).
  const deposit = depositFor({
    priceVnd: price,
    pct: settings.deposit_pct,
    peakOnly: settings.deposit_peak_only,
    isPeak: list.is_peak,
    round: settings.round_vnd,
  });
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
      disc.pct,
      Number(settings.vat_rate),
      holdUntil.toISOString(),
      occId,
      promo?.promo_id ?? null,
      promo?.discount_vnd ?? 0,
      deposit,
    ],
  );
  const booking = await one(sql, `select * from court_bookings where id = $1`, [bookingId]);
  return {
    status: 201,
    body: {
      booking,
      hold_until: holdUntil.toISOString(),
      price,
      deposit_vnd: deposit,
      due_now_vnd: deposit > 0 ? deposit : price,
      list_price: list.price_vnd,
      promo: promo ? { code: promo.code, name: promo.name, discount_vnd: promo.discount_vnd } : null,
      // Court hours the member can spend on this slot right now (BR-12, BR-13): the same plan
      // the confirm step would charge, so the card offers "Use plan hours" only when it will work.
      plan_hours_left: Number(disc.court_hours_left) || 0,
    },
  };
}

type HeldBooking = {
  id: string;
  code?: string;
  user_id: string;
  status: string;
  hold_until: string | null;
  transfer_requested_at: string | null;
  occupancy_id: string | null;
  court_id: string;
  start_at: string;
  end_at: string;
  price_vnd: number;
  deposit_vnd?: number;
  discount_pct: number;
  vat_rate: string | number;
  quota_hours: string | number;
};

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
) {
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
  const fresh = await one(sql, `select * from court_bookings where id = $1`, [booking.id]);
  const payment = await one(sql, `select * from payments where id = $1`, [pay!.id]);
  return { booking: fresh, payment, invoice_id: invoiceId };
}

/**
 * What a member is allowed to settle their own booking with.
 *
 * `quota` spends hours they already bought, and `transfer` only asks reception
 * to go and look at the bank — neither one posts money. Everything else means
 * "cash/card changed hands", which is a claim only somebody standing at the
 * till can make.
 *
 * Without this list `method` went from the request body straight into the
 * payment row, so a member could POST `{"method":"cash"}` and mark their own
 * booking paid for money nobody had collected. `gateway` is absent on purpose:
 * an online payment becomes real when payOS confirms it, never because a
 * client said so.
 */
