import { useRouterState } from "@tanstack/react-router";
import { CircleCheck, RefreshCw, ServerCrash, WifiOff, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { dismissBack, newScreen, retryNow, useLink } from "@/lib/connection";
import { t } from "@/lib/i18n";

/**
 * The one place that says the screen cannot reach its server, and how to get going again.
 *
 * It sits at the top of every signed-in page. Before it, a dropped signal left a page on grey blocks
 * with a toast that faded after a few seconds; now the page says what is wrong and offers a button
 * that opens the screen again.
 */
export function ConnectionBanner() {
  const link = useLink();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [busy, setBusy] = useState(false);
  const [missed, setMissed] = useState(false);

  // "This page could not load" is about one page; once another is on show it is stale.
  useEffect(() => {
    newScreen();
  }, [pathname]);

  if (link === "ok") return null;

  async function retry() {
    setBusy(true);
    setMissed(false);
    const ok = await retryNow();
    setBusy(false);
    // On success the banner unmounts with the reload; on failure say that nothing changed.
    if (!ok) setMissed(true);
  }

  const shell = "sticky top-16 z-10 mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-lg)] border px-4 py-3 text-sm shadow-[var(--shadow-border)]";

  if (link === "back") {
    return (
      <div key="back" role="status" className={cn(shell, "border-success/30 bg-surface")}>
        <CircleCheck className="size-5 shrink-0 text-success" strokeWidth={1.75} aria-hidden="true" />
        <p className="min-w-0 flex-1 basis-48 font-medium">{t("You are connected again.")}</p>
        <Button size="sm" variant="outline" onClick={() => void retry()} disabled={busy}>
          <RefreshCw className="size-4" strokeWidth={1.75} aria-hidden="true" />
          {t("Reload page")}
        </Button>
        <button
          type="button"
          onClick={dismissBack}
          aria-label={t("Close")}
          className="-mr-2 grid size-11 place-items-center rounded-[var(--radius-sm)] text-muted hover:bg-wood hover:text-fg sm:size-9"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    );
  }

  const Icon = link === "offline" ? WifiOff : ServerCrash;
  const heading =
    link === "offline"
      ? t("You are offline.")
      : link === "broken"
        ? t("This page could not load.")
        : t("The server is not answering.");
  const hint = missed
    ? t("Still no answer. Check the connection and try once more.")
    : link === "offline"
      ? t("Check your Wi-Fi or mobile data, then reload this page.")
      : link === "broken"
        ? t("The server had a problem. Reload the page to try again.")
        : t("It may be restarting. Wait a moment, then reload this page.");
  return (
    <div key="down" role="alert" className={cn(shell, "border-hold/30 bg-surface")}>
      <Icon className="size-5 shrink-0 text-hold" strokeWidth={1.75} aria-hidden="true" />
      <div className="min-w-0 flex-1 basis-48">
        <p className="font-medium">{heading}</p>
        <p className="text-xs text-muted">{hint}</p>
      </div>
      <Button size="sm" variant="outline" onClick={() => void retry()} disabled={busy}>
        <RefreshCw className={cn("size-4", busy && "animate-spin")} strokeWidth={1.75} aria-hidden="true" />
        {busy ? t("Trying…") : t("Reload page")}
      </Button>
    </div>
  );
}
