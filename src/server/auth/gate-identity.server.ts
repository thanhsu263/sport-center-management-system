/**
 * File: src/server/auth/gate-identity.server.ts
 * Vai trò: Xử lý và xác thực danh tính người dùng (GateIdentity) gửi từ Grok Gate proxy qua header x-grok-identity.
 * Vị trí trong app: Phục vụ tầng xác thực server-side, xác minh chữ ký số JWT (EdDSA) bằng JWKS public key,
 * hỗ trợ tự động đăng nhập người dùng xem app (gate identity sessions) trong Better Auth.
 */
import {
  importJWK,
  jwtVerify,
  type JWK,
  type JWTVerifyGetKey,
} from "jose";
import { env, isWorkspacePreview } from "../env.server.ts";

/**
 * Làm gì: Tên header HTTP mang token JWT định danh người dùng do Grok Gate gửi kèm trong request.
 * Được gọi ở: src/server/auth/gate-identity.server.ts (hàm gateIdentityFromHeaders), src/server/auth/gate-session.server.ts (middleware gateIdentitySessions), test runner (node --test trong src/server/auth/gate-identity.test.ts).
 */
export const GATE_IDENTITY_HEADER = "x-grok-identity";
/**
 * Làm gì: Đường dẫn URL endpoint phục vụ bộ khóa công khai JWKS từ Grok Gate để tải public key xác thực chữ ký JWT.
 * Được gọi ở: src/server/auth/gate-identity.server.ts (hàm resolveGateEndpoints), test runner (node --test trong src/server/auth/gate-identity.test.ts).
 */
export const GATE_JWKS_PATH = "/__gate/identity-key";

const JWKS_CACHE_TTL_MS = 300_000;
const PREVIEW_AUDIENCE = "preview";
/**
 * Làm gì: Địa chỉ origin mặc định của Grok Gate service chạy cục bộ trong môi trường workspace preview.
 * Được gọi ở: src/server/auth/gate-identity.server.ts (hàm resolveGateEndpoints), test runner (node --test trong src/server/auth/gate-identity.test.ts).
 */
export const PREVIEW_GATE_ORIGIN = "http://127.0.0.1:6014";
const FALLBACK_EMAIL_DOMAIN = "viewer.grok.invalid";
const FALLBACK_NAME = "Grok user";

export type GateIdentity = {
  sub: string;
  email: string | null;
  name: string | null;
  teamId: string | null;
};

export type GateJwks = { keys: JWK[] };

export type JwksFetch = (url: string) => Promise<GateJwks | null>;

/**
 * Làm gì: Kiểm tra tính năng xác thực danh tính qua Grok Gate có được kích hoạt hay không dựa trên biến môi trường.
 * Được gọi ở: src/server/auth/gate-identity.server.ts (hàm gateIdentityFromHeaders), src/server/auth/gate-session.server.ts (middleware gateIdentitySessions), src/server/auth/verify.server.ts (hàm verifySession, requireUserId), test runner (node --test trong src/server/auth/gate-identity.test.ts).
 * @returns True nếu VITE_AUTH_ENABLED khác "false" (mặc định bật), ngược lại trả về false.
 */
export function gateIdentityEnabled(): boolean {
  return env("VITE_AUTH_ENABLED") !== "false";
}

/**
 * Làm gì: Xác định giá trị audience (aud) hợp lệ của JWT token tùy theo ứng dụng đang chạy trong môi trường preview hay production.
 * Được gọi ở: src/server/auth/gate-identity.server.ts (hàm gateIdentityFromHeaders), test runner (node --test trong src/server/auth/gate-identity.test.ts).
 * @returns Chuỗi audience mong đợi ("preview" cho sandbox preview hoặc "app:<GROK_PROJECT_ID>" cho app đã deploy).
 */
export function gateTokenAudience(): string {
  // Bước 1: Nếu chạy trong môi trường workspace preview, sử dụng audience cố định "preview".
  if (isWorkspacePreview()) return PREVIEW_AUDIENCE;
  // Bước 2: Khi deploy thực tế, audience phải có tiền tố "app:" kèm project ID từ GROK_PROJECT_ID.
  return `app:${env("GROK_PROJECT_ID")}`;
}

/**
 * Làm gì: Gửi HTTP request tải tập khóa công khai JWKS từ endpoint của Gate service để phục vụ kiểm tra chữ ký token.
 * Được gọi ở: src/server/auth/gate-identity.server.ts (làm hàm tải mặc định cho tham số jwksFetch trong gateKeyResolver).
 * @param url Địa chỉ URL endpoint của JWKS.
 * @returns Đối tượng GateJwks chứa mảng các public key, hoặc null nếu tải thất bại hoặc dữ liệu sai định dạng.
 */
async function defaultJwksFetch(url: string): Promise<GateJwks | null> {
  try {
    // Bước 1: Gửi request GET tới endpoint với header nhận JSON, chặn tự động redirect (redirect: manual) để bảo mật.
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "manual",
    });
    // Bước 2: Kiểm tra HTTP status; nếu request thất bại (không phải 2xx) thì trả về null.
    if (!res.ok) return null;
    // Bước 3: Đọc dữ liệu JSON và xác thực định dạng có chứa mảng keys hợp lệ hay không.
    const body = (await res.json()) as GateJwks;
    return Array.isArray(body?.keys) ? body : null;
  } catch {
    return null;
  }
}

const jwksCache = new Map<string, { jwks: GateJwks; fetchedAt: number }>();

/**
 * Làm gì: Tạo hàm giải quyết public key (JWTVerifyGetKey) từ JWKS endpoint, có cơ chế cache bộ nhớ và tự động refresh khi xoay vòng khóa (key rotation).
 * Được gọi ở: src/server/auth/gate-identity.server.ts (hàm gateIdentityFromHeaders), test runner (node --test trong src/server/auth/gate-identity.test.ts).
 * @param url Địa chỉ URL endpoint JWKS để lấy khóa công khai.
 * @param jwksFetch Hàm tùy biến để tải JWKS (mặc định sử dụng defaultJwksFetch).
 * @returns Hàm callback nhận protectedHeader của JWT và trả về khóa công khai EdDSA hợp lệ.
 * @throws Error khi không tìm thấy khóa nào khớp với kid trong token hoặc không đúng loại Ed25519.
 */
export function gateKeyResolver(
  url: string,
  jwksFetch: JwksFetch = defaultJwksFetch,
): JWTVerifyGetKey {
  return async (protectedHeader) => {
    // Bước 1: Trích xuất kid (Key ID) từ header của JWT token và định nghĩa hàm tìm khóa Ed25519 phù hợp.
    const kid =
      typeof protectedHeader.kid === "string" ? protectedHeader.kid : undefined;
    const findKey = (jwks: GateJwks): JWK | undefined =>
      jwks.keys.find(
        (k) =>
          k.kty === "OKP" && k.crv === "Ed25519" && (!kid || k.kid === kid),
      );

    // Bước 2: Kiểm tra cache bộ nhớ; nếu chưa cache hoặc cache đã quá hạn TTL (5 phút), tải mới JWKS từ endpoint.
    let entry = jwksCache.get(url);
    if (!entry || Date.now() - entry.fetchedAt > JWKS_CACHE_TTL_MS) {
      const jwks = await jwksFetch(url);
      if (jwks) {
        entry = { jwks, fetchedAt: Date.now() };
        jwksCache.set(url, entry);
      }
    }

    // Bước 3: Tìm public key trong cache; nếu không thấy khớp kid, tải lại JWKS ngay lập tức để đón key xoay vòng (key rotation).
    let key = entry ? findKey(entry.jwks) : undefined;
    if (!key) {
      const jwks = await jwksFetch(url);
      if (jwks) {
        entry = { jwks, fetchedAt: Date.now() };
        jwksCache.set(url, entry);
        key = findKey(jwks);
      }
    }
    // Bước 4: Ném lỗi nếu không tìm thấy key; nếu có, chuyển đổi JWK sang CryptoKey hỗ trợ thuật toán EdDSA.
    if (!key) {
      throw new Error("no gate identity key matches the token kid");
    }
    return importJWK(key, "EdDSA");
  };
}

export type VerifyGateIdentityTokenOptions = {
  issuer: string;
  audience: string;
  getKey: JWTVerifyGetKey;
};

/**
 * Làm gì: Giải mã và kiểm tra chữ ký số của JWT token bằng thuật toán EdDSA, xác minh issuer, audience, thời hạn và trích xuất payload định danh.
 * Được gọi ở: src/server/auth/gate-identity.server.ts (hàm gateIdentityFromHeaders), test runner (node --test trong src/server/auth/gate-identity.test.ts).
 * @param token Chuỗi JWT token lấy từ header request.
 * @param options Cấu hình xác minh bao gồm issuer, audience và hàm giải quyết khóa getKey.
 * @returns Đối tượng GateIdentity chứa thông tin định danh người dùng, hoặc null nếu token không hợp lệ hoặc đã hết hạn.
 */
export async function verifyGateIdentityToken(
  token: string,
  options: VerifyGateIdentityTokenOptions,
): Promise<GateIdentity | null> {
  try {
    // Bước 1: Xác thực chữ ký số EdDSA, kiểm tra issuer, audience, các claims bắt buộc (sub, iat, exp) và giới hạn tuổi thọ token tối đa 10 phút.
    const { payload } = await jwtVerify(token, options.getKey, {
      algorithms: ["EdDSA"],
      issuer: options.issuer,
      audience: options.audience,
      requiredClaims: ["sub", "iat", "exp"],
      maxTokenAge: "10 minutes",
    });
    // Bước 2: Kiểm tra subject (sub); nếu thiếu hoặc rỗng thì coi như token không hợp lệ.
    const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
    if (!sub) return null;
    // Bước 3: Chuẩn hóa payload thành đối tượng GateIdentity chứa sub, email, name và teamId.
    return {
      sub,
      email: typeof payload.email === "string" ? payload.email : null,
      name: typeof payload.name === "string" ? payload.name : null,
      teamId: typeof payload.team_id === "string" ? payload.team_id : null,
    };
  } catch {
    return null;
  }
}

type GateEndpoints = { issuer: string; jwksUrl: string };

/**
 * Làm gì: Xác định địa chỉ issuer và URL endpoint JWKS tương ứng dựa trên biến môi trường GROK_GATE_ORIGIN, cờ preview workspace hoặc header host/x-forwarded-host.
 * Được gọi ở: src/server/auth/gate-identity.server.ts (hàm gateIdentityFromHeaders), test runner (node --test trong src/server/auth/gate-identity.test.ts).
 * @param headers Headers của HTTP request đến.
 * @returns Đối tượng GateEndpoints chứa issuer và jwksUrl, hoặc null nếu không nhận diện được domain hợp lệ.
 */
export function resolveGateEndpoints(headers: Headers): GateEndpoints | null {
  // Bước 1: Ưu tiên biến môi trường GROK_GATE_ORIGIN nếu được chỉ định tường minh.
  const explicit = env("GROK_GATE_ORIGIN");
  if (explicit) {
    const origin = explicit.replace(/\/+$/, "");
    return { issuer: origin, jwksUrl: `${origin}${GATE_JWKS_PATH}` };
  }

  // Bước 2: Sử dụng origin gate cục bộ nếu đang chạy trong môi trường workspace preview.
  if (isWorkspacePreview()) {
    return {
      issuer: PREVIEW_GATE_ORIGIN,
      jwksUrl: `${PREVIEW_GATE_ORIGIN}${GATE_JWKS_PATH}`,
    };
  }

  // Bước 3: Đọc host từ x-forwarded-host hoặc host header của request để nhận diện domain triển khai.
  const xf = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = (xf || headers.get("host") || "")
    .split(":")[0]
    ?.trim()
    .toLowerCase();
  if (!host) return null;

  // Bước 4: Ánh xạ domain sang URL gate tương ứng (môi trường testing hoặc production grok.me).
  let issuer: string | null = null;
  if (
    host === "app-builder-testing.com" ||
    host.endsWith(".app-builder-testing.com")
  ) {
    issuer = "https://gate.app-builder-testing.com";
  } else if (host === "grok.me" || host.endsWith(".grok.me")) {
    issuer = "https://gate.grok.me";
  }
  if (!issuer) return null;

  // Bước 5: Trả về đối tượng chứa issuer và đường dẫn jwksUrl hoàn chỉnh.
  return { issuer, jwksUrl: `${issuer}${GATE_JWKS_PATH}` };
}

export type GateLinkedAccount = { providerId: string; accountId: string };

/**
 * Làm gì: Kiểm tra phiên đăng nhập hiện tại có gắn đúng với danh tính người dùng Grok Gate (khớp providerId và accountId) hay không.
 * Được gọi ở: src/server/auth/gate-session.server.ts (middleware gateIdentitySessions), test runner (node --test trong src/server/auth/gate-identity.test.ts).
 * @param accounts Danh sách các tài khoản liên kết của user được lưu trong database.
 * @param identitySub Mã định danh subject (sub) lấy từ JWT token của Gate.
 * @param gateProviderId Tên định danh provider của Grok Gate (ví dụ: "grok-gate").
 * @returns True nếu user đã có liên kết khớp với danh tính Gate, ngược lại false.
 */
export function sessionBoundToGateIdentity(
  accounts: readonly GateLinkedAccount[],
  identitySub: string,
  gateProviderId: string,
): boolean {
  return accounts.some(
    (account) =>
      account.providerId === gateProviderId &&
      account.accountId === identitySub,
  );
}

/**
 * Làm gì: Trích xuất và xác thực token JWT định danh từ header x-grok-identity của request, kết hợp giải quyết endpoint và khóa JWKS để trả về GateIdentity.
 * Được gọi ở: src/server/auth/gate-session.server.ts (middleware gateIdentitySessions), test runner (node --test trong src/server/auth/gate-identity.test.ts).
 * @param headers Headers của HTTP request cần xác thực.
 * @param jwksFetch Hàm tùy chọn để tải JWKS (thường dùng để inject mock trong unit test).
 * @returns Đối tượng GateIdentity hợp lệ của người dùng, hoặc null nếu auth tắt, thiếu token hoặc xác thực thất bại.
 */
export async function gateIdentityFromHeaders(
  headers: Headers,
  jwksFetch?: JwksFetch,
): Promise<GateIdentity | null> {
  // Bước 1: Kiểm tra tính năng xác thực gate identity có được bật hay không; nếu tắt thì bỏ qua.
  if (!gateIdentityEnabled()) return null;
  // Bước 2: Đọc và cắt khoảng trắng thừa của token JWT từ header x-grok-identity.
  const token = headers.get(GATE_IDENTITY_HEADER)?.trim();
  if (!token) return null;
  // Bước 3: Xác định các endpoint issuer và jwksUrl phù hợp từ headers của request.
  const endpoints = resolveGateEndpoints(headers);
  if (!endpoints) return null;
  // Bước 4: Kiểm tra chữ ký số và giải mã token để lấy thông tin GateIdentity hoàn chỉnh.
  return verifyGateIdentityToken(token, {
    issuer: endpoints.issuer,
    audience: gateTokenAudience(),
    getKey: gateKeyResolver(endpoints.jwksUrl, jwksFetch),
  });
}

export type GateUserInfo = {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
};

/**
 * Làm gì: Chuyển đổi dữ liệu GateIdentity thành cấu trúc GateUserInfo chuẩn để truyền vào Better Auth tạo hoặc cập nhật tài khoản người dùng.
 * Được gọi ở: src/server/auth/gate-session.server.ts (middleware gateIdentitySessions), test runner (node --test trong src/server/auth/gate-identity.test.ts).
 * @param identity Đối tượng GateIdentity đã được xác minh chữ ký từ token.
 * @returns Đối tượng GateUserInfo chứa id, email, emailVerified và name sẵn sàng cho Better Auth.
 */
export function gateIdentityUserInfo(identity: GateIdentity): GateUserInfo {
  // Chuẩn hóa thông tin: email chuyển về chữ thường (dùng email dự phòng @viewer.grok.invalid nếu thiếu) và đặt tên mặc định nếu rỗng.
  return {
    id: identity.sub,
    email: (
      identity.email ?? `${identity.sub}@${FALLBACK_EMAIL_DOMAIN}`
    ).toLowerCase(),
    emailVerified: Boolean(identity.email),
    name: identity.name ?? FALLBACK_NAME,
  };
}
