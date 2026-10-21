/**
 * Paging arithmetic shared by every long list.
 *
 * Pure functions only (no React, no imports), so the node test runner checks them directly.
 */

/** The page sizes a person can pick. A list's default should be one of these. */
export const PAGE_SIZES = [10, 25, 50, 100] as const;

export type PageSlot = number | "gap";

/**
 * Which page buttons to draw: always the first and last page, the current one and its
 * neighbours, and a gap where pages are skipped ("1 … 4 5 6 … 20"). A gap never stands in for
 * a single page: "1 … 3" becomes "1 2 3", since the button takes the same room as the dots, and
 * up to seven pages are all drawn.
 */
export function pageWindow(page: number, pages: number, around = 1): PageSlot[] {
  if (pages <= 0) return [];
  // Few enough pages to show every one in the room the gaps would take.
  if (pages <= 2 * around + 5) return Array.from({ length: pages }, (_, i) => i + 1);
  const current = Math.min(Math.max(1, page), pages);
  const keep = new Set<number>([1, pages]);
  for (let p = current - around; p <= current + around; p++) if (p >= 1 && p <= pages) keep.add(p);
  const sorted = [...keep].sort((a, b) => a - b);
  const out: PageSlot[] = [];
  for (const p of sorted) {
    const prev = out[out.length - 1];
    if (typeof prev === "number" && p - prev === 2) out.push(prev + 1);
    else if (typeof prev === "number" && p - prev > 2) out.push("gap");
    out.push(p);
  }
  return out;
}

/**
 * The offset of the page that holds `offset` once pages are `size` rows long, so the row at
 * the top stays on screen when someone switches from 10 to 50 rows a page.
 */
export function alignOffset(offset: number, size: number): number {
  if (size <= 0) return 0;
  return Math.floor(Math.max(0, offset) / size) * size;
}

/** The offset of the last page, for a list that shrank under the page someone was on. */
export function lastPageOffset(total: number, size: number): number {
  if (total <= 0 || size <= 0) return 0;
  return alignOffset(total - 1, size);
}
