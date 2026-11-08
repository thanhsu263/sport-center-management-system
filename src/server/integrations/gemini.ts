import { readFileSync } from "node:fs";

export type ChatTurn = { role: "user" | "model"; text: string };
export type AssistantSource = "gemini" | "xai" | "rules";

const GEMINI_MODEL = "gemini-2.5-flash";
const XAI_MODEL = "grok-4.5";
const TIMEOUT_MS = 12_000;
const MAX_OUT = 512;

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

function extractGeminiText(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const cands = (data as { candidates?: unknown }).candidates;
  if (!Array.isArray(cands) || !cands[0] || typeof cands[0] !== "object") return null;
  const content = (cands[0] as { content?: { parts?: Array<{ text?: string }> } }).content;
  const parts = content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("").trim();
  return text || null;
}

async function callGemini(system: string, turns: ChatTurn[]): Promise<string | null> {
  const key = geminiApiKey();
  if (!key) return null;
  const contents = turns
    .filter((t) => t.text.trim().length > 0)
    .map((t) => ({ role: t.role === "model" ? "model" : "user", parts: [{ text: t.text.slice(0, 1200) }] }));
  while (contents.length && contents[0]?.role !== "user") contents.shift();
  if (!contents.length) return null;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature: 0.35, maxOutputTokens: MAX_OUT },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
        ],
      }),
    },
  );
  if (!res.ok) {
    console.warn(`[assistant] gemini ${res.status}`);
    return null;
  }
  return extractGeminiText(await res.json());
}

async function callXai(system: string, turns: ChatTurn[]): Promise<string | null> {
  const key = xaiApiKey();
  if (!key) return null;
  const messages = [
    { role: "system", content: system },
    ...turns.map((t) => ({
      role: t.role === "model" ? "assistant" : "user",
      content: t.text.slice(0, 1200),
    })),
  ];
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model: XAI_MODEL,
      messages,
      temperature: 0.35,
      max_tokens: MAX_OUT,
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
): Promise<{ text: string; source: Exclude<AssistantSource, "rules"> } | null> {
  try {
    const gemini = await callGemini(system, turns);
    if (gemini) return { text: gemini, source: "gemini" };
  } catch (e) {
    console.warn("[assistant] gemini error", e instanceof Error ? e.message : "fail");
  }
  try {
    const xai = await callXai(system, turns);
    if (xai) return { text: xai, source: "xai" };
  } catch (e) {
    console.warn("[assistant] xai error", e instanceof Error ? e.message : "fail");
  }
  return null;
}
