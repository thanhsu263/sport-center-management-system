/**
 * Dev/preview (Vite) half of the platform PWA chrome: serves the ?install=1
 * tutorial and the per-app manifest, and injects missing PWA head tags into
 * app documents. The deployed-app half lives in server/middleware/grok-pwa.ts;
 * both share scripts/grok-pwa-shared.mjs.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acceptsHtml,
  createHeadInjector,
  injectGrokPwaHead,
  isDocumentPath,
  isInstallQuery,
  readOgSite,
  renderInstallPageHtml,
  renderWebManifest,
  snapshotOgIdentity,
} from "./grok-pwa-shared.mjs";

/**
 * Làm gì: Định danh virtual module ID trong Vite để cung cấp thông tin nhận diện Open Graph (OG identity snapshot) từ lúc build cho server middleware mà không cần đọc ổ đĩa runtime.
 * Được gọi ở: scripts/grok-pwa-plugin.mjs (resolveId, load) và server/middleware/grok-pwa.ts
 */
export const GROK_OG_IDENTITY_ID = "virtual:grok-og-identity";

// Đường dẫn tuyệt đối đến tệp template HTML giao diện hướng dẫn cài đặt PWA (install-page.html)
const INSTALL_PAGE_PATH = join(dirname(fileURLToPath(import.meta.url)), "install-page.html");

/**
 * Làm gì: Trích xuất tên host từ HTTP request headers, ưu tiên header proxy x-forwarded-host, sau đó đến host hoặc :authority (HTTP/2).
 * Được gọi ở: scripts/grok-pwa-plugin.mjs (trong các hàm serveGrokPwa và wrapHtmlResponses)
 * - Tham số req: Đối tượng HTTP request của Node.js (http.IncomingMessage)
 * - Trả về: Chuỗi tên host đại diện cho request hoặc undefined nếu không tìm thấy
 */
function requestHost(req) {
  const forwarded = req.headers["x-forwarded-host"];
  const host = forwarded ?? req.headers.host ?? req.headers[":authority"];
  return Array.isArray(host) ? host[0] : host;
}

/**
 * Làm gì: Đọc tệp template install-page.html và điền các giá trị host, tên app cùng URL hiện tại để sinh mã HTML trang hướng dẫn cài đặt PWA.
 * Được gọi ở: scripts/grok-pwa-plugin.mjs (hàm serveGrokPwa) và scripts/grok-pwa-plugin.test.mjs
 * - Tham số hostHeader: Giá trị Host header trích xuất từ request của client
 * - Tham số url: Đường dẫn URL hiện tại của request (mặc định là "/")
 * - Trả về: Chuỗi HTML hoàn chỉnh của trang hướng dẫn cài đặt PWA
 * - Lỗi có thể ném: Error nếu tệp template INSTALL_PAGE_PATH không tồn tại hoặc không đọc được
 */
export function renderInstallPage(hostHeader, url = "/") {
  const template = readFileSync(INSTALL_PAGE_PATH, "utf8");
  return renderInstallPageHtml(template, { host: hostHeader, url });
}

/**
 * Làm gì: Gửi phản hồi HTTP 200 chứa nội dung HTML với đầy đủ headers chuẩn (content-type, cache-control: no-cache, content-length) và kết thúc response.
 * Được gọi ở: scripts/grok-pwa-plugin.mjs (hàm serveGrokPwa khi trả về trang install page)
 * - Tham số res: Đối tượng HTTP response của Node.js (http.ServerResponse)
 * - Tham số html: Chuỗi mã HTML cần gửi về cho client
 * - Trả về: void
 */
function sendHtml(res, html) {
  const body = Buffer.from(html, "utf8");
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("content-length", String(body.byteLength));
  res.end(body);
}

/**
 * Làm gì: Đăng ký middleware xử lý các route PWA chuyên biệt trong môi trường dev/preview của Vite, bao gồm web manifest (/__grok/manifest.webmanifest) và trang hướng dẫn cài đặt (?install=1).
 * Được gọi ở: scripts/grok-pwa-plugin.mjs (trong grokPwaPlugin.configureServer và grokPwaPlugin.configurePreviewServer)
 * - Tham số middlewares: Bộ middleware Connect của Vite dev/preview server (server.middlewares)
 * - Tham số cwd: Đường dẫn thư mục gốc của dự án
 * - Trả về: void
 */
function serveGrokPwa(middlewares, cwd) {
  middlewares.use((req, res, next) => {
    const rawUrl = req.url ?? "";
    const pathOnly = rawUrl.split("?", 1)[0] ?? "";
    const method = (req.method ?? "GET").toUpperCase();
    // Bước 1: Chỉ xử lý phương thức GET vì manifest và trang cài đặt chỉ phục vụ truy vấn tài nguyên.
    if (method !== "GET") {
      next();
      return;
    }

    // Bước 2: Phục vụ Web App Manifest động theo host và metadata của site, đảm bảo PWA hiển thị đúng tên app và icon.
    if (pathOnly === "/__grok/manifest.webmanifest" || pathOnly === "/__grok/manifest.json") {
      const body = Buffer.from(renderWebManifest(requestHost(req), readOgSite(cwd)), "utf8");
      res.statusCode = 200;
      res.setHeader("content-type", "application/manifest+json; charset=utf-8");
      res.setHeader("cache-control", "no-cache");
      res.setHeader("content-length", String(body.byteLength));
      res.end(body);
      return;
    }

    // Bước 3: Phục vụ trang hướng dẫn cài đặt PWA nếu URL chứa query ?install=1 trên trang tài liệu HTML.
    if (isInstallQuery(rawUrl) && isDocumentPath(pathOnly) && acceptsHtml(req.headers.accept)) {
      try {
        sendHtml(res, renderInstallPage(requestHost(req), rawUrl));
      } catch (err) {
        console.error("[app-builder] install page missing:", err);
        res.statusCode = 500;
        res.end("install page unavailable");
      }
      return;
    }

    // Bước 4: Chuyển tiếp request cho các middleware tiếp theo nếu không khớp các endpoint PWA trên.
    next();
  });
}

/**
 * Wrap res.write/res.end on app-document requests to inject missing PWA head
 * tags at the `</head>` boundary as chunks stream through (no full-document
 * buffering, so streaming SSR keeps its early flush). Skips anything already
 * content-encoded: under `vite preview` the compression middleware can hand
 * this wrapper gzipped bytes, which must pass through untouched.
 */
function wrapHtmlResponses(middlewares, cwd) {
  middlewares.use((req, res, next) => {
    const rawUrl = req.url ?? "";
    const pathOnly = rawUrl.split("?", 1)[0] ?? "";
    const method = (req.method ?? "GET").toUpperCase();
    // Bước 1: Kiểm tra xem request có phải là trang tài liệu HTML hay không (GET, header accept chứa text/html, không chứa ?install=1 và là document path).
    const looksLikeDocument =
      method === "GET" &&
      String(req.headers.accept ?? "").includes("text/html") &&
      !isInstallQuery(rawUrl) &&
      isDocumentPath(pathOnly);
    // Bỏ qua và chuyển tiếp ngay nếu không phải request tài liệu HTML để không ảnh hưởng đến API hay static assets.
    if (!looksLikeDocument) {
      next();
      return;
    }

    // Bước 2: Lưu lại hàm write/end gốc của response và khởi tạo bộ chèn thẻ head (head injector) theo host cùng thư mục dự án.
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const host = requestHost(req);
    const injector = createHeadInjector({
      host,
      cwd,
    });
    let mode = null; // null = undecided, "inject" | "passthrough"

    // Bước 3: Xác định chế độ xử lý response (chỉ chèn thẻ nếu là HTML chưa bị nén; nếu đã bị mã hóa content-encoding thì cho dữ liệu đi qua nguyên vẹn).
    const decideMode = () => {
      if (mode) return mode;
      const isHtml = String(res.getHeader("content-type") ?? "").includes("text/html");
      const encoded = Boolean(res.getHeader("content-encoding"));
      mode = isHtml && !encoded ? "inject" : "passthrough";
      // Streaming SSR flushes headers before the first body chunk, so the
      // header may no longer be removable — chunked responses don't carry one.
      if (mode === "inject" && !res.headersSent) res.removeHeader("content-length");
      return mode;
    };

    // Chuyển đổi dữ liệu chunk nhận được (chuỗi hoặc Buffer) về Buffer tiêu chuẩn để bộ injector xử lý stream.
    const toBuffer = (chunk, encoding) => {
      if (Buffer.isBuffer(chunk)) return chunk;
      if (typeof chunk === "string") {
        return Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8");
      }
      return Buffer.from(chunk);
    };

    // Bước 4: Ghi đè hàm res.write để đẩy từng chunk qua injector, tìm thẻ đóng </head> và chèn các thẻ PWA/OG trước khi gửi ra client.
    res.write = (chunk, encoding, cb) => {
      if (decideMode() === "passthrough") return originalWrite(chunk, encoding, cb);
      const done = typeof encoding === "function" ? encoding : cb;
      if (chunk) {
        for (const out of injector.push(toBuffer(chunk, encoding))) originalWrite(out);
      }
      if (typeof done === "function") done();
      return true;
    };

    // Bước 5: Ghi đè hàm res.end để xả (flush) nốt phần đệm còn lại của injector trước khi kết thúc response.
    res.end = (chunk, encoding, cb) => {
      const done = typeof encoding === "function" ? encoding : cb;
      if (decideMode() === "passthrough") return originalEnd(chunk, encoding, cb);
      if (chunk) {
        for (const out of injector.push(toBuffer(chunk, encoding))) originalWrite(out);
      }
      for (const out of injector.flush()) originalWrite(out);
      return originalEnd(undefined, undefined, done);
    };

    // Chuyển quyền xử lý cho middleware tiếp theo trong pipeline của Vite để bắt đầu sinh response.
    next();
  });
}

/**
 * Làm gì: Khởi tạo plugin Vite cho PWA và Open Graph, hỗ trợ đóng gói virtual module nhận diện OG, biến đổi index.html và đăng ký middleware chèn thẻ PWA cho cả dev server lẫn preview server.
 * Được gọi ở: vite.config.ts (mảng plugins trong cấu hình Vite)
 * - Trả về: Đối tượng Vite plugin (Plugin) chứa các hook configResolved, resolveId, load, transformIndexHtml, configureServer và configurePreviewServer
 */
export function grokPwaPlugin() {
  let root = process.cwd();
  return {
    name: "app-builder:grok-pwa",
    // Lưu lại đường dẫn thư mục gốc đã được Vite giải quyết (resolved root directory)
    configResolved(config) {
      root = config.root;
    },
    // Nhận diện virtual module ID để Vite xử lý nội bộ, không tìm kiếm file thật trên ổ đĩa
    resolveId(id) {
      if (id === GROK_OG_IDENTITY_ID) return `\0${GROK_OG_IDENTITY_ID}`;
    },
    // Sinh mã nguồn cho virtual module: chụp nhanh thông tin OG (site.json, ảnh preview) thành object tĩnh lúc build
    load(id) {
      if (id !== `\0${GROK_OG_IDENTITY_ID}`) return;
      return `export const grokOgIdentity = ${JSON.stringify(snapshotOgIdentity(root))};`;
    },
    // Chèn các thẻ PWA và Open Graph vào mã HTML tĩnh khi build hoặc phục vụ trang SPA
    transformIndexHtml(html) {
      return injectGrokPwaHead(html, {
        host: process.env.VITE_PUBLIC_HOSTNAME ?? "",
        cwd: root,
      });
    },
    configureServer(server) {
      // Registered directly (not in a returned post-hook) so both run BEFORE
      // TanStack Start's SSR middleware, like the auth-popup plugin.
      serveGrokPwa(server.middlewares, root);
      wrapHtmlResponses(server.middlewares, root);
    },
    configurePreviewServer(server) {
      serveGrokPwa(server.middlewares, root);
      // Post-hook: preview registers compression between the direct hooks and
      // the post-hooks, and the injector must wrap AFTER compression so it
      // sees plaintext HTML (compression then compresses the injected output).
      return () => {
        wrapHtmlResponses(server.middlewares, root);
      };
    },
  };
}
