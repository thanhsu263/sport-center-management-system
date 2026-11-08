import { useEffect, useRef, useState, type ReactNode } from "react";
import { getToken } from "./arena3/client";

type Listener = () => void;

class LiveHub {
  private listeners = new Map<string, Set<Listener>>();
  private eventSource: EventSource | null = null;
  private currentTopicsKey = "";
  private isVisible = true;
  private isPollingFallback = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (typeof window !== "undefined") {
      this.isVisible = !document.hidden;
      document.addEventListener("visibilitychange", () => {
        const visible = !document.hidden;
        if (this.isVisible !== visible) {
          this.isVisible = visible;
          if (visible) {
            // Tab active again: refetch everything once to catch up, then resume stream
            this.notifyAll();
            this.syncConnection();
          } else {
            // Tab hidden: pause network stream
            this.disconnect();
            this.stopPolling();
          }
        }
      });
    }
  }

  subscribe(topic: string, listener: Listener): () => void {
    if (!this.listeners.has(topic)) {
      this.listeners.set(topic, new Set());
    }
    this.listeners.get(topic)!.add(listener);
    this.syncConnection();

    return () => {
      const set = this.listeners.get(topic);
      if (set) {
        set.delete(listener);
        if (set.size === 0) {
          this.listeners.delete(topic);
        }
      }
      this.syncConnection();
    };
  }

  private getActiveTopics(): string[] {
    return Array.from(this.listeners.keys()).sort();
  }

  private notifyTopic(topic: string) {
    const set = this.listeners.get(topic);
    if (set) {
      for (const listener of set) {
        try {
          listener();
        } catch (e) {
          console.error("[live] listener error", e);
        }
      }
    }
  }

  private notifyAll() {
    for (const topic of this.listeners.keys()) {
      this.notifyTopic(topic);
    }
  }

  private syncConnection() {
    if (typeof window === "undefined" || !this.isVisible) return;

    const topics = this.getActiveTopics();
    const key = topics.join(",");

    if (topics.length === 0) {
      this.disconnect();
      this.stopPolling();
      this.currentTopicsKey = "";
      return;
    }

    if (this.currentTopicsKey === key && (this.eventSource || this.isPollingFallback)) {
      return;
    }

    this.currentTopicsKey = key;
    this.connect(topics);
  }

  private connect(topics: string[]) {
    this.disconnect();

    if (typeof EventSource === "undefined") {
      this.startPolling();
      return;
    }

    const token = getToken();
    const params = new URLSearchParams({
      topics: topics.join(","),
    });
    if (token) params.set("token", token);

    const es = new EventSource(`/api/live?${params.toString()}`);
    this.eventSource = es;

    // If connection doesn't establish within 8 seconds, fall back to polling
    this.connectTimeout = setTimeout(() => {
      if (es.readyState === EventSource.CONNECTING) {
        this.disconnect();
        this.startPolling();
      }
    }, 8000);

    es.onopen = () => {
      if (this.connectTimeout) clearTimeout(this.connectTimeout);
      this.stopPolling();
    };

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data && typeof data.topic === "string") {
          this.notifyTopic(data.topic);
        }
      } catch {
        // ignore malformed message
      }
    };

    es.onerror = () => {
      // If stream closes or errors out permanently, fall back to polling
      if (es.readyState === EventSource.CLOSED) {
        this.disconnect();
        this.startPolling();
      }
    };
  }

  private startPolling() {
    if (this.isPollingFallback) return;
    this.isPollingFallback = true;
    this.stopPolling();

    // Poll every 4 seconds when falling back
    this.pollTimer = setInterval(() => {
      if (!this.isVisible) return;
      this.notifyAll();
    }, 4000);
  }

  private stopPolling() {
    this.isPollingFallback = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private disconnect() {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }
}

export const liveHub = new LiveHub();

/**
 * Shared live subscription hook. Subscribes to a topic on the app-wide singleton EventSource.
 * Pauses when tab is hidden, falls back to polling if SSE drops.
 */
export function useLive(topic: string | null | undefined, refetch: () => void) {
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    if (!topic) return;
    const unsub = liveHub.subscribe(topic, () => {
      refetchRef.current();
    });
    return unsub;
  }, [topic]);
}

/**
 * Highlight animation when a number or value changes, honoring reduced motion.
 */
export function useChangedHighlight(value: unknown, durationMs = 1200): boolean {
  const [highlighted, setHighlighted] = useState(false);
  const prevRef = useRef(value);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      prevRef.current = value;
      return;
    }

    if (prevRef.current !== value) {
      prevRef.current = value;
      setHighlighted(true);
      const timer = setTimeout(() => setHighlighted(false), durationMs);
      return () => clearTimeout(timer);
    }
  }, [value, durationMs]);

  return highlighted;
}

/**
 * Lightweight wrapper to subtly pulse on value change.
 */
export function HighlightBadge({
  value,
  children,
  className = "",
}: {
  value: unknown;
  children: ReactNode;
  className?: string;
}) {
  const isChanged = useChangedHighlight(value);
  return (
    <span
      className={`${className} transition-colors duration-300 ${
        isChanged ? "text-accent font-semibold motion-safe:animate-pulse" : ""
      }`}
    >
      {children}
    </span>
  );
}
