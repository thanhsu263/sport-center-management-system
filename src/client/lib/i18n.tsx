import { Fragment, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { VI } from "@/lib/i18n/vi";
import { viData } from "@/lib/i18n/vi.data";
import { VI_SERVER_EXACT, VI_SERVER_PATTERNS } from "@/lib/i18n/vi.srv";

/**
 * English first, Vietnamese as the second language, with English as the source text.
 *
 * `t("Open shift")` returns the English string unchanged in English and the Vietnamese entry
 * from `src/lib/i18n/vi.*.ts` in Vietnamese; a missing entry falls back to the English so a
 * forgotten string shows up as English rather than as a blank. `{name}` placeholders are filled
 * from the second argument.
 *
 * It is a plain function, not a hook: switching language remounts the tree (see `LangProvider`),
 * so every component simply renders again and calls `t` with the new language. The one rule that
 * follows is that `t` is called while rendering, never at module scope. For a constant that has
 * to live at module scope (a nav list, a label table) write the English with `tk("…")` and call
 * `t(item.label)` where it is drawn; `tk` is an identity function that only marks the string for
 * `scripts/i18n-check.mjs`.
 */
export type Lang = "en" | "vi";
type Vars = Record<string, string | number>;

const STORAGE_KEY = "arena3.lang";
// English is the primary language (PRODUCT.md): it is what the server renders and what a first visit sees.
let current: Lang = "en";
const subscribers = new Set<() => void>();

const fill = (s: string, vars?: Vars) =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;

import { registerTranslator } from "./arena3/translator.ts";

export function t(en: string, vars?: Vars): string {
  return fill(current === "vi" ? (VI[en] ?? en) : en, vars);
}

registerTranslator(t);

/** Marks an English string for the checker without translating it yet. */
export const tk = <S extends string>(en: S): S => en;

/**
 * A message that came from the server in English (an error, a notification body). Exact matches
 * first, then the patterns for messages that carry numbers or names; anything else is shown as it
 * arrived.
 */
export function tServer(msg: string): string {
  if (current !== "vi" || !msg) return msg;
  const exact = VI_SERVER_EXACT[msg] ?? VI[msg];
  if (exact) return exact;
  for (const [re, vi] of VI_SERVER_PATTERNS) {
    const m = re.exec(msg);
    if (m) return vi.replace(/\$(\d)/g, (_, i: string) => m[Number(i)] ?? "");
  }
  return msg;
}

/** Seeded demo content stored in English in the database (plan, gear and staff names, health notes). */
export function tData<T extends string | null | undefined>(s: T): T {
  return (current === "vi" && s ? viData(s) : s) as T;
}

export const getLang = (): Lang => current;
/** The locale to hand to Intl / toLocale*String so dates and numbers read natively. */
export const locale = (): string => (current === "vi" ? "vi-VN" : "en-GB");

function apply(next: Lang) {
  if (next === current) return;
  current = next;
  // Screen readers pick the voice from this, so it must change even when storage is blocked.
  if (typeof document !== "undefined") document.documentElement.lang = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* private mode: the choice just lasts until reload */
  }
  subscribers.forEach((f) => f());
}

export const setLang = apply;

const subscribe = (f: () => void) => {
  subscribers.add(f);
  return () => void subscribers.delete(f);
};

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, () => "en" as Lang);
}

/**
 * Keys the subtree by language, so a switch re-renders every `t()` call. The saved choice is read
 * after mount (the server and the first client render are always English, so hydration agrees).
 */
export function LangProvider({ children }: { children: ReactNode }) {
  const lang = useLang();
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "vi" || saved === "en") apply(saved);
    } catch {
      /* ignore */
    }
  }, []);
  return <Fragment key={lang}>{children}</Fragment>;
}
