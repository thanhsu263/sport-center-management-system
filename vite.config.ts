/**
 * Tệp cấu hình Vite cho ứng dụng full-stack TanStack Start và React.
 * Thiết lập máy chủ phát triển (dev server) và xem trước (preview server), đồng thời tích hợp các plugin
 * quan trọng: khởi tạo cơ sở dữ liệu PGLite, xử lý popup đăng nhập OAuth, nạp biến môi trường client,
 * cấu hình PWA, Tailwind CSS và Nitro để đóng gói triển khai lên Vercel.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
// @ts-expect-error JS plugin alongside the TS vite config
import { grokPwaPlugin } from "./scripts/grok-pwa-plugin.mjs";
// @ts-expect-error JS plugin alongside the TS vite config
import { appEnvPlugin } from "./scripts/app-env-plugin.mjs";
import { isMigrationFile } from "./scripts/migration-plan.mjs";

/** The files `src/server/data/db.ts` globs — same directory, same non-recursive scope. */
/**
 * Làm gì: Quét thư mục migrations/ ở thư mục gốc dự án để kiểm tra xem có tệp migration nào (.sql) cần áp dụng hay không.
 * Được gọi ở: vite.config.ts (trong hook configureServer của pgliteBootstrapPlugin).
 * @param root Đường dẫn tuyệt đối đến thư mục gốc của dự án (server.config.root).
 * @returns true nếu tìm thấy ít nhất một tệp migration .sql hợp lệ, ngược lại false.
 */
function hasGlobbedMigrations(root: string): boolean {
  try {
    // Đọc danh sách file trong migrations/ và kiểm tra tồn tại file .sql; nếu thư mục không tồn tại thì catch trả về false.
    return readdirSync(join(root, "migrations")).some(isMigrationFile);
  } catch {
    return false;
  }
}

/**
 * Finish PGLite bootstrap during dev-server setup (before traffic). Vite awaits
 * async `configureServer` hooks. Production: `src/server/data/db` kicks `ensureDbReady`
 * on import.
 *
 * Vite awaiting the hook puts this on time-to-first-render, so an app with no
 * migrations — no schema to apply — skips it entirely rather than paying for a
 * PGLite instance it never queries.
 */
/**
 * Làm gì: Tạo plugin Vite cho môi trường dev để khởi tạo cơ sở dữ liệu PGLite trước khi server nhận request đầu tiên.
 * Được gọi ở: vite.config.ts (mảng plugins trong cấu hình defineConfig).
 * @returns Plugin của Vite chứa hook configureServer để chạy migration cho PGLite.
 * @throws Error nếu quá trình bootstrap cơ sở dữ liệu PGLite thất bại.
 */
function pgliteBootstrapPlugin(): Plugin {
  return {
    name: "app-builder:pglite-bootstrap",
    apply: "serve",
    async configureServer(server) {
      // Bước 1: Kiểm tra xem có file migration nào không; nếu không có thì bỏ qua để tránh khởi tạo PGLite khi không dùng DB.
      if (!hasGlobbedMigrations(server.config.root)) return;
      try {
        // Bước 2: Tải động module /src/server/data/db.ts qua cơ chế SSR của Vite.
        const mod = (await server.ssrLoadModule("/src/server/data/db.ts")) as {
          ensureDbReady?: () => Promise<void>;
        };
        // Bước 3: Gọi ensureDbReady để áp dụng các file migration vào PGLite trước khi server phục vụ traffic.
        if (typeof mod.ensureDbReady === "function") {
          await mod.ensureDbReady();
        }
      } catch (err) {
        // Bắn lỗi ra console và ném ngoại lệ để dừng tiến trình khởi động dev server nếu bootstrap DB thất bại.
        console.error("[app-builder] DB bootstrap failed:", err);
        throw err;
      }
    },
  };
}

/**
 * Live-preview OAuth popup — handled HERE so the agent never has to create a
 * `/auth/popup` route (and cannot break it by scaffolding a React page that
 * paints the full app shell in the popup).
 *
 * `signIn` (client.ts) opens `/auth/popup?providerId=…` in a top-level window.
 * This middleware runs before TanStack Start, calls `handleAuthPopupRequest`,
 * and returns the 302 / completion HTML. Deployed apps do not use the popup
 * (full-page OAuth redirect), so `apply: "serve"` is enough.
 */
/**
 * Làm gì: Tạo plugin Vite cho môi trường dev để đăng ký middleware xử lý trực tiếp route /auth/popup cho OAuth popup.
 * Được gọi ở: vite.config.ts (mảng plugins trong cấu hình defineConfig).
 * @returns Plugin của Vite chứa middleware chặn và xử lý request /auth/popup.
 */
function authPopupPlugin(): Plugin {
  return {
    name: "app-builder:auth-popup",
    apply: "serve",
    configureServer(server) {
      // Register immediately (not in a returned post-hook) so we run BEFORE
      // TanStack Start / the SPA HTML fallback. A model-authored
      // `src/routes/auth/popup.tsx` React page must never win this path.
      server.middlewares.use(async (req, res, next) => {
        try {
          // Bước 1: Trích xuất pathname; nếu không phải route /auth/popup thì chuyển tiếp sang middleware kế tiếp qua next().
          const rawUrl = req.url ?? "";
          const pathOnly = rawUrl.split("?", 1)[0] ?? "";
          if (pathOnly !== "/auth/popup") {
            next();
            return;
          }
          // Bước 2: Chỉ chấp nhận method GET cho luồng popup; các method khác trả về mã 405 Method Not Allowed.
          if ((req.method ?? "GET").toUpperCase() !== "GET") {
            res.statusCode = 405;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end("Method Not Allowed");
            return;
          }

          // Bước 3: Xác định host và protocol (ưu tiên proxy headers) để khớp với origin công khai của live-preview.
          const host = String(
            req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:8080",
          );
          const proto = String(
            req.headers["x-forwarded-proto"] ??
              ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? "https" : "http"),
          );
          // Chuyển đổi toàn bộ headers từ Node.js request sang Web Standard Headers object.
          const requestHeaders = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
              for (const v of value) requestHeaders.append(key, v);
            } else {
              requestHeaders.set(key, value);
            }
          }
          // Ensure Host is the public preview host so Better Auth's dynamic
          // baseURL / redirect_uri match the popup origin.
          if (!requestHeaders.has("host")) requestHeaders.set("host", host);

          // Bước 4: Khởi tạo Web Standard Request object với URL tuyệt đối và headers đầy đủ để truyền vào auth handler.
          const request = new Request(`${proto}://${host}${rawUrl}`, {
            method: "GET",
            headers: requestHeaders,
          });

          // Bước 5: Nạp động module /src/server/auth/popup.server.ts bằng Vite SSR và gọi hàm handleAuthPopupRequest.
          const mod = (await server.ssrLoadModule("/src/server/auth/popup.server.ts")) as {
            handleAuthPopupRequest: (req: Request) => Promise<Response>;
          };
          const response = await mod.handleAuthPopupRequest(request);

          // Bước 6: Sao chép HTTP status và các headers sang response của Node.js, bảo toàn nhiều header Set-Cookie (state OAuth và session).
          res.statusCode = response.status;
          // Preserve multiple Set-Cookie headers (OAuth state + session).
          const setCookies =
            typeof response.headers.getSetCookie === "function"
              ? response.headers.getSetCookie()
              : [];
          response.headers.forEach((value, key) => {
            if (key.toLowerCase() === "set-cookie") return;
            res.setHeader(key, value);
          });
          for (const cookie of setCookies) {
            res.appendHeader("set-cookie", cookie);
          }
          // Bước 7: Chuyển dữ liệu phản hồi sang Buffer nhị phân và hoàn tất gửi response về client.
          const body = Buffer.from(await response.arrayBuffer());
          res.end(body);
        } catch (err) {
          console.error("[app-builder] /auth/popup handler failed:", err);
          // Xử lý khi có lỗi phát sinh: trả về mã lỗi 500 nếu headers chưa được gửi đi.
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end("auth popup failed");
          }
        }
      });
    },
  };
}

// `0.0.0.0:8080` is the live-preview contract — don't change host/port.
// The dev server starts once `src/router.tsx` and `src/routes/` exist — see
// AGENTS.md § "First scaffold".
/**
 * Làm gì: Cấu hình và xuất cấu hình Vite cho ứng dụng (cấu hình dev server, preview server, alias và danh sách plugin).
 * Được gọi ở: Vite runner khi thực thi các lệnh npm run dev, npm run build hoặc npm run preview.
 * @param env Đối tượng môi trường của Vite chứa command ("build" | "serve") và cờ isPreview.
 * @returns Đối tượng cấu hình Vite (UserConfig) cho toàn bộ dự án.
 */
export default defineConfig(({ command, isPreview }) => ({
  server: {
    host: "0.0.0.0",
    port: 8080,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 8081,
    strictPort: true,
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    pgliteBootstrapPlugin(),
    // Before tanstackStart so /auth/popup never falls through to the SPA.
    authPopupPlugin(),
    // Dev-only /__app-env, read by scripts/check-auth-invariant.mjs.
    appEnvPlugin(),
    // PWA head + ?install=1 tutorial page; runs before Start/Nitro.
    grokPwaPlugin(),
    tailwindcss(),
    tanstackStart(),
    ...(command === "build" || isPreview
      ? [
          nitro({
            preset: "vercel",
            // Auto-registers server/middleware/* (the PWA install page +
            // manifest + head-tag middleware). Nitro v3 defaults serverDir to
            // false, so removing this silently unwires /?install=1 on deploys.
            serverDir: "./server",
          }),
        ]
      : []),
    viteReact(),
  ],
}));
