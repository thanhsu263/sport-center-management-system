/**
 * File: src/client/components/user-avatar.tsx
 * Vai trò: Component hiển thị ảnh đại diện (avatar) của người dùng hoặc chữ cái đầu (initials) dự phòng khi không có ảnh.
 * Vị trí trong app: Được dùng rộng rãi ở giao diện client như thanh điều hướng (shell.tsx), trang tài khoản (account.tsx), tin nhắn chat (chat.tsx, new-chat.tsx), và danh sách điểm danh (attendance-panels.tsx, coach.attendance.tsx).
 */
import { useRef } from "react";
import { cn } from "@/client/lib/cn";
import { initials } from "@/client/lib/initials";
import { useAvatarSrc } from "@/client/arena3/avatar";

// Định nghĩa các thuộc tính (props) đầu vào cho component UserAvatar
export type UserAvatarProps = {
  name?: string | null;
  url?: string | null;
  className?: string;
  initialsClassName?: string;
  alt?: string;
};

/**
 * Renders an authenticated user avatar image via blob URL or falls back to initials.
 * Lazy loads offscreen avatars using IntersectionObserver and loading="lazy".
 */
/**
 * Làm gì: Hiển thị ảnh đại diện (avatar) của người dùng từ blob URL đã xác thực, hoặc hiển thị chữ cái đầu (initials) nếu chưa có ảnh. Hỗ trợ lazy load khi cuộn vào khung nhìn để tối ưu hiệu năng.
 * Được gọi ở: src/client/components/shell.tsx (UserMenu), src/routes/account.tsx, src/routes/chat.tsx, src/client/components/new-chat.tsx, src/client/components/attendance-panels.tsx, src/client/components/class-detail.tsx.
 * @param name Tên người dùng dùng để tạo chữ cái viết tắt (initials) hoặc làm alt text dự phòng.
 * @param url Đường dẫn ảnh avatar trên server để tải về qua Bearer token.
 * @param className Class CSS tùy biến bổ sung cho thẻ span bọc ngoài.
 * @param initialsClassName Class CSS tùy biến bổ sung cho phần hiển thị chữ cái viết tắt.
 * @param alt Văn bản thay thế (alt text) cho thẻ img của avatar.
 * @returns Phần tử JSX hiển thị ảnh avatar tròn hoặc chữ cái viết tắt trên nền màu gỗ.
 */
export function UserAvatar({
  name,
  url,
  className,
  initialsClassName,
  alt,
}: UserAvatarProps) {
  // Bước 1: Khởi tạo ref liên kết với thẻ container DOM để theo dõi khi avatar cuộn vào khung nhìn (viewport)
  const containerRef = useRef<HTMLSpanElement>(null);
  // Bước 2: Tải blob URL ảnh đại diện với Bearer token; chỉ fetch khi containerRef xuất hiện trong khung nhìn nhờ IntersectionObserver
  const src = useAvatarSrc(url, containerRef);

  // Bước 3: Render avatar tròn - nếu có blob URL hợp lệ thì render thẻ img với lazy loading, ngược lại hiển thị chữ cái viết tắt (initials) trên nền gỗ (bg-wood)
  return (
    <span
      ref={containerRef}
      className={cn(
        "relative inline-grid size-full place-items-center overflow-hidden rounded-full select-none",
        !src && "bg-wood",
        className,
      )}
    >
      {src ? (
        <img
          src={src}
          alt={alt ?? name ?? "Avatar"}
          className="size-full rounded-full object-cover transition-opacity duration-200 motion-reduce:transition-none"
          loading="lazy"
          decoding="async"
        />
      ) : (
        <span className={cn("grid size-full place-items-center font-display", initialsClassName)}>
          {initials(name ?? undefined)}
        </span>
      )}
    </span>
  );
}
