import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ACTIVITY, WINDOW_START, demand, random, id, normalize, protectedLogin, suspiciousUser, writableTarget, migrate, populate, verify, prepareLocalDirectory, replaceActivity } from './seed-lively.mjs';

test('bulk replacement locks before any read, and rolls back on failure', async () => {
  const calls = [];
  const stopped = new Error('stop before reading');
  const db = { exec: async sql => calls.push(sql), query: async sql => { calls.push(sql); throw stopped; } };
  await assert.rejects(replaceActivity(db, '2026-11-09T16:00:00Z'), stopped);
  assert.equal(calls[0], 'begin');
  assert.equal(calls[1], `lock table ${ACTIVITY.join(', ')}, users in access exclusive mode`);
  assert.match(calls[2], /^select/);
  assert.equal(calls.at(-1), 'rollback');
});

test('deterministic demand models weekly/hourly rhythm, growth and events', () => {
  assert.equal(WINDOW_START, '2026-09-01');
  assert.equal(random('noise:day'), random('noise:day'));
  for (const d of ['2026-10-05', '2026-10-09', '2026-10-10']) {
    assert.ok(demand(d, 19) > demand(d, 7));
    assert.ok(demand(d, 7) > demand(d, 12));
  }
  assert.ok(demand('2026-10-10', 19) > demand('2026-10-05', 19));
  assert.ok(demand('2026-10-09', 19) > demand('2026-10-06', 19));
  assert.ok(demand('2026-09-02', 19) > demand('2026-09-09', 19));
  assert.ok(demand('2026-10-20', 19) > demand('2026-10-06', 19));
  assert.ok(demand('2026-10-14', 19) > demand('2026-10-07', 19));
  assert.ok(demand('2026-10-28', 19) < demand('2026-10-07', 19));
  assert.ok(demand('2026-11-04', 19) > demand('2026-09-09', 19));
});

test('production guards and protected demo identities', () => {
  for (const url of ['postgres://u:p@ep-demo.neon.tech/db', 'postgres://u:p@db.example.com/db',
    'postgres://u:p@localhost/db?host=ep-prod.neon.tech'])
    assert.throws(() => writableTarget(url), /blocked/);
  assert.throws(() => writableTarget('', ''), /dedicated/);
  assert.throws(() => writableTarget('', 'memory'), /dedicated/);
  assert.doesNotThrow(() => writableTarget('', '.cache/lively-test'));
  assert.throws(() => writableTarget('postgres://u:p@ep-demo.neon.tech/db', '', 'wrong-host'), /hostname/);
  assert.doesNotThrow(() => writableTarget('postgres://u:p@ep-demo.neon.tech/db', '', 'ep-demo.neon.tech'));
  assert.equal(normalize('Đặng Thị Bảo Ngọc'), 'dang thi bao ngoc');
  assert.equal(id('member:1'), id('member:1'));
  for (const u of [{ full_name: 'Coach Test 12345', email: 'coach@arena3.local' },
    { full_name: 'Coach Check 5319583', phone: '+84900000002' }]) {
    assert.ok(protectedLogin(u)); assert.equal(suspiciousUser(u), false);
  }
  assert.ok(suspiciousUser({ full_name: 'Coach Swim 9048569' }));
  assert.equal(suspiciousUser({ full_name: 'Nguyễn Minh Khoa' }), false);
});

test('PGlite directory survives close and reopen on Windows', async () => {
  await mkdir('.cache', { recursive: true });
  const dir = await mkdtemp(resolve('.cache', 'lively-persistence-'));
  await prepareLocalDirectory(dir);
  const first = new PGlite({ dataDir: dir });
  await first.exec('create table persistence_probe(value int); insert into persistence_probe values(42)');
  await first.close();
  await prepareLocalDirectory(dir);
  const second = new PGlite({ dataDir: dir });
  try { assert.equal((await second.query('select value from persistence_probe')).rows[0].value, 42); }
  finally { await second.close(); }
});

test('real migrations, financial/schedule invariants, rerun idempotency and rollback', { timeout: 180000 }, async () => {
  const db = new PGlite({ parsers: { 1082: s => s, 20: Number } });
  try {
    await migrate(db);
    const logins = (await db.query('select id, phone, email, password_hash, google_sub from users order by id')).rows;
    const asOf = '2026-11-09T16:00:00.000Z';
    const snapshot = async () => {
      await db.exec(`truncate table ${ACTIVITY.join(',')} restart identity`);
      const report = await populate(db, asOf);
      assert.ok(report.added.court_bookings > 5000);
      assert.ok(report.added.users === 0 || report.added.users > 50 && report.added.users <= 96);
      assert.equal(report.from, WINDOW_START);
      assert.ok(report.added.conversations >= 200);
      assert.ok(report.added.messages >= 3000);
      assert.ok(report.added.promotion_redemptions > 0);
      const verification = await verify(db, asOf);
      assert.ok(verification.checks >= 38);
      assert.deepEqual(verification.failures, {});
      const result = {};
      for (const t of ACTIVITY) result[t] = (await db.query(`select md5(coalesce(string_agg(row_to_json(r)::text, '|' order by row_to_json(r)::text),'')) hash from ${t} r`)).rows[0].hash;
      return result;
    };
    const first = await snapshot();
    assert.deepEqual(await snapshot(), first, 'same as-of must produce exactly the same activity rows');
    const scalar = async sql => Number((await db.query(sql)).rows[0].n);
    const methods = (await db.query('select distinct method::text method from payments order by 1')).rows.map(r => r.method);
    assert.deepEqual(methods, ['card', 'cash', 'gateway', 'transfer']);
    const weekdays = (await db.query(`select extract(isodow from paid_at at time zone 'Asia/Ho_Chi_Minh')::int weekday,
      sum(amount_vnd)::bigint revenue from payments where paid_at>='2026-10-01T00:00:00+07:00'
      and paid_at<'2026-11-01T00:00:00+07:00' and status='posted' group by 1`)).rows;
    const avg = d => Number(weekdays.find(r => r.weekday === d).revenue) / ([4,4,4,5,5,5,4][d - 1]);
    for (const d of [1, 2]) for (const busy of [3, 4, 5, 6, 7]) assert.ok(avg(busy) > avg(d), `weekday ${busy} should beat ${d}`);
    assert.ok(avg(6) > avg(5) && avg(7) > avg(5), 'weekends have the highest average daily revenue');
    const bookingsOn = date => scalar(`select count(*) n from court_bookings where (start_at at time zone 'Asia/Ho_Chi_Minh')::date='${date}'`);
    assert.ok(await bookingsOn('2026-09-02') > await bookingsOn('2026-09-09'));
    assert.ok(await bookingsOn('2026-10-20') > await bookingsOn('2026-10-06'));
    assert.ok(await bookingsOn('2026-10-28') < await bookingsOn('2026-10-07'));
    assert.ok(await scalar(`select count(distinct (paid_at at time zone 'Asia/Ho_Chi_Minh')::date) n from payments where amount_vnd<0`) > 30);
    assert.ok(await scalar(`select count(*) n from messages where read_at is null`) > 50);
    assert.ok(await scalar(`select count(*) n from messages where read_at is not null`) > 1000);
    assert.ok(await scalar(`select count(distinct action) n from audit_logs`) >= 14);
    assert.ok(await scalar(`select count(*) n from tickets where status='open'`) > 10);
    assert.ok(await scalar(`select count(*) n from tickets where status='closed' and reply is null`) > 0);
    assert.ok(await scalar(`select count(*) n from outbox where read_at is null and sent_at is not null`) > 20);
    const joinedBy = date => scalar(`select count(distinct user_id) n from subscriptions where start_on<='${date}'`);
    assert.ok(await joinedBy('2026-11-09') > await joinedBy('2026-10-01'));
    assert.ok(await joinedBy('2026-10-01') > await joinedBy('2026-09-10'));
    const seededCount = Number((await db.query("select count(*) n from users where email like 'lively.%@example.invalid'")).rows[0].n);
    assert.equal(Number((await db.query('select count(*) n from users')).rows[0].n), logins.length + seededCount);
    for (const u of logins) assert.deepEqual((await db.query('select id, phone, email, password_hash, google_sub from users where id=$1', [u.id])).rows[0], u);
    // The DB's overlap protection stays enabled.
    await db.exec('begin');
    const occ = (await db.query(`insert into occupancies(court_id,start_at,end_at,kind,ref_id)
      select court_id,start_at,end_at,'booking',id from court_bookings limit 1 returning *`)).rows[0];
    await assert.rejects(db.query('insert into occupancies(court_id,start_at,end_at,kind,ref_id) values($1,$2,$3,$4,$5)',
      [occ.court_id, occ.start_at, occ.end_at, 'booking', id('deliberate-conflict')]), /CONFLICT_SLOT/);
    await db.exec('rollback');
    await db.exec('begin');
    await db.exec(`truncate table ${ACTIVITY.join(',')} restart identity`);
    await assert.rejects(populate(db, 'invalid'), /Invalid/);
    await db.exec('rollback');
    assert.deepEqual((await verify(db, asOf)).failures, {});
    // Verify the verifier detects bad new data, rather than only counting checks.
    await db.exec('begin');
    await db.query('update messages set read_at=$1 where id=(select id from messages limit 1)', ['2027-01-01T00:00:00Z']);
    await assert.rejects(verify(db, asOf), /messageWindow/);
    await db.exec('rollback');
    // Early and partial days must not mint activity after their cutoff, even on a rerun.
    for (const cutoff of ['2026-08-31T17:00:00Z', '2026-09-01T05:00:00Z', '2026-09-11T18:00:00Z',
      '2026-10-12T18:00:00Z', '2026-11-09T05:30:00Z']) {
      await db.exec('begin');
      await db.exec(`truncate table ${ACTIVITY.join(',')} restart identity`);
      await populate(db, cutoff);
      assert.deepEqual((await verify(db, cutoff)).failures, {}, cutoff);
      await db.exec('rollback');
    }
    await assert.rejects(populate(db, '2026-08-31T16:59:59Z'), /precedes/);
  } finally { await db.close(); }
});
