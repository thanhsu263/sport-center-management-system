/**
 * File này cung cấp plugin Better Auth (gateIdentitySessions) để quản lý phiên đăng nhập tự động (zero-click auth).
 * Khi người dùng mở app qua Grok Gate viewer, file này đọc header x-grok-identity, xác thực và phát hành session cookie tương thích với TanStack Start.
 */
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import {
  parseSetCookieHeader,
  setRequestCookie,
  setSessionCookie,
} from "better-auth/cookies";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import {
  GATE_IDENTITY_HEADER,
  gateIdentityEnabled,
  gateIdentityFromHeaders,
  gateIdentityUserInfo,
  sessionBoundToGateIdentity,
} from "./gate-identity.server.ts";
import { GATE_SESSION_MARKER_COOKIE } from "../../shared/auth/gate-session-marker";

/**
 * Làm gì: Định danh provider OAuth nội bộ đại diện cho Grok Gate identity trong Better Auth.
 * Được gọi ở: src/server/auth/server.ts (cấu hình trustedProviders) và gate-session.server.ts (liên kết account).
 */
export const GATE_PROVIDER_ID = "grok-gate";
const GATE_ACCOUNT_ISSUER = "https://grok.com";
const LOG = "[gate-identity]";

type GateAccount = Parameters<typeof handleOAuthUserInfo>[1]["account"];

/**
 * Emit the signed session cookie so the browser actually receives it.
 *
 * `setSessionCookie` writes into the Better Auth middleware header bag, but on
 * TanStack Start that bag is not always copied onto the final HTTP response
 * (the response can end up with no `Set-Cookie`). Sign the token ourselves and
 * push it through TanStack's `setCookie` + `responseHeaders` so both the
 * framework cookie store and any after-hooks see it.
 */
async function emitSessionCookie(
  ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
  sessionTokenName: string,
  sessionToken: string,
): Promise<string | null> {
  // Bước 1: Chuẩn bị tùy chọn cookie và ký session token bằng secret của Better Auth.
  const attributes = ctx.context.authCookies.sessionToken.attributes;
  const maxAge = ctx.context.sessionConfig.expiresIn;
  const cookieOptions = {
    ...attributes,
    maxAge,
  };

  let signedCookie: string;
  try {
    signedCookie = await ctx.setSignedCookie(
      sessionTokenName,
      sessionToken,
      ctx.context.secret,
      cookieOptions,
    );
  } catch (err) {
    console.error(`${LOG} setSignedCookie failed`, err);
    return null;
  }

  // Bước 2: Bóc tách giá trị session token đã ký từ chuỗi header Set-Cookie trả về.
  const sessionValue = parseSetCookieHeader(signedCookie).get(
    sessionTokenName,
  )?.value;
  if (!sessionValue) {
    console.error(`${LOG} signed Set-Cookie missing session token value`, {
      cookiePreview: signedCookie.slice(0, 120),
    });
    return null;
  }

  // Bước 3: Đưa cookie vào store của TanStack Start để trình duyệt thực sự nhận được Set-Cookie.
  // Primary path: TanStack Start's response cookie store (reaches the browser).
  try {
    const { setCookie } = await import("@tanstack/react-start/server");
    setCookie(sessionTokenName, sessionValue, {
      path: cookieOptions.path ?? "/",
      httpOnly: cookieOptions.httpOnly ?? true,
      secure: cookieOptions.secure ?? true,
      sameSite: (cookieOptions.sameSite as "lax" | "strict" | "none") ?? "lax",
      maxAge: typeof maxAge === "number" ? maxAge : undefined,
      domain: cookieOptions.domain,
    });
  } catch (err) {
    console.error(`${LOG} TanStack setCookie failed`, err);
  }

  // Bước 4: Lưu đồng thời vào responseHeaders của Better Auth để các after-hook có thể chuyển tiếp tiếp.
  // Also stash on Better Auth responseHeaders so after-hooks (tanstackStartCookies)
  // can forward it if they run.
  try {
    const responseHeaders = ctx.context.responseHeaders;
    if (responseHeaders) {
      responseHeaders.append("set-cookie", signedCookie);
    } else {
      console.error(`${LOG} ctx.context.responseHeaders is missing`);
    }
  } catch (err) {
    console.error(`${LOG} responseHeaders.append(set-cookie) failed`, err);
  }

  // Trả về token đã ký để caller có thể inject ngay vào header của request hiện tại.
  return sessionValue;
}

/**
 * Expire the previous user's `session_data` cookie cache after an identity
 * swap. The cache is signed against the old session and outlives it (5-min
 * TTL), so without this `/get-session` keeps serving the replaced user.
 * Mirrors `emitSessionCookie`'s dual-path delivery: TanStack's response
 * cookie store plus Better Auth's `responseHeaders` bag.
 */
async function expireSessionDataCookie(
  ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
  cookie: { name: string; attributes: { path?: string; secure?: boolean } },
): Promise<void> {
  // Bước 1: Xóa cookie session_data trên TanStack Start bằng cách đặt Max-Age=0.
  const path = cookie.attributes.path ?? "/";
  const secure = cookie.attributes.secure ?? true;
  try {
    const { setCookie } = await import("@tanstack/react-start/server");
    setCookie(cookie.name, "", {
      path,
      httpOnly: true,
      secure,
      sameSite: "lax",
      maxAge: 0,
    });
  } catch (err) {
    console.error(`${LOG} TanStack setCookie (expire session_data) failed`, err);
  }
  // Bước 2: Ghi thêm Set-Cookie Max-Age=0 vào responseHeaders của Better Auth để xóa triệt để cả hai kênh.
  try {
    ctx.context.responseHeaders?.append(
      "set-cookie",
      `${cookie.name}=; Path=${path}; HttpOnly; ` +
        `${secure ? "Secure; " : ""}SameSite=Lax; Max-Age=0`,
    );
  } catch (err) {
    console.error(
      `${LOG} responseHeaders.append (expire session_data) failed`,
      err,
    );
  }
}

/**
 * Write or clear the client-readable gate-session marker
 * (`gate-session-marker.ts`), through the same dual-path delivery as
 * `emitSessionCookie`. Not HttpOnly by design: `UserButton` reads it to hide
 * sign-out for gate sessions (signing out would re-materialize instantly).
 */
async function writeGateMarkerCookie(
  ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
  clear: boolean,
): Promise<void> {
  // Bước 1: Xác định giá trị và thời hạn (maxAge) của marker cookie (xóa thì maxAge=0, ghi thì theo thời hạn session).
  const sessionMaxAge = ctx.context.sessionConfig.expiresIn;
  const maxAge = clear
    ? 0
    : typeof sessionMaxAge === "number"
      ? sessionMaxAge
      : undefined;
  const value = clear ? "" : "1";
  // Bước 2: Ghi marker qua TanStack Start; httpOnly=false để client (UserButton) có thể đọc và ẩn nút sign-out.
  try {
    const { setCookie } = await import("@tanstack/react-start/server");
    setCookie(GATE_SESSION_MARKER_COOKIE, value, {
      path: "/",
      httpOnly: false,
      secure: true,
      sameSite: "lax",
      maxAge,
    });
  } catch (err) {
    console.error(`${LOG} TanStack setCookie (gate marker) failed`, err);
  }
  // Bước 3: Đồng bộ Set-Cookie marker vào responseHeaders của Better Auth.
  try {
    ctx.context.responseHeaders?.append(
      "set-cookie",
      `${GATE_SESSION_MARKER_COOKIE}=${value}; Path=/; Secure; SameSite=Lax` +
        (maxAge === undefined ? "" : `; Max-Age=${maxAge}`),
    );
  } catch (err) {
    console.error(`${LOG} responseHeaders.append (gate marker) failed`, err);
  }
}

/**
 * Clear a stale marker when a `/get-session` arrives without `x-grok-identity`:
 * the browser is no longer behind a gate viewer (returned anonymously, or the
 * session is a broker one), so sign-out must not stay hidden. Emits the
 * Max-Age=0 clear only when the marker is actually on the request.
 */
async function clearGateMarkerIfPresent(
  ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
  inbound: Headers,
): Promise<void> {
  const cookieHeader = inbound.get("cookie") ?? "";
  if (!cookieHeader.includes(`${GATE_SESSION_MARKER_COOKIE}=`)) return;
  await writeGateMarkerCookie(ctx, true);
}

/** Drop a cookie from the request `Cookie` header (inverse of `setRequestCookie`). */
function removeRequestCookie(headers: Headers, name: string): void {
  const cookieHeader = headers.get("cookie");
  if (!cookieHeader) return;
  const kept = cookieHeader
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair && !pair.startsWith(`${name}=`));
  if (kept.length > 0) {
    headers.set("cookie", kept.join("; "));
  } else {
    headers.delete("cookie");
  }
}

/**
 * Làm gì: Tạo plugin Better Auth chặn bắt route /get-session để tự động đăng nhập hoặc đồng bộ phiên từ Grok Gate identity.
 * Được gọi ở: src/server/auth/server.ts (trong mảng plugins khi cấu hình betterAuth).
 * @returns Đối tượng BetterAuthPlugin chứa before-hook cho endpoint /get-session.
 */
export function gateIdentitySessions() {
  return {
    id: "grok-gate-identity",
    hooks: {
      before: [
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/get-session",
          handler: createAuthMiddleware(async (ctx) => {
            // Bước 1: Kiểm tra cờ bật auth và lấy danh sách inbound headers từ request.
            if (!gateIdentityEnabled()) return;
            const inbound = ctx.request?.headers ?? ctx.headers;
            if (!inbound) {
              console.error(`${LOG} no request headers on /get-session`);
              return;
            }
            // Bearer auth (live-preview popup) already carries a session — leave it alone.
            if (inbound.get("authorization")) return;
            // Bước 2: Nếu thiếu header x-grok-identity, xóa marker cookie cũ nếu có rồi kết thúc xử lý.
            if (!inbound.get(GATE_IDENTITY_HEADER)) {
              await clearGateMarkerIfPresent(ctx, inbound);
              return;
            }

            // Bước 3: Xác thực JWT token trong header x-grok-identity thông qua JWKS của Grok Gate.
            const identity = await gateIdentityFromHeaders(inbound);
            if (!identity) {
              console.error(
                `${LOG} ${GATE_IDENTITY_HEADER} present but verification failed`,
              );
              return;
            }

            // Bước 4: Kiểm tra session hiện tại trong cookie; giữ nguyên nếu đã khớp Gate identity, ngược lại xóa phiên cũ trong DB.
            const sessionCookieName = ctx.context.authCookies.sessionToken.name;
            const cookieHeader = inbound.get("cookie") ?? "";
            if (cookieHeader.includes(`${sessionCookieName}=`)) {
              const existing = await getSessionFromCtx(ctx).catch((err) => {
                console.error(`${LOG} getSessionFromCtx failed`, err);
                return null;
              });
              if (existing?.session && existing.user) {
                const accounts = await ctx.context.internalAdapter
                  .findAccounts(existing.user.id)
                  .catch((err) => {
                    console.error(`${LOG} findAccounts failed`, err);
                    return null;
                  });
                if (!accounts) {
                  console.error(
                    `${LOG} could not load accounts for existing session user`,
                    { userId: existing.user.id },
                  );
                  return;
                }
                // Nếu phiên đã gắn đúng với accountId (identity.sub) của Gate, đảm bảo có marker cookie rồi giữ nguyên phiên.
                if (
                  sessionBoundToGateIdentity(
                    accounts,
                    identity.sub,
                    GATE_PROVIDER_ID,
                  )
                ) {
                  await writeGateMarkerCookie(ctx, false);
                  return;
                }
                // Phiên hiện tại không thuộc Gate identity này (hoặc đổi user), xóa session cũ để cấp phiên mới.
                await ctx.context.internalAdapter
                  .deleteSession(existing.session.token)
                  .catch((err) => {
                    console.error(
                      `${LOG} deleteSession (stale non-gate session) failed`,
                      err,
                    );
                    return null;
                  });
              }
            }

            // Bước 5: Gọi handleOAuthUserInfo để tạo mới hoặc cập nhật user và liên kết tài khoản grok-gate.
            try {
              const result = await handleOAuthUserInfo(ctx, {
                userInfo: gateIdentityUserInfo(identity),
                account: {
                  providerId: GATE_PROVIDER_ID,
                  issuer: GATE_ACCOUNT_ISSUER,
                  accountId: identity.sub,
                } as GateAccount,
              });
              if (result.error || !result.data) {
                console.error(`${LOG} handleOAuthUserInfo failed`, {
                  error: result.error,
                  hasData: Boolean(result.data),
                  sub: identity.sub,
                });
                return;
              }

              // Bước 6: Lưu session vào DB và phát hành session cookie đã ký cho trình duyệt.
              // Persist session rows + internal newSession state.
              await setSessionCookie(ctx, result.data);

              // Explicitly sign the token and emit Set-Cookie — do NOT rely on
              // reading it back from ctx.context.responseHeaders (often empty
              // here, which previously caused a silent signed-out render).
              const sessionValue = await emitSessionCookie(
                ctx,
                sessionCookieName,
                result.data.session.token,
              );
              if (!sessionValue) {
                console.error(
                  `${LOG} session created in DB but cookie was not emitted`,
                  { userId: result.data.user.id },
                );
                return;
              }

              // Bước 7: Ghi marker cookie và xóa cache session_data cũ để tránh phục vụ dữ liệu user trước.
              await writeGateMarkerCookie(ctx, false);

              const sessionDataCookie = ctx.context.authCookies.sessionData;
              await expireSessionDataCookie(ctx, sessionDataCookie);

              // Bước 8: Bơm session cookie mới vào headers của request để /get-session trả về phiên mới ngay trong cùng lượt gọi.
              // Inject the cookie into this request so the rest of /get-session
              // resolves the newly created session in the same round-trip.
              const headers = new Headers(
                Object.fromEntries(inbound.entries()),
              );
              setRequestCookie(headers, sessionCookieName, sessionValue);
              removeRequestCookie(headers, sessionDataCookie.name);
              return { context: { headers } };
            } catch (err) {
              console.error(`${LOG} gate identity session hook threw`, err);
              return;
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
