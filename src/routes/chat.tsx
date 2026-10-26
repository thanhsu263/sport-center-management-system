import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { AlertCircle, ArrowLeft, Check, CheckCheck, Clock, MessageSquare, RefreshCw, Send, ShieldCheck, Zap } from "lucide-react";
import { toast } from "sonner";
import { Guard, Shell, initials, roleLabel, useSessionUser } from "@/components/shell";
import { Badge, Button, Card, EmptyState, Input, LoadError, Skeleton } from "@/components/ui";
import { Cover } from "@/components/media";
import { apiGet, apiPost } from "@/lib/arena3/client";
import { locale, t, tServer } from "@/lib/i18n";
import { HighlightBadge, useLive } from "@/lib/use-live";
import { useRead } from "@/lib/use-read";
import { P2PRoom } from "@/lib/multiplayer/p2p";
import { cn } from "@/lib/cn";

export const Route = createFileRoute("/chat")({
  validateSearch: (search: Record<string, unknown>): { conv?: string } => ({
    conv: typeof search.conv === "string" ? search.conv : undefined,
  }),
  component: () => (
    <Guard roles={["member", "coach", "receptionist", "manager"]}>
      <ChatPage />
    </Guard>
  ),
});

export interface ConversationItem {
  id: string;
  peer_id: string;
  peer_name: string;
  peer_role: string;
  peer_phone: string | null;
  last_message: {
    id: string;
    sender_id: string;
    body: string;
    created_at: string;
  } | null;
  unread_count: number;
}

export interface MessageItem {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  read_at: string | null;
  status?: "sending" | "sent" | "failed" | "read";
}

function formatChatTime(iso: string) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
      return d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString(locale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function ChatPage() {
  const user = useSessionUser();
  const navigate = useNavigate();
  const search = useSearch({ from: "/chat" });
  const activeConvId = search.conv;

  const { data: convsData, error: convsErr, reload: reloadConvs } = useRead<{ conversations: ConversationItem[] }>("/conversations");
  useLive("chat", reloadConvs);
  useLive("notifications", reloadConvs);

  const [activeConv, setActiveConv] = useState<ConversationItem | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [inputText, setInputText] = useState("");
  const [isP2PDirect, setIsP2PDirect] = useState(false);
  const [peerTyping, setPeerTyping] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const p2pRef = useRef<P2PRoom | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevConvIdRef = useRef<string | undefined>(undefined);

  // Sync active conversation object
  useEffect(() => {
    const list = convsData?.conversations ?? (convsData as any)?.items;
    if (!list) return;
    if (activeConvId) {
      const found = list.find((c: ConversationItem) => c.id === activeConvId);
      if (found) setActiveConv(found);
    } else {
      setActiveConv(null);
    }
  }, [convsData, activeConvId]);

  // Load messages when activeConvId changes
  const loadMessages = useCallback(async (convId: string, before?: string) => {
    try {
      if (before) setLoadingHistory(true);
      const url = before
        ? `/conversations/${convId}/messages?before=${encodeURIComponent(before)}`
        : `/conversations/${convId}/messages`;
      const res = await apiGet<{ items: MessageItem[]; has_more: boolean }>(url);
      if (before) {
        setMessages((prev) => {
          const existingIds = new Set(prev.map((m) => m.id));
          const newItems = res.items.filter((m) => !existingIds.has(m.id));
          return [...newItems, ...prev];
        });
      } else {
        setMessages(res.items);
      }
      setHasMore(res.has_more);
    } catch (e: any) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Failed to load messages"));
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  // Mark conversation as read
  const markRead = useCallback(async (convId: string) => {
    try {
      await apiPost(`/conversations/${convId}/read`, {});
      reloadConvs();
    } catch {
      // Ignore background read error
    }
  }, [reloadConvs]);

  // Setup P2P connection when active conversation changes
  useEffect(() => {
    if (!activeConvId || !user) {
      if (p2pRef.current) {
        p2pRef.current.close();
        p2pRef.current = null;
      }
      setIsP2PDirect(false);
      setPeerTyping(false);
      return;
    }

    if (prevConvIdRef.current !== activeConvId) {
      prevConvIdRef.current = activeConvId;
      setMessages([]);
      void loadMessages(activeConvId);
      void markRead(activeConvId);
    }

    // Initialize WebRTC P2PRoom
    const room = new P2PRoom({
      room: activeConvId,
      selfId: user.id,
      name: user.full_name,
      onPeersChanged: (peers) => {
        const isConnected = peers.some((p) => p.connectionState === "connected");
        setIsP2PDirect(isConnected);
      },
      onMessage: (_from, data) => {
        if (!data || typeof data !== "object") return;
        const msg = data as Record<string, unknown>;

        if (msg.type === "chat_msg" && typeof msg.id === "string" && typeof msg.body === "string") {
          const newMsg: MessageItem = {
            id: msg.id,
            conversation_id: activeConvId,
            sender_id: String(msg.sender_id),
            body: msg.body,
            created_at: typeof msg.created_at === "string" ? msg.created_at : new Date().toISOString(),
            read_at: null,
            status: "sent",
          };
          setMessages((prev) => {
            if (prev.some((m) => m.id === newMsg.id)) return prev;
            return [...prev, newMsg];
          });
          // Send P2P read receipt and mark read on server
          room.send({ type: "chat_read", conversation_id: activeConvId, message_id: newMsg.id });
          void markRead(activeConvId);
        } else if (msg.type === "chat_typing") {
          setPeerTyping(Boolean(msg.typing));
          if (msg.typing) {
            if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
            typingTimerRef.current = setTimeout(() => setPeerTyping(false), 3000);
          }
        } else if (msg.type === "chat_read") {
          setMessages((prev) =>
            prev.map((m) => (m.sender_id === user.id && !m.read_at ? { ...m, read_at: new Date().toISOString(), status: "read" } : m)),
          );
        }
      },
    });

    void room.join();
    p2pRef.current = room;

    return () => {
      room.close();
      p2pRef.current = null;
      setIsP2PDirect(false);
      setPeerTyping(false);
    };
  }, [activeConvId, user, loadMessages, markRead]);

  // Realtime updates via SSE topic for this conversation
  useLive(activeConvId ? `chat:${activeConvId}` : null, () => {
    if (activeConvId) {
      void loadMessages(activeConvId);
      void markRead(activeConvId);
    }
  });

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, peerTyping]);

  // Handle typing notification
  const handleInputChange = (val: string) => {
    setInputText(val);
    if (p2pRef.current && isP2PDirect) {
      p2pRef.current.send({ type: "chat_typing", typing: val.length > 0 });
    }
  };

  // Send a message
  const handleSend = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = inputText.trim();
    if (!text || !activeConvId || !user) return;

    const clientMsgId = crypto.randomUUID();
    const optimisticMsg: MessageItem = {
      id: clientMsgId,
      conversation_id: activeConvId,
      sender_id: user.id,
      body: text,
      created_at: new Date().toISOString(),
      read_at: null,
      status: "sending",
    };

    // 1. Optimistic UI update
    setMessages((prev) => [...prev, optimisticMsg]);
    setInputText("");

    // Notify typing stopped
    if (p2pRef.current && isP2PDirect) {
      p2pRef.current.send({ type: "chat_typing", typing: false });
    }

    // 2. Send via P2P DataChannel if direct connection is open
    if (p2pRef.current && isP2PDirect) {
      p2pRef.current.send({
        type: "chat_msg",
        id: clientMsgId,
        conversation_id: activeConvId,
        sender_id: user.id,
        body: text,
        created_at: optimisticMsg.created_at,
      });
    }

    // 3. Simultaneously POST to API to persist
    try {
      await apiPost(`/conversations/${activeConvId}/messages`, { id: clientMsgId, body: text });
      setMessages((prev) => prev.map((m) => (m.id === clientMsgId ? { ...m, status: "sent" } : m)));
      reloadConvs();
    } catch (err: any) {
      setMessages((prev) => prev.map((m) => (m.id === clientMsgId ? { ...m, status: "failed" } : m)));
      toast.error(err instanceof Error ? tServer(err.message) : t("Failed to send message"));
    }
  };

  // Retry sending failed message
  const handleRetry = async (msg: MessageItem) => {
    if (!activeConvId) return;
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, status: "sending" } : m)));
    try {
      await apiPost(`/conversations/${activeConvId}/messages`, { id: msg.id, body: msg.body });
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, status: "sent" } : m)));
    } catch {
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, status: "failed" } : m)));
      toast.error(t("Failed to send message"));
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const conversations: ConversationItem[] = convsData?.conversations ?? (convsData as any)?.items ?? [];
  const filteredConvs = conversations.filter((c) =>
    searchQuery ? c.peer_name.toLowerCase().includes(searchQuery.toLowerCase()) : true,
  );

  return (
    <Shell role={user?.role ?? "member"} title={t("Messages")} subtitle={t("Real-time two-way messaging")}>
      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface shadow-[var(--shadow-soft)]">
        <div className="grid h-[78vh] min-h-[500px] grid-cols-1 lg:grid-cols-12">
          {/* Left Column: Conversations List */}
          <div
            className={cn(
              "flex flex-col border-r border-line bg-surface/50 lg:col-span-5 xl:col-span-4",
              activeConvId ? "hidden lg:flex" : "flex",
            )}
          >
            {/* Conversations Header */}
            <div className="border-b border-line p-3.5">
              <div className="mb-2.5 flex items-center justify-between">
                <h2 className="text-base font-semibold text-fg">{t("Conversations")}</h2>
                <Badge tone="accent">
                  <HighlightBadge value={conversations.reduce((acc, c) => acc + (Number(c.unread_count) || 0), 0)}>
                    {t("{n} unread", { n: conversations.reduce((acc, c) => acc + (Number(c.unread_count) || 0), 0) })}
                  </HighlightBadge>
                </Badge>
              </div>
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("Search conversations...")}
                className="h-9 text-xs"
              />
            </div>

            {/* Conversations List */}
            <div className="flex-1 overflow-y-auto p-2">
              {convsErr ? (
                <LoadError message={convsErr.message} onRetry={reloadConvs} />
              ) : !convsData ? (
                <div className="grid gap-2 p-2">
                  <Skeleton className="h-16" />
                  <Skeleton className="h-16" />
                  <Skeleton className="h-16" />
                </div>
              ) : filteredConvs.length === 0 ? (
                <EmptyState
                  title={t("No conversations")}
                  hint={t("Your conversations with coaches and members will appear here.")}
                />
              ) : (
                <ul className="grid gap-1">
                  {filteredConvs.map((conv) => {
                    const isSelected = conv.id === activeConvId;
                    return (
                      <li key={conv.id}>
                        <button
                          type="button"
                          onClick={() => navigate({ to: "/chat", search: { conv: conv.id } })}
                          className={cn(
                            "flex w-full items-center gap-3 rounded-[var(--radius-md)] p-2.5 text-left transition-colors duration-150",
                            isSelected
                              ? "bg-accent/15 text-fg shadow-sm"
                              : "hover:bg-wood/60 text-muted",
                          )}
                        >
                          <div className="relative shrink-0">
                            <Cover
                              slot={`avatar.${conv.peer_id}`}
                              fallbackInitials={initials(conv.peer_name)}
                              className="size-11 rounded-full border border-line"
                              initialsClassName="text-xs font-bold"
                              alt={conv.peer_name}
                            />
                            {conv.unread_count > 0 ? (
                              <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-accent-2 px-1 text-2xs font-bold leading-4 text-surface tabular-nums">
                                {conv.unread_count > 9 ? "9+" : conv.unread_count}
                              </span>
                            ) : null}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-1">
                              <span className={cn("truncate text-sm", conv.unread_count > 0 ? "font-bold text-fg" : "font-medium text-fg")}>
                                {conv.peer_name}
                              </span>
                              {conv.last_message ? (
                                <span className="shrink-0 text-3xs text-subtle">
                                  {formatChatTime(conv.last_message.created_at)}
                                </span>
                              ) : null}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-3xs text-subtle capitalize">{roleLabel(conv.peer_role)}</span>
                              {conv.last_message ? (
                                <span className="truncate text-xs text-muted">
                                  {conv.last_message.sender_id === user?.id ? `${t("You")}: ` : ""}
                                  {conv.last_message.body}
                                </span>
                              ) : (
                                <span className="text-3xs italic text-subtle">{t("No messages yet")}</span>
                              )}
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          {/* Right Column: Chat Box */}
          <div
            className={cn(
              "flex flex-col bg-surface lg:col-span-7 xl:col-span-8",
              activeConvId ? "flex" : "hidden lg:flex",
            )}
          >
            {activeConv ? (
              <>
                {/* Active Chat Header */}
                <div className="flex h-16 items-center justify-between border-b border-line px-4">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => navigate({ to: "/chat", search: { conv: undefined } })}
                      className="grid size-9 place-items-center rounded-full text-muted hover:bg-wood hover:text-fg lg:hidden"
                      aria-label={t("Back to conversations")}
                    >
                      <ArrowLeft className="size-5" />
                    </button>
                    <Cover
                      slot={`avatar.${activeConv.peer_id}`}
                      fallbackInitials={initials(activeConv.peer_name)}
                      className="size-10 rounded-full border border-line"
                      initialsClassName="text-xs font-bold"
                      alt={activeConv.peer_name}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-fg">{activeConv.peer_name}</span>
                        <span className="rounded bg-wood px-1.5 py-0.5 text-3xs text-muted capitalize">
                          {roleLabel(activeConv.peer_role)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-3xs">
                        {/* P2P vs Server Indicator with Tooltip */}
                        <div
                          className="flex items-center gap-1 cursor-help"
                          title={
                            isP2PDirect
                              ? t("P2P Direct: Instant encrypted peer-to-peer data channel active")
                              : t("Server Relay: Connected via secure realtime server")
                          }
                        >
                          <span
                            className={cn(
                              "size-2 rounded-full",
                              isP2PDirect ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" : "bg-amber-500",
                            )}
                          />
                          <span className={cn("font-medium", isP2PDirect ? "text-emerald-500" : "text-amber-500")}>
                            {isP2PDirect ? t("P2P Direct") : t("Server Relay")}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Message Stream */}
                <div className="flex-1 overflow-y-auto p-4">
                  {hasMore ? (
                    <div className="mb-3 text-center">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={loadingHistory}
                        onClick={() => {
                          const oldest = messages[0];
                          if (oldest) void loadMessages(activeConv.id, oldest.created_at);
                        }}
                        className="text-xs text-muted"
                      >
                        {loadingHistory ? <RefreshCw className="mr-1.5 size-3 animate-spin" /> : null}
                        {t("Load older messages")}
                      </Button>
                    </div>
                  ) : null}

                  {messages.length === 0 ? (
                    <div className="grid h-full place-items-center">
                      <EmptyState
                        title={t("Say hello!")}
                        hint={t("Send a message to start chatting with {name}.", { name: activeConv.peer_name })}
                      />
                    </div>
                  ) : (
                    <div className="grid gap-3">
                      {messages.map((m) => {
                        const isMe = m.sender_id === user?.id;
                        return (
                          <div key={m.id} className={cn("flex flex-col", isMe ? "items-end" : "items-start")}>
                            <div
                              className={cn(
                                "max-w-[85%] rounded-[var(--radius-lg)] px-3.5 py-2.5 text-sm shadow-sm sm:max-w-[70%]",
                                isMe
                                  ? "bg-accent text-accent-fg"
                                  : "border border-line bg-surface/90 text-fg",
                              )}
                            >
                              {/* Safely render escaped text */}
                              <p className="whitespace-pre-wrap break-words">{m.body}</p>
                            </div>
                            <div className="mt-1 flex items-center gap-1.5 px-1 text-3xs text-subtle">
                              <span>{formatChatTime(m.created_at)}</span>
                              {isMe ? (
                                <span className="flex items-center gap-0.5">
                                  {m.status === "sending" ? (
                                    <span title={t("Sending...")}>
                                      <Clock className="size-3 text-muted animate-pulse" />
                                    </span>
                                  ) : m.status === "failed" ? (
                                    <button
                                      type="button"
                                      onClick={() => void handleRetry(m)}
                                      className="flex items-center gap-0.5 text-danger underline hover:opacity-80"
                                      title={t("Failed to send. Click to retry.")}
                                    >
                                      <AlertCircle className="size-3" />
                                      <span>{t("Retry")}</span>
                                    </button>
                                  ) : m.read_at || m.status === "read" ? (
                                    <span title={t("Read")}>
                                      <CheckCheck className="size-3 text-emerald-400" />
                                    </span>
                                  ) : (
                                    <span title={t("Sent")}>
                                      <Check className="size-3 text-muted" />
                                    </span>
                                  )}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                      {peerTyping ? (
                        <div className="flex items-center gap-2 text-xs text-muted italic">
                          <span className="flex gap-1">
                            <span className="size-1.5 rounded-full bg-accent animate-bounce" />
                            <span className="size-1.5 rounded-full bg-accent animate-bounce [animation-delay:0.2s]" />
                            <span className="size-1.5 rounded-full bg-accent animate-bounce [animation-delay:0.4s]" />
                          </span>
                          <span>{t("{name} is typing...", { name: activeConv.peer_name })}</span>
                        </div>
                      ) : null}
                      <div ref={messagesEndRef} />
                    </div>
                  )}
                </div>

                {/* Message Input Box */}
                <form onSubmit={handleSend} className="border-t border-line p-3">
                  <div className="flex items-center gap-2">
                    <Input
                      value={inputText}
                      onChange={(e) => handleInputChange(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={t("Type a message...")}
                      maxLength={2000}
                      className="flex-1"
                    />
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={!inputText.trim()}
                      className="shrink-0 px-4"
                      aria-label={t("Send message")}
                    >
                      <Send className="size-4" />
                      <span className="hidden sm:inline">{t("Send")}</span>
                    </Button>
                  </div>
                </form>
              </>
            ) : (
              <div className="grid h-full place-items-center p-8 text-center">
                <div className="grid max-w-sm gap-2">
                  <div className="mx-auto grid size-12 place-items-center rounded-full bg-wood text-muted">
                    <MessageSquare className="size-6" />
                  </div>
                  <h3 className="text-base font-semibold text-fg">{t("Select a conversation")}</h3>
                  <p className="text-xs text-muted">
                    {t("Choose a chat from the left sidebar or click 'Message coach' in any class to start a conversation.")}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}
