/**
 * Quản lý thông tin người dùng hiện tại (current user) và trạng thái phiên đăng nhập (session state) ở phía client.
 * File chuẩn hóa cấu trúc người dùng (AppUser) dùng chung cho toàn bộ ứng dụng dù bật hay tắt xác thực,
 * cung cấp fallback DEV_USER khi tắt auth (môi trường dev/sandbox), và tích hợp hook useSession của Better Auth.
 * Các hook useCurrentUserState và useCurrentUser được sử dụng bởi các auth gates (gates.tsx), UserButton và các trang cần kiểm tra quyền truy cập.
 */
import { authClient, authEnabled } from "./client";

/** Normalized user shape used across the app, auth on or off. */
export type AppUser = {
  id: string;
  displayName: string | null;
  primaryEmail: string | null;
  profileImageUrl: string | null;
  /** True when this is the sandbox/dev fallback (auth not configured). */
  isDevFallback: boolean;
};

/**
 * Stable fallback user, used ONLY when auth is disabled
 * (`VITE_AUTH_ENABLED=false`, the shipped default). With auth on, the sandbox
 * live preview does real sign-in via the baked preview client. Its id is
 * `"dev-user"` — the SAME id `verify.server.ts` returns server-side — so per-user
 * rows written in that mode belong to one consistent owner.
 */
export const DEV_USER: AppUser = {
  id: "dev-user",
  displayName: "Dev User",
  primaryEmail: "dev@example.com",
  profileImageUrl: null,
  isDevFallback: true,
};

/** `useCurrentUserState()` result: the user plus the session-loading flag. */
export type CurrentUserState = {
  /** The user — `null` BOTH while the session loads and when signed out. */
  user: AppUser | null;
  /** True while the session is still resolving — don't treat `user: null` as signed out yet. */
  isPending: boolean;
};

/**
 * Current user + loading state. Same behavior in live preview and when deployed:
 *   - Auth enabled -> the real signed-in user; `user` is `null` while
 *                            the session resolves (`isPending: true`) and when
 *                            signed out (`isPending: false`). Session comes from
 *                            Better Auth `useSession()` → `/api/auth/get-session`
 *                            (cookie when deployed; bearer in live preview).
 *   - Auth disabled (`VITE_AUTH_ENABLED=false`) -> `DEV_USER`, never pending.
 *
 * Protect a route by waiting out `isPending` before acting on `user` —
 * redirecting on `user: null` alone bounces signed-in visitors to sign-in on
 * every hard reload:
 *
 *   import { RedirectToSignIn } from "@/client/auth/gates";
 *   const { user, isPending } = useCurrentUserState();
 *   if (isPending) return null;              // still resolving — don't redirect yet
 *   if (!user) return <RedirectToSignIn />;  // definitely signed out
 *
 * `authEnabled` is a module-level constant fixed at load, so the guarded hook
 * call keeps a stable hook order across every render of a given component.
 */
export function useCurrentUserState(): CurrentUserState {
  // Bước 1: Nếu tính năng auth bị tắt (VITE_AUTH_ENABLED=false), trả về ngay người dùng fallback DEV_USER với isPending = false mà không cần truy vấn session.
  // Giúp môi trường dev/sandbox hoạt động ngay với một tài khoản cố định ('dev-user') mà không yêu cầu luồng đăng nhập.
  if (!authEnabled) return { user: DEV_USER, isPending: false };
  // Bước 2: Khi auth được bật, gọi hook useSession từ Better Auth để lấy dữ liệu phiên đăng nhập và trạng thái đang tải isPending.
  // authEnabled là hằng số cố định khi ứng dụng khởi chạy nên thứ tự gọi hook luôn đảm bảo ổn định, an toàn để bỏ qua cảnh báo Rules of Hooks.
  // eslint-disable-next-line react-hooks/rules-of-hooks -- authEnabled is constant for the app's lifetime
  const { data, isPending } = authClient.useSession();
  // Bước 3: Trích xuất thông tin người dùng từ dữ liệu session trả về (nếu chưa đăng nhập hoặc session đang tải thì user là undefined).
  const user = data?.user;
  // Bước 4: Chuẩn hóa dữ liệu người dùng về cấu trúc AppUser thống nhất trong toàn app (chuyển các trường thiếu về null, đặt isDevFallback = false vì đây là phiên thật).
  // Giữ nguyên cờ isPending để các route guard phân biệt trạng thái đang xác thực với việc người dùng đã thực sự đăng xuất (tránh chuyển hướng nhầm khi tải lại trang).
  return {
    user: user
      ? {
          id: user.id,
          displayName: user.name ?? null,
          primaryEmail: user.email ?? null,
          profileImageUrl: user.image ?? null,
          isDevFallback: false,
        }
      : null,
    isPending,
  };
}

/**
 * Convenience view of `useCurrentUserState().user` for display (e.g.
 * `user?.displayName ?? "Guest"`). NOTE: `null` means *loading OR signed out* —
 * for redirects/guards use `useCurrentUserState()` and check `isPending`.
 */
export function useCurrentUser(): AppUser | null {
  return useCurrentUserState().user;
}
