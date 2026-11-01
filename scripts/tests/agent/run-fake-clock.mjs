/**
 * run-fake-clock.mjs — Runs any command under a fixed fake clock:
 * 2026-10-15T02:00:00Z (09:00 ICT, Thursday).
 *
 * Computes offset ONCE and passes it down via FAKE_CLOCK_OFFSET_MS and NODE_OPTIONS.
 */
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FAKE_TARGET_ISO = "2026-10-15T02:00:00Z";
const targetMs = Date.parse(FAKE_TARGET_ISO);
const offsetMs = targetMs - Date.now();

const fakeClockPath = resolve(ROOT, "scripts", "tests", "fake-clock.mjs");
const fakeClockUrl = pathToFileURL(fakeClockPath).href;

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node run-fake-clock.mjs <command> [args...]");
  process.exit(1);
}

const [cmd, ...cmdArgs] = args;

const existingNodeOptions = process.env.NODE_OPTIONS || "";
const importFlag = `--import ${fakeClockUrl}`;
const nodeOptions = existingNodeOptions ? `${importFlag} ${existingNodeOptions}` : importFlag;

console.error(`[run-fake-clock] target=${FAKE_TARGET_ISO} offsetMs=${offsetMs}`);

const res = spawnSync(cmd, cmdArgs, {
  cwd: process.cwd(),
  stdio: "inherit",
  env: {
    ...process.env,
    FAKE_CLOCK_OFFSET_MS: String(offsetMs),
    NODE_OPTIONS: nodeOptions,
  },
});

process.exit(res.status ?? (res.error ? 1 : 0));
