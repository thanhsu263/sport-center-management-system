/**
 * File: src/client/auth/gates.tsx
 * Vai trò: Cung cấp các component và route guard kiểm soát quyền truy cập dựa trên trạng thái xác thực ở phía client.
 * Vị trí trong app:
 * - Định nghĩa các component hiển thị có điều kiện (SignedIn, SignedOut, SignInGate) dựa trên phiên người dùng từ useCurrentUserState.
 * - Điều hướng client-side sang trang đăng nhập bằng RedirectToSignIn (dùng TanStack Router Navigate).
 * - Cung cấp component UserButton hiển thị avatar, tên người dùng và nút đăng xuất an toàn (tự động ẩn khi ở chế độ gate session hoặc tắt auth).
 * - Cung cấp danh sách các nút đăng nhập OAuth qua SignInButtons.
 * Giúp giao diện phân biệt rõ giữa trạng thái đang tải phiên (pending), đã đăng nhập và chưa đăng nhập, chống chớp nháy (flash) khi tải lại trang.
 */
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Navigate } from "@tanstack/react-router";
import { GROK_PROVIDERS, authEnabled, signIn, signOut } from "./client";
import { hasGateSessionMarker } from "../../shared/auth/gate-session-marker";
import { resolveSignInGateState } from "./sign-in-gate";
import { useCurrentUser, useCurrentUserState } from "./use-current-user";

/**
 * Làm gì: Hàm subscribe rỗng (noop) dùng cho hook useSyncExternalStore vì cookie trình duyệt không phát sinh DOM event khi thay đổi.
 * Được gọi ở: src/client/auth/gates.tsx (component UserButton, truyền vào tham số thứ nhất của hook useSyncExternalStore).
 * @returns Hàm unsubscribe rỗng (() => {}).
 */
const subscribeToNothing = () => () => {};
/**
 * Làm gì: Cung cấp giá trị snapshot mặc định cho hook useSyncExternalStore khi chạy ở phía server (SSR/hydration); luôn trả về false vì server không có document.cookie.
 * Được gọi ở: src/client/auth/gates.tsx (component UserButton, truyền vào tham số thứ ba getServerSnapshot của useSyncExternalStore).
 * @returns Luôn trả về giá trị false.
 */
const noGateSessionOnServer = () => false;

/**
 * Auth state components — plain wrappers around `useCurrentUserState()`.
 *
 * With auth on, visitors are signed out until they authenticate — in the sandbox
 * live preview too, which does real sign-in. The shared dev user appears only
 * when auth is disabled (`VITE_AUTH_ENABLED=false`, the shipped default).
 * While the session is still resolving, gates that care about signed-out state
 * render nothing so there's no signed-out flash on hard reload.
 */

/** Where `RedirectToSignIn` sends signed-out visitors. Create this route. */
/**
 * Làm gì: Đường dẫn URL mặc định (/login) để điều hướng khách chưa đăng nhập khi truy cập các route được bảo vệ.
 * Được gọi ở: src/client/auth/gates.tsx (giá trị mặc định của prop 'to' trong component RedirectToSignIn), các route guard trong app.
 */
export const SIGN_IN_PATH = "/login";

/** Render children only when a user is present (real session, or the disabled-auth dev user). */
/**
 * Làm gì: Component bọc có điều kiện; chỉ hiển thị các phần tử con (children) khi người dùng đã đăng nhập (phiên thật hoặc dev user khi tắt auth).
 * Được gọi ở: Các trang hoặc thanh điều hướng cần bảo vệ nội dung dành riêng cho người dùng đã đăng nhập (như navbar, profile menu).
 * @param children Các phần tử React con chỉ được render khi có user hợp lệ.
 * @returns React Fragment chứa children nếu đã đăng nhập, ngược lại trả về null.
 */
export function SignedIn({ children }: { children: ReactNode }) {
  // Lấy thông tin user hiện tại; nếu có user (phiên thật hoặc dev user) thì mới render children, ngược lại ẩn hoàn toàn (null).
  const { user } = useCurrentUserState();
  return user ? <>{children}</> : null;
}

/**
 * Render children only once we KNOW the visitor is signed out (`isPending` has
 * cleared and there is no user). Hidden while the session is still loading.
 */
/**
 * Làm gì: Component bọc có điều kiện; chỉ hiển thị children khi chắc chắn người dùng chưa đăng nhập (đã kiểm tra xong phiên và không có user).
 * Được gọi ở: Các thành phần giao diện chỉ dành cho khách vãng lai (như nút đăng nhập, banner giới thiệu tính năng).
 * @param children Các phần tử React con chỉ được render khi người dùng chưa đăng nhập.
 * @returns React Fragment chứa children nếu chưa đăng nhập, ngược lại trả về null.
 */
export function SignedOut({ children }: { children: ReactNode }) {
  const { user, isPending } = useCurrentUserState();
  // Nếu phiên đang tải (isPending) hoặc đã có user thì ẩn (trả về null), tránh hiện tượng chớp nháy (flash) giao diện khách khi vừa tải lại trang.
  if (isPending || user) return null;
  return <>{children}</>;
}

/**
 * Client-side redirect to the sign-in route (TanStack `<Navigate>` — NOT a full
 * `window.location` reload). A hard navigation re-bootstraps the SPA and re-runs
 * session loading, which feels like a second "Loading…" on /login.
 *
 * Guard routes by waiting out `isPending` first (see `use-current-user`), then
 * render this.
 */
/**
 * Làm gì: Chuyển hướng người dùng sang trang đăng nhập bằng component Navigate của TanStack Router (chuyển hướng client-side, không reload toàn trang SPA).
 * Được gọi ở: Các route guard phía client sau khi xác nhận isPending = false mà không có user (tham khảo hướng dẫn trong use-current-user.ts).
 * @param to Đường dẫn trang đăng nhập đích cần chuyển hướng đến (mặc định là SIGN_IN_PATH = "/login").
 * @returns Component Navigate của TanStack Router để điều hướng ở client.
 */
export function RedirectToSignIn({ to = SIGN_IN_PATH }: { to?: string }) {
  return <Navigate to={to} />;
}

/**
 * Làm gì: Cổng bảo vệ giao diện yêu cầu xác thực; tự động ẩn khi đang tải phiên (pending), hiển thị children khi đã đăng nhập, hoặc hiển thị fallback/nút đăng nhập khi chưa đăng nhập.
 * Được gọi ở: Các trang hoặc khối giao diện yêu cầu đăng nhập trước khi xem hoặc thao tác (ví dụ: màn hình đặt sân, tính năng thành viên).
 * @param children Nội dung React được bảo vệ, hiển thị khi người dùng đã đăng nhập thành công.
 * @param fallback Giao diện thay thế khi chưa đăng nhập (nếu không truyền sẽ mặc định hiển thị SignInButtons).
 * @returns null khi đang tải phiên, children khi đã đăng nhập, hoặc fallback/SignInButtons khi chưa đăng nhập.
 */
export function SignInGate({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  // Bước 1: Lấy thông tin người dùng và cờ trạng thái đang tải phiên (isPending) từ hook useCurrentUserState.
  const { user, isPending } = useCurrentUserState();
  // Bước 2: Phân giải trạng thái cổng thành một trong ba giá trị ("pending", "signed_in", "signed_out") qua resolveSignInGateState.
  const state = resolveSignInGateState({ isPending, hasUser: user !== null });
  // Bước 3: Nếu phiên đang được kiểm tra ("pending"), tạm thời không render gì (null) để chống chớp nháy giao diện.
  if (state === "pending") return null;
  // Bước 4: Nếu đã đăng nhập thành công ("signed_in"), render toàn bộ nội dung được bảo vệ (children).
  if (state === "signed_in") return <>{children}</>;
  // Bước 5: Nếu chưa đăng nhập ("signed_out"), hiển thị giao diện fallback được truyền vào hoặc mặc định danh sách nút SignInButtons.
  return <>{fallback ?? <SignInButtons />}</>;
}

/**
 * Làm gì: Hiển thị danh sách các nút bấm đăng nhập cho từng nhà cung cấp OAuth trong GROK_PROVIDERS (Google, X...); khi bấm sẽ gọi hàm signIn để bắt đầu xác thực.
 * Được gọi ở: src/client/auth/gates.tsx (fallback mặc định của SignInGate), src/routes/login.tsx (trang đăng nhập).
 * @returns Khối JSX chứa danh sách các nút đăng nhập OAuth dạng cột dọc.
 */
export function SignInButtons() {
  // Duyệt danh sách nhà cung cấp GROK_PROVIDERS để tạo nút đăng nhập; khi click sẽ gọi signIn với callbackURL về trang chủ ("/").
  return (
    <div className="flex w-full max-w-sm flex-col gap-2">
      {GROK_PROVIDERS.map((p) => (
        <button
          key={p.providerId}
          type="button"
          onClick={() => signIn(p.providerId, { callbackURL: "/" })}
          className="w-full cursor-pointer rounded-md border border-neutral-300 px-4 py-2 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Continue with {p.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Minimal signed-in identity chip + sign-out. Restyle freely (see the
 * `design-ui` skill). Sign-out is only shown when auth is enabled (the
 * disabled-auth dev user has nothing to sign out of) and the session is not
 * gate-materialized — behind the gate the next request signs the viewer
 * straight back in, so a sign-out control there is a broken loop.
 */
/**
 * Làm gì: Hiển thị thông tin người dùng hiện tại (ảnh đại diện, tên hiển thị) và nút đăng xuất an toàn; tự động ẩn nút đăng xuất khi ở chế độ gate session hoặc tắt auth.
 * Được gọi ở: Header / thanh điều hướng chính của ứng dụng (trong layout src/routes/__root.tsx hoặc component navbar).
 * @returns Khối JSX hiển thị thông tin tài khoản và nút đăng xuất, hoặc null nếu chưa có người dùng đăng nhập.
 */
export function UserButton() {
  // Bước 1: Lấy thông tin người dùng hiện tại từ hook useCurrentUser; nếu chưa đăng nhập thì ẩn toàn bộ component (null).
  const user = useCurrentUser();
  // Sign-out can take a moment (and can fail when deployed), so the control
  // shows it is working and cannot be fired twice.
  const [signingOut, setSigningOut] = useState(false);
  // Bước 2: Đồng bộ trạng thái cookie gate session (__Host-grok_gate_session) để ẩn nút đăng xuất khi phiên do cổng Grok tự động cấp.
  const gateSession = useSyncExternalStore(
    subscribeToNothing,
    hasGateSessionMarker,
    noGateSessionOnServer,
  );
  if (!user) return null;
  // Bước 3: Xác định nhãn hiển thị ưu tiên theo thứ tự: tên hiển thị (displayName) -> email chính (primaryEmail) -> "Account".
  const label = user.displayName ?? user.primaryEmail ?? "Account";
  // Bước 4: Render thông tin người dùng gồm avatar (hoặc chữ cái đầu), tên và nút đăng xuất (kèm trạng thái signingOut chống bấm đúp).
  return (
    <div className="flex items-center gap-2">
      {user.profileImageUrl ? (
        <img
          src={user.profileImageUrl}
          alt=""
          className="h-8 w-8 rounded-full object-cover"
        />
      ) : (
        <span className="grid h-8 w-8 place-items-center rounded-full bg-black/10 text-sm font-medium dark:bg-white/20">
          {label.charAt(0).toUpperCase()}
        </span>
      )}
      <span className="text-sm font-medium">{label}</span>
      {authEnabled && !gateSession && (
        <button
          type="button"
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true);
            // Success navigates away; on failure re-enable so it can be retried.
            void signOut().catch(() => setSigningOut(false));
          }}
          className="cursor-pointer text-sm underline-offset-4 opacity-70 hover:underline disabled:cursor-wait disabled:no-underline"
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      )}
    </div>
  );
}
