import { useCallback, useEffect, useState } from "react";
import { PAGE_SIZES, alignOffset } from "./paging";

const storageKey = (list: string) => `arena3.pageSize.${list}`;

/**
 * Offset and page size for one long list, with the page size remembered per list.
 *
 * The stored size is read after mount: the server render has no storage, so the first client
 * render must match it. Storage can be blocked (private mode); the choice then lasts the visit.
 * Callers reset to page one when their filters change: `useEffect(reset, [filters])`.
 */
export function usePageState(list: string, defaultSize: number = 25) {
  const [pageSize, setSize] = useState(defaultSize);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey(list)));
      if ((PAGE_SIZES as readonly number[]).includes(saved)) setSize(saved);
    } catch {
      /* storage blocked */
    }
  }, [list]);

  const setPageSize = useCallback(
    (size: number) => {
      setOffset((o) => alignOffset(o, size));
      setSize(size);
      try {
        localStorage.setItem(storageKey(list), String(size));
      } catch {
        /* storage blocked: the choice lasts this visit */
      }
    },
    [list],
  );

  const reset = useCallback(() => setOffset(0), []);

  return { offset, setOffset, pageSize, setPageSize, reset };
}
