import { Moon, Sun } from "lucide-react";
import { cn } from "@/client/lib/cn";
import { t } from "@/client/lib/i18n";
import { useTheme } from "@/client/lib/theme";

/** A round light/dark switch for the public pages, beside the language switch. */
export function ThemeIconToggle({ className }: { className?: string }) {
  const [theme, set] = useTheme();
  const light = theme === "light";
  const label = light ? t("Dark mode") : t("Light mode");
  return (
    <button
      type="button"
      onClick={() => set(light ? "dark" : "light")}
      aria-label={label}
      title={label}
      className={cn(
        "grid size-11 place-items-center rounded-[var(--radius-pill)] text-muted transition-colors duration-150 hover:bg-wood hover:text-fg",
        className,
      )}
    >
      {light ? <Moon aria-hidden="true" className="size-5" strokeWidth={1.75} /> : <Sun aria-hidden="true" className="size-5" strokeWidth={1.75} />}
    </button>
  );
}
