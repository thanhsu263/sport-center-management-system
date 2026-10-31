#!/usr/bin/env node
/**
 * Start a throwaway dev server for testing: in-memory PGLite, every outside
 * integration switched off.
 *
 * `npm run dev` on this machine is NOT safe to test against. `.env.local`
 * points DATABASE_URL at the real Neon database, and `.env` carries live payOS
 * and SMTP keys — so a test run would write bookings into production, open real
 * payment links and send real mail. Each of those integrations treats an empty
 * (or whitespace) value as "not configured", and a value already in the
 * environment wins over both files, so blanking them here is what isolates the
 * run. Setting them to "" rather than deleting them matters: a deleted key is
 * simply filled back in from the file.
 *
 * The server only counts as safe once it has printed the in-memory PGLite line.
 * Anything else (the "persisting to" line, or no line at all) kills it and
 * exits 1 — the caller must stop, not carry on.
 *
 *   node scripts/tests/start-safe-server.mjs            # port 8090
 *   PORT=8091 node scripts/tests/start-safe-server.mjs
 *
 * Output is mirrored to test-output/server.log. Stop it with Ctrl+C.
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";

const PORT = String(process.env.PORT ?? "8090");
const READY_TIMEOUT_MS = 180_000;
const SAFE_LINE = "[db] PGLite running in memory";
const UNSAFE_LINE = "[db] PGLite persisting to";

const BLANK = [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "NEON_BRANCH",
  "PAYOS_CLIENT_ID",
  "PAYOS_API_KEY",
  "PAYOS_CHECKSUM_KEY",
  "PAYOS_TEST_AMOUNT",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "MAIL_FROM",
  "MAIL_TRANSPORT",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "VERCEL_OIDC_TOKEN",
];

const env = { ...process.env, PGLITE_DATA_DIR: "memory", OTP_ECHO: "1" };
for (const key of BLANK) env[key] = "";

mkdirSync("test-output", { recursive: true });
const log = createWriteStream("test-output/server.log", { flags: "w" });

const child = spawn("npm", ["run", "dev", "--", "--port", PORT], { env, shell: true, windowsHide: true });

let safe = false;
let ready = false;
let checking = false;

function stop(code, why) {
  if (why) console.error(`\n[safe-server] ${why}`);
  child.kill("SIGTERM");
  // `shell: true` on Windows leaves the vite process behind a cmd.exe; take
  // the whole tree down so the port is released.
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  }
  setTimeout(() => process.exit(code), 500);
}

function onOutput(chunk) {
  const text = chunk.toString();
  process.stdout.write(text);
  log.write(text);
  if (text.includes(UNSAFE_LINE)) stop(1, "UNSAFE: PGLite is persisting to disk instead of running in memory. STOP.");
  if (text.includes(SAFE_LINE)) safe = true;
}

child.stdout.on("data", onOutput);
child.stderr.on("data", onOutput);
child.on("exit", (code) => {
  if (!ready) console.error(`[safe-server] dev server exited before it was ready (code ${code}). STOP.`);
  process.exit(ready ? 0 : 1);
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(0));

const started = Date.now();
const timer = setInterval(async () => {
  if (checking || ready) return;
  if (Date.now() - started > READY_TIMEOUT_MS) {
    clearInterval(timer);
    stop(1, `UNSAFE or broken: no "${SAFE_LINE}" line and/or no answer from /v1/plans within ${READY_TIMEOUT_MS / 1000}s. STOP.`);
    return;
  }
  checking = true;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/plans`);
    if (res.status !== 200) return;
  } catch {
    return;
  } finally {
    checking = false;
  }
  checking = true;
  // The PGLite line is printed when the database first opens, which the
  // request above forces. Give the log a moment to flush before judging.
  if (!safe) await new Promise((r) => setTimeout(r, 2000));
  clearInterval(timer);
  if (!safe) {
    stop(1, `UNSAFE: the server answers but never printed "${SAFE_LINE}" — it is probably on the real database. STOP.`);
    return;
  }
  // payOS reports itself through the public flags route; it must be off.
  const flags = await fetch(`http://127.0.0.1:${PORT}/v1/flags`).then((r) => r.json()).catch(() => null);
  if (flags?.capabilities?.online_payment !== false) {
    stop(1, "UNSAFE: payOS is still switched on (capabilities.online_payment is not false). STOP.");
    return;
  }
  ready = true;
  const banner = `SAFE TEST SERVER READY at http://127.0.0.1:${PORT} (in-memory PGLite, payOS/SMTP/AI off)`;
  console.log(`\n[safe-server] ${banner}\n`);
  log.write(`\n[safe-server] ${banner}\n`);
}, 2000);
