/**
 * Tệp tích hợp các dịch vụ AI bên ngoài (Google Gemini API và xAI Grok).
 * Cung cấp giải pháp sinh câu trả lời AI hai tầng: thử lần lượt chuỗi model Gemini Flash
 * (mặc định gemini-3.5-flash-lite → gemini-3.1-flash-lite → gemini-3.5-flash, đổi được qua GEMINI_MODELS),
 * model lỗi thì tạm nghỉ; hết model thì dự phòng sang xAI Grok (grok-4.5), cuối cùng là câu trả lời theo quy tắc.
 * Phục vụ tính năng trợ lý ảo hội viên (/v1/assistant) và gợi ý giáo án tập luyện (/v1/training-plans/suggest).
 */
import { readFileSync } from "node:fs";

export type ChatTurn = { role: "user" | "model"; text: string };
export type AssistantSource = "gemini" | "xai" | "rules";
// Per-call tuning. json asks for a bare JSON reply.
export type ReplyOptions = { maxOutputTokens?: number; json?: boolean };

/**
 * Gemini models tried in order, Flash family only.
 *
 * The assistant used to call one hardcoded model, and when Google closed
 * `gemini-2.5-flash` to new keys every question got a 404 that was swallowed
 * into the rule-based reply — the member saw the same canned line for every
 * question and nothing said why. Now a list: GEMINI_MODELS (comma-separated)
 * or GEMINI_MODEL overrides it, and a model that fails is skipped for a while
 * so the next one answers instead.
 *
 * Lite models first: measured on a free-tier key (18/11/2026), the Lite models
 * answered a plan-expiry question correctly in 0.5–1.5 s, while the full Flash
 * models ran past 20 s or answered 503. With two models asked per question, a
 * full Flash pair in front meant every question timed out into the rule reply.
 */
const DEFAULT_GEMINI_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash"];
const XAI_MODEL = "grok-4.5";
/** One model's attempt. A Lite reply takes about 1 s; a full Flash one can take far longer on the free tier. */
let TRY_MS = 9_000;
/** The whole question, fallbacks included: one slow answer plus a short second chance. */
let TOTAL_MS = 14_000;
/**
 * Longest turn of a conversation, in characters, everywhere it travels: the
 * reply shown to the member, the reply sealed for the thread
 * (`assistant-thread.ts`) and each turn sent back to a model. One number, so
 * a follow-up about the end of a long answer still reaches the model with
 * that end in it.
 */
export const MAX_TURN_CHARS = 4000;
/** Models asked per question. Each try spends free-tier quota (about 20 a day), so a bad hour costs two, not three. */
const MAX_MODELS_PER_ASK = 2;
const MAX_OUT = 1024;
/** Less time than this left before the deadline is not worth a request. */
let MIN_TRY_MS = 1_500;
/** Overloaded / rate-limited / timed out: try it again soon. */
const COOL_BUSY_MS = 60_000;
/** 404, the model is gone or not offered to this key: leave it alone for a long time. */
const COOL_GONE_MS = 6 * 60 * 60_000;

/**
 * When each model that failed may be asked again. An entry stays after its
 * time has passed: the model is then "recovering", and only one recovering
 * model is tried per question, so a chain that was all down comes back one
 * request at a time instead of every question paying for every model.
 */
const coolUntil = new Map<string, number>();
/** Models that answered 400 to `thinkingConfig` and then worked without it. */
const noThinkingConfig = new Set<string>();

function readSecretFile(name: string): string | undefined {
  try {
    const v = readFileSync(`/workspace/.secrets/${name}`, "utf8").trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

export function geminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || readSecretFile("gemini");
}

function xaiApiKey(): string | undefined {
  return process.env.XAI_API_KEY?.trim();
}

/** The configured chain, de-duplicated, with model names checked so nothing odd lands in the URL. */
export function geminiModels(): string[] {
  const raw = process.env.GEMINI_MODELS?.trim() || process.env.GEMINI_MODEL?.trim();
  const list = raw ? raw.split(",") : DEFAULT_GEMINI_MODELS;
  const clean = list.map((m) => m.trim().replace(/^models\//, "")).filter((m) => /^[a-z0-9.-]{3,64}$/i.test(m));
  return [...new Set(clean.length ? clean : DEFAULT_GEMINI_MODELS)];
}

/**
 * The models worth asking now, in the configured order: every healthy one,
 * plus at most one whose cooldown has run out. A model still cooling is never
 * asked — when nothing is left the question goes straight to xAI or the
 * rule-based reply instead of waiting on models known to be failing.
 */
export function modelsToTry(now = Date.now()): string[] {
  let probe = false;
  return geminiModels().filter((m) => {
    const until = coolUntil.get(m);
    if (until === undefined) return true;
    if (until > now || probe) return false;
    probe = true;
    return true;
  });
}

/** Test hooks: forget every cooldown, end them all now, or forget everything learned about the models. */
export function resetGeminiCooldowns(): void {
  coolUntil.clear();
}

export function expireGeminiCooldowns(): void {
  for (const m of coolUntil.keys()) coolUntil.set(m, 0);
}

export function setGeminiTimingForTests(t: { tryMs?: number; totalMs?: number; minMs?: number } | null): void {
  TRY_MS = t?.tryMs ?? 9_000;
  TOTAL_MS = t?.totalMs ?? 14_000;
  MIN_TRY_MS = t?.minMs ?? 1_500;
}

export function resetGeminiState(): void {
  coolUntil.clear();
  noThinkingConfig.clear();
  setGeminiTimingForTests(null);
}

/**
 * Thinking switched off as far as the model allows, so it cannot eat the
 * output budget and cut the answer short. Gemini 3 and later take
 * `thinkingLevel` (Google's current setting for them; "minimal" is accepted by
 * every default model above); 2.x takes `thinkingBudget: 0`.
 */
export function thinkingOffConfig(model: string): Record<string, unknown> {
  const gen = Number(/^gemini-(\d+)/.exec(model)?.[1] ?? 0);
  return gen >= 3 ? { thinkingLevel: "minimal" } : { thinkingBudget: 0 };
}

type GeminiCandidate = { finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } };

export function extractGeminiText(data: unknown): { text: string | null; finishReason: string | null; blocked: boolean } {
  if (!data || typeof data !== "object") return { text: null, finishReason: null, blocked: false };
  const blocked = Boolean((data as { promptFeedback?: { blockReason?: string } }).promptFeedback?.blockReason);
  const cands = (data as { candidates?: unknown }).candidates;
  if (!Array.isArray(cands) || !cands[0] || typeof cands[0] !== "object") return { text: null, finishReason: null, blocked };
  const c = cands[0] as GeminiCandidate;
  const text = (c.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("").trim();
  return { text: text || null, finishReason: c.finishReason ?? null, blocked };
}

/** What a failed attempt means for the rest of the chain. */
type Outcome = { kind: "ok"; text: string } | { kind: "next" } | { kind: "stop" };

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string; details?: Array<{ reason?: string }> } };
    // The reason (API_KEY_INVALID, …) sits in details, not in the message.
    const reasons = (body.error?.details ?? []).map((d) => d?.reason ?? "").join(" ");
    return `${body.error?.message ?? ""} ${reasons}`.replace(/\s+/g, " ").trim().slice(0, 200);
  } catch {
    return "";
  }
}

async function tryGemini(
  model: string,
  key: string,
  system: string,
  contents: unknown[],
  opts: ReplyOptions,
  deadline: number,
  thinkingOff = !noThinkingConfig.has(model),
): Promise<Outcome> {
  const maxOut = opts.maxOutputTokens ?? MAX_OUT;
  // A model that refuses the thinking setting is asked without it, with room for its thoughts.
  const left = deadline - Date.now();
  if (left < MIN_TRY_MS) return { kind: "stop" };
  const ms = Math.min(TRY_MS, left);
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      signal: AbortSignal.timeout(ms),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: {
          temperature: 0.35,
          maxOutputTokens: thinkingOff ? maxOut : maxOut * 2,
          ...(thinkingOff ? { thinkingConfig: thinkingOffConfig(model) } : {}),
          ...(opts.json ? { responseMimeType: "application/json" } : {}),
        },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
        ],
      }),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    console.warn(`[assistant] gemini ${model} ${timedOut ? `timeout after ${ms} ms` : "network error"}`);
    coolUntil.set(model, Date.now() + COOL_BUSY_MS);
    return { kind: "next" };
  }

  if (!res.ok) {
    const msg = await errorMessage(res);
    console.warn(`[assistant] gemini ${model} ${res.status}${msg ? `: ${msg}` : ""}`);
    // A bad key is the key, not the model: every model would say the same.
    // Gemini answers a wrong key with 400 API_KEY_INVALID, not 401/403.
    const badKey =
      (res.status === 400 && /API_KEY_INVALID|API key not valid|API key expired/i.test(msg)) ||
      ((res.status === 401 || res.status === 403) && /api key|permission|unauthori[sz]ed/i.test(msg) && !/model/i.test(msg));
    if (badKey) return { kind: "stop" };
    if (res.status === 400 && thinkingOff && /thinking/i.test(msg)) {
      // The model refused the thinking setting. Ask once more without it, and
      // remember that only if it then works.
      const again = await tryGemini(model, key, system, contents, opts, deadline, false);
      if (again.kind === "ok") noThinkingConfig.add(model);
      return again;
    }
    // Only 404 says the model is gone; any other 4xx is about this one request,
    // so the next model answers and this one stays available for everyone.
    if (res.status === 404) coolUntil.set(model, Date.now() + COOL_GONE_MS);
    else if (res.status === 429 || res.status >= 500) coolUntil.set(model, Date.now() + COOL_BUSY_MS);
    return { kind: "next" };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    console.warn(`[assistant] gemini ${model} unreadable reply`);
    return { kind: "next" };
  }
  const { text, finishReason, blocked } = extractGeminiText(data);
  if (blocked || finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT" || finishReason === "BLOCKLIST") {
    // The question itself was refused; another model is unlikely to differ. Rules answer it.
    console.warn(`[assistant] gemini ${model} blocked (${finishReason ?? "prompt"})`);
    return { kind: "stop" };
  }
  if (finishReason && finishReason !== "STOP") {
    // MAX_TOKENS and the like: a cut-off sentence reads as a wrong answer.
    console.warn(`[assistant] gemini ${model} finishReason ${finishReason}`);
    coolUntil.set(model, Date.now() + COOL_BUSY_MS);
    return { kind: "next" };
  }
  if (!text) {
    console.warn(`[assistant] gemini ${model} empty reply`);
    coolUntil.set(model, Date.now() + COOL_BUSY_MS);
    return { kind: "next" };
  }
  coolUntil.delete(model);
  return { kind: "ok", text };
}

async function callGemini(system: string, turns: ChatTurn[], opts: ReplyOptions, deadline: number): Promise<string | null> {
  const key = geminiApiKey();
  if (!key) return null;
  const contents = turns
    .filter((t) => t.text.trim().length > 0)
    .map((t) => ({ role: t.role === "model" ? "model" : "user", parts: [{ text: t.text.slice(0, MAX_TURN_CHARS) }] }));
  while (contents.length && contents[0]?.role !== "user") contents.shift();
  if (!contents.length) return null;

  const models = modelsToTry().slice(0, MAX_MODELS_PER_ASK);
  // Claim the probe before the first await: a second request arriving while it
  // is in flight then sees the model still cooling instead of probing it too.
  const hold = Date.now() + TRY_MS;
  for (const m of models) if (coolUntil.has(m)) coolUntil.set(m, hold);
  for (const model of models) {
    const out = await tryGemini(model, key, system, contents, opts, deadline);
    if (out.kind === "ok") return out.text;
    if (out.kind === "stop") return null;
  }
  return null;
}

async function callXai(system: string, turns: ChatTurn[], opts: ReplyOptions, deadline: number): Promise<string | null> {
  const key = xaiApiKey();
  if (!key) return null;
  const left = deadline - Date.now();
  if (left < MIN_TRY_MS) return null;
  const ms = Math.min(TRY_MS, left);
  const messages = [
    { role: "system", content: system },
    ...turns.map((t) => ({
      role: t.role === "model" ? "assistant" : "user",
      content: t.text.slice(0, MAX_TURN_CHARS),
    })),
  ];
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(ms),
    body: JSON.stringify({
      model: XAI_MODEL,
      messages,
      temperature: 0.35,
      max_tokens: opts.maxOutputTokens ?? MAX_OUT,
    }),
  });
  if (!res.ok) {
    console.warn(`[assistant] xai ${res.status}`);
    return null;
  }
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = body.choices?.[0]?.message?.content?.trim();
  return text || null;
}

export async function generateAssistantReply(
  system: string,
  turns: ChatTurn[],
  opts: ReplyOptions = {},
): Promise<{ text: string; source: Exclude<AssistantSource, "rules"> } | null> {
  const deadline = Date.now() + TOTAL_MS;
  try {
    const gemini = await callGemini(system, turns, opts, deadline);
    if (gemini) return { text: gemini, source: "gemini" };
  } catch (e) {
    console.warn("[assistant] gemini error", e instanceof Error ? e.message : "fail");
  }
  try {
    const xai = await callXai(system, turns, opts, deadline);
    if (xai) return { text: xai, source: "xai" };
  } catch (e) {
    console.warn("[assistant] xai error", e instanceof Error ? e.message : "fail");
  }
  return null;
}
