/**
 * Live-preview sign-in popup — server-only (NEVER import from the client).
 *
 * The sandbox preview runs the app in a partitioned iframe, so OAuth must happen
 * in a top-level popup (first-party cookies). This handler is the ENTIRE popup
 * document — no React shell:
 *
 *   Phase 1 (`?providerId=…`): start OAuth server-side and 302 straight to the
 *     broker / upstream login page. The popup never paints the app.
 *   Phase 2 (`?done=1`): after the broker round-trip, emit a tiny HTML page that
 *     posts the session token to the opener and closes. No SPA hydrate, no
 *     server-fn round-trip.
 *
 * Wired automatically by the Vite `authPopupPlugin` in `vite.config.ts` during
 * `npm run dev` (live preview). Do NOT create `src/routes/auth/popup.tsx` — a
 * React route here paints the full app shell in the popup. The opener lives in
 * `client.ts` (`signIn` → `openSignInPopup`).
 */
import { auth, SESSION_TOKEN_COOKIE } from "./server";

/** Message shape the popup posts to the opener (must match `client.ts`). */
type PopupMessage = {
  source: "grok-auth-popup";
  token: string | null;
  error?: string;
};

/**
 * Handle `GET /auth/popup`. Invoked by the Vite `authPopupPlugin` (dev / live
 * preview). Do not re-export this from a React route file.
 */
/**
 * Làm gì: Xử lý HTTP request GET /auth/popup để điều phối luồng đăng nhập OAuth trong môi trường Live Preview. Điều phối 2 giai đoạn: Phase 1 khởi tạo OAuth rồi chuyển hướng 302 đến broker, hoặc Phase 2 trả về trang HTML hoàn tất để gửi session token về cửa sổ cha qua postMessage.
 * Được gọi ở: vite.config.ts (middleware authPopupPlugin khi chạy npm run dev / preview).
 * @param request Đối tượng Request HTTP gửi tới endpoint /auth/popup.
 * @returns Promise giải quyết thành Response HTTP (chuyển hướng 302 đến broker, trả về HTML 200, hoặc mã lỗi 400).
 */
export async function handleAuthPopupRequest(request: Request): Promise<Response> {
  // Bước 1: Trích xuất thông tin URL từ request và kiểm tra tham số "done" để xác định giai đoạn xử lý OAuth.
  const url = new URL(request.url);
  const done = url.searchParams.get("done") === "1";

  // Bước 2: Xử lý Phase 2 (khi done=1) sau khi broker chuyển hướng quay lại popup. Đọc session token từ cookie hoặc bắt lỗi để đóng gói thành PopupMessage.
  if (done) {
    const errored = url.searchParams.has("error");
    // Đọc session token từ cookie của popup (first-party) để gửi sang iframe preview (vốn bị hạn chế do partitioned cookies).
    const token = errored ? null : readCookie(request, SESSION_TOKEN_COOKIE);
    const message: PopupMessage = {
      source: "grok-auth-popup",
      token,
      ...(errored ? { error: url.searchParams.get("error") ?? "sign_in_failed" } : {}),
    };
    return new Response(completionHtml(message), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Never cache a page that embeds a session token.
        "cache-control": "no-store",
      },
    });
  }

  // Bước 3: Xử lý Phase 1 - Bắt đầu luồng OAuth. Lấy mã nhà cung cấp (providerId) và kiểm tra tính hợp lệ; trả về 400 nếu thiếu.
  const providerId = url.searchParams.get("providerId")?.trim();
  if (!providerId) {
    return new Response("Missing providerId", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Stay first-party for the callback so the session cookie lands in THIS popup.
  const back = `${url.origin}/auth/popup?done=1`;
  // Bước 4: Gọi API signInWithOAuth2 của Better Auth để lấy URL đăng nhập của broker, đặt callback quay lại chính popup này kèm tham số done=1.
  try {
    const apiRes = await auth.api.signInWithOAuth2({
      body: {
        providerId,
        callbackURL: back,
        errorCallbackURL: `${back}&error=1`,
      },
      // Forward the preview host so Better Auth derives the correct baseURL /
      // redirect_uri for the dynamic `*.grok-sandbox.com` origin.
      headers: request.headers,
      asResponse: true,
    });

    // Bước 5: Kiểm tra kết quả phản hồi từ Better Auth; nếu thất bại hoặc thiếu URL chuyển hướng, trả về trang HTML báo lỗi cho cửa sổ cha.
    if (!apiRes.ok) {
      const detail = await apiRes.text().catch(() => "");
      return completionResponse({
        source: "grok-auth-popup",
        token: null,
        error: detail || `oauth_init_failed_${apiRes.status}`,
      });
    }

    const body = (await apiRes.json().catch(() => null)) as {
      url?: string;
    } | null;
    const location = body?.url;
    if (!location) {
      return completionResponse({
        source: "grok-auth-popup",
        token: null,
        error: "oauth_init_missing_url",
      });
    }

    // 302 to the broker (which headlessly forwards to Google/X). Forward any
    // Set-Cookie (OAuth state / PKCE) so the callback can complete in this popup.
    // Bước 6: Chuyển hướng 302 tới broker đăng nhập, đồng thời chuyển tiếp các header Set-Cookie (chứa state và PKCE) để popup lưu lại.
    const headers = new Headers({ location, "cache-control": "no-store" });
    for (const cookie of apiRes.headers.getSetCookie()) {
      headers.append("set-cookie", cookie);
    }
    return new Response(null, { status: 302, headers });
  } catch (err) {
    // Bắt ngoại lệ nếu quá trình khởi tạo OAuth phát sinh lỗi và gửi thông báo lỗi về cửa sổ cha.
    const message = err instanceof Error ? err.message : "oauth_init_threw";
    return completionResponse({
      source: "grok-auth-popup",
      token: null,
      error: message,
    });
  }
}

/**
 * Làm gì: Tạo HTTP Response với mã trạng thái 200 chứa nội dung HTML hoàn tất xác thực, thiết lập header no-store để không lưu cache trang chứa token.
 * Được gọi ở: src/server/auth/popup.server.ts (trong hàm handleAuthPopupRequest khi cần trả về trang HTML hoàn tất hoặc báo lỗi).
 * @param message Dữ liệu PopupMessage chứa session token hoặc thông báo lỗi cần gửi về client.
 * @returns Đối tượng Response HTTP hoàn chỉnh với Content-Type là text/html.
 */
function completionResponse(message: PopupMessage): Response {
  return new Response(completionHtml(message), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** Minimal HTML: postMessage the token to the opener and close. No React. */
/**
 * Làm gì: Sinh mã HTML tĩnh gọn nhẹ không chứa React shell, dùng script nội tuyến để gửi thông điệp PopupMessage tới window.opener qua postMessage rồi tự đóng popup.
 * Được gọi ở: src/server/auth/popup.server.ts (trong hàm handleAuthPopupRequest và completionResponse).
 * @param message Đối tượng PopupMessage chứa token hoặc thông tin lỗi cần gửi tới cửa sổ cha.
 * @returns Chuỗi HTML tĩnh hoàn chỉnh của trang hoàn tất xác thực.
 */
function completionHtml(message: PopupMessage): string {
  // JSON is safe inside a <script type="application/json"> block; the inline
  // script only reads it. Avoids escaping pitfalls of embedding in JS source.
  // Bước 1: Chuyển message thành chuỗi JSON và escape ký tự "<" thành dạng unicode để chống tấn công XSS và tránh đóng sớm thẻ script.
  const payload = JSON.stringify(message).replace(/</g, "\\u003c");
  // Bước 2: Trả về chuỗi HTML chứa inline script tự động gửi postMessage tới window.opener và đóng cửa sổ popup.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Signing in…</title>
<style>
  html,body{margin:0;min-height:100%;background:#0b0b0c;color:#a1a1aa;
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  main{min-height:100vh;display:grid;place-items:center;padding:1.5rem;text-align:center}
</style>
</head>
<body>
<main><p>Signing you in…</p></main>
<script type="application/json" id="grok-auth-popup-msg">${payload}</script>
<script>
(function () {
  var el = document.getElementById("grok-auth-popup-msg");
  var msg = { source: "grok-auth-popup", token: null };
  try { if (el && el.textContent) msg = JSON.parse(el.textContent); } catch (e) {}
  try {
    if (window.opener) window.opener.postMessage(msg, window.location.origin);
  } catch (e) {}
  try { window.close(); } catch (e) {}
})();
</script>
</body>
</html>`;
}

/** Read a single cookie value from the request (handles `=` inside values). */
/**
 * Làm gì: Đọc và giải mã giá trị của một cookie cụ thể từ header cookie của request, hỗ trợ giá trị có chứa ký tự dấu bằng (=).
 * Được gọi ở: src/server/auth/popup.server.ts (trong hàm handleAuthPopupRequest để lấy giá trị SESSION_TOKEN_COOKIE).
 * @param request Đối tượng Request HTTP chứa cookie header cần đọc.
 * @param name Tên cookie cần tìm.
 * @returns Chuỗi giá trị cookie đã giải mã URL, hoặc null nếu không tìm thấy.
 */
function readCookie(request: Request, name: string): string | null {
  // Bước 1: Lấy header cookie từ request; nếu không có thì trả về null ngay.
  const header = request.headers.get("cookie");
  if (!header) return null;
  // Bước 2: Tách chuỗi cookie thành các cặp name=value, tìm cặp có tên trùng khớp với tham số name.
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    // Bước 3: Lấy giá trị sau dấu "=" đầu tiên và giải mã decodeURIComponent; nếu lỗi giải mã thì giữ nguyên chuỗi thô.
    const raw = trimmed.slice(eq + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}
