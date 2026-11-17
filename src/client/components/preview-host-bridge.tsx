/**
 * Mount once in `__root.tsx` so the Grok preview chrome can drive navigation
 * (and later receive registered routes). Noops when the app is not embedded.
 */

import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  collectRoutePathsFromTree,
  installPreviewHostBridge,
} from "@/client/lib/preview-host-bridge";

/**
 * Làm gì: Cung cấp cầu nối liên lạc (bridge) giữa ứng dụng và khung xem trước (Grok preview host) qua postMessage, hỗ trợ điều hướng và thu thập danh sách đường dẫn route.
 * Được gọi ở: src/routes/__root.tsx trong component RootComponent
 * @returns null - Component headless chỉ chạy logic ngầm, không render giao diện UI
 */
export function PreviewHostBridge() {
  // Bước 1: Lấy router instance từ TanStack Router để điều khiển điều hướng và truy xuất cây định tuyến.
  const router = useRouter();

  // Bước 2: Thiết lập cầu nối postMessage khi component mount và tự động dọn dẹp các listener khi unmount.
  useEffect(() => {
    return installPreviewHostBridge({
      navigate: (path) => {
        router.history.push(path);
      },
      // Cung cấp danh sách đường dẫn tĩnh từ cây route để preview host hỗ trợ gợi ý URL (autosuggest).
      getRoutePaths: () => collectRoutePathsFromTree(router.routeTree),
    });
  }, [router]);

  // Component headless chỉ xử lý logic kết nối ngầm, không render giao diện UI.
  return null;
}
