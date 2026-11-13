import { useCallback, useEffect, useState } from "react";

/** One line of the assistant conversation as both the widget and the full page keep it. */
export type ChatMsg = { role: "me" | "bot"; text: string; source?: "gemini" | "xai" | "rules" };

/** Enough for a conversation to survive a reload without the key growing for ever. */
const LIMIT = 50;
/** Same-tab signal: the widget and /app/assistant can both be mounted at once. */
const EVENT = "arena3:chat-log";

const keyFor = (userId: string) => `arena3:chat:${userId}`;

function read(userId: string): ChatMsg[] {
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m): m is ChatMsg =>
          !!m && typeof m === "object" && (m.role === "me" || m.role === "bot") && typeof m.text === "string",
      )
      .slice(-LIMIT);
  } catch {
    return [];
  }
}

function write(userId: string, log: ChatMsg[]) {
  try {
    window.localStorage.setItem(keyFor(userId), JSON.stringify(log.slice(-LIMIT)));
  } catch {
    // Private mode or a full quota: the conversation still works, it just won't survive a reload.
  }
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: userId }));
  } catch {
    /* no window events */
  }
}

/**
 * The member's assistant conversation, kept in localStorage per user so a reload keeps it and the
 * corner widget and the full page share one thread. Starts empty on the server and on first render
 * (so hydration matches), then loads once the user is known.
 */
export function useChatLog(userId: string | null | undefined) {
  const [log, setLogState] = useState<ChatMsg[]>([]);

  useEffect(() => {
    if (!userId) {
      setLogState([]);
      return;
    }
    setLogState(read(userId));
    const sync = () => setLogState(read(userId));
    const onLocal = (e: Event) => {
      if ((e as CustomEvent<string>).detail === userId) sync();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === keyFor(userId)) sync();
    };
    window.addEventListener(EVENT, onLocal);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, onLocal);
      window.removeEventListener("storage", onStorage);
    };
  }, [userId]);

  /**
   * Appends to the thread. Other mounted views follow through the same-tab event, so each view's
   * state is current; writing from it (not a fresh read) keeps history alive when storage is off.
   */
  const append = useCallback(
    (msg: ChatMsg) => {
      setLogState((l) => {
        const next = [...l, msg].slice(-LIMIT);
        // Idempotent, so a doubled updater call in strict mode writes the same value twice.
        if (userId) queueMicrotask(() => write(userId, next));
        return next;
      });
    },
    [userId],
  );

  const clear = useCallback(() => {
    setLogState([]);
    if (userId) write(userId, []);
  }, [userId]);

  return { log, append, clear };
}
