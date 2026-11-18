import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { saveChatMessage } from "./chat-log";

/** A bare window: localStorage in a Map, and a list of the events dispatched on it. */
function fakeWindow(storageWorks = true) {
  const store = new Map<string, string>();
  const events: string[] = [];
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => {
        if (!storageWorks) throw new Error("blocked");
        return store.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (!storageWorks) throw new Error("blocked");
        store.set(k, v);
      },
    },
    dispatchEvent: (e: Event) => {
      events.push(`${e.type}:${String((e as CustomEvent).detail)}`);
      return true;
    },
  };
  return { store, events };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("chat log", () => {
  it("saves a late reply with no chat view mounted, after what is already stored", () => {
    const { store, events } = fakeWindow();
    // The question was saved while the widget was still open…
    saveChatMessage("u1", { role: "me", text: "Mở cửa mấy giờ?" });
    // …and the reply arrives after the member opened /app/assistant and the widget unmounted.
    saveChatMessage("u1", { role: "bot", text: "06:00–22:00.", source: "gemini", sig: "s" });
    assert.deepEqual(JSON.parse(store.get("arena3:chat:u1")!), [
      { role: "me", text: "Mở cửa mấy giờ?" },
      { role: "bot", text: "06:00–22:00.", source: "gemini", sig: "s" },
    ]);
    // Each save tells the page's view to re-read the log.
    assert.deepEqual(events, ["arena3:chat-log:u1", "arena3:chat-log:u1"]);
  });

  it("keeps each member's log apart", () => {
    const { store } = fakeWindow();
    saveChatMessage("u1", { role: "me", text: "a" });
    saveChatMessage("u2", { role: "me", text: "b" });
    assert.equal(JSON.parse(store.get("arena3:chat:u1")!).length, 1);
    assert.equal(JSON.parse(store.get("arena3:chat:u2")!).length, 1);
  });

  it("sends no event when storage is blocked, so open views keep the thread they hold", () => {
    const { events } = fakeWindow(false);
    saveChatMessage("u1", { role: "me", text: "a" });
    assert.deepEqual(events, []);
  });
});
