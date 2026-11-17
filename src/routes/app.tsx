/**
 * File: src/routes/app.tsx
 * Vai trò: Route layout cha (parent layout route) cho toàn bộ phân hệ hội viên (member) tại đường dẫn /app.
 * Vị trí trong app: Bọc component Guard để kiểm tra quyền truy cập theo vai trò "member" trước khi hiển thị các trang con (/app/*) qua Outlet.
 */
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { Guard } from "@/client/components/shell";

/**
 * Làm gì: Định nghĩa route layout cha cho phân hệ hội viên (/app), bảo vệ các route con bằng Guard để chỉ tài khoản có vai trò "member" mới được truy cập.
 * Được gọi ở: URL /app (và các route con như /app/book, /app/classes, /app/plans...). TanStack Router tự động đăng ký qua hệ thống file-based routing.
 * @returns Cấu hình route của TanStack Router cho đường dẫn /app với component bảo vệ và Outlet.
 */
export const Route = createFileRoute("/app")({
  component: () => (
    <Guard roles={["member"]}>
      <Outlet />
    </Guard>
  ),
});
