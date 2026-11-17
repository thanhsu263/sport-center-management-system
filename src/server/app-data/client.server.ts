/**
 * Client phía server để gọi các công cụ (tools) của connector app-data qua edge gate.
 * File này chịu trách nhiệm lấy access token từ request header/env, xác thực same-site và method POST,
 * điều hướng request tới connectors gate API, quản lý cache lỗi tạm thời và xử lý token ở môi trường preview/deployed.
 * Chỉ chạy trên server (server-only).
 */
import { createHash } from "node:crypto";
import { getRequest } from "@tanstack/react-start/server";
import {
  assertSameSiteRequest,
  CrossSiteRequestError,
} from "../auth/isolation.server.ts";
import { env, isWorkspacePreview } from "../env.server.ts";
import { assertAppDataServerOnly } from "./server-only.ts";
import {
  CONNECTOR_TOKEN_HEADER,
  CONNECTOR_TOKEN_PENDING_CODE,
  ConnectorType,
  type CallToolOptions,
  type CallToolResult,
  type ToolArgs,
} from "../../shared/app-data/types.ts";

// Chặn thực thi ở client: module này là server-only và chứa secret token, tuyệt đối không chạy trên browser
assertAppDataServerOnly("app-data/client.server");

/**
 * Làm gì: Tên miền máy chủ connectors ở môi trường kiểm thử (staging).
 * Được gọi ở: src/server/app-data/client.server.ts (hàm connectorsBaseFor).
 */
export const CONNECTORS_HOST_STAGING = "connectors.app-builder-testing.com";
/**
 * Làm gì: Tên miền máy chủ connectors ở môi trường production.
 * Được gọi ở: src/server/app-data/client.server.ts (hàm connectorsBaseFor).
 */
export const CONNECTORS_HOST_PROD = "connectors.grok.me";

/**
 * Làm gì: Kiểm tra xem một host có phải là địa chỉ loopback cục bộ (localhost, 127.0.0.1, [::1]) hay không.
 * Được gọi ở: src/server/app-data/client.server.ts (hàm connectorsBaseFor, gateSigninUrl).
 * @param host Tên miền hoặc địa chỉ IP cần kiểm tra.
 * @returns true nếu là loopback host, ngược lại false.
 */
function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

type InboundContext = {
  token: string | null;
  publicHost: string | null;
  connectorsBase: string | null;
};

/**
 * Làm gì: Xác định URL gốc của connectors service dựa trên biến môi trường hoặc public host của request.
 * Được gọi ở: src/server/app-data/client.server.ts (hàm inboundContext).
 * @param publicHost Tên miền công khai của request (lấy từ header Host hoặc X-Forwarded-Host).
 * @returns URL gốc dạng https://... của connectors service hoặc null nếu không khớp môi trường.
 */
function connectorsBaseFor(publicHost: string | null): string | null {
  // Bước 1: Ưu tiên URL tường minh được cấu hình trong biến môi trường GROK_CONNECTORS_URL
  const explicit = env("GROK_CONNECTORS_URL");
  if (explicit) return explicit.replace(/\/+$/, "");

  // Bước 2: Kiểm tra public host để xác định domain staging hoặc production tương ứng
  const host = publicHost?.toLowerCase();
  // Không kết nối tới gate nếu không có host hoặc đang chạy local loopback mà không có GROK_CONNECTORS_URL
  if (!host || isLoopbackHost(host)) return null;
  if (
    host === "app-builder-testing.com" ||
    host.endsWith(".app-builder-testing.com")
  ) {
    return `https://${CONNECTORS_HOST_STAGING}`;
  }
  if (host === "grok.me" || host.endsWith(".grok.me")) {
    return `https://${CONNECTORS_HOST_PROD}`;
  }
  return null;
}

/**
 * Làm gì: Lấy đối tượng Request hiện tại từ context của TanStack Start mà không ném ngoại lệ nếu không có context.
 * Được gọi ở: src/server/app-data/client.server.ts (hàm inboundContext, nonPostBlockedResult).
 * @returns Đối tượng Request hiện tại, hoặc null nếu nằm ngoài request context (ví dụ lúc build SSR).
 */
function tryGetRequest(): Request | null {
  try {
    return getRequest() ?? null;
  } catch {
    return null;
  }
}

/**
 * Làm gì: Trích xuất thông tin ngữ cảnh từ request gửi đến gồm token xác thực, public host và URL gốc connectorsBase.
 * Được gọi ở: src/server/app-data/client.server.ts (hàm resolveGateAppDataBase, getConnectorAccessToken, isConnectorTokenReady, callTool).
 * @returns Đối tượng InboundContext chứa token, publicHost và connectorsBase.
 */
function inboundContext(): InboundContext {
  // Bước 1: Lấy request hiện tại và trích xuất public host từ x-forwarded-host hoặc host header
  const req = tryGetRequest();
  const xf = req?.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const publicHost =
    (xf || req?.headers.get("host") || "").split(":")[0]?.trim() || null;
  // Bước 2: Lấy token từ header request, hoặc fallback về biến môi trường khi ở chế độ development
  const headerToken = req?.headers.get(CONNECTOR_TOKEN_HEADER)?.trim() || null;
  const envToken =
    process.env.NODE_ENV === "production"
      ? null
      : (env("GROK_CONNECTOR_ACCESS_TOKEN") ?? null);
  // Bước 3: Đóng gói ngữ cảnh và tự động phân giải URL connectorsBase tương ứng
  return {
    token: headerToken ?? envToken,
    publicHost,
    connectorsBase: connectorsBaseFor(publicHost),
  };
}

/**
 * Làm gì: Lấy URL gốc của dịch vụ connectors gate tương ứng với request hiện tại.
 * Được gọi ở: Các server handlers cần biết địa chỉ máy chủ gate của connector.
 * @returns URL gốc của gate (ví dụ https://connectors.grok.me) hoặc null nếu không xác định được.
 */
export function resolveGateAppDataBase(): string | null {
  return inboundContext().connectorsBase;
}

/**
 * Làm gì: Lấy connector access token từ request hiện tại hoặc biến môi trường phát triển.
 * Được gọi ở: Các server handlers cần sử dụng hoặc kiểm tra token trực tiếp.
 * @returns Token xác thực dạng chuỗi, hoặc null nếu không có token.
 */
export function getConnectorAccessToken(): string | null {
  return inboundContext().token;
}

export { isWorkspacePreview } from "../env.server.ts";

// Digest of the last preview token the gate answered 401 for. The readiness
// probe reports "not ready" while that exact token is still the one on the
// request, so the client waits for the preview panel to push a fresh token
// instead of re-calling the gate with a token already known to be rejected.
let rejectedTokenDigest: string | null = null;

/**
 * Làm gì: Băm SHA-256 chuỗi token và mã hóa base64url để đối chiếu mà không lưu token thô trong bộ nhớ.
 * Được gọi ở: src/server/app-data/client.server.ts (hàm noteTokenRejected, noteTokenAccepted, isConnectorTokenReady).
 * @param token Chuỗi access token cần băm.
 * @returns Chuỗi mã băm định dạng base64url.
 */
function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/**
 * Làm gì: Ghi nhận mã băm của token vừa bị gate từ chối (HTTP 401) để probe readiness báo chưa sẵn sàng.
 * Được gọi ở: src/server/app-data/client.server.ts (hàm unauthorizedResult).
 * @param token Chuỗi token bị gate phản hồi lỗi 401.
 */
function noteTokenRejected(token: string): void {
  rejectedTokenDigest = tokenDigest(token);
}

/**
 * Làm gì: Xóa mã băm token bị từ chối nếu token đó vừa được gate chấp nhận xử lý thành công.
 * Được gọi ở: src/server/app-data/client.server.ts (hàm callTool).
 * @param token Chuỗi token vừa được gate xác thực thành công.
 */
function noteTokenAccepted(token: string): void {
  if (rejectedTokenDigest === tokenDigest(token)) rejectedTokenDigest = null;
}

/**
 * True when the inbound request carries a connector token the gate has not
 * rejected. This is what the preview readiness probe reports; it never calls
 * the gate.
 */
export function isConnectorTokenReady(): boolean {
  const token = inboundContext().token;
  // Token sẵn sàng khi có token và token đó không trùng với token vừa bị gate trả về 401
  return token !== null && tokenDigest(token) !== rejectedTokenDigest;
}

type GateJson = {
  ok?: boolean;
  data?: unknown;
  errorMessage?: string;
  loginUrl?: string;
};

/**
 * Làm gì: Gửi HTTP POST request chứa payload gọi tool tới API endpoint /call-tool của connectors gate.
 * Được gọi ở: src/server/app-data/client.server.ts (hàm callTool).
 * @param ctx Ngữ cảnh request chứa thông tin publicHost và URL connectorsBase.
 * @param body Dữ liệu payload gửi lên gate (tool_name, arguments, connector_type,...).
 * @param token Access token dùng cho header Authorization Bearer.
 * @returns Đối tượng chứa mã HTTP status và dữ liệu JSON phản hồi từ gate.
 * @throws Error Nếu không thể xác định gate host hoặc URL gate không phải là http(s) tuyệt đối.
 */
async function gatePost(
  ctx: InboundContext,
  body: Record<string, unknown>,
  token: string,
): Promise<{ status: number; json: GateJson }> {
  // Bước 1: Kiểm tra tính hợp lệ của URL máy chủ gate trước khi thực hiện gọi mạng
  const base = ctx.connectorsBase;
  if (!base) {
    throw new Error(
      "cannot resolve gate host (missing x-forwarded-host/host on the server request); " +
        "open the app through the gated public URL so the gate can proxy and inject credentials",
    );
  }

  if (!/^https?:\/\//i.test(base)) {
    throw new Error(
      `gate base must be absolute http(s) URL (got ${base}); refusing relative fetch`,
    );
  }

  // Bước 2: Thiết lập headers gồm Authorization Bearer và x-forwarded-host
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `Bearer ${token}`,
  };
  if (ctx.publicHost) {
    headers["x-forwarded-host"] = ctx.publicHost;
  }

  // Bước 3: Gửi HTTP POST request tới endpoint /call-tool của gate
  const res = await fetch(`${base}/call-tool`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "manual",
  });

  // Bước 4: Đọc và parse dữ liệu JSON phản hồi, fallback lỗi an toàn nếu gate trả về non-JSON
  let json: GateJson = {};
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text) as GateJson;
    } catch {
      json = {
        ok: false,
        errorMessage: `gate non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`,
      };
    }
  }

  return { status: res.status, json };
}

/**
 * Làm gì: Xây dựng URL trang đăng nhập (__gate/signin) kèm tham số return_to để người dùng xác thực tài khoản.
 * Được gọi ở: src/server/app-data/client.server.ts (hàm unauthorizedResult).
 * @param ctx Ngữ cảnh request chứa thông tin connectorsBase và publicHost.
 * @returns Đường dẫn đăng nhập hoàn chỉnh hoặc undefined nếu không xác định được host của gate.
 */
function gateSigninUrl(ctx: InboundContext): string | undefined {
  // Bước 1: Trích xuất host từ connectorsBase và chuyển đổi tiền tố connectors. thành gate.
  const base = ctx.connectorsBase;
  if (!base) return undefined;
  try {
    const connectorsHost = new URL(base).host.toLowerCase();
    const gateHost = connectorsHost.replace(/^connectors\./, "gate.");
    if (gateHost === connectorsHost) return undefined;
    // Bước 2: Tạo URL return_to trỏ về public host của ứng dụng để redirect sau khi đăng nhập
    const publicHost = ctx.publicHost?.toLowerCase();
    const gated =
      publicHost && !isLoopbackHost(publicHost)
        ? `https://${publicHost}`
        : undefined;
    const signin = `https://${gateHost}/__gate/signin`;
    return gated
      ? `${signin}?return_to=${encodeURIComponent(gated)}`
      : signin;
  } catch {
    return undefined;
  }
}

const PENDING_TOKEN_MISSING =
  "the preview has not received the connector token yet; it arrives once " +
  "the connector grant is approved";
const PENDING_TOKEN_REJECTED =
  "the gate rejected the current preview token; the preview panel pushes a " +
  "fresh one on its own schedule";

/**
 * Làm gì: Tạo đối tượng kết quả CallToolResult biểu thị trạng thái đang chờ token (pending: true) trong preview.
 * Được gọi ở: src/server/app-data/client.server.ts (hàm missingAuthResult, unauthorizedResult).
 * @param reason Lý do chi tiết giải thích vì sao token đang ở trạng thái chờ.
 * @returns Đối tượng CallToolResult có cờ pending: true và mã lỗi connector_token_pending.
 */
function pendingTokenResult(reason: string): CallToolResult {
  return {
    ok: false,
    data: null,
    pending: true,
    errorMessage: `${CONNECTOR_TOKEN_PENDING_CODE}: ${reason}`,
  };
}

// Deployed apps only reach here when the request bypassed the gate (the gate
// injects the token on every proxied request), so a sign-in redirect cannot
// fix it: no loginRequired / loginUrl.
/**
 * Làm gì: Tạo kết quả khi request thiếu token (trả về pending trong preview, hoặc báo lỗi truy cập qua gate khi đã deploy).
 * Được gọi ở: src/server/app-data/client.server.ts (hàm callTool).
 * @returns Đối tượng CallToolResult biểu thị lỗi thiếu token xác thực.
 */
function missingAuthResult(): CallToolResult {
  // Trong preview: trả về pending vì token sẽ được cấp tự động sau khi người dùng phê duyệt quyền
  if (isWorkspacePreview()) return pendingTokenResult(PENDING_TOKEN_MISSING);
  return {
    ok: false,
    data: null,
    errorMessage:
      "missing_connector_token: open this app through the edge gate " +
      "(the server must receive x-connector-access-token on the inbound request)",
  };
}

/**
 * Làm gì: Xử lý phản hồi HTTP 401 từ gate (đánh dấu token bị từ chối ở preview, hoặc trả về loginRequired kèm loginUrl khi đã deploy).
 * Được gọi ở: src/server/app-data/client.server.ts (hàm callTool).
 * @param ctx Ngữ cảnh request chứa thông tin host để sinh loginUrl.
 * @param json Dữ liệu JSON trả về từ gate (có thể chứa errorMessage và loginUrl).
 * @param token Token vừa bị gate phản hồi lỗi 401.
 * @returns Đối tượng CallToolResult chứa trạng thái pending hoặc yêu cầu đăng nhập (loginRequired: true).
 */
function unauthorizedResult(
  ctx: InboundContext,
  json: GateJson,
  token: string,
): CallToolResult {
  // Bước 1: Trong preview, ghi nhớ token bị reject để probe readiness báo not ready và trả về pending
  if (isWorkspacePreview()) {
    noteTokenRejected(token);
    return pendingTokenResult(PENDING_TOKEN_REJECTED);
  }
  // Bước 2: Khi đã deploy, trả về loginRequired: true cùng loginUrl để UI chuyển hướng đăng nhập
  const loginUrl =
    gateSigninUrl(ctx) ??
    (typeof json.loginUrl === "string" && json.loginUrl
      ? json.loginUrl
      : undefined);
  return {
    ok: false,
    data: null,
    loginRequired: true,
    errorMessage: json.errorMessage ?? "login required",
    ...(loginUrl ? { loginUrl } : {}),
  };
}

/**
 * Làm gì: Kiểm tra và chặn các request cross-site độc hại gửi tới server functions của ứng dụng.
 * Được gọi ở: src/server/app-data/client.server.ts (hàm callTool).
 * @returns Đối tượng CallToolResult lỗi nếu phát hiện request cross-site, hoặc null nếu request hợp lệ.
 */
function crossSiteBlockedResult(): CallToolResult | null {
  try {
    assertSameSiteRequest();
    return null;
  } catch (e) {
    if (e instanceof CrossSiteRequestError) {
      return { ok: false, data: null, errorMessage: e.message };
    }
    return null;
  }
}

// Thời gian sống (TTL = 5 giây) cho bộ nhớ đệm lưu các kết quả gọi tool thất bại, tránh spam request lỗi liên tục
const FAILURE_MEMO_TTL_MS = 5_000;
const failureMemo = new Map<string, { at: number; result: CallToolResult }>();

/**
 * Làm gì: Trích xuất định danh (sub, team_id) từ payload JWT để làm khóa cache, giúp chia sẻ cache lỗi khi token được cấp lại.
 * Được gọi ở: src/server/app-data/client.server.ts (hàm callTool).
 * @param token Chuỗi access token (JWT hoặc chuỗi thông thường).
 * @returns Chuỗi mã băm đại diện cho danh tính người dùng hoặc mã băm của chính chuỗi token.
 */
function tokenIdentityKey(token: string): string {
  // Bước 1: Giải mã payload của JWT để trích xuất sub và team_id làm khóa định danh người dùng
  const payload = token.split(".")[1];
  if (payload) {
    try {
      const claims: unknown = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      );
      if (claims && typeof claims === "object" && !Array.isArray(claims)) {
        const { sub, team_id: teamId } = claims as {
          sub?: unknown;
          team_id?: unknown;
        };
        if (typeof sub === "string" && sub) {
          return createHash("sha256")
            .update(
              JSON.stringify([sub, typeof teamId === "string" ? teamId : null]),
            )
            .digest("base64url");
        }
      }
    } catch {
      /* malformed token — fall through to hashing the raw string */
    }
  }
  // Bước 2: Fallback băm toàn bộ chuỗi token nếu không phải JWT hoặc payload không hợp lệ
  return createHash("sha256").update(token).digest("base64url");
}

/**
 * Làm gì: Tra cứu kết quả lỗi đã được lưu cache trước đó cho cùng một khóa gọi tool trong khoảng thời gian TTL (5 giây).
 * Được gọi ở: src/server/app-data/client.server.ts (hàm callTool).
 * @param key Khóa định danh thao tác gọi tool (chuỗi JSON serialize từ toolName, args, token identity,...).
 * @returns Kết quả lỗi CallToolResult đã cache nếu còn hiệu lực, ngược lại trả về null.
 */
function memoizedFailure(key: string | null): CallToolResult | null {
  if (!key) return null;
  const hit = failureMemo.get(key);
  if (!hit) return null;
  // Xóa mục cache nếu đã quá thời gian sống 5 giây (TTL)
  if (Date.now() - hit.at > FAILURE_MEMO_TTL_MS) {
    failureMemo.delete(key);
    return null;
  }
  return hit.result;
}

/**
 * Làm gì: Lưu kết quả lỗi vào Map bộ nhớ đệm tạm thời và dọn dẹp các mục đã hết hạn để tránh tích tụ bộ nhớ.
 * Được gọi ở: src/server/app-data/client.server.ts (hàm callTool).
 * @param key Khóa định danh thao tác gọi tool.
 * @param result Kết quả lỗi CallToolResult cần lưu cache.
 * @returns Chính đối tượng CallToolResult được truyền vào.
 */
function memoizeFailure(
  key: string | null,
  result: CallToolResult,
): CallToolResult {
  if (!key) return result;
  // Quét và xóa các mục cache đã hết hạn trước khi lưu mục mới
  const now = Date.now();
  for (const [staleKey, entry] of failureMemo) {
    if (now - entry.at > FAILURE_MEMO_TTL_MS) failureMemo.delete(staleKey);
  }
  failureMemo.set(key, { at: now, result });
  return result;
}

/**
 * Làm gì: Lấy số lượng mục lỗi hiện đang lưu trong bộ nhớ đệm failure memo (chủ yếu phục vụ kiểm thử).
 * Được gọi ở: src/server/app-data/app-data.test.ts (trong các ca kiểm thử dọn dẹp cache).
 * @returns Số lượng mục hiện có trong failureMemo Map.
 */
export function failureMemoSize(): number {
  return failureMemo.size;
}

/**
 * Làm gì: Chuyển đổi mảng các thành phần định danh thành chuỗi JSON an toàn dùng làm khóa cache (tránh lỗi khi có circular reference).
 * Được gọi ở: src/server/app-data/client.server.ts (hàm callTool).
 * @param parts Mảng các giá trị cấu thành khóa (tên tool, args, connectorType, catalogId, token identity).
 * @returns Chuỗi JSON biểu diễn khóa cache, hoặc null nếu không thể serialize.
 */
function safeMemoKey(parts: unknown[]): string | null {
  try {
    return JSON.stringify(parts);
  } catch {
    return null;
  }
}

/**
 * Làm gì: Kiểm tra HTTP method của request gửi đến và chặn các request không phải POST để đảm bảo an toàn cho connector call.
 * Được gọi ở: src/server/app-data/client.server.ts (hàm callTool).
 * @returns Đối tượng CallToolResult lỗi nếu method không phải POST, hoặc null nếu hợp lệ.
 */
function nonPostBlockedResult(): CallToolResult | null {
  const req = tryGetRequest();
  if (!req || req.method === "POST") return null;
  return {
    ok: false,
    data: null,
    errorMessage:
      `blocked ${req.method} inbound request: connector calls must run inside ` +
      'a createServerFn({ method: "POST" }) handler',
  };
}

/**
 * Làm gì: Thực thi một công cụ (tool) của connector qua edge gate, xử lý bảo mật, xác thực token, memoize lỗi và trả về dữ liệu.
 * Được gọi ở: Các server functions (createServerFn) tích hợp app-data, src/server/app-data/app-data.test.ts.
 * @param toolName Tên công cụ cần thực thi (ví dụ google_drive_search, google_calendar_search).
 * @param args Tham số đầu vào truyền cho công cụ (dạng key-value).
 * @param options Tùy chọn cấu hình gọi tool gồm connectorType, connectorCatalogId và token tùy chọn.
 * @returns Promise chứa CallToolResult gồm cờ ok, dữ liệu trả về hoặc thông tin lỗi/đăng nhập.
 */
export async function callTool(
  toolName: string,
  args: ToolArgs,
  options: CallToolOptions,
): Promise<CallToolResult> {
  // Bước 1: Kiểm tra bảo mật request (chặn các cuộc gọi cross-site và bắt buộc dùng method POST)
  const blocked = crossSiteBlockedResult() ?? nonPostBlockedResult();
  if (blocked) return blocked;

  // Bước 2: Lấy thông tin ngữ cảnh và kiểm tra sự tồn tại của connector access token
  const ctx = inboundContext();
  const token = options.token ?? ctx.token;
  if (!token) {
    return missingAuthResult();
  }

  // Bước 3: Xác thực loại connector (bắt buộc phải chỉ định connectorType)
  const connectorType = options.connectorType;
  if (!connectorType) {
    return {
      ok: false,
      data: null,
      errorMessage:
        "connectorType is required: pass the connector type granted to this app " +
        "(e.g. { connectorType: ConnectorType.GoogleDrive })",
    };
  }

  // Bước 4: Tạo memo key và kiểm tra bộ nhớ đệm lỗi (tránh spam request khi thao tác liên tục thất bại)
  const memoKey = safeMemoKey([
    toolName,
    args,
    connectorType,
    options?.connectorCatalogId ?? null,
    tokenIdentityKey(token),
  ]);
  const memoized = memoizedFailure(memoKey);
  if (memoized) {
    return memoized;
  }
  const fail = (errorMessage: string): CallToolResult =>
    memoizeFailure(memoKey, { ok: false, data: null, errorMessage });
  // Bắt buộc cung cấp connectorCatalogId khi loại connector là Mcp
  if (connectorType === ConnectorType.Mcp && !options?.connectorCatalogId) {
    return {
      ok: false,
      data: null,
      errorMessage: "connectorCatalogId is required when connectorType is Mcp",
    };
  }

  // Bước 5: Gửi request gọi tool tới edge gate và xử lý kết quả phản hồi
  try {
    const { status, json } = await gatePost(
      ctx,
      {
        host: ctx.publicHost ?? undefined,
        connector_type: connectorType,
        tool_name: toolName,
        arguments: args,
        connector_catalog_id: options.connectorCatalogId,
      },
      token,
    );

    // Gate từ chối token (HTTP 401): xử lý trả về pending ở preview hoặc loginRequired khi đã deploy
    if (status === 401) {
      return unauthorizedResult(ctx, json, token);
    }
    // Ghi nhận token hợp lệ để xóa cờ bị từ chối nếu có trước đó
    noteTokenAccepted(token);
    if (status === 403) {
      return fail(json.errorMessage ?? "access_denied");
    }
    if (json.errorMessage && json.ok === false) {
      return fail(json.errorMessage);
    }
    if (status >= 400 && json.ok !== true) {
      return fail(json.errorMessage ?? `HTTP ${status}`);
    }
    if (json.ok === false) {
      return fail(json.errorMessage ?? "tool error");
    }
    // Gọi tool thành công, trả về dữ liệu kết quả
    return { ok: true, data: json.data ?? null };
  } catch (e) {
    // Bắt lỗi ngoại lệ (mạng, parse JSON...) và lưu vào failure memo trước khi trả về kết quả lỗi
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export {
  ConnectorType,
  GoogleCalendarTools,
  GoogleDriveTools,
  CONNECTOR_TOKEN_HEADER,
} from "../../shared/app-data/types.ts";
export type {
  CallToolResult,
  CallToolOptions,
  ToolArgs,
  ConnectorTypeName,
} from "../../shared/app-data/types.ts";
export { isLoginRequired, redirectToLoginIfRequired } from "../../shared/app-data/login.ts";
