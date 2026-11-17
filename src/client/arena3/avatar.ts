/**
 * File: src/client/arena3/avatar.ts
 * Vai trò: Hook tải và lưu bộ nhớ đệm (cache) blob URL của ảnh đại diện người dùng với xác thực Bearer token.
 * Vị trí trong app: Được sử dụng ở client bởi component UserAvatar (src/client/components/user-avatar.tsx) để hiển thị avatar người dùng, hỗ trợ tải trễ (lazy load) khi cuộn vào khung nhìn và tự động giải phóng bộ nhớ khi unmount.
 */
import { type RefObject, useEffect, useState } from "react";
import { getToken } from "./client";

// Định nghĩa kiểu dữ liệu phần tử trong cache: src là blob URL của ảnh, refs là số lượng component đang cùng hiển thị ảnh đó
type CacheEntry = { src: string; refs: number };
// Bộ nhớ đệm dùng chung ở client: ánh xạ URL avatar gốc sang blob URL tạm thời, dùng cơ chế đếm tham chiếu (reference counting) để chia sẻ giữa các component
const cache = new Map<string, CacheEntry>();

/**
 * Hook to fetch and cache an avatar image blob URL with Bearer token authentication.
 *
 * Uses reference counting so identical avatar URLs share one object URL, and revokes
 * the object URL when all referencing components unmount.
 *
 * If a targetRef is provided, avatar image fetching is deferred until the element
 * intersects the viewport (via IntersectionObserver).
 */
/**
 * Làm gì: Tải và lưu cache blob URL của ảnh đại diện người dùng với xác thực Bearer token, hỗ trợ đếm tham chiếu (reference counting) và lazy load.
 * Được gọi ở: src/client/components/user-avatar.tsx (component UserAvatar).
 * @param url Đường dẫn ảnh avatar cần tải từ server.
 * @param targetRef Ref trỏ đến phần tử DOM để trì hoãn việc tải ảnh cho đến khi phần tử xuất hiện trong khung nhìn (viewport).
 * @returns Blob URL của ảnh để gán vào thẻ img, hoặc null nếu không có url, chưa vào khung nhìn, thiếu token hoặc tải lỗi.
 */
export function useAvatarSrc(
  url: string | null | undefined,
  targetRef?: RefObject<Element | null>,
): string | null {
  // Bước 1: Khởi tạo state lưu blob URL (src) và trạng thái hiển thị trong viewport (inView); nếu không có targetRef thì mặc định inView = true để tải ngay
  const [src, setSrc] = useState<string | null>(null);
  const [inView, setInView] = useState<boolean>(() => !targetRef || typeof IntersectionObserver === "undefined");

  // Bước 2: Thiết lập IntersectionObserver để theo dõi phần tử DOM, kích hoạt inView = true khi phần tử cuộn vào gần khung nhìn
  useEffect(() => {
    if (!targetRef?.current || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const el = targetRef.current;
    let cancelled = false;
    // rootMargin 100px: tải trước khi phần tử cách viewport 100px để ảnh sẵn sàng kịp thời khi người dùng cuộn tới
    const observer = new IntersectionObserver(
      (entries) => {
        if (cancelled) return;
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          // Ngắt kết nối observer ngay sau khi đã vào khung nhìn vì chỉ cần kích hoạt tải ảnh một lần
          observer.disconnect();
        }
      },
      { rootMargin: "100px" },
    );
    observer.observe(el);
    // Dọn dẹp observer khi component unmount hoặc targetRef thay đổi để tránh rò rỉ bộ nhớ
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [targetRef]);

  // Bước 3: Tải ảnh và quản lý bộ nhớ đệm (cache): kiểm tra token, tái sử dụng URL nếu đã có trong cache hoặc fetch ảnh mới
  useEffect(() => {
    // Bỏ qua nếu không có URL hoặc phần tử chưa xuất hiện trong khung nhìn; reset src = null để tránh hiển thị ảnh cũ
    if (!url || !inView) {
      if (!inView) setSrc(null);
      return;
    }
    // Endpoint ảnh avatar yêu cầu đăng nhập; nếu thiếu Bearer token thì không thể tải ảnh
    const token = getToken();
    if (!token) {
      setSrc(null);
      return;
    }

    // Cờ active ngăn cập nhật state khi unmount, refCounted ghi nhận đã tăng refs trong cache, ac dùng để hủy request fetch dở dang
    let active = true;
    let refCounted = false;
    const ac = new AbortController();

    // Bước 4: Kiểm tra cache: nếu đã có sẵn, tăng số tham chiếu (refs) và dùng lại object URL hiện tại mà không cần gọi API mạng
    const existing = cache.get(url);
    if (existing) {
      existing.refs += 1;
      refCounted = true;
      setSrc(existing.src);
    } else {
      // Bước 5: Nếu chưa có trong cache, fetch dữ liệu nhị phân của ảnh qua HTTP với Bearer token và tạo blob URL mới
      (async () => {
        try {
          const res = await fetch(url, {
            headers: { authorization: `Bearer ${token}` },
            signal: ac.signal,
          });
          // Nếu request thất bại (401 hết hạn phiên, 404 không tìm thấy ảnh), giữ src = null để component hiển thị initials thay thế
          if (!res.ok) {
            if (active) setSrc(null);
            return;
          }
          const blob = await res.blob();
          if (!active) return;
          // Lưu blob URL vào cache dùng chung và tăng refs để quản lý vòng đời bộ nhớ
          let entry = cache.get(url);
          if (!entry) {
            entry = { src: URL.createObjectURL(blob), refs: 0 };
            cache.set(url, entry);
          }
          entry.refs += 1;
          refCounted = true;
          setSrc(entry.src);
        } catch {
          if (active) setSrc(null);
        }
      })();
    }

    // Bước 6: Hàm dọn dẹp khi unmount hoặc đổi URL: hủy fetch request dở dang, giảm refs và giải phóng URL (revokeObjectURL) khi refs <= 0
    return () => {
      active = false;
      ac.abort();
      if (refCounted) {
        const entry = cache.get(url);
        if (entry) {
          entry.refs -= 1;
          if (entry.refs <= 0) {
            URL.revokeObjectURL(entry.src);
            cache.delete(url);
          }
        }
      }
    };
  }, [url, inView]);

  // Bước 7: Trả về blob URL của ảnh đại diện (hoặc null nếu chưa tải xong/lỗi) để gán vào thẻ <img>
  return src;
}
