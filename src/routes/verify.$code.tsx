/**
 * File: src/routes/verify.$code.tsx
 * Vai trò: Định nghĩa route và giao diện trang xác thực chứng chỉ hoàn thành khóa học (/verify/$code) trong hệ thống Arena 3.
 * Vị trí trong app:
 * - Tuyến đường công khai (public route), cho phép bất kỳ ai có đường link hoặc quét mã QR chứng chỉ tra cứu thông tin trực tiếp từ server mà không cần đăng nhập.
 * - Được mở từ nút xem chứng nhận trong trang tiến độ luyện tập của hội viên (src/client/components/member-certificates.tsx).
 * - Hiển thị khung chứng chỉ theo tỉ lệ giấy in tiêu chuẩn A4 (1.414/1), hỗ trợ in trực tiếp hoặc lưu thành file PDF qua lệnh in của trình duyệt.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { Printer, ShieldCheck } from "lucide-react";
import { ArenaMark } from "@/client/components/mark";
import { LangSwitch } from "@/client/components/lang-switch";
import { Button, LoadError, Skeleton } from "@/client/components/ui";
import { formatDate, levelLabel, sportLabel } from "@/shared/arena3/labels";
import { t, tData } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";

/**
 * Làm gì: Khởi tạo định tuyến cho trang xác thực chứng chỉ (/verify/$code) bằng TanStack Router, thiết lập tiêu đề trang và liên kết URL với component Page.
 * Được gọi ở: URL `/verify/$code` (TanStack Router tự động đăng ký và nạp route khi người dùng truy cập hoặc mở đường link xác thực).
 * @returns Route cấu hình cho đường dẫn `/verify/$code`.
 */
export const Route = createFileRoute("/verify/$code")({
  head: () => ({ meta: [{ title: "Certificate · Lê Long Sport" }] }),
  component: Page,
});

// Cấu trúc dữ liệu chứng chỉ hoàn thành khóa học (mã code, số buổi tham gia, tên môn, cấp độ, HLV, ngày cấp) trả về từ API /certificates/:code.
type Cert = {
  code: string;
  attended: number;
  sessions: number;
  issued_at: string;
  member_name: string;
  sport: string;
  level: string;
  start_on: string;
  end_on: string;
  coach_name: string;
};

/**
 * A completion certificate, and the check of it. The member prints it from here; anyone handed
 * the code opens the same page to see the centre's own record of it. No effects: it is a document.
 */
/**
 * Làm gì: Component giao diện hiển thị chứng chỉ hoàn thành khóa học, gọi API xác thực theo mã code và hỗ trợ in hoặc lưu file PDF.
 * Được gọi ở: Thuộc tính component của Route tại URL `/verify/$code` (src/routes/verify.$code.tsx).
 * @returns JSX layout trang xác thực chứng chỉ gồm thương hiệu trung tâm, nội dung chứng nhận và nút in ấn.
 */
function Page() {
  // Bước 1: Lấy mã chứng chỉ (code) từ tham số dynamic param của route /verify/$code.
  const { code } = Route.useParams();
  // Bước 2: Tải dữ liệu chứng nhận từ API công khai /certificates/:code qua hook useRead.
  // Dùng encodeURIComponent để mã hóa an toàn mã code khi truyền trên đường dẫn API.
  const read = useRead<Cert>(`/certificates/${encodeURIComponent(code)}`);
  const c = read.data;

  // Bước 3: Render giao diện chứng chỉ xử lý theo 3 trạng thái: báo lỗi (LoadError), khung chờ (Skeleton), và nội dung hoàn chỉnh.
  // Khung chứng chỉ dùng tỉ lệ aspect-[1.414/1] tương ứng với tỉ lệ khổ giấy in A4 chuẩn (√2:1); các class print:* tối ưu giao diện khi in ấn hoặc lưu PDF.
  return (
    <div className="min-h-dvh bg-bg text-fg print:bg-white">
      <header className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-4 sm:px-6 print:hidden">
        <Link to="/" className="inline-flex items-center gap-2" aria-label={t("Lê Long Sport home")}>
          <ArenaMark className="size-8" />
          <span className="font-display text-xl">Lê Long Sport</span>
        </Link>
        <LangSwitch />
      </header>
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-3xl px-4 pb-16 sm:px-6 print:p-0">
        {read.error ? (
          <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />
        ) : !c ? (
          <Skeleton className="aspect-[1.414/1] w-full" />
        ) : (
          <>
            <p className="mb-4 flex items-center gap-2 text-sm text-muted print:hidden">
              <ShieldCheck className="size-4 text-accent-2" aria-hidden />
              {t("Verified: this certificate is on record at Lê Long Sport.")}
            </p>
            <article className="relative grid aspect-[1.414/1] place-content-center gap-5 rounded-[var(--radius-xl)] border-2 border-line-strong bg-surface p-8 text-center sm:p-12 print:rounded-none print:border-black">
              <div className="absolute inset-3 rounded-[var(--radius-lg)] border border-line print:rounded-none" aria-hidden />
              <div className="relative flex items-center justify-center gap-2">
                <ArenaMark className="size-7" />
                <span className="font-display text-lg">Lê Long Sport</span>
              </div>
              <p className="kicker relative text-2xs text-muted">{t("Certificate of completion")}</p>
              <h1 className="relative font-display text-4xl sm:text-5xl">{tData(c.member_name)}</h1>
              <p className="relative mx-auto max-w-md text-sm leading-relaxed sm:text-base">
                {t("has completed the {sport} class, {level} level, from {from} to {to}.", {
                  sport: sportLabel(c.sport),
                  level: levelLabel(c.level),
                  from: formatDate(c.start_on),
                  to: formatDate(c.end_on),
                })}
              </p>
              <p className="relative text-sm tabular-nums text-muted">
                {t("Attended {a} of {n} sessions", { a: c.attended, n: c.sessions })} ·{" "}
                {t("Coach {name}", { name: tData(c.coach_name) })}
              </p>
              <p className="relative mt-2 text-xs tabular-nums text-muted">
                {t("Issued {date}", { date: formatDate(c.issued_at) })} · {t("Code {code}", { code: c.code })}
              </p>
            </article>
            <p className="mt-4 text-xs text-muted print:mt-2">
              {t("Check it at {url}", { url: typeof window === "undefined" ? `/verify/${c.code}` : window.location.href })}
            </p>
            <div className="mt-6 flex justify-end print:hidden">
              <Button onClick={() => window.print()}>
                <Printer className="mr-1.5 size-4" aria-hidden />
                {t("Print or save as PDF")}
              </Button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
