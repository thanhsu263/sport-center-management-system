import { Globe } from "lucide-react";
import { cn } from "@/lib/cn";
import { setLang, t, useLang, type Lang } from "@/lib/i18n";

const OPTIONS: { value: Lang; short: string; full: string }[] = [
  { value: "en", short: "EN", full: "English" },
  { value: "vi", short: "VI", full: "Tiếng Việt" },
];

/** EN | VI toggle. Names stay in their own language so it can be found whichever one is on. */
export function LangSwitch({ className }: { className?: string }) {
  const lang = useLang();
  return (
    <div
      role="group"
      aria-label={t("Language")}
      className={cn("inline-flex h-12 items-center gap-0.5 rounded-full bg-surface p-0.5 shadow-[var(--shadow-border)] sm:h-9", className)}
    >
      <Globe aria-hidden="true" className="ml-1.5 hidden size-3.5 shrink-0 text-muted sm:block" />
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          lang={o.value}
          title={o.full}
          aria-label={o.full}
          aria-pressed={lang === o.value}
          onClick={() => setLang(o.value)}
          className={cn(
            "h-11 min-w-11 rounded-full px-2 text-xs font-semibold tracking-wide transition-colors sm:h-8 sm:min-w-9",
            lang === o.value ? "bg-accent text-accent-fg" : "text-muted hover:text-fg",
          )}
        >
          {o.short}
        </button>
      ))}
    </div>
  );
}
