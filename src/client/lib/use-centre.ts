import { useMemo } from "react";
import { uiConfigFrom, type UiConfig } from "@/shared/ui-config";
import { venueFrom, type Venue, type VenueRaw } from "@/client/lib/venue";
import { useRead } from "@/client/lib/use-read";

/*
 * The last answer, kept for the life of the tab. Moving between screens mounts the shell again,
 * and drawing the shipped menu until `/flags` answers would make a menu the manager changed jump
 * back and forth on every click.
 */
let last: { ui: UiConfig; venue: Venue } | null = null;

/**
 * The centre's menus, list lengths and opening hours as the manager set them, from the public
 * `/flags` read. Until it answers (or if it fails) the shipped defaults stand in.
 */
export function useCentre(): { ui: UiConfig; venue: Venue } {
  const { data } = useRead<{ ui?: unknown; venue?: VenueRaw }>("/flags");
  return useMemo(() => {
    if (!data) return last ?? { ui: uiConfigFrom(null), venue: venueFrom(null) };
    last = { ui: uiConfigFrom(data.ui), venue: venueFrom(data.venue) };
    return last;
  }, [data]);
}

/** Just the list lengths. */
export const useLimits = () => useCentre().ui.limits;
