/**
 * File: src/client/components/new-chat.tsx
 * Vai trò: Giao diện tìm kiếm danh bạ và bắt đầu cuộc trò chuyện mới (NewChat) giữa người dùng trong hệ thống Arena 3.
 * Vị trí trong app: Chạy ở client, được nhúng trong trang chat (/chat, src/routes/chat.tsx) khi người dùng bấm tạo tin nhắn mới.
 */
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
/**
 * Làm gì: Hiển thị giao diện tìm kiếm người dùng trong danh bạ và bắt đầu hoặc mở lại cuộc trò chuyện trực tiếp (1-1).
 * Được gọi ở: src/routes/chat.tsx (trong component ChatPage khi người dùng bật trạng thái soạn tin nhắn mới: composing = true).
 * @param onOpen Callback được gọi khi mở hoặc tạo thành công cuộc trò chuyện, nhận vào convId để chuyển hướng.
 * @param onClose Callback được gọi khi người dùng đóng khung tạo chat mới (bấm nút X).
 * @returns JSX phần tử giao diện tìm kiếm và danh sách danh bạ người dùng.
 */
export function NewChat({ onOpen, onClose }: { onOpen: (convId: string) => void; onClose: () => void }) {
  // Bước 1: Khởi tạo state cho từ khóa tìm kiếm (q), danh sách kết quả (items), và ID liên hệ đang xử lý mở chat (busy)
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Contact[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Bước 2: Theo dõi từ khóa q để tự động tìm kiếm danh bạ với cơ chế debounce 200ms
  useEffect(() => {
    // Cờ live để ngăn cập nhật state nếu component unmount hoặc q thay đổi trước khi request hoàn tất (tránh race condition)
    let live = true;
    // Trì hoãn 200ms để đợi người dùng ngừng gõ phím mới gửi request, giảm tải cho server
    const id = setTimeout(() => {
      // Gửi từ khóa đã cắt khoảng trắng thừa lên server; server chỉ lọc theo tên hoặc mã hội viên, không lộ email/SĐT
      apiGet<{ items: Contact[] }>(`/conversations/contacts?q=${encodeURIComponent(q.trim())}`)
        .then((r) => live && setItems(r.items))
        .catch(() => live && setItems([]));
    }, 200);
    // Cleanup function: Hủy timer và đánh dấu kết quả trước đó không còn hợp lệ khi q thay đổi hoặc component unmount
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [q]);

  /**
   * Làm gì: Gửi yêu cầu lên server để tạo mới hoặc lấy cuộc trò chuyện sẵn có với người liên hệ, sau đó kích hoạt callback onOpen.
   * Được gọi ở: Sự kiện onClick của từng hàng người liên hệ trong danh sách kết quả (component NewChat).
   * @param c Thông tin người liên hệ (Contact) được người dùng bấm chọn để trò chuyện.
   * @returns Không trả về dữ liệu (Promise<void>).
   */
  async function open(c: Contact) {
    // Bước 1: Đánh dấu đang mở hội thoại với liên hệ này để khóa nút bấm, tránh thao tác trùng lặp
    setBusy(c.id);
    try {
      // Bước 2: Gọi API POST /conversations để lấy cuộc trò chuyện sẵn có hoặc tạo mới nếu chưa từng chat
      const res = await apiPost<{ conversation: { id: string } }>("/conversations", { recipient_id: c.id });
      // Bước 3: Kích hoạt callback thông báo cho component cha điều hướng người dùng tới hội thoại
      onOpen(res.conversation.id);
    } catch (err) {
      // Hiển thị thông báo lỗi từ server hoặc câu thông báo mặc định nếu không thể mở cuộc trò chuyện
      toast.error(err instanceof Error ? tServer(err.message) : t("Could not open the chat"));
    } finally {
      // Xóa trạng thái bận sau khi hoàn tất (thành công hoặc lỗi) để mở khóa giao diện
      setBusy(null);
    }
  }

  // Bước 4: Render giao diện gồm thanh tìm kiếm, nút đóng và danh sách kết quả (kèm trạng thái Skeleton và EmptyState)
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
