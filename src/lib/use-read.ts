import { useCallback, useEffect, useState } from "react";
import { ApiClientError, apiGet } from "@/lib/arena3/client";
import { t } from "@/lib/i18n";

/** Why a read did not come back, in the shape a screen needs to say so. */
export type ReadError = {
  /** Already in the language the person reads. */
  message: string;
  /** The input the server named ("from", "to", "date") when it refused one of them. */
  field?: string;
  /**
   * The server answered "no" to the question itself: it was refused (400 / 422), the person may not
   * see it (403) or there is nothing there (404). Asking again gets the same answer, so a "Try again"
   * button would only bring the same words back; the person has to change what they asked for.
   */
  refused: boolean;
};

/** Statuses that mean "the answer is no", not "the answer did not arrive". */
const REFUSALS = new Set([400, 403, 404, 422]);

export function readError(e: unknown): ReadError {
  if (e instanceof ApiClientError) {
    return { message: e.message, field: e.body.field, refused: REFUSALS.has(e.status) };
  }
  return { message: e instanceof Error ? e.message : t("Something went wrong"), refused: false };
}

type Answer<T> = { path: string; data: T | null; error: ReadError | null };

/**
 * One GET that follows its path.
 *
 * What comes back is the answer to the path as it is *now*: change the date and the old day's rows
 * are gone at once (not a render later), and a slow reply to an earlier date can never land on top
 * of a later one. When the server says no, `error` says why, so the screen can show the reason
 * where the rows would have been instead of leaving grey blocks behind a toast that fades.
 *
 * `reload()` asks again without blanking the screen, so a screen that refreshes after saving does
 * not flash; after an error it clears the message first, so "Try again" visibly does something.
 * A reload never joins a request that was already in flight: it follows a change, and an answer
 * asked for before that change is the old picture. `path` null means "nothing to ask yet".
 *
 * `keepPrevious` is for a long list the person pages through or filters: it keeps the last good
 * answer on screen while the next one is on its way (`stale` says so, so the screen can dim it and
 * mark it busy) instead of collapsing the list to a placeholder and throwing the scroll position
 * away. A failed answer always replaces it — rows that do not match what was asked are never left
 * under an error.
 */
export function useRead<T>(path: string | null, options?: { keepPrevious?: boolean }) {
  const [answer, setAnswer] = useState<Answer<T> | null>(null);
  // The last good answer, for whichever path it was; only handed out when `keepPrevious` asks.
  const [held, setHeld] = useState<T | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (path === null) return;
    let live = true;
    apiGet<T>(path, { fresh: round > 0 }).then(
      (data) => {
        if (!live) return;
        setAnswer({ path, data, error: null });
        setHeld(data);
      },
      (e: unknown) => {
        if (!live) return;
        setAnswer({ path, data: null, error: readError(e) });
        setHeld(null);
      },
    );
    return () => {
      live = false;
    };
  }, [path, round]);

  const reload = useCallback(() => {
    setAnswer((a) => (a?.error ? null : a));
    setRound((n) => n + 1);
  }, []);

  const mine = answer !== null && answer.path === path ? answer : null;
  const stale = mine === null && options?.keepPrevious === true && held !== null;
  return {
    data: mine ? mine.data : stale ? held : null,
    error: mine?.error ?? null,
    /** True while `data` is the answer to an earlier path, shown until the one asked for arrives. */
    stale,
    reload,
  };
}
