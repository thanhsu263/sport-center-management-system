import type { Sql } from "@/server/data/db";
import { err, isConflictSlot } from "../errors";
import {
  audit,
  enqueue,
  enqueueReceipt,
  getSettings,
  issueInvoice,
  nextCode,
  num,
  pageOf,
  readJson,
  str,
} from "../helpers";
import { memberCourtFee } from "../../services/membership";
import { isValidVnPhone, normalizePhone } from "../../services/phone";
import { seriesDates, seriesWeekday } from "../../services/policy";
import { applyDiscount, lookupPrice } from "../../services/pricing";
import { requireRole, type PublicUser } from "../session";
import { ictClock, ictDateString, ictDateTime, ictStamp, roundVnd } from "../../../shared/arena3/time";
import { one } from "../tx";
import { pageParams } from "../validate";
import { bookingsCancel, hasCourtOverlap } from "./bookings";

/**
 * The extras the scope benchmark asked for: fixed weekly bookings,
 * loyalty points, coach commission, maintenance work orders and e-invoice
 * export. Every money flow here still ends in a `payments` row and an invoice,
 * and every court a customer takes still goes through `occupancies`.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const METHODS = ["cash", "card", "transfer"];

export async function openShift(sql: Sql, user: PublicUser): Promise<string | null> {
  if (user.role !== "receptionist") return null;
  const sh = await one<{ id: string }>(
    sql,
    `select id from cashier_shifts where receptionist_id = $1 and closed_at is null`,
    [user.id],
  );
  if (!sh) throw err.br("BR-44", "Open a till shift before taking payment.");
  return sh.id;
}

export function pickMethod(v: unknown): string {
  const m = str(v) ?? "cash";
  if (!METHODS.includes(m)) throw err.validation("Pick cash, card or transfer.");
  return m;
}

/* ───────────────────────── Fixed weekly bookings ───────────────────────── */

type SeriesWho = { userId: string | null; name: string; phone: string; discountPct: number };

async function resolveWho(sql: Sql, b: Record<string, unknown>): Promise<SeriesWho> {
  const phoneRaw = str(b.phone) ?? str(b.guest_phone);
  if (!phoneRaw) throw err.field("phone", "Phone number is required.");
  const phone = normalizePhone(phoneRaw);
  if (!isValidVnPhone(phone)) throw err.field("phone", "That phone number is not valid.");
  const member = await one<{ id: string; full_name: string }>(
    sql,
    `select id, full_name from users where phone = $1 and role = 'member'`,
    [phone],
  );
  // Members pay the slot price like everyone else; only the series discount applies.
  if (member) return { userId: member.id, name: member.full_name, phone, discountPct: 0 };
  const name = str(b.guest_name) ?? str(b.name);
  if (!name) throw err.field("guest_name", "Enter the customer's name.");
  return { userId: null, name, phone, discountPct: 0 };
}

type SeriesInput = {
  courtId: string;
  firstDate: string;
  startLocal: string;
  weeks: number;
};

async function readSeriesInput(sql: Sql, b: Record<string, unknown>): Promise<SeriesInput & { court: { id: string; court_code: string; sport: string; status: string } }> {
  const courtId = str(b.court_id);
  const firstDate = str(b.first_date);
  const startLocal = str(b.start_local);
  const weeks = num(b.weeks);
  if (!courtId) throw err.field("court_id", "Pick a court.");
  if (!firstDate || !DATE_RE.test(firstDate)) throw err.field("first_date", "Pick the first date.");
  if (!startLocal || !/^\d{1,2}:\d{2}$/.test(startLocal)) throw err.field("start_local", "Pick a start time like 19:00.");
  const settings = await getSettings(sql);
  if (weeks == null || !Number.isInteger(weeks) || weeks < settings.series_min_weeks || weeks > settings.series_max_weeks) {
    throw err.field("weeks", `A fixed booking runs ${settings.series_min_weeks}–${settings.series_max_weeks} weeks.`);
  }
  const court = await one<{ id: string; court_code: string; sport: string; status: string; retired_at: string | null }>(
    sql,
    `select id, court_code, sport::text as sport, status::text as status, retired_at from courts where id = $1`,
    [courtId],
  );
  if (!court) throw err.notFound("No such court.");
  if (court.retired_at || court.status !== "ready") throw err.br("BR-06", "That court is not available.");
  return { courtId, firstDate, startLocal: startLocal.padStart(5, "0"), weeks, court };
}

type SeriesLine = {
  date: string;
  start_at: string;
  end_at: string;
  list_vnd: number;
  price_vnd: number;
  is_peak: boolean;
  available: boolean;
  reason?: string;
};

/**
 * Work out every week of the series. Each week is tried on the real occupancy
 * table inside a savepoint, so "free" means exactly what a booking would find;
 * a week that is taken is skipped, never forced.
 */
async function planSeries(
  sql: Sql,
  input: SeriesInput & { court: { sport: string } },
  who: SeriesWho,
  keep: boolean,
): Promise<{ lines: SeriesLine[]; discountPct: number; attached: { line: SeriesLine; bookingId: string; occId: string }[] }> {
  const settings = await getSettings(sql);
  const disc = Math.max(settings.series_discount_pct, who.discountPct);
  const open = ictDateTime(input.firstDate, settings.open_time.slice(0, 5));
  const close = ictDateTime(input.firstDate, settings.close_time.slice(0, 5));
  const first = ictDateTime(input.firstDate, input.startLocal);
  if (first < open || first.getTime() + settings.slot_minutes * 60_000 > close.getTime() + 1) {
    // Compare the wall clock, not the day: opening hours repeat every day.
    throw err.br("BR-06", "That is outside opening hours.");
  }
  const lines: SeriesLine[] = [];
  const attached: { line: SeriesLine; bookingId: string; occId: string }[] = [];
  for (const date of seriesDates(input.firstDate, input.weeks)) {
    const start = ictDateTime(date, input.startLocal);
    const end = new Date(start.getTime() + settings.slot_minutes * 60_000);
    const list = await lookupPrice(sql, { sport: input.court.sport, courtId: input.courtId, start });
    const covered = who.userId ? await memberCourtFee(sql, who.userId, start, settings) : null;
    const price = covered
      ? covered.fee_vnd
      : roundVnd(applyDiscount(list.price_vnd, disc, settings.round_vnd), settings.round_vnd);
    const line: SeriesLine = {
      date,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      list_vnd: list.price_vnd,
      price_vnd: price,
      is_peak: list.is_peak,
      available: true,
    };
    if (start < new Date()) {
      line.available = false;
      line.reason = "past";
    } else if (who.userId && (await hasCourtOverlap(sql, who.userId, start, end))) {
      line.available = false;
      line.reason = "taken";
    } else {
      const bookingId = (await one<{ id: string }>(sql, `select gen_random_uuid() as id`))!.id;
      await sql.query("savepoint sp_series");
      try {
        const occ = await one<{ occupancy_attach: string }>(
          sql,
          `select occupancy_attach($1::uuid, $2::timestamptz, $3::timestamptz, 'hold'::occ_kind, $4::uuid, null) as occupancy_attach`,
          [input.courtId, start.toISOString(), end.toISOString(), bookingId],
        );
        if (keep) {
          await sql.query("release savepoint sp_series");
          attached.push({ line, bookingId, occId: occ!.occupancy_attach });
        } else {
          await sql.query("rollback to savepoint sp_series");
        }
      } catch (e) {
        await sql.query("rollback to savepoint sp_series").catch(() => undefined);
        if (!isConflictSlot(e)) throw e;
        line.available = false;
        line.reason = "taken";
      }
    }
    lines.push(line);
  }
  return { lines, discountPct: disc, attached };
}

export async function seriesPreview(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  const b = await readJson(request);
  const input = await readSeriesInput(sql, b);
  const who = await resolveWho(sql, b);
  const { lines, discountPct } = await planSeries(sql, input, who, false);
  const ok = lines.filter((l) => l.available);
  const settings = await getSettings(sql);
  return {
    status: 200,
    body: {
      court_code: input.court.court_code,
      customer: { name: who.name, phone: who.phone, is_member: !!who.userId },
      weekday: seriesWeekday(input.firstDate, input.startLocal),
      discount_pct: discountPct,
      min_weeks: settings.series_min_weeks,
      lines,
      booked: ok.length,
      skipped: lines.length - ok.length,
      list_total_vnd: ok.reduce((a, l) => a + l.list_vnd, 0),
      total_vnd: ok.reduce((a, l) => a + l.price_vnd, 0),
    },
  };
}

export async function seriesCreate(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  const b = await readJson(request);
  const method = pickMethod(b.method);
  const input = await readSeriesInput(sql, b);
  const who = await resolveWho(sql, b);
  const shiftId = await openShift(sql, user);
  const settings = await getSettings(sql);
  const { lines, discountPct, attached } = await planSeries(sql, input, who, true);
  if (attached.length === 0) throw err.conflictSlot("None of those weeks is free.");
  const total = attached.reduce((a, x) => a + x.line.price_vnd, 0);

  const seriesCode = await nextCode(sql, "SER");
  const series = await one<{ id: string }>(
    sql,
    `insert into booking_series
       (code, user_id, guest_name, guest_phone, court_id, weekday, start_local, weeks, starts_on, discount_pct, created_by)
     values ($1,$2,$3,$4,$5,$6,$7::time,$8,$9::date,$10,$11) returning id`,
    [
      seriesCode,
      who.userId,
      who.userId ? null : who.name,
      who.userId ? null : who.phone,
      input.courtId,
      seriesWeekday(input.firstDate, input.startLocal),
      input.startLocal,
      input.weeks,
      input.firstDate,
      discountPct,
      user.id,
    ],
  );

  const bookingIds: string[] = [];
  for (const a of attached) {
    const code = await nextCode(sql, "CRT");
    await sql.query(
      `insert into court_bookings
         (id, code, court_id, user_id, guest_name, guest_phone, start_at, end_at, status, channel,
          price_vnd, discount_pct, vat_rate, occupancy_id, series_id, paid_vnd)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'hold','series',$9,$10,$11,$12,$13,$9)`,
      [
        a.bookingId,
        code,
        input.courtId,
        who.userId,
        who.userId ? null : who.name,
        who.userId ? null : who.phone,
        a.line.start_at,
        a.line.end_at,
        a.line.price_vnd,
        discountPct,
        Number(settings.vat_rate),
        a.occId,
        series!.id,
      ],
    );
    await sql.query(`select occupancy_confirm_hold($1::uuid)`, [a.occId]);
    await sql.query(`update court_bookings set status = 'confirmed', hold_until = null where id = $1`, [a.bookingId]);
    bookingIds.push(a.bookingId);
  }

  // One payment and one invoice for the whole block, filed against the first week.
  const pay = await one<{ id: string }>(
    sql,
    `insert into payments (code, user_id, shift_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by)
     values ($1,$2,$3,$4,$5,$6,'posted','booking',$7,$8) returning id`,
    [await nextCode(sql, "PAY"), who.userId, shiftId, method, total, Number(settings.vat_rate), bookingIds[0], user.id],
  );
  const weekdayVi = ["Chủ nhật", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"][seriesWeekday(input.firstDate, input.startLocal)];
  const invoiceId = await issueInvoice(sql, {
    paymentId: pay!.id,
    buyerName: who.name,
    buyerPhone: who.userId ? null : who.phone,
    amountVnd: total,
    vatRate: Number(settings.vat_rate ?? 0),
    description: `Thuê sân cố định ${input.court.court_code} — ${weekdayVi} ${input.startLocal}, ${attached.length} buổi (giảm ${discountPct}%)`,
    unit: "buổi",
    settings,
  });
  await enqueueReceipt(sql, who.userId, {
    payment_id: pay!.id,
    invoice_id: invoiceId,
    amount_vnd: total,
    method,
  });
  await enqueue(
    sql,
    "inapp",
    "series_created",
    who.userId,
    { series_id: series!.id, code: seriesCode, weeks: attached.length },
    `series_created|${series!.id}`,
  );
  await audit(sql, user.id, "create_series", "booking_series", series!.id, null, {
    weeks: attached.length,
    skipped: lines.length - attached.length,
    total_vnd: total,
  });
  return {
    status: 201,
    body: {
      series_id: series!.id,
      code: seriesCode,
      booked: attached.length,
      skipped: lines.filter((l) => !l.available).map((l) => ({ date: l.date, reason: l.reason })),
      total_vnd: total,
      payment_id: pay!.id,
      invoice_id: invoiceId,
    },
  };
}

export async function seriesList(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager", "member"]);
  const mine = user.role === "member";
  const { limit, offset } = pageParams(request, { def: 100, max: 100 });
  const rows = await sql.query<{ total: number } & Record<string, unknown>>(
    `select s.id, s.code, s.weekday, s.start_local::text as start_local, s.weeks, s.starts_on::text as starts_on,
            s.discount_pct, s.status, c.court_code,
            coalesce(u.full_name, s.guest_name) as customer, coalesce(u.phone, s.guest_phone) as phone,
            (select count(*)::int from court_bookings b where b.series_id = s.id and b.status in ('confirmed','in_use') and b.start_at > now()) as remaining,
            (select count(*)::int from court_bookings b where b.series_id = s.id and b.status in ('confirmed','in_use','completed')) as booked,
            (select min(b.start_at) from court_bookings b where b.series_id = s.id and b.status = 'confirmed' and b.start_at > now()) as next_at,
            count(*) over ()::int as total
       from booking_series s
       join courts c on c.id = s.court_id
       left join users u on u.id = s.user_id
      where ($1::uuid is null or s.user_id = $1)
      order by s.status, s.created_at desc
      limit $2 offset $3`,
    [mine ? user.id : null, limit, offset],
  );
  const body = await pageOf(rows, { limit, offset }, async () =>
    ((await one<{ n: number }>(sql, `select count(*)::int as n from booking_series where ($1::uuid is null or user_id = $1)`, [mine ? user.id : null]))?.n ?? 0),
  );
  return { status: 200, body };
}

/**
 * Stop a fixed booking. Every remaining week is cancelled through the normal
 * cancel path, so each one is refunded by the same tiers as any other booking.
 */
export async function seriesCancel(sql: Sql, id: string, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  const b = await readJson(request);
  const series = await one<{ id: string; status: string }>(sql, `select id, status from booking_series where id = $1 for update`, [id]);
  if (!series) throw err.notFound();
  if (series.status !== "active") throw err.conflictState("That fixed booking is already cancelled.");
  const rows = await sql.query<{ id: string }>(
    `select id from court_bookings where series_id = $1 and status = 'confirmed' and start_at > now() order by start_at`,
    [id],
  );
  let refunded = 0;
  let fees = 0;
  for (const r of rows) {
    const req = new Request("http://local/cancel", {
      method: "POST",
      body: JSON.stringify({ waive: b.waive === true, reason: str(b.reason) ?? "Hủy lịch cố định" }),
    });
    const res = await bookingsCancel(sql, r.id, user, req);
    const q = (res.body as { quote?: { refund_vnd: number; fee_vnd: number } }).quote;
    refunded += q?.refund_vnd ?? 0;
    fees += q?.fee_vnd ?? 0;
  }
  await sql.query(`update booking_series set status = 'cancelled' where id = $1`, [id]);
  await audit(sql, user.id, "cancel_series", "booking_series", id, null, { weeks: rows.length, refunded, fees });
  return { status: 200, body: { cancelled: rows.length, refunded_vnd: refunded, fee_vnd: fees } };
}

/* ───────────────────────────── Loyalty ───────────────────────────── */

const TIERS = [
  { key: "gold", min: 600 },
  { key: "silver", min: 200 },
  { key: "bronze", min: 0 },
] as const;

export async function loyaltyBalance(sql: Sql, userId: string) {
  const settings = await getSettings(sql);
  const row = await one<{ net: number; spent: number }>(
    sql,
    `select coalesce((select sum(amount_vnd) from payments
                       where user_id = $1 and status in ('posted','refund_pending')
                         -- 'day_pass' stays: day passes are no longer sold, but what a member already paid for them still counts toward loyalty.
                         and ref_type in ('booking','subscription','day_pass')), 0)::int as net,
            coalesce((select sum(points) from loyalty_adjustments where user_id = $1), 0)::int as spent`,
    [userId],
  );
  const earned = Math.max(0, Math.floor((row?.net ?? 0) / settings.loyalty_earn_vnd));
  const adjust = row?.spent ?? 0;
  const points = Math.max(0, earned + adjust);
  // Tier counts every point ever earned, so spending points never demotes a member.
  const lifetime = earned + Math.max(0, adjust);
  const tier = TIERS.find((t) => lifetime >= t.min)!;
  const idx = TIERS.indexOf(tier);
  const next = idx > 0 ? TIERS[idx - 1]! : null;
  return {
    points,
    earned,
    spend_vnd: row?.net ?? 0,
    tier: tier.key,
    next_tier: next ? { key: next.key, need: Math.max(0, next.min - lifetime) } : null,
    earn_vnd: settings.loyalty_earn_vnd,
    redeem_vnd: settings.loyalty_redeem_vnd,
    min_redeem: 50,
  };
}

/** The balance, and the history a page at a time (`?limit=&offset=`, newest first). */
export async function meLoyalty(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["member"]);
  const { limit, offset } = pageParams(request, { def: 30, max: 100 });
  const bal = await loyaltyBalance(sql, user.id);
  const rows = await sql.query<{ total: number } & Record<string, unknown>>(
    `select id, points, reason, note, created_at, promo_id,
            (select code from promotions p where p.id = la.promo_id) as promo_code,
            count(*) over ()::int as total
       from loyalty_adjustments la where user_id = $1 order by created_at desc limit $2 offset $3`,
    [user.id, limit, offset],
  );
  const page = await pageOf(rows, { limit, offset }, async () =>
    ((await one<{ n: number }>(sql, `select count(*)::int as n from loyalty_adjustments where user_id = $1`, [user.id]))?.n ?? 0),
  );
  return { status: 200, body: { ...bal, history: page.items, history_total: page.total, limit, offset } };
}

export async function memberLoyalty(sql: Sql, memberId: string, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  return { status: 200, body: await loyaltyBalance(sql, memberId) };
}

/** Turn points into a single-use discount code the member can type at checkout. */
export async function loyaltyRedeem(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["member"]);
  const b = await readJson(request);
  const points = num(b.points);
  const bal = await loyaltyBalance(sql, user.id);
  if (points == null || !Number.isInteger(points) || points < bal.min_redeem) {
    throw err.field("points", `Redeem at least ${bal.min_redeem} points.`);
  }
  if (points > bal.points) throw err.field("points", "You do not have that many points.");
  const value = points * bal.redeem_vnd;
  const suffix = (await nextCode(sql, "RWD")).replace(/[^0-9]/g, "");
  const code = `DIEM${suffix}`.slice(0, 24);
  const promo = await one<{ id: string }>(
    sql,
    `insert into promotions (code, name, kind, value, ends_at, max_uses, max_per_member, applies_to, created_by)
     values ($1,$2,'amount',$3, now() + interval '60 days', 1, 1, ARRAY['court','plan'], $4) returning id`,
    [code, `Đổi ${points} điểm`, value, user.id],
  );
  await sql.query(
    `insert into loyalty_adjustments (user_id, points, reason, note, promo_id, created_by)
     values ($1,$2,'redeem',$3,$4,$1)`,
    [user.id, -points, `Đổi ${points} điểm lấy mã ${code}`, promo!.id],
  );
  await audit(sql, user.id, "redeem_points", "promotion", promo!.id, null, { points, value });
  return { status: 201, body: { code, value_vnd: value, points_left: bal.points - points } };
}

/** Staff goodwill: add or take back points, with a reason on record. */
export async function loyaltyAdjust(sql: Sql, memberId: string, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const b = await readJson(request);
  const points = num(b.points);
  const note = str(b.note);
  if (points == null || !Number.isInteger(points) || points === 0 || Math.abs(points) > 100_000) {
    throw err.field("points", "Enter a whole number of points, not zero.");
  }
  if (!note) throw err.field("note", "Say why.");
  await sql.query(
    `insert into loyalty_adjustments (user_id, points, reason, note, created_by)
     values ($1,$2,$3,$4,$5)`,
    [memberId, points, points > 0 ? "bonus" : "correction", note, user.id],
  );
  await audit(sql, user.id, "adjust_points", "user", memberId, null, { points, note });
  return { status: 200, body: await loyaltyBalance(sql, memberId) };
}

/* ───────────────────────── Coach commission ───────────────────────── */

type CommissionRow = {
  coach_id: string;
  coach_name: string;
  per_session_vnd: number;
  per_student_vnd: number;
  sessions: number;
  students: number;
  amount_vnd: number;
  payout_status: "closed" | "paid" | null;
  paid_at: string | null;
};

function periodBounds(period: string) {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const from = ictDateTime(`${period}-01`, "00:00");
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const to = ictDateTime(`${ny}-${String(nm).padStart(2, "0")}-01`, "00:00");
  return { from: from.toISOString(), to: to.toISOString() };
}

function thisPeriod(): string {
  return ictDateString().slice(0, 7);
}

async function commissionRows(sql: Sql, period: string, coachId?: string): Promise<CommissionRow[]> {
  const { from, to } = periodBounds(period);
  const rows = await sql.query<CommissionRow>(
    `with taught as (
        select cl.coach_id,
               count(*)::int as sessions,
               coalesce(sum((select count(*) from attendance a
                              where a.session_id = s.id and a.kind = 'session' and a.result in ('present','late'))), 0)::int as students
          from sessions s join classes cl on cl.id = s.class_id
         where s.status = 'done' and s.start_at >= $1::timestamptz and s.start_at < $2::timestamptz
         group by cl.coach_id
     )
     select u.id as coach_id, u.full_name as coach_name,
            coalesce(r.per_session_vnd, 150000) as per_session_vnd,
            coalesce(r.per_student_vnd, 10000) as per_student_vnd,
            coalesce(t.sessions, 0) as sessions, coalesce(t.students, 0) as students,
            coalesce(t.sessions, 0) * coalesce(r.per_session_vnd, 150000)
              + coalesce(t.students, 0) * coalesce(r.per_student_vnd, 10000) as amount_vnd,
            po.status as payout_status, po.paid_at::text as paid_at
       from users u
       left join coach_rates r on r.coach_id = u.id
       left join taught t on t.coach_id = u.id
       left join coach_payouts po on po.coach_id = u.id and po.period = $3
      where u.role = 'coach' and ($4::uuid is null or u.id = $4)
      order by u.full_name`,
    [from, to, period, coachId ?? null],
  );
  // A closed month is frozen: show what was paid, not what today's rates would give.
  const frozen = await sql.query<{ coach_id: string; sessions: number; students: number; amount_vnd: number }>(
    `select coach_id, sessions, students, amount_vnd from coach_payouts where period = $1`,
    [period],
  );
  for (const r of rows) {
    const f = frozen.find((x) => x.coach_id === r.coach_id);
    if (f) {
      r.sessions = f.sessions;
      r.students = f.students;
      r.amount_vnd = f.amount_vnd;
    }
  }
  return rows;
}

function readPeriod(request: Request): string {
  const p = new URL(request.url).searchParams.get("period") ?? thisPeriod();
  if (!PERIOD_RE.test(p)) throw err.validation("period must be YYYY-MM.");
  return p;
}

export async function commissionReport(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const period = readPeriod(request);
  const items = await commissionRows(sql, period);
  return {
    status: 200,
    body: {
      period,
      current: thisPeriod(),
      items,
      total_vnd: items.reduce((a, r) => a + r.amount_vnd, 0),
    },
  };
}

export async function commissionRate(sql: Sql, coachId: string, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const b = await readJson(request);
  const perSession = num(b.per_session_vnd);
  const perStudent = num(b.per_student_vnd);
  for (const [k, v] of [["per_session_vnd", perSession], ["per_student_vnd", perStudent]] as const) {
    if (v == null || !Number.isInteger(v) || v < 0 || v > 10_000_000) {
      throw err.field(k, "Enter a whole amount in đồng, 0 or more.");
    }
  }
  const coach = await one(sql, `select id from users where id = $1 and role = 'coach'`, [coachId]);
  if (!coach) throw err.notFound("No such coach.");
  await sql.query(
    `insert into coach_rates (coach_id, per_session_vnd, per_student_vnd) values ($1,$2,$3)
     on conflict (coach_id) do update set per_session_vnd = $2, per_student_vnd = $3, updated_at = now()`,
    [coachId, perSession, perStudent],
  );
  await audit(sql, user.id, "set_coach_rate", "user", coachId, null, { perSession, perStudent });
  return { status: 200, body: { ok: true } };
}

/** Freeze a finished month: the figures are copied so a later rate change cannot rewrite them. */
export async function commissionClose(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const b = await readJson(request);
  const period = str(b.period) ?? "";
  if (!PERIOD_RE.test(period)) throw err.field("period", "Pick a month.");
  if (period >= thisPeriod()) throw err.conflictState("A month can be closed only after it has ended.");
  const rows = await commissionRows(sql, period);
  let closed = 0;
  for (const r of rows) {
    if (r.payout_status) continue;
    if (r.sessions === 0) continue;
    await sql.query(
      `insert into coach_payouts (coach_id, period, sessions, students, amount_vnd, closed_by)
       values ($1,$2,$3,$4,$5,$6) on conflict (coach_id, period) do nothing`,
      [r.coach_id, period, r.sessions, r.students, r.amount_vnd, user.id],
    );
    closed += 1;
  }
  await audit(sql, user.id, "close_commission", "coach_payout", null, null, { period, closed });
  return { status: 200, body: { period, closed } };
}

export async function commissionPay(sql: Sql, coachId: string, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const b = await readJson(request);
  const period = str(b.period) ?? "";
  if (!PERIOD_RE.test(period)) throw err.field("period", "Pick a month.");
  const po = await one<{ status: string }>(sql, `select status from coach_payouts where coach_id = $1 and period = $2 for update`, [coachId, period]);
  if (!po) throw err.conflictState("Close the month first.");
  if (po.status === "paid") throw err.conflictState("That month is already paid.");
  await sql.query(`update coach_payouts set status = 'paid', paid_at = now() where coach_id = $1 and period = $2`, [coachId, period]);
  await audit(sql, user.id, "pay_commission", "coach_payout", null, null, { coachId, period });
  return { status: 200, body: { ok: true } };
}

export async function coachEarnings(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["coach"]);
  const period = readPeriod(request);
  const [row] = await commissionRows(sql, period, user.id);
  const { from, to } = periodBounds(period);
  const sessions = await sql.query(
    `select s.id, s.start_at, cl.level, c.court_code,
            (select count(*)::int from attendance a where a.session_id = s.id and a.kind = 'session' and a.result in ('present','late')) as students
       from sessions s join classes cl on cl.id = s.class_id join courts c on c.id = s.court_id
      where cl.coach_id = $1 and s.status = 'done' and s.start_at >= $2::timestamptz and s.start_at < $3::timestamptz
      order by s.start_at desc limit 100`,
    [user.id, from, to],
  );
  const history = await sql.query(
    `select period, sessions, students, amount_vnd, status, paid_at from coach_payouts where coach_id = $1 order by period desc limit 12`,
    [user.id],
  );
  return { status: 200, body: { period, current: thisPeriod(), summary: row ?? null, sessions, history } };
}

/* ───────────────────── Maintenance work orders ───────────────────── */

const WO_PRIORITY = ["low", "normal", "urgent"];
const WO_STATUS = ["open", "in_progress", "done", "cancelled"];

async function syncCourtBlock(sql: Sql, courtId: string | null) {
  if (!courtId) return;
  const blocking = await one<{ n: number }>(
    sql,
    `select count(*)::int as n from work_orders where court_id = $1 and blocks_court and status in ('open','in_progress')`,
    [courtId],
  );
  if ((blocking?.n ?? 0) > 0) {
    await sql.query(`update courts set status = 'maintenance' where id = $1 and status = 'ready'`, [courtId]);
  } else {
    await sql.query(`update courts set status = 'ready' where id = $1 and status = 'maintenance'`, [courtId]);
  }
}

export async function workOrdersList(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager", "coach"]);
  const status = new URL(request.url).searchParams.get("status");
  // "active" is the desk's default view: open or in progress.
  const statusFilter = status === "active" || (status && WO_STATUS.includes(status)) ? status : null;
  const { limit, offset } = pageParams(request, { def: 200, max: 200 });
  const rows = await sql.query<{ total: number } & Record<string, unknown>>(
    `select w.id, w.code, w.court_id, c.court_code, w.title, w.description, w.priority, w.status, w.blocks_court,
            w.assignee, w.cost_vnd, w.resolution, w.created_at, w.closed_at, u.full_name as reporter,
            count(*) over ()::int as total
       from work_orders w
       left join courts c on c.id = w.court_id
       left join users u on u.id = w.reported_by
      where ($1::text is null or w.status = $1 or ($1 = 'active' and w.status in ('open','in_progress')))
      order by (w.status in ('done','cancelled')), (w.priority = 'urgent') desc, w.created_at desc
      limit $2 offset $3`,
    [statusFilter, limit, offset],
  );
  const page = await pageOf(rows, { limit, offset }, async () =>
    ((await one<{ n: number }>(sql, `select count(*)::int as n from work_orders where ($1::text is null or status = $1 or ($1 = 'active' and status in ('open','in_progress')))`, [statusFilter]))?.n ?? 0),
  );
  const items = page.items;
  const sum = await one<{ open: number; urgent: number; cost: number }>(
    sql,
    `select count(*) filter (where status in ('open','in_progress'))::int as open,
            count(*) filter (where status in ('open','in_progress') and priority = 'urgent')::int as urgent,
            coalesce(sum(cost_vnd) filter (where status = 'done' and closed_at >= date_trunc('month', now())), 0)::int as cost
       from work_orders`,
  );
  return {
    status: 200,
    body: { items, total: page.total, limit, offset, open: sum?.open ?? 0, urgent: sum?.urgent ?? 0, cost_month_vnd: sum?.cost ?? 0 },
  };
}

export async function workOrdersCreate(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager", "coach"]);
  const b = await readJson(request);
  const title = str(b.title);
  if (!title) throw err.field("title", "Say what is broken.");
  if (title.length > 160) throw err.field("title", "Keep the title under 160 characters.");
  const priority = str(b.priority) ?? "normal";
  if (!WO_PRIORITY.includes(priority)) throw err.field("priority", "Pick low, normal or urgent.");
  const courtId = str(b.court_id) || null;
  if (courtId) await one(sql, `select 1 from courts where id = $1 and retired_at is null`, [courtId]).then((r) => { if (!r) throw err.notFound("No such court."); });
  const blocks = b.blocks_court === true && !!courtId;
  const code = await nextCode(sql, "WO");
  const row = await one<{ id: string }>(
    sql,
    `insert into work_orders (code, court_id, title, description, priority, blocks_court, reported_by)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [code, courtId, title, str(b.description) ?? null, priority, blocks, user.id],
  );
  await syncCourtBlock(sql, courtId);
  await audit(sql, user.id, "create_work_order", "work_order", row!.id, null, { title, priority, blocks });
  return { status: 201, body: { id: row!.id, code } };
}

export async function workOrdersPatch(sql: Sql, id: string, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  const b = await readJson(request);
  const cur = await one<{ court_id: string | null; status: string }>(sql, `select court_id, status from work_orders where id = $1 for update`, [id]);
  if (!cur) throw err.notFound();
  const status = str(b.status);
  if (status !== undefined && !WO_STATUS.includes(status)) throw err.field("status", "Unknown status.");
  const priority = str(b.priority);
  if (priority !== undefined && !WO_PRIORITY.includes(priority)) throw err.field("priority", "Pick low, normal or urgent.");
  const cost = b.cost_vnd === undefined ? undefined : num(b.cost_vnd);
  if (b.cost_vnd !== undefined && (cost == null || !Number.isInteger(cost) || cost < 0 || cost > 1_000_000_000)) {
    throw err.field("cost_vnd", "Enter the cost in whole đồng.");
  }
  const closing = status === "done" || status === "cancelled";
  await sql.query(
    `update work_orders set
        status = coalesce($2, status),
        priority = coalesce($3, priority),
        assignee = case when $4::boolean then $5 else assignee end,
        cost_vnd = coalesce($6, cost_vnd),
        resolution = case when $7::boolean then $8 else resolution end,
        blocks_court = coalesce($9, blocks_court),
        closed_at = case when $10::boolean then now() when $2 in ('open','in_progress') then null else closed_at end
      where id = $1`,
    [
      id,
      status ?? null,
      priority ?? null,
      b.assignee !== undefined,
      str(b.assignee) || null,
      cost ?? null,
      b.resolution !== undefined,
      str(b.resolution) || null,
      typeof b.blocks_court === "boolean" ? b.blocks_court : null,
      closing && !["done", "cancelled"].includes(cur.status),
    ],
  );
  await syncCourtBlock(sql, cur.court_id);
  await audit(sql, user.id, "patch_work_order", "work_order", id, { status: cur.status }, { status: status ?? cur.status });
  return { status: 200, body: { ok: true } };
}

/* ───────────────────────────── E-invoice ───────────────────────────── */

function esc(v: unknown): string {
  return String(v ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

type InvoiceExportRow = {
  id: string;
  code: string;
  issued_at: string;
  form_no: string | null;
  serial_no: string | null;
  buyer_name: string;
  buyer_tax_code: string | null;
  buyer_address: string | null;
  buyer_phone: string | null;
  seller_legal_name: string | null;
  seller_tax_code: string | null;
  seller_address: string | null;
  subtotal_vnd: number | null;
  vat_rate: string | number | null;
  vat_vnd: number | null;
  total_vnd: number | null;
  method: string;
  amount_vnd: number;
  payment_code: string;
  status: string;
};

const EXPORT_SELECT = `select i.id, i.code, i.issued_at::text as issued_at, i.form_no, i.serial_no, i.buyer_name, i.buyer_tax_code,
        i.buyer_address, i.buyer_phone, i.seller_legal_name, i.seller_tax_code, i.seller_address,
        i.subtotal_vnd, i.vat_rate, i.vat_vnd, i.total_vnd,
        p.method::text as method, p.amount_vnd, p.code as payment_code, p.status::text as status
   from invoices i join payments p on p.id = i.payment_id`;

/**
 * An invoice as the structured data Vietnamese e-invoice providers import.
 * The shape follows the field groups of Circular 78 (general data, seller,
 * buyer, goods lines, totals). It is NOT a legally issued e-invoice: that needs
 * a digital signature and a tax-authority code from an accredited provider, so
 * this file is the hand-off to that provider or to the accountant.
 */
function invoiceXml(inv: InvoiceExportRow, lines: { description: string; unit: string | null; qty: number; unit_vnd: number; amount_vnd: number }[]) {
  const rate = Number(inv.vat_rate ?? 0);
  const total = inv.total_vnd ?? inv.amount_vnd;
  const sub = inv.subtotal_vnd ?? total;
  const vat = inv.vat_vnd ?? total - sub;
  return [
    `<HDon>`,
    `  <DLHDon Id="${esc(inv.code)}">`,
    `    <TTChung>`,
    `      <KHMSHDon>${esc(inv.form_no ?? "1")}</KHMSHDon>`,
    `      <KHHDon>${esc(inv.serial_no ?? "")}</KHHDon>`,
    `      <SHDon>${esc(inv.code)}</SHDon>`,
    `      <NLap>${esc(inv.issued_at.slice(0, 10))}</NLap>`,
    `      <DVTTe>VND</DVTTe>`,
    `      <HTTToan>${esc(inv.method === "cash" ? "TM" : inv.method === "transfer" ? "CK" : inv.method === "card" ? "TM/CK" : "Khác")}</HTTToan>`,
    `    </TTChung>`,
    `    <NDHDon>`,
    `      <NBan><Ten>${esc(inv.seller_legal_name)}</Ten><MST>${esc(inv.seller_tax_code)}</MST><DChi>${esc(inv.seller_address)}</DChi></NBan>`,
    `      <NMua><Ten>${esc(inv.buyer_name)}</Ten><MST>${esc(inv.buyer_tax_code)}</MST><DChi>${esc(inv.buyer_address)}</DChi><SDThoai>${esc(inv.buyer_phone)}</SDThoai></NMua>`,
    `      <DSHHDVu>`,
    ...lines.map(
      (l, i) =>
        `        <HHDVu><STT>${i + 1}</STT><THHDVu>${esc(l.description)}</THHDVu><DVTinh>${esc(l.unit)}</DVTinh><SLuong>${l.qty}</SLuong><DGia>${l.unit_vnd}</DGia><ThTien>${l.amount_vnd}</ThTien><TSuat>${rate}%</TSuat></HHDVu>`,
    ),
    `      </DSHHDVu>`,
    `      <TToan><TgTCThue>${sub}</TgTCThue><TgTThue>${vat}</TgTThue><TgTTTBSo>${total}</TgTTTBSo></TToan>`,
    `    </NDHDon>`,
    `  </DLHDon>`,
    `</HDon>`,
  ].join("\n");
}

function xmlResponse(name: string, body: string) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    status: 200,
    headers: { "content-type": "application/xml; charset=utf-8", "content-disposition": `attachment; filename="${name}"` },
  });
}

export async function invoiceXmlOne(sql: Sql, id: string, user: PublicUser) {
  requireRole(user, ["manager", "receptionist"]);
  const inv = await one<InvoiceExportRow>(sql, `${EXPORT_SELECT} where i.id = $1`, [id]);
  if (!inv) throw err.notFound();
  const lines = await sql.query<{ description: string; unit: string | null; qty: number; unit_vnd: number; amount_vnd: number }>(
    `select description, unit, qty, unit_vnd, amount_vnd from invoice_lines where invoice_id = $1`,
    [id],
  );
  return xmlResponse(`${inv.code}.xml`, invoiceXml(inv, lines));
}

export function csvCell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) {
    s = `'${s}`;
  }
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rangeFromRequest(request: Request) {
  const sp = new URL(request.url).searchParams;
  const to = sp.get("to") ?? ictDateString();
  const from = sp.get("from") ?? `${to.slice(0, 8)}01`;
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw err.validation("Pick a valid date range.");
  return { sp, from, to };
}

/** The list the accountant sees before exporting: what is in range and what has already gone. */
export async function invoiceExportList(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const { from, to } = rangeFromRequest(request);
  const { limit, offset } = pageParams(request, { def: 500, max: 500 });
  const items = await sql.query(
    `select i.id, i.code, i.issued_at::text as issued_at, i.buyer_name, i.buyer_tax_code, i.total_vnd, i.vat_vnd,
            i.exported_at::text as exported_at, p.status::text as status
       from invoices i join payments p on p.id = i.payment_id
      where (i.issued_at at time zone 'Asia/Ho_Chi_Minh')::date between $1::date and $2::date
      order by i.issued_at desc limit $3 offset $4`,
    [from, to, limit, offset],
  );
  const sum = await one<{ n: number; total: number; vat: number; pending: number }>(
    sql,
    `select count(*)::int as n, coalesce(sum(total_vnd), 0)::bigint::int as total, coalesce(sum(vat_vnd), 0)::bigint::int as vat,
            count(*) filter (where exported_at is null)::int as pending
       from invoices where (issued_at at time zone 'Asia/Ho_Chi_Minh')::date between $1::date and $2::date`,
    [from, to],
  );
  // `n` is the row count to page through; `total` in the summary is money (the sum of totals).
  return { status: 200, body: { from, to, items, limit, offset, ...sum } };
}

export async function invoiceExport(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const { sp, from, to } = rangeFromRequest(request);
  const format = sp.get("format") === "xml" ? "xml" : "csv";
  const onlyNew = sp.get("only_new") === "1";
  const rows = await sql.query<InvoiceExportRow>(
    `${EXPORT_SELECT}
      where (i.issued_at at time zone 'Asia/Ho_Chi_Minh')::date between $1::date and $2::date
        and ($3::boolean = false or i.exported_at is null)
      order by i.issued_at, i.code limit 2000`,
    [from, to, onlyNew],
  );
  await sql.query(`update invoices set exported_at = now() where id = any($1::uuid[]) and exported_at is null`, [rows.map((r) => r.id)]);
  await audit(sql, user.id, "export_invoices", "invoice", null, null, { from, to, format, count: rows.length });
  if (format === "xml") {
    const lines = await sql.query<{ invoice_id: string; description: string; unit: string | null; qty: number; unit_vnd: number; amount_vnd: number }>(
      `select invoice_id, description, unit, qty, unit_vnd, amount_vnd from invoice_lines where invoice_id = any($1::uuid[])`,
      [rows.map((r) => r.id)],
    );
    const body = `<DSHDon>\n${rows.map((r) => invoiceXml(r, lines.filter((l) => l.invoice_id === r.id))).join("\n")}\n</DSHDon>`;
    return xmlResponse(`hoa-don-${from}_${to}.xml`, body);
  }
  const head = ["So_hoa_don", "Ngay_lap", "Mau_so", "Ky_hieu", "Ten_nguoi_mua", "MST_nguoi_mua", "Tien_truoc_thue", "Thue_suat_%", "Tien_thue", "Tong_tien", "Hinh_thuc_TT", "Ma_thanh_toan", "Trang_thai"];
  const out = [head.join(",")];
  for (const r of rows) {
    out.push(
      [
        r.code,
        r.issued_at.slice(0, 10),
        r.form_no ?? "1",
        r.serial_no ?? "",
        r.buyer_name,
        r.buyer_tax_code ?? "",
        r.subtotal_vnd ?? "",
        Number(r.vat_rate ?? 0),
        r.vat_vnd ?? "",
        r.total_vnd ?? r.amount_vnd,
        r.method,
        r.payment_code,
        r.status,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return new Response("﻿" + out.join("\r\n") + "\r\n", {
    status: 200,
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="hoa-don-${from}_${to}.csv"` },
  });
}

void ictClock;
void ictStamp;
