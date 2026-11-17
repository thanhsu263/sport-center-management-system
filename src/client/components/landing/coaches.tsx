/**
 * File: src/client/components/landing/coaches.tsx
 * Vai trò: Component hiển thị khu vực giới thiệu đội ngũ huấn luyện viên (Coaches Scene) trên Landing Page.
 * Vị trí trong app: Được nhúng tại trang chủ (src/routes/index.tsx), hỗ trợ lọc HLV theo môn thể thao với hiệu ứng chuyển đổi GSAP Flip mượt mà và hộp thoại (modal) xem chi tiết tiểu sử, chứng chỉ chuyên môn.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Flip } from "gsap/Flip";
import { Cover, MediaCaption } from "@/client/components/media";
import { Button, ButtonAnchor, Card, Modal, Seg } from "@/client/components/ui";
import { GlareHover, SpotlightCard } from "@/client/components/fx";
import { initials } from "@/client/components/shell";
import { COACHES, type CoachCard } from "@/shared/arena3/coaches";
import { sportLabel } from "@/shared/arena3/labels";
import { gsap, motionOff, registerGsap, useScene } from "@/client/lib/gsap";
import { useCalm } from "@/client/lib/calm";
import { t, useLang } from "@/client/lib/i18n";
import { useSports } from "@/client/components/sports-ui";
import { Award } from "lucide-react";
import { certificationLine, type Certification } from "@/client/components/coach-certifications";
import { useRead } from "@/client/lib/use-read";
import { useLimits } from "@/client/lib/use-centre";
import { SplitHeading } from "./kit";
import { rise } from "./tweens";

// Đăng ký plugin Flip với GSAP để kích hoạt tính năng ghi nhận tọa độ và diễn hoạt chuyển đổi layout mượt mà.
registerGsap(Flip);

/**
 * One head coach per sport. Filtering by sport is a FLIP: the cards that stay slide to where
 * they now belong, the ones that arrive grow in where they land, so the eye can follow which
 * coach went where instead of reading a fresh grid. Without motion the grid simply changes.
 *
 * A card carries the three things that decide whether you want to read more (face, sport,
 * role); the rest is one click away in the dialog.
 */
/**
 * Làm gì: Hiển thị phân đoạn giới thiệu đội ngũ huấn luyện viên (Coaches Scene) trên trang chủ, hỗ trợ lọc theo môn thể thao với hiệu ứng FLIP animation mượt mà và mở modal xem chi tiết chứng chỉ.
 * Được gọi ở: src/routes/index.tsx (component Index trên trang chủ / của ứng dụng).
 * Các props quan trọng:
 * - dbCoaches: Danh sách huấn luyện viên thực tế từ database (tùy chọn); nếu để trống hoặc không truyền sẽ dùng danh sách mặc định COACHES.
 * @returns Khối JSX section #coaches gồm lưới thẻ huấn luyện viên, bộ lọc môn thể thao và modal thông tin chi tiết.
 */
export function CoachesScene({
  dbCoaches,
}: {
  dbCoaches?: Array<{ id: string; name: string; sports: string[] }>;
} = {}) {
  // Bước 1: Khởi tạo các ref và state quản lý bộ lọc môn thể thao, modal chi tiết và trạng thái hiệu ứng Flip.
  const root = useRef<HTMLElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [sport, setSport] = useState("");
  const [open, setOpen] = useState<CoachCard | null>(null);
  const flipState = useRef<Flip.FlipState | null>(null);
  const flipHeight = useRef(0);
  // Kiểm tra tùy chọn giảm chuyển động của người dùng (prefers-reduced-motion) để tắt animation khi cần thiết.
  const calm = useCalm();

  // Bước 2: Chuẩn hóa danh sách huấn luyện viên, hợp nhất dữ liệu từ database với thông tin giới thiệu có sẵn trong COACHES.
  const allCoaches = useMemo<CoachCard[]>(() => {
    if (!dbCoaches || !dbCoaches.length) return COACHES;
    return dbCoaches.map((dbc) => {
      // Ghép nối với danh sách COACHES theo id hoặc tên để tái sử dụng hình ảnh, chức danh và mô tả phong phú sẵn có.
      const match = COACHES.find((c) => c.userId === dbc.id || c.name === dbc.name);
      if (match) {
        return {
          ...match,
          sport: match.sport ?? dbc.sports[0] ?? "",
          userId: dbc.id,
          slot: `coach.${dbc.id}`,
        };
      }
      // Nếu là HLV mới từ database chưa có trong COACHES, tự động sinh thông tin mặc định theo môn đầu tiên được phân công.
      const sp = dbc.sports[0] ?? "";
      return {
        name: dbc.name,
        sport: sp,
        title: `${sportLabel(sp)} Coach`,
        blurb: "Dedicated coach at Lê Long Sport.",
        creds: dbc.sports.map((s) => sportLabel(s)),
        userId: dbc.id,
        slot: `coach.${dbc.id}`,
      };
    });
  }, [dbCoaches]);

  // Certifications the centre has on record and that still hold; the dialog lists them under the bio.
  // Bước 3: Tải danh sách chứng chỉ huấn luyện viên hợp lệ từ API backend (/coaches/certifications).
  const certRead = useRead<{ items: Certification[] }>("/coaches/certifications");
  /**
   * Làm gì: Lọc danh sách chứng chỉ hợp lệ theo coach_id (userId) của từng huấn luyện viên.
   * Được gọi ở: Thẻ HLV (dòng 171, 174 để hiện huy hiệu) và modal thông tin chi tiết (dòng 226, 230).
   * @param userId Mã định danh của huấn luyện viên.
   * @returns Danh sách chứng chỉ Certification tương ứng.
   */
  const certsOf = (userId?: string) => (userId ? (certRead.data?.items ?? []).filter((x) => x.coach_id === userId) : []);

  // Only sports still on offer, and only as many coaches as the manager chose to show.
  // Bước 4: Lọc HLV theo các môn đang mở, giới hạn số lượng hiển thị (landing_coaches) theo cấu hình của quản lý.
  const { sports } = useSports();
  const limits = useLimits();
  const offered = sports.length ? allCoaches.filter((c) => !c.sport || sports.some((s) => s.code === c.sport)) : allCoaches;
  const featured = offered.slice(0, limits.landing_coaches);
  // Lọc danh sách HLV hiển thị theo tab môn thể thao đang chọn (chuỗi rỗng nghĩa là chọn tất cả).
  const coaches = featured.filter((c) => !sport || c.sport === sport);
  // Chỉ hiển thị các tab môn thể thao thực sự có huấn luyện viên xuất hiện trong danh sách featured.
  const filterSports = sports.filter((s) => featured.some((c) => c.sport === s.code));

  // Kích hoạt hoạt ảnh cuộn trang (ScrollTrigger): đẩy section và các phần tử [data-rise] trồi lên khi người dùng cuộn tới.
  useScene(root, ({ motion }) => {
    if (motion && root.current) rise(root.current);
  });

  /**
   * Làm gì: Cập nhật môn thể thao được chọn và ghi lại vị trí các thẻ trước khi React re-render để phục vụ diễn hoạt FLIP.
   * Được gọi ở: Component Seg (sự kiện onChange của thanh chọn môn thể thao ở dòng 139).
   * @param next Mã môn thể thao được chọn (chuỗi rỗng "" tương ứng với "Tất cả").
   * @returns Không trả về giá trị (void).
   */
  const choose = (next: string) => {
    if (next === sport) return;
    // Chụp lại tọa độ/kích thước cũ của từng thẻ và chiều cao lưới trước khi React render lại DOM.
    if (grid.current && !motionOff(calm)) {
      flipState.current = Flip.getState(grid.current.querySelectorAll("[data-coach]"));
      flipHeight.current = grid.current.offsetHeight;
    }
    setSport(next);
  };

  // After React has laid the new grid out, play from where the cards were.
  // Bước 5: Kích hoạt animation GSAP Flip sau khi DOM cập nhật để di chuyển mượt mà các thẻ đến vị trí mới.
  useLayoutEffect(() => {
    const state = flipState.current;
    flipState.current = null;
    const box = grid.current;
    if (!state || !box) return;
    // `absolute` lifts the cards out of flow while they fly, so the grid would collapse and the
    // sections below jump up under them. Resize it from the old height to the new one instead,
    // started after Flip has read the new layout and held until the last card lands.
    const to = box.offsetHeight;
    // Xóa thuộc tính height inline trên grid sau khi diễn hoạt hoàn tất để lưới tự động co giãn theo CSS.
    const release = () => void gsap.set(box, { clearProps: "height" });
    // Diễn hoạt chuyển đổi FLIP: các thẻ giữ lại trượt đến vị trí mới, thẻ xuất hiện mới (onEnter) mờ dần và phóng to.
    const flip = Flip.from(state, {
      targets: box.querySelectorAll("[data-coach]"),
      duration: 0.65,
      ease: "arena",
      stagger: 0.04,
      absolute: true,
      scale: true,
      onEnter: (els) => gsap.fromTo(els, { autoAlpha: 0, scale: 0.86 }, { autoAlpha: 1, scale: 1, duration: 0.5, delay: 0.15 }),
      onComplete: release,
    });
    // Inside the Flip timeline, so it has rendered its last frame before onComplete clears it.
    flip.fromTo(box, { height: flipHeight.current }, { height: to, duration: 0.65, ease: "arena" }, 0);
    // Hủy tween và khôi phục chiều cao grid khi component unmount hoặc khi môn thể thao thay đổi.
    return () => {
      flip.kill();
      release();
    };
  }, [sport]);

  const lang = useLang();

  // Bước 6: Render giao diện khu vực huấn luyện viên gồm tiêu đề, thanh tab bộ lọc, lưới thẻ HLV và modal chi tiết.
  return (
    <section ref={root} id="coaches" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20">
      <p data-rise className="kicker text-2xs text-muted">
        {t("The team")}
      </p>
      <h2 className="mt-2 max-w-2xl font-display text-4xl sm:text-5xl">
        <SplitHeading text={t("Our coaches")} stagger={0.05} />
      </h2>
      <p data-rise className="mt-3 max-w-lg text-muted">
        {t("One head coach per sport, teaching from first footwork to match play. Join a class and its sessions appear in your schedule.")}
      </p>

      <div data-rise className="mt-6">
        <Seg
          value={sport}
          onChange={choose}
          options={[
            { value: "", label: t("All") },
            ...filterSports.map((s) => ({ value: s.code, label: lang === "vi" ? s.name_vi : s.name_en })),
          ]}
        />
      </div>

      {/* Five coaches sit in one row rather than leaving one card alone under four. */}
      <div ref={grid} className={`relative mt-7 grid gap-4 sm:grid-cols-2 ${coaches.length === 5 ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
        {coaches.map((c) => (
          <div key={c.name} data-coach data-flip-id={c.name} data-rise className="h-full">
            <SpotlightCard className="h-full rounded-[var(--radius-xl)]">
              <Card interactive className="group flex h-full flex-col overflow-hidden p-0">
                <GlareHover>
                  <Cover
                    slot={c.slot}
                    fallbackInitials={initials(c.name)}
                    initialsClassName="text-3xl font-bold"
                    alt={c.name}
                    scrim="none"
                    className="aspect-[4/5]"
                    imgClassName="transition-transform duration-[900ms] ease-[var(--ease-smooth)] group-hover:scale-105"
                  >
                    <MediaCaption>
                      <p className="kicker text-2xs text-on-media-muted">{sportLabel(c.sport || "")}</p>
                      <p className="athletic mt-1 text-2xl">{c.name}</p>
                    </MediaCaption>
                  </Cover>
                </GlareHover>
                <div className="flex flex-1 flex-col p-4">
                  <p className="flex-1 text-sm font-medium">{t(c.title)}</p>
                  {certsOf(c.userId).length ? (
                    <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                      <Award className="size-3.5 text-accent-2" aria-hidden />
                      {certsOf(c.userId).length === 1
                        ? t("1 certification")
                        : t("{n} certifications", { n: certsOf(c.userId).length })}
                    </p>
                  ) : null}
                  <Button size="sm" variant="outline" className="mt-3 w-full" onClick={() => setOpen(c)}>
                    {t("View details")}
                  </Button>
                </div>
              </Card>
            </SpotlightCard>
          </div>
        ))}
      </div>

      <Modal
        open={!!open}
        onClose={() => setOpen(null)}
        title={open?.name ?? ""}
        footer={
          <>
            <ButtonAnchor href="#classes" onClick={() => setOpen(null)}>
              {t("See open classes")}
            </ButtonAnchor>
            <Button variant="ghost" onClick={() => setOpen(null)}>
              {t("Close")}
            </Button>
          </>
        }
      >
        {open ? (
          <div className="grid gap-4 sm:grid-cols-[9rem_1fr]">
            <Cover
              slot={open.slot}
              fallbackInitials={initials(open.name)}
              initialsClassName="text-3xl font-bold"
              alt={open.name}
              scrim="none"
              className="aspect-[3/4] rounded-[var(--radius-lg)]"
            />
            <div>
              <p className="kicker text-2xs text-muted">{sportLabel(open.sport || "")}</p>
              <p className="mt-1 text-sm font-medium">{t(open.title)}</p>
              <p className="mt-3 text-sm text-muted">{t(open.blurb)}</p>
              <ul className="mt-4 grid gap-1.5 text-sm text-muted">
                {open.creds.map((x) => (
                  <li key={x} className="flex gap-2">
                    <span className="text-accent">·</span>
                    {t(x)}
                  </li>
                ))}
              </ul>
              {certsOf(open.userId).length ? (
                <div className="mt-5">
                  <p className="kicker text-2xs text-muted">{t("Certifications")}</p>
                  <ul className="mt-2 grid gap-2">
                    {certsOf(open.userId).map((x) => (
                      <li key={x.id} className="flex gap-2 text-sm">
                        <Award className="mt-0.5 size-4 shrink-0 text-accent-2" aria-hidden />
                        <span>
                          <span className="font-medium">{x.name}</span>
                          {certificationLine(x) ? (
                            <span className="block text-xs text-muted">{certificationLine(x)}</span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </Modal>
    </section>
  );
}
