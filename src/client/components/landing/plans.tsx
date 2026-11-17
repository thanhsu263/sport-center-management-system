/**
 * File: src/client/components/landing/plans.tsx
 * Vai trò: Component hiển thị phân đoạn danh sách lớp học thể thao (ClassesScene) trên trang chủ (Landing page).
 * Vị trí trong app: Được nạp tại route trang chủ ("/" trong src/routes/index.tsx), cho phép khách vãng lai
 * xem danh sách lớp mở đăng ký, lọc theo môn thể thao, theo dõi mức độ lấp đầy chỗ học và điều hướng sang trang /register.
 */
import { useMemo, useRef, useState } from "react";
import { Cover, sportPhoto } from "@/client/components/media";
import { ButtonLink, Card } from "@/client/components/ui";
import type { CatalogClass } from "@/shared/arena3/contracts";
import { levelLabel, rruleLabel, sportLabel } from "@/shared/arena3/labels";
import { gsap, useScene } from "@/client/lib/gsap";
import { t } from "@/client/lib/i18n";
import { SplitHeading } from "./kit";
import { rise } from "./tweens";

/**
 * Classes with seats left. The enrol button sits next to the seat count that decides it, and each
 * seat meter fills to how full the class really is as it scrolls in.
 */
const FIRST_SHOWN = 4;

/**
 * Làm gì: Render phân đoạn danh sách lớp học trên trang chủ, hỗ trợ lọc theo môn thể thao, theo dõi sĩ số/chỗ trống và tạo hiệu ứng cuộn mượt mà.
 * Được gọi ở: src/routes/index.tsx (component Home -> Landing, route /)
 * @param props.classes Danh sách các lớp học thể thao (CatalogClass[]) lấy từ catalog công khai của hệ thống.
 * @returns JSX.Element biểu diễn phân đoạn danh sách lớp học mở đăng ký (section #classes).
 */
export function ClassesScene({ classes }: { classes: CatalogClass[] }) {
  // Bước 1: Khởi tạo ref cho phần tử DOM gốc và các state quản lý bộ lọc
  const root = useRef<HTMLElement>(null);
  const [sport, setSport] = useState("");
  const [all, setAll] = useState(false);
  // Bước 2: Trích xuất danh mục các môn thể thao duy nhất và lọc danh sách lớp theo điều kiện
  const sports = useMemo(() => [...new Set(classes.map((c) => c.sport))], [classes]);
  const picked = sport ? classes.filter((c) => c.sport === sport) : classes;
  // Mặc định chỉ hiển thị tối đa FIRST_SHOWN (4) lớp học để giữ giao diện gọn gàng; bấm "Show all" mới mở toàn bộ
  const shown = all ? picked : picked.slice(0, FIRST_SHOWN);
  // Bước 3: Thiết lập hiệu ứng hoạt họa GSAP khi phân đoạn cuộn vào tầm nhìn (viewport)
  useScene(root, ({ motion }) => {
    const el = root.current;
    // Bỏ qua hiệu ứng nếu người dùng bật tùy chọn giảm chuyển động (prefers-reduced-motion) hoặc phần tử gốc chưa gắn vào DOM
    if (!motion || !el) return;
    // Kích hoạt hiệu ứng xuất hiện trồi lên (rise) so le 0.08s cho các phần tử có thuộc tính data-rise
    rise(el, "[data-rise]", { stagger: 0.08 });
    // Tạo hiệu ứng phóng to thanh đo sĩ số (data-meter) từ trái sang phải một lần duy nhất khi cuộn đến 92% mép trên màn hình
    gsap.utils.toArray<HTMLElement>("[data-meter]", el).forEach((m) => {
      gsap.fromTo(m, { scaleX: 0 }, {
        scaleX: 1,
        transformOrigin: "left center",
        duration: 1,
        ease: "arena",
        scrollTrigger: { trigger: m, start: "top 92%", once: true },
      });
    });
  });
  // Bước 4: Render giao diện phân đoạn lớp học (section #classes):
  // - Tiêu đề và mô tả giới thiệu kèm hiệu ứng cuộn data-rise.
  // - Thanh nút bấm lọc theo từng môn thể thao (chỉ hiển thị khi có từ 2 môn trở lên); khi đổi môn sẽ đặt lại all=false để xem 4 lớp đầu.
  // - Lưới thẻ lớp học: tính toán tỷ lệ lấp đầy (pct), đánh dấu sắp hết chỗ khi >= 80% (nearlyFull) để đổi màu thanh đo sang màu cam (bg-hold), và trạng thái hết chỗ (full) để chuyển nút sang danh sách chờ (waitlist).
  // - Nút "Show all / Show fewer" hiển thị khi số lớp vượt quá FIRST_SHOWN (4 lớp) để mở rộng hoặc thu gọn danh sách.
  return (
    <section ref={root} id="classes" className="mx-auto max-w-6xl scroll-mt-20 px-4 pb-20">
      <p data-rise className="kicker text-2xs text-muted">
        {t("Open classes")}
      </p>
      <h2 className="mt-2 font-display text-4xl">
        <SplitHeading text={t("Classes open for enrolment")} />
      </h2>
      <p data-rise className="mt-3 max-w-lg text-muted">
        {t("Small groups, one coach, a fixed timetable. Pick your level and start with the next session. Seats go to whoever signs up first.")}
      </p>

      {sports.length > 1 ? (
        <div data-rise className="mt-6 flex flex-wrap gap-2" role="group" aria-label={t("Sport")}>
          {["", ...sports].map((s) => (
            <button
              key={s || "all"}
              type="button"
              aria-pressed={sport === s}
              onClick={() => {
                setSport(s);
                setAll(false);
              }}
              className={`rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
                sport === s ? "border-accent bg-accent text-accent-fg" : "border-line text-muted hover:text-fg"
              }`}
            >
              {s ? sportLabel(s) : t("All sports")}
            </button>
          ))}
        </div>
      ) : null}

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {shown.map((c) => {
          const pct = c.capacity ? Math.min(100, (c.enrolled_count / c.capacity) * 100) : 0;
          const nearlyFull = pct >= 80;
          const full = c.enrolled_count >= c.capacity;
          const left = Math.max(0, c.capacity - c.enrolled_count);
          return (
            <div key={c.id} data-rise className="h-full">
              <Card interactive className="flex h-full gap-4 p-3">
                <Cover slot={sportPhoto(c.sport)} alt="" className="h-28 w-28 shrink-0 rounded-[var(--radius-lg)]" />
                <div className="flex min-w-0 flex-1 flex-col py-1">
                  <p className="kicker text-2xs text-muted">{sportLabel(c.sport)}</p>
                  <p className="font-display text-xl">{levelLabel(c.level)}</p>
                  <p className="text-sm text-muted">
                    {c.coach_name} · {c.court_code}
                  </p>
                  <p className="text-sm">{rruleLabel(c.rrule, c.duration_min)}</p>
                  <div className="mt-2.5 flex items-center gap-2">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-wood">
                      <span
                        data-meter
                        className={`block h-full rounded-full ${nearlyFull ? "bg-hold" : "bg-accent"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-subtle">
                      {c.enrolled_count}/{c.capacity}
                    </span>
                  </div>
                  <div className="mt-auto flex items-center justify-between gap-2 pt-3">
                    <span className={`text-xs ${nearlyFull ? "text-hold" : "text-muted"}`}>
                      {full ? t("Full, waitlist open") : left === 1 ? t("1 seat left") : t("{n} seats left", { n: left })}
                    </span>
                    <ButtonLink
                      to="/register"
                      size="sm"
                      variant={full ? "outline" : "primary"}
                      aria-label={`${full ? t("Join the waitlist") : t("Enrol")}: ${sportLabel(c.sport)} ${levelLabel(c.level)}`}
                    >
                      {full ? t("Join the waitlist") : t("Enrol")}
                    </ButtonLink>
                  </div>
                </div>
              </Card>
            </div>
          );
        })}
        {!classes.length ? <p className="text-sm text-muted">{t("No classes published yet.")}</p> : null}
      </div>
      {picked.length > FIRST_SHOWN ? (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={() => setAll((v) => !v)}
            aria-expanded={all}
            className="rounded-full border border-line px-4 py-2 text-sm text-fg transition-colors hover:border-accent"
          >
            {all ? t("Show fewer") : t("Show all {n} classes", { n: picked.length })}
          </button>
        </div>
      ) : null}
    </section>
  );
}
