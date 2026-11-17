/**
 * File: src/routes/app.pass.tsx
 * Vai trò: Trang thẻ ra vào (Gate pass) và tự điểm danh (Self check-in) cho hội viên.
 * Vị trí trong app: Route /app/pass, phục vụ hội viên xuất trình mã QR động tại quầy lễ tân
 *   hoặc tự quét mã từ màn hình quầy để điểm danh vào trung tâm thể thao.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { toast } from "sonner";
import { ScanLine } from "@/client/components/arena-icons";
import { Shell, useSessionUser } from "@/client/components/shell";
import { Badge, Button, ButtonLink, Card, Field, Input, LoadError, PageHero, Skeleton } from "@/client/components/ui";
import { Tilt } from "@/client/components/motion";
import { GlareHover } from "@/client/components/fx";
import { apiGet, apiPost } from "@/client/arena3/client";
import { QrScanner, tokenFromScan } from "@/client/components/qr-scanner";
import { t } from "@/client/lib/i18n";

/**
 * Làm gì: Định nghĩa route /app/pass bằng TanStack Router, gắn kết URL với component Page để hiển thị thẻ vào cổng cho hội viên.
 * Được gọi ở: URL "/app/pass" (được liên kết từ thanh điều hướng Shell, trang chủ /app và trang xác nhận đặt sân /app/book).
 * @returns Đối tượng cấu hình route của TanStack Router.
 */
export const Route = createFileRoute("/app/pass")({ component: Page });

type Token = {
  token: string;
  expires_at: string;
  ttl_seconds: number;
  member_code?: string | null;
  full_name?: string;
};

/** Redraw a little early so a code is never shown in its last seconds (UI-22). */
const REFRESH_MARGIN_MS = 5000;

/**
 * Làm gì: Component giao diện chính hiển thị thẻ hội viên điện tử với mã QR động tự làm mới và khu vực tự điểm danh tại quầy.
 * Được gọi ở: Route /app/pass (khai báo tại file này).
 * @returns Phần tử JSX biểu diễn giao diện thẻ ra vào và tự điểm danh.
 */
function Page() {
  const user = useSessionUser();
  const [tok, setTok] = useState<Token | null>(null);
  const [img, setImg] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selfCode, setSelfCode] = useState("");
  const [selfBusy, setSelfBusy] = useState(false);
  const [inside, setInside] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Làm gì: Gọi API /me/checkin-token lấy mã token mới, sinh ảnh QR base64 và hẹn giờ tự động làm mới trước khi token hết hạn.
   * Được gọi ở: Component Page (khi trang mount, khi quay lại tab từ trạng thái ngủ, nút "New code", hoặc thử lại khi lỗi).
   * @returns Promise<void>
   */
  const refresh = useCallback(async () => {
    try {
      // Bước 1: Gọi API lấy mã token điểm danh mới nhất của hội viên (kèm thời gian hết hạn expires_at).
      const next = await apiGet<Token>("/me/checkin-token");
      setError(null);
      setTok(next);
      // Bước 2: Tạo ảnh QR Data URL từ token; sử dụng errorCorrectionLevel "M" và nền trắng để máy quét ở quầy đọc rõ.
      setImg(await QRCode.toDataURL(next.token, { margin: 1, width: 320, errorCorrectionLevel: "M" }));
      // Bước 3: Hủy timer cũ và hẹn giờ làm mới sớm hơn 5 giây (REFRESH_MARGIN_MS), tối thiểu chờ 5 giây để tránh gửi dồn request.
      if (timer.current) clearTimeout(timer.current);
      const wait = Math.max(5000, new Date(next.expires_at).getTime() - Date.now() - REFRESH_MARGIN_MS);
      timer.current = setTimeout(() => void refresh(), wait);
    } catch (e) {
      // Nếu gặp lỗi mạng hoặc API, lưu thông báo lỗi để hiển thị và hẹn giờ thử lại sau 15 giây.
      setError(e instanceof Error ? e.message : t("Could not make a code"));
      timer.current = setTimeout(() => void refresh(), 15000);
    }
  }, []);

  // Tải mã ngay khi mở trang và theo dõi sự kiện visibilitychange để lập tức tạo mã mới nếu người dùng vừa mở lại điện thoại.
  useEffect(() => {
    void refresh();
    // A phone that was asleep when the code ran out wakes up to a dead code.
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // Cập nhật số giây còn hiệu lực của mã QR mỗi 500ms để hiển thị thời gian còn lại trên Badge.
  useEffect(() => {
    if (!tok) return;
    const tick = () => setLeft(Math.max(0, Math.round((new Date(tok.expires_at).getTime() - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [tok]);

  /**
   * Làm gì: Gửi mã điểm danh quét từ quầy lễ tân lên server để hội viên tự check-in vào cơ sở thể thao.
   * Được gọi ở: Component Page (useEffect khi URL có tham số "?d=...", hàm submit selfCheckin, hoặc callback onCode của QrScanner).
   * @param code Chuỗi mã hoặc đường dẫn quét được từ màn hình quầy lễ tân.
   * @returns Promise<void>
   */
  const sendSelf = useCallback(async (code: string) => {
    // Bước 1: Đánh dấu đang xử lý (selfBusy = true) để vô hiệu hóa nút bấm và camera, tránh gửi yêu cầu trùng lặp.
    setSelfBusy(true);
    try {
      // Bước 2: Trích xuất token sạch bằng tokenFromScan rồi gửi yêu cầu tự điểm danh qua API /me/self-checkin.
      const res = await apiPost<{ allowed: boolean; duplicate?: boolean; message?: string }>("/me/self-checkin", {
        token: tokenFromScan(code),
      });
      // Bước 3: Xử lý kết quả trả về: nếu thành công thì hiển thị thông báo đã check-in, nếu từ chối thì báo lỗi yêu cầu gặp quầy lễ tân.
      if (res.allowed) {
        setInside(res.duplicate ? t("You are already checked in today.") : t("You are checked in. Enjoy your session."));
        setSelfCode("");
      } else {
        toast.error(res.message ?? t("Please see the front desk."));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("That code did not work"));
    } finally {
      setSelfBusy(false);
    }
  }, []);

  // The desk screen shows a QR that opens this page with the code attached, so
  // a member only needs their phone camera (SRS FR-TRN-02).
  useEffect(() => {
    const d = new URLSearchParams(window.location.search).get("d");
    if (!d) return;
    // Xóa tham số "?d" khỏi thanh địa chỉ URL để tránh tự động điểm danh lại nếu hội viên nhấn F5 tải lại trang.
    window.history.replaceState(null, "", window.location.pathname);
    void sendSelf(d);
  }, [sendSelf]);

  /**
   * Làm gì: Xử lý sự kiện submit form khi hội viên nhập mã check-in của quầy thủ công bằng bàn phím.
   * Được gọi ở: Sự kiện onSubmit của thẻ <form> tự điểm danh trong component Page.
   * @param e Sự kiện FormEvent phát sinh khi submit form.
   * @returns void
   */
  function selfCheckin(e: React.FormEvent) {
    // Chặn hành vi reload trang mặc định của trình duyệt và chỉ gửi mã nếu ô nhập có dữ liệu.
    e.preventDefault();
    if (selfCode.trim()) void sendSelf(selfCode.trim());
  }

  return (
    <Shell role="member">
      <PageHero
        slot="banner.gate"
        title={t("Gate pass")}
        subtitle={t("Show this code to the front desk. It changes every minute.")}
        fallbackSpot="gate"
      />

      <div className="grid max-w-md gap-6 mx-auto sm:mx-0">
        <Tilt>
          <GlareHover duration={1.2} className="rounded-[var(--radius-xl)]">
            <Card className="grid place-items-center gap-3 p-6 bg-surface shadow-[var(--shadow-soft)]">
              {error ? (
                <LoadError message={error} onRetry={() => void refresh()} />
              ) : img ? (
                // The code must stay readable in sunlight: white tile, no theming.
                <div className="relative overflow-hidden rounded-[var(--radius-md)]">
                  <img
                    src={img}
                    alt={t("Your check-in code")}
                    className="size-64 bg-white p-2"
                  />
                  <ScanLine />
                </div>
              ) : (
                <Skeleton className="size-64" />
              )}
              <div className="my-1 text-center">
                <p className="text-2xs font-semibold uppercase tracking-wider text-muted">
                  {t("Member Code")}
                </p>
                <p className="font-mono text-2xl font-bold tracking-widest text-primary">
                  {tok?.member_code || user?.member_code || "—"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={left > 10 ? "accent" : "hold"}>{tok ? t("Valid for {n}s", { n: left }) : t("Making a code…")}</Badge>
                <Button size="sm" variant="ghost" onClick={() => void refresh()}>
                  {t("New code")}
                </Button>
              </div>
              <p className="text-center text-xs text-muted">
                {t("This only lets the desk see who you are. It does not use up a session or change your plan.")}
              </p>
            </Card>
          </GlareHover>
        </Tilt>

        <Card>
          <form onSubmit={selfCheckin} className="grid gap-3">
            <Field tone="muted"
              label={t("Check yourself in")}
              hint={t("Only when the centre has turned this on. Scan the code on the front-desk screen with your phone camera, or paste what it reads.")}
            >
              <Input value={selfCode} onChange={(e) => setSelfCode(e.target.value)} placeholder={t("Code from the desk screen")} />
            </Field>
            <QrScanner
              startLabel={t("Scan the desk code")}
              onCode={(c) => {
                if (!selfBusy) void sendSelf(c);
              }}
            />
            <div>
              <Button type="submit" variant="outline" disabled={selfBusy || !selfCode.trim()}>
                {selfBusy ? t("Checking…") : t("Check in")}
              </Button>
            </div>
            {inside ? (
              <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-accent/30 bg-accent/5 p-3">
                <p className="text-sm font-medium text-fg">{inside}</p>
                <ButtonLink to="/app" size="sm">
                  {t("Back to schedule")}
                </ButtonLink>
              </div>
            ) : null}
          </form>
        </Card>
      </div>
    </Shell>
  );
}
