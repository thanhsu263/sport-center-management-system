/**
 * File: src/routes/desk.at-risk.tsx
 * Vai trò: Định nghĩa route và giao diện trang danh sách hội viên có nguy cơ bỏ tập (/desk/at-risk).
 * Vị trí trong app:
 * - Thuộc phân hệ Lễ tân (/desk), được bảo vệ quyền truy cập cho vai trò receptionist và manager.
 * - Nhúng component AtRiskPanel để hiển thị danh sách hội viên ngừng đến tập, hỗ trợ nhân viên liên hệ chăm sóc và giữ chân hội viên trước khi gói tập hết hạn.
 */
import { createFileRoute } from "@tanstack/react-router";
import { AtRiskPanel } from "@/client/components/attendance-panels";
import { Shell, useSessionUser } from "@/client/components/shell";
import { t } from "@/client/lib/i18n";

/**
 * Làm gì: Khởi tạo cấu hình route cho đường dẫn /desk/at-risk trong TanStack Router, liên kết URL với component Page.
 * Được gọi ở: URL /desk/at-risk (TanStack Router tự động đăng ký và nạp route khi người dùng truy cập).
 * @returns Đối tượng Route cấu hình cho đường dẫn /desk/at-risk.
 */
export const Route = createFileRoute("/desk/at-risk")({ component: Page });

/**
 * Làm gì: Component trang hiển thị danh sách hội viên có nguy cơ bỏ tập, bọc AtRiskPanel trong khung giao diện Shell với vai trò tương ứng của người dùng.
 * Được gọi ở: Thuộc tính component của Route tại src/routes/desk.at-risk.tsx (dòng 6).
 * @returns JSX phần tử Shell chứa AtRiskPanel để quản lý và chăm sóc hội viên.
 */
function Page() {
  // Bước 1: Lấy thông tin phiên người dùng hiện tại để xác định vai trò hiển thị trên khung Shell (ưu tiên manager, mặc định receptionist).
  const user = useSessionUser();
  // Bước 2: Hiển thị giao diện trong khung Shell với AtRiskPanel để theo dõi và ghi nhận liên hệ học viên.
  return (
    <Shell
      role={user?.role === "manager" ? "manager" : "receptionist"}
      title={t("At risk")}
      subtitle={t("Members who have stopped coming. Call them before their plan lapses.")}
    >
      <AtRiskPanel />
    </Shell>
  );
}
