/**
 * File định nghĩa AuthProvider ở tầng client root cho toàn bộ ứng dụng.
 * Được gắn tại src/routes/__root.tsx để bọc toàn bộ giao diện; hiện tại đóng vai trò passthrough chuyển tiếp children vì Better Auth React client hoạt động độc lập, đồng thời làm điểm gắn kết ổn định cho các client provider trong tương lai.
 */
import type { ReactNode } from "react";

/**
 * App-wide client provider mounted once near the root (in `src/routes/__root.tsx`):
 *
 *   <AuthProvider><Outlet /></AuthProvider>
 *
 * Better Auth's React client (`@/client/auth/client`) needs NO context provider —
 * its `useSession()` works standalone — so this is a passthrough today. It's
 * kept as the single, stable mount point for any future client-side providers
 * (e.g. a toast or theme provider) without churning the root shell.
 */
/**
 * Làm gì: Component React bọc toàn bộ client app, đóng vai trò passthrough chuyển tiếp children và giữ chỗ ổn định cho các client provider mở rộng về sau.
 * Được gọi ở: src/routes/__root.tsx (component RootComponent bọc Outlet, LangProvider, SiteAssetsProvider và Toaster).
 * @param children Các phần tử React con được render bên trong provider (chẳng hạn như Outlet, router views, Toaster).
 * @returns Fragment React (<>{children}</>) hiển thị trực tiếp các phần tử con mà không tạo thêm node bọc ngoài DOM.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
