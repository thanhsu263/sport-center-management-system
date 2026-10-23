import { createRootRoute, HeadContent, Outlet, Scripts, useRouterState } from "@tanstack/react-router";
import { AuthProvider } from "@/lib/auth/provider";
import { useRetryKey } from "@/lib/connection";
import { LangProvider, t } from "@/lib/i18n";
import { ClickSpark } from "@/components/fx";
import { PreviewHostBridge } from "@/components/preview-host-bridge";
import { Toaster } from "sonner";
import { createServerFn } from "@tanstack/react-start";
import { SiteAssetsProvider, type PublicSiteAsset } from "@/components/media";
import appCss from "../styles.css?url";

const APP_NAME = "Lê Long Sport Center";

export const getRootAssets = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
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
    return { items };
  } catch {
    return { items: [] };
  }
});

// Its own component so `t()` runs when the language remounts it, not once in the root render.
function SkipLink() {
  return (
    <a href="#main-content" className="skip-link">
      {t("Skip to main content")}
    </a>
  );
}

// "Reload page" on the connection banner bumps this key, which remounts whatever page is showing so
// it asks for its data again. Without it a page whose first request failed keeps its grey blocks.
function RetryOutlet() {
  return <Outlet key={useRetryKey()} />;
}

export const Route = createRootRoute({
  loader: async () => {
    try {
      return await getRootAssets();
    } catch {
      return { items: [] };
    }
  },
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
          "Lê Long Sport Center: book badminton, basketball and volleyball courts, coached classes and memberships at an indoor sports centre in Ho Chi Minh City.",
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

function RootComponent() {
  const data = Route.useLoaderData();
  return (
    <html lang="en" className="antialiased" suppressHydrationWarning>
      <head>
        <HeadContent />
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
function PublicClickSpark() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (WORK_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;
  return <ClickSpark />;
}
