/**
 * Restart the safe test server, then run one suite with its output logged.
 *
 *   node scripts/tests/agent/run-suite.mjs 06                    restart the server, run 06-*.mjs
 *   node scripts/tests/agent/run-suite.mjs 06 --no-restart       run on the server that is already up
 *   node scripts/tests/agent/run-suite.mjs scripts/tests/test-member-flows.mjs
 *   node scripts/tests/agent/run-suite.mjs some-script.mjs -- --flag value   (args after -- go to the script)
 *   node scripts/tests/agent/run-suite.mjs --server-only         only (re)start the server
 *   node scripts/tests/agent/run-suite.mjs --stop                stop the server
 *
 * Writes test-output/logs/<name>.log, test-output/results/<name>.jsonl and
 * test-output/logs/server.log. UNVALIDATED helper: if it misbehaves, use the
 * manual commands (Phase 0, "Cách thủ công").
 */
import { execSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PORT = 8090;
const BASE = `http://127.0.0.1:${PORT}`;
const LOGS = join(ROOT, "test-output", "logs");
const RESULTS = join(ROOT, "test-output", "results");
const PID_FILE = join(LOGS, "server.pid");
const AGENT_DIR = join(ROOT, "scripts", "tests", "agent");
const SUITE_TIMEOUT_MS = 30 * 60e3;

mkdirSync(LOGS, { recursive: true });
mkdirSync(RESULTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listenerPids() {
  try {
    if (process.platform === "win32") {
      const rows = execSync("netstat -ano", { encoding: "utf8", windowsHide: true })
        .split(/\r?\n/)
        .map((l) => l.trim().split(/\s+/))
        .filter((c) => c[0] === "TCP" && c.length >= 5 && c[1].endsWith(`:${PORT}`))
        .filter((c) => c[3] === "LISTENING" || /:0$/.test(c[2]));
      return [...new Set(rows.map((c) => Number(c[4])))].filter((p) => p > 0);
    }
    return execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN`, { encoding: "utf8" })
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

function kill(pid) {
  try {
    if (process.platform === "win32") execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore", windowsHide: true });
    else process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

async function stopServer() {
  if (existsSync(PID_FILE)) {
    kill(Number(readFileSync(PID_FILE, "utf8")));
    rmSync(PID_FILE, { force: true });
  }
  for (let i = 0; i < 20; i++) {
    const pids = listenerPids();
    if (!pids.length) return true;
    pids.forEach(kill);
    await sleep(500);
  }
  return listenerPids().length === 0;
}

async function waitReady(timeoutMs, hasExited = () => false) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (hasExited()) return false;
    try {
      const r = await fetch(`${BASE}/v1/classes`, { signal: AbortSignal.timeout(20000) });
      if (r.status === 200) return true;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  return false;
}

async function startServer() {
  if (!(await stopServer())) {
    console.error(`Port ${PORT} is still in use after trying to stop it. STOP and tell the user.`);
    process.exit(3);
  }
  const fd = openSync(join(LOGS, "server.log"), "w");
  const child = spawn(process.execPath, ["scripts/tests/start-safe-server.mjs"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  const started = Date.now();
  if (!(await waitReady(180e3, () => exited))) {
    console.error("The safe server did not come up (or it exited). Read test-output/logs/server.log.");
    process.exit(3);
  }
  console.log(`safe server ready on ${BASE} after ${Math.round((Date.now() - started) / 1000)} s (pid ${child.pid})`);
}

function findSuite(arg) {
  const asPath = resolve(ROOT, arg);
  if (existsSync(asPath)) return asPath;
  const hit = readdirSync(AGENT_DIR)
    .filter((f) => f.endsWith(".mjs") && f.startsWith(arg))
    .sort()[0];
  return hit ? join(AGENT_DIR, hit) : null;
}

function runSuite(file, passArgs) {
  const name = basename(file).replace(/\.mjs$/, "");
  const logPath = join(LOGS, `${name}.log`);
  const resultsPath = join(RESULTS, `${name}.jsonl`);
  rmSync(resultsPath, { force: true });
  const log = createWriteStream(logPath);
  return new Promise((done) => {
    const child = spawn(process.execPath, [file, ...passArgs], {
      cwd: ROOT,
      env: { ...process.env, BASE, RESULTS_FILE: resultsPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      const msg = `\n[run-suite] TIMEOUT after ${SUITE_TIMEOUT_MS / 60e3} min — killed\n`;
      process.stdout.write(msg);
      log.write(msg);
      kill(child.pid);
    }, SUITE_TIMEOUT_MS);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (b) => {
        process.stdout.write(b);
        log.write(b);
      });
    }
    child.on("close", (code) => {
      clearTimeout(timer);
      log.end();
      console.log(`\n[run-suite] exit code ${code}`);
      console.log(`[run-suite] log:     ${relative(ROOT, logPath)}`);
      console.log(`[run-suite] results: ${relative(ROOT, resultsPath)}`);
      done(code ?? 1);
    });
  });
}

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const own = sep < 0 ? argv : argv.slice(0, sep);
const passArgs = sep < 0 ? [] : argv.slice(sep + 1);
const flags = new Set(own.filter((a) => a.startsWith("--")));
const positional = own.filter((a) => !a.startsWith("--"));

if (flags.has("--stop")) {
  console.log((await stopServer()) ? "safe server stopped" : `port ${PORT} is still in use`);
  process.exit(0);
}
if (flags.has("--server-only")) {
  await startServer();
  process.exit(0);
}
const file = positional[0] ? findSuite(positional[0]) : null;
if (!file) {
  console.error("Usage: node scripts/tests/agent/run-suite.mjs <06 | path/to/script.mjs> [--no-restart] [-- args]");
  console.error("       node scripts/tests/agent/run-suite.mjs --server-only | --stop");
  process.exit(2);
}
if (flags.has("--no-restart")) {
  if (!(await waitReady(5000))) {
    console.error("No server answers on port 8090. Run again without --no-restart.");
    process.exit(3);
  }
} else {
  await startServer();
}
process.exit(await runSuite(file, passArgs));
