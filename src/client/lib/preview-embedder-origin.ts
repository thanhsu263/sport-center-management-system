/**
 * File: src/client/lib/preview-embedder-origin.ts
 * Vai trò: Kiểm tra và xác định origin của cửa sổ cha (Grok preview embedder) khi ứng dụng được nhúng trong iframe.
 * Vị trí trong app: Được gọi bởi preview-host-bridge.ts để bảo vệ an toàn cho cầu nối postMessage, chỉ cho phép giao tiếp với các host Grok hoặc môi trường dev đáng tin cậy.
 */
/**
 * Làm gì: Kiểm tra chuỗi origin có phải là máy chủ nhúng Grok hợp lệ (grok.com, subdomain của grok.com hoặc localhost/127.0.0.1/[::1]) hay không.
 * Được gọi ở: src/client/lib/preview-embedder-origin.ts (hàm resolveParentEmbedderOrigin); src/client/lib/preview-host-bridge.ts (re-export).
 * @param origin Chuỗi origin cần kiểm tra (ví dụ: "https://grok.com" hoặc "http://localhost:8080").
 * @returns true nếu origin nằm trong danh sách cho phép của Grok, ngược lại false.
 */
export function isGrokEmbedderOrigin(origin: string): boolean {
  try {
    // Bước 1: Phân tích chuỗi origin thành URL; chỉ chấp nhận giao thức web tiêu chuẩn (http: hoặc https:).
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    // Bước 2: Chuẩn hóa hostname về chữ thường để so khớp allowlist (grok.com, subdomain của Grok, hoặc localhost khi dev).
    const host = url.hostname.toLowerCase();
    if (host === "grok.com" || host.endsWith(".grok.com")) return true;
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return true;
    return false;
  } catch {
    // Trả về false nếu origin là chuỗi không hợp lệ khiến new URL() ném lỗi.
    return false;
  }
}

/**
 * Làm gì: Kiểm tra xem hostname của ứng dụng con (preview guest) có đang chạy trên môi trường sandbox của Grok hay không.
 * Được gọi ở: src/client/lib/preview-embedder-origin.ts (hàm resolveParentEmbedderOrigin); src/client/lib/preview-host-bridge.ts (re-export).
 * @param hostname Tên miền của ứng dụng khách (thường truyền từ window.location.hostname).
 * @returns true nếu hostname là grok-sandbox.com hoặc subdomain của nó, ngược lại false.
 */
export function isSandboxPreviewGuestHost(hostname: string): boolean {
  // Chuẩn hóa hostname về chữ thường và kiểm tra tên miền sandbox của Grok.
  const host = hostname.toLowerCase();
  return host === "grok-sandbox.com" || host.endsWith(".grok-sandbox.com");
}

/**
 * Làm gì: Kiểm tra cặp hostname giữa trang xem trước (guest) và trang cha (parent) có khớp cấu trúc preview phân nhánh dạng <label>.preview.<domain> hay không.
 * Được gọi ở: src/client/lib/preview-embedder-origin.ts (hàm resolveParentEmbedderOrigin).
 * @param guestHost Hostname của iframe con đang chạy bản xem trước.
 * @param parentHost Hostname của cửa sổ cha đang nhúng iframe.
 * @returns true nếu guestHost và parentHost tạo thành cặp preview hợp lệ, ngược lại false.
 */
function isRemintPreviewPair(guestHost: string, parentHost: string): boolean {
  // Bước 1: Chuẩn hóa tên miền về chữ thường và tìm vị trí chuỗi phân tách xem trước (.preview.).
  const guest = guestHost.toLowerCase();
  const parent = parentHost.toLowerCase();
  const sep = ".preview.";
  const i = guest.indexOf(sep);
  // Nếu không chứa .preview. hoặc .preview. nằm ở đầu chuỗi (thiếu label) thì không phải preview pair hợp lệ.
  if (i <= 0) return false;
  // Bước 2: Tách phần nhãn nhánh (label) phía trước và tên miền gốc (rest) phía sau chuỗi phân tách.
  const label = guest.slice(0, i);
  const rest = guest.slice(i + sep.length);
  // Nhãn label chỉ được là một cấp subdomain (không chứa dấu chấm) và domain gốc rest phải là domain hợp lệ (chứa dấu chấm).
  if (label.includes(".") || !rest.includes(".")) return false;
  // Bước 3: Xác thực parentHost khớp với domain gốc (rest) hoặc subdomain grok.<rest>.
  return parent === rest || parent === `grok.${rest}`;
}

/**
 * Làm gì: Xác định và trả về origin hợp lệ của cửa sổ cha (Grok embedder) đang nhúng ứng dụng; trả về null nếu chạy độc lập hoặc không thuộc nguồn tin cậy.
 * Được gọi ở: src/client/lib/preview-host-bridge.ts (hàm resolveCurrentEmbedderOrigin và re-export).
 * @param parentIsSelf Cờ cho biết trang hiện tại có đang tự mở độc lập (window.parent === window) mà không bị nhúng trong iframe hay không.
 * @param referrer URL của trang cha giới thiệu tới iframe này (lấy từ document.referrer).
 * @param ancestorOrigin Origin của trang cha lấy từ location.ancestorOrigins (nếu trình duyệt hỗ trợ).
 * @param guestHostname Hostname của chính trang xem trước hiện tại (mặc định là chuỗi rỗng).
 * @returns Origin hợp lệ của trang cha (ví dụ: "https://grok.com") để gửi postMessage, hoặc null nếu không an toàn.
 */
export function resolveParentEmbedderOrigin(
  parentIsSelf: boolean,
  referrer: string,
  ancestorOrigin?: string | null,
  guestHostname: string = "",
): string | null {
  // Nếu ứng dụng đang chạy độc lập ở cửa sổ riêng (không bị nhúng trong iframe), không cần bridge nên trả về null.
  if (parentIsSelf) return null;
  // Bước 1: Quét qua các nguồn khả dĩ có thể chứa origin của trang cha (document.referrer hoặc ancestorOrigin).
  for (const candidate of [referrer, ancestorOrigin ?? ""].filter(Boolean)) {
    try {
      // Bước 2: Phân tích ứng viên thành đối tượng URL; tự động bổ sung scheme https:// nếu chuỗi thiếu giao thức.
      const url = new URL(
        candidate.includes("://") ? candidate : `https://${candidate}`,
      );
      // Bỏ qua các ứng viên không sử dụng giao thức web tiêu chuẩn (chỉ chấp nhận https hoặc http).
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      // Bước 3: Ưu tiên trả về ngay nếu origin thuộc danh sách Grok embedder chính thức hoặc localhost.
      if (isGrokEmbedderOrigin(url.origin)) return url.origin;
      // Bước 4: Chấp nhận origin nếu ứng dụng đang chạy trên sandbox hoặc khớp cấu trúc cặp preview phân nhánh.
      if (
        isSandboxPreviewGuestHost(guestHostname) ||
        isRemintPreviewPair(guestHostname, url.hostname)
      ) {
        return url.origin;
      }
    } catch {
      // try next candidate
    }
  }
  // Không tìm thấy origin nào hợp lệ và thỏa mãn điều kiện an toàn.
  return null;
}
