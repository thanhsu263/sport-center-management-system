/**
 * File: src/routes/index.tsx
 * Vai trò: Tuyến đường chính (route "/") hiển thị trang Landing Page công khai của hệ thống Arena3.
 * Vị trí trong app: Phục vụ khách vãng lai và thành viên ghé thăm trung tâm; hiển thị thông tin giới thiệu sân, bảng giá, lớp học, huấn luyện viên và lịch trống sân theo thời gian thực mà không bắt buộc đăng nhập. Tự động điều hướng người dùng đã đăng nhập sang dashboard phù hợp theo vai trò (role).
 */
import { Navigate, createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { freeHours, useNowMinute } from "@/client/components/court-grid";
import { ClassTicker } from "@/client/components/landing/ticker";
import { ClassesScene } from "@/client/components/landing/plans";
import { ClosingCta, SiteFooter } from "@/client/components/landing/closing";
import { CoachesScene } from "@/client/components/landing/coaches";
import { CourtsScene } from "@/client/components/landing/courts";
import { FacilitiesScene } from "@/client/components/landing/facilities";
import { Hero, StatsBand } from "@/client/components/landing/hero";
import { LandingSmoother, useLandingScroll } from "@/client/components/landing/smoother";
import { Manifesto } from "@/client/components/landing/manifesto";
import { PricingScene } from "@/client/components/landing/pricing";
import { ScheduleScene, type Picked } from "@/client/components/landing/schedule";
import type { NextFree } from "@/client/components/landing/hero";
import { GalleryScene } from "@/client/components/landing/gallery";
import { SiteHeader } from "@/client/components/landing/header";
import { ShuttleScene } from "@/client/components/landing/shuttle3d";
import { StepsScene } from "@/client/components/landing/steps";
import { Testimonials } from "@/client/components/landing/testimonials";
import { VenueProvider, priceFor, useVenueHour, wdLabel } from "@/client/components/landing/util";
import { hoursOf, venueFrom } from "@/client/lib/venue";
import { getStoredUser, getToken, homeFor } from "@/client/arena3/client";
import { getPublicAvailability, getPublicCatalog } from "@/server/services/catalog";
import { addDaysISO } from "@/shared/arena3/labels";
import { BootGate } from "@/client/components/media";
import { useSports } from "@/client/components/sports-ui";
import { t } from "@/client/lib/i18n";

/**
 * Làm gì: Định nghĩa route trang chủ ("/") với loader tải trước danh mục dịch vụ công khai (bảng giá, lớp học, huấn luyện viên) và tình trạng sân trống của ngày hiện tại.
 * Được gọi ở: TanStack Router khi người dùng truy cập URL "/".
 * @returns Định nghĩa route của TanStack Router cấu hình loader và component Home.
 */
export const Route = createFileRoute("/")({
  // Today's schedule loads with the page rather than behind a sign-in wall:
  // "is a court free tonight" is the question people arrive with, and making
  // them register to find out is the funnel running backwards.
  loader: async () => {
    // Tải song song danh mục công khai (bảng giá, lớp học, cơ sở vật chất) và lịch trống của ngày hiện tại để tối ưu thời gian phản hồi.
    const [catalog, availability] = await Promise.all([
      getPublicCatalog(),
      getPublicAvailability({ data: {} }),
    ]);
    return { ...catalog, availability };
  },
  component: Home,
});

/**
 * Làm gì: Component bao bọc trang chủ; kiểm tra phiên đăng nhập để điều hướng về dashboard phù hợp theo vai trò (role), hoặc render Landing Page mượt mà với hiệu ứng quả cầu 3D.
 * Được gọi ở: Component hiển thị của Route ("/") trong TanStack Router.
 * @returns Phần tử JSX hiển thị Landing Page cho khách hoặc component Navigate chuyển hướng người dùng đã đăng nhập.
 */
function Home() {
  // Bước 1: Kiểm tra phiên đăng nhập hiện tại từ localStorage.
  const token = getToken();
  const u = getStoredUser();
  // Bước 2: Lấy dữ liệu tình trạng sân trống từ loader và phút hiện tại để tính toán độ sáng hiệu ứng quả cầu 3D.
  const { availability } = Route.useLoaderData();
  const now = useNowMinute();
  // The shuttle's rim light follows how much of today's court is free.
  const free = freeHours(availability.courts, availability.slots, availability.date, now, true).length;
  // 0.35 là độ sáng viền tối thiểu; 48 là ước lượng tổng số giờ-sân trong ngày để chuẩn hóa độ sáng tối đa về 1.0.
  const glow = Math.min(1, 0.35 + free / 48);
  // Bước 3: Nếu đã đăng nhập, tự động chuyển hướng về trang làm việc tương ứng với vai trò (member, coach, staff, admin).
  if (token && u) return <Navigate to={homeFor(u.role)} />;
  // Bước 4: Khách vãng lai xem Landing Page bọc trong BootGate và LandingSmoother (cuộn mượt GSAP).
  return (
    <BootGate>
      <main id="main-content" tabIndex={-1} className="min-h-dvh overflow-x-clip text-fg">
        <LandingSmoother header={<><SiteHeader /><ShuttleScene glow={glow} /></>}>
          <Landing />
        </LandingSmoother>
      </main>
    </BootGate>
  );
}

/**
 * The public page, told as a scroll story (GSAP: components/landing/*).
 *
 * This component owns the data and the live schedule state that several sections share (today's
 * free-hour count shows in the hero, the counters, the court cards and the grid); each section is
 * its own scene with its own GSAP timeline, and none of them use `motion`.
 */
/**
 * Làm gì: Quản lý toàn bộ dữ liệu danh mục, giờ hoạt động và trạng thái chọn lịch trống theo thời gian thực của Landing Page; điều phối dữ liệu cho các phân đoạn giao diện cuộn theo kịch bản (Hero, Courts, Schedule, Pricing...).
 * Được gọi ở: Component Home trong src/routes/index.tsx.
 * @returns Giao diện các phân đoạn Landing Page bọc trong VenueProvider.
 */
function Landing() {
  // Bước 1: Lấy dữ liệu từ loader và chuẩn hóa thông tin cơ sở vật chất (giờ mở/đóng cửa, thời gian giữ chỗ).
  const { classes, prices, availability, venue: venueRaw, coaches: dbCoaches } = Route.useLoaderData();
  // The centre's own hours and hold length, for every section's copy and the grid.
  const venue = useMemo(() => venueFrom(venueRaw), [venueRaw]);
  const { scrollToId } = useLandingScroll();
  // Xác định trạng thái mở/đóng cửa của trung tâm dựa vào giờ địa phương hiện tại.
  const hour = useVenueHour();
  const isOpen = hour == null ? null : hour >= venue.open && hour < venue.close;

  // ── Today's schedule, live on the page ──────────────────────────────
  // Bước 2: Khởi tạo state cho bộ lọc môn thể thao, ngày xem lịch, dữ liệu lịch và slot sân đang được chọn.
  const { sports } = useSports();
  const [schedSport, setSchedSport] = useState("");
  // Tự động chọn môn thể thao đầu tiên trong danh mục khi danh sách môn thể thao được tải xong.
  useEffect(() => {
    if (!schedSport && sports.length > 0) {
      setSchedSport(sports[0].code);
    }
  }, [schedSport, sports]);
  const [schedDate, setSchedDate] = useState(availability.date);
  const [sched, setSched] = useState(availability);
  const [schedBusy, setSchedBusy] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const now = useNowMinute();

  // Bước 3: Tải lại lịch trống khi người dùng chọn xem ngày khác; dùng cờ alive để chống race condition khi đổi ngày liên tục.
  useEffect(() => {
    if (schedDate === sched.date) return;
    let alive = true;
    setSchedBusy(true);
    setPicked(null);
    getPublicAvailability({ data: { date: schedDate } })
      .then((r) => {
        if (alive) setSched(r);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setSchedBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [schedDate, sched.date]);

  // Guests book like members: an hour that has started is no longer on offer (BR-07).
  // Bước 4: Tính toán danh sách giờ trống, thống kê số giờ theo môn và xác định giờ trống tiếp theo khả dụng.
  const schedFreeList = freeHours(sched.courts, sched.slots, sched.date, now, true, hoursOf(venue));
  const freeCounts = new Map<string, number>();
  for (const { court } of schedFreeList) {
    freeCounts.set(court.sport, (freeCounts.get(court.sport) ?? 0) + 1);
  }
  /**
   * Làm gì: Đếm tổng số giờ còn trống trong ngày của một môn thể thao cụ thể.
   * Được gọi ở: CourtsScene (qua prop freeBySport) để hiển thị số giờ trống trên thẻ từng môn.
   * @param sport Mã môn thể thao cần tra cứu.
   * @returns Số lượng giờ-sân còn trống trong ngày của môn thể thao đó.
   */
  const freeBySport = (sport: string) => freeCounts.get(sport) ?? 0;
  const schedFree = schedFreeList.length;
  // Hours come out earliest first, so the first one is the next you could play. Until the clock
  // arrives (now = 0) nothing has been ruled out yet, so the offer waits for it.
  const first = now ? schedFreeList[0] : undefined;
  // Tìm khung giờ trống sớm nhất kèm giá tiền tương ứng để làm đề xuất đặt sân nhanh trên Hero section.
  const nextFree: NextFree | null = first
    ? { ...first, price: priceFor(prices, first.court.sport, sched.date, first.hour) }
    : null;
  const schedDay =
    sched.date === availability.date
      ? t("today")
      : t("on {day}", { day: `${wdLabel(sched.date)} ${Number(sched.date.slice(8, 10))}` });
  // Lấy mức giá giờ chơi rẻ nhất của sân tiêu chuẩn (không chỉ định court_id) để hiển thị từ giá sàn.
  const cheapestHour = Math.min(...prices.filter((p) => !p.court_id).map((p) => p.price_vnd));
  const weekday = prices.filter((p) => p.day_kind === "weekday" && !p.court_id);

  /*
   * After close, show tomorrow.
   *
   * Open the site at half past ten at night and every hour on today's grid has
   * already been played; a page whose headline offer is "0 free hours" and
   * whose grid is a wall of finished hours is telling the truth in the least
   * useful way there is. The first day with hours left is the one worth
   * showing. Deferred to an effect rather than decided during render because
   * the clock is not available until the client has mounted.
   */
  // Bước 5: Tự động chuyển lịch sang ngày mai nếu toàn bộ giờ hôm nay đã kết thúc (sau giờ đóng cửa).
  useEffect(() => {
    if (!now) return;
    if (schedDate !== availability.date) return;
    if (freeHours(availability.courts, availability.slots, availability.date, now, true, hoursOf(venue)).length > 0) return;
    setSchedDate(addDaysISO(availability.date, 1));
  }, [now, schedDate, availability, venue]);

  /** Jump to the schedule already filtered to the sport they tapped. */
  /**
   * Làm gì: Lọc nhanh lịch đặt sân theo môn thể thao được chọn và cuộn mượt màn hình tới phân đoạn lịch (schedule).
   * Được gọi ở: Phân đoạn CourtsScene (qua prop onShowTimes) khi người dùng bấm vào thẻ môn thể thao.
   * @param s Mã môn thể thao được chọn (ví dụ: "badminton", "pickleball").
   * @returns void
   */
  const showTimes = (s: string) => {
    setSchedSport(s);
    setPicked(null);
    scrollToId("schedule");
  };

  /** The hero's free hour, picked on the schedule so the next step is the hold. */
  /**
   * Làm gì: Chọn sẵn khung giờ trống sớm nhất từ phần Hero và cuộn mượt xuống phân đoạn lịch để người dùng tiếp tục giữ chỗ.
   * Được gọi ở: Phân đoạn Hero (qua prop onHold) khi người dùng bấm nút giữ chỗ giờ trống gần nhất.
   * @param n Đối tượng NextFree chứa thông tin sân, giờ trống và giá tiền.
   * @returns void
   */
  const holdNext = (n: NextFree) => {
    setSchedSport(n.court.sport);
    setPicked({ court: n.court, hour: n.hour });
    scrollToId("schedule");
  };

  // Bước 6: Render toàn bộ các phân đoạn (scene) của Landing Page bọc trong VenueProvider.
  return (
    <VenueProvider value={venue}>
      <Hero
        isOpen={isOpen}
        freeHours={schedFree}
        openClasses={classes.length}
        day={schedDay}
        cheapestHour={cheapestHour}
        next={nextFree}
        onHold={holdNext}
      />
      <StatsBand courts={sched.courts} />
      <CourtsScene weekday={weekday} freeBySport={freeBySport} day={schedDay} onShowTimes={showTimes} courts={sched.courts} />
      <ScheduleScene
        sched={sched}
        date={schedDate}
        onDate={setSchedDate}
        sport={schedSport}
        onSport={setSchedSport}
        busy={schedBusy}
        picked={picked}
        onPick={setPicked}
        prices={prices}
      />
      {classes.length ? <ClassTicker classes={classes} /> : null}
      <Manifesto />
      <StepsScene />
      <CoachesScene dbCoaches={dbCoaches} />
      <FacilitiesScene courts={sched.courts} />
      <PricingScene weekday={weekday} />
      <ClassesScene classes={classes} />
      <Testimonials />
      <GalleryScene />
      <ClosingCta />
      <SiteFooter />
    </VenueProvider>
  );
}
