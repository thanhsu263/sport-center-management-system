// @ts-check
/**
 * The sign-out sequence used by `src/client/auth/client.ts`, kept here as a pure
 * module so its effects can be unit-tested (`node --test` only covers
 * `scripts/`), the same split `migration-plan.mjs` uses for the two appliers.
 *
 * The two environments authenticate differently, so they need different
 * answers to "the server did not reply":
 *
 * - **Live preview** — a partitioned iframe with no readable session cookie;
 *   the session rides the bearer token in `sessionStorage`. Dropping that token
 *   IS being signed out, so the server call is best effort and a wedged request
 *   must never strand the button. This is where the hang actually happens.
 * - **Deployed** — the session rides an HttpOnly `__Host-` cookie that JS
 *   cannot delete. ONLY a completed sign-out response clears it, and
 *   `server.ts` enables `session.cookieCache` (maxAge 300), so `/get-session`
 *   would keep answering from the cached cookie for minutes afterwards.
 *   Redirecting on a timeout would show the visitor "signed out" while their
 *   session is still live — so here we fail loudly instead of pretending.
 */

/**
 * Live preview: aggressive, because the local clear is what signs the user out.
 * The same-origin POST normally answers in tens of ms; lower would start
 * abandoning slow-but-working sign-outs for no gain.
 */
/*
 * Làm gì: Thời gian chờ tối đa (1.500 ms) cho thao tác đăng xuất trong Live Preview; request cùng domain thường chỉ mất vài chục ms và việc xóa token ở client đã đủ để hoàn tất đăng xuất nên đặt timeout ngắn để tránh nút bấm bị treo.
 * Được gọi ở: scripts/sign-out-plan.mjs (hàm signOutTimeoutMs), scripts/sign-out-plan.test.mjs ("test runner (node --test)").
 */
export const PREVIEW_SIGN_OUT_TIMEOUT_MS = 1500;

/**
 * Deployed: generous, because only the server can end this session — but still
 * bounded, so a wedged request reports failure the visitor can retry instead of
 * spinning forever. A sign-out still unanswered at 10s is not going to land.
 */
/*
 * Làm gì: Thời gian chờ tối đa (10.000 ms) cho thao tác đăng xuất khi đã triển khai (deployed production); chỉ server mới có quyền xóa HttpOnly cookie nên cần chờ đủ lâu trước khi báo lỗi cho người dùng thử lại.
 * Được gọi ở: scripts/sign-out-plan.mjs (hàm signOutTimeoutMs), scripts/sign-out-plan.test.mjs ("test runner (node --test)").
 */
export const DEPLOYED_SIGN_OUT_TIMEOUT_MS = 10_000;

/**
 * How long to wait for a sign-out in this environment. Every sign-out network
 * call picks its bound here, so the preview/deployed split cannot drift apart
 * between callers.
 * @param {boolean} livePreview
 * @returns {number}
 */
/*
 * Làm gì: Lấy thời gian chờ tối đa cho thao tác đăng xuất tương ứng với từng môi trường (1.5s cho preview, 10s cho deployed) nhằm đảm bảo tính nhất quán trên toàn hệ thống.
 * Được gọi ở: scripts/sign-out-plan.mjs (hàm runSignOut, runPreSignInSignOut), scripts/sign-out-plan.test.mjs ("test runner (node --test)").
 * - Tham số livePreview: Cờ boolean cho biết ứng dụng có đang chạy trong iframe preview của sandbox hay không.
 * - Trả về: Thời gian timeout tính bằng millisecond (1500 nếu livePreview là true, ngược lại 10000).
 */
export function signOutTimeoutMs(livePreview) {
  // Chọn timeout tương ứng: preview ưu tiên phản hồi nhanh (1.5s), deployed cần chờ server xác nhận xóa HttpOnly cookie (10s).
  return livePreview ? PREVIEW_SIGN_OUT_TIMEOUT_MS : DEPLOYED_SIGN_OUT_TIMEOUT_MS;
}

/**
 * Run `start()` but give up after `timeoutMs`, reporting which happened. Never
 * rejects — callers decide what a failure means, and a `try/catch` around an
 * `await` does nothing for a promise that never settles.
 * @param {() => unknown} start
 * @param {number} timeoutMs
 * @returns {Promise<"ok" | "failed" | "timeout">}
 */
/*
 * Làm gì: Thực thi một hàm bất đồng bộ với thời gian chờ giới hạn, luôn hoàn thành và trả về trạng thái ("ok", "failed", "timeout") mà không bao giờ ném lỗi (reject).
 * Được gọi ở: scripts/sign-out-plan.mjs (hàm runSignOut, runPreSignInSignOut), scripts/sign-out-plan.test.mjs ("test runner (node --test)").
 * - Tham số start: Hàm kích hoạt tác vụ cần thực thi (trả về Promise hoặc giá trị bất kỳ).
 * - Tham số timeoutMs: Thời gian chờ tối đa cho phép tính bằng millisecond.
 * - Trả về: Promise giải quyết thành một trong 3 chuỗi trạng thái: "ok", "failed", hoặc "timeout".
 */
export function settleWithin(start, timeoutMs) {
  return new Promise((resolve) => {
    // Bước 1: Thiết lập timer đếm ngược; nếu hết hạn timeoutMs mà tác vụ chưa hoàn thành thì giải quyết kết quả là "timeout".
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    /** @param {"ok" | "failed"} outcome */
    // Bước 2: Định nghĩa hàm đóng lại: hủy timer để tránh rò rỉ bộ nhớ và giải quyết Promise với kết quả ("ok" hoặc "failed").
    const done = (outcome) => {
      clearTimeout(timer);
      resolve(outcome);
    };
    // Bước 3: Kích hoạt hàm start() và lắng nghe kết quả; dùng Promise.resolve để xử lý đồng nhất cả hàm sync lẫn async.
    try {
      Promise.resolve(start()).then(
        () => done("ok"),
        () => done("failed"),
      );
    } catch {
      // Bắt lỗi đồng bộ phòng trường hợp start() ném exception trực tiếp khi vừa được gọi.
      done("failed");
    }
  });
}

/**
 * @typedef {object} SignOutSteps
 * @property {boolean} livePreview Whether the app is the sandbox preview iframe.
 * @property {boolean} hasBearer Whether a preview bearer token is stored.
 * @property {() => unknown} requestSignOut Ask the server to end the session; must reject on a failed response.
 * @property {() => void} clearToken Drop the stored bearer token.
 * @property {() => void} redirect Leave the page.
 * @property {number} [timeoutMs]
 */

/**
 * End the session, then clear the local token and redirect.
 *
 * In the live preview those last two always run. When deployed they run only if
 * the server confirmed, because nothing else can clear the cookie — a failed or
 * timed-out sign-out throws rather than reporting a sign-out that did not
 * happen.
 * @param {SignOutSteps} steps
 * @returns {Promise<void>}
 */
/*
 * Làm gì: Thực hiện toàn bộ quy trình đăng xuất: yêu cầu server hủy phiên, xóa bearer token cục bộ và chuyển hướng trang; tự động phân nhánh xử lý an toàn giữa preview và deployed.
 * Được gọi ở: src/client/auth/client.ts (hàm signOut), scripts/sign-out-plan.test.mjs ("test runner (node --test)").
 * - Tham số steps: Đối tượng chứa các tham số và hàm callback (livePreview, hasBearer, requestSignOut, clearToken, redirect, timeoutMs).
 * - Trả về: Promise không trả về giá trị (void) khi hoàn tất đăng xuất.
 * - Lỗi có thể ném: Error Khi ở môi trường deployed mà server phản hồi thất bại hoặc timeout (phiên đăng nhập vẫn còn tồn tại).
 */
export async function runSignOut({
  livePreview,
  hasBearer,
  requestSignOut,
  clearToken,
  redirect,
  timeoutMs,
}) {
  // Bước 1: Xử lý đăng xuất trong môi trường Live Preview (session dựa vào bearer token ở client).
  if (livePreview) {
    // No bearer means a partitioned iframe with nothing to invalidate; with one,
    // still invalidate it server-side, just don't block on the answer.
    if (hasBearer) {
      await settleWithin(requestSignOut, timeoutMs ?? signOutTimeoutMs(livePreview));
    }
    // Bước 2: Với preview, việc xóa token ở client đồng nghĩa với đăng xuất; luôn xóa token và chuyển hướng rời trang.
    clearToken();
    redirect();
    return;
  }

  // Bước 3: Xử lý khi đã deployed: session nằm ở HttpOnly cookie, chỉ server mới có quyền xóa nên bắt buộc phải đợi server phản hồi.
  const outcome = await settleWithin(requestSignOut, timeoutMs ?? signOutTimeoutMs(livePreview));
  // Bước 4: Nếu server phản hồi lỗi hoặc timeout, bắt buộc ném Error để giao diện báo lỗi và cho người dùng thử lại (không giả vờ thành công vì cookie vẫn còn).
  if (outcome !== "ok") {
    throw new Error(
      outcome === "timeout"
        ? "Sign-out timed out — you are still signed in. Please try again."
        : "Sign-out failed — you are still signed in. Please try again.",
    );
  }
  // Bước 5: Khi server xác nhận thành công ("ok"), tiến hành dọn dẹp token và chuyển hướng trang.
  clearToken();
  redirect();
}

/**
 * @typedef {object} PreSignInSteps
 * @property {boolean} livePreview Whether the app is the sandbox preview iframe.
 * @property {boolean} hasBearer Whether a preview bearer token is stored.
 * @property {() => unknown} requestSignOut Ask the server to end any prior session.
 * @property {() => void} clearToken Drop the stored bearer token.
 * @property {number} [timeoutMs]
 */

/**
 * Drop any prior session before a new sign-in starts, so switching providers
 * actually switches identity.
 *
 * Deliberately BEST EFFORT — unlike `runSignOut` this never throws. It also
 * runs when there is no prior session at all, so treating a failure as fatal
 * would block first-time sign-in on a transport hiccup, for a visitor with no
 * session to protect. The subsequent OAuth flow issues a fresh session either
 * way. Only the wait is bounded, and by the same per-environment rule as
 * `runSignOut`: a deployed session dies server-side, so it gets the full
 * window rather than the preview's aggressive one.
 * @param {PreSignInSteps} steps
 * @returns {Promise<void>}
 */
/*
 * Làm gì: Hủy phiên đăng nhập cũ trước khi bắt đầu đăng nhập mới (OAuth) theo cơ chế best-effort, giúp chuyển đổi tài khoản sạch sẽ mà không chặn luồng đăng nhập nếu gặp lỗi mạng.
 * Được gọi ở: src/client/auth/client.ts (hàm signIn), scripts/sign-out-plan.test.mjs ("test runner (node --test)").
 * - Tham số steps: Đối tượng chứa các tham số và hàm callback (livePreview, hasBearer, requestSignOut, clearToken, timeoutMs).
 * - Trả về: Promise không trả về giá trị (void) sau khi hoàn tất dọn dẹp hoặc hết thời gian chờ.
 */
export async function runPreSignInSignOut({
  livePreview,
  hasBearer,
  requestSignOut,
  clearToken,
  timeoutMs,
}) {
  // In the preview a missing bearer means there is nothing to clear.
  // Bước 1: Gửi yêu cầu hủy phiên cũ lên server (nếu có token trong preview, hoặc luôn gọi khi deployed để xóa cookie); cơ chế best-effort không bao giờ ném lỗi.
  if (hasBearer || !livePreview) {
    await settleWithin(requestSignOut, timeoutMs ?? signOutTimeoutMs(livePreview));
  }
  // Bước 2: Luôn xóa sạch bearer token cũ để đảm bảo phiên đăng nhập mới bắt đầu với trạng thái hoàn toàn sạch.
  clearToken();
}
