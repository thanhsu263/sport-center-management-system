import { useEffect, useState } from "react";

export type Theme = "dark" | "light";
const KEY = "arena3:theme";
const listeners = new Set<(t: Theme) => void>();

/** Read before paint by the inline script in __root.tsx, so the page never flashes the wrong scheme. */
export const THEME_BOOT = `try{var t=localStorage.getItem("${KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

function current(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function setTheme(next: Theme) {
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* private mode: the choice lasts this visit only */
  }
  listeners.forEach((l) => l(next));
}

/** The scheme in use and a setter. Starts as "dark" on the server and settles after mount. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, set] = useState<Theme>("dark");
  useEffect(() => {
    set(current());
    listeners.add(set);
    return () => {
      listeners.delete(set);
    };
  }, []);
  return [theme, setTheme];
}
