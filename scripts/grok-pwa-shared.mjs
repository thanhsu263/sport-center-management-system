/**
 * Single source of truth for platform head chrome (PWA, extensions.js, OG),
 * shared by the Vite plugin and Nitro middleware. Plain ESM so `node --test`
 * and the Nitro bundler can both consume it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Làm gì: Tên ứng dụng mặc định ("Grok App") dùng làm giá trị dự phòng (fallback) khi
 *   không xác định được tên ứng dụng từ subdomain grok.me hoặc file cấu hình site.json.
 * Được gọi ở: scripts/grok-pwa-shared.mjs (appNameFromHost, renderWebManifest, grokPwaHeadTags, resolveOgTitle).
 */
export const DEFAULT_APP_NAME = "Grok App";
/**
 * Làm gì: URL mặc định của dịch vụ Open Graph (og.grok.me) dùng để tự động tạo ảnh
 *   thẻ chia sẻ (OG card placeholder) khi ứng dụng chưa có file ảnh og.jpg hoặc og.png tùy biến riêng.
 * Được gọi ở: scripts/grok-pwa-shared.mjs (hàm ogServiceUrl).
 */
export const OG_SERVICE_URL_DEFAULT = "https://og.grok.me";
/**
 * Làm gì: Đường dẫn tương đối từ thư mục gốc dự án đến file cấu hình site.json,
 *   nơi khai báo thông tin thương hiệu ứng dụng (tiêu đề, màu sắc, ảnh card, banner).
 * Được gọi ở: scripts/grok-pwa-shared.mjs (readOgSite), scripts/brand-check.mjs (brandCheck).
 */
export const OG_SITE_REL_PATH = "src/server/og/site.json";

const SHARE_META_KEYS = new Set([
  "og:title",
  "og:description",
  "og:image",
  "og:image:width",
  "og:image:height",
  "og:type",
  "og:url",
  "og:site_name",
  "twitter:card",
  "twitter:title",
  "twitter:image",
  "twitter:description",
  "x:game:image",
  "x:game:image:width",
  "x:game:image:height",
]);

/**
 * Làm gì: Mã hóa các ký tự đặc biệt trong chuỗi (&, <, >, ", ') thành các HTML entity tương ứng,
 *   giúp ngăn ngừa lỗ hổng XSS khi chèn giá trị động vào các thẻ meta và HTML template.
 * Được gọi ở: scripts/grok-pwa-shared.mjs (renderInstallPageHtml, grokPwaHeadTags, grokExtensionsHeadTags, grokOgHeadTags).
 * - Tham số value: Giá trị bất kỳ cần mã hóa (được ép kiểu sang chuỗi).
 * - Trả về: Chuỗi đã được mã hóa an toàn để chèn vào mã HTML.
 */
export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Inverse of escapeHtml. Decode &amp; last so a single pass undoes one encode. */
function unescapeHtml(value) {
  return String(value)
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

/** 6-digit hex for the og.grok.me placeholder, or "" if site.color is missing/invalid. */
function placeholderCardColor(site = {}) {
  const raw = String(site.color ?? "").trim();
  const hex = raw.startsWith("#") ? raw.slice(1) : raw;
  return /^[0-9a-fA-F]{6}$/.test(hex) ? hex : "";
}

/**
 * "wild-race.grok.me" → "Wild Race". Only published app hosts encode the
 * display name in the first label. Preview / guest hosts are image origins
 * only — slugifying them produced internal names like "Hds Abc 3000 Xy".
 */
export function appNameFromHost(hostHeader) {
  // Bước 1: Chuẩn hóa header host — lấy host đầu tiên nếu qua nhiều proxy, cắt bỏ port và chuyển về chữ thường.
  const host = String(hostHeader ?? "")
    .split(",")[0]
    .trim()
    .split(":")[0]
    .toLowerCase();
  // Bước 2: Chỉ app đã publish lên grok.me mới chứa tên app ở subdomain; các host khác (preview, localhost) dùng tên mặc định.
  if (!host.endsWith(".grok.me")) {
    return DEFAULT_APP_NAME;
  }
  // Bước 3: Tách lấy slug (subdomain đầu tiên) và kiểm tra tính hợp lệ (độ dài tối đa 63 ký tự theo chuẩn DNS, bỏ qua subdomain 'www').
  const slug = host.split(".")[0] ?? "";
  if (!slug || slug === "www" || !/^[a-z0-9-]{1,63}$/.test(slug)) {
    return DEFAULT_APP_NAME;
  }
  // Bước 4: Chuyển đổi slug từ dạng kebab-case sang Title Case (ví dụ: "wild-race" -> "Wild Race").
  return (
    slug
      .split("-")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || DEFAULT_APP_NAME
  );
}

/** True for Vercel system domains. Envoy rewrites origin Host to these; they SSO-protect `/og.jpg`. */
function isVercelSystemHost(host) {
  return (
    host === "vercel.app" ||
    host.endsWith(".vercel.app") ||
    host === "vercel.com" ||
    host.endsWith(".vercel.com")
  );
}

/** Hostname suitable for absolute og:image URLs. Preview guests (X-Forwarded-Host) are allowed. */
export function publicAppHost(hostHeader) {
  // Bước 1: Chuẩn hóa host header, loại bỏ port và lấy IP/domain đầu tiên nếu có proxy forward.
  const host = String(hostHeader ?? "")
    .split(",")[0]
    .trim()
    .split(":")[0]
    .toLowerCase();
  // Bước 2: Kiểm tra host hợp lệ — phải chứa dấu chấm, không được là IP thô hoặc domain nội bộ Vercel (bị chặn SSO làm hỏng ảnh og:image).
  if (!host || !/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) return "";
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return "";
  if (isVercelSystemHost(host)) return "";
  return host;
}

/**
 * Published apps always use `VITE_PUBLIC_HOSTNAME` (the grok.me host the
 * deployer injects). Live preview has no such env, so fall back to the
 * request host / X-Forwarded-Host. Never prefer request Host on a published
 * app — Envoy rewrites it to `*.vercel.app`.
 */
export function resolvePublicHost(hostHeader) {
  // Ưu tiên VITE_PUBLIC_HOSTNAME khi đã deploy (tránh bị Envoy proxy đổi thành vercel.app); fallback sang request host khi ở preview.
  return (
    publicAppHost(process.env?.VITE_PUBLIC_HOSTNAME) || publicAppHost(hostHeader)
  );
}

/**
 * Làm gì: Kiểm tra xem URL request có chứa tham số yêu cầu hiển thị trang hướng dẫn
 *   cài đặt PWA lên màn hình chính cho hệ điều hành iOS (?install=1&platform=ios) hay không.
 * Được gọi ở: scripts/grok-pwa-plugin.mjs (serveGrokPwa), server/middleware/grok-pwa.ts (grokPwaMiddleware).
 * - Tham số url: Chuỗi URL hoặc request path cần kiểm tra query parameters.
 * - Trả về: true nếu thỏa mãn cả hai điều kiện install=(1|true) và platform=ios; ngược lại false.
 */
export function isInstallQuery(url) {
  // Bước 1: Tách lấy phần query string phía sau dấu chấm hỏi và parse các tham số URLSearchParams.
  const query = String(url ?? "").split("?", 2)[1] ?? "";
  const params = new URLSearchParams(query);
  const install = params.get("install");
  const platform = (params.get("platform") ?? "").toLowerCase();
  // Bước 2: Kiểm tra cả hai điều kiện: cờ cài đặt (install) được bật và nền tảng đích là thiết bị iOS.
  return (install === "1" || install === "true") && platform === "ios";
}

/** Paths that can carry an app document (vs assets / API / internals). */
export function isDocumentPath(pathname) {
  const path = String(pathname ?? "");
  // Lọc bỏ các tài nguyên tĩnh, API endpoint, module nội bộ của Vite/Node và các file có phần mở rộng (ví dụ: .js, .css, .png).
  return (
    !path.startsWith("/__grok/") &&
    !path.startsWith("/api/") &&
    !path.startsWith("/@") &&
    !path.startsWith("/node_modules") &&
    !/\.[a-z0-9]+$/i.test(path)
  );
}

export function acceptsHtml(accept) {
  const value = String(accept ?? "");
  return value === "" || value.includes("text/html") || value.includes("*/*");
}

/** The same URL without the install-tutorial params (used as the app link). */
export function stripInstallParams(url) {
  // Tách URL thành pathname và search params, xóa 2 param 'install' và 'platform' để tạo URL đích mở app thật.
  const [path = "/", query = ""] = String(url ?? "/").split("?", 2);
  const params = new URLSearchParams(query);
  params.delete("install");
  params.delete("platform");
  const rest = params.toString();
  return rest ? `${path}?${rest}` : path;
}

/**
 * Làm gì: Điền tên ứng dụng và URL khởi chạy vào template HTML hướng dẫn cài đặt PWA
 *   trên màn hình chính iOS (Home Screen tutorial), đồng thời escape dữ liệu để chống XSS.
 * Được gọi ở: scripts/grok-pwa-plugin.mjs (renderInstallPage), server/middleware/grok-pwa.ts (grokPwaMiddleware).
 * - Tham số template: Nội dung file HTML template mẫu (chứa các placeholder {{APP_NAME}} và {{APP_URL}}).
 * - Tham số options: Object chứa hostHeader và url hiện tại của request.
 * - Trả về: Chuỗi HTML hoàn chỉnh sẵn sàng gửi về cho trình duyệt người dùng.
 */
export function renderInstallPageHtml(template, { host, url } = {}) {
  return String(template)
    .replaceAll("{{APP_NAME}}", escapeHtml(appNameFromHost(host)))
    .replaceAll("{{APP_URL}}", escapeHtml(stripInstallParams(url)));
}

/** A `#rrggbb` from site.json, or "" when the field is missing or malformed. */
function siteHex(site, key) {
  const raw = String(site?.[key] ?? "").trim();
  const hex = raw.startsWith("#") ? raw.slice(1) : raw;
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : "";
}

/**
 * The installed-app identity.
 *
 * `site` is threaded in rather than read from disk because the deployed half
 * of this runs as a Vercel function with no workspace to read — Nitro passes
 * the copy baked at build time by `snapshotOgIdentity`.
 *
 * A published `*.grok.me` host still names the app, as it always has. Every
 * other host — a custom domain, a `*.vercel.app` deploy — used to fall all the
 * way through to "Grok App" on a black splash, so an app that says Arena3
 * everywhere else introduced itself as somebody else's on the home screen.
 */
export function renderWebManifest(hostHeader, site = readOgSite()) {
  // Bước 1: Quyết định tên app — ưu tiên tên trích xuất từ host grok.me, sau đó đến site.title từ site.json, cuối cùng là DEFAULT_APP_NAME.
  const fromHost = appNameFromHost(hostHeader);
  const name =
    fromHost !== DEFAULT_APP_NAME
      ? fromHost
      : String(site?.title ?? "").trim() || DEFAULT_APP_NAME;
  // Bước 2: Lấy mã màu theme (theme_color) và màu nền splash screen từ cấu hình site.json (mặc định đen #000000).
  const theme = siteHex(site, "color") || "#000000";
  // Bước 3: Tạo và định dạng JSON cho file Web App Manifest (display standalone để mở app không có thanh điều hướng trình duyệt).
  return JSON.stringify(
    {
      name,
      short_name: name,
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: siteHex(site, "background") || theme,
      theme_color: theme,
      icons: [
        {
          src: "/__grok/icon-180.png",
          sizes: "180x180",
          type: "image/png",
        },
      ],
    },
    null,
    2,
  );
}

/**
 * Làm gì: Sinh danh sách các thẻ HTML trong thẻ <head> phục vụ tính năng PWA (manifest, icon, tiêu đề trên iOS, thanh trạng thái).
 * Được gọi ở: scripts/grok-pwa-shared.mjs (hàm injectGrokPwaHead).
 * - Tham số appName: Tên ứng dụng hiển thị trên màn hình chính khi người dùng cài đặt PWA (mặc định DEFAULT_APP_NAME).
 * - Trả về: Mảng các cặp [key, htmlTag] đại diện cho từng thẻ meta/link của PWA cần chèn.
 */
export function grokPwaHeadTags(appName = DEFAULT_APP_NAME) {
  return [
    // Standalone display comes from the manifest ("display": "standalone");
    // the legacy *-web-app-capable metas it replaces are deliberately absent.
    ["manifest", '<link rel="manifest" href="/__grok/manifest.webmanifest">'],
    ["apple-touch-icon", '<link rel="apple-touch-icon" href="/__grok/icon-180.png">'],
    [
      "apple-mobile-web-app-title",
      `<meta name="apple-mobile-web-app-title" content="${escapeHtml(appName)}">`,
    ],
    [
      "apple-mobile-web-app-status-bar-style",
      '<meta name="apple-mobile-web-app-status-bar-style" content="black">',
    ],
    ["theme-color", '<meta name="theme-color" content="#000000">'],
  ];
}

/**
 * Làm gì: Địa chỉ URL của script extensions nền tảng Grok (hiển thị banner "Created with Grok / Remix" và cầu nối giao tiếp với chat preview).
 * Được gọi ở: scripts/grok-pwa-shared.mjs (hàm grokExtensionsHeadTags).
 */
export const GROK_EXTENSIONS_SCRIPT_SRC = "https://grok.com/grok-app-builder/extensions.js";

/**
 * Làm gì: Đọc mã định danh dự án Grok (project ID) từ biến môi trường VITE_PROJECT_ID nếu đang chạy trong môi trường Node.js.
 * Được gọi ở: scripts/grok-pwa-shared.mjs (grokExtensionsHeadTags, normalizeHeadContext).
 * - Trả về: Chuỗi ID dự án đã được cắt bỏ khoảng trắng thừa, hoặc chuỗi rỗng nếu không có.
 */
export function readGrokProjectId() {
  const fromProcess = typeof process !== "undefined" ? process.env?.VITE_PROJECT_ID : "";
  return String(fromProcess ?? "").trim();
}

/**
 * Làm gì: Đọc username tài khoản X (Twitter) của tác giả ứng dụng từ biến môi trường X_CREATOR.
 * Được gọi ở: scripts/grok-pwa-shared.mjs (grokXCreatorHeadTags, normalizeHeadContext).
 * - Trả về: Tên tài khoản X (handle) của tác giả, hoặc chuỗi rỗng nếu chưa thiết lập.
 */
export function readXCreator() {
  const fromProcess = typeof process !== "undefined" ? process.env?.X_CREATOR : "";
  return String(fromProcess ?? "").trim();
}

/**
 * Làm gì: Đọc mã số định danh ID duy nhất của tác giả trên nền tảng X từ biến môi trường X_CREATOR_ID.
 * Được gọi ở: scripts/grok-pwa-shared.mjs (grokXCreatorHeadTags, normalizeHeadContext).
 * - Trả về: Chuỗi ID số của tài khoản X tác giả, hoặc chuỗi rỗng nếu chưa thiết lập.
 */
export function readXCreatorId() {
  const fromProcess = typeof process !== "undefined" ? process.env?.X_CREATOR_ID : "";
  return String(fromProcess ?? "").trim();
}

/**
 * Làm gì: Tạo các thẻ meta gắn quyền tác giả trên mạng xã hội X (x:creator và x:creator:id) khi chia sẻ liên kết.
 * Được gọi ở: scripts/grok-pwa-shared.mjs (hàm injectGrokPwaHead), scripts/grok-pwa-plugin.test.mjs.
 * - Tham số creator: Tên username tài khoản X của tác giả (mặc định lấy từ readXCreator).
 * - Tham số creatorId: Mã ID người dùng X của tác giả (mặc định lấy từ readXCreatorId).
 * - Trả về: Mảng các thẻ meta HTML nếu có đủ cả name và id; ngược lại trả về mảng rỗng.
 */
export function grokXCreatorHeadTags(creator = readXCreator(), creatorId = readXCreatorId()) {
  const name = String(creator ?? "").trim();
  const id = String(creatorId ?? "").trim();
  // Bắt buộc phải có cả tên username và ID người dùng thì mới tạo thẻ; thiếu một trong hai sẽ trả về mảng rỗng để tránh metadata không hợp lệ.
  if (!name || !id) return [];
  return [
    `<meta property="x:creator" content="${escapeHtml(name)}">`,
    `<meta property="x:creator:id" content="${escapeHtml(id)}">`,
  ];
}

/** Platform "Created with Grok" banner — injected into every HTML document. */
export function grokExtensionsHeadTags(projectId = readGrokProjectId()) {
  // Bước 1: Escape mã dự án để chống tấn công XSS khi chèn vào attribute của thẻ script/meta.
  const id = escapeHtml(projectId);
  const tags = [];
  // Bước 2: Nếu có projectId thì chèn thêm thẻ meta nhận diện; script extensions.js luôn được thêm với cờ defer để không chặn tải trang.
  if (projectId) {
    tags.push(`<meta name="grok-project-id" content="${id}">`);
  }
  tags.push(
    `<script src="${GROK_EXTENSIONS_SCRIPT_SRC}"${
      projectId ? ` data-project-id="${id}"` : ""
    } defer></script>`,
  );
  return tags;
}

/**
 * Làm gì: Đọc và phân tích cú pháp file cấu hình site.json từ ổ đĩa tại thư mục làm việc,
 *   chứa các thông tin cấu hình thương hiệu như tiêu đề, màu sắc, ảnh card và banner.
 * Được gọi ở: scripts/grok-pwa-shared.mjs (renderWebManifest, snapshotOgIdentity), scripts/brand-check.mjs, scripts/grok-pwa-plugin.mjs.
 * - Tham số cwd: Thư mục làm việc gốc (mặc định process.cwd()).
 * - Trả về: Object dữ liệu cấu hình đã parse, hoặc object rỗng {} nếu file không tồn tại hoặc lỗi cú pháp JSON.
 */
export function readOgSite(cwd = process.cwd()) {
  try {
    // Bước 1: Đọc nội dung file site.json đồng bộ từ thư mục gốc dự án.
    const raw = readFileSync(join(cwd, OG_SITE_REL_PATH), "utf8");
    // Bước 2: Parse chuỗi JSON và kiểm tra tính hợp lệ (phải là plain object, không phải null hay mảng).
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  // Bước 3: Bắt lỗi an toàn (ví dụ file chưa được tạo hoặc JSON sai cú pháp), luôn trả về object rỗng để không làm crash luồng xử lý.
  } catch {
    return {};
  }
}

/** Public path of an on-disk share card, or "" if neither file exists. */
/*
 * Làm gì: Kiểm tra sự tồn tại của file ảnh thẻ chia sẻ (share card) trên ổ đĩa trong thư mục public/ (ưu tiên og.jpg rồi đến og.png) và trả về đường dẫn công khai; trả về chuỗi rỗng "" nếu cả hai file đều không tồn tại.
 * Được gọi ở: scripts/grok-pwa-shared.mjs (trong các hàm detectCustomOgCard, snapshotOgIdentity, customOgAssetPath, resolveOgCardAsset, applyCustomCardFromFs).
 * - Tham số cwd: Đường dẫn thư mục gốc của dự án (mặc định process.cwd()).
 * - Trả về: Đường dẫn công khai "/og.jpg", "/og.png", hoặc "" nếu chưa có file nào trên ổ đĩa.
 */
export function ogCardPublicPath(cwd = process.cwd()) {
  // Ưu tiên kiểm tra file ảnh JPG (chuẩn tối ưu dung lượng của nền tảng).
  if (existsSync(join(cwd, "public/og.jpg"))) return "/og.jpg";
  // Dự phòng kiểm tra định dạng PNG nếu dự án không có file JPG.
  if (existsSync(join(cwd, "public/og.png"))) return "/og.png";
  return "";
}

/**
 * Làm gì: Xác định xem ứng dụng có sử dụng share card tùy chỉnh hay không (ở môi trường dev/preview kiểm tra file thực tế trên ổ đĩa; ở môi trường Vercel production tin tưởng cấu hình card="custom" hoặc image đã được bake lúc build).
 * Được gọi ở: scripts/grok-pwa-shared.mjs (hàm resolveOgCardAsset).
 * - Tham số cwd: Đường dẫn thư mục gốc của dự án (mặc định process.cwd()).
 * - Tham số site: Đối tượng cấu hình từ site.json hoặc snapshot đã bake lúc build.
 * - Trả về: true nếu có share card tùy chỉnh, ngược lại false.
 */
function detectCustomOgCard(cwd = process.cwd(), site = {}) {
  // Nếu tìm thấy file og.jpg hoặc og.png trên ổ đĩa thì chắc chắn ứng dụng dùng custom card.
  if (ogCardPublicPath(cwd)) return true;
  // Vercel runtime has no public/: trust a bake that already saw the file.
  return siteHasCustomCard(site) || Boolean(String(site.image ?? "").trim());
}

/** Snapshot for Vite/Nitro to bake into the server bundle (Vercel has no workspace FS). */
/*
 * Làm gì: Chụp nhanh (snapshot) cấu hình nhận diện Open Graph từ site.json và file thực tế trong public/ để Vite/Nitro đóng gói vào server bundle dưới dạng virtual module, vì hàm serverless trên Vercel không có quyền đọc ổ đĩa workspace.
 * Được gọi ở: scripts/grok-pwa-plugin.mjs (hook load cho virtual:grok-og-identity), scripts/grok-pwa-shared.mjs (normalizeHeadContext), scripts/grok-pwa-plugin.test.mjs ("test runner (node --test)").
 * - Tham số cwd: Đường dẫn thư mục gốc của dự án (mặc định process.cwd()).
 * - Trả về: Object { site } chứa cấu hình site đã chuẩn hóa kèm đường dẫn ảnh share card và banner.
 */
export function snapshotOgIdentity(cwd = process.cwd()) {
  // Bước 1: Đọc cấu hình site.json gốc và kiểm tra file share card thực tế trên ổ đĩa.
  const site = { ...readOgSite(cwd) };
  const disk = ogCardPublicPath(cwd);
  // Bước 2: Nếu có file ảnh trên đĩa, tự động đánh dấu card="custom" và gắn đường dẫn ảnh.
  if (disk) {
    site.card = "custom";
    site.image = disk;
  // Bước 3: Nếu không có file thực tế, dọn dẹp các thuộc tính custom để tránh sinh link ảnh bị 404.
  } else {
    // site.json `card=custom` without a file must not bake a 404 /og.jpg URL.
    if (siteHasCustomCard(site)) delete site.card;
    if (site.image) delete site.image;
  }
  // Bước 4: Tự động bổ sung banner x-banner.jpg vào cấu hình nếu file tồn tại trong public/.
  if (existsSync(join(cwd, "public/x-banner.jpg"))) {
    site.banner = site.banner || "/x-banner.jpg";
  }
  return { site };
}

/**
 * Làm gì: Lấy đường dẫn công khai của file share card tùy chỉnh trên ổ đĩa, hoặc fallback về "/og.jpg" nếu chưa có file nào.
 * Được gọi ở: Các công cụ kiểm tra tài nguyên thương hiệu và kịch bản test ("test runner (node --test)").
 * - Tham số cwd: Đường dẫn thư mục gốc của dự án (mặc định process.cwd()).
 * - Trả về: Đường dẫn công khai tới asset ảnh share card (chuỗi bắt đầu bằng "/").
 */
export function customOgAssetPath(cwd = process.cwd()) {
  return ogCardPublicPath(cwd) || "/og.jpg";
}

/**
 * Làm gì: Lấy URL gốc của dịch vụ sinh ảnh placeholder Open Graph từ biến môi trường VITE_OG_SERVICE_URL hoặc fallback về mặc định "https://og.grok.me", loại bỏ dấu gạch chéo cuối.
 * Được gọi ở: scripts/grok-pwa-shared.mjs (hàm grokOgHeadTags để tạo URL ảnh placeholder).
 * - Trả về: Chuỗi URL chuẩn hóa của service sinh ảnh Open Graph.
 */
export function ogServiceUrl() {
  const fromEnv = String(process.env?.VITE_OG_SERVICE_URL ?? "").trim();
  return (fromEnv || OG_SERVICE_URL_DEFAULT).replace(/\/+$/, "");
}

/**
 * Làm gì: Trích xuất nội dung tiêu đề tài liệu từ thẻ <title>...</title> trong chuỗi HTML và giải mã các ký tự HTML entities (&amp;, &lt;,...).
 * Được gọi ở: scripts/grok-pwa-shared.mjs (hàm injectGrokPwaHead).
 * - Tham số html: Chuỗi mã nguồn HTML của trang tài liệu.
 * - Trả về: Tiêu đề trang đã decode và cắt khoảng trắng, hoặc "" nếu không tìm thấy thẻ title.
 */
export function titleFromDocument(html) {
  const match = String(html ?? "").match(/<title\b[^>]*>([^<]*)<\/title>/i);
  return match ? unescapeHtml(match[1]).trim() : "";
}

/**
 * Làm gì: Xác định tiêu đề hiển thị cho Open Graph theo thứ tự ưu tiên: cấu hình site.title > tiêu đề HTML documentTitle > tên trích xuất từ host appNameFromHost() > tham số appName > mặc định "Grok App".
 * Được gọi ở: scripts/grok-pwa-shared.mjs (các hàm grokOgHeadTags, normalizeHeadContext, injectGrokPwaHead).
 * - Tham số site: Đối tượng cấu hình từ site.json.
 * - Tham số appName: Tên ứng dụng truyền vào (mặc định DEFAULT_APP_NAME).
 * - Tham số host: Giá trị header host của request hiện tại.
 * - Tham số documentTitle: Tiêu đề trích xuất từ thẻ <title> của tài liệu HTML.
 * - Trả về: Chuỗi tiêu đề được chọn có độ ưu tiên cao nhất.
 */
export function resolveOgTitle(
  site = {},
  appName = DEFAULT_APP_NAME,
  host = "",
  documentTitle = "",
) {
  // Bước 1: Ưu tiên cao nhất cho tiêu đề được khai báo tường minh trong site.json.
  const fromSite = String(site.title ?? "").trim();
  if (fromSite) return fromSite;
  // Bước 2: Kế tiếp sử dụng tiêu đề thực tế của trang đọc từ thẻ <title>.
  const fromDoc = String(documentTitle ?? "").trim();
  if (fromDoc) return fromDoc;
  // Bước 3: Phân tích tên ứng dụng từ subdomain grok.me nếu là app đã publish.
  const fromHost = appNameFromHost(host);
  if (fromHost && fromHost !== DEFAULT_APP_NAME) return fromHost;
  // Bước 4: Fallback về tên app được truyền qua tham số hoặc hằng số DEFAULT_APP_NAME.
  const fromArg = String(appName ?? "").trim();
  return fromArg || DEFAULT_APP_NAME;
}

/**
 * Làm gì: Kiểm tra xem đối tượng site có khai báo thuộc tính card là "custom" hay không (không phân biệt hoa thường).
 * Được gọi ở: scripts/brand-check.mjs (hàm brandWarningsOnDisk), scripts/grok-pwa-shared.mjs (các hàm detectCustomOgCard, snapshotOgIdentity).
 * - Tham số site: Đối tượng cấu hình đọc từ site.json hoặc snapshot.
 * - Trả về: true nếu site.card có giá trị "custom", ngược lại false.
 */
export function siteHasCustomCard(site = {}) {
  return String(site.card ?? "").toLowerCase() === "custom";
}

/**
 * Preview: public/og.jpg|png on disk.
 * Vercel: the bake (`card=custom` / `image`) because the function cannot stat public/.
 * Otherwise empty — caller emits the og.grok.me placeholder.
 */
/*
 * Làm gì: Xác định đường dẫn file ảnh share card tùy chỉnh (ưu tiên file trên đĩa /og.jpg, /og.png; trên Vercel lấy từ site.image đã bake); trả về "" nếu dùng ảnh placeholder từ og.grok.me.
 * Được gọi ở: scripts/grok-pwa-shared.mjs (hàm grokOgHeadTags), scripts/grok-pwa-plugin.test.mjs ("test runner (node --test)").
 * - Tham số site: Đối tượng cấu hình từ site.json hoặc snapshot.
 * - Tham số cwd: Thư mục gốc của dự án (mặc định process.cwd()).
 * - Trả về: Đường dẫn công khai tới file ảnh share card, hoặc "" nếu dùng placeholder.
 */
export function resolveOgCardAsset(site = {}, cwd = process.cwd()) {
  return ogCardPublicPath(cwd) || (detectCustomOgCard(cwd, site) ? String(site.image ?? "").trim() || "/og.jpg" : "");
}

/** Stamp `card=custom` when public/og.jpg or public/og.png is on disk. */
/*
 * Làm gì: Gán đè card="custom" và cập nhật đường dẫn image vào đối tượng site nếu tìm thấy file public/og.jpg hoặc public/og.png trên ổ đĩa.
 * Được gọi ở: scripts/grok-pwa-shared.mjs (hàm normalizeHeadContext).
 * - Tham số site: Đối tượng cấu hình site hiện tại.
 * - Tham số cwd: Thư mục gốc của dự án.
 * - Trả về: Bản sao đối tượng site đã cập nhật thông tin custom card nếu có file trên đĩa.
 */
function applyCustomCardFromFs(site, cwd) {
  const disk = ogCardPublicPath(cwd);
  if (!disk) return site;
  return { ...site, card: "custom", image: disk };
}

/**
 * Làm gì: Sinh danh sách các chuỗi thẻ HTML <meta> chuẩn Open Graph và Twitter Card (og:title, og:image 1200x630, twitter:card, og:description, x:game:image 1200x264 cho game trên X) dựa theo cấu hình site và host công khai.
 * Được gọi ở: scripts/grok-pwa-shared.mjs (hàm injectGrokPwaHead).
 * - Tham số options: Object chứa host, appName, site, documentTitle, cwd.
 * - Trả về: Mảng các chuỗi thẻ <meta> HTML hoàn chỉnh sẵn sàng chèn vào <head>.
 */
export function grokOgHeadTags({
  host = "",
  appName = DEFAULT_APP_NAME,
  site = {},
  documentTitle = "",
  cwd = process.cwd(),
} = {}) {
  // Bước 1: Xác định tiêu đề chuẩn cho OG và lấy hostname công khai hợp lệ.
  const title = resolveOgTitle(site, appName, host, documentTitle);
  const publicHost = resolvePublicHost(host);
  // Bước 2: Khởi tạo các thẻ meta cơ bản bắt buộc: twitter:card kiểu ảnh lớn và og:title.
  const tags = [
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
  ];
  const description = String(site.description ?? "").trim();
  // Bổ sung thẻ og:description nếu được định nghĩa trong cấu hình site.json.
  if (description) {
    tags.push(`<meta property="og:description" content="${escapeHtml(description)}">`);
  }
  // Gắn og:type="x:game" để nền tảng X (Twitter) kích hoạt giao diện hiển thị dành riêng cho game.
  if (String(site.type ?? "").toLowerCase() === "x:game") {
    tags.push(`<meta property="og:type" content="x:game">`);
  }
  // Bước 3: Nếu xác định được publicHost, sinh URL ảnh đại diện (og:image) và kích thước chuẩn 1200x630.
  if (publicHost) {
    const asset = resolveOgCardAsset(site, cwd);
    const custom = Boolean(asset);
    // Dùng ảnh custom trên host nếu có; nếu không thì gọi dịch vụ ogServiceUrl() sinh ảnh placeholder.
    let image = custom
      ? `https://${publicHost}${asset.startsWith("/") ? asset : `/${asset}`}`
      : `${ogServiceUrl()}/v1/card.png?host=${encodeURIComponent(publicHost)}&title=${encodeURIComponent(title)}`;
    const color = !custom ? placeholderCardColor(site) : "";
    if (color) image += `&color=${encodeURIComponent(color)}`;
    // Kích thước chuẩn Open Graph 1200x630px giúp ảnh hiển thị sắc nét, không bị vỡ trên mạng xã hội.
    tags.push(`<meta property="og:image" content="${escapeHtml(image)}">`);
    tags.push(`<meta property="og:image:width" content="1200">`);
    tags.push(`<meta property="og:image:height" content="630">`);
    const banner = String(site.banner ?? "").trim();
    // Thêm thẻ x:game:image tỉ lệ 1200x264px nếu app có cấu hình banner ngang cho game.
    if (banner) {
      const bannerUrl = `https://${publicHost}${banner.startsWith("/") ? banner : `/${banner}`}`;
      tags.push(`<meta property="x:game:image" content="${escapeHtml(bannerUrl)}">`);
      tags.push(`<meta property="x:game:image:width" content="1200">`);
      tags.push(`<meta property="x:game:image:height" content="264">`);
    }
  }
  return tags;
}

/**
 * Làm gì: Loại bỏ toàn bộ các thẻ <meta> chia sẻ mạng xã hội (Open Graph, Twitter Card) cũ trong mã HTML để tránh bị trùng lặp hoặc xung đột khi hệ thống chèn các thẻ chuẩn hóa mới.
 * Được gọi ở: scripts/grok-pwa-shared.mjs (hàm injectGrokPwaHead).
 * - Tham số html: Chuỗi mã nguồn HTML cần dọn dẹp các thẻ meta chia sẻ.
 * - Trả về: Chuỗi mã HTML đã được loại bỏ các thẻ meta nằm trong danh sách SHARE_META_KEYS.
 */
export function stripShareMetaTags(html) {
  // Quét toàn bộ các thẻ <meta> trong HTML để kiểm tra thuộc tính property hoặc name.
  return String(html).replace(/<meta\b[^>]*>/gi, (tag) => {
    const attrs = [...tag.matchAll(/\b(?:property|name)\s*=\s*["']([^"']+)["']/gi)];
    for (const match of attrs) {
      // Xóa bỏ thẻ nếu tên thuộc tính nằm trong danh sách SHARE_META_KEYS cần ghi đè.
      if (SHARE_META_KEYS.has(String(match[1]).toLowerCase())) return "";
    }
    return tag;
  });
}

/**
 * Làm gì: Chèn một đoạn mã HTML (snippet) vào ngay sau thẻ mở <head>; nếu tài liệu chưa có <head> nhưng có <html> thì tự bọc thẻ <head>, nếu thiếu cả hai thì tự tạo khung tài liệu HTML hoàn chỉnh.
 * Được gọi ở: scripts/grok-pwa-shared.mjs (các hàm insertBeforeHeadClose và injectGrokPwaHead).
 * - Tham số html: Chuỗi mã nguồn HTML ban đầu.
 * - Tham số snippet: Đoạn mã HTML cần chèn vào đầu <head>.
 * - Trả về: Chuỗi mã HTML sau khi chèn đoạn snippet.
 */
function insertAfterHeadOpen(html, snippet) {
  // Trường hợp 1: Đã có thẻ <head>, chèn đoạn snippet ngay sau thẻ mở <head>.
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (open) => `${open}${snippet}`);
  }
  // Trường hợp 2: Có thẻ <html> nhưng thiếu <head>, tự động tạo cặp thẻ <head> chứa snippet.
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (open) => `${open}<head>${snippet}</head>`);
  }
  // Trường hợp 3: Mã HTML phân mảnh thiếu cả <html>, tự động bổ sung khung <!doctype html><html><head>.
  return `<!doctype html><html><head>${snippet}</head>${html}`;
}

/**
 * Làm gì: Chèn một đoạn mã HTML (snippet) vào ngay trước thẻ đóng </head>; nếu không tìm thấy thẻ đóng </head> thì chuyển sang gọi insertAfterHeadOpen.
 * Được gọi ở: scripts/grok-pwa-shared.mjs (hàm injectGrokPwaHead).
 * - Tham số html: Chuỗi mã nguồn HTML của trang.
 * - Tham số snippet: Đoạn mã HTML cần chèn vào trước thẻ đóng </head>.
 * - Trả về: Chuỗi mã HTML sau khi chèn.
 */
function insertBeforeHeadClose(html, snippet) {
  // Chèn ngay trước thẻ đóng </head> nếu tìm thấy trong tài liệu HTML.
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${snippet}</head>`);
  // Dự phòng: Nếu không có thẻ đóng </head>, chèn sau thẻ mở <head> bằng insertAfterHeadOpen.
  return insertAfterHeadOpen(html, snippet);
}

/**
 * Làm gì: Chuẩn hóa đối tượng ngữ cảnh (head context) gồm cấu hình site, tên app, projectId, thông tin tác giả X (creator, creatorId) và host, đồng thời đồng bộ file ảnh mới nhất từ ổ đĩa nếu có.
 * Được gọi ở: scripts/grok-pwa-shared.mjs (các hàm injectGrokPwaHead và createHeadInjector).
 * - Tham số ctx: Đối tượng ngữ cảnh đầu vào tùy chọn.
 * - Trả về: Đối tượng ngữ cảnh chuẩn hóa đầy đủ các trường thông tin phục vụ chèn thẻ head.
 */
export function normalizeHeadContext(ctx = {}) {
  // Bước 1: Xác định thư mục làm việc (cwd), mặc định lấy thư mục chạy tiến trình Node.
  const cwd = ctx.cwd ?? process.cwd();
  // Middleware passes a baked `site`. Still consult the workspace so a
  // public/og.jpg generated after that snapshot (or missed by a wrong cwd)
  // wins over the og.grok.me placeholder. Vercel has no public/ to read, so
  // a correct bake is unchanged.
  // Bước 2: Lấy cấu hình site từ ngữ cảnh hoặc snapshot, rồi kiểm tra ổ đĩa để ưu tiên ảnh mới sinh.
  const site = applyCustomCardFromFs(
    ctx.site !== undefined ? ctx.site : snapshotOgIdentity(cwd).site,
    cwd,
  );
  // Bước 3: Phân giải tên ứng dụng chuẩn theo thứ tự ưu tiên.
  const appName = resolveOgTitle(site, ctx.appName ?? DEFAULT_APP_NAME, ctx.host ?? "");
  // Bước 4: Trả về đối tượng ngữ cảnh hoàn chỉnh với các giá trị fallback từ biến môi trường.
  return {
    appName,
    projectId: ctx.projectId ?? readGrokProjectId(),
    creator: ctx.creator ?? readXCreator(),
    creatorId: ctx.creatorId ?? readXCreatorId(),
    host: ctx.host ?? "",
    cwd,
    site,
  };
}

/**
 * Làm gì: Chèn đầy đủ các thẻ PWA (manifest, apple-touch-icon), Open Graph meta tags, script nền tảng Grok extensions (extensions.js), grok-project-id, grok:app_id và thông tin tác giả X vào tài liệu HTML một cách an toàn và có tính lũy thừa (idempotent, không chèn trùng).
 * Được gọi ở: scripts/grok-pwa-plugin.mjs (hook transformIndexHtml và bên trong createHeadInjector), scripts/grok-pwa-shared.mjs (createHeadInjector), scripts/grok-pwa-plugin.test.mjs ("test runner (node --test)").
 * - Tham số html: Chuỗi mã nguồn HTML của trang tài liệu cần chèn thẻ.
 * - Tham số ctx: Đối tượng ngữ cảnh tùy chọn (host, site, appName, projectId, creator,...).
 * - Trả về: Chuỗi mã HTML mới đã được bổ sung đầy đủ các thẻ meta và script cần thiết trong phần <head>.
 */
export function injectGrokPwaHead(html, ctx = {}) {
  if (typeof html !== "string") return html;
  // Bước 1: Chuẩn hóa ngữ cảnh và xác định tiêu đề trang từ thẻ <title> hoặc tên app.
  const { site, projectId, creator, creatorId, host, cwd } = normalizeHeadContext(ctx);
  const documentTitle = titleFromDocument(html);
  const appName = resolveOgTitle(
    site,
    ctx.appName ?? DEFAULT_APP_NAME,
    host,
    documentTitle,
  );
  // Bước 2: Xóa bỏ các thẻ meta chia sẻ cũ để chuẩn bị chèn bộ thẻ Open Graph mới.
  let next = stripShareMetaTags(html);

  // Bước 3: Lọc danh sách các thẻ PWA còn thiếu (manifest, apple-touch-icon, theme-color).
  const missing = grokPwaHeadTags(appName)
    .filter(([key]) => {
      if (key === "manifest") return !next.includes('href="/__grok/manifest.webmanifest"');
      if (key === "apple-touch-icon") return !next.includes('href="/__grok/icon-180.png"');
      return !next.includes(`name="${key}"`);
    })
    .map(([, tag]) => tag);

  // Bước 4: Chèn các thẻ Open Graph mới vào ngay sau thẻ mở <head>.
  next = insertAfterHeadOpen(
    next,
    grokOgHeadTags({ host, appName, site, documentTitle, cwd }).join(""),
  );

  // Bước 5: Đảm bảo script grok-app-builder/extensions.js và thẻ định danh project ID được nạp đầy đủ.
  if (!next.includes("/grok-app-builder/extensions.js")) {
    missing.push(...grokExtensionsHeadTags(projectId));
  } else if (projectId && !next.includes('name="grok-project-id"')) {
    missing.push(`<meta name="grok-project-id" content="${escapeHtml(projectId)}">`);
  }
  if (
    projectId &&
    !next.includes('property="grok:app_id"') &&
    !next.includes("property='grok:app_id'")
  ) {
    missing.push(`<meta property="grok:app_id" content="${escapeHtml(projectId)}">`);
  }
  // Bước 6: Bổ sung thông tin tác giả X (x:creator và x:creator:id) nếu có cấu hình biến môi trường.
  const creatorTags = grokXCreatorHeadTags(creator, creatorId);
  if (creatorTags.length > 0) {
    const hasCreator =
      next.includes('property="x:creator" content=') ||
      next.includes("property='x:creator' content=");
    if (!hasCreator) missing.push(creatorTags[0]);
    if (!next.includes('property="x:creator:id"')) missing.push(creatorTags[1]);
  }

  // Bước 7: Chèn tất cả các thẻ còn thiếu vào trước thẻ đóng </head>; nếu đã đủ thì trả về ngay.
  if (missing.length === 0) return next;
  return insertBeforeHeadClose(next, missing.join(""));
}

/**
 * Làm gì: Tìm kiếm vị trí byte bắt đầu của thẻ đóng </head> trong buffer nhị phân sử dụng mã hóa latin1 (chuỗi ASCII 1 byte an toàn, không bao giờ nằm trong continuation byte của UTF-8).
 * Được gọi ở: scripts/grok-pwa-shared.mjs (hàm createHeadInjector trong phương thức push).
 * - Tham số buf: Đối tượng Buffer chứa một phần dữ liệu stream HTML đang tải.
 * - Trả về: Chỉ số vị trí byte bắt đầu của </head> nếu tìm thấy, hoặc -1 nếu chưa xuất hiện trong buffer.
 */
function findHeadClose(buf) {
  const at = buf.toString("latin1").search(/<\/head>/i);
  return at;
}

/**
 * Streaming head injector: buffers only until `</head>` (ASCII marker; never
 * appears inside a UTF-8 continuation byte), overwrites share-card metas,
 * then passes later chunks through so streaming SSR keeps streaming.
 */
/*
 * Làm gì: Khởi tạo bộ chèn thẻ head dạng luồng (streaming head injector) cho phản hồi SSR; chỉ đệm dữ liệu cho đến khi gặp thẻ đóng </head>, chèn các thẻ PWA/OG rồi chuyển tiếp trực tiếp các chunk sau đó để không chặn stream.
 * Được gọi ở: scripts/grok-pwa-plugin.mjs (hàm wrapHtmlResponses trong Vite dev server), server/middleware/grok-pwa.ts (hàm injectHeadStreaming trong Nitro production middleware), scripts/grok-pwa-plugin.test.mjs ("test runner (node --test)").
 * - Tham số ctx: Đối tượng ngữ cảnh tùy chọn (host, site, cwd,...).
 * - Trả về: Đối tượng injector gồm phương thức push(chunk) để đẩy dữ liệu và flush() để xả phần đệm còn lại.
 */
export function createHeadInjector(ctx = {}) {
  // Bước 1: Chuẩn hóa ngữ cảnh và tạo hàm apply đóng gói injectGrokPwaHead.
  const normalized = normalizeHeadContext(ctx);

  /** @type {Buffer[]} */
  let pending = [];
  let done = false;

  const apply = (html) =>
    injectGrokPwaHead(html, {
      appName: normalized.appName,
      projectId: normalized.projectId,
      creator: normalized.creator,
      creatorId: normalized.creatorId,
      host: normalized.host,
      cwd: normalized.cwd,
      site: normalized.site,
    });

  return {
    /** @param {Uint8Array | string} chunk @returns {Buffer[]} chunks ready to emit */
    push(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      // Khi đã xử lý xong phần <head>, các chunk tiếp theo (nội dung <body>) được cho qua ngay để giữ hiệu năng stream.
      if (done) return [buf];
      pending.push(buf);
      const joined = Buffer.concat(pending);
      const at = findHeadClose(joined);
      // Tạm thời đệm dữ liệu nếu trong buffer chưa xuất hiện thẻ đóng </head>.
      if (at === -1) return [];
      // Bước 2: Tìm thấy thẻ đóng </head>, tiến hành tách phần head để chèn thẻ và trả về chunk hoàn chỉnh.
      done = true;
      pending = [];
      const closeLen = joined.toString("latin1", at).match(/^<\/head>/i)[0].length;
      const head = apply(joined.subarray(0, at + closeLen).toString("utf8"));
      return [Buffer.concat([Buffer.from(head, "utf8"), joined.subarray(at + closeLen)])];
    },
    /** @returns {Buffer[]} whatever is still buffered (no `</head>` seen) */
    // Bước 3: Phương thức flush xả toàn bộ dữ liệu còn đọng lại trong bộ đệm khi response kết thúc mà chưa gặp </head>.
    flush() {
      if (done || pending.length === 0) return [];
      const rest = Buffer.concat(pending);
      pending = [];
      done = true;
      return [Buffer.from(apply(rest.toString("utf8")), "utf8")];
    },
  };
}
