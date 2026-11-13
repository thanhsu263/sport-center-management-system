import assert from "node:assert/strict";
import { SHORTEST_PLAN_ID } from "../services/membership";
import { describe, it, before, after } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

// Prevent src/server/data/db.ts from running bootstrap in test runner
process.env.DATABASE_URL = "postgres://mock:mock@localhost/mock";
process.env.PGLITE_DATA_DIR = "memory";

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
const { classesCreate, enrollmentDelete, classesEnroll, sessionReschedule, sessionCancel, classDetail, classRoster, classesPatch, classQuote } = await import("./handlers/classes.ts");
const { bookingGet, bookingsReschedule, walkIn, bookingsHold, bookingsConfirm, bookingsCancel } = await import("./handlers/bookings.ts");
const { shiftClose, paymentsCreate, shiftCurrent, paymentsRefund, paymentsApproveRefund, paymentsRejectRefund } = await import("./handlers/desk.ts");
const { waitlistAccept, inviteWaitlist, sessionAttendancePost } = await import("./handlers/ops.ts");
const { waitlistExpire } = await import("../data/jobs.ts");
const { findUserByLogin, issueSession, authFromRequest, toPublic } = await import("./session.ts");
const { hashPassword, hashOtp } = await import("../services/crypto.ts");
const { csvCell } = await import("./handlers/extras.ts");
const { trainingCreate } = await import("./handlers/training.ts");
const { clearAll: clearLimits, RULES: LIMITS, take: takeLimit } = await import("./ratelimit.ts");
const { onlineCreate } = await import("./handlers/online.ts");
const { handleApi } = await import("./router.ts");
const { setOverridePaymentLinkCreator, setOverridePaymentLinkCanceller } = await import("../integrations/payos.ts");
const chatH = await import("./handlers/chat.ts");
const avatarH = await import("./handlers/avatar.ts");
const { sniffAvatar, meAvatarPut, meAvatarDelete, userAvatarGet } = avatarH;
const membersH = await import("./handlers/members.ts");
const { memberGet, membersDirectory, membersSearch } = membersH;
const { PLAN_PHASES, INTENSITIES } = await import("../services/rules.ts");

let db: PGlite;

describe("training suggestions publish without manual edits", () => {
  for (const mode of ["ai", "unavailable", "invalid-json"] as const) {
    it(`publishes ${mode} suggestions through trainingCreate`, async (t) => {
      const original = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = "test-training-suggestion";
      t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.generationConfig.responseMimeType, "application/json");
        assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0);
        for (const value of [...PLAN_PHASES, ...INTENSITIES]) assert.ok(body.systemInstruction.parts[0].text.includes(value));
        if (mode === "unavailable") return new Response("unavailable", { status: 503 });
        const blocks = [
          { title: " Khởi động ", minutes: "Infinity", phase: "invalid", intensity: "invalid" },
          { title: "Kỹ thuật", minutes: 12.5, phase: "technique", intensity: "hard", description: "d".repeat(700), equipment: "e".repeat(250), target: "t".repeat(250) },
          { title: "Thả lỏng", minutes: -4, phase: null, description: " " },
          null, [], { title: " " },
        ];
        return Response.json({ candidates: [{ content: { parts: [{ text: mode === "invalid-json" ? "not JSON" : JSON.stringify(blocks) }] } }] });
      });
      try {
        await withTx(async (sql) => {
          await sql.query("insert into feature_flags (key, enabled) values ('F4', true), ('F5', true) on conflict (key) do update set enabled = true");
          const coach = toPublic((await sql.query("select * from users where role = 'coach' limit 1"))[0] as any);
          const classId = (await sql.query<{ id: string }>(`insert into classes (sport, level, coach_id, court_id, capacity, rrule, duration_min, start_on, end_on, status)
            values ('badminton', 'beginner', $1, (select id from courts where sport='badminton' limit 1), 10, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10', 60, '2026-01-01', '2026-12-31', 'open') returning id`, [coach.id]))[0].id;
          const suggestion = await opsH.trainingSuggest(sql, new Request("http://localhost/v1/training-plans/suggest", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ sport: "badminton", level: "beginner", prompt: "Tập kỹ thuật cầu lông" }),
          }), coach);
          assert.equal(suggestion.body.ai, mode === "ai");
          const { payload } = suggestion.body;
          assert.equal(payload.blocks[0].phase, "warm-up");
          assert.equal(payload.blocks.at(-1)!.phase, "cool-down");
          for (const block of payload.blocks) {
            assert.ok(PLAN_PHASES.includes(block.phase));
            assert.ok(INTENSITIES.includes(block.intensity));
            assert.ok(block.description.length > 0 && block.description.length <= 600);
            assert.ok(block.equipment.length > 0 && block.equipment.length <= 200);
            assert.ok(block.target.length > 0 && block.target.length <= 200);
          }
          if (mode === "ai") {
            assert.equal(payload.blocks[0].minutes, 10);
            assert.equal(payload.blocks[0].intensity, "medium");
            assert.equal(payload.blocks[1].intensity, "hard");
            assert.equal(payload.blocks[1].minutes, 13);
            assert.equal(payload.blocks[1].description.length, 600);
          }
          const published = await trainingCreate(sql, new Request("http://localhost/v1/training-plans", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ class_id: classId, source: "ai", published: true, payload }),
          }), coach);
          assert.equal(published.status, 201);
          const saved = (await sql.query<{ published: boolean; payload: unknown }>("select published, payload from training_plans where id=$1", [published.body.id]))[0];
          assert.equal(saved.published, true);
          assert.deepEqual((saved.payload as { blocks: unknown }).blocks, payload.blocks);
          await sql.query("delete from training_plans where class_id=$1", [classId]);
          await sql.query("delete from classes where id=$1", [classId]);
        });
      } finally {
        if (original === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = original;
      }
    });
  }
});

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

describe("foreign keys & subscription role unit tests (Vòng 3: F-24, F-25, F-18, F-21)", () => {
  const managerUser = { id: "00000000-0000-0000-0000-000000000001", role: "manager" } as any;
  const receptionistUser = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist" } as any;
  const coachUser = { id: "00000000-0000-0000-0000-000000000003", role: "coach" } as any;
  const memberUser = { id: "00000000-0000-0000-0000-000000000004", role: "member" } as any;

  const validCourtId = "10000000-0000-0000-0000-000000000001";
  const nonexistentId = "99999999-9999-4999-8999-999999999999";
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

  // F-16 (2): Quản lý duyệt hoàn tiền (approve-refund) → tổng ca lễ tân giảm theo số tiền hoàn
  it("F-16: manager approves refund (approve-refund) -> receptionist shift till totals reduced by refund", async () => {
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
    assert.equal((resPending.body as any).payment?.shift_id, shift.id);
    const pendingId = (resPending.body as any).payment.id;

    // Manager approves refund
    const reqApprove = new Request("http://localhost/v1/payments/" + pendingId + "/approve-refund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Duyệt hoàn tiền" }),
    });
    const resApprove = await withTx(async (sql) => paymentsApproveRefund(sql, pendingId, reqApprove, managerUser));
    assert.equal(resApprove.status, 200);

    // Shift totals for receptionist MUST drop by refund amount (the approved refund has shift_id = shift.id)
    const curAfter = await withTx(async (sql) => shiftCurrent(sql, receptionistUser, reqCurrentBefore));
    assert.equal((curAfter.body as any).totals?.cash, cashBefore - 1200000);

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
      `insert into classes (id, sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count, price_vnd)
       values ($1, 'badminton', 'f26-test', $2, $3, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10', current_date + 1, current_date + 14, 60, 1, 'open', 0, 300000)`,
      [classId, coachId, validCourtId]
    );

    const mem1 = { id: "00000000-0000-0000-0000-000000000104", phone: "+84900000104", name: "Mem 1", role: "member" } as any;
    const mem2 = { id: "00000000-0000-0000-0000-000000000105", phone: "+84900000105", name: "Mem 2", role: "member" } as any;
    const mem3 = { id: "00000000-0000-0000-0000-000000000106", phone: "+84900000106", name: "Mem 3", role: "member" } as any;
    const mem4 = { id: "00000000-0000-0000-0000-000000000107", phone: "+84900000107", name: "Mem 4", role: "member" } as any;

    try {
      for (const m of [mem1, mem2, mem3, mem4]) {
        await db.query(
          `insert into users (id, phone, full_name, name_normalized, role, password_hash)
           values ($1, $2, $3, $4, 'member', 'hash')
           on conflict (id) do nothing`,
          [m.id, m.phone, m.name, m.name.toLowerCase()]
        );
      }
      await db.query("delete from subscriptions where user_id = any($1::uuid[])", [[mem1.id, mem2.id, mem3.id, mem4.id]]);
      await db.query(
        `insert into subscriptions (user_id, plan_id, start_on, end_on, status)
         select u, (select id from membership_plans order by price_vnd limit 1), current_date - 1, current_date + 400, 'active'
           from unnest($1::uuid[]) as u`,
        [[mem1.id, mem2.id, mem3.id, mem4.id]],
      );

      // 1. mem1 enrolls -> hold (1/1)
      const enr1 = await withTx(async (sql) => classesEnroll(sql, classId, new Request("http://localhost"), mem1));
      assert.equal(enr1.status, 201);
      assert.equal((enr1.body as any).enrollment?.status, "hold");

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

      // 4. mem3 (newcomer) attempts to enroll while offer is pending -> hold (D5: free seat is not held back)
      const enr3 = await withTx(async (sql) => classesEnroll(sql, classId, new Request("http://localhost"), mem3));
      assert.equal(enr3.status, 201);
      assert.equal((enr3.body as any).enrollment?.status, "hold");

      // offer for mem2 was skipped
      const offerAfter = (await db.query<{ status: string }>("select status from waitlist_offers where id = $1", [offer.id])).rows[0];
      assert.equal(offerAfter.status, "skipped");

      // mem2 attempts to accept skipped/full offer -> throws BR-21
      await assert.rejects(
        () => withTx(async (sql) => waitlistAccept(sql, offer.id, mem2)),
        (err: any) => {
          assert.equal(err.extra?.br, "BR-21");
          return true;
        }
      );
      // The refused accept changed nothing: mem2 is still waitlisted and the offer is still skipped.
      const mem2After = (await db.query<{ status: string }>("select status from enrollments where id = $1", [(enr2.body as any).enrollment.id])).rows[0];
      assert.equal(mem2After.status, "waitlisted");
      const offerStill = (await db.query<{ status: string }>("select status from waitlist_offers where id = $1", [offer.id])).rows[0];
      assert.equal(offerStill.status, "skipped");

      // Cancel mem3 -> triggers new offer for mem2
      await withTx(async (sql) => enrollmentDelete(sql, (enr3.body as any).enrollment.id, mem3));
      const newOffer = (await db.query<{ id: string }>(
        "select o.id from waitlist_offers o join enrollments e on e.id = o.enrollment_id where e.class_id = $1 and o.status = 'pending'",
        [classId]
      )).rows[0];
      assert.ok(newOffer);

      // 5. mem2 accepts offer -> 200, a hold awaiting payment
      const accRes = await withTx(async (sql) => waitlistAccept(sql, newOffer.id, mem2));
      assert.equal(accRes.status, 200);
      const mem2Enr = (await db.query<{ status: string }>("select status from enrollments where id = $1", [(enr2.body as any).enrollment.id])).rows[0];
      assert.equal(mem2Enr.status, "hold");
    } finally {
      // Clean up test class and enrollments so later tests don't clash on court
      await db.query("delete from waitlist_offers where enrollment_id in (select id from enrollments where class_id = $1)", [classId]);
      await db.query("delete from enrollments where class_id = $1", [classId]);
      await db.query("delete from classes where id = $1", [classId]);
    }
  });

  it("BR-63: a member cannot be in more classes at once than the centre allows", async () => {
    const coachId = "00000000-0000-0000-0000-000000000011";
    const c1 = "40000000-0000-0000-0000-0000000000c1";
    const c2 = "40000000-0000-0000-0000-0000000000c2";
    const m = { id: "00000000-0000-0000-0000-0000000001c1", phone: "+84900001c1", name: "Cap", role: "member" } as any;
    const before = (await db.query(`select max_active_classes from center_settings where id = 1`)).rows[0] as any;
    try {
      await db.query(`update center_settings set max_active_classes = 1 where id = 1`);
      for (const [id, day] of [[c1, "MO"], [c2, "TH"]]) {
        await db.query(
          `insert into classes (id, sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count, price_vnd)
           values ($1, 'badminton', 'scratch', $2, $3, $4, current_date + 3, current_date + 30, 60, 5, 'open', 0, 300000)`,
          [id, coachId, validCourtId, `FREQ=WEEKLY;BYDAY=${day};BYHOUR=6`],
        );
      }
      await db.query(`insert into users (id, phone, full_name, name_normalized, role, password_hash) values ($1,$2,$3,$4,'member','hash') on conflict (id) do nothing`, [m.id, m.phone, m.name, "cap"]);
      await db.query(`insert into subscriptions (user_id, plan_id, start_on, end_on, status) values ($1, (select id from membership_plans order by price_vnd limit 1), current_date - 1, current_date + 400, 'active')`, [m.id]);
      await withTx(async (sql) => classesEnroll(sql, c1, new Request("http://localhost"), m));
      await assert.rejects(
        withTx(async (sql) => classesEnroll(sql, c2, new Request("http://localhost"), m)),
        /the most at once/,
      );
    } finally {
      await db.query(`update center_settings set max_active_classes = $1 where id = 1`, [before.max_active_classes]);
      await db.query("delete from enrollments where class_id in ($1, $2)", [c1, c2]);
      await db.query("delete from classes where id in ($1, $2)", [c1, c2]);
    }
  });

  it("waitlist claim survives out-of-order compaction and the freed seat goes to the first in line", async () => {
    const coachId = "00000000-0000-0000-0000-000000000011";
    const classId = "40000000-0000-0000-0000-0000000000aa";
    await db.query(
      `insert into classes (id, sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count, price_vnd)
       values ($1, 'badminton', 'scratch', $2, $3, 'FREQ=WEEKLY;BYDAY=TU;BYHOUR=15', current_date + 3, current_date + 30, 60, 1, 'open', 0, 300000)`,
      [classId, coachId, validCourtId],
    );
    const a = { id: "00000000-0000-0000-0000-0000000001a1", phone: "+84900001a1", name: "A", role: "member" } as any;
    const b = { id: "00000000-0000-0000-0000-0000000001a2", phone: "+84900001a2", name: "B", role: "member" } as any;
    const c = { id: "00000000-0000-0000-0000-0000000001a3", phone: "+84900001a3", name: "C", role: "member" } as any;
    const d = { id: "00000000-0000-0000-0000-0000000001a4", phone: "+84900001a4", name: "D", role: "member" } as any;
    for (const m of [a, b, c, d]) {
      await db.query(`insert into users (id, phone, full_name, name_normalized, role, password_hash) values ($1,$2,$3,$4,'member','hash') on conflict (id) do nothing`, [m.id, m.phone, m.name, m.name.toLowerCase()]);
      await db.query(`insert into subscriptions (user_id, plan_id, start_on, end_on, status) values ($1, (select id from membership_plans order by price_vnd limit 1), current_date - 1, current_date + 400, 'active')`, [m.id]);
    }
    const ea = await withTx(async (sql) => classesEnroll(sql, classId, new Request("http://localhost"), a));
    await db.query(`update enrollments set status='confirmed', hold_until=null where id=$1`, [(ea.body as any).enrollment.id]);
    for (const m of [b, c, d]) await withTx(async (sql) => classesEnroll(sql, classId, new Request("http://localhost"), m));
    await withTx(async (sql) => enrollmentDelete(sql, (ea.body as any).enrollment.id, a));
    const offers = (await db.query(`select o.* from waitlist_offers o join enrollments e on e.id=o.enrollment_id where e.class_id=$1`, [classId])).rows;
    assert.equal(offers.length, 1);
    // Touching C moves its row to the end of the heap, so compaction meets D (3 -> 2) before C leaves 2.
    await db.query(`update enrollments set price_vnd = price_vnd where class_id=$1 and user_id=$2`, [classId, c.id]);
    const r = await withTx(async (sql) => waitlistAccept(sql, (offers[0] as any).id, b));
    assert.equal((r.body as any).status, "hold");
    const re = await withTx(async (sql) => classesEnroll(sql, classId, new Request("http://localhost"), a));
    assert.equal((re.body as any).enrollment.status, "waitlisted");
    const pos = (await db.query(`select user_id, waitlist_pos from enrollments where class_id=$1 and status='waitlisted' order by waitlist_pos`, [classId])).rows.map((x: any) => [x.user_id, x.waitlist_pos]);
    assert.deepEqual(pos, [[c.id, 1], [d.id, 2], [a.id, 3]]);
    await db.query(`delete from waitlist_offers where enrollment_id in (select id from enrollments where class_id=$1)`, [classId]);
    await db.query(`delete from enrollments where class_id=$1`, [classId]);
    await db.query(`delete from classes where id=$1`, [classId]);
  });

  it("inviteWaitlist offers one seat per open place, not only the first person", async () => {
    const coachId = "00000000-0000-0000-0000-000000000011";
    const classId = "40000000-0000-0000-0000-000000000191";
    const members = [1, 2, 3].map((n) => ({
      id: `00000000-0000-0000-0000-00000000019${n}`,
      phone: `+8490000019${n}`,
      name: `Wait ${n}`,
    }));
    try {
      await db.query(
        `insert into classes (id, sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count)
         values ($1, 'badminton', 'wl-seats', $2, $3, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=8', current_date + 1, current_date + 14, 60, 3, 'open', 0)`,
        [classId, coachId, validCourtId],
      );
      for (const [i, m] of members.entries()) {
        await db.query(
          `insert into users (id, phone, full_name, name_normalized, role, password_hash)
           values ($1, $2, $3, $4, 'member', 'hash') on conflict (id) do nothing`,
          [m.id, m.phone, m.name, m.name.toLowerCase()],
        );
        await db.query(
          `insert into enrollments (class_id, user_id, status, waitlist_pos) values ($1, $2, 'waitlisted', $3)`,
          [classId, m.id, i + 1],
        );
      }
      await withTx(async (sql) => inviteWaitlist(sql, classId));
      const offers = (
        await db.query<{ n: number }>(
          `select count(*)::int as n from waitlist_offers o
             join enrollments e on e.id = o.enrollment_id
            where e.class_id = $1 and o.status = 'pending'`,
          [classId],
        )
      ).rows[0];
      assert.equal(offers.n, 3);
    } finally {
      await db.query("delete from waitlist_offers where enrollment_id in (select id from enrollments where class_id = $1)", [classId]);
      await db.query("delete from enrollments where class_id = $1", [classId]);
      await db.query("delete from classes where id = $1", [classId]);
    }
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

  it("F-11: change password in session 1 -> session 2 is revoked, session 1 stays signed in", async () => {
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
      assert.equal((res.body as any).signed_out, 1);
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

      // Session 1 stays signed in
      const u1 = await authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${s1.token}` } }));
      assert.equal(u1.id, userId);
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
    // Dates are relative to "now" and far past the seeded bookings: the seed
    // fills the courts for the next days, so fixed dates collided with it
    // (409 on the valid reschedule) and went stale once the day passed.
    const ictDay = (plusDays: number) =>
      new Date(Date.now() + plusDays * 86400000 + 7 * 3600000).toISOString().slice(0, 10);
    const dStart = ictDay(40);
    const dMove = ictDay(41);
    const dEnd = ictDay(55);
    const dPast = ictDay(70);
    const clId = (
      await db.query<{ id: string }>(
        `insert into classes (sport, level, coach_id, court_id, capacity, rrule, duration_min, start_on, end_on, status)
         values ('badminton', 'ss-test', $1, $2, 10, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10', 60, '${dStart}', '${dEnd}', 'open')
         returning id`,
        [coachUser.id, badmintonCourtId],
      )
    ).rows[0].id;

    const occId = (await db.query<{ id: string }>(`
      insert into occupancies (court_id, start_at, end_at, kind, ref_id)
      values ($1, '${dStart} 10:00:00+07', '${dStart} 11:00:00+07', 'session', gen_random_uuid())
      returning id
    `, [badmintonCourtId])).rows[0].id;

    const sessId = (
      await db.query<{ id: string }>(
        `insert into sessions (class_id, court_id, start_at, end_at, status, occupancy_id)
         values ($1, $2, '${dStart} 10:00:00+07', '${dStart} 11:00:00+07', 'scheduled', $3)
         returning id`,
        [clId, badmintonCourtId, occId],
      )
    ).rows[0].id;

    await withTx(async (sql) => {
      // SS-18: reschedule to 03:00 (outside opening hours) -> 422 BR-06
      const req0300 = new Request(`http://localhost/v1/sessions/${sessId}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ start_at: `${dStart}T03:00:00.000+07:00`, reason: "test 03:00" }),
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
        body: JSON.stringify({ start_at: `${dPast}T10:00:00.000+07:00`, reason: "test past end" }),
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
        body: JSON.stringify({ start_at: `${dMove}T10:00:00.000+07:00`, reason: "test valid reschedule" }),
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
      values ($1, now() + interval '300 days', now() + interval '300 days 1 hour', 'session', gen_random_uuid())
      returning id
    `, [badmintonCourtId])).rows[0].id;

    const sessNoResults = (
      await db.query<{ id: string }>(
        `insert into sessions (class_id, court_id, start_at, end_at, status, occupancy_id)
         values ($1, $2, now() + interval '300 days', now() + interval '300 days 1 hour', 'scheduled', $3)
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
      avatar_url: null,
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
      avatar_url: null,
    };

    // Anyone may message anyone: a member reaches a coach before enrolling.
    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipient_id: coach.id }),
      });
      const res = await chatH.createOrGetConversation(sql, member, req);
      assert.ok(res.conversation!.id);
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

  describe("Task A2: manager-approved cash refund in till shift (SU-FL05-01)", () => {
    const receptionistUser = { id: "00000000-0000-0000-0000-a20000000001", role: "receptionist", full_name: "A2 Receptionist" } as any;
    const managerUser = { id: "00000000-0000-0000-0000-a20000000002", role: "manager", full_name: "A2 Manager" } as any;
    const bookingId = "30000000-0000-0000-0000-a20000000003";

    async function setupA2() {
      await db.query("delete from payments where ref_id = $1", [bookingId]);
      await db.query("delete from cashier_shifts where receptionist_id in ($1, $2)", [receptionistUser.id, managerUser.id]);
      await db.query("delete from users where id in ($1, $2) or phone in ('+84999999002', '+84999999003')", [receptionistUser.id, managerUser.id]);

      await db.query(
        `insert into users (id, phone, full_name, name_normalized, role, password_hash)
         values ($1, '+84999999002', $2, 'a2 receptionist', 'receptionist', 'hash'),
                ($3, '+84999999003', $4, 'a2 manager', 'manager', 'hash')`,
        [receptionistUser.id, receptionistUser.full_name, managerUser.id, managerUser.full_name],
      );
    }

    async function seedBasePayment(shiftId: string, amount = 1_500_000) {
      const pay = (await db.query<{ id: string }>(
        `insert into payments (code, shift_id, method, amount_vnd, vat_rate, status, ref_type, ref_id)
         values ('PAY-A2-' || substr(gen_random_uuid()::text, 1, 8), $1, 'cash', $2, 8, 'posted', 'booking', $3)
         returning id`,
        [shiftId, amount, bookingId],
      )).rows[0];
      return pay.id;
    }

    it("A2-1: receptionist with no open shift, refund >= refund_manager_vnd -> throws BR-44, no payment row inserted", async () => {
      await setupA2();
      // Ensure no open shift
      await db.query("update cashier_shifts set closed_at = now() where receptionist_id = $1", [receptionistUser.id]);

      // Seed an unattached positive payment
      const payId = (await db.query<{ id: string }>(
        `insert into payments (code, method, amount_vnd, vat_rate, status, ref_type, ref_id)
         values ('PAY-A2-NO-SHIFT', 'cash', 1000000, 8, 'posted', 'booking', $1)
         returning id`,
        [bookingId],
      )).rows[0].id;

      const req = new Request("http://localhost/v1/payments/" + payId + "/refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount_vnd: 800000, reason: "Refund test" }),
      });

      await assert.rejects(
        () => withTx(async (sql) => paymentsRefund(sql, payId, req, receptionistUser)),
        (e: any) => e.extra?.br === "BR-44",
      );

      const count = (await db.query<{ c: number }>(
        `select count(*)::int as c from payments where status = 'refund_pending' and ref_id = $1`,
        [bookingId],
      )).rows[0].c;
      assert.equal(count, 0);
    });

    it("A2-2: receptionist with an open shift S1, large refund -> refund_pending row has shift_id = S1", async () => {
      await setupA2();
      const s1 = (await db.query<{ id: string }>(
        `insert into cashier_shifts (receptionist_id) values ($1) returning id`,
        [receptionistUser.id],
      )).rows[0].id;

      const payId = await seedBasePayment(s1);

      const req = new Request("http://localhost/v1/payments/" + payId + "/refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount_vnd: 1000000, reason: "Move out" }),
      });
      const res = await withTx(async (sql) => paymentsRefund(sql, payId, req, receptionistUser));
      assert.equal(res.status, 201);
      assert.equal((res.body as any).payment?.status, "refund_pending");
      assert.equal((res.body as any).payment?.shift_id, s1);
    });

    it("A2-3: manager approves while S1 is still open -> posted, shift_id = S1, cash total drops", async () => {
      await setupA2();
      const s1 = (await db.query<{ id: string }>(
        `insert into cashier_shifts (receptionist_id) values ($1) returning id`,
        [receptionistUser.id],
      )).rows[0].id;

      const payId = await seedBasePayment(s1, 1500000);

      const reqCurrent = new Request("http://localhost/v1/shifts/current");
      const curBefore = await withTx(async (sql) => shiftCurrent(sql, receptionistUser, reqCurrent));
      const cashBefore = (curBefore.body as any).totals?.cash;

      const reqPending = new Request("http://localhost/v1/payments/" + payId + "/refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount_vnd: 1000000, reason: "Refund" }),
      });
      const resPending = await withTx(async (sql) => paymentsRefund(sql, payId, reqPending, receptionistUser));
      const pendingId = (resPending.body as any).payment.id;

      const reqApprove = new Request("http://localhost/v1/payments/" + pendingId + "/approve-refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Approved" }),
      });
      const resApprove = await withTx(async (sql) => paymentsApproveRefund(sql, pendingId, reqApprove, managerUser));
      assert.equal(resApprove.status, 200);

      const checkRow = (await db.query<{ status: string; shift_id: string }>(
        `select status, shift_id from payments where id = $1`,
        [pendingId],
      )).rows[0];
      assert.equal(checkRow.status, "posted");
      assert.equal(checkRow.shift_id, s1);

      const curAfter = await withTx(async (sql) => shiftCurrent(sql, receptionistUser, reqCurrent));
      assert.equal((curAfter.body as any).totals?.cash, cashBefore - 1000000);
    });

    it("A2-4: S1 closes -> receptionist opens S2 -> approve -> shift_id = S2; S1's figures unchanged", async () => {
      await setupA2();
      const s1 = (await db.query<{ id: string }>(
        `insert into cashier_shifts (receptionist_id) values ($1) returning id`,
        [receptionistUser.id],
      )).rows[0].id;

      const payId = await seedBasePayment(s1, 1500000);

      const reqPending = new Request("http://localhost/v1/payments/" + payId + "/refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount_vnd: 1000000, reason: "Refund" }),
      });
      const resPending = await withTx(async (sql) => paymentsRefund(sql, payId, reqPending, receptionistUser));
      const pendingId = (resPending.body as any).payment.id;

      // Close S1
      await db.query("update cashier_shifts set closed_at = now() where id = $1", [s1]);
      const s1Totals = (await db.query<{ cash: number }>(
        `select coalesce(sum(amount_vnd) filter (where method = 'cash' and status = 'posted'), 0)::int as cash from payments where shift_id = $1`,
        [s1],
      )).rows[0].cash;
      assert.equal(s1Totals, 1500000);

      // Receptionist opens S2
      const s2 = (await db.query<{ id: string }>(
        `insert into cashier_shifts (receptionist_id) values ($1) returning id`,
        [receptionistUser.id],
      )).rows[0].id;

      // Seed some intake in S2
      await seedBasePayment(s2, 2000000);

      // Manager approves
      const reqApprove = new Request("http://localhost/v1/payments/" + pendingId + "/approve-refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Approved in new shift" }),
      });
      const resApprove = await withTx(async (sql) => paymentsApproveRefund(sql, pendingId, reqApprove, managerUser));
      assert.equal(resApprove.status, 200);

      const checkRow = (await db.query<{ status: string; shift_id: string }>(
        `select status, shift_id from payments where id = $1`,
        [pendingId],
      )).rows[0];
      assert.equal(checkRow.status, "posted");
      assert.equal(checkRow.shift_id, s2);

      // S1 figures remain 1500000
      const s1After = (await db.query<{ cash: number }>(
        `select coalesce(sum(amount_vnd) filter (where method = 'cash' and status = 'posted'), 0)::int as cash from payments where shift_id = $1`,
        [s1],
      )).rows[0].cash;
      assert.equal(s1After, 1500000);

      // S2 cash dropped by 1000000 (2000000 - 1000000 = 1000000)
      const s2Totals = (await db.query<{ cash: number }>(
        `select coalesce(sum(amount_vnd) filter (where method = 'cash' and status = 'posted'), 0)::int as cash from payments where shift_id = $1`,
        [s2],
      )).rows[0].cash;
      assert.equal(s2Totals, 1000000);
    });

    it("A2-5: S1 closes, no new shift -> approve refused; payment still refund_pending", async () => {
      await setupA2();
      const s1 = (await db.query<{ id: string }>(
        `insert into cashier_shifts (receptionist_id) values ($1) returning id`,
        [receptionistUser.id],
      )).rows[0].id;

      const payId = await seedBasePayment(s1, 1500000);

      const reqPending = new Request("http://localhost/v1/payments/" + payId + "/refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount_vnd: 1000000, reason: "Refund" }),
      });
      const resPending = await withTx(async (sql) => paymentsRefund(sql, payId, reqPending, receptionistUser));
      const pendingId = (resPending.body as any).payment.id;

      // Close S1 and ensure no open shift
      await db.query("update cashier_shifts set closed_at = now() where receptionist_id = $1", [receptionistUser.id]);

      const reqApprove = new Request("http://localhost/v1/payments/" + pendingId + "/approve-refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Approved" }),
      });

      await assert.rejects(
        () => withTx(async (sql) => paymentsApproveRefund(sql, pendingId, reqApprove, managerUser)),
        (e: any) => e.code === "CONFLICT_STATE",
      );

      const checkRow = (await db.query<{ status: string; shift_id: string }>(
        `select status, shift_id from payments where id = $1`,
        [pendingId],
      )).rows[0];
      assert.equal(checkRow.status, "refund_pending");
      assert.equal(checkRow.shift_id, s1);
    });

    it("A2-6: reject (decideRefund approve=false) -> shift_id unchanged, status refund_rejected", async () => {
      await setupA2();
      const s1 = (await db.query<{ id: string }>(
        `insert into cashier_shifts (receptionist_id) values ($1) returning id`,
        [receptionistUser.id],
      )).rows[0].id;

      const payId = await seedBasePayment(s1, 1500000);

      const reqPending = new Request("http://localhost/v1/payments/" + payId + "/refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount_vnd: 1000000, reason: "Refund" }),
      });
      const resPending = await withTx(async (sql) => paymentsRefund(sql, payId, reqPending, receptionistUser));
      const pendingId = (resPending.body as any).payment.id;

      // Close S1 - reject should still work even if S1 is closed!
      await db.query("update cashier_shifts set closed_at = now() where receptionist_id = $1", [receptionistUser.id]);

      const reqReject = new Request("http://localhost/v1/payments/" + pendingId + "/reject-refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Denied by manager" }),
      });
      const resReject = await withTx(async (sql) => paymentsRejectRefund(sql, pendingId, reqReject, managerUser));
      assert.equal(resReject.status, 200);

      const checkRow = (await db.query<{ status: string; shift_id: string }>(
        `select status, shift_id from payments where id = $1`,
        [pendingId],
      )).rows[0];
      assert.equal(checkRow.status, "refund_rejected");
      assert.equal(checkRow.shift_id, s1);
    });
  });

  describe("Task B: self-service user avatars", () => {
    function makePng(width = 64, height = 64): Buffer {
      const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const ihdr = Buffer.alloc(25);
      ihdr.writeUInt32BE(13, 0);
      ihdr.write("IHDR", 4, 4, "ascii");
      ihdr.writeUInt32BE(width, 8);
      ihdr.writeUInt32BE(height, 12);
      ihdr[16] = 8;
      ihdr[17] = 6;
      ihdr[18] = 0;
      ihdr[19] = 0;
      ihdr[20] = 0;
      ihdr.writeUInt32BE(0, 21);
      return Buffer.concat([sig, ihdr]);
    }

    function makeJpeg(width = 100, height = 100, withApp0 = true): Buffer {
      const parts: Buffer[] = [];
      if (withApp0) {
        const app0 = Buffer.alloc(18);
        app0[0] = 0xff;
        app0[1] = 0xe0;
        app0.writeUInt16BE(16, 2);
        app0.write("JFIF\0", 4, "ascii");
        parts.push(Buffer.from([0xff, 0xd8]), app0);
      } else {
        parts.push(Buffer.from([0xff, 0xd8]));
      }
      const sof0 = Buffer.alloc(19);
      sof0[0] = 0xff;
      sof0[1] = 0xc0;
      sof0.writeUInt16BE(17, 2);
      sof0[4] = 8;
      sof0.writeUInt16BE(height, 5);
      sof0.writeUInt16BE(width, 7);
      parts.push(sof0);
      return Buffer.concat(parts);
    }

    function makeWebpVP8X(width = 120, height = 90): Buffer {
      const buf = Buffer.alloc(32);
      buf.write("RIFF", 0, "ascii");
      buf.writeUInt32LE(24, 4);
      buf.write("WEBP", 8, "ascii");
      buf.write("VP8X", 12, "ascii");
      buf.writeUInt32LE(10, 16);
      const w = width - 1;
      buf[24] = w & 0xff;
      buf[25] = (w >> 8) & 0xff;
      buf[26] = (w >> 16) & 0xff;
      const h = height - 1;
      buf[27] = h & 0xff;
      buf[28] = (h >> 8) & 0xff;
      buf[29] = (h >> 16) & 0xff;
      return buf;
    }

    it("sniffAvatar: covers PNG, JPEG with APP0, WebP VP8X, truncated, and empty buffer", () => {
      const png = sniffAvatar(makePng(64, 64));
      assert.deepEqual(png, { mime: "image/png", width: 64, height: 64 });

      const jpeg = sniffAvatar(makeJpeg(100, 80, true));
      assert.deepEqual(jpeg, { mime: "image/jpeg", width: 100, height: 80 });

      const webp = sniffAvatar(makeWebpVP8X(120, 90));
      assert.deepEqual(webp, { mime: "image/webp", width: 120, height: 90 });

      assert.equal(sniffAvatar(Buffer.from([0x89, 0x50, 0x4e])), null);
      assert.equal(sniffAvatar(Buffer.alloc(0)), null);
    });

    const memberA = { id: "00000000-0000-0000-0000-b00000000001", role: "member", full_name: "Member A", phone: "+84999999081" } as any;
    const memberB = { id: "00000000-0000-0000-0000-b00000000002", role: "member", full_name: "Member B", phone: "+84999999082" } as any;
    const staffCoach = { id: "00000000-0000-0000-0000-b00000000003", role: "coach", full_name: "Coach B", phone: "+84999999083" } as any;

    async function setupTaskB() {
      await db.query("delete from user_avatars where user_id in ($1, $2, $3)", [memberA.id, memberB.id, staffCoach.id]);
      await db.query("delete from conversations where id = '00000000-0000-0000-0000-b00000000099'");
      await db.query("delete from users where id in ($1, $2, $3) or phone in ('+84999999081', '+84999999082', '+84999999083')", [memberA.id, memberB.id, staffCoach.id]);
      await db.query(
        `insert into users (id, phone, full_name, name_normalized, role, password_hash)
         values ($1, $2, $3, 'member a', 'member', 'hash'),
                ($4, $5, $6, 'member b', 'member', 'hash'),
                ($7, $8, $9, 'coach b', 'coach', 'hash')`,
        [memberA.id, memberA.phone, memberA.full_name, memberB.id, memberB.phone, memberB.full_name, staffCoach.id, staffCoach.phone, staffCoach.full_name],
      );
    }

    it("B-1: member PUTs a valid 64x64 PNG -> 200, avatar_url ends in ?v=1, audit row created with no bytes", async () => {
      await setupTaskB();
      const req = new Request("http://localhost/v1/me/avatar", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data_base64: makePng(64, 64).toString("base64") }),
      });
      const res = await withTx(async (sql) => meAvatarPut(sql, req, memberA));
      assert.equal(res.status, 200);
      const user = (res.body as any).user;
      assert.match(user.avatar_url, /\/v1\/users\/00000000-0000-0000-0000-b00000000001\/avatar\?v=1$/);

      const audits = (await db.query<{ action: string; after: string }>(
        `select action, after from audit_logs where action = 'avatar_set' and actor_id = $1`,
        [memberA.id],
      )).rows;
      assert.equal(audits.length, 1);
      const after = typeof audits[0].after === "string" ? JSON.parse(audits[0].after) : audits[0].after;
      assert.equal(after.mime, "image/png");
      assert.equal(after.width, 64);
      assert.equal(after.height, 64);
      assert.equal(after.bytes > 0, true);
      assert.equal(after.data, undefined);
    });

    it("B-2: PUT again -> ?v=2", async () => {
      const req = new Request("http://localhost/v1/me/avatar", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data_base64: makePng(128, 128).toString("base64") }),
      });
      const res = await withTx(async (sql) => meAvatarPut(sql, req, memberA));
      assert.equal(res.status, 200);
      const user = (res.body as any).user;
      assert.match(user.avatar_url, /\?v=2$/);
    });

    it("B-3: 2 MB + 1 byte -> field error file", async () => {
      const bigBuf = Buffer.alloc(2 * 1024 * 1024 + 1);
      const req = new Request("http://localhost/v1/me/avatar", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data_base64: bigBuf.toString("base64") }),
      });
      await assert.rejects(
        () => withTx(async (sql) => meAvatarPut(sql, req, memberA)),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "file");
          assert.match(err.message, /2 MB/);
          return true;
        },
      );
    });

    it("B-4: SVG (<svg ...>), a renamed .exe (MZ...), random bytes -> field error file", async () => {
      for (const raw of ["<svg width='100' height='100'></svg>", "MZ9999renamedexe", "randombytes12345678901234567890"]) {
        const req = new Request("http://localhost/v1/me/avatar", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data_base64: Buffer.from(raw).toString("base64") }),
        });
        await assert.rejects(
          () => withTx(async (sql) => meAvatarPut(sql, req, memberA)),
          (err: any) => {
            assert.equal(err.status, 400);
            assert.equal(err.extra?.field, "file");
            return true;
          },
        );
      }
    });

    it("B-5: 32x32 PNG; PNG with IHDR 5000x10 -> field error file", async () => {
      for (const [w, h] of [[32, 32], [5000, 10]]) {
        const req = new Request("http://localhost/v1/me/avatar", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data_base64: makePng(w, h).toString("base64") }),
        });
        await assert.rejects(
          () => withTx(async (sql) => meAvatarPut(sql, req, memberA)),
          (err: any) => {
            assert.equal(err.status, 400);
            assert.equal(err.extra?.field, "file");
            assert.match(err.message, /between 64 and 4096 pixels/);
            return true;
          },
        );
      }
    });

    it("B-6: GET own avatar -> 200, correct Content-Type, Cache-Control contains private, X-Content-Type-Options: nosniff", async () => {
      const res = await withTx(async (sql) => userAvatarGet(sql, memberA.id, memberA));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/png");
      assert.equal(res.headers.get("cache-control")?.includes("private"), true);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("etag"), '"2"');
    });

    it("B-7: GET without a token -> 401", async () => {
      await assert.rejects(
        () => withTx(async (sql) => userAvatarGet(sql, memberA.id, null)),
        (err: any) => {
          assert.equal(err.status, 401);
          return true;
        },
      );
    });

    it("B-8: member A GETs member B (no conversation) -> 404", async () => {
      await assert.rejects(
        () => withTx(async (sql) => userAvatarGet(sql, memberB.id, memberA)),
        (err: any) => {
          assert.equal(err.status, 404);
          return true;
        },
      );
    });

    it("B-9: member A GETs a staff member A has a conversation with; staff GETs a member -> 200", async () => {
      // Upload avatar for staffCoach
      const reqCoach = new Request("http://localhost/v1/me/avatar", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data_base64: makePng(64, 64).toString("base64") }),
      });
      await withTx(async (sql) => meAvatarPut(sql, reqCoach, staffCoach));

      // Create conversation
      await db.query(
        `insert into conversations (id, member_id, staff_id) values ('00000000-0000-0000-0000-b00000000099', $1, $2)`,
        [memberA.id, staffCoach.id],
      );

      // member A GETs staffCoach
      const res1 = await withTx(async (sql) => userAvatarGet(sql, staffCoach.id, memberA));
      assert.equal(res1.status, 200);

      // staffCoach GETs member A
      const res2 = await withTx(async (sql) => userAvatarGet(sql, memberA.id, staffCoach));
      assert.equal(res2.status, 200);
    });

    it("B-10: DELETE -> avatar_url = null; GET -> 404; DELETE again -> still 200", async () => {
      const resDel = await withTx(async (sql) => meAvatarDelete(sql, memberA));
      assert.equal(resDel.status, 200);
      assert.equal((resDel.body as any).user.avatar_url, null);

      await assert.rejects(
        () => withTx(async (sql) => userAvatarGet(sql, memberA.id, memberA)),
        (err: any) => {
          assert.equal(err.status, 404);
          return true;
        },
      );

      const resDelAgain = await withTx(async (sql) => meAvatarDelete(sql, memberA));
      assert.equal(resDelAgain.status, 200);
    });

    it("B-11: GET /me after an upload -> user.avatar_url present through authFromRequest", async () => {
      const req = new Request("http://localhost/v1/me/avatar", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data_base64: makePng(64, 64).toString("base64") }),
      });
      await withTx(async (sql) => meAvatarPut(sql, req, memberA));

      const sess = await withTx(async (sql) => issueSession(sql, memberA));
      const reqMe = new Request("http://localhost/v1/me", {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      const meUser = await withTx(async (sql) => authFromRequest(sql, reqMe));
      assert.match(meUser.avatar_url ?? "", /\/v1\/users\/00000000-0000-0000-0000-b00000000001\/avatar\?v=\d+$/);
    });

    it("B-12: user is deleted -> the user_avatars row is gone (cascade)", async () => {
      const tempUser = { id: "00000000-0000-0000-0000-b00000000089", role: "member", full_name: "Temp", phone: "+84999999089" } as any;
      await db.query(
        `insert into users (id, phone, full_name, name_normalized, role, password_hash)
         values ($1, $2, $3, 'temp', 'member', 'hash')`,
        [tempUser.id, tempUser.phone, tempUser.full_name],
      );
      const req = new Request("http://localhost/v1/me/avatar", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data_base64: makePng(64, 64).toString("base64") }),
      });
      await withTx(async (sql) => meAvatarPut(sql, req, tempUser));

      const beforeCount = (await db.query<{ count: number }>(
        `select count(*)::int as count from user_avatars where user_id = $1`,
        [tempUser.id],
      )).rows[0].count;
      assert.equal(beforeCount, 1);

      await db.query("delete from users where id = $1", [tempUser.id]);

      const afterCount = (await db.query<{ count: number }>(
        `select count(*)::int as count from user_avatars where user_id = $1`,
        [tempUser.id],
      )).rows[0].count;
      assert.equal(afterCount, 0);
    });
  });

  describe("Task W: fair waitlist order and free seat allocation (D5, D6)", () => {
    const coachW = { id: "00000000-0000-0000-0000-c00000000001", role: "coach", full_name: "Coach W" } as any;
    const courtW = "10000000-0000-0000-0000-000000000004";
    const classW = "40000000-0000-0000-0000-c00000000001";
    const memA = { id: "00000000-0000-0000-0000-c0000000000a", phone: "+84999999011", full_name: "An", role: "member" } as any;
    const memH = { id: "00000000-0000-0000-0000-c0000000000b", phone: "+84999999012", full_name: "Hoa", role: "member" } as any;
    const memN = { id: "00000000-0000-0000-0000-c0000000000c", phone: "+84999999013", full_name: "Nam", role: "member" } as any;
    const memL = { id: "00000000-0000-0000-0000-c0000000000d", phone: "+84999999014", full_name: "Linh", role: "member" } as any;

    async function setupW() {
      await db.query("delete from outbox where user_id in ($1, $2, $3, $4)", [memA.id, memH.id, memN.id, memL.id]);
      await db.query("delete from waitlist_offers where enrollment_id in (select id from enrollments where class_id = $1)", [classW]);
      await db.query("delete from enrollments where class_id = $1", [classW]);
      await db.query("delete from classes where id = $1", [classW]);
      await db.query("delete from subscriptions where user_id in ($1, $2, $3, $4)", [memA.id, memH.id, memN.id, memL.id]);
      await db.query("delete from users where id in ($1, $2, $3, $4, $5)", [memA.id, memH.id, memN.id, memL.id, coachW.id]);

      await db.query(
        `insert into users (id, phone, full_name, name_normalized, role, password_hash)
         values ($1, $2, $3, 'an', 'member', 'hash'),
                ($4, $5, $6, 'hoa', 'member', 'hash'),
                ($7, $8, $9, 'nam', 'member', 'hash'),
                ($10, $11, $12, 'linh', 'member', 'hash'),
                ($13, '+84999999015', $14, 'coach w', 'coach', 'hash')`,
        [memA.id, memA.phone, memA.full_name, memH.id, memH.phone, memH.full_name, memN.id, memN.phone, memN.full_name, memL.id, memL.phone, memL.full_name, coachW.id, coachW.full_name],
      );
      await db.query(
        `insert into subscriptions (user_id, plan_id, start_on, end_on, status)
         select u, (select id from membership_plans order by price_vnd limit 1), current_date - 1, current_date + 400, 'active'
           from unnest($1::uuid[]) as u`,
        [[memA.id, memH.id, memN.id, memL.id]],
      );

      await db.query(
        `insert into classes (id, sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count, price_vnd)
         values ($1, 'badminton', 'w-test', $2, $3, 'FREQ=WEEKLY;BYDAY=TU;BYHOUR=14', current_date + 1, current_date + 14, 60, 1, 'open', 0, 300000)`,
        [classW, coachW.id, courtW],
      );
    }

    it("W-1: QA scenario with capacity 1 (steps 1 to 6)", async () => {
      await setupW();

      // 1. A enrols (hold). H joins (waitlist 1). A leaves -> H has a pending offer.
      const enrA = await withTx(async (sql) => classesEnroll(sql, classW, new Request("http://localhost"), memA));
      assert.equal(enrA.status, 201);
      assert.equal((enrA.body as any).enrollment?.status, "hold");

      const enrH = await withTx(async (sql) => classesEnroll(sql, classW, new Request("http://localhost"), memH));
      assert.equal(enrH.status, 201);
      assert.equal((enrH.body as any).enrollment?.status, "waitlisted");
      const hRow1 = (await db.query<{ waitlist_pos: number }>("select waitlist_pos from enrollments where id = $1", [(enrH.body as any).enrollment.id])).rows[0];
      assert.equal(hRow1.waitlist_pos, 1);

      // A leaves -> triggers inviteWaitlist -> creates pending offer for H
      await withTx(async (sql) => enrollmentDelete(sql, (enrA.body as any).enrollment.id, memA));
      const offerH = (await db.query<{ id: string; status: string }>(
        "select id, status from waitlist_offers where enrollment_id = $1 and status = 'pending'",
        [(enrH.body as any).enrollment.id],
      )).rows[0];
      assert.ok(offerH);
      assert.equal(offerH.status, "pending");

      // 2. N enrols -> hold (takes the seat); H's offer is skipped; H is still waitlist 1
      const enrN = await withTx(async (sql) => classesEnroll(sql, classW, new Request("http://localhost"), memN));
      assert.equal(enrN.status, 201);
      assert.equal((enrN.body as any).enrollment?.status, "hold");

      const offerHAfter = (await db.query<{ status: string }>("select status from waitlist_offers where id = $1", [offerH.id])).rows[0];
      assert.equal(offerHAfter.status, "skipped");

      const hRow2 = (await db.query<{ status: string; waitlist_pos: number }>("select status, waitlist_pos from enrollments where id = $1", [(enrH.body as any).enrollment.id])).rows[0];
      assert.equal(hRow2.status, "waitlisted");
      assert.equal(hRow2.waitlist_pos, 1);

      // Verify inapp note waitlist_seat_taken queued for H
      const notes = (await db.query<{ template: string; user_id: string }>(
        "select template, user_id from outbox where user_id = $1 and template = 'waitlist_seat_taken'",
        [memH.id],
      )).rows;
      assert.equal(notes.length, 1);

      // 3. L enrols -> waitlist 2
      const enrL = await withTx(async (sql) => classesEnroll(sql, classW, new Request("http://localhost"), memL));
      assert.equal(enrL.status, 201);
      assert.equal((enrL.body as any).enrollment?.status, "waitlisted");
      const lRow1 = (await db.query<{ waitlist_pos: number }>("select waitlist_pos from enrollments where id = $1", [(enrL.body as any).enrollment.id])).rows[0];
      assert.equal(lRow1.waitlist_pos, 2);

      // 4. H accepts -> BR-21, H stays waitlist 1
      await assert.rejects(
        () => withTx(async (sql) => waitlistAccept(sql, offerH.id, memH)),
        (err: any) => {
          assert.equal(err.extra?.br, "BR-21");
          return true;
        },
      );
      const hRow3 = (await db.query<{ status: string; waitlist_pos: number }>("select status, waitlist_pos from enrollments where id = $1", [(enrH.body as any).enrollment.id])).rows[0];
      assert.equal(hRow3.status, "waitlisted");
      assert.equal(hRow3.waitlist_pos, 1);

      // 5. N leaves -> H gets a new offer, accepts -> hold; L is now waitlist 1
      await withTx(async (sql) => enrollmentDelete(sql, (enrN.body as any).enrollment.id, memN));
      const newOfferH = (await db.query<{ id: string; status: string }>(
        "select id, status from waitlist_offers where enrollment_id = $1 and status = 'pending'",
        [(enrH.body as any).enrollment.id],
      )).rows[0];
      assert.ok(newOfferH);

      const accRes = await withTx(async (sql) => waitlistAccept(sql, newOfferH.id, memH));
      assert.equal(accRes.status, 200);
      const hRow4 = (await db.query<{ status: string }>("select status from enrollments where id = $1", [(enrH.body as any).enrollment.id])).rows[0];
      assert.equal(hRow4.status, "hold");

      // L is now waitlist 1
      const lRow2 = (await db.query<{ status: string; waitlist_pos: number }>("select status, waitlist_pos from enrollments where id = $1", [(enrL.body as any).enrollment.id])).rows[0];
      assert.equal(lRow2.status, "waitlisted");
      assert.equal(lRow2.waitlist_pos, 1);

      // 6. L leaves the waitlist -> class has no waitlisted rows; positions of any others stay gap-free
      const delL = await withTx(async (sql) => enrollmentDelete(sql, (enrL.body as any).enrollment.id, memL));
      assert.equal(delL.status, 200);
      const remainingWl = (await db.query<{ count: number }>("select count(*)::int as count from enrollments where class_id = $1 and status = 'waitlisted'", [classW])).rows[0].count;
      assert.equal(remainingWl, 0);

      // Clean up
      await db.query("delete from waitlist_offers where enrollment_id in (select id from enrollments where class_id = $1)", [classW]);
      await db.query("delete from enrollments where class_id = $1", [classW]);
      await db.query("delete from classes where id = $1", [classW]);
    });

    it("W-2: expired offer drops its holder and moves everyone up by one (gap-free)", async () => {
      await setupW();

      // Enrol A (confirmed, fills capacity)
      await withTx(async (sql) => classesEnroll(sql, classW, new Request("http://localhost"), memA));

      // H joins (waitlist 1)
      const enrH = await withTx(async (sql) => classesEnroll(sql, classW, new Request("http://localhost"), memH));
      // N joins (waitlist 2)
      const enrN = await withTx(async (sql) => classesEnroll(sql, classW, new Request("http://localhost"), memN));
      // L joins (waitlist 3)
      const enrL = await withTx(async (sql) => classesEnroll(sql, classW, new Request("http://localhost"), memL));

      // Create an expired pending offer for H
      await db.query(
        `insert into waitlist_offers (enrollment_id, expires_at, status)
         values ($1, now() - interval '5 minutes', 'pending')`,
        [(enrH.body as any).enrollment.id],
      );

      // Run waitlistExpire job
      const expiredCount = await waitlistExpire();
      assert.ok(expiredCount >= 1);

      // H's enrollment should be cancelled
      const hRow = (await db.query<{ status: string; waitlist_pos: number | null }>("select status, waitlist_pos from enrollments where id = $1", [(enrH.body as any).enrollment.id])).rows[0];
      assert.equal(hRow.status, "cancelled");
      assert.equal(hRow.waitlist_pos, null);

      // N should now be waitlist 1
      const nRow = (await db.query<{ status: string; waitlist_pos: number }>("select status, waitlist_pos from enrollments where id = $1", [(enrN.body as any).enrollment.id])).rows[0];
      assert.equal(nRow.status, "waitlisted");
      assert.equal(nRow.waitlist_pos, 1);

      // L should now be waitlist 2
      const lRow = (await db.query<{ status: string; waitlist_pos: number }>("select status, waitlist_pos from enrollments where id = $1", [(enrL.body as any).enrollment.id])).rows[0];
      assert.equal(lRow.status, "waitlisted");
      assert.equal(lRow.waitlist_pos, 2);

      // Clean up
      await db.query("delete from waitlist_offers where enrollment_id in (select id from enrollments where class_id = $1)", [classW]);
      await db.query("delete from enrollments where class_id = $1", [classW]);
      await db.query("delete from classes where id = $1", [classW]);
    });
  });

  describe("Task M: full member profile for reception and manager", () => {
    const memM1 = { id: "e0000000-0000-0000-0000-000000000001", phone: "+84999992001", full_name: "M Member 1", role: "member" } as any;
    const memM2 = { id: "e0000000-0000-0000-0000-000000000002", phone: "+84999992002", full_name: "M Member 2", role: "member" } as any;
    const coachM = { id: "e0000000-0000-0000-0000-000000000003", phone: "+84999992003", full_name: "M Coach", role: "coach" } as any;
    const mgrM = { id: "e0000000-0000-0000-0000-000000000004", phone: "+84999992004", full_name: "M Manager", role: "manager" } as any;
    const recM = { id: "e0000000-0000-0000-0000-000000000005", phone: "+84999992005", full_name: "M Reception", role: "receptionist" } as any;

    const classM1 = "f0000000-0000-0000-0000-000000000001";
    const classM2 = "f0000000-0000-0000-0000-000000000002";
    const courtM = "10000000-0000-0000-0000-000000000001";
    const planM = "20000000-0000-0000-0000-000000000003";
    const subM1 = "e1000000-0000-0000-0000-000000000001";

    async function cleanupM() {
      await db.query("delete from attendance where user_id in ($1, $2)", [memM1.id, memM2.id]);
      await db.query("delete from waitlist_offers where enrollment_id in (select id from enrollments where class_id in ($1, $2))", [classM1, classM2]);
      await db.query("delete from enrollments where class_id in ($1, $2) or user_id in ($3, $4)", [classM1, classM2, memM1.id, memM2.id]);
      await db.query("delete from classes where id in ($1, $2)", [classM1, classM2]);
      await db.query("delete from subscriptions where user_id in ($1, $2)", [memM1.id, memM2.id]);
      await db.query("delete from payments where user_id in ($1, $2)", [memM1.id, memM2.id]);
      await db.query("delete from users where id in ($1, $2, $3, $4, $5)", [memM1.id, memM2.id, coachM.id, mgrM.id, recM.id]);
    }

    async function setupM() {
      await cleanupM();
      for (const u of [coachM, mgrM, recM]) {
        await db.query(
          `insert into users (id, phone, full_name, name_normalized, role, password_hash)
           values ($1, $2, $3, $4, $5, 'hash')`,
          [u.id, u.phone, u.full_name, u.full_name.toLowerCase(), u.role],
        );
      }
      await db.query(
        `insert into users (id, phone, full_name, name_normalized, role, password_hash, email, status, date_of_birth, pii_consent_at, guardian_name, guardian_phone, created_at)
         values ($1, $2, $3, $4, 'member', 'hash', 'm1@example.com', 'active', '2008-05-15', now(), 'Guardian One', '+84999992099', now() - interval '60 days')`,
        [memM1.id, memM1.phone, memM1.full_name, memM1.full_name.toLowerCase()],
      );
      await db.query(
        `insert into users (id, phone, full_name, name_normalized, role, password_hash, status, date_of_birth, created_at)
         values ($1, $2, $3, $4, 'member', 'hash', 'active', '1995-10-20', now() - interval '100 days')`,
        [memM2.id, memM2.phone, memM2.full_name, memM2.full_name.toLowerCase()],
      );

      await db.query(
        `insert into classes (id, sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count)
         values ($1, 'badminton', 'Beginner', $2, $3, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=18', current_date - 10, current_date + 30, 60, 5, 'open', 1)`,
        [classM1, coachM.id, courtM],
      );
      await db.query(
        `insert into classes (id, sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count)
         values ($1, 'badminton', 'Advanced', $2, $3, 'FREQ=WEEKLY;BYDAY=TH;BYHOUR=19', current_date - 10, current_date + 30, 60, 5, 'open', 1)`,
        [classM2, coachM.id, courtM],
      );

      await db.query(
        `insert into subscriptions (id, user_id, plan_id, start_on, end_on, status, session_left, price_vnd)
         values ($1, $2, $3, current_date - 5, current_date + 25, 'active', 7, 500000)`,
        [subM1, memM1.id, planM],
      );

      const enr1 = "e2000000-0000-0000-0000-000000000001";
      const enr2 = "e2000000-0000-0000-0000-000000000002";
      await db.query(
        `insert into enrollments (id, class_id, user_id, status, waitlist_pos)
         values ($1, $2, $3, 'confirmed', null)`,
        [enr1, classM1, memM1.id],
      );
      await db.query(
        `insert into enrollments (id, class_id, user_id, status, waitlist_pos)
         values ($1, $2, $3, 'waitlisted', 1)`,
        [enr2, classM2, memM1.id],
      );
      await db.query(
        `insert into waitlist_offers (id, enrollment_id, status, expires_at)
         values ('e3000000-0000-0000-0000-000000000001', $1, 'pending', now() + interval '2 hours')`,
        [enr2],
      );

      await db.query(
        `insert into attendance (user_id, kind, result, at)
         values
           ($1, 'session', 'present', now() - interval '2 days'),
           ($1, 'session', 'late', now() - interval '5 days'),
           ($1, 'session', 'absent', now() - interval '10 days'),
           ($1, 'session', 'excused', now() - interval '15 days'),
           ($1, 'session', 'present', now() - interval '40 days')`,
        [memM1.id],
      );

      await db.query(
        `insert into payments (id, user_id, code, method, amount_vnd, vat_rate, status, ref_type, ref_id)
         values ('e4000000-0000-0000-0000-000000000001', $1, 'PAY-M1', 'cash', 500000, 8, 'posted', 'subscription', $2)`,
        [memM1.id, subM1],
      );
    }

    after(async () => {
      await cleanupM();
    });

    it("memberGet returns full profile: user fields, subscriptions, enrollments, attendance_summary", async () => {
      await setupM();
      const res = await withTx(async (sql) => memberGet(sql, memM1.id, mgrM));
      assert.equal(res.status, 200);
      const b = res.body as any;

      assert.equal(b.user.id, memM1.id);
      assert.equal(b.user.email, "m1@example.com");
      assert.equal(b.user.status, "active");
      assert.ok(b.user.created_at);
      assert.ok(b.user.pii_consent_at);

      assert.equal(b.guardian.name, "Guardian One");
      assert.equal(b.guardian.phone, "+84999992099");

      // memberGet still returns the member's plan orders (the desk takes payment from them),
      // so the contract is the seeded subscription, not the absence of the key.
      assert.ok(Array.isArray(b.subscriptions));
      assert.equal(b.subscriptions.length, 1);
      assert.equal(b.subscriptions[0].id, subM1);
      assert.equal(b.subscriptions[0].status, "active");
      assert.equal(b.subscriptions[0].session_left, 7);
      assert.equal(b.subscriptions[0].price_vnd, 500000);
      assert.equal(b.subscriptions[0].due_vnd, 500000);

      assert.equal(b.enrollments.length, 2);
      const conf = b.enrollments.find((e: any) => e.status === "confirmed");
      assert.ok(conf);
      assert.equal(conf.coach_name, "M Coach");
      const wait = b.enrollments.find((e: any) => e.status === "waitlisted");
      assert.ok(wait);
      assert.equal(wait.waitlist_pos, 1);
      assert.equal(wait.offer_pending, true);
      assert.ok(wait.offer_expires_at);

      assert.equal(b.attendance_summary.present, 1);
      assert.equal(b.attendance_summary.late, 1);
      assert.equal(b.attendance_summary.absent, 1);
      assert.equal(b.attendance_summary.excused, 1);
      assert.ok(b.attendance_summary.last_visit_at);

      assert.ok(b.payments && b.payments.length >= 1);
    });

    it("memberGet for coach strips payments and pii_consent_at, forbids non-taught member", async () => {
      await setupM();

      const res = await withTx(async (sql) => memberGet(sql, memM1.id, coachM));
      assert.equal(res.status, 200);
      const b = res.body as any;
      assert.equal(b.payments, undefined);
      assert.equal(b.user.pii_consent_at, undefined);

      await assert.rejects(
        () => withTx(async (sql) => memberGet(sql, memM2.id, coachM)),
        (err: any) => err.status === 403,
      );
    });

    it("membersDirectory returns date_of_birth for members", async () => {
      await setupM();
      const req = new Request("http://localhost?limit=10&q=M%20Member");
      const res = await withTx(async (sql) => membersDirectory(sql, req, mgrM));
      assert.equal(res.status, 200);
      const b = res.body as any;
      const m1 = b.items.find((r: any) => r.id === memM1.id);
      assert.ok(m1);
      assert.equal(m1.date_of_birth, "2008-05-15");
      const m2 = b.items.find((r: any) => r.id === memM2.id);
      assert.ok(m2);
      assert.equal(m2.date_of_birth, "1995-10-20");
    });
  });

  describe("Task V: avatars wherever a name is listed", () => {
    function makePng(width = 64, height = 64): Buffer {
      const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const ihdr = Buffer.alloc(25);
      ihdr.writeUInt32BE(13, 0);
      ihdr.write("IHDR", 4, 4, "ascii");
      ihdr.writeUInt32BE(width, 8);
      ihdr.writeUInt32BE(height, 12);
      ihdr[16] = 8;
      ihdr[17] = 6;
      ihdr[18] = 0;
      ihdr[19] = 0;
      ihdr[20] = 0;
      ihdr.writeUInt32BE(0, 21);
      return Buffer.concat([sig, ihdr]);
    }

    const memV = { id: "d0000000-0000-0000-0000-000000000001", phone: "+84999993001", full_name: "V Member", role: "member" } as any;
    const coachV = { id: "d0000000-0000-0000-0000-000000000002", phone: "+84999993002", full_name: "V Coach", role: "coach" } as any;
    const mgrV = { id: "d0000000-0000-0000-0000-000000000003", phone: "+84999993003", full_name: "V Manager", role: "manager" } as any;
    const classV = "f0000000-0000-0000-0000-000000000010";
    const courtV = "10000000-0000-0000-0000-000000000001";

    async function cleanupV() {
      await db.query("delete from user_avatars where user_id in ($1, $2, $3)", [memV.id, coachV.id, mgrV.id]);
      await db.query("delete from enrollments where class_id = $1 or user_id = $2", [classV, memV.id]);
      await db.query("delete from classes where id = $1", [classV]);
      await db.query("delete from users where id in ($1, $2, $3)", [memV.id, coachV.id, mgrV.id]);
    }

    async function setupV() {
      await cleanupV();
      for (const u of [coachV, mgrV]) {
        await db.query(
          `insert into users (id, phone, full_name, name_normalized, role, password_hash)
           values ($1, $2, $3, $4, $5, 'hash')`,
          [u.id, u.phone, u.full_name, u.full_name.toLowerCase(), u.role],
        );
      }
      await db.query(
        `insert into users (id, phone, full_name, name_normalized, role, password_hash, status, date_of_birth)
         values ($1, $2, $3, $4, 'member', 'hash', 'active', '1990-01-01')`,
        [memV.id, memV.phone, memV.full_name, memV.full_name.toLowerCase()],
      );
      await db.query(
        `insert into classes (id, sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count)
         values ($1, 'badminton', 'Beginner', $2, $3, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=18', current_date - 1, current_date + 30, 60, 5, 'open', 1)`,
        [classV, coachV.id, courtV],
      );
      await db.query(
        `insert into enrollments (id, class_id, user_id, status)
         values ('d2000000-0000-0000-0000-000000000001', $1, $2, 'confirmed')`,
        [classV, memV.id],
      );
    }

    after(async () => {
      await cleanupV();
    });

    it("after meAvatarPut, membersDirectory, membersSearch, memberGet, and class roster return non-null avatar_url; after meAvatarDelete they return null", async () => {
      await setupV();

      // 1. Initially without avatar, all return avatar_url = null
      const initDir = await withTx(async (sql) => membersDirectory(sql, new Request("http://localhost?q=V%20Member"), mgrV));
      const initSearch = await withTx(async (sql) => membersSearch(sql, new Request("http://localhost?q=V%20Member"), mgrV));
      const initGet = await withTx(async (sql) => memberGet(sql, memV.id, mgrV));
      const initClass = await withTx(async (sql) => classDetail(sql, classV, mgrV));
      const initRoster = await withTx(async (sql) => classRoster(sql, classV, mgrV));

      assert.equal((initDir.body as any).items.find((r: any) => r.id === memV.id)?.avatar_url, null);
      assert.equal((initSearch.body as any).items.find((r: any) => r.id === memV.id)?.avatar_url, null);
      assert.equal((initGet.body as any).user.avatar_url, null);
      assert.equal((initClass.body as any).roster.find((r: any) => r.id === memV.id)?.avatar_url, null);
      assert.equal((initRoster.body as any).items.find((r: any) => r.id === memV.id)?.avatar_url, null);

      // 2. PUT avatar
      const reqPut = new Request("http://localhost/v1/me/avatar", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data_base64: makePng(64, 64).toString("base64") }),
      });
      const putRes = await withTx(async (sql) => meAvatarPut(sql, reqPut, memV));
      assert.equal(putRes.status, 200);

      // 3. Each returns non-null avatar_url
      const afterDir = await withTx(async (sql) => membersDirectory(sql, new Request("http://localhost?q=V%20Member"), mgrV));
      const afterSearch = await withTx(async (sql) => membersSearch(sql, new Request("http://localhost?q=V%20Member"), mgrV));
      const afterGet = await withTx(async (sql) => memberGet(sql, memV.id, mgrV));
      const afterClass = await withTx(async (sql) => classDetail(sql, classV, mgrV));
      const afterRoster = await withTx(async (sql) => classRoster(sql, classV, mgrV));

      const dirUrl = (afterDir.body as any).items.find((r: any) => r.id === memV.id)?.avatar_url;
      const searchUrl = (afterSearch.body as any).items.find((r: any) => r.id === memV.id)?.avatar_url;
      const getUrl = (afterGet.body as any).user.avatar_url;
      const classUrl = (afterClass.body as any).roster.find((r: any) => r.id === memV.id)?.avatar_url;
      const rosterUrl = (afterRoster.body as any).items.find((r: any) => r.id === memV.id)?.avatar_url;

      assert.ok(dirUrl && dirUrl.includes(`/v1/users/${memV.id}/avatar`));
      assert.ok(searchUrl && searchUrl.includes(`/v1/users/${memV.id}/avatar`));
      assert.ok(getUrl && getUrl.includes(`/v1/users/${memV.id}/avatar`));
      assert.ok(classUrl && classUrl.includes(`/v1/users/${memV.id}/avatar`));
      assert.ok(rosterUrl && rosterUrl.includes(`/v1/users/${memV.id}/avatar`));

      // 4. DELETE avatar
      const delRes = await withTx(async (sql) => meAvatarDelete(sql, memV));
      assert.equal(delRes.status, 200);

      // 5. Each returns null
      const finalDir = await withTx(async (sql) => membersDirectory(sql, new Request("http://localhost?q=V%20Member"), mgrV));
      const finalSearch = await withTx(async (sql) => membersSearch(sql, new Request("http://localhost?q=V%20Member"), mgrV));
      const finalGet = await withTx(async (sql) => memberGet(sql, memV.id, mgrV));
      const finalClass = await withTx(async (sql) => classDetail(sql, classV, mgrV));
      const finalRoster = await withTx(async (sql) => classRoster(sql, classV, mgrV));

      assert.equal((finalDir.body as any).items.find((r: any) => r.id === memV.id)?.avatar_url, null);
      assert.equal((finalSearch.body as any).items.find((r: any) => r.id === memV.id)?.avatar_url, null);
      assert.equal((finalGet.body as any).user.avatar_url, null);
      assert.equal((finalClass.body as any).roster.find((r: any) => r.id === memV.id)?.avatar_url, null);
      assert.equal((finalRoster.body as any).items.find((r: any) => r.id === memV.id)?.avatar_url, null);
    });
  });

describe("Account settings (profile page)", () => {
  it("validates mePatch full_name and health_notes", async () => {
    const phone = "0987000021";
    const pwHash = hashPassword("Pass123!");
    const userId = (
      await db.query<{ id: string }>(
        `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
         values (gen_random_uuid(), $1, 'Member TwentyOne', 'member twentyone', 'member', 'active', $2)
         returning id`,
        [phone, pwHash],
      )
    ).rows[0].id;
    const userPub = toPublic((await db.query("select * from users where id = $1", [userId])).rows[0] as any);

    // mePatch with full_name: "   " -> rejects with 400 and field === "full_name"
    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ full_name: "   " }),
      });
      await assert.rejects(
        async () => authH.mePatch(sql, req, userPub),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "full_name");
          return true;
        },
      );
    });

    // mePatch with a 121-character name -> 400, field === "full_name"
    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ full_name: "A".repeat(121) }),
      });
      await assert.rejects(
        async () => authH.mePatch(sql, req, userPub),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "full_name");
          return true;
        },
      );
    });

    // mePatch by a member with 1001-character health_notes -> 400, field === "health_notes"
    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ health_notes: "H".repeat(1001) }),
      });
      await assert.rejects(
        async () => authH.mePatch(sql, req, userPub),
        (err: any) => {
          assert.equal(err.status, 400);
          assert.equal(err.extra?.field, "health_notes");
          return true;
        },
      );
    });

    // mePatch by a member with health_notes: "  " -> stored as null
    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ health_notes: "  " }),
      });
      const res = await authH.mePatch(sql, req, userPub);
      assert.equal(res.status, 200);
      assert.equal((res.body as any).user.health_notes, null);
    });
    const checkDb = (await db.query<{ health_notes: string | null }>("select health_notes from users where id = $1", [userId])).rows[0];
    assert.equal(checkDb.health_notes, null);

    // mePatch by a coach with health_notes: "x" -> 200 and health_notes unchanged in database
    const coachPhone = "0987000022";
    const coachId = (
      await db.query<{ id: string }>(
        `insert into users (id, phone, full_name, name_normalized, role, status, password_hash, health_notes)
         values (gen_random_uuid(), $1, 'Coach TwentyTwo', 'coach twentytwo', 'coach', 'active', $2, 'initial notes')
         returning id`,
        [coachPhone, pwHash],
      )
    ).rows[0].id;
    const coachPub = toPublic((await db.query("select * from users where id = $1", [coachId])).rows[0] as any);

    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ health_notes: "x" }),
      });
      const res = await authH.mePatch(sql, req, coachPub);
      assert.equal(res.status, 200);
    });
    const coachDb = (await db.query<{ health_notes: string | null }>("select health_notes from users where id = $1", [coachId])).rows[0];
    assert.equal(coachDb.health_notes, "initial notes");
  });

  it("handles meProfile for member and coach correctly", async () => {
    const pwHash = hashPassword("Pass123!");
    // meProfile for a member with a guardian -> guardian.name matches, coach === null
    const memberGuardPhone = "0987000023";
    const memberGuardId = (
      await db.query<{ id: string }>(
        `insert into users (id, phone, full_name, name_normalized, role, status, password_hash, guardian_name, guardian_phone, pii_consent_at)
         values (gen_random_uuid(), $1, 'Member With Guardian', 'member with guardian', 'member', 'active', $2, 'Parent Guardian', '0912345678', now())
         returning id`,
        [memberGuardPhone, pwHash],
      )
    ).rows[0].id;
    const memberGuardPub = toPublic((await db.query("select * from users where id = $1", [memberGuardId])).rows[0] as any);
    let sGuard: any;
    await withTx(async (sql) => {
      sGuard = await issueSession(sql, memberGuardPub);
    });
    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/me/profile", {
        headers: { authorization: `Bearer ${sGuard.token}` },
      });
      const res = await authH.meProfile(sql, req, memberGuardPub);
      assert.equal(res.status, 200);
      const b = res.body as any;
      assert.equal(b.guardian?.name, "Parent Guardian");
      assert.equal(b.guardian?.phone, "0912345678");
      assert.ok(b.pii_consent_at);
      assert.equal(b.coach, null);
    });

    // meProfile for a coach with one coach_sports row and no coach_rates row -> sports has that sport, rates are 150000 / 10000, guardian === null
    const coachProfPhone = "0987000024";
    const coachProfId = (
      await db.query<{ id: string }>(
        `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
         values (gen_random_uuid(), $1, 'Coach Profile', 'coach profile', 'coach', 'active', $2)
         returning id`,
        [coachProfPhone, pwHash],
      )
    ).rows[0].id;
    await db.query(`insert into coach_sports (user_id, sport) values ($1, 'badminton')`, [coachProfId]);
    const coachProfPub = toPublic((await db.query("select * from users where id = $1", [coachProfId])).rows[0] as any);
    let sCoach: any;
    await withTx(async (sql) => {
      sCoach = await issueSession(sql, coachProfPub);
    });
    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/me/profile", {
        headers: { authorization: `Bearer ${sCoach.token}` },
      });
      const res = await authH.meProfile(sql, req, coachProfPub);
      assert.equal(res.status, 200);
      const b = res.body as any;
      assert.deepEqual(b.coach?.sports, ["badminton"]);
      assert.equal(b.coach?.per_session_vnd, 150000);
      assert.equal(b.coach?.per_student_vnd, 10000);
      assert.equal(b.guardian, null);
    });
  });

  it("handles multi-session counting and sign-out-others", async () => {
    const pwHash = hashPassword("Pass123!");
    const multiPhone = "0987000025";
    const multiId = (
      await db.query<{ id: string }>(
        `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
         values (gen_random_uuid(), $1, 'Multi User', 'multi user', 'member', 'active', $2)
         returning id`,
        [multiPhone, pwHash],
      )
    ).rows[0].id;
    const multiPub = toPublic((await db.query("select * from users where id = $1", [multiId])).rows[0] as any);
    let sA: any, sB: any, sC: any;
    await withTx(async (sql) => {
      sA = await issueSession(sql, multiPub);
      sB = await issueSession(sql, multiPub);
      sC = await issueSession(sql, multiPub);
    });

    // Three sessions for one user; meProfile called with session A's token -> other_sessions === 2
    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/me/profile", {
        headers: { authorization: `Bearer ${sA.token}` },
      });
      const res = await authH.meProfile(sql, req, multiPub);
      assert.equal(res.status, 200);
      assert.equal((res.body as any).other_sessions, 2);
    });

    // meSignOutOthers with session A -> signed_out === 2; A still authenticates, B and C get 401; calling it again returns signed_out === 0
    await withTx(async (sql) => {
      const req = new Request("http://localhost/v1/me/sessions/sign-out-others", {
        method: "POST",
        headers: { authorization: `Bearer ${sA.token}` },
      });
      const res = await authH.meSignOutOthers(sql, req, multiPub);
      assert.equal(res.status, 200);
      assert.equal((res.body as any).signed_out, 2);

      // A still authenticates
      const uA = await authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${sA.token}` } }));
      assert.equal(uA.id, multiId);

      // B and C get 401
      await assert.rejects(
        async () => authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${sB.token}` } })),
        (err: any) => {
          assert.equal(err.status, 401);
          return true;
        },
      );
      await assert.rejects(
        async () => authFromRequest(sql, new Request("http://localhost/v1/me", { headers: { authorization: `Bearer ${sC.token}` } })),
        (err: any) => {
          assert.equal(err.status, 401);
          return true;
        },
      );

      // Calling it again returns signed_out === 0
      const res2 = await authH.meSignOutOthers(sql, req, multiPub);
      assert.equal(res2.status, 200);
      assert.equal((res2.body as any).signed_out, 0);
    });
  });
});

describe("Shared row contracts match the tables", () => {
  // columns.ts replaces `select *`; a migration that adds or drops a column
  // must update contracts.ts and columns.ts too, or the API shape drifts.
  it("lists every column of court_bookings, payments and invoices, and nothing else", async () => {
    const { BOOKING_COLS, PAYMENT_COLS, INVOICE_COLS } = await import("../services/columns.ts");
    for (const [table, cols] of [
      ["court_bookings", BOOKING_COLS],
      ["payments", PAYMENT_COLS],
      ["invoices", INVOICE_COLS],
    ] as const) {
      const res = await db.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1",
        [table],
      );
      assert.deepEqual(
        cols.split(", ").sort(),
        res.rows.map((r) => r.column_name).sort(),
        `${table} columns`,
      );
    }
  });
});

let scClassSeq = 0;

/** An open badminton class with a unique weekly slot, so classes never clash. */
async function seedClass(opts: { price: number | null; capacity: number; courtId?: string; slot?: string }): Promise<string> {
  scClassSeq += 1;
  const days = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
  const day = days[scClassSeq % 7];
  const hour = 6 + (Math.floor(scClassSeq / 7) % 16);
  const rrule = opts.slot ?? `FREQ=WEEKLY;BYDAY=${day};BYHOUR=${hour}`;
  const rows = await db.query<{ id: string }>(
    `insert into classes (sport, level, coach_id, court_id, rrule, start_on, end_on, duration_min, capacity, status, enrolled_count, price_vnd)
     values ('badminton', $1, '00000000-0000-0000-0000-000000000011', $5,
             $2, current_date + 1, current_date + 60, 60, $3, 'open', 0, $4)
     returning id`,
    [`sc-level-${scClassSeq}`, rrule, opts.capacity, opts.price, opts.courtId ?? "10000000-0000-0000-0000-000000000001"],
  );
  return rows.rows[0].id;
}

/** A member whose membership already covers every seeded class, so the price is the tuition alone. */
async function seedMember(n: number) {
  const member = await seedPlainUser(n);
  await db.query(
    `insert into subscriptions (user_id, plan_id, start_on, end_on, status)
     select $1, $2, current_date - 1, current_date + 400, 'active'
      where not exists (select 1 from subscriptions where user_id = $1 and status = 'active')`,
    [member.id, SHORTEST_PLAN_ID],
  );
  return member;
}

/** A user with a fixed id 0000...0500 + n, shaped like a PublicUser. */
async function seedPlainUser(n: number) {
  const id = `00000000-0000-0000-0000-0000000005${String(n).padStart(2, "0")}`;
  const phone = `+8490000${String(500 + n)}`;
  const name = `Sell Member ${n}`;
  await db.query(
    `insert into users (id, phone, full_name, name_normalized, role, password_hash)
     values ($1, $2, $3, $4, 'member', 'hash')
     on conflict (id) do nothing`,
    [id, phone, name, name.toLowerCase()],
  );
  return { id, phone, full_name: name, role: "member" } as any;
}

describe("One membership: class quote", () => {
  it("MB-quote: with no membership the quote refuses, and holds no seat", async () => {
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const m = await seedPlainUser(90);
    const res = await withTx((sql) =>
      classQuote(sql, classId, new Request(`http://localhost/v1/classes/${classId}/quote`), m),
    );
    const q = (res as any).body;
    assert.equal(q.eligible, false);
    assert.equal(q.total_vnd, 300000);
    const held = await db.query("select 1 from enrollments where class_id = $1", [classId]);
    assert.equal(held.rows.length, 0);
  });
  it("MB-covered: a membership past the class end can enrol and pays tuition only", async () => {
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const m = await seedMember(91);
    const res = await withTx((sql) =>
      classQuote(sql, classId, new Request(`http://localhost/v1/classes/${classId}/quote`), m),
    );
    const q = (res as any).body;
    assert.equal(q.eligible, true);
    assert.equal(q.total_vnd, 300000);
  });
  it("MB-gate: enrolling without a membership that outlasts the class is refused", async () => {
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const m = await seedPlainUser(92);
    await assert.rejects(
      withTx((sql) => classesEnroll(sql, classId, new Request("http://localhost"), m)),
      (e: any) => e.extra?.br === "BR-19",
    );
    const held = await db.query("select 1 from enrollments where class_id = $1", [classId]);
    assert.equal(held.rows.length, 0);
  });
  it("MB-gate-equal: a membership ending the same day as the class is refused", async () => {
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const m = await seedMember(93);
    const cl = await db.query<{ end_on: string }>("select end_on::text from classes where id = $1", [classId]);
    await db.query("update subscriptions set end_on = $2 where user_id = $1", [m.id, cl.rows[0].end_on]);
    await assert.rejects(
      withTx((sql) => classesEnroll(sql, classId, new Request("http://localhost"), m)),
      (e: any) => e.extra?.br === "BR-19",
    );
  });
});

describe("Sell classes: schema", () => {
  it("SC-schema-hold: enrollment_hold writes a priced, timed hold", async () => {
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const m1 = await seedMember(1);
    const r = await db.query<{ id: string }>("select enrollment_hold($1,$2,15,300000) as id", [classId, m1.id]);
    const row = (
      await db.query<{ status: string; price_vnd: number; ok: boolean }>(
        `select status, price_vnd,
                hold_until between now() + interval '14 minutes' and now() + interval '16 minutes' as ok
           from enrollments where id = $1`,
        [r.rows[0].id],
      )
    ).rows[0];
    assert.equal(row.status, "hold");
    assert.equal(row.price_vnd, 300000);
    assert.equal(row.ok, true);
    const cnt = (await db.query<{ enrolled_count: number }>("select enrolled_count from classes where id = $1", [classId])).rows[0];
    assert.equal(cnt.enrolled_count, 1);
  });

  it("SC-schema-errors: duplicate hold, full class and the default hold setting", async () => {
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const m1 = await seedMember(1);
    const m2 = await seedMember(2);
    await db.query("select enrollment_hold($1,$2,15,300000)", [classId, m1.id]);
    await assert.rejects(
      () => db.query("select enrollment_hold($1,$2,15,300000)", [classId, m1.id]),
      /ALREADY_ENROLLED/,
    );
    await assert.rejects(
      () => db.query("select enrollment_hold($1,$2,15,300000)", [classId, m2.id]),
      /CLASS_FULL/,
    );
    await assert.rejects(
      () => db.query("select enrollment_waitlist($1,$2)", [classId, m1.id]),
      /ALREADY_ENROLLED/,
    );
    const { getSettings } = await import("./helpers.ts");
    const s = await withTx((sql) => getSettings(sql));
    assert.equal(s.class_hold_minutes, 15);
  });
});

describe("Sell classes: enrol", () => {
  const jsonReq = (method: string, body: unknown) =>
    new Request("http://localhost", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const enrol = (classId: string, m: any) =>
    withTx((sql) => classesEnroll(sql, classId, new Request("http://localhost"), m));
  const mgr = { id: "00000000-0000-0000-0000-000000000001", role: "manager" } as any;

  it("SC-enrol-hold: a priced class holds a seat with the price locked, no plan needed", async () => {
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(10);
    const res = await enrol(classId, m);
    assert.equal(res.status, 201);
    const e = (res.body as any).enrollment;
    assert.equal(e.status, "hold");
    assert.equal(e.price_vnd, 300000);
    assert.ok(e.hold_until);
    const c = (await db.query<{ enrolled_count: number }>("select enrolled_count from classes where id = $1", [classId])).rows[0];
    assert.equal(c.enrolled_count, 1);
  });

  it("SC-enrol-unpriced: a class with no price is not open for sale (BR-53)", async () => {
    const classId = await seedClass({ price: null, capacity: 5 });
    const m = await seedMember(11);
    await assert.rejects(() => enrol(classId, m), (e: any) => e.extra?.br === "BR-53");
  });

  it("SC-enrol-free: a free class confirms at once with no payment row", async () => {
    const classId = await seedClass({ price: 0, capacity: 5 });
    const m = await seedMember(12);
    const res = await enrol(classId, m);
    const e = (res.body as any).enrollment;
    assert.equal(e.status, "confirmed");
    assert.equal(e.hold_until, null);
    const p = await db.query("select 1 from payments where ref_id = $1", [e.id]);
    assert.equal(p.rows.length, 0);
  });

  it("SC-enrol-full: the second member on a one-seat class is waitlisted", async () => {
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const m1 = await seedMember(13);
    const m2 = await seedMember(14);
    assert.equal(((await enrol(classId, m1)).body as any).enrollment.status, "hold");
    assert.equal(((await enrol(classId, m2)).body as any).enrollment.status, "waitlisted");
  });

  it("SC-clash-hold: a held class blocks another class in the same weekly slot", async () => {
    const slot = "FREQ=WEEKLY;BYDAY=MO;BYHOUR=21";
    const a = await seedClass({ price: 100000, capacity: 5, slot });
    const b = await seedClass({ price: 100000, capacity: 5, slot, courtId: "10000000-0000-0000-0000-000000000002" });
    const m = await seedMember(15);
    await enrol(a, m);
    await assert.rejects(() => enrol(b, m), (e: any) => e.extra?.br === "BR-22" && /clashes/.test(e.message));
  });

  it("SC-price-patch: a manager sets the price; bad values are field errors; holds keep their price", async () => {
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(16);
    const held = (await enrol(classId, m)).body as any;
    const patch = (price: unknown) =>
      withTx((sql) => classesPatch(sql, classId, jsonReq("PATCH", { price_vnd: price }), mgr));
    await patch(250000);
    const row = (await db.query<{ price_vnd: number }>("select price_vnd from classes where id = $1", [classId])).rows[0];
    assert.equal(row.price_vnd, 250000);
    for (const bad of [-1, "abc", 1.5, 100_000_001]) {
      await assert.rejects(() => patch(bad), (e: any) => e.extra?.field === "price_vnd");
    }
    await patch(null);
    const e = (await db.query<{ price_vnd: number }>("select price_vnd from enrollments where id = $1", [held.enrollment.id])).rows[0];
    assert.equal(e.price_vnd, 300000);
  });

  it("SC-list-mine: classesList shows my_enrollment for the holder only", async () => {
    const { classesList } = await import("./handlers/classes.ts");
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(17);
    const other = await seedMember(18);
    await enrol(classId, m);
    const find = async (u: any) => {
      const r = await withTx((sql) => classesList(sql, new Request("http://localhost/v1/classes"), u));
      return (r.body as any).items.find((c: any) => c.id === classId);
    };
    const mine = await find(m);
    assert.equal(mine.price_vnd, 300000);
    assert.equal(mine.my_enrollment.status, "hold");
    assert.equal((await find(other)).my_enrollment, null);
    assert.equal((await find(null)).my_enrollment, null);
  });
});

describe("Sell classes: pay", () => {
  const jsonReq = (method: string, body: unknown) =>
    new Request("http://localhost", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const enrol = (classId: string, m: any) =>
    withTx((sql) => classesEnroll(sql, classId, new Request("http://localhost"), m));
  const mgr = { id: "00000000-0000-0000-0000-000000000001", role: "manager", full_name: "Quan ly" } as any;
  const holdFor = async (classId: string, m: any) => ((await enrol(classId, m)).body as any).enrollment.id as string;
  const payDesk = (enrollmentId: string, amount: number) =>
    withTx((sql) =>
      paymentsCreate(sql, jsonReq("POST", { ref_type: "enrollment", ref_id: enrollmentId, method: "cash", amount_vnd: amount }), mgr),
    );

  it("SC-transfer: a transfer request extends the hold and shows on the desk list", async () => {
    const { enrollmentTransfer } = await import("./handlers/classes.ts");
    const { paymentsPending } = await import("./handlers/desk.ts");
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(20);
    const id = await holdFor(classId, m);
    const res = await withTx((sql) => enrollmentTransfer(sql, id, m));
    assert.equal(res.status, 200);
    const row = (
      await db.query<{ ok: boolean; req: string | null }>(
        `select hold_until between now() + interval '119 minutes' and now() + interval '121 minutes' as ok,
                transfer_requested_at as req from enrollments where id = $1`,
        [id],
      )
    ).rows[0];
    assert.equal(row.ok, true);
    assert.ok(row.req);
    const pend = await withTx((sql) => paymentsPending(sql, new Request("http://localhost/v1/payments/pending"), mgr));
    const hit = (pend.body as any).awaiting.find((r: any) => r.kind === "enrollment" && r.id === id);
    assert.ok(hit);
    assert.equal(hit.amount_vnd, 300000);
  });

  it("SC-desk-pay: cash at the desk confirms the seat, posts a payment, issues an invoice", async () => {
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(21);
    const id = await holdFor(classId, m);
    await payDesk(id, 300000);
    const e = (await db.query<{ status: string; hold_until: string | null }>("select status, hold_until from enrollments where id = $1", [id])).rows[0];
    assert.equal(e.status, "confirmed");
    assert.equal(e.hold_until, null);
    const pays = await db.query<{ id: string }>("select id from payments where ref_type = 'enrollment' and ref_id = $1 and status = 'posted'", [id]);
    assert.equal(pays.rows.length, 1);
    const lines = await db.query<{ description: string }>(
      `select il.description from invoice_lines il join invoices i on i.id = il.invoice_id where i.payment_id = $1`,
      [pays.rows[0].id],
    );
    assert.equal(lines.rows.length, 1);
    assert.ok(lines.rows[0].description.startsWith("Khoá badminton"));
  });

  it("SC-settle-idempotent: settling twice confirms once and keeps the count", async () => {
    const { settleEnrollment } = await import("./handlers/classes.ts");
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(22);
    const id = await holdFor(classId, m);
    assert.equal((await withTx((sql) => settleEnrollment(sql, id))).outcome, "confirmed");
    assert.equal((await withTx((sql) => settleEnrollment(sql, id))).outcome, "already");
    const c = (await db.query<{ enrolled_count: number }>("select enrolled_count from classes where id = $1", [classId])).rows[0];
    assert.equal(c.enrolled_count, 1);
  });

  it("SC-settle-late-full: money for an expired hold whose seat was retaken is flagged, not seated", async () => {
    const { settleEnrollment } = await import("./handlers/classes.ts");
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const m1 = await seedMember(23);
    const m2 = await seedMember(24);
    const id1 = await holdFor(classId, m1);
    // Stand-in for the expiry sweep (Task 5): the hold lapses and gives its seat back.
    await db.query("update enrollments set hold_until = now() - interval '1 minute' where id = $1", [id1]);
    await db.query("update enrollments set status = 'cancelled' where id = $1", [id1]);
    await db.query("update classes set enrolled_count = enrolled_count - 1 where id = $1", [classId]);
    const id2 = await holdFor(classId, m2);
    assert.equal((await db.query<{ status: string }>("select status from enrollments where id = $1", [id2])).rows[0].status, "hold");
    const res = await withTx((sql) => settleEnrollment(sql, id1));
    assert.equal(res.outcome, "late_no_seat");
    const c = (await db.query<{ enrolled_count: number }>("select enrolled_count from classes where id = $1", [classId])).rows[0];
    assert.equal(c.enrolled_count, 1);
    const a = await db.query("select 1 from audit_logs where action = 'enrollment_paid_no_seat' and entity_id = $1", [id1]);
    assert.equal(a.rows.length, 1);
  });

  it("SC-late-confirmed: money for an expired hold with a free seat still seats the member", async () => {
    const { settleEnrollment } = await import("./handlers/classes.ts");
    const classId = await seedClass({ price: 300000, capacity: 2 });
    const m = await seedMember(25);
    const id = await holdFor(classId, m);
    await db.query("update enrollments set status = 'cancelled' where id = $1", [id]);
    await db.query("update classes set enrolled_count = enrolled_count - 1 where id = $1", [classId]);
    assert.equal((await withTx((sql) => settleEnrollment(sql, id))).outcome, "late_confirmed");
    const c = (await db.query<{ enrolled_count: number }>("select enrolled_count from classes where id = $1", [classId])).rows[0];
    assert.equal(c.enrolled_count, 1);
  });

  it("SC-locked-price: the desk must take the price locked at hold time", async () => {
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(26);
    const id = await holdFor(classId, m);
    await withTx((sql) => classesPatch(sql, classId, jsonReq("PATCH", { price_vnd: 250000 }), mgr));
    await assert.rejects(() => payDesk(id, 250000), (e: any) => e.extra?.field === "amount_vnd");
    await payDesk(id, 300000);
  });

  it("SC-amount-mismatch: a desk payment for a seat must equal its price to the đồng, or nothing is posted", async () => {
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(29);
    const id = await holdFor(classId, m);
    for (const wrong of [1, 299999, 300001]) {
      await assert.rejects(() => payDesk(id, wrong), (e: any) => e.extra?.field === "amount_vnd");
    }
    const posted = await db.query("select 1 from payments where ref_type = 'enrollment' and ref_id = $1", [id]);
    assert.equal(posted.rows.length, 0);
    assert.equal((await db.query<{ status: string }>("select status from enrollments where id = $1", [id])).rows[0].status, "hold");
    await payDesk(id, 300000);
  });

  it("SC-transfer-repeat: a second transfer request is refused and the hold is unchanged", async () => {
    const { enrollmentTransfer } = await import("./handlers/classes.ts");
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(28);
    const id = await holdFor(classId, m);
    await withTx((sql) => enrollmentTransfer(sql, id, m));
    const before = (await db.query<{ h: string }>("select hold_until::text as h from enrollments where id = $1", [id])).rows[0].h;
    await assert.rejects(() => withTx((sql) => enrollmentTransfer(sql, id, m)), (e: any) => e.status === 409);
    const after = (await db.query<{ h: string }>("select hold_until::text as h from enrollments where id = $1", [id])).rows[0].h;
    assert.equal(after, before);
  });

  it("SC-expired-transfer: a lapsed hold cannot ask for a transfer (BR-28)", async () => {
    const { enrollmentTransfer } = await import("./handlers/classes.ts");
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(27);
    const id = await holdFor(classId, m);
    await db.query("update enrollments set hold_until = now() - interval '1 minute' where id = $1", [id]);
    await assert.rejects(() => withTx((sql) => enrollmentTransfer(sql, id, m)), (e: any) => e.extra?.br === "BR-28");
  });
});

/** Stands in for a confirmed payment: turns a held seat into a confirmed one. */
async function confirmHold(enrollmentId: string) {
  await db.query("update enrollments set status = 'confirmed', hold_until = null where id = $1", [enrollmentId]);
}

describe("Sell classes: online", () => {
  const enrol = (classId: string, m: any) =>
    withTx((sql) => classesEnroll(sql, classId, new Request("http://localhost"), m));
  const mgr = { id: "00000000-0000-0000-0000-000000000001", role: "manager", full_name: "Quan ly" } as any;
  const holdFor = async (classId: string, m: any) => ((await enrol(classId, m)).body as any).enrollment.id as string;
  const linkFor = (enrollmentId: string, u: any) =>
    withTx((sql) =>
      onlineCreate(
        sql,
        new Request("http://localhost/v1/payments/online", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ref_type: "enrollment", ref_id: enrollmentId }),
        }),
        u,
      ),
    );
  let orderSeq = 0;
  const useMockLink = () =>
    setOverridePaymentLinkCreator(async (args) => {
      orderSeq += 1;
      return {
        orderCode: args.orderCode,
        checkoutUrl: `https://pay.mock/checkout/sc${orderSeq}`,
        qrCode: "data:image/png;base64,mock",
        paymentLinkId: `link_sc_${orderSeq}`,
        expiredAt: Math.floor(Date.now() / 1000) + 900,
      };
    });
  after(() => setOverridePaymentLinkCreator(null));

  it("SC-online-create: owner links their hold at the locked price; others and lapsed holds are refused", async () => {
    useMockLink();
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(40);
    const other = await seedMember(41);
    const id = await holdFor(classId, m);
    await assert.rejects(() => linkFor(id, other), (e: any) => e.status === 403);
    const res = await linkFor(id, m);
    assert.equal(res.status, 201);
    assert.equal((res.body as any).amount_vnd, 300000);
    const pay = (await db.query<{ amount_vnd: number; user_id: string }>("select amount_vnd, user_id from payments where id = $1", [(res.body as any).payment_id])).rows[0];
    assert.equal(pay.amount_vnd, 300000);
    assert.equal(pay.user_id, m.id);

    const m2 = await seedMember(42);
    const id2 = await holdFor(await seedClass({ price: 300000, capacity: 5 }), m2);
    await db.query("update enrollments set hold_until = now() - interval '1 minute' where id = $1", [id2]);
    await assert.rejects(() => linkFor(id2, m2), (e: any) => e.extra?.br === "BR-28");
  });

  it("SC-online-expire: a pending link for a lapsed hold is cancelled by the job", async () => {
    useMockLink();
    const { expireOnlineLinks } = await import("./handlers/online.ts");
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(43);
    const id = await holdFor(classId, m);
    const res = await linkFor(id, m);
    const payId = (res.body as any).payment_id as string;
    await withTx((sql) => expireOnlineLinks(sql));
    let st = (await db.query<{ status: string }>("select status::text as status from payments where id = $1", [payId])).rows[0].status;
    assert.equal(st, "pending");
    await db.query("update enrollments set hold_until = now() - interval '1 minute' where id = $1", [id]);
    await withTx((sql) => expireOnlineLinks(sql));
    st = (await db.query<{ status: string }>("select status::text as status from payments where id = $1", [payId])).rows[0].status;
    assert.equal(st, "expired");
  });

  it("SC-online-settle: a paid link confirms the seat, invoices once, and a repeat does nothing", async () => {
    useMockLink();
    const { settleOnline } = await import("./handlers/online.ts");
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(44);
    const id = await holdFor(classId, m);
    const res = await linkFor(id, m);
    const payId = (res.body as any).payment_id as string;
    const settle = () =>
      withTx(async (sql) => {
        const pay = await sql.query<any>(
          `select id, code, user_id, amount_vnd, status::text as status, ref_type, ref_id, provider_order_code from payments where id = $1 for update`,
          [payId],
        );
        return settleOnline(sql, pay[0], { amountPaid: 300000, transactionId: "TX-SC", providerStatus: "PAID" });
      });
    assert.equal((await settle()).posted, true);
    assert.equal((await settle()).posted, true);
    const e = (await db.query<{ status: string }>("select status::text as status from enrollments where id = $1", [id])).rows[0];
    assert.equal(e.status, "confirmed");
    const invs = await db.query<{ description: string }>(
      `select il.description from invoice_lines il join invoices i on i.id = il.invoice_id where i.payment_id = $1`,
      [payId],
    );
    assert.equal(invs.rows.length, 1);
    assert.ok(invs.rows[0].description.startsWith("Khoá badminton"));
    const c = (await db.query<{ enrolled_count: number }>("select enrolled_count from classes where id = $1", [classId])).rows[0];
    assert.equal(c.enrolled_count, 1);
  });

  it("SC-online-late: money for a retaken seat stays posted and is invoiced", async () => {
    useMockLink();
    const { settleOnline } = await import("./handlers/online.ts");
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const m1 = await seedMember(45);
    const m2 = await seedMember(46);
    const id1 = await holdFor(classId, m1);
    const payId = ((await linkFor(id1, m1)).body as any).payment_id as string;
    // Stand-in for the expiry sweep: the hold lapses, gives its seat back, another member takes it.
    await db.query("update enrollments set hold_until = now() - interval '1 minute', status = 'cancelled' where id = $1", [id1]);
    await db.query("update classes set enrolled_count = enrolled_count - 1 where id = $1", [classId]);
    await holdFor(classId, m2);
    const out = await withTx(async (sql) => {
      const pay = await sql.query<any>(
        `select id, code, user_id, amount_vnd, status::text as status, ref_type, ref_id, provider_order_code from payments where id = $1 for update`,
        [payId],
      );
      return settleOnline(sql, pay[0], { amountPaid: 300000, transactionId: "TX-LATE", providerStatus: "PAID" });
    });
    assert.equal(out.posted, true);
    const st = (await db.query<{ status: string }>("select status::text as status from payments where id = $1", [payId])).rows[0].status;
    assert.equal(st, "posted");
    const n = (await db.query("select 1 from invoices where payment_id = $1", [payId])).rows.length;
    assert.equal(n, 1);
  });
});

describe("Sell classes: lifecycle", () => {
  const enrol = (classId: string, m: any) =>
    withTx((sql) => classesEnroll(sql, classId, new Request("http://localhost"), m));
  const holdFor = async (classId: string, m: any) => ((await enrol(classId, m)).body as any).enrollment.id as string;
  const leave = (enrollmentId: string, m: any) => withTx((sql) => enrollmentDelete(sql, enrollmentId, m));
  const statusOf = async (enrollmentId: string) =>
    (await db.query<{ status: string }>("select status::text as status from enrollments where id = $1", [enrollmentId])).rows[0].status;
  const countOf = async (classId: string) =>
    (await db.query<{ n: number }>("select enrolled_count as n from classes where id = $1", [classId])).rows[0].n;
  /** A scheduled session starting in an hour, so the class is inside the cancel cutoff. */
  const soonSession = async (classId: string, courtId: string) => {
    const occ = (
      await db.query<{ id: string }>(
        `insert into occupancies (court_id, start_at, end_at, kind, ref_id)
         values ($1, now() + interval '1 hour', now() + interval '2 hours', 'session', $2) returning id`,
        [courtId, classId],
      )
    ).rows[0].id;
    await db.query(
      `insert into sessions (class_id, court_id, start_at, end_at, status, occupancy_id)
       values ($1, $2, now() + interval '1 hour', now() + interval '2 hours', 'scheduled', $3)`,
      [classId, courtId, occ],
    );
  };
  const quietCourt = async (id: string) => {
    await db.query(
      `insert into courts (id, court_code, sport, status) values ($1, $2, 'badminton', 'ready') on conflict (id) do nothing`,
      [id, "LC-" + id.slice(-4)],
    );
    return id;
  };
  const pendingOffer = async (enrollmentId: string) =>
    (await db.query<{ id: string }>("select id from waitlist_offers where enrollment_id = $1 and status = 'pending'", [enrollmentId])).rows[0];

  it("SC-waitlist-hold: accepting an offer takes a hold at the locked price, with no plan needed", async () => {
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const a = await seedMember(60);
    const b = await seedMember(61);
    const idA = await holdFor(classId, a);
    const idB = await holdFor(classId, b);
    assert.equal(await statusOf(idB), "waitlisted");
    await leave(idA, a);
    const offer = await pendingOffer(idB);
    assert.ok(offer);
    const res = await withTx((sql) => waitlistAccept(sql, offer.id, b));
    assert.equal(res.status, 200);
    const holdMinutes = (await db.query<{ m: number }>("select class_hold_minutes as m from center_settings where id = 1")).rows[0].m;
    const row = (
      await db.query<{ status: string; price_vnd: number; ok: boolean; pos: number | null }>(
        `select status::text as status, price_vnd, waitlist_pos as pos,
                hold_until between now() + ($2::int - 1) * interval '1 minute' and now() + ($2::int + 1) * interval '1 minute' as ok
           from enrollments where id = $1`,
        [idB, holdMinutes],
      )
    ).rows[0];
    assert.equal(row.status, "hold");
    assert.equal(row.price_vnd, 300000);
    assert.equal(row.pos, null);
    assert.equal(row.ok, true);
    assert.equal(await countOf(classId), 1);
  });

  it("SC-waitlist-hold-unpriced: accepting an offer for a class that lost its price gives BR-53", async () => {
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const a = await seedMember(62);
    const b = await seedMember(63);
    const idA = await holdFor(classId, a);
    const idB = await holdFor(classId, b);
    await leave(idA, a);
    const offer = await pendingOffer(idB);
    await db.query("update classes set price_vnd = null where id = $1", [classId]);
    await assert.rejects(() => withTx((sql) => waitlistAccept(sql, offer.id, b)), (e: any) => e.extra?.br === "BR-53");
    assert.equal(await statusOf(idB), "waitlisted");
  });

  it("SC-waitlist-left: accepting an offer after leaving the waitlist is refused", async () => {
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const a = await seedMember(69);
    const b = await seedMember(70);
    const idA = await holdFor(classId, a);
    const idB = await holdFor(classId, b);
    await leave(idA, a);
    const offer = await pendingOffer(idB);
    assert.ok(offer);
    await leave(idB, b);
    await assert.rejects(() => withTx((sql) => waitlistAccept(sql, offer.id, b)), (e: any) => e.status === 409);
    assert.equal(await statusOf(idB), "cancelled");
    assert.equal(await countOf(classId), 0);
  });

  it("SC-release: releasing a hold frees the seat and skips the cancel cutoff", async () => {
    const court = await quietCourt("10000000-0000-0000-0000-0000000c0007");
    const classId = await seedClass({ price: 300000, capacity: 3, courtId: court });
    await soonSession(classId, court);
    const m = await seedMember(64);
    const id = await holdFor(classId, m);
    assert.equal(await countOf(classId), 1);
    const res = await leave(id, m);
    assert.equal(res.status, 200);
    assert.equal(await statusOf(id), "cancelled");
    assert.equal(await countOf(classId), 0);
    const h = (await db.query<{ hold_until: string | null }>("select hold_until from enrollments where id = $1", [id])).rows[0];
    assert.equal(h.hold_until, null);
  });

  it("SC-release-cancels-link: releasing a hold cancels its pending payOS link", async () => {
    let seq = 0;
    setOverridePaymentLinkCreator(async (args) => {
      seq += 1;
      return {
        orderCode: args.orderCode,
        checkoutUrl: `https://pay.mock/checkout/lc${seq}`,
        qrCode: "data:image/png;base64,mock",
        paymentLinkId: `link_lc_${seq}`,
        expiredAt: Math.floor(Date.now() / 1000) + 900,
      };
    });
    try {
      const classId = await seedClass({ price: 300000, capacity: 3 });
      const m = await seedMember(65);
      const id = await holdFor(classId, m);
      const link = await withTx((sql) =>
        onlineCreate(
          sql,
          new Request("http://localhost/v1/payments/online", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ref_type: "enrollment", ref_id: id }),
          }),
          m,
        ),
      );
      const payId = (link.body as any).payment_id as string;
      const st = async () => (await db.query<{ status: string }>("select status::text as status from payments where id = $1", [payId])).rows[0].status;
      assert.equal(await st(), "pending");
      await leave(id, m);
      assert.equal(await st(), "expired");
    } finally {
      setOverridePaymentLinkCreator(null);
    }
  });

  it("SC-expire-job: a lapsed hold is cancelled, its seat freed and offered to the waitlist", async () => {
    const { expireEnrollmentHolds } = await import("../data/jobs.ts");
    const classId = await seedClass({ price: 300000, capacity: 1 });
    const a = await seedMember(66);
    const b = await seedMember(67);
    const idA = await holdFor(classId, a);
    const idB = await holdFor(classId, b);
    await expireEnrollmentHolds(); // other tests may have left lapsed holds; ours is still live
    assert.equal(await statusOf(idA), "hold");
    await db.query("update enrollments set hold_until = now() - interval '1 minute' where id = $1", [idA]);
    assert.ok((await expireEnrollmentHolds()) >= 1);
    assert.equal(await statusOf(idA), "cancelled");
    assert.equal(await countOf(classId), 0);
    assert.ok(await pendingOffer(idB));
    await expireEnrollmentHolds(); // a second sweep must not decrement again
    assert.equal(await statusOf(idA), "cancelled");
    assert.equal(await countOf(classId), 0);
  });

  it("SC-leave-confirmed: a confirmed seat still obeys the cutoff and no refund row appears", async () => {
    const court = await quietCourt("10000000-0000-0000-0000-0000000c0006");
    const classId = await seedClass({ price: 300000, capacity: 3, courtId: court });
    await soonSession(classId, court);
    const m = await seedMember(68);
    const id = await holdFor(classId, m);
    await confirmHold(id);
    await assert.rejects(() => leave(id, m), (e: any) => e.extra?.br === "BR-24");
    assert.equal(await statusOf(id), "confirmed");
    const n = (await db.query<{ n: number }>("select count(*)::int as n from payments where ref_type = 'enrollment' and ref_id = $1", [id])).rows[0].n;
    assert.equal(n, 0);
  });
});

describe("Sell classes: attendance", () => {
  it("SC-attendance-no-charge: marking present neither spends a plan session nor writes a charge", async () => {
    const court = "10000000-0000-0000-0000-0000000c0008";
    await db.query(
      `insert into courts (id, court_code, sport, status) values ($1, 'SA-0008', 'badminton', 'ready') on conflict (id) do nothing`,
      [court],
    );
    const classId = await seedClass({ price: 300000, capacity: 3, courtId: court });
    const m = await seedPlainUser(92);
    const manager = { id: "00000000-0000-0000-0000-000000000001", role: "manager", full_name: "Sell Manager" } as any;
    const subId = (
      await db.query<{ id: string }>(
        `insert into subscriptions (user_id, plan_id, start_on, end_on, status, session_left)
         values ($1, '20000000-0000-0000-0000-000000000002', current_date - 1, current_date + 30, 'active', 3)
         returning id`,
        [m.id],
      )
    ).rows[0].id;
    await db.query(
      `insert into enrollments (class_id, user_id, status, price_vnd) values ($1, $2, 'confirmed', 300000)`,
      [classId, m.id],
    );
    const occ = (
      await db.query<{ id: string }>(
        `insert into occupancies (court_id, start_at, end_at, kind, ref_id)
         values ($1, now() - interval '1 hour', now() + interval '1 hour', 'session', $2) returning id`,
        [court, classId],
      )
    ).rows[0].id;
    const sessionId = (
      await db.query<{ id: string }>(
        `insert into sessions (class_id, court_id, start_at, end_at, status, occupancy_id)
         values ($1, $2, now() - interval '1 hour', now() + interval '1 hour', 'scheduled', $3) returning id`,
        [classId, court, occ],
      )
    ).rows[0].id;
    const req = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ user_id: m.id, result: "present" }] }),
    });
    const res = await withTx((sql) => sessionAttendancePost(sql, sessionId, req, manager));
    assert.equal(res.status, 200);
    const left = (await db.query<{ n: number }>("select session_left as n from subscriptions where id = $1", [subId])).rows[0].n;
    assert.equal(left, 3);
    const charges = (
      await db.query<{ n: number }>("select count(*)::int as n from session_charges where session_id = $1 and user_id = $2", [sessionId, m.id])
    ).rows[0].n;
    assert.equal(charges, 0);
    const marked = (await db.query<{ result: string }>("select result::text as result from attendance where session_id = $1 and user_id = $2", [sessionId, m.id])).rows[0];
    assert.equal(marked.result, "present");
  });
});

describe("Sell classes: final fixes", () => {
  const jsonReq = (method: string, body: unknown) =>
    new Request("http://localhost", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const enrol = (classId: string, m: any) =>
    withTx((sql) => classesEnroll(sql, classId, new Request("http://localhost"), m));
  const mgr = { id: "00000000-0000-0000-0000-000000000001", role: "manager", full_name: "Quan ly" } as any;
  const holdFor = async (classId: string, m: any) => ((await enrol(classId, m)).body as any).enrollment.id as string;
  const payDesk = (enrollmentId: string, amount: number) =>
    withTx((sql) =>
      paymentsCreate(sql, jsonReq("POST", { ref_type: "enrollment", ref_id: enrollmentId, method: "cash", amount_vnd: amount }), mgr),
    );
  const linkFor = (enrollmentId: string, u: any) =>
    withTx((sql) =>
      onlineCreate(
        sql,
        new Request("http://localhost/v1/payments/online", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ref_type: "enrollment", ref_id: enrollmentId }),
        }),
        u,
      ),
    );
  const settleLink = (payId: string, txn: string) =>
    withTx(async (sql) => {
      const { settleOnline } = await import("./handlers/online.ts");
      const pay = await sql.query<any>(
        `select id, code, user_id, amount_vnd, status::text as status, ref_type, ref_id, provider_order_code from payments where id = $1 for update`,
        [payId],
      );
      return settleOnline(sql, pay[0], { amountPaid: 300000, transactionId: txn, providerStatus: "PAID" });
    });
  const statusOf = async (enrollmentId: string) =>
    (await db.query<{ status: string }>("select status::text as status from enrollments where id = $1", [enrollmentId])).rows[0].status;
  const countOf = async (classId: string) =>
    (await db.query<{ enrolled_count: number }>("select enrolled_count from classes where id = $1", [classId])).rows[0].enrolled_count;
  const staffFlags = async (paymentId: string) =>
    (
      await db.query<{ reason: string }>(
        "select payload->>'reason' as reason from outbox where template = 'class_payment_exception' and payload->>'payment_id' = $1",
        [paymentId],
      )
    ).rows.map((r) => r.reason);
  const linkRow = async (payId: string) =>
    (
      await db.query<{ status: string; ps: string; code: string }>(
        "select status::text as status, provider_status as ps, provider_order_code::text as code from payments where id = $1",
        [payId],
      )
    ).rows[0];

  let seq = 0;
  let lastExpires: number | undefined;
  const withdrawn: number[] = [];
  before(() => {
    setOverridePaymentLinkCreator(async (args: any) => {
      seq += 1;
      lastExpires = args.expiresInSeconds;
      return {
        orderCode: args.orderCode,
        checkoutUrl: `https://pay.mock/checkout/ff${seq}`,
        qrCode: "data:image/png;base64,mock",
        paymentLinkId: `link_ff_${seq}`,
        expiredAt: Math.floor(Date.now() / 1000) + 900,
      };
    });
    setOverridePaymentLinkCanceller(async (orderCode: number) => {
      withdrawn.push(orderCode);
    });
  });
  after(() => {
    setOverridePaymentLinkCreator(null);
    setOverridePaymentLinkCanceller(null);
  });

  it("SC-cancel-refund: cancelling a class owes the paid tuition until the desk hands it over", async () => {
    const { paymentsPayOutRefund, paymentsApproveRefund } = await import("./handlers/desk.ts");
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(84);
    const id = await holdFor(classId, m);
    await payDesk(id, 300000);
    await db.query(
      "insert into payments (code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id) values ('PAY-SC84', $1, 'cash', -100000, 0, 'posted', 'enrollment', $2)",
      [m.id, id],
    );
    await withTx((sql) => classesPatch(sql, classId, jsonReq("PATCH", { status: "cancelled", reason: "Coach is away" }), mgr));
    const row = (
      await db.query<{ id: string; amount_vnd: number; status: string; shift_id: string | null }>(
        "select id, amount_vnd, status::text as status, shift_id from payments where ref_id = $1 and status = 'refund_pending'",
        [id],
      )
    ).rows[0];
    assert.equal(row.amount_vnd, -200000);
    assert.equal(row.shift_id, null);
    const told = await db.query<{ payload: any }>(
      "select payload from outbox where user_id = $1 and template = 'class_changed' and payload->>'class_id' = $2",
      [m.id, classId],
    );
    assert.equal(told.rows[0].payload.refund_vnd, 200000);
    await assert.rejects(() => withTx((sql) => paymentsApproveRefund(sql, row.id, jsonReq("POST", {}), { ...mgr, id: "00000000-0000-0000-0000-000000000009" })));
    const desk = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist" } as any;
    const open = await db.query<{ id: string }>("select id from cashier_shifts where receptionist_id = $1 and closed_at is null", [desk.id]);
    const shiftId = open.rows[0]?.id ?? (await db.query<{ id: string }>("insert into cashier_shifts (receptionist_id) values ($1) returning id", [desk.id])).rows[0].id;
    await withTx((sql) => paymentsPayOutRefund(sql, row.id, desk));
    const paid = (await db.query<{ status: string; shift_id: string }>("select status::text as status, shift_id from payments where id = $1", [row.id])).rows[0];
    assert.equal(paid.status, "posted");
    assert.equal(paid.shift_id, shiftId);
    await assert.rejects(() => withTx((sql) => paymentsPayOutRefund(sql, row.id, desk)));
    await db.query("update cashier_shifts set closed_at = now() where id = $1", [shiftId]);
  });

  it("SC-cancel-refund-manager: a manager hands the refund over without a till, a receptionist without a shift cannot", async () => {
    const { paymentsPayOutRefund } = await import("./handlers/desk.ts");
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(85);
    const id = await holdFor(classId, m);
    await payDesk(id, 300000);
    await withTx((sql) => classesPatch(sql, classId, jsonReq("PATCH", { status: "cancelled", reason: "Coach is away" }), mgr));
    const row = (await db.query<{ id: string }>("select id from payments where ref_id = $1 and status = 'refund_pending'", [id])).rows[0];
    const desk = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist" } as any;
    await db.query("update cashier_shifts set closed_at = now() where receptionist_id = $1 and closed_at is null", [desk.id]);
    await assert.rejects(
      () => withTx((sql) => paymentsPayOutRefund(sql, row.id, desk)),
      (e: any) => e.extra?.br === "BR-44",
    );
    await withTx((sql) => paymentsPayOutRefund(sql, row.id, mgr));
    const paid = (await db.query<{ status: string; shift_id: string | null }>("select status::text as status, shift_id from payments where id = $1", [row.id])).rows[0];
    assert.equal(paid.status, "posted");
    assert.equal(paid.shift_id, null);
  });

  it("SC-cancel-class-hold: cancelling a class ends its holds and links, and a late payment is flagged, not seated", async () => {
    const { settleEnrollment } = await import("./handlers/classes.ts");
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(80);
    const id = await holdFor(classId, m);
    const payId = ((await linkFor(id, m)).body as any).payment_id as string;
    await db.query("update enrollments set transfer_requested_at = now() where id = $1", [id]);
    await withTx((sql) => classesPatch(sql, classId, jsonReq("PATCH", { status: "cancelled", reason: "Coach is away" }), mgr));
    const row = (
      await db.query<{ status: string; hold_until: string | null; req: string | null }>(
        "select status::text as status, hold_until, transfer_requested_at as req from enrollments where id = $1",
        [id],
      )
    ).rows[0];
    assert.equal(row.status, "cancelled");
    assert.equal(row.hold_until, null);
    assert.equal(row.req, null);
    assert.equal(await countOf(classId), 0);
    const link = await linkRow(payId);
    assert.equal(link.status, "expired");
    assert.equal(link.ps, "CLASS_CANCELLED");
    assert.ok(withdrawn.includes(Number(link.code)));
    const told = await db.query("select 1 from outbox where user_id = $1 and payload->>'class_id' = $2", [m.id, classId]);
    assert.ok(told.rows.length >= 1);

    // Money that arrives anyway (paid at payOS before the cancel landed) is flagged, not seated.
    const out = await withTx((sql) => settleEnrollment(sql, id, { paymentId: payId }));
    assert.equal(out.outcome, "class_cancelled");
    assert.equal(await statusOf(id), "cancelled");
    assert.equal(await countOf(classId), 0);
    const a = await db.query("select 1 from audit_logs where action = 'enrollment_paid_class_cancelled' and entity_id = $1", [id]);
    assert.equal(a.rows.length, 1);
    const flags = await staffFlags(payId);
    assert.ok(flags.length >= 1);
    assert.ok(flags.every((r) => r === "class_cancelled"));
  });

  it("SC-cancel-class-refusals: a cancelled class refuses links, transfer requests and desk payments (BR-18)", async () => {
    const { enrollmentTransfer } = await import("./handlers/classes.ts");
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(81);
    const id = await holdFor(classId, m);
    // The class is cancelled behind the hold's back: every way in must still refuse.
    await db.query("update classes set status = 'cancelled' where id = $1", [classId]);
    const isBr18 = (e: any) => e.extra?.br === "BR-18";
    await assert.rejects(() => linkFor(id, m), isBr18);
    await assert.rejects(() => withTx((sql) => enrollmentTransfer(sql, id, m)), isBr18);
    await assert.rejects(() => payDesk(id, 300000), isBr18);
    assert.equal(await statusOf(id), "hold");
  });

  it("SC-release-link: releasing a hold withdraws its link, and money on that link never re-seats the member", async () => {
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(82);
    const id = await holdFor(classId, m);
    const payId = ((await linkFor(id, m)).body as any).payment_id as string;
    await withTx((sql) => enrollmentDelete(sql, id, m));
    const link = await linkRow(payId);
    assert.equal(link.status, "expired");
    assert.equal(link.ps, "RELEASED");
    assert.ok(withdrawn.includes(Number(link.code)));
    assert.equal(await countOf(classId), 0);

    const out = await settleLink(payId, "TX-FF-REL");
    assert.equal(out.posted, true);
    assert.equal(await statusOf(id), "cancelled");
    assert.equal(await countOf(classId), 0);
    const a = await db.query("select 1 from audit_logs where action = 'enrollment_paid_released' and entity_id = $1", [id]);
    assert.equal(a.rows.length, 1);
    const flags = await staffFlags(payId);
    assert.ok(flags.length >= 1);
    assert.ok(flags.every((r) => r === "released"));
  });

  it("SC-waitlist-free: accepting an offer for a free class confirms the seat at once", async () => {
    const classId = await seedClass({ price: 0, capacity: 1 });
    const a = await seedMember(83);
    const b = await seedMember(84);
    const idA = await holdFor(classId, a);
    assert.equal(await statusOf(idA), "confirmed");
    const idB = await holdFor(classId, b);
    assert.equal(await statusOf(idB), "waitlisted");
    await withTx((sql) => enrollmentDelete(sql, idA, a));
    const offer = (
      await db.query<{ id: string }>("select id from waitlist_offers where enrollment_id = $1 and status = 'pending'", [idB])
    ).rows[0];
    assert.ok(offer);
    const res = await withTx((sql) => waitlistAccept(sql, offer.id, b));
    assert.equal((res.body as any).status, "confirmed");
    const row = (
      await db.query<{ status: string; hold_until: string | null }>(
        "select status::text as status, hold_until from enrollments where id = $1",
        [idB],
      )
    ).rows[0];
    assert.equal(row.status, "confirmed");
    assert.equal(row.hold_until, null);
    assert.equal(await countOf(classId), 1);
  });

  it("SC-desk-then-online: the desk withdraws the open link, and money on it later is flagged to staff", async () => {
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(85);
    const id = await holdFor(classId, m);
    const payId = ((await linkFor(id, m)).body as any).payment_id as string;
    await payDesk(id, 300000);
    const link = await linkRow(payId);
    assert.equal(link.status, "expired");
    assert.equal(link.ps, "PAID_AT_DESK");
    assert.ok(withdrawn.includes(Number(link.code)));
    assert.equal(await statusOf(id), "confirmed");

    const out = await settleLink(payId, "TX-FF-DUP");
    assert.equal(out.posted, true);
    assert.equal(await statusOf(id), "confirmed");
    assert.equal(await countOf(classId), 1);
    const a = await db.query("select 1 from audit_logs where action = 'enrollment_paid_twice' and entity_id = $1", [id]);
    assert.equal(a.rows.length, 1);
    const flags = await staffFlags(payId);
    assert.ok(flags.length >= 1);
    assert.ok(flags.every((r) => r === "duplicate"));
  });

  it("SC-link-expiry: a seat link never outlives the hold", async () => {
    const classId = await seedClass({ price: 300000, capacity: 5 });
    const m = await seedMember(86);
    const id = await holdFor(classId, m);
    await db.query("update enrollments set hold_until = now() + interval '5 minutes' where id = $1", [id]);
    await linkFor(id, m);
    assert.ok(lastExpires !== undefined && lastExpires <= 300 && lastExpires >= 280, `expires in ${lastExpires}`);
  });
});

describe("Remove plans: courts", () => {
  const receptionistUser = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist", full_name: "Lễ tân RP" } as any;
  const courtId = "10000000-0000-0000-0000-000000000008";
  const testDate = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);

  before(async () => {
    // The demo seed books most of court 8 on these days; clear the test day as Round 6 does.
    await db.query(`update court_bookings set occupancy_id = null, status = 'cancelled' where court_id = $1 and (start_at at time zone 'Asia/Ho_Chi_Minh')::date = $2::date`, [courtId, testDate]);
    await db.query(`update sessions set occupancy_id = null, status = 'cancelled' where court_id = $1 and (start_at at time zone 'Asia/Ho_Chi_Minh')::date = $2::date`, [courtId, testDate]);
    await db.query(`delete from occupancies where court_id = $1 and (start_at at time zone 'Asia/Ho_Chi_Minh')::date = $2::date`, [courtId, testDate]);
  });

  async function seedMember(id: string, name: string): Promise<any> {
    const phone = "+8490" + id.replace(/-/g, "").slice(-7);
    await db.query(
      `insert into users (id, phone, full_name, name_normalized, role, password_hash)
       values ($1, $2, $3, $4, 'member', 'hash')
       on conflict (id) do nothing`,
      [id, phone, name, name.toLowerCase()],
    );
    return { id, role: "member", full_name: name } as any;
  }

  async function seedPlanSubscription(userId: string, courtHoursLeft: number): Promise<void> {
    const planId = (
      await db.query<{ id: string }>(
        `insert into membership_plans (name, duration_days, court_hours, court_discount_pct, price_vnd, is_on_sale)
         values ('Remove plans RP', 30, 5, 20, 500000, true)
         returning id`,
      )
    ).rows[0].id;
    await db.query(
      `insert into subscriptions (user_id, plan_id, start_on, end_on, status, court_hours_left)
       values ($1, $2, current_date - 1, current_date + 30, 'active', $3)`,
      [userId, planId, courtHoursLeft],
    );
  }

  function holdReq(start: string, body: Record<string, unknown> = {}): Request {
    return new Request("http://localhost/v1/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ court_id: courtId, start_at: `${testDate}T${start}:00.000+07:00`, ...body }),
    });
  }

  // RP-full-price: a plan with a 20% court discount and hours left no longer changes the price.
  it("RP-member-fee: a member covered on the day pays the member fee and the hold has no plan hours", async () => {
    const member = await seedMember("00000000-0000-0000-0000-000000000241", "Member RP1");
    await seedPlanSubscription(member.id, 5);

    const res = await withTx(async (sql) => bookingsHold(sql, holdReq("09:00"), member));
    assert.equal(res.status, 201);
    const body = res.body as any;
    assert.equal(body.price, 30000);
    assert.equal(body.membership.covered, true);
    assert.equal("plan_hours_left" in body, false);

    const shift = (await db.query<{ id: string }>("insert into cashier_shifts (receptionist_id) values ($1) returning id", [receptionistUser.id])).rows[0];
    const paid = await withTx(async (sql) =>
      paymentsCreate(
        sql,
        new Request("http://localhost/v1/payments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ref_type: "booking", ref_id: body.booking.id, method: "cash", amount_vnd: body.due_now_vnd }),
        }),
        receptionistUser,
      ),
    );
    assert.equal(paid.status, 201);
    await db.query("update cashier_shifts set closed_at = now() where id = $1", [shift.id]);

    const sub = (await db.query<{ court_hours_left: number }>(
      "select court_hours_left from subscriptions where user_id = $1",
      [member.id],
    )).rows[0];
    assert.equal(Number(sub.court_hours_left), 5);
  });

  // RP-no-quota: "quota" is no longer a way to pay for a court.
  it("RP-no-quota: confirming a hold with method quota is rejected with 422 on method", async () => {
    const member = await seedMember("00000000-0000-0000-0000-000000000242", "Member RP2");
    await seedPlanSubscription(member.id, 5);
    const hold = await withTx(async (sql) => bookingsHold(sql, holdReq("10:00"), member));
    const bookingId = (hold.body as any).booking.id;

    await assert.rejects(
      async () =>
        withTx(async (sql) =>
          bookingsConfirm(
            sql,
            bookingId,
            new Request(`http://localhost/v1/bookings/${bookingId}/confirm`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ method: "quota" }),
            }),
            member,
          ),
        ),
      (err: any) => {
        assert.equal(err.status, 422);
        assert.equal(err.extra?.field, "method");
        return true;
      },
    );
  });

  // RP-old-quota-cancel: a booking paid with plan hours before plans went can still be cancelled,
  // but nothing is refunded and no subscription or payment row is touched.
  it("RP-old-quota-cancel: cancelling an old quota booking refunds nothing and leaves the plan alone", async () => {
    const member = await seedMember("00000000-0000-0000-0000-000000000243", "Member RP3");
    await seedPlanSubscription(member.id, 0);
    const bookingId = "30000000-0000-0000-0000-000000000241";
    const occId = (
      await db.query<{ id: string }>(
        `insert into occupancies (id, court_id, start_at, end_at, kind, ref_id)
         values (gen_random_uuid(), $1, '2026-12-20 08:00:00+07', '2026-12-20 09:00:00+07', 'booking', $2)
         returning id`,
        [courtId, bookingId],
      )
    ).rows[0].id;
    await db.query(
      `insert into court_bookings (id, court_id, user_id, start_at, end_at, status, price_vnd, deposit_vnd, paid_vnd, code, channel, quota_hours, occupancy_id)
       values ($1, $2, $3, '2026-12-20 08:00:00+07', '2026-12-20 09:00:00+07', 'confirmed', 100000, 0, 0, 'BK-RP-OLD', 'app', 1, $4)`,
      [bookingId, courtId, member.id, occId],
    );

    const res = await withTx(async (sql) => bookingsCancel(sql, bookingId, member));
    assert.equal(res.status, 200);
    assert.equal((res.body as any).refund, null);

    const payments = (await db.query<{ n: number }>("select count(*)::int as n from payments where ref_id = $1", [bookingId])).rows[0];
    assert.equal(payments.n, 0);
    const sub = (await db.query<{ court_hours_left: number }>(
      "select court_hours_left from subscriptions where user_id = $1",
      [member.id],
    )).rows[0];
    assert.equal(Number(sub.court_hours_left), 0);
  });
});

describe("Remove plans: sales", () => {
  const receptionist = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist", full_name: "Lễ tân RP-sales" } as any;

  // RP-no-sub-payment: subscription is an accepted ref_type; an order that does not exist is refused and nothing is posted.
  it("RP-no-sub-payment: paymentsCreate accepts ref_type subscription but refuses an unknown plan order with 404 and posts nothing", async () => {
    // The desk needs an open shift first (BR-44); without one the request is refused
    // before ref_type is read, which is what made the old expectation unreachable.
    const shift = (
      await db.query<{ id: string }>("insert into cashier_shifts (receptionist_id) values ($1) returning id", [receptionist.id])
    ).rows[0];
    const missingId = "50000000-0000-0000-0000-000000000299";
    try {
      await assert.rejects(
        async () =>
          withTx(async (sql) =>
            paymentsCreate(
              sql,
              new Request("http://localhost/v1/payments", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ref_type: "subscription", ref_id: missingId, method: "cash", amount_vnd: 500000 }),
              }),
              receptionist,
            ),
          ),
        (err: any) => {
          assert.equal(err.status, 404);
          assert.equal(err.code, "NOT_FOUND");
          assert.notEqual(err.extra?.field, "ref_type", "subscription must stay an accepted ref_type");
          return true;
        },
      );
      const n = (
        await db.query<{ n: number }>("select count(*)::int as n from payments where ref_type = 'subscription' and ref_id = $1", [missingId])
      ).rows[0].n;
      assert.equal(n, 0, "a refused plan payment writes no money");
    } finally {
      await db.query("update cashier_shifts set closed_at = now() where id = $1", [shift.id]);
    }
  });

  // RP-no-plan-route: POST /v1/subscriptions exists and requires authentication.
  it("RP-no-plan-route: POST /v1/subscriptions exists and refuses an unauthenticated caller with 401", async () => {
    // handleApi starts the 15 s job loop unless it already runs; that interval would keep the test process alive.
    (globalThis as any).__arena3Jobs__ = true;
    const before = (await db.query<{ n: number }>("select count(*)::int as n from subscriptions")).rows[0].n;
    const res = await handleApi(
      new Request("http://localhost/v1/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan_id: "20000000-0000-0000-0000-000000000001" }),
      }),
    );
    assert.equal(res.status, 401);
    const after = (await db.query<{ n: number }>("select count(*)::int as n from subscriptions")).rows[0].n;
    assert.equal(after, before, "an unauthenticated request creates no order");
  });

  // RP-sub-target: staff may only issue a plan order to a member.
  it("RP-sub-target: subscriptionsCreate refuses a missing target user (field user_id) and a non-member target (403)", async () => {
    const { subscriptionsCreate } = await import("./handlers/plans.ts");
    const call = (userId: string) =>
      withTx((sql) =>
        subscriptionsCreate(
          sql,
          new Request("http://localhost/v1/subscriptions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ plan_id: "20000000-0000-0000-0000-000000000002", user_id: userId }),
          }),
          receptionist,
        ),
      );
    await assert.rejects(call("50000000-0000-0000-0000-000000000298"), (e: any) => {
      assert.equal(e.extra?.field, "user_id");
      return true;
    });
    await assert.rejects(call(receptionist.id), (e: any) => {
      assert.equal(e.status, 403);
      return true;
    });
  });

  // RP-old-link: a payOS link raised for a plan order that has since gone is refused, nothing is posted or activated.
  it("RP-old-link: a paid link for a plan order that no longer exists is refused (404) and posts and activates nothing", async () => {
    const { settleOnline } = await import("./handlers/online.ts");
    const pay = {
      id: "40000000-0000-0000-0000-000000000299",
      code: "PAY-RP-OLD-LINK",
      user_id: "00000000-0000-0000-0000-000000000004",
      amount_vnd: 500000,
      status: "pending",
      ref_type: "subscription",
      ref_id: "50000000-0000-0000-0000-000000000299",
      provider_order_code: 987654321,
    } as any;
    // Seed the real pending link row so "nothing posted" is checked against a row that exists.
    await db.query(
      `insert into payments (id, code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, provider_order_code)
       values ($1, $2, $3, 'transfer', $4, 0, 'pending', 'subscription', $5, $6)`,
      [pay.id, pay.code, pay.user_id, pay.amount_vnd, pay.ref_id, pay.provider_order_code],
    );
    const activeBefore = (await db.query<{ n: number }>("select count(*)::int as n from subscriptions where status = 'active'")).rows[0].n;
    // The current code raises NOT_FOUND here and the transaction rolls back. Whether a late
    // callback should instead be recorded as ignored is an open product decision (see handoff).
    await assert.rejects(
      withTx(async (sql) => settleOnline(sql, pay, { amountPaid: 500000, transactionId: "TX-RP-OLD", providerStatus: "PAID" })),
      (e: any) => {
        assert.equal(e.status, 404);
        assert.equal(e.code, "NOT_FOUND");
        return true;
      },
    );
    const posted = (
      await db.query<{ n: number }>("select count(*)::int as n from payments where id = $1 and status = 'posted'", [pay.id])
    ).rows[0];
    assert.equal(posted.n, 0);
    const still = (await db.query<any>("select status::text as status, provider_txn_id from payments where id = $1", [pay.id])).rows[0];
    assert.equal(still.status, "pending", "the update to posted was rolled back");
    assert.equal(still.provider_txn_id, null);
    const activeAfter = (await db.query<{ n: number }>("select count(*)::int as n from subscriptions where status = 'active'")).rows[0].n;
    assert.equal(activeAfter, activeBefore, "nothing was activated");
  });
});

describe("Remove plans: reads", () => {
  const receptionist = { id: "00000000-0000-0000-0000-000000000002", role: "receptionist", full_name: "Lễ tân RP-reads" } as any;
  const manager = { id: "00000000-0000-0000-0000-000000000001", role: "manager", full_name: "Quản lý RP-reads" } as any;
  const planId = "20000000-0000-0000-0000-000000000002";
  const ictToday = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

  async function seedMember(id: string, name: string): Promise<any> {
    const phone = "+8491" + id.replace(/-/g, "").slice(-7);
    await db.query(
      `insert into users (id, phone, full_name, name_normalized, role, password_hash)
       values ($1, $2, $3, $4, 'member', 'hash')
       on conflict (id) do nothing`,
      [id, phone, name, name.toLowerCase()],
    );
    return { id, role: "member", full_name: name } as any;
  }

  async function seedSubscription(userId: string, start: string, end: string): Promise<void> {
    await db.query(
      `insert into subscriptions (user_id, plan_id, start_on, end_on, status)
       values ($1, $2, $3::date, $4::date, 'active')`,
      [userId, planId, start, end],
    );
  }

  async function seedCourt(id: string, code: string): Promise<string> {
    await db.query(
      `insert into courts (id, court_code, sport, status) values ($1, $2, 'badminton', 'ready') on conflict (id) do nothing`,
      [id, code],
    );
    return id;
  }

  async function seedBooking(bookingId: string, courtId: string, userId: string, startAt: string, code: string): Promise<void> {
    const endAt = new Date(new Date(startAt).getTime() + 3600_000).toISOString();
    const occId = (
      await db.query<{ id: string }>(
        `insert into occupancies (id, court_id, start_at, end_at, kind, ref_id)
         values (gen_random_uuid(), $1, $2, $3, 'booking', $4)
         returning id`,
        [courtId, startAt, endAt, bookingId],
      )
    ).rows[0].id;
    await db.query(
      `insert into court_bookings (id, court_id, user_id, start_at, end_at, status, price_vnd, deposit_vnd, paid_vnd, code, channel, occupancy_id)
       values ($1, $2, $3, $4, $5, 'confirmed', 100000, 0, 0, $6, 'app', $7)`,
      [bookingId, courtId, userId, startAt, endAt, code, occId],
    );
  }

  // RP-gate-no-plan: an active subscription alone lets nobody in, and the gate no longer talks about plans.
  it("RP-gate-no-plan: a member with only a subscription and nothing today is not entitled, and no plan warnings", async () => {
    const member = await seedMember("00000000-0000-0000-0000-000000000301", "Member RP-gate-1");
    await seedSubscription(member.id, "2026-01-01", "2099-12-31");
    const { gateCheckin } = await import("./handlers/checkin.ts");
    const res = await withTx((sql) =>
      gateCheckin(
        sql,
        new Request("http://localhost/v1/gate/checkin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ member_id: member.id, reason: "forgot" }),
        }),
        receptionist,
      ),
    );
    const body = res.body as any;
    assert.equal(body.allowed, false);
    assert.equal(body.needs_override, true);
    assert.equal("plans" in body, false);
    const planKinds = ["no_plan", "frozen", "expired", "scheduled", "expiring", "no_sessions"];
    assert.deepEqual(
      body.warnings.filter((w: { kind: string }) => planKinds.includes(w.kind)),
      [],
    );
  });

  // RP-gate-booking: a court booked today is enough to walk through the gate.
  it("RP-gate-booking: a member with a confirmed booking today is entitled", async () => {
    const member = await seedMember("00000000-0000-0000-0000-000000000302", "Member RP-gate-2");
    const courtId = await seedCourt("10000000-0000-0000-0000-0000000000a2", "RPG2");
    await seedBooking("30000000-0000-0000-0000-000000000302", courtId, member.id, `${ictToday}T10:00:00+07:00`, "BKRPG2");
    const { gateCheckin } = await import("./handlers/checkin.ts");
    const res = await withTx((sql) =>
      gateCheckin(
        sql,
        new Request("http://localhost/v1/gate/checkin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ member_id: member.id, reason: "forgot" }),
        }),
        receptionist,
      ),
    );
    const body = res.body as any;
    assert.equal(body.allowed, true);
    assert.equal(body.needs_override, false);
    assert.equal(body.today.bookings.length, 1);
  });

  // RP-report-active: a subscription no longer makes anyone an active member; a booking in range does.
  it("RP-report-active: active members count bookings in range, not subscriptions", async () => {
    const booker = await seedMember("00000000-0000-0000-0000-000000000303", "Member RP-report-1");
    const subOnly = await seedMember("00000000-0000-0000-0000-000000000304", "Member RP-report-2");
    const courtId = await seedCourt("10000000-0000-0000-0000-0000000000a3", "RPR3");
    await seedBooking("30000000-0000-0000-0000-000000000303", courtId, booker.id, "2099-01-10T10:00:00+07:00", "BKRPR3");
    await seedSubscription(subOnly.id, "2098-12-01", "2099-12-31");
    const { membersReportBody } = await import("./handlers/reports.ts");
    const body = await withTx((sql) => membersReportBody(sql, "2099-01-01", "2099-01-31", null));
    assert.equal(body.members.active, 1);
    assert.equal("expiring" in body.members, false);
    assert.equal("plans_ended" in body.members, false);
  });
});


/**
 * The desk side of a support request: closing it, and answering it once.
 *
 * Covers the three things the F6 audit found here — a closed request that the
 * member's screen still called "Waiting", a second answer written over the
 * first, and Close happily reporting success on a ticket that was already
 * closed or never existed.
 */
describe("ticket lifecycle", () => {
  const desk = { id: "00000000-0000-0000-0000-0000000000d1", role: "receptionist" } as any;
  const memberId = "00000000-0000-0000-0000-0000000000d2";
  const missingId = "99999999-9999-4999-8999-999999999991";

  before(async () => {
    await db.query(
      `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
       values ($1, '0987000401', 'Desk D1', 'desk d1', 'receptionist', 'active', 'hash'),
              ($2, '0987000402', 'Member D2', 'member d2', 'member', 'active', 'hash')
       on conflict (id) do nothing`,
      [desk.id, memberId],
    );
  });

  async function newTicket(body = "the lights in BC2 are out") {
    return (
      await db.query<{ id: string }>(`insert into tickets (user_id, body) values ($1,$2) returning id`, [
        memberId,
        body,
      ])
    ).rows[0].id;
  }

  function replyReq(id: string, text: string) {
    return new Request(`http://localhost/v1/tickets/${id}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply: text }),
    });
  }

  const countOf = async (sql: string, params: unknown[]) =>
    (await db.query<{ n: number }>(sql, params)).rows[0].n;

  it("closes once however many times the button is pressed", async () => {
    const id = await newTicket();
    await withTx(async (sql) => {
      assert.equal((await opsH.ticketClose(sql, id, desk)).status, 200);
    });
    // Second press still answers ok — the caller wanted it closed and it is.
    await withTx(async (sql) => {
      assert.equal((await opsH.ticketClose(sql, id, desk)).status, 200);
    });
    assert.equal(
      await countOf(`select count(*)::int as n from audit_logs where action = 'ticket_close' and entity_id = $1`, [id]),
      1,
    );
    assert.equal(
      await countOf(`select count(*)::int as n from outbox where dedupe_key = $1`, [`ticket_closed|${id}`]),
      1,
    );
  });

  it("refuses to close a request that is not there", async () => {
    await assert.rejects(
      async () => withTx(async (sql) => opsH.ticketClose(sql, missingId, desk)),
      (e: any) => {
        assert.equal(e.status, 404);
        return true;
      },
    );
  });

  it("tells the member their request is no longer waiting", async () => {
    const id = await newTicket("duplicate of the one I just sent");
    await withTx(async (sql) => opsH.ticketClose(sql, id, desk));
    const row = (
      await db.query<{ status: string; reply: string | null }>(`select status, reply from tickets where id = $1`, [id])
    ).rows[0];
    assert.equal(row.status, "closed");
    // No answer was written, so the Support badge reads this as "Closed" —
    // judging by `reply` alone was what left it saying "Waiting" for good.
    assert.equal(row.reply, null);
    const note = (
      await db.query<{ template: string; user_id: string }>(
        `select template, user_id from outbox where dedupe_key = $1`,
        [`ticket_closed|${id}`],
      )
    ).rows[0];
    assert.equal(note.template, "ticket_closed");
    assert.equal(note.user_id, memberId);
  });

  it("refuses a second answer instead of writing over the first", async () => {
    const id = await newTicket();
    await withTx(async (sql) => {
      assert.equal((await opsH.ticketReply(sql, id, replyReq(id, "Fixed on Tuesday."), desk)).status, 200);
    });
    await assert.rejects(
      async () => withTx(async (sql) => opsH.ticketReply(sql, id, replyReq(id, "Actually Wednesday."), desk)),
      (e: any) => {
        assert.equal(e.status, 409);
        return true;
      },
    );
    const row = (await db.query<{ reply: string }>(`select reply from tickets where id = $1`, [id])).rows[0];
    assert.equal(row.reply, "Fixed on Tuesday.");
    // One answer, one notification: the dedupe key no longer carries the clock.
    assert.equal(
      await countOf(`select count(*)::int as n from outbox where dedupe_key = $1`, [`ticket_replied|${id}`]),
      1,
    );
  });

  it("still answers a request the desk closed without a reply", async () => {
    const id = await newTicket();
    await withTx(async (sql) => opsH.ticketClose(sql, id, desk));
    // Otherwise Close would be a trap: the request would be unanswerable.
    await withTx(async (sql) => {
      assert.equal((await opsH.ticketReply(sql, id, replyReq(id, "Sorted, sorry for the wait."), desk)).status, 200);
    });
    const row = (await db.query<{ reply: string }>(`select reply from tickets where id = $1`, [id])).rows[0];
    assert.equal(row.reply, "Sorted, sorry for the wait.");
  });

  it("refuses to answer a request that is not there", async () => {
    await assert.rejects(
      async () => withTx(async (sql) => opsH.ticketReply(sql, missingId, replyReq(missingId, "Hello?"), desk)),
      (e: any) => {
        assert.equal(e.status, 404);
        return true;
      },
    );
  });
});

/**
 * Switching F6 off has to stop the module without taking away what people
 * already have. Every F6 write route answers 403 BR-52; the reads that hold a
 * member's own history, and the desk's queue of requests already in, keep
 * working — a manager turning a module off is not deleting anybody's past.
 */
describe("F6 flag gate", () => {
  const member = { id: "00000000-0000-0000-0000-0000000000f1", role: "member" } as any;
  const desk = { id: "00000000-0000-0000-0000-0000000000f2", role: "receptionist" } as any;

  before(async () => {
    await db.query(
      `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
       values ($1, '0987000501', 'Member F1', 'member f1', 'member', 'active', 'hash'),
              ($2, '0987000502', 'Desk F2', 'desk f2', 'receptionist', 'active', 'hash')
       on conflict (id) do nothing`,
      [member.id, desk.id],
    );
  });

  async function setF6(enabled: boolean) {
    await db.query(
      `insert into feature_flags (key, enabled) values ('F6', $1)
       on conflict (key) do update set enabled = excluded.enabled`,
      [enabled],
    );
  }

  const isOff = (e: any) => {
    assert.equal(e.status, 403);
    assert.equal(e.extra?.br, "BR-52");
    assert.equal(e.extra?.flag, "F6");
    return true;
  };

  function post(url: string, body: unknown) {
    return new Request(`http://localhost${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("refuses the module's own routes and keeps the reads that hold history", async () => {
    await setF6(false);
    try {
      await assert.rejects(
        async () => withTx((sql) => opsH.ticketsCreate(sql, post("/v1/tickets", { body: "lights out" }), member)),
        isOff,
      );
      await assert.rejects(
        async () => withTx((sql) => opsH.assistantChat(sql, post("/v1/assistant", { message: "opening hours?" }), member)),
        isOff,
      );
      await assert.rejects(async () => withTx((sql) => chatH.listConversations(sql, member)), isOff);
      await assert.rejects(
        async () =>
          withTx((sql) =>
            chatH.rtcPollHandler(sql, member, new Request("http://localhost/api/rtc?room=r&peer=" + member.id)),
          ),
        isOff,
      );
      await assert.rejects(
        async () => withTx((sql) => chatH.rtcSignalHandler(sql, member, post("/api/rtc", { op: "leave", room: "r" }))),
        isOff,
      );

      // Still readable: the member's own requests and replies (FR-S04)...
      const mine = await withTx((sql) =>
        opsH.ticketsMine(sql, new Request("http://localhost/v1/tickets/mine"), member),
      );
      assert.equal(mine.status, 200);
      // ...and the queue the desk still has to work through.
      const queue = await withTx((sql) => opsH.ticketsList(sql, new Request("http://localhost/v1/tickets"), desk));
      assert.equal(queue.status, 200);
    } finally {
      await setF6(true);
    }
  });

  it("lets the same routes through once the flag is back on", async () => {
    await setF6(true);
    const res = await withTx((sql) =>
      opsH.ticketsCreate(sql, post("/v1/tickets", { body: "the net on BC2 sags" }), member),
    );
    assert.equal(res.status, 201);
    // This one returns its body directly rather than a {status, body} pair.
    const convs = await withTx((sql) => chatH.listConversations(sql, member));
    assert.ok(Array.isArray(convs.conversations));
  });
});

/**
 * The relay has to charge a caller for a request it rejects.
 *
 * The per-room budget cannot be charged until the room is known, so a request
 * missing that parameter skips it entirely. Without a ceiling charged earlier,
 * that is an unlimited loop: each attempt still costs a `requireFlag` query
 * before being thrown out.
 */
describe("rtc signalling quota covers rejected requests", () => {
  const user = { id: "00000000-0000-0000-0000-0000000000e1", role: "member" } as any;

  before(async () => {
    await db.query(
      `insert into users (id, phone, full_name, name_normalized, role, status, password_hash)
       values ($1, '0987000601', 'Member E1', 'member e1', 'member', 'active', 'hash')
       on conflict (id) do nothing`,
      [user.id],
    );
  });

  it("charges a poll with no room, so it cannot be repeated forever", async () => {
    clearLimits();
    const bare = () => new Request("http://localhost/api/rtc");
    // Fill the bucket to one below the ceiling directly, rather than driving
    // two thousand requests through the database to get there.
    for (let i = 0; i < LIMITS.rtcEndpoint.limit - 1; i += 1) {
      takeLimit(`rtc:${user.id}`, LIMITS.rtcEndpoint);
    }
    // Invalid, and rejected as such — but it has to be charged on the way out.
    await assert.rejects(
      async () => withTx((sql) => chatH.rtcPollHandler(sql, user, bare())),
      (e: any) => e.status === 422 || e.status === 400,
    );
    // Which is why the next one is refused instead of reaching the database again.
    await assert.rejects(
      async () => withTx((sql) => chatH.rtcPollHandler(sql, user, bare())),
      (e: any) => {
        assert.equal(e.status, 429);
        return true;
      },
    );
    clearLimits();
  });

  it("leaves teardown out of the per-room budget", async () => {
    clearLimits();
    const room = "99999999-9999-4999-8999-999999999992";
    // Exhaust the room budget the way a long negotiation would.
    for (let i = 0; i < LIMITS.rtcSignal.limit; i += 1) {
      takeLimit(`rtc:${user.id}:${room}`, LIMITS.rtcSignal);
    }
    // A leave must still get through: the client fires it on teardown and
    // ignores the result, so a refusal strands the peer in the roster.
    const res = await withTx((sql) =>
      chatH.rtcSignalHandler(
        sql,
        user,
        new Request("http://localhost/api/rtc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "leave", room, peer: user.id }),
        }),
      ),
    );
    assert.deepEqual(res, { ok: true });
    clearLimits();
  });
});
