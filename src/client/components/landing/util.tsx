import { useContext, createContext, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_VENUE, type Venue } from "@/lib/venue";
import type { CatalogPrice } from "@/lib/arena3/catalog";
import { weekdayShort } from "@/lib/arena3/labels";
import { t, tk } from "@/lib/i18n";

/**
 * Rich sentences: translate the whole sentence with `{name}` placeholders set to `mark("name")`,
 * then `rich()` swaps each marker for a styled node, so word order stays the translator's call.
 */
export const mark = (k: string) => `\u0001${k}\u0002`;
export function rich(text: string, nodes: Record<string, ReactNode>): ReactNode {
  // eslint-disable-next-line no-control-regex -- \u0001 and \u0002 are the markers mark() writes; copy never contains them.
  return text.split(/\u0001(\w+)\u0002/).map((part, i) => (i % 2 === 0 ? part : <span key={i}>{nodes[part]}</span>));
}

/** Short weekday for display; `weekdayShort` keeps its English codes for the weekend check. */
const WD_SHORT: Record<string, string> = {
  Mon: tk("Mon"),
  Tue: tk("Tue"),
  Wed: tk("Wed"),
  Thu: tk("Thu"),
  Fri: tk("Fri"),
  Sat: tk("Sat"),
  Sun: tk("Sun"),
};
export const wdLabel = (iso: string) => {
  const w = weekdayShort(iso);
  return t(WD_SHORT[w] ?? w);
};

/** Opening hours and hold length for every landing section; the page provides the real ones. */
const VenueCtx = createContext<Venue>(DEFAULT_VENUE);
export const VenueProvider = VenueCtx.Provider;
export const useVenue = () => useContext(VenueCtx);

/** Current wall-clock hour at the centre (ICT), or null until the client mounts. */
export function useVenueHour() {
  const [hour, setHour] = useState<number | null>(null);
  useEffect(() => {
    const read = () =>
      setHour(
        Number(
          new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", hour12: false }).format(
            new Date(),
          ),
        ),
      );
    read();
    const id = setInterval(read, 60_000);
    return () => clearInterval(id);
  }, []);
  return hour;
}

/** Weekend pricing runs on Saturday and Sunday; everything else is a weekday. */
function dayKindOf(iso: string) {
  const wd = weekdayShort(iso);
  return wd === "Sat" || wd === "Sun" ? "weekend" : "weekday";
}

/** What one hour on one sport costs on a given day, from the centre's own sheet. */
export function priceFor(prices: CatalogPrice[], sport: string, date: string, hour: number) {
  const kind = dayKindOf(date);
  const rule = prices.find(
    (p) =>
      p.sport === sport &&
      p.day_kind === kind &&
      !p.court_id &&
      Number(p.start_local.slice(0, 2)) <= hour &&
      hour < Number(p.end_local.slice(0, 2)),
  );
  return rule?.price_vnd ?? null;
}
