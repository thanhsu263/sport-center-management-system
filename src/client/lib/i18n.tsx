/**
 * File: src/client/lib/i18n.tsx
 * Vai trò: Quản lý đa ngôn ngữ (tiếng Anh và tiếng Việt) cho toàn bộ giao diện client của Arena3.
 * Vị trí trong app: Cung cấp hàm dịch giao diện t(), dịch lỗi server tServer(), dịch dữ liệu seed tData(), quản lý trạng thái ngôn ngữ qua useSyncExternalStore và bọc toàn bộ ứng dụng bằng LangProvider để cập nhật UI khi đổi ngôn ngữ.
 */
import { Fragment, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { VI } from "@/client/lib/i18n/vi";
import { viData } from "@/client/lib/i18n/vi.data.ts";
import { VI_SERVER_EXACT, VI_SERVER_PATTERNS } from "@/client/lib/i18n/vi.srv.ts";

/**
 * English first, Vietnamese as the second language, with English as the source text.
 *
 * `t("Open shift")` returns the English string unchanged in English and the Vietnamese entry
 * from `src/client/lib/i18n/vi.*.ts` in Vietnamese; a missing entry falls back to the English so a
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

// Khóa định danh lưu trữ tùy chọn ngôn ngữ của người dùng trong localStorage
const STORAGE_KEY = "arena3.lang";
// English is the primary language (PRODUCT.md): it is what the server renders and what a first visit sees.
let current: Lang = "en";
// Danh sách các hàm callback đăng ký lắng nghe sự kiện thay đổi ngôn ngữ để kích hoạt re-render
const subscribers = new Set<() => void>();

/**
 * Làm gì: Điền giá trị thực tế vào các placeholder dạng `{key}` trong chuỗi mẫu.
 * Được gọi ở: Nội bộ file src/client/lib/i18n.tsx (trong hàm dịch t).
 * @param s Chuỗi mẫu chứa các placeholder dạng `{key}`.
 * @param vars Đối tượng chứa các cặp key-value dùng để thay thế vào chuỗi.
 * @returns Chuỗi văn bản sau khi đã thay thế các biến, hoặc chuỗi gốc nếu không truyền vars.
 */
const fill = (s: string, vars?: Vars) =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;

import { registerTranslator } from "../../shared/arena3/translator.ts";

/**
 * Làm gì: Dịch chuỗi tiếng Anh sang tiếng Việt dựa theo từ điển VI; tự động fallback về tiếng Anh gốc nếu chưa có bản dịch và điền các biến nội suy dạng `{key}`.
 * Được gọi ở: Hầu hết các component và trang giao diện client (như src/routes/__root.tsx, src/routes/app.index.tsx, src/client/components/lang-switch.tsx...); truyền vào registerTranslator để dùng ở tầng shared.
 * @param en Chuỗi tiếng Anh gốc dùng làm khóa tra cứu bản dịch.
 * @param vars Đối tượng tùy chọn chứa các biến cần điền vào placeholder `{key}`.
 * @returns Chuỗi tiếng Việt nếu tìm thấy bản dịch khi chọn "vi", hoặc giữ nguyên chuỗi tiếng Anh gốc.
 */
export function t(en: string, vars?: Vars): string {
  return fill(current === "vi" ? (VI[en] ?? en) : en, vars);
}

// Đăng ký hàm t với translator dùng chung ở src/shared/arena3/translator.ts để các file shared cũng dịch được chuỗi
registerTranslator(t);

/** Marks an English string for the checker without translating it yet. */
export const tk = <S extends string>(en: S): S => en;

/**
 * A message that came from the server in English (an error, a notification body). Exact matches
 * first, then the patterns for messages that carry numbers or names; anything else is shown as it
 * arrived.
 */
export function tServer(msg: string): string {
  // Bước 1: Trả về chuỗi nguyên bản nếu ngôn ngữ hiện tại là tiếng Anh hoặc thông báo rỗng
  if (current !== "vi" || !msg) return msg;
  // Bước 2: Tra cứu bản dịch khớp chính xác trong từ điển server VI_SERVER_EXACT hoặc từ điển giao diện VI
  const exact = VI_SERVER_EXACT[msg] ?? VI[msg];
  if (exact) return exact;
  // Bước 3: Thử so khớp các mẫu regex trong VI_SERVER_PATTERNS để thay thế tham số động ($1, $2...) như số tiền hoặc tên
  for (const [re, vi] of VI_SERVER_PATTERNS) {
    const m = re.exec(msg);
    if (m) return vi.replace(/\$(\d)/g, (_, i: string) => m[Number(i)] ?? "");
  }
  // Bước 4: Nếu không khớp bất kỳ mẫu nào, giữ nguyên thông báo gốc từ server
  return msg;
}

/** Seeded demo content stored in English in the database (plan, gear and staff names, health notes). */
export function tData<T extends string | null | undefined>(s: T): T {
  return (current === "vi" && s ? viData(s) : s) as T;
}

/**
 * Làm gì: Lấy mã ngôn ngữ hiện tại đang hoạt động ("en" hoặc "vi").
 * Được gọi ở: Nội bộ file src/client/lib/i18n.tsx (dùng làm snapshot selector cho useSyncExternalStore trong hook useLang).
 * @returns Mã ngôn ngữ hiện tại ("en" hoặc "vi").
 */
export const getLang = (): Lang => current;
/** The locale to hand to Intl / toLocale*String so dates and numbers read natively. */
export const locale = (): string => (current === "vi" ? "vi-VN" : "en-GB");

/**
 * Làm gì: Cập nhật ngôn ngữ toàn cục, đồng bộ thuộc tính lang của thẻ html, lưu vào localStorage và thông báo tới tất cả subscriber để cập nhật giao diện.
 * Được gọi ở: Nội bộ file src/client/lib/i18n.tsx (được gán cho export setLang và gọi trong useEffect của LangProvider).
 * @param next Ngôn ngữ đích cần áp dụng ("en" hoặc "vi").
 */
function apply(next: Lang) {
  // Bước 1: Bỏ qua nếu ngôn ngữ mới trùng khớp với ngôn ngữ hiện tại
  if (next === current) return;
  // Bước 2: Cập nhật biến trạng thái ngôn ngữ toàn cục trong bộ nhớ
  current = next;
  // Screen readers pick the voice from this, so it must change even when storage is blocked.
  if (typeof document !== "undefined") document.documentElement.lang = next;
  // Bước 3: Lưu lựa chọn vào localStorage; bao bọc try/catch để tránh lỗi ở chế độ duyệt web ẩn danh
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* private mode: the choice just lasts until reload */
  }
  // Bước 4: Thông báo tới tất cả subscriber để kích hoạt cập nhật lại giao diện
  subscribers.forEach((f) => f());
}

/**
 * Làm gì: Hàm kích hoạt chuyển đổi ngôn ngữ ứng dụng sang tiếng Anh ("en") hoặc tiếng Việt ("vi").
 * Được gọi ở: src/client/components/lang-switch.tsx (khi người dùng click nút chọn ngôn ngữ).
 * @param next Ngôn ngữ cần chuyển sang ("en" hoặc "vi").
 */
export const setLang = apply;

/**
 * Làm gì: Đăng ký hàm callback lắng nghe sự kiện đổi ngôn ngữ, phục vụ cơ chế đồng bộ của useSyncExternalStore.
 * Được gọi ở: Nội bộ file src/client/lib/i18n.tsx (trong hook useLang).
 * @param f Hàm callback thông báo cần re-render khi ngôn ngữ thay đổi.
 * @returns Hàm dọn dẹp (cleanup) để hủy đăng ký callback khỏi danh sách subscribers.
 */
const subscribe = (f: () => void) => {
  subscribers.add(f);
  return () => void subscribers.delete(f);
};

/**
 * Làm gì: React hook theo dõi và trả về ngôn ngữ hiện tại của ứng dụng qua useSyncExternalStore.
 * Được gọi ở: src/client/components/lang-switch.tsx; src/client/lib/i18n.tsx (trong LangProvider).
 * @returns Mã ngôn ngữ hiện tại ("en" hoặc "vi").
 */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, () => "en" as Lang);
}

/**
 * Keys the subtree by language, so a switch re-renders every `t()` call. The saved choice is read
 * after mount (the server and the first client render are always English, so hydration agrees).
 */
export function LangProvider({ children }: { children: ReactNode }) {
  // Bước 1: Lấy ngôn ngữ hiện tại thông qua hook useLang
  const lang = useLang();
  // Bước 2: Khi mount ở client, đọc ngôn ngữ đã lưu từ localStorage và áp dụng (tránh lệch hydration với server render vốn dùng tiếng Anh)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "vi" || saved === "en") apply(saved);
    } catch {
      /* ignore */
    }
  }, []);
  // Bước 3: Render cây con trong Fragment với key={lang} để buộc remount toàn bộ khi đổi ngôn ngữ, đảm bảo mọi lời gọi t() được thực thi lại
  return <Fragment key={lang}>{children}</Fragment>;
}
