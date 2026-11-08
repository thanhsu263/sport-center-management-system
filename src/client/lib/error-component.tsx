import type { ErrorComponentProps } from "@tanstack/react-router";
import { Compass, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { getStoredUser, homeFor } from "@/lib/arena3/client";
import { cn } from "@/lib/cn";
import { t, tk } from "@/lib/i18n";

// These two screens are what a person sees when the app itself has failed, so they lean on as little
// of it as they can: icons, the translator and the stored role, nothing from the component kit.

const FALLBACK_MESSAGE = tk("An unexpected error occurred. Try reloading the page.");

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return t(FALLBACK_MESSAGE);
}

/**
 * Where "Back to home" goes: the signed-in person's own home, or the front page.
 *
 * Read after mount, because local storage does not exist while the server renders. A plain link, so
 * it loads the page afresh instead of asking a router that may be the thing that broke.
 */
function useHomePath(): string {
  const [home, setHome] = useState("/");
  useEffect(() => {
    const user = getStoredUser();
    if (user) setHome(homeFor(user.role));
  }, []);
  return home;
}

const button =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-lg)] px-5 text-sm font-medium";

export function AppErrorComponent({ error }: ErrorComponentProps) {
  const home = useHomePath();
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-bg px-6 py-10 text-center text-fg"
    >
      <span className="text-danger" aria-hidden="true">
        <TriangleAlert className="size-10" strokeWidth={2} />
      </span>
      <div role="alert" className="grid justify-items-center gap-3">
        <h1 className="font-display text-2xl">{t("Something went wrong")}</h1>
        <p className="max-w-md text-sm text-muted">{t("This screen stopped working. Reloading usually fixes it.")}</p>
        {/* What the browser reported, for whoever has to look into it. */}
        <p className="max-w-md rounded-[var(--radius-sm)] bg-wood px-3 py-2 text-xs break-words text-muted">
          {errorMessage(error)}
        </p>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className={cn(button, "bg-accent text-accent-fg")}
        >
          <RefreshCw className="size-4" strokeWidth={1.75} aria-hidden="true" />
          {t("Reload page")}
        </button>
        <a href={home} className={cn(button, "border border-line-strong bg-surface text-fg")}>
          {t("Back to home")}
        </a>
      </div>
    </main>
  );
}

/**
 * The page for a URL that does not exist.
 *
 * Without one, TanStack renders its own `<p>Not Found</p>` — no styling, no
 * nav, and nothing to click. A mistyped address, a stale bookmark or a member
 * link that has since moved all landed a visitor on a blank white page with no
 * way back into the centre.
 */
export function AppNotFoundComponent() {
  const home = useHomePath();
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-bg px-6 py-10 text-center text-fg"
    >
      <span className="text-muted" aria-hidden="true">
        <Compass className="size-10" strokeWidth={1.5} />
      </span>
      <h1 className="font-display text-3xl">{t("This page isn’t here")}</h1>
      <p className="max-w-md text-sm text-muted">
        {t("The address may have changed, or the link that brought you here is out of date.")}
      </p>
      <a href={home} className={cn(button, "mt-2 bg-accent text-accent-fg")}>
        {t("Back to home")}
      </a>
    </main>
  );
}
