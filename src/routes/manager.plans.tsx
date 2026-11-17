/**
 * File: src/routes/manager.plans.tsx
 * Vai trò: Trang quản lý danh mục gói hội viên (membership plans) dành cho vai trò manager trong hệ thống Lê Long Sport (Arena 3).
 * Vị trí trong app: Tuyến đường /manager/plans; cho phép xem danh sách gói tập, xem số lượng hội viên đang sở hữu, bật/tắt mở bán và tạo mới gói tập.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { monthsLabel } from "@/shared/arena3/labels";
import { toast } from "sonner";
import { Cover } from "@/client/components/media";
import { Shell, money } from "@/client/components/shell";
import { PageHero } from "@/client/components/page-hero";
import { StatStrip } from "@/client/components/stat-strip";
import { Badge, Button, Card, Check, EmptyState, Field, Input, LoadError, Modal, MoneyInput, Skeleton } from "@/client/components/ui";
import { Lift, Stagger, StaggerItem } from "@/client/components/motion";
import { GlareHover, SpotlightCard } from "@/client/components/fx";
import { ApiClientError, apiGet, apiPatch, apiPost } from "@/client/arena3/client";
import { t, tk, tServer, tData } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";

/**
 * Làm gì: Định nghĩa route cho trang quản lý gói tập (/manager/plans) qua TanStack Router, liên kết URL với component Page.
 * Được gọi ở: URL /manager/plans (TanStack Router tự động nạp qua src/routeTree.gen.ts).
 * @returns Route configuration của TanStack Router cho đường dẫn /manager/plans.
 * @throws Không ném lỗi.
 */
export const Route = createFileRoute("/manager/plans")({
  component: Page,
});

type Plan = {
  id: string;
  name: string;
  price_vnd: number;
  is_on_sale: boolean;
  duration_months: number | null;
  duration_days: number | null;
};

// Giá trị khởi tạo mặc định cho form tạo gói tập mới: gói 1 tháng, giá 500.000đ, mặc định mở bán ngay.
const emptyForm = {
  name: "",
  price_vnd: "500000",
  duration_months: "1",
  is_on_sale: true,
};

/** Plans sold before months existed still carry days. */
function lasts(p: Plan) {
  // Ưu tiên duration_months; nếu là dữ liệu cũ chỉ có duration_days thì quy đổi sang tháng (30 ngày/tháng, tối thiểu 1 tháng).
  return p.duration_months ?? Math.max(1, Math.round((p.duration_days ?? 30) / 30));
}

type Detail = {
  plan: Plan;
  holders: { active: number; pending: number; frozen: number; ever: number };
};

/**
 * Làm gì: Component giao diện chính của trang quản lý gói tập (/manager/plans), cho phép xem danh sách, thống kê, tạo mới, bật/tắt mở bán và xem chi tiết gói tập.
 * Được gọi ở: Thuộc tính component của Route trong file này (src/routes/manager.plans.tsx dòng 17).
 * @returns JSX element hiển thị toàn bộ trang quản lý gói tập bọc trong Shell role="manager".
 * @throws Không ném lỗi ra ngoài; các lỗi tải dữ liệu hoặc gọi API được xử lý qua toast và component LoadError.
 */
function Page() {
  // Bước 1: Khởi tạo dữ liệu và state: nạp danh sách gói tập từ API GET /plans qua hook useRead, cùng các state quản lý modal, form và chi tiết gói.
  const read = useRead<{ items: Plan[] }>("/plans");
  const items = read.data?.items ?? null;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [fe, setFe] = useState<{ field: string; message: string } | null>(null);
  /**
   * Làm gì: Trích xuất thông báo lỗi validate của một trường (field) cụ thể từ state fe nếu server báo lỗi trên trường đó.
   * Được gọi ở: Thuộc tính hint của các component Field trong form tạo gói mới (dòng 187, 195, 198).
   * @param f Tên trường cần lấy thông báo lỗi (ví dụ: "name", "price_vnd", "duration_months").
   * @returns Chuỗi thông báo lỗi nếu trường f trùng khớp với lỗi từ server, ngược lại trả về undefined.
   * @throws Không ném lỗi.
   */
  const bad = (f: string) => (fe?.field === f ? fe.message : undefined);

  /**
   * Làm gì: Tải thông tin chi tiết của một gói tập kèm số lượng hội viên đang giữ gói (active, pending, frozen, ever) từ API GET /plans/:id và mở modal chi tiết.
   * Được gọi ở: Nút "Details" trên từng card gói tập (dòng 156).
   * @param id Mã định danh UUID của gói tập cần xem chi tiết.
   * @returns Promise<void>
   * @throws Không ném lỗi ra ngoài; tự bắt lỗi và hiển thị toast thông báo nếu không tải được thông tin gói.
   */
  async function openDetail(id: string) {
    try {
      // Bước 1: Gọi API GET /plans/:id để lấy dữ liệu gói tập và thống kê người sở hữu, sau đó cập nhật vào state detail để mở Modal.
      setDetail(await apiGet<Detail>(`/plans/${id}`));
    } catch (e) {
      // Bước 2: Bắt lỗi nếu gọi API thất bại: hiển thị thông báo lỗi qua toast (ưu tiên thông điệp dịch từ server qua tServer).
      toast.error(e instanceof Error ? tServer(e.message) : t("Could not open that plan"));
    }
  }

  /**
   * Làm gì: Bật hoặc tắt trạng thái mở bán của gói tập qua API PATCH /plans/:id; gói ngừng bán sẽ ẩn khỏi app thành viên nhưng hội viên cũ vẫn tiếp tục sử dụng.
   * Được gọi ở: Nút "Stop selling" / "Sell again" trên card gói tập (dòng 159) và nút toggle trong modal chi tiết gói (dòng 221).
   * @param p Đối tượng gói tập Plan cần cập nhật trạng thái bán.
   * @param on Trạng thái mở bán mới (true: mở bán lại, false: ngừng bán).
   * @returns Promise<void>
   * @throws Không ném lỗi ra ngoài; tự bắt lỗi và hiển thị toast thông báo nếu cập nhật thất bại.
   */
  async function setSale(p: Plan, on: boolean) {
    try {
      // Bước 1: Gửi request PATCH /plans/:id để cập nhật cờ is_on_sale trên server.
      await apiPatch(`/plans/${p.id}`, { is_on_sale: on });
      // Bước 2: Hiển thị toast thông báo thành công tương ứng: thông báo mở bán lại hoặc thông báo ngừng bán (hội viên cũ vẫn giữ gói).
      toast.success(
        on
          ? t("{name} is on sale again", { name: tData(p.name) })
          : t("{name} is no longer sold. Members who hold it keep it.", { name: tData(p.name) }),
      );
      // Bước 3: Tải lại danh sách gói tập và cập nhật state detail nếu modal chi tiết đang mở đúng gói này.
      read.reload();
      setDetail((d) => (d && d.plan.id === p.id ? { ...d, plan: { ...d.plan, is_on_sale: on } } : d));
    } catch (e) {
      // Bước 4: Xử lý lỗi: hiển thị toast thông báo lỗi dịch từ server (tServer) nếu cập nhật trạng thái thất bại.
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    }
  }

  /**
   * Làm gì: Xử lý submit form tạo gói tập mới, gửi request POST /plans lên server, làm mới danh sách và đóng modal khi thành công.
   * Được gọi ở: Nút "Create plan" trong Modal tạo gói tập mới (dòng 180).
   * @returns Promise<void>
   * @throws Không ném lỗi ra ngoài; bắt ApiClientError để gán lỗi inline vào từng trường nhập liệu hoặc hiển thị toast lỗi chung.
   */
  async function create() {
    // Bước 1: Xóa lỗi trường cũ và bật cờ busy để khóa nút submit, ngăn người dùng click liên tiếp gây trùng request.
    setFe(null);
    setBusy(true);
    try {
      // Bước 2: Gửi request POST /plans tạo gói tập mới. Dữ liệu số được giữ nguyên dạng chuỗi để server validate và chỉ rõ trường bị sai.
      // Sent as typed: the server names the field that is wrong, so a typo
      // reaches the person who made it instead of quietly becoming a zero.
      await apiPost("/plans", {
        name: form.name.trim(),
        price_vnd: form.price_vnd,
        duration_months: form.duration_months,
        is_on_sale: form.is_on_sale,
      });
      // Bước 3: Tạo gói thành công: hiển thị toast, đóng modal, reset form về giá trị ban đầu và tải lại danh sách gói tập.
      toast.success(t("Plan created"));
      setOpen(false);
      setForm(emptyForm);
      read.reload();
    } catch (e) {
      // Bước 4: Bắt lỗi từ API: nếu server chỉ rõ trường bị sai (e.body.field), hiển thị lỗi inline dưới trường đó; ngược lại hiển thị toast lỗi chung.
      if (e instanceof ApiClientError && e.body.field) setFe({ field: e.body.field, message: tServer(e.message) });
      else toast.error(e instanceof Error ? tServer(e.message) : t("Could not create the plan"));
    } finally {
      // Bước 5: Luôn giải phóng trạng thái chờ (busy = false) dù request thành công hay thất bại.
      setBusy(false);
    }
  }

  // Bước 2: Tính toán các số liệu thống kê: tổng số gói, số gói đang mở bán và số gói đã ngừng bán để hiển thị trên StatStrip.
  const totalPlans = items?.length ?? 0;
  const onSalePlans = items?.filter((p) => p.is_on_sale).length ?? 0;
  const stoppedPlans = totalPlans - onSalePlans;

  // Bước 3: Render giao diện quản lý gói tập: PageHero giới thiệu trang, StatStrip thống kê, danh sách card gói tập và các Modal tạo mới / chi tiết.
  return (
    <Shell role="manager">
      <PageHero
        slot="banner.manager"
        title={t("Membership plans")}
        subtitle={t("Plans are never deleted: one you stop selling leaves the app, and members who hold it keep it.")}
        className="mb-6"
      />

      <StatStrip
        stats={[
          { label: tk("Available plans"), value: onSalePlans },
          { label: tk("Total plans"), value: totalPlans },
          { label: tk("Not for sale"), value: stoppedPlans },
        ]}
        className="mb-6"
      />

      <div className="mb-4 flex justify-end">
        <Button onClick={() => setOpen(true)}>{t("New plan")}</Button>
      </div>
      {read.error ? (
        <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />
      ) : !items ? (
        <Skeleton className="h-48" />
      ) : !items.length ? (
        <EmptyState title={t("No plans yet")} hint={t("Create the first plan so members can buy a membership in the app.")}>
          <Button onClick={() => setOpen(true)}>{t("New plan")}</Button>
        </EmptyState>
      ) : null}
      <Stagger className="grid gap-3 md:grid-cols-3" gap={0.07}>
        {(items ?? []).map((p) => (
          <StaggerItem key={p.id} className="h-full">
          <Lift className="h-full">
          <SpotlightCard className="h-full rounded-[var(--radius-xl)]" size={320} strength={0.1}>
          <Card interactive className="relative z-[2] flex h-full flex-col overflow-hidden p-0">
            <GlareHover>
              <Cover slot="plan.default" alt="" className="h-28" />
            </GlareHover>
            <div className="flex flex-1 flex-col p-5">
              <div className="flex items-center gap-2">
                <Badge tone={p.is_on_sale ? "accent" : "muted"}>{p.is_on_sale ? t("On sale") : t("Not for sale")}</Badge>
              </div>
              <h2 className="mt-2 font-display text-2xl">{tData(p.name)}</h2>
              <p className="mt-2 font-display text-3xl tabular-nums">{money(p.price_vnd)}</p>
              <p className="mt-2 text-sm text-muted">
                {monthsLabel(lasts(p))}
              </p>
              <div className="mt-auto flex gap-2 pt-4">
                <Button variant="outline" onClick={() => void openDetail(p.id)}>
                  {t("Details")}
                </Button>
                <Button variant="ghost" onClick={() => void setSale(p, !p.is_on_sale)}>
                  {p.is_on_sale ? t("Stop selling") : t("Sell again")}
                </Button>
              </div>
            </div>
          </Card>
          </SpotlightCard>
          </Lift>
          </StaggerItem>
        ))}
      </Stagger>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("New membership plan")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button disabled={busy} onClick={() => void create()}>
              {busy ? t("Saving…") : t("Create plan")}
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <Field label={t("Plan name")} hint={bad("name")}>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t("3 months")}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("Price (đ)")} hint={bad("price_vnd")}>
              <MoneyInput value={form.price_vnd} onChange={(v) => setForm({ ...form, price_vnd: v })} />
            </Field>
            <Field label={t("Duration (months)")} hint={bad("duration_months")}>
              <Input
                inputMode="numeric"
                value={form.duration_months}
                onChange={(e) => setForm({ ...form, duration_months: e.target.value })}
              />
            </Field>
          </div>
          <Check
            checked={form.is_on_sale}
            onChange={(e) => setForm({ ...form, is_on_sale: e.target.checked })}
            label={t("Put it on sale now (members see it in the app)")}
          />
        </div>
      </Modal>

      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={tData(detail?.plan.name) ?? t("Plan")}
        footer={
          <>
            {detail ? (
              <Button variant="outline" onClick={() => void setSale(detail.plan, !detail.plan.is_on_sale)}>
                {detail.plan.is_on_sale ? t("Stop selling") : t("Sell again")}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setDetail(null)}>
              {t("Close")}
            </Button>
          </>
        }
      >
        {detail ? (
          <div className="grid gap-4 text-sm">
            <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-2">
              <dt className="text-muted">{t("Status")}</dt>
              <dd>
                <Badge tone={detail.plan.is_on_sale ? "accent" : "muted"}>
                  {detail.plan.is_on_sale ? t("On sale") : t("Not for sale")}
                </Badge>
              </dd>
              <dt className="text-muted">{t("Price")}</dt>
              <dd className="tabular-nums">{money(detail.plan.price_vnd)}</dd>
              <dt className="text-muted">{t("Lasts")}</dt>
              <dd>{monthsLabel(lasts(detail.plan))}</dd>
            </dl>
            <p className="rounded-[var(--radius-md)] bg-wood px-3 py-2">
              <span className="font-medium tabular-nums">{detail.holders.active}</span> {t("active")} ·{" "}
              <span className="font-medium tabular-nums">{detail.holders.pending}</span> {t("waiting for payment")} ·{" "}
              <span className="font-medium tabular-nums">{detail.holders.frozen}</span> {t("frozen")} ·{" "}
              <span className="tabular-nums">{detail.holders.ever}</span> {t("sold in total")}
            </p>
            <p className="text-xs text-muted">
              {t("Stopping sales hides the plan from members and blocks new orders. People who already hold it keep it, and a plan is never deleted.")}
            </p>
          </div>
        ) : null}
      </Modal>
    </Shell>
  );
}
