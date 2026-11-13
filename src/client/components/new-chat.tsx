import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { roleLabel } from "@/client/components/shell";
import { EmptyState, Input, Skeleton } from "@/client/components/ui";
import { UserAvatar } from "@/client/components/user-avatar";
import { apiGet, apiPost } from "@/client/arena3/client";
import { t, tServer } from "@/client/lib/i18n";

type Contact = { id: string; full_name: string; role: string; member_code: string | null; avatar_url: string | null };

/**
 * Pick anyone with an active account and open (or reopen) a chat with them.
 * Search is by name or member code; the server never returns phone or email.
 */
export function NewChat({ onOpen, onClose }: { onOpen: (convId: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Contact[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const id = setTimeout(() => {
      apiGet<{ items: Contact[] }>(`/conversations/contacts?q=${encodeURIComponent(q.trim())}`)
        .then((r) => live && setItems(r.items))
        .catch(() => live && setItems([]));
    }, 200);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [q]);

  async function open(c: Contact) {
    setBusy(c.id);
    try {
      const res = await apiPost<{ conversation: { id: string } }>("/conversations", { recipient_id: c.id });
      onOpen(res.conversation.id);
    } catch (err) {
      toast.error(err instanceof Error ? tServer(err.message) : t("Could not open the chat"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line p-3.5">
        <Input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("Search people by name or member code…")}
          aria-label={t("Search people by name or member code…")}
          className="h-9 flex-1 text-xs"
        />
        <button
          type="button"
          onClick={onClose}
          aria-label={t("Close")}
          className="grid size-9 place-items-center rounded-full text-muted hover:bg-wood hover:text-fg"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {items == null ? (
          <div className="grid gap-2 p-2">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState title={t("No one found")} hint={t("Try another name or member code.")} />
        ) : (
          <ul className="grid gap-1">
            {items.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  disabled={busy != null}
                  onClick={() => void open(c)}
                  className="flex w-full items-center gap-3 rounded-[var(--radius-md)] p-2.5 text-left transition-colors duration-150 hover:bg-wood disabled:opacity-60"
                >
                  <UserAvatar name={c.full_name} url={c.avatar_url} className="size-9 rounded-full border border-line" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{c.full_name}</span>
                    <span className="block text-2xs text-muted">
                      {roleLabel(c.role as never)}
                      {c.member_code ? ` · ${c.member_code}` : ""}
                    </span>
                  </span>
                  {busy === c.id ? <span className="text-2xs text-muted">{t("Opening…")}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
