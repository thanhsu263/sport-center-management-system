/**
 * File: src/client/lib/initials.ts
 * Vai trò: Tiện ích tính toán ký tự viết tắt (initials) từ họ tên người dùng để hiển thị avatar dạng chữ.
 * Vị trí trong app: Được sử dụng ở giao diện client bởi các component như UserAvatar, MediaCover, ClassDetailModal... khi người dùng hoặc huấn luyện viên chưa có ảnh avatar hoặc ảnh gặp lỗi tải.
 */
/**
 * Compute 1-2 letter initials for a user name.
 *
 * Vietnamese names put the given name last, and that is the one people answer
 * to — so take the first and last word rather than the first two.
 */
/**
 * Làm gì: Trích xuất 1-2 chữ cái viết tắt (initials) từ họ tên người dùng, ưu tiên lấy chữ cái đầu của họ và tên chính theo văn hóa đặt tên tiếng Việt.
 * Được gọi ở: src/client/components/user-avatar.tsx (UserAvatar), src/client/components/class-detail.tsx (ClassDetailModal), src/client/components/landing/coaches.tsx (CoachesSection), src/routes/manager.staff.tsx (ManagerStaff) thông qua export tại src/client/components/shell.tsx.
 * @param name Họ và tên đầy đủ của người dùng hoặc nhân viên/huấn luyện viên (có thể là undefined).
 * @returns Chuỗi 1-2 ký tự viết hoa đại diện cho tên, hoặc "A3" làm giá trị mặc định nếu không có tên.
 */
export function initials(name: string | undefined): string {
  // Bước 1: Chuẩn hóa chuỗi, tách các từ theo khoảng trắng và lọc bỏ khoảng trắng thừa
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  // Trả về "A3" (viết tắt của Arena 3) làm giá trị mặc định khi tên rỗng hoặc không xác định
  if (parts.length === 0) return "A3";
  // Bước 2: Lấy ký tự đầu của họ (từ đầu tiên) và tên chính (từ cuối cùng) theo quy tắc xưng hô tiếng Việt
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "";
  // Bước 3: Ghép 1-2 ký tự đầu và chuyển thành chữ in hoa để hiển thị đồng bộ trên avatar
  return (first + last).toUpperCase();
}
