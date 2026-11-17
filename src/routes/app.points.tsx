/**
 * File: src/routes/app.points.tsx
 * Vai trò: Trang quản lý điểm thưởng tích luỹ (Loyalty Points) dành cho hội viên (Member) trong hệ thống Arena 3.
 * Vị trí trong app:
 * - Định nghĩa route `/app/points` trong phân hệ hội viên (Shell role="member").
 * - Hiển thị số dư điểm hiện tại, phân hạng hội viên (Bronze/Silver/Gold) và tiến trình tích luỹ điểm lên hạng tiếp theo.
 * - Cung cấp chức năng đổi điểm tích luỹ lấy voucher giảm giá áp dụng khi đặt sân hoặc mua gói tập.
 * - Hiển thị nhật ký biến động điểm (cộng/trừ) có hỗ trợ phân trang theo thứ tự thời gian mới nhất.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { SectionTitle } from "@/client/components/section";
import { Shell, money, when } from "@/client/components/shell";
import { Badge, Button, Card, EmptyState, Field, Input, LoadError, PageHero, Pagination, Skeleton } from "@/client/components/ui";
import { Tilt } from "@/client/components/motion";
import { GlareHover } from "@/client/components/fx";
import { cn } from "@/client/lib/cn";
import { ApiClientError, apiPost } from "@/client/arena3/client";
import { t, tServer } from "@/client/lib/i18n";
import { usePageState } from "@/client/lib/use-page-state";
import { useRead } from "@/client/lib/use-read";

/**
 * Làm gì: Khởi tạo định tuyến cho trang /app/points bằng TanStack Router, liên kết URL với component Page để hiển thị giao diện điểm thưởng của hội viên.
 * Được gọi ở: TanStack Router (URL: `/app/points`).
 * @returns Đối tượng định nghĩa route của TanStack Router cấu hình cho trang /app/points.
 * @throws Không ném lỗi.
 */
export const Route = createFileRoute("/app/points")({ component: Page });

// Cấu trúc dữ liệu phản hồi từ API GET /me/points, bao gồm số dư điểm, phân hạng hội viên, tỷ lệ quy đổi và danh sách lịch sử điểm.
type Data = {
  points: number;
  earned: number;
  spend_vnd: number;
  tier: "bronze" | "silver" | "gold";
  next_tier: { key: string; need: number } | null;
  earn_vnd: number;
  redeem_vnd: number;
  min_redeem: number;
  history: { id: string; points: number; reason: string; note: string | null; created_at: string; promo_code: string | null }[];
  history_total: number;
};

/**
 * Làm gì: Chuyển đổi mã định danh hạng hội viên (gold, silver, bronze) sang tên hiển thị tương ứng có hỗ trợ đa ngôn ngữ qua hàm t().
 * Được gọi ở: src/routes/app.points.tsx (trong component Page, hiển thị tại PageHero và thẻ hội viên 3D).
 * @param k Mã định danh phân hạng hội viên ('gold' | 'silver' | 'bronze').
 * @returns Tên hiển thị của hạng hội viên sau khi được dịch đa ngôn ngữ ('Gold' / 'Silver' / 'Bronze').
 * @throws Không ném lỗi.
 */
const tierName = (k: string) => (k === "gold" ? t("Gold") : k === "silver" ? t("Silver") : t("Bronze"));

/**
 * Làm gì: Component giao diện chính của trang Điểm thưởng (/app/points), hiển thị số dư điểm, hạng thành viên, form đổi điểm lấy voucher và danh sách lịch sử biến động điểm.
 * Được gọi ở: src/routes/app.points.tsx (khai báo tại Route.component phục vụ URL: `/app/points`).
 * @returns Giao diện trang quản lý điểm tích luỹ của hội viên bọc trong component Shell vai trò member.
 * @throws Không ném lỗi.
 */
function Page() {
  // Bước 1: Khởi tạo phân trang (mặc định 10 dòng/trang, lưu theo key "points.history") và gọi API GET /me/points tải dữ liệu điểm thưởng cùng lịch sử.
  const { offset, setOffset, pageSize, setPageSize } = usePageState("points.history", 10);
  // The balance comes with every page; the history pages, newest first.
  const { data: d, error, reload } = useRead<Data>(`/me/points?limit=${pageSize}&offset=${offset}`, { keepPrevious: true });
  // Bước 2: Khai báo các state cho form đổi điểm: pts (số điểm nhập), fieldErr (lỗi nhập liệu), code (mã voucher đã đổi), busy (trạng thái gửi API).
  const [pts, setPts] = useState("");
  const [fieldErr, setFieldErr] = useState<string | null>(null);
  const [code, setCode] = useState<{ code: string; value: number } | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Làm gì: Thực hiện đổi điểm thưởng lấy mã giảm giá (voucher) bằng cách gọi API POST /me/points/redeem, hiển thị mã mới tạo và làm mới dữ liệu điểm.
   * Được gọi ở: src/routes/app.points.tsx (sự kiện onClick của nút Button "Get a code" trong form đổi điểm).
   * @returns Không trả về giá trị (Promise<void>).
   * @throws Không ném lỗi ra ngoài; bắt lỗi từ API và lưu thông báo lỗi vào state fieldErr để hiển thị trên giao diện.
   */
  async function redeem() {
    // Bước 1: Xóa thông báo lỗi cũ và bật trạng thái busy để khóa nút bấm, tránh người dùng nhấn nhiều lần gây trùng lặp request.
    setFieldErr(null);
    setBusy(true);
    try {
      // Bước 2: Gửi request POST /me/points/redeem kèm số điểm muốn đổi để hệ thống tạo mã khuyến mãi giảm giá mới.
      const r = await apiPost<{ code: string; value_vnd: number }>("/me/points/redeem", { points: Number(pts) }, true);
      // Bước 3: Đổi điểm thành công: lưu mã voucher vào state để người dùng sao chép, xóa ô nhập điểm và gọi reload() để cập nhật lại số dư mới.
      setCode({ code: r.code, value: r.value_vnd });
      setPts("");
      reload();
    } catch (e) {
      // Bước 4: Xử lý khi có lỗi xảy ra (ví dụ: không đủ điểm hoặc nhập ít hơn mức tối thiểu min_redeem) và dịch thông báo lỗi sang tiếng Việt.
      setFieldErr(e instanceof ApiClientError ? e.message : e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      // Bước 5: Tắt trạng thái busy để mở lại nút bấm dù thành công hay thất bại.
      setBusy(false);
    }
  }

  // Bước 3: Chuyển chuỗi điểm nhập vào sang kiểu số (n) để kiểm tra điều kiện kích hoạt nút đổi điểm và tính trước giá trị voucher quy đổi.
  const n = Number(pts);
  // Bước 4: Render giao diện người dùng hoàn chỉnh gồm PageHero (thống kê tổng quan), thẻ thành viên 3D hiệu ứng Tilt/GlareHover, form đổi điểm và bảng lịch sử điểm.
  return (
    <Shell role="member">
      <PageHero
        slot="banner.train"
        title={t("My points")}
        subtitle={t("Every booking and plan earns points. Swap them for a discount code.")}
        fallbackSpot="receipt"
        stats={[
          {
            label: t("Points balance"),
            value: d?.points ?? 0,
            live: true,
          },
          {
            label: t("Member tier"),
            value: d ? tierName(d.tier) : "—",
          },
          {
            label: t("Redeem value"),
            value: d ? money(d.points * d.redeem_vnd) : "—",
          },
        ]}
      />

      {error ? (
        <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
      ) : !d ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <div className="mb-6">
            <Tilt>
              <GlareHover duration={1.2} className="rounded-[var(--radius-xl)]">
                <Card className="p-6 bg-surface shadow-[var(--shadow-soft)] border-accent/20">
                  <div className="flex flex-wrap items-end justify-between gap-4">
                    <div>
                      <p className="text-xs uppercase tracking-wider font-semibold text-muted">{t("Balance")}</p>
                      <p className="font-display text-5xl font-bold tabular-nums text-fg mt-1">{d.points}</p>
                      <p className="text-xs text-muted mt-1">{t("worth {amount}", { amount: money(d.points * d.redeem_vnd) })}</p>
                    </div>
                    <div className="text-right">
                      <Badge tone="accent" className="text-sm px-3 py-1 font-semibold">{tierName(d.tier)}</Badge>
                      <p className="mt-2 text-xs text-muted max-w-xs">
                        {d.next_tier
                          ? t("{n} more points to {tier}", { n: d.next_tier.need, tier: tierName(d.next_tier.key) })
                          : t("Top tier. Thank you for playing here.")}
                      </p>
                    </div>
                  </div>
                  <p className="mt-4 border-t border-line/60 pt-3 text-xs text-muted leading-relaxed">
                    {t("You earn 1 point for every {amount} you spend. 1 point is worth {value}.", { amount: money(d.earn_vnd), value: money(d.redeem_vnd) })}
                  </p>
                </Card>
              </GlareHover>
            </Tilt>
          </div>

          <Card className="mb-8 p-5">
            <p className="mb-3 font-semibold text-fg">{t("Swap points for a code")}</p>
            <div className="flex flex-wrap items-end gap-3">
              <Field label={t("Points to swap (at least {n})", { n: d.min_redeem })} hint={fieldErr ?? undefined}>
                <Input inputMode="numeric" value={pts} onChange={(e) => setPts(e.target.value)} />
              </Field>
              <Button disabled={busy || !n || n < d.min_redeem || n > d.points} onClick={() => void redeem()}>
                {n > 0 ? t("Get a {amount} code", { amount: money(n * d.redeem_vnd) }) : t("Get a code")}
              </Button>
            </div>
            {code ? (
              <div className="mt-4 rounded-[var(--radius-md)] bg-accent/10 p-4 border border-accent/30">
                <p className="text-xs text-muted">{t("Your code: {amount} off one booking or plan, valid 60 days. Type it at checkout.", { amount: money(code.value) })}</p>
                <p className="mt-1 select-all font-mono text-2xl font-bold tracking-wider text-accent-2">{code.code}</p>
              </div>
            ) : null}
          </Card>

          <SectionTitle text={t("History")} className="mb-4 font-display text-2xl" />
          {d.history.length === 0 ? (
            <EmptyState title={t("Nothing swapped yet")} hint={t("Points you swap or are given show up here.")} />
          ) : (
            <div className="relative pl-6 before:absolute before:left-2.5 before:top-3 before:bottom-3 before:w-0.5 before:bg-line">
              {d.history.map((h) => {
                const isPos = h.points > 0;
                return (
                  <div key={h.id} className="relative mb-3.5 last:mb-0">
                    <div
                      className={cn(
                        "absolute -left-6 top-3 size-5 rounded-full border-2 border-surface flex items-center justify-center text-xs font-bold shadow-xs",
                        isPos ? "bg-accent text-accent-fg" : "bg-hold text-white",
                      )}
                    >
                      {isPos ? "+" : "−"}
                    </div>
                    <Card className="flex items-center justify-between gap-3 p-3.5 text-sm transition-colors hover:border-line-strong">
                      <div>
                        <p className="font-semibold text-fg">{h.note ?? h.reason}</p>
                        <span className="block text-2xs text-muted mt-0.5">{when(h.created_at)}</span>
                      </div>
                      <span
                        className={cn(
                          "rounded-[var(--radius-pill)] px-2.5 py-1 text-xs font-bold tabular-nums",
                          isPos ? "bg-accent/10 text-accent-2" : "bg-hold/10 text-hold",
                        )}
                      >
                        {isPos ? `+${h.points}` : h.points} {t("pts")}
                      </span>
                    </Card>
                  </div>
                );
              })}
            </div>
          )}
          <Pagination
            offset={offset}
            total={d.history_total ?? 0}
            pageSize={pageSize}
            onChange={setOffset}
            onPageSizeChange={setPageSize}
            label={t("History pages")}
          />
        </>
      )}
    </Shell>
  );
}
