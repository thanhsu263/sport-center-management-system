/**
 * Quản lý trạng thái phân trang (offset và pageSize) cho các bảng dữ liệu và danh sách dài trong client.
 * Lưu và ghi nhớ lựa chọn pageSize vào localStorage theo từng danh sách riêng biệt, đồng thời tự động căn chỉnh lại offset khi thay đổi số dòng mỗi trang.
 */
import { useCallback, useEffect, useState } from "react";
import { PAGE_SIZES, alignOffset } from "./paging";

/**
 * Làm gì: Tạo khóa lưu trữ (key) trong localStorage để lưu pageSize riêng biệt cho từng danh sách cụ thể.
 * Được gọi ở: usePageState (trong useEffect để đọc cấu hình đã lưu và trong hàm callback setPageSize).
 * @param list Tên định danh của danh sách (ví dụ: "desk.gate", "desk.tickets", "manager.invoices").
 * @returns Chuỗi khóa lưu trữ có dạng "arena3.pageSize.<list>".
 */
const storageKey = (list: string) => `arena3.pageSize.${list}`;

/**
 * Offset and page size for one long list, with the page size remembered per list.
 *
 * The stored size is read after mount: the server render has no storage, so the first client
 * render must match it. Storage can be blocked (private mode); the choice then lasts the visit.
 * Callers reset to page one when their filters change: `useEffect(reset, [filters])`.
 */
/**
 * Làm gì: Hook quản lý trạng thái phân trang (offset và pageSize) cho danh sách dài, hỗ trợ ghi nhớ pageSize vào localStorage và tự động điều chỉnh offset khi đổi số dòng mỗi trang.
 * Được gọi ở: Các trang danh sách dữ liệu trong src/routes/ (account.tsx, alerts.tsx, app.notifications.tsx, app.points.tsx, desk.gate.tsx, desk.index.tsx, desk.maintenance.tsx, manager.invoices.tsx, manager.members.tsx, manager.staff.tsx).
 * @param list Tên định danh của danh sách để lưu pageSize riêng biệt trong localStorage.
 * @param defaultSize Số dòng hiển thị mặc định trên một trang (mặc định là 25).
 * @returns Đối tượng gồm { offset, setOffset, pageSize, setPageSize, reset }.
 */
export function usePageState(list: string, defaultSize: number = 25) {
  // Bước 1: Khởi tạo state lưu số dòng mỗi trang (pageSize) và vị trí dòng bắt đầu (offset, mặc định từ 0).
  const [pageSize, setSize] = useState(defaultSize);
  const [offset, setOffset] = useState(0);

  // Bước 2: Đọc pageSize đã lưu từ localStorage sau khi mount để đồng bộ dữ liệu ở client mà không gây lỗi hydration với server.
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey(list)));
      // Chỉ nhận giá trị hợp lệ thuộc PAGE_SIZES ([10, 25, 50, 100]) để tránh lỗi hiển thị khi dữ liệu trong storage bị sai lệch.
      if ((PAGE_SIZES as readonly number[]).includes(saved)) setSize(saved);
    } catch {
      /* storage blocked */
    }
  }, [list]);

  // Bước 3: Định nghĩa hàm setPageSize để cập nhật số dòng mỗi trang, tự tính lại offset tương ứng và lưu vào localStorage.
  const setPageSize = useCallback(
    (size: number) => {
      // Căn chỉnh lại offset bằng alignOffset để hàng đầu tiên đang xem vẫn hiển thị trên màn hình khi thay đổi kích thước trang.
      setOffset((o) => alignOffset(o, size));
      setSize(size);
      try {
        localStorage.setItem(storageKey(list), String(size));
      } catch {
        /* storage blocked: the choice lasts this visit */
      }
    },
    [list],
  );

  // Bước 4: Định nghĩa hàm reset để đưa offset về trang đầu (offset = 0), thường gọi khi bộ lọc (filters) thay đổi.
  const reset = useCallback(() => setOffset(0), []);

  // Bước 5: Trả về trạng thái phân trang và các hàm điều khiển để component giao diện sử dụng.
  return { offset, setOffset, pageSize, setPageSize, reset };
}
