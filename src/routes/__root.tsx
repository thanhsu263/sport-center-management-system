/**
 * File: src/routes/__root.tsx
 * Vai trò: Root Route (layout gốc) của toàn bộ ứng dụng trên TanStack Router / TanStack Start.
 * Khởi tạo khung HTML chuẩn (<html>, <head>, <body>), nạp stylesheet, cấu hình meta/SEO,
 * nạp trước tài nguyên giao diện (site_assets) từ server, và thiết lập các Provider toàn cục (Auth, Media, i18n).
 */
import { THEME_BOOT } from "@/client/lib/theme";
import { createRootRoute, HeadContent, Outlet, Scripts, useRouterState } from "@tanstack/react-router";
import { AuthProvider } from "@/client/auth/provider";
import { useRetryKey } from "@/client/lib/connection";
import { LangProvider, t } from "@/client/lib/i18n";
import { ClickSpark } from "@/client/components/fx";
import { PreviewHostBridge } from "@/client/components/preview-host-bridge";
import { Toaster } from "sonner";
import { createServerFn } from "@tanstack/react-start";
import { SiteAssetsProvider, type PublicSiteAsset } from "@/client/components/media";
import appCss from "../styles.css?url";

const APP_NAME = "Lê Long Sport";

/**
 * Làm gì: Server function truy vấn cơ sở dữ liệu để lấy danh sách tài nguyên tĩnh (ảnh banner, logo, video...) của toàn trang web.
 * Được gọi ở: src/routes/__root.tsx -> Route.loader.
 * @returns {Promise<{ items: PublicSiteAsset[] }>} Mảng chứa danh sách asset công khai kèm URL đã xử lý, trả về mảng rỗng nếu xảy ra lỗi.
 * @throws Không ném lỗi ra ngoài (đã bắt lỗi nội bộ trong try/catch và trả về items rỗng).
 */
export const getRootAssets = createServerFn({ method: "GET" }).handler(async () => {
  try {
    // Bước 1: Kết nối cơ sở dữ liệu. Dùng dynamic import để tách biệt mã server, tránh kéo bundle DB vào phía client.
    const { getSql } = await import("@/server/data/db");
    const sql = await getSql();
    // Bước 2: Truy vấn bảng site_assets để lấy thông tin các slot tài nguyên.
    // Dùng 'bytes is not null as has_bytes' để kiểm tra file được lưu trực tiếp trong DB hay dùng đường dẫn tĩnh.
    const rows = await sql.query<{
      slot: string;
      kind: "image" | "video";
      src_path: string | null;
      default_path: string | null;
      mime: string | null;
      has_bytes: boolean;
      width: number | null;
      height: number | null;
      alt_en: string;
      alt_vi: string;
      enabled: boolean;
      version: number;
    }>(
      `select slot, kind, src_path, default_path, mime, bytes is not null as has_bytes,
              width, height, alt_en, alt_vi, enabled, version
         from site_assets`,
    );
    // Bước 3: Chuyển đổi dữ liệu từ database sang định dạng PublicSiteAsset.
    // Nếu file lưu trực tiếp (has_bytes = true), tạo URL streaming kèm version (?v=) để hỗ trợ cache-busting.
    const items: PublicSiteAsset[] = rows.map((r) => ({
      slot: r.slot,
      kind: r.kind,
      url: r.has_bytes
        ? `/v1/site-assets/${r.slot}/file?v=${r.version}`
        : (r.src_path ?? r.default_path ?? ""),
      alt_en: r.alt_en,
      alt_vi: r.alt_vi,
      enabled: r.enabled,
      width: r.width,
      height: r.height,
    }));
    // Bước 4: Trả về danh sách asset đã được chuẩn hóa cho loader.
    return { items };
  } catch {
    // Fallback an toàn: nếu database gặp sự cố, trả về mảng rỗng để giao diện trang chủ vẫn tải được bình thường.
    return { items: [] };
  }
});

// Its own component so `t()` runs when the language remounts it, not once in the root render.
/**
 * Làm gì: Hiển thị liên kết ẩn hỗ trợ trợ năng (a11y), cho phép người dùng bàn phím bấm Tab để nhảy nhanh đến vùng nội dung chính (#main-content).
 * Được gọi ở: src/routes/__root.tsx -> RootComponent.
 * @returns {JSX.Element} Phần tử thẻ <a> với class skip-link trỏ tới #main-content.
 */
function SkipLink() {
  return (
    <a href="#main-content" className="skip-link">
      {t("Skip to main content")}
    </a>
  );
}

// "Reload page" on the connection banner bumps this key, which remounts whatever page is showing so
// it asks for its data again. Without it a page whose first request failed keeps its grey blocks.
/**
 * Làm gì: Bọc component Outlet với key lấy từ hook useRetryKey(), ép React remount toàn bộ trang con khi người dùng bấm thử lại kết nối.
 * Được gọi ở: src/routes/__root.tsx -> RootComponent.
 * @returns {JSX.Element} Component Outlet của TanStack Router mang key động.
 */
function RetryOutlet() {
  return <Outlet key={useRetryKey()} />;
}

/**
 * Làm gì: Khởi tạo Root Route cho toàn bộ ứng dụng; cấu hình loader tải trước asset, thiết lập thẻ meta/link cho phần <head> và gán RootComponent làm layout chính.
 * Được gọi ở: TanStack Router (được tổng hợp vào routeTree tại src/routeTree.gen.ts và nạp bởi src/router.tsx). URL: Mọi đường dẫn (layout gốc toàn ứng dụng).
 * @returns Đối tượng RootRoute của TanStack Router.
 */
export const Route = createRootRoute({
  loader: async () => {
    // Nạp trước danh sách asset trang web từ server; nếu lỗi thì fallback về mảng rỗng để không làm gián đoạn việc tải trang.
    try {
      return await getRootAssets();
    } catch {
      return { items: [] };
    }
  },
  // Khai báo các thẻ meta (viewport, title, màu sắc thương hiệu PWA) và các liên kết CSS, manifest, favicon cho phần <head> của HTML.
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: APP_NAME },
      // The same sprout green the manifest and the palette use, so the phone chrome matches the brand.
      { name: "theme-color", content: "#3f7d20" },
      {
        name: "description",
        content:
          "Lê Long Sport: book badminton, basketball and volleyball courts, coached classes and memberships at an indoor sports centre in Ho Chi Minh City.",
      },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/__grok/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/__grok/icon-180.png" },
    ],
  }),
  component: RootComponent,
});

/**
 * Làm gì: Component layout gốc dựng cấu trúc tài liệu HTML hoàn chỉnh (html, head, body), tích hợp theme ban đầu và bọc các Context Provider toàn cục (Auth, Media, i18n).
 * Được gọi ở: src/routes/__root.tsx -> Route.component.
 * @returns {JSX.Element} Cấu trúc DOM hoàn chỉnh của ứng dụng.
 */
function RootComponent() {
  // Lấy danh sách asset đã được tải từ loader của Route để truyền vào SiteAssetsProvider.
  const data = Route.useLoaderData();
  return (
    <html lang="en" className="antialiased" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="bg-bg text-fg">
        <PreviewHostBridge />
        <AuthProvider>
          <SiteAssetsProvider initialAssets={data?.items}>
            <LangProvider>
              <SkipLink />
              {/* Click feedback on the public pages only; it parks its rAF loop whenever there is
                  nothing left to draw. */}
              <PublicClickSpark />
              <RetryOutlet />
            </LangProvider>
          </SiteAssetsProvider>
          {/* Below the 56px header on both sizes: sonner's phone default of 16px sat on top of it, and
              six seconds rather than four, because a refused payment is a line to read twice. */}
          <Toaster
            position="top-center"
            offset={72}
            mobileOffset={{ top: 68, left: 16, right: 16 }}
            duration={6000}
            visibleToasts={3}
            toastOptions={{
              className: "font-sans",
              // sonner's own description grey is meant for a light card and nearly vanished on ours.
              classNames: { description: "!text-muted" },
              style: {
                background: "var(--color-surface)",
                color: "var(--color-fg)",
                border: "1px solid var(--color-line)",
              },
            }}
          />
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  );
}

/**
 * The working screens (member, desk, coach, manager) are tools used many times a day, and the
 * review asked for fewer effects there (X-4). The spark stays where it greets people: the
 * landing, sign-in, sign-up and the public pages.
 */
const WORK_PREFIXES = ["/app", "/desk", "/manager", "/coach", "/account", "/alerts"];
/**
 * Làm gì: Kích hoạt hiệu ứng tia lửa khi click chuột (ClickSpark) trên các trang công khai, tự động tắt trên các màn hình làm việc nghiệp vụ nội bộ.
 * Được gọi ở: src/routes/__root.tsx -> RootComponent.
 * @returns {JSX.Element | null} Component ClickSpark nếu ở trang công khai, hoặc null nếu ở trang làm việc nội bộ.
 */
function PublicClickSpark() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Ẩn hiệu ứng click trên các trang công việc thường nhật (member, desk, coach, manager...) để giao diện gọn gàng và tránh gây phiền.
  if (WORK_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;
  return <ClickSpark />;
}
