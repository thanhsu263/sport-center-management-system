import { useSyncExternalStore } from "react";

/**
 * Calm means the device asked for reduced motion. Looping video, shaders and
 * the ticker follow `useCalm()`. One-shot transitions keep Motion's own hook,
 * so a preference change does not remount a form mid-typing.
 */
const QUERY = "(prefers-reduced-motion: reduce)";

let system = false;
const subscribers = new Set<() => void>();
const emit = () => subscribers.forEach((f) => f());

if (typeof window !== "undefined") {
  // The pause button is gone. A choice saved under it would stay on forever.
  try {
    localStorage.removeItem("arena3.calm");
  } catch {
    /* storage blocked */
  }
  const mq = window.matchMedia?.(QUERY);
  system = mq?.matches === true;
  mq?.addEventListener?.("change", (e) => {
    system = e.matches;
    emit();
  });
}

const subscribe = (f: () => void) => {
  subscribers.add(f);
  return () => void subscribers.delete(f);
};

/** True when nothing should move by itself. */
export const useCalm = (): boolean => useSyncExternalStore(subscribe, () => system, () => false);

/** For event handlers, where a hook cannot be called. */
export const isCalm = (): boolean => system;

/** `behavior` for `scrollIntoView` / `scrollTo`: instant when calm. */
export const scrollBehavior = (): ScrollBehavior => (isCalm() ? "auto" : "smooth");
