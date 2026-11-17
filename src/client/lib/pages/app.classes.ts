/**
 * File: src/client/lib/pages/app.classes.ts
 * Vai trò: Hook logic và quản lý trạng thái cho trang danh sách lớp học của hội viên (/app/classes).
 * Vị trí trong app: Được gọi bởi component Page tại src/routes/app.classes.tsx; kết nối API /classes và /me để cung cấp danh sách lớp học, trạng thái đăng ký cá nhân, bộ lọc tìm kiếm và các thao tác ghi danh, giữ chỗ, chuyển khoản, rời lớp hoặc danh sách chờ.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSports } from "@/client/components/ui";
import { apiDelete, apiGet, apiPost } from "@/client/arena3/client";
import { classSlotMatches } from "@/shared/arena3/labels";
import { t, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";
import { useLive } from "@/client/lib/use-live";


type Cl = {
  id: string;
  sport: string;
  level: string;
  capacity: number;
  enrolled_count: number;
  court_code: string;
  coach_name: string;
  rrule: string;
  duration_min: number;
  status: string;
  price_vnd: number | null;
  min_enrolled?: number | null;
  start_on?: string;
  end_on?: string;
  description?: string | null;
  syllabus?: string | null;
  who_for?: string | null;
  bring?: string | null;
  my_enrollment: {
    id: string;
    status: string;
    hold_until: string | null;
    price_vnd: number | null;
    transfer_requested_at: string | null;
  } | null;
};


type EnrolQuote = {
  tuition_vnd: number;
  promo: { code: string; discount_vnd: number } | null;
  total_vnd: number;
  eligible: boolean;
  current_end: string | null;
  class_end: string;
  suggested_plan: { name: string; price_vnd: number } | null;
};


type Enr = {
  id: string;
  class_id: string;
  status: string;
  waitlist_pos: number | null;
  /** The class's next scheduled session, and the last moment leaving is allowed (BR-24). */
  next_session_at?: string | null;
  leave_until?: string | null;
};

type Offer = { id: string; class_id: string; expires_at: string; sport: string; level: string };

/**
 * Làm gì: Custom hook quản lý toàn bộ dữ liệu, bộ lọc và quy trình đăng ký lớp học cho hội viên (tải danh sách lớp, thông tin ghi danh cá nhân, tính học phí kèm ưu đãi, giữ chỗ, báo chuyển khoản và rời lớp).
 * Được gọi ở: src/routes/app.classes.tsx (component Page tại route /app/classes).
 * @param useRouteSearch Hook đọc search params từ URL route hiện tại để lấy bộ lọc môn thể thao ban đầu (?sport=...).
 * @returns Đối tượng chứa danh sách lớp học, trạng thái đăng ký cá nhân, các bộ lọc tìm kiếm và các hàm xử lý hành động người dùng.
 */
export function useMemberClasses(useRouteSearch: () => { sport?: string }) {
  // Bước 1: Tải song song danh sách lớp học (/classes) và thông tin cá nhân của hội viên (/me bao gồm danh sách đăng ký và suất mời nhận chỗ).
  const classesRead = useRead<{ items: Cl[] }>("/classes");
  const meRead = useRead<{ enrollments?: Enr[]; offers?: Offer[] }>("/me");
  // The list is only shown once the member's own enrolments are known too: without them every class would read "Enrol".
  const items = classesRead.data && meRead.data ? classesRead.data.items : null;
  const mine = meRead.data?.enrollments ?? [];
  const offers = meRead.data?.offers ?? [];
  const failure = classesRead.error ?? meRead.error;
  const [sport, setSport] = useState(useRouteSearch().sport ?? "");
  /**
   * Làm gì: Tải lại đồng thời dữ liệu danh sách lớp học (/classes) và thông tin cá nhân (/me) của hội viên.
   * Được gọi ở:
   * - Nội bộ hook useMemberClasses (lắng nghe sự kiện useLive("classes") và sau các hành động enrol, askTransfer, releaseSeat, leave).
   * - src/routes/app.classes.tsx (khi bấm thử lại lỗi, khi bộ đếm giữ chỗ hết hạn hoặc khi thanh toán thành công).
   * @returns Không trả về dữ liệu (void).
   */
  const load = () => {
    classesRead.reload();
    meRead.reload();
  };
  // Lắng nghe sự kiện SSE thời gian thực kênh "classes" để tự động làm mới danh sách khi có thay đổi từ hệ thống hoặc học viên khác.
  useLive("classes", load);

  const sports = useSports();
  const [limit, setLimit] = useState(6);
  const [detail, setDetail] = useState<Cl | null>(null);
  // Bước 2: Gom nhóm ID các lớp hội viên đã đăng ký và ghim cố định thứ tự ban đầu bằng ref để tránh nhảy thẻ lớp khi vừa bấm giữ chỗ (C-4).
  // The member's own classes come first (C-4): they are what someone opens this page to manage.
  const enrolledIds = new Set(mine.map((e) => e.class_id));
  // The order is fixed from the first load: holding a seat must not move the card the member just tapped.
  const pinned = useRef<Set<string> | null>(null);
  if (pinned.current == null && meRead.data) pinned.current = enrolledIds;
  const firstIds = pinned.current ?? enrolledIds;
  // Bước 3: Khởi tạo các state lọc lớp học (huấn luyện viên, thứ trong tuần, buổi trong ngày) và danh sách tên HLV tương ứng môn đã chọn.
  // Narrowing by coach, weekday and part of the day saves scrolling through every class.
  const [coach, setCoach] = useState("");
  const [day, setDay] = useState("");
  const [part, setPart] = useState("");
  const coachNames = [...new Set((items ?? []).filter((c) => !sport || c.sport === sport).map((c) => c.coach_name))].sort((a, b) =>
    a.localeCompare(b, "vi"),
  );
  // Bước 4: Lọc danh sách lớp học theo bộ môn, HLV, lịch học (rrule) và sắp xếp đưa các lớp đã đăng ký lên đầu danh sách.
  const matching = (items ?? [])
    .filter((c) => !sport || c.sport === sport)
    .filter((c) => !coach || c.coach_name === coach)
    .filter((c) => classSlotMatches(c.rrule, day, part))
    .sort((a, b) => Number(firstIds.has(b.id)) - Number(firstIds.has(a.id)));
  const shown = matching.slice(0, limit);
  // Đặt lại giới hạn phân trang về 6 lớp ban đầu mỗi khi người dùng thay đổi bất kỳ tiêu chí lọc nào.
  useEffect(() => setLimit(6), [sport, coach, day, part]);
  // Tạo map tra cứu nhanh thông tin đăng ký theo class_id với độ phức tạp O(1) để kiểm tra trạng thái từng lớp trên giao diện.
  const byClass = Object.fromEntries(mine.map((e) => [e.class_id, e]));
  // Bước 5: Khởi tạo các state quản lý tương tác người dùng: xác nhận rời lớp (leaving), báo giá đăng ký (enrolling), mã giảm giá (enrolCode) và cờ khóa thao tác (enrolBusy).
  // Leaving a class (or the waitlist) is asked twice: one tap used to give the seat away.
  const [leaving, setLeaving] = useState<{ enr: Enr; cls: Cl } | null>(null);
  // The class being enrolled in, with what it will cost said before anything is held.
  const [enrolling, setEnrolling] = useState<{ cls: Cl; quote: EnrolQuote } | null>(null);
  const [enrolCode, setEnrolCode] = useState("");
  const [enrolBusy, setEnrolBusy] = useState(false);

  /**
   * Làm gì: Lấy báo giá học phí (tuition_vnd) và giảm giá khuyến mãi cho lớp học qua API /quote, sau đó mở modal thanh toán cho hội viên.
   * Được gọi ở: src/routes/app.classes.tsx (nút "Enrol" trên thẻ lớp học tại dòng 325 và nút áp dụng mã ưu đãi tại dòng 446).
   * @param cls Đối tượng thông tin lớp học cần lấy báo giá.
   * @param code Mã giảm giá / ưu đãi hội viên nhập vào (mặc định chuỗi rỗng).
   * @returns Không trả về dữ liệu (Promise<void>).
   */
  async function openQuote(cls: Cl, code = "") {
    // Bước 1: Khóa tương tác bằng cờ enrolBusy để tránh người dùng bấm liên tục gây trùng lặp request.
    setEnrolBusy(true);
    try {
      // Bước 2: Chuẩn bị query param mã khuyến mãi và gọi API GET /classes/:id/quote để tính toán học phí.
      const qs = code.trim() ? `?promo_code=${encodeURIComponent(code.trim())}` : "";
      const quote = await apiGet<EnrolQuote>(`/classes/${cls.id}/quote${qs}`);
      // Bước 3: Lưu lớp học kèm báo giá vào state enrolling để mở modal thanh toán.
      setEnrolling({ cls, quote });
    } catch (e) {
      // Hiển thị thông báo lỗi thân thiện nếu không thể lấy báo giá hoặc vi phạm quy tắc gói tập (BR-19).
      toast.error(enrolError(e));
    } finally {
      // Mở lại tương tác các nút bấm sau khi kết thúc request.
      setEnrolBusy(false);
    }
  }

  /**
   * Làm gì: Xử lý và chuyển đổi đối tượng lỗi từ API đăng ký lớp thành thông báo tiếng Việt thân thiện, đặc biệt là lỗi BR-19 (thời hạn gói tập kết thúc trước ngày bế giảng).
   * Được gọi ở: Nội bộ hook useMemberClasses (hàm openQuote dòng 116 và hàm enrol dòng 149).
   * @param e Đối tượng lỗi bất kỳ (unknown) nhận được từ khối catch khi gọi API.
   * @returns Chuỗi thông báo lỗi đã được bản địa hóa để hiển thị toast.
   */
  /** The gate's refusal is shown from here, so it reads in the member's language. */
  function enrolError(e: unknown): string {
    // Bước 1: Trích xuất body phản hồi từ server để kiểm tra các mã quy tắc nghiệp vụ (BR).
    const body = (e as { body?: { br?: string; class_end?: string } } | null)?.body;
    // Bước 2: Xử lý quy tắc nghiệp vụ BR-19: thời hạn gói tập của hội viên phải kết thúc sau ngày kết thúc lớp học.
    if (body?.br === "BR-19" && body.class_end) {
      return t("Your membership must end after this class ends ({date}). Buy or extend a plan first.", { date: body.class_end });
    }
    // Bước 3: Dịch thông báo lỗi server qua hàm tServer nếu là Error, hoặc dùng thông báo mặc định.
    return e instanceof Error ? tServer(e.message) : t("Could not enrol");
  }

  /**
   * Làm gì: Gửi yêu cầu đăng ký tham gia lớp học hoặc ghi danh vào danh sách chờ (waitlist) nếu lớp đã hết chỗ.
   * Được gọi ở: src/routes/app.classes.tsx (nút đăng ký nhanh khi lớp đã đầy tại dòng 325 và nút xác nhận "Enrol now" trong modal tại dòng 391).
   * @param cls Đối tượng lớp học hội viên muốn đăng ký.
   * @param code Mã giảm giá / khuyến mãi (mặc định chuỗi rỗng).
   * @returns Không trả về dữ liệu (Promise<void>).
   */
  async function enrol(cls: Cl, code = "") {
    // Bước 1: Khóa giao diện bằng cờ enrolBusy để ngăn chặn việc người dùng nhấn đăng ký nhiều lần liên tiếp.
    setEnrolBusy(true);
    try {
      // Bước 2: Gọi API POST /classes/:id/enroll kèm mã giảm giá (nếu có) để xử lý đăng ký hoặc xếp hàng chờ.
      const r = await apiPost<{ waitlisted?: boolean; enrollment?: { status?: string } }>(
        `/classes/${cls.id}/enroll`,
        code.trim() ? { promo_code: code.trim() } : {},
      );
      // Bước 3: Thông báo kết quả theo trạng thái: đã vào danh sách chờ (waitlisted), đã giữ chỗ chờ thanh toán (hold), hoặc đăng ký thành công.
      toast.success(
        r.waitlisted
          ? t("Added to the waitlist")
          : r.enrollment?.status === "hold"
            ? t("Seat held. Pay before the timer runs out.")
            : t("You are enrolled"),
      );
      // Bước 4: Đóng modal đăng ký, xóa mã giảm giá và làm mới toàn bộ dữ liệu lớp học trên trang.
      setEnrolling(null);
      setEnrolCode("");
      load();
    } catch (e) {
      // Bắt lỗi và thông báo chi tiết cho người dùng (ví dụ lỗi BR-19 cần mua thêm gói tập).
      toast.error(enrolError(e));
    } finally {
      // Mở lại các nút bấm giao diện sau khi hoàn tất thao tác.
      setEnrolBusy(false);
    }
  }
  const [leaveBusy, setLeaveBusy] = useState(false);
  // One seat action at a time: asking for a transfer or releasing a hold both settle on the server.
  const [seatBusy, setSeatBusy] = useState<string | null>(null);
  /**
   * Làm gì: Gửi yêu cầu thanh toán chuyển khoản ngân hàng tới quầy lễ tân để giữ chỗ lớp học trong thời gian chờ đối soát.
   * Được gọi ở: src/routes/app.classes.tsx (nút "I have transferred" / "Tôi đã chuyển khoản" tại dòng 263).
   * @param enrId Mã định danh bản ghi đăng ký giữ chỗ (enrollment ID).
   * @returns Không trả về dữ liệu (Promise<void>).
   */
  async function askTransfer(enrId: string) {
    // Bước 1: Kiểm tra cờ seatBusy để đảm bảo chỉ xử lý duy nhất một hành động chỗ (giữ/hủy) tại một thời điểm.
    if (seatBusy) return;
    setSeatBusy(enrId);
    try {
      // Bước 2: Gọi API POST /enrollments/:id/transfer để thông báo tới quầy lễ tân kiểm tra giao dịch chuyển khoản.
      await apiPost(`/enrollments/${enrId}/transfer`);
      toast.success(t("The desk has been told. Your seat stays held."));
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Could not ask the desk"));
    } finally {
      // Bước 3: Giải phóng cờ seatBusy và làm mới dữ liệu để cập nhật trạng thái giữ chỗ từ server.
      setSeatBusy(null);
      load();
    }
  }
  /**
   * Làm gì: Hủy suất giữ chỗ (hold) lớp học trước khi hết giờ để nhường cơ hội đăng ký cho học viên khác.
   * Được gọi ở: src/routes/app.classes.tsx (nút "Release seat" / "Hủy giữ chỗ" tại dòng 273).
   * @param enrId Mã định danh bản ghi đăng ký giữ chỗ (enrollment ID).
   * @returns Không trả về dữ liệu (Promise<void>).
   */
  async function releaseSeat(enrId: string) {
    // Bước 1: Kiểm tra cờ seatBusy để chặn thao tác trùng lặp nếu đang xử lý một hành động chỗ khác.
    if (seatBusy) return;
    setSeatBusy(enrId);
    try {
      // Bước 2: Gọi API DELETE /enrollments/:id để hủy bỏ việc giữ chỗ trên hệ thống.
      await apiDelete(`/enrollments/${enrId}`);
      toast.success(t("Seat released"));
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Could not release the seat"));
    } finally {
      // Bước 3: Đặt lại trạng thái bận và tải lại dữ liệu để cập nhật danh sách lớp học.
      setSeatBusy(null);
      load();
    }
  }
  /**
   * Làm gì: Hủy đăng ký lớp học đã tham gia hoặc rút tên khỏi danh sách chờ (waitlist).
   * Được gọi ở: src/routes/app.classes.tsx (nút xác nhận nguy hiểm trong modal hủy tham gia lớp tại dòng 367).
   * @returns Không trả về dữ liệu (Promise<void>).
   */
  async function leave() {
    // Bước 1: Kiểm tra đối tượng cần hủy (leaving) và đảm bảo không có yêu cầu hủy nào khác đang thực thi.
    if (!leaving || leaveBusy) return;
    setLeaveBusy(true);
    try {
      // Bước 2: Gọi API DELETE /enrollments/:id để xóa bản ghi ghi danh hoặc bản ghi chờ trên server.
      await apiDelete(`/enrollments/${leaving.enr.id}`);
      // Bước 3: Phân biệt trạng thái: nếu đang trong hàng chờ thì báo rời waitlist, nếu đã ghi danh thì báo hủy lớp thành công.
      toast.success(leaving.enr.status === "waitlisted" ? t("Left the waitlist") : t("Enrolment cancelled"));
      // Bước 4: Đóng modal xác nhận, tải lại danh sách lớp và giải phóng cờ leaveBusy trong khối finally.
      setLeaving(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Could not cancel"));
    } finally {
      setLeaveBusy(false);
    }
  }
  return {
    items, mine, offers, failure, sport, setSport, load, sports, setLimit, detail, setDetail,
    coach, setCoach, day, setDay, part, setPart, coachNames, matching, shown, byClass, leaving,
    setLeaving, enrolling, setEnrolling, enrolCode, setEnrolCode, enrolBusy, openQuote, enrol,
    leaveBusy, seatBusy, askTransfer, releaseSeat, leave,
  };
}

export { type Cl };
