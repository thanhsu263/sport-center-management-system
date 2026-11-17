/**
 * File: src/client/lib/pages/manager.sports.ts
 * Vai trò: Cung cấp hook useManagerSports quản lý toàn bộ trạng thái, lọc tìm kiếm và các thao tác CRUD môn thể thao cho quản lý trung tâm.
 * Vị trí trong app: Phục vụ trực tiếp trang Quản lý môn thể thao (/manager/sports tại src/routes/manager.sports.tsx), kết nối với các API /v1/manager/sports và /v1/manager/site-assets.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { invalidateSportsCache } from "@/client/components/sports-ui";
import { useRefreshAssets } from "@/client/components/media";
import { apiDelete, apiPatch, apiPost } from "@/client/arena3/client";
import { t, tk, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";

/**
 * Kiểu dữ liệu đại diện cho một môn thể thao trong hệ thống quản lý trung tâm.
 * Bao gồm thông tin cơ bản (mã môn, tên tiếng Anh/Việt, tiền tố mã sân, màu sắc, biểu tượng),
 * cấu hình vận hành (số người chơi tối đa, thời lượng slot, thứ tự sắp xếp), trạng thái kích hoạt,
 * và các chỉ số thống kê (số sân đang mở, số lượt đặt trước và số lớp học sắp diễn ra).
 */
type ManagerSport = {
  code: string;
  name_en: string;
  name_vi: string;
  court_prefix: string | null;
  color_key: string;
  glyph_key: string;
  is_scope_all: boolean;
  max_players: number;
  slot_duration_min: number;
  sort_order: number;
  enabled: boolean;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
  active_courts_count: number;
  future_bookings_count: number;
  future_classes_count: number;
  photo_url: string;
};


/**
 * Làm gì: Danh sách 8 mã màu chủ đạo được hệ thống hỗ trợ để gán cho môn thể thao kèm nhãn hiển thị đa ngôn ngữ.
 * Được gọi ở: src/routes/manager.sports.tsx (bộ chọn màu sắc trong modal tạo và chỉnh sửa môn thể thao).
 */
const COLOR_KEYS = [
  { key: "leaf", label: tk("Leaf (Green)") },
  { key: "clay", label: tk("Clay (Terracotta)") },
  { key: "sun", label: tk("Sun (Amber)") },
  { key: "sky", label: tk("Sky (Blue)") },
  { key: "plum", label: tk("Plum (Purple)") },
  { key: "slate", label: tk("Slate (Grey)") },
  { key: "moss", label: tk("Moss (Olive)") },
  { key: "dune", label: tk("Dune (Sand)") },
] as const;


/**
 * Làm gì: Danh sách các biểu tượng thể thao (glyph) có sẵn để người quản lý lựa chọn đại diện cho môn thể thao.
 * Được gọi ở: src/routes/manager.sports.tsx (bộ chọn biểu tượng trong modal tạo và chỉnh sửa môn thể thao).
 */
const GLYPH_KEYS = [
  { key: "generic", label: tk("Generic Sport") },
  { key: "badminton", label: tk("Shuttlecock") },
  { key: "basketball", label: tk("Basketball") },
  { key: "volleyball", label: tk("Volleyball") },
] as const;


/**
 * Làm gì: Danh sách các định dạng MIME ảnh hợp lệ (JPEG, PNG, WebP) được phép tải lên làm ảnh đại diện môn thể thao.
 * Được gọi ở: src/client/lib/pages/manager.sports.ts (hàm photoProblem); src/routes/manager.sports.tsx (thuộc tính accept của thẻ input file).
 */
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];


/**
 * Làm gì: Tải tệp ảnh vào bộ nhớ trình duyệt thông qua Image DOM object để xác định kích thước chiều rộng và chiều cao thực tế.
 * Được gọi ở: src/client/lib/pages/manager.sports.ts (hàm photoProblem để kiểm tra kích thước tối thiểu và tối đa của ảnh).
 * @param file Tệp ảnh đối tượng File do người dùng chọn từ máy tính.
 * @returns Promise trả về đối tượng chứa chiều rộng (w) và chiều cao (h) tính theo pixel.
 * @throws Error('unreadable') nếu tệp không phải định dạng ảnh hợp lệ hoặc không thể giải mã hình ảnh.
 */
function imageSize(file: File): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    // Bước 1: Tạo Object URL tạm thời từ tệp File và khởi tạo đối tượng Image trong bộ nhớ
    const url = URL.createObjectURL(file);
    const img = new Image();
    // Bước 2: Khi ảnh tải xong, lấy kích thước thực (naturalWidth, naturalHeight) và giải phóng Object URL để tránh rò rỉ bộ nhớ
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    // Bước 3: Nếu ảnh bị lỗi không thể đọc hoặc giải mã, từ chối Promise với lỗi 'unreadable' và giải phóng URL tạm
    img.onerror = () => {
      reject(new Error("unreadable"));
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}


/** Why the server would turn this picture down, in the manager's language; null when it fits. */
async function photoProblem(file: File): Promise<string | null> {
  // Bước 1: Kiểm tra định dạng tệp (MIME type), chỉ chấp nhận ảnh định dạng JPEG, PNG hoặc WebP
  if (!PHOTO_TYPES.includes(file.type)) return t("Choose a JPEG, PNG or WebP picture.");
  // Bước 2: Giới hạn dung lượng tệp tối đa 2 MB (2 * 1024 * 1024 bytes) để tiết kiệm băng thông và dung lượng lưu trữ
  if (file.size > 2 * 1024 * 1024) return t("The photo must be 2 MB or smaller.");
  // Bước 3: Đọc kích thước pixel của ảnh; yêu cầu cạnh ngắn tối thiểu 400px và cạnh dài tối đa 4000px
  try {
    const { w, h } = await imageSize(file);
    if (Math.min(w, h) < 400 || Math.max(w, h) > 4000) {
      return t("The shorter side needs 400 px or more, the longer side 4000 px or less.");
    }
  } catch {
    return t("This file could not be read as a picture.");
  }
  // Bước 4: Tệp ảnh thỏa mãn toàn bộ tiêu chí hợp lệ, trả về null (không có vấn đề)
  return null;
}


/**
 * Làm gì: Đóng gói tệp ảnh môn thể thao vào đối tượng FormData với slot 'sport.{code}' và gửi request POST để lưu trữ ảnh đại diện.
 * Được gọi ở: src/client/lib/pages/manager.sports.ts (hàm handleCreate); src/routes/manager.sports.tsx (hàm pick trong component EditSportPhotoField).
 * @param code Mã định danh môn thể thao (ví dụ 'badminton', 'tennis') dùng làm tên vị trí slot ảnh.
 * @param file Đối tượng tệp File của hình ảnh được người dùng chọn tải lên.
 * @returns Promise kết quả phản hồi từ API /manager/site-assets/upload chứa thông tin URL ảnh và số phiên bản.
 */
function uploadSportPhoto(code: string, file: File) {
  // Bước 1: Tạo đối tượng FormData, gắn định danh vị trí tài nguyên (slot = sport.<code\>) và tệp ảnh được chọn
  const fd = new FormData();
  fd.append("slot", `sport.${code}`);
  fd.append("file", file);
  // Bước 2: Gửi yêu cầu tải ảnh lên endpoint /manager/site-assets/upload qua phương thức POST multipart/form-data
  return apiPost("/manager/site-assets/upload", fd);
}

/**
 * Làm gì: Custom hook quản lý toàn bộ trạng thái dữ liệu, bộ lọc tìm kiếm và các thao tác CRUD (tạo, sửa, ngưng hoạt động, khôi phục, xóa) môn thể thao cho trang quản lý.
 * Được gọi ở: src/routes/manager.sports.tsx (component Page tại route /manager/sports).
 * @returns Đối tượng chứa dữ liệu môn thể thao, danh sách đã lọc, các state của modal và các hàm xử lý sự kiện quản lý.
 */
export function useManagerSports() {
  const read = useRead<{ items: ManagerSport[] }>("/manager/sports");
  const refreshAssets = useRefreshAssets();
  const [items, setItems] = useState<ManagerSport[] | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "retired">("");

  // Create state
  const [creating, setCreating] = useState(false);
  const [createStep, setCreateStep] = useState<1 | 2>(1);
  const [cCode, setCCode] = useState("");
  const [cNameEn, setCNameEn] = useState("");
  const [cNameVi, setCNameVi] = useState("");
  const [cPrefix, setCPrefix] = useState("");
  const [cColor, setCColor] = useState("leaf");
  const [cGlyph, setCGlyph] = useState("generic");
  const [cMaxPlayers, setCMaxPlayers] = useState("4");
  const [cWeekdayPrice, setCWeekdayPrice] = useState("100000");
  const [cWeekdayPeak, setCWeekdayPeak] = useState("150000");
  const [cWeekendPrice, setCWeekendPrice] = useState("120000");
  const [cWeekendPeak, setCWeekendPeak] = useState("180000");
  const [cPhoto, setCPhoto] = useState<File | null>(null);
  const [cSubmitting, setCSubmitting] = useState(false);

  // Edit state
  const [editing, setEditing] = useState<ManagerSport | null>(null);
  const [eNameEn, setENameEn] = useState("");
  const [eNameVi, setENameVi] = useState("");
  const [ePrefix, setEPrefix] = useState("");
  const [eColor, setEColor] = useState("leaf");
  const [eGlyph, setEGlyph] = useState("generic");
  const [eSortOrder, setESortOrder] = useState("100");
  const [eEnabled, setEEnabled] = useState(true);
  const [eSubmitting, setESubmitting] = useState(false);

  // Retire / Delete confirmation states
  const [retiring, setRetiring] = useState<ManagerSport | null>(null);
  const [retireBlockers, setRetireBlockers] = useState<string[] | null>(null);
  const [retireSubmitting, setRetireSubmitting] = useState(false);

  const [deleting, setDeleting] = useState<ManagerSport | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  // Đồng bộ dữ liệu danh sách môn thể thao từ phản hồi API (read.data) vào local state items
  useEffect(() => {
    if (read.data?.items) {
      setItems(read.data.items);
    }
  }, [read.data]);

  const allList = items ?? [];
  // Lọc bỏ môn thể thao ảo có phạm vi toàn bộ (is_scope_all), chỉ giữ lại các môn thể thao thực tế có sân thi đấu
  const playableList = allList.filter((s) => !s.is_scope_all);

  // Lọc danh sách môn thể thao theo bộ lọc trạng thái (đang hoạt động / đã ngưng) và từ khóa tìm kiếm (mã môn, tên Anh/Việt, tiền tố sân)
  const filtered = playableList.filter((s) => {
    if (statusFilter === "active" && (!s.enabled || s.retired_at)) return false;
    if (statusFilter === "retired" && !s.retired_at) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      s.code.toLowerCase().includes(q) ||
      s.name_en.toLowerCase().includes(q) ||
      s.name_vi.toLowerCase().includes(q) ||
      (s.court_prefix && s.court_prefix.toLowerCase().includes(q))
    );
  });

  // Tổng hợp số liệu thống kê hiển thị trên hero banner: tổng số sân đang hoạt động và số môn thể thao đang mở
  const totalCourts = playableList.reduce((acc, s) => acc + (s.active_courts_count || 0), 0);
  const activeSports = playableList.filter((s) => s.enabled && !s.retired_at).length;

  /**
   * Làm gì: Đặt lại toàn bộ giá trị form tạo mới về mặc định ban đầu và mở modal tạo môn thể thao ở bước 1.
   * Được gọi ở: src/routes/manager.sports.tsx (nút 'Add sport' trên thanh công cụ và nút trong trạng thái rỗng EmptyState).
   */
  function openCreate() {
    // Bước 1: Khởi tạo lại các trường thông tin cơ bản, màu sắc (leaf), biểu tượng (generic) và mức giá đề xuất mặc định
    setCCode("");
    setCNameEn("");
    setCNameVi("");
    setCPrefix("");
    setCColor("leaf");
    setCGlyph("generic");
    setCMaxPlayers("4");
    setCWeekdayPrice("100000");
    setCWeekdayPeak("150000");
    setCWeekendPrice("120000");
    setCWeekendPeak("180000");
    setCPhoto(null);
    // Bước 2: Đặt bước tạo về bước 1 và mở modal tạo môn thể thao (setCreating = true)
    setCreateStep(1);
    setCreating(true);
  }

  /**
   * Làm gì: Nạp thông tin hiện tại của môn thể thao được chọn vào các state của form chỉnh sửa và mở modal cập nhật.
   * Được gọi ở: src/routes/manager.sports.tsx (khi quản lý nhấp vào một thẻ hoặc hàng môn thể thao trong danh sách).
   * @param sport Đối tượng môn thể thao được chọn để chỉnh sửa.
   */
  function openEdit(sport: ManagerSport) {
    // Lưu môn thể thao đang chọn và nạp các thuộc tính (tên, tiền tố sân, màu, biểu tượng, thứ tự hiển thị, trạng thái bật/tắt) vào form
    setEditing(sport);
    setENameEn(sport.name_en);
    setENameVi(sport.name_vi);
    setEPrefix(sport.court_prefix ?? "");
    setEColor(sport.color_key);
    setEGlyph(sport.glyph_key);
    setESortOrder(String(sport.sort_order));
    setEEnabled(sport.enabled);
  }

  /**
   * Làm gì: Gửi yêu cầu tạo môn thể thao mới lên API kèm bảng giá mặc định, tải ảnh đại diện lên slot nếu có, xóa cache và tải lại danh sách.
   * Được gọi ở: src/routes/manager.sports.tsx (nút 'Create sport' tại bước 2 của modal tạo môn thể thao).
   * @returns Promise<void>
   */
  async function handleCreate() {
    // Bước 1: Bật cờ cSubmitting để vô hiệu hóa nút bấm, ngăn chặn người dùng gửi yêu cầu nhiều lần liên tiếp
    setCSubmitting(true);
    try {
      // Bước 2: Chuẩn hóa dữ liệu (mã môn chữ thường, tiền tố sân chữ hoa) và gửi yêu cầu tạo môn qua POST /manager/sports
      const res = await apiPost<{ ok: boolean; sport: ManagerSport }>("/manager/sports", {
        code: cCode.trim().toLowerCase(),
        name_en: cNameEn.trim(),
        name_vi: cNameVi.trim(),
        court_prefix: cPrefix.trim().toUpperCase(),
        color_key: cColor,
        glyph_key: cGlyph,
        max_players: Number(cMaxPlayers) || 4,
        weekday_price_vnd: Number(cWeekdayPrice) || 100000,
        weekday_peak_price_vnd: Number(cWeekdayPeak) || 150000,
        weekend_price_vnd: Number(cWeekendPrice) || 120000,
        weekend_peak_price_vnd: Number(cWeekendPeak) || 180000,
      });
      // Bước 3: Thông báo tạo môn thể thao thành công đến người quản lý
      toast.success(t("Sport {name} created", { name: res.sport.name_en }));
      // Bước 4: Nếu có chọn ảnh đại diện, tải ảnh lên vị trí slot 'sport.<code\>' và làm mới cache tài nguyên media
      if (cPhoto) {
        try {
          await uploadSportPhoto(res.sport.code, cPhoto);
          await refreshAssets();
        } catch (e) {
          toast.error(t("The sport was saved without its photo: {reason}", { reason: tServer((e as Error).message) }));
        }
      }
      // Bước 5: Xóa bộ nhớ đệm môn thể thao (invalidateSportsCache), đóng modal tạo và tải lại danh sách mới nhất từ server
      invalidateSportsCache();
      setCreating(false);
      read.reload();
    } catch (e) {
      // Bước 6: Nếu server trả về lỗi (trùng mã môn, trùng tiền tố sân...), hiển thị thông báo lỗi đã được dịch
      toast.error(tServer((e as Error).message));
    } finally {
      setCSubmitting(false);
    // Bước 7: Luôn mở khóa trạng thái cSubmitting sau khi hoàn tất tác vụ
    }
  }

  /**
   * Làm gì: Gửi dữ liệu cập nhật môn thể thao (tên, tiền tố sân, màu, biểu tượng, thứ tự sắp xếp, trạng thái) qua API PATCH, xóa cache và làm mới danh sách.
   * Được gọi ở: src/routes/manager.sports.tsx (nút 'Save changes' trong modal chỉnh sửa môn thể thao).
   * @returns Promise<void>
   */
  async function handleEdit() {
    // Bước 1: Kiểm tra môn thể thao đang được chỉnh sửa; nếu không có thì dừng xử lý
    if (!editing) return;
    // Bước 2: Bật cờ eSubmitting để khóa form, tránh gửi trùng lặp
    setESubmitting(true);
    try {
      // Bước 3: Gửi dữ liệu cập nhật đã chuẩn hóa đến API PATCH /manager/sports/:code
      await apiPatch<{ ok: boolean; sport: ManagerSport }>(`/manager/sports/${editing.code}`, {
        name_en: eNameEn.trim(),
        name_vi: eNameVi.trim(),
        court_prefix: ePrefix.trim().toUpperCase() || undefined,
        color_key: eColor,
        glyph_key: eGlyph,
        sort_order: Number(eSortOrder) || 100,
        enabled: eEnabled,
      });
      // Bước 4: Thông báo thành công, xóa cache môn thể thao client-side, đóng modal sửa và tải lại danh sách
      toast.success(t("Sport updated"));
      invalidateSportsCache();
      setEditing(null);
      read.reload();
    } catch (e) {
      // Bước 5: Bắt lỗi từ server và hiển thị thông báo lỗi qua toast
      toast.error(tServer((e as Error).message));
    } finally {
      setESubmitting(false);
    // Bước 6: Luôn mở khóa cờ eSubmitting sau khi kết thúc yêu cầu
    }
  }

  /**
   * Làm gì: Gửi yêu cầu chuyển môn thể thao sang trạng thái ngưng hoạt động (retire); nếu có ràng buộc (sân đang mở, lịch đặt tương lai), hiển thị danh sách lý do cản trở.
   * Được gọi ở: src/routes/manager.sports.tsx (nút xác nhận 'Retire sport' trong modal ngưng hoạt động).
   * @param sport Môn thể thao cần ngưng hoạt động.
   * @returns Promise<void>
   */
  async function handleRetire(sport: ManagerSport) {
    // Bước 1: Đặt trạng thái đang xử lý retireSubmitting và xóa sạch danh sách lý do cản trở từ lần thử trước
    setRetireSubmitting(true);
    setRetireBlockers(null);
    try {
      // Bước 2: Gọi API POST /manager/sports/:code/retire để thực hiện ngưng hoạt động môn thể thao
      await apiPost(`/manager/sports/${sport.code}/retire`, {});
      // Bước 3: Thông báo thành công, xóa cache môn thể thao, đóng modal xác nhận và tải lại danh sách
      toast.success(t("Sport retired"));
      invalidateSportsCache();
      setRetiring(null);
      read.reload();
    } catch (e: any) {
      // Bước 4: Xử lý lỗi trả về; nếu mã 409 (xung đột do còn sân hoặc lịch tương lai), lưu danh sách reasons để hiển thị cho quản lý
      if (e.status === 409 && e.body?.reasons) {
        setRetireBlockers(e.body.reasons);
      } else {
        toast.error(tServer(e.message));
        setRetiring(null);
      }
    } finally {
      // Bước 5: Luôn khôi phục cờ retireSubmitting về false khi kết thúc quá trình xử lý
      setRetireSubmitting(false);
    }
  }

  /**
   * Làm gì: Khôi phục một môn thể thao đã bị ngưng hoạt động trở lại trạng thái hoạt động bình thường, xóa cache và cập nhật lại danh sách.
   * Được gọi ở: src/routes/manager.sports.tsx (nút 'Restore' cạnh môn thể thao đã ngưng hoạt động trong danh sách).
   * @param sport Môn thể thao cần khôi phục hoạt động.
   * @returns Promise<void>
   */
  async function handleRestore(sport: ManagerSport) {
    try {
      // Bước 1: Gọi API POST /manager/sports/:code/restore để khôi phục trạng thái hoạt động của môn thể thao
      await apiPost(`/manager/sports/${sport.code}/restore`, {});
      // Bước 2: Thông báo khôi phục thành công, xóa bộ nhớ đệm cache client và tải lại dữ liệu từ server
      toast.success(t("Sport restored"));
      invalidateSportsCache();
      read.reload();
    } catch (e) {
      // Bước 3: Bắt lỗi nếu khôi phục thất bại và hiển thị thông báo lỗi
      toast.error(tServer((e as Error).message));
    }
  }

  /**
   * Làm gì: Gửi yêu cầu xóa vĩnh viễn môn thể thao khỏi cơ sở dữ liệu (chỉ thành công khi môn chưa từng có sân, lịch đặt hoặc lớp học), xóa cache và tải lại danh sách.
   * Được gọi ở: src/routes/manager.sports.tsx (nút xác nhận 'Delete sport' trong modal xóa môn thể thao).
   * @param sport Môn thể thao cần xóa vĩnh viễn.
   * @returns Promise<void>
   */
  async function handleDelete(sport: ManagerSport) {
    // Bước 1: Bật cờ deleteSubmitting để vô hiệu hóa nút xóa, ngăn bấm đúp
    setDeleteSubmitting(true);
    try {
      // Bước 2: Gửi yêu cầu DELETE /manager/sports/:code để xóa môn thể thao
      await apiDelete(`/manager/sports/${sport.code}`);
      // Bước 3: Thông báo xóa thành công, xóa cache môn thể thao client-side, đóng modal xác nhận và reload trang
      toast.success(t("Sport deleted"));
      invalidateSportsCache();
      setDeleting(null);
      read.reload();
    } catch (e) {
      // Bước 4: Hiển thị thông báo lỗi nếu server từ chối xóa (ví dụ do vi phạm khóa ngoại hoặc còn dữ liệu liên kết)
      toast.error(tServer((e as Error).message));
    } finally {
      setDeleteSubmitting(false);
    // Bước 5: Luôn đặt lại cờ deleteSubmitting về false sau khi hoàn tất
    }
  }
  // Trả về toàn bộ dữ liệu, cờ trạng thái form và các hàm xử lý hành động để component giao diện sử dụng
  return {
    read, items, query, setQuery, statusFilter, setStatusFilter, creating, setCreating, createStep,
    setCreateStep, cCode, setCCode, cNameEn, setCNameEn, cNameVi, setCNameVi, cPrefix, setCPrefix,
    cColor, setCColor, cGlyph, setCGlyph, cMaxPlayers, setCMaxPlayers, cWeekdayPrice,
    setCWeekdayPrice, cWeekdayPeak, setCWeekdayPeak, cWeekendPrice, setCWeekendPrice, cWeekendPeak,
    setCWeekendPeak, cPhoto, setCPhoto, cSubmitting, editing, setEditing, eNameEn, setENameEn,
    eNameVi, setENameVi, ePrefix, setEPrefix, eColor, setEColor, eGlyph, setEGlyph, eSortOrder,
    setESortOrder, eEnabled, setEEnabled, eSubmitting, retiring, setRetiring, retireBlockers,
    retireSubmitting, deleting, setDeleting, deleteSubmitting, playableList, filtered, totalCourts,
    activeSports, openCreate, openEdit, handleCreate, handleEdit, handleRetire, handleRestore,
    handleDelete,
  };
}

// Tái xuất các kiểu dữ liệu, danh sách hằng số và hàm tiện ích xử lý ảnh để các component trang quản lý sử dụng
export { type ManagerSport, COLOR_KEYS, GLYPH_KEYS, PHOTO_TYPES, photoProblem, uploadSportPhoto };
