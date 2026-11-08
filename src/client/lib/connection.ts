import { useSyncExternalStore } from "react";

/**
 * Whether this page can reach its server right now, and one place that knows why not.
 *
 * Without it a dropped signal looked like three different bugs: a page stuck on grey blocks (the
 * request threw, the page showed a toast that faded, and nothing else), a till operator signed out
 * because a single `/me` call failed, and "Unexpected token <" read out to someone whose host had
 * answered with an HTML error page. `client.ts` reports every request here; `ConnectionBanner`
 * says it once, in words, with a way to try again.
 *
 *   ok       nothing to say
 *   offline  no answer at all: no signal, a dropped Wi-Fi, a server that is down
 *   server   an answer, but from the hosting platform (502 / 503 / 504), not from the app
 *   broken   the app itself answered with an error (a plain 500) to a request that fills a screen,
 *            so the screen is still on grey blocks and nothing will ask again on its own
 *   back     it was down and a request has just gone through again
 */
export type LinkState = "ok" | "offline" | "server" | "broken" | "back";

type Snapshot = { link: LinkState; retryKey: number };

let snap: Snapshot = { link: "ok", retryKey: 0 };
let backTimer: ReturnType<typeof setTimeout> | undefined;
const subscribers = new Set<() => void>();
/** Screen-filling requests that last came back as an error, by path. */
const failedLoads = new Set<string>();

const set = (next: Partial<Snapshot>) => {
  snap = { ...snap, ...next };
  subscribers.forEach((f) => f());
};

const subscribe = (f: () => void) => {
  subscribers.add(f);
  return () => void subscribers.delete(f);
};

/** A request got no usable answer. */
export function linkDown(kind: "offline" | "server") {
  clearTimeout(backTimer);
  // No answer at all is the bigger news; a page that errored a moment ago is part of it.
  failedLoads.clear();
  if (snap.link !== kind) set({ link: kind });
}

/**
 * A request that fills a screen got an error from the app itself (a 500, or a reply that was not
 * its JSON). The server is there, so this is not "offline" — but the screen stays on grey blocks
 * and a toast that fades is all it said. Cleared by that same request going through, or by
 * "Reload page".
 */
export function loadFailed(path: string) {
  // Nothing to add when there is already no answer at all: that banner says more.
  if (snap.link === "offline" || snap.link === "server") return;
  failedLoads.add(path);
  if (snap.link === "broken") return;
  clearTimeout(backTimer);
  set({ link: "broken" });
}

/** That same request went through. Once nothing is left failing, the banner has nothing to say. */
export function loadOk(path: string) {
  if (!failedLoads.delete(path)) return;
  if (snap.link === "broken" && failedLoads.size === 0) set({ link: "ok" });
}

/**
 * A different screen is on show, so a read that failed on the last one is no longer the news.
 * Called when the page changes, before the new page's own requests have had time to answer.
 */
export function newScreen() {
  failedLoads.clear();
  if (snap.link === "broken") set({ link: "ok" });
}

/** A request got a real answer (any status the app itself produced counts: the server is there). */
export function linkUp() {
  // A request going through elsewhere says nothing about the screen that did not load.
  if (snap.link === "ok" || snap.link === "back" || snap.link === "broken") return;
  set({ link: "back" });
  // The banner only needs to say "you are connected again" for a moment; the button on it stays
  // useful for a page that never finished loading, so it lingers longer than a toast would.
  clearTimeout(backTimer);
  backTimer = setTimeout(() => {
    if (snap.link === "back") set({ link: "ok" });
  }, 12_000);
}

/** Dismiss the "connected again" note without reloading anything. */
export function dismissBack() {
  clearTimeout(backTimer);
  if (snap.link === "back") set({ link: "ok" });
}

/**
 * Ask the server whether it is there, with a short leash.
 *
 * Plain `fetch`, not `api()`: this is the thing `api()` reports to, and a failed probe must not
 * trigger the reporting again.
 */
async function reachable(): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8_000);
  try {
    const res = await fetch("/v1/health", { cache: "no-store", signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * "Try again": probe the server and, if it answers, load the screen afresh.
 *
 * The reload is the point. A page whose first request failed is still holding its empty state, and
 * nothing will ask again on its own; bumping `retryKey` remounts the routed page (see
 * `RetryOutlet`), which is exactly "open this screen again". Returns whether the server answered.
 */
export async function retryNow(): Promise<boolean> {
  const ok = await reachable();
  if (!ok) {
    linkDown(snap.link === "server" || snap.link === "broken" ? "server" : "offline");
    return false;
  }
  clearTimeout(backTimer);
  failedLoads.clear();
  set({ link: "ok", retryKey: snap.retryKey + 1 });
  return true;
}

if (typeof window !== "undefined") {
  // The browser knows before any request fails: say so, and say so again when the signal returns.
  window.addEventListener("offline", () => linkDown("offline"));
  window.addEventListener("online", () => {
    if (snap.link === "offline") linkUp();
  });
}

export const useLink = (): LinkState => useSyncExternalStore(subscribe, () => snap.link, () => "ok" as LinkState);
export const useRetryKey = (): number => useSyncExternalStore(subscribe, () => snap.retryKey, () => 0);
