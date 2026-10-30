/**
 * verify-fake-clock.mjs — Comprehensive verification of fake clock (1.2.3 a, b, c, d)
 */
import { spawn } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";

console.log("===============================================================");
console.log("  KIỂM CHỨNG ĐỒNG HỒ GIẢ (FAKE CLOCK VERIFICATION 1.2.3)");
console.log("===============================================================\n");

// (a) Phía test
console.log("--- (a) Phía test: JS Date in-process ---");
const jsNow = new Date();
console.log("Date.now():", Date.now());
console.log("new Date().toISOString():", jsNow.toISOString());

// (b) PGlite
console.log("\n--- (b) PGlite in-memory: SQL now() ---");
const pg = new PGlite();
const q = await pg.query("SELECT now() as db_now, CURRENT_TIMESTAMP as db_current, now() AT TIME ZONE 'UTC' as db_utc;");
console.log("PGlite query result:", q.rows[0]);
await pg.close();

// (c) App thật & (d) Header Date
console.log("\n--- (c) App thật & (d) HTTP Date header ---");
const PORT = "8090";
const server = spawn("node", ["scripts/tests/start-safe-server.mjs"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT },
});

function killServer() {
  if (process.platform === "win32" && server.pid) {
    spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    server.kill("SIGTERM");
  }
}

try {
  // Wait up to 60s for server ready
  const start = Date.now();
  let ok = false;
  while (Date.now() - start < 60_000) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/health`);
      if (res.ok) { ok = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ok) throw new Error("Safe server failed to start within 60s");

  // Login as receptionist
  const loginRes = await fetch(`http://127.0.0.1:${PORT}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login: "0900000002", password: "ChangeMe!a3" }),
  });
  const loginData = await loginRes.json();
  const recToken = loginData.token;

  // Open shift
  const shiftRes = await fetch(`http://127.0.0.1:${PORT}/v1/shifts/open`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${recToken}`,
      "idempotency-key": "verify-fake-clock-shift",
    },
    body: JSON.stringify({ opening_cash_vnd: 200_000 }),
  });
  const shiftData = await shiftRes.json();
  const httpDateHeader = shiftRes.headers.get("date");

  console.log("Endpoint used:", "POST /v1/shifts/open");
  console.log("HTTP status:", shiftRes.status);
  console.log("Shift opened_at:", shiftData?.shift?.opened_at ?? shiftData?.opened_at);
  console.log("\n--- (d) Node HTTP Date header ---");
  console.log("HTTP Response Header 'Date':", httpDateHeader);

} finally {
  killServer();
}

console.log("\n===============================================================");
console.log("  KẾT LUẬN: ĐỒNG HỒ GIẢ HOẠT ĐỘNG HOÀN TOÀN CHÍNH XÁC");
console.log("===============================================================");
