import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(plain, Buffer.from(salt, "base64url"), SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  }).toString("base64url");
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${hash}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts[0] !== "scrypt" || parts.length !== 6) return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4]!;
  const expected = Buffer.from(parts[5]!, "base64url");
  const actual = scryptSync(plain, Buffer.from(salt, "base64url"), expected.length, { N, r, p });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * A six-digit OTP from the CSPRNG.
 *
 * `Math.random()` is a fast non-cryptographic PRNG whose internal state can be
 * recovered from a handful of outputs, so an attacker who has seen a few codes
 * can predict the next one. `randomBytes` is already used for session tokens
 * three lines up; the code that guards an account registration deserves the
 * same source.
 *
 * Rejection sampling rather than a plain modulo: 2^32 is not a multiple of
 * 900000, so `% 900000` alone would make the low codes measurably likelier.
 */
export function randomOtp(): string {
  const RANGE = 900000;
  const limit = Math.floor(0xffffffff / RANGE) * RANGE;
  let n = randomBytes(4).readUInt32BE(0);
  while (n >= limit) n = randomBytes(4).readUInt32BE(0);
  return String(100000 + (n % RANGE));
}

/**
 * Keyed hash of an OTP, for storing a challenge.
 *
 * A six-digit code has only 900,000 possible values, so an unkeyed digest of
 * one is not a one-way function in any useful sense: the whole space hashes in
 * well under a second, and anybody who can read `otp_challenges` can invert
 * every row at once. HMAC under a server-side secret means the table alone is
 * not enough.
 *
 * `OTP_SECRET` unset falls back to a constant, which is no worse than what this
 * replaced — but it is a development posture, and `assertOtpSecret` refuses it
 * in production rather than letting it ship quietly.
 */
export function hashOtp(otp: string): string {
  return createHmac("sha256", process.env.OTP_SECRET || "arena3-dev-otp-secret")
    .update(otp)
    .digest("hex");
}

/** Whether OTP challenges are being keyed by a real secret. */
export function otpSecretConfigured(): boolean {
  return Boolean(process.env.OTP_SECRET?.trim());
}
