/**
 * Dev-only `/__app-env` endpoint: the client env the running Vite server
 * resolved, as JSON.
 *
 * `scripts/check-auth-invariant.mjs` reads it to compare the live dev server's
 * `VITE_AUTH_ENABLED` against the value the next build will resolve. The
 * config is loaded even when Vite is started outside `scripts/with-app-env.mjs`
 * — the case that check exists to catch. These are the same values Vite inlines
 * into the client bundle, and `apply: "serve"` keeps the route out of deployed
 * apps.
 */
export const APP_ENV_ROUTE = "/__app-env";

/**
 * Làm gì: Tạo Vite plugin cho môi trường dev, đăng ký middleware phục vụ route /__app-env để trả về toàn bộ biến môi trường client (server.config.env) dưới dạng JSON.
 * Được gọi ở: vite.config.ts (mảng plugins trong cấu hình Vite).
 * - Trả về: Object plugin của Vite chứa name, apply: "serve" và hook configureServer.
 */
export function appEnvPlugin() {
  return {
    name: "app-builder:app-env",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // Bước 1: Trích xuất pathname (bỏ qua query string); nếu không khớp GET /__app-env thì gọi next() để middleware khác xử lý.
        const pathOnly = (req.url ?? "").split("?", 1)[0];
        if (pathOnly !== APP_ENV_ROUTE || (req.method ?? "GET").toUpperCase() !== "GET") {
          next();
          return;
        }
        // Bước 2: Chuyển đổi toàn bộ biến môi trường client (server.config.env) thành chuỗi JSON và bọc trong Buffer UTF-8.
        const body = Buffer.from(JSON.stringify(server.config.env), "utf8");
        // Bước 3: Thiết lập mã HTTP 200, header JSON không cache và gửi dữ liệu response về client.
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("content-length", String(body.byteLength));
        res.end(body);
      });
    },
  };
}
