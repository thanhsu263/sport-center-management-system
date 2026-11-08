/**
 * Check-in tokens (SRS v1.4.1 FR-TRN-02, FR-CRT-07, BR-30).
 *
 * A token is `base64url(payload).base64url(hmac)`: signed with a server secret,
 * short-lived, and never stored in a readable form. Three kinds:
 *
 *  - `member`  — a member's own door code. 60 seconds, single use (the jti is
 *                recorded when scanned, so a photographed code is worthless).
 *  - `booking` — the same for one court booking.
 *  - `desk`    — the code displayed at the front desk for optional self
 *                check-in. 30 seconds, reusable inside that window (many members
 *                scan the same screen), and only honoured when the centre has
 *                switched self check-in on.
 *
 * There is deliberately no location in a token: GPS is not used (see SRS §3.5).
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { err } from "./errors.ts";

export type CheckinKind = "member" | "booking" | "desk";

export const CHECKIN_TTL_SECONDS: Record<CheckinKind, number> = {
  member: 60,
  booking: 60,
  desk: 30,
};

type Payload = { k: CheckinKind; s: string; j: string; e: number };

export type VerifiedToken = { kind: CheckinKind; sub: string; jti: string; expiresAt: number };

/**
 * A dev constant keeps local runs working. In production it would be a key
 * anyone can read in the repository, so there the QR codes refuse to work until
 * CHECKIN_SECRET (or OTP_SECRET) is set.
 */
function secret(): string {
  const set = process.env.CHECKIN_SECRET?.trim() || process.env.OTP_SECRET?.trim();
  if (set) return set;
  if (process.env.NODE_ENV === "production") throw new Error("CHECKIN_SECRET is not set");
  return "arena3-dev-checkin-secret";
}

export function checkinSecretConfigured(): boolean {
  return Boolean(process.env.CHECKIN_SECRET?.trim() || process.env.OTP_SECRET?.trim());
}

function mac(body: string): Buffer {
  return createHmac("sha256", secret()).update(body).digest();
}

export function signCheckinToken(kind: CheckinKind, sub: string, now = Date.now()) {
  const exp = Math.floor(now / 1000) + CHECKIN_TTL_SECONDS[kind];
  const payload: Payload = { k: kind, s: sub, j: randomUUID(), e: exp };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const token = `${body}.${mac(body).toString("base64url")}`;
  return { token, expires_at: new Date(exp * 1000).toISOString(), ttl_seconds: CHECKIN_TTL_SECONDS[kind] };
}

export function verifyCheckinToken(raw: unknown, now = Date.now()): VerifiedToken {
  const bad = (m: string) => err.br("BR-30", m, { field: "token" });
  if (typeof raw !== "string") throw bad("That code is not valid.");
  // The scanner may hand back a URL that carries the token (the desk code does).
  const text = raw.trim();
  const token = text.includes("=") && text.includes("?") ? (new URL(text, "http://x").searchParams.get("d") ?? "") : text;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw bad("That code is not valid.");
  const given = Buffer.from(parts[1], "base64url");
  const want = mac(parts[0]);
  if (given.length !== want.length || !timingSafeEqual(given, want)) throw bad("That code is not valid.");
  let p: Payload;
  try {
    p = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Payload;
  } catch {
    throw bad("That code is not valid.");
  }
  if (!p || !["member", "booking", "desk"].includes(p.k) || typeof p.s !== "string" || typeof p.j !== "string") {
    throw bad("That code is not valid.");
  }
  if (typeof p.e !== "number" || p.e * 1000 < now) {
    throw bad("That code has expired — ask the member to refresh it.");
  }
  return { kind: p.k, sub: p.s, jti: p.j, expiresAt: p.e * 1000 };
}
