/**
 * Quản lý giao diện và định tuyến trang chat hai chiều thời gian thực (/chat) trong hệ thống Arena 3.
 * Cho phép các vai trò (member, coach, receptionist, manager) trao đổi tin nhắn trực tiếp với nhau.
 * Kết hợp WebRTC P2P DataChannel (độ trễ thấp) với SSE và REST API để đồng bộ và lưu trữ tin nhắn bền vững.
 */
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { AlertCircle, ArrowLeft, PenSquare, Check, CheckCheck, Clock, MessageSquare, RefreshCw, Send } from "lucide-react";
import { toast } from "sonner";
import { Guard, Shell, roleLabel, useSessionUser } from "@/client/components/shell";
import { Badge, Button, EmptyState, Input, LoadError, Skeleton } from "@/client/components/ui";
import { UserAvatar } from "@/client/components/user-avatar";
import { NewChat } from "@/client/components/new-chat";
import { apiGet, apiPost, getToken } from "@/client/arena3/client";
import { locale, t, tServer } from "@/client/lib/i18n";
import { HighlightBadge, useLive } from "@/client/lib/use-live";
import { useRead } from "@/client/lib/use-read";
import { P2PRoom } from "@/client/lib/multiplayer/p2p";
import { cn } from "@/client/lib/cn";
import { scrollBehavior } from "@/client/lib/calm";

/**
 * Làm gì: Khởi tạo cấu hình định tuyến cho route /chat bằng TanStack Router, xác thực search param conv và bảo vệ quyền truy cập bằng Guard.
 * Được gọi ở: URL /chat hoặc /chat?conv=<id> (TanStack Router tự động đăng ký và nạp route).
 * @returns Cấu hình route cho đường dẫn /chat.
 */
export const Route = createFileRoute("/chat")({
  // Xác thực và chuẩn hóa query param conv trên URL (ID cuộc hội thoại), trả về undefined nếu không phải chuỗi
  validateSearch: (search: Record<string, unknown>): { conv?: string } => ({
    conv: typeof search.conv === "string" ? search.conv : undefined,
  }),
  component: () => (
    <Guard roles={["member", "coach", "receptionist", "manager"]}>
      <ChatPage />
    </Guard>
  ),
});

// Cấu trúc dữ liệu chi tiết một cuộc hội thoại (thông tin người chat cùng, tin nhắn gần nhất, số lượng tin chưa đọc) trả về từ API /conversations.
export interface ConversationItem {
  id: string;
  peer_id: string;
  peer_name: string;
  peer_role: string;
  peer_phone: string | null;
  peer_avatar_url?: string | null;
  peer?: {
    id: string;
    full_name: string;
    role: string;
    member_code: string | null;
    avatar_url: string | null;
  };
  last_message: {
    id: string;
    sender_id: string;
    body: string;
    created_at: string;
  } | null;
  unread_count: number;
}

// Cấu trúc dữ liệu một tin nhắn trong cuộc hội thoại, kèm trạng thái gửi (sending, sent, failed, read) phục vụ Optimistic UI.
export interface MessageItem {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  read_at: string | null;
  status?: "sending" | "sent" | "failed" | "read";
}

/**
 * Làm gì: Định dạng chuỗi thời gian ISO thành định dạng hiển thị giờ/ngày thân thiện với người dùng (chỉ hiện giờ nếu trong ngày, hiện ngày tháng nếu trước đó).
 * Được gọi ở: `src/routes/chat.tsx` tại danh sách cuộc hội thoại (dòng 433) và bong bóng tin nhắn chat (dòng 564).
 * @param iso Chuỗi thời gian chuẩn ISO 8601 của tin nhắn.
 * @returns Chuỗi thời gian đã định dạng theo ngôn ngữ hiện tại, hoặc chuỗi rỗng nếu thời gian không hợp lệ.
 */
function formatChatTime(iso: string) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    // Nếu tin nhắn gửi trong ngày hôm nay thì chỉ hiển thị giờ:phút, ngược lại hiển thị thêm ngày tháng
    if (isToday) {
      return d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString(locale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/**
 * Làm gì: Component chính hiển thị trang chat, quản lý danh sách cuộc hội thoại, kết nối WebRTC P2P, tải lịch sử tin nhắn và gửi/nhận tin nhắn thời gian thực.
 * Được gọi ở: `src/routes/chat.tsx` trong component của Route (dòng 23).
 * @returns JSX phần tử giao diện trang tin nhắn gồm danh sách cuộc hội thoại bên trái và khung chat bên phải.
 */
function ChatPage() {
  // Bước 1: Lấy thông tin người dùng hiện tại từ session, hook điều hướng và search param conv trên URL
  const user = useSessionUser();
  const navigate = useNavigate();
  const search = useSearch({ from: "/chat" });
  const activeConvId = search.conv;

  // Bước 2: Tải danh sách cuộc hội thoại từ API /conversations
  const { data: convsData, error: convsErr, reload: reloadConvs } = useRead<{ conversations: ConversationItem[] }>("/conversations");
  // There is no "chat" topic: `filterAllowedTopics` only ever allowed
  // "chat:<id>", so subscribing to the bare name was dropped on the server and
  // this list has always been kept current by `notifications` alone.
  useLive("notifications", reloadConvs);

  // Bước 3: Khởi tạo các state và ref quản lý cuộc hội thoại đang mở, danh sách tin nhắn, trạng thái WebRTC P2P và ô nhập liệu
  const [activeConv, setActiveConv] = useState<ConversationItem | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [inputText, setInputText] = useState("");
  const [isP2PDirect, setIsP2PDirect] = useState(false);
  const [peerTyping, setPeerTyping] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [composing, setComposing] = useState(false);

  const p2pRef = useRef<P2PRoom | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevConvIdRef = useRef<string | undefined>(undefined);

  // Sync active conversation object
  useEffect(() => {
    // Bước 4: Tự động đồng bộ đối tượng activeConv khi danh sách hội thoại tải xong hoặc activeConvId trên URL thay đổi
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
  /**
   * Làm gì: Tải lịch sử tin nhắn của cuộc hội thoại từ API /conversations/:id/messages, hỗ trợ phân trang ngược khi cuộn lên xem tin cũ.
   * Được gọi ở: `src/routes/chat.tsx` trong useEffect khi đổi hội thoại (dòng 164), trong useLive khi có tin mới (dòng 235), hoặc nút tải thêm tin cũ (dòng 529).
   * @param convId Mã ID của cuộc hội thoại cần lấy tin nhắn.
   * @param before Mốc thời gian/ID tin nhắn cũ nhất hiện tại để phân trang tải tin nhắn trước đó (tùy chọn).
   * @returns Promise<void>
   */
  const loadMessages = useCallback(async (convId: string, before?: string) => {
    try {
      // Bước 1: Bật cờ loadingHistory nếu đang tải tin cũ, chuẩn bị URL truy vấn có hoặc không có query before
      if (before) setLoadingHistory(true);
      const url = before
        ? `/conversations/${convId}/messages?before=${encodeURIComponent(before)}`
        : `/conversations/${convId}/messages`;
      // Bước 2: Gọi API lấy dữ liệu tin nhắn và cập nhật danh sách; nếu tải tin cũ thì lọc trùng ID rồi ghép lên trước
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
      // Bước 3: Bắt lỗi nếu gọi API thất bại và hiển thị thông báo lỗi bằng toast
      toast.error(e instanceof Error ? tServer(e.message) : t("Failed to load messages"));
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  // Mark conversation as read
  /**
   * Làm gì: Gửi yêu cầu lên server qua API POST /conversations/:id/read để đánh dấu tất cả tin nhắn trong hội thoại là đã đọc, đồng thời tải lại danh sách hội thoại.
   * Được gọi ở: `src/routes/chat.tsx` khi mở cuộc hội thoại (dòng 165), khi nhận tin nhắn P2P mới (dòng 206) hoặc khi nhận sự kiện SSE (dòng 236).
   * @param convId Mã ID của cuộc hội thoại cần đánh dấu đã đọc.
   * @returns Promise<void>
   */
  const markRead = useCallback(async (convId: string) => {
    try {
      // Gửi request đánh dấu đã đọc lên server; bỏ qua lỗi nền nếu có vì đây là thao tác phụ
      await apiPost(`/conversations/${convId}/read`, {});
      reloadConvs();
    } catch {
      // Ignore background read error
    }
  }, [reloadConvs]);

  // Setup P2P connection when active conversation changes
  useEffect(() => {
    // Bước 1: Dọn dẹp phòng P2P và reset trạng thái nếu không có hội thoại nào được chọn hoặc người dùng chưa đăng nhập
    if (!activeConvId || !user) {
      if (p2pRef.current) {
        p2pRef.current.close();
        p2pRef.current = null;
      }
      setIsP2PDirect(false);
      setPeerTyping(false);
      return;
    }

    // Bước 2: Khi chuyển sang cuộc hội thoại mới, xóa danh sách tin cũ trên giao diện và tải dữ liệu mới từ server
    if (prevConvIdRef.current !== activeConvId) {
      prevConvIdRef.current = activeConvId;
      setMessages([]);
      void loadMessages(activeConvId);
      void markRead(activeConvId);
    }

    // Initialize WebRTC P2PRoom
    // Bước 3: Khởi tạo kết nối WebRTC P2PRoom với signaling server để nhắn tin trực tiếp ngang hàng giữa 2 người dùng
    const room = new P2PRoom({
      room: activeConvId,
      selfId: user.id,
      name: user.full_name,
      // `/rtc` goes through `authFromRequest` like every other route, and these
      // calls carried no token at all — so every poll, signal and leave came
      // back 401 and the room never connected to anybody. Passed as a getter so
      // the leave fired during teardown still uses a current token.
      getAuthToken: getToken,
      // Messages still go through the server relay, so there is nothing to tell
      // the member — but the badge must not keep implying a direct link is
      // being negotiated when the relay has shut us out.
      onAuthError: () => setIsP2PDirect(false),
      onPeersChanged: (peers) => {
        const isConnected = peers.some((p) => p.connectionState === "connected");
        setIsP2PDirect(isConnected);
      },
      onMessage: (_from, data) => {
        if (!data || typeof data !== "object") return;
        const msg = data as Record<string, unknown>;

        // Xử lý khi nhận tin nhắn trực tiếp qua DataChannel: thêm vào danh sách, gửi phản hồi đã đọc (chat_read) và gọi API markRead
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
        // Cập nhật trạng thái đối phương đang gõ phím; tự động hủy trạng thái sau 3000ms nếu không có tín hiệu mới
        } else if (msg.type === "chat_typing") {
          setPeerTyping(Boolean(msg.typing));
          if (msg.typing) {
            if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
            typingTimerRef.current = setTimeout(() => setPeerTyping(false), 3000);
          }
        // Cập nhật trạng thái tin nhắn của mình sang "read" khi nhận tín hiệu đối phương đã đọc qua P2P
        } else if (msg.type === "chat_read") {
          setMessages((prev) =>
            prev.map((m) => (m.sender_id === user.id && !m.read_at ? { ...m, read_at: new Date().toISOString(), status: "read" } : m)),
          );
        }
      },
    });

    // Bước 4: Tham gia phòng WebRTC và thiết lập hàm dọn dẹp (cleanup) khi unmount hoặc đổi cuộc hội thoại
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
    // Khi nhận sự kiện qua kênh SSE (fallback khi P2P chưa kết nối): tải lại tin nhắn và đánh dấu đã đọc
    if (activeConvId) {
      void loadMessages(activeConvId);
      void markRead(activeConvId);
    }
  });

  // Keep the newest message in view.
  //
  // Unlike the assistant's thread, this column is `flex-1` with no height cap:
  // it grows with the conversation and the scrolling happens on the document,
  // so there is no inner scrollport to move. `block: "nearest"` is what stops
  // the jumping — it scrolls only when the foot of the thread is actually out
  // of view, and only as far as it must, where `block: "end"` (the default)
  // re-aligned the page on every message. `behavior` was hardcoded "smooth",
  // which animated regardless of `prefers-reduced-motion`.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
  }, [messages, peerTyping]);

  // Handle typing notification
  /**
   * Làm gì: Cập nhật nội dung văn bản trong ô nhập tin nhắn và phát sự kiện typing qua kết nối P2P tới đối phương.
   * Được gọi ở: `src/routes/chat.tsx` trong sự kiện onChange của thẻ Input nhập tin nhắn (dòng 616).
   * @param val Giá trị chuỗi mới đang được người dùng nhập vào.
   * @returns void
   */
  const handleInputChange = (val: string) => {
    setInputText(val);
    if (p2pRef.current && isP2PDirect) {
      p2pRef.current.send({ type: "chat_typing", typing: val.length > 0 });
    }
  };

  // Send a message
  /**
   * Làm gì: Xử lý gửi tin nhắn mới: thêm ngay vào UI (Optimistic UI), phát tin nhắn qua WebRTC P2P nếu có kết nối trực tiếp và đồng thời lưu vào server qua API POST.
   * Được gọi ở: `src/routes/chat.tsx` trong sự kiện onSubmit của form chat (dòng 612) và phím Enter trong handleKeyDown (dòng 326).
   * @param e Sự kiện gửi form (FormEvent), tùy chọn.
   * @returns Promise<void>
   */
  const handleSend = async (e?: FormEvent) => {
    e?.preventDefault();
    // Kiểm tra nội dung tin nhắn hợp lệ, đảm bảo đã chọn cuộc hội thoại và người dùng đã đăng nhập
    const text = inputText.trim();
    if (!text || !activeConvId || !user) return;

    // Tạo ID duy nhất (UUID v4) ở client để phục vụ Optimistic UI và đồng bộ trạng thái tin nhắn giữa P2P và server
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
    // Gọi API lưu tin nhắn; nếu thành công cập nhật trạng thái "sent", nếu lỗi chuyển sang "failed" và thông báo toast
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
  /**
   * Làm gì: Thử gửi lại tin nhắn bị lỗi (status "failed") bằng cách cập nhật lại trạng thái thành "sending" và gọi lại API lưu tin nhắn.
   * Được gọi ở: `src/routes/chat.tsx` trong sự kiện onClick của nút thử lại bên cạnh tin nhắn lỗi (dòng 574).
   * @param msg Đối tượng tin nhắn cần gửi lại.
   * @returns Promise<void>
   */
  const handleRetry = async (msg: MessageItem) => {
    if (!activeConvId) return;
    // Chuyển trạng thái tin nhắn thành "sending" trước khi gọi lại API gửi tin
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, status: "sending" } : m)));
    try {
      await apiPost(`/conversations/${activeConvId}/messages`, { id: msg.id, body: msg.body });
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, status: "sent" } : m)));
    } catch {
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, status: "failed" } : m)));
      toast.error(t("Failed to send message"));
    }
  };

  /**
   * Làm gì: Bắt sự kiện phím trong ô nhập tin nhắn, cho phép nhấn Enter (không giữ Shift) để gửi tin nhắn nhanh.
   * Được gọi ở: `src/routes/chat.tsx` trong sự kiện onKeyDown của thẻ Input nhập tin nhắn (dòng 617).
   * @param e Sự kiện bàn phím từ ô input (KeyboardEvent).
   * @returns void
   */
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Ngăn hành vi xuống dòng mặc định và kích hoạt hàm gửi tin nhắn
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  // Bước 5: Chuẩn bị danh sách cuộc hội thoại từ dữ liệu API, hỗ trợ cấu trúc dữ liệu phẳng hoặc phân trang (items), mặc định là mảng rỗng nếu chưa có dữ liệu
  const conversations: ConversationItem[] = convsData?.conversations ?? (convsData as any)?.items ?? [];
  // Bước 6: Lọc danh sách hội thoại theo từ khóa tìm kiếm (searchQuery) dựa trên tên người chat cùng (peer_name), không phân biệt hoa thường
  const filteredConvs = conversations.filter((c) =>
    searchQuery ? c.peer_name.toLowerCase().includes(searchQuery.toLowerCase()) : true,
  );

  // Bước 7: Render giao diện trang tin nhắn với bố cục hai cột: danh sách hội thoại bên trái và khung chat trực tiếp bên phải (hỗ trợ WebRTC P2P và Server Relay)
  return (
    <Shell role={user?.role ?? "member"} title={t("Messages")} subtitle={t("Real-time two-way messaging")}>
      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface shadow-[var(--shadow-soft)]">
        <div className="grid h-[78vh] min-h-[500px] grid-cols-1 lg:grid-cols-12">
          {/* Left Column: Conversations List */}
          <div
            className={cn(
              "flex min-h-0 flex-col border-r border-line bg-surface/50 lg:col-span-5 xl:col-span-4",
              activeConvId ? "hidden lg:flex" : "flex",
            )}
          >
            {composing ? (
              <NewChat
                onClose={() => setComposing(false)}
                onOpen={(id) => {
                  setComposing(false);
                  reloadConvs();
                  navigate({ to: "/chat", search: { conv: id } });
                }}
              />
            ) : (
            <>
            {/* Conversations Header */}
            <div className="border-b border-line p-3.5">
              <div className="mb-2.5 flex items-center justify-between">
                <h2 className="text-base font-semibold text-fg">{t("Conversations")}</h2>
                <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => setComposing(true)}>
                  <PenSquare className="size-4" />
                  {t("New message")}
                </Button>
                <Badge tone="accent">
                  <HighlightBadge value={conversations.reduce((acc, c) => acc + (Number(c.unread_count) || 0), 0)}>
                    {t("{n} unread", { n: conversations.reduce((acc, c) => acc + (Number(c.unread_count) || 0), 0) })}
                  </HighlightBadge>
                </Badge>
                </div>
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
                  hint={t("Tap New message to chat with anyone at the centre.")}
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
                            <UserAvatar
                              url={conv.peer_avatar_url}
                              name={conv.peer_name}
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
            </>
            )}
          </div>

          {/* Right Column: Chat Box */}
          <div
            className={cn(
              "flex min-h-0 flex-col bg-surface lg:col-span-7 xl:col-span-8",
              activeConvId ? "flex" : "hidden lg:flex",
            )}
          >
            {activeConv ? (
              <>
                {/* Active Chat Header */}
                <div className="flex h-16 shrink-0 items-center justify-between border-b border-line px-4">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => navigate({ to: "/chat", search: { conv: undefined } })}
                      className="grid size-9 place-items-center rounded-full text-muted hover:bg-wood hover:text-fg lg:hidden"
                      aria-label={t("Back to conversations")}
                    >
                      <ArrowLeft className="size-5" />
                    </button>
                    <UserAvatar
                      url={activeConv.peer_avatar_url}
                      name={activeConv.peer_name}
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
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
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
                <form onSubmit={handleSend} className="shrink-0 border-t border-line p-3">
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
                    {t("Choose a chat on the left, or tap New message to start one with anyone.")}
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
