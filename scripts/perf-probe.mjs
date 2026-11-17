/**
 * Script đo lường và kiểm chuẩn hiệu năng (performance benchmark & regression probe) cho hệ thống Arena3.
 * File này chạy độc lập qua Node CLI, dựng cơ sở dữ liệu PGlite trong bộ nhớ (in-memory) kèm bộ dữ liệu mẫu lớn
 * (12.000 payments, 500 classes, 20 courts, lịch đặt sân), sau đó giả lập gọi trực tiếp các controller handler
 * quan trọng (occupancy, booking hold, classes, báo cáo doanh thu, thanh toán) để đo thời gian phản hồi (median, min, max)
 * và đếm số lượng câu query SQL phát sinh, phát hiện sớm tình trạng N+1 query hoặc suy giảm hiệu năng.
 */
import "./tests/agent/ts-loader.mjs";
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

// Bước 1: Đọc và kiểm tra các tham số dòng lệnh (output, baseline, runs, fixture).
const { values } = parseArgs({ options: { output: { type: "string" }, baseline: { type: "string" }, runs: { type: "string", default: "9" }, fixture: { type: "string", default: ".cache/perf-fixture.tar.gz" } } });
const runs = Number(values.runs);
// Số lần chạy phải là số nguyên dương để đảm bảo tính toán thời gian trung vị (median) chính xác.
assert(Number.isInteger(runs) && runs > 0);
// Cấu hình PGlite chạy in-memory; nếu có baseline thì nạp sẵn dữ liệu từ file fixture tar.gz để tiết kiệm thời gian.
process.env.PGLITE_DATA_DIR = "memory";
process.env.DATABASE_URL = "postgres://mock:mock@localhost/mock";
const db = values.baseline ? new PGlite({ loadDataDir: new Blob([readFileSync(values.fixture)]) }) : new PGlite();
await db.waitReady;
// Bước 2: Import các controller handler và nạp hàm ghi đè instance PGlite vào tầng điều khiển giao dịch (tx).
const { setOverridePglite } = await import("../src/server/controllers/tx.ts");
const bookings = await import("../src/server/controllers/handlers/bookings.ts");
const classes = await import("../src/server/controllers/handlers/classes.ts");
const desk = await import("../src/server/controllers/handlers/desk.ts");
const reports = await import("../src/server/controllers/handlers/reports.ts");
const staff = await import("../src/server/controllers/handlers/staff.ts");
const { toPublic } = await import("../src/server/controllers/session.ts");
const { ictDateString, addDays } = await import("../src/shared/arena3/time.ts");
// Ghi đè kết nối database trong withTx sang instance PGlite giả lập để cô lập môi trường test.
setOverridePglite(db);
const date = "2026-11-09";
// Bước 3: Nạp cấu trúc bảng qua migrations và tạo dữ liệu giả lập quy mô lớn (stress data) nếu chưa có sẵn fixture.
if (!values.baseline) {
  // Quét và thực thi tuần tự các file migration SQL theo thứ tự chữ cái để khởi tạo toàn bộ schema.
  for (const name of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) await db.exec(readFileSync(`migrations/${name}`, "utf8"));
  // Chèn lượng lớn dữ liệu mẫu (20 courts, 500 classes, 12.000 payments, 30 ngày occupancies) và chạy analyze để cập nhật thống kê truy vấn.
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
  // Lưu snapshot dữ liệu vừa khởi tạo vào file nén tar.gz để tái sử dụng làm fixture cho các lần chạy sau.
  mkdirSync(".cache", { recursive: true });
  const dump = await db.dumpDataDir("gzip");
  writeFileSync(values.fixture, Buffer.from(await dump.arrayBuffer()));
}
// Bước 4: Lấy thông tin tài khoản mẫu (manager, member) và sân thi đấu để phục vụ các yêu cầu kiểm thử.
const manager = toPublic((await db.query("select * from users where role='manager' limit 1")).rows[0]);
const member = toPublic((await db.query("select * from users where id='99999999-9999-4999-8999-999999999999'")).rows[0]);
const courtId = (await db.query("select id from courts where court_code='PF20'")).rows[0].id;
/**
 * Làm gì: Tạo đối tượng Request giả lập gọi đến API v1 cho các bài kiểm tra hiệu năng.
 * Được gọi ở: scripts/perf-probe.mjs trong danh sách các test case (cases).
 * - Tham số path: Đường dẫn endpoint cần gọi (ví dụ: "/classes", "/occupancy?date=...").
 * - Trả về: Đối tượng Request hoàn chỉnh để truyền vào controller handler.
 */
const request = (path) => new Request(`http://perf.local/v1${path}`);
const window = "from=2026-11-01&to=2026-11-30";
// Bước 5: Khai báo danh sách các kịch bản kiểm thử hiệu năng cho các API trọng yếu (sân trống, giữ chỗ, báo cáo, thanh toán).
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
  // Bước 6: Duyệt qua từng kịch bản, chạy lặp nhiều lần để đo thời gian thực thi và số lượng câu lệnh SQL.
  for (const [name, handler, prepare] of cases) {
    const samples = [];
    const counts = [];
    let response;
    let statements;
    // Chạy thêm 2 lần đầu (warmup) để JIT compile và nạp cache bộ nhớ trước khi lấy mẫu đo chính thức.
    for (let i = 0; i < runs + 2; i++) {
      // Mở transaction trước mỗi lần chạy để cô lập các thao tác ghi dữ liệu.
      await db.exec("begin");
      const prepared = await prepare?.();
      const queries = [];
      // Giả lập client sql tương thích với Sql interface để chặn (intercept), chuẩn hóa khoảng trắng và đếm mọi câu query phát sinh khi chạy handler.
      const sql = Object.assign(async (strings, ...params) => sql.query(strings.reduce((s, part, i) => s + (i ? `$${i}` : "") + part, ""), params), {
        query: async (text, params = []) => { queries.push(text.replace(/\s+/g, " ").trim()); return (await db.query(text, params)).rows; },
      });
      // Đo thời gian handler xử lý bằng performance.now() với độ chính xác cao (sub-millisecond).
      const start = performance.now();
      // Luôn rollback transaction trong finally để hoàn tác mọi thay đổi (đặt chỗ, thanh toán), giữ nguyên trạng thái dữ liệu cho lần lặp tiếp theo.
      try { response = await handler(sql, prepared); } finally { samples.push(performance.now() - start); counts.push(queries.length); statements = queries; await db.exec("rollback"); }
    }
    // Bỏ qua kết quả của 2 lần chạy làm nóng (warmup) đầu tiên để loại trừ độ trễ do khởi động lạnh.
    samples.splice(0, 2);
    counts.splice(0, 2);
    // Kiểm tra tính nhất quán: số câu query SQL phải giống hệt nhau giữa tất cả các lượt chạy, không được dao động.
    assert.equal(new Set(counts).size, 1, `${name}: inconsistent query counts`);
    samples.sort((a, b) => a - b);
    // Tạo mã băm SHA-256 từ kết quả trả về (chuyển đổi kiểu bigint sang number) để đối soát tính ổn định dữ liệu.
    const hash = createHash("sha256").update(JSON.stringify(response, (_, v) => typeof v === "bigint" ? Number(v) : v)).digest("hex");
    const result = { name, median_ms: +samples[Math.floor(samples.length / 2)].toFixed(3), min_ms: +samples[0].toFixed(3), max_ms: +samples.at(-1).toFixed(3), queries: counts[0], query_counts: [...new Set(counts)], hash, statements };
    // Nếu có file baseline, kiểm tra mã băm phải khớp chính xác để đảm bảo thay đổi mã nguồn không làm sai lệch phản hồi của API.
    if (values.baseline) assert.equal(hash, JSON.parse(readFileSync(values.baseline, "utf8")).results.find((r) => r.name === name).hash, `${name}: response changed`);
    results.push(result);
    console.log(`${name}: ${result.median_ms} ms, ${result.queries} queries`);
  }
  // Bước 7: Tổng hợp kết quả kiểm chuẩn hiệu năng (median, min, max, số query) và ghi ra file JSON nếu có tùy chọn --output.
  const output = { date, engine: "PGlite", node: process.version, runs, warmups: 2, fixture: values.fixture, results };
  if (values.output) writeFileSync(values.output, JSON.stringify(output, null, 2) + "\n");
// Dọn dẹp tài nguyên khi kết thúc hoặc gặp lỗi: hủy bỏ override PGlite trong tx và đóng kết nối cơ sở dữ liệu.
} finally { setOverridePglite(null); await db.close(); }
