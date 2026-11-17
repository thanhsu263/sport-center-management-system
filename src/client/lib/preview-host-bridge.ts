/**
 * Guest side of the grok-web ↔ sandbox preview postMessage bridge.
 *
 * Activates only when this page is framed by an allowlisted Grok embedder.
 * Top-level runs (download/export, local `npm run dev`, deployed sites) noop.
 */

import { z } from "zod";
import { CONNECTOR_TOKEN_READY_EVENT } from "../../shared/app-data/types";
import { resolveParentEmbedderOrigin } from "./preview-embedder-origin";

export {
  isGrokEmbedderOrigin,
  isSandboxPreviewGuestHost,
  resolveParentEmbedderOrigin,
} from "./preview-embedder-origin";

/**
 * Làm gì: Tên định danh kênh truyền thông điệp postMessage giữa cửa sổ xem trước (guest iframe) và giao diện Grok host.
 * Được gọi ở: Nội bộ src/client/lib/preview-host-bridge.ts (EnvelopeSchema, reportLocation, reportRoutes, announce).
 */
export const PREVIEW_BRIDGE_CHANNEL = "grok-preview-bridge" as const;
/**
 * Làm gì: Số phiên bản giao thức của cầu nối postMessage, dùng để kiểm tra tính tương thích và loại bỏ các thông điệp khác phiên bản.
 * Được gọi ở: Nội bộ src/client/lib/preview-host-bridge.ts (EnvelopeSchema, reportLocation, reportRoutes, announce, onMessage).
 */
export const PREVIEW_BRIDGE_VERSION = 1 as const;

// Các schema Zod xác thực cấu trúc phong bì (envelope) và các kiểu sự kiện hợp lệ nhận từ preview host qua postMessage.
const EnvelopeSchema = z.object({
  channel: z.literal(PREVIEW_BRIDGE_CHANNEL),
  version: z.number().int().positive(),
  type: z.string().min(1),
});

const HelloSchema = EnvelopeSchema.extend({
  type: z.literal("hello"),
});

const NavigateSchema = EnvelopeSchema.extend({
  type: z.literal("navigate"),
  path: z.string().min(1),
});

const HistorySchema = EnvelopeSchema.extend({
  type: z.literal("history"),
  delta: z.union([z.literal(-1), z.literal(1)]),
});

const ConnectorTokenReadySchema = EnvelopeSchema.extend({
  type: z.literal("connector-token-ready"),
});

/**
 * Làm gì: Định nghĩa các tùy chọn cấu hình cho cầu nối xem trước (preview bridge), bao gồm hàm điều hướng tùy biến và hàm lấy danh sách route.
 * Được gọi ở: src/client/lib/preview-host-bridge.ts (tham số hàm installPreviewHostBridge), src/client/components/preview-host-bridge.tsx.
 */
export type PreviewHostBridgeOptions = {
  /** Prefer the app router when available; falls back to history.pushState. */
  navigate?: (path: string) => void;
  /** Best-effort registered paths for host autosuggest (may be empty). */
  getRoutePaths?: () => string[];
};

/**
 * Làm gì: Kiểm tra một đường dẫn URL từ host gửi sang có an toàn để điều hướng hay không, phòng chống tấn công Open Redirect hoặc thoát khỏi domain nội bộ (như //evil.com hoặc ký tự \).
 * Được gọi ở: Nội bộ src/client/lib/preview-host-bridge.ts (trong defaultNavigate và navigate).
 * @param path Chuỗi đường dẫn URL cần kiểm tra tính hợp lệ và an toàn.
 * @returns true nếu đường dẫn là path nội bộ an toàn (bắt đầu bằng đúng một dấu / và không đổi origin), ngược lại false.
 * @throws Không ném lỗi.
 */
export function isSafeBridgePath(path: string): boolean {
  // Bước 1: Từ chối các đường dẫn không bắt đầu bằng '/', bắt đầu bằng '//' (dạng protocol-relative nguy hiểm) hoặc chứa ký tự '\' (tránh bypass parser trên một số trình duyệt).
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    return false;
  }
  // Bước 2: Phân tích cú pháp với origin giả lập để đảm bảo đường dẫn không làm thay đổi origin sang domain bên ngoài.
  try {
    const resolved = new URL(path, "https://preview.invalid");
    return resolved.origin === "https://preview.invalid";
  } catch {
    return false;
  }
}

/**
 * Origin of the Grok embedder framing this page, or null when the page runs
 * top-level (download/export, local `npm run dev`, deployed sites) or under a
 * non-Grok parent. Client-only; null during SSR.
 */
/**
 * Làm gì: Xác định origin của trang Grok cha đang nhúng iframe hiện tại, trả về null nếu chạy độc lập (top-level), chạy dev nội bộ hoặc trong môi trường SSR.
 * Được gọi ở: Nội bộ src/client/lib/preview-host-bridge.ts (trong installPreviewHostBridge).
 * @returns Chuỗi origin của host cha (ví dụ https://grok.com) nếu hợp lệ, ngược lại trả về null.
 * @throws Không ném lỗi.
 */
export function resolveCurrentEmbedderOrigin(): string | null {
  // Bước 1: Trả về null nếu đang chạy ở môi trường server (SSR) vì không có đối tượng window.
  if (typeof window === "undefined") return null;
  // Bước 2: Lấy origin của khung cha gần nhất từ thuộc tính ancestorOrigins nếu trình duyệt (như Chromium) hỗ trợ.
  const ancestorOrigin =
    typeof location.ancestorOrigins !== 'undefined' && location.ancestorOrigins.length > 0
      ? location.ancestorOrigins[0]
      : null;
  // Bước 3: So khớp và kiểm tra tính hợp lệ của host cha thông qua resolver với các thông số môi trường.
  return resolveParentEmbedderOrigin(
    window.parent === window,
    document.referrer,
    ancestorOrigin,
    window.location.hostname,
  );
}

/**
 * Install host↔guest messaging. Returns a dispose function.
 * Noops (returns a no-op dispose) when not embedded under a Grok parent.
 */
/**
 * Làm gì: Cài đặt cầu nối truyền thông điệp hai chiều (postMessage) giữa ứng dụng (iframe guest) và giao diện xem trước (Grok host); trả về hàm dọn dẹp (cleanup/dispose).
 * Được gọi ở: src/client/components/preview-host-bridge.tsx (trong hook useEffect của component PreviewHostBridge).
 * @param options Cấu hình tùy chọn chứa hàm điều hướng (navigate) và hàm lấy danh sách route (getRoutePaths).
 * @returns Hàm dọn dẹp để gỡ bỏ toàn bộ event listener và hoàn tác việc ghi đè window.history khi unmount.
 * @throws Không ném lỗi.
 */
export function installPreviewHostBridge(
  options: PreviewHostBridgeOptions = {},
): () => void {
  // Bước 1: Xác định origin của host cha. Nếu trang chạy độc lập hoặc không thuộc Grok embedder được cấp phép thì bỏ qua (noop).
  const parentOrigin = resolveCurrentEmbedderOrigin();
  if (parentOrigin === null) return () => {};

  // Bước 2: Lưu lại các hàm gốc của History API và định nghĩa hàm kiểm tra xem trang có đang ở điểm mốc lịch sử ban đầu (root) hay không.
  const ROOT_STATE_KEY = "__grokPreviewBridgeRoot";
  const originalPushState = window.history.pushState.bind(window.history);
  const originalReplaceState = window.history.replaceState.bind(window.history);

  const isAtHistoryRoot = () => {
    const state = window.history.state;
    return Boolean(
      state && typeof state === "object" && state[ROOT_STATE_KEY] === true,
    );
  };

  // Floor for chrome Back: only the first install in a fresh history stack is
  // root. Full document navigations reinstall this bridge on a deep URL; if we
  // re-stamped that entry as root, Back would no-op while earlier in-preview
  // history still exists. Preserve an existing tag (bfcache / SPA remount).
  // Bước 3: Đánh dấu trạng thái gốc (root state) vào history entry hiện tại để ngăn nút Back của host thoát khỏi khung xem trước.
  try {
    const current = window.history.state;
    const alreadyTagged =
      current !== null &&
      typeof current === "object" &&
      Object.prototype.hasOwnProperty.call(current, ROOT_STATE_KEY);
    if (!alreadyTagged) {
      const isRoot = window.history.length <= 1;
      const marked =
        current && typeof current === "object"
          ? { ...current, [ROOT_STATE_KEY]: isRoot }
          : { [ROOT_STATE_KEY]: isRoot };
      originalReplaceState(marked, "", window.location.href);
    }
  } catch {
    // ignore if the document cannot be marked
  }

  // Gửi thông điệp postMessage tới cửa sổ cha với targetOrigin được khóa chính xác để đảm bảo an toàn.
  const post = (message: object) => {
    window.parent.postMessage(message, parentOrigin);
  };

  // Đồng bộ URL hiện tại (pathname, search params, hash) lên thanh địa chỉ của preview host.
  const reportLocation = () => {
    post({
      channel: PREVIEW_BRIDGE_CHANNEL,
      version: PREVIEW_BRIDGE_VERSION,
      type: "location",
      path: window.location.pathname || "/",
      search: window.location.search,
      hash: window.location.hash,
    });
  };

  // Gửi danh sách các route có sẵn trong ứng dụng lên host để hỗ trợ tính năng gợi ý đường dẫn (autosuggest).
  const reportRoutes = () => {
    const paths = options.getRoutePaths?.() ?? [];
    post({
      channel: PREVIEW_BRIDGE_CHANNEL,
      version: PREVIEW_BRIDGE_VERSION,
      type: "routes",
      paths,
    });
  };

  // Điều hướng mặc định dùng History API của trình duyệt khi ứng dụng không truyền hàm navigate tùy chỉnh.
  const defaultNavigate = (path: string) => {
    if (!isSafeBridgePath(path)) return;
    try {
      const url = new URL(path, window.location.origin);
      if (url.origin !== window.location.origin) return;
      const next = `${url.pathname}${url.search}${url.hash}`;
      window.history.pushState(window.history.state, "", next);
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    } catch {
      // ignore malformed paths
    }
  };

  // Điều hướng tới đường dẫn mới: ưu tiên dùng hàm navigate của router (TanStack Router) nếu được cung cấp.
  const navigate = (path: string) => {
    if (!isSafeBridgePath(path)) return;
    if (options.navigate) {
      options.navigate(path);
      return;
    }
    defaultNavigate(path);
  };

  // Phát tín hiệu "ready" kèm thông tin location và danh sách routes cho host ngay khi cầu nối sẵn sàng.
  const announce = () => {
    reportLocation();
    reportRoutes();
    post({
      channel: PREVIEW_BRIDGE_CHANNEL,
      version: PREVIEW_BRIDGE_VERSION,
      type: "ready",
    });
  };

  // Host re-handshake: it may have (re)mounted after our install-time
  // announce, or asked before we hydrated. Announce again.
  const onHello = (data: unknown) => {
    if (!HelloSchema.safeParse(data).success) return;
    announce();
  };

  // Xử lý yêu cầu điều hướng từ host: thực hiện chuyển trang và hẹn lịch thông báo lại URL sau microtask.
  const onNavigate = (data: unknown) => {
    const parsed = NavigateSchema.safeParse(data);
    if (!parsed.success) return;
    navigate(parsed.data.path);
    // Router navigations often update location asynchronously; report after a tick.
    queueMicrotask(reportLocation);
  };

  // Xử lý yêu cầu Back (-1) hoặc Forward (1) trong lịch sử duyệt trang từ các nút điều hướng của host.
  const onHistory = (data: unknown) => {
    const parsed = HistorySchema.safeParse(data);
    if (!parsed.success) return;
    // Do not history.go(-1) off the first entry — that leaves the preview.
    if (parsed.data.delta === -1 && isAtHistoryRoot()) return;
    // Location sync comes from the popstate listener once history settles.
    window.history.go(parsed.data.delta);
  };

  // Phát sự kiện DOM khi connector token (Google/Notion...) sẵn sàng để các hook client kích hoạt refetch dữ liệu.
  const onConnectorTokenReady = (data: unknown) => {
    if (!ConnectorTokenReadySchema.safeParse(data).success) return;
    window.dispatchEvent(new Event(CONNECTOR_TOKEN_READY_EVENT));
  };

  // Bảng tra cứu ánh xạ giữa tên loại sự kiện (type) và hàm xử lý tương ứng từ host.
  const hostMessageHandlers = new Map<string, (data: unknown) => void>([
    ["hello", onHello],
    ["navigate", onNavigate],
    ["history", onHistory],
    ["connector-token-ready", onConnectorTokenReady],
  ]);

  // Lắng nghe và kiểm duyệt bảo mật nghiêm ngặt mọi thông điệp postMessage (đúng window.parent, đúng origin, đúng version).
  const onMessage = (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    if (event.origin !== parentOrigin) return;

    const envelope = EnvelopeSchema.safeParse(event.data);
    if (!envelope.success || envelope.data.version !== PREVIEW_BRIDGE_VERSION) return;
    hostMessageHandlers.get(envelope.data.type)?.(event.data);
  };

  const onPopState = () => {
    reportLocation();
  };

  // Same-document `#` navigations fire hashchange, not popstate / pushState.
  const onHashChange = () => {
    reportLocation();
  };

  // Patch history so in-app SPA navigations sync the host address bar.
  // Bước 4: Ghi đè (monkey-patch) pushState và replaceState để tự động đồng bộ URL lên host mỗi khi router SPA chuyển trang.
  window.history.pushState = (data, unused, url) => {
    const next =
      data && typeof data === "object"
        ? { ...data, [ROOT_STATE_KEY]: false }
        : data;
    originalPushState(next, unused, url);
    reportLocation();
  };
  window.history.replaceState = (data, unused, url) => {
    const next =
      isAtHistoryRoot()
        ? {
            ...(data && typeof data === "object" ? data : {}),
            [ROOT_STATE_KEY]: true,
          }
        : data;
    originalReplaceState(next, unused, url);
    reportLocation();
  };

  // Bước 5: Đăng ký các bộ lắng nghe sự kiện trên window và gửi gói tin khởi tạo đầu tiên (announce) tới host.
  window.addEventListener("message", onMessage);
  window.addEventListener("popstate", onPopState);
  window.addEventListener("hashchange", onHashChange);

  announce();

  // Bước 6: Trả về hàm dọn dẹp để gỡ bỏ toàn bộ event listener và khôi phục các hàm History API gốc.
  return () => {
    window.removeEventListener("message", onMessage);
    window.removeEventListener("popstate", onPopState);
    window.removeEventListener("hashchange", onHashChange);
    window.history.pushState = originalPushState;
    window.history.replaceState = originalReplaceState;
  };
}

/** Collect static path patterns from a TanStack route tree (best-effort). */
/**
 * Làm gì: Duyệt đệ quy cây định tuyến (route tree) của TanStack Router để thu thập danh sách tất cả các đường dẫn tĩnh (path patterns).
 * Được gọi ở: src/client/components/preview-host-bridge.tsx (trong callback getRoutePaths truyền vào installPreviewHostBridge).
 * @param routeTree Đối tượng cây định tuyến (routeTree) từ TanStack Router instance.
 * @returns Mảng các chuỗi đường dẫn route tĩnh (ví dụ: ["/", "/login", "/classes"]).
 * @throws Không ném lỗi.
 */
export function collectRoutePathsFromTree(routeTree: unknown): string[] {
  // Bước 1: Khởi tạo Set để lưu trữ danh sách đường dẫn duy nhất, tránh trùng lặp.
  const paths = new Set<string>();

  // Bước 2: Hàm đệ quy duyệt qua từng node và các node con (children) trong cây định tuyến.
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as {
      fullPath?: unknown;
      path?: unknown;
      children?: unknown;
    };
    // Ưu tiên lấy fullPath nếu có, nếu không thì lấy path tương đối.
    const full =
      typeof record.fullPath === "string"
        ? record.fullPath
        : typeof record.path === "string"
          ? record.path
          : null;
    if (full !== null && full !== "") {
      paths.add(full.startsWith("/") ? full : `/${full}`);
    } else if (full === "") {
      paths.add("/");
    }
    const children = record.children;
    if (Array.isArray(children)) {
      for (const child of children) walk(child);
    } else if (children && typeof children === "object") {
      for (const child of Object.values(children as Record<string, unknown>)) {
        walk(child);
      }
    }
  };

  // Bước 3: Bắt đầu duyệt từ node gốc của cây route và chuyển Set thành mảng kết quả.
  walk(routeTree);
  return [...paths];
}
