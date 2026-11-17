/**
 * Quản lý trạng thái và logic giao diện quản trị sân thể thao dành cho tài khoản Manager.
 * Tệp này cung cấp hook useManagerCourts và cấu hình STATUS_OPTS, phục vụ trang /manager/courts
 * trong việc xem danh sách sân, lọc, tạo mới, chỉnh sửa, đổi trạng thái, ngưng hoạt động (retire) và khôi phục sân.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSports } from "@/client/components/sports-ui";
import { ApiClientError, apiPatch, apiPost } from "@/client/arena3/client";
import { t, tk, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";


type ManagerCourt = {
  id: string;
  court_code: string;
  sport: string;
  status: string;
  display_name: string | null;
  sort_order: number | null;
  retired_at: string | null;
  upcoming_bookings: number;
  active_classes: number;
  has_custom_price: boolean;
};


type AffectedItem = {
  kind: string;
  start_at: string;
  end_at: string;
  description: string;
};


/**
 * Làm gì: Định nghĩa danh sách các trạng thái vận hành của sân kèm nhãn hiển thị và màu sắc giao diện (tone).
 * Được gọi ở: src/routes/manager.courts.tsx trong bộ nút chuyển nhanh trạng thái (Status switcher).
 * @returns Mảng các đối tượng chứa mã trạng thái (value), nhãn đa ngôn ngữ (label) và sắc thái màu badge (tone).
 */
const STATUS_OPTS = [
  { value: "ready", label: tk("Open"), tone: "accent" as const },
  { value: "maintenance", label: tk("Maintenance"), tone: "hold" as const },
  { value: "closed", label: tk("Closed"), tone: "danger" as const },
];

/**
 * Làm gì: Quản lý toàn bộ dữ liệu, bộ lọc, phân trang và các thao tác nghiệp vụ trên danh sách sân của Manager.
 *   Bao gồm: tải dữ liệu, tự động sinh mã sân tiếp theo, thêm/sửa sân, chuyển đổi trạng thái (ready, maintenance, closed),
 *   ngưng hoạt động sân (retire có kiểm tra xung đột đặt sân/lớp học), và khôi phục sân đã ngưng hoạt động.
 * Được gọi ở: src/routes/manager.courts.tsx trong component Page (/manager/courts).
 * @returns Đối tượng chứa dữ liệu danh sách sân, bộ lọc, trạng thái các modal/dialog và các hàm xử lý sự kiện (handlers).
 */
export function useManagerCourts() {
  // Bước 1: Khởi tạo truy vấn dữ liệu từ API /manager/courts và các state lưu trữ bộ lọc, phân trang
  const read = useRead<{ items: ManagerCourt[] }>("/manager/courts");
  const [items, setItems] = useState<ManagerCourt[] | null>(null);
  const [sport, setSport] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const pageSize = 25;

  const { sports } = useSports();
  // Dialog states
  // Bước 2: Khai báo các state điều khiển modal/form thêm mới, chỉnh sửa và ngưng hoạt động sân
  const [creating, setCreating] = useState(false);
  const [createSport, setCreateSport] = useState("");
  // Tự động gán môn thể thao mặc định là môn đầu tiên trong danh sách khi mở form tạo mới
  useEffect(() => {
    if (!createSport && sports.length > 0) {
      setCreateSport(sports[0].code);
    }
  }, [createSport, sports]);
  const [createCode, setCreateCode] = useState("");
  const [createName, setCreateName] = useState("");
  const [createSortOrder, setCreateSortOrder] = useState("");
  const [createSubmitting, setCreateSubmitting] = useState(false);

  const [editing, setEditing] = useState<ManagerCourt | null>(null);
  const [editCode, setEditCode] = useState("");
  const [editName, setEditName] = useState("");
  const [editSortOrder, setEditSortOrder] = useState("");
  const [editSport, setEditSport] = useState("");
  const [editSubmitting, setEditSubmitting] = useState(false);

  const [retiring, setRetiring] = useState<ManagerCourt | null>(null);
  const [retireSubmitting, setRetireSubmitting] = useState(false);
  const [blockedRetire, setBlockedRetire] = useState<{
    court: ManagerCourt;
    message: string;
    affected: AffectedItem[];
  } | null>(null);

  const [actionBusy, setActionBusy] = useState<string | null>(null);

  // Cập nhật danh sách sân vào state cục bộ khi API trả về dữ liệu mới
  useEffect(() => {
    if (read.data) setItems(read.data.items);
  }, [read.data]);

  // Compute summary stats
  // Bước 3: Tính toán các số liệu thống kê tổng quan (đang hoạt động, bảo trì, đã ngưng hoạt động, tổng số sân)
  const total = items ? items.length : 0;
  const readyCount = items ? items.filter((c) => !c.retired_at && c.status === "ready").length : 0;
  const maintCount = items ? items.filter((c) => !c.retired_at && c.status === "maintenance").length : 0;
  const retiredCount = items ? items.filter((c) => c.retired_at).length : 0;

  // Next court code suggestion for create dialog
  // Bước 4: Tự động gợi ý mã sân tiếp theo (ví dụ: BD-01, TN-02) dựa trên tiền tố của môn thể thao và các số thứ tự chưa dùng
  useEffect(() => {
    if (!creating || !items) return;
    const sportObj = sports.find((s) => s.code === createSport);
    const prefix = sportObj?.court_prefix ? `${sportObj.court_prefix}-` : "CT-";
    const used = new Set<number>();
    for (const c of items) {
      if (c.court_code.startsWith(prefix)) {
        const m = /^[A-Z]{2}-(\d+)$/.exec(c.court_code);
        if (m && m[1]) used.add(parseInt(m[1], 10));
      }
    }
    let n = 1;
    while (used.has(n)) n++;
    setCreateCode(`${prefix}${String(n).padStart(2, "0")}`);
  }, [creating, createSport, items]);

  // Bước 5: Lọc danh sách sân theo môn thể thao đã chọn và trạng thái (active, retired, ready, maintenance, closed)
  const filtered = useMemo(() => {
    if (!items) return [];
    return items.filter((c) => {
      if (sport && c.sport !== sport) return false;
      if (statusFilter === "retired" && !c.retired_at) return false;
      if (statusFilter === "active" && c.retired_at) return false;
      if (statusFilter === "ready" && (c.retired_at || c.status !== "ready")) return false;
      if (statusFilter === "maintenance" && (c.retired_at || c.status !== "maintenance")) return false;
      if (statusFilter === "closed" && (c.retired_at || c.status !== "closed")) return false;
      return true;
    });
  }, [items, sport, statusFilter]);

  // Bước 6: Phân trang danh sách đã lọc (mỗi trang tối đa 25 sân)
  const pagedItems = filtered.slice(offset, offset + pageSize);

  /**
   * Làm gì: Xử lý submit form tạo mới sân thể thao, gửi dữ liệu lên server và cập nhật lại giao diện.
   * Được gọi ở: src/routes/manager.courts.tsx trong sự kiện onSubmit của form tạo sân (Modal "Add court").
   * @param e Sự kiện submit form React (React.FormEvent).
   * @returns Không trả về giá trị (Promise<void>).
   * @throws Bắt lỗi API nội bộ, hiển thị toast thông báo lỗi từ server hoặc lỗi mặc định.
   */
  async function handleCreate(e: React.FormEvent) {
    // Bước 1: Ngăn hành vi reload mặc định của trình duyệt và bật trạng thái đang gửi dữ liệu (loading)
    e.preventDefault();
    setCreateSubmitting(true);
    try {
      // Bước 2: Gọi API POST /manager/courts để tạo mới bản ghi sân trong cơ sở dữ liệu
      const res = await apiPost<{ court: ManagerCourt }>("/manager/courts", {
        sport: createSport,
        court_code: createCode.trim() || undefined,
        display_name: createName.trim() || undefined,
        sort_order: createSortOrder ? Number(createSortOrder) : undefined,
      });
      // Bước 3: Thông báo thành công, đóng modal, đặt lại form và thêm sân mới vào danh sách hiển thị
      toast.success(t("Court created"));
      setCreating(false);
      setCreateName("");
      setCreateSortOrder("");
      setItems((prev) => (prev ? [...prev, res.court] : [res.court]));
      void read.reload();
    // Bước 4: Xử lý ngoại lệ nếu server từ chối (trùng mã sân, dữ liệu không hợp lệ...) và tắt trạng thái submitting
    } catch (err) {
      toast.error(err instanceof Error ? tServer(err.message) : t("Something went wrong"));
    } finally {
      setCreateSubmitting(false);
    }
  }

  /**
   * Làm gì: Chuẩn bị dữ liệu và mở modal chỉnh sửa thông tin sân thể thao.
   * Được gọi ở: src/routes/manager.courts.tsx khi người dùng nhấn nút "Edit" trên một dòng sân.
   * @param c Bản ghi sân cần chỉnh sửa (ManagerCourt).
   * @returns Không trả về giá trị.
   */
  function startEdit(c: ManagerCourt) {
    // Điền trước thông tin hiện tại của sân vào các state tương ứng của modal chỉnh sửa
    setEditing(c);
    setEditCode(c.court_code);
    setEditName(c.display_name ?? "");
    setEditSortOrder(c.sort_order != null ? String(c.sort_order) : "");
    setEditSport(c.sport);
  }

  /**
   * Làm gì: Xử lý submit form cập nhật thông tin sân (mã sân, tên hiển thị, thứ tự sắp xếp, môn thể thao).
   * Được gọi ở: src/routes/manager.courts.tsx trong sự kiện onSubmit của form chỉnh sửa sân (Modal "Edit court").
   * @param e Sự kiện submit form React (React.FormEvent).
   * @returns Không trả về giá trị (Promise<void>).
   * @throws Bắt lỗi API nội bộ, hiển thị thông báo lỗi từ server qua toast.
   */
  async function handleEdit(e: React.FormEvent) {
    // Bước 1: Ngăn reload trang và kiểm tra xem có sân nào đang được chọn chỉnh sửa không
    e.preventDefault();
    if (!editing) return;
    setEditSubmitting(true);
    try {
      // Bước 2: Gửi yêu cầu PATCH /courts/:id để cập nhật thông tin sân trong cơ sở dữ liệu
      const res = await apiPatch<{ court: ManagerCourt; upcoming: number }>(`/courts/${editing.id}`, {
        court_code: editCode.trim(),
        display_name: editName.trim() || null,
        sort_order: editSortOrder ? Number(editSortOrder) : null,
        sport: editSport,
      });
      // Bước 3: Đóng modal, hiển thị thông báo thành công và cập nhật lại bản ghi sân trong danh sách local
      toast.success(t("Court updated"));
      setEditing(null);
      setItems((prev) => (prev ? prev.map((c) => (c.id === editing.id ? { ...c, ...res.court } : c)) : null));
      void read.reload();
    // Bước 4: Xử lý lỗi nếu xảy ra sự cố và tắt cờ đang submit
    } catch (err) {
      toast.error(err instanceof Error ? tServer(err.message) : t("Something went wrong"));
    } finally {
      setEditSubmitting(false);
    }
  }

  /**
   * Làm gì: Chuyển đổi nhanh trạng thái vận hành của sân giữa ready (sẵn sàng), maintenance (bảo trì) hoặc closed (đóng cửa).
   * Được gọi ở: src/routes/manager.courts.tsx khi người dùng nhấn chọn nút trạng thái mới trong nhóm nút status switcher.
   * @param court Bản ghi sân cần đổi trạng thái (ManagerCourt).
   * @param newStatus Mã trạng thái mới cần áp dụng ("ready" | "maintenance" | "closed").
   * @returns Không trả về giá trị (Promise<void>).
   * @throws Bắt lỗi API nội bộ, hiển thị thông báo lỗi khi không thể cập nhật trạng thái.
   */
  async function handleStatusChange(court: ManagerCourt, newStatus: string) {
    // Bước 1: Bỏ qua nếu trạng thái không đổi hoặc đang có một thao tác khác đang được xử lý trên sân này
    if (court.status === newStatus || actionBusy) return;
    setActionBusy(court.id);
    try {
      // Bước 2: Gọi API PATCH /courts/:id để cập nhật trạng thái mới của sân
      const res = await apiPatch<{ court: ManagerCourt; upcoming: number }>(`/courts/${court.id}`, {
        status: newStatus,
      });
      // Bước 3: Cập nhật trạng thái trực tiếp vào state local để giao diện phản hồi tức thì và đồng bộ lại qua read.reload()
      toast.success(t("{code} → {label}", { code: court.court_code, label: t(newStatus) }));
      setItems((prev) => (prev ? prev.map((c) => (c.id === court.id ? { ...c, status: res.court.status } : c)) : null));
      void read.reload();
    // Bước 4: Bắt lỗi nếu server từ chối và giải phóng khóa actionBusy
    } catch (err) {
      toast.error(err instanceof Error ? tServer(err.message) : t("Cannot change court status"));
    } finally {
      setActionBusy(null);
    }
  }

  /**
   * Làm gì: Ngưng hoạt động (retire) một sân thể thao; xử lý xung đột 409 nếu sân còn lịch đặt chỗ hoặc lớp học sắp tới.
   * Được gọi ở: src/routes/manager.courts.tsx khi người dùng xác nhận "Retire court" trong modal xác nhận ngưng hoạt động.
   * @param court Bản ghi sân cần ngưng hoạt động (ManagerCourt).
   * @returns Không trả về giá trị (Promise<void>).
   * @throws Bắt lỗi API nội bộ: nếu lỗi 409 (Conflict) thì mở modal hiển thị danh sách xung đột; các lỗi khác hiển thị toast.
   */
  async function handleRetire(court: ManagerCourt) {
    // Bước 1: Bật trạng thái đang xử lý retireSubmitting
    setRetireSubmitting(true);
    try {
      // Bước 2: Gửi yêu cầu POST /manager/courts/:id/retire tới server để ngưng hoạt động sân
      const res = await apiPost<{ ok: boolean; court: ManagerCourt }>(`/manager/courts/${court.id}/retire`, {});
      // Bước 3: Đóng modal xác nhận, thông báo thành công và cập nhật lại trạng thái sân đã retire
      toast.success(t("Court retired"));
      setRetiring(null);
      setItems((prev) => (prev ? prev.map((c) => (c.id === court.id ? { ...c, ...res.court } : c)) : null));
      void read.reload();
    } catch (err) {
      setRetiring(null);
      // Bước 4: Nếu gặp lỗi 409 (xung đột do có booking hoặc lớp học tương lai), hiển thị dialog cảnh báo blockedRetire kèm danh sách chi tiết
      if (err instanceof ApiClientError && err.status === 409) {
        const body = err.body as { message?: string; affected?: AffectedItem[]; extra?: { affected?: AffectedItem[] } };
        setBlockedRetire({
          court,
          message: err.message,
          affected: body.affected ?? body.extra?.affected ?? [],
        });
      } else {
        toast.error(err instanceof Error ? tServer(err.message) : t("Something went wrong"));
      }
    } finally {
      setRetireSubmitting(false);
    }
  }

  /**
   * Làm gì: Khôi phục một sân đã ngưng hoạt động (retired) trở lại trạng thái sẵn sàng sử dụng (ready).
   * Được gọi ở: src/routes/manager.courts.tsx khi người dùng chọn hành động "Restore court" trong menu của sân đã retire.
   * @param court Bản ghi sân cần khôi phục (ManagerCourt).
   * @returns Không trả về giá trị (Promise<void>).
   * @throws Bắt lỗi API nội bộ, hiển thị thông báo lỗi qua toast nếu thao tác thất bại.
   */
  async function handleRestore(court: ManagerCourt) {
    // Bước 1: Khóa tương tác của sân để tránh người dùng nhấn nút nhiều lần liên tiếp
    setActionBusy(court.id);
    try {
      // Bước 2: Gửi yêu cầu POST /manager/courts/:id/restore để khôi phục trạng thái sân thành ready
      const res = await apiPost<{ ok: boolean; court: ManagerCourt }>(`/manager/courts/${court.id}/restore`, {});
      // Bước 3: Thông báo thành công và đồng bộ lại danh sách sân cả ở state local và cache server
      toast.success(t("Court restored"));
      setItems((prev) => (prev ? prev.map((c) => (c.id === court.id ? { ...c, ...res.court } : c)) : null));
      void read.reload();
    // Bước 4: Xử lý ngoại lệ nếu có lỗi và giải phóng trạng thái bận actionBusy
    } catch (err) {
      toast.error(err instanceof Error ? tServer(err.message) : t("Something went wrong"));
    } finally {
      setActionBusy(null);
    }
  }

  // Chuẩn bị dữ liệu hiển thị cho dải thống kê tóm tắt ở đầu trang (StatStrip)
  const statItems = [
    { label: t("Courts in service"), value: readyCount },
    { label: t("Maintenance"), value: maintCount },
    { label: t("Retired"), value: retiredCount },
    { label: t("Total courts"), value: total },
  ];
  // Trả về toàn bộ state và các hàm điều khiển cho component Page sử dụng
  return {
    read, items, sport, setSport, statusFilter, setStatusFilter, offset, setOffset, pageSize,
    sports, creating, setCreating, createSport, setCreateSport, createCode, setCreateCode,
    createName, setCreateName, createSortOrder, setCreateSortOrder, createSubmitting, editing,
    setEditing, editCode, setEditCode, editName, setEditName, editSortOrder, setEditSortOrder,
    editSport, setEditSport, editSubmitting, retiring, setRetiring, retireSubmitting,
    blockedRetire, setBlockedRetire, actionBusy, total, filtered, pagedItems, handleCreate,
    startEdit, handleEdit, handleStatusChange, handleRetire, handleRestore, statItems,
  };
}

export { STATUS_OPTS };
