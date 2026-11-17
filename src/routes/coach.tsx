/**
 * Route layout cha cho phân hệ huấn luyện viên (/coach) trong hệ thống Arena 3.
 * File này đóng vai trò tầng bảo vệ phân quyền, bọc tất cả các trang con của huấn luyện viên
 * bằng Guard để đảm bảo chỉ tài khoản có vai trò coach hoặc manager mới được truy cập.
 */
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { Guard } from "@/client/components/shell";

/**
 * Làm gì: Định nghĩa route layout cha cho tiền tố "/coach", bọc component con bằng Guard để kiểm tra quyền và render nội dung trang con qua Outlet.
 * Được gọi ở: URL /coach và các route con (/coach/attendance, /coach/classes, /coach/earnings, /coach/student/$id); được đăng ký tại src/routeTree.gen.ts.
 * @returns Đối tượng Route của TanStack Router dùng để điều hướng và bảo vệ các trang con của phân hệ coach.
 */
export const Route = createFileRoute("/coach")({
  component: () => (
    <Guard roles={["coach", "manager"]}>
      <Outlet />
    </Guard>
  ),
});
