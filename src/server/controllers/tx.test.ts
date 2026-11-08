import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

// Prevent src/lib/db.ts from running bootstrap in test runner
process.env.DATABASE_URL = "postgres://mock:mock@localhost/mock";

import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Register custom loader for .ttf font files required by pdf.ts (via desk.ts)
try {
  register(pathToFileURL("./scripts/tests/agent/ttf-loader.mjs"));
} catch {
  // Ignore if already registered
}

const { KeepWrites, setOverridePglite, withTx } = await import("./tx.ts");
const authH = await import("./handlers/auth.ts");
const { readJson, withIdempotency } = await import("./helpers.ts");
const opsH = await import("./handlers/ops.ts");
const { classesCreate, enrollmentDelete, classesEnroll, sessionReschedule } = await import("./handlers/classes.ts");
const { subscriptionsCreate, plansPatch } = await import("./handlers/plans.ts");
const { bookingGet, bookingsReschedule, walkIn, bookingsHold } = await import("./handlers/bookings.ts");
const { shiftClose, paymentsCreate, shiftCurrent, paymentsRefund, paymentsApproveRefund } = await import("./handlers/desk.ts");
const { waitlistAccept, inviteWaitlist, subscriptionFreeze, subscriptionUnfreeze, sessionAttendancePost } = await import("./handlers/ops.ts");
const { findUserByLogin, issueSession, authFromRequest, toPublic } = await import("./session.ts");
const { hashPassword, hashOtp } = await import("./crypto.ts");
const { csvCell } = await import("./handlers/extras.ts");
const { trainingCreate } = await import("./handlers/training.ts");
const { onlineCreate } = await import("./handlers/online.ts");
const { setOverridePaymentLinkCreator } = await import("./payos.ts");
const chatH = await import("./handlers/chat.ts");

let db: PGlite;

before(async () => {
  db = new PGlite();
  await db.waitReady;
  const migDir = "migrations";
  const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sqlContent = readFileSync(join(migDir, f), "utf8");
    await db.exec(sqlContent);
  }
  setOverridePglite(db);
});

after(() => {
  setOverridePglite(null);
});

describe("withTx & KeepWrites unit tests", () => {
  it("commits writes when KeepWrites is thrown, and rethrows inner error", async () => {
    await db.query("create table if not exists _tx_test (id serial primary key, note text);");

    const inner = new Error("custom inner error");
    await assert.rejects(
      async () => {
        await withTx(async (sql) => {
          await sql.query("insert into _tx_test (note) values ($1)", ["survived_keep_writes"]);
          throw new KeepWrites(inner);
        });
      },
      (err: any) => {
        assert.equal(err, inner);
        assert.equal(err instanceof KeepWrites, false);
        return true;
      }
    );

    const rows = await db.query("select * from _tx_test where note = 'survived_keep_writes'");
    assert.equal(rows.rows.length, 1);
  });

  it("rolls back writes when a normal error is thrown", async () => {
    await db.query("create table if not exists _tx_test (id serial primary key, note text);");

    const normal = new Error("regular rollback error");
    await assert.rejects(
      async () => {
        await withTx(async (sql) => {
          await sql.query("insert into _tx_test (note) values ($1)", ["should_be_rolled_back"]);
          throw normal;
        });
      },
      (err: any) => {
        assert.equal(err, normal);
        return true;
      }
    );

    const rows = await db.query("select * from _tx_test where note = 'should_be_rolled_back'");
    assert.equal(rows.rows.length, 0);
  });

  it("5 consecutive wrong password attempts locks account and preserves counter", async () => {
    const testPhone = "+84999888777";
    await db.query(`
      insert into users (id, phone, full_name, name_normalized, role, status, password_hash, failed_logins)
      values (
        '99999999-0000-0000-0000-000000000001',
        $1,
        'Test Lockout User',
        'test lockout user',
        'member',
        'active',
        '$2b$10$wE4Q1i5s88xV83rGzLqWdOBiK7GjBvhVv6U1X7r2H5P1G8z123456',
        0
      )
      on conflict (phone) do update set failed_logins = 0, locked_until = null
    `, [testPhone]);

    // 4 wrong passwords -> 401 UNAUTHORIZED, failed_logins increases 1..4
    for (let i = 1; i <= 4; i++) {
      const req = new Request("http://localhost/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: testPhone, password: "WrongPassword!123" }),
      });

      await assert.rejects(
        async () => {
          await withTx(async (sql) => authH.login(sql, req));
        },
        (err: any) => {
          assert.equal(err.status, 401);
          return true;
        }
      );

      const r = await db.query<{ failed_logins: number; locked_until: string | null }>(
        "select failed_logins, locked_until from users where phone = $1",
        [testPhone]
      );
      assert.equal(r.rows[0].failed_logins, i);
      assert.equal(r.rows[0].locked_until, null);
    }

    // 5th wrong password -> 429 RATE_LIMITED, locked_until is set
    const req5 = new Request("http://localhost/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: testPhone, password: "WrongPassword!123" }),
    });

    await assert.rejects(
      async () => {
        await withTx(async (sql) => authH.login(sql, req5));
      },
      (err: any) => {
        assert.equal(err.status, 429);
        return true;
      }
    );

    const r5 = await db.query<{ failed_logins: number; locked_until: string | null }>(
      "select failed_logins, locked_until from users where phone = $1",
      [testPhone]
    );
    assert.equal(r5.rows[0].failed_logins, 5);
    assert.notEqual(r5.rows[0].locked_until, null);
  });
});

describe("readJson unit tests", () => {
  const reqOf = (body?: string) =>
    new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

  it("throws validation error for null and primitives", async () => {
    for (const raw of ["null", "5", '"x"', "true"]) {
      await assert.rejects(
        async () => readJson(reqOf(raw)),
        (err: any) => {
          assert.equal(err.status, 422);
          assert.equal(err.code, "VALIDATION");
          assert.equal(err.message, "Request body must be a JSON object.");
          return true;
        }
      );
    }
  });

  it("returns arrays as-is for [] and [{\"a\":1}]", async () => {
    const emptyArr = await readJson(reqOf("[]"));
    assert.deepEqual(emptyArr, []);

    const filledArr = await readJson(reqOf('[{"a":1}]'));
    assert.deepEqual(filledArr, [{ a: 1 }]);
  });

  it("returns empty object for empty body", async () => {
    const res = await readJson(reqOf(""));
    assert.deepEqual(res, {});
  });

  it("rejects NUL byte in string value, nested array, or object key", async () => {
    const cases = [
      '{"a":"x\\u0000y"}',
      '{"a":["\\u0000"]}',
      '{"bad\\u0000key":1}',
    ];
    for (const raw of cases) {
      await assert.rejects(
        async () => readJson(reqOf(raw)),
        (err: any) => {
          assert.equal(err.status, 422);
          assert.equal(err.code, "VALIDATION");
          assert.equal(err.message, "Text must not contain NUL characters.");
          return true;
        }
      );
    }
  });

  it("returns normal object as-is", async () => {
    const res = await readJson(reqOf('{"name":"Tennis Court","price":100000,"active":true}'));
    assert.deepEqual(res, { name: "Tennis Court", price: 100000, active: true });
  });
});

describe("subscriptionFreeze days validation unit tests", () => {
  it("rejects non-integer days 'abc' with 400", async () => {
    const req = new Request("http://localhost/v1/subscriptions/mock/freeze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ days: "abc" }),
    });
    const mockUser = { id: "00000000-0000-0000-0000-000000000001", role: "manager" } as any;

    await assert.rejects(
      async () => opsH.subscriptionFreeze({} as any, "99999999-9999-4999-8999-999999999999", req, mockUser),
      (err: any) => {
        assert.equal(err.status, 400);
        assert.equal(err.extra?.field, "days");
        return true;
      }
    );
  });

  it("rejects out-of-range days (0 and 91) with 422", async () => {
    const mockUser = { id: "00000000-0000-0000-0000-000000000001", role: "manager" } as any;
    for (const d of [0, 91]) {
      const req = new Request("http://localhost/v1/subscriptions/mock/freeze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ days: d }),
      });
      await assert.rejects(
        async () => opsH.subscriptionFreeze({} as any, "99999999-9999-4999-8999-999999999999", req, mockUser),
        (err: any) => {
          assert.equal(err.status, 422);
          assert.equal(err.message, "Freeze length must be 1–90 days.");
          return true;
        }
      );
    }
  });

  it("accepts valid days '7' and defaults missing days to 7", async () => {
    const mockUser = { id: "00000000-0000-0000-0000-000000000001", role: "manager" } as any;
    for (const body of [{ days: "7" }, {}]) {
      const req = new Request("http://localhost/v1/subscriptions/mock/freeze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await assert.rejects(
        async () => withTx(async (sql) => opsH.subscriptionFreeze(sql, "99999999-9999-4999-8999-999999999999", req, mockUser)),
        (err: any) => {
          assert.equal(err.status, 404);
          return true;
        }
      );
    }
  });
});

describe("foreign keys & subscription role unit tests (Vòng 3: F-24, F-25, F-18, F-21)", () => {
  const managerUser = { id: "00000000-0000-0000-0000-000000000001", role: "manager" } as any;
  const receptionistUser = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist" } as any;
  const coachUser = { id: "00000000-0000-0000-0000-000000000003", role: "coach" } as any;
  const memberUser = { id: "00000000-0000-0000-0000-000000000004", role: "member" } as any;

  const validCourtId = "10000000-0000-0000-0000-000000000001";
  const nonexistentId = "99999999-9999-4999-8999-999999999999";
  const validPlanId = "20000000-0000-0000-0000-000000000001";
  const asstCoachId = "00000000-0000-0000-0000-000000000005";

  before(async () => {
    await db.query(`
      insert into users (id, full_name, name_normalized, phone, role, status, password_hash, pii_consent_at)
      values ($1, 'HLV Phu', 'hlv phu', '+84900000005', 'coach', 'active', 'hash', now())
      on conflict (id) do nothing
    `, [asstCoachId]);
  });

  const classBody = (overrides = {}) => ({
    sport: "badminton",
    level: "beginner",
    coach_id: coachUser.id,
    court_id: validCourtId,
    rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9",
    start_on: "2026-11-01",
    end_on: "2026-11-30",
    duration_min: 60,
    capacity: 10,
    ...overrides,
  });

  // 1. sân không tồn tại (nonexistent court_id -> 400 field: court_id)
  it("rejects nonexistent court_id with 400", async () => {
    const req = new Request("http://localhost/v1/classes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(classBody({ court_id: nonexistentId })),
    });
    await assert.rejects(
      async () => withTx(async (sql) => classesCreate(sql, req, managerUser)),
      (err: any) => {
        assert.equal(err.status, 400);
        assert.equal(err.extra?.field, "court_id");
        return true;
      }
    );
  });

  // 2. trợ giảng không tồn tại (nonexistent assistant_id -> 400 field: assistant_id)
  it("rejects nonexistent assistant_id with 400", async () => {
    const req = new Request("http://localhost/v1/classes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(classBody({ assistant_id: nonexistentId })),
    });
    await assert.rejects(
      async () => withTx(async (sql) => classesCreate(sql, req, managerUser)),
      (err: any) => {
        assert.equal(err.status, 400);
        assert.equal(err.extra?.field, "assistant_id");
        return true;
      }
    );
  });

  // 3. trợ giảng là member (assistant is member -> 400 field: assistant_id)
  it("rejects member as assistant_id with 400", async () => {
    const req = new Request("http://localhost/v1/classes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(classBody({ assistant_id: memberUser.id })),
    });
    await assert.rejects(
      async () => withTx(async (sql) => classesCreate(sql, req, managerUser)),
      (err: any) => {
        assert.equal(err.status, 400);
        assert.equal(err.extra?.field, "assistant_id");
        return true;
      }
    );
  });

  // 4. trợ giảng hợp lệ (vẫn tạo được) (assistant is coach -> creates class)
  it("creates class when assistant is coach", async () => {
    const req = new Request("http://localhost/v1/classes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(classBody({ assistant_id: asstCoachId })),
    });
    const res = await withTx(async (sql) => classesCreate(sql, req, managerUser));
    assert.equal(res.status, 201);
  });

  // 5. user_id không tồn tại (nonexistent user_id for subscription -> 400 field: user_id)
  it("rejects nonexistent user_id for subscription with 400", async () => {
    const req = new Request("http://localhost/v1/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan_id: validPlanId, user_id: nonexistentId }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => subscriptionsCreate(sql, req, receptionistUser)),
      (err: any) => {
        assert.equal(err.status, 400);
        assert.equal(err.extra?.field, "user_id");
        return true;
      }
    );
  });

  // 6. user_id là coach (subscription for coach -> 403)
  it("rejects coach as subscription recipient with 403", async () => {
    const req = new Request("http://localhost/v1/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan_id: validPlanId, user_id: coachUser.id }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => subscriptionsCreate(sql, req, receptionistUser)),
      (err: any) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, "FORBIDDEN");
        return true;
      }
    );
  });

  // 7. user_id là member (vẫn bán được -> creates subscription)
  it("creates subscription when user_id is member", async () => {
    const req = new Request("http://localhost/v1/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan_id: validPlanId, user_id: memberUser.id }),
    });
    const res = await withTx(async (sql) => subscriptionsCreate(sql, req, receptionistUser));
    assert.equal(res.status, 201);
  });

  // 8. nhân viên không gửi user_id (staff buying without user_id -> 403)
  it("rejects staff buying without user_id with 403", async () => {
    const req = new Request("http://localhost/v1/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan_id: validPlanId }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => subscriptionsCreate(sql, req, receptionistUser)),
      (err: any) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, "FORBIDDEN");
        return true;
      }
    );
  });
});

describe("authorization & role check order unit tests (Vòng 4: F-10, F-03, F-23)", () => {
  const coachUser = { id: "00000000-0000-0000-0000-000000000003", role: "coach" } as any;
  const otherCoachUser = { id: "00000000-0000-0000-0000-000000000006", role: "coach" } as any;
  const memberUser = { id: "00000000-0000-0000-0000-000000000004", role: "member" } as any;
  const otherMemberUser = { id: "00000000-0000-0000-0000-000000000007", role: "member" } as any;

  const courtId = "10000000-0000-0000-0000-000000000001";
  const testBookingId = "30000000-0000-0000-0000-000000000001";
  const testClassId = "40000000-0000-0000-0000-000000000001";
  const testEnrollmentId = "50000000-0000-0000-0000-000000000001";

  before(async () => {
    // Insert otherCoach and otherMember
    await db.query(`
      insert into users (id, full_name, name_normalized, phone, role, status, password_hash, pii_consent_at)
      values
        ($1, 'HLV Khac', 'hlv khac', '+84900000006', 'coach', 'active', 'hash', now()),
        ($2, 'Hoi Vien Khac', 'hoi vien khac', '+84900000007', 'member', 'active', 'hash', now())
      on conflict (id) do nothing
    `, [otherCoachUser.id, otherMemberUser.id]);

    // Insert test booking owned by memberUser
    await db.query(`
      insert into court_bookings (id, court_id, user_id, start_at, end_at, status, price_vnd, deposit_vnd, paid_vnd, code, channel)
      values ($1, $2, $3, now() + interval '1 day', now() + interval '1 day 1 hour', 'completed', 100000, 100000, 100000, 'BK-TEST-R4', 'online')
      on conflict (id) do nothing
    `, [testBookingId, courtId, memberUser.id]);

    // Insert class with coachUser and enrollment for otherMemberUser
    await db.query(`
      insert into classes (id, sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count)
      values ($1, 'badminton', 'beginner', $2, $3, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9', '2026-11-01', '2026-11-30', 60, 10, 'open', 1)
      on conflict (id) do nothing
    `, [testClassId, coachUser.id, courtId]);

    await db.query(`
      insert into enrollments (id, class_id, user_id, status)
      values ($1, $2, $3, 'confirmed')
      on conflict (id) do nothing
    `, [testEnrollmentId, testClassId, otherMemberUser.id]);
  });

  // 1. HLV gọi GET /bookings/:id của hội viên → 403
  it("rejects coach viewing member booking with 403 (F-03)", async () => {
    await assert.rejects(
      async () => withTx(async (sql) => bookingGet(sql, testBookingId, coachUser)),
      (err: any) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, "FORBIDDEN");
        return true;
      }
    );
  });

  // 2. Hội viên khác gọi GET /bookings/:id → 403
  it("rejects other member viewing member booking with 403 (F-03)", async () => {
    await assert.rejects(
      async () => withTx(async (sql) => bookingGet(sql, testBookingId, otherMemberUser)),
      (err: any) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, "FORBIDDEN");
        return true;
      }
    );
  });

  // 3. Chủ booking gọi GET /bookings/:id → 200
  it("allows owner viewing member booking with 200", async () => {
    const res = await withTx(async (sql) => bookingGet(sql, testBookingId, memberUser));
    assert.equal(res.status, 200);
    assert.equal((res.body as any).id, testBookingId);
  });

  // 4. HLV khác lớp xoá ghi danh → 403
  it("rejects cross-sport coach deleting enrollment with 403 (F-23)", async () => {
    await assert.rejects(
      async () => withTx(async (sql) => enrollmentDelete(sql, testEnrollmentId, otherCoachUser)),
      (err: any) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, "FORBIDDEN");
        return true;
      }
    );
  });

  // 5. HLV đúng lớp xoá ghi danh → thành công (không ném 403)
  it("allows assigned coach deleting enrollment in their class (F-23)", async () => {
    const res = await withTx(async (sql) => enrollmentDelete(sql, testEnrollmentId, coachUser));
    assert.equal(res.status, 200);
    assert.equal((res.body as any).ok, true);
  });

  // 6. HLV dời lịch booking của hội viên → 403 (Section 7.3)
  it("rejects coach rescheduling member booking with 403 before body/query (Section 7.3)", async () => {
    const req = new Request("http://localhost/v1/bookings/" + testBookingId + "/reschedule", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    await assert.rejects(
      async () => withTx(async (sql) => bookingsReschedule(sql, testBookingId, req, coachUser)),
      (err: any) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, "FORBIDDEN");
        return true;
      }
    );
  });

  // 7. Chủ booking dời lịch booking → không phải 403 (Section 7.3)
  it("does not reject owner with 403 when rescheduling (Section 7.3)", async () => {
    const req = new Request("http://localhost/v1/bookings/" + testBookingId + "/reschedule", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ start_at: "2026-11-05T09:00:00.000Z" }),
    });
    try {
      await withTx(async (sql) => bookingsReschedule(sql, testBookingId, req, memberUser));
    } catch (err: any) {
      assert.notEqual(err.status, 403);
    }
  });
});

describe("Section 8: Drop day_passes table & center_settings.day_pass_vnd column", () => {
  // 1. select to_regclass('day_passes') ra null
  it("confirms day_passes table is dropped (to_regclass returns null)", async () => {
    const res = await db.query<{ tbl: string | null }>("select to_regclass('day_passes') as tbl");
    assert.equal(res.rows[0].tbl, null);
  });

  // 2. information_schema.columns không có center_settings.day_pass_vnd
  it("confirms center_settings.day_pass_vnd column is dropped", async () => {
    const res = await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'center_settings' and column_name = 'day_pass_vnd'"
    );
    assert.equal(res.rows.length, 0);
  });

  // 3. insert payment ref_type='day_pass', method='cash', status='posted' vào một ca thì tổng ca tăng đúng số tiền (lịch sử vẫn được tính)
  it("counts historical day_pass cash payment in real shift till totals via shiftCurrent", async () => {
    const receptionistUser = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist" } as any;
    const shift = (await db.query<{ id: string }>(
      "insert into cashier_shifts (receptionist_id) values ($1) returning id",
      [receptionistUser.id]
    )).rows[0];
    await db.query(
      `insert into payments (code, shift_id, method, amount_vnd, vat_rate, status, ref_type, ref_id)
       values ('PAY-HIST-DP', $1, 'cash', 50000, 8, 'posted', 'day_pass', gen_random_uuid())`,
      [shift.id]
    );
    const req = new Request("http://localhost/v1/shifts/current");
    const res = await withTx(async (sql) => shiftCurrent(sql, receptionistUser, req));
    assert.equal(res.status, 200);
    assert.equal((res.body as any).totals.cash, 50000);
    // Clean up test shift
    await db.query("update cashier_shifts set closed_at = now() where id = $1", [shift.id]);
  });
});

describe("Round 5: Money & Cashier Shift unit tests (F-17, F-12, F-13, F-09)", () => {
  const receptionistUser = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist", full_name: "Lễ tân test" } as any;
  const managerUser = { id: "00000000-0000-0000-0000-000000000001", role: "manager", full_name: "Quản lý test" } as any;
  const validCourtId = "10000000-0000-0000-0000-000000000001";
  const nonexistentId = "99999999-9999-4999-8999-999999999999";
  const testBookingId = "30000000-0000-0000-0000-000000000001";

  // F-17: cash_declared_vnd parseInteger min 0
  it("rejects negative cash_declared_vnd with 400 (F-17)", async () => {
    const shift = (await db.query<{ id: string }>(
      "insert into cashier_shifts (receptionist_id) values ($1) returning id",
      [receptionistUser.id]
    )).rows[0];
    const req = new Request("http://localhost/v1/shifts/" + shift.id + "/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cash_declared_vnd: -1 }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => shiftClose(sql, shift.id, req, receptionistUser)),
      (err: any) => {
        assert.equal(err.status, 400);
        assert.equal(err.extra?.field, "cash_declared_vnd");
        return true;
      }
    );
    // 0 is accepted
    const reqZero = new Request("http://localhost/v1/shifts/" + shift.id + "/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cash_declared_vnd: 0 }),
    });
    const res = await withTx(async (sql) => shiftClose(sql, shift.id, reqZero, receptionistUser));
    assert.equal(res.status, 200);
    assert.equal((res.body as any).cash_declared_vnd, 0);
  });

  // F-12: method quota rejected in paymentsCreate
  it("rejects payment method quota with 400 (F-12)", async () => {
    const shift = (await db.query<{ id: string }>(
      "insert into cashier_shifts (receptionist_id) values ($1) returning id",
      [receptionistUser.id]
    )).rows[0];
    const reqQuota = new Request("http://localhost/v1/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref_type: "booking",
        ref_id: testBookingId,
        method: "quota",
        amount_vnd: 50000,
      }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => paymentsCreate(sql, reqQuota, receptionistUser)),
      (err: any) => {
        assert.equal(err.status, 400);
        assert.equal(err.extra?.field, "method");
        return true;
      }
    );
    // cash is accepted
    const reqCash = new Request("http://localhost/v1/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref_type: "booking",
        ref_id: testBookingId,
        method: "cash",
        amount_vnd: 50000,
      }),
    });
    const resCash = await withTx(async (sql) => paymentsCreate(sql, reqCash, receptionistUser));
    assert.equal(resCash.status, 201);
    assert.equal((resCash.body as any).payment?.method, "cash");
    await db.query("update cashier_shifts set closed_at = now() where id = $1", [shift.id]);
  });

  // F-13: shift_id validation
  it("validates shift_id in paymentsCreate: 404 for nonexistent, 403 for other shift (F-13)", async () => {
    const myShift = (await db.query<{ id: string }>(
      "insert into cashier_shifts (receptionist_id) values ($1) returning id",
      [receptionistUser.id]
    )).rows[0];
    const otherShift = (await db.query<{ id: string }>(
      "insert into cashier_shifts (receptionist_id) values ($1) returning id",
      [managerUser.id]
    )).rows[0];

    // Nonexistent shift_id -> 404
    const req404 = new Request("http://localhost/v1/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref_type: "booking",
        ref_id: testBookingId,
        method: "cash",
        amount_vnd: 50000,
        shift_id: nonexistentId,
      }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => paymentsCreate(sql, req404, receptionistUser)),
      (err: any) => {
        assert.equal(err.status, 404);
        return true;
      }
    );

    // Other shift_id -> 403
    const req403 = new Request("http://localhost/v1/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref_type: "booking",
        ref_id: testBookingId,
        method: "cash",
        amount_vnd: 50000,
        shift_id: otherShift.id,
      }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => paymentsCreate(sql, req403, receptionistUser)),
      (err: any) => {
        assert.equal(err.status, 403);
        return true;
      }
    );

    // Own open shift -> 201
    const reqOwn = new Request("http://localhost/v1/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref_type: "booking",
        ref_id: testBookingId,
        method: "cash",
        amount_vnd: 50000,
        shift_id: myShift.id,
      }),
    });
    const resOwn = await withTx(async (sql) => paymentsCreate(sql, reqOwn, receptionistUser));
    assert.equal(resOwn.status, 201);
    assert.equal((resOwn.body as any).payment?.shift_id, myShift.id);

    await db.query("update cashier_shifts set closed_at = now() where id in ($1, $2)", [myShift.id, otherShift.id]);
  });

  // F-09: walkIn phone validation & slot clash
  it("validates phone and rejects conflicting slot with 409 in walkIn (F-09)", async () => {
    const shift = (await db.query<{ id: string }>(
      "insert into cashier_shifts (receptionist_id) values ($1) returning id",
      [receptionistUser.id]
    )).rows[0];

    // SĐT rác -> validation error
    const reqBadPhone = new Request("http://localhost/v1/walk-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        court_id: validCourtId,
        start_at: "2026-11-20T09:00:00.000Z",
        guest_name: "Walkin Guest",
        guest_phone: "12345",
        method: "cash",
      }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => walkIn(sql, reqBadPhone, receptionistUser)),
      (err: any) => {
        assert.equal(err.status, 422);
        assert.equal(err.extra?.field, "phone");
        return true;
      }
    );

    // Slot đã hold -> 409 CONFLICT_SLOT
    await db.query(`
      insert into occupancies (id, court_id, start_at, end_at, kind, ref_id)
      values (gen_random_uuid(), $1, '2026-11-20 09:00:00+00', '2026-11-20 10:00:00+00', 'hold', gen_random_uuid())
    `, [validCourtId]);

    const reqClash = new Request("http://localhost/v1/walk-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        court_id: validCourtId,
        start_at: "2026-11-20T09:00:00.000Z",
        guest_name: "Walkin Clash",
        guest_phone: "0912345678",
        method: "cash",
      }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => walkIn(sql, reqClash, receptionistUser)),
      (err: any) => {
        assert.equal(err.status, 409);
        assert.equal(err.code, "CONFLICT_SLOT");
        return true;
      }
    );

    await db.query("update cashier_shifts set closed_at = now() where id = $1", [shift.id]);
  });

  // F-09: walkIn preserves member's app hold on another day
  it("preserves member's app hold on another day when receptionist creates a walk-in for that member (F-09)", async () => {
    await db.query("update cashier_shifts set closed_at = now() where receptionist_id = $1 and closed_at is null", [receptionistUser.id]);
    const shift = (await db.query<{ id: string }>(
      "insert into cashier_shifts (receptionist_id) values ($1) returning id",
      [receptionistUser.id]
    )).rows[0];

    const memberUser = { id: "00000000-0000-0000-0000-000000000004", role: "member" } as any;
    const memberHoldId = "30000000-0000-0000-0000-000000000002";
    // Member has an app hold on 2026-11-25
    const occId = (await db.query<{ id: string }>(`
      insert into occupancies (id, court_id, start_at, end_at, kind, ref_id)
      values (gen_random_uuid(), $1, '2026-11-25 09:00:00+00', '2026-11-25 10:00:00+00', 'hold', $2)
      returning id
    `, [validCourtId, memberHoldId])).rows[0].id;
    await db.query(`
      insert into court_bookings (id, court_id, user_id, start_at, end_at, status, price_vnd, deposit_vnd, paid_vnd, code, channel, occupancy_id)
      values ($1, $2, $3, '2026-11-25 09:00:00+00', '2026-11-25 10:00:00+00', 'hold', 100000, 0, 0, 'BK-HOLD-MEM', 'online', $4)
      on conflict (id) do nothing
    `, [memberHoldId, validCourtId, memberUser.id, occId]);

    // Receptionist creates walk-in for the same member on 2026-11-26
    const reqWalkIn = new Request("http://localhost/v1/walk-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        court_id: validCourtId,
        start_at: "2026-11-26T09:00:00.000Z",
        guest_name: "Member Walkin",
        guest_phone: "+84900000004",
        method: "cash",
      }),
    });
    const resWalkIn = await withTx(async (sql) => walkIn(sql, reqWalkIn, receptionistUser));
    assert.equal(resWalkIn.status, 201);

    // Member's original hold is STILL in status 'hold'
    const origHold = (await db.query<{ status: string }>(
      "select status from court_bookings where id = $1",
      [memberHoldId]
    )).rows[0];
    assert.equal(origHold.status, "hold");

    await db.query("update cashier_shifts set closed_at = now() where id = $1", [shift.id]);
  });

  // F-16 (1): Lễ tân thu 100.000 đ mặt, hoàn 40.000 đ mặt → shiftCurrent tiền mặt = 60.000 đ
  it("F-16: receptionist refunds 40,000 cash from 100,000 intake -> shift till cash is 60,000", async () => {
    await db.query("update cashier_shifts set closed_at = now() where receptionist_id = $1 and closed_at is null", [receptionistUser.id]);
    const shift = (await db.query<{ id: string }>(
      "insert into cashier_shifts (receptionist_id) values ($1) returning id",
      [receptionistUser.id]
    )).rows[0];

    // Seed positive payment of 100,000 cash in this shift
    const pay = (await db.query<{ id: string }>(`
      insert into payments (code, shift_id, method, amount_vnd, vat_rate, status, ref_type, ref_id)
      values ('PAY-RF-100K', $1, 'cash', 100000, 8, 'posted', 'booking', $2)
      returning id
    `, [shift.id, testBookingId])).rows[0];

    // Direct refund 40,000 cash by receptionist
    const reqRefund = new Request("http://localhost/v1/payments/" + pay.id + "/refund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount_vnd: 40000, reason: "Hỏng vợt" }),
    });
    const resRefund = await withTx(async (sql) => paymentsRefund(sql, pay.id, reqRefund, receptionistUser));
    assert.equal(resRefund.status, 201);
    assert.equal((resRefund.body as any).payment?.shift_id, shift.id);
    assert.equal((resRefund.body as any).payment?.amount_vnd, -40000);

    // Verify shift totals: 100k - 40k = 60k
    const reqCurrent = new Request("http://localhost/v1/shifts/current");
    const cur = await withTx(async (sql) => shiftCurrent(sql, receptionistUser, reqCurrent));
    assert.equal(cur.status, 200);
    assert.equal((cur.body as any).totals?.cash, 60000);

    await db.query("update cashier_shifts set closed_at = now() where id = $1", [shift.id]);
  });

  // F-16 (2): Quản lý duyệt hoàn tiền (approve-refund) → tổng ca lễ tân không đổi
  it("F-16: manager approves refund (approve-refund) -> receptionist shift till totals unchanged", async () => {
    await db.query("update cashier_shifts set closed_at = now() where receptionist_id = $1 and closed_at is null", [receptionistUser.id]);
    const shift = (await db.query<{ id: string }>(
      "insert into cashier_shifts (receptionist_id) values ($1) returning id",
      [receptionistUser.id]
    )).rows[0];

    // Seed large payment of 1,500,000
    const pay = (await db.query<{ id: string }>(`
      insert into payments (code, shift_id, method, amount_vnd, vat_rate, status, ref_type, ref_id)
      values ('PAY-RF-BIG', $1, 'cash', 1500000, 8, 'posted', 'booking', $2)
      returning id
    `, [shift.id, testBookingId])).rows[0];

    const reqCurrentBefore = new Request("http://localhost/v1/shifts/current");
    const curBefore = await withTx(async (sql) => shiftCurrent(sql, receptionistUser, reqCurrentBefore));
    const cashBefore = (curBefore.body as any).totals?.cash;

    // Receptionist requests 1,200,000 refund -> refund_pending
    const reqPending = new Request("http://localhost/v1/payments/" + pay.id + "/refund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount_vnd: 1200000, reason: "Chuyển nhà" }),
    });
    const resPending = await withTx(async (sql) => paymentsRefund(sql, pay.id, reqPending, receptionistUser));
    assert.equal(resPending.status, 201);
    assert.equal((resPending.body as any).payment?.status, "refund_pending");
    assert.equal((resPending.body as any).payment?.shift_id, null);
    const pendingId = (resPending.body as any).payment.id;

    // Manager approves refund
    const reqApprove = new Request("http://localhost/v1/payments/" + pendingId + "/approve-refund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Duyệt hoàn tiền" }),
    });
    const resApprove = await withTx(async (sql) => paymentsApproveRefund(sql, pendingId, reqApprove, managerUser));
    assert.equal(resApprove.status, 200);

    // Shift totals for receptionist MUST be unchanged (the approved refund has shift_id = null)
    const curAfter = await withTx(async (sql) => shiftCurrent(sql, receptionistUser, reqCurrentBefore));
    assert.equal((curAfter.body as any).totals?.cash, cashBefore);

    await db.query("update cashier_shifts set closed_at = now() where id = $1", [shift.id]);
  });

  // F-16 (3): Lễ tân không có ca mà hoàn mặt → lỗi BR (BR-44)
  it("F-16: receptionist without open shift attempting cash refund throws BR-44", async () => {
    // Ensure no open shift for receptionist
    await db.query("update cashier_shifts set closed_at = now() where receptionist_id = $1 and closed_at is null", [receptionistUser.id]);

    const pay = (await db.query<{ id: string }>(`
      insert into payments (code, method, amount_vnd, vat_rate, status, ref_type, ref_id)
      values ('PAY-RF-NOCASHIER', 'cash', 50000, 8, 'posted', 'booking', $1)
      returning id
    `, [testBookingId])).rows[0];

    const reqRefund = new Request("http://localhost/v1/payments/" + pay.id + "/refund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount_vnd: 20000 }),
    });

    await assert.rejects(
      async () => withTx(async (sql) => paymentsRefund(sql, pay.id, reqRefund, receptionistUser)),
      (err: any) => {
        assert.equal(err.code, "BR_VIOLATION");
        assert.equal(err.extra?.br, "BR-44");
        return true;
      }
    );
  });
});

describe("Section 10.0: Patch Round 5 omissions", () => {
  const receptionistUser = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist", full_name: "Lễ tân test" } as any;
  const managerUser = { id: "00000000-0000-0000-0000-000000000001", role: "manager", full_name: "Quản lý test" } as any;
  const validCourtId = "10000000-0000-0000-0000-000000000001";
  const testBookingId = "30000000-0000-0000-0000-000000000001";

  it("manager walk-in with invented shift_id -> 201, payment shift_id is NULL", async () => {
    const req = new Request("http://localhost/v1/walk-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        court_id: validCourtId,
        start_at: "2026-11-28T09:00:00.000Z",
        guest_name: "Mgr Walkin",
        guest_phone: "0912345678",
        method: "cash",
        shift_id: "99999999-9999-4999-8999-999999999999",
      }),
    });
    const res = await withTx(async (sql) => walkIn(sql, req, managerUser));
    assert.equal(res.status, 201);
    assert.equal((res.body as any).payment?.shift_id, null);
  });

  it("manager walk-in with open receptionist shift_id -> 201, receptionist till cash unchanged", async () => {
    await db.query("update cashier_shifts set closed_at = now() where receptionist_id = $1 and closed_at is null", [receptionistUser.id]);
    const shift = (await db.query<{ id: string }>(
      "insert into cashier_shifts (receptionist_id) values ($1) returning id",
      [receptionistUser.id]
    )).rows[0];

    const reqBefore = new Request("http://localhost/v1/shifts/current");
    const curBefore = await withTx(async (sql) => shiftCurrent(sql, receptionistUser, reqBefore));
    const cashBefore = (curBefore.body as any).totals?.cash;

    const req = new Request("http://localhost/v1/walk-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        court_id: validCourtId,
        start_at: "2026-11-29T09:00:00.000Z",
        guest_name: "Mgr Walkin 2",
        guest_phone: "0912345678",
        method: "cash",
        shift_id: shift.id,
      }),
    });
    const res = await withTx(async (sql) => walkIn(sql, req, managerUser));
    assert.equal(res.status, 201);
    assert.equal((res.body as any).payment?.shift_id, null);

    const curAfter = await withTx(async (sql) => shiftCurrent(sql, receptionistUser, reqBefore));
    assert.equal((curAfter.body as any).totals?.cash, cashBefore);

    await db.query("update cashier_shifts set closed_at = now() where id = $1", [shift.id]);
  });

  it("paymentsCreate: non-UUID shift_id -> 404, non-UUID ref_id -> 404", async () => {
    // 1. shift_id = "abc" -> 404
    const reqBadShift = new Request("http://localhost/v1/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref_type: "booking",
        ref_id: testBookingId,
        method: "cash",
        amount_vnd: 50000,
        shift_id: "abc",
      }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => paymentsCreate(sql, reqBadShift, receptionistUser)),
      (err: any) => {
        assert.equal(err.status, 404);
        return true;
      }
    );

    // 2. ref_id = "abc" with ref_type = "booking" -> 404
    const reqBadRef = new Request("http://localhost/v1/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref_type: "booking",
        ref_id: "abc",
        method: "cash",
        amount_vnd: 50000,
      }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => paymentsCreate(sql, reqBadRef, managerUser)),
      (err: any) => {
        assert.equal(err.status, 404);
        return true;
      }
    );
  });
});

describe("Round 6: F-06, F-07, F-26, F-04 unit tests", () => {
  const memberF06 = { id: "00000000-0000-0000-0000-000000000201", role: "member", full_name: "Member F06" } as any;
  const memberF07A = { id: "00000000-0000-0000-0000-000000000202", role: "member", full_name: "Member F07A" } as any;
  const memberF07B = { id: "00000000-0000-0000-0000-000000000203", role: "member", full_name: "Member F07B" } as any;
  const receptionistUser = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist", full_name: "Lễ tân" } as any;
  const _managerUser = { id: "00000000-0000-0000-0000-000000000001", role: "manager", full_name: "Quản lý" } as any;
  const validCourtId = "10000000-0000-0000-0000-000000000001";
  const validCourtId2 = "10000000-0000-0000-0000-000000000002";
  const testDate = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

  before(async () => {
    for (const m of [memberF06, memberF07A, memberF07B]) {
      const phone = "+8490" + m.id.replace(/-/g, "").slice(-7);
      await db.query(
        `insert into users (id, phone, full_name, name_normalized, role, password_hash)
         values ($1, $2, $3, $4, 'member', 'hash')
         on conflict (id) do nothing`,
        [m.id, phone, m.full_name, m.full_name.toLowerCase()]
      );
    }
    await db.query(`update court_bookings set occupancy_id = null, status = 'cancelled' where court_id in ($1, $2) and (start_at at time zone 'Asia/Ho_Chi_Minh')::date = $3::date`, [validCourtId, validCourtId2, testDate]);
    await db.query(`update sessions set occupancy_id = null, status = 'cancelled' where court_id in ($1, $2) and (start_at at time zone 'Asia/Ho_Chi_Minh')::date = $3::date`, [validCourtId, validCourtId2, testDate]);
    await db.query(`delete from occupancies where court_id in ($1, $2) and (start_at at time zone 'Asia/Ho_Chi_Minh')::date = $3::date`, [validCourtId, validCourtId2, testDate]);
  });

  // F-06: 10:17 -> 4xx; 21:30 (ends 22:30) -> 4xx; 21:00 -> 201; walk-in 10:17 -> 4xx
  it("F-06: rejects off-grid 10:17 and after-closing 21:30, allows 21:00, rejects walk-in 10:17", async () => {
    // 1. 10:17 -> 4xx
    const req1017 = new Request("http://localhost/v1/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ court_id: validCourtId, start_at: `${testDate}T10:17:00.000+07:00` }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => bookingsHold(sql, req1017, memberF06)),
      (err: any) => {
        assert.ok(err.status >= 400 && err.status < 500);
        return true;
      }
    );

    // 2. 21:30 (ends 22:30, after close 22:00) -> 4xx
    const req2130 = new Request("http://localhost/v1/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ court_id: validCourtId, start_at: `${testDate}T21:30:00.000+07:00` }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => bookingsHold(sql, req2130, memberF06)),
      (err: any) => {
        assert.ok(err.status >= 400 && err.status < 500);
        return true;
      }
    );

    // 3. 21:00 -> 201 (on court 2 to avoid occupancy conflict)
    const req2100 = new Request("http://localhost/v1/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ court_id: validCourtId2, start_at: `${testDate}T21:00:00.000+07:00` }),
    });
    const res2100 = await withTx(async (sql) => bookingsHold(sql, req2100, memberF06));
    assert.equal(res2100.status, 201);

    // 4. walk-in 10:17 -> 4xx
    const reqWi1017 = new Request("http://localhost/v1/walk-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        court_id: validCourtId,
        start_at: `${testDate}T10:17:00.000+07:00`,
        guest_name: "Walkin Grid",
        guest_phone: "0912345678",
        method: "cash",
      }),
    });
    await assert.rejects(
      async () => withTx(async (sql) => walkIn(sql, reqWi1017, receptionistUser)),
      (err: any) => {
        assert.ok(err.status >= 400 && err.status < 500);
        return true;
      }
    );
  });

  // F-07: Member A & B using same key -> 2 different bookings; A resends key -> same booking id, count unchanged
  it("F-07: Idempotency-Key scoped per user and replaying returns same booking id", async () => {
    const key = "f07-test-key-" + Date.now();
    const reqA = new Request("http://localhost/v1/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ court_id: validCourtId, start_at: `${testDate}T08:00:00.000+07:00` }),
    });
    const resA1 = await withTx(async (sql) =>
      withIdempotency(sql, reqA, memberF07A.id, true, () => bookingsHold(sql, reqA, memberF07A))
    );
    assert.equal(resA1.status, 201);
    const bookingIdA = (resA1.body as any).booking?.id;
    assert.ok(bookingIdA);

    // Member B using the same key -> gets their own booking (not A's, different booking id)
    const reqB = new Request("http://localhost/v1/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ court_id: validCourtId2, start_at: `${testDate}T08:00:00.000+07:00` }),
    });
    const resB = await withTx(async (sql) =>
      withIdempotency(sql, reqB, memberF07B.id, true, () => bookingsHold(sql, reqB, memberF07B))
    );
    assert.equal(resB.status, 201);
    const bookingIdB = (resB.body as any).booking?.id;
    assert.ok(bookingIdB);
    assert.notEqual(bookingIdA, bookingIdB);

    // Member A resends with same key -> same booking id
    const countBefore = (await db.query<{ n: number }>("select count(*)::int as n from court_bookings where user_id = $1", [memberF07A.id])).rows[0].n;
    const reqA2 = new Request("http://localhost/v1/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ court_id: validCourtId, start_at: `${testDate}T08:00:00.000+07:00` }),
    });
    const resA2 = await withTx(async (sql) =>
      withIdempotency(sql, reqA2, memberF07A.id, true, () => bookingsHold(sql, reqA2, memberF07A))
    );
    assert.equal(resA2.status, 201);
    assert.equal((resA2.body as any).booking?.id, bookingIdA);
    const countAfter = (await db.query<{ n: number }>("select count(*)::int as n from court_bookings where user_id = $1", [memberF07A.id])).rows[0].n;
    assert.equal(countBefore, countAfter);
  });

  // F-26: Waitlist queue jumping
  it("F-26: pending offer reserves seat against newcomer; offer accepted -> 200; offer expired -> newcomer can take seat", async () => {
    const coachId = "00000000-0000-0000-0000-000000000011";
    const classId = "40000000-0000-0000-0000-000000000001";
    await db.query("delete from enrollments where class_id = $1", [classId]);
    await db.query("delete from classes where id = $1", [classId]);
    await db.query(
      `insert into classes (id, sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count)
       values ($1, 'badminton', 'f26-test', $2, $3, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10', current_date + 1, current_date + 14, 60, 1, 'open', 0)`,
      [classId, coachId, validCourtId]
    );

    // Give members active subscriptions
    const planId = "20000000-0000-0000-0000-000000000002";
    const mem1 = { id: "00000000-0000-0000-0000-000000000104", phone: "+84900000104", name: "Mem 1", role: "member" } as any;
    const mem2 = { id: "00000000-0000-0000-0000-000000000105", phone: "+84900000105", name: "Mem 2", role: "member" } as any;
    const mem3 = { id: "00000000-0000-0000-0000-000000000106", phone: "+84900000106", name: "Mem 3", role: "member" } as any;
    const mem4 = { id: "00000000-0000-0000-0000-000000000107", phone: "+84900000107", name: "Mem 4", role: "member" } as any;

    for (const m of [mem1, mem2, mem3, mem4]) {
      await db.query(
        `insert into users (id, phone, full_name, name_normalized, role, password_hash)
         values ($1, $2, $3, $4, 'member', 'hash')
         on conflict (id) do nothing`,
        [m.id, m.phone, m.name, m.name.toLowerCase()]
      );
      await db.query("delete from subscriptions where user_id = $1", [m.id]);
      await db.query(
        `insert into subscriptions (id, user_id, plan_id, sport_scope, start_on, end_on, status, session_left)
         values (gen_random_uuid(), $1, $2, 'badminton', current_date - 1, current_date + 30, 'active', 10)`,
        [m.id, planId]
      );
    }

    // 1. mem1 enrolls -> confirmed (1/1)
    const enr1 = await withTx(async (sql) => classesEnroll(sql, classId, new Request("http://localhost"), mem1));
    assert.equal(enr1.status, 201);
    assert.equal((enr1.body as any).enrollment?.status, "confirmed");

    // 2. mem2 enrolls -> waitlisted
    const enr2 = await withTx(async (sql) => classesEnroll(sql, classId, new Request("http://localhost"), mem2));
    assert.equal(enr2.status, 201);
    assert.equal((enr2.body as any).enrollment?.status, "waitlisted");

    // 3. mem1 cancels -> triggers inviteWaitlist -> creates offer for mem2
    await withTx(async (sql) => enrollmentDelete(sql, (enr1.body as any).enrollment.id, mem1));
    await withTx(async (sql) => inviteWaitlist(sql, classId));

    const offer = (await db.query<{ id: string }>(
      "select o.id from waitlist_offers o join enrollments e on e.id = o.enrollment_id where e.class_id = $1 and o.status = 'pending'",
      [classId]
    )).rows[0];
    assert.ok(offer);

    // 4. mem3 (newcomer) attempts to enroll while offer is pending -> waitlisted (cannot jump queue)
    const enr3 = await withTx(async (sql) => classesEnroll(sql, classId, new Request("http://localhost"), mem3));
    assert.equal(enr3.status, 201);
    assert.equal((enr3.body as any).waitlisted, true);
    assert.equal((enr3.body as any).enrollment?.status, "waitlisted");

    // 5. mem2 accepts offer -> 200 confirmed
    const accRes = await withTx(async (sql) => waitlistAccept(sql, offer.id, mem2));
    assert.equal(accRes.status, 200);
    const mem2Enr = (await db.query<{ status: string }>("select status from enrollments where id = $1", [(enr2.body as any).enrollment.id])).rows[0];
    assert.equal(mem2Enr.status, "confirmed");

    // 6. Test offer expired -> newcomer can take seat
    // Cancel mem2, invite mem3, then expire mem3's offer
    await withTx(async (sql) => enrollmentDelete(sql, (enr2.body as any).enrollment.id, mem2));
    await withTx(async (sql) => inviteWaitlist(sql, classId));
    // Expire all pending offers
    await db.query("update waitlist_offers set expires_at = now() - interval '1 hour' where status = 'pending'");

    const enr4 = await withTx(async (sql) => classesEnroll(sql, classId, new Request("http://localhost"), mem4));
    assert.equal(enr4.status, 201);
    assert.equal((enr4.body as any).enrollment?.status, "confirmed");
  });

  // F-04: next_member_code past 0099
  it("F-04: seed A3-2026-0099 and A3-2026-0100 -> next code is A3-2026-0101, 150 consecutive calls without collision", async () => {
    const y = new Date().getFullYear();
    // Seed 0099 and 0100
    await db.query("insert into users (id, phone, full_name, name_normalized, role, member_code, password_hash) values (gen_random_uuid(), '0988000099', 'Seed 99', 'seed 99', 'member', $1, 'hash') on conflict do nothing", [`A3-${y}-0099`]);
    await db.query("insert into users (id, phone, full_name, name_normalized, role, member_code, password_hash) values (gen_random_uuid(), '0988000100', 'Seed 100', 'seed 100', 'member', $1, 'hash') on conflict do nothing", [`A3-${y}-0100`]);
    await db.query("insert into code_counters (kind, yyyy, n) values ('member', $1, 98) on conflict (kind, yyyy) do update set n = 98", [y]);

    const code1 = (await db.query<{ next_member_code: string }>("select next_member_code()")).rows[0].next_member_code;
    assert.equal(code1, `A3-${y}-0101`);

    // 150 consecutive calls
    const seen = new Set<string>();
    seen.add(code1);
    for (let i = 0; i < 150; i++) {
      const code = (await db.query<{ next_member_code: string }>("select next_member_code()")).rows[0].next_member_code;
      assert.ok(!seen.has(code), `Duplicate code: ${code}`);
      seen.add(code);
      assert.match(code, new RegExp(`^A3-${y}-\\d{4,}$`));
    }
  });
});

describe("Round 7: Group A unit tests (F-08, F-11)", () => {
  it("F-08: 'Abc@X.com' can log in to account registered with 'abc@x.com'", async () => {
    const phone = "0987000008";
    const email = "abc@x.com";
    await db.query(
      `insert into users (id, phone, full_name, name_normalized, email, role, status, password_hash)
       values (gen_random_uuid(), $1, 'Test F08', 'test f08', $2, 'member', 'active', $3)
       on conflict (phone) do update set email = $2`,
      [phone, email, hashPassword("Pass12345!")],
    );

    await withTx(async (sql) => {
      // 1. findUserByLogin with mixed case email
      const u = await findUserByLogin(sql, "Abc@X.com");
      assert.ok(u, "findUserByLogin should find user with mixed case email");
      assert.equal(u.email, "abc@x.com");

      // 2. login handler with mixed case email
      const req = new Request("http://localhost/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login: "Abc@X.com", password: "Pass12345!" }),
      });
      const res = await authH.login(sql, req);
      assert.equal(res.status, 200);
      assert.ok((res.body as any).token);
    });
  });

  it("F-11: 2 sessions -> change password in session 1 -> session 2 is revoked (401)", async () => {
    const phone = "0987000011";
    const pwHash = hashPassword("OldPass123!");
    const userId = (
      await db.query<{ id: string }>(
        `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
         values (gen_random_uuid(), $1, 'Test F11', 'test f11', 'member', 'active', $2)
         returning id`,
        [phone, pwHash],
      )
    ).rows[0].id;

    const userRow = (await db.query("select * from users where id = $1", [userId])).rows[0];
    const userPub = toPublic(userRow as any);

    let s1: any;
    let s2: any;
    await withTx(async (sql) => {
      s1 = await issueSession(sql, userPub);
      s2 = await issueSession(sql, userPub);
    });

    // Both sessions valid initially
    await withTx(async (sql) => {
      const u1 = await authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${s1.token}` } }));
      const u2 = await authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${s2.token}` } }));
      assert.equal(u1.id, userId);
      assert.equal(u2.id, userId);
    });

    // Session 1 changes password
    await withTx(async (sql) => {
      const changeReq = new Request("http://localhost/v1/me/password", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${s1.token}` },
        body: JSON.stringify({ current_password: "OldPass123!", new_password: "NewPass123!", confirm_password: "NewPass123!" }),
      });
      const res = await authH.mePassword(sql, changeReq, userPub);
      assert.equal(res.status, 200);
    });

    // Session 2 is revoked -> throws 401
    await withTx(async (sql) => {
      await assert.rejects(
        async () => {
          await authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${s2.token}` } }));
        },
        (err: any) => {
          assert.equal(err.status, 401);
          return true;
        },
      );

      // Session 1 is also revoked on subsequent /me calls
      await assert.rejects(
        async () => {
          await authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${s1.token}` } }));
        },
        (err: any) => {
          assert.equal(err.status, 401);
          return true;
        },
      );
    });
  });
});

describe("Round 7: Group B unit tests (F-15, F-20, F-19)", () => {
  it("F-15: csvCell neutralises formula injection and preserves normal strings/numbers", () => {
    // Starts with =, +, -, @, \t, \r -> prefixed with '
    assert.equal(csvCell("=1+1"), "'=1+1");
    assert.equal(csvCell("+84971234567"), "'+84971234567");
    assert.equal(csvCell("@cmd"), "'@cmd");
    assert.equal(csvCell("\tindented"), "'\tindented");

    // Negative case: 'Nguyễn' does NOT get prefixed with '
    assert.equal(csvCell("Nguyễn Văn A"), "Nguyễn Văn A");

    // Negative case: purely numeric values (including negative money) are NOT prefixed with '
    assert.equal(csvCell(500000), "500000");
    assert.equal(csvCell(-20000), "-20000");
    assert.equal(csvCell("-50000"), "-50000");
  });

  it("F-19: unfreezing same day restores original end_on without bonus days", async () => {
    const mgr = toPublic((await db.query("select * from users where role = 'manager' limit 1")).rows[0] as any);
    const plan = (await db.query<{ id: string }>("select id from membership_plans limit 1")).rows[0];

    const testMemberF19 = { id: "00000000-0000-0000-0000-000000000219", role: "member", full_name: "Member F19" } as any;
    await db.query(
      `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
       values ($1, '0987000219', 'Member F19', 'member f19', 'member', 'active', 'hash')
       on conflict (id) do nothing`,
      [testMemberF19.id],
    );
    await db.query("delete from subscriptions where user_id = $1", [testMemberF19.id]);

    // Create an active subscription
    const subId = (
      await db.query<{ id: string }>(
        `insert into subscriptions (user_id, plan_id, sport_scope, start_on, end_on, status, court_hours_left, session_left)
         values ($1, $2, 'badminton', '2026-11-01', '2026-11-30', 'active', 10, 10)
         returning id`,
        [testMemberF19.id, plan.id],
      )
    ).rows[0].id;

    // Freeze for 10 days
    await withTx(async (sql) => {
      const req = new Request(`http://localhost/v1/subscriptions/${subId}/freeze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ days: 10 }),
      });
      const res = await subscriptionFreeze(sql, subId, req, mgr);
      assert.equal(res.status, 200);
      assert.equal((res.body as any).end_on.slice(0, 10), "2026-12-10");
    });

    // Unfreeze on the same day -> end_on must revert back to 2026-11-30
    await withTx(async (sql) => {
      const res = await subscriptionUnfreeze(sql, subId, mgr);
      assert.equal(res.status, 200);
      assert.equal((res.body as any).status, "active");
      assert.equal((res.body as any).end_on.slice(0, 10), "2026-11-30");
    });

    // Negative case: unfreezing an active plan throws conflict 409
    await withTx(async (sql) => {
      await assert.rejects(
        async () => {
          await subscriptionUnfreeze(sql, subId, mgr);
        },
        (err: any) => {
          assert.equal(err.status, 409);
          return true;
        },
      );
    });
  });

  it("F-20 (NEEDS-HUMAN): payment of incorrect amount (400,000 instead of expected) is rejected", async () => {
    const mgr = toPublic((await db.query("select * from users where role = 'manager' limit 1")).rows[0] as any);
    const plan = (await db.query<{ id: string; price_vnd: number }>("select id, price_vnd from membership_plans limit 1")).rows[0];

    const testMemberF20 = { id: "00000000-0000-0000-0000-000000000220", role: "member", full_name: "Member F20" } as any;
    await db.query(
      `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
       values ($1, '0987000220', 'Member F20', 'member f20', 'member', 'active', 'hash')
       on conflict (id) do nothing`,
      [testMemberF20.id],
    );
    await db.query("delete from subscriptions where user_id = $1", [testMemberF20.id]);

    // Create a pending subscription
    const subId = (
      await db.query<{ id: string }>(
        `insert into subscriptions (user_id, plan_id, sport_scope, start_on, end_on, status, court_hours_left, session_left)
         values ($1, $2, 'badminton', '2026-11-01', '2026-11-30', 'pending', 10, 10)
         returning id`,
        [testMemberF20.id, plan.id],
      )
    ).rows[0].id;

    // Negative test: paying incorrect amount throws validation error
    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/payments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref_type: "subscription", ref_id: subId, method: "cash", amount_vnd: plan.price_vnd - 10000 }),
      });
      await assert.rejects(
        async () => {
          await paymentsCreate(sql, req, mgr);
        },
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "amount_vnd");
          return true;
        },
      );
    });
  });
});

describe("Round 7: Group C unit tests (CL-21, CL-22, CL-23, CL-24, SS-18, SS-20, AT-12, TR-47)", () => {
  const managerUser = { id: "00000000-0000-0000-0000-000000000001", role: "manager", full_name: "Quản lý" } as any;
  const coachUser = { id: "00000000-0000-0000-0000-000000000011", role: "coach", full_name: "HLV" } as any;
  const badmintonCourtId = "10000000-0000-0000-0000-000000000001";

  // CL-21: capacity > 200 rejected, <= 200 accepted
  it("CL-21: rejects capacity > 200 with 400, accepts capacity <= 200 with 201", async () => {
    await withTx(async (sql) => {
      // Negative
      const reqBad = new Request("http://localhost/v1/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sport: "badminton",
          level: "cl21-test",
          coach_id: coachUser.id,
          court_id: badmintonCourtId,
          rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=10",
          start_on: "2026-11-01",
          end_on: "2026-11-30",
          capacity: 1000,
        }),
      });
      await assert.rejects(
        async () => classesCreate(sql, reqBad, managerUser),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "capacity");
          return true;
        },
      );

      // Positive
      const reqGood = new Request("http://localhost/v1/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sport: "badminton",
          level: "cl21-test-ok",
          coach_id: coachUser.id,
          court_id: badmintonCourtId,
          rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=10",
          start_on: "2026-11-01",
          end_on: "2026-11-30",
          capacity: 200,
        }),
      });
      const res = await classesCreate(sql, reqGood, managerUser);
      assert.equal(res.status, 201);
      assert.equal((res.body as any).capacity, 200);
    });
  });

  // CL-22: BYHOUR=25 rejected with 400, BYHOUR=10 accepted with 201
  it("CL-22: rejects invalid BYHOUR with 400, accepts valid BYHOUR with 201", async () => {
    await withTx(async (sql) => {
      // Negative: BYHOUR=25
      const reqBad = new Request("http://localhost/v1/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sport: "badminton",
          level: "cl22-test",
          coach_id: coachUser.id,
          court_id: badmintonCourtId,
          rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=25",
          start_on: "2026-11-01",
          end_on: "2026-11-30",
          capacity: 20,
        }),
      });
      await assert.rejects(
        async () => classesCreate(sql, reqBad, managerUser),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "rrule");
          return true;
        },
      );

      // Positive: BYHOUR=10
      const reqGood = new Request("http://localhost/v1/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sport: "badminton",
          level: "cl22-test-ok",
          coach_id: coachUser.id,
          court_id: badmintonCourtId,
          rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=11",
          start_on: "2026-11-01",
          end_on: "2026-11-30",
          capacity: 20,
        }),
      });
      const res = await classesCreate(sql, reqGood, managerUser);
      assert.equal(res.status, 201);
    });
  });

  // CL-23: start_on > end_on rejected with 400, start_on <= end_on accepted with 201
  it("CL-23: rejects start_on > end_on with 400, accepts start_on <= end_on with 201", async () => {
    await withTx(async (sql) => {
      // Negative
      const reqBad = new Request("http://localhost/v1/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sport: "badminton",
          level: "cl23-test",
          coach_id: coachUser.id,
          court_id: badmintonCourtId,
          rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=10",
          start_on: "2026-11-30",
          end_on: "2026-11-01",
          capacity: 20,
        }),
      });
      await assert.rejects(
        async () => classesCreate(sql, reqBad, managerUser),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "end_on");
          return true;
        },
      );

      // Positive
      const reqGood = new Request("http://localhost/v1/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sport: "badminton",
          level: "cl23-test-ok",
          coach_id: coachUser.id,
          court_id: badmintonCourtId,
          rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=12",
          start_on: "2026-11-01",
          end_on: "2026-11-30",
          capacity: 20,
        }),
      });
      const res = await classesCreate(sql, reqGood, managerUser);
      assert.equal(res.status, 201);
    });
  });

  // CL-24: court sport mismatch rejected with 400, matching court accepted with 201
  it("CL-24: rejects court sport mismatch with 400, accepts matching court with 201", async () => {
    // Find or insert a basketball court
    let basketballCourt = (await db.query<{ id: string }>("select id from courts where sport = 'basketball' limit 1")).rows[0];
    if (!basketballCourt) {
      basketballCourt = (await db.query<{ id: string }>(
        `insert into courts (court_code, sport, is_active) values ('BB-TEST', 'basketball', true) returning id`
      )).rows[0];
    }

    await withTx(async (sql) => {
      // Negative: badminton class on basketball court
      const reqBad = new Request("http://localhost/v1/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sport: "badminton",
          level: "cl24-test",
          coach_id: coachUser.id,
          court_id: basketballCourt.id,
          rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=10",
          start_on: "2026-11-01",
          end_on: "2026-11-30",
          capacity: 20,
        }),
      });
      await assert.rejects(
        async () => classesCreate(sql, reqBad, managerUser),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "court_id");
          return true;
        },
      );

      // Positive: badminton class on badminton court
      const reqGood = new Request("http://localhost/v1/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sport: "badminton",
          level: "cl24-test-ok",
          coach_id: coachUser.id,
          court_id: badmintonCourtId,
          rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=13",
          start_on: "2026-11-01",
          end_on: "2026-11-30",
          capacity: 20,
        }),
      });
      const res = await classesCreate(sql, reqGood, managerUser);
      assert.equal(res.status, 201);
    });
  });

  it("CL-25: a class on the same court, weekday and hour as an existing one is refused with 409", async () => {
    await withTx(async (sql) => {
      // CL-24 left a Monday 13:00 class on this court for November.
      const reqClash = new Request("http://localhost/v1/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sport: "badminton",
          level: "cl25-clash",
          coach_id: coachUser.id,
          court_id: badmintonCourtId,
          rrule: "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=13",
          start_on: "2026-11-10",
          end_on: "2026-12-20",
          capacity: 9,
        }),
      });
      await assert.rejects(
        async () => classesCreate(sql, reqClash, managerUser),
        (err: any) => {
          assert.equal(err.status, 409);
          return true;
        },
      );
    });
  });

  // SS-18 & SS-20: session reschedule outside hours or past class end_on
  it("SS-18 & SS-20: session reschedule outside hours or past end_on rejected, valid reschedule accepted", async () => {
    // Create class and session
    const clId = (
      await db.query<{ id: string }>(
        `insert into classes (sport, level, coach_id, court_id, capacity, rrule, duration_min, start_on, end_on, status)
         values ('badminton', 'ss-test', $1, $2, 10, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10', 60, '2026-11-01', '2026-11-20', 'open')
         returning id`,
        [coachUser.id, badmintonCourtId],
      )
    ).rows[0].id;

    const occId = (await db.query<{ id: string }>(`
      insert into occupancies (court_id, start_at, end_at, kind, ref_id)
      values ($1, '2026-11-05 10:00:00+07', '2026-11-05 11:00:00+07', 'session', gen_random_uuid())
      returning id
    `, [badmintonCourtId])).rows[0].id;

    const sessId = (
      await db.query<{ id: string }>(
        `insert into sessions (class_id, court_id, start_at, end_at, status, occupancy_id)
         values ($1, $2, '2026-11-05 10:00:00+07', '2026-11-05 11:00:00+07', 'scheduled', $3)
         returning id`,
        [clId, badmintonCourtId, occId],
      )
    ).rows[0].id;

    await withTx(async (sql) => {
      // SS-18: reschedule to 03:00 (outside opening hours) -> 422 BR-06
      const req0300 = new Request(`http://localhost/v1/sessions/${sessId}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ start_at: "2026-11-05T03:00:00.000+07:00", reason: "test 03:00" }),
      });
      await assert.rejects(
        async () => sessionReschedule(sql, sessId, req0300, managerUser),
        (err: any) => {
          assert.equal(err.code, "BR_VIOLATION");
          assert.equal(err.extra?.br, "BR-06");
          return true;
        },
      );

      // SS-20: reschedule past class end_on (2026-11-20) -> 400
      const reqPastEnd = new Request(`http://localhost/v1/sessions/${sessId}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ start_at: "2026-11-25T10:00:00.000+07:00", reason: "test past end" }),
      });
      await assert.rejects(
        async () => sessionReschedule(sql, sessId, reqPastEnd, managerUser),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "start_at");
          return true;
        },
      );

      // Positive: reschedule within hours and class end_on -> 200
      const reqValid = new Request(`http://localhost/v1/sessions/${sessId}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ start_at: "2026-11-06T10:00:00.000+07:00", reason: "test valid reschedule" }),
      });
      const res = await sessionReschedule(sql, sessId, reqValid, managerUser);
      assert.equal(res.status, 200);
    });
  });

  // AT-12: attendance marking for unstarted session rejected with 400, started session accepted with 200
  it("AT-12: rejects attendance for session that has not started with 400, accepts started session with 200", async () => {
    // Ensure feature flag F4 is on
    await db.query("insert into feature_flags (key, enabled) values ('F4', true) on conflict (key) do update set enabled = true");

    const memberUser = { id: "00000000-0000-0000-0000-000000000004", role: "member" } as any;
    const clId = (
      await db.query<{ id: string }>(
        `insert into classes (sport, level, coach_id, court_id, capacity, rrule, duration_min, start_on, end_on, status)
         values ('badminton', 'at12-test', $1, $2, 10, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10', 60, '2026-01-01', '2026-12-31', 'open')
         returning id`,
        [coachUser.id, badmintonCourtId],
      )
    ).rows[0].id;

    // Enrolled member
    await db.query(
      `insert into enrollments (class_id, user_id, status) values ($1, $2, 'confirmed') on conflict do nothing`,
      [clId, memberUser.id],
    );

    // Future session (not started)
    const occFuture = (await db.query<{ id: string }>(`
      insert into occupancies (court_id, start_at, end_at, kind, ref_id)
      values ($1, now() + interval '50 days', now() + interval '50 days 1 hour', 'session', gen_random_uuid())
      returning id
    `, [badmintonCourtId])).rows[0].id;

    const futureSessId = (
      await db.query<{ id: string }>(
        `insert into sessions (class_id, court_id, start_at, end_at, status, occupancy_id)
         values ($1, $2, now() + interval '50 days', now() + interval '50 days 1 hour', 'scheduled', $3)
         returning id`,
        [clId, badmintonCourtId, occFuture],
      )
    ).rows[0].id;

    // Past session (started 1 hour ago)
    const occPast = (await db.query<{ id: string }>(`
      insert into occupancies (court_id, start_at, end_at, kind, ref_id)
      values ($1, now() - interval '2 hours', now() - interval '1 hour', 'session', gen_random_uuid())
      returning id
    `, [badmintonCourtId])).rows[0].id;

    const pastSessId = (
      await db.query<{ id: string }>(
        `insert into sessions (class_id, court_id, start_at, end_at, status, occupancy_id)
         values ($1, $2, now() - interval '2 hours', now() - interval '1 hour', 'scheduled', $3)
         returning id`,
        [clId, badmintonCourtId, occPast],
      )
    ).rows[0].id;

    await withTx(async (sql) => {
      // Negative: future session -> 400
      const reqFuture = new Request(`http://localhost/v1/sessions/${futureSessId}/attendance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ user_id: memberUser.id, result: "present" }] }),
      });
      await assert.rejects(
        async () => sessionAttendancePost(sql, futureSessId, reqFuture, coachUser),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "session_id");
          return true;
        },
      );

      // Positive: past session -> 200
      const reqPast = new Request(`http://localhost/v1/sessions/${pastSessId}/attendance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ user_id: memberUser.id, result: "present" }] }),
      });
      const res = await sessionAttendancePost(sql, pastSessId, reqPast, coachUser);
      assert.equal(res.status, 200);
    });
  });

  // TR-47: training plan for session with results rejected with 422 (BR-48), session without results accepted with 201
  it("TR-47: rejects new plan for session with results with 422 (BR-48), accepts session without results with 201", async () => {
    // Ensure feature flag F4 is on
    await db.query("insert into feature_flags (key, enabled) values ('F4', true) on conflict (key) do update set enabled = true");

    const clId = (
      await db.query<{ id: string }>(
        `insert into classes (sport, level, coach_id, court_id, capacity, rrule, duration_min, start_on, end_on, status)
         values ('badminton', 'tr47-test', $1, $2, 10, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10', 60, '2026-01-01', '2026-12-31', 'open')
         returning id`,
        [coachUser.id, badmintonCourtId],
      )
    ).rows[0].id;

    const sessWithResults = (
      await db.query<{ id: string }>(
        `insert into sessions (class_id, court_id, start_at, end_at, status)
         values ($1, $2, now() - interval '2 days', now() - interval '2 days - 1 hour', 'done')
         returning id`,
        [clId, badmintonCourtId],
      )
    ).rows[0].id;

    // Seed result in session_results (plan_pct and note)
    await db.query(
      `insert into session_results (session_id, user_id, plan_pct, note)
       values ($1, '00000000-0000-0000-0000-000000000004', 100, 'Good form')`,
      [sessWithResults],
    );

    const occNoRes = (await db.query<{ id: string }>(`
      insert into occupancies (court_id, start_at, end_at, kind, ref_id)
      values ($1, now() + interval '30 days', now() + interval '30 days 1 hour', 'session', gen_random_uuid())
      returning id
    `, [badmintonCourtId])).rows[0].id;

    const sessNoResults = (
      await db.query<{ id: string }>(
        `insert into sessions (class_id, court_id, start_at, end_at, status, occupancy_id)
         values ($1, $2, now() + interval '30 days', now() + interval '30 days 1 hour', 'scheduled', $3)
         returning id`,
        [clId, badmintonCourtId, occNoRes],
      )
    ).rows[0].id;

    const planPayload = {
      sport: "badminton",
      level: "tr47-test",
      blocks: [
        {
          title: "Warmup block",
          minutes: 15,
          phase: "warm-up",
          intensity: "light",
          description: "Stretching and warm-up drills",
        },
      ],
    };

    await withTx(async (sql) => {
      // Negative: session with results -> 422 BR-48
      const reqBad = new Request("http://localhost/v1/training", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          class_id: clId,
          session_id: sessWithResults,
          title: "Plan for session with results",
          payload: planPayload,
        }),
      });
      await assert.rejects(
        async () => trainingCreate(sql, reqBad, coachUser),
        (err: any) => {
          assert.equal(err.status, 422);
          assert.equal(err.code, "BR_VIOLATION");
          assert.equal(err.extra?.br, "BR-48");
          return true;
        },
      );

      // Positive: session without results -> 201
      const reqGood = new Request("http://localhost/v1/training", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          class_id: clId,
          session_id: sessNoResults,
          title: "Plan for session without results",
          payload: planPayload,
        }),
      });
      const res = await trainingCreate(sql, reqGood, coachUser);
      assert.equal(res.status, 201);
    });
  });
});

describe("Round 8 unit tests (AT-12, SB-31 / F-20, F-11, F-19)", () => {
  it("AT-12: rejects attendance for future session with 400, accepts started session with 200 even if earlier session is uncompleted", async () => {
    await db.query("insert into feature_flags (key, enabled) values ('F4', true) on conflict (key) do update set enabled = true");
    const coachUser = toPublic((await db.query("select * from users where role = 'coach' limit 1")).rows[0] as any);
    const memberUser = toPublic((await db.query("select * from users where role = 'member' limit 1")).rows[0] as any);
    // Dedicated court to avoid CONFLICT_SLOT with seed occupancies
    const courtId = (
      await db.query<{ id: string }>(
        `insert into courts (court_code, sport, status) values ('AT12', 'badminton', 'ready') returning id`,
      )
    ).rows[0].id;

    // Create class and enroll member
    const clId = (
      await db.query<{ id: string }>(
        `insert into classes (sport, level, coach_id, court_id, capacity, rrule, duration_min, start_on, end_on, status)
         values ('badminton', 'at12-v8-test', $1, $2, 10, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=7', 60, '2026-01-01', '2026-12-31', 'open')
         returning id`,
        [coachUser.id, courtId],
      )
    ).rows[0].id;

    await db.query(
      `insert into enrollments (class_id, user_id, status) values ($1, $2, 'confirmed')`,
      [clId, memberUser.id],
    );

    // Session 1: past unattended session (started 3 hours ago, still scheduled)
    const occ1 = (await db.query<{ id: string }>(`
      insert into occupancies (court_id, start_at, end_at, kind, ref_id)
      values ($1, now() - interval '3 hours', now() - interval '2 hours', 'session', gen_random_uuid())
      returning id
    `, [courtId])).rows[0].id;
    const _sess1 = (
      await db.query<{ id: string }>(
        `insert into sessions (class_id, court_id, start_at, end_at, status, occupancy_id)
         values ($1, $2, now() - interval '3 hours', now() - interval '2 hours', 'scheduled', $3)
         returning id`,
        [clId, courtId, occ1],
      )
    ).rows[0].id;

    // Session 2: past started session (started 1 hour ago, currently within lock window)
    const occ2 = (await db.query<{ id: string }>(`
      insert into occupancies (court_id, start_at, end_at, kind, ref_id)
      values ($1, now() - interval '1 hour', now(), 'session', gen_random_uuid())
      returning id
    `, [courtId])).rows[0].id;
    const sess2 = (
      await db.query<{ id: string }>(
        `insert into sessions (class_id, court_id, start_at, end_at, status, occupancy_id)
         values ($1, $2, now() - interval '1 hour', now(), 'scheduled', $3)
         returning id`,
        [clId, courtId, occ2],
      )
    ).rows[0].id;

    // Session 3: future session (starts in 2 hours)
    const occ3 = (await db.query<{ id: string }>(`
      insert into occupancies (court_id, start_at, end_at, kind, ref_id)
      values ($1, now() + interval '2 hours', now() + interval '3 hours', 'session', gen_random_uuid())
      returning id
    `, [courtId])).rows[0].id;
    const sess3 = (
      await db.query<{ id: string }>(
        `insert into sessions (class_id, court_id, start_at, end_at, status, occupancy_id)
         values ($1, $2, now() + interval '2 hours', now() + interval '3 hours', 'scheduled', $3)
         returning id`,
        [clId, courtId, occ3],
      )
    ).rows[0].id;

    await withTx(async (sql) => {
      // 1. Future session (sess3) -> rejected with 400
      const reqFuture = new Request(`http://localhost/v1/sessions/${sess3}/attendance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ user_id: memberUser.id, result: "present" }] }),
      });
      await assert.rejects(
        async () => sessionAttendancePost(sql, sess3, reqFuture, coachUser),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "session_id");
          return true;
        },
      );

      // 2. Started session (sess2) -> accepted with 200 even though sess1 was never attended
      const reqStarted = new Request(`http://localhost/v1/sessions/${sess2}/attendance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ user_id: memberUser.id, result: "present" }] }),
      });
      const resStarted = await sessionAttendancePost(sql, sess2, reqStarted, coachUser);
      assert.equal(resStarted.status, 200);
    });
  });

  it("SB-31 / F-20: locks subscription price at order time; payment follows locked price after manager price change", async () => {
    const mgr = toPublic((await db.query("select * from users where role = 'manager' limit 1")).rows[0] as any);

    // Create a plan with initial price 500,000 VND
    const planId = (
      await db.query<{ id: string }>(
        `insert into membership_plans (name, sport_scope, duration_days, court_hours, price_vnd, is_on_sale)
         values ('Plan Lock Test', 'badminton', 30, 10, 500000, true)
         returning id`,
      )
    ).rows[0].id;

    const testMember = { id: "00000000-0000-0000-0000-000000000231", role: "member", full_name: "Member SB31" } as any;
    await db.query(
      `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
       values ($1, '0987000231', 'Member SB31', 'member sb31', 'member', 'active', 'hash')
       on conflict (id) do nothing`,
      [testMember.id],
    );
    await db.query("delete from subscriptions where user_id = $1", [testMember.id]);

    // Member orders subscription when plan is 500,000
    let subId = "";
    await withTx(async (sql) => {
      const orderReq = new Request("http://localhost/v1/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan_id: planId }),
      });
      const res = await subscriptionsCreate(sql, orderReq, testMember);
      assert.equal(res.status, 201);
      subId = (res.body as any).subscription.id;
      assert.equal((res.body as any).subscription.price_vnd, 500000);
    });

    // Manager updates plan price to 600,000 VND
    await withTx(async (sql) => {
      const patchReq = new Request(`http://localhost/v1/plans/${planId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ price_vnd: 600000 }),
      });
      const patchRes = await plansPatch(sql, planId, patchReq, mgr);
      assert.equal(patchRes.status, 200);
      assert.equal((patchRes.body as any).price_vnd, 600000);
    });

    // Negative case (counter-verification): paying the new plan price (600,000) is rejected
    await withTx(async (sql) => {
      const payReqBad = new Request("http://localhost/v1/payments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ref_type: "subscription",
          ref_id: subId,
          method: "cash",
          amount_vnd: 600000,
        }),
      });
      await assert.rejects(
        async () => paymentsCreate(sql, payReqBad, mgr),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "amount_vnd");
          assert.equal(err.extra?.expected_vnd, 500000);
          return true;
        },
      );
    });

    // Positive case: paying the locked order price (500,000) succeeds with 201
    await withTx(async (sql) => {
      const payReqGood = new Request("http://localhost/v1/payments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ref_type: "subscription",
          ref_id: subId,
          method: "cash",
          amount_vnd: 500000,
        }),
      });
      const payRes = await paymentsCreate(sql, payReqGood, mgr);
      assert.equal(payRes.status, 201);
    });
  });

  it("F-11: password reset via OTP revokes all sessions of the user", async () => {
    const rawPhone = "0987000211";
    const phone = "+84987000211";
    const testMemberF11 = { id: "00000000-0000-0000-0000-000000000211", role: "member", phone, full_name: "Member F11" } as any;
    await db.query(
      `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
       values ($1, $2, 'Member F11', 'member f11', 'member', 'active', $3)
       on conflict (id) do nothing`,
      [testMemberF11.id, testMemberF11.phone, hashPassword("OldPass123!")],
    );

    // Issue 2 active sessions
    let s1: any;
    let s2: any;
    await withTx(async (sql) => {
      s1 = await issueSession(sql, testMemberF11);
      s2 = await issueSession(sql, testMemberF11);
    });

    // Verify both tokens are valid
    await withTx(async (sql) => {
      const u1 = await authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${s1.token}` } }));
      const u2 = await authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${s2.token}` } }));
      assert.equal(u1?.id, testMemberF11.id);
      assert.equal(u2?.id, testMemberF11.id);
    });

    // Create OTP challenge for purpose 'reset'
    await db.query(
      `insert into otp_challenges (phone, purpose, otp_hash, payload, expires_at)
       values ($1, 'reset', $2, '{}'::jsonb, now() + interval '10 minutes')`,
      [phone, hashOtp("123456")],
    );

    // Call verifyOtp with new password
    await withTx(async (sql) => {
      const verifyReq = new Request("http://localhost/v1/auth/otp/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: rawPhone, otp: "123456", purpose: "reset", password: "NewPassword123!" }),
      });
      const verifyRes = await authH.verifyOtp(sql, verifyReq);
      assert.equal(verifyRes.status, 200);
    });

    // Verify both session tokens are now revoked and receive 401
    await withTx(async (sql) => {
      await assert.rejects(
        async () => authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${s1.token}` } })),
        (err: any) => {
          assert.equal(err.status, 401);
          return true;
        },
      );
      await assert.rejects(
        async () => authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${s2.token}` } })),
        (err: any) => {
          assert.equal(err.status, 401);
          return true;
        },
      );
    });
  });

  it("F-19: unfreeze without freeze_sub audit log does not crash 500, unfreeze after full duration caps at actual days", async () => {
    const mgr = toPublic((await db.query("select * from users where role = 'manager' limit 1")).rows[0] as any);
    const plan = (await db.query<{ id: string }>("select id from membership_plans limit 1")).rows[0];

    const testMemberF19b = { id: "00000000-0000-0000-0000-000000000218", role: "member", full_name: "Member F19b" } as any;
    await db.query(
      `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
       values ($1, '0987000218', 'Member F19b', 'member f19b', 'member', 'active', 'hash')
       on conflict (id) do nothing`,
      [testMemberF19b.id],
    );
    await db.query("delete from subscriptions where user_id = $1", [testMemberF19b.id]);

    // 1. Unfreeze when there is NO audit log for freeze_sub (imported or legacy data)
    const subNoAudit = (
      await db.query<{ id: string }>(
        `insert into subscriptions (user_id, plan_id, sport_scope, start_on, end_on, status, court_hours_left, session_left, frozen_days)
         values ($1, $2, 'badminton', '2026-11-01', '2026-11-30', 'frozen', 10, 10, 7)
         returning id`,
        [testMemberF19b.id, plan.id],
      )
    ).rows[0].id;

    await withTx(async (sql) => {
      const res = await subscriptionUnfreeze(sql, subNoAudit, mgr);
      assert.equal(res.status, 200);
      assert.equal((res.body as any).status, "active");
      assert.equal((res.body as any).end_on.slice(0, 10), "2026-11-30");
    });

    // 2. Unfreeze after entire freeze duration has elapsed
    await db.query("delete from subscriptions where user_id = $1", [testMemberF19b.id]);
    const subWithAudit = (
      await db.query<{ id: string }>(
        `insert into subscriptions (user_id, plan_id, sport_scope, start_on, end_on, status, court_hours_left, session_left, frozen_days)
         values ($1, $2, 'badminton', '2026-11-01', '2026-12-07', 'frozen', 10, 10, 7)
         returning id`,
        [testMemberF19b.id, plan.id],
      )
    ).rows[0].id;

    // Seed audit log for freeze_sub 10 days ago (more than the 7 frozen days)
    await db.query(
      `insert into audit_logs (actor_id, action, entity, entity_id, at, before, after)
       values ($1, 'freeze_sub', 'subscription', $2, now() - interval '10 days',
               '{"end_on":"2026-11-30"}'::jsonb, '{"days":7,"end":"2026-12-07"}'::jsonb)`,
      [mgr.id, subWithAudit],
    );

    await withTx(async (sql) => {
      const res = await subscriptionUnfreeze(sql, subWithAudit, mgr);
      assert.equal(res.status, 200);
      assert.equal((res.body as any).status, "active");
      // End date is capped at 7 days extension from original end_on: 2026-11-30 + 7 days = 2026-12-07
      assert.equal((res.body as any).end_on.slice(0, 10), "2026-12-07");
    });
  });
});

describe("Round 9 unit tests (SB-31 online flow price lock)", () => {
  after(() => {
    setOverridePaymentLinkCreator(null);
  });

  it("SB-31 online: creates online payment link with locked price minus promo after manager price change", async () => {
    const mgr = toPublic((await db.query("select * from users where role = 'manager' limit 1")).rows[0] as any);
    const rec = toPublic((await db.query("select * from users where role = 'receptionist' limit 1")).rows[0] as any);

    // 1. Create a member
    const testMemberOnline = { id: "00000000-0000-0000-0000-000000000301", role: "member", full_name: "Member Online" } as any;
    await db.query(
      `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
       values ($1, '0987000301', 'Member Online', 'member online', 'member', 'active', 'hash')
       on conflict (id) do nothing`,
      [testMemberOnline.id],
    );
    await db.query("delete from subscriptions where user_id = $1", [testMemberOnline.id]);

    // 2. Create a test plan with initial price 500,000 VND
    const planId = (
      await db.query<{ id: string }>(
        `insert into membership_plans (name, sport_scope, duration_days, price_vnd, court_hours, is_on_sale)
         values ('Plan Online SB31', 'badminton', 30, 500000, 10, true)
         returning id`,
      )
    ).rows[0].id;

    // 3. Create a promo code with 50,000 VND discount
    await db.query(
      `insert into promotions (code, name, kind, value, max_discount_vnd, min_order_vnd, starts_at, ends_at, applies_to, stackable, status)
       values ('PROMOONLINE', 'Promo Online', 'amount', 50000, 50000, 0, now() - interval '1 day', now() + interval '30 days', ARRAY['plan'], false, 'active')
       on conflict do nothing`,
    );

    // 4. Member orders the plan with promo code
    let subId = "";
    await withTx(async (sql) => {
      const orderReq = new Request("http://localhost/v1/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan_id: planId, promo_code: "PROMOONLINE" }),
      });
      const orderRes = await subscriptionsCreate(sql, orderReq, testMemberOnline);
      assert.equal(orderRes.status, 201);
      subId = (orderRes.body as any).subscription.id;
      // Locked price should be 500,000, discount 50,000
      assert.equal((orderRes.body as any).subscription.price_vnd, 500000);
      assert.equal((orderRes.body as any).subscription.promo_discount_vnd, 50000);
    });

    // 5. Manager changes the plan price to 700,000 VND
    await withTx(async (sql) => {
      const patchReq = new Request(`http://localhost/v1/plans/${planId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ price_vnd: 700000 }),
      });
      const patchRes = await plansPatch(sql, planId, patchReq, mgr);
      assert.equal(patchRes.status, 200);
    });

    // 6. Set up mock payment link creator to capture args
    let capturedArgs: any = null;
    setOverridePaymentLinkCreator(async (args) => {
      capturedArgs = args;
      return {
        orderCode: args.orderCode,
        checkoutUrl: "https://pay.mock/checkout/123",
        qrCode: "data:image/png;base64,mock",
        paymentLinkId: "link_mock_123",
        expiredAt: Math.floor(Date.now() / 1000) + 900,
      };
    });

    try {
      // 7. Receptionist creates online payment link for the pending subscription
      await withTx(async (sql) => {
        const linkReq = new Request("http://localhost/v1/payments/online", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ref_type: "subscription", ref_id: subId }),
        });
        const linkRes = await onlineCreate(sql, linkReq, rec);
        assert.equal(linkRes.status, 201);
        // Expected amount = locked price (500,000) - discount (50,000) = 450,000
        assert.equal((linkRes.body as any).amount_vnd, 450000);
        assert.equal(capturedArgs?.amountVnd, 450000);
        // Counter-verification: must NOT be 650,000 (700,000 - 50,000)
        assert.notEqual(capturedArgs?.amountVnd, 650000);
      });

      // 8. Counter-verification: if subscription.price_vnd was NULL, it falls back to current plan price
      await db.query("delete from payments where ref_id = $1", [subId]);
      await db.query("update subscriptions set price_vnd = null where id = $1", [subId]);
      await withTx(async (sql) => {
        const linkReq = new Request("http://localhost/v1/payments/online", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ref_type: "subscription", ref_id: subId }),
        });
        const linkRes = await onlineCreate(sql, linkReq, rec);
        assert.equal(linkRes.status, 201);
        // Fallback to 700,000 - 50,000 = 650,000
        assert.equal((linkRes.body as any).amount_vnd, 650000);
        assert.equal(capturedArgs?.amountVnd, 650000);
      });
    } finally {
      setOverridePaymentLinkCreator(null);
    }
  });
});

describe("Round 10: Two-way Chat unit tests", () => {
  it("enforces permissions: member not enrolled in coach class cannot chat, enrolled member can, idempotent send, and mark read", async () => {
    // 1. Create a coach C1 and a member M1, and an active class taught by C1
    const coachRes = await db.query<{ id: string; role: string; full_name: string }>(
      `insert into users (full_name, name_normalized, phone, role, status, password_hash)
       values ('Coach Chat Test', 'coach chat test', '0901999881', 'coach', 'active', 'test_hash')
       returning id, role, full_name`,
    );
    const coach = {
      id: coachRes.rows[0]!.id,
      role: "coach" as const,
      full_name: coachRes.rows[0]!.full_name,
      phone: "0901999881",
      email: null,
      member_code: null,
      status: "active",
      date_of_birth: null,
      health_notes: null,
      must_change_password: false,
    };

    const memberRes = await db.query<{ id: string; role: string; full_name: string }>(
      `insert into users (full_name, name_normalized, phone, role, status, password_hash)
       values ('Member Chat Test', 'member chat test', '0901999882', 'member', 'active', 'test_hash')
       returning id, role, full_name`,
    );
    const member = {
      id: memberRes.rows[0]!.id,
      role: "member" as const,
      full_name: memberRes.rows[0]!.full_name,
      phone: "0901999882",
      email: null,
      member_code: null,
      status: "active",
      date_of_birth: null,
      health_notes: null,
      must_change_password: false,
    };

    // Member tries to create conversation with Coach before enrollment -> 403 Forbidden
    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipient_id: coach.id }),
      });
      await assert.rejects(
        async () => chatH.createOrGetConversation(sql, member, req),
        (err: any) => {
          assert.equal(err.status, 403);
          return true;
        },
      );
    });

      // Create an active class taught by coach and enroll member
      const court = await db.query<{ id: string }>(`select id from courts where sport = 'badminton' limit 1`);
      const clsRes = await db.query<{ id: string }>(
        `insert into classes (sport, level, coach_id, court_id, capacity, rrule, duration_min, status, start_on, end_on)
         values ('badminton', 'beginner', $1, $2, 12, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10', 60, 'open', current_date, current_date + 30)
         returning id`,
        [coach.id, court.rows[0]!.id],
      );
      const classId = clsRes.rows[0]!.id;

      await db.query(
        `insert into enrollments (class_id, user_id, status)
         values ($1, $2, 'confirmed')`,
        [classId, member.id],
      );

      // Now member can create conversation with Coach -> 201 Created
      let convId = "";
      await withTx(async (sql) => {
        const req = new Request("http://localhost/v1/conversations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ recipient_id: coach.id }),
        });
        const res = await chatH.createOrGetConversation(sql, member, req);
        assert.ok(res.conversation!.id);
        convId = res.conversation!.id;
      });

      // 2. Idempotent message sending
      const clientMsgId = "11111111-2222-3333-4444-555555555555";
      await withTx(async (sql) => {
        const req = new Request(`http://localhost/v1/conversations/${convId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: clientMsgId, body: "Xin chao HLV!" }),
        });
        const res = await chatH.sendMessage(sql, member, convId, req);
        assert.equal(res.message!.id, clientMsgId);
        assert.equal(res.message!.body, "Xin chao HLV!");
        assert.equal(res.message!.read_at, null);
      });

      // Replay with exact same clientMsgId -> returns same message without duplicate
      await withTx(async (sql) => {
        const req = new Request(`http://localhost/v1/conversations/${convId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: clientMsgId, body: "Xin chao HLV!" }),
        });
        const res = await chatH.sendMessage(sql, member, convId, req);
        assert.equal(res.message!.id, clientMsgId);
      });

      const msgCount = await db.query<{ c: number }>(
        `select count(*)::int as c from messages where conversation_id = $1`,
        [convId],
      );
      assert.equal(msgCount.rows[0]!.c, 1);

      // 3. Mark conversation read
      await withTx(async (sql) => {
        const res = await chatH.markConversationRead(sql, coach, convId);
        assert.equal(res.ok, true);
      });

      const readCheck = await db.query<{ read_at: string | null }>(
        `select read_at from messages where id = $1`,
        [clientMsgId],
      );
      assert.ok(readCheck.rows[0]!.read_at !== null);
    });
  });










