/**
 * File: src/client/components/landing/schedule.tsx
 * Vai trò: Phân đoạn hiển thị lịch đặt sân trực tiếp (live availability schedule) trên trang landing page.
 * Vị trí trong app: Được trang chủ (src/routes/index.tsx - route "/") nhúng vào để khách vãng lai tra cứu tình trạng sân trống theo ngày và môn thể thao, xem giá dự kiến và bấm chọn giờ để giữ chỗ trước khi đăng nhập.
 */
import { useRef } from "react";
import { CourtGrid, DateStrip, type Court as GridCourt } from "@/client/components/court-grid";
import { Button, ButtonLink, Card, Seg, Skeleton } from "@/client/components/ui";
import { money } from "@/client/components/shell";
import type { CatalogCourt, CatalogPrice, CatalogSlot } from "@/shared/arena3/contracts";
import { sportLabel } from "@/shared/arena3/labels";
import { gsap, useScene } from "@/client/lib/gsap";
import { t } from "@/client/lib/i18n";
import { useSports } from "@/client/components/sports-ui";
import { SplitHeading } from "./kit";
import { rise } from "./tweens";
import { priceFor, wdLabel } from "./util";
import { useVenue } from "./util";
import { hoursOf } from "@/client/lib/venue";

/**
 * Làm gì: Định nghĩa kiểu dữ liệu đại diện cho ô giờ sân được chọn trên lưới lịch, gồm đối tượng sân (court) và mốc giờ bắt đầu (hour: 0-23).
 * Được gọi ở: src/client/components/landing/schedule.tsx (props của ScheduleScene, PickedCard), src/routes/index.tsx (state picked của trang landing).
 */
export type Picked = { court: GridCourt; hour: number };

/**
 * The live grid, on the public page. The heading and controls arrive like every other section;
 * the grid itself never animates: its colours are the message (DESIGN.md, "The Light Finds the
 * Court Rule"), and nothing is allowed over its cells.
 */
/**
 * Làm gì: Hiển thị phân đoạn lịch đặt sân trực tiếp trên trang chủ, gồm thanh chọn ngày (DateStrip), bộ lọc môn thể thao (Seg), thẻ tóm tắt giờ đã chọn (PickedCard) và lưới lịch sân trực tiếp (CourtGrid).
 * Được gọi ở: src/routes/index.tsx (trang landing page công khai tại route "/").
 * @param props Các thuộc tính điều khiển phân đoạn lịch:
 *   - sched: Dữ liệu lịch sân gồm ngày, danh sách sân (courts) và danh sách ô giờ chiếm dụng (slots).
 *   - date: Chuỗi ngày đang được chọn xem lịch (định dạng YYYY-MM-DD).
 *   - onDate: Hàm callback cập nhật khi người dùng chọn ngày mới.
 *   - sport: Mã môn thể thao đang lọc (chuỗi rỗng "" nghĩa là hiển thị tất cả các môn).
 *   - onSport: Hàm callback cập nhật môn thể thao đang chọn và xóa ô giờ đã chọn trước đó.
 *   - busy: Cờ báo trạng thái đang tải dữ liệu lịch mới từ server (hiển thị khung xương Skeleton).
 *   - picked: Thông tin sân và khung giờ khách đang chọn giữ chỗ tạm thời (hoặc null nếu chưa chọn).
 *   - onPick: Hàm callback lưu hoặc hủy bỏ ô giờ sân được chọn.
 *   - prices: Danh mục bảng giá thuê sân theo khung giờ và loại ngày để tính giá hiển thị.
 * @returns JSX phần tử section chứa toàn bộ giao diện phân đoạn lịch sân.
 */
export function ScheduleScene({
  sched,
  date,
  onDate,
  sport,
  onSport,
  busy,
  picked,
  onPick,
  prices,
}: {
  sched: { date: string; courts: CatalogCourt[]; slots: CatalogSlot[] };
  date: string;
  onDate: (d: string) => void;
  sport: string;
  onSport: (s: string) => void;
  busy: boolean;
  picked: Picked | null;
  onPick: (p: Picked | null) => void;
  prices: CatalogPrice[];
}) {
  // Bước 1: Khởi tạo thông tin cấu hình địa điểm (venue), danh sách môn thể thao (sports) và ref tham chiếu DOM của phân đoạn lịch
  const venue = useVenue();
  const root = useRef<HTMLElement>(null);
  const { sports } = useSports();
  // Bước 2: Thiết lập hiệu ứng chuyển động GSAP (rise) khi phân đoạn cuộn vào tầm nhìn; stagger 0.07s giúp các phần tử trồi lên so le nhịp nhàng
  useScene(root, ({ motion }) => {
    if (motion && root.current) rise(root.current, "[data-rise]", { stagger: 0.07 });
  });

  // Bước 3: Render giao diện phân đoạn lịch: thanh chọn ngày/môn, thẻ giữ chỗ tạm thời và lưới sân trực tiếp (CourtGrid)
  return (
    <section ref={root} id="schedule" className="mx-auto max-w-6xl scroll-mt-20 px-4 pb-20">
      <p data-rise className="kicker text-2xs text-muted">
        {t("Live availability")}
      </p>
      <h2 className="mt-2 font-display text-4xl sm:text-5xl">
        <SplitHeading text={t("When is a court free?")} />
      </h2>
      <p data-rise className="mt-3 max-w-lg text-muted">
        {t("Free and booked hours for every court. Tap a free hour to hold it for {n} minutes while you sign in. You do not pay to hold it.", {
          n: venue.holdMinutes,
        })}
      </p>

      <div className="mt-7 grid gap-3">
        <div data-rise>
          <DateStrip value={date} onChange={onDate} />
        </div>
        <div data-rise>
          <Seg
            value={sport}
            onChange={(v) => {
              onSport(v);
              onPick(null);
            }}
            options={[
              { value: "", label: t("All") },
              ...sports
                .filter((s) => sched.courts.some((c) => c.sport === s.code))
                .map((s) => ({ value: s.code, label: sportLabel(s.code) })),
            ]}
          />
        </div>
      </div>

      {picked ? (
        <PickedCard
          key={`${picked.court.id}-${picked.hour}-${date}`}
          picked={picked}
          date={date}
          prices={prices}
          onClear={() => onPick(null)}
        />
      ) : null}

      {/* data-no-fly: the 3D ball is cut out of this box, so it never covers a court cell. */}
      <div data-no-fly className="mt-4">
        {busy ? (
          <div className="grid gap-2">
            <Skeleton className="h-8" />
            <Skeleton className="h-72" />
          </div>
        ) : (
          <CourtGrid
            startedIsPast
            hours={hoursOf(venue)}
            date={sched.date}
            courts={sched.courts}
            slots={sched.slots}
            sport={sport || undefined}
            onPick={(court, hour) => onPick({ court, hour })}
            onPickSport={(s) => {
              onSport(s);
              onPick(null);
            }}
            onPickDate={onDate}
            legendCompact
            selected={picked ? { courtId: picked.court.id, hour: picked.hour } : null}
          />
        )}
      </div>
    </section>
  );
}

/**
 * What a tap on a free hour gets you, before you are asked for anything: the slot named, priced
 * and dated, so signing in is a step towards something specific rather than a toll gate. It opens
 * out of nothing each time a different hour is picked.
 */
/**
 * Làm gì: Hiển thị thẻ tóm tắt chi tiết khung giờ sân được khách chọn, tính giá thuê dự kiến và cung cấp các nút dẫn đến đăng nhập hoặc tạo tài khoản để giữ chỗ.
 * Được gọi ở: src/client/components/landing/schedule.tsx (component con của ScheduleScene, hiển thị khi picked !== null).
 * @param props Các thuộc tính của thẻ giờ chọn:
 *   - picked: Thông tin sân và mốc giờ bắt đầu đang được chọn.
 *   - date: Ngày được chọn đặt sân (YYYY-MM-DD).
 *   - prices: Danh mục bảng giá để tra cứu giá thuê sân theo môn, ngày và giờ.
 *   - onClear: Hàm callback hủy chọn khung giờ để đóng thẻ tóm tắt.
 * @returns JSX phần tử chứa thẻ Card thông tin đặt chỗ kèm animation mở rộng.
 */
function PickedCard({
  picked,
  date,
  prices,
  onClear,
}: {
  picked: Picked;
  date: string;
  prices: CatalogPrice[];
  onClear: () => void;
}) {
  // Bước 1: Lấy cấu hình cơ sở (thời gian giữ chỗ venue.holdMinutes) và ref tham chiếu thẻ DOM
  const venue = useVenue();
  const root = useRef<HTMLDivElement>(null);
  // Bước 2: Thiết lập hiệu ứng hoạt họa GSAP khi thẻ mở ra: trượt mở chiều cao từ 0 và làm rõ dần các chi tiết bên trong
  useScene(root, ({ motion }) => {
    const el = root.current;
    if (!motion || !el) return;
    // Trượt mở mượt mà từ chiều cao 0 lên kích thước tự nhiên (auto) trong 0.45s
    gsap.fromTo(el, { height: 0, autoAlpha: 0 }, { height: "auto", autoAlpha: 1, duration: 0.45 });
    // Các thành phần con trượt nhẹ từ dưới lên (y: 10 -> 0) với độ trễ so le (stagger) để tạo cảm giác xuất hiện tự nhiên
    gsap.fromTo(el.querySelectorAll("[data-pick-part]"), { y: 10, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.5, stagger: 0.06, delay: 0.12 });
  });
  // Bước 3: Tra cứu đơn giá thuê sân theo môn thể thao, ngày và khung giờ bắt đầu từ danh mục bảng giá
  const p = priceFor(prices, picked.court.sport, date, picked.hour);
  // Bước 4: Render giao diện thẻ tóm tắt: thông tin môn/sân, khung giờ, ngày trong tuần, giá tiền và nút đăng nhập giữ chỗ
  return (
    <div ref={root} className="overflow-hidden">
      <Card className="mt-4 flex flex-wrap items-center gap-4 border border-accent/30">
        <div data-pick-part className="min-w-[13rem] flex-1">
          <p className="kicker text-2xs text-muted">
            {sportLabel(picked.court.sport)} · {picked.court.court_code}
          </p>
          <p className="mt-1 font-display text-2xl tabular-nums">
            {String(picked.hour).padStart(2, "0")}:00-{String(picked.hour + 1).padStart(2, "0")}:00
            <span className="ml-2 text-muted">
              {wdLabel(date)} {Number(date.slice(8, 10))}
            </span>
          </p>
          <p className="mt-1 text-sm text-muted">
            {p ? t("{price} for the hour", { price: money(p) }) : t("Priced at the desk")} ·{" "}
            {t("held {n} minutes once you sign in", { n: venue.holdMinutes })}
          </p>
        </div>
        <div data-pick-part className="flex flex-wrap gap-2">
          <ButtonLink to="/login">{t("Sign in & hold it")}</ButtonLink>
          <ButtonLink to="/register" variant="outline">
            {t("Create an account")}
          </ButtonLink>
          <Button variant="ghost" onClick={onClear}>
            {t("Pick another")}
          </Button>
        </div>
      </Card>
    </div>
  );
}
