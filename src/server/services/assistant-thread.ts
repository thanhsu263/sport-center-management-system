import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { MAX_TURN_CHARS, type ChatTurn } from "../integrations/gemini";

/**
 * A seal on each AI reply, so the browser can send the thread back and the
 * server can tell its own past answers from ones a browser made up.
 *
 * The server used to drop every assistant turn the browser sent, because a
 * browser that may write the assistant's past can talk the model into a
 * discount or a free court that does not exist. With only the member's turns
 * left, the model saw a row of unanswered questions and answered the oldest
 * one again. A reply now comes back with `sig` = "<issued-at>.<HMAC(member,
 * issued-at, question, reply)>": only a question → answer pair whose seal
 * checks out reaches the model, so a real answer cannot be glued onto a
 * different question either.
 *
 * What the seal does not stop, by design: a member resending their own real
 * answers. Seals expire after THREAD_TTL_MS and pairs must arrive in the order
 * they were issued, so the most a member can do is replay, within a day,
 * something this server really told them — no new words for the assistant.
 *
 * The key is ASSISTANT_SECRET (or OTP_SECRET) and must be the same on every
 * instance. Without one it is random per process: a restart, or a second
 * server, then only makes old threads start fresh — the behaviour before this
 * change, not a hole — and production says so once in the log.
 */
const CONFIGURED = process.env.ASSISTANT_SECRET?.trim() || process.env.OTP_SECRET?.trim();
const KEY = CONFIGURED || randomBytes(32).toString("hex");
if (!CONFIGURED && process.env.NODE_ENV === "production") {
  console.warn("[assistant] ASSISTANT_SECRET is not set: conversation context will not survive a restart or reach a second server");
}

/** Longest assistant turn shown, sealed and sent back: the one limit in `gemini.ts`. */
export const MAX_BOT_TURN = MAX_TURN_CHARS;
/** Longest member question, as `assistantChat` takes it. */
export const MAX_QUESTION = 800;
/** How long a sealed answer may be sent back as context. */
export const THREAD_TTL_MS = 24 * 60 * 60_000;
/** Clock drift tolerated between instances. */
const SKEW_MS = 5 * 60_000;
/** Turns kept for the model: the four latest question → answer pairs. */
const MAX_TURNS = 8;

function mac(userId: string, issuedAt: number, question: string, reply: string): Buffer {
  return createHmac("sha256", KEY)
    .update(JSON.stringify(["assistant:v3", userId, issuedAt, question, reply]))
    .digest()
    .subarray(0, 18);
}

let lastIssued = 0;

export function signReply(userId: string, question: string, reply: string, at = Date.now()): string {
  // Strictly increasing per server, so two answers sealed in the same
  // millisecond still have one order that `parseHistory` can check.
  const now = at <= lastIssued && lastIssued - at < 1_000 ? lastIssued + 1 : at;
  lastIssued = now;
  return `${now.toString(36)}.${mac(userId, now, question, reply).toString("base64url")}`;
}

/** The time the seal was issued when it is genuine and still fresh, otherwise null. */
export function verifyReply(userId: string, question: string, reply: string, sig: unknown, now = Date.now()): number | null {
  if (typeof sig !== "string" || sig.length > 40 || reply.length > MAX_BOT_TURN) return null;
  const [ts, tag] = sig.split(".");
  if (!ts || !tag || tag.length !== 24 || !/^[0-9a-z]{1,12}$/.test(ts)) return null;
  const issuedAt = parseInt(ts, 36);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now + SKEW_MS || now - issuedAt > THREAD_TTL_MS) return null;
  const got = Buffer.from(tag, "base64url");
  const want = mac(userId, issuedAt, question, reply);
  return got.length === want.length && timingSafeEqual(got, want) ? issuedAt : null;
}

/**
 * The earlier turns the browser sends up with a question, as the model may see them.
 *
 * Only question → answer pairs whose seal proves this server wrote that answer
 * to that question for this member are kept, oldest first and in the order
 * they were issued. A question with no sealed answer after it (an old thread,
 * a failed call, a rule-based reply, a ticket confirmation) is dropped:
 * handed a row of unanswered questions, the model answered the oldest one
 * again instead of the one just asked.
 */
export function parseHistory(raw: unknown, userId: string, now = Date.now()): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  type Rec = { role?: unknown; text?: unknown; sig?: unknown };
  const items = raw.slice(-2 * MAX_TURNS - 8).filter((x): x is Rec => !!x && typeof x === "object" && typeof (x as Rec).text === "string");
  const out: ChatTurn[] = [];
  let last = 0;
  for (let i = 0; i < items.length - 1; i++) {
    const q = items[i]!;
    const a = items[i + 1]!;
    if (q.role !== "me" && q.role !== "user") continue;
    if (a.role !== "bot" && a.role !== "model") continue;
    // The same trim and cap `assistantChat` applied to the question it sealed.
    const question = (q.text as string).trim().slice(0, MAX_QUESTION);
    const answer = a.text as string;
    const issuedAt = question ? verifyReply(userId, question, answer, a.sig, now) : null;
    if (issuedAt !== null && issuedAt > last) {
      out.push({ role: "user", text: question }, { role: "model", text: answer });
      last = issuedAt;
      i++;
    }
  }
  return out.slice(-MAX_TURNS);
}
