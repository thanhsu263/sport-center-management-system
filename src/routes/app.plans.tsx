/**
 * File: src/routes/app.plans.tsx
 * Vai trò: Giao diện và định tuyến trang danh sách gói hội viên (/app/plans) trong hệ thống Arena 3.
 * Vị trí trong app: Dành cho hội viên (role: member) xem danh sách các gói tập, so sánh chi phí trung bình mỗi tháng, áp dụng mã giảm giá (promo code) và gửi yêu cầu đăng ký mua gói mới hoặc gia hạn gói hiện tại để thanh toán tại quầy lễ tân.
 */
import { createFileRoute } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Cover } from "@/client/components/media";
import { Shell, money } from "@/client/components/shell";
import { Badge, Button, Card, EmptyState, Input, LoadError, PageHero, Skeleton } from "@/client/components/ui";
import { Lift, Stagger, StaggerItem } from "@/client/components/motion";
import { GlareHover, SpotlightCard } from "@/client/components/fx";
import { cn } from "@/client/lib/cn";
import { apiPost } from "@/client/arena3/client";
import { t, tData } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";

/**
 * Làm gì: Khởi tạo định tuyến cho trang /app/plans bằng TanStack Router, liên kết URL với component Page.
 * Được gọi ở: URL /app/plans (TanStack Router tự động đăng ký và nạp trong routeTree.gen.ts).
 * @returns Route cấu hình cho đường dẫn /app/plans.
 */
export const Route = createFileRoute("/app/plans")({
  component: Page,
});

// Cấu trúc dữ liệu thông tin gói hội viên trả về từ API /plans.
type Plan = {
  id: string;
  name: string;
  duration_months: number | null;
  duration_days: number | null;
  price_vnd: number;
};

/**
 * Làm gì: Tính toán số tháng hiệu lực của gói tập; quy đổi các gói cũ lưu theo ngày (duration_days) thành số tháng tương đương (chia 30 làm tròn, tối thiểu 1 tháng).
 * Được gọi ở: src/routes/app.plans.tsx (trong Page để xác định bestId và tính đơn giá tháng).
 * @param p Đối tượng gói hội viên (Plan).
 * @returns Số tháng hiệu lực của gói tập.
 */
/** Plans sold before months existed still carry days. */
function months(p: Plan) {
  return p.duration_months ?? Math.max(1, Math.round((p.duration_days ?? 30) / 30));
}

/**
 * Làm gì: Component giao diện trang danh sách gói hội viên, quản lý mã giảm giá, hiển thị so sánh đơn giá và xử lý yêu cầu đặt mua hoặc gia hạn gói.
 * Được gọi ở: src/routes/app.plans.tsx (trong cấu hình Route tại dòng 16).
 * @returns JSX phần tử giao diện trang gói hội viên bọc trong Shell vai trò member.
 */
function Page() {
  // Bước 1: Tải danh mục các gói tập đang mở bán (/plans) và thông tin gói hội viên hiện tại của người dùng (/me).
  const { data, error, reload } = useRead<{ items: Plan[]; member_court_fee_vnd: number }>("/plans");
  const meRead = useRead<{ subscriptions?: Array<{ id: string; status: string; plan_name: string; end_on: string }> }>("/me");
  const items = data?.items ?? null;
  // Tìm gói hội viên đang còn hiệu lực (status = 'active') để xác định trạng thái Mua mới hay Gia hạn (Extend).
  const activeSub = meRead.data?.subscriptions?.find((s) => s.status === "active");

  // Bước 2: Khởi tạo các state quản lý tiến trình đặt mua gói, danh sách gói đã đặt trong phiên và mã giảm giá.
  // Which plan is mid-request. One at a time: every order extends the one
  // membership, and two buttons spinning at once would look like two memberships.
  const [busy, setBusy] = useState<string | null>(null);
  // Plans already ordered this visit. The desk has not taken the money yet, so
  // pressing the button again does nothing useful — say so instead of firing a
  // request the rate limiter will reject.
  const [ordered, setOrdered] = useState<Record<string, string>>({});
  const [promoCode, setPromoCode] = useState("");
  // The plan that costs least per month is the one filled button on the page.
  const bestId = (items ?? []).reduce<Plan | null>(
    (b, p) => (!b || p.price_vnd / months(p) < b.price_vnd / months(b) ? p : b),
    null,
  )?.id;

  /**
   * Làm gì: Gửi yêu cầu đặt mua hoặc gia hạn gói hội viên qua API POST /subscriptions, áp dụng mã giảm giá và hướng dẫn thanh toán tại quầy lễ tân.
   * Được gọi ở: src/routes/app.plans.tsx (trong sự kiện onClick của nút Button mua/gia hạn gói tại dòng 160).
   * @param p Đối tượng gói hội viên (Plan) người dùng chọn mua.
   * @returns Promise không trả về giá trị (hiển thị thông báo thành công hoặc lỗi qua toast).
   */
  async function order(p: Plan) {
    // Bước 1: Kiểm tra trạng thái bận để ngăn chặn bấm liên tiếp (double click); đánh dấu ID gói đang gửi request.
    if (busy) return;
    setBusy(p.id);
    try {
      // Bước 2: Gửi request POST /subscriptions để tạo gói tập ở trạng thái pending, kèm mã ưu đãi nếu có.
      const res = await apiPost<{
        preview_end: string;
        amount_due_vnd: number;
        promo?: { code: string; discount_vnd: number } | null;
      }>("/subscriptions", {
        plan_id: p.id,
        ...(promoCode.trim() ? { promo_code: promoCode.trim() } : {}),
      });
      // Bước 3: Cập nhật ngày hết hạn dự kiến vào state ordered để vô hiệu hóa nút đặt lại, và hiển thị toast hướng dẫn hội viên thanh toán tại quầy.
      setOrdered((o) => ({ ...o, [p.id]: res.preview_end }));
      toast.success(
        t("Order placed, valid through {date}. Pay at the desk.", { date: res.preview_end }),
        {
          description: res.promo
            ? t("{code} takes {off} off, so you pay {total}.", {
                code: res.promo.code,
                off: money(res.promo.discount_vnd),
                total: money(res.amount_due_vnd),
              })
            : t("You pay {total}.", { total: money(res.amount_due_vnd) }),
        },
      );
    } catch (e) {
      // Bước 4: Bắt lỗi từ API (như mã giảm giá không hợp lệ hoặc vượt giới hạn rate limit) và hiển thị thông báo lỗi qua toast.
      toast.error(e instanceof Error ? e.message : t("Something went wrong"));
    } finally {
      // Bước 5: Giải phóng trạng thái bận để các nút bấm hoạt động trở lại bình thường.
      setBusy(null);
    }
  }

  // Bước 3: Render giao diện trang quản lý gói tập gồm:
  // - Banner PageHero hiển thị thống kê số lượng gói khả dụng và thời hạn gói hiện tại của hội viên.
  // - Khối trạng thái: lỗi nạp dữ liệu (LoadError) hoặc hiệu ứng chờ (Skeleton 3 cột).
  // - Ô nhập mã giảm giá (promoCode) tự động chuyển sang chữ hoa (tối đa 32 ký tự).
  // - Danh sách gói tập (SpotlightCard, Card): hiển thị tên gói, giá niêm yết, đơn giá mỗi tháng, ưu đãi giờ chơi sân và quyền tham gia lớp học.
  // - Nút hành động tương ứng: Mua mới (Buy), Gia hạn (Extend), Đang đặt (Placing order…) hoặc Đã đặt chờ thanh toán tại quầy lễ tân.
  return (
    <Shell role="member">
      <PageHero
        slot="banner.train"
        title={t("Membership plans")}
        subtitle={t("One membership, for every sport. A longer plan only costs less per month. Buying again adds to your end date.")}
        fallbackSpot="plans"
        stats={[
          {
            label: t("Available plans"),
            value: items?.length ?? 0,
          },
          {
            label: activeSub ? t("Membership ends") : t("Current plan"),
            value: activeSub ? activeSub.end_on : t("None"),
            live: Boolean(activeSub),
          },
        ]}
      />

      {error ? (
        <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
      ) : !items ? (
        <div className="grid gap-3 md:grid-cols-3">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      ) : (
        <>
        <div className="mb-4 flex max-w-sm items-center gap-2">
          <Input
            value={promoCode}
            onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
            placeholder={t("Promo code (optional)")}
            aria-label={t("Promo code")}
            autoCapitalize="characters"
            maxLength={32}
          />
        </div>
        <Stagger className="grid gap-3 md:grid-cols-3" gap={0.08}>
          {items.map((p) => {
            const best = items.length > 1 && p.id === bestId;
            return (
              <StaggerItem key={p.id} className="h-full">
              <Lift className="h-full">
              <SpotlightCard className="h-full rounded-[var(--radius-xl)]" size={340} strength={0.11}>
              <Card interactive className={cn("relative z-[2] flex h-full flex-col overflow-hidden p-0")}>
                <GlareHover>
                  <Cover slot="plan.default" alt="" scrim="none" className="h-36" />
                </GlareHover>
                <div className="flex flex-1 flex-col p-5">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-display text-2xl">{tData(p.name)}</h2>
                    {best ? <Badge tone="accent">{t("Lowest per month")}</Badge> : null}
                  </div>
                  <p className="mt-3 font-display text-3xl tabular-nums text-fg">{money(p.price_vnd)}</p>
                  <ul className="mt-4 grid gap-2 text-sm text-muted">
                    <li className="flex items-center gap-2">
                      <Check className="size-4 text-accent" strokeWidth={1.75} />
                      {t("{price} a month", { price: money(Math.round(p.price_vnd / months(p))) })}
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="size-4 text-accent" strokeWidth={1.75} />
                      {t("Courts at {fee} an hour", { fee: money(data?.member_court_fee_vnd ?? 0) })}
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="size-4 text-accent" strokeWidth={1.75} />
                      {t("Join classes that end before your plan does")}
                    </li>
                  </ul>
                  <div className="mt-auto pt-5">
                    <Button
                      className="w-full"
                      variant="primary"
                      disabled={busy !== null || ordered[p.id] !== undefined}
                      onClick={() => void order(p)}
                    >
                      {busy === p.id
                        ? t("Placing order…")
                        : ordered[p.id]
                          ? t("Ordered: pay at the desk")
                          : activeSub
                            ? t("Extend")
                            : t("Buy")}
                    </Button>
                    {ordered[p.id] ? (
                      <p className="mt-2 text-center text-xs text-muted">{t("Valid through {date}", { date: ordered[p.id] })}</p>
                    ) : null}
                  </div>
                </div>
              </Card>
              </SpotlightCard>
              </Lift>
              </StaggerItem>
            );
          })}
          {!items.length ? <EmptyState title={t("No plans on sale right now")} /> : null}
        </Stagger>

        </>
      )}
    </Shell>
  );
}
