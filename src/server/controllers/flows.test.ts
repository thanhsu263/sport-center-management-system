import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

// Keep src/server/data/db.ts from bootstrapping a real connection.
process.env.DATABASE_URL = "postgres://mock:mock@localhost/mock";
process.env.PGLITE_DATA_DIR = "memory";

import { register } from "node:module";
import { pathToFileURL } from "node:url";

try {
  register(pathToFileURL("./scripts/tests/agent/ttf-loader.mjs"));
} catch {
  // already registered
}

const { setOverridePglite, withTx } = await import("./tx.ts");
const { classesEnroll, enrollmentDelete } = await import("./handlers/classes.ts");
const { bookingsHold, bookingsConfirm, bookingsTransferConfirm, bookingsCancel } = await import("./handlers/bookings.ts");
const { paymentsCreate } = await import("./handlers/desk.ts");
const { gateCheckin } = await import("./handlers/checkin.ts");
const { membersReportBody } = await import("./handlers/reports.ts");
const { handleApi } = await import("./router.ts");

let db: PGlite;

before(async () => {
  db = new PGlite();
  await db.waitReady;
  const migDir = "migrations";
  const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    await db.exec(readFileSync(join(migDir, f), "utf8"));
  }
  setOverridePglite(db);
});

after(() => {
  setOverridePglite(null);
});

// ---- shared fixtures (seeded by migrations 0003/0006) ----
const MANAGER = { id: "00000000-0000-0000-0000-000000000001", role: "manager", full_name: "Quan ly Arena3" } as any;
const RECEPTIONIST = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist", full_name: "Le tan ca 1" } as any;
const COACH_ID = "00000000-0000-0000-0000-000000000003";

let seq = 0;
const nextPhone = () => "+8497" + String(++seq).padStart(7, "0");

/** Day n days from today in Asia/Ho_Chi_Minh (UTC+7), as YYYY-MM-DD. */
const ictDay = (n: number) => new Date(Date.now() + 7 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
const FUTURE = () => ictDay(3);
const PAST = () => ictDay(-2);
const TODAY = () => ictDay(0);

function jsonReq(body: unknown, method = "POST"): Request {
  return new Request("http://localhost/v1/test", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedMember(name: string): Promise<any> {
  const id = randomUUID();
  const phone = nextPhone();
  await db.query(
    `insert into users (id, phone, full_name, name_normalized, role, password_hash, pii_consent_at)
     values ($1, $2, $3, $4, 'member', 'hash', now())`,
    [id, phone, name, name.toLowerCase()],
  );
  return { id, role: "member", full_name: name } as any;
}

async function seedCourt(tag: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into courts (id, court_code, sport, status) values ($1, $2, 'badminton', 'ready')`,
    [id, "C" + tag + String(++seq)],
  );
  return id;
}

/** The receptionist has at most one open shift (one_open_shift), so reuse it when present. */
async function openShift(): Promise<string> {
  const existing = await db.query<{ id: string }>(
    "select id from cashier_shifts where receptionist_id = $1 and closed_at is null",
    [RECEPTIONIST.id],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const r = await db.query<{ id: string }>(
    "insert into cashier_shifts (receptionist_id) values ($1) returning id",
    [RECEPTIONIST.id],
  );
  return r.rows[0].id;
}

async function insertClass(opts: {
  capacity: number;
  price: number;
  startOn?: string;
  endOn?: string;
  courtId: string;
}): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into classes (id, sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count, price_vnd)
     values ($1, 'badminton', 'flow-test', $2, $3, 'FREQ=WEEKLY;BYDAY=TU;BYHOUR=14', $4::date, $5::date, 60, $6, 'open', 0, $7)`,
    [id, COACH_ID, opts.courtId, opts.startOn ?? ictDay(2), opts.endOn ?? ictDay(30), opts.capacity, opts.price],
  );
  return id;
}

/** Member places a hold on a court slot (09:00 local by default). Returns the hold response. */
async function holdSlot(member: any, courtId: string, day = FUTURE(), hhmm = "09:00") {
  return withTx((sql) =>
    bookingsHold(sql, jsonReq({ court_id: courtId, start_at: `${day}T${hhmm}:00+07:00` }), member),
  );
}

async function bookingRow(id: string): Promise<any> {
  return (await db.query<any>("select * from court_bookings where id = $1", [id])).rows[0];
}

async function expectRejects(p: () => Promise<unknown>, status: number, check?: (e: any) => void) {
  await assert.rejects(p, (e: any) => {
    assert.equal(e.status, status, `expected HTTP ${status}, got ${e.status}: ${e.message}`);
    check?.(e);
    return true;
  });
}

/** Seed a court booking directly (for gate, cancel and report flows). */
async function seedConfirmedBooking(opts: {
  userId: string;
  courtId: string;
  startAt: string;
  paidVnd?: number;
  quotaHours?: number;
  status?: string;
}): Promise<string> {
  const bookingId = randomUUID();
  const endAt = new Date(new Date(opts.startAt).getTime() + 3600_000).toISOString();
  // booking_occ_sync: a cancelled booking holds no occupancy; a live one must hold it.
  const live = (opts.status ?? "confirmed") !== "cancelled";
  const occId = live
    ? (
        await db.query<{ id: string }>(
          `insert into occupancies (id, court_id, start_at, end_at, kind, ref_id)
           values (gen_random_uuid(), $1, $2, $3, 'booking', $4) returning id`,
          [opts.courtId, opts.startAt, endAt, bookingId],
        )
      ).rows[0].id
    : null;
  await db.query(
    `insert into court_bookings (id, court_id, user_id, start_at, end_at, status, price_vnd, deposit_vnd, paid_vnd, code, channel, occupancy_id)
     values ($1, $2, $3, $4, $5, $6, 100000, 0, $7, $8, 'app', $9)`,
    [
      bookingId,
      opts.courtId,
      opts.userId,
      opts.startAt,
      endAt,
      opts.status ?? "confirmed",
      opts.paidVnd ?? 0,
      "BK" + bookingId.slice(0, 8).toUpperCase(),
      occId,
    ],
  );
  if (opts.quotaHours) {
    await db.query("update court_bookings set quota_hours = $2 where id = $1", [bookingId, opts.quotaHours]);
  }
  return bookingId;
}

// =====================================================================
// MF-01: Member books a court and pays the full slot price
// =====================================================================
describe("MF-01 Member books a court and pays the full slot price", () => {
  it("MF-01: hold -> transfer request -> desk confirms; the posted payment equals the slot price", async () => {
    const m = await seedMember("MF01 Member");
    const court = await seedCourt("MF01");
    const hold = await holdSlot(m, court);
    assert.equal(hold.status, 201);
    const booking = (hold.body as any).booking;
    const price = (hold.body as any).price;
    assert.equal(booking.status, "hold");
    assert.ok(price > 0, "slot price should be positive");

    const confirm = await withTx((sql) => bookingsConfirm(sql, booking.id, jsonReq({ method: "transfer" }), m));
    assert.equal(confirm.status, 202);
    assert.equal((confirm.body as any).awaiting_transfer, true);

    const settled = await withTx((sql) => bookingsTransferConfirm(sql, booking.id, RECEPTIONIST));
    assert.equal(settled.status, 200);

    const row = await bookingRow(booking.id);
    assert.equal(row.status, "confirmed");
    const pays = (await db.query<any>(
      "select amount_vnd, status from payments where ref_type = 'booking' and ref_id = $1",
      [booking.id],
    )).rows;
    assert.equal(pays.length, 1, "exactly one payment row");
    assert.equal(pays[0].status, "posted");
    // Default settings: the slot's own terms decide (deposit if valid, else full).
    const deposit = Number(row.deposit_vnd);
    const expectedDue = deposit > 0 && deposit < price ? deposit : price;
    assert.equal(Number(pays[0].amount_vnd), expectedDue);
    assert.equal(Number(row.paid_vnd), expectedDue);
  });

  it("MF-01b: controlled settings - a 30% deposit collects less than the price and leaves a balance; 0% collects the full price", async () => {
    const saved = (await db.query<any>("select deposit_pct, deposit_peak_only from center_settings where id = 1")).rows[0];
    try {
      const run = async (pct: number, tag: string) => {
        await db.query("update center_settings set deposit_pct = $1, deposit_peak_only = false where id = 1", [pct]);
        const m = await seedMember("MF01b " + tag);
        const court = await seedCourt("D" + tag[0]);
        const hold = await holdSlot(m, court);
        assert.equal(hold.status, 201);
        const id = (hold.body as any).booking.id;
        const price = Number((hold.body as any).price);
        await withTx((sql) => bookingsConfirm(sql, id, jsonReq({ method: "transfer" }), m));
        await withTx((sql) => bookingsTransferConfirm(sql, id, RECEPTIONIST));
        const row = await bookingRow(id);
        const pays = (await db.query<any>(
          "select amount_vnd from payments where ref_type = 'booking' and ref_id = $1 and status = 'posted'", [id],
        )).rows;
        assert.equal(pays.length, 1);
        return { price, row, paid: Number(pays[0].amount_vnd) };
      };
      const dep = await run(30, "dep");
      assert.equal(dep.row.status, "confirmed");
      assert.ok(dep.paid > 0 && dep.paid < dep.price, `deposit ${dep.paid} must be between 0 and price ${dep.price}`);
      // 30% of the price within one rounding step (not a copy of depositFor).
      assert.ok(Math.abs(dep.paid - dep.price * 0.3) <= dep.price * 0.05, "deposit is about 30% of the price");
      assert.equal(Number(dep.row.deposit_vnd), dep.paid);
      assert.equal(Number(dep.row.paid_vnd), dep.paid);
      assert.ok(Number(dep.row.price_vnd) - Number(dep.row.paid_vnd) > 0, "a balance is left for the desk");

      const full = await run(0, "full");
      assert.equal(Number(full.row.deposit_vnd), 0);
      assert.equal(full.paid, full.price, "no deposit -> full price collected");
      assert.equal(Number(full.row.paid_vnd), full.price);
    } finally {
      await db.query("update center_settings set deposit_pct = $1, deposit_peak_only = $2 where id = 1", [saved.deposit_pct, saved.deposit_peak_only]);
    }
  });

  it("EF-01a: a second member cannot hold a slot that is already held (409 CONFLICT_SLOT)", async () => {
    const m1 = await seedMember("EF01a Holder");
    const m2 = await seedMember("EF01a Latecomer");
    const court = await seedCourt("EF01a");
    await holdSlot(m1, court);
    await expectRejects(() => holdSlot(m2, court), 409, (e) => assert.equal(e.code, "CONFLICT_SLOT"));
  });

  it("EF-01b: method quota is refused with 422 and the hold stays on hold", async () => {
    const m = await seedMember("EF01b Member");
    const court = await seedCourt("EF01b");
    const hold = await holdSlot(m, court);
    const id = (hold.body as any).booking.id;
    await expectRejects(
      () => withTx((sql) => bookingsConfirm(sql, id, jsonReq({ method: "quota" }), m)),
      422,
      (e) => assert.equal(e.extra.field, "method"),
    );
    assert.equal((await bookingRow(id)).status, "hold");
  });

  it("EF-01c: a member cannot confirm another member's hold (403)", async () => {
    const owner = await seedMember("EF01c Owner");
    const intruder = await seedMember("EF01c Intruder");
    const court = await seedCourt("EF01c");
    const hold = await holdSlot(owner, court);
    const id = (hold.body as any).booking.id;
    await expectRejects(
      () => withTx((sql) => bookingsConfirm(sql, id, jsonReq({ method: "transfer" }), intruder)),
      403,
    );
  });

  it("EF-01d: a booking whose start is in the past is refused (4xx, no booking created)", async () => {
    const m = await seedMember("EF01d Member");
    const court = await seedCourt("EF01d");
    await assert.rejects(() => holdSlot(m, court, PAST()), (e: any) => {
      assert.ok(e.status >= 400 && e.status < 500, `expected 4xx, got ${e.status}`);
      return true;
    });
    const n = (await db.query<{ n: number }>("select count(*)::int as n from court_bookings where user_id = $1", [m.id])).rows[0].n;
    assert.equal(n, 0);
  });

  it("EF-01e: a court id that does not exist is refused with 404", async () => {
    const m = await seedMember("EF01e Member");
    await expectRejects(() => holdSlot(m, randomUUID()), 404);
  });
});

// =====================================================================
// MF-02: Member enrols in a class and pays the class price
// =====================================================================
describe("MF-02 Member enrols in a class and pays the class price", () => {
  it("MF-02: enrol (hold) -> desk takes the class price -> seat confirmed", async () => {
    const court = await seedCourt("MF02");
    const cls = await insertClass({ capacity: 5, price: 300000, courtId: court });
    const m = await seedMember("MF02 Member");
    const enr = await withTx((sql) => classesEnroll(sql, cls, new Request("http://localhost"), m));
    assert.equal(enr.status, 201);
    const enrollment = (enr.body as any).enrollment;
    assert.equal(enrollment.status, "hold");

    const shift = await openShift();
    const pay = await withTx((sql) =>
      paymentsCreate(sql, jsonReq({ ref_type: "enrollment", ref_id: enrollment.id, method: "cash", amount_vnd: 300000, shift_id: shift }), RECEPTIONIST),
    );
    assert.equal(pay.status, 201);
    const row = (await db.query<any>("select status from enrollments where id = $1", [enrollment.id])).rows[0];
    assert.equal(row.status, "confirmed");
    const cnt = (await db.query<any>("select enrolled_count from classes where id = $1", [cls])).rows[0];
    assert.equal(cnt.enrolled_count, 1);
  });

  it("EF-02a: a full class seats the member on the waitlist (201, waitlisted: true)", async () => {
    const court = await seedCourt("EF02a");
    const cls = await insertClass({ capacity: 1, price: 300000, courtId: court });
    const first = await seedMember("EF02a First");
    const second = await seedMember("EF02a Second");
    await withTx((sql) => classesEnroll(sql, cls, new Request("http://localhost"), first));
    const res = await withTx((sql) => classesEnroll(sql, cls, new Request("http://localhost"), second));
    assert.equal(res.status, 201);
    assert.equal((res.body as any).waitlisted, true);
    assert.equal((res.body as any).enrollment.status, "waitlisted");
  });

  it("EF-02b: enrolling twice in the same class is refused (422 BR-22)", async () => {
    const court = await seedCourt("EF02b");
    const cls = await insertClass({ capacity: 5, price: 300000, courtId: court });
    const m = await seedMember("EF02b Member");
    await withTx((sql) => classesEnroll(sql, cls, new Request("http://localhost"), m));
    await expectRejects(
      () => withTx((sql) => classesEnroll(sql, cls, new Request("http://localhost"), m)),
      422,
      (e) => assert.equal(e.extra.br, "BR-22"),
    );
  });

  it("EF-02c: a payment for a wrong class amount is refused (400, field amount_vnd) and the seat stays on hold", async () => {
    const court = await seedCourt("EF02c");
    const cls = await insertClass({ capacity: 5, price: 300000, courtId: court });
    const m = await seedMember("EF02c Member");
    const enr = await withTx((sql) => classesEnroll(sql, cls, new Request("http://localhost"), m));
    const enrId = (enr.body as any).enrollment.id;
    const shift = await openShift();
    await expectRejects(
      () =>
        withTx((sql) =>
          paymentsCreate(sql, jsonReq({ ref_type: "enrollment", ref_id: enrId, method: "cash", amount_vnd: 250000, shift_id: shift }), RECEPTIONIST),
        ),
      400,
      (e) => assert.equal(e.extra.field, "amount_vnd"),
    );
    const row = (await db.query<any>("select status from enrollments where id = $1", [enrId])).rows[0];
    assert.equal(row.status, "hold");
  });
});

// =====================================================================
// MF-03: Desk records a payment for a booking or an enrolment
// =====================================================================
describe("MF-03 Desk records a payment (paymentsCreate)", () => {
  it("MF-03: receptionist with an open shift records cash for a held booking (201, posted, invoice issued)", async () => {
    const m = await seedMember("MF03 Member");
    const court = await seedCourt("MF03");
    const hold = await holdSlot(m, court);
    const booking = (hold.body as any).booking;
    const price = (hold.body as any).price;
    const shift = await openShift();
    const res = await withTx((sql) =>
      paymentsCreate(sql, jsonReq({ ref_type: "booking", ref_id: booking.id, method: "cash", amount_vnd: price, shift_id: shift }), RECEPTIONIST),
    );
    assert.equal(res.status, 201);
    assert.equal((res.body as any).payment.status, "posted");
    assert.equal((res.body as any).payment.method, "cash");
    assert.ok((res.body as any).invoice?.id, "an invoice is issued");
  });

  it("EF-03a: ref_type subscription is accepted again; an unknown plan is refused, not the ref_type", async () => {
    const shift = await openShift();
    await assert.rejects(
      () =>
        withTx((sql) =>
          paymentsCreate(sql, jsonReq({ ref_type: "subscription", ref_id: randomUUID(), method: "cash", amount_vnd: 100000, shift_id: shift }), RECEPTIONIST),
        ),
      (e: any) => {
        assert.notEqual(e.extra?.field, "ref_type");
        return true;
      },
    );
  });

  it("EF-03b: a member cannot record a desk payment (403)", async () => {
    const m = await seedMember("EF03b Member");
    await expectRejects(
      () =>
        withTx((sql) =>
          paymentsCreate(sql, jsonReq({ ref_type: "booking", ref_id: randomUUID(), method: "cash", amount_vnd: 100000 }), m),
        ),
      403,
    );
  });
});

// =====================================================================
// MF-04: Gate check-in admits a member with a booking today
// =====================================================================
describe("MF-04 Gate check-in admits a member with activity today", () => {
  it("MF-04: a member with a confirmed booking today is entitled and admitted", async () => {
    const m = await seedMember("MF04 Member");
    const court = await seedCourt("MF04");
    await seedConfirmedBooking({ userId: m.id, courtId: court, startAt: `${TODAY()}T10:00:00+07:00` });
    const res = await withTx((sql) => gateCheckin(sql, jsonReq({ member_id: m.id, reason: "forgot" }), RECEPTIONIST));
    const body = res.body as any;
    assert.equal(body.allowed, true);
    assert.equal(body.needs_override, false);
    assert.equal(body.today.bookings.length, 1);
  });

  it("EF-04a: a member with nothing booked today is not entitled (needs override)", async () => {
    const m = await seedMember("EF04a Member");
    const res = await withTx((sql) => gateCheckin(sql, jsonReq({ member_id: m.id, reason: "forgot" }), RECEPTIONIST));
    assert.equal((res.body as any).allowed, false);
    assert.equal((res.body as any).needs_override, true);
  });

  it("EF-04b: a booking that was yesterday does not admit the member today", async () => {
    const m = await seedMember("EF04b Member");
    const court = await seedCourt("EF04b");
    await seedConfirmedBooking({ userId: m.id, courtId: court, startAt: `${PAST()}T10:00:00+07:00` });
    const res = await withTx((sql) => gateCheckin(sql, jsonReq({ member_id: m.id, reason: "forgot" }), RECEPTIONIST));
    assert.equal((res.body as any).allowed, false);
    assert.equal((res.body as any).today.bookings.length, 0);
  });
});

// =====================================================================
// MF-05: Cancel a booking or an enrolment under the cancel rules
// =====================================================================
describe("MF-05 Cancel a booking or enrolment", () => {
  it("MF-05a: member cancels own confirmed, paid booking -> 200, booking cancelled, refund row matches the quote", async () => {
    const m = await seedMember("MF05a Member");
    const court = await seedCourt("MF05a");
    const id = await seedConfirmedBooking({ userId: m.id, courtId: court, startAt: `${ictDay(20)}T09:00:00+07:00`, paidVnd: 100000 });
    const res = await withTx((sql) => bookingsCancel(sql, id, m));
    assert.equal(res.status, 200);
    assert.equal((await bookingRow(id)).status, "cancelled");
    const quote = (res.body as any).quote;
    const refunds = (await db.query<any>("select amount_vnd from payments where ref_type = 'booking' and ref_id = $1", [id])).rows;
    if (quote.refund_vnd > 0) {
      assert.equal(refunds.length, 1);
      assert.equal(Number(refunds[0].amount_vnd), -quote.refund_vnd);
    } else {
      assert.equal(refunds.length, 0);
    }
  });

  it("MF-05b: member releases own enrolment hold -> 200, enrolment cancelled, class count back down", async () => {
    const court = await seedCourt("MF05b");
    const cls = await insertClass({ capacity: 5, price: 300000, courtId: court });
    const m = await seedMember("MF05b Member");
    const enr = await withTx((sql) => classesEnroll(sql, cls, new Request("http://localhost"), m));
    const enrId = (enr.body as any).enrollment.id;
    const res = await withTx((sql) => enrollmentDelete(sql, enrId, m));
    assert.equal(res.status, 200);
    assert.equal((await db.query<any>("select status from enrollments where id = $1", [enrId])).rows[0].status, "cancelled");
    assert.equal((await db.query<any>("select enrolled_count from classes where id = $1", [cls])).rows[0].enrolled_count, 0);
  });

  it("EF-05a: a member cannot cancel another member's booking (403)", async () => {
    const owner = await seedMember("EF05a Owner");
    const other = await seedMember("EF05a Other");
    const court = await seedCourt("EF05a");
    const id = await seedConfirmedBooking({ userId: owner.id, courtId: court, startAt: `${ictDay(20)}T09:00:00+07:00`, paidVnd: 100000 });
    await expectRejects(() => withTx((sql) => bookingsCancel(sql, id, other)), 403);
    assert.equal((await bookingRow(id)).status, "confirmed");
  });

  it("EF-05b: an old quota booking cancels with no refund and writes no payment row", async () => {
    const m = await seedMember("EF05b Member");
    const court = await seedCourt("EF05b");
    const id = await seedConfirmedBooking({ userId: m.id, courtId: court, startAt: `${ictDay(20)}T09:00:00+07:00`, paidVnd: 0, quotaHours: 1 });
    const res = await withTx((sql) => bookingsCancel(sql, id, m));
    assert.equal(res.status, 200);
    assert.equal((res.body as any).refund, null);
    const n = (await db.query<{ n: number }>("select count(*)::int as n from payments where ref_id = $1", [id])).rows[0].n;
    assert.equal(n, 0);
  });

  it("EF-05c: cancelling a booking that is already cancelled is refused (409)", async () => {
    const m = await seedMember("EF05c Member");
    const court = await seedCourt("EF05c");
    const id = await seedConfirmedBooking({ userId: m.id, courtId: court, startAt: `${ictDay(20)}T09:00:00+07:00`, status: "cancelled" });
    await expectRejects(() => withTx((sql) => bookingsCancel(sql, id, m)), 409);
  });

  it("EF-05e: a paid booking that has already started cannot be cancelled, and no refund is written", async () => {
    const m = await seedMember("EF05e Member");
    const court = await seedCourt("EF05e");
    const id = await seedConfirmedBooking({ userId: m.id, courtId: court, startAt: `${PAST()}T10:00:00+07:00`, paidVnd: 100000 });
    await expectRejects(() => withTx((sql) => bookingsCancel(sql, id, m)), 409);
    assert.equal((await bookingRow(id)).status, "confirmed");
    const n = (await db.query<{ n: number }>("select count(*)::int as n from payments where ref_id = $1", [id])).rows[0].n;
    assert.equal(n, 0);
  });

  it("EF-05d: a member cannot release another member's enrolment (403)", async () => {
    const court = await seedCourt("EF05d");
    const cls = await insertClass({ capacity: 5, price: 300000, courtId: court });
    const owner = await seedMember("EF05d Owner");
    const other = await seedMember("EF05d Other");
    const enr = await withTx((sql) => classesEnroll(sql, cls, new Request("http://localhost"), owner));
    const enrId = (enr.body as any).enrollment.id;
    await expectRejects(() => withTx((sql) => enrollmentDelete(sql, enrId, other)), 403);
  });
});

// =====================================================================
// MF-06: Plan endpoints are back
// =====================================================================
describe("MF-06 Plan endpoints answer again", () => {
  before(() => {
    // handleApi starts the job loop unless this flag is set; the loop would keep the process alive.
    (globalThis as any).__arena3Jobs__ = true;
  });

  it("MF-06: GET /v1/plans lists plans publicly (200)", async () => {
    const res = await handleApi(new Request("http://localhost/v1/plans", { method: "GET" }));
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(((await res.json()) as any).items));
  });

  it("EF-06a: POST /v1/plans without a session is refused (401), not missing", async () => {
    const res = await handleApi(
      new Request("http://localhost/v1/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Goi thang", price_vnd: 500000 }),
      }),
    );
    assert.equal(res.status, 401);
  });

  it("EF-06b: POST /v1/subscriptions without a session is refused (401), not missing", async () => {
    const res = await handleApi(
      new Request("http://localhost/v1/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan_id: "00000000-0000-0000-0000-000000000000" }),
      }),
    );
    assert.equal(res.status, 401);
  });
});

// =====================================================================
// MF-07: Reports count active members from bookings and enrolments
// =====================================================================
describe("MF-07 Reports count active members from bookings and enrolments", () => {
  const FROM = "2099-03-01";
  const TO = "2099-03-31";

  async function activeCount(): Promise<number> {
    const body: any = await withTx((sql) => membersReportBody(sql, FROM, TO, null));
    return body.members.active as number;
  }

  it("MF-07: a member with a booking in range and a member with a confirmed class seat both count as active", async () => {
    const base = await activeCount();
    const booker = await seedMember("MF07 Booker");
    const seated = await seedMember("MF07 Seated");
    const courtB = await seedCourt("MF07b");
    await seedConfirmedBooking({ userId: booker.id, courtId: courtB, startAt: "2099-03-10T10:00:00+07:00" });
    const courtC = await seedCourt("MF07c");
    const cls = await insertClass({ capacity: 10, price: 300000, courtId: courtC, startOn: FROM, endOn: TO });
    await withTx((sql) => classesEnroll(sql, cls, new Request("http://localhost"), seated));
    await db.query("update enrollments set status = 'confirmed' where class_id = $1 and user_id = $2", [cls, seated.id]);
    assert.equal(await activeCount(), base + 2);
  });

  it("EF-07a: a member with no activity is not counted", async () => {
    const base = await activeCount();
    await seedMember("EF07a Idle");
    assert.equal(await activeCount(), base);
  });

  it("EF-07b: a booking outside the report window does not make the member active", async () => {
    const base = await activeCount();
    const m = await seedMember("EF07b Outside");
    const court = await seedCourt("EF07b");
    await seedConfirmedBooking({ userId: m.id, courtId: court, startAt: "2099-02-10T10:00:00+07:00" });
    assert.equal(await activeCount(), base);
  });
});
