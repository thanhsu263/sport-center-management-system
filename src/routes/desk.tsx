/**
 * File: src/routes/desk.tsx
 * Vai trò: Định nghĩa route layout cha /desk và bảo vệ quyền truy cập cho phân hệ quầy lễ tân (Front Desk).
 * Vị trí trong app:
 * - Là route layout gốc cho toàn bộ các trang chức năng lễ tân (/desk/*) trong TanStack Router.
 * - Sử dụng Guard để kiểm tra quyền, chỉ cho phép tài khoản có vai trò receptionist hoặc manager truy cập.
 * - Render Outlet để hiển thị giao diện của các route con tương ứng khi người dùng chuyển trang.
 */
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { Guard } from "@/client/components/shell";

/**
 * Làm gì: Định nghĩa cấu hình route cha /desk, bọc phân hệ lễ tân trong Guard để phân quyền cho receptionist và manager, sau đó render nội dung route con qua Outlet.
 * Được gọi ở: URL /desk (TanStack Router tự động khớp khi người dùng truy cập các đường dẫn con /desk/*).
 * @returns Đối tượng cấu hình route của TanStack Router cho phân hệ /desk.
 */
export const Route = createFileRoute("/desk")({
  component: () => (
    <Guard roles={["receptionist", "manager"]}>
      <Outlet />
    </Guard>
  ),
});
