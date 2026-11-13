import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clearAll, RULES, take } from "./ratelimit";

/**
 * Runs under `tsx`, not `node --experimental-strip-types`, because
 * `ratelimit.ts` imports `./errors` without a file extension and plain ESM
 * cannot resolve that. `arena3.test.ts` is the extension-free suite; this
 * module needs a resolver, so it lives beside `tx.test.ts` in the npm script.
 *
 * Every test calls `clearAll()` first: the limiter's buckets are module state,
 * so a leftover hit from a neighbour would decide the outcome here.
 */

describe("support request rate limit", () => {
  it("lets three through a minute and holds the fourth", () => {
    clearAll();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      assert.equal(take("ticket:u1", RULES.ticketCreate, t0 + i * 100), 0);
    }
    assert.ok(take("ticket:u1", RULES.ticketCreate, t0 + 300) > 0);
  });

  it("still caps the hour once the per-minute window keeps reopening", () => {
    clearAll();
    let now = 2_000_000;
    // Spread out so the 3-a-minute rule never bites; the hourly guard is what
    // stops a member burying the desk queue one request at a time.
    for (let i = 0; i < 10; i += 1) {
      now += 61_000;
      assert.equal(take("ticket:u1", RULES.ticketCreate, now), 0);
      assert.equal(take("ticket:u1:hour", RULES.ticketCreateHourly, now), 0);
    }
    now += 61_000;
    assert.equal(take("ticket:u1", RULES.ticketCreate, now), 0);
    assert.ok(take("ticket:u1:hour", RULES.ticketCreateHourly, now) > 0);
  });

  it("bites long before the assistant ceiling does", () => {
    clearAll();
    const t0 = 3_000_000;
    // A `ticket:` turn through the assistant pays twice: the endpoint ceiling
    // (FR-A03) and the desk's own budget. The desk's is the one that stops a
    // flood — three a minute, not twenty. That gap was the whole of bug #2:
    // `RULES.assistant` was the only guard, so twenty a minute reached the
    // queue, or about 1,200 an hour.
    for (let i = 0; i < 3; i += 1) {
      assert.equal(take("ai:u1", RULES.assistant, t0 + i), 0);
      assert.equal(take("ticket:u1", RULES.ticketCreate, t0 + i), 0);
    }
    // The endpoint would still take a fourth turn; the desk will not.
    assert.equal(take("ai:u1", RULES.assistant, t0 + 3), 0);
    assert.ok(take("ticket:u1", RULES.ticketCreate, t0 + 3) > 0);
  });

  it("gives each member their own allowance", () => {
    clearAll();
    const t0 = 4_000_000;
    for (let i = 0; i < 3; i += 1) take("ticket:u1", RULES.ticketCreate, t0 + i);
    assert.ok(take("ticket:u1", RULES.ticketCreate, t0 + 3) > 0);
    assert.equal(take("ticket:u2", RULES.ticketCreate, t0 + 4), 0);
  });

  it("reports how long the caller has to wait, in whole seconds", () => {
    clearAll();
    const t0 = 5_000_000;
    for (let i = 0; i < 3; i += 1) take("ticket:u1", RULES.ticketCreate, t0);
    // Asked again straight away: the oldest hit has the full window left.
    assert.equal(take("ticket:u1", RULES.ticketCreate, t0), 60);
    // Half a window later, half of it remains.
    assert.equal(take("ticket:u1", RULES.ticketCreate, t0 + 30_000), 30);
  });
});

describe("webrtc signaling rate limit", () => {
  it("leaves room for a real negotiation at the client's own poll rate", () => {
    clearAll();
    const t0 = 7_000_000;
    // `p2p.ts` polls every 400ms while a pair is connecting — 150 a minute —
    // and posts offers, answers and ICE candidates alongside. A full minute of
    // that must not trip the limit, or the fix from Phase 4 is undone by this.
    let now = t0;
    for (let i = 0; i < 150; i += 1) {
      now += 400;
      assert.equal(take("rtc:u1", RULES.rtcSignal, now), 0);
    }
    // Still headroom left for the signal posts that go with those polls.
    assert.equal(take("rtc:u1", RULES.rtcSignal, now), 0);
  });

  it("gives each room its own budget", () => {
    clearAll();
    const t0 = 9_000_000;
    // The limit is sized from one room's poll rate, so keying on the user alone
    // meant a second tab tripped it and lost P2P in both.
    for (let i = 0; i < RULES.rtcSignal.limit; i += 1) {
      assert.equal(take("rtc:u1:roomA", RULES.rtcSignal, t0 + i), 0);
    }
    assert.ok(take("rtc:u1:roomA", RULES.rtcSignal, t0 + RULES.rtcSignal.limit) > 0);
    assert.equal(take("rtc:u1:roomB", RULES.rtcSignal, t0 + RULES.rtcSignal.limit) ,0);
    clearAll();
  });

  it("still stops a tight loop", () => {
    clearAll();
    const t0 = 8_000_000;
    for (let i = 0; i < RULES.rtcSignal.limit; i += 1) {
      assert.equal(take("rtc:u1", RULES.rtcSignal, t0 + i), 0);
    }
    assert.ok(take("rtc:u1", RULES.rtcSignal, t0 + RULES.rtcSignal.limit) > 0);
    clearAll();
  });
});

describe("chat message rate limit", () => {
  it("moved out of the handler without changing what it allows", () => {
    clearAll();
    const t0 = 6_000_000;
    // The handler used to carry `{ windowMs: 10_000, limit: 25 }` inline.
    assert.equal(RULES.chatMessage.limit, 25);
    assert.equal(RULES.chatMessage.windowMs, 10_000);
    for (let i = 0; i < 25; i += 1) {
      assert.equal(take("chat:u1", RULES.chatMessage, t0 + i), 0);
    }
    assert.ok(take("chat:u1", RULES.chatMessage, t0 + 25) > 0);
    clearAll();
  });
});
