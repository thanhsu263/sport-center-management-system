import { getSql } from "@/lib/db";
import { ApiError, err, handleError, json } from "./errors";
import { withIdempotency } from "./helpers";
import { startJobLoop } from "./jobs";
import { authFromRequest, staffRoles, type PublicUser } from "./session";
import { withTx } from "./tx";
import * as deskH from "./handlers/desk";
import * as sportsH from "./handlers/sports";
import * as assetsH from "./handlers/assets";

type Result = { status: number; body: unknown };

function pathOf(request: Request): { method: string; parts: string[]; url: URL } {
  const url = new URL(request.url);
  const raw = url.pathname.replace(/^\/(?:v1|api)\/?/, "").replace(/\/+$/, "");
  const parts = raw ? raw.split("/") : [];
  return { method: request.method.toUpperCase(), parts, url };
}

async function dispatch(request: Request): Promise<Response | Result> {
  startJobLoop();
  const { method, parts, url } = pathOf(request);
  const p0 = parts[0] ?? "";
  const p1 = parts[1] ?? "";
  const p2 = parts[2] ?? "";

  const idem = (userId: string | null, fn: () => Promise<Result>) =>
    withTx(async (sql) => {
      const r = await withIdempotency(sql, request, userId, true, fn);
      return r;
    });

  // "Is the server there?" — what the connection banner's retry button asks. No session and no
  // database on purpose: it answers whenever the app itself is running, which is the whole question.
  if (method === "GET" && p0 === "health" && !p1) {
    return { status: 200, body: { ok: true } };
  }

  if (method === "GET" && p0 === "site-assets" && !p1) {
    const sql = await getSql();
    return assetsH.siteAssetsList(sql);
  }
  if (method === "GET" && p0 === "site-assets" && p1 && p2 === "file") {
    const sql = await getSql();
    return assetsH.siteAssetGetFile(sql, p1);
  }
  if (method === "GET" && p0 === "media" && p1 === "credits") {
    const sql = await getSql();
    return assetsH.publicMediaCredits(sql, request);
  }
  if (method === "GET" && p0 === "sports" && !p1) {
    const sql = await getSql();
    return sportsH.publicSportsList(sql);
  }

  // Authenticated
  const authed = async (fn: (sql: Awaited<ReturnType<typeof getSql>>, user: PublicUser) => Promise<Result | Response>) => {
    return withTx(async (sql) => {
      const user = await authFromRequest(sql, request);
      return fn(sql, user);
    });
  };

  // Same authentication, no transaction. Every handler reached through this is
  // a pure `select` — verified one by one — so a BEGIN/COMMIT buys nothing and
  // costs real time: it takes a connection out of the pool and spends two extra
  // round trips on it. That is cheap when the app and the database share a
  // region and brutal when they don't — against a database a continent away it
  // was half a second per read.
  const authedRead = async (fn: (sql: Awaited<ReturnType<typeof getSql>>, user: PublicUser) => Promise<Result | Response>) => {
    const sql = await getSql();
    const user = await authFromRequest(sql, request);
    return fn(sql, user);
  };

  if (method === "POST" && p0 === "shifts" && p1 === "open") {
    return authed((sql, user) => deskH.shiftOpen(sql, user));
  }
  if (method === "GET" && p0 === "shifts" && p1 === "current") {
    return authedRead((sql, user) => deskH.shiftCurrent(sql, user, request));
  }
  if (method === "POST" && p0 === "shifts" && p1 && p2 === "close") {
    return authed((sql, user) => deskH.shiftClose(sql, p1, request, user));
  }

  // Manager sports
  if (method === "GET" && p0 === "manager" && p1 === "sports" && !p2) {
    return authedRead((sql, user) => sportsH.managerSportsList(sql, user));
  }
  if (method === "POST" && p0 === "manager" && p1 === "sports" && !p2) {
    return authed((sql, user) => sportsH.managerSportCreate(sql, request, user));
  }
  if (method === "PATCH" && p0 === "manager" && p1 === "sports" && p2 && !parts[3]) {
    return authed((sql, user) => sportsH.managerSportPatch(sql, p2, request, user));
  }
  if (method === "POST" && p0 === "manager" && p1 === "sports" && p2 && parts[3] === "retire") {
    return authed((sql, user) => sportsH.managerSportRetire(sql, p2, user));
  }
  if (method === "POST" && p0 === "manager" && p1 === "sports" && p2 && parts[3] === "restore") {
    return authed((sql, user) => sportsH.managerSportRestore(sql, p2, user));
  }
  if (method === "DELETE" && p0 === "manager" && p1 === "sports" && p2 && !parts[3]) {
    return authed((sql, user) => sportsH.managerSportDelete(sql, p2, user));
  }

  // Manager site assets & media library
  if (
    (method === "GET" && p0 === "manager" && p1 === "site-assets" && p2 === "library") ||
    (method === "GET" && p0 === "manager" && p1 === "media-library" && !p2)
  ) {
    return authedRead((sql, user) => assetsH.managerMediaLibrary(sql, request, user));
  }
  if (method === "GET" && p0 === "manager" && p1 === "site-assets" && !p2) {
    return authedRead((sql, user) => assetsH.managerAssetsList(sql, user));
  }
  if (method === "POST" && p0 === "manager" && p1 === "site-assets" && p2 === "upload") {
    return authed((sql, user) => assetsH.managerAssetUpload(sql, request, user));
  }
  if ((method === "PUT" || method === "POST") && p0 === "manager" && p1 === "site-assets" && p2 && !parts[3]) {
    return authed((sql, user) => assetsH.managerAssetUpload(sql, request, user, p2));
  }
  if (method === "PATCH" && p0 === "manager" && p1 === "site-assets" && p2 && !parts[3]) {
    return authed((sql, user) => assetsH.managerAssetPatch(sql, request, user, p2));
  }
  if (method === "POST" && p0 === "manager" && p1 === "site-assets" && p2 && parts[3] === "revert") {
    return authed((sql, user) => assetsH.managerAssetRevert(sql, request, user, p2));
  }
  if (method === "POST" && p0 === "manager" && p1 === "site-assets" && p2 && parts[3] === "reset") {
    return authed((sql, user) =>
      assetsH.managerAssetRevert(
        sql,
        new Request(request.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to: "default" }),
        }),
        user,
        p2,
      ),
    );
  }

  void staffRoles;
  void idem;
  throw err.notFound(`No route for ${method} /v1/${parts.join("/")}`);
}

export async function handleApi(request: Request): Promise<Response> {
  try {
    const result = await dispatch(request);
    if (result instanceof Response) return result;
    if (result.status === 204) return new Response(null, { status: 204 });
    return json(result.status, result.body);
  } catch (e) {
    if (e instanceof ApiError) return json(e.status, e.body());
    return handleError(e);
  }
}
