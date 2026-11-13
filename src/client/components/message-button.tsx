import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/client/components/ui";
import { apiPost } from "@/client/arena3/client";
import { t, tServer } from "@/client/lib/i18n";

/** Opens (or reopens) the chat with this person and jumps to it. */
export function MessageButton({ userId, compact = false }: { userId: string; compact?: boolean }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function open(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    try {
      const res = await apiPost<{ conversation: { id: string } }>("/conversations", { recipient_id: userId });
      await navigate({ to: "/chat", search: { conv: res.conversation.id } as never });
    } catch (err) {
      toast.error(err instanceof Error ? tServer(err.message) : t("Could not open the chat"));
    } finally {
      setBusy(false);
    }
  }

  if (compact) {
    return (
      <button
        type="button"
        onClick={open}
        disabled={busy}
        aria-label={t("Message")}
        title={t("Message")}
        className="grid size-8 place-items-center rounded-full text-muted transition-colors hover:bg-wood hover:text-fg disabled:opacity-50"
      >
        <MessageSquare className="size-4" />
      </button>
    );
  }
  return (
    <Button size="sm" variant="outline" onClick={open} disabled={busy}>
      <MessageSquare className="size-4" />
      {busy ? t("Opening…") : t("Message")}
    </Button>
  );
}
