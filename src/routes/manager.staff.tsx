/**
 * Màn hình quản lý nhân sự dành cho Quản lý (Manager) tại route `/manager/staff`.
 * Trong hệ thống Arena3, Manager là người trực tiếp cấp phát và quản lý tài khoản nội bộ
 * (Manager, Receptionist, Coach), cấp mật khẩu tạm, khóa/mở khóa tài khoản,
 * hủy phiên làm việc và phân công môn thể thao/chứng chỉ cho huấn luyện viên.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Copy, Upload } from "lucide-react";
import { toast } from "sonner";
import { Shell, initials, when, useSessionUser } from "@/client/components/shell";
import { UserAvatar } from "@/client/components/user-avatar";
import { Cover } from "@/client/components/media";
import { PageHero } from "@/client/components/page-hero";
import { StatStrip } from "@/client/components/stat-strip";
import { CertificationsModal } from "@/client/components/coach-certifications";
import { RowActions } from "@/client/components/row-actions";
import { SportBadge, useSports } from "@/client/components/sports-ui";
import { Badge, Button, Card, EmptyState, Field, Input, LoadError, Modal, Select, Skeleton, Pagination } from "@/client/components/ui";
import { ApiClientError, apiPost, apiPatch } from "@/client/arena3/client";
import { roleLabel, sportLabel } from "@/shared/arena3/labels";
import { cn } from "@/client/lib/cn";
import { t, tServer, tData } from "@/client/lib/i18n";
import { usePageState } from "@/client/lib/use-page-state";
import { useRead } from "@/client/lib/use-read";

/**
 * Làm gì: Định nghĩa route `/manager/staff` cho TanStack Router, liên kết URL với component Page để hiển thị giao diện quản lý nhân sự.
 * Được gọi ở: URL `/manager/staff` (khi người dùng truy cập từ thanh điều hướng hoặc liên kết tạo nhanh).
 * @returns Đối tượng cấu hình route của TanStack Router.
 */
export const Route = createFileRoute("/manager/staff")({ component: Page });

type Staff = {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  role: string;
  status: string;
  must_change_password: boolean;
  created_at: string;
  sports: string[] | null;
  open_sessions: number;
  issued_by: string | null;
  issued_at: string | null;
  avatar_url?: string | null;
};

type Issued = { name: string; phone: string; password: string; why: string };

/**
 * Làm gì: Component trang quản lý nhân sự, hiển thị danh sách nhân viên, thanh thống kê, bộ lọc tìm kiếm và các hộp thoại quản trị tài khoản nội bộ.
 * Được gọi ở: Route `/manager/staff` (TanStack Router render khi khớp URL).
 * @returns Giao diện quản lý nhân sự được bọc trong component Shell dành cho Manager.
 */
function Page() {
  const user = useSessionUser();
  // Bước 1: Khởi tạo state và đọc query params trên URL (hỗ trợ mở sẵn modal tạo mới với vai trò chỉ định, ví dụ khi chuyển từ /manager).
  const searchParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const initialCreating = searchParams?.get("create") === "1" || searchParams?.get("create") === "true";
  const initialRole = searchParams?.get("role") || "receptionist";
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(initialCreating);
  const [createRole] = useState(initialRole);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [editing, setEditing] = useState<Staff | null>(null);
  const [certsOf, setCertsOf] = useState<Staff | null>(null);

  // Typing waits a beat so one search is one request.
  const [term, setTerm] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  // Bước 2: Chuẩn bị query string chứa các tiêu chí lọc (role, status, term) để gửi kèm request API.
  const qs = new URLSearchParams();
  if (role) qs.set("role", role);
  if (status) qs.set("status", status);
  if (term) qs.set("q", term);
  const filtered = !!(role || status || term);
  const { offset, setOffset, pageSize, setPageSize, reset } = usePageState("manager.staff", 25);
  // Reset trang về đầu (offset = 0) mỗi khi người dùng thay đổi bộ lọc hoặc từ khóa tìm kiếm.
  useEffect(reset, [role, status, term, reset]);
  qs.set("limit", String(pageSize));
  qs.set("offset", String(offset));
  // The list on screen stays (dimmed) while a new filter loads; a failed read replaces it with the reason.
  const read = useRead<{ items: Staff[]; total: number }>(`/staff?${qs}`, { keepPrevious: true });
  const items = read.data?.items ?? null;
  // Tải danh sách toàn bộ nhân sự (tối đa 100) độc lập với bộ lọc để tính toán số lượng thống kê trên các tab và thanh số liệu.
  const allStaffRead = useRead<{ items: Staff[] }>("/staff?limit=100");
  const allStaff = allStaffRead.data?.items ?? [];

  // Bước 3: Tính toán số lượng nhân sự theo từng vai trò phục vụ thanh bộ lọc tab và thanh chỉ số.
  const roleCounts = {
    "": allStaff.length,
    receptionist: allStaff.filter((s) => s.role === "receptionist").length,
    coach: allStaff.filter((s) => s.role === "coach").length,
    manager: allStaff.filter((s) => s.role === "manager").length,
  };

  const ROLES = [
    { value: "", label: t("All roles"), count: roleCounts[""] },
    { value: "receptionist", label: t("Receptionist"), count: roleCounts.receptionist },
    { value: "coach", label: t("Coach"), count: roleCounts.coach },
    { value: "manager", label: t("Manager"), count: roleCounts.manager },
  ];

  const statItems = [
    { label: t("Total coaches"), value: roleCounts.coach },
    { label: t("Total receptionists"), value: roleCounts.receptionist },
    { label: t("Must change password"), value: allStaff.filter((s) => s.must_change_password).length },
    { label: t("Open sessions"), value: allStaff.reduce((sum, s) => sum + s.open_sessions, 0) },
  ];

  /**
   * Làm gì: Thực hiện các thao tác quản trị tài khoản nhân viên bao gồm khóa/mở khóa tài khoản, đặt lại mật khẩu tạm và thu hồi phiên làm việc.
   * Được gọi ở: src/routes/manager.staff.tsx (menu tác vụ RowActions trên từng thẻ nhân sự tại các dòng 232, 237, 244, 248).
   * @param s Đối tượng thông tin nhân viên cần xử lý.
   * @param what Loại hành động quản trị: "lock" (khóa tài khoản), "unlock" (mở khóa), "reset" (đặt lại mật khẩu tạm), "revoke" (thu hồi tất cả phiên đăng nhập).
   * @returns Promise không có giá trị trả về sau khi hoàn tất cập nhật và tải lại dữ liệu.
   */
  async function act(s: Staff, what: "lock" | "unlock" | "reset" | "revoke") {
    try {
      // Bước 1: Gọi API tương ứng với thao tác quản trị được chọn.
      if (what === "lock" || what === "unlock") {
        // Cập nhật trạng thái tài khoản thành locked (khóa) hoặc active (mở khóa hoạt động).
        await apiPatch(`/staff/${s.id}`, { status: what === "lock" ? "locked" : "active" });
        toast.success(
          what === "lock"
            ? t("{name} is locked out", { name: s.full_name })
            : t("{name} can sign in again", { name: s.full_name }),
        );
      } else if (what === "reset") {
        // Đặt lại mật khẩu: server sinh mật khẩu tạm thời, hủy toàn bộ phiên đang chạy và mở modal bàn giao thông tin.
        const r = await apiPost<{ temp_password: string }>(`/staff/${s.id}/reset-password`);
        setIssued({
          name: s.full_name,
          phone: s.phone,
          password: r.temp_password,
          why: t("Password reset. Every open session for this account was signed out."),
        });
      } else {
        // Thu hồi phiên: buộc đăng xuất tài khoản khỏi tất cả các thiết bị đang đăng nhập.
        const r = await apiPost<{ revoked: number }>(`/staff/${s.id}/revoke-sessions`);
        toast.success(
          r.revoked
            ? t("Signed {name} out of {n} session(s)", { name: s.full_name, n: r.revoked })
            : t("No open sessions"),
        );
      }
      // Bước 2: Tải lại cả danh sách phân trang và danh sách thống kê để cập nhật trạng thái mới nhất.
      read.reload();
      allStaffRead.reload();
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    }
  }

  // Bước 4: Render giao diện quản lý nhân sự. Quản lý không thể tự khóa hoặc đổi vai trò của chính mình (s.id !== user.id).
  return (
    <Shell role="manager">
      <PageHero
        slot="banner.manager"
        title={t("Staff")}
        subtitle={t("Manager, receptionist and coach logins are issued here. Members sign themselves up.")}
      />
      <StatStrip className="mb-6" items={statItems} />
      <div className="mb-4 flex flex-wrap gap-2">
        {ROLES.map((r) => (
          <button
            key={r.value}
            type="button"
            onClick={() => setRole(r.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
              role === r.value
                ? "bg-accent text-accent-fg shadow-[var(--shadow-accent)]"
                : "border border-line bg-surface text-muted hover:bg-wood hover:text-fg",
            )}
          >
            <span>{r.label}</span>
            <span
              className={cn(
                "rounded-full px-1.5 py-0.2 text-2xs font-semibold tabular-nums",
                role === r.value ? "bg-accent-fg/20 text-accent-fg" : "bg-wood text-muted",
              )}
            >
              {r.count}
            </span>
          </button>
        ))}
      </div>
      <Card className="mb-4 grid gap-3 md:grid-cols-[1.8fr_1fr_auto]">
        <Input aria-label={t("Search staff")} placeholder={t("Search name, phone or email")} value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label={t("Status")} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t("Any status")}</option>
          <option value="active">{t("Active")}</option>
          <option value="locked">{t("Locked")}</option>
        </Select>
        <Button onClick={() => setCreating(true)}>{t("Add staff")}</Button>
      </Card>

      <div aria-busy={read.stale} className={cn("transition-opacity", read.stale && "opacity-60")}>
      {read.error ? (
        <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />
      ) : !items ? (
        <Skeleton className="h-40" />
      ) : !items.length ? (
        <EmptyState
          title={filtered ? t("Nobody matches those filters") : t("No staff accounts yet")}
          hint={filtered ? t("Clear a filter to see everyone.") : t("Add a manager, receptionist or coach to give them a login.")}
        >
          {!filtered ? <Button onClick={() => setCreating(true)}>{t("Add staff")}</Button> : null}
        </EmptyState>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {items.map((s) => {
            const managed = !!user && s.id !== user.id && ["receptionist", "coach", "manager"].includes(s.role);
            return (
              <Card key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="flex items-center gap-3.5 min-w-0">
                  <div className="size-10 shrink-0">
                    <UserAvatar name={s.full_name} url={s.avatar_url} />
                  </div>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {tData(s.full_name)}
                      <Badge tone={s.role === "manager" ? "ink" : "accent"}>{roleLabel(s.role)}</Badge>
                      {s.status !== "active" ? <Badge tone="danger">{t("Locked")}</Badge> : null}
                      {s.must_change_password ? <Badge tone="hold">{t("Must change password")}</Badge> : null}
                    </p>
                    <p className="text-sm tabular-nums text-muted">
                      {s.phone}
                      {s.email ? ` · ${s.email}` : ""}
                    </p>
                    {s.role === "coach" && s.sports?.length ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {s.sports.map((sp) => (
                          <SportBadge key={sp} sport={sp} className="text-xs" />
                        ))}
                      </div>
                    ) : null}
                    <p className="mt-1 text-xs text-muted">
                      {s.issued_at
                        ? t("Issued by {name} · {when}", { name: s.issued_by ?? "-", when: when(s.issued_at) })
                        : t("Seeded account")}{" "}
                      · {s.open_sessions === 1 ? t("1 open session") : t("{n} open sessions", { n: s.open_sessions })}
                    </p>
                  </div>
                </div>
                {managed ? (
                  <RowActions
                    primary={{
                      label: t("Role"),
                      onClick: () => setEditing(s),
                    }}
                    secondary={[
                      ...(s.role === "coach"
                        ? [{ label: t("Certifications"), onClick: () => setCertsOf(s) }]
                        : []),
                      {
                        label: t("Reset password"),
                        onClick: () => void act(s, "reset"),
                      },
                      {
                        label: t("Sign out everywhere"),
                        disabled: !s.open_sessions,
                        onClick: () => void act(s, "revoke"),
                      },
                      s.status === "active"
                        ? {
                            label: t("Lock"),
                            danger: true,
                            confirm: t("Are you sure you want to lock this account?"),
                            onClick: () => void act(s, "lock"),
                          }
                        : {
                            label: t("Unlock"),
                            onClick: () => void act(s, "unlock"),
                          },
                    ]}
                  />
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
      <Pagination
        offset={offset}
        total={read.data?.total ?? 0}
        pageSize={pageSize}
        onChange={setOffset}
        onPageSizeChange={setPageSize}
        label={t("Staff pages")}
      />
      </div>

      <CreateModal
        open={creating}
        defaultRole={createRole}
        onClose={() => setCreating(false)}
        onDone={(i) => {
          setCreating(false);
          setIssued(i);
          read.reload();
        }}
      />
      <CertificationsModal
        coachId={certsOf?.id ?? null}
        coachName={certsOf?.full_name ?? ""}
        onClose={() => setCertsOf(null)}
      />
      <RoleModal
        staff={editing}
        onClose={() => setEditing(null)}
        onDone={() => {
          setEditing(null);
          read.reload();
        }}
      />
      <Modal
        open={!!issued}
        onClose={() => setIssued(null)}
        title={t("Hand this over now")}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                if (issued) {
                  navigator.clipboard.writeText(issued.password);
                  toast.success(t("Copied to clipboard"));
                }
              }}
            >
              <Copy className="mr-1.5 size-4" />
              {t("Copy")}
            </Button>
            <Button onClick={() => setIssued(null)}>{t("Done")}</Button>
          </div>
        }
      >
        {issued ? (
          <div className="grid gap-3 text-sm">
            <p>{issued.why}</p>
            <dl className="grid grid-cols-[6rem_1fr] items-center gap-y-2">
              <dt className="text-muted">{t("Account")}</dt>
              <dd className="font-medium">{issued.name}</dd>
              <dt className="text-muted">{t("Sign in with")}</dt>
              <dd className="tabular-nums">{issued.phone}</dd>
              <dt className="text-muted">{t("Temporary password")}</dt>
              <dd className="flex items-center gap-2">
                <span className="select-all rounded-[var(--radius-sm)] border border-line bg-wood px-2 py-1 font-mono text-base font-semibold">
                  {issued.password}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    navigator.clipboard.writeText(issued.password);
                    toast.success(t("Copied to clipboard"));
                  }}
                  title={t("Copy")}
                >
                  <Copy className="size-4" />
                </Button>
              </dd>
            </dl>
            <p className="text-xs text-muted">
              {t("This is the only time it is shown. They will be asked to choose their own at first sign-in.")}
            </p>
          </div>
        ) : null}
      </Modal>
    </Shell>
  );
}

/**
 * Làm gì: Hiển thị danh sách nút chọn nhanh (chip/pill) các môn thể thao mà huấn luyện viên có thể giảng dạy, cho phép chọn nhiều môn hoặc chọn tất cả ("all").
 * Được gọi ở: src/routes/manager.staff.tsx (component CreateModal tại dòng 478 và component RoleModal tại dòng 593).
 * @param value Danh sách mã định danh các môn thể thao đang được chọn (ví dụ: ["badminton", "pickleball"]).
 * @param onChange Hàm callback được gọi khi thay đổi lựa chọn môn thể thao, nhận vào mảng mã môn thể thao mới.
 * @returns Giao diện danh sách nút chọn môn thể thao hỗ trợ bật/tắt (toggle).
 */
function SportPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { sports } = useSports();
  // Lấy danh sách mã các môn thể thao đang hoạt động từ hook useSports và bổ sung thêm tùy chọn "all" (áp dụng cho mọi môn).
  const allChoices = [...sports.map((s) => s.code), "all"];
  return (
    <div className="flex flex-wrap gap-2">
      {allChoices.map((s) => {
        const on = value.includes(s);
        return (
          <button
            key={s}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== s) : [...value, s])}
            className={`rounded-full px-3 py-1 text-sm ${on ? "bg-accent text-accent-fg" : "bg-wood text-muted"}`}
          >
            {s === "all" ? t("Any sport") : sportLabel(s)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Làm gì: Modal tạo mới tài khoản nhân sự nội bộ (receptionist, coach, manager). Cho phép nhập thông tin, phân công môn dạy, tải ảnh đại diện cho HLV và hiển thị mật khẩu tạm thời sau khi tạo thành công.
 * Được gọi ở: src/routes/manager.staff.tsx (component Page tại dòng 268 khi quản lý bấm nút thêm nhân sự hoặc khi URL có query param ?create=1).
 * @param open Trạng thái đóng/mở của hộp thoại modal.
 * @param defaultRole Vai trò mặc định được chọn sẵn khi mở form (mặc định là "receptionist").
 * @param onClose Hàm callback đóng modal khi bấm Hủy hoặc đóng hộp thoại.
 * @param onDone Hàm callback nhận thông tin tài khoản bàn giao (Issued) gồm tên, SĐT và mật khẩu tạm để hiển thị cho quản lý.
 * @returns Hộp thoại modal chứa form tạo tài khoản nhân sự.
 */
function CreateModal({
  open,
  defaultRole = "receptionist",
  onClose,
  onDone,
}: {
  open: boolean;
  defaultRole?: string;
  onClose: () => void;
  onDone: (i: Issued) => void;
}) {
  // Bước 1: Khởi tạo các state lưu dữ liệu form (f), danh sách môn dạy (sports), file ảnh đại diện, lỗi kiểm tra (fe) và cờ trạng thái xử lý (busy).
  const [f, setF] = useState({ full_name: "", phone: "", email: "", role: defaultRole });
  const [sports, setSports] = useState<string[]>([]);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fe, setFe] = useState<{ field: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Làm gì: Trích xuất thông điệp lỗi của một trường nhập liệu cụ thể từ state fe nếu server trả về lỗi.
   * Được gọi ở: Thuộc tính hint của các component Field (full_name, phone, email, sports) trong CreateModal.
   * @param field Tên trường nhập liệu cần lấy thông điệp lỗi.
   * @returns Chuỗi thông báo lỗi hiển thị cho người dùng, hoặc undefined nếu trường không có lỗi.
   */
  const bad = (field: string) => (fe?.field === field ? fe.message : undefined);

  // Reset toàn bộ dữ liệu form, môn thể thao, file ảnh và lỗi kiểm tra về trạng thái ban đầu mỗi khi mở lại modal hoặc đổi vai trò mặc định.
  useEffect(() => {
    if (open) {
      setF({ full_name: "", phone: "", email: "", role: defaultRole });
      setSports([]);
      setAvatarFile(null);
      setAvatarPreview(null);
      setFe(null);
    }
  }, [open, defaultRole]);

  /**
   * Làm gì: Xử lý gửi form tạo tài khoản nhân viên mới: gọi API POST /staff, tải ảnh đại diện nếu là HLV, dọn dẹp form và kích hoạt callback bàn giao tài khoản.
   * Được gọi ở: src/routes/manager.staff.tsx (sự kiện onClick của nút "Create account" trong footer của CreateModal tại dòng 452).
   * @returns Promise không có giá trị trả về sau khi hoàn tất quy trình tạo tài khoản.
   */
  async function submit() {
    // Bước 1: Xóa thông báo lỗi cũ và bật cờ busy để khóa nút bấm, tránh gửi trùng lặp request.
    setFe(null);
    setBusy(true);
    try {
      // Bước 2: Gọi API POST /staff để tạo tài khoản nhân sự. Server sẽ sinh mật khẩu ngẫu nhiên và bật cờ must_change_password.
      const r = await apiPost<{ staff: Staff; temp_password: string }>("/staff", {
        ...f,
        email: f.email || undefined,
        sports: f.role === "coach" ? sports : undefined,
      });
      // Bước 3: Nếu là huấn luyện viên và có chọn file ảnh đại diện, tải ảnh lên endpoint /manager/site-assets/upload với slot "coach.{id}".
      if (avatarFile && f.role === "coach") {
        const fd = new FormData();
        fd.append("slot", `coach.${r.staff.id}`);
        fd.append("file", avatarFile);
        try {
          await apiPost("/manager/site-assets/upload", fd);
        } catch {
          // Lỗi tải ảnh đại diện không làm gián đoạn việc tạo tài khoản; chỉ hiển thị thông báo cảnh báo cho người dùng.
          toast.error(t("Staff created, but avatar upload failed"));
        }
      }
      // Bước 4: Reset form về trạng thái ban đầu và gọi callback onDone để mở modal hiển thị mật khẩu tạm thời cho quản lý bàn giao.
      setF({ full_name: "", phone: "", email: "", role: "receptionist" });
      setSports([]);
      setAvatarFile(null);
      setAvatarPreview(null);
      onDone({
        name: r.staff.full_name,
        phone: r.staff.phone,
        password: r.temp_password,
        why: t("{role} account created.", { role: roleLabel(r.staff.role) }),
      });
    } catch (e) {
      // Bước 5: Bắt lỗi nghiệp vụ từ server: nếu trùng SĐT/email (mã BR-01) hoặc lỗi validate trường thì gắn vào fe để hiển thị cạnh ô nhập liệu.
      if (e instanceof ApiClientError && (e.body?.field || e.body?.br === "BR-01")) {
        setFe({ field: (e.body?.field as string) || "phone", message: tServer(e.message) });
      } else {
        toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
      }
    } finally {
      // Bước 6: Luôn tắt trạng thái busy khi hoàn thành (dù thành công hay thất bại).
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("Add staff")}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {t("Create account")}
          </Button>
        </div>
      }
    >
      <div className="grid gap-3">
        <Field label={t("Role")}>
          <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="receptionist">{t("Receptionist")}</option>
            <option value="coach">{t("Coach")}</option>
            <option value="manager">{t("Manager")}</option>
          </Select>
        </Field>
        <Field label={t("Full name")} hint={bad("full_name")}>
          <Input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} />
        </Field>
        <Field label={t("Phone")} hint={bad("phone")}>
          <Input inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </Field>
        <Field label={t("Email (optional)")} hint={bad("email")}>
          <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        {f.role === "coach" ? (
          <>
            <Field label={t("Sports they teach")} hint={bad("sports")}>
              <SportPicker value={sports} onChange={setSports} />
            </Field>
            <Field label={t("Avatar")}>
              <div className="flex items-center gap-4">
                <div className="relative size-16 shrink-0 overflow-hidden rounded-full border border-line bg-wood flex items-center justify-center">
                  {avatarPreview ? (
                    <img src={avatarPreview} alt={t("Avatar")} className="size-full object-cover" />
                  ) : (
                    <span className="font-display font-bold text-muted text-sm">
                      {initials(f.full_name) || "HLV"}
                    </span>
                  )}
                </div>
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        setAvatarFile(file);
                        setAvatarPreview(URL.createObjectURL(file));
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="mr-1.5 size-4" />
                    {avatarFile ? t("Change photo") : t("Upload avatar")}
                  </Button>
                  <p className="mt-1 text-2xs text-muted">JPEG, PNG, WebP &lt; 2MB</p>
                </div>
              </div>
            </Field>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * Làm gì: Modal thay đổi vai trò (role), môn thể thao phụ trách và ảnh đại diện cho nhân sự hiện có; server sẽ tự động thu hồi phiên làm việc cũ khi đổi vai trò.
 * Được gọi ở: src/routes/manager.staff.tsx (component Page tại dòng 283 khi quản lý chọn tác vụ chỉnh sửa vai trò từ menu RowActions).
 * @param staff Đối tượng thông tin nhân sự đang được chỉnh sửa, hoặc null nếu modal đang đóng.
 * @param onClose Hàm callback đóng modal khi bấm nút Hủy hoặc đóng hộp thoại.
 * @param onDone Hàm callback thông báo hoàn tất để component Page tải lại danh sách nhân sự mới nhất.
 * @returns Hộp thoại modal chỉnh sửa vai trò nhân sự.
 */
function RoleModal({ staff, onClose, onDone }: { staff: Staff | null; onClose: () => void; onDone: () => void }) {
  // Bước 1: Khởi tạo các state lưu vai trò (role), danh sách môn dạy (sports), file ảnh đại diện mới, thông báo lỗi (fe) và cờ xử lý (busy).
  const [role, setRole] = useState("receptionist");
  const [sports, setSports] = useState<string[]>([]);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fe, setFe] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Đồng bộ thông tin vai trò và danh sách môn thể thao của nhân sự được chọn vào state form mỗi khi mở modal hoặc đổi nhân sự khác.
  useEffect(() => {
    if (staff) {
      setRole(staff.role);
      setSports(staff.sports ?? []);
      setAvatarFile(null);
      setAvatarPreview(null);
      setFe(null);
    }
  }, [staff]);

  /**
   * Làm gì: Lưu thay đổi vai trò và môn dạy qua API PATCH /staff/:id, tải ảnh đại diện mới nếu có, hiển thị thông báo thành công và đóng modal.
   * Được gọi ở: src/routes/manager.staff.tsx (sự kiện onClick của nút "Save" trong footer của RoleModal tại dòng 578).
   * @returns Promise không có giá trị trả về sau khi hoàn tất cập nhật.
   */
  async function save() {
    // Bước 1: Kiểm tra dữ liệu nhân sự tồn tại và bật cờ busy để ngăn thao tác bấm lưu nhiều lần.
    if (!staff) return;
    setBusy(true);
    try {
      // Bước 2: Gọi API PATCH /staff/:id để cập nhật vai trò mới (chỉ gửi danh sách môn thể thao khi vai trò là coach).
      await apiPatch(`/staff/${staff.id}`, { role, sports: role === "coach" ? sports : undefined });
      // Bước 3: Tải ảnh đại diện mới lên slot "coach.{id}" nếu nhân sự có vai trò HLV và quản lý có chọn file ảnh mới.
      if (avatarFile && role === "coach") {
        const fd = new FormData();
        fd.append("slot", `coach.${staff.id}`);
        fd.append("file", avatarFile);
        try {
          await apiPost("/manager/site-assets/upload", fd);
        } catch {
          // Lỗi tải ảnh đại diện không chặn tiến trình cập nhật vai trò; chỉ hiển thị thông báo cảnh báo.
          toast.error(t("Staff updated, but avatar upload failed"));
        }
      }
      // Bước 4: Thông báo thành công và gọi onDone. Lưu ý: server tự động thu hồi (revoke) các phiên đăng nhập cũ để quyền mới áp dụng ở lần đăng nhập tiếp theo.
      toast.success(t("{name} is now {role}. They were signed out.", { name: staff.full_name, role: roleLabel(role).toLowerCase() }));
      onDone();
    } catch (e) {
      // Bước 5: Bắt lỗi từ server (ví dụ: HLV vẫn còn lớp học đang mở chưa chuyển giao) và hiển thị thông báo lỗi lên form.
      setFe(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      // Bước 6: Luôn mở khóa trạng thái bận (busy) khi kết thúc tiến trình lưu.
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!staff}
      onClose={onClose}
      title={staff ? t("Role · {name}", { name: staff.full_name }) : t("Role")}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button disabled={busy} onClick={() => void save()}>{t("Save")}</Button>
        </div>
      }
    >
      <div className="grid gap-3">
        <Field label={t("Role")}>
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="receptionist">{t("Receptionist")}</option>
            <option value="coach">{t("Coach")}</option>
            <option value="manager">{t("Manager")}</option>
          </Select>
        </Field>
        {role === "coach" ? (
          <>
            <Field label={t("Sports they teach")}>
              <SportPicker value={sports} onChange={setSports} />
            </Field>
            {staff ? (
              <Field label={t("Avatar")}>
                <div className="flex items-center gap-4">
                  <div className="relative size-16 shrink-0 overflow-hidden rounded-full border border-line bg-wood flex items-center justify-center">
                    {avatarPreview ? (
                      <img src={avatarPreview} alt={t("Avatar")} className="size-full object-cover" />
                    ) : (
                      <Cover
                        slot={"coach." + staff.id}
                        fallbackInitials={initials(staff.full_name)}
                        className="size-full"
                        initialsClassName="text-sm font-bold"
                      />
                    )}
                  </div>
                  <div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          setAvatarFile(file);
                          setAvatarPreview(URL.createObjectURL(file));
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="mr-1.5 size-4" />
                      {avatarFile ? t("Change photo") : t("Upload avatar")}
                    </Button>
                    <p className="mt-1 text-2xs text-muted">JPEG, PNG, WebP &lt; 2MB</p>
                  </div>
                </div>
              </Field>
            ) : null}
          </>
        ) : null}
        {fe ? <p className="text-sm text-danger">{fe}</p> : null}
        <p className="text-xs text-muted">{t("Changing the role signs them out so the new permissions apply at the next sign-in.")}</p>
      </div>
    </Modal>
  );
}
