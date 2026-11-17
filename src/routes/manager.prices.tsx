/**
 * Tuyến đường (route) giao diện quản lý bảng giá (/manager/prices) trong hệ thống Arena 3 dành cho vai trò quản lý (manager).
 * Vai trò trong ứng dụng: Cho phép xem và điều chỉnh biểu giá thuê sân theo từng môn thể thao, loại ngày và khung giờ (bao gồm giờ cao điểm);
 * đồng thời hiển thị danh sách gói hội viên đang mở bán và tỷ lệ thuế VAT áp dụng trên hóa đơn để quản lý nắm bắt toàn diện chính sách giá.
 */
import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Shell, money } from "@/client/components/shell";
import { PageHero } from "@/client/components/page-hero";
import { StatStrip } from "@/client/components/stat-strip";
import { SportBadge, useSports } from "@/client/components/sports-ui";
import { Badge, Button, Card, EmptyState, LoadError, MoneyInput, Skeleton } from "@/client/components/ui";
import { Stagger, StaggerItem } from "@/client/components/motion";
import { StarBorder } from "@/client/components/fx";
import { ApiClientError, apiPut } from "@/client/arena3/client";
import { DAY_KIND_LABEL, sportLabel, monthsLabel } from "@/shared/arena3/labels";
import { t, tk, tServer, tData } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";
import { SectionTitle } from "@/client/components/section";
import { Banknote, ChevronDown, Percent, Ticket } from "lucide-react";

/**
 * Làm gì: Định nghĩa route cho trang quản lý bảng giá (/manager/prices) bằng TanStack Router, liên kết URL với component Page.
 * Được gọi ở: URL `/manager/prices` (TanStack Router tự động đăng ký và nạp route theo file-based routing).
 * @returns Đối tượng cấu hình route quản lý URL `/manager/prices`.
 */
export const Route = createFileRoute("/manager/prices")({
  component: Page,
});

// Cấu trúc quy tắc giá thuê sân (price_rules): môn thể thao, loại ngày, khung giờ bắt đầu/kết thúc, giá theo giờ (VND), cờ giờ cao điểm và sân áp dụng cụ thể (nếu có).
type Rule = {
  id: string;
  sport: string;
  day_kind: string;
  start_local: string;
  end_local: string;
  price_vnd: number;
  is_peak: boolean;
  court_id: string | null;
};

// Cấu trúc gói hội viên (plans): tên gói, giá niêm yết (VND), trạng thái mở bán, thời hạn hiệu lực (ngày/tháng) và số giờ thuê sân đi kèm.
type Plan = {
  id: string;
  name: string;
  price_vnd: number;
  is_on_sale: boolean;
  duration_days: number | null;
  duration_months: number | null;
  court_hours: number;
};

/**
 * Pricing, in the blocks a manager thinks in: what a court costs by sport and
 * hour, what a membership costs, and the VAT that sits on top. Plans and VAT
 * are read-only here — they have their own screens — so a price can only be
 * changed in one place.
 */
/**
 * Làm gì: Component chính của trang /manager/prices — hiển thị và quản lý bảng giá thuê sân theo môn, loại ngày và khung giờ; theo dõi gói tập đang bán và thuế VAT.
 * Được gọi ở: Route /manager/prices (khai báo tại Route export ở dòng 18 của file này).
 * @returns JSX Element giao diện trang quản lý giá cho vai trò manager được bọc trong Shell.
 */
function Page() {
  // Bước 1: Khởi tạo dữ liệu từ server gồm danh mục môn thể thao, quy tắc giá sân (/price-rules), gói tập (/plans), thuế VAT (/settings) và danh sách sân (/courts).
  const { sports } = useSports();
  const rulesRead = useRead<{ items: Rule[] }>("/price-rules");
  const plansRead = useRead<{ items: Plan[] }>("/plans");
  const vatRead = useRead<{ vat_rate?: string | number }>("/settings");
  // Court codes only name the rows that apply to one court; without them such a row still reads "One court only".
  const courtsRead = useRead<{ items: { id: string; court_code: string }[] }>("/courts");
  const courtCodes = useMemo(
    () => Object.fromEntries((courtsRead.data?.items ?? []).map((c) => [c.id, c.court_code])) as Record<string, string>,
    [courtsRead.data],
  );
  // Chuẩn hóa danh sách gói tập và chuyển đổi giá trị vat_rate sang kiểu số để hiển thị phần trăm trên giao diện.
  const plans = plansRead.data?.items ?? null;
  const vat = vatRead.data?.vat_rate == null ? null : Number(vatRead.data.vat_rate);

  // Bước 2: Khởi tạo state edited để lưu tạm thời các mức giá mà quản lý chỉnh sửa trên form; đồng bộ từ rulesRead khi tải xong.
  // The rates the manager edits start from what the server holds; a failed read leaves nothing to edit.
  const [edited, setEdited] = useState<Rule[] | null>(null);
  useEffect(() => {
    if (rulesRead.data) setEdited(rulesRead.data.items);
  }, [rulesRead.data]);
  const items = rulesRead.error ? null : edited;
  // Quản lý trạng thái lỗi xác thực theo chỉ số dòng (bad), nội dung thông báo lỗi (message) và cờ đang lưu (saving).
  const [bad, setBad] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  // Bước 3: Gom nhóm các quy tắc giá theo môn thể thao và sắp xếp theo thứ tự ưu tiên của danh mục sports.
  // Rows keep their index in the flat list: the save sends that list as-is.
  const groups = useMemo(() => {
    const out = new Map<string, { rule: Rule; index: number }[]>();
    (items ?? []).forEach((rule, index) => {
      const g = out.get(rule.sport) ?? [];
      g.push({ rule, index });
      out.set(rule.sport, g);
    });
    /**
     * Làm gì: Xác định thứ tự ưu tiên sắp xếp của môn thể thao theo vị trí trong danh sách sports đã cấu hình.
     * Được gọi ở: Hàm so sánh sort() khi tạo danh sách nhóm môn thể thao groups (dòng 85).
     * @param sport Mã môn thể thao cần xếp hạng (sport code).
     * @returns Chỉ số index của môn thể thao trong danh mục (nếu không có sẽ xếp ở cuối cùng).
     */
    const rank = (sport: string) => {
      const idx = sports.findIndex((s) => s.code === sport);
      return idx < 0 ? sports.length : idx;
    };
    return [...out.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
  }, [items, sports]);

  /**
   * Làm gì: Cập nhật giá tiền (price_vnd) cho quy tắc giá tại vị trí index trong state local, xóa trạng thái lỗi khi người dùng chỉnh sửa.
   * Được gọi ở: Sự kiện onChange của MoneyInput trong mỗi thẻ quy tắc giá (dòng 195).
   * @param index Chỉ số của quy tắc giá trong danh sách items mảng phẳng.
   * @param value Chuỗi giá trị tiền mới người dùng nhập vào ô input.
   * @returns Không có (void).
   */
  function edit(index: number, value: string) {
    // Bước 1: Kiểm tra danh sách items; nếu chưa tải xong thì không xử lý.
    if (!items) return;
    // Bước 2: Tạo bản sao mảng, cập nhật giá mới (chuỗi rỗng chuyển thành NaN để ngăn lưu dữ liệu không hợp lệ) và reset thông báo lỗi.
    const next = [...items];
    next[index] = { ...next[index], price_vnd: value === "" ? Number.NaN : Number(value) };
    setEdited(next);
    setBad(null);
    setMessage("");
  }

  /**
   * Làm gì: Gửi toàn bộ danh sách quy tắc giá đã chỉnh sửa lên server qua API PUT /price-rules, xử lý lỗi xác thực và làm mới dữ liệu sau khi lưu.
   * Được gọi ở: Sự kiện onClick của nút "Save new prices" (dòng 210).
   * @returns Promise<void> hoàn thành khi kết thúc quá trình gửi yêu cầu lên server.
   */
  async function save() {
    // Bước 1: Kiểm tra dữ liệu hợp lệ; bật trạng thái saving và xóa các cảnh báo lỗi trước đó.
    if (!items) return;
    setSaving(true);
    setBad(null);
    setMessage("");
    // Bước 2: Gửi danh sách quy tắc giá lên server qua API PUT /price-rules; thông báo thành công và reload lại danh sách giá.
    try {
      await apiPut("/price-rules", { items });
      toast.success(t("Pricing saved"));
      rulesRead.reload();
    // Bước 3: Xử lý lỗi từ API; nếu server trả về vị trí dòng bị lỗi (body.index), đánh dấu vào bad để viền đỏ ô input tương ứng.
    } catch (e) {
      if (e instanceof ApiClientError && typeof e.body.index === "number") setBad(e.body.index);
      setMessage(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    // Bước 4: Tắt trạng thái saving để mở lại nút lưu giá dù thành công hay thất bại.
    } finally {
      setSaving(false);
    }
  }

  // Bước 4: Lọc các gói tập đang mở bán và tính toán số liệu thống kê (tổng quy tắc, giờ cao điểm, giờ thấp điểm, số môn thể thao) cho StatStrip.
  const onSale = (plans ?? []).filter((p) => p.is_on_sale);

  const totalRules = items?.length ?? 0;
  const peakRules = items?.filter((r) => r.is_peak).length ?? 0;
  const offPeakRules = totalRules - peakRules;
  const sportsCount = groups.length;

  // Bước 5: Render toàn bộ giao diện quản lý giá gồm PageHero, dải thống kê StatStrip, danh sách biểu giá sân, gói hội viên và mức thuế VAT.
  return (
    <Shell role="manager">
      <PageHero
        slot="banner.manager"
        title={t("Pricing")}
        subtitle={t("A new price only applies to new transactions: bookings and plans already sold keep theirs.")}
        className="mb-6"
      />

      <StatStrip
        stats={[
          { label: tk("Total rates"), value: totalRules },
          { label: tk("Peak rules"), value: peakRules },
          { label: tk("Off-peak rules"), value: offPeakRules },
          { label: tk("Sports covered"), value: sportsCount },
        ]}
        className="mb-6"
      />

      <section aria-labelledby="court-rates">
        <SectionTitle
          id="court-rates"
          icon={Banknote}
          text={tk("Court rates")}
          hint={t("Price per hour, by sport, day and time of day. Peak hours are the busy evening slots.")}
          className="mb-3"
        />
        {rulesRead.error ? (
          <LoadError message={rulesRead.error.message} onRetry={rulesRead.error.refused ? undefined : rulesRead.reload} />
        ) : !items ? (
          <Skeleton className="h-40" />
        ) : !items.length ? (
          <EmptyState title={t("No court rates yet")} hint={t("Without a rate a court cannot be quoted, so no booking can be made.")} />
        ) : (
          <div className="grid gap-5">
            {groups.map(([sport, rows], gi) => (
              <details key={sport} open={gi === 0 || rows.some((x) => x.index === bad)} className="group">
                <summary className="mb-2 flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-[var(--radius-md)] bg-surface px-3 text-sm font-medium text-muted [&::-webkit-details-marker]:hidden">
                  <div className="flex items-center gap-2">
                    <SportBadge sport={sport} />
                    <span>
                      {sportLabel(sport)} <span className="normal-case tracking-normal">· {t("{n} rates", { n: rows.length })}</span>
                    </span>
                  </div>
                  <ChevronDown aria-hidden="true" className="size-4 transition-transform group-open:rotate-180" />
                </summary>
                <Stagger className="grid gap-2" gap={0.03}>
                  {rows.map(({ rule: r, index }) => (
                    <StaggerItem key={r.id}>
                      <Card
                        className={`grid grid-cols-2 items-center gap-2 p-3 md:grid-cols-4 ${
                          bad === index ? "border-danger" : ""
                        }`}
                      >
                        <span className="text-sm">
                          {DAY_KIND_LABEL[r.day_kind] ?? r.day_kind}
                          {r.court_id ? (
                            <span className="block text-xs text-muted">{t("{court} only", { court: courtCodes[r.court_id] ?? t("One court") })}</span>
                          ) : null}
                        </span>
                        <span className="text-sm tabular-nums">
                          {r.start_local.slice(0, 5)}-{r.end_local.slice(0, 5)}
                        </span>
                        <span>
                          <Badge tone={r.is_peak ? "accent" : "muted"}>{r.is_peak ? t("Peak") : t("Off-peak")}</Badge>
                        </span>
                        <MoneyInput
                          aria-label={t("{sport} {day} {time} price", {
                            sport: sportLabel(r.sport),
                            day: DAY_KIND_LABEL[r.day_kind] ?? r.day_kind,
                            time: r.start_local.slice(0, 5),
                          })}
                          value={Number.isNaN(r.price_vnd) ? "" : String(r.price_vnd)}
                          onChange={(v) => edit(index, v)}
                        />
                      </Card>
                    </StaggerItem>
                  ))}
                </Stagger>
              </details>
            ))}
          </div>
        )}
        {message ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {message}
          </p>
        ) : null}
        <StarBorder className="mt-4" speed={4}>
          <Button disabled={saving || !items?.length} onClick={() => void save()}>
            {saving ? t("Saving…") : t("Save new prices")}
          </Button>
        </StarBorder>
      </section>

      <section aria-labelledby="plan-prices" className="mt-10">
        <div className="mb-2 flex items-end justify-between gap-3">
          <SectionTitle
            id="plan-prices"
            icon={Ticket}
            text={tk("Membership plans")}
            hint={t("What each plan on sale costs and what it includes.")}
          />
          <Link to="/manager/plans" className="hit text-sm underline">
            {t("Edit plans")}
          </Link>
        </div>
        {plansRead.error ? (
          <LoadError message={plansRead.error.message} onRetry={plansRead.error.refused ? undefined : plansRead.reload} />
        ) : !plans ? (
          <Skeleton className="h-24" />
        ) : !onSale.length ? (
          <EmptyState title={t("No plan is on sale")} hint={t("Members cannot buy a plan until you put one on sale.")}>
            <Link to="/manager/plans" className="hit text-sm underline">
              {t("Go to plans")}
            </Link>
          </EmptyState>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {onSale.map((p) => (
              <Card key={p.id} className="flex items-center justify-between gap-3 p-3">
                <span>
                  <span className="block text-sm font-medium">{tData(p.name)}</span>
                  <span className="block text-xs text-muted">
                    {p.duration_months ? monthsLabel(p.duration_months) : t("{n} days", { n: p.duration_days ?? 30 })}
                  </span>
                </span>
                <span className="text-sm tabular-nums">{money(p.price_vnd)}</span>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="vat" className="mt-10">
        <SectionTitle
          id="vat"
          icon={Percent}
          text={tk("VAT")}
          hint={t("The tax rate printed on every receipt.")}
          className="mb-3"
        />
        <Card className="flex items-center justify-between gap-3 p-4">
          <span className="text-sm">
            {vatRead.error ? (
              t("VAT rate not available.")
            ) : !vatRead.data ? (
              <Skeleton className="h-5 w-40" />
            ) : vat == null ? (
              t("VAT rate not available.")
            ) : (
              <>
                {t("VAT rate on receipts:")} <span className="font-medium tabular-nums">{vat}%</span>
              </>
            )}
          </span>
          <Link to="/manager/settings" className="hit text-sm underline">
            {t("Change in Settings")}
          </Link>
        </Card>
      </section>
    </Shell>
  );
}
