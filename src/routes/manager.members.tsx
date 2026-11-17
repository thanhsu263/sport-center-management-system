/**
 * File: src/routes/manager.members.tsx
 * Vai trò: Định nghĩa route và trang danh bạ hội viên (/manager/members) dành riêng cho vai trò quản lý (manager).
 * Vị trí trong app:
 * - Route "/manager/members" hiển thị danh bạ toàn bộ hội viên (members) có tài khoản trong hệ sinh thái thể thao Arena 3.
 * - Hỗ trợ lọc theo từ khóa tìm kiếm (tên, SĐT, mã hội viên), trạng thái tài khoản, môn thể thao tham gia và trạng thái gói tập (FR-MEM-04).
 * - Tích hợp thanh thống kê nhanh (StatStrip), phân trang dữ liệu (usePageState) và điều hướng đến chi tiết hồ sơ hội viên (/desk/member/$id).
 */
import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Shell } from "@/client/components/shell";
import { PageHero } from "@/client/components/page-hero";
import { StatStrip } from "@/client/components/stat-strip";
import { useSports } from "@/client/components/sports-ui";
import { Badge, Button, Card, EmptyState, FilterChip, Input, LoadError, Pagination, Select, Skeleton, StatusBadge } from "@/client/components/ui";
import { formatDate } from "@/shared/arena3/labels";
import { cn } from "@/client/lib/cn";
import { ageYears } from "@/shared/arena3/time";
import { locale, t, tk, tData } from "@/client/lib/i18n";
import { UserAvatar } from "@/client/components/user-avatar";
import { MessageButton } from "@/client/components/message-button";
import { useRead } from "@/client/lib/use-read";
import { usePageState } from "@/client/lib/use-page-state";

/**
 * Làm gì: Cấu hình định tuyến TanStack Router cho đường dẫn /manager/members, liên kết URL với component Page.
 * Được gọi ở: URL /manager/members (TanStack Router tự động đăng ký và nạp khi quản lý truy cập).
 * @returns Route object của TanStack Router cho trang /manager/members.
 */
export const Route = createFileRoute("/manager/members")({
  component: Page,
});

// Cấu trúc dữ liệu một dòng hội viên trả về từ API /directory/members, bao gồm thông tin cá nhân, gói tập và số lớp đã tham gia.
type Row = {
  id: string;
  member_code: string | null;
  full_name: string;
  phone: string;
  status: string;
  date_of_birth: string | null;
  avatar_url?: string | null;
  plan_name: string | null;
  end_on: string | null;
  plan_state: "active" | "expiring" | "expired" | "none";
  classes: number;
};

// Bảng ánh xạ trạng thái gói tập (active, expiring, expired, none) sang nhãn văn bản đa ngôn ngữ có hỗ trợ trích xuất bản dịch.
const PLAN_LABEL: Record<Row["plan_state"], string> = {
  active: tk("Plan active"),
  expiring: tk("Ends within a week"),
  expired: tk("Plan expired"),
  none: tk("No plan"),
};

/**
 * Làm gì: Component trang danh bạ hội viên của quản lý (FR-MEM-04); hỗ trợ tìm kiếm, lọc theo nhiều tiêu chí, xem thống kê gói tập, phân trang và truy cập hồ sơ chi tiết.
 * Được gọi ở: src/routes/manager.members.tsx (Route /manager/members, dòng 18).
 * @returns JSX hiển thị toàn bộ màn hình danh bạ hội viên bọc trong Shell vai trò manager.
 */
/** FR-MEM-04: every member, filtered by who they are and where their plan stands. */
function Page() {
  // Bước 1: Khởi tạo các state lọc (từ khóa q, trạng thái tài khoản status, môn thể thao sport, gói tập plan) và phân trang (offset, pageSize mặc định 25).
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [sport, setSport] = useState("");
  const [plan, setPlan] = useState("");
  const { offset, setOffset, pageSize, setPageSize, reset } = usePageState("manager.members", 25);

  // Bước 2: Quản lý độ trễ debounce (250ms) cho ô tìm kiếm và tự động đặt lại trang về đầu khi bộ lọc thay đổi.
  // Typing waits a beat so one search is one request, and any filter change goes back to page one.
  const [term, setTerm] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  useEffect(reset, [term, status, sport, plan, reset]);

  // Bước 3: Tạo query params và gọi API GET /directory/members để tải danh sách hội viên.
  const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
  if (term) params.set("q", term);
  if (status) params.set("status", status);
  if (sport) params.set("sport", sport);
  if (plan) params.set("plan", plan);
  // The rows already on screen stay (dimmed) while the next page or filter loads, so paging does not
  // collapse the list; a failure replaces them with the reason rather than rows that do not match.
  const read = useRead<{ items: Row[]; total: number }>(`/directory/members?${params}`, { keepPrevious: true });
  const data = read.data;
  const total = data?.total ?? 0;

  // Danh sách các tùy chọn chip lọc trạng thái gói tập hiển thị phía trên bảng danh sách.
  const PLAN_CHIPS: Array<{ value: string; label: string }> = [
    { value: "", label: t("Everyone") },
    { value: "active", label: t("Plan active") },
    { value: "expiring", label: t("Ends this week") },
    { value: "expired", label: t("Expired") },
    { value: "none", label: t("No plan") },
  ];

  // Bước 4: Lấy danh mục môn thể thao và tính toán số lượng hội viên theo từng trạng thái gói tập trên trang hiện tại để hiển thị StatStrip.
  const sports = useSports();
  // Đếm trực tiếp trên trang dữ liệu hiện tại (data.items) phục vụ thống kê nhanh mà không cần thêm truy vấn phụ từ server.
  const activeCount = data?.items.filter((m) => m.plan_state === "active").length ?? 0;
  const expiringCount = data?.items.filter((m) => m.plan_state === "expiring").length ?? 0;
  const noPlanCount = data?.items.filter((m) => m.plan_state === "none").length ?? 0;

  // Bước 5: Render giao diện người dùng với Shell của manager, thanh tiêu đề PageHero, thống kê StatStrip, bộ lọc và danh sách hội viên kèm phân trang.
  return (
    <Shell role="manager">
      <PageHero
        slot="banner.manager"
        title={t("Members")}
        subtitle={t("Everyone with an account. Open a member for their plan, classes, balance and attendance.")}
        className="mb-6"
      />

      <StatStrip
        stats={[
          { label: term || status || sport || plan ? t("Matching members") : t("Total members"), value: data ? total : "…" },
          { label: t("Plan active"), value: data ? activeCount : "…", detail: t("On this page") },
          { label: t("Ends within a week"), value: data ? expiringCount : "…", detail: t("On this page") },
          { label: t("No plan"), value: data ? noPlanCount : "…", detail: t("On this page") },
        ]}
        className="mb-6"
      />

      <div className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0" role="group" aria-label={t("Plan state")}>
        {PLAN_CHIPS.map((c) => (
          <FilterChip key={c.value || "all"} active={plan === c.value} onClick={() => setPlan(c.value)} label={c.label} />
        ))}
      </div>
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_10rem_10rem]">
        <Input
          placeholder={t("Name, phone or member code")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={t("Search members")}
        />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t("Account status")}>
          <option value="">{t("Any status")}</option>
          <option value="active">{t("Active")}</option>
          <option value="locked">{t("Locked")}</option>
          <option value="disabled">{t("Disabled")}</option>
        </Select>
        <Select value={sport} onChange={(e) => setSport(e.target.value)} aria-label={t("Sport")}>
          <option value="">{t("Any sport")}</option>
          {sports.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>

      <div aria-busy={read.stale} className={cn("transition-opacity", read.stale && "opacity-60")}>
      {read.error ? (
        <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />
      ) : !data ? (
        <Skeleton className="h-48" />
      ) : !data.items.length ? (
        <EmptyState
          title={t("No members match")}
          hint={t("Loosen a filter or check the spelling.")}
          action={
            term || status || sport || plan ? (
              <Button
                variant="outline"
                onClick={() => {
                  setQ("");
                  setStatus("");
                  setSport("");
                  setPlan("");
                }}
              >
                {t("Clear filters")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <p className="mb-2 text-sm text-muted tabular-nums">
            {total === 1 ? t("1 member") : t("{n} members", { n: total.toLocaleString(locale()) })}
          </p>
          <Card className="overflow-hidden p-0">
            <div className="hidden grid-cols-[minmax(0,1.6fr)_4rem_minmax(0,1.3fr)_minmax(0,1.4fr)_7.5rem] gap-4 border-b border-line bg-wood/50 px-4 py-2 text-xs font-medium text-muted md:grid">
              <span>{t("Member")}</span>
              <span>{t("Age")}</span>
              <span>{t("Phone")}</span>
              <span>{t("Plan")}</span>
              <span className="text-right">{t("Classes")}</span>
            </div>
            <ul className="divide-y divide-line/70">
              {data.items.map((m) => (
                <li key={m.id}>
                  <Link
                    to="/desk/member/$id"
                    params={{ id: m.id }}
                    className="grid gap-x-4 gap-y-0.5 px-4 py-2.5 transition-colors duration-150 hover:bg-wood/60 md:grid-cols-[minmax(0,1.6fr)_4rem_minmax(0,1.3fr)_minmax(0,1.4fr)_7.5rem] md:items-center"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="size-8 shrink-0">
                        <UserAvatar name={m.full_name} url={m.avatar_url} />
                      </div>
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 font-medium">
                          <span className="break-words">{m.full_name}</span>
                          {m.status !== "active" ? <StatusBadge status={m.status} /> : null}
                        </p>
                        <p className="text-xs tabular-nums text-muted">
                          {m.member_code ?? "-"}
                          {m.date_of_birth ? ` · ${t("{age} yrs", { age: ageYears(m.date_of_birth) })}` : ""}
                        </p>
                      </div>
                    </div>
                    <p className="hidden text-sm tabular-nums text-muted md:block">
                      {m.date_of_birth ? ageYears(m.date_of_birth) : "-"}
                    </p>
                    <p className="text-sm tabular-nums text-muted">{m.phone}</p>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge tone={m.plan_state === "active" ? "accent" : m.plan_state === "expiring" ? "hold" : "muted"}>
                        {t(PLAN_LABEL[m.plan_state])}
                      </Badge>
                      {m.plan_name ? (
                        <span className="break-words text-xs text-muted">
                          {tData(m.plan_name)}
                          {m.end_on ? ` · ${t("until {date}", { date: formatDate(m.end_on) })}` : ""}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2 md:justify-end">
                      <p className="text-sm tabular-nums text-muted">
                        {m.classes === 1 ? t("1 class") : t("{n} classes", { n: m.classes })}
                      </p>
                      {m.status === "active" ? <MessageButton userId={m.id} compact /> : null}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
          <Pagination offset={offset} total={total} pageSize={pageSize} onChange={setOffset} onPageSizeChange={setPageSize} label={t("Member pages")} />
        </>
      )}
      </div>
    </Shell>
  );
}
