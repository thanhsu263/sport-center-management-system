import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { P2PRoom } from "./p2p";

/**
 * The signaling calls, with `fetch` swapped out.
 *
 * `p2p.ts` only touches WebRTC APIs once a roster comes back with somebody in
 * it, so an empty roster lets the join, poll, signal and leave paths run under
 * plain node. Runs under `tsx` (see the `test` script) because this module is
 * imported without a file extension.
 */

type Call = { url: string; method: string; headers: Record<string, string> };

function lower(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries((headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
  );
}

function harness(responder: (method: string) => { ok: boolean; status: number; body?: unknown }) {
  const calls: Call[] = [];
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  // The room logs a refusal on purpose; keep it out of the test output.
  console.warn = () => {};
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url: String(input), method, headers: lower(init?.headers) });
    const r = responder(method);
    return { ok: r.ok, status: r.status, json: async () => r.body ?? {} } as unknown as Response;
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
    },
  };
}

const emptyRoster = { ok: true, status: 200, body: { peers: [], signals: [] } };

describe("p2p signaling auth", () => {
  it("sends the session token on every signaling call", async () => {
    const h = harness(() => emptyRoster);
    const room = new P2PRoom({ room: "r1", selfId: "u1", getAuthToken: () => "tok-123" });
    try {
      await room.join();
      room.close();
      // The poll, and the leave that teardown fires.
      assert.ok(h.calls.length >= 2, `expected a poll and a leave, got ${h.calls.length}`);
      for (const c of h.calls) {
        assert.equal(c.headers.authorization, "Bearer tok-123", `${c.method} ${c.url} carried no token`);
      }
      // Never in the query string: that ends up in logs and history.
      const poll = h.calls.find((c) => c.method === "GET");
      assert.ok(poll && !poll.url.includes("tok-123"));
    } finally {
      h.restore();
    }
  });

  it("omits the header when the app supplies no token", async () => {
    const h = harness(() => emptyRoster);
    const room = new P2PRoom({ room: "r1", selfId: "u1" });
    try {
      await room.join();
      room.close();
      for (const c of h.calls) assert.equal(c.headers.authorization, undefined);
    } finally {
      h.restore();
    }
  });

  it("reads the token fresh on each call, so a refresh is picked up", async () => {
    const h = harness(() => emptyRoster);
    let token = "first";
    const room = new P2PRoom({ room: "r1", selfId: "u1", getAuthToken: () => token });
    try {
      await room.join();
      token = "second";
      room.close();
      const leave = h.calls.at(-1);
      assert.equal(leave?.headers.authorization, "Bearer second");
    } finally {
      h.restore();
    }
  });

  it("stops the room when the relay refuses the session", async () => {
    let polls = 0;
    const h = harness((method) => {
      if (method === "GET") polls += 1;
      return { ok: false, status: 401, body: {} };
    });
    let refused: number | null = null;
    const room = new P2PRoom({
      room: "r1",
      selfId: "u1",
      onAuthError: (s) => {
        refused = s;
      },
    });
    try {
      await room.join();
      assert.equal(refused, 401);
      // One attempt, not a retry loop. This is the whole bug: the poll loop
      // swallowed the 401 and asked again on every tick, so a signaling route
      // that answered 401 to everything looked like P2P simply being
      // unavailable. Waited past IDLE_POLL_MS (2s), or a room that *is* still
      // polling would look identical to one that stopped.
      await new Promise((r) => setTimeout(r, 2300));
      assert.equal(polls, 1);
    } finally {
      room.close();
      h.restore();
    }
  });

  it("keeps retrying a transient failure", async () => {
    let polls = 0;
    const h = harness((method) => {
      if (method !== "GET") return emptyRoster;
      polls += 1;
      return { ok: false, status: 503, body: {} };
    });
    let refused = false;
    const room = new P2PRoom({ room: "r1", selfId: "u1", onAuthError: () => (refused = true) });
    try {
      await room.join();
      // Past IDLE_POLL_MS: with no peers yet the loop ticks every 2s, not 400ms.
      await new Promise((r) => setTimeout(r, 2300));
      // A relay that is briefly down is not a refusal: the room must not give up.
      assert.equal(refused, false);
      assert.ok(polls > 1, `expected a retry, saw ${polls} poll(s)`);
    } finally {
      room.close();
      h.restore();
    }
  });
});
