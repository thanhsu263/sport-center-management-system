/**
 * Quản lý phiếu bảo trì và sửa chữa cơ sở vật chất, sân bãi (Work Orders).
 * Định tuyến: /desk/maintenance (thuộc phân hệ Bàn làm việc / Vận hành).
 * Cung cấp giao diện cho lễ tân và quản lý tạo phiếu báo hỏng, đóng sân khẩn cấp
 * (kèm cảnh báo và hủy các lịch đặt sân bị ảnh hưởng), theo dõi tiến độ, ghi nhận chi phí và hoàn tất sửa chữa.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SectionTitle } from "@/client/components/section";
import { Shell, money, useSessionUser, when } from "@/client/components/shell";
import {
  Badge,
  Button,
  Card,
  Check,
  EmptyState,
  Field,
  Input,
  LoadError,
  MoneyInput,
  Modal,
  Select,
  Skeleton,
  Stat,
  Pagination,
} from "@/client/components/ui";
import { Reveal, Stagger, StaggerItem } from "@/client/components/motion";
import { ApiClientError, apiPatch, apiPost, type ApiErrorBody } from "@/client/arena3/client";
import { t, tServer } from "@/client/lib/i18n";
import { usePageState } from "@/client/lib/use-page-state";
import { useRead } from "@/client/lib/use-read";

/**
 * Làm gì: Định nghĩa route cho trang quản lý bảo trì cơ sở vật chất và sân đấu (/desk/maintenance) trong TanStack Router.
 * Được gọi ở: TanStack Router qua URL /desk/maintenance (được liên kết từ thanh điều hướng của lễ tân và quản lý).
 * @returns Route cấu hình cho trang bảo trì, gắn với component Page.
 */
export const Route = createFileRoute("/desk/maintenance")({ component: Page });

type Court = { id: string; court_code: string };
type WO = {
  id: string;
  code: string;
  court_id: string | null;
  court_code: string | null;
  title: string;
  description: string | null;
  priority: "low" | "normal" | "urgent";
  status: "open" | "in_progress" | "done" | "cancelled";
  blocks_court: boolean;
  assignee: string | null;
  cost_vnd: number;
  resolution: string | null;
  created_at: string;
  closed_at: string | null;
  reporter: string | null;
};
type Data = { items: WO[]; total: number; open: number; urgent: number; cost_month_vnd: number };

/**
 * Làm gì: Chuyển đổi mã mức độ ưu tiên ("urgent", "low", "normal") thành chuỗi nhãn hiển thị đã được bản địa hóa.
 * Được gọi ở: src/routes/desk.maintenance.tsx trong component Page (hiển thị Badge mức ưu tiên của từng phiếu bảo trì).
 * @param p Mã mức độ ưu tiên ("urgent" | "low" | "normal").
 * @returns Nhãn hiển thị tương ứng ("Khẩn cấp", "Thấp", "Bình thường") theo ngôn ngữ hiện tại.
 */
const prio = (p: string) => (p === "urgent" ? t("Urgent") : p === "low" ? t("Low") : t("Normal"));
/**
 * Làm gì: Chuyển đổi mã trạng thái phiếu bảo trì ("open", "in_progress", "done", "cancelled") thành nhãn hiển thị đã được bản địa hóa.
 * Được gọi ở: src/routes/desk.maintenance.tsx trong component Page (hiển thị Badge trạng thái của từng phiếu bảo trì).
 * @param s Mã trạng thái phiếu bảo trì ("open" | "in_progress" | "done" | "cancelled").
 * @returns Nhãn hiển thị trạng thái tương ứng theo ngôn ngữ hiện tại.
 */
const stat = (s: string) => (s === "open" ? t("Open") : s === "in_progress" ? t("In progress") : s === "done" ? t("Done") : t("Cancelled"));

/**
 * Làm gì: Component trang quản lý bảo trì cơ sở vật chất, cho phép tạo phiếu báo hỏng, đóng sân khẩn cấp, theo dõi trạng thái, cập nhật chi phí và hoàn tất sửa chữa.
 * Được gọi ở: src/routes/desk.maintenance.tsx trong Route /desk/maintenance.
 * @returns Giao diện React hiển thị bảng thống kê, form báo hỏng và danh sách phiếu bảo trì.
 */
function Page() {
  // Bước 1: Lấy thông tin phiên đăng nhập và xác định quyền hạn người dùng (coach chỉ được xem, manager và receptionist được phép chỉnh sửa)
  const user = useSessionUser();
  const role = user?.role === "manager" ? "manager" : user?.role === "coach" ? "coach" : "receptionist";
  const canEdit = role !== "coach";
  // Bước 2: Quản lý bộ lọc trạng thái và phân trang danh sách phiếu bảo trì
  const [filter, setFilter] = useState("active");
  const { offset, setOffset, pageSize, setPageSize, reset } = usePageState("desk.maintenance", 25);
  // Reset về trang đầu tiên mỗi khi người dùng thay đổi bộ lọc trạng thái
  useEffect(reset, [filter, reset]);
  // Bước 3: Tải danh sách phiếu bảo trì theo trang và bộ lọc, cùng danh sách sân để phục vụ biểu mẫu báo hỏng
  const woParams = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
  if (filter !== "all") woParams.set("status", filter);
  const read = useRead<Data>(`/work-orders?${woParams}`, { keepPrevious: true });
  // null = not known yet (still asking, or the question failed) — never zero tickets.
  const data = read.data;
  const courtsRead = useRead<{ items: Court[] }>("/courts");
  const courts = courtsRead.data?.items ?? [];
  // Bước 4: Khởi tạo state biểu mẫu báo hỏng mới, form đóng phiếu và modal xác nhận đóng sân
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [courtId, setCourtId] = useState("");
  const [priority, setPriority] = useState("normal");
  const [blocks, setBlocks] = useState(false);
  const [fe, setFe] = useState<{ field?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState<{ id: string; cost: string; note: string } | null>(null);
  const [confirmation, setConfirmation] = useState<{
    affected: NonNullable<ApiErrorBody["affected"]>;
    body: Record<string, unknown>;
    id?: string;
  } | null>(null);

  /**
   * Làm gì: Gửi yêu cầu tạo mới phiếu bảo trì qua API POST /work-orders; xử lý yêu cầu xác nhận nếu việc đóng sân làm ảnh hưởng đến các lượt đặt sân hoặc buổi học có sẵn.
   * Được gọi ở: src/routes/desk.maintenance.tsx trong component Page (khi nhấn nút Báo cáo sự cố hoặc nút Xác nhận đóng sân trong modal).
   * @param body Dữ liệu phiếu bảo trì cần tạo (tiêu đề, mô tả, sân, mức ưu tiên, cờ đóng sân). Mặc định lấy từ state của form.
   * @returns Không trả về giá trị (Promise<void>).
   */
  async function create(body: Record<string, unknown> = {
    title, description: desc || undefined, court_id: courtId || undefined, priority, blocks_court: blocks,
  }) {
    // Bước 1: Xóa thông báo lỗi cũ và bật trạng thái bận để vô hiệu hóa nút bấm
    setFe(null);
    setBusy(true);
    try {
      // Bước 2: Gọi API POST /work-orders để tạo mới phiếu bảo trì
      const r = await apiPost<{ code: string }>("/work-orders", body);
      // Bước 3: Đóng modal xác nhận, hiển thị thông báo thành công và xóa trắng các trường nhập liệu
      setConfirmation(null);
      toast.success(t("Ticket {code} created", { code: r.code }));
      setTitle("");
      setDesc("");
      setBlocks(false);
      // Tải lại danh sách phiếu bảo trì để hiển thị mục vừa tạo
      read.reload();
    } catch (e) {
      // Bước 4: Xử lý lỗi API; nếu server yêu cầu xác nhận do ảnh hưởng đến lịch đặt sân/buổi học, mở modal cảnh báo
      if (e instanceof ApiClientError && e.body.requires_confirm && e.body.affected) {
        setConfirmation({ affected: e.body.affected, body });
        return;
      }
      // Hiển thị lỗi validation theo từng trường hoặc lỗi chung từ server
      if (e instanceof ApiClientError) setFe({ field: e.body.field, message: e.message });
      else setFe({ message: e instanceof Error ? tServer(e.message) : t("Something went wrong") });
    } finally {
      // Bước 5: Mở lại khóa giao diện sau khi hoàn tất hoặc gặp lỗi
      setBusy(false);
    }
  }

  /**
   * Làm gì: Gửi yêu cầu cập nhật thông tin phiếu bảo trì qua API PATCH /work-orders/:id (chuyển trạng thái, cập nhật chi phí, ghi chú giải pháp hoặc xác nhận đóng sân).
   * Được gọi ở: src/routes/desk.maintenance.tsx trong component Page (khi bắt đầu sửa, hủy phiếu, mở lại phiếu, hoàn thành sửa chữa hoặc xác nhận đóng sân).
   * @param id Mã định danh (UUID) của phiếu bảo trì cần cập nhật.
   * @param body Dữ liệu cập nhật gửi lên server.
   * @param ok Thông báo toast hiển thị khi thao tác thành công (tùy chọn).
   * @returns Promise<boolean> true nếu lưu thành công, false nếu thất bại hoặc cần xác nhận thêm.
   */
  /** True when the change went through, so a form the person typed into is only closed once it has been saved. */
  async function patch(id: string, body: Record<string, unknown>, ok?: string) {
    // Bước 1: Khóa giao diện để ngăn người dùng thao tác trùng lặp
    setBusy(true);
    try {
      // Bước 2: Gọi API PATCH để cập nhật thông tin phiếu bảo trì
      await apiPatch(`/work-orders/${id}`, body);
      setConfirmation(null);
      if (ok) toast.success(ok);
      return true;
    } catch (e) {
      // Bước 3: Nếu thao tác chặn sân làm hủy các lượt đặt sân có sẵn, lưu dữ liệu để mở modal xác nhận
      if (e instanceof ApiClientError && e.body.requires_confirm && e.body.affected) {
        setConfirmation({ affected: e.body.affected, body, id });
        return false;
      }
      // Hiển thị thông báo lỗi nếu cập nhật thất bại
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
      return false;
    } finally {
      // Bước 4: Mở khóa giao diện và luôn tải lại dữ liệu để đồng bộ với server
      setBusy(false);
      // Either way the list is asked again: after a refusal it may be someone else's change that got in first.
      read.reload();
    }
  }

  // The server applies the view ("active" = open or in progress) and pages it.
  const shown = data?.items ?? [];
  /**
   * Làm gì: Lấy thông báo lỗi validation từ state của form tương ứng với tên trường nhập liệu cụ thể.
   * Được gọi ở: src/routes/desk.maintenance.tsx trong component Page (truyền vào prop hint của các trường nhập liệu title, priority).
   * @param k Tên trường cần lấy thông báo lỗi (ví dụ: "title", "priority").
   * @returns Chuỗi thông báo lỗi nếu trường bị lỗi, ngược lại trả về undefined.
   */
  const f = (k: string) => (fe?.field === k ? fe.message : undefined);

  // Bước 5: Render giao diện người dùng gồm modal xác nhận đóng sân, form báo hỏng, thống kê và danh sách phiếu bảo trì
  return (
    <Shell
      role={role}
      title={t("Maintenance")}
      subtitle={t("Report what is broken. A ticket can take a court out of booking until it is fixed.")}
    >
      <Modal open={!!confirmation} onClose={() => { if (!busy) setConfirmation(null); }} title={t("Block this court?")}>
        {confirmation ? <div className="space-y-4">
          <p>{t("{bookings} bookings will be cancelled. Refunds are collected in cash at the front desk. {sessions} class sessions need moving or cancelling by the manager and coach.", {
            bookings: confirmation.affected.booking_count, sessions: confirmation.affected.session_count,
          })}</p>
          <p className="text-sm text-muted">{t("First affected start times")}</p>
          <ul className="space-y-2 text-sm">
            {confirmation.affected.bookings.map((b) => <li key={b.id}>{t("Booking")} {b.code} · {when(b.start_at)}</li>)}
            {confirmation.affected.sessions.map((s) => <li key={s.id}>{t("Class session")} · {when(s.start_at)}</li>)}
          </ul>
          {fe ? <p role="alert" className="text-sm text-danger">{fe.message}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => {
              const body = { ...confirmation.body, confirm: true };
              void (confirmation.id ? patch(confirmation.id, body) : create(body));
            }}>{t("Confirm court closure")}</Button>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>{t("Back")}</Button>
          </div>
        </div> : null}
      </Modal>
      <Reveal from="down">
        <Card className="mb-4 grid gap-3 md:grid-cols-4">
          <div className="md:col-span-2">
            <Field label={t("What is wrong?")} hint={f("title")}>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("e.g. Net on court 3 is torn")} />
            </Field>
          </div>
          <Field label={t("Court")} hint={courtsRead.error?.message}>
            <Select value={courtId} onChange={(e) => setCourtId(e.target.value)}>
              <option value="">{t("Not about one court")}</option>
              {courts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.court_code}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("How urgent?")} hint={f("priority")}>
            <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="low">{t("Low")}</option>
              <option value="normal">{t("Normal")}</option>
              <option value="urgent">{t("Urgent")}</option>
            </Select>
          </Field>
          <div className="md:col-span-3">
            <Field label={t("Details (optional)")}>
              <Input value={desc} onChange={(e) => setDesc(e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-col justify-end gap-2">
            <Check checked={blocks} disabled={!courtId} onChange={(e) => setBlocks(e.target.checked)} label={t("Close the court until fixed")} />
            <Button disabled={busy || !title.trim()} onClick={() => void create()}>
              {t("Report it")}
            </Button>
          </div>
          {fe && !fe.field ? <p role="alert" className="text-sm text-danger md:col-span-4">{fe.message}</p> : null}
        </Card>
      </Reveal>

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Stat label={t("Open tickets")} value={data ? String(data.open) : "-"} />
        <Stat label={t("Urgent")} value={data ? String(data.urgent) : "-"} />
        <Stat label={t("Repair cost this month")} value={data ? money(data.cost_month_vnd) : "-"} />
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SectionTitle text={t("Tickets")} className="font-display text-2xl" />
        <Select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t("Show")}>
          <option value="active">{t("Still to fix")}</option>
          <option value="done">{t("Done")}</option>
          <option value="all">{t("All")}</option>
        </Select>
      </div>

      {read.error ? (
        <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />
      ) : !data ? (
        <Skeleton className="h-24" />
      ) : shown.length === 0 ? (
        <EmptyState title={t("Nothing here")} hint={t("No tickets match this view.")} />
      ) : (
        <Stagger className="grid gap-2" gap={0.04}>
          {shown.map((w) => (
            <StaggerItem key={w.id}>
              <Card className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {w.title} <span className="font-mono text-xs text-muted">{w.code}</span>
                    </p>
                    <p className="text-xs text-muted">
                      {w.court_code ?? t("General")} · {w.reporter ?? "-"} · {when(w.created_at)}
                      {w.assignee ? ` · ${w.assignee}` : ""}
                    </p>
                    {w.description ? <p className="mt-1 text-sm">{w.description}</p> : null}
                    {w.resolution ? <p className="mt-1 text-sm text-muted">{w.resolution}</p> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {w.blocks_court && (w.status === "open" || w.status === "in_progress") ? <Badge tone="danger">{t("Court closed")}</Badge> : null}
                    <Badge tone={w.priority === "urgent" ? "danger" : w.priority === "low" ? "muted" : "hold"}>{prio(w.priority)}</Badge>
                    <Badge tone={w.status === "done" ? "accent" : w.status === "cancelled" ? "muted" : "ink"}>{stat(w.status)}</Badge>
                    {w.cost_vnd > 0 ? <span className="text-xs tabular-nums text-muted">{money(w.cost_vnd)}</span> : null}
                  </div>
                </div>
                {canEdit && (w.status === "open" || w.status === "in_progress") ? (
                  closing?.id === w.id ? (
                    <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_2fr_auto_auto] sm:items-end">
                      <Field label={t("Cost (đ)")}>
                        <MoneyInput value={closing.cost} onChange={(v) => setClosing({ ...closing, cost: v })} />
                      </Field>
                      <Field label={t("What was done?")}>
                        <Input value={closing.note} onChange={(e) => setClosing({ ...closing, note: e.target.value })} />
                      </Field>
                      <Button
                        size="sm"
                        onClick={() => {
                          void patch(w.id, { status: "done", cost_vnd: Number(closing.cost) || 0, resolution: closing.note }, t("Ticket closed")).then((saved) => {
                            if (saved) setClosing(null);
                          });
                        }}
                      >
                        {t("Mark done")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setClosing(null)}>
                        {t("Back")}
                      </Button>
                    </div>
                  ) : (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {w.status === "open" ? (
                        <Button size="sm" variant="outline" onClick={() => void patch(w.id, { status: "in_progress" })}>
                          {t("Start work")}
                        </Button>
                      ) : null}
                      <Button size="sm" onClick={() => setClosing({ id: w.id, cost: "", note: "" })}>
                        {t("Fixed")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => void patch(w.id, { status: "cancelled" }, t("Ticket cancelled"))}>
                        {t("Cancel ticket")}
                      </Button>
                    </div>
                  )
                ) : null}
                {canEdit && (w.status === "done" || w.status === "cancelled") ? (
                  <Button className="mt-3" size="sm" variant="outline" disabled={busy} onClick={() => void patch(w.id, { status: "open" })}>
                    {t("Reopen ticket")}
                  </Button>
                ) : null}
              </Card>
            </StaggerItem>
          ))}
        </Stagger>
      )}
      <Pagination
        offset={offset}
        total={data?.total ?? 0}
        pageSize={pageSize}
        onChange={setOffset}
        onPageSizeChange={setPageSize}
        label={t("Ticket pages")}
      />
    </Shell>
  );
}
