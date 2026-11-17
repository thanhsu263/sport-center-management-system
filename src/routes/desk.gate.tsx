/**
 * File: src/routes/desk.gate.tsx
 * Vai trò: Trang quản lý cổng ra vào và điểm danh (gate check-in) tại quầy lễ tân cho hệ thống Arena3.
 * Vị trí trong app: URL /desk/gate; phục vụ lễ tân quét mã QR hoặc nhập thông tin hội viên để mở cổng, xử lý phê duyệt ghi đè (override) và theo dõi danh sách vào cổng hôm nay qua kết nối thời gian thực (SSE).
 */
import { createFileRoute } from "@tanstack/react-router";
import { SectionTitle } from "@/client/components/section";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { toast } from "sonner";
import { Shell, hhmm, useSessionUser } from "@/client/components/shell";
import { UserAvatar } from "@/client/components/user-avatar";
import { QrScanner, tokenFromScan } from "@/client/components/qr-scanner";
import { PageHero } from "@/client/components/page-hero";
import { Badge, Button, Card, EmptyState, Field, Input, LoadError, Pagination, Select, Seg, Skeleton } from "@/client/components/ui";
import { ApiClientError, apiGet, apiPost } from "@/client/arena3/client";
import { sportLabel } from "@/shared/arena3/labels";
import { t, tk, tServer, tData } from "@/client/lib/i18n";
import { usePageState } from "@/client/lib/use-page-state";
import { readError, useRead } from "@/client/lib/use-read";
import { useLive } from "@/client/lib/use-live";

/**
 * Làm gì: Định nghĩa route cho trang quản lý cổng ra vào và điểm danh quầy lễ tân (/desk/gate).
 * Được gọi ở: URL /desk/gate (TanStack Router tự động tải và hiển thị component Page).
 */
export const Route = createFileRoute("/desk/gate")({ component: Page });

// Kết quả xác thực check-in từ server: thông tin hội viên, quyền vào cổng (allowed), cờ yêu cầu ghi đè (needs_override), gói tập hiện có và lịch đặt sân hôm nay.
type Result = {
  member: { id: string; full_name: string; member_code: string | null; avatar_url?: string | null };
  allowed: boolean;
  needs_override: boolean;
  flagged?: boolean;
  checked_in_at: string | null;
  duplicate: boolean;
  plans: Array<{ id: string; name: string; end_on: string; status: string }>;
  warnings: Array<{ kind: string; message: string }>;
  today: {
    bookings: Array<{ id: string; code: string; start_at: string; court_code: string }>;
    sessions: Array<{ id: string; start_at: string; sport: string; court_code: string }>;
  };
};

// Thông tin một lượt check-in qua cổng trong ngày: thời gian, mã hội viên, phương thức quét (method), lý do (nếu nhập tay) và cờ theo dõi của quản lý.
type Entry = {
  id: string;
  at: string;
  user_id: string;
  full_name: string;
  member_code: string | null;
  method: string | null;
  flagged: boolean;
  reason: string | null;
  avatar_url?: string | null;
};

/** What reception picks from when the code could not be used (BR-31). */
const MANUAL_REASONS = [
  { value: "no_phone", label: tk("Member has no phone with them") },
  { value: "dead_battery", label: tk("Phone battery is dead") },
  { value: "qr_failed", label: tk("Code would not scan") },
  { value: "forgot", label: tk("Forgot to open the app") },
  { value: "other", label: tk("Other") },
];

/** Why someone with no plan or booking may still come in. */
const OVERRIDE_REASONS = [
  { value: "renewing", label: tk("Paying at the desk right now") },
  { value: "guest_pass", label: tk("Guest pass") },
  { value: "manager_ok", label: tk("Manager approved") },
  { value: "expired_ok", label: tk("Just expired (grace)") },
  { value: "other", label: tk("Other") },
];

/**
 * Làm gì: Ánh xạ mã phương thức check-in (qr, manual, self) sang nhãn văn bản đã được bản địa hóa.
 * Được gọi ở: Nội bộ file src/routes/desk.gate.tsx (danh sách lịch sử lượt check-in qua cổng hôm nay).
 */
const METHOD_LABEL: Record<string, string> = { qr: tk("QR"), manual: tk("Manual"), self: tk("Self") };

/** The wording for a stored reason code, in the current language. */
/**
 * Làm gì: Chuyển đổi mã lý do check-in (lý do nhập tay hoặc lý do ghi đè) sang chuỗi văn bản theo ngôn ngữ hiện tại.
 * Được gọi ở: src/routes/desk.gate.tsx (hiển thị lý do trong danh sách lượt qua cổng hôm nay).
 * @param code Mã lý do lưu trong database (ví dụ: "no_phone", "renewing").
 * @returns Chuỗi văn bản lý do hiển thị cho người dùng, hoặc mã gốc đã bỏ dấu gạch dưới nếu không có trong danh mục.
 */
function reasonLabel(code: string) {
  const hit = [...MANUAL_REASONS, ...OVERRIDE_REASONS].find((r) => r.value === code);
  return hit ? t(hit.label) : code.replace(/_/g, " ");
}

// Trạng thái yêu cầu check-in đang chờ xử lý hoặc chờ duyệt ghi đè (quét mã QR hoặc nhập thông tin thủ công).
type Pending = { kind: "qr"; token: string } | { kind: "manual"; body: Record<string, unknown> };

/**
 * Làm gì: Hiển thị giao diện quản lý cổng ra vào và điểm danh tại quầy lễ tân; hỗ trợ quét mã QR bằng máy quét/camera, nhập tay khi không có mã, phê duyệt ghi đè (override) và theo dõi danh sách lượt vào cổng theo thời gian thực.
 * Được gọi ở: URL /desk/gate (thông qua Route định nghĩa ở đầu file).
 * @returns Khối JSX toàn bộ giao diện trang quản lý cổng ra vào tại quầy lễ tân.
 */
function Page() {
  // Bước 1: Khởi tạo thông tin người dùng hiện tại và các state quản lý giao diện (chế độ quét QR/nhập tay, nội dung scan/q, cờ bận busy, kết quả result, lỗi error).
  const user = useSessionUser();
  const [mode, setMode] = useState("qr");
  const [scan, setScan] = useState("");
  const [q, setQ] = useState("");
  const [reason, setReason] = useState("no_phone");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [overrideReason, setOverrideReason] = useState("renewing");
  const [error, setError] = useState<string | null>(null);
  // Bước 2: Quản lý phân trang (mặc định 25 dòng/trang) và tải danh sách các lượt qua cổng hôm nay từ API /desk/gate-checkins (giữ dữ liệu cũ khi đổi trang).
  const gatePage = usePageState("desk.gate", 25);
  const todayRead = useRead<{ items: Entry[]; total: number }>(
    `/desk/gate-checkins?limit=${gatePage.pageSize}&offset=${gatePage.offset}`,
    { keepPrevious: true },
  );
  // Bước 3: Lắng nghe sự kiện SSE kênh "attendance" để tự động tải lại danh sách ngay khi có lượt check-in mới từ bất kỳ nguồn nào.
  useLive("attendance", () => {
    todayRead.reload();
  });
  const today = todayRead.data?.items ?? null;

  /**
   * Làm gì: Tự động đưa con trỏ focus trở lại ô nhập liệu chỉ định sau khi thao tác check-in hoàn tất.
   * Được gọi ở: Nội bộ hàm send (khối finally) và sự kiện click nút chuyển chế độ nhập không mã.
   * @param id ID của phần tử input trong DOM cần focus ("gate-scan" hoặc "gate-q").
   */
  const refocus = (id: string) => setTimeout(() => document.getElementById(id)?.focus(), 0);

  /**
   * Làm gì: Gửi yêu cầu check-in (quét mã QR hoặc nhập tay) lên server, xử lý các trường hợp thành công, trùng lặp hoặc cần duyệt ghi đè khi hội viên không có gói tập.
   * Được gọi ở: Nội bộ component Page (hàm submitScan, submitManual, sự kiện quét mã của QrScanner và nút "Let them in").
   * @param p Dữ liệu lượt check-in cần gửi dạng mã QR ({ kind: "qr", token }) hoặc nhập tay ({ kind: "manual", body }).
   * @param override Mã lý do cho phép vào cổng ghi đè (nếu có, ví dụ: đóng tiền tại quầy, vé khách).
   * @returns Không trả về giá trị (Promise<void>).
   */
  async function send(p: Pending, override?: string) {
    // Bước 1: Bật cờ bận (busy) để khóa giao diện tạm thời và xóa thông báo lỗi trước đó.
    setBusy(true);
    setError(null);
    try {
      // Bước 2: Chuẩn bị tham số ghi đè (override) nếu có và gọi API tương ứng: POST /desk/scan cho mã QR hoặc POST /desk/gate-checkin cho nhập tay.
      const extra = override ? { override: true, override_reason: override } : {};
      const res =
        p.kind === "qr"
          ? await apiPost<Result>("/desk/scan", { token: p.token, ...extra })
          : await apiPost<Result>("/desk/gate-checkin", { ...p.body, ...extra });
      // Bước 3: Lưu kết quả phản hồi từ server vào state result để hiển thị thông tin thẻ hội viên lên màn hình.
      setResult(res);
      // Bước 4: Kiểm tra điều kiện vào cổng: nếu không có gói/lịch hợp lệ (needs_override = true), lưu lại pending và cảnh báo lễ tân chọn lý do ghi đè.
      if (res.needs_override) {
        setPending(p);
        toast.warning(t("Needs override approval"));
      } else {
        // Trường hợp hợp lệ: xóa trạng thái chờ, làm sạch ô nhập, báo toast thành công (hoặc báo đã vào trước đó nếu duplicate) và tải lại danh sách hôm nay.
        setPending(null);
        setScan("");
        setQ("");
        toast.success(
          res.duplicate
            ? t("Already checked in: {name}", { name: res.member.full_name })
            : t("Checked in: {name}", { name: res.member.full_name }),
        );
        todayRead.reload();
      }
    // Bước 5: Bắt lỗi khi gọi API: nếu server yêu cầu lý do (field === "reason"), tự động chuyển sang tab manual để lễ tân chọn lý do.
    } catch (err) {
      setResult(null);
      setPending(null);
      setError(err instanceof Error ? tServer(err.message) : t("Check-in failed"));
      toast.error(t("That check-in didn't go through"));
      if (err instanceof ApiClientError && err.body.field === "reason") setMode("manual");
    // Bước 6: Tắt cờ bận và tự động focus lại ô nhập liệu tương ứng để sẵn sàng quét lượt tiếp theo mà không cần dùng chuột.
    } finally {
      setBusy(false);
      refocus(p.kind === "qr" ? "gate-scan" : "gate-q");
    }
  }

  /**
   * Làm gì: Xử lý sự kiện submit biểu mẫu khi lễ tân quét mã QR hoặc nhập chuỗi token từ máy quét mã vạch.
   * Được gọi ở: src/routes/desk.gate.tsx (sự kiện onSubmit của form quét mã QR).
   * @param e Đối tượng sự kiện FormEvent từ biểu mẫu.
   */
  function submitScan(e: React.FormEvent) {
    // Bước 1: Ngăn trình duyệt reload trang mặc định khi nhấn Enter trên form quét mã.
    e.preventDefault();
    // Bước 2: Kiểm tra chuỗi mã quét hợp lệ, trích xuất token sạch qua tokenFromScan rồi gửi yêu cầu check-in.
    const v = scan.trim();
    if (v) void send({ kind: "qr", token: tokenFromScan(v) });
  }

  /**
   * Làm gì: Xử lý sự kiện submit biểu mẫu check-in thủ công khi hội viên không mang điện thoại hoặc mã QR bị lỗi.
   * Được gọi ở: src/routes/desk.gate.tsx (sự kiện onSubmit của form check-in thủ công).
   * @param e Đối tượng sự kiện FormEvent từ biểu mẫu.
   */
  function submitManual(e: React.FormEvent) {
    // Bước 1: Ngăn hành vi reload trang mặc định của biểu mẫu HTML.
    e.preventDefault();
    // Bước 2: Kiểm tra chuỗi tìm kiếm đã nhập; nếu rỗng thì dừng xử lý.
    const v = q.trim();
    if (!v) return;
    // A phone number starts with a digit or +; a member code is letters first.
    const who = /^[+0-9][0-9 .-]{7,}$/.test(v) ? { phone: v.replace(/[ .-]/g, "") } : { code: v };
    // Bước 3: Gửi yêu cầu check-in thủ công kèm thông tin định danh (số điện thoại đã chuẩn hóa hoặc mã hội viên) và mã lý do không dùng mã QR.
    void send({ kind: "manual", body: { ...who, reason } });
  }

  // Bước 4: Render giao diện màn hình: gồm Shell theo vai trò người dùng, banner tiêu đề, cột trái chứa form quét QR/nhập tay và mã tự phục vụ, cột phải hiển thị thẻ kết quả check-in và bảng lịch sử qua cổng hôm nay.
  return (
    <Shell role={user?.role === "manager" ? "manager" : "receptionist"}>
      <PageHero
        slot="banner.gate"
        title={t("Gate & check-in")}
        subtitle={t("Scan a member's code to let them in. Type a phone number only when the code can't be used.")}
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,34rem)_minmax(0,1fr)]">
        <div className="grid content-start gap-4">
          <Card className="grid gap-3">
            <Seg
              value={mode}
              onChange={setMode}
              options={[
                { value: "qr", label: t("Scan code") },
                { value: "manual", label: t("Without a code") },
              ]}
            />
            {mode === "qr" ? (
              <form onSubmit={submitScan} className="grid gap-3">
                <QrScanner onCode={(c) => void send({ kind: "qr", token: tokenFromScan(c) })} hint={t("Hold the member's phone up to the camera.")} />
                <Field tone="muted" label={t("Scanner input")} hint={t("A handheld scanner types here. Focus stays on this box.")}>
                  <Input
                    id="gate-scan"
                    autoFocus
                    value={scan}
                    onChange={(e) => setScan(e.target.value)}
                    placeholder={t("Point the scanner at the member's phone")}
                    autoComplete="off"
                  />
                </Field>
                <div>
                  <Button type="submit" disabled={busy || !scan.trim()}>
                    {busy ? t("Checking…") : t("Check in")}
                  </Button>
                </div>
              </form>
            ) : (
              <form onSubmit={submitManual} className="grid gap-3">
                <Field label={t("Member code or phone")}>
                  <Input
                    id="gate-q"
                    autoFocus
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={t("A3-000123 or 0900 000 000")}
                  />
                </Field>
                <Field tone="muted" label={t("Why not the code?")} hint={t("Recorded with the visit so a manager can review it.")}>
                  <Select value={reason} onChange={(e) => setReason(e.target.value)}>
                    {MANUAL_REASONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {t(r.label)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div>
                  <Button type="submit" disabled={busy || !q.trim()}>
                    {busy ? t("Checking…") : t("Check in")}
                  </Button>
                </div>
              </form>
            )}
            <p className="text-xs text-muted">
              {t("This only records that they walked in. It never uses up a session or changes a plan.")}
            </p>
          </Card>

          <SelfCheckinCode />
        </div>

        <div aria-live="polite" className="grid content-start gap-4">
          {error ? (
            <Card className="border border-danger/30">
              <p className="text-sm text-danger">{error}</p>
            </Card>
          ) : null}
          {result ? (
            // Read from two metres away: lime means in, amber means already in, red means a reason is needed.
            <Card
              className={
                result.needs_override
                  ? "grid gap-3 border-2 border-danger/60"
                  : result.duplicate
                    ? "grid gap-3 border-2 border-hold/60"
                    : "next-free grid gap-3 border-2 border-accent bg-accent text-accent-fg"
              }
            >
              <p
                className={`font-mono text-xs font-semibold uppercase tracking-[0.18em] ${
                  result.needs_override ? "text-danger" : result.duplicate ? "text-hold" : "text-accent-fg/80"
                }`}
              >
                {result.needs_override
                  ? t("Nothing to enter on")
                  : result.duplicate
                    ? t("Already in at {time}", { time: hhmm(result.checked_in_at!) })
                    : t("In at {time}", { time: hhmm(result.checked_in_at!) })}
              </p>
              <div className="flex items-center gap-4">
                <div className="size-14 shrink-0">
                  <UserAvatar name={result.member.full_name} url={result.member.avatar_url} />
                </div>
                <div className="min-w-0">
                  <p className="font-athletic text-3xl leading-none sm:text-4xl">{result.member.full_name}</p>
                  <p
                    className={`mt-1 font-mono text-sm ${
                      result.needs_override || result.duplicate ? "text-muted" : "text-accent-fg/70"
                    }`}
                  >
                    {result.member.member_code}
                  </p>
                </div>
              </div>
              {result.flagged ? <Badge tone="hold">{t("Flagged for the manager")}</Badge> : null}
              {(result.warnings ?? []).map((w) => (
                <p
                  key={w.kind + w.message}
                  className={`rounded-[var(--radius-sm)] px-3 py-2 text-sm font-medium ${
                    result.needs_override || result.duplicate
                      ? "bg-hold/12 text-hold"
                      : "bg-accent-fg/10 text-accent-fg"
                  }`}
                >
                  {tServer(w.message)}
                </p>
              ))}
              {(result.plans ?? []).map((p) => (
                <p key={p.id} className="text-sm">
                  {tData(p.name)}
                  <span className="text-muted">
                    {" "}
                    · {t("until {date}", { date: p.end_on })}
                  </span>
                </p>
              ))}
              {result.today?.sessions?.length || result.today?.bookings?.length ? (
                <div className="text-base font-semibold">
                  <p
                    className={`kicker text-2xs ${
                      result.needs_override || result.duplicate ? "text-muted" : "text-accent-fg/70"
                    }`}
                  >
                    {t("Today")}
                  </p>
                  <ul className="mt-1 grid gap-1">
                    {(result.today?.sessions ?? []).map((s) => (
                      <li key={s.id}>
                        {hhmm(s.start_at)} · {t("{sport} class", { sport: sportLabel(s.sport) })} · {s.court_code}
                      </li>
                    ))}
                    {(result.today?.bookings ?? []).map((b) => (
                      <li key={b.id}>
                        {hhmm(b.start_at)} · {t("court {code}", { code: b.court_code })} <span className="opacity-70">({b.code})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm opacity-70">{t("Nothing booked for today.")}</p>
              )}
              {result.needs_override && pending ? (
                <div className="grid gap-3 rounded-[var(--radius-md)] border border-line p-3">
                  <p className="text-sm">
                    {t("There is no live plan, booking or class for them today. Let them in anyway only with a reason: it is recorded and the manager sees it.")}
                  </p>
                  <Field label={t("Reason")}>
                    <Select value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)}>
                      {OVERRIDE_REASONS.map((r) => (
                        <option key={r.value} value={r.value}>
                          {t(r.label)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className="flex gap-2">
                    <Button disabled={busy} onClick={() => void send(pending, overrideReason)}>
                      {t("Let them in")}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setPending(null);
                        setResult(null);
                      }}
                    >
                      {t("Send to the desk")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </Card>
          ) : !error ? (
            <div className="grid min-h-56 place-content-center gap-2 rounded-[var(--radius-xl)] border-2 border-dashed border-line p-8 text-center">
              <p className="font-athletic text-3xl text-muted">{t("Ready to scan")}</p>
              <p className="text-sm text-muted">{t("The member's name and today's plan show here, large enough to read from the desk.")}</p>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-10">
        <div className="flex items-baseline justify-between gap-2">
          <SectionTitle text={t("Through the gate today")} className="font-display text-2xl" />
          {todayRead.data ? (
            <span className="text-sm tabular-nums text-muted">
              {t("Today's check-ins")}: <span className="font-semibold text-fg">{todayRead.data.total}</span>
            </span>
          ) : null}
        </div>
        <div className="mt-3 grid gap-2">
          {todayRead.error ? (
            <LoadError
              message={todayRead.error.message}
              onRetry={todayRead.error.refused ? undefined : todayRead.reload}
            />
          ) : !today ? (
            <Skeleton className="h-16" />
          ) : !today.length ? (
            <EmptyState
              title={t("Nobody yet today")}
              hint={t("Check-ins appear here as they happen.")}
              action={
                <Button variant="outline" onClick={() => { setMode("manual"); refocus("gate-q"); }}>
                  {t("Check in without code")}
                </Button>
              }
            />
          ) : (
            today.map((row) => (
              <Card key={row.id} className="flex flex-wrap items-center justify-between gap-2 p-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="size-8 shrink-0">
                    <UserAvatar name={row.full_name} url={row.avatar_url} />
                  </div>
                  <p className="font-medium">
                    {row.full_name} <span className="text-xs text-muted">{row.member_code}</span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {row.flagged ? <Badge tone="hold">{t("Flagged")}</Badge> : null}
                  {row.method ? <Badge tone="muted">{METHOD_LABEL[row.method] ? t(METHOD_LABEL[row.method]) : row.method}</Badge> : null}
                  <span className="text-sm tabular-nums text-muted">{hhmm(row.at)}</span>
                </div>
                {row.reason ? (
                  <p className="w-full text-xs text-muted">
                    {t("Reason: {reason}", { reason: reasonLabel(row.reason) })}
                  </p>
                ) : null}
              </Card>
            ))
          )}
        </div>
        <Pagination
          offset={gatePage.offset}
          total={todayRead.data?.total ?? 0}
          pageSize={gatePage.pageSize}
          onChange={gatePage.setOffset}
          onPageSizeChange={gatePage.setPageSize}
          label={t("Check-in pages")}
        />
      </div>
    </Shell>
  );
}

/** The address a member's phone can open: VITE_PUBLIC_URL when set, else this page's own origin. */
/**
 * Làm gì: Xác định địa chỉ URL gốc công khai mà điện thoại hội viên có thể truy cập; ưu tiên biến môi trường VITE_PUBLIC_URL nếu được cấu hình, ngược lại dùng origin hiện tại của trình duyệt.
 * Được gọi ở: src/routes/desk.gate.tsx (hàm phoneCannotReach và hàm draw trong SelfCheckinCode).
 * @returns Chuỗi URL gốc công khai không có dấu gạch chéo ở cuối (ví dụ: "http://192.168.1.10:8080").
 */
function publicOrigin() {
  // Cắt bỏ dấu gạch chéo ở cuối VITE_PUBLIC_URL nếu có; fallback về window.location.origin nếu chưa cấu hình biến môi trường.
  const env = (import.meta.env.VITE_PUBLIC_URL as string | undefined)?.replace(/\/+$/, "");
  return env || window.location.origin;
}

/** A phone cannot open "localhost": that address points at the phone itself. */
/**
 * Làm gì: Kiểm tra xem địa chỉ publicOrigin có trỏ về localhost hoặc loopback IP không; điện thoại của hội viên không thể quét mã nếu quầy đang mở trên localhost.
 * Được gọi ở: src/routes/desk.gate.tsx (điều kiện hiển thị cảnh báo mạng trong JSX của SelfCheckinCode).
 * @returns true nếu URL trỏ về localhost, 127.0.0.1 hoặc IPv6 [::1]; ngược lại false.
 */
function phoneCannotReach() {
  // Kiểm tra chuỗi URL bằng regex: nếu là localhost, 127.0.0.1 hoặc IPv6 [::1] thì điện thoại quét mã sẽ không thể kết nối tới.
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(publicOrigin());
}

/** The 30-second code members scan to check themselves in, when the centre allows it. */
/**
 * Làm gì: Component hiển thị mã QR tự điểm danh tại quầy lễ tân; tự động gọi API lấy token và tạo ảnh mã QR tự làm mới mỗi 30 giây để hội viên tự quét bằng điện thoại cá nhân.
 * Được gọi ở: src/routes/desk.gate.tsx (bên trong component Page tại dòng 218).
 * @returns Phần tử JSX hiển thị thẻ Card mã QR tự điểm danh hoặc thông báo hướng dẫn.
 */
function SelfCheckinCode() {
  // Quản lý state: cờ mở/đóng thẻ QR (open), trạng thái bật/tắt từ cài đặt (enabled), ảnh QR dạng data URL (img), thông báo lỗi (problem) và bộ đếm làm mới (round).
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [img, setImg] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  // Bước 1: Quản lý vòng đời tải và tự động làm mới mã QR định kỳ khi mở thẻ hoặc khi người dùng bấm thử lại.
  useEffect(() => {
    // Closed: forget the old code, so opening it again never flashes one that has since run out.
    if (!open) {
      setEnabled(null);
      setImg(null);
      setProblem(null);
      return;
    }
    // Cờ stop hủy cập nhật state nếu unmount; biến timer lưu timeout làm mới mã.
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    /**
     * Làm gì: Gọi API lấy token điểm danh của quầy, tạo ảnh QR base64 và lập lịch tự động tải mã mới trước khi token hết hạn.
     * Được gọi ở: Nội bộ hook useEffect của component SelfCheckinCode (dòng 465).
     * @returns Không trả về giá trị (Promise<void>).
     */
    const draw = async () => {
      try {
        // Bước 1: Gọi API GET /desk/checkin-qr lấy token điểm danh mới nhất và thời gian hết hạn (expires_at).
        const res = await apiGet<{ enabled: boolean; token: string; expires_at: string }>("/desk/checkin-qr");
        if (stop) return;
        // Bước 2: Khi tính năng bật, tạo URL dẫn tới trang /app/pass?d={token} và chuyển thành ảnh QR code (mức sửa lỗi M để máy ảnh điện thoại dễ quét).
        if (res.enabled) {
          const url = `${publicOrigin()}/app/pass?d=${encodeURIComponent(res.token)}`;
          const drawn = await QRCode.toDataURL(url, { margin: 1, width: 280, errorCorrectionLevel: "M" });
          if (stop) return;
          setImg(drawn);
        }
        // Bước 3: Cập nhật state enabled, xóa lỗi cũ và lập lịch tải mã tiếp theo: trước khi token hết hạn 4 giây, tối thiểu chờ 5 giây để tránh gửi dồn request.
        setEnabled(res.enabled);
        setProblem(null);
        const wait = Math.max(5000, new Date(res.expires_at).getTime() - Date.now() - 4000);
        timer = setTimeout(() => void draw(), wait);
      } catch (e) {
        // Bước 4: Xử lý lỗi khi gọi API: lưu thông báo lỗi để hiển thị và hẹn giờ thử lại sau 10 giây.
        if (stop) return;
        setProblem(readError(e).message);
        timer = setTimeout(() => void draw(), 10000);
      }
    };
    // Kích hoạt vẽ mã QR lần đầu tiên khi thẻ được mở.
    void draw();
    // Dọn dẹp effect: đánh dấu stop = true và hủy timer định thời khi đóng thẻ hoặc unmount để tránh rò rỉ bộ nhớ.
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [open, round]);

  // Bước 2: Render giao diện thẻ Card gồm thanh tiêu đề, nút Ẩn/Hiện, thông báo lỗi/tắt tính năng, cảnh báo truy cập localhost và ảnh mã QR.
  return (
    <Card className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="font-medium">{t("Self check-in code")}</p>
          <p className="text-xs text-muted">{t("Members scan this screen with their own phone. Changes every 30 seconds.")}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
          {open ? t("Hide") : t("Show")}
        </Button>
      </div>
      {open && problem ? (
        <LoadError
          message={problem}
          onRetry={() => {
            setProblem(null);
            setRound((n) => n + 1);
          }}
        />
      ) : null}
      {open && !problem && enabled === false ? (
        <p className="text-sm text-muted">{t("Self check-in is switched off. A manager can turn it on in Settings.")}</p>
      ) : null}
      {open && !problem && enabled !== false && !img ? <Skeleton className="mx-auto size-56" /> : null}
      {open && !problem && enabled && img && phoneCannotReach() ? (
        <p className="text-xs text-hold">
          {t("This screen is open on localhost, which a phone cannot reach. Open the desk at this computer's network address (for example http://192.168.1.10:8080), or set VITE_PUBLIC_URL.")}
        </p>
      ) : null}
      {open && !problem && enabled && img ? (
        <img src={img} alt={t("Self check-in code")} className="mx-auto size-56 rounded-[var(--radius-md)] bg-white p-2" />
      ) : null}
    </Card>
  );
}
