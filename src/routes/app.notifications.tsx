import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { NotificationList, type Notification } from "@/components/notifications";
import { Shell } from "@/components/shell";
import { Button, EmptyState, LoadError, Pagination, Skeleton } from "@/components/ui";
import { t } from "@/lib/i18n";
import { usePageState } from "@/lib/use-page-state";
import { useRead } from "@/lib/use-read";
import { useLive } from "@/lib/use-live";

export const Route = createFileRoute("/app/notifications")({
  component: Page,
});

/** The member's inbox, apart from the account menu (G-08), a page at a time. */
function Page() {
  const [onlyNew, setOnlyNew] = useState(false);
  const { offset, setOffset, pageSize, setPageSize, reset } = usePageState("notifications", 25);
  useEffect(reset, [onlyNew, reset]);
  const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
  if (onlyNew) params.set("unread", "1");
  const { data, error, reload } = useRead<{ items: Notification[]; total: number; unread: number }>(
    `/me/notifications?${params}`,
    { keepPrevious: true },
  );
  useLive("notifications", reload);
  // The page is the server's copy, marked read here as the person opens things.
  const [items, setItems] = useState<Notification[] | null>(null);
  useEffect(() => {
    setItems(data?.items ?? null);
  }, [data]);

  const total = data?.total ?? 0;
  // The toggle is worth showing once something has been read, or while it is on.
  const showToggle = onlyNew || (data ? data.unread < data.total : false);

  return (
    <Shell
      role="member"
      title={t("Notifications")}
      subtitle={t("Receipts, booking changes and replies from reception. Open one to read it.")}
    >
      {error ? (
        <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
      ) : !items ? (
        <Skeleton className="h-32" />
      ) : (
        <>
          {showToggle ? (
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => setOnlyNew((v) => !v)}>
                {onlyNew ? t("Show read ones too") : t("Hide read ones")}
              </Button>
            </div>
          ) : null}
          {!items.length ? (
            onlyNew ? (
              <EmptyState title={t("Nothing unread")} hint={t("Everything here has been read.")} />
            ) : (
              <EmptyState
                title={t("Nothing here yet")}
                hint={t("Receipts and booking updates will show up here as they happen.")}
              />
            )
          ) : (
            <>
              <NotificationList
                items={items}
                limit={pageSize}
                onRead={(ids) =>
                  setItems((cur) =>
                    (cur ?? []).map((n) =>
                      ids.includes(n.id) && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n,
                    ),
                  )
                }
              />
              <Pagination
                offset={offset}
                total={total}
                pageSize={pageSize}
                onChange={setOffset}
                onPageSizeChange={setPageSize}
                label={t("Notification pages")}
              />
            </>
          )}
        </>
      )}
    </Shell>
  );
}
