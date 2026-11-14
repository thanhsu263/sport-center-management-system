import { CalendarPlus } from "lucide-react";
import { Badge } from "@/client/components/ui";
import { googleCalendarUrl, type CalendarEvent } from "@/client/arena3/gcal";
import { t } from "@/client/lib/i18n";

/** Staff see when a running class has fewer members than its minimum. It only warns. */
export function MinSizeBadge({ enrolled, min, status }: { enrolled: number; min?: number | null; status?: string }) {
  if (!min || enrolled >= min || status === "cancelled") return null;
  return (
    <Badge tone="hold" title={t("Minimum to run: {n}", { n: min })}>
      {t("Below minimum · {n} more needed", { n: min - enrolled })}
    </Badge>
  );
}

/** Opens Google Calendar with the event filled in, in a new tab. `onLime` sets it in the dark ink of a lime card. */
export function AddToCalendar({ event, className, onLime = false }: { event: CalendarEvent; className?: string; onLime?: boolean }) {
  return (
    <a
      href={googleCalendarUrl(event)}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex min-h-9 items-center gap-1.5 text-xs font-medium underline-offset-2 hover:underline ${onLime ? "font-semibold text-accent-fg" : "text-accent-2"} ${className ?? ""}`}
    >
      <CalendarPlus className="size-4" aria-hidden />
      {t("Add to Google Calendar")}
    </a>
  );
}
