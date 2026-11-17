/**
 * File: src/client/lib/connection.ts
 * Vai trò: Quản lý trạng thái kết nối mạng (network link) và sức khỏe máy chủ ở phía client.
 * Vị trí trong app: Đóng vai trò là single source of truth cho toàn bộ client về tình trạng kết nối.
 * Module này nhận báo cáo từ `client.ts` khi gửi request và từ sự kiện online/offline của trình duyệt,
 * sau đó cung cấp trạng thái cho `ConnectionBanner` để hiển thị thông báo và kích hoạt `RetryOutlet`
 * remount lại toàn bộ trang khi kết nối được phục hồi.
 */
import { useSyncExternalStore } from "react";

/**
 * Whether this page can reach its server right now, and one place that knows why not.
 *
 * Without it a dropped signal looked like three different bugs: a page stuck on grey blocks (the
 * request threw, the page showed a toast that faded, and nothing else), a till operator signed out
 * because a single `/me` call failed, and "Unexpected token <" read out to someone whose host had
 * answered with an HTML error page. `client.ts` reports every request here; `ConnectionBanner`
 * says it once, in words, with a way to try again.
 *
 *   ok       nothing to say
 *   offline  no answer at all: no signal, a dropped Wi-Fi, a server that is down
 *   server   an answer, but from the hosting platform (502 / 503 / 504), not from the app
 *   broken   the app itself answered with an error (a plain 500) to a request that fills a screen,
 *            so the screen is still on grey blocks and nothing will ask again on its own
 *   back     it was down and a request has just gone through again
 */
export type LinkState = "ok" | "offline" | "server" | "broken" | "back";

// Cấu trúc dữ liệu snapshot lưu trạng thái kết nối và khóa remount trang (retryKey)
type Snapshot = { link: LinkState; retryKey: number };

// Snapshot trạng thái hiện tại; retryKey tăng dần mỗi lần tải lại trang thành công
let snap: Snapshot = { link: "ok", retryKey: 0 };
let backTimer: ReturnType<typeof setTimeout> | undefined;
// Danh sách callback lắng nghe thay đổi trạng thái kết nối phục vụ useSyncExternalStore
const subscribers = new Set<() => void>();
/** Screen-filling requests that last came back as an error, by path. */
const failedLoads = new Set<string>();

/**
 * Làm gì: Cập nhật snapshot trạng thái kết nối và thông báo tới tất cả subscriber (các React hook đang lắng nghe).
 * Được gọi ở: Nội bộ file `connection.ts` (trong các hàm `linkDown`, `loadFailed`, `loadOk`, `newScreen`, `linkUp`, `dismissBack`, `retryNow`).
 * @param next Đối tượng chứa các trường cần cập nhật trong Snapshot (`link` hoặc `retryKey`).
 * @returns Không trả về giá trị (void).
 */
const set = (next: Partial<Snapshot>) => {
  // Cập nhật snapshot mới và kích hoạt thông báo cho tất cả subscriber đang lắng nghe
  snap = { ...snap, ...next };
  subscribers.forEach((f) => f());
};

/**
 * Làm gì: Đăng ký hàm callback lắng nghe thay đổi trạng thái kết nối, phục vụ cơ chế `useSyncExternalStore`.
 * Được gọi ở: `useLink` (dòng 142), `useRetryKey` (dòng 143) trong `connection.ts`.
 * @param f Hàm callback cần kích hoạt khi snapshot thay đổi.
 * @returns Hàm cleanup để hủy đăng ký (unsubscribe) khỏi danh sách subscribers.
 */
const subscribe = (f: () => void) => {
  // Thêm subscriber vào Set và trả về hàm hủy đăng ký tương ứng
  subscribers.add(f);
  return () => void subscribers.delete(f);
};

/** A request got no usable answer. */
/**
 * Làm gì: Ghi nhận trạng thái mất kết nối mạng (offline) hoặc lỗi từ hạ tầng/máy chủ gateway (502/503/504).
 * Được gọi ở: `src/client/arena3/client.ts` (trong `unreachable` và khi `res.status` là 502/503/504), hàm `retryNow` (dòng 125), và sự kiện `window.onoffline` (dòng 136).
 * @param kind Loại sự cố kết nối: "offline" (mất mạng thiết bị) hoặc "server" (máy chủ proxy/gateway không phản hồi).
 * @returns Không trả về giá trị (void).
 */
export function linkDown(kind: "offline" | "server") {
  // Bước 1: Hủy timer chuyển trạng thái "back" -> "ok" (nếu có) vì kết nối vừa bị gián đoạn
  clearTimeout(backTimer);
  // No answer at all is the bigger news; a page that errored a moment ago is part of it.
  failedLoads.clear();
  // Bước 2: Cập nhật trạng thái kết nối mới nếu có sự thay đổi
  if (snap.link !== kind) set({ link: kind });
}

/**
 * A request that fills a screen got an error from the app itself (a 500, or a reply that was not
 * its JSON). The server is there, so this is not "offline" — but the screen stays on grey blocks
 * and a toast that fades is all it said. Cleared by that same request going through, or by
 * "Reload page".
 */
/**
 * Làm gì: Ghi nhận một URL/màn hình tải dữ liệu thất bại do lỗi 500 từ ứng dụng hoặc dữ liệu trả về không hợp lệ, khiến màn hình bị kẹt ở trạng thái loading.
 * Được gọi ở: `src/client/arena3/client.ts` (trong callback lỗi của hàm `get` khi gặp lỗi `brokeTheScreen`).
 * @param path Đường dẫn API của màn hình bị tải lỗi (ví dụ: "/customers", "/courts").
 * @returns Không trả về giá trị (void).
 */
export function loadFailed(path: string) {
  // Nothing to add when there is already no answer at all: that banner says more.
  // Bước 1: Bỏ qua nếu ứng dụng đã ở trạng thái mất mạng hoặc sập server (banner mạng ưu tiên hơn)
  if (snap.link === "offline" || snap.link === "server") return;
  // Bước 2: Ghi nhận đường dẫn bị lỗi và chuyển trạng thái sang "broken" nếu chưa bật
  failedLoads.add(path);
  if (snap.link === "broken") return;
  clearTimeout(backTimer);
  set({ link: "broken" });
}

/** That same request went through. Once nothing is left failing, the banner has nothing to say. */
/**
 * Làm gì: Đánh dấu một đường dẫn API đã tải thành công, xóa khỏi danh sách tải lỗi và phục hồi trạng thái "ok" nếu không còn màn hình nào lỗi.
 * Được gọi ở: `src/client/arena3/client.ts` (trong callback thành công của hàm `get`).
 * @param path Đường dẫn API vừa tải thành công.
 * @returns Không trả về giá trị (void).
 */
export function loadOk(path: string) {
  // Bước 1: Xóa đường dẫn khỏi danh sách lỗi; nếu đường dẫn không tồn tại trong danh sách thì bỏ qua
  if (!failedLoads.delete(path)) return;
  // Bước 2: Khi tất cả các màn hình bị lỗi đều đã tải thành công, chuyển trạng thái về "ok" để ẩn banner
  if (snap.link === "broken" && failedLoads.size === 0) set({ link: "ok" });
}

/**
 * A different screen is on show, so a read that failed on the last one is no longer the news.
 * Called when the page changes, before the new page's own requests have had time to answer.
 */
/**
 * Làm gì: Đặt lại danh sách màn hình lỗi và xóa trạng thái "broken" khi người dùng chuyển sang trang/màn hình mới.
 * Được gọi ở: `src/client/components/connection-banner.tsx` (trong hook `useEffect` theo dõi sự thay đổi của `pathname`).
 * @returns Không trả về giá trị (void).
 */
export function newScreen() {
  // Bước 1: Xóa sạch các lỗi của màn hình cũ vì người dùng đã điều hướng sang màn hình khác
  failedLoads.clear();
  // Bước 2: Đặt lại trạng thái "ok" để ẩn banner lỗi màn hình cũ
  if (snap.link === "broken") set({ link: "ok" });
}

/** A request got a real answer (any status the app itself produced counts: the server is there). */
/**
 * Làm gì: Ghi nhận kết nối mạng và máy chủ đã hoạt động trở lại sau sự cố mất mạng hoặc sập server, tạm thời hiển thị trạng thái "back".
 * Được gọi ở: `src/client/arena3/client.ts` (trong hàm `send` sau khi nhận phản hồi từ server), và sự kiện `window.ononline` (dòng 138).
 * @returns Không trả về giá trị (void).
 */
export function linkUp() {
  // A request going through elsewhere says nothing about the screen that did not load.
  // Bước 1: Bỏ qua nếu mạng đang bình thường, đang hiển thị "back", hoặc trang hiện tại đang lỗi app
  if (snap.link === "ok" || snap.link === "back" || snap.link === "broken") return;
  // Bước 2: Đánh dấu trạng thái "back" báo hiệu vừa kết nối lại thành công
  set({ link: "back" });
  // The banner only needs to say "you are connected again" for a moment; the button on it stays
  // useful for a page that never finished loading, so it lingers longer than a toast would.
  // Bước 3: Đặt timer tự động ẩn thông báo sau 12 giây (đủ lâu để người dùng kịp bấm tải lại trang)
  clearTimeout(backTimer);
  backTimer = setTimeout(() => {
    if (snap.link === "back") set({ link: "ok" });
  }, 12_000);
}

/** Dismiss the "connected again" note without reloading anything. */
/**
 * Làm gì: Tắt ngay thông báo "Đã kết nối lại" (trạng thái "back") và đưa trạng thái về "ok" mà không cần tải lại trang.
 * Được gọi ở: `src/client/components/connection-banner.tsx` (sự kiện `onClick` của nút đóng thông báo X trên banner).
 * @returns Không trả về giá trị (void).
 */
export function dismissBack() {
  // Hủy timer tự đóng và chuyển ngay trạng thái kết nối về "ok"
  clearTimeout(backTimer);
  if (snap.link === "back") set({ link: "ok" });
}

/**
 * Ask the server whether it is there, with a short leash.
 *
 * Plain `fetch`, not `api()`: this is the thing `api()` reports to, and a failed probe must not
 * trigger the reporting again.
 */
/**
 * Làm gì: Kiểm tra máy chủ có đang phản hồi hay không bằng cách gửi HTTP request trực tiếp tới endpoint `/v1/health` với timeout ngắn.
 * Được gọi ở: `retryNow` (dòng 123) trong `src/client/lib/connection.ts`.
 * @returns Promise<boolean> trả về true nếu máy chủ phản hồi HTTP 200 OK, ngược lại trả về false.
 */
async function reachable(): Promise<boolean> {
  // Bước 1: Khởi tạo AbortController với giới hạn timeout 8 giây (8_000ms) để tránh treo lâu
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8_000);
  try {
    // Bước 2: Gửi request thăm dò bằng fetch thuần với cache "no-store" (không qua api client để tránh lặp đệ quy báo lỗi)
    const res = await fetch("/v1/health", { cache: "no-store", signal: ctl.signal });
    return res.ok;
  } catch {
    // Bước 3: Bắt lỗi nếu mạng bị ngắt hoặc request bị timeout, trả về false
    return false;
  } finally {
    // Luôn dọn dẹp timer timeout sau khi thăm dò hoàn tất
    clearTimeout(timer);
  }
}

/**
 * "Try again": probe the server and, if it answers, load the screen afresh.
 *
 * The reload is the point. A page whose first request failed is still holding its empty state, and
 * nothing will ask again on its own; bumping `retryKey` remounts the routed page (see
 * `RetryOutlet`), which is exactly "open this screen again". Returns whether the server answered.
 */
/**
 * Làm gì: Thử kết nối lại với máy chủ; nếu máy chủ phản hồi tốt, tăng `retryKey` để remount lại màn hình hiện tại và kéo lại dữ liệu từ đầu.
 * Được gọi ở: `src/client/components/connection-banner.tsx` (trong hàm `retry` khi người dùng bấm nút "Thử lại" hoặc "Tải lại trang").
 * @returns Promise<boolean> trả về true nếu kết nối lại thành công và đã kích hoạt tải lại trang, false nếu máy chủ vẫn chưa phản hồi.
 */
export async function retryNow(): Promise<boolean> {
  // Bước 1: Thăm dò xem máy chủ đã sẵn sàng phản hồi hay chưa qua /v1/health
  const ok = await reachable();
  // Bước 2: Nếu chưa thể kết nối, duy trì hoặc cập nhật trạng thái lỗi tương ứng và dừng lại
  if (!ok) {
    linkDown(snap.link === "server" || snap.link === "broken" ? "server" : "offline");
    return false;
  }
  // Bước 3: Khi kết nối thành công, xóa danh sách lỗi cũ và tăng retryKey để remount trang qua RetryOutlet
  clearTimeout(backTimer);
  failedLoads.clear();
  set({ link: "ok", retryKey: snap.retryKey + 1 });
  return true;
}

// Lắng nghe sự kiện mất mạng/có mạng từ trình duyệt để cập nhật banner kết nối tức thì ở phía client
if (typeof window !== "undefined") {
  // The browser knows before any request fails: say so, and say so again when the signal returns.
  window.addEventListener("offline", () => linkDown("offline"));
  window.addEventListener("online", () => {
    if (snap.link === "offline") linkUp();
  });
}

/**
 * Làm gì: Custom hook đồng bộ trạng thái kết nối (`LinkState`) từ store ra component React bằng `useSyncExternalStore`.
 * Được gọi ở: `src/client/components/connection-banner.tsx` (trong component `ConnectionBanner` để quyết định hiển thị banner tương ứng).
 * @returns Trạng thái kết nối hiện tại (`LinkState`).
 */
export const useLink = (): LinkState => useSyncExternalStore(subscribe, () => snap.link, () => "ok" as LinkState);
/**
 * Làm gì: Custom hook đồng bộ giá trị `retryKey` từ store để làm key kích hoạt remount lại route component khi người dùng nhấn thử lại.
 * Được gọi ở: `src/routes/__root.tsx` (trong component `RetryOutlet` truyền vào `<Outlet key={useRetryKey()} />`).
 * @returns Giá trị số `retryKey` hiện tại, tăng dần mỗi lần thử lại thành công.
 */
export const useRetryKey = (): number => useSyncExternalStore(subscribe, () => snap.retryKey, () => 0);
