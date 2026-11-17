/**
 * File: src/client/components/attendance-panels.tsx
 * Vai trò: Cung cấp các panel giao diện quản lý chuyên cần và chăm sóc học viên có nguy cơ bỏ tập trong hệ thống Arena3.
 * Vị trí trong app:
 * - AttendancePanel: Báo cáo tỷ lệ điểm danh theo lớp, HLV, học viên (sử dụng tại route /manager/attendance).
 * - AtRiskPanel: Danh sách cảnh báo học viên bỏ tập và form ghi nhận liên hệ chăm sóc (sử dụng tại /desk/at-risk và /manager/attendance).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePageState } from "@/client/lib/use-page-state";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Card,
  DateField,
  EmptyState,
  Field,
  FilterChip,
  Input,
  LoadError,
  Modal,
  Pagination,
  Select,
  Skeleton,
  Stat,
} from "@/client/components/ui";
import { UserAvatar } from "@/client/components/user-avatar";
import { ExportButtons } from "@/client/components/report-panels";
import { ApiClientError, apiGet, apiPost } from "@/client/arena3/client";
import { addDaysISO, formatDate, sportLabel, todayISO } from "@/shared/arena3/labels";
import { scrollBehavior } from "@/client/lib/calm";
import { t, tk, tServer } from "@/client/lib/i18n";
import { readError, useRead, type ReadError } from "@/client/lib/use-read";

// Thống kê số lượng các trạng thái điểm danh và tỷ lệ chuyên cần (rate_pct) của một nhóm đối tượng
type Counts = { present: number; late: number; absent: number; excused: number; rate_pct: number | null };

// Cấu trúc dữ liệu báo cáo chuyên cần trả về từ API /reports/attendance
type Report = {
  from: string;
  to: string;
  totals: Counts;
  classes: Array<Counts & { class_id: string; class_code: string; sport: string; coach: string; students: number }>;
  coaches: Array<Counts & { coach_id: string; coach: string; classes: number }>;
  students: Array<Counts & { user_id: string; full_name: string; member_code: string | null; class_code: string; sport: string }>;
};

/**
 * Làm gì: Chuyển đổi số tỷ lệ phần trăm thành chuỗi hiển thị có dấu "%", hoặc trả về "-" nếu null.
 * Được gọi ở: src/client/components/attendance-panels.tsx (component AttendancePanel để hiển thị rate_pct trong bảng và thẻ Stat).
 * @param v Số phần trăm tỷ lệ điểm danh (number) hoặc null nếu chưa có dữ liệu.
 * @returns Chuỗi hiển thị tỷ lệ phần trăm (ví dụ: "85%") hoặc "-" nếu null.
 */
const pct = (v: number | null) => (v === null ? "-" : `${v}%`);

/**
 * Làm gì: Hiển thị bảng điều khiển báo cáo chuyên cần theo khoảng ngày, gom nhóm theo lớp, HLV hoặc học viên và xuất dữ liệu báo cáo.
 * Được gọi ở: src/routes/manager.attendance.tsx (component Page tại route /manager/attendance).
 * @param canExport Cờ cho phép hiển thị các nút xuất báo cáo ra file (ExportButtons).
 * @returns Khung giao diện JSX chứa bộ lọc thời gian, thẻ thống kê tổng quan và bảng số liệu chi tiết.
 */
/**
 * Attendance rate = (present + late) ÷ (sessions marked − excused). Excused
 * absences are not held against anyone, and nothing here is a penalty (BR-32).
 */
export function AttendancePanel({ canExport }: { canExport: boolean }) {
  // Bước 1: Khởi tạo khoảng thời gian lọc (mặc định 30 ngày gần nhất), chế độ xem (lớp, HLV, học viên) và tải dữ liệu báo cáo chuyên cần qua useRead.
  const [from, setFrom] = useState(() => addDaysISO(todayISO(), -29));
  const [to, setTo] = useState(todayISO);
  const [view, setView] = useState<"class" | "coach" | "student">("class");
  const { data, error, reload } = useRead<Report>(`/reports/attendance?from=${from}&to=${to}`);
  // The server names the date it will not take; a refusal it does not name (a 422) blames both.
  const faulty = (field: "from" | "to") => error?.refused === true && (error.field ? error.field === field : true);
  const errorId = "attendance-error";

  // Bước 2: Render giao diện gồm bộ chọn khoảng ngày, chế độ xem nhóm, các thẻ số liệu tổng quan (Stat) và bảng chi tiết (Table).
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t("From")}>
          <DateField
            required
            value={from}
            max={to}
            onChange={setFrom}
            invalid={faulty("from")}
            aria-describedby={faulty("from") ? errorId : undefined}
            aria-label={t("From")}
          />
        </Field>
        <Field label={t("To")}>
          <DateField
            required
            value={to}
            min={from}
            onChange={setTo}
            invalid={faulty("to")}
            aria-describedby={faulty("to") ? errorId : undefined}
            aria-label={t("To")}
          />
        </Field>
        <Select value={view} onChange={(e) => setView(e.target.value as typeof view)} aria-label={t("Group by")}>
          <option value="class">{t("By class")}</option>
          <option value="coach">{t("By coach")}</option>
          <option value="student">{t("By student")}</option>
        </Select>
        {canExport ? <ExportButtons kind="attendance" from={from} to={to} /> : null}
      </div>

      {error ? (
        <LoadError id={errorId} message={error.message} onRetry={error.refused ? undefined : reload} />
      ) : !data ? (
        <Skeleton className="h-48" />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label={t("Attendance rate")} value={pct(data.totals.rate_pct)} />
            <Stat label={t("Present or late")} value={String(data.totals.present + data.totals.late)} />
            <Stat label={t("Absent")} value={String(data.totals.absent)} />
            <Stat label={t("Excused (not counted)")} value={String(data.totals.excused)} />
          </div>
          {view === "class" ? (
            <Table
              head={[t("Class"), t("Coach"), t("Students"), t("Present"), t("Late"), t("Absent"), t("Excused"), t("Rate")]}
              rows={data.classes.map((c) => [
                `${c.class_code} · ${sportLabel(c.sport)}`,
                c.coach,
                c.students,
                c.present,
                c.late,
                c.absent,
                c.excused,
                pct(c.rate_pct),
              ])}
            />
          ) : view === "coach" ? (
            <Table
              head={[t("Coach"), t("Classes"), t("Present"), t("Late"), t("Absent"), t("Excused"), t("Rate")]}
              rows={data.coaches.map((c) => [c.coach, c.classes, c.present, c.late, c.absent, c.excused, pct(c.rate_pct)])}
            />
          ) : (
            <Table
              head={[t("Student"), t("Class"), t("Present"), t("Late"), t("Absent"), t("Excused"), t("Rate")]}
              rows={data.students.map((s) => [
                `${s.full_name}${s.member_code ? ` (${s.member_code})` : ""}`,
                s.class_code,
                s.present,
                s.late,
                s.absent,
                s.excused,
                pct(s.rate_pct),
              ])}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Làm gì: Hiển thị bảng dữ liệu báo cáo chuyên cần hỗ trợ cuộn ngang trên màn hình nhỏ, hoặc hiển thị EmptyState khi không có dữ liệu.
 * Được gọi ở: src/client/components/attendance-panels.tsx (component AttendancePanel khi hiển thị số liệu theo lớp, HLV hoặc học viên).
 * @param head Danh sách tên các cột tiêu đề trong bảng.
 * @param rows Mảng dữ liệu các dòng, mỗi dòng là danh sách giá trị tương ứng từng cột.
 * @returns Phần tử JSX dạng Card chứa bảng HTML hoặc thông báo EmptyState nếu danh sách rỗng.
 */
function Table({ head, rows }: { head: string[]; rows: Array<Array<string | number>> }) {
  // Trả về giao diện trống (EmptyState) nếu không có buổi học nào được ghi nhận điểm danh trong khoảng thời gian đã chọn.
  if (!rows.length) return <EmptyState title={t("No marked sessions in this window")} hint={t("Pick a longer range.")} />;
  return (
    <Card className="overflow-x-auto p-0" role="region" aria-label={t("Attendance table, scrolls sideways")} tabIndex={0}>
      <table className="w-full min-w-[34rem] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            {head.map((h) => (
              <th key={h} className="px-4 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line/60 last:border-0">
              {r.map((c, j) => (
                <td key={j} className="px-4 py-2 tabular-nums">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// Cấu trúc dữ liệu học viên có nguy cơ bỏ tập kèm lịch sử liên hệ gần nhất trả về từ API /at-risk
type RiskItem = {
  user_id: string;
  full_name: string;
  member_code: string | null;
  phone: string | null;
  plan_end_on: string | null;
  reasons: Array<{ kind: string; message: string }>;
  attendance_pct: number | null;
  last_seen_at: string | null;
  contacted: boolean;
  last_contact: { at: string; outcome: string; note: string | null; by: string } | null;
  avatar_url?: string | null;
};

/**
 * Làm gì: Danh sách các kênh liên hệ với học viên (gọi điện, Zalo, SMS, gặp trực tiếp) để nhân viên chọn khi ghi nhận liên hệ.
 * Được gọi ở: src/client/components/attendance-panels.tsx (dropdown chọn kênh liên hệ trong modal của AtRiskPanel).
 */
const CHANNELS = [
  { value: "phone", label: tk("Phone call") },
  { value: "zalo", label: tk("Zalo") },
  { value: "sms", label: tk("SMS") },
  { value: "in_person", label: tk("In person") },
];
/**
 * Làm gì: Danh sách kết quả cuộc gọi hoặc liên hệ chăm sóc học viên (đã trao đổi, sẽ đi tập lại, dời lịch, xin nghỉ hẳn, không nghe máy).
 * Được gọi ở: src/client/components/attendance-panels.tsx (hàm outcomeLabel và dropdown chọn kết quả trong modal của AtRiskPanel).
 */
const OUTCOMES = [
  { value: "reached", label: tk("Spoke to them") },
  { value: "will_return", label: tk("Will come back") },
  { value: "reschedule", label: tk("Wants another time") },
  { value: "leaving", label: tk("Leaving") },
  { value: "no_answer", label: tk("No answer") },
];
/**
 * Làm gì: Chuyển đổi mã kết quả liên hệ (outcome) sang chuỗi nhãn hiển thị đã được bản địa hóa đa ngôn ngữ.
 * Được gọi ở: src/client/components/attendance-panels.tsx (component AtRiskPanel khi hiển thị lịch sử liên hệ gần nhất của học viên).
 * @param v Mã kết quả liên hệ (ví dụ: "reached", "will_return", "leaving").
 * @returns Chuỗi nhãn hiển thị tương ứng đã dịch qua hàm t(), hoặc giữ nguyên mã gốc nếu không tìm thấy.
 */
const outcomeLabel = (v: string) => {
  const l = OUTCOMES.find((o) => o.value === v)?.label;
  return l ? t(l) : v;
};

type RiskKind = "streak" | "idle" | "expiring";
type RiskFilter = "todo" | "done" | "all" | RiskKind;
type RiskSort = "priority" | "plan_end" | "last_seen" | "name";

/**
 * Làm gì: Danh sách các tiêu chí sắp xếp học viên có nguy cơ bỏ tập (ưu tiên khẩn cấp nhất, hạn gói tập, thời gian vắng mặt, tên A-Z).
 * Được gọi ở: src/client/components/attendance-panels.tsx (dropdown sắp xếp trong component AtRiskPanel).
 */
const SORTS: Array<{ value: RiskSort; label: string }> = [
  { value: "priority", label: tk("Most urgent first") },
  { value: "plan_end", label: tk("Plan ends soonest") },
  { value: "last_seen", label: tk("Away the longest") },
  { value: "name", label: tk("Name A-Z") },
];

/**
 * Làm gì: Trả về nhãn ngắn gọn của lý do học viên có nguy cơ bỏ tập để hiển thị trong badge trên ô bảng danh sách.
 * Được gọi ở: src/client/components/attendance-panels.tsx (component AtRiskPanel khi render danh sách badge lý do cảnh báo).
 * @param kind Loại nguy cơ bỏ tập ("streak": vắng liên tiếp, "idle": lâu ngày không đến, "expiring": sắp hết hạn gói).
 * @param idleDays Ngưỡng số ngày không đến tập do trung tâm cấu hình (mặc định 14 nếu null).
 * @returns Chuỗi nhãn ngắn đã bản địa hóa tương ứng với loại nguy cơ.
 */
/** The short word a receptionist reads in a table cell; the long sentence stays in the tooltip. */
function reasonChip(kind: string, idleDays: number | null) {
  if (kind === "streak") return t("Absent in a row");
  if (kind === "idle") return t("No visit {n}+ days", { n: idleDays ?? 14 });
  return t("Plan ending · low attendance");
}

/**
 * Làm gì: Hiển thị danh sách học viên có nguy cơ bỏ tập (FR-TRN-09), hỗ trợ lọc theo trạng thái, tìm kiếm, phân trang và ghi nhận lịch sử liên hệ.
 * Được gọi ở:
 * - src/routes/desk.at-risk.tsx (màn hình /desk/at-risk của lễ tân).
 * - src/routes/manager.attendance.tsx (tab "At risk" trong màn hình /manager/attendance của quản lý).
 * @param canContact Cờ cho phép hiển thị nút mở modal ghi nhận liên hệ chăm sóc (mặc định true).
 * @returns Khung giao diện JSX chứa bộ lọc trạng thái, ô tìm kiếm, danh sách học viên nguy cơ và modal liên hệ.
 */
/** Members who may be drifting away, with what has already been done about it (FR-TRN-09). */
export function AtRiskPanel({ canContact = true }: { canContact?: boolean }) {
  // Bước 1: Khởi tạo các state quản lý danh sách học viên nguy cơ, bộ lọc (filter), tìm kiếm (q), sắp xếp (sort), phân trang và dữ liệu modal ghi nhận liên hệ.
  const [items, setItems] = useState<RiskItem[] | null>(null);
  const [idleDays, setIdleDays] = useState<number | null>(null);
  const [target, setTarget] = useState<RiskItem | null>(null);
  const [form, setForm] = useState({ channel: "phone", outcome: "reached", note: "" });
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [filter, setFilter] = useState<RiskFilter>("todo");
  const [sort, setSort] = useState<RiskSort>("priority");
  const [q, setQ] = useState("");
  const { offset, setOffset, pageSize, setPageSize, reset } = usePageState("at-risk", 25);
  const top = useRef<HTMLDivElement>(null);

  const [loadError, setLoadError] = useState<ReadError | null>(null);

  // Bước 2: Tải danh sách học viên có nguy cơ bỏ tập và ngưỡng ngày vắng mặt (idle_days) từ API GET /at-risk.
  const load = useCallback(async () => {
    const r = await apiGet<{ items: RiskItem[]; idle_days: number }>("/at-risk");
    setItems(r.items);
    setIdleDays(r.idle_days);
  }, []);
  // The first read says why it failed on the panel itself, with a button to ask again; a refresh after
  // saving a contact keeps the list that is already on screen and reports through `save`'s toast.
  const firstLoad = useCallback(() => {
    setLoadError(null);
    void load().catch((e: unknown) => setLoadError(readError(e)));
  }, [load]);
  useEffect(firstLoad, [firstLoad]);

  /**
   * Làm gì: Gửi bản ghi liên lạc với hội viên có nguy cơ bỏ tập lên server qua POST /contacts, đóng modal và tải lại danh sách.
   * Được gọi ở: src/client/components/attendance-panels.tsx (component AtRiskPanel, sự kiện onClick của nút Save trong Modal ở dòng 445).
   * @returns Promise<void> - không trả về dữ liệu.
   */
  async function save() {
    // Thoát sớm nếu chưa chọn hội viên mục tiêu để tránh gửi request không hợp lệ
    if (!target) return;
    // Khóa nút bấm (busy) tránh người dùng nhấn đúp gửi trùng dữ liệu, đồng thời xóa lỗi trường trước đó
    setBusy(true);
    setFieldError(null);
    try {
      // Bước 1: Gửi thông tin cuộc gọi lên server qua POST /contacts (kênh liên lạc, kết quả, ghi chú và lý do nguy cơ chính)
      await apiPost("/contacts", {
        user_id: target.user_id,
        reason: target.reasons[0]?.kind ?? "other",
        channel: form.channel,
        outcome: form.outcome,
        note: form.note,
      });
      // Bước 2: Báo thành công qua toast, đóng modal, đặt lại form liên lạc về mặc định và tải lại danh sách
      toast.success(t("Contact saved"));
      setTarget(null);
      setForm({ channel: "phone", outcome: "reached", note: "" });
      // Tải lại dữ liệu từ server để cập nhật trạng thái contacted và làm mới số lượng thống kê
      await load();
    } catch (e) {
      // Bước 3: Xử lý lỗi. Nếu server trả về lỗi validate cụ thể theo trường (422), gán vào fieldError để hiện dưới ô nhập; ngược lại báo toast lỗi
      if (e instanceof ApiClientError && e.body.field) setFieldError(tServer(e.message));
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      // Mở lại các nút bấm trên modal sau khi lưu xong (dù thành công hay thất bại)
      setBusy(false);
    }
  }

  // Thống kê số lượng hội viên theo từng nhóm trạng thái và lý do nguy cơ để hiển thị số đếm trên các FilterChip
  const counts = useMemo(() => {
    const c = { all: 0, todo: 0, done: 0, streak: 0, idle: 0, expiring: 0 };
    // Duyệt qua danh sách để phân loại: tổng số (all), đã liên lạc (done), cần gọi (todo) và từng lý do nguy cơ cụ thể
    for (const m of items ?? []) {
      c.all++;
      if (m.contacted) c.done++;
      else c.todo++;
      for (const r of m.reasons) if (r.kind in c) c[r.kind as RiskKind]++;
    }
    return c;
  }, [items]);

  // Lọc và sắp xếp danh sách hội viên hiển thị dựa trên bộ lọc trạng thái, loại nguy cơ, từ khóa tìm kiếm và tiêu chí sắp xếp
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    // Bước 1: Lọc hội viên theo trạng thái liên lạc (todo/done), loại nguy cơ cụ thể và từ khóa tìm kiếm (tên, mã thẻ, SĐT)
    const rows = (items ?? []).filter((m) => {
      if (filter === "todo" && m.contacted) return false;
      if (filter === "done" && !m.contacted) return false;
      // Lọc theo lý do nguy cơ: streak (vắng liên tiếp), idle (không đến nhiều ngày), expiring (gói tập sắp hết)
      if (filter === "streak" || filter === "idle" || filter === "expiring") {
        if (!m.reasons.some((r) => r.kind === filter)) return false;
      }
      // Nếu không nhập từ khóa tìm kiếm thì giữ lại hội viên thỏa mãn các bộ lọc trạng thái ở trên
      if (!term) return true;
      // Tìm kiếm không phân biệt hoa thường theo tên đầy đủ, mã hội viên hoặc số điện thoại
      return [m.full_name, m.member_code, m.phone].some((v) => v?.toLowerCase().includes(term));
    });
    // The server already returns "most urgent first"; only the other orders need work here.
    // Bước 2: Sắp xếp theo lựa chọn. Ai không có ngày hết hạn gói tập được gán mốc 9999 để luôn xếp ở cuối danh sách
    if (sort === "plan_end") rows.sort((a, b) => (a.plan_end_on ?? "9999").localeCompare(b.plan_end_on ?? "9999"));
    // Sắp xếp theo ngày đến trung tâm gần nhất; ai vắng lâu nhất được xếp lên trước
    if (sort === "last_seen") rows.sort((a, b) => (a.last_seen_at ?? "").localeCompare(b.last_seen_at ?? ""));
    // Sắp xếp theo thứ tự bảng chữ cái A-Z của họ và tên hội viên
    if (sort === "name") rows.sort((a, b) => a.full_name.localeCompare(b.full_name));
    return rows;
  }, [items, filter, sort, q]);

  // A new search, filter or sort starts from the first page; a stale offset would show an empty one.
  useEffect(reset, [filter, sort, q, reset]);
  // Phân trang: cắt danh sách đã lọc theo vị trí offset và số lượng bản ghi mỗi trang (pageSize)
  const page = shown.slice(offset, offset + pageSize);
  /**
   * Làm gì: Chuyển sang trang phân trang mới và cuộn màn hình lên đầu danh sách hội viên.
   * Được gọi ở: src/client/components/attendance-panels.tsx (component AtRiskPanel, truyền vào prop onChange của Pagination ở dòng 432).
   * @param o Vị trí offset mới của trang cần hiển thị.
   * @returns Không trả về dữ liệu.
   */
  const goTo = (o: number) => {
    setOffset(o);
    // Cuộn lên đầu danh sách; scrollBehavior() tự chuyển thành tức thì nếu người dùng bật chế độ giảm chuyển động (prefers-reduced-motion)
    top.current?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  };

  // Trạng thái chờ tải dữ liệu: hiển thị màn hình báo lỗi nếu API thất bại, hoặc 6 khung xương (Skeleton) khi đang tải
  if (!items)
    return loadError ? (
      <LoadError message={loadError.message} onRetry={firstLoad} />
    ) : (
      <div className="grid gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    );

  // Cấu hình danh sách chip bộ lọc: mục todo dùng tone hold (cảnh báo) để nhắc lễ tân các hội viên cần gọi điện chăm sóc
  const chips: Array<{ value: RiskFilter; label: string; count: number; tone?: "hold" }> = [
    { value: "todo", label: t("To call"), count: counts.todo, tone: "hold" },
    { value: "done", label: t("Already contacted"), count: counts.done },
    { value: "all", label: t("Everyone"), count: counts.all },
    { value: "streak", label: t("Absent in a row"), count: counts.streak },
    { value: "idle", label: t("No visit {n}+ days", { n: idleDays ?? 14 }), count: counts.idle },
    { value: "expiring", label: t("Plan ending soon"), count: counts.expiring },
  ];

  // Bước 3: Dựng giao diện hoàn chỉnh gồm: giải thích quy tắc, thanh chip lọc, thanh tìm kiếm & sắp xếp, danh sách hội viên và modal ghi nhận liên lạc
  return (
    <div className="grid gap-3" ref={top}>
      <details className="group rounded-[var(--radius-lg)] bg-surface px-4 py-3 text-sm shadow-[var(--shadow-border)]">
        <summary className="cursor-pointer py-3 font-medium marker:text-muted sm:py-0.5">{t("Who ends up on this list?")}</summary>
        <p className="mt-2 text-muted">
          {t(
            "Three things put someone here: absent three sessions running, no visit for {n}+ days on a live plan, or a plan ending soon with low attendance. Contacting them is a courtesy call, never a penalty.",
            { n: idleDays ?? "-" },
          )}
        </p>
      </details>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0" role="group" aria-label={t("Filter the list")}>
        {chips.map((c) => (
          <FilterChip key={c.value} active={filter === c.value} onClick={() => setFilter(c.value)} label={c.label} count={c.count} tone={c.tone} />
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_14rem]">
        <Input placeholder={t("Search name, phone or member code")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("Search the list")} />
        <Select value={sort} onChange={(e) => setSort(e.target.value as RiskSort)} aria-label={t("Sort the list")}>
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {t(s.label)}
            </option>
          ))}
        </Select>
      </div>

      {!items.length ? (
        <EmptyState title={t("Nobody is at risk")} hint={t("Everyone with a plan has been in recently.")} />
      ) : !shown.length ? (
        <EmptyState
          title={filter === "todo" && !q ? t("Everyone on the list has been contacted") : t("Nobody matches")}
          hint={filter === "todo" && !q ? t("Nice work. Switch to “Already contacted” to review the calls.") : t("Loosen the filter or check the spelling.")}
        >
          {filter !== "all" || q ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setFilter("all");
                setQ("");
              }}
            >
              {t("Show everyone")}
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <>
          <Card className="overflow-hidden p-0">
            <ul className="divide-y divide-line/70">
              {page.map((m) => (
                <li key={m.user_id} className="grid gap-x-4 gap-y-1.5 px-4 py-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.5fr)_8.5rem_auto] md:items-center">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="size-8 shrink-0">
                      <UserAvatar name={m.full_name} url={m.avatar_url} />
                    </div>
                    <div className="min-w-0">
                      <p className="break-words font-medium">
                        {m.full_name} <span className="text-xs font-normal tabular-nums text-muted">{m.member_code}</span>
                      </p>
                      <p className="break-words text-xs text-muted">
                        {m.phone ? (
                          <a href={`tel:${m.phone}`} className="tabular-nums hover:underline">
                            {m.phone}
                          </a>
                        ) : (
                          t("no phone")
                        )}
                        {m.last_seen_at ? ` · ${t("last seen {date}", { date: formatDate(m.last_seen_at) })}` : ` · ${t("never seen")}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5" title={m.reasons.map((r) => tServer(r.message)).join(" ")}>
                    {m.reasons.map((r) => (
                      <Badge key={r.kind} tone={r.kind === "streak" ? "danger" : r.kind === "idle" ? "hold" : "muted"}>
                        {reasonChip(r.kind, idleDays)}
                      </Badge>
                    ))}
                  </div>
                  <div className="text-xs text-muted md:text-right">
                    <p>{m.plan_end_on ? t("Plan ends {date}", { date: formatDate(m.plan_end_on) }) : t("No live plan")}</p>
                    {m.attendance_pct !== null ? <p className="tabular-nums">{t("Attendance {pct}%", { pct: m.attendance_pct })}</p> : null}
                  </div>
                  <div className="flex items-center gap-2 md:justify-end">
                    <Badge tone={m.contacted ? "muted" : "hold"}>{m.contacted ? t("Contacted") : t("Not contacted")}</Badge>
                    {canContact ? (
                      <Button size="sm" variant={m.contacted ? "ghost" : "outline"} onClick={() => setTarget(m)}>
                        {t("Log a contact")}
                      </Button>
                    ) : null}
                  </div>
                  {m.last_contact ? (
                    <p className="text-xs text-muted md:col-span-4">
                      {formatDate(m.last_contact.at)} · {m.last_contact.by}: {outcomeLabel(m.last_contact.outcome)}
                      {m.last_contact.note ? ` · ${m.last_contact.note}` : ""}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
          <Pagination offset={offset} total={shown.length} pageSize={pageSize} onChange={goTo} onPageSizeChange={setPageSize} label={t("At-risk pages")} />
        </>
      )}

      <Modal
        open={target !== null}
        onClose={() => setTarget(null)}
        title={target ? t("Contact {name}", { name: target.full_name }) : ""}
        footer={
          <>
            <Button variant="ghost" onClick={() => setTarget(null)}>
              {t("Cancel")}
            </Button>
            <Button disabled={busy} onClick={() => void save()}>
              {busy ? t("Saving…") : t("Save")}
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <Field label={t("How")}>
            <Select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
              {CHANNELS.map((c) => (
                <option key={c.value} value={c.value}>
                  {t(c.label)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("What happened")} hint={fieldError ?? undefined}>
            <Select value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })}>
              {OUTCOMES.map((c) => (
                <option key={c.value} value={c.value}>
                  {t(c.label)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("Note (optional)")}>
            <Input value={form.note} maxLength={300} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
