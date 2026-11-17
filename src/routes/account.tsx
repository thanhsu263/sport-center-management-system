/**
 * Giao diện và định tuyến trang cài đặt tài khoản (/account) trong hệ thống Arena 3.
 * Dành cho tất cả các vai trò đã đăng nhập: member, receptionist, coach, manager.
 * Quản lý thông tin cá nhân (Profile), bảo mật (Security), biên lai (Receipts) và hỗ trợ (Support).
 */
import { createFileRoute, useBlocker } from "@tanstack/react-router";
import { Check, Circle, Download, Eye, EyeOff, KeyRound, MonitorSmartphone, Receipt, UserRound } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Guard, Shell, money, useF6, useSessionUser, when } from "@/client/components/shell";
import { Badge, Button, Card, EmptyState, Field, Input, Label, LoadError, Pagination, Seg, Skeleton, Textarea } from "@/client/components/ui";
import { UserAvatar } from "@/client/components/user-avatar";
import { GoogleButton } from "@/client/components/google-sign-in";
import { Lift, Stagger, StaggerItem } from "@/client/components/motion";
import { SpotlightCard, StarBorder } from "@/client/components/fx";
import {
  ApiClientError,
  api,
  apiGet,
  apiPatch,
  apiPost,
  getStoredUser,
  homeFor,
  openInvoice,
  setStoredUser,
  type SessionUser,
} from "@/client/arena3/client";
import { formatDate, roleLabel, sportLabel } from "@/shared/arena3/labels";
import { usePageState } from "@/client/lib/use-page-state";
import { useRead } from "@/client/lib/use-read";
import { cn } from "@/client/lib/cn";
import { t, tk, tServer } from "@/client/lib/i18n";

/**
 * Làm gì: Khởi tạo định tuyến cho trang /account bằng TanStack Router, liên kết URL với component Page.
 * Được gọi ở: URL /account (TanStack Router tự động đăng ký và nạp route).
 * @returns Route cấu hình cho đường dẫn /account.
 */
export const Route = createFileRoute("/account")({ component: Page });

// Cấu trúc dữ liệu hồ sơ mở rộng của người dùng (người giám hộ, PII consent, thông tin HLV) trả về từ API /me/profile.
type MeProfile = {
  guardian: { name: string | null; phone: string | null } | null;
  pii_consent_at: string | null;
  coach: { sports: string[]; per_session_vnd: number; per_student_vnd: number } | null;
  other_sessions: number;
};

// Cấu trúc dữ liệu biên lai/hóa đơn thanh toán cá nhân của hội viên từ API /me/invoices.
type Invoice = {
  id: string;
  code: string;
  issued_at: string;
  payment_code: string;
  method: string;
  amount_vnd: number;
  status: string;
  ref_type: string;
};

// Bảng ánh xạ mã phương thức thanh toán (cash, transfer, card) sang nhãn đa ngôn ngữ hiển thị trên biên lai.
const METHOD: Record<string, string> = {
  cash: tk("Cash"),
  transfer: tk("Bank transfer"),
  card: tk("Card"),
};

// Bảng ánh xạ loại giao dịch (booking, subscription, enrollment, loan, walkin) sang nhãn đa ngôn ngữ tương ứng.
const REF: Record<string, string> = {
  booking: tk("Court booking"),
  subscription: tk("Membership"),
  enrollment: tk("Class"),
  loan: tk("Equipment"),
  walkin: tk("Walk-in"),
};

/**
 * Làm gì: Component trang quản lý tài khoản, kiểm tra quyền truy cập cho 4 vai trò qua Guard và điều hướng giữa các tab.
 * Được gọi ở: `src/routes/account.tsx` trong Route (dòng 29).
 * @returns JSX layout trang tài khoản với thanh chuyển tab và nội dung tương ứng.
 */
function Page() {
  // Bước 1: Lấy thông tin phiên người dùng và xác định tab mặc định.
  // Nếu tài khoản có cờ must_change_password (mật khẩu tạm), tự động mở tab "security" để buộc đổi mật khẩu.
  const user = useSessionUser();
  const [tab, setTab] = useState(() => (getStoredUser()?.must_change_password ? "security" : "profile"));

  // Bước 2: Hiển thị giao diện bọc trong Guard kiểm tra quyền và Shell bố cục chuẩn.
  // Tab "Receipts" chỉ hiển thị cho member vì nhân viên xem biên lai tại màn hình Payments của trung tâm.
  return (
    <Guard roles={["member", "receptionist", "coach", "manager"]}>
      <Shell
        role={user?.role ?? "member"}
        title={t("Account settings")}
        subtitle={
          user?.role === "member" || !user
            ? t("Your details, your password, your receipts, and anything you have asked us.")
            : t("Your details, your password, and anything you have asked us.")
        }
      >
        <div className="mb-5">
          <Seg
            value={tab}
            onChange={setTab}
            options={[
              { value: "profile", label: t("Profile") },
              { value: "security", label: t("Security") },
              // Staff take payments, they do not make them: their receipts are
              // the centre's, and live under Payments (D-04).
              ...(user?.role === "member" || !user ? [{ value: "receipts", label: t("Receipts") }] : []),
              { value: "support", label: t("Support") },
            ]}
          />
        </div>
        {tab === "profile" ? <Profile user={user} /> : null}
        {tab === "security" ? <Security forced={!!user?.must_change_password} /> : null}
        {tab === "receipts" ? <Receipts /> : null}
        {tab === "support" ? <Support /> : null}
      </Shell>
    </Guard>
  );
}

/**
 * Làm gì: Component quản lý ảnh đại diện, hỗ trợ chọn ảnh xem trước (tối đa 2 MB, định dạng hợp lệ), lưu qua API PUT /me/avatar hoặc xóa ảnh qua DELETE /me/avatar.
 * Được gọi ở: `src/routes/account.tsx` bên trong component Profile (dòng 362).
 * @param props.user Đối tượng SessionUser chứa thông tin avatar_url và full_name của người dùng hiện tại.
 * @returns JSX giao diện hiển thị ảnh đại diện và các nút đổi/xóa ảnh.
 */
function AvatarEditor({ user }: { user: SessionUser }) {
  // Bước 1: Khởi tạo các state quản lý tệp ảnh chọn, URL preview, trạng thái bận (busy), lỗi và xác nhận xóa ảnh.
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Dọn dẹp bộ nhớ: thu hồi Object URL khi previewUrl thay đổi hoặc khi component unmount để tránh rò rỉ bộ nhớ.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  /**
   * Làm gì: Xử lý khi người dùng chọn file ảnh từ máy; kiểm tra giới hạn dung lượng (<= 2 MB) và định dạng (JPEG, PNG, WebP), sau đó tạo preview URL.
   * Được gọi ở: `src/routes/account.tsx` trong sự kiện onChange của thẻ input file trong AvatarEditor (dòng 212).
   * @param e Sự kiện thay đổi của thẻ input file HTML (React.ChangeEvent<HTMLInputElement>).
   * @returns void
   */
  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    // Bước 1: Lấy file đầu tiên và reset giá trị input để có thể chọn lại cùng một file nếu cần.
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    // Bước 2: Thu hồi URL xem trước trước đó nếu đang có để tránh rò rỉ bộ nhớ.
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }

    // Bước 3: Kiểm tra dung lượng file (giới hạn tối đa 2 MB theo nghiệp vụ để tối ưu truyền tải).
    if (file.size > 2 * 1024 * 1024) {
      setError(t("The photo must be 2 MB or smaller."));
      setSelectedFile(null);
      setPreviewUrl(null);
      return;
    }

    // Bước 4: Kiểm tra định dạng file (chỉ cho phép JPEG, PNG hoặc WebP).
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.type)) {
      setError(t("Use a JPEG, PNG or WebP photo."));
      setSelectedFile(null);
      setPreviewUrl(null);
      return;
    }

    // Bước 5: File hợp lệ: xóa lỗi cũ, lưu file và tạo Object URL để hiển thị bản xem trước.
    setError(null);
    setConfirmRemove(false);
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
  }

  /**
   * Làm gì: Hủy bỏ ảnh xem trước tạm thời, thu hồi Object URL và khôi phục trạng thái ban đầu.
   * Được gọi ở: `src/routes/account.tsx` trong sự kiện onClick của nút Cancel khi preview ảnh (dòng 246).
   * @returns void
   */
  function cancelPreview() {
    // Thu hồi Object URL tạm thời để giải phóng bộ nhớ, sau đó reset previewUrl, selectedFile và error.
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setSelectedFile(null);
    setError(null);
  }

  /**
   * Làm gì: Gửi file ảnh đại diện lên server qua API PUT /me/avatar dưới dạng FormData, cập nhật thông tin người dùng trong phiên.
   * Được gọi ở: `src/routes/account.tsx` trong sự kiện onClick của nút Save photo trong AvatarEditor (dòng 243).
   * @returns Promise<void>
   * @throws Không ném lỗi ra ngoài; bắt lỗi từ API (ApiClientError hoặc Error) và lưu thông báo vào state error.
   */
  async function savePhoto() {
    // Bước 1: Kiểm tra file đã chọn, xóa lỗi cũ và bật trạng thái bận (busy).
    if (!selectedFile) return;
    setError(null);
    setBusy(true);
    try {
      // Bước 2: Đóng gói tệp ảnh vào FormData với trường "file" để gửi dạng multipart/form-data.
      const fd = new FormData();
      fd.append("file", selectedFile);
      // Bước 3: Gọi API PUT /me/avatar để tải ảnh đại diện lên server.
      const res = await api<{ user: SessionUser }>("/me/avatar", { method: "PUT", body: fd });
      // Bước 4: Cập nhật thông tin người dùng vào local storage, dọn dẹp previewUrl và hiển thị toast thành công.
      setStoredUser(res.user);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setSelectedFile(null);
      toast.success(t("Photo updated."));
    // Bước 5: Bắt lỗi nếu gọi API thất bại (trích xuất thông báo lỗi server qua tServer hoặc lỗi mạng) để hiển thị.
    } catch (e) {
      if (e instanceof ApiClientError && e.body?.message) {
        setError(tServer(e.body.message));
      } else if (e instanceof Error) {
        setError(e.message);
      } else {
        setError(t("Could not save your details"));
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * Làm gì: Gửi yêu cầu xóa ảnh đại diện lên server qua API DELETE /me/avatar, cập nhật phiên đăng nhập và đóng hộp xác nhận.
   * Được gọi ở: `src/routes/account.tsx` trong sự kiện onClick của nút Remove photo trong AvatarEditor (dòng 254).
   * @returns Promise<void>
   * @throws Không ném lỗi ra ngoài; bắt lỗi từ API và lưu vào state error.
   */
  async function doRemove() {
    // Bước 1: Xóa thông báo lỗi cũ và bật trạng thái bận (busy).
    setError(null);
    setBusy(true);
    // Bước 2: Gọi API DELETE /me/avatar để xóa ảnh đại diện trên hệ thống.
    try {
      const res = await api<{ user: SessionUser }>("/me/avatar", { method: "DELETE" });
      // Bước 3: Cập nhật lại thông tin phiên người dùng trong storage, đóng hộp thoại xác nhận và thông báo toast.
      setStoredUser(res.user);
      setConfirmRemove(false);
      toast.success(t("Photo removed."));
    // Bước 4: Xử lý và hiển thị thông báo nếu thao tác xóa ảnh thất bại.
    } catch (e) {
      if (e instanceof ApiClientError && e.body?.message) {
        setError(tServer(e.body.message));
      } else if (e instanceof Error) {
        setError(e.message);
      } else {
        setError(t("Could not save your details"));
      }
    } finally {
      setBusy(false);
    }
  }

  // Kiểm tra người dùng đã có avatar hay chưa để quyết định hiển thị nút "Remove photo".
  const hasAvatar = Boolean(user.avatar_url);

  return (
    <div className="mb-6 grid gap-3 border-b border-line pb-6">
      <div className="flex flex-col gap-1.5">
        <label className="sr-only">
          {t("Profile photo")}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            onChange={onFileChange}
          />
        </label>
        <div className="flex flex-wrap items-center gap-4">
          <div className="relative size-20 shrink-0 overflow-hidden rounded-full bg-accent text-accent-fg shadow-sm">
            {previewUrl ? (
              <img
                src={previewUrl}
                alt={user.full_name}
                className="size-full rounded-full object-cover"
              />
            ) : (
              <UserAvatar
                url={user.avatar_url}
                name={user.full_name}
                className="size-20 bg-accent text-xl font-bold"
                initialsClassName="text-xl font-bold tracking-wide text-accent-fg"
              />
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-display text-xl">{user.full_name}</span>
                <Badge tone="accent">{roleLabel(user.role)}</Badge>
              </div>
              <div className="truncate text-sm text-muted">{user.email ?? user.phone}</div>
            </div>
            {previewUrl ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" type="button" disabled={busy} onClick={savePhoto}>
                  {busy ? t("Saving…") : t("Save photo")}
                </Button>
                <Button size="sm" variant="outline" type="button" disabled={busy} onClick={cancelPreview}>
                  {t("Cancel")}
                </Button>
              </div>
            ) : confirmRemove ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">{t("Remove your photo?")}</span>
                <Button size="sm" variant="danger" type="button" disabled={busy} onClick={doRemove}>
                  {busy ? t("Removing…") : t("Remove photo")}
                </Button>
                <Button size="sm" variant="outline" type="button" disabled={busy} onClick={() => setConfirmRemove(false)}>
                  {t("Cancel")}
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" type="button" onClick={() => fileInputRef.current?.click()}>
                  {t("Change photo")}
                </Button>
                {hasAvatar ? (
                  <Button size="sm" variant="ghost" type="button" onClick={() => setConfirmRemove(true)}>
                    {t("Remove photo")}
                  </Button>
                ) : null}
              </div>
            )}
            <p className="text-xs text-muted">{t("JPEG, PNG or WebP, up to 2 MB.")}</p>
          </div>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Làm gì: Component hiển thị và chỉnh sửa hồ sơ người dùng (họ tên, ghi chú sức khỏe nếu là hội viên), tích hợp AvatarEditor và chặn điều hướng nếu có thay đổi chưa lưu.
 * Được gọi ở: `src/routes/account.tsx` trong component Page khi tab hiện tại là "profile" (dòng 92).
 * @param props.user Đối tượng SessionUser hoặc null khi chưa nạp xong phiên đăng nhập.
 * @returns JSX form hồ sơ người dùng hoặc Skeleton trong lúc chờ nạp dữ liệu.
 */
function Profile({ user }: { user: SessionUser | null }) {
  // Bước 1: Nạp thông tin hồ sơ mở rộng từ API /me/profile (người giám hộ, PII consent, thông tin HLV).
  const profileRead = useRead<MeProfile>("/me/profile");
  // Khởi tạo state cho dữ liệu form (họ tên, ghi chú sức khỏe), trạng thái đã lưu (saved), cờ đã nạp (loaded), trạng thái bận (busy) và lỗi theo trường (fieldErrors).
  const [form, setForm] = useState({ full_name: "", health_notes: "" });
  const [saved, setSaved] = useState({ full_name: "", health_notes: "" });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ full_name?: string; health_notes?: string }>({});

  // Quy tắc nghiệp vụ: Chỉ hội viên (member) mới có trường ghi chú sức khỏe (health_notes) để HLV nắm thông tin trước buổi tập.
  const isMember = user?.role === "member";
  // Kiểm tra dữ liệu form có thay đổi so với bản đã lưu hay không (dirty flag).
  const dirty =
    form.full_name.trim() !== saved.full_name.trim() ||
    (isMember && form.health_notes.trim() !== saved.health_notes.trim());

  // Chặn rời trang nếu có thay đổi chưa lưu: cảnh báo xác nhận khi chuyển trang nội bộ hoặc đóng/tải lại tab trình duyệt.
  useBlocker({
    shouldBlockFn: () => !busy && dirty && !window.confirm(t("You have unsaved changes. Leave without saving?")),
    enableBeforeUnload: () => dirty,
  });

  // Seed from the cached session the moment it arrives, then let /me correct it
  // Bước 2: Đồng bộ dữ liệu ban đầu từ session người dùng vào form state ngay khi có dữ liệu phiên đăng nhập.
  useEffect(() => {
    if (!user || loaded) return;
    const initial = { full_name: user.full_name, health_notes: user.health_notes ?? "" };
    setForm(initial);
    setSaved(initial);
    setLoaded(true);
  }, [user, loaded]);

  /**
   * Làm gì: Hủy bỏ các thay đổi chưa lưu trên form và khôi phục lại giá trị họ tên, ghi chú sức khỏe đã lưu gần nhất.
   * Được gọi ở: `src/routes/account.tsx` trong sự kiện onClick của nút Discard trong form Profile (dòng 437).
   * @returns void
   */
  function discard() {
    // Khôi phục form về giá trị saved và xóa toàn bộ thông báo lỗi trường nhập liệu.
    setForm(saved);
    setError(null);
    setFieldErrors({});
  }

  /**
   * Làm gì: Xử lý gửi form cập nhật thông tin cá nhân (họ tên, ghi chú sức khỏe nếu là hội viên) lên server qua API PATCH /me.
   * Được gọi ở: `src/routes/account.tsx` trong sự kiện onSubmit của thẻ form trong Profile (dòng 363).
   * @param e Sự kiện gửi form HTML (FormEvent).
   * @returns Promise<void>
   * @throws Không ném lỗi ra ngoài; phân loại lỗi từ API (gán lỗi riêng cho trường vi phạm hoặc hiển thị lỗi chung).
   */
  async function save(e: FormEvent) {
    // Bước 1: Ngăn chặn reload trang mặc định, xóa lỗi cũ và bật trạng thái bận (busy).
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setBusy(true);
    try {
      // Bước 2: Đóng gói payload cập nhật; chỉ đính kèm health_notes nếu người dùng có vai trò là hội viên.
      const payload: { full_name: string; health_notes?: string } = {
        full_name: form.full_name,
      };
      if (isMember) {
        payload.health_notes = form.health_notes;
      }
      // Bước 3: Gửi yêu cầu cập nhật hồ sơ cá nhân qua API PATCH /me.
      const res = await apiPatch<{ user: SessionUser }>("/me", payload);
      // Bước 4: Lưu thông tin người dùng mới vào local storage, đồng bộ form state với bản đã lưu để tắt cờ dirty và hiển thị toast.
      setStoredUser(res.user);
      const next = { full_name: res.user.full_name, health_notes: res.user.health_notes ?? "" };
      setForm(next);
      setSaved(next);
      toast.success(t("Saved."));
    // Bước 5: Xử lý lỗi trả về từ API. Nếu server báo lỗi ở trường cụ thể (full_name hoặc health_notes), gán lỗi vào fieldErrors; ngược lại hiển thị lỗi chung.
    } catch (e) {
      if (e instanceof ApiClientError && e.body?.field) {
        const f = e.body.field as "full_name" | "health_notes";
        const msg = e.body.message ? tServer(e.body.message) : e.message;
        if (f === "full_name" || f === "health_notes") {
          setFieldErrors({ [f]: msg });
          return;
        }
      }
      setError(e instanceof Error ? e.message : t("Could not save your details"));
    } finally {
      setBusy(false);
    }
  }

  // Bước 6: Hiển thị khung chờ Skeleton trong khi chờ thông tin người dùng được tải hoàn tất.
  if (!user) return <Skeleton className="h-72" />;

  // Bước 7: Render giao diện form chi tiết: ảnh đại diện (AvatarEditor), form nhập họ tên và ghi chú sức khỏe.
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <SpotlightCard className="rounded-[var(--radius-xl)]" size={420} strength={0.09}>
        <Card className="relative z-[2] p-6">
          <div className="mb-5 flex items-center gap-2.5">
            <UserRound className="size-4 text-accent" strokeWidth={1.75} />
            <h2 className="font-display text-xl">{t("Your details")}</h2>
          </div>
          <AvatarEditor user={user} />
          <form className="grid gap-6" onSubmit={save}>
            <section className="grid gap-4">
              <Label>{t("Identity")}</Label>
              <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t("Full name")}
              tone={fieldErrors.full_name ? "danger" : undefined}
              hint={fieldErrors.full_name}
            >
              <Input
                required
                maxLength={120}
                value={form.full_name}
                onChange={(e) => {
                  setForm({ ...form, full_name: e.target.value });
                  if (fieldErrors.full_name) setFieldErrors({ ...fieldErrors, full_name: undefined });
                }}
                aria-invalid={fieldErrors.full_name ? true : undefined}
              />
            </Field>
            {user.member_code ? <ReadOnly label={t("Member code")} value={user.member_code} mono /> : null}
            <ReadOnly label={t("Phone")} value={user.phone} />
            <ReadOnly label={t("Email")} value={user.email ?? t("Not set")} />
            <ReadOnly
              label={t("Date of birth")}
              value={user.date_of_birth ? formatDate(user.date_of_birth) : t("Not set")}
            />
              </div>
              <p className="text-xs text-subtle">
                {t("Phone, email and date of birth are changed at the front desk: an OTP or an ID is needed.")}
              </p>
            </section>
            {isMember ? (
              <section className="grid gap-4 border-t border-line pt-6">
                <Label>{t("Health")}</Label>
              <Field
                label={t("Health notes")}
                tone={fieldErrors.health_notes ? "danger" : "muted"}
                hint={
                  fieldErrors.health_notes ??
                  t("Coaches see this before a session: injuries, asthma, anything they should know.")
                }
              >
                <Textarea
                  rows={3}
                  maxLength={1000}
                  value={form.health_notes}
                  placeholder={t("Nothing to declare")}
                  onChange={(e) => {
                    setForm({ ...form, health_notes: e.target.value });
                    if (fieldErrors.health_notes) setFieldErrors({ ...fieldErrors, health_notes: undefined });
                  }}
                  aria-invalid={fieldErrors.health_notes ? true : undefined}
                />
                {form.health_notes.length > 800 ? (
                  <div className="mt-1 text-right text-2xs tabular-nums text-subtle">
                    {form.health_notes.length} / 1000
                  </div>
                ) : null}
              </Field>
              </section>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            <div className="flex items-center gap-3 border-t border-line pt-5">
              <StarBorder speed={4}>
                <Button type="submit" disabled={busy || !dirty || !form.full_name.trim()}>
                  {busy ? t("Saving…") : t("Save changes")}
                </Button>
              </StarBorder>
              {dirty ? (
                <Button variant="ghost" type="button" disabled={busy} onClick={discard}>
                  {t("Discard")}
                </Button>
              ) : null}
            </div>
          </form>
        </Card>
      </SpotlightCard>

      <div className="flex flex-col gap-4">
        <GoogleLink />

        {profileRead.error ? (
          <LoadError
            message={profileRead.error.message}
            onRetry={profileRead.error.refused ? undefined : profileRead.reload}
          />
        ) : !profileRead.data ? (
          user.role === "member" || user.role === "coach" ? <Skeleton className="h-24" /> : null
        ) : (
          <>
            {user.role === "member" && profileRead.data.guardian ? (
              <Card className="h-fit p-6">
                <Label>{t("Guardian")}</Label>
                <dl className="mt-4 grid gap-4">
                  <Row
                    label={t("Name")}
                    value={profileRead.data.guardian.name ?? t("Not set")}
                  />
                  <Row
                    label={t("Phone")}
                    value={profileRead.data.guardian.phone ?? t("Not set")}
                    note={t("The front desk updates it.")}
                  />
                </dl>
                {profileRead.data.pii_consent_at ? (
                  <p className="mt-4 text-xs text-subtle">
                    {t("You agreed to how we use your data on {date}.", {
                      date: formatDate(profileRead.data.pii_consent_at),
                    })}
                  </p>
                ) : null}
              </Card>
            ) : null}

            {user.role === "coach" && profileRead.data.coach ? (
              <Card className="h-fit p-6">
                <Label>{t("Coaching")}</Label>
                <dl className="mt-4 grid gap-4">
                  <Row
                    label={t("Sports")}
                    value={
                      profileRead.data.coach.sports.length > 0
                        ? profileRead.data.coach.sports.map(sportLabel).join(", ")
                        : t("None yet")
                    }
                  />
                  <Row
                    label={t("Per session")}
                    value={money(profileRead.data.coach.per_session_vnd)}
                  />
                  <Row
                    label={t("Per student")}
                    value={money(profileRead.data.coach.per_student_vnd)}
                    note={t("The manager sets these on the Staff screen.")}
                  />
                </dl>
              </Card>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Làm gì: Component hiển thị thẻ liên kết hoặc hủy liên kết tài khoản Google để hỗ trợ đăng nhập nhanh; tự động ẩn nếu hệ thống chưa bật Google OAuth.
 * Được gọi ở: `src/routes/account.tsx` bên trong component Profile (dòng 447).
 * @returns JSX phần tử Card liên kết Google hoặc null nếu server chưa cấu hình client_id.
 */
/**
 * Linking Google is the only way Google sign-in starts working for an account:
 * the sign-in page never creates one, and a matching email alone is not enough.
 */
function GoogleLink() {
  // Bước 1: Nạp trạng thái cấu hình và liên kết tài khoản Google từ API /me/google.
  const read = useRead<{ client_id: string | null; google_email: string | null }>("/me/google");
  const [busy, setBusy] = useState(false);
  // Nếu máy chủ chưa cấu hình Google Client ID, ẩn component để không hiển thị tính năng chưa sẵn sàng.
  if (!read.data?.client_id) return null;
  const linked = read.data.google_email;

  /**
   * Làm gì: Gửi Google credential lên server qua API POST /me/google để liên kết tài khoản Google với tài khoản hiện tại.
   * Được gọi ở: `src/routes/account.tsx` trong prop onCredential của GoogleButton (dòng 566).
   * @param credential Chuỗi JWT ID token nhận được từ Google sau khi người dùng xác thực.
   * @returns Promise<void>
   * @throws Không ném lỗi ra ngoài; bắt lỗi từ API hoặc mạng và hiển thị qua toast.
   */
  async function link(credential: string) {
    // Bước 1: Bật trạng thái bận (busy) để vô hiệu hóa nút và chống bấm trùng lặp.
    setBusy(true);
    // Bước 2: Gửi credential lên server để lưu liên kết Google, thông báo toast thành công và làm mới dữ liệu.
    try {
      await apiPost("/me/google", { credential });
      toast.success(t("Google is linked. You can now sign in with it."));
      read.reload();
    // Bước 3: Bắt lỗi nếu gọi API thất bại và hiển thị thông báo lỗi qua toast.
    } catch (err) {
      toast.error(err instanceof Error ? tServer(err.message) : t("Could not link Google"));
    // Bước 4: Tắt trạng thái bận sau khi hoàn tất.
    } finally {
      setBusy(false);
    }
  }

  /**
   * Làm gì: Gửi yêu cầu hủy liên kết tài khoản Google qua API DELETE /me/google và cập nhật lại giao diện.
   * Được gọi ở: `src/routes/account.tsx` trong sự kiện onClick của nút Unlink Google (dòng 556).
   * @returns Promise<void>
   * @throws Không ném lỗi ra ngoài; bắt lỗi từ API hoặc mạng và hiển thị qua toast.
   */
  async function unlink() {
    // Bước 1: Bật trạng thái bận (busy) khi bắt đầu thao tác hủy liên kết.
    setBusy(true);
    // Bước 2: Gọi API DELETE /me/google để xóa liên kết Google, hiển thị toast thành công và nạp lại trạng thái.
    try {
      await api("/me/google", { method: "DELETE" });
      toast.success(t("Google is unlinked."));
      read.reload();
    // Bước 3: Bắt lỗi nếu hủy liên kết thất bại và hiển thị thông báo lỗi qua toast.
    } catch (err) {
      toast.error(err instanceof Error ? tServer(err.message) : t("Could not unlink Google"));
    // Bước 4: Tắt trạng thái bận sau khi hoàn thành thao tác.
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="h-fit p-6">
      <Label>{t("Sign in with Google")}</Label>
      {linked ? (
        <div className="mt-4 grid gap-3">
          <Row label={t("Linked Google account")} value={linked} note={t("You can sign in with this Google account.")} />
          <div>
            <Button size="sm" variant="outline" type="button" disabled={busy} onClick={unlink}>
              {busy ? t("Unlinking…") : t("Unlink Google")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 grid gap-3">
          <p className="text-sm text-muted">
            {t("Link your Google account to sign in with it next time. Google cannot be used to create an account.")}
          </p>
          <GoogleButton clientId={read.data.client_id} text="signin_with" onCredential={link} />
        </div>
      )}
    </Card>
  );
}

/**
 * Làm gì: Component phụ trợ hiển thị trường thông tin dạng chỉ đọc (read-only input), vô hiệu hóa focus để ngăn chỉnh sửa.
 * Được gọi ở: `src/routes/account.tsx` trong component Profile (dòng 383, 384, 385, 386).
 * @param label Tiêu đề nhãn của trường thông tin.
 * @param value Giá trị chuỗi hiển thị trong ô chỉ đọc.
 * @param mono Cờ tùy chọn bật font chữ monospace (thường áp dụng cho Member code).
 * @returns JSX thẻ Input chỉ đọc bọc trong Field.
 */
function ReadOnly({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <Field label={label}>
      <Input
        readOnly
        tabIndex={-1}
        value={value}
        className={cn("cursor-default bg-bg text-muted focus:ring-0", mono && "font-mono tracking-wider")}
      />
    </Field>
  );
}

/**
 * Làm gì: Component phụ trợ hiển thị một hàng thông tin dạng danh sách định nghĩa (dl/dt/dd) gồm nhãn, giá trị và ghi chú phụ tùy chọn.
 * Được gọi ở: `src/routes/account.tsx` trong các component Profile (dòng 462, 466, 486, 494, 498) và GoogleLink (dòng 554).
 * @param label Tiêu đề của mục thông tin hiển thị ở thẻ dt.
 * @param value Giá trị nội dung hiển thị ở thẻ dd.
 * @param note Ghi chú phụ trợ hiển thị bên dưới giá trị nếu có.
 * @param mono Cờ tùy chọn bật font chữ monospace cho giá trị.
 * @returns JSX phần tử div chứa cấu trúc định nghĩa dt và dd.
 */
function Row({ label, value, note, mono }: { label: string; value: string; note?: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-2xs text-subtle">{label}</dt>
      <dd className={mono ? "mt-0.5 font-mono text-sm font-semibold tracking-wider" : "mt-0.5 text-sm"}>{value}</dd>
      {note ? <dd className="mt-1 text-xs text-subtle">{note}</dd> : null}
    </div>
  );
}

/**
 * Làm gì: Component quản lý bảo mật tài khoản: cung cấp form đổi mật khẩu và quản lý các thiết bị đang đăng nhập khác.
 * Được gọi ở: `src/routes/account.tsx` trong component Page khi chọn tab "security" (dòng 93).
 * @param forced Cờ boolean xác định người dùng có bị bắt buộc đổi mật khẩu hay không (khi vừa đăng nhập bằng mật khẩu tạm).
 * @returns JSX layout chứa form đổi mật khẩu và danh sách thiết bị đăng nhập.
 */
function Security({ forced }: { forced: boolean }) {
  // Bước 1: Nạp thông tin bảo mật từ API /me/profile (đặc biệt là số lượng thiết bị khác đang đăng nhập other_sessions).
  const profileRead = useRead<MeProfile>("/me/profile");
  // Bước 2: Khởi tạo state form mật khẩu (mật khẩu hiện tại, mới, xác nhận), cờ ẩn/hiện mật khẩu, trạng thái bận và lỗi.
  const [form, setForm] = useState({ current_password: "", new_password: "", confirm_password: "" });
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field: string | null } | null>(null);
  /** For an input: marked invalid, and tied to the message, when the server named it as the fault. */
  const faulted = (name: string) =>
    error?.field === name ? ({ "aria-invalid": true, "aria-describedby": "password-error" } as const) : {};

  // Bước 3: Kiểm tra tính hợp lệ của mật khẩu mới theo các quy tắc nghiệp vụ.
  const mismatch = form.confirm_password.length > 0 && form.confirm_password !== form.new_password;
  // Quy tắc nghiệp vụ: mật khẩu mới phải có ít nhất 8 ký tự, bao gồm cả chữ cái và chữ số.
  const tooWeak =
    form.new_password.length > 0 &&
    !(form.new_password.length >= 8 && /[A-Za-z]/.test(form.new_password) && /\d/.test(form.new_password));
  // Nút đổi mật khẩu chỉ sẵn sàng khi đã nhập mật khẩu cũ, mật khẩu mới đạt chuẩn và khớp với mật khẩu xác nhận.
  const ready = form.current_password.length > 0 && form.new_password.length > 0 && !mismatch && !tooWeak;

  /**
   * Làm gì: Xử lý gửi form đổi mật khẩu lên server qua API POST /me/password, làm mới phiên và chuyển hướng nếu đang ở chế độ bắt buộc đổi mật khẩu tạm.
   * Được gọi ở: `src/routes/account.tsx` trong sự kiện onSubmit của form đổi mật khẩu (dòng 659).
   * @param e Sự kiện gửi form HTML (FormEvent).
   * @returns Promise<void>
   * @throws Không ném lỗi ra ngoài; bắt lỗi từ API và lưu vào state error để hiển thị và highlight ô nhập liệu bị sai.
   */
  async function submit(e: FormEvent) {
    // Bước 1: Ngăn chặn reload trang mặc định và kiểm tra điều kiện sẵn sàng trước khi gửi dữ liệu.
    e.preventDefault();
    if (!ready) return;
    // Bước 2: Xóa thông báo lỗi cũ và bật trạng thái bận (busy).
    setError(null);
    setBusy(true);
    try {
      // Bước 3: Gọi API POST /me/password để đổi mật khẩu và xóa trắng các trường nhập liệu trên form.
      const res = await apiPost<{ ok: boolean; signed_out: number }>("/me/password", form);
      setForm({ current_password: "", new_password: "", confirm_password: "" });
      // Hiển thị thông báo toast: nêu rõ nếu có thiết bị khác bị đăng xuất sau khi đổi mật khẩu thành công.
      if (res.signed_out > 0) {
        toast.success(t("Password changed. Your other devices were signed out."));
      } else {
        toast.success(t("Password changed."));
      }
      // Bước 4: Nạp lại thông tin hồ sơ để cập nhật số lượng thiết bị đăng nhập còn lại.
      profileRead.reload();
      // Bước 5: Nếu đang ở luồng bắt buộc đổi mật khẩu tạm (must_change_password), cập nhật storage và chuyển hướng về trang chủ theo vai trò.
      const u = getStoredUser();
      if (u?.must_change_password) {
        setStoredUser({ ...u, must_change_password: false });
        // Let the menu and guard see the cleared flag.
        window.location.assign(homeFor(u.role));
      }
    } catch (e) {
      // The usual cause is a wrong current password; say so beside the button, where it stays, and
      // mark the box the server named.
      setError({
        message: e instanceof Error ? e.message : t("Could not change your password"),
        field: e instanceof ApiClientError ? (e.body.field ?? null) : null,
      });
    } finally {
      // Bước 6: Tắt trạng thái bận dù thành công hay thất bại.
      setBusy(false);
    }
  }

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <SpotlightCard className="rounded-[var(--radius-xl)]" size={420} strength={0.09}>
        <Card className="relative z-[2] p-6">
          <div className="mb-5 flex items-center gap-2.5">
            <KeyRound className="size-4 text-accent" strokeWidth={1.75} />
            <h2 className="font-display text-xl">{t("Change password")}</h2>
          </div>
          {forced ? (
            <p className="mb-4 rounded-[var(--radius-md)] bg-wood px-3 py-2 text-sm">
              {t(
                "You signed in with a temporary password. Choose your own to continue, and enter the temporary one as the current password.",
              )}
            </p>
          ) : null}
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
            <div className="sm:col-span-2">
            <Field label={t("Current password")}>
              <Input
                required
                type={show ? "text" : "password"}
                autoComplete="current-password"
                value={form.current_password}
                onChange={(e) => setForm({ ...form, current_password: e.target.value })}
                {...faulted("current_password")}
              />
            </Field>
            </div>
            <Field
              label={t("New password")}
              hint={tooWeak ? t("At least 8 characters, with a letter and a number.") : undefined}
            >
              <div className="relative">
                <Input
                  required
                  type={show ? "text" : "password"}
                  autoComplete="new-password"
                  className="pr-12"
                  value={form.new_password}
                  onChange={(e) => setForm({ ...form, new_password: e.target.value })}
                  {...faulted("new_password")}
                  aria-invalid={tooWeak || error?.field === "new_password" ? true : undefined}
                />
                <button
                  type="button"
                  className="absolute right-0 top-0 grid size-11 place-items-center text-muted hover:text-fg"
                  onClick={() => setShow((v) => !v)}
                  aria-label={show ? t("Hide passwords") : t("Show passwords")}
                >
                  {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </Field>
            <Field
              label={t("Confirm new password")}
              hint={mismatch ? t("The two passwords do not match.") : undefined}
            >
              <Input
                required
                type={show ? "text" : "password"}
                autoComplete="new-password"
                value={form.confirm_password}
                onChange={(e) => setForm({ ...form, confirm_password: e.target.value })}
                {...faulted("confirm_password")}
                aria-invalid={mismatch || error?.field === "confirm_password" ? true : undefined}
              />
            </Field>
            <ul className="grid gap-1.5 rounded-[var(--radius-md)] bg-bg/60 p-3 text-xs sm:col-span-2" aria-label={t("Password rules")}>
              {[
                { ok: form.new_password.length >= 8, label: t("At least 8 characters") },
                { ok: /[A-Za-z]/.test(form.new_password), label: t("A letter") },
                { ok: /\d/.test(form.new_password), label: t("A number") },
                {
                  ok: form.confirm_password.length > 0 && form.confirm_password === form.new_password,
                  label: t("Both passwords match"),
                },
              ].map((r) => (
                <li key={r.label} className={cn("flex items-center gap-2", r.ok ? "text-accent" : "text-subtle")}>
                  {r.ok ? <Check className="size-3.5" /> : <Circle className="size-3.5" />}
                  {r.label}
                </li>
              ))}
            </ul>
            {error ? (
              <p id="password-error" role="alert" className="text-sm text-danger sm:col-span-2">
                {error.message}
              </p>
            ) : null}
            <div className="border-t border-line pt-5 sm:col-span-2">
              <Button type="submit" disabled={busy || !ready}>
                {busy ? t("Changing…") : t("Change password")}
              </Button>
            </div>
          </form>
        </Card>
      </SpotlightCard>

      <SignedInDevices
        otherSessions={profileRead.data ? profileRead.data.other_sessions : null}
        loading={!profileRead.data && !profileRead.error}
        onReload={profileRead.reload}
      />
    </div>
  );
}

/**
 * Làm gì: Component hiển thị số lượng thiết bị khác đang đăng nhập tài khoản và cung cấp chức năng đăng xuất tất cả thiết bị đó từ xa.
 * Được gọi ở: `src/routes/account.tsx` bên trong component Security (dòng 741).
 * @param otherSessions Số lượng phiên đăng nhập khác đang hoạt động trên hệ thống (null nếu chưa tải xong).
 * @param loading Trạng thái đang tải dữ liệu phiên đăng nhập.
 * @param onReload Callback hàm tải lại thông tin phiên sau khi đăng xuất thành công.
 * @returns JSX khối hiển thị thiết bị đăng nhập và các nút xác nhận đăng xuất.
 */
function SignedInDevices({
  otherSessions,
  loading,
  onReload,
}: {
  otherSessions: number | null;
  loading: boolean;
  onReload: () => void;
}) {
  // Bước 1: Khởi tạo các state: hộp thoại xác nhận đăng xuất (confirming), trạng thái bận (busy) và thông báo lỗi (signOutError).
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  /**
   * Làm gì: Gửi yêu cầu đăng xuất tất cả các thiết bị khác qua API POST /me/sessions/sign-out-others, hiển thị toast và làm mới danh sách thiết bị.
   * Được gọi ở: `src/routes/account.tsx` trong sự kiện onClick của nút Sign out trong SignedInDevices (dòng 812).
   * @returns Promise<void>
   * @throws Không ném lỗi ra ngoài; bắt lỗi từ API hoặc mạng và lưu thông báo vào state signOutError để hiển thị.
   */
  async function doSignOutOthers() {
    // Bước 1: Xóa thông báo lỗi trước đó để chuẩn bị gửi yêu cầu.
    setSignOutError(null);
    // Bước 1: Khóa giao diện để tránh người dùng thao tác nhiều lần (setBusy).
    setBusy(true);
    try {
      // Bước 2: Gọi API POST /me/sessions/sign-out-others để thu hồi tất cả phiên đăng nhập khác ngoại trừ phiên này.
      const res = await apiPost<{ signed_out: number }>("/me/sessions/sign-out-others");
      // Bước 3: Thông báo số lượng phiên đã đăng xuất thành công, đóng hộp thoại xác nhận và tải lại danh sách.
      toast.success(t("Signed out {n} devices.", { n: res.signed_out }));
      setConfirming(false);
      onReload();
    // Bước 4: Xử lý và hiển thị thông báo lỗi thân thiện nếu gọi API thất bại.
    } catch (e) {
      if (e instanceof ApiClientError && e.body?.message) {
        setSignOutError(tServer(e.body.message));
      } else if (e instanceof Error) {
        setSignOutError(e.message);
      } else {
        setSignOutError(t("Something went wrong"));
      }
    // Bước 5: Luôn mở khóa trạng thái bận (busy) khi kết thúc quá trình.
    } finally {
      setBusy(false);
    }
  }

  return (
    <SpotlightCard className="rounded-[var(--radius-xl)]" size={420} strength={0.09}>
      <Card className="relative z-[2] p-6">
        <div className="mb-5 flex items-center gap-2.5">
          <MonitorSmartphone className="size-4 text-accent" strokeWidth={1.75} />
          <h2 className="font-display text-xl">{t("Signed-in devices")}</h2>
        </div>
        {loading ? (
          <Skeleton className="h-12" />
        ) : otherSessions === null || otherSessions === 0 ? (
          <p className="text-sm text-subtle">{t("Only this device is signed in.")}</p>
        ) : (
          <div className="grid gap-3">
            <p className="text-sm">
              {otherSessions === 1
                ? t("Signed in on 1 other device.")
                : t("Signed in on {n} other devices.", { n: otherSessions })}
            </p>
            {confirming ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-xs text-muted">
                  {t("Sign them out? They will need your password to sign in again.")}
                </span>
                <Button
                  size="sm"
                  variant="danger"
                  type="button"
                  disabled={busy}
                  onClick={doSignOutOthers}
                >
                  {t("Sign out")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(false);
                    setSignOutError(null);
                  }}
                >
                  {t("Cancel")}
                </Button>
              </div>
            ) : (
              <div className="pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => {
                    setConfirming(true);
                    setSignOutError(null);
                  }}
                >
                  {t("Sign out other devices")}
                </Button>
              </div>
            )}
            {signOutError ? (
              <p role="alert" className="text-sm text-danger">
                {signOutError}
              </p>
            ) : null}
          </div>
        )}
      </Card>
    </SpotlightCard>
  );
}

// Cấu trúc dữ liệu yêu cầu hỗ trợ (Ticket) từ hội viên gửi quầy lễ tân.
type Ticket = {
  id: string;
  body: string;
  status: string;
  created_at: string;
  reply: string | null;
  replied_at: string | null;
  replied_by_name: string | null;
};

/**
 * Customer care, from the member's side.
 *
 * Until now the only way to reach the desk was to start a message with
 * "ticket:" at the assistant, which opened a row nobody could answer and
 * pointed the member at no screen. Everything else in this app — a booking, a class, a receipt — can
 * be looked up afterwards; a complaint was the one thing you sent into silence.
 */
/**
 * The longest message the desk will take, and where the counter wakes up.
 *
 * The server's own number: `ticketsCreate` slices at 2000, so anything past it
 * was being dropped without a word to the person who typed it.
 */
const TICKET_MAX_CHARS = 2000;
// Bắt đầu hiển thị số ký tự còn lại khi độ dài nội dung đạt từ 1800 ký tự (còn 200 ký tự nữa là chạm trần).
const TICKET_COUNTER_FROM = TICKET_MAX_CHARS - 200;

/**
 * Làm gì: Hiển thị tab hỗ trợ khách hàng (Customer Support), cho phép hội viên gửi thắc mắc hoặc khiếu nại tới quầy lễ tân và theo dõi phản hồi.
 * Được gọi ở: `src/routes/account.tsx` trong component Page khi chọn tab "support" (dòng 95) trên trang /account.
 * @returns JSX phần tử giao diện danh sách yêu cầu và form gửi tin nhắn.
 */
function Support() {
  // The tab stays whatever the flag says: `GET /tickets/mine` is not gated, so
  // what a member has already asked and been told stays readable (FR-S04).
  // Switching a module off must not take their own history away from them. Only
  // the box that opens a new request goes, because `POST /tickets` now 403s.
  const f6 = useF6();
  // Bước 1: Khởi tạo các state quản lý danh sách yêu cầu, nội dung soạn thảo, trạng thái gửi, lỗi và phân trang.
  const [items, setItems] = useState<Ticket[] | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const { offset, setOffset, pageSize, setPageSize } = usePageState("account.requests", 10);

  /**
   * Làm gì: Gọi API lấy danh sách yêu cầu hỗ trợ cá nhân của hội viên theo phân trang limit và offset.
   * Được gọi ở: `src/routes/account.tsx` bên trong hàm loadAgain của component Support (dòng 906).
   * @returns Promise<void>
   */
  async function load() {
    // Bước 1: Gọi API GET /tickets/mine với tham số limit và offset của trang hiện tại.
    const r = await apiGet<{ items: Ticket[]; total: number }>(`/tickets/mine?limit=${pageSize}&offset=${offset}`);
    // Bước 2: Lưu danh sách ticket và tổng số bản ghi vào state, đồng thời xóa thông báo lỗi tải trang trước đó.
    setItems(r.items);
    setTotal(r.total);
    setLoadError(null);
  }

  /**
   * Làm gì: Kích hoạt tải dữ liệu danh sách yêu cầu và bắt lỗi để cập nhật vào loadError nếu có sự cố mạng/máy chủ.
   * Được gọi ở: `src/routes/account.tsx` trong useEffect khi offset/pageSize đổi, trong LoadError khi bấm retry, và sau khi gửi ticket mới.
   * @returns void
   */
  function loadAgain() {
    // Bước 1: Xóa thông báo lỗi cũ trước khi bắt đầu tải lại.
    setLoadError(null);
    // Bước 2: Kích hoạt tải dữ liệu qua load(); nếu thất bại thì lưu thông báo lỗi để hiển thị nút thử lại.
    void load().catch((e) => setLoadError(e instanceof Error ? e.message : t("Could not load your requests")));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps -- load reads the page it is asked for
  useEffect(loadAgain, [offset, pageSize]);

  /**
   * Làm gì: Xử lý submit form gửi yêu cầu hỗ trợ mới tới quầy lễ tân qua API POST /tickets.
   * Được gọi ở: `src/routes/account.tsx` trong sự kiện onSubmit của form bên trong component Support (dòng 951).
   * @param e Sự kiện submit form HTML (FormEvent).
   * @returns Promise<void>
   */
  async function send(e: FormEvent) {
    // Bước 1: Ngăn hành vi submit form mặc định của trình duyệt và loại bỏ khoảng trắng thừa đầu cuối.
    e.preventDefault();
    const text = body.trim();
    // Kiểm tra tính hợp lệ: nội dung phải tối thiểu 2 ký tự và không gửi khi đang xử lý (busy).
    if (text.length < 2 || busy) return;
    // Bước 2: Xóa lỗi cũ và khóa giao diện bằng cờ busy.
    setError(null);
    setBusy(true);
    // Bước 3: Gửi nội dung yêu cầu hỗ trợ lên máy chủ qua API POST /tickets.
    try {
      await apiPost("/tickets", { body: text });
      // Bước 4: Xóa trắng ô nhập liệu và hiển thị thông báo đã gửi thành công tới quầy lễ tân.
      setBody("");
      toast.success(t("Sent to the front desk"));
      // The list is asked for again on its own: if that fails it says so beside the list, and never
      // claims the message was not sent when it was. The new request is at the top of page one.
      // Bước 5: Làm mới danh sách; nếu đang ở trang khác thì chuyển về trang 1 để xem yêu cầu vừa gửi.
      if (offset === 0) loadAgain();
      else setOffset(0);
    } catch (e) {
      // The message the person typed stays in the box, and the reason stays on screen beside it.
      setError(e instanceof Error ? e.message : t("Could not send that"));
    // Bước 6: Mở khóa trạng thái bận trong khối finally.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-5">
      {!f6 ? (
        <Card className="p-5">
          <h2 className="font-display text-xl">{t("Ask the front desk")}</h2>
          <p className="mt-1 text-sm text-muted">
            {t("Sending new messages is switched off right now. Ask at reception — anything you sent before is still below.")}
          </p>
        </Card>
      ) : (
      <Card className="p-5">
        <h2 className="font-display text-xl">{t("Ask the front desk")}</h2>
        <p className="mt-1 text-sm text-muted">
          {t(
            "A question, a complaint, something broken on a court. Reception answers during opening hours and the reply shows up here.",
          )}
        </p>
        <form className="mt-3 grid gap-3" onSubmit={send}>
          <Field label={t("Your message")}>
            <Textarea
              rows={3}
              maxLength={TICKET_MAX_CHARS}
              value={body}
              aria-describedby={
                [error ? "support-error" : null, body.length >= TICKET_COUNTER_FROM ? "support-remaining" : null]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              onChange={(e) => setBody(e.target.value.slice(0, TICKET_MAX_CHARS))}
              placeholder={t("The lights over BC2 have been out since Tuesday…")}
            />
          </Field>
          {/* Same manners as the assistant's box: quiet until the limit is
              nearly in reach, then it says how much is left and finally what
              the ceiling actually is. The box used to just stop accepting
              typing with nothing on screen to explain why. */}
          {body.length >= TICKET_COUNTER_FROM ? (
            <p
              id="support-remaining"
              aria-live="polite"
              className={cn(
                "text-2xs tabular-nums",
                body.length >= TICKET_MAX_CHARS ? "text-danger" : "text-muted",
              )}
            >
              {body.length >= TICKET_MAX_CHARS
                ? t("That is the whole {max} characters. Shorten it, or send it in two.", { max: TICKET_MAX_CHARS })
                : t("{n} characters left", { n: TICKET_MAX_CHARS - body.length })}
            </p>
          ) : null}
          {error ? (
            <p id="support-error" role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <div>
            <StarBorder>
              <Button type="submit" disabled={busy || body.trim().length < 2}>
                {busy ? t("Sending…") : t("Send to reception")}
              </Button>
            </StarBorder>
          </div>
        </form>
      </Card>
      )}

      {loadError ? <LoadError message={loadError} onRetry={loadAgain} /> : null}
      {!items ? (
        loadError ? null : <Skeleton className="h-24" />
      ) : items.length === 0 ? (
        // Not while the list could not be refreshed: "nothing asked yet" would be a guess.
        loadError ? null : (
          <EmptyState title={t("Nothing asked yet")} hint={t("Anything you send the desk will be kept here with its reply.")} />
        )
      ) : (
        <Stagger className="grid gap-2.5" gap={0.05}>
          {items.map((tix) => (
            <StaggerItem key={tix.id}>
              <Card className="p-4">
                <div className="flex items-start justify-between gap-3">
                  {/* `break-words` is doing real work: this is text somebody
                      typed, and a long run without a space — a pasted URL, or
                      the "ticket:ticket:ticket:" that older rows still carry —
                      has nothing to wrap on and pushes the badge off the card. */}
                  <p className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm">{tix.body}</p>
                  {/* Three states, read off `status` and not off `reply`
                      alone. The desk can close a request without writing an
                      answer, and judging by `reply` showed those rows as
                      "Waiting" for good — the one thing the member could be
                      sure of was that nobody had got to it yet. */}
                  <Badge
                    tone={tix.reply ? "accent" : tix.status === "closed" ? "muted" : "hold"}
                    className="shrink-0"
                  >
                    {tix.reply ? t("Answered") : tix.status === "closed" ? t("Closed") : t("Waiting")}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted">{when(tix.created_at)}</p>
                {tix.reply ? (
                  /* Indented, tinted and signed at the top so the reply reads as somebody
                     else speaking, not as more of the member's own message. */
                  <div className="mt-3 ml-3 rounded-[var(--radius-md)] bg-accent/5 p-3 ring-1 ring-inset ring-accent/15">
                    <p className="text-2xs font-semibold text-accent-2">
                      {tix.replied_by_name ?? t("Reception")}
                      {tix.replied_at ? <span className="font-normal text-muted"> · {when(tix.replied_at)}</span> : null}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm">{tix.reply}</p>
                  </div>
                ) : null}
              </Card>
            </StaggerItem>
          ))}
        </Stagger>
      )}
      <Pagination
        offset={offset}
        total={total}
        pageSize={pageSize}
        onChange={setOffset}
        onPageSizeChange={setPageSize}
        label={t("Request pages")}
      />
    </div>
  );
}

/**
 * Làm gì: Hiển thị tab biên lai/hóa đơn thanh toán (Receipts) của hội viên, cho phép theo dõi lịch sử thanh toán và tải file PDF hóa đơn.
 * Được gọi ở: `src/routes/account.tsx` trong component Page khi chọn tab "receipts" (dòng 94) trên trang /account.
 * @returns JSX phần tử giao diện danh sách hóa đơn theo phân trang.
 */
function Receipts() {
  // Bước 1: Khởi tạo state opening lưu ID hóa đơn đang mở PDF để hiển thị trạng thái đang xử lý trên nút bấm.
  const [opening, setOpening] = useState<string | null>(null);
  // Quản lý trạng thái phân trang (offset, pageSize) lưu theo namespace "account.receipts".
  const { offset, setOffset, pageSize, setPageSize } = usePageState("account.receipts", 10);
  // The receipts already on screen stay while another page loads, so paging does not flash empty.
  const read = useRead<{ items: Invoice[]; total: number }>(`/invoices?limit=${pageSize}&offset=${offset}`, {
    keepPrevious: true,
  });
  const items = read.data?.items ?? null;

  // Bước 2: Hiển thị bộ khung tải (Skeleton) hoặc component LoadError nếu có lỗi xảy ra khi truy vấn dữ liệu.
  if (!items) {
    if (read.error) return <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />;
    return (
      <div className="grid gap-2">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
    );
  }

  // Bước 3: Hiển thị trạng thái trống (EmptyState) nếu hội viên chưa từng phát sinh hóa đơn nào.
  if (items.length === 0) {
    return (
      <EmptyState
        title={t("No receipts yet")}
        hint={t("Every payment you make (court, class or membership) lands here as a PDF you can download.")}
      />
    );
  }

  // Bước 4: Render danh sách hóa đơn theo dạng thẻ (Card), hiển thị mã hóa đơn, số tiền, trạng thái hoàn tiền và nút tải PDF.
  return (
    <>
      <p className="mb-3 text-sm text-muted">{t("Collect your refund in cash at the front desk.")}</p>
      <Stagger className="grid gap-2.5" gap={0.05}>
        {items.map((r) => (
          <StaggerItem key={r.id}>
            <Lift amount={-2}>
              <Card className="flex flex-wrap items-center gap-x-5 gap-y-3 p-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-md)] bg-wood text-muted">
                  <Receipt className="size-4" strokeWidth={1.75} />
                </span>
                <div className="min-w-[8rem] flex-1">
                  <p className="font-mono text-sm font-semibold tracking-wide">{r.code}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {REF[r.ref_type] ? t(REF[r.ref_type]) : r.ref_type} · {when(r.issued_at)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-display text-lg tabular-nums">{money(r.amount_vnd)}</p>
                  <p className="text-2xs text-subtle">{METHOD[r.method] ? t(METHOD[r.method]) : r.method}</p>
                </div>
                {r.status !== "posted" ? <Badge tone="danger">{t("Refunded")}</Badge> : null}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={opening === r.id}
                  onClick={async () => {
                    setOpening(r.id);
                    try {
                      await openInvoice(r.id);
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : t("Could not open that receipt"));
                    } finally {
                      setOpening(null);
                    }
                  }}
                >
                  <Download className="size-3.5" strokeWidth={2} />
                  {opening === r.id ? t("Opening…") : t("PDF")}
                </Button>
              </Card>
            </Lift>
          </StaggerItem>
        ))}
      </Stagger>
      <Pagination
        offset={offset}
        total={read.data?.total ?? 0}
        pageSize={pageSize}
        onChange={setOffset}
        onPageSizeChange={setPageSize}
        label={t("Receipt pages")}
      />
    </>
  );
}
