/**
 * Route layout cha cho phân hệ quản lý (/manager) trong hệ thống Arena 3.
 * File này đóng vai trò tầng bảo vệ phân quyền, bọc tất cả các trang con của quản lý (/manager/*)
 * bằng Guard để đảm bảo chỉ tài khoản có vai trò manager mới được phép truy cập.
 */
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { Guard } from "@/client/components/shell";

/**
 * Làm gì: Định nghĩa route layout cha cho tiền tố "/manager", bọc phân hệ quản lý bằng Guard để phân quyền (chỉ role manager) và render nội dung các route con qua Outlet.
 * Được gọi ở: URL /manager và các route con (/manager/members, /manager/classes, /manager/courts, v.v.); được đăng ký tại src/routeTree.gen.ts.
 * @returns Đối tượng Route của TanStack Router dùng để điều hướng và bảo vệ các trang con của phân hệ quản trị.
 */
export const Route = createFileRoute("/manager")({
  component: () => (
    <Guard roles={["manager"]}>
      <Outlet />
    </Guard>
  ),
});
