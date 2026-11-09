import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Sql } from "@/server/data/db";
import { err } from "../errors";
import { audit, readJson, str } from "../helpers";
import { findUserByLogin, issueSession, toPublic } from "../session";
import { checkSignup, createMember } from "./auth";

/**
 * "Continue with Google".
 *
 * The browser gets a Google ID token from Google Identity Services and posts it
 * here; we check its signature against Google's published keys, its audience
 * against our own client id, and that Google has verified the email.
 *
 * An email that matches an account signs in. One that does not gets back
 * `{ signup }` with the name and email Google gave us: an Arena3 account also
 * needs a phone number, a birthday and the privacy consent, none of which Google
 * gives us, so the sign-up form asks for just those and posts them with the same
 * token to `/auth/google/register`. There is no OTP on that path, because Google
 * has already proved the email.
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
async function verifyGoogle(credential: string | null | undefined): Promise<{ email: string; full_name: string }> {
  const clientId = googleClientId();
  if (!clientId) throw err.notFound("Google sign-in is not set up.");
  if (!credential) throw err.validation("The Google sign-in did not return a token.");
  try {
    const { payload } = await jwtVerify(credential, googleKeys, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: clientId,
    });
    if (payload.email_verified !== true || typeof payload.email !== "string") {
      throw new Error("unverified email");
    }
    return {
      email: payload.email.trim().toLowerCase(),
      full_name: typeof payload.name === "string" ? payload.name.trim() : "",
    };
  } catch {
    throw err.unauth("Google could not confirm who you are. Please try again.");
  }
}

export async function googleLogin(sql: Sql, request: Request) {
  const body = await readJson(request);
  const google = await verifyGoogle(str(body.credential));
  const user = await findUserByLogin(sql, google.email);
  if (!user) return { status: 200, body: { signup: google } };
  if (user.status !== "active") throw err.unauth("This account is not active.");
  await audit(sql, user.id, "login_google", "user", user.id);
  return { status: 200, body: await issueSession(sql, toPublic(user)) };
}

export async function googleRegister(sql: Sql, request: Request) {
  const body = await readJson(request);
  const google = await verifyGoogle(str(body.credential));
  // The email is Google's, never the form's: that is what makes skipping the OTP safe.
  const fields = await checkSignup(sql, body, { email: google.email, password: false });
  return createMember(sql, fields, "register_google");
}
