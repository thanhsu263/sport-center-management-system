/**
 * File này quản lý việc tải SDK Google Identity Services (GIS) và hiển thị nút đăng nhập / liên kết tài khoản Google.
 * Vị trí trong ứng dụng:
 * - Dùng trên trang đăng nhập (src/routes/login.tsx) để đăng nhập nhanh cho tài khoản đã liên kết trước đó.
 * - Dùng trên trang quản lý tài khoản (src/routes/account.tsx) để liên kết Google account với tài khoản hiện tại.
 */
import { useEffect, useRef, useState } from "react";
import { apiGet, apiPost, type SessionUser } from "@/client/arena3/client";
import { t, useLang } from "@/client/lib/i18n";

type GoogleId = {
  initialize(opts: { client_id: string; callback: (r: { credential?: string }) => void }): void;
  renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
};
declare global {
  interface Window {
    google?: { accounts: { id: GoogleId } };
  }
}

// Đường dẫn CDN chứa bộ thư viện client của Google Identity Services (GIS).
const GIS_SRC = "https://accounts.google.com/gsi/client";

// Biến lưu trữ Promise tải SDK để dùng lại giữa các lần gọi (tránh chèn lặp lại thẻ script).
let gisLoad: Promise<void> | null = null;

/** Google Identity Services, loaded once per page and only where the button is shown. */
/**
 * Làm gì: Tải thư viện script Google Identity Services (GIS) từ Google CDN theo cơ chế lazy load và lưu cache Promise để chỉ tải một lần duy nhất cho toàn trang.
 * Được gọi ở: src/client/components/google-sign-in.tsx (trong useEffect của component GoogleButton).
 * @returns Promise<void> hoàn thành khi script GIS được tải thành công vào DOM.
 * @throws Error("gis") khi trình duyệt không thể tải script từ Google CDN (do lỗi mạng hoặc bị chặn).
 */
function loadGis(): Promise<void> {
  // Bước 1: Khởi tạo Promise tải script nếu chưa có (singleton pattern để tránh tải trùng lặp).
  gisLoad ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    // Nếu tải script thất bại, đặt lại gisLoad về null để cho phép lần sau có thể thử tải lại.
    s.onerror = () => {
      gisLoad = null;
      reject(new Error("gis"));
    };
    document.head.appendChild(s);
  });
  // Bước 2: Trả về Promise đại diện cho tiến trình tải SDK của Google.
  return gisLoad;
}

/**
 * Google's own button. It renders nothing until a client id is known, so a
 * machine without one looks the same as before. Each press hands the Google ID
 * token to `onCredential`; what it means (sign in, or link) is the caller's.
 * Pass `clientId` when the caller already has it; otherwise it is fetched.
 */
/**
 * Làm gì: Hiển thị nút đăng nhập / liên kết chính thức của Google vào DOM container thông qua Google Identity Services (GIS). Nút chỉ render khi đã có client_id và sẽ chuyển Google ID token về callback onCredential khi người dùng hoàn tất xác thực.
 * Được gọi ở:
 * - src/client/components/google-sign-in.tsx: component GoogleSignIn (trên trang đăng nhập /login).
 * - src/routes/account.tsx: component AccountGoogleSection (trên trang /account để liên kết tài khoản).
 * @param onCredential Callback nhận chuỗi Google ID token (JWT) sau khi người dùng xác thực tài khoản Google thành công.
 * @param text Kiểu nhãn hiển thị trên nút: "continue_with" (Tiếp tục với Google) hoặc "signin_with" (Đăng nhập bằng Google).
 * @param clientId Mã Google Client ID; nếu không truyền thì component sẽ tự động gọi API GET /auth/google để lấy.
 * @returns Thẻ div container chứa nút Google SDK được render, hoặc null nếu chưa có clientId.
 */
export function GoogleButton({
  onCredential,
  text = "continue_with",
  clientId: knownClientId,
}: {
  onCredential: (credential: string) => void | Promise<void>;
  text?: "continue_with" | "signin_with";
  clientId?: string | null;
}) {
  // Bước 1: Khởi tạo các hook quản lý ngôn ngữ, tham chiếu DOM container và state client_id.
  const lang = useLang();
  const box = useRef<HTMLDivElement>(null);
  const [fetchedId, setFetchedId] = useState<string | null>(null);
  // Ưu tiên dùng knownClientId từ props; nếu không có thì dùng fetchedId lấy từ server.
  const clientId = knownClientId === undefined ? fetchedId : knownClientId;
  // The latest handler, so the one-time Google callback never calls a stale closure.
  const handler = useRef(onCredential);
  handler.current = onCredential;

  // Bước 2: Tự động tải client_id từ API backend GET /auth/google nếu props chưa truyền vào.
  useEffect(() => {
    if (knownClientId !== undefined) return;
    // Cờ live ngăn chặn việc cập nhật state khi component đã bị unmount trước khi API phản hồi.
    let live = true;
    apiGet<{ client_id: string | null }>("/auth/google", { background: true })
      .then((r) => live && setFetchedId(r.client_id))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [knownClientId]);

  // Bước 3: Tải Google Identity Services SDK và khởi tạo, render nút bấm Google vào container div.
  useEffect(() => {
    if (!clientId) return;
    let live = true;
    loadGis()
      .then(() => {
        const id = window.google?.accounts.id;
        if (!live || !id || !box.current) return;
        // Cấu hình Google Identity Services với client_id và hàm callback nhận token xác thực.
        id.initialize({
          client_id: clientId,
          callback: ({ credential }) => {
            if (credential) void handler.current(credential);
          },
        });
        // Dọn sạch các phần tử con cũ trong container trước khi render để tránh bị nhân đôi nút khi re-render.
        box.current.replaceChildren();
        // Render nút bấm Google vào DOM container với kiểu dáng, kích thước và ngôn ngữ hiện tại.
        id.renderButton(box.current, {
          type: "standard",
          theme: "outline",
          size: "large",
          shape: "pill",
          text,
          width: Math.min(box.current.clientWidth || 320, 400),
          locale: lang,
        });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [clientId, lang, text]);

  // Bước 4: Nếu server chưa cấu hình client_id (hoặc đang tải), ẩn component (trả về null).
  if (!clientId) return null;
  // Google's iframe paints an opaque white box when its colour scheme differs from the
  // page's dark one; a light scheme here keeps it transparent around the pill.
  return <div ref={box} className="flex min-h-11 w-full justify-center rounded-full [color-scheme:light]" />;
}

/**
 * "Continue with Google" on the sign-in page. It only signs in an account
 * whose owner already linked this Google account in Account settings; Google
 * never creates an account.
 */
/**
 * Làm gì: Cung cấp cụm giao diện đăng nhập bằng Google trên trang đăng nhập (/login), bao gồm đường kẻ phân cách và nút GoogleButton. Chỉ cho phép đăng nhập nếu tài khoản Google này đã được liên kết trước trong phần cài đặt tài khoản.
 * Được gọi ở: src/routes/login.tsx (trên trang đăng nhập /login).
 * @param onSignedIn Callback xử lý sau khi đăng nhập thành công, nhận token phiên làm việc và thông tin user từ server.
 * @param onError Callback xử lý khi đăng nhập hoặc xác thực thất bại, nhận đối tượng lỗi để hiển thị thông báo.
 * @returns Khối giao diện đăng nhập Google hoàn chỉnh, hoặc null nếu backend chưa cấu hình Google client_id.
 */
export function GoogleSignIn({
  onSignedIn,
  onError,
}: {
  onSignedIn: (res: { token: string; user: SessionUser }) => void;
  onError: (err: unknown) => void;
}) {
  // Bước 1: Khởi tạo state lưu trữ Google client_id lấy từ backend.
  const [clientId, setClientId] = useState<string | null>(null);
  // Bước 2: Gọi API GET /auth/google khi component mount để kiểm tra tính khả dụng của Google sign-in.
  useEffect(() => {
    let live = true;
    apiGet<{ client_id: string | null }>("/auth/google", { background: true })
      .then((r) => live && setClientId(r.client_id))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // Bước 3: Nếu hệ thống không cấu hình Google client_id thì ẩn toàn bộ khối đăng nhập Google.
  if (!clientId) return null;
  // Bước 4: Render khối giao diện gồm vạch phân cách, nút GoogleButton và lời nhắc liên kết tài khoản.
  return (
    <div className="mt-4 grid gap-3">
      <div className="flex items-center gap-3 text-2xs text-muted">
        <span className="h-px flex-1 bg-line" />
        {t("or")}
        <span className="h-px flex-1 bg-line" />
      </div>
      <GoogleButton
        clientId={clientId}
        onCredential={async (credential) => {
          try {
            onSignedIn(await apiPost<{ token: string; user: SessionUser }>("/auth/google", { credential }));
          } catch (e) {
            onError(e);
          }
        }}
      />
      <p className="text-center text-2xs text-muted">{t("Link Google in Account settings first.")}</p>
    </div>
  );
}
