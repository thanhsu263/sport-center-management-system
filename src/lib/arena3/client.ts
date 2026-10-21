import { linkDown, linkUp, loadFailed, loadOk } from "@/lib/connection";
import { tServer } from "@/lib/i18n";

const TOKEN_KEY = "arena3.token";
const USER_KEY = "arena3.user";
/** Set when a signed-in session ends by itself, so the sign-in page can say why. */
const EXPIRED_KEY = "arena3.expired";
/** Fired on `window` when the cached user changes, so the header can follow a profile edit. */
const USER_EVENT = "arena3:user";

export type Role = "manager" | "coach" | "receptionist" | "member";

export type SessionUser = {
  id: string;
  member_code: string | null;
  full_name: string;
  phone: string;
  email: string | null;
  role: Role;
  status: string;
  date_of_birth: string | null;
  health_notes: string | null;
  must_change_password: boolean;
  avatar_url?: string | null;
};

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): SessionUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: SessionUser) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/**
 * Refresh the cached user without touching the token.
 *
 * The shell reads the name and role out of local storage so it can paint the
 * header before `/me` comes back. After a profile edit that copy is stale —
 * the header would keep showing the old name until the next sign-in.
 */
export function setStoredUser(user: SessionUser) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  window.dispatchEvent(new Event(USER_EVENT));
}

/** Run `f` whenever `setStoredUser` has changed the cached user; returns the way to stop. */
export function onStoredUserChange(f: () => void): () => void {
  window.addEventListener(USER_EVENT, f);
  return () => window.removeEventListener(USER_EVENT, f);
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function homeFor(role: Role): string {
  if (role === "manager") return "/manager";
  if (role === "receptionist") return "/desk";
  if (role === "coach") return "/coach";
  return "/app";
}

let ending = false;

/**
 * The server says this session is over (it timed out, or the account was switched off) while
 * someone is part-way through something. Left to each screen that arrived as a toast reading
 * "Invalid or expired session" on a page where nothing works any more. Send them to sign in
 * instead, with a line saying why. Several requests can fail at once; the first one does this.
 */
function sessionEnded() {
  if (ending || typeof window === "undefined") return;
  ending = true;
  clearSession();
  try {
    sessionStorage.setItem(EXPIRED_KEY, "1");
  } catch {
    // Storage blocked: the redirect still happens, only the explanation is lost.
  }
  window.location.assign("/login");
}

/** Read-and-clear, so the note shows once and not again on a later visit to the sign-in page. */
export function takeSessionNotice(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const was = sessionStorage.getItem(EXPIRED_KEY) === "1";
    sessionStorage.removeItem(EXPIRED_KEY);
    return was;
  } catch {
    return false;
  }
}

export type ApiErrorBody = {
  code: string;
  message: string;
  br?: string;
  /** Set on a 400: the form input the message is about. */
  field?: string;
  /** Set when a bulk save names the row that was refused. */
  index?: number;
  requires_confirm?: boolean;
};

/**
 * The server answers in English. The message is translated here, once, so every screen that
 * shows `e.message` or `e.body.message` reads in the language the UI is in at the moment the
 * error arrives (`tServer` returns English unchanged, and anything it does not know).
 */
export class ApiClientError extends Error {
  status: number;
  body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody | null) {
    const raw = typeof body?.message === "string" ? body.message : "Request failed";
    const message = tServer(raw);
    super(message);
    this.status = status;
    this.body = { code: "ERROR", ...(body ?? {}), message };
  }
}

function newIdem(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random()}`;
}

const SERVER_TROUBLE = "Something went wrong on our side.";

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isErrorBody(v: unknown): v is ApiErrorBody {
  return typeof v === "object" && v !== null && typeof (v as { message?: unknown }).message === "string";
}

/** No answer at all. The browser knows when it has no network; otherwise the server is not answering. */
function unreachable(): ApiClientError {
  linkDown(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "server");
  return new ApiClientError(0, {
    code: "NETWORK",
    message: "Could not reach the server. Check your connection and try again.",
  });
}

/**
 * `fetch` that tells `connection.ts` how the trip went, and turns the two answers that never came
 * from this app into errors a person can read: no answer at all, and the host's own 502 / 503 / 504
 * page. They used to surface as `TypeError: Failed to fetch` and `Unexpected token '<'`.
 */
async function send(path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`/v1${path}`, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw unreachable();
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    linkDown("server");
    throw new ApiClientError(res.status, {
      code: "UNAVAILABLE",
      message: "The server is busy or restarting. Try again in a moment.",
    });
  }
  linkUp();
  return res;
}

async function bodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    // The connection dropped part-way through the answer.
    throw unreachable();
  }
}

/**
 * An error response as an `ApiClientError`; ends the session first when that is what it says.
 *
 * Only when the token that was refused is still the one in storage: a request that was in flight
 * when someone signed out, or signed in as someone else, comes back 401 and means nothing now.
 */
function failure(res: Response, text: string, path: string, sent: string | null): ApiClientError {
  if (res.status === 401 && sent && sent === getToken() && path !== "/auth/login" && path !== "/auth/logout") {
    sessionEnded();
  }
  const body = parseBody(text);
  return new ApiClientError(res.status, isErrorBody(body) ? body : { code: "ERROR", message: SERVER_TROUBLE });
}

export async function api<T>(
  path: string,
  init: RequestInit & { idempotent?: boolean } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body && !(init.body instanceof FormData)) {
    headers.set("content-type", "application/json");
  }
  const token = getToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.idempotent) headers.set("idempotency-key", newIdem());
  const res = await send(path, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/pdf")) {
    return (await res.blob()) as T;
  }
  const text = await bodyText(res);
  if (!res.ok) throw failure(res, text, path, token);
  const data = parseBody(text);
  // A 200 that is not our JSON is a host or proxy page standing in for the app.
  if (data === undefined) throw new ApiClientError(res.status, { code: "BAD_RESPONSE", message: SERVER_TROUBLE });
  return data as T;
}

/** The app itself failed to answer a read: a 500, or a reply that was not its JSON. */
function brokeTheScreen(e: unknown): boolean {
  return e instanceof ApiClientError && (e.status >= 500 || e.body.code === "BAD_RESPONSE");
}

/**
 * GETs that are already in flight, keyed by path.
 *
 * Several components legitimately ask for the same thing at the same moment —
 * `Guard` and the page it wraps both want `/me`, and React's StrictMode mounts
 * each of them twice in dev. `/me` is the most expensive read in the app, so
 * firing it two or four times over is the single largest thing standing
 * between a sign-in and a rendered page; measured on the deployed app, the
 * duplicate alone added ~840ms to every load.
 *
 * Callers still each get their own promise result; only the network trip is
 * shared. The entry is dropped as soon as the request settles, so this is a
 * de-duplicator for concurrent calls, not a cache — a later `load()` after a
 * mutation always hits the server.
 */
const inflight = new Map<string, Promise<unknown>>();

/**
 * `background` is for reads nobody is waiting on — the unread count, a session check. A screen's own
 * read that fails with a server error leaves the screen on grey blocks with nothing to say but a
 * toast that fades, so the connection banner is told and offers to open the screen again; a
 * background read failing is not news on screen. Each caller reports for itself, so a screen that
 * shares a request a background caller started still gets its banner.
 *
 * `fresh` is for a read that follows a change the person just made: joining a request that was
 * already in flight would hand back an answer asked for *before* that change, and the screen would
 * redraw a row that has just been paid for.
 */
export const apiGet = <T>(path: string, opts: { background?: boolean; fresh?: boolean } = {}): Promise<T> => {
  let p = opts.fresh ? undefined : (inflight.get(path) as Promise<T> | undefined);
  if (!p) {
    const own: Promise<T> = api<T>(path).finally(() => {
      if (inflight.get(path) === own) inflight.delete(path);
    });
    p = own;
    inflight.set(path, own);
  }
  if (!opts.background) {
    p.then(
      () => loadOk(path),
      (e: unknown) => {
        if (brokeTheScreen(e)) loadFailed(path);
      },
    );
  }
  return p;
};
export const apiPost = <T>(path: string, body?: unknown, idempotent = false) =>
  api<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined, idempotent });
export const apiPatch = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined });
export const apiPut = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined });
export const apiDelete = <T>(path: string) => api<T>(path, { method: "DELETE" });
/**
 * A binary GET that also surfaces the filename the server chose.
 *
 * `api()` throws the headers away, and the invoice code only exists in
 * `content-disposition` — without it a saved receipt lands in Downloads named
 * after a UUID.
 */
async function apiBlob(path: string): Promise<{ blob: Blob; filename: string | null }> {
  const headers = new Headers();
  const token = getToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await send(path, { headers });
  if (!res.ok) throw failure(res, await bodyText(res), path, token);
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1];
  return { blob: await res.blob(), filename: name ?? null };
}

/**
 * Save a server-built report (xlsx / pdf) to Downloads.
 *
 * A plain link cannot carry the bearer token, so the file is fetched with it and
 * handed to the browser as a blob.
 */
export async function downloadReport(path: string, fallbackName: string): Promise<string> {
  const { blob, filename } = await apiBlob(path);
  const name = filename ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return name;
}

/**
 * Show a receipt, and actually show it.
 *
 * `window.open` after an `await` is no longer inside the click that caused it,
 * so every browser treats it as an unsolicited popup and blocks it. It does
 * not throw when that happens — it returns `null` — so the callers' `try/catch`
 * never fired and pressing "Receipt" did nothing at all, with no error, on any
 * of the eleven places that call this. The PDF had been fetched correctly the
 * whole time.
 *
 * A programmatic download is not subject to the popup blocker, so it is the
 * fallback: worst case the receipt lands in Downloads instead of a new tab,
 * which is a far better outcome than silence at the till.
 */
export async function openInvoice(id: string): Promise<"opened" | "downloaded"> {
  const { blob, filename } = await apiBlob(`/invoices/${id}.pdf`);
  const url = URL.createObjectURL(blob);
  try {
    const win = window.open(url, "_blank");
    if (win && !win.closed) return "opened";
    const a = document.createElement("a");
    a.href = url;
    a.download = filename ?? `receipt-${id}.pdf`;
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
    return "downloaded";
  } finally {
    // The blob is held alive by the object URL until it is revoked, and a till
    // that prints all day would otherwise accumulate every receipt it issued.
    // Long enough for the new tab or the download to have read it.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
