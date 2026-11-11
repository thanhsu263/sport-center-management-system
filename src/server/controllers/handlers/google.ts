import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Sql } from "@/server/data/db";
import { err } from "../errors";
import { audit, readJson, str } from "../helpers";
import { PUBLIC_COLS, issueSession, toPublic, type PublicUser } from "../session";
import { one, q } from "../tx";

/**
 * "Continue with Google".
 *
 * The browser gets a Google ID token from Google Identity Services and posts it
 * here; we check its signature against Google's published keys, its audience
 * against our own client id, and that Google has verified the email.
 *
 * Google never creates an account and never signs anyone in on its own. A
 * signed-in person links their Google account from Account settings
 * (`googleLink`), which stores Google's subject id on their user row; after
 * that, and only then, `googleLogin` accepts a token whose subject matches.
 * An email that merely matches an account's email is not enough.
 *
 * Only the client id is needed (no secret): the ID token flow never trades a
 * code for tokens, so there is nothing for a secret to protect.
 */
export function googleClientId(): string | null {
  return process.env.GOOGLE_CLIENT_ID?.trim() || null;
}

// Fetched once and cached by jose, refreshed when Google rotates its keys.
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export function googleConfig() {
  return { status: 200, body: { client_id: googleClientId() } };
}

/** The verified email and name in a Google ID token, or a 401. */
async function verifyGoogle(credential: string | null | undefined): Promise<{ sub: string; email: string }> {
  const clientId = googleClientId();
  if (!clientId) throw err.notFound("Google sign-in is not set up.");
  if (!credential) throw err.validation("The Google sign-in did not return a token.");
  try {
    const { payload } = await jwtVerify(credential, googleKeys, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: clientId,
    });
    if (payload.email_verified !== true || typeof payload.email !== "string" || !payload.sub) {
      throw new Error("unverified email");
    }
    return { sub: payload.sub, email: payload.email.trim().toLowerCase() };
  } catch {
    throw err.unauth("Google could not confirm who you are. Please try again.");
  }
}

export async function googleLogin(sql: Sql, request: Request) {
  const body = await readJson(request);
  const google = await verifyGoogle(str(body.credential));
  const user = await one<Record<string, unknown>>(sql, `select ${PUBLIC_COLS} from users where google_sub = $1`, [
    google.sub,
  ]);
  if (!user) {
    throw err.unauth(
      "This Google account is not linked to an Arena3 account. Sign in with your password, then link Google in Account settings.",
    );
  }
  if (user.status !== "active") throw err.unauth("This account is not active.");
  await audit(sql, String(user.id), "login_google", "user", String(user.id));
  return { status: 200, body: await issueSession(sql, toPublic(user)) };
}

/** Which Google account, if any, the signed-in person has linked. */
export async function googleLinkGet(sql: Sql, user: PublicUser) {
  const row = await one<{ google_email: string | null }>(sql, "select google_email from users where id = $1", [user.id]);
  return { status: 200, body: { client_id: googleClientId(), google_email: row?.google_email ?? null } };
}

export async function googleLink(sql: Sql, request: Request, user: PublicUser) {
  const body = await readJson(request);
  const google = await verifyGoogle(str(body.credential));
  const taken = await one<{ id: string }>(sql, "select id from users where google_sub = $1 and id <> $2", [
    google.sub,
    user.id,
  ]);
  if (taken) throw err.conflict("That Google account is already linked to another Arena3 account.");
  await q(sql, "update users set google_sub = $1, google_email = $2 where id = $3", [google.sub, google.email, user.id]);
  await audit(sql, user.id, "google_link", "user", user.id);
  return { status: 200, body: { google_email: google.email } };
}

export async function googleUnlink(sql: Sql, user: PublicUser) {
  await q(sql, "update users set google_sub = null, google_email = null where id = $1", [user.id]);
  await audit(sql, user.id, "google_unlink", "user", user.id);
  return { status: 200, body: { google_email: null } };
}
