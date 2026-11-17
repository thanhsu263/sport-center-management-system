/**
 * File: src/client/lib/use-read.ts
 * Vai trò: Hook và tiện ích đọc dữ liệu GET từ API cho toàn bộ giao diện frontend Arena3.
 * Vị trí trong app: Chạy ở client, quản lý vòng đời truy vấn dữ liệu (loading, data, error, stale, reload), chống race condition khi đổi path và hỗ trợ giữ dữ liệu cũ khi phân trang/lọc.
 */
import { useCallback, useEffect, useState } from "react";
import { ApiClientError, apiGet } from "@/client/arena3/client";
import { t } from "@/client/lib/i18n";

/** Why a read did not come back, in the shape a screen needs to say so. */
export type ReadError = {
  /** Already in the language the person reads. */
  message: string;
  /** The input the server named ("from", "to", "date") when it refused one of them. */
  field?: string;
  /**
   * The server answered "no" to the question itself: it was refused (400 / 422), the person may not
   * see it (403) or there is nothing there (404). Asking again gets the same answer, so a "Try again"
   * button would only bring the same words back; the person has to change what they asked for.
   */
  refused: boolean;
};

/** Statuses that mean "the answer is no", not "the answer did not arrive". */
const REFUSALS = new Set([400, 403, 404, 422]);

/**
 * Làm gì: Chuyển đổi ngoại lệ (unknown error) thành đối tượng ReadError chuẩn hóa để UI hiển thị lý do thao tác đọc dữ liệu thất bại.
 * Được gọi ở: use-read.ts (trong callback reject của useRead), attendance-panels.tsx, cancel-booking.tsx, coach.attendance.tsx, desk.gate.tsx, desk.gear.tsx, desk.index.tsx.
 * @param e Ngoại lệ hoặc đối tượng lỗi bắt được (ApiClientError, Error, hoặc kiểu dữ liệu bất kỳ).
 * @returns Đối tượng ReadError gồm message (thông điệp lỗi), field (tên trường bị server từ chối nếu có), và refused (true nếu server chủ động từ chối với mã 400/403/404/422).
 * @throws Không ném lỗi.
 */
export function readError(e: unknown): ReadError {
  // Bước 1: Nếu là lỗi ApiClientError, trích xuất thông điệp lỗi, trường bị lỗi và kiểm tra xem server có từ chối (400, 403, 404, 422) hay không
  if (e instanceof ApiClientError) {
    return { message: e.message, field: e.body.field, refused: REFUSALS.has(e.status) };
  }
  // Bước 2: Nếu là lỗi JavaScript thông thường hoặc lỗi khác, trả về thông điệp lỗi hoặc thông báo chung mặc định
  return { message: e instanceof Error ? e.message : t("Something went wrong"), refused: false };
}

type Answer<T> = { path: string; data: T | null; error: ReadError | null };

/**
 * One GET that follows its path.
 *
 * What comes back is the answer to the path as it is *now*: change the date and the old day's rows
 * are gone at once (not a render later), and a slow reply to an earlier date can never land on top
 * of a later one. When the server says no, `error` says why, so the screen can show the reason
 * where the rows would have been instead of leaving grey blocks behind a toast that fades.
 *
 * `reload()` asks again without blanking the screen, so a screen that refreshes after saving does
 * not flash; after an error it clears the message first, so "Try again" visibly does something.
 * A reload never joins a request that was already in flight: it follows a change, and an answer
 * asked for before that change is the old picture. `path` null means "nothing to ask yet".
 *
 * `keepPrevious` is for a long list the person pages through or filters: it keeps the last good
 * answer on screen while the next one is on its way (`stale` says so, so the screen can dim it and
 * mark it busy) instead of collapsing the list to a placeholder and throwing the scroll position
 * away. A failed answer always replaces it — rows that do not match what was asked are never left
 * under an error.
 */
/**
 * Làm gì: Hook thực hiện HTTP GET để đọc dữ liệu từ server theo đường dẫn API, tự động hủy kết quả cũ khi đổi path (tránh race condition), hỗ trợ tải lại (reload) và giữ dữ liệu cũ khi chuyển trang/lọc (keepPrevious).
 * Được gọi ở: Hầu hết các màn hình trong ứng dụng như desk.courts.tsx, desk.classes.tsx, app.book.tsx, coach.attendance.tsx, manager.plans.tsx, shell.tsx.
 * @param path Đường dẫn endpoint API cần đọc dữ liệu (ví dụ: "/v1/courts", null nếu chưa đủ điều kiện để gọi).
 * @param options Tùy chọn bổ sung cho hook; options.keepPrevious giữ lại dữ liệu thành công gần nhất trong khi request mới đang được tải (tránh giật layout/mất vị trí cuộn).
 * @returns Đối tượng gồm data (dữ liệu trả về hoặc null), error (lỗi ReadError nếu thất bại), stale (true khi đang hiển thị dữ liệu cũ của path trước đó), và reload (hàm kích hoạt gọi lại API).
 * @throws Không ném lỗi (bắt toàn bộ ngoại lệ và trả về qua trường error).
 */
export function useRead<T>(path: string | null, options?: { keepPrevious?: boolean }) {
  // Bước 1: Khởi tạo các state quản lý kết quả phản hồi hiện tại (answer), dữ liệu hợp lệ gần nhất (held), và số lần tải lại (round)
  const [answer, setAnswer] = useState<Answer<T> | null>(null);
  // The last good answer, for whichever path it was; only handed out when `keepPrevious` asks.
  const [held, setHeld] = useState<T | null>(null);
  const [round, setRound] = useState(0);

  // Bước 2: Kích hoạt gọi API mỗi khi path hoặc round thay đổi
  useEffect(() => {
    // Bỏ qua nếu path là null (chưa đủ tham số hoặc chưa cần gọi API)
    if (path === null) return;
    // Cờ live chống race condition: ngăn cập nhật state nếu component đã unmount hoặc effect đã bị hủy
    let live = true;
    // round > 0 (khi reload) sẽ yêu cầu dữ liệu mới nhất (fresh: true), bỏ qua request trùng đang bay
    apiGet<T>(path, { fresh: round > 0 }).then(
      (data) => {
        if (!live) return;
        setAnswer({ path, data, error: null });
        setHeld(data);
      },
      (e: unknown) => {
        if (!live) return;
        setAnswer({ path, data: null, error: readError(e) });
        setHeld(null);
      },
    );
    // Hủy hiệu lực của request hiện tại khi effect chạy lại hoặc component unmount
    return () => {
      live = false;
    };
  }, [path, round]);

  // Bước 3: Định nghĩa hàm reload để gọi lại API; nếu đang có lỗi thì xóa lỗi trước để giao diện phản hồi thao tác thử lại
  const reload = useCallback(() => {
    setAnswer((a) => (a?.error ? null : a));
    setRound((n) => n + 1);
  }, []);

  // Bước 4: Kiểm tra kết quả phản hồi có khớp với path hiện tại không và xác định cờ stale khi dùng keepPrevious
  const mine = answer !== null && answer.path === path ? answer : null;
  const stale = mine === null && options?.keepPrevious === true && held !== null;
  // Bước 5: Trả về dữ liệu, lỗi (nếu có), trạng thái stale và hàm reload cho component sử dụng
  return {
    data: mine ? mine.data : stale ? held : null,
    error: mine?.error ?? null,
    /** True while `data` is the answer to an earlier path, shown until the one asked for arrives. */
    stale,
    reload,
  };
}
