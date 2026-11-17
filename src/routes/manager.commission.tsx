/**
 * Quản lý hoa hồng và thù lao cho huấn luyện viên (Coach commission).
 * Màn hình thuộc vai trò Manager (/manager/commission), cung cấp các chức năng:
 * - Xem báo cáo tổng hợp thù lao huấn luyện viên theo từng chu kỳ tháng (YYYY-MM).
 * - Cập nhật mức đơn giá dạy theo buổi (per class) và theo học viên (per student).
 * - Chốt số liệu hoa hồng của tháng đã kết thúc (close) để khóa số liệu không bị sửa đổi.
 * - Đánh dấu đã chi trả tiền hoa hồng (mark paid) cho từng huấn luyện viên.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SectionTitle } from "@/client/components/section";
import { Shell, money, when } from "@/client/components/shell";
import { Badge, Button, Card, EmptyState, Field, LoadError, MoneyInput, Skeleton, Stat } from "@/client/components/ui";
import { Reveal } from "@/client/components/motion";
import { apiPatch, apiPost } from "@/client/arena3/client";
import { t, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";

/**
 * Làm gì: Định nghĩa route cho trang quản lý hoa hồng huấn luyện viên (/manager/commission).
 * Được gọi ở: TanStack Router (URL: /manager/commission).
 * @returns Đối tượng route được cấu hình với component Page.
 */
export const Route = createFileRoute("/manager/commission")({ component: Page });

type Row = {
  coach_id: string;
  coach_name: string;
  per_session_vnd: number;
  per_student_vnd: number;
  sessions: number;
  students: number;
  amount_vnd: number;
  payout_status: "closed" | "paid" | null;
  paid_at: string | null;
};
type Report = { period: string; current: string; items: Row[]; total_vnd: number };

/**
 * Làm gì: Tính toán chu kỳ tháng mới bằng cách cộng hoặc trừ số tháng so với chu kỳ ban đầu.
 * Được gọi ở: Page component trong src/routes/manager.commission.tsx (nút chuyển tháng trước/sau).
 * @param p Chuỗi chu kỳ tháng hiện tại theo định dạng "YYYY-MM" (ví dụ: "2026-11").
 * @param by Số lượng tháng cần dịch chuyển (ví dụ: -1 để lùi 1 tháng, 1 để tiến 1 tháng).
 * @returns Chuỗi chu kỳ tháng mới theo định dạng "YYYY-MM".
 */
function shiftMonth(p: string, by: number) {
  const [y, m] = p.split("-").map(Number) as [number, number];
  // Dùng Date.UTC vào ngày 1 của tháng để tránh lệch múi giờ và tránh lỗi tràn ngày khi số ngày các tháng khác nhau
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Làm gì: Hiển thị giao diện quản lý hoa hồng huấn luyện viên, hỗ trợ xem báo cáo theo tháng, điều chỉnh đơn giá, chốt số liệu và ghi nhận thanh toán.
 * Được gọi ở: TanStack Router qua Route trong src/routes/manager.commission.tsx (URL: /manager/commission).
 * @returns Giao diện bảng điều khiển hoa hồng huấn luyện viên được bọc trong Shell component.
 */
function Page() {
  // Bước 1: Khởi tạo state và truy vấn báo cáo hoa hồng từ API theo chu kỳ tháng
  // null asks for "this month": the server says which one that is, and the answer names it.
  const [asked, setAsked] = useState<string | null>(null);
  const [rates, setRates] = useState<Record<string, { s: string; p: string }>>({});
  const [busy, setBusy] = useState(false);
  const read = useRead<Report>(`/commission${asked ? `?period=${asked}` : ""}`);
  const data = read.data;
  // Ưu tiên chu kỳ chuẩn do server trả về, fallback về chu kỳ người dùng đang yêu cầu nếu chưa tải xong
  const period = data?.period ?? asked;

  // Bước 2: Đồng bộ đơn giá thù lao của từng HLV từ server vào state nội bộ để người dùng chỉnh sửa
  // The rate boxes start from what the server holds and are the person's to edit from there.
  useEffect(() => {
    if (!data) return;
    setRates(Object.fromEntries(data.items.map((x) => [x.coach_id, { s: String(x.per_session_vnd), p: String(x.per_student_vnd) }])));
  }, [data]);

  /**
   * Làm gì: Thực thi tác vụ gọi API bất đồng bộ, quản lý trạng thái loading, hiển thị thông báo toast và làm mới lại dữ liệu.
   * Được gọi ở: Page component trong src/routes/manager.commission.tsx (các nút Chốt tháng, Lưu đơn giá, Đánh dấu đã trả).
   * @param fn Hàm bất đồng bộ gọi API cần thực hiện.
   * @param ok Chuỗi thông báo thành công hiển thị cho người dùng qua toast.
   * @returns Promise<void> hoàn thành khi tác vụ kết thúc.
   */
  async function run(fn: () => Promise<unknown>, ok: string) {
    // Bước 1: Đặt cờ busy = true để vô hiệu hóa các nút bấm, ngăn người dùng click lặp lại
    setBusy(true);
    try {
      // Bước 2: Thực thi tác vụ API, hiển thị toast thành công và tải lại dữ liệu mới nhất từ server
      await fn();
      toast.success(ok);
      read.reload();
    // Bước 3: Bắt lỗi nếu gọi API thất bại, chuyển đổi thông báo lỗi phù hợp qua tServer và hiển thị toast
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    // Bước 4: Luôn giải phóng cờ busy để người dùng tiếp tục thao tác
    } finally {
      setBusy(false);
    }
  }

  // Bước 3: Kiểm tra các điều kiện nghiệp vụ để cho phép chốt sổ tháng
  // Chỉ tháng đã kết thúc (period < current) mới được chốt; tháng hiện tại vẫn còn phát sinh buổi dạy
  const ended = data ? data.period < data.current : false;
  // Đếm số HLV có dạy trong tháng (sessions > 0) nhưng chưa chốt sổ hoặc thanh toán (!payout_status)
  const open = data?.items.filter((r) => !r.payout_status && r.sessions > 0).length ?? 0;

  // Bước 4: Render giao diện với thanh chuyển tháng, thẻ thống kê tổng quan và danh sách chi tiết hoa hồng từng HLV
  return (
    <Shell
      role="manager"
      title={t("Coach commission")}
      subtitle={t("Paid per class taught plus a little for each student who turned up. Close the month, then mark it paid.")}
    >
      <Reveal from="down">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className="min-w-11" aria-label={t("Previous month")} disabled={!period} onClick={() => period && setAsked(shiftMonth(period, -1))}>
            ←
          </Button>
          <span className="min-w-28 text-center font-display text-xl tabular-nums">{period ?? "…"}</span>
          <Button variant="outline" size="sm" className="min-w-11" aria-label={t("Next month")} disabled={!period || !data || period >= data.current} onClick={() => period && setAsked(shiftMonth(period, 1))}>
            →
          </Button>
          {ended && open > 0 ? (
            <Button
              className="ml-auto"
              disabled={busy}
              onClick={() => void run(() => apiPost("/commission/close", { period }), t("Month closed. The figures are now locked."))}
            >
              {t("Close this month")}
            </Button>
          ) : null}
        </div>
      </Reveal>

      {read.error ? (
        <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />
      ) : !data ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <Stat label={t("To pay this month")} value={money(data.total_vnd)} />
            <Stat label={t("Classes taught")} value={String(data.items.reduce((a, r) => a + r.sessions, 0))} />
            <Stat label={t("Students counted")} value={String(data.items.reduce((a, r) => a + r.students, 0))} />
          </div>
          {!ended ? <p className="mb-3 text-xs text-muted">{t("This month is still running, so these figures can still change.")}</p> : null}

          <SectionTitle text={t("Coaches")} className="mb-3 font-display text-2xl" />
          {data.items.length === 0 ? (
            <EmptyState title={t("No coaches yet")} hint={t("Add a coach under Staff.")} />
          ) : (
            <div className="grid gap-3">
              {data.items.map((r) => {
                const rate = rates[r.coach_id] ?? { s: String(r.per_session_vnd), p: String(r.per_student_vnd) };
                const frozen = !!r.payout_status;
                return (
                  <Card key={r.coach_id} className="grid gap-3 p-4 md:grid-cols-[1.2fr_1fr_1.4fr_auto] md:items-end">
                    <div>
                      <p className="font-medium">{r.coach_name}</p>
                      <p className="text-xs text-muted">
                        {t("{n} classes", { n: r.sessions })} · {t("{n} students", { n: r.students })}
                      </p>
                      <p className="mt-1">
                        {r.payout_status === "paid" ? (
                          <Badge tone="accent">
                            {t("Paid")} {r.paid_at ? when(r.paid_at) : ""}
                          </Badge>
                        ) : r.payout_status === "closed" ? (
                          <Badge tone="hold">{t("Closed, not paid")}</Badge>
                        ) : (
                          <Badge tone="muted">{t("Open")}</Badge>
                        )}
                      </p>
                    </div>
                    <div className="font-display text-2xl tabular-nums">{money(r.amount_vnd)}</div>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label={t("Per class")}>
                        <MoneyInput
                          disabled={frozen}
                          value={rate.s}
                          onChange={(v) => setRates((m) => ({ ...m, [r.coach_id]: { ...rate, s: v } }))}
                        />
                      </Field>
                      <Field label={t("Per student")}>
                        <MoneyInput
                          disabled={frozen}
                          value={rate.p}
                          onChange={(v) => setRates((m) => ({ ...m, [r.coach_id]: { ...rate, p: v } }))}
                        />
                      </Field>
                    </div>
                    <div className="flex gap-2">
                      {!frozen ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => apiPatch(`/commission/rates/${r.coach_id}`, { per_session_vnd: Number(rate.s), per_student_vnd: Number(rate.p) }),
                              t("Rates saved"),
                            )
                          }
                        >
                          {t("Save rates")}
                        </Button>
                      ) : null}
                      {r.payout_status === "closed" ? (
                        <Button size="sm" disabled={busy} onClick={() => void run(() => apiPost(`/commission/pay/${r.coach_id}`, { period }), t("Marked as paid"))}>
                          {t("Mark paid")}
                        </Button>
                      ) : null}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}
    </Shell>
  );
}
