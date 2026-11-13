#!/usr/bin/env node
/**
 * Tell me whether email and payOS are actually connected.
 *
 * Wiring up a third party is mostly a question of whether the credentials in
 * `.env` are the right ones, and the usual way to find out is to trip over a
 * failure in the middle of a demo. This makes the same round trips the app
 * makes — signs in to the mail server, asks payOS to price a link — and says
 * which step broke, without printing a single secret.
 *
 *   node scripts/check-integrations.mjs            both
 *   node scripts/check-integrations.mjs mail       just email
 *   node scripts/check-integrations.mjs payos      just payOS
 *   node scripts/check-integrations.mjs mail --send you@example.com
 *   node scripts/check-integrations.mjs payos --keep     leave a 2,000d link payable
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

try {
  process.loadEnvFile(join(root, ".env"));
} catch {
  // No .env — everything below will simply report "not configured".
}

const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith("-"));
const sendTo = args.includes("--send") ? args[args.indexOf("--send") + 1] : null;
/** Leave the 2,000d test link open so it can actually be paid. */
const keep = args.includes("--keep");

const ok = (m) => console.log(`  \u001b[32mOK\u001b[0m    ${m}`);
const bad = (m) => console.log(`  \u001b[31mFAIL\u001b[0m  ${m}`);
const warn = (m) => console.log(`  \u001b[33mWARN\u001b[0m  ${m}`);
const info = (m) => console.log(`        ${m}`);

/** Show that a secret is present and roughly right, without showing it. */
function fingerprint(value) {
  if (!value) return "(not set)";
  return `${value.length} chars, ends …${value.slice(-4)}`;
}

let failures = 0;

async function checkMail() {
  console.log("\nEmail");
  const nodemailer = require("nodemailer");
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const port = Number(process.env.SMTP_PORT ?? 587);

  if (!host && process.env.MAIL_TRANSPORT === "ethereal") {
    warn("using Ethereal — messages are CAPTURED, never delivered to a real inbox");
    info("fine for development; set SMTP_* before anyone outside the team relies on it");
    return;
  }
  if (!host || !user || !pass) {
    bad("SMTP_HOST / SMTP_USER / SMTP_PASS are not all set");
    info("nothing is sent; codes are written to the server log only");
    failures += 1;
    return;
  }

  info(`host ${host}:${port}  user ${user}`);
  info(`password: ${fingerprint(pass)}`);
  if (host.includes("gmail") && pass.length !== 16 && !pass.includes(" ")) {
    warn("Gmail app passwords are 16 characters — this may be the account password, which will not work");
  }

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  try {
    await transport.verify();
    ok("the mail server accepted these credentials");
  } catch (e) {
    bad(`the mail server refused the connection: ${e.message}`);
    if (/Invalid login|535/i.test(e.message)) {
      info("for Gmail: 2-Step Verification must be on, and this must be an App Password");
    }
    failures += 1;
    return;
  }

  if (sendTo) {
    try {
      const receipt = await transport.sendMail({
        from: process.env.MAIL_FROM?.trim() || user,
        to: sendTo,
        subject: "Arena3 — kiểm tra kết nối email",
        text: "Nếu bạn đọc được thư này, hệ thống đã gửi email thật được.",
      });
      ok(`test message accepted for delivery to ${sendTo} (${receipt.messageId})`);
      info("check the inbox AND the spam folder — a new sender usually lands in spam first");
    } catch (e) {
      bad(`send failed: ${e.message}`);
      failures += 1;
    }
  } else {
    info("add --send you@example.com to put a real message through");
  }
}

async function checkPayos() {
  console.log("\npayOS");
  const clientId = process.env.PAYOS_CLIENT_ID?.trim();
  const apiKey = process.env.PAYOS_API_KEY?.trim();
  const checksumKey = process.env.PAYOS_CHECKSUM_KEY?.trim();

  if (!clientId || !apiKey || !checksumKey) {
    bad("PAYOS_CLIENT_ID / PAYOS_API_KEY / PAYOS_CHECKSUM_KEY are not all set");
    info("the app runs, but every Pay online button stays hidden");
    failures += 1;
    return;
  }
  info(`client id:    ${fingerprint(clientId)}`);
  info(`api key:      ${fingerprint(apiKey)}`);
  info(`checksum key: ${fingerprint(checksumKey)}`);

  const { PayOS } = require("@payos/node");
  const payos = new PayOS({ clientId, apiKey, checksumKey });

  // A real link, cancelled straight away. Creating one is the only way to find
  // out whether all three keys are right: the checksum key is never checked
  // until something is signed with it.
  const orderCode = Number(`9${Date.now().toString().slice(-11)}`);
  try {
    const link = await payos.paymentRequests.create({
      orderCode,
      amount: 2000,
      // payOS caps this at 9 characters on an unlinked bank account.
      description: "A3CHECK",
      returnUrl: "http://localhost:8080/pay/return",
      cancelUrl: "http://localhost:8080/pay/return",
    });
    ok(`payOS issued a live payment link (order ${orderCode})`);
    info(`checkout: ${link.checkoutUrl}`);
    if (keep) {
      // payOS has no sandbox: the only way to watch money actually move is to
      // move some. 2,000d from your own banking app lands in your own payOS
      // bank account, so the round trip costs nothing but proves the whole
      // chain — bank, payOS, and the keys in this .env.
      warn("left OPEN on purpose — scan or open the link above and pay 2,000d to test for real");
      info("the money goes to the bank account linked to your payOS channel, i.e. back to you");
      info(`cancel it later in the dashboard if you change your mind (order ${orderCode})`);
    } else {
      try {
        await payos.paymentRequests.cancel(orderCode, "connection check");
        ok("and cancelled it again — nothing is left open");
      } catch {
        warn(`could not cancel order ${orderCode}; cancel it in the dashboard if it lingers`);
      }
      info("add --keep to leave a 2,000d link open and pay it for a real end-to-end test");
    }
  } catch (e) {
    bad(`payOS refused: ${e.message}`);
    if (/signature|checksum/i.test(e.message)) info("the checksum key looks wrong");
    else if (/401|unauthor/i.test(e.message)) info("the client id or api key looks wrong");
    failures += 1;
  }
}

/**
 * How far this system has got with payOS.
 *
 * The number that has to survive a move to a different database. It is read
 * over HTTP rather than out of the database directly so this works whether the
 * app is on PGLite or Postgres.
 */
async function reportSequence() {
  console.log("");
  console.log("payOS order sequence");
  try {
    const res = await fetch("http://127.0.0.1:8080/v1/payments/online/sequence");
    if (!res.ok) {
      info(`dev server not answering (HTTP ${res.status}) — start it and re-run to read this`);
      return;
    }
    const row = await res.json();
    if (!row?.last_order_code) {
      info("nothing issued yet");
      return;
    }
    ok(`highest order code issued: ${row.last_order_code}`);
    info(`last moved: ${row.updated_at}`);
    if (row.note) info(`note: ${row.note}`);
    console.log("");
    info("CARRY THIS TO THE PRODUCTION DATABASE before taking a payment there:");
    info(`  INSERT INTO provider_sequences (provider, last_order_code, note)`);
    info(`  VALUES ('payos', ${row.last_order_code}, 'carried over');`);
  } catch {
    info("dev server not running — start it and re-run to read this");
  }
}

if (!only || only === "mail") await checkMail();
if (!only || only === "payos") await checkPayos();
if (!only || only === "payos") await reportSequence();

console.log(
  failures === 0
    ? "\nEverything checked is connected.\n"
    : `\n${failures} thing(s) not connected — see above.\n`,
);
process.exit(failures === 0 ? 0 : 1);
