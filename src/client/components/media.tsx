/**
 * File: src/client/components/media.tsx
 * Vai trò: Quản lý và hiển thị tài nguyên truyền thông (hình ảnh banner, ảnh bìa thể thao, video hero, bộ đếm giữ chỗ) trong hệ thống Arena 3.
 * Vị trí trong app:
 * - Cung cấp SiteAssetsProvider và SiteAssetsContext để lưu trữ, chia sẻ và làm mới dữ liệu media (PublicSiteAsset) toàn ứng dụng.
 * - Cung cấp các component hiển thị media chuẩn hóa: Cover (ảnh bìa), PhotoBanner (banner đầu trang), MediaCaption (thanh phụ đề chuẩn WCAG).
 * - Cung cấp các hook tra cứu tiện ích useAsset, useSportPhoto và các component kiểm soát tải video mở đầu (HeroVideo, BootGate).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cn } from "@/client/lib/cn";
import { useCalm } from "@/client/lib/calm";
import { sportPhoto } from "@/shared/arena3/media";
import { t, useLang } from "@/client/lib/i18n";
import { ArenaMark } from "./mark";

/**
 * Làm gì: Re-export hàm sportPhoto từ shared media để các component phía client tiện import cùng các media component khác.
 * Được gọi ở:
 * - src/routes/app.book.tsx: lấy banner theo môn khi đặt sân
 * - src/routes/app.classes.tsx: lấy ảnh bìa môn học
 * @param sport Tên hoặc mã môn thể thao (ví dụ: "badminton", "basketball").
 * @returns Mã slot media tương ứng dạng "sport.<mã>" hoặc "sport.all".
 */
export { sportPhoto };

// Kiểu dữ liệu mô tả tài nguyên media công khai (ảnh/video) của trang web gắn với một slot định danh
export type PublicSiteAsset = {
  slot: string;
  kind: "image" | "video";
  url: string;
  alt_en: string;
  alt_vi: string;
  enabled: boolean;
  width?: number | null;
  height?: number | null;
};

// Kiểu dữ liệu của SiteAssetsContext gồm bảng tra cứu Map các asset theo slot và hàm refresh để tải lại từ server
type SiteAssetsContextType = {
  assets: Map<string, PublicSiteAsset>;
  refresh: () => Promise<void>;
};

// React Context lưu trữ và phân phối danh sách tài nguyên trang web (theo slot) cho toàn bộ cây component
const SiteAssetsContext = createContext<SiteAssetsContextType | null>(null);

/**
 * Làm gì: React Context Provider quản lý bộ nhớ đệm (Map) danh sách tài nguyên media của trang web và cung cấp hàm refresh để tải lại từ server.
 * Được gọi ở: src/routes/__root.tsx (bọc ngoài toàn bộ ứng dụng tại root layout để mọi màn hình đều có thể lấy ảnh/video theo slot).
 * @param children Các component con bên trong ứng dụng nhận dữ liệu từ Provider.
 * @param initialAssets Danh sách tài nguyên ban đầu truyền từ loader SSR (nếu có).
 * @returns Thẻ JSX SiteAssetsContext.Provider cung cấp context value cho các component con.
 */
export function SiteAssetsProvider({
  children,
  initialAssets,
}: {
  children: ReactNode;
  initialAssets?: PublicSiteAsset[];
}) {
  // Bước 1: Khởi tạo state assetMap dạng Map<slot, PublicSiteAsset> từ initialAssets nếu có sẵn
  const [assetMap, setAssetMap] = useState<Map<string, PublicSiteAsset>>(() => {
    const map = new Map<string, PublicSiteAsset>();
    if (initialAssets) {
      // Đưa từng asset vào Map với key là slot để việc tra cứu theo slot sau này đạt độ phức tạp O(1)
      for (const a of initialAssets) {
        map.set(a.slot, a);
      }
    }
    return map;
  });

  // Bước 2: Tạo hàm refresh để fetch lại danh sách media mới nhất từ API GET /v1/site-assets (no-cache) khi quản lý vừa cập nhật ảnh
  const refresh = useCallback(async () => {
    try {
      // The list is cached for a minute; a manager who just changed a photo should see it now.
      const res = await fetch("/v1/site-assets", { cache: "no-cache" });
      if (!res.ok) return;
      const data = (await res.json()) as { items?: PublicSiteAsset[] };
      if (Array.isArray(data.items)) {
        const next = new Map<string, PublicSiteAsset>();
        for (const it of data.items) {
          next.set(it.slot, it);
        }
        setAssetMap(next);
      }
    } catch {
      // Network/offline: keep current asset map
    }
  }, []);

  // Bước 3: Tự động gọi refresh khi ứng dụng khởi chạy nếu chưa có initialAssets từ loader
  useEffect(() => {
    if (!initialAssets || initialAssets.length === 0) {
      void refresh();
    }
  }, [initialAssets, refresh]);

  // Bước 4: Đóng gói assetMap và hàm refresh vào context value với useMemo để tránh kích hoạt re-render thừa cho các component con
  const value = useMemo(() => ({ assets: assetMap, refresh }), [assetMap, refresh]);

  return <SiteAssetsContext.Provider value={value}>{children}</SiteAssetsContext.Provider>;
}

/** Reads the site's pictures again, after a manager changed one. */
export function useRefreshAssets(): () => Promise<void> {
  const ctx = useContext(SiteAssetsContext);
  return ctx?.refresh ?? (async () => {});
}

// Kết quả trả về của hook useAsset gồm đường dẫn url, văn bản alt, trạng thái enabled và loại kind (image/video)
export type AssetResult = {
  url: string;
  alt: string;
  enabled: boolean;
  kind?: "image" | "video";
};

/**
 * Làm gì: Hook tra cứu thông tin tài nguyên media (url, alt, enabled, kind) theo mã slot từ SiteAssetsContext và tự động chọn alt text theo ngôn ngữ hiện tại (vi/en).
 * Được gọi ở:
 * - src/client/components/media.tsx: các component Cover, PhotoBanner, HeroVideo và hook useSportPhoto
 * @param slot Mã định danh vị trí media cần tra cứu (ví dụ: "landing.hero.image", "auth.login.image", "sport.badminton").
 * @returns Đối tượng AssetResult chứa url, alt phù hợp ngôn ngữ, cờ enabled và kind. Trả về giá trị mặc định an toàn nếu không tìm thấy.
 */
export function useAsset(slot?: string | null): AssetResult {
  const ctx = useContext(SiteAssetsContext);
  const lang = useLang();
  // Bước 1: Trả về object mặc định an toàn nếu không truyền slot hoặc component nằm ngoài SiteAssetsProvider
  if (!slot || !ctx) {
    return { url: "", alt: "", enabled: true };
  }
  // Bước 2: Tra cứu tài nguyên theo slot từ bảng Map trong context; nếu chưa cấu hình thì trả về giá trị mặc định
  const item = ctx.assets.get(slot);
  if (!item) {
    return { url: "", alt: "", enabled: true };
  }
  // Bước 3: Ưu tiên chọn văn bản mô tả (alt) theo ngôn ngữ người dùng đang chọn (tiếng Việt hoặc tiếng Anh), tự fallback sang ngôn ngữ còn lại
  const alt = lang === "vi" ? (item.alt_vi || item.alt_en || "") : (item.alt_en || item.alt_vi || "");
  return {
    url: item.url ?? "",
    alt,
    enabled: item.enabled,
    kind: item.kind,
  };
}

/**
 * Làm gì: Hook tiện ích tra cứu ảnh bìa của một môn thể thao cụ thể (chuẩn hóa tên môn thành slot "sport.<mã>" rồi tra cứu qua useAsset).
 * Được gọi ở: Các màn hình hiển thị thông tin môn thể thao, danh sách lớp học hoặc đăng ký gói tập.
 * @param sport Tên hoặc mã môn thể thao (ví dụ: "badminton", "pickleball", "basketball").
 * @returns Đối tượng AssetResult chứa thông tin ảnh bìa của môn thể thao đó.
 */
export function useSportPhoto(sport: string): AssetResult {
  return useAsset(sportPhoto(sport));
}

/**
 * Làm gì: Component hiển thị ảnh bìa (cover image) đa năng, tự động tra cứu ảnh theo slot hoặc dùng src trực tiếp, hỗ trợ lớp phủ tương phản (scrim), fallback chữ cái đầu (initials) và xử lý ảnh lỗi.
 * Được gọi ở:
 * - src/routes/app.classes.tsx: ảnh đại diện lớp học theo môn
 * - src/routes/app.plans.tsx và src/routes/manager.plans.tsx: ảnh thẻ gói tập
 * - src/routes/login.tsx và src/routes/register.tsx: ảnh bìa màn hình xác thực
 * - src/routes/manager.staff.tsx: ảnh đại diện nhân viên/HLV
 * - src/client/components/media.tsx: component PhotoBanner
 * @param slot Mã vị trí media để tự động lấy URL và alt text từ context (ví dụ: "plan.default", "auth.login.image").
 * @param src Đường dẫn ảnh trực tiếp (được ưu tiên hơn slot nếu cả hai cùng có).
 * @param alt Văn bản mô tả ảnh thay thế cho người dùng khiếm thị (chuẩn WCAG).
 * @param scrim Kiểu lớp phủ gradient tối: "hero" (phủ đậm), "media" (phủ vừa), "auto" (tự bật khi có children đè lên ảnh) hoặc "none".
 * @param eager Khi true, tải ảnh ngay lập tức với fetchPriority="high" thay vì lazy load (dành cho ảnh đầu trang above-the-fold).
 * @param fallbackInitials Chữ cái viết tắt hiển thị thay thế khi ảnh trống hoặc bị lỗi tải (ví dụ tên HLV).
 * @param children Các phần tử JSX (nút bấm, phụ đề, nhãn) hiển thị nổi bên trên ảnh.
 * @returns Khung JSX chứa ảnh nền object-cover, lớp phủ scrim và nội dung con.
 */
export function Cover({
  slot,
  src,
  alt,
  className,
  imgClassName,
  scrim = "auto",
  style,
  children,
  eager = false,
  fallbackInitials,
  initialsClassName,
}: {
  slot?: string;
  src?: string;
  alt?: string;
  className?: string;
  imgClassName?: string;
  scrim?: "auto" | "media" | "hero" | "none";
  style?: CSSProperties;
  children?: ReactNode;
  /** The one picture above the fold: fetched first instead of when it scrolls near. */
  eager?: boolean;
  fallbackInitials?: string;
  initialsClassName?: string;
}) {
  // Bước 1: Tra cứu asset từ context theo slot và xác định URL, alt text và trạng thái hiển thị hiệu lực (ưu tiên prop trực tiếp hơn asset)
  const asset = useAsset(slot);
  // Lưu lại URL bị lỗi tải để chuyển sang giao diện fallback (initials hoặc nền trống), tránh vòng lặp re-render lỗi ảnh
  const [broken, setBroken] = useState<string | null>(null);
  const effectiveUrl = src ?? asset.url;
  const effectiveAlt = alt !== undefined ? alt : asset.alt;
  const enabled = slot ? asset.enabled : true;

  // Bước 2: Quyết định có hiển thị lớp phủ gradient tối (scrim) không; tự động bật khi có children để chữ đè lên ảnh dễ đọc hơn (đạt độ tương phản WCAG)
  const showScrim = scrim === "media" || scrim === "hero" || (scrim === "auto" && children != null);

  // Bước 3: Render ảnh nền với object-cover (hoặc initials nếu ảnh hỏng/chưa có), kèm lớp phủ scrim chống chói và children ở tầng trên cùng (z-[2])
  return (
    <div className={cn("relative overflow-hidden bg-wood", className)} style={style}>
      {enabled && effectiveUrl && broken !== effectiveUrl ? (
        <img
          src={effectiveUrl}
          onError={() => setBroken(effectiveUrl)}
          alt={effectiveAlt}
          aria-hidden={!effectiveAlt ? true : undefined}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          fetchPriority={eager ? "high" : undefined}
          className={cn("absolute inset-0 z-0 size-full object-cover", imgClassName)}
        />
      ) : fallbackInitials ? (
        <div
          className={cn(
            "absolute inset-0 z-0 flex select-none items-center justify-center bg-wood font-display font-bold text-muted",
            initialsClassName ?? "text-xl sm:text-2xl",
          )}
        >
          {fallbackInitials}
        </div>
      ) : null}
      {showScrim ? (
        <div
          className={cn(
            "pointer-events-none absolute inset-0 z-[1]",
            scrim === "hero" ? "hero-scrim" : "media-scrim",
          )}
        />
      ) : null}
      {children ? <div className="relative z-[2] size-full">{children}</div> : null}
    </div>
  );
}

/** A wide photo strip at the top of a screen: it says whose screen this is before any word is read. */
export function PhotoBanner({
  slot,
  src,
  className,
  focus = "50% 50%",
}: {
  slot?: string;
  src?: string;
  className?: string;
  /** CSS object-position: where in the photo the strip should stay centred (faces, not feet). */
  focus?: string;
}) {
  const asset = useAsset(slot);
  // Không hiển thị banner nếu vị trí slot này đã bị quản lý vô hiệu hóa (enabled = false)
  if (slot && !asset.enabled) return null;
  return (
    <Cover
      slot={slot}
      src={src}
      alt=""
      scrim="none"
      className={cn("h-32 rounded-[var(--radius-lg)] sm:h-44", className)}
      imgClassName="[object-position:var(--focus)]"
      style={{ "--focus": focus } as CSSProperties}
    />
  );
}

/** Solid 82% ink bar — captions never sit on the photo itself (Stitch/WCAG). */
export function MediaCaption({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("absolute inset-x-0 bottom-0 caption-bar px-4 py-3", className)}>
      {children}
    </div>
  );
}

// Context truyền hàm callback báo hiệu sẵn sàng (signal ready) từ HeroVideo lên BootGate khi video đã nạp đủ dữ liệu
const BootReady = createContext<(() => void) | null>(null);
// True once the cover is gone. Outside a BootGate there is no cover, so it is always open.
const BootOpen = createContext(true);

/** Whether the BootGate around this component has lifted, for intros that must be seen. */
export function useBootOpen() {
  return useContext(BootOpen);
}

/**
 * Covers the page until the hero video can play. The cover is a blank ground
 * for the first moment; the mark only appears once the wait is actually slow,
 * and a file that never arrives still lets the page open.
 */
export function BootGate({ children }: { children: ReactNode }) {
  // Bước 1: Khởi tạo các trạng thái cổng chờ (ready: đã mở cổng, slow: tải chậm > 400ms) và hàm signal phát tín hiệu sẵn sàng
  const calm = useCalm();
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);
  const signal = useCallback(() => setReady(true), []);

  // Bước 2: Thiết lập thời gian chờ để tự động mở cổng và hiển thị màn hình chờ khi tải chậm
  useEffect(() => {
    // Chế độ calm (giảm hiệu ứng chuyển động): mở cổng ngay lập tức, không chờ video phát
    if (calm) {
      setReady(true);
      return;
    }
    // Sau 400ms nếu chưa tải xong mới hiển thị logo và thông báo chờ, tránh giật nhấp nháy khi tải nhanh
    const show = window.setTimeout(() => setSlow(true), 400);
    // Giới hạn tối đa 1.800ms (1,8s): ép mở cổng để người dùng không bị kẹt lại nếu video gặp sự cố hoặc mạng chậm
    const cap = window.setTimeout(() => setReady(true), 1_800);
    // Hủy bỏ các bộ đếm thời gian khi unmount để tránh rò rỉ bộ nhớ
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(cap);
    };
  }, [calm]);

  // Bước 3: Cung cấp signal và cờ ready cho component con; che phủ toàn trang và vô hiệu hóa tương tác trong khi chờ
  return (
    <BootReady.Provider value={signal}>
      <BootOpen.Provider value={ready}>
        <div aria-hidden={ready ? undefined : true} inert={ready ? undefined : true}>
          {children}
        </div>
      </BootOpen.Provider>
      {ready ? null : (
        <div className="fixed inset-0 z-[60] bg-bg" aria-busy="true">
          {slow ? (
            <div className="grid h-full place-items-center text-muted" role="status">
              <div className="flex flex-col items-center gap-3">
                <ArenaMark />
                <p className="font-display text-lg">{t("Opening Lê Long Sport")}</p>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </BootReady.Provider>
  );
}

/**
 * A muted, looping background video that only fetches once it is near the
 * viewport — and never before the page has painted.
 */
export function HeroVideo({
  slot,
  posterSlot,
  src,
  poster,
  className,
  priority = false,
}: {
  slot?: string;
  posterSlot?: string;
  src?: string;
  poster?: string;
  className?: string;
  priority?: boolean;
}) {
  // Bước 1: Tra cứu asset video và tự động suy luận poster tương ứng từ slot cấu hình (hero, pricing hoặc login)
  const videoAsset = useAsset(slot);
  const inferredPosterSlot =
    posterSlot ??
    (slot === "landing.hero.video"
      ? "landing.hero.image"
      : slot === "landing.pricing.video"
      ? "landing.pricing.image"
      : slot === "auth.login.video"
      ? "auth.login.image"
      : undefined);
  const posterAsset = useAsset(inferredPosterSlot);

  // Ưu tiên URL trực tiếp từ props nếu có, ngược lại lấy từ kho asset được cấu hình
  const effectiveSrc = src ?? videoAsset.url;
  const effectivePoster = poster ?? posterAsset.url;
  const videoEnabled = slot ? videoAsset.enabled : true;

  // Bước 2: Khởi tạo ref và các trạng thái điều khiển video (near: cuộn gần, wanted: bắt đầu tải src, signal: mở BootGate)
  const ref = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  const calm = useCalm();
  const signal = useContext(BootReady);
  const [wanted, setWanted] = useState(priority);

  // Bước 3: Đánh dấu wanted khi video cuộn gần màn hình và người dùng không bật chế độ calm
  useEffect(() => {
    if (near && !calm) setWanted(true);
  }, [near, calm]);

  // Bước 4: Xử lý video ưu tiên cao (priority) — phối hợp với BootGate để nhấc màn hình che khi video sẵn sàng phát
  useEffect(() => {
    if (!priority) return;
    const v = ref.current;
    // Nếu ở chế độ calm: dừng video, xóa src để giải phóng tài nguyên và kích hoạt signal để mở trang ngay
    if (calm) {
      if (v) {
        v.pause();
        v.removeAttribute("src");
        v.load();
      }
      signal?.();
      return;
    }
    if (!v) {
      signal?.();
      return;
    }
    // Hàm tiện ích phát tín hiệu sẵn sàng mở cổng chào
    const done = () => signal?.();
    // Nếu video đã có sẵn dữ liệu khung hình tương lai (HAVE_FUTURE_DATA), mở cổng chào ngay lập tức
    if (v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      done();
      return;
    }
    // Lắng nghe sự kiện canplay hoặc error (lỗi tải video) để luôn mở cổng chào, không để người dùng bị kẹt
    v.addEventListener("canplay", done);
    v.addEventListener("error", done);
    return () => {
      v.removeEventListener("canplay", done);
      v.removeEventListener("error", done);
    };
  }, [priority, calm, signal]);

  // Bước 5: Tự động phát hoặc tạm dừng video khi trạng thái wanted hoặc calm thay đổi (bắt lỗi autoplay bị chặn)
  useEffect(() => {
    const v = ref.current;
    if (!v || !wanted) return;
    if (calm) v.pause();
    else void v.play().catch(() => undefined);
  }, [calm, wanted]);

  // Bước 6: Dùng IntersectionObserver theo dõi vùng nhìn (rootMargin 400px) để tải trước video khi người dùng cuộn tới gần
  useEffect(() => {
    const el = ref.current;
    if (!el || near || priority) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    // Hàm kiểm tra phần tử có kích thước 0 (chưa dàn trang xong)
    const empty = (n: HTMLElement) => {
      const r = n.getBoundingClientRect();
      return r.width === 0 || r.height === 0;
    };
    // Leo ngược cây DOM tìm phần tử cha có kích thước hợp lệ để theo dõi vị trí hiển thị
    let target: HTMLElement = el;
    while (empty(target) && target.parentElement) {
      target = target.parentElement;
    }
    if (empty(target)) {
      setNear(true);
      return;
    }
    // Thiết lập IntersectionObserver với biên đệm 400px để tải video trước khi cuộn vào khung nhìn
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: "400px" },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [near, priority]);

  // When video slot is disabled, fall back to the poster image
  // Bước 7: Khi slot video bị vô hiệu hóa trong cấu hình, fallback hiển thị ảnh poster tĩnh
  if (!videoEnabled) {
    if (!effectivePoster) return null;
    return (
      <img
        src={effectivePoster}
        alt={posterAsset.alt}
        aria-hidden={!posterAsset.alt ? true : undefined}
        className={cn("absolute inset-0 size-full object-cover", className)}
      />
    );
  }

  return (
    // Bước 8: Render thẻ video chạy ngầm không tiếng (muted), tự động lặp (loop) và tối ưu trên di động (playsInline)
    <video
      ref={ref}
      className={cn("absolute inset-0 size-full object-cover", className)}
      src={wanted && effectiveSrc ? effectiveSrc : undefined}
      poster={effectivePoster}
      autoPlay={!calm}
      muted
      loop
      playsInline
      preload={priority ? "auto" : "none"}
      aria-hidden
    />
  );
}

/**
 * Làm gì: Tính số giây còn lại từ thời điểm hiện tại đến mốc thời gian hết hạn (until), không trả về số âm.
 * Được gọi ở: src/client/components/media.tsx (trong component HoldTimer).
 * @param until Chuỗi thời gian ISO mốc hết hạn giữ chỗ sân.
 * @returns Số giây nguyên còn lại (tối thiểu là 0).
 */
function secsLeft(until: string) {
  // Trừ thời gian đích cho thời gian hiện tại, đổi sang giây và chặn dưới bằng 0 để tránh số âm khi quá hạn
  return Math.max(0, Math.floor((new Date(until).getTime() - Date.now()) / 1000));
}

/**
 * Làm gì: Hiển thị bộ đếm ngược thời gian giữ chỗ sân (định dạng mm:ss) và kích hoạt callback khi hết hạn.
 * Được gọi ở: src/routes/app.book.tsx (màn hình đặt sân); src/routes/desk.payments.tsx (màn hình thu ngân).
 * @param until Mốc thời gian ISO hết hạn giữ chỗ.
 * @param onExpire Callback tùy chọn được kích hoạt một lần duy nhất khi thời gian đếm về 0.
 * @returns Thẻ span hiển thị thời gian phút:giây với định dạng tabular-nums cố định độ rộng số.
 */
export function HoldTimer({ until, onExpire }: { until: string; onExpire?: () => void }) {
  // Bước 1: Khởi tạo số giây còn lại ban đầu và các ref lưu callback onExpire cùng cờ fired chống gọi lặp
  const [left, setLeft] = useState(() => secsLeft(until));
  const fired = useRef(false);
  const expireRef = useRef(onExpire);
  // Cập nhật ref mỗi lần render để tránh lỗi stale closure mà không kích hoạt lại useEffect
  expireRef.current = onExpire;
  // Bước 2: Thiết lập vòng lặp đếm ngược mỗi 250ms, tính toán lại thời gian còn lại và gọi callback khi hết hạn
  useEffect(() => {
    // Đặt lại cờ fired khi thời điểm hết hạn (until) thay đổi
    fired.current = false;
    const tick = () => {
      const n = secsLeft(until);
      setLeft(n);
      // Khi thời gian hết hạn (n <= 0) và chưa từng kích hoạt, đánh dấu fired và gọi callback onExpire
      if (n <= 0 && !fired.current) {
        fired.current = true;
        expireRef.current?.();
      }
    };
    tick();
    // Thăm dò mỗi 250ms (thay vì 1.000ms) để phản ánh tức thì bước nhảy giây và hạn chế trôi đồng hồ JavaScript
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [until]);
  // Bước 3: Chuyển đổi số giây còn lại thành phút (m) và giây có chèn số 0 ở đầu (s)
  const m = Math.floor(left / 60);
  const s = String(left % 60).padStart(2, "0");
  // Bước 4: Hiển thị thời gian định dạng mm:ss với class tabular-nums để số không bị nhảy giật khi đổi chữ số
  return (
    <span className="tabular-nums">
      {m}:{s}
    </span>
  );
}
