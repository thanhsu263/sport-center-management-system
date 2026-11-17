/**
 * File: src/routes/coach.earnings.tsx
 * Vai trò: Tuyến đường (route) hiển thị trang chi tiết thu nhập của huấn luyện viên (/coach/earnings).
 * Vị trí trong app: Thuộc phân hệ Coach, liên kết với API /me/earnings để hiển thị bảng kê thù lao theo từng tháng (thù lao buổi dạy và phụ cấp học viên), danh sách lớp đã dạy và lịch sử các đợt chi trả từ trung tâm.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SectionTitle } from "@/client/components/section";
import { Shell, money, when } from "@/client/components/shell";
import { Badge, Button, Card, EmptyState, LoadError, Skeleton, Stat } from "@/client/components/ui";
import { Reveal } from "@/client/components/motion";
import { levelLabel } from "@/shared/arena3/labels";
import { locale, t } from "@/client/lib/i18n";

/** "2026-11" is a database key; a coach reads "November 2026". */
/**
 * Làm gì: Định dạng mã chu kỳ tháng dạng "YYYY-MM" thành tên tháng và năm đầy đủ theo ngôn ngữ người dùng để hiển thị trên giao diện (ví dụ: "2026-11" thành "November 2026").
 * Được gọi ở: src/routes/coach.earnings.tsx (thanh điều hướng chuyển tháng và danh sách lịch sử quá khứ trong component Page).
 * @param period Chuỗi mã kỳ kế toán định dạng "YYYY-MM" (ví dụ: "2026-11").
 * @returns Chuỗi tên tháng và năm đã định dạng theo locale hiện tại ở múi giờ UTC.
 */
const monthName = (period: string) =>
  new Date(`${period}-01T00:00:00Z`).toLocaleDateString(locale(), { month: "long", year: "numeric", timeZone: "UTC" });
import { useRead } from "@/client/lib/use-read";

/**
 * Làm gì: Khởi tạo định nghĩa tuyến đường cho trang thu nhập của huấn luyện viên (/coach/earnings) trong TanStack Router, liên kết URL với component Page.
 * Được gọi ở: URL "/coach/earnings" (được tự động đăng ký vào cây route của ứng dụng thông qua src/routeTree.gen.ts).
 * @returns Đối tượng Route cấu hình tuyến đường của TanStack Router.
 */
export const Route = createFileRoute("/coach/earnings")({ component: Page });

// Cấu trúc dữ liệu thu nhập của HLV nhận về từ API /me/earnings (bao gồm kỳ xem, kỳ hiện tại, thống kê thù lao, danh sách buổi dạy và lịch sử thanh toán)
type Data = {
  period: string;
  current: string;
  summary: { sessions: number; students: number; amount_vnd: number; per_session_vnd: number; per_student_vnd: number; payout_status: string | null } | null;
  sessions: { id: string; start_at: string; level: string; court_code: string; students: number }[];
  history: { period: string; sessions: number; students: number; amount_vnd: number; status: string; paid_at: string | null }[];
};

/**
 * Làm gì: Tính toán chu kỳ tháng mới bằng cách cộng hoặc trừ một số lượng tháng tương đối so với kỳ hiện tại (dùng để chuyển sang tháng trước hoặc tháng sau).
 * Được gọi ở: src/routes/coach.earnings.tsx (sự kiện click nút lùi/tiến tháng trong component Page).
 * @param p Chuỗi kỳ tháng gốc theo định dạng "YYYY-MM" (ví dụ: "2026-11").
 * @param by Số lượng tháng cần dịch chuyển (số âm là lùi về quá khứ, số dương là tiến tới tương lai).
 * @returns Chuỗi định dạng "YYYY-MM" của tháng mới (ví dụ: "2026-10" hoặc "2026-12").
 */
function shiftMonth(p: string, by: number) {
  const [y, m] = p.split("-").map(Number) as [number, number];
  // Dùng Date.UTC với chỉ số tháng bắt đầu từ 0 (m - 1) để tránh lệch ngày do múi giờ địa phương khi chuyển tháng
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Làm gì: Component giao diện chính hiển thị trang thu nhập của huấn luyện viên (/coach/earnings), cung cấp bộ điều hướng chuyển tháng, thẻ thống kê tổng quan (thu nhập, số lớp dạy, số học viên), danh sách lớp chi tiết và lịch sử các đợt chi trả trước đây.
 * Được gọi ở: src/routes/coach.earnings.tsx (được gắn vào Route để hiển thị khi người dùng truy cập URL "/coach/earnings").
 * @returns Giao diện React hoàn chỉnh của trang thu nhập được bọc trong component Shell.
 */
function Page() {
  // Bước 1: Quản lý chu kỳ tháng đang chọn và truy vấn dữ liệu thu nhập từ API /me/earnings
  // undefined = the month that is running now, whatever the centre calls it; the server answers with it.
  const [period, setPeriod] = useState<string | undefined>();
  const read = useRead<Data>(`/me/earnings${period ? `?period=${period}` : ""}`);
  const data = read.data;

  // Bước 2: Ghi nhớ tháng hiện tại của hệ thống để duy trì điều hướng và xác định chu kỳ đang hiển thị
  // The centre's current month, kept once it is known so the arrows keep working after a month fails to
  // load: a coach who lands on a month that would not open can still step to the next one.
  const [knownCurrent, setKnownCurrent] = useState<string | null>(null);
  useEffect(() => {
    if (data) setKnownCurrent(data.current);
  }, [data]);
  const current = data?.current ?? knownCurrent;
  // viewing ưu tiên theo tháng HLV chủ động chọn (period), nếu chưa chọn thì mặc định xem tháng hiện tại (current)
  const viewing = period ?? current;

  // Bước 3: Trích xuất thông tin tổng kết thu nhập (summary) và kết xuất giao diện trang theo trạng thái dữ liệu
  const s = data?.summary;
  return (
    <Shell
      role="coach"
      title={t("My earnings")}
      subtitle={t("What you earn for the classes you taught: a fee per class plus a little for each student who came.")}
    >
      <Reveal from="down">
        <div className="mb-4 flex items-center gap-2">
          <Button variant="outline" size="sm" className="min-w-11" aria-label={t("Previous month")} disabled={!viewing} onClick={() => viewing && setPeriod(shiftMonth(viewing, -1))}>
            ←
          </Button>
          <span className="min-w-28 text-center font-display text-xl tabular-nums">{viewing ? monthName(viewing) : "…"}</span>
          <Button variant="outline" size="sm" className="min-w-11" aria-label={t("Next month")} disabled={!viewing || !current || viewing >= current} onClick={() => viewing && setPeriod(shiftMonth(viewing, 1))}>
            →
          </Button>
        </div>
      </Reveal>

      {read.error ? (
        <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />
      ) : !data ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <div className="mb-2 grid gap-3 sm:grid-cols-3">
            <Stat label={t("Earned")} value={money(s?.amount_vnd ?? 0)} />
            <Stat label={t("Classes taught")} value={String(s?.sessions ?? 0)} />
            <Stat label={t("Students counted")} value={String(s?.students ?? 0)} />
          </div>
          <p className="mb-4 text-xs text-muted">
            {s
              ? t("Your rate: {a} per class and {b} per student.", { a: money(s.per_session_vnd), b: money(s.per_student_vnd) })
              : ""}{" "}
            {data.period >= data.current ? t("This month is still running, so the figure can still grow.") : ""}
          </p>

          <SectionTitle text={t("Classes this month")} className="mb-3 font-display text-2xl" />
          {data.sessions.length === 0 ? (
            <EmptyState title={t("No finished classes this month")} hint={t("A class counts once it is marked done.")} />
          ) : (
            <div className="mb-8 grid gap-2">
              {data.sessions.map((x) => (
                <Card key={x.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                  <span>
                    {when(x.start_at)} · {x.court_code} · {levelLabel(x.level)}
                  </span>
                  <span className="tabular-nums text-muted">{t("{n} students", { n: x.students })}</span>
                </Card>
              ))}
            </div>
          )}

          <SectionTitle text={t("Past months")} className="mb-3 font-display text-2xl" />
          {data.history.length === 0 ? (
            <p className="text-sm text-muted">{t("Nothing closed yet.")}</p>
          ) : (
            <div className="grid gap-2">
              {data.history.map((h) => (
                <Card key={h.period} className="flex items-center justify-between gap-3 p-3 text-sm">
                  <span className="tabular-nums">
                    {monthName(h.period)} · {t("{n} classes", { n: h.sessions })}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums">{money(h.amount_vnd)}</span>
                    <Badge tone={h.status === "paid" ? "accent" : "hold"}>{h.status === "paid" ? t("Paid") : t("Closed, not paid")}</Badge>
                  </span>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </Shell>
  );
}
