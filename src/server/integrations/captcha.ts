import { err } from "../controllers/errors";

/** Fail closed when enabled; an unset secret preserves local/demo behaviour. */
export async function verifyCaptcha(token: unknown, ip?: string): Promise<void> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return;
  const rejected = () => err.validation("Complete the human verification and try again.", { field: "captcha" });
  if (typeof token !== "string" || !token.trim() || token.length > 2048) throw rejected();
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok && (await response.json()).success === true) return;
  } catch {
    // Unavailable verification must never authorize a write or email.
  }
  throw rejected();
}
