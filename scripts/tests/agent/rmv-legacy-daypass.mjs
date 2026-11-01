import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";

// Register .ttf loader so desk.ts -> pdf.ts loads in Node without Vite
register("./ttf-loader.mjs", import.meta.url);
// Prevent src/lib/db.ts from running Vite-only import.meta.glob during module load
process.env.DATABASE_URL = "postgres://mock:mock@localhost/mock";

function createSql(db) {
  const sql = async (strings, ...values) => {
    let text = strings[0] ?? "";
    for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1]}`;
    const res = await db.query(text, values);
    return res.rows;
  };
  sql.query = async (text, params = []) => {
    const res = await db.query(text, params);
    return res.rows;
  };
  return sql;
}

function toUser(r) {
  return {
    id: r.id,
    member_code: r.member_code ?? null,
    full_name: r.full_name,
    phone: r.phone,
    email: r.email ?? null,
    role: r.role,
    status: r.status,
    date_of_birth: r.date_of_birth ?? null,
    health_notes: r.health_notes ?? null,
    must_change_password: Boolean(r.must_change_password),
  };
}

async function main() {
  console.log("=== RMV-LEGACY-DAYPASS: Verify Historical day_pass and sell_day_pass via Real App Handlers ===");

  // 1. Initialize PGlite and apply all migrations in order
  const db = new PGlite();
  const migDir = "migrations";
  const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sqlContent = readFileSync(join(migDir, f), "utf8");
    await db.exec(sqlContent);
  }
  const sql = createSql(db);

  // 2. Import real app handlers
  const deskH = await import("../../../src/lib/arena3/handlers/desk.ts");
  const extrasH = await import("../../../src/lib/arena3/handlers/extras.ts");

  // 3. Load users
  const uRecRow = (await db.query(`select * from users where role = 'receptionist' limit 1`)).rows[0];
  const uMgrRow = (await db.query(`select * from users where role = 'manager' limit 1`)).rows[0];
  const uMemRow = (await db.query(`select * from users where role = 'member' limit 1`)).rows[0];

  const uRec = toUser(uRecRow);
  const uMgr = toUser(uMgrRow);
  const uMem = toUser(uMemRow);

  console.log(`[setup] Receptionist: ${uRec.full_name} (${uRec.id})`);
  console.log(`[setup] Manager: ${uMgr.full_name} (${uMgr.id})`);
  console.log(`[setup] Member: ${uMem.full_name} (${uMem.id})`);

  // Step 1: Receptionist opens till shift via real handler
  const openRes = await deskH.shiftOpen(sql, uRec);
  const shift = openRes.body.shift;
  console.log(`[1] Lễ tân mở ca thật (shiftOpen): ${shift.id}`);

  // Step 2: Record metrics BEFORE
  const curReq = new Request("http://localhost/v1/shifts/current");
  const curBefore = await deskH.shiftCurrent(sql, uRec, curReq);
  const cashBefore = curBefore.body.totals.cash;
  const allBefore = curBefore.body.totals.all;
  console.log(`[2.1] Tổng ca TRƯỚC (shiftCurrent): cash = ${cashBefore.toLocaleString("vi-VN")} đ, all = ${allBefore.toLocaleString("vi-VN")} đ`);

  const loyaltyBefore = await extrasH.loyaltyBalance(sql, uMem.id);
  const spendBefore = loyaltyBefore.spend_vnd;
  console.log(`[2.2] Member loyalty TRƯỚC (loyaltyBalance extras.ts:383-384): spend_vnd = ${spendBefore.toLocaleString("vi-VN")} đ, points = ${loyaltyBefore.points}`);

  const revReq = new Request("http://localhost/v1/reports/revenue");
  const revBefore = await deskH.reportsRevenue(sql, revReq, uMgr);
  const grossBefore = revBefore.body.totals.gross_vnd ?? 0;
  const revVndBefore = revBefore.body.totals.revenue_vnd ?? 0;
  const dayPassRevBefore = revBefore.body.by_source?.day_pass ?? 0;
  console.log(`[2.3] Doanh thu TRƯỚC (reportsRevenue): gross = ${grossBefore.toLocaleString("vi-VN")} đ, rev = ${revVndBefore.toLocaleString("vi-VN")} đ, day_pass = ${dayPassRevBefore.toLocaleString("vi-VN")} đ`);

  const auditReq = new Request("http://localhost/v1/audit");
  const auditBefore = await deskH.auditList(sql, auditReq, uMgr);
  console.log(`[2.4] Audit list TRƯỚC (auditList): ${auditBefore.body.items.length} items`);

  // Step 3: Insert ONE legacy payment (ref_type='day_pass', method='cash', 60.000đ) and ONE audit row (sell_day_pass)
  const insertAmount = 60000;
  const payId = "10000000-0000-0000-0000-000000000099";
  const payCode = "PAY-20261014-9999";
  console.log(`[3.1] Chèn payment cũ (SQL trực tiếp): 60.000đ, ref_type='day_pass', method='cash', shift_id='${shift.id}'`);
  await db.query(
    `INSERT INTO payments (id, code, user_id, shift_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by)
     VALUES ($1, $2, $3, $4, 'cash', $5, 0.08, 'posted', 'day_pass', '00000000-0000-0000-0000-000000000000', $6)`,
    [payId, payCode, uMem.id, shift.id, insertAmount, uRec.id]
  );

  console.log(`[3.2] Chèn audit cũ (SQL trực tiếp): action='sell_day_pass', entity='day_pass'`);
  await db.query(
    `INSERT INTO audit_logs (actor_id, action, entity, entity_id, before, after)
     VALUES ($1, 'sell_day_pass', 'day_pass', $2, null, '{"price_vnd": 60000, "code": "DP-20261014-001"}'::jsonb)`,
    [uRec.id, payId]
  );

  // Step 4: Record metrics AFTER using real handlers
  const curAfter = await deskH.shiftCurrent(sql, uRec, curReq);
  const cashAfter = curAfter.body.totals.cash;
  const allAfter = curAfter.body.totals.all;
  console.log(`[4.1] Tổng ca SAU (shiftCurrent): cash = ${cashAfter.toLocaleString("vi-VN")} đ, all = ${allAfter.toLocaleString("vi-VN")} đ`);

  const loyaltyAfter = await extrasH.loyaltyBalance(sql, uMem.id);
  const spendAfter = loyaltyAfter.spend_vnd;
  console.log(`[4.2] Member loyalty SAU (loyaltyBalance extras.ts:383-384): spend_vnd = ${spendAfter.toLocaleString("vi-VN")} đ, points = ${loyaltyAfter.points}`);

  const closeReq = new Request(`http://localhost/v1/shifts/${shift.id}/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cash_declared_vnd: cashAfter }),
  });
  const closeRes = await deskH.shiftClose(sql, shift.id, closeReq, uRec);
  const systemCashClose = closeRes.body.cash_system_vnd;
  console.log(`[4.3] Đóng ca thật (shiftClose): cash_declared = ${closeRes.body.cash_declared_vnd.toLocaleString("vi-VN")} đ, cash_system = ${systemCashClose.toLocaleString("vi-VN")} đ`);

  const revAfter = await deskH.reportsRevenue(sql, revReq, uMgr);
  const grossAfter = revAfter.body.totals.gross_vnd ?? 0;
  const revVndAfter = revAfter.body.totals.revenue_vnd ?? 0;
  const dayPassRevAfter = revAfter.body.by_source?.day_pass ?? 0;
  console.log(`[4.4] Doanh thu SAU (reportsRevenue): gross = ${grossAfter.toLocaleString("vi-VN")} đ, rev = ${revVndAfter.toLocaleString("vi-VN")} đ, day_pass = ${dayPassRevAfter.toLocaleString("vi-VN")} đ`);

  const auditAfter = await deskH.auditList(sql, auditReq, uMgr);
  const foundSellDayPass = auditAfter.body.items.some((it) => it.action === "sell_day_pass");
  console.log(`[4.5] Audit list SAU (auditList): ${auditAfter.body.items.length} items, found sell_day_pass = ${foundSellDayPass}`);

  // Step 5: Assertions
  const diffCash = cashAfter - cashBefore;
  const diffAll = allAfter - allBefore;
  const diffSpend = spendAfter - spendBefore;
  const diffGross = grossAfter - grossBefore;
  const diffRevVnd = revVndAfter - revVndBefore;
  const diffDayPassRev = dayPassRevAfter - dayPassRevBefore;

  console.log("=== KẾT QUẢ KIỂM TRA ===");
  console.log(`- Tiền mặt ca tăng: ${diffCash.toLocaleString("vi-VN")} đ (kỳ vọng: ${insertAmount.toLocaleString("vi-VN")} đ)`);
  console.log(`- Tổng tất cả ca tăng: ${diffAll.toLocaleString("vi-VN")} đ (kỳ vọng: ${insertAmount.toLocaleString("vi-VN")} đ)`);
  console.log(`- Tiền mặt hệ thống khi đóng ca: ${systemCashClose.toLocaleString("vi-VN")} đ (khớp cash sau)`);
  console.log(`- Member spend_vnd (extras.ts:383-384) tăng: ${diffSpend.toLocaleString("vi-VN")} đ (kỳ vọng: ${insertAmount.toLocaleString("vi-VN")} đ)`);
  console.log(`- Doanh thu theo nguồn day_pass tăng: ${diffDayPassRev.toLocaleString("vi-VN")} đ (kỳ vọng: ${insertAmount.toLocaleString("vi-VN")} đ)`);
  console.log(`- Tổng doanh thu gross tăng: ${diffGross.toLocaleString("vi-VN")} đ (kỳ vọng: ${insertAmount.toLocaleString("vi-VN")} đ)`);
  console.log(`- Tổng doanh thu net tăng: ${diffRevVnd.toLocaleString("vi-VN")} đ (kỳ vọng: ${insertAmount.toLocaleString("vi-VN")} đ)`);
  console.log(`- Audit list có sell_day_pass: ${foundSellDayPass} (kỳ vọng: true)`);

  let failed = false;
  if (diffCash !== insertAmount) {
    console.error(`FAIL: diffCash (${diffCash}) !== ${insertAmount}`);
    failed = true;
  }
  if (diffAll !== insertAmount) {
    console.error(`FAIL: diffAll (${diffAll}) !== ${insertAmount}`);
    failed = true;
  }
  if (systemCashClose !== cashAfter) {
    console.error(`FAIL: systemCashClose (${systemCashClose}) !== cashAfter (${cashAfter})`);
    failed = true;
  }
  if (diffSpend !== insertAmount) {
    console.error(`FAIL: diffSpend (${diffSpend}) !== ${insertAmount} (extras.ts:384 check)`);
    failed = true;
  }
  if (diffDayPassRev !== insertAmount) {
    console.error(`FAIL: diffDayPassRev (${diffDayPassRev}) !== ${insertAmount}`);
    failed = true;
  }
  if (diffGross !== insertAmount) {
    console.error(`FAIL: diffGross (${diffGross}) !== ${insertAmount}`);
    failed = true;
  }
  if (diffRevVnd !== insertAmount) {
    console.error(`FAIL: diffRevVnd (${diffRevVnd}) !== ${insertAmount}`);
    failed = true;
  }
  if (!foundSellDayPass) {
    console.error(`FAIL: sell_day_pass audit row not found in auditList`);
    failed = true;
  }

  if (failed) {
    console.error("\n>>> VERDICT: FAIL <<<");
    process.exit(1);
  } else {
    console.log("\n>>> VERDICT: PASS (all checks satisfied using real app handlers) <<<");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Lỗi thực thi:", err);
  process.exit(1);
});
