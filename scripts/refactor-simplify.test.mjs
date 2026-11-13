import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import * as time from "../src/shared/arena3/time.ts";
import { venueFrom } from "../src/client/lib/venue.ts";
import { summarizeCapacity } from "../src/server/services/capacity.ts";

function loadFunctions(path, dependencies, extraExports = "") {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source + extraExports, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  new Function("require", "exports", outputText)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

test("weekly sessions retain ICT boundaries, default hours and invalid-day filtering", () => {
  const { expandWeekly } = loadFunctions("../src/server/services/rrule.ts", {
    "../../shared/arena3/time": time,
  });
  const from = new Date("2026-11-09T18:00:00+07:00");
  const until = new Date("2026-11-16T18:00:00+07:00");
  const sessions = expandWeekly("BYDAY=MO,WE,MO,invalid", 90, from, until);
  assert.deepEqual(sessions, [
    { start: from, end: new Date("2026-11-09T19:30:00+07:00") },
    { start: new Date("2026-11-11T18:00:00+07:00"), end: new Date("2026-11-11T19:30:00+07:00") },
  ]);
  assert.deepEqual(expandWeekly("FREQ=DAILY;BYDAY=MO", 60, from, until), []);
});

test("closing hours retain partial-hour rounding and paired fallback", () => {
  assert.deepEqual(venueFrom({ open_time: "06:00", close_time: "21:30", hold_minutes: 7 }), {
    open: 6, close: 22, holdMinutes: 7,
  });
  assert.deepEqual(venueFrom({ open_time: "22:00", close_time: "06:00", hold_minutes: 0 }), {
    open: 6, close: 22, holdMinutes: 5,
  });
});

test("court codes fill the first gap and blockers keep booking precedence", async () => {
  const { generateCourtCode, describeCourtBlocker } = loadFunctions("../src/server/controllers/handlers/courts.ts", {
    "../errors": {}, "../helpers": {}, "../tx": {}, "../session": {},
  }, "\nexport { generateCourtCode, describeCourtBlocker };\n");
  const sql = { query: async (query, params) => {
    assert.equal(query, "select court_code from courts where court_code like $1");
    assert.deepEqual(params, ["CL-%"]);
    return ["CL-01", "CL-03", "invalid"].map(court_code => ({ court_code }));
  } };
  assert.equal(await generateCourtCode(sql, "CL"), "CL-02");
  assert.deepEqual(describeCourtBlocker({ kind: "booking", start_at: "start", end_at: "end", code: "B1", title: "C1" }), {
    kind: "booking", start_at: "start", end_at: "end", description: "Booking B1",
  });
});

test("SQL patches preserve parameter order, casts and explicit null values", () => {
  const { sqlPatch } = loadFunctions("../src/server/controllers/helpers.ts", {
    "../services/crypto": {}, "./errors": {}, "./tx": {},
    "../../shared/arena3/labels": {}, "../../shared/arena3/time": time,
  });
  const patch = sqlPatch(["row-id"]);
  patch.add("published", false);
  patch.add("title", null);
  patch.add("payload", '{"blocks":[]}', "::jsonb");
  assert.deepEqual(patch.sets, ["published = $2", "title = $3", "payload = $4::jsonb"]);
  assert.deepEqual(patch.params, ["row-id", false, null, '{"blocks":[]}']);
});

test("capacity summaries keep court order, missing hours and peak boundaries", () => {
  const cell = (court_id, sport, hr, sold_min, slots = 2) => ({
    court_id, court_code: court_id, sport, hr, slots, sold_min, days_booked: 1, days_total: slots,
  });
  const summary = summarizeCapacity([
    cell("B", "badminton", 17, 90), cell("A", "badminton", 17, 60),
    cell("B", "badminton", 18, 30), cell("C", "__proto__", 17, 60),
  ], [{ sport: "badminton", start_min: 17 * 60, end_min: 18 * 60 }], 17, 20, 2);
  assert.deepEqual(summary.courts.map(court => court.court_id), ["B", "A", "C"]);
  assert.deepEqual(summary.courts[0].cells, [75, 25, 0]);
  assert.deepEqual(summary.courts[0].days_booked, [1, 1, 0]);
  assert.deepEqual(summary.all, { sold: 240, open: 480 });
  assert.deepEqual(summary.bySport.get("badminton"), {
    sold: 180, open: 360, peakSold: 150, peakOpen: 240, offSold: 30, offOpen: 120,
  });
  assert.equal(summary.bySport.get("__proto__").peakOpen, 0);
  const empty = summarizeCapacity([], [], 22, 6, 1);
  assert.deepEqual(empty.hours, []);
  assert.deepEqual(empty.courts, []);
  assert.deepEqual(empty.all, { sold: 0, open: 0 });
});

test("promo previews dispatch each scope and reject member court fees before quoting", async () => {
  const calls = [];
  const field = (field, message) => Object.assign(new Error(message), { field });
  const dependencies = {
    "../../services/membership": { memberCourtFee: async () => null },
    "../errors": { err: { field, notFound: message => new Error(message), br: (code, message) => Object.assign(new Error(message), { code }) } },
    "../helpers": { str: value => typeof value === "string" ? value.trim() : undefined, readJson: request => request.json(), getSettings: async () => ({}) },
    "../../services/pricing": { lookupPrice: async () => ({ price_vnd: 100000 }) },
    "../../services/promos": { quotePromo: async (sql, input) => { calls.push(input); return { discount_vnd: 10000 }; } },
    "../session": {}, "../tx": { one: async () => ({ price_vnd: 200000, sport_scope: "all", sport: "badminton" }) },
    "../validate": {}, "./sports": {},
  };
  const { promosValidate } = loadFunctions("../src/server/controllers/handlers/promos.ts", dependencies);
  const request = body => new Request("https://arena.test/v1/promotions/validate", { method: "POST", body: JSON.stringify(body) });
  for (const scope of ["plan", "class", "court"]) {
    const result = await promosValidate({}, request({ scope, code: "PROMO", plan_id: "plan", class_id: "class", court_id: "court", start_at: "2026-11-09T17:00:00+07:00", user_id: "other" }), { id: "member", role: "member" });
    assert.equal(result.status, 200);
    assert.equal(result.body.valid, true);
    assert.equal(result.body.order_vnd, scope === "court" ? 100000 : 200000);
    assert.equal(calls.at(-1).scope, scope);
    assert.equal(calls.at(-1).userId, "member");
  }
  await assert.rejects(promosValidate({}, request({ scope: "invalid", code: "PROMO" }), { id: "member", role: "member" }), error => error.field === "scope");
  dependencies["../../services/membership"].memberCourtFee = async () => ({ fee_vnd: 20000 });
  const count = calls.length;
  await assert.rejects(promosValidate({}, request({ scope: "court", code: "PROMO", court_id: "court", start_at: "2026-11-09T17:00:00+07:00" }), { id: "member", role: "member" }), error => error.code === "BR-41");
  assert.equal(calls.length, count);
});
