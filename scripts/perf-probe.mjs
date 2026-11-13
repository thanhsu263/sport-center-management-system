import "./tests/agent/ts-loader.mjs";
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const { values } = parseArgs({ options: { output: { type: "string" }, baseline: { type: "string" }, runs: { type: "string", default: "9" }, fixture: { type: "string", default: ".cache/perf-fixture.tar.gz" } } });
const runs = Number(values.runs);
assert(Number.isInteger(runs) && runs > 0);
process.env.PGLITE_DATA_DIR = "memory";
process.env.DATABASE_URL = "postgres://mock:mock@localhost/mock";
const db = values.baseline ? new PGlite({ loadDataDir: new Blob([readFileSync(values.fixture)]) }) : new PGlite();
await db.waitReady;
const { setOverridePglite } = await import("../src/server/controllers/tx.ts");
const bookings = await import("../src/server/controllers/handlers/bookings.ts");
const classes = await import("../src/server/controllers/handlers/classes.ts");
const desk = await import("../src/server/controllers/handlers/desk.ts");
const reports = await import("../src/server/controllers/handlers/reports.ts");
const staff = await import("../src/server/controllers/handlers/staff.ts");
const { toPublic } = await import("../src/server/controllers/session.ts");
const { ictDateString, addDays } = await import("../src/shared/arena3/time.ts");
setOverridePglite(db);
const date = "2026-11-09";
if (!values.baseline) {
  for (const name of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) await db.exec(readFileSync(`migrations/${name}`, "utf8"));
  await db.exec(`
    insert into users (id, full_name, name_normalized, phone, role, password_hash)
    values ('99999999-9999-4999-8999-999999999999', 'Perf Member', 'perf member', '+84999999999', 'member', 'unused');
    insert into courts (court_code, sport, status) select 'PF' || g, 'badminton', 'ready' from generate_series(1,20) g;
    insert into classes (sport, level, coach_id, court_id, capacity, rrule, duration_min, start_on, end_on, status)
    select 'badminton', 'perf-' || g, (select id from users where role='coach' limit 1),
      (select id from courts where court_code='PF1'), 20, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10', 60, '2026-11-01', '2026-11-30', 'open' from generate_series(1,500) g;
    insert into audit_logs (actor_id, action, entity, entity_id, at)
    select (select id from users where role='manager' limit 1), 'create_class', 'class', id, '2026-11-01' from classes where level like 'perf-%';
    insert into payments (code, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_at)
    select 'PF-' || g, case when g % 3=0 then 'transfer'::pay_method else 'cash'::pay_method end,
      case when g % 11=0 then -10000 else 100000 end, 0, 'posted',
      case when g % 2=0 then 'booking' else 'enrollment' end, gen_random_uuid(),
      '2026-10-01T00:00:00+07:00'::timestamptz + (g % 60) * interval '1 day' from generate_series(1,12000) g;
    insert into occupancies (court_id,start_at,end_at,kind,ref_id)
    select c.id, '2026-11-01T07:00:00+07:00'::timestamptz + g * interval '1 day',
      '2026-11-01T08:00:00+07:00'::timestamptz + g * interval '1 day', 'booking', gen_random_uuid()
    from courts c cross join generate_series(0,29) g where c.court_code like 'PF%';
    analyze;
  `);
  mkdirSync(".cache", { recursive: true });
  const dump = await db.dumpDataDir("gzip");
  writeFileSync(values.fixture, Buffer.from(await dump.arrayBuffer()));
}
const manager = toPublic((await db.query("select * from users where role='manager' limit 1")).rows[0]);
const member = toPublic((await db.query("select * from users where id='99999999-9999-4999-8999-999999999999'")).rows[0]);
const courtId = (await db.query("select id from courts where court_code='PF20'")).rows[0].id;
const request = (path) => new Request(`http://perf.local/v1${path}`);
const window = "from=2026-11-01&to=2026-11-30";
const cases = [
  ["occupancy", (sql) => bookings.occupancyGet(sql, request(`/occupancy?date=${date}`))],
  ["availability", (sql) => bookings.availabilityGet(sql, request(`/availability?from=${date}&days=31`))],
  ["booking_hold", async (sql) => {
    const out = await bookings.bookingsHold(sql, new Request("http://perf.local/v1/bookings/hold", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ court_id: courtId, start_at: `${addDays(ictDateString(), 1)}T13:00:00+07:00` }) }), member);
    return { status: out.status, booking_status: out.body.booking.status, price: out.body.price, due_now_vnd: out.body.due_now_vnd, membership: out.body.membership };
  }],
  ["classes", (sql) => classes.classesList(sql, request("/classes"), manager)],
  ["revenue", (sql) => desk.reportsRevenue(sql, request(`/reports/revenue?${window}`), manager)],
  ["capacity", (sql) => reports.reportsCapacity(sql, request(`/reports/capacity?${window}`), manager)],
  ["members", (sql) => reports.reportsMembers(sql, request(`/reports/members?${window}`), manager)],
  ["manager_dashboard", async (sql) => ({ revenue: await desk.reportsRevenue(sql, request(`/reports/revenue?${window}`), manager), occupancy: await desk.reportsOccupancy(sql, request(`/reports/occupancy?date=${date}`), manager), map: await bookings.occupancyGet(sql, request(`/occupancy?date=${date}`)), staff: await staff.staffList(sql, request("/staff?limit=100"), manager) })],
  ["desk_pending", (sql) => desk.paymentsPending(sql, request("/payments/pending?days=30"), manager)],
  ["desk_payment", async (sql, sub) => {
    const out = await desk.paymentsCreate(sql, new Request("http://perf.local/v1/payments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref_type: "subscription", ref_id: sub.id, method: "cash", amount_vnd: sub.price_vnd }) }), manager);
    return { status: out.status, amount_vnd: out.body.payment.amount_vnd, method: out.body.payment.method, invoice_total: out.body.invoice.total_vnd };
  }, async () => (await db.query(`insert into subscriptions (user_id, plan_id, start_on, end_on, status, price_vnd)
    select (select id from users where role='member' and not exists (select 1 from subscriptions s where s.user_id=users.id and s.status in ('active','frozen','pending')) limit 1), id, '2026-11-09', '2026-12-09', 'pending', price_vnd from membership_plans where is_on_sale and price_vnd > 0 limit 1 returning id, price_vnd`)).rows[0]],
];
const results = [];
try {
  for (const [name, handler, prepare] of cases) {
    const samples = [];
    const counts = [];
    let response;
    let statements;
    for (let i = 0; i < runs + 2; i++) {
      await db.exec("begin");
      const prepared = await prepare?.();
      const queries = [];
      const sql = Object.assign(async (strings, ...params) => sql.query(strings.reduce((s, part, i) => s + (i ? `$${i}` : "") + part, ""), params), {
        query: async (text, params = []) => { queries.push(text.replace(/\s+/g, " ").trim()); return (await db.query(text, params)).rows; },
      });
      const start = performance.now();
      try { response = await handler(sql, prepared); } finally { samples.push(performance.now() - start); counts.push(queries.length); statements = queries; await db.exec("rollback"); }
    }
    samples.splice(0, 2);
    counts.splice(0, 2);
    assert.equal(new Set(counts).size, 1, `${name}: inconsistent query counts`);
    samples.sort((a, b) => a - b);
    const hash = createHash("sha256").update(JSON.stringify(response, (_, v) => typeof v === "bigint" ? Number(v) : v)).digest("hex");
    const result = { name, median_ms: +samples[Math.floor(samples.length / 2)].toFixed(3), min_ms: +samples[0].toFixed(3), max_ms: +samples.at(-1).toFixed(3), queries: counts[0], query_counts: [...new Set(counts)], hash, statements };
    if (values.baseline) assert.equal(hash, JSON.parse(readFileSync(values.baseline, "utf8")).results.find((r) => r.name === name).hash, `${name}: response changed`);
    results.push(result);
    console.log(`${name}: ${result.median_ms} ms, ${result.queries} queries`);
  }
  const output = { date, engine: "PGlite", node: process.version, runs, warmups: 2, fixture: values.fixture, results };
  if (values.output) writeFileSync(values.output, JSON.stringify(output, null, 2) + "\n");
} finally { setOverridePglite(null); await db.close(); }
