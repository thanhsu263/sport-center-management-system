/**
 * Tệp tích hợp các dịch vụ AI bên ngoài (Google Gemini API và xAI Grok).
 * Cung cấp giải pháp sinh câu trả lời AI hai tầng: ưu tiên gọi Google Gemini (gemini-2.5-flash),
 * tự động dự phòng sang xAI Grok (grok-4.5) nếu Gemini lỗi hoặc thiếu API key.
 * Phục vụ tính năng trợ lý ảo hội viên (/v1/assistant) và gợi ý giáo án tập luyện (/v1/training-plans/suggest).
 */
import { readFileSync } from "node:fs";

// Định dạng một lượt hội thoại giữa người dùng (role 'user') và mô hình AI (role 'model').
export type ChatTurn = { role: "user" | "model"; text: string };
// Nguồn gốc câu trả lời trợ lý: 'gemini' (chính), 'xai' (dự phòng), hoặc 'rules' (quy tắc nghiệp vụ nội bộ).
export type AssistantSource = "gemini" | "xai" | "rules";
// Per-call tuning. json asks for a bare JSON reply; Gemini 2.5 thinking is switched off then so it cannot eat the output budget.
export type ReplyOptions = { maxOutputTokens?: number; json?: boolean };

// Cấu hình mô hình AI mặc định, thời gian chờ timeout (12s) và giới hạn token đầu ra mặc định (512).
const GEMINI_MODEL = "gemini-2.5-flash";
const XAI_MODEL = "grok-4.5";
const TIMEOUT_MS = 12_000;
const MAX_OUT = 512;

/**
 * Làm gì: Đọc nội dung chuỗi bí mật (API key) từ tệp trong thư mục `/workspace/.secrets/`.
 * Được gọi ở: Hàm `geminiApiKey` trong cùng tệp khi không tìm thấy khóa trong biến môi trường.
 * @param name Tên tệp bí mật cần đọc trong thư mục .secrets (ví dụ: "gemini").
 * @returns Chuỗi bí mật đã cắt khoảng trắng thừa, hoặc undefined nếu không đọc được hoặc tệp không tồn tại.
 */
function readSecretFile(name: string): string | undefined {
  try {
    // Bước 1: Đọc tệp bí mật đồng bộ theo bảng mã UTF-8 và cắt khoảng trắng thừa.
    const v = readFileSync(`/workspace/.secrets/${name}`, "utf8").trim();
    return v || undefined;
  } catch {
    // Trả về undefined nếu không thể đọc được tệp (tệp không tồn tại hoặc lỗi quyền truy cập).
    return undefined;
  }
}

/**
 * Làm gì: Lấy Google Gemini API key theo thứ tự ưu tiên từ biến môi trường hoặc tệp secret.
 * Được gọi ở: Hàm `callGemini` trong cùng tệp.
 * @returns Chuỗi API key nếu tìm thấy, hoặc undefined nếu chưa được cấu hình.
 */
export function geminiApiKey(): string | undefined {
  // Ưu tiên biến môi trường GEMINI_API_KEY hoặc GOOGLE_API_KEY, nếu không có sẽ tìm trong tệp secret cục bộ.
  return process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || readSecretFile("gemini");
}

/**
 * Làm gì: Lấy API key của xAI (dùng cho mô hình Grok dự phòng) từ biến môi trường `XAI_API_KEY`.
 * Được gọi ở: Hàm `callXai` trong cùng tệp.
 * @returns Chuỗi API key xAI nếu tồn tại, ngược lại trả về undefined.
 */
function xaiApiKey(): string | undefined {
  return process.env.XAI_API_KEY?.trim();
}

/**
 * Làm gì: Bóc tách chuỗi văn bản câu trả lời từ dữ liệu JSON phản hồi của Google Gemini API.
 * Được gọi ở: Hàm `callGemini` trong cùng tệp sau khi gọi API thành công.
 * @param data Dữ liệu phản hồi thô nhận từ Google Gemini API.
 * @returns Chuỗi văn bản đã trích xuất và loại bỏ khoảng trắng thừa, hoặc null nếu phản hồi không hợp lệ.
 */
function extractGeminiText(data: unknown): string | null {
  // Bước 1: Kiểm tra tính hợp lệ của dữ liệu phản hồi thô trước khi bóc tách.
  if (!data || typeof data !== "object") return null;
  const cands = (data as { candidates?: unknown }).candidates;
  if (!Array.isArray(cands) || !cands[0] || typeof cands[0] !== "object") return null;
  // Bước 2: Trích xuất danh sách các đoạn nội dung (parts) từ câu trả lời của ứng viên (candidate) đầu tiên.
  const content = (cands[0] as { content?: { parts?: Array<{ text?: string }> } }).content;
  const parts = content?.parts ?? [];
  // Bước 3: Ghép nối các phần văn bản lại thành một chuỗi duy nhất và cắt bỏ khoảng trắng thừa.
  const text = parts.map((p) => p.text ?? "").join("").trim();
  return text || null;
}

/**
 * Làm gì: Gửi yêu cầu hội thoại tới Google Gemini API (`gemini-2.5-flash`) để sinh phản hồi văn bản hoặc JSON.
 * Được gọi ở: Hàm `generateAssistantReply` trong cùng tệp (lớp gọi AI chính).
 * @param system Lời nhắc chỉ thị hệ thống (system instruction) định hình vai trò và quy tắc trả lời của AI.
 * @param turns Danh sách các lượt hội thoại trước đó và câu hỏi hiện tại giữa người dùng và AI.
 * @param opts Tùy chọn bổ sung: giới hạn token (`maxOutputTokens`) hoặc yêu cầu định dạng JSON (`json`).
 * @returns Nội dung phản hồi dạng chuỗi văn bản, hoặc null nếu thất bại hoặc thiếu API key.
 */
async function callGemini(system: string, turns: ChatTurn[], opts: ReplyOptions = {}): Promise<string | null> {
  // Bước 1: Kiểm tra API key của Gemini; nếu chưa cấu hình thì dừng sớm để chuyển sang phương án dự phòng.
  const key = geminiApiKey();
  if (!key) return null;
  // Bước 2: Chuẩn hóa lịch sử hội thoại sang định dạng contents của Gemini; giới hạn mỗi tin nhắn tối đa 1200 ký tự để kiểm soát chi phí token.
  const contents = turns
    .filter((t) => t.text.trim().length > 0)
    .map((t) => ({ role: t.role === "model" ? "model" : "user", parts: [{ text: t.text.slice(0, 1200) }] }));
  // Gemini API bắt buộc lượt tin nhắn đầu tiên phải xuất phát từ người dùng (role 'user').
  while (contents.length && contents[0]?.role !== "user") contents.shift();
  if (!contents.length) return null;
  // Bước 3: Gửi HTTP POST request đến endpoint generateContent của Gemini với timeout 12 giây; nhiệt độ 0.35 giúp kết quả ổn định, tắt thinking khi cần JSON để tránh tiêu hao token.
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: {
          temperature: 0.35,
          maxOutputTokens: opts.maxOutputTokens ?? MAX_OUT,
          ...(opts.json ? { responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
        ],
      }),
    },
  );
  // Bước 4: Kiểm tra trạng thái HTTP; nếu có lỗi thì ghi log cảnh báo và trả về null để chuyển sang xAI.
  if (!res.ok) {
    console.warn(`[assistant] gemini ${res.status}`);
    return null;
  }
  // Bước 5: Bóc tách và trả về nội dung văn bản từ kết quả JSON nhận được.
  return extractGeminiText(await res.json());
}

/**
 * Làm gì: Gửi yêu cầu hội thoại tới xAI API (`grok-4.5`) theo chuẩn OpenAI chat completions đóng vai trò mô hình dự phòng (fallback).
 * Được gọi ở: Hàm `generateAssistantReply` trong cùng tệp khi Gemini gặp sự cố hoặc thiếu API key.
 * @param system Lời nhắc chỉ thị hệ thống (system prompt).
 * @param turns Lịch sử các lượt hội thoại giữa người dùng và trợ lý.
 * @param opts Tùy chọn cấu hình lượt gọi (số lượng token tối đa).
 * @returns Nội dung văn bản do Grok sinh ra, hoặc null nếu thất bại hoặc thiếu API key.
 */
async function callXai(system: string, turns: ChatTurn[], opts: ReplyOptions = {}): Promise<string | null> {
  // Bước 1: Kiểm tra xAI API key; nếu chưa cấu hình thì dừng sớm để chuyển sang quy tắc cứng (rules).
  const key = xaiApiKey();
  if (!key) return null;
  // Bước 2: Chuyển đổi lịch sử chat sang định dạng tin nhắn OpenAI (system, user, assistant); cắt tối đa 1200 ký tự mỗi tin.
  const messages = [
    { role: "system", content: system },
    ...turns.map((t) => ({
      role: t.role === "model" ? "assistant" : "user",
      content: t.text.slice(0, 1200),
    })),
  ];
  // Bước 3: Gửi request tới endpoint chat completions của xAI với timeout 12 giây.
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model: XAI_MODEL,
      messages,
      temperature: 0.35,
      max_tokens: opts.maxOutputTokens ?? MAX_OUT,
    }),
  });
  // Bước 4: Kiểm tra mã trạng thái HTTP; ghi log cảnh báo nếu xAI trả về mã lỗi.
  if (!res.ok) {
    console.warn(`[assistant] xai ${res.status}`);
    return null;
  }
  // Bước 5: Bóc tách nội dung câu trả lời từ choices[0].message trong kết quả JSON.
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = body.choices?.[0]?.message?.content?.trim();
  return text || null;
}

/**
 * Làm gì: Điều phối sinh câu trả lời AI hai tầng: ưu tiên gọi Google Gemini trước, tự động chuyển sang xAI Grok nếu Gemini thất bại.
 * Được gọi ở:
 * - `src/server/controllers/handlers/ops.ts` -> hàm `trainingSuggest` (route `POST /v1/training-plans/suggest`).
 * - `src/server/controllers/handlers/ops.ts` -> hàm `generateAssistantChatResponse` (được gọi bởi `assistantChat` tại route `POST /v1/assistant`).
 * @param system Lời nhắc chỉ thị hệ thống định hướng vai trò và luật trả lời.
 * @param turns Chuỗi lịch sử hội thoại gồm các lượt hỏi của người dùng và trả lời của mô hình.
 * @param opts Tùy chọn bổ sung (số token tối đa, cờ yêu cầu JSON).
 * @returns Đối tượng chứa nội dung text và nguồn sinh câu trả lời ("gemini" hoặc "xai"), hoặc null nếu cả hai đều thất bại.
 */
export async function generateAssistantReply(
  system: string,
  turns: ChatTurn[],
  opts: ReplyOptions = {},
): Promise<{ text: string; source: Exclude<AssistantSource, "rules"> } | null> {
  // Bước 1: Thử gọi Google Gemini (nguồn chính). Nếu thành công thì trả về ngay với nguồn "gemini".
  try {
    const gemini = await callGemini(system, turns, opts);
    if (gemini) return { text: gemini, source: "gemini" };
  } catch (e) {
    // Bắt lỗi ngoại lệ (mạng ngắt quãng, timeout) khi gọi Gemini để tiếp tục luồng fallback dự phòng.
    console.warn("[assistant] gemini error", e instanceof Error ? e.message : "fail");
  }
  // Bước 2: Thử gọi xAI Grok (nguồn dự phòng fallback). Nếu thành công thì trả về với nguồn "xai".
  try {
    const xai = await callXai(system, turns, opts);
    if (xai) return { text: xai, source: "xai" };
  } catch (e) {
    // Bắt lỗi ngoại lệ khi gọi xAI dự phòng.
    console.warn("[assistant] xai error", e instanceof Error ? e.message : "fail");
  }
  // Bước 3: Cả hai mô hình AI đều thất bại, trả về null để tầng nghiệp vụ chuyển sang dùng quy tắc nội bộ (rules).
  return null;
}
