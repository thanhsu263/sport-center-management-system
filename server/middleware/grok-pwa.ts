/**
 * Deployed-app (Nitro) half of the platform PWA chrome. Auto-registered as
 * global h3 middleware because vite.config.ts sets `serverDir: "./server"` —
 * without that option Nitro v3 never scans this directory.
 *
 * - `?install=1&platform=ios` on a document path → the Home Screen tutorial,
 *   bundled into the server build via `?raw` (the public/ directory is CDN
 *   static output on Vercel and not readable from the function).
 * - `/__grok/manifest.webmanifest` → per-app-named manifest (kept out of
 *   public/ so this dynamic response is the only one).
 * - Other HTML documents → stream-inject PWA + OG head tags at `</head>`.
 *   OG identity is baked via `virtual:grok-og-identity` at `vite build`
 *   (this function cannot read `src/server/og/site.json` or `public/og.jpg`).
 *   This must be a middleware transforming `next()`: h3 discards the `response`
 *   runtime hook's return value, and `render:html` does not exist in Nitro v3.
 */
import installPageTemplate from "../../scripts/install-page.html?raw";
import { grokOgIdentity } from "virtual:grok-og-identity";
import {
  acceptsHtml,
  createHeadInjector,
  isDocumentPath,
  isInstallQuery,
  renderInstallPageHtml,
  renderWebManifest,
} from "../../scripts/grok-pwa-shared.mjs";

interface GrokPwaEvent {
  url: URL;
  req: { method: string; headers: Headers };
}

/**
 * Làm gì: Trích xuất hostname của request hiện tại theo thứ tự ưu tiên: header x-forwarded-host (khi đứng sau reverse proxy như Vercel), header host tiêu chuẩn, hoặc fallback về hostname từ URL.
 * Được gọi ở: server/middleware/grok-pwa.ts (hàm grokPwaMiddleware tại các dòng xử lý manifest, install page và chèn head tag).
 * @param event Đối tượng sự kiện request của Nitro/h3 chứa URL và HTTP headers
 * @returns Chuỗi tên miền hostname của request
 */
function requestHost(event: GrokPwaEvent): string {
  // Ưu tiên x-forwarded-host khi đứng sau reverse proxy (như Vercel/Cloudflare) để lấy đúng tên miền người dùng truy cập.
  return (
    event.req.headers.get("x-forwarded-host") ?? event.req.headers.get("host") ?? event.url.host
  );
}

/**
 * Làm gì: Chèn các thẻ PWA và Open Graph vào luồng stream HTML của phản hồi SSR bằng TransformStream mà không chặn luồng tải trang, đồng thời xóa header content-length do kích thước body bị thay đổi.
 * Được gọi ở: server/middleware/grok-pwa.ts (hàm grokPwaMiddleware).
 * @param response Phản hồi HTTP gốc (chứa body dạng ReadableStream) trả về từ tầng ứng dụng
 * @param host Tên miền của request hiện tại để sinh các URL tuyệt đối cho thẻ Open Graph
 * @returns Phản hồi Response mới với body dạng stream đã được chèn thẻ meta
 */
function injectHeadStreaming(response: Response, host: string): Response {
  // Bước 1: Khởi tạo bộ chèn thẻ head dạng streaming với thông tin host và cấu hình site đã bake lúc build.
  const injector = createHeadInjector({
    host,
    site: grokOgIdentity.site,
  });
  // Bước 2: Pipe body qua TransformStream để chèn thẻ meta ngay khi gặp thẻ đóng </head> mà không làm gián đoạn luồng stream SSR.
  const transformed = response.body!.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (const out of injector.push(chunk)) controller.enqueue(out);
      },
      flush(controller) {
        for (const out of injector.flush()) controller.enqueue(out);
      },
    }),
  );
  // Bước 3: Sao chép headers và xóa content-length vì việc chèn thêm thẻ HTML làm thay đổi kích thước phản hồi ban đầu, tránh lỗi truyền dữ liệu.
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  // Bước 4: Tạo Response mới với body dạng stream đã được biến đổi, giữ nguyên status và headers.
  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Làm gì: Middleware toàn cục của Nitro (h3) xử lý PWA trên môi trường production: phục vụ web app manifest động, trả về trang hướng dẫn cài đặt iOS khi có tham số ?install=1, và chèn thẻ PWA/Open Graph vào tài liệu HTML dạng stream.
 * Được gọi ở: Nitro / h3 framework (tự động đăng ký qua cấu hình serverDir trong vite.config.ts cho mọi request).
 * @param event Đối tượng sự kiện request của Nitro/h3 chứa URL và HTTP headers
 * @param next Hàm chuyển tiếp request đến middleware hoặc route handler tiếp theo trong chuỗi xử lý
 * @returns Phản hồi HTTP Response (manifest, trang install HTML, hoặc response đã chèn head tags), hoặc kết quả từ handler tiếp theo
 */
export default async function grokPwaMiddleware(
  event: GrokPwaEvent,
  next: () => unknown | Promise<unknown>,
): Promise<unknown> {
  // Bước 1: Chỉ xử lý request HTTP GET; bỏ qua các method khác (POST, PUT, DELETE,...) và chuyển tiếp ngay cho handler tiếp theo.
  const method = (event.req.method ?? "GET").toUpperCase();
  if (method !== "GET") return next();

  // Lấy đường dẫn pathname và URL kèm query string của request.
  const path = event.url.pathname;
  const urlWithQuery = path + event.url.search;

  // Bước 2: Xử lý request lấy manifest PWA động (/manifest.webmanifest hoặc /manifest.json), sinh JSON manifest theo tên app và cấu hình site; dùng cache-control: no-cache để client luôn cập nhật mới nhất.
  if (path === "/__grok/manifest.webmanifest" || path === "/__grok/manifest.json") {
    return new Response(renderWebManifest(requestHost(event), grokOgIdentity.site), {
      headers: {
        "content-type": "application/manifest+json; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  }

  // Bước 3: Kiểm tra nếu URL chứa query cài đặt (?install=1&platform=ios), là đường dẫn trang tài liệu và client chấp nhận HTML thì trả về trang hướng dẫn cài đặt iOS (Home Screen tutorial).
  if (
    isInstallQuery(urlWithQuery) &&
    isDocumentPath(path) &&
    acceptsHtml(event.req.headers.get("accept"))
  ) {
    // Điền tên app và URL khởi chạy vào template HTML hướng dẫn cài đặt rồi trả về response với cache-control: no-cache.
    const html = renderInstallPageHtml(installPageTemplate, {
      host: requestHost(event),
      url: urlWithQuery,
    });
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  }

  // Bước 4: Bỏ qua các tài nguyên tĩnh (.js, .css, ảnh,...), module nội bộ và API routes; chỉ xử lý các request tải tài liệu HTML.
  if (!isDocumentPath(path)) return next();

  // Bước 5: Gọi next() để lấy phản hồi từ route handler hoặc trang SSR phía sau.
  const result = await next();
  // Bước 6: Kiểm tra nếu kết quả là Response HTML hợp lệ và chưa bị nén (không có content-encoding như gzip/brotli thì mới tìm được thẻ </head> dạng text thô).
  if (
    result instanceof Response &&
    result.body &&
    String(result.headers.get("content-type") ?? "").includes("text/html") &&
    !result.headers.get("content-encoding")
  ) {
    // Chèn các thẻ head dạng stream và trả về Response đã được biến đổi.
    return injectHeadStreaming(result, requestHost(event));
  }
  // Trả về kết quả nguyên bản nếu không phải là phản hồi HTML cần can thiệp.
  return result;
}
