/**
 * File: src/client/auth/client.ts
 * Vai trò: Khởi tạo Better Auth client phía trình duyệt và điều phối xác thực người dùng cho React SPA.
 * Vị trí trong app: Giao tiếp với API xác thực (/api/auth/*), quản lý đăng nhập OAuth (Google, X), lưu trữ bearer token trong iframe preview và đồng bộ quy trình đăng xuất an toàn.
 */
import { genericOAuthClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { runPreSignInSignOut, runSignOut } from "../../../scripts/sign-out-plan.mjs";
import { GROK_PROVIDERS } from "../../shared/auth/providers";

/**
 * Better Auth client for this React SPA (browser-side).
 *
 * Talks to this app's OWN Better Auth at same-origin `/api/auth/*`. In the live
 * preview the app is an embedded iframe with PARTITIONED cookies, so after a
 * popup sign-in it can't read the session cookie — it authenticates with a
 * bearer token instead (captured from the popup, see `signIn`). The `onRequest`
 * hook attaches that token when present; when deployed (cookie auth) no token
 * is stored, so nothing changes.
 *
 * To sign out call `signOut()` below, NOT `authClient.signOut()`: the raw call
 * leaves the bearer token in place, and `onRequest` keeps re-attaching it, so
 * the visitor stays signed in.
 */
/**
 * Làm gì: Khởi tạo client Better Auth cho React SPA; cấu hình plugin genericOAuthClient và hook onRequest để tự động gắn bearer token khi chạy trong iframe Live Preview.
 * Được gọi ở: src/client/auth/client.ts (hàm signIn, signOut), src/client/auth/use-current-user.ts (authClient.useSession).
 */
export const authClient = createAuthClient({
  plugins: [genericOAuthClient()],
  fetchOptions: {
    onRequest(ctx) {
      // Gắn bearer token vào header Authorization nếu có (đảm bảo xác thực trong iframe preview khi cookie bị partitioned).
      const token = getBearerToken();
      if (token) ctx.headers.set("Authorization", `Bearer ${token}`);
      return ctx;
    },
  },
});

/**
 * True when sign-in UI should be shown — i.e. whenever `VITE_AUTH_ENABLED` is
 * not `"false"`. The shipped template sets it to `"false"`
 * (`.grok/app-env.json`), which selects the dev user (see `use-current-user`);
 * with the key removed, sign-in is real in preview (baked preview client) and
 * when deployed (injected per-app client).
 */
/**
 * Làm gì: Cờ boolean xác định chức năng xác thực có được kích hoạt hay không dựa trên biến môi trường VITE_AUTH_ENABLED; nếu false sẽ dùng dev user mặc định.
 * Được gọi ở: src/client/auth/gates.tsx (component UserButton), src/client/auth/use-current-user.ts (hàm useCurrentUserState).
 */
export const authEnabled = import.meta.env.VITE_AUTH_ENABLED !== "false";

/** The upstream providers to render sign-in buttons for. */
/**
 * Làm gì: Re-export danh sách các nhà cung cấp xác thực OAuth (Google, X...) để giao diện hiển thị các nút đăng nhập tương ứng.
 * Được gọi ở: src/client/auth/gates.tsx (component SignInButtons).
 */
export { GROK_PROVIDERS };

// ── Live-preview bearer token ────────────────────────────────────────────────
// The embedded preview iframe has partitioned cookies, so we keep the session's
// bearer token in sessionStorage and attach it to every Better Auth request (and
// to server functions, via `@/server/auth/middleware`). Empty everywhere except the
// preview after a popup sign-in, so the cookie path is untouched elsewhere.
const BEARER_KEY = "grok-auth.bearer-token";

/** The stored preview bearer token, or null. */
/**
 * Làm gì: Đọc bearer token của phiên đăng nhập trong Live Preview từ sessionStorage; trả về null nếu chạy ở phía server hoặc storage bị chặn.
 * Được gọi ở: src/client/auth/client.ts (hook onRequest, hàm signIn, signOut), src/server/auth/middleware.ts (client authMiddleware).
 * @returns Chuỗi bearer token nếu tồn tại trong sessionStorage, ngược lại null.
 */
export function getBearerToken(): string | null {
  // Bỏ qua nếu đang chạy ở môi trường server (SSR/build).
  if (typeof window === "undefined") return null;
  try {
    // Đọc token từ sessionStorage; bắt try/catch để tránh crash khi trình duyệt chặn quyền truy cập storage.
    return window.sessionStorage.getItem(BEARER_KEY);
  } catch {
    return null;
  }
}

/**
 * Làm gì: Lưu hoặc xóa bearer token trong sessionStorage cho môi trường Live Preview; tự động bỏ qua nếu storage không khả dụng.
 * Được gọi ở: src/client/auth/client.ts (trong hàm signIn khi nhận token mới, hàm signOut khi đăng xuất).
 * @param token Chuỗi bearer token cần lưu, hoặc null nếu muốn xóa token.
 */
function setBearerToken(token: string | null): void {
  // Bỏ qua thao tác nếu đang chạy ở môi trường server.
  if (typeof window === "undefined") return;
  try {
    // Lưu token vào sessionStorage nếu có giá trị; nếu token là null thì xóa bỏ key.
    if (token) window.sessionStorage.setItem(BEARER_KEY, token);
    else window.sessionStorage.removeItem(BEARER_KEY);
  } catch {
    /* storage unavailable — ignore */
  }
}

/**
 * The sandbox live preview runs this app inside an iframe on a `*.grok-sandbox.com`
 * host, where a full-page redirect to the broker can't work — so sign-in uses a
 * popup there and a normal redirect everywhere else.
 */
/**
 * Làm gì: Kiểm tra xem ứng dụng có đang chạy bên trong iframe Live Preview của Grok sandbox (*.grok-sandbox.com) hay không.
 * Được gọi ở: src/client/auth/client.ts (hàm signIn để chọn mở popup, hàm signOut để chọn thời gian timeout).
 * @returns true nếu đang chạy trên host *.grok-sandbox.com ở client, ngược lại false.
 */
function inLivePreview(): boolean {
  // Kiểm tra an toàn: đảm bảo có window và hostname kết thúc bằng .grok-sandbox.com.
  return (
    typeof window !== "undefined" &&
    window.location.hostname.endsWith(".grok-sandbox.com")
  );
}

/** Message the popup posts back to the opener once sign-in completes. */
type PopupMessage = { source: "grok-auth-popup"; token: string | null; error?: string };

/**
 * Start sign-in with one upstream provider (`providerId` from `GROK_PROVIDERS`),
 * federating through the Grok auth broker.
 *
 * - **Live preview** (`*.grok-sandbox.com` iframe): opens a POPUP to
 *   `/auth/popup`, served by the template Vite plugin (see `vite.config.ts` +
 *   `popup.server.ts`) — 302s to the broker/upstream login (no app chrome) and,
 *   on return, posts the session bearer token back. We store it and refresh the
 *   session; no top-level navigation of the iframe to the broker.
 * - **Deployed** (and local non-iframe): a normal full-page redirect into the broker.
 *
 * Either way it clears any existing local session FIRST so switching providers
 * actually switches identity.
 */
/**
 * Làm gì: Khởi tạo quy trình đăng nhập OAuth với một nhà cung cấp; mở popup trong Live Preview hoặc chuyển hướng toàn trang khi đã deploy; luôn dọn dẹp phiên cũ trước.
 * Được gọi ở: src/client/auth/gates.tsx (sự kiện onClick trong component SignInButtons).
 * @param providerId Mã định danh nhà cung cấp OAuth (như "grok-google", "grok-x").
 * @param opts Tùy chọn callbackURL và errorCallbackURL (mặc định là "/").
 * @returns Promise<void> Hoàn tất khi nhận được token hoặc đã bắt đầu chuyển hướng.
 * @throws Error Khi popup bị chặn bởi trình duyệt, đăng nhập bị hủy hoặc OAuth server báo lỗi.
 */
export async function signIn(
  providerId: string,
  opts: { callbackURL?: string; errorCallbackURL?: string } = {},
): Promise<void> {
  const callbackURL = opts.callbackURL ?? "/";
  const errorCallbackURL = opts.errorCallbackURL ?? "/";

  // Open the popup SYNCHRONOUSLY on the user gesture — before any await
  // (including signOut). Awaiting first drops user-gesture privilege in some
  // browsers when the opener is a cross-origin live-preview iframe.
  // Bước 1: Mở popup đồng bộ ngay trong user gesture (trước bất kỳ await nào) để tránh bị trình duyệt chặn popup trong iframe.
  const popup = inLivePreview() ? openSignInPopup(providerId) : null;

  // Clear any prior session so switching providers actually switches identity.
  // Bounded because the popup is already open — a request that never settles
  // would leave it hanging — but bounded PER ENVIRONMENT: only the server can
  // end a deployed session, so cutting it short at the preview's 1.5s would
  // start OAuth with the old session still live.
  // Bước 2: Dọn dẹp phiên đăng nhập cũ (nếu có) trước khi bắt đầu phiên mới để chuyển đổi tài khoản sạch sẽ.
  await runPreSignInSignOut({
    livePreview: inLivePreview(),
    hasBearer: Boolean(getBearerToken()),
    requestSignOut: () => authClient.signOut(),
    clearToken: () => setBearerToken(null),
  });

  // Bước 3: Phân nhánh môi trường: trong Live Preview xử lý qua popup nhận token bằng postMessage.
  if (inLivePreview()) {
    if (!popup) throw new Error("Pop-up blocked — allow pop-ups for sign-in");
    // Chờ popup hoàn tất xác thực và trả về bearer token qua postMessage.
    const token = await waitForPopupToken(popup);
    if (!token) throw new Error("Sign-in was cancelled or failed");
    // Bước 4: Lưu bearer token vừa nhận được vào sessionStorage.
    setBearerToken(token);
    // Refresh the client session store with the bearer attached (onRequest).
    // Avoid a full iframe reload when we're already on the destination — that
    // reload was the slow "still loading after the popup closed" feeling.
    // Bước 5: Cập nhật lại session store của client với token mới mà không cần reload lại toàn bộ iframe.
    try {
      await authClient.getSession();
    } catch {
      /* session store will recover on next useSession fetch */
    }
    // Điều hướng về URL đích (callbackURL) nếu khác với URL của trang hiện tại.
    if (typeof window !== "undefined") {
      const dest = new URL(callbackURL, window.location.origin);
      const here = window.location;
      if (dest.origin !== here.origin || dest.pathname !== here.pathname || dest.search !== here.search) {
        window.location.href = callbackURL;
      }
    }
    return;
  }

  // Bước 6: Xử lý khi đã deploy (hoặc ngoài iframe): chuyển hướng toàn trang đến Better Auth OAuth.
  const { data, error } = await authClient.signIn.oauth2({
    providerId,
    callbackURL,
    errorCallbackURL,
  });
  if (error) throw new Error(error.message ?? "Sign-in failed");
  // Chuyển hướng trình duyệt tới URL xác thực do OAuth provider trả về.
  if (data?.url) window.location.href = data.url;
}

/**
 * Open `/auth/popup` in a new window. Must run synchronously inside the click
 * handler (no await before this). The path is served by the template Vite
 * plugin (`authPopupPlugin` in vite.config.ts) — NOT by a React route.
 *
 * Opens the real URL directly (not about:blank → assign). From a cross-origin
 * iframe the about:blank dance often fails on the first click and the window
 * ends up showing the app shell.
 */
/**
 * Làm gì: Mở cửa sổ popup đồng bộ tới endpoint /auth/popup để phục vụ luồng đăng nhập OAuth trong môi trường Live Preview.
 * Được gọi ở: src/client/auth/client.ts (hàm signIn).
 * @param providerId Mã định danh nhà cung cấp OAuth cần xác thực.
 * @returns Đối tượng Window của popup vừa mở, hoặc null nếu bị trình duyệt chặn.
 */
function openSignInPopup(providerId: string): Window | null {
  // Bước 1: Tạo URL đầy đủ trỏ tới endpoint /auth/popup do plugin Vite phục vụ kèm providerId.
  const origin = window.location.origin;
  const url = `${origin}/auth/popup?providerId=${encodeURIComponent(providerId)}`;
  // Unique name per attempt so a prior attempt stuck on the SPA is not reused.
  // Bước 2: Đặt tên cửa sổ popup kèm timestamp duy nhất để tránh dùng lại cửa sổ cũ bị treo.
  const name = `grok-signin-${Date.now()}`;
  // Bước 3: Mở cửa sổ popup với kích thước chuẩn 500x650 tối ưu cho màn hình đăng nhập OAuth.
  return window.open(url, name, "popup,width=500,height=650");
}

/**
 * Wait for the popup's completion page to postMessage the session bearer (or
 * for the user to dismiss the popup).
 */
/**
 * Làm gì: Lắng nghe sự kiện postMessage từ popup để nhận bearer token sau khi đăng nhập thành công, hoặc trả về null nếu người dùng đóng popup.
 * Được gọi ở: src/client/auth/client.ts (hàm signIn).
 * @param popup Đối tượng Window của cửa sổ popup đang xử lý đăng nhập.
 * @returns Promise giải quyết thành chuỗi bearer token nếu thành công, hoặc null nếu popup bị đóng/hủy.
 */
function waitForPopupToken(popup: Window): Promise<string | null> {
  return new Promise((resolve) => {
    const origin = window.location.origin;
    let settled = false;
    let closeTimer: number | undefined;
    // Bước 1: Định nghĩa hàm settle để giải quyết Promise một lần duy nhất và dọn dẹp listener/timer.
    const settle = (token: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(token);
    };
    // Bước 2: Lắng nghe postMessage từ popup; xác thực đúng origin và cấu trúc grok-auth-popup.
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      const data = event.data as PopupMessage | undefined;
      if (!data || data.source !== "grok-auth-popup") return;
      settle(data.token ?? null);
    };
    // Fallback when the user dismisses the popup. Grace period lets the
    // completion page's postMessage win over a racing `popup.closed`.
    // Bước 3: Định kỳ kiểm tra (300ms) nếu popup bị đóng; chờ thêm 400ms grace period để nhận token nếu popup đóng sát nút.
    const pollTimer = window.setInterval(() => {
      if (!popup.closed) return;
      window.clearInterval(pollTimer);
      closeTimer = window.setTimeout(() => settle(null), 400);
    }, 300);
    // Bước 4: Dọn dẹp tài nguyên: xóa timer và gỡ bỏ event listener khi hoàn tất.
    function cleanup() {
      window.clearInterval(pollTimer);
      if (closeTimer !== undefined) window.clearTimeout(closeTimer);
      window.removeEventListener("message", onMessage);
    }
    // Đăng ký nhận thông điệp message từ cửa sổ popup.
    window.addEventListener("message", onMessage);
  });
}

/**
 * Sign out of THIS app's local session, clear the preview token, then redirect.
 *
 * Use this, never `authClient.signOut()` — see the note on `authClient`.
 * Sequencing lives in `scripts/sign-out-plan.mjs` so it can be unit-tested.
 *
 * **Rejects when deployed if the server never confirms.** There the session is
 * an HttpOnly cookie only the server can clear, so redirecting anyway would
 * report a sign-out that did not happen. `<UserButton />` handles that for you;
 * a hand-rolled control must catch it and let the visitor retry. In the live
 * preview the local clear is sufficient, so it always resolves.
 */
/**
 * Làm gì: Thực hiện đăng xuất khỏi phiên làm việc hiện tại, xóa bearer token cục bộ và chuyển hướng trang; ủy quyền điều phối cho runSignOut.
 * Được gọi ở: src/client/auth/gates.tsx (component UserButton).
 * @param redirectTo Đường dẫn chuyển hướng sau khi đăng xuất hoàn tất (mặc định là "/").
 * @returns Promise<void> Hoàn tất quy trình hủy phiên và chuyển hướng.
 * @throws Error Khi ở môi trường deployed mà server báo lỗi hoặc timeout (phiên đăng nhập vẫn còn hiệu lực).
 */
export async function signOut(redirectTo = "/"): Promise<void> {
  // Bước 1: Chuyển quyền điều phối cho runSignOut xử lý theo từng môi trường.
  await runSignOut({
    livePreview: inLivePreview(),
    hasBearer: Boolean(getBearerToken()),
    // Better Auth resolves with `{ error }` instead of rejecting, so surface a
    // failed response as a rejection for the sequence to act on.
    // Better Auth trả về { error } thay vì reject Promise, nên chủ động ném Error để runSignOut bắt được lỗi.
    requestSignOut: async () => {
      const { error } = await authClient.signOut();
      if (error) throw new Error(error.message ?? "Sign-out failed");
    },
    // Bước 2: Xóa bearer token trong sessionStorage.
    clearToken: () => setBearerToken(null),
    // Bước 3: Chuyển hướng trình duyệt về trang đích redirectTo sau khi đăng xuất xong.
    redirect: () => {
      window.location.href = redirectTo;
    },
  });
}
