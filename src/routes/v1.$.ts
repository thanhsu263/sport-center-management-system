// Định nghĩa route catch-all /v1/* của TanStack Router cho toàn bộ server API v1.
// Đóng vai trò gateway đón mọi HTTP request đến /v1/ và chuyển tiếp đến bộ điều khiển trung tâm handleApi.
import { createFileRoute } from "@tanstack/react-router";
import { handleApi } from "@/server/controllers/router";

/**
 * Làm gì: Định nghĩa route catch-all /v1/$ trên server để tiếp nhận mọi phương thức HTTP (GET, POST, PATCH, PUT, DELETE) và ủy quyền cho handleApi xử lý.
 * Được gọi ở: URL /v1/* (tất cả các endpoint API v1 từ client gửi lên).
 * @returns Cấu hình Route của TanStack Router chứa các server handlers.
 */
export const Route = createFileRoute("/v1/$")({
  server: {
    handlers: {
      GET: ({ request }) => handleApi(request),
      POST: ({ request }) => handleApi(request),
      PATCH: ({ request }) => handleApi(request),
      PUT: ({ request }) => handleApi(request),
      DELETE: ({ request }) => handleApi(request),
    },
  },
});
