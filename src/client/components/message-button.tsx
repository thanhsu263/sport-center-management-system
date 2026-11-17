/**
 * File: src/client/components/message-button.tsx
 * Vai trò: Nút bấm tiện ích mở hoặc tiếp tục cuộc trò chuyện 1-1 với một người dùng (hội viên hoặc nhân viên).
 * Vị trí trong app: Chạy ở client, được dùng trên màn hình chi tiết hội viên (Desk) và danh sách hội viên (Manager) để điều hướng nhanh đến trang chat.
 */
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/client/components/ui";
import { apiPost } from "@/client/arena3/client";
import { t, tServer } from "@/client/lib/i18n";

/** Opens (or reopens) the chat with this person and jumps to it. */
/**
 * Làm gì: Hiển thị nút nhắn tin (dạng nút đầy đủ hoặc icon thu gọn); khi click sẽ tìm hoặc tạo cuộc trò chuyện với người nhận rồi điều hướng sang trang /chat.
 * Được gọi ở:
 * - src/routes/desk.member.$id.tsx: component DeskMemberDetailPage (trang chi tiết hội viên của lễ tân)
 * - src/routes/manager.members.tsx: component ManagerMembersPage (danh sách hội viên của quản lý)
 * @param userId Mã định danh (ID) của người dùng cần nhắn tin.
 * @param compact Cờ tùy chọn giao diện thu gọn; true là icon tròn nhỏ gọn, false là nút bấm đầy đủ kèm nhãn chữ (mặc định false).
 * @returns JSX phần tử nút bấm nhắn tin.
 */
export function MessageButton({ userId, compact = false }: { userId: string; compact?: boolean }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  /**
   * Làm gì: Xử lý sự kiện click nút để gọi API tạo/mở cuộc trò chuyện với userId và điều hướng sang trang /chat.
   * Được gọi ở: Sự kiện onClick của thẻ button (chế độ compact) và component Button (chế độ tiêu chuẩn).
   * @param e Sự kiện click chuột (React.MouseEvent) từ người dùng.
   * @returns Promise<void>
   */
  async function open(e: React.MouseEvent) {
    // Bước 1: Ngăn hành vi mặc định và chặn nổi bọt sự kiện để tránh kích hoạt click của hàng hoặc thẻ cha
    e.preventDefault();
    e.stopPropagation();
    // Bước 2: Bật trạng thái bận (busy) để vô hiệu hóa nút, tránh người dùng bấm nhiều lần trong lúc chờ API
    setBusy(true);
    try {
      // Bước 3: Gọi API tạo hoặc lấy ID hội thoại 1-1 với recipient_id, sau đó chuyển hướng đến trang /chat với query conv
      const res = await apiPost<{ conversation: { id: string } }>("/conversations", { recipient_id: userId });
      await navigate({ to: "/chat", search: { conv: res.conversation.id } as never });
    } catch (err) {
      // Bước 4: Nếu gặp lỗi, hiển thị toast thông báo; ưu tiên dùng tServer để dịch thông điệp lỗi từ server
      toast.error(err instanceof Error ? tServer(err.message) : t("Could not open the chat"));
    } finally {
      // Bước 5: Luôn giải phóng trạng thái bận (busy) trong finally để mở khóa lại nút bấm
      setBusy(false);
    }
  }

  // Nhánh 1: Chế độ compact = true hiển thị icon tròn nhỏ gọn, phù hợp khi đặt trong bảng dữ liệu hoặc không gian hẹp
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
  // Nhánh 2: Chế độ mặc định hiển thị nút Button có nhãn chữ và icon, hiển thị trạng thái "Opening…" khi busy = true
  return (
    <Button size="sm" variant="outline" onClick={open} disabled={busy}>
      <MessageSquare className="size-4" />
      {busy ? t("Opening…") : t("Message")}
    </Button>
  );
}
