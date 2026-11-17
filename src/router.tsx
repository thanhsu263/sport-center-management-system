/**
 * Cấu hình router trung tâm cho ứng dụng Arena 3 bằng TanStack Router.
 * File này liên kết cây định tuyến (routeTree) với các màn hình xử lý lỗi (AppErrorComponent) và trang 404 (AppNotFoundComponent).
 */
import { createRouter } from "@tanstack/react-router";
import { AppErrorComponent, AppNotFoundComponent } from "@/client/lib/error-component";
import { routeTree } from "./routeTree.gen.ts";

/**
 * Làm gì: Khởi tạo và trả về instance TanStack Router cho toàn bộ ứng dụng, kết hợp routeTree và giao diện xử lý lỗi/404 mặc định.
 * Được gọi ở: TanStack Start framework (tự động gọi khi chạy SSR và hydrate client); src/routeTree.gen.ts (đăng ký kiểu cho Register).
 * @returns Instance router đã được cấu hình đầy đủ của TanStack Router.
 */
export function getRouter() {
  return createRouter({ //find rounter to make sure things alright!!
    routeTree,
    defaultErrorComponent: AppErrorComponent,
    defaultNotFoundComponent: AppNotFoundComponent,
  });
}
