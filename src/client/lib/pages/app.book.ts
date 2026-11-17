/**
 * Quản lý toàn bộ trạng thái và logic nghiệp vụ cho màn hình đặt sân của hội viên (/app/book).
 * Cung cấp custom hook useCourtBooking kết nối dữ liệu lịch sân trống theo thời gian thực (SSE),
 * xử lý quy trình giữ chỗ (hold slot), thanh toán chuyển khoản, đổi lịch (reschedule) và hủy đặt sân.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAvailability } from "@/client/components/availability-calendar";
import { freeHours, type Court, type OccSlot } from "@/client/components/court-grid";
import { useCentreBank } from "@/client/components/transfer-qr-modal";
import { apiGet, apiPost, openInvoice, ApiClientError } from "@/client/arena3/client";
import type { ConfirmResponse, HoldResponse, MeBookingsResponse, MyBooking, MyClassSession } from "@/shared/arena3/contracts";
import { todayISO } from "@/shared/arena3/labels";
import { t } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";
import { useLimits } from "@/client/lib/use-centre";
import { useLive } from "@/client/lib/use-live";
import { useSports } from "@/client/components/sports-ui";
import { DEFAULT_VENUE, hoursOf, venueFrom, type Venue, type VenueRaw } from "@/client/lib/venue";


/**
 * Làm gì: Tìm các khung giờ còn trống gần nhất của cùng môn thể thao khi khung giờ mong muốn bị hết chỗ hoặc xung đột.
 * Được gọi ở: src/client/lib/pages/app.book.ts -> trong hàm holdSlot().
 * @param data Danh sách sân (courts) và các slot đã bị chiếm chỗ (slots).
 * @param wanted Thông tin sân mà hội viên mong muốn đặt.
 * @param hour Khung giờ hội viên muốn đặt (ví dụ: 18 nghĩa là 18:00).
 * @param date Ngày đặt sân định dạng YYYY-MM-DD.
 * @param hours Danh sách các khung giờ mở cửa của trung tâm.
 * @param count Số lượng khung giờ gợi ý thay thế tối đa.
 * @returns Danh sách các khung giờ trống được sắp xếp theo độ lệch giờ tăng dần so với giờ mong muốn.
 */
/** The closest still-free hours on the same sport, nearest to what they wanted. */
function nearestFree(
  data: { courts: Court[]; slots: OccSlot[] },
  wanted: Court,
  hour: number,
  date: string,
  hours: readonly number[],
  count: number,
) {
  // Bước 1: Lọc danh sách sân thuộc cùng môn thể thao với sân hội viên mong muốn đặt
  const sameSport = data.courts.filter((c) => c.sport === wanted.sport);
  // Bước 2: Tìm các khung giờ còn trống trong ngày và sắp xếp ưu tiên giờ lệch ít nhất
  return freeHours(sameSport, data.slots, date, Date.now(), true, hours)
    .sort(
      (a, b) =>
        Math.abs(a.hour - hour) - Math.abs(b.hour - hour) ||
        Number(b.court.court_code === wanted.court_code) -
          Number(a.court.court_code === wanted.court_code),
    )
    .slice(0, count);
}


/** One of the member's own upcoming court bookings (M-04). */
type Hold = HoldResponse & {
  /** Which slot this is, carried from the tap so the card can name it. */
  court_code?: string;
  hour?: number;
};


/** A hold that was refused, and — when another hour would help — where to go instead. */
type Taken = {
  message: string;
  alts: { court: Court; hour: number }[];
  /** False when the refusal was about the member, not the slot. */
  canRetry: boolean;
};

/**
 * Làm gì: Custom hook quản lý toàn bộ dữ liệu, trạng thái và nghiệp vụ đặt sân của hội viên.
 * Được gọi ở: src/routes/app.book.tsx -> component Page (route /app/book).
 * @param useRouteSearch Hook đọc query parameters từ URL route (chứa sport nếu có).
 * @returns Object chứa các state (ngày, môn, tình trạng sân, đơn giữ chỗ, thông báo trùng lịch...) và các hàm xử lý đặt sân.
 */
export function useCourtBooking(useRouteSearch: () => { sport?: string }) {
  const limits = useLimits();
  const { sports } = useSports();
  const searchSport = useRouteSearch().sport;
  const [date, setDate] = useState(todayISO);
  const [sport, setSport] = useState(searchSport ?? "");
  // Open on the first sport once; after that "All" ("") is a real choice, not a gap to fill.
  const sportDefaulted = useRef(searchSport != null);
  useEffect(() => {
    if (!sportDefaulted.current && sports.length > 0) {
      sportDefaulted.current = true;
      setSport(sports[0].code);
    }
  }, [sports]);
  // The day on screen. A day the server will not show comes back as `error` (not a grid of grey
  // blocks behind a toast), and a late reply for an earlier date never lands on a later one.
  const { data, error, reload } = useRead<{ courts: Court[]; slots: OccSlot[] }>(`/occupancy?date=${date}`);
  const [hold, setHold] = useState<Hold | null>(null);
  // Typed before tapping a slot: the hold is priced when it is made, so the code goes with it.
  const [promoCode, setPromoCode] = useState("");
  const [promoOpen, setPromoOpen] = useState(false);
  // Refusals and clash warnings appear above the grid; a tap deep in the grid must still see them.
  const notices = useRef<HTMLDivElement>(null);
  const [overlap, setOverlap] = useState<{ court: Court; hour: number; message: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const avail = useAvailability(sport, refresh);
  const [mine, setMine] = useState<MyBooking[] | null>(null);
  const [myClasses, setMyClasses] = useState<MyClassSession[]>([]);
  const [showAllClasses, setShowAllClasses] = useState(false);
  const [windowHours, setWindowHours] = useState(2);
  const [showAllMine, setShowAllMine] = useState(false);
  type MySub = {
    plan_name: string;
    end_on: string;
  };
  const [mySubs, setMySubs] = useState<MySub[]>([]);

  // The booking being moved: the grid's next tap lands on it instead of making a new hold.
  const [moving, setMoving] = useState<MyBooking | null>(null);
  const [moveError, setMoveError] = useState("");
  const [cancelId, setCancelId] = useState<string | null>(null);
  /**
   * Làm gì: Tải danh sách lịch đặt sân cá nhân, lớp học đã đăng ký và gói hội viên của người dùng hiện tại.
   * Được gọi ở: useCourtBooking -> hàm load() và useEffect khi đổi ngày (date).
   * @returns Promise<void>
   */
  async function loadMine() {
    // Bước 1: Lấy danh sách lịch đặt sân cá nhân, buổi học lớp và giới hạn giờ hủy/đổi lịch
    try {
      const r = await apiGet<MeBookingsResponse>("/me/bookings");
      setMine(r.items);
      setMyClasses(r.class_sessions ?? []);
      setWindowHours(r.window_hours);
    } catch {
      // Keep the list that is already on screen
    }
    // Bước 2: Lấy thông tin các gói hội viên (subscriptions) của người dùng hiện tại
    try {
      const me = await apiGet<{ subscriptions?: MySub[] }>("/me");
      if (Array.isArray(me.subscriptions)) {
        setMySubs(me.subscriptions);
      }
    } catch {
      // Ignore if /me subscriptions unavailable
    }
  }
  const [taken, setTaken] = useState<Taken | null>(null);
  const [busy, setBusy] = useState(false);
  // Tự động cuộn màn hình đến phần thông báo khi bị từ chối giữ chỗ hoặc phát hiện trùng lịch
  useEffect(() => {
    if (taken || overlap) notices.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [taken, overlap]);
  // Leave the online button out entirely when the centre has no payOS set up,
  // rather than offering one that errors.
  const [onlineOn, setOnlineOn] = useState(false);
  // The centre's hours and hold length come with the same answer, for the grid and the copy.
  const [venue, setVenue] = useState<Venue>(DEFAULT_VENUE);
  useEffect(() => {
    void apiGet<{ capabilities?: { online_payment?: boolean }; venue?: VenueRaw }>("/flags")
      .then((r) => {
        setOnlineOn(Boolean(r.capabilities?.online_payment));
        setVenue(venueFrom(r.venue));
      })
      .catch(() => setOnlineOn(false));
  }, []);
  // Sticks around after the toast has gone. A receipt people paid for should
  // not be something you have four seconds to notice.
  const [receipt, setReceipt] = useState<string | null>(null);
  // A transfer the member has promised but reception has not yet found.
  const [pending, setPending] = useState<{ amount: number; until: string; code: string } | null>(null);
  // The centre's own account for VietQR. Without one the transfer option is left out entirely,
  // rather than asking for money with nowhere to send it (B-5).
  const { bank } = useCentreBank();
  const bankOn = bank?.configured === true;
  const [transferOpen, setTransferOpen] = useState<"hold" | "pending" | null>(null);

  /**
   * Làm gì: Tải lại toàn bộ dữ liệu gồm lưới sân trống (/occupancy), lịch tháng và lịch cá nhân của hội viên.
   * Được gọi ở: useCourtBooking -> hook useLive("courts", load), và sau khi giữ chỗ, đổi lịch hoặc xác nhận thanh toán.
   * @returns void
   */
  /** Ask again for the day on screen and for everything counted from it. */
  function load() {
    // Bước 1: Tải lại dữ liệu chiếm sân (occupancy) của ngày đang chọn
    reload();
    // Bước 2: Tăng biến đếm refresh để kích hoạt useAvailability tải lại số slot trống theo tháng
    setRefresh((n) => n + 1);
    // Bước 3: Tải lại lịch đặt sân và gói hội viên cá nhân
    void loadMine();
  }

  // Lắng nghe sự kiện SSE 'courts' để tự động cập nhật lại toàn bộ lưới sân khi có thay đổi realtime
  useLive("courts", load);

  /**
   * Làm gì: Chuyển đổi lịch đặt sân hiện có sang một sân hoặc khung giờ mới (reschedule).
   * Được gọi ở: src/routes/app.book.tsx -> khi hội viên nhấp vào ô slot trên lưới sân trong trạng thái di chuyển (moving).
   * @param court Sân mới muốn chuyển đến.
   * @param hour Khung giờ mới muốn chuyển đến.
   * @param confirmOverlap Đánh dấu true nếu hội viên đã xác nhận chấp nhận trùng lịch cá nhân.
   * @returns Promise<void>
   */
  async function moveTo(court: Court, hour: number, confirmOverlap = false) {
    // Bước 1: Kiểm tra lịch cần chuyển và tạo chuỗi thời gian bắt đầu theo múi giờ Việt Nam (+07:00)
    if (!moving) return;
    const start = `${date}T${String(hour).padStart(2, "0")}:00:00+07:00`;
    setBusy(true);
    setMoveError("");
    // Bước 2: Gửi yêu cầu đổi lịch đặt sân lên backend qua API /bookings/:id/reschedule
    try {
      await apiPost(
        `/bookings/${moving.id}/reschedule`,
        { start_at: start, court_id: court.id, ...(confirmOverlap ? { confirm_overlap: true } : {}) },
      );
      // Bước 3: Đổi lịch thành công, hiển thị toast thông báo, thoát chế độ di chuyển và tải lại dữ liệu
      toast.success(
        t("Moved {code} to {court} · {time}", {
          code: moving.code,
          court: court.court_code,
          time: `${String(hour).padStart(2, "0")}:00`,
        }),
      );
      setMoving(null);
      setOverlap(null);
      load();
    // Bước 4: Xử lý lỗi: nếu hệ thống yêu cầu xác nhận trùng lịch thì lưu vào overlap, ngược lại báo lỗi
    } catch (e) {
      if (e instanceof ApiClientError && e.body.requires_confirm && !confirmOverlap) {
        setOverlap({ court, hour, message: e.body.message });
      } else {
        setMoveError(e instanceof Error ? e.message : t("Could not move that booking"));
        load();
      }
    // Bước 5: Kết thúc xử lý, giải phóng cờ bận
    } finally {
      setBusy(false);
    }
  }

  /**
   * Làm gì: Bắt đầu quy trình đổi lịch cho một đơn đặt sân, chuyển màn hình về đúng ngày và môn thể thao của lịch đó.
   * Được gọi ở: src/routes/app.book.tsx -> khi hội viên bấm nút đổi lịch trên thẻ đơn đặt sân.
   * @param b Thông tin lịch đặt sân (MyBooking) cần đổi.
   * @returns void
   */
  function startMove(b: MyBooking) {
    // Bước 1: Đánh dấu đơn đặt sân cần di chuyển và xóa các trạng thái giữ chỗ/thông báo lỗi cũ
    setMoving(b);
    setMoveError("");
    setHold(null);
    setTaken(null);
    // Bước 2: Đồng bộ môn thể thao và chuyển ngày hiển thị về đúng ngày của lịch đặt
    setSport(b.sport);
    // Open the booking's own day: most changes are another hour the same day.
    setDate(
      new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(b.start_at)),
    );
  }
  // Opening a day also refreshes the counts on the strip and the member's own list.
  useEffect(() => {
    setRefresh((n) => n + 1);
    void loadMine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  /**
   * Làm gì: Tạo yêu cầu giữ chỗ sân (hold slot) kèm mã giảm giá; tự động tìm khung giờ thay thế gần nhất nếu slot bị chiếm.
   * Được gọi ở: src/routes/app.book.tsx -> khi hội viên nhấn chọn một ô slot còn trống trên lưới sân.
   * @param court Sân được chọn để giữ chỗ.
   * @param hour Khung giờ được chọn (ví dụ: 19 nghĩa là 19:00).
   * @param confirmOverlap Đánh dấu true nếu hội viên chấp nhận tiếp tục dù bị cảnh báo trùng lịch cá nhân.
   * @returns Promise<void>
   */
  async function holdSlot(court: Court, hour: number, confirmOverlap = false) {
    // Bước 1: Khởi tạo thời gian bắt đầu với múi giờ Việt Nam (+07:00) và bật cờ bận
    const start = `${date}T${String(hour).padStart(2, "0")}:00:00+07:00`;
    setBusy(true);
    // Bước 2: Gửi yêu cầu giữ chỗ sân lên API /bookings kèm mã khuyến mãi (nếu có)
    try {
      const res = await apiPost<HoldResponse>(
        "/bookings",
        {
          court_id: court.id,
          start_at: start,
          ...(confirmOverlap ? { confirm_overlap: true } : {}),
          ...(promoCode.trim() ? { promo_code: promoCode.trim() } : {}),
        },
        true,
      );
      // Bước 3: Giữ chỗ thành công, lưu thông tin hold, hiển thị toast và làm mới lưới sân
      setHold({ ...res, court_code: court.court_code, hour });
      setOverlap(null);
      setTaken(null);
      toast.success(t("Holding {court} · {code}", { court: court.court_code, code: res.booking.code }));
      load();
    // Bước 4: Xử lý lỗi giữ chỗ: nếu cần xác nhận trùng lịch thì lưu vào overlap, nếu slot đã bị chiếm thì tìm giờ thay thế
    } catch (e) {
      if (e instanceof ApiClientError && e.body.requires_confirm && !confirmOverlap) {
        setOverlap({ court, hour, message: e.body.message });
      } else {
        // Two people reaching for the same 19:00 on a Saturday is the system
        // working, not breaking — but a red toast saying "slot unavailable"
        // leaves the member to start the search again from nothing. Offer the
        // nearest hours that are still open instead, closest first.
        const message = e instanceof Error ? e.message : t("Could not hold that slot");
        // Only when another hour would actually help. A member who has used up
        // their two holds for the day, or whose balance is over the limit, is
        // not going to get anywhere by tapping a different court — offering
        // three of them would just be three more refusals.
        const aboutTheSlot =
          !(e instanceof ApiClientError) ||
          e.body.code === "CONFLICT_SLOT" ||
          e.body.br === "BR-06" ||
          e.body.br === "BR-07";
        // Re-read the day before suggesting anything: the grid on screen is
        // the one that just turned out to be wrong.
        const fresh = aboutTheSlot
          ? await apiGet<{ courts: Court[]; slots: OccSlot[] }>(`/occupancy?date=${date}`).catch(
              () => null,
            )
          : null;
        if (aboutTheSlot) reload();
        // Cập nhật danh sách các khung giờ thay thế gần nhất nếu lỗi do slot bị chiếm
        setTaken({
          message,
          alts: fresh ? nearestFree(fresh, court, hour, date, hoursOf(venue), limits.book_alternatives) : [],
          canRetry: aboutTheSlot,
        });
      }
    // Bước 5: Kết thúc xử lý, giải phóng cờ bận
    } finally {
      setBusy(false);
    }
  }

  /**
   * Làm gì: Xác nhận thanh toán cho đơn giữ chỗ hiện tại bằng hình thức chuyển khoản ngân hàng.
   * Được gọi ở: src/routes/app.book.tsx -> trong modal chuyển khoản hoặc khi hội viên nhấn xác nhận chuyển tiền.
   * @param method Phương thức thanh toán (hiện tại hỗ trợ "transfer").
   * @returns Promise<void>
   */
  async function confirmPay(method: "transfer") {
    // Bước 1: Kiểm tra đơn giữ chỗ hiện tại và bật cờ bận
    if (!hold) return;
    setBusy(true);
    // Bước 2: Gửi yêu cầu xác nhận thanh toán lên backend qua API /bookings/:id/confirm
    try {
      // The endpoint issues an invoice and hands back its id. Dropping that on
      // the floor is why a member could pay and never see a receipt — nothing
      // in the UI ever mentioned one existed.
      const res = await apiPost<ConfirmResponse>(`/bookings/${hold.booking.id}/confirm`, { method }, true);
      // Bước 3: Xóa đơn giữ chỗ tạm thời và tải lại dữ liệu lịch sân
      setHold(null);
      load();
      // A transfer is not a booking yet. Saying "Booking confirmed" here would
      // be the app telling a member their court is theirs while reception has
      // not found a single dong of it in the bank.
      // Bước 4: Trường hợp chuyển khoản chờ lễ tân đối soát: lưu vào pending và thông báo giữ sân tạm thời
      if ("awaiting_transfer" in res) {
        setPending({ amount: hold.due_now_vnd, until: res.hold_until, code: hold.booking.code });
        toast.success(t("Transfer noted"), {
          description: t("Your court is held while reception checks the bank."),
        });
        return;
      }
      // Bước 5: Đã có hóa đơn: lưu mã hóa đơn và hiển thị toast kèm nút xem hóa đơn
      if (res.invoice_id) {
        setReceipt(res.invoice_id);
        toast.success(t("Booking confirmed"), {
          description: t("Your receipt is ready."),
          action: {
            label: t("Open receipt"),
            onClick: () => void openInvoice(res.invoice_id!),
          },
        });
      } else {
        toast.success(t("Booking confirmed"));
      }
    // Bước 6: Xử lý lỗi nếu xác nhận thanh toán thất bại
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Could not confirm the booking"));
    // Bước 7: Kết thúc xử lý, giải phóng cờ bận
    } finally {
      setBusy(false);
    }
  }

  // Sentences that wrap a live component: the translation carries a {placeholder}
  // and the component is dropped in between the two halves.
  const [heldBefore, heldAfter] = t(
    "Reception confirms it against the bank, usually the same day. We hold the slot for another {timer}; after that it goes back on the grid.",
  ).split("{timer}");
  const [keptBefore, keptAfter] = t("It is also kept in {link}.").split("{link}");

  // How many courts the member already has on the day on screen: said before they tap, not after.
  /**
   * Làm gì: Chuyển đổi mốc thời gian ISO sang chuỗi ngày YYYY-MM-DD theo múi giờ Việt Nam.
   * Được gọi ở: useCourtBooking -> hàm lọc onThisDay.
   * @param iso Chuỗi thời gian chuẩn ISO 8601.
   * @returns Chuỗi ngày định dạng YYYY-MM-DD.
   */
  const dayKey = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(iso));
  // Đếm số lượng sân hội viên đã giữ chỗ hoặc đã xác nhận trong ngày đang chọn để hiển thị cảnh báo
  const onThisDay = (mine ?? []).filter(
    (b) => (b.status === "confirmed" || b.status === "in_use" || b.status === "hold") && dayKey(b.start_at) === date,
  ).length;
  // Trả về toàn bộ trạng thái và các hàm nghiệp vụ phục vụ giao diện đặt sân
  return {
    limits, sports, date, setDate, sport, setSport, data, error, reload, hold, setHold, promoCode,
    setPromoCode, promoOpen, setPromoOpen, notices, overlap, setOverlap, avail, mine, myClasses,
    showAllClasses, setShowAllClasses, windowHours, showAllMine, setShowAllMine, mySubs, moving,
    setMoving, moveError, setMoveError, cancelId, setCancelId, taken, setTaken, busy, onlineOn,
    venue, receipt, setReceipt, pending, setPending, bank, bankOn, transferOpen, setTransferOpen,
    load, moveTo, startMove, holdSlot, confirmPay, heldBefore, heldAfter, keptBefore, keptAfter,
    onThisDay,
  };
}
