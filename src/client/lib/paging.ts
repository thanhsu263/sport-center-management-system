/**
 * Paging arithmetic shared by every long list.
 *
 * Pure functions only (no React, no imports), so the node test runner checks them directly.
 */

/** The page sizes a person can pick. A list's default should be one of these. */
/**
 * Làm gì: Danh sách các kích thước phân trang (10, 25, 50, 100 dòng/trang) cho phép người dùng lựa chọn khi xem các danh sách dài.
 * Được gọi ở: src/client/components/ui/index.tsx (Pagination component), src/client/lib/use-page-state.ts (usePageState hook).
 */
export const PAGE_SIZES = [10, 25, 50, 100] as const;

// Đại diện cho một vị trí hiển thị trên thanh phân trang: số trang cụ thể hoặc khoảng trống ("gap", hiển thị dấu ba chấm "…").
export type PageSlot = number | "gap";

/**
 * Which page buttons to draw: always the first and last page, the current one and its
 * neighbours, and a gap where pages are skipped ("1 … 4 5 6 … 20"). A gap never stands in for
 * a single page: "1 … 3" becomes "1 2 3", since the button takes the same room as the dots, and
 * up to seven pages are all drawn.
 */
/**
 * Làm gì: Tính toán danh sách các nút phân trang cần hiển thị trên giao diện (luôn có trang đầu, trang cuối, trang hiện tại, các trang lân cận và "gap" thay cho các đoạn nhảy trang).
 * Được gọi ở: src/client/components/ui/index.tsx (Pagination component), src/server/services/arena3.test.ts (test runner (node --test)).
 * @param page Số trang hiện tại đang xem (1-based index).
 * @param pages Tổng số trang có trong danh sách.
 * @param around Số lượng trang liền kề hai bên trang hiện tại cần hiển thị (mặc định là 1).
 * @returns Mảng PageSlot[] chứa số trang hoặc chuỗi "gap" tương ứng với vị trí hiển thị dấu ba chấm.
 */
export function pageWindow(page: number, pages: number, around = 1): PageSlot[] {
  // Bước 1: Trả về mảng rỗng nếu tổng số trang không hợp lệ (pages <= 0).
  if (pages <= 0) return [];
  // Bước 2: Nếu tổng số trang nhỏ (<= 2 * around + 5, ví dụ around=1 thì <= 7 trang), hiển thị tất cả các trang vì vẽ đủ nút chiếm ít hoặc bằng diện tích khi chèn "gap".
  // Few enough pages to show every one in the room the gaps would take.
  if (pages <= 2 * around + 5) return Array.from({ length: pages }, (_, i) => i + 1);
  // Bước 3: Giới hạn trang hiện tại trong khoảng [1, pages] và gom các trang cần giữ: trang đầu (1), trang cuối (pages) cùng các trang lân cận (current ± around).
  const current = Math.min(Math.max(1, page), pages);
  const keep = new Set<number>([1, pages]);
  for (let p = current - around; p <= current + around; p++) if (p >= 1 && p <= pages) keep.add(p);
  // Bước 4: Sắp xếp các số trang cần giữ theo thứ tự tăng dần để chuẩn bị duyệt tuần tự.
  const sorted = [...keep].sort((a, b) => a - b);
  // Bước 5: Duyệt mảng trang đã sắp xếp để chèn các trang hoặc "gap" (dấu ba chấm) vào kết quả.
  const out: PageSlot[] = [];
  for (const p of sorted) {
    const prev = out[out.length - 1];
    // Nếu khoảng cách giữa 2 trang là 2 (chỉ khuyết đúng 1 trang), vẽ luôn trang đó thay vì "gap" vì chiếm diện tích như nhau.
    if (typeof prev === "number" && p - prev === 2) out.push(prev + 1);
    // Nếu khoảng cách lớn hơn 2 thì chèn "gap" để đại diện cho nhiều trang bị ẩn ở giữa.
    else if (typeof prev === "number" && p - prev > 2) out.push("gap");
    out.push(p);
  }
  return out;
}

/**
 * The offset of the page that holds `offset` once pages are `size` rows long, so the row at
 * the top stays on screen when someone switches from 10 to 50 rows a page.
 */
/**
 * Làm gì: Căn chỉnh lại offset về đầu trang chứa nó khi người dùng đổi kích thước trang (size), giúp giữ nguyên dòng đầu tiên đang xem trên màn hình.
 * Được gọi ở: src/client/lib/use-page-state.ts (usePageState hook khi setPageSize), src/client/lib/paging.ts (hàm lastPageOffset), src/server/services/arena3.test.ts (test runner (node --test)).
 * @param offset Vị trí dòng hiện tại (0-based index) trong toàn bộ danh sách dữ liệu.
 * @param size Kích thước trang mới (số dòng trên một trang).
 * @returns Vị trí offset mới được làm tròn xuống bội số của size.
 */
export function alignOffset(offset: number, size: number): number {
  if (size <= 0) return 0;
  // Làm tròn offset xuống bội số gần nhất của size để đưa về vị trí bắt đầu của trang hiện tại.
  return Math.floor(Math.max(0, offset) / size) * size;
}

/** The offset of the last page, for a list that shrank under the page someone was on. */
/**
 * Làm gì: Tính toán offset của trang cuối cùng khi danh sách bị thu hẹp hoặc xóa bớt dữ liệu, tránh tình trạng người dùng bị kẹt ở trang trống.
 * Được gọi ở: src/client/components/ui/index.tsx (Pagination component khi offset vượt quá total), src/routes/desk.index.tsx (Desk page khi danh sách ticket co lại), src/server/services/arena3.test.ts (test runner (node --test)).
 * @param total Tổng số phần tử hiện có trong danh sách.
 * @param size Số phần tử hiển thị trên một trang (pageSize).
 * @returns Vị trí offset bắt đầu của trang cuối cùng (0-based index).
 */
export function lastPageOffset(total: number, size: number): number {
  if (total <= 0 || size <= 0) return 0;
  // Lấy vị trí phần tử cuối cùng (total - 1) rồi căn chỉnh theo size để tìm offset của trang cuối.
  return alignOffset(total - 1, size);
}
