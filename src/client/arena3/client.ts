/**
 * File: src/client/arena3/client.ts
 * Vai trò: Module trung tâm quản lý HTTP client và phiên đăng nhập (session) cho toàn bộ ứng dụng Arena3 phía frontend.
 * Vị trí trong app: Chạy ở client, quản lý lưu trữ token/user trong localStorage, cung cấp các hàm gọi API (apiGet, apiPost...) tự động gắn Bearer token, chống trùng lặp request, dịch lỗi server và xử lý tải tài liệu PDF/báo cáo.
 */
import { linkDown, linkUp, loadFailed, loadOk } from "@/client/lib/connection";
import { tServer } from "@/client/lib/i18n";
import type { PublicUser, Role } from "../../shared/arena3/contracts";

const TOKEN_KEY = "arena3.token";
const USER_KEY = "arena3.user";
/** Set when a signed-in session ends by itself, so the sign-in page can say why. */
const EXPIRED_KEY = "arena3.expired";
/** Fired on `window` when the cached user changes, so the header can follow a profile edit. */
const USER_EVENT = "arena3:user";

export type { Role };

/**
 * The signed-in person as cached in the browser. Same shape the server sends,
 * except that a session saved before avatars existed has no `avatar_url`.
 */
export type SessionUser = Omit<PublicUser, "avatar_url"> & { avatar_url?: string | null };

/**
 * Làm gì: Lấy JWT token của phiên đăng nhập hiện tại từ localStorage để gửi kèm trong header các HTTP request.
 * Được gọi ở: client.ts (api, apiBlob, failure), avatar.ts (uploadAvatar), use-live.tsx (useLive), shell.tsx, chat.tsx, routes/index.tsx.
 * @returns Chuỗi JWT token nếu đã đăng nhập và đang chạy trên trình duyệt, ngược lại trả về null.
 * @throws Không ném lỗi.
 */
export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * Làm gì: Đọc và parse thông tin người dùng được lưu trong localStorage để giao diện hiển thị ngay lập tức trước khi gọi API /me.
 * Được gọi ở: shell.tsx, error-component.tsx, routes/account.tsx, routes/index.tsx, routes/app.index.tsx, routes/coach.index.tsx.
 * @returns Đối tượng SessionUser nếu có dữ liệu hợp lệ trong localStorage, hoặc null nếu chưa đăng nhập hoặc dữ liệu hỏng.
 * @throws Không ném lỗi.
 */
export function getStoredUser(): SessionUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

/**
 * Làm gì: Lưu token xác thực và thông tin người dùng vào localStorage ngay sau khi đăng nhập hoặc đăng ký thành công.
 * Được gọi ở: routes/login.tsx (xử lý đăng nhập thông thường và Google login), routes/register.tsx (xử lý đăng ký tài khoản).
 * @param token Chuỗi JWT token xác thực do server cấp.
 * @param user Thông tin người dùng cơ bản (SessionUser).
 * @returns void
 * @throws Không ném lỗi.
 */
export function setSession(token: string, user: SessionUser) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/**
 * Refresh the cached user without touching the token.
 *
 * The shell reads the name and role out of local storage so it can paint the
 * header before `/me` comes back. After a profile edit that copy is stale —
 * the header would keep showing the old name until the next sign-in.
 */
export function setStoredUser(user: SessionUser) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  // Bắn custom event để header và các component lắng nghe tự cập nhật lại giao diện ngay lập tức mà không cần reload
  window.dispatchEvent(new Event(USER_EVENT));
}

/** Run `f` whenever `setStoredUser` has changed the cached user; returns the way to stop. */
export function onStoredUserChange(f: () => void): () => void {
  window.addEventListener(USER_EVENT, f);
  return () => window.removeEventListener(USER_EVENT, f);
}

/**
 * Làm gì: Xóa sạch JWT token và thông tin người dùng khỏi localStorage khi người dùng đăng xuất hoặc khi phiên làm việc hết hạn.
 * Được gọi ở: client.ts (sessionEnded), shell.tsx (menu đăng xuất).
 * @returns void
 * @throws Không ném lỗi.
 */
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/**
 * Làm gì: Xác định đường dẫn URL trang chủ mặc định dựa trên vai trò (role) của tài khoản trong hệ thống.
 * Được gọi ở: shell.tsx, error-component.tsx, routes/index.tsx, routes/login.tsx, routes/register.tsx, routes/account.tsx.
 * @param role Vai trò của người dùng ("manager", "receptionist", "coach", hoặc "member").
 * @returns Đường dẫn URL tương ứng ("/manager", "/desk", "/coach", hoặc mặc định là "/app").
 * @throws Không ném lỗi.
 */
export function homeFor(role: Role): string {
  if (role === "manager") return "/manager";
  if (role === "receptionist") return "/desk";
  if (role === "coach") return "/coach";
  return "/app";
}

let ending = false;

/**
 * The server says this session is over (it timed out, or the account was switched off) while
 * someone is part-way through something. Left to each screen that arrived as a toast reading
 * "Invalid or expired session" on a page where nothing works any more. Send them to sign in
 * instead, with a line saying why. Several requests can fail at once; the first one does this.
 */
function sessionEnded() {
  if (ending || typeof window === "undefined") return;
  // Bước 1: Khóa cờ ending để ngăn chặn xử lý nhiều lần khi có hàng loạt request 401 cùng lúc
  ending = true;
  // Bước 2: Dọn dẹp phiên làm việc cũ khỏi localStorage
  clearSession();
  // Bước 3: Đặt cờ thông báo phiên hết hạn vào sessionStorage để trang /login hiển thị lý do cho người dùng
  try {
    sessionStorage.setItem(EXPIRED_KEY, "1");
  } catch {
    // Storage blocked: the redirect still happens, only the explanation is lost.
  }
  // Bước 4: Chuyển hướng trình duyệt đến trang đăng nhập (/login)
  window.location.assign("/login");
}

/** Read-and-clear, so the note shows once and not again on a later visit to the sign-in page. */
export function takeSessionNotice(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const was = sessionStorage.getItem(EXPIRED_KEY) === "1";
    sessionStorage.removeItem(EXPIRED_KEY);
    return was;
  } catch {
    return false;
  }
}

export type ApiErrorBody = {
  code: string;
  message: string;
  br?: string;
  /** Set on a 400: the form input the message is about. */
  field?: string;
  /** Set when a bulk save names the row that was refused. */
  index?: number;
  requires_confirm?: boolean;
  affected?: {
    booking_count: number;
    session_count: number;
    bookings: { id: string; code: string; start_at: string }[];
    sessions: { id: string; start_at: string }[];
  };
};

/**
 * The server answers in English. The message is translated here, once, so every screen that
 * shows `e.message` or `e.body.message` reads in the language the UI is in at the moment the
 * error arrives (`tServer` returns English unchanged, and anything it does not know).
 */
export class ApiClientError extends Error {
  status: number;
  body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody | null) {
    const raw = typeof body?.message === "string" ? body.message : "Request failed";
    const message = tServer(raw);
    super(message);
    this.status = status;
    this.body = { code: "ERROR", ...(body ?? {}), message };
  }
}

/**
 * Làm gì: Tạo chuỗi khóa ngẫu nhiên duy nhất (idempotency key) đính kèm vào header các request ghi nhằm tránh thực hiện lặp giao dịch khi gửi lại.
 * Được gọi ở: client.ts -> api() khi tùy chọn idempotent được bật.
 * @returns Chuỗi UUID v4 ngẫu nhiên hoặc fallback kết hợp timestamp và số ngẫu nhiên.
 * @throws Không ném lỗi.
 */
function newIdem(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random()}`;
}

const SERVER_TROUBLE = "Something went wrong on our side.";

/**
 * Làm gì: Parse an toàn chuỗi text phản hồi từ server sang đối tượng JSON; tránh throw exception khi server trả về HTML lỗi.
 * Được gọi ở: client.ts -> api(), failure().
 * @param text Chuỗi text nhận về từ HTTP response body.
 * @returns Đối tượng dữ liệu đã parse nếu JSON hợp lệ, null nếu text rỗng, hoặc undefined nếu không thể parse JSON.
 * @throws Không ném lỗi.
 */
function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Làm gì: Hàm type guard kiểm tra xem dữ liệu phản hồi có phải là đối tượng ApiErrorBody chứa thông báo lỗi hợp lệ từ server hay không.
 * Được gọi ở: client.ts -> failure().
 * @param v Giá trị bất kỳ cần kiểm tra cấu trúc.
 * @returns true nếu v là đối tượng có trường message kiểu string, ngược lại trả về false.
 * @throws Không ném lỗi.
 */
function isErrorBody(v: unknown): v is ApiErrorBody {
  return typeof v === "object" && v !== null && typeof (v as { message?: unknown }).message === "string";
}

/** No answer at all. The browser knows when it has no network; otherwise the server is not answering. */
function unreachable(): ApiClientError {
  linkDown(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "server");
  return new ApiClientError(0, {
    code: "NETWORK",
    message: "Could not reach the server. Check your connection and try again.",
  });
}

/**
 * `fetch` that tells `connection.ts` how the trip went, and turns the two answers that never came
 * from this app into errors a person can read: no answer at all, and the host's own 502 / 503 / 504
 * page. They used to surface as `TypeError: Failed to fetch` and `Unexpected token '<'`.
 */
async function send(path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  // Bước 1: Gửi HTTP request qua fetch với tiền tố /v1; chuyển đổi lỗi mạng thành lỗi dễ hiểu
  try {
    res = await fetch(`/v1${path}`, init);
  } catch (e) {
    // Giữ nguyên AbortError khi request bị chủ động hủy (ví dụ unmount component) thay vì báo lỗi mất mạng
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw unreachable();
  }
  // Bước 2: Bắt lỗi 502/503/504 từ gateway/proxy khi server quá tải hoặc đang khởi động lại
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    linkDown("server");
    throw new ApiClientError(res.status, {
      code: "UNAVAILABLE",
      message: "The server is busy or restarting. Try again in a moment.",
    });
  }
  // Bước 3: Báo trạng thái mạng thông suốt (linkUp) và trả về response
  linkUp();
  return res;
}

/**
 * Làm gì: Đọc toàn bộ nội dung text từ Response; nếu đường truyền đứt đoạn khi đang nhận phản hồi thì chuyển thành lỗi mất mạng dễ hiểu.
 * Được gọi ở: client.ts -> api(), apiBlob().
 * @param res Đối tượng Response trả về từ fetch.
 * @returns Chuỗi text chứa toàn bộ nội dung của response body.
 * @throws ApiClientError với mã "NETWORK" nếu quá trình đọc dữ liệu từ server bị gián đoạn.
 */
async function bodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    // The connection dropped part-way through the answer.
    throw unreachable();
  }
}

/**
 * An error response as an `ApiClientError`; ends the session first when that is what it says.
 *
 * Only when the token that was refused is still the one in storage: a request that was in flight
 * when someone signed out, or signed in as someone else, comes back 401 and means nothing now.
 */
function failure(res: Response, text: string, path: string, sent: string | null): ApiClientError {
  // Bước 1: Nếu bị lỗi 401 Unauthorized và token gửi đi trùng với token trong storage, xử lý hết hạn phiên
  if (res.status === 401 && sent && sent === getToken() && path !== "/auth/login" && path !== "/auth/logout") {
    sessionEnded();
  }
  // Bước 2: Parse body lỗi; nếu server trả về HTML lỗi của proxy thì dùng thông báo lỗi mặc định
  const body = parseBody(text);
  return new ApiClientError(res.status, isErrorBody(body) ? body : { code: "ERROR", message: SERVER_TROUBLE });
}

/**
 * Làm gì: Hàm gửi HTTP request tổng quát của toàn hệ thống; tự động đính kèm token, header JSON, idempotency key, xử lý phản hồi và chuẩn hóa lỗi.
 * Được gọi ở: client.ts -> apiGet, apiPost, apiPatch, apiPut, apiDelete.
 * @param path Đường dẫn endpoint API tương đối (sau tiền tố /v1).
 * @param init Cấu hình fetch mở rộng (method, body, headers, tùy chọn idempotent).
 * @returns Promise chứa dữ liệu phản hồi kiểu T, Blob (nếu là PDF), hoặc undefined (nếu là 204 No Content).
 * @throws ApiClientError khi HTTP status không thành công (!res.ok), mất mạng, proxy lỗi hoặc định dạng phản hồi không hợp lệ.
 */
export async function api<T>(
  path: string,
  init: RequestInit & { idempotent?: boolean } = {},
): Promise<T> {
  // Bước 1: Chuẩn bị headers; mặc định application/json trừ khi gửi FormData (upload file)
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body && !(init.body instanceof FormData)) {
    headers.set("content-type", "application/json");
  }
  // Bước 2: Tự động gán Bearer token nếu đã đăng nhập và sinh idempotency-key nếu được yêu cầu
  const token = getToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.idempotent) headers.set("idempotency-key", newIdem());
  // Bước 3: Thực hiện gọi request qua hàm send
  const res = await send(path, { ...init, headers });
  // Bước 4: Xử lý các dạng response đặc biệt (204 No Content không có body, hoặc file PDF nhị phân)
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/pdf")) {
    return (await res.blob()) as T;
  }
  // Bước 5: Đọc text và kiểm tra HTTP status; ném ApiClientError nếu server báo lỗi
  const text = await bodyText(res);
  if (!res.ok) throw failure(res, text, path, token);
  const data = parseBody(text);
  // A 200 that is not our JSON is a host or proxy page standing in for the app.
  // Đề phòng trường hợp HTTP 200 nhưng nội dung trả về là trang HTML của proxy hoặc Cloudflare
  if (data === undefined) throw new ApiClientError(res.status, { code: "BAD_RESPONSE", message: SERVER_TROUBLE });
  return data as T;
}

/** The app itself failed to answer a read: a 500, or a reply that was not its JSON. */
function brokeTheScreen(e: unknown): boolean {
  return e instanceof ApiClientError && (e.status >= 500 || e.body.code === "BAD_RESPONSE");
}

/**
 * GETs that are already in flight, keyed by path.
 *
 * Several components legitimately ask for the same thing at the same moment —
 * `Guard` and the page it wraps both want `/me`, and React's StrictMode mounts
 * each of them twice in dev. `/me` is the most expensive read in the app, so
 * firing it two or four times over is the single largest thing standing
 * between a sign-in and a rendered page; measured on the deployed app, the
 * duplicate alone added ~840ms to every load.
 *
 * Callers still each get their own promise result; only the network trip is
 * shared. The entry is dropped as soon as the request settles, so this is a
 * de-duplicator for concurrent calls, not a cache — a later `load()` after a
 * mutation always hits the server.
 */
const inflight = new Map<string, Promise<unknown>>();

/**
 * `background` is for reads nobody is waiting on — the unread count, a session check. A screen's own
 * read that fails with a server error leaves the screen on grey blocks with nothing to say but a
 * toast that fades, so the connection banner is told and offers to open the screen again; a
 * background read failing is not news on screen. Each caller reports for itself, so a screen that
 * shares a request a background caller started still gets its banner.
 *
 * `fresh` is for a read that follows a change the person just made: joining a request that was
 * already in flight would hand back an answer asked for *before* that change, and the screen would
 * redraw a row that has just been paid for.
 */
export const apiGet = <T>(path: string, opts: { background?: boolean; fresh?: boolean } = {}): Promise<T> => {
  // Bước 1: Tận dụng request đang gửi (inflight deduplication) để tránh gọi trùng lặp, trừ khi cần dữ liệu mới nhất (fresh: true)
  let p = opts.fresh ? undefined : (inflight.get(path) as Promise<T> | undefined);
  if (!p) {
    const own: Promise<T> = api<T>(path).finally(() => {
      if (inflight.get(path) === own) inflight.delete(path);
    });
    p = own;
    inflight.set(path, own);
  }
  // Bước 2: Cập nhật trạng thái hiển thị trên thanh banner kết nối mạng (bỏ qua với background request)
  if (!opts.background) {
    p.then(
      () => loadOk(path),
      (e: unknown) => {
        if (brokeTheScreen(e)) loadFailed(path);
      },
    );
  }
  return p;
};
// A FormData (a file upload) goes as it is; stringified it would arrive as "{}".
const bodyOf = (body: unknown) => (body instanceof FormData ? body : body ? JSON.stringify(body) : undefined);
/**
 * Làm gì: Gửi HTTP POST request để tạo mới dữ liệu hoặc thực hiện các tác vụ nghiệp vụ quan trọng (đăng nhập, đặt lịch sân, thanh toán).
 * Được gọi ở: routes/login.tsx, routes/register.tsx, routes/app.book.tsx, routes/desk.payments.tsx, components/pay-online.tsx và nhiều màn hình khác.
 * @param path Đường dẫn endpoint API (sau /v1).
 * @param body Dữ liệu gửi lên server (object hoặc FormData).
 * @param idempotent Bật header idempotency-key chống gửi trùng giao dịch (mặc định false).
 * @returns Promise chứa dữ liệu T trả về từ server.
 * @throws ApiClientError khi request gặp lỗi từ server hoặc mạng.
 */
export const apiPost = <T>(path: string, body?: unknown, idempotent = false) =>
  api<T>(path, { method: "POST", body: bodyOf(body), idempotent });
/**
 * Làm gì: Gửi HTTP PATCH request để cập nhật một phần thông tin của bản ghi (trạng thái sân, thông tin hội viên, điểm danh).
 * Được gọi ở: routes/desk.member.$id.tsx, routes/desk.courts.tsx, routes/manager.sports.tsx, components/attendance-panels.tsx.
 * @param path Đường dẫn endpoint API (sau /v1).
 * @param body Đối tượng chứa các trường dữ liệu cần cập nhật một phần.
 * @returns Promise chứa dữ liệu T sau khi đã được cập nhật.
 * @throws ApiClientError khi request thất bại.
 */
export const apiPatch = <T>(path: string, body?: unknown) => api<T>(path, { method: "PATCH", body: bodyOf(body) });
/**
 * Làm gì: Gửi HTTP PUT request để lưu hoặc thay thế toàn bộ một tài nguyên/cấu hình (bảng giá sân, chương trình khuyến mãi, phân ca huấn luyện).
 * Được gọi ở: routes/manager.prices.tsx, routes/manager.promos.tsx, components/coach-training.tsx.
 * @param path Đường dẫn endpoint API (sau /v1).
 * @param body Toàn bộ đối tượng dữ liệu cần lưu/thay thế.
 * @returns Promise chứa dữ liệu T trả về từ server.
 * @throws ApiClientError khi request thất bại.
 */
export const apiPut = <T>(path: string, body?: unknown) => api<T>(path, { method: "PUT", body: bodyOf(body) });
/**
 * Làm gì: Gửi HTTP DELETE request để xóa một tài nguyên khỏi hệ thống (hủy lịch đặt sân, xóa môn thể thao, xóa sân, hủy gói tập).
 * Được gọi ở: components/cancel-booking.tsx, routes/manager.courts.tsx, routes/manager.sports.tsx, routes/desk.member.$id.tsx.
 * @param path Đường dẫn endpoint API (sau /v1).
 * @returns Promise chứa dữ liệu T trả về hoặc undefined nếu nhận mã 204 No Content.
 * @throws ApiClientError khi request thất bại.
 */
export const apiDelete = <T>(path: string) => api<T>(path, { method: "DELETE" });
/**
 * A binary GET that also surfaces the filename the server chose.
 *
 * `api()` throws the headers away, and the invoice code only exists in
 * `content-disposition` — without it a saved receipt lands in Downloads named
 * after a UUID.
 */
async function apiBlob(path: string): Promise<{ blob: Blob; filename: string | null }> {
  const headers = new Headers();
  // Bước 1: Gắn Bearer token xác thực vào headers nếu người dùng đã đăng nhập
  const token = getToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await send(path, { headers });
  if (!res.ok) throw failure(res, await bodyText(res), path, token);
  // Bước 2: Trích xuất tên file đính kèm từ header content-disposition do server gửi về
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1];
  return { blob: await res.blob(), filename: name ?? null };
}

/**
 * Save a server-built report (xlsx / pdf) to Downloads.
 *
 * A plain link cannot carry the bearer token, so the file is fetched with it and
 * handed to the browser as a blob.
 */
export async function downloadReport(path: string, fallbackName: string): Promise<string> {
  // Bước 1: Tải dữ liệu nhị phân (Blob) và lấy tên file được server chỉ định
  const { blob, filename } = await apiBlob(path);
  const name = filename ?? fallbackName;
  // Bước 2: Tạo Object URL tạm thời đại diện cho dữ liệu file trong bộ nhớ trình duyệt
  const url = URL.createObjectURL(blob);
  // Bước 3: Tạo thẻ <a> ẩn và kích hoạt sự kiện click để bắt đầu tải file về máy
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  // Bước 4: Hủy Object URL sau 60 giây để giải phóng bộ nhớ RAM
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return name;
}

/**
 * Show a receipt, and actually show it.
 *
 * `window.open` after an `await` is no longer inside the click that caused it,
 * so every browser treats it as an unsolicited popup and blocks it. It does
 * not throw when that happens — it returns `null` — so the callers' `try/catch`
 * never fired and pressing "Receipt" did nothing at all, with no error, on any
 * of the eleven places that call this. The PDF had been fetched correctly the
 * whole time.
 *
 * A programmatic download is not subject to the popup blocker, so it is the
 * fallback: worst case the receipt lands in Downloads instead of a new tab,
 * which is a far better outcome than silence at the till.
 */
export async function openInvoice(id: string): Promise<"opened" | "downloaded"> {
  // Bước 1: Tải file PDF hóa đơn qua apiBlob và tạo Object URL trong bộ nhớ
  const { blob, filename } = await apiBlob(`/invoices/${id}.pdf`);
  const url = URL.createObjectURL(blob);
  try {
    // Bước 2: Thử mở trực tiếp trong tab mới bằng window.open
    const win = window.open(url, "_blank");
    if (win && !win.closed) return "opened";
    // Bước 3: Nếu trình duyệt chặn mở tab mới (popup blocker), chuyển sang phương án tải thẳng file về máy
    const a = document.createElement("a");
    a.href = url;
    a.download = filename ?? `receipt-${id}.pdf`;
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
    return "downloaded";
  } finally {
    // The blob is held alive by the object URL until it is revoked, and a till
    // that prints all day would otherwise accumulate every receipt it issued.
    // Long enough for the new tab or the download to have read it.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
