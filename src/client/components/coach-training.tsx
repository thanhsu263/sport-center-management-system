/**
 * File: coach-training.tsx
 * Vai trò: Cung cấp các panel giao diện phục vụ huấn luyện viên quản lý đào tạo trong lớp học:
 * - ResultsPanel: Nhập kết quả đánh giá và chỉ số rèn luyện của từng học viên (FR-TRN-05).
 * - PlanPanel: Soạn thảo giáo án, gợi ý qua AI, quản lý phiên bản và xuất bản cho lớp (FR-TRN-04).
 * - HomeworkPanel: Quản lý bài tập về nhà và theo dõi tiến độ hoàn thành của học viên (FR-TRN-06).
 * Vị trí trong app: Được tích hợp vào màn hình điểm danh & điều hành buổi học tại route `/coach/attendance`.
 */
import { useEffect, useState } from "react";
import { SectionTitle } from "@/client/components/section";
import { toast } from "sonner";
import { Badge, Button, Card, EmptyState, DateField, Field, Input, LoadError, Select, Skeleton, Textarea } from "@/client/components/ui";
import { Reveal } from "@/client/components/motion";
import { hhmm } from "@/client/components/shell";
import { sessionDay } from "@/client/components/class-detail";
import { apiGet, apiPatch, apiPost, apiPut } from "@/client/arena3/client";
import { addDaysISO, formatDate } from "@/shared/arena3/labels";
import { scrollBehavior } from "@/client/lib/calm";
import { t, tk, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";

type Msg = (e: unknown) => string;
/**
 * Làm gì: Trích xuất thông báo lỗi từ đối tượng ngoại lệ (Error) hoặc trả về thông báo lỗi mặc định nếu lỗi không xác định.
 * Được gọi ở: coach-training.tsx (các khối catch trong ResultsPanel, PlanPanel, HomeworkPanel).
 * @param e Ngoại lệ hoặc lỗi bắt được từ khối try/catch.
 * @returns Chuỗi thông báo lỗi đã được xử lý để hiển thị thông báo toast.
 */
const say: Msg = (e) => (e instanceof Error ? e.message : t("Something went wrong"));

/** Bản nháp giáo án AI cho một buổi trong khóa, chờ HLV duyệt. */
type CourseDraft = { session_id: string; start_at: string; end_at: string; title: string; ai: boolean; payload: PlanPayload };

export type TrainingSession = {
  id: string;
  class_id: string;
  start_at: string;
  end_at?: string;
  sport: string;
  level: string;
  status: string;
};

// Danh sách các chỉ số tập luyện định lượng cần theo dõi cho học viên theo FR-TRN-05
const METRICS = [
  { key: "smash_count", label: tk("Smashes"), hint: tk("count") },
  { key: "freethrow_pct", label: tk("Free throws %"), hint: "0-100" },
  { key: "serve_pct", label: tk("Serves in %"), hint: "0-100" },
] as const;

// Các giai đoạn tiêu chuẩn cấu thành một buổi tập (khởi động, kỹ thuật, thể lực, thi đấu, thả lỏng)
const PHASES = [tk("warm-up"), tk("technique"), tk("fitness"), tk("match"), tk("cool-down")] as const;

/* ------------------------------------------------------------------ *
 * Results — plan completion and numbers per student (FR-TRN-05)        *
 * ------------------------------------------------------------------ */

type ResultRow = {
  user_id: string;
  full_name: string;
  member_code: string | null;
  attendance: string | null;
  plan_pct: number | null;
  metrics: Record<string, number> | null;
  note: string | null;
};

type Draft = { pct: string; note: string } & Record<string, string>;

/**
 * Làm gì: Chuyển đổi dữ liệu kết quả học viên từ server (ResultRow) sang dạng chuỗi nháp (Draft) để gắn vào form nhập liệu.
 * Được gọi ở: coach-training.tsx (ResultsPanel: khi nhận dữ liệu từ useRead và sau khi gọi API save thành công).
 * @param r Bản ghi kết quả học viên từ API.
 * @returns Đối tượng Draft chứa dữ liệu chuỗi phục vụ binding hai chiều trên form.
 */
function toDraft(r: ResultRow): Draft {
  const d: Draft = { pct: r.plan_pct == null ? "" : String(r.plan_pct), note: r.note ?? "" };
  for (const m of METRICS) d[m.key] = r.metrics?.[m.key] == null ? "" : String(r.metrics[m.key]);
  return d;
}

/**
 * Làm gì: Panel cho huấn luyện viên ghi nhận tiến độ hoàn thành giáo án và các chỉ số tập luyện của từng học viên (FR-TRN-05).
 * Được gọi ở: src/routes/coach.attendance.tsx (component Page).
 * @param sessionId ID của buổi tập cần nhập kết quả.
 * @param cancelled Trạng thái buổi tập đã bị hủy hay chưa; nếu đã hủy sẽ vô hiệu hóa việc ghi nhận.
 * @returns JSX hiển thị bảng danh sách học viên và form nhập chỉ số kết quả.
 */
export function ResultsPanel({ sessionId, cancelled }: { sessionId: string; cancelled: boolean }) {
  const { data, error, reload } = useRead<{ items: ResultRow[] }>(`/sessions/${sessionId}/results`);
  const [rows, setRows] = useState<ResultRow[] | null>(null);
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState(false);

  // What the server holds is where the form starts; typing after that stays in the form until it is saved.
  useEffect(() => {
    setRows(data?.items ?? null);
    setDraft(Object.fromEntries((data?.items ?? []).map((x) => [x.user_id, toDraft(x)])));
  }, [data]);

  /**
   * Làm gì: Thu thập dữ liệu nháp của tất cả học viên, kiểm tra và gửi lên server để lưu kết quả buổi tập.
   * Được gọi ở: coach-training.tsx (ResultsPanel: sự kiện onClick của nút "Save results").
   * @returns Không trả về dữ liệu (Promise<void>).
   */
  async function save() {
    // Bước 1: Bật trạng thái saving để khóa nút bấm, tránh người dùng bấm gửi nhiều lần liên tiếp
    setSaving(true);
    try {
      // Bước 2: Chuyển đổi dữ liệu form từ chuỗi sang kiểu số; nếu để trống thì gán null để server không báo lỗi
      const items = (rows ?? []).map((r) => {
        const d = draft[r.user_id]!;
        const metrics: Record<string, number> = {};
        for (const m of METRICS) if (d[m.key] !== "") metrics[m.key] = Number(d[m.key]);
        return {
          user_id: r.user_id,
          plan_pct: d.pct === "" ? null : Number(d.pct),
          metrics,
          note: d.note,
        };
      });
      // Bước 3: Gửi toàn bộ danh sách kết quả lên server qua API PUT và đồng bộ lại state form từ dữ liệu trả về
      const res = await apiPut<{ items: ResultRow[] }>(`/sessions/${sessionId}/results`, { items });
      setRows(res.items);
      setDraft(Object.fromEntries(res.items.map((x) => [x.user_id, toDraft(x)])));
      toast.success(t("Results saved"));
    } catch (e) {
      toast.error(say(e));
    } finally {
      setSaving(false);
    }
  }

  /**
   * Làm gì: Cập nhật giá trị một trường dữ liệu nháp của một học viên cụ thể trong bảng kết quả.
   * Được gọi ở: coach-training.tsx (ResultsPanel: sự kiện onChange của các ô input plan_pct, note, metrics).
   * @param id ID của học viên (user_id).
   * @param k Tên trường cần cập nhật (pct, note, hoặc key trong METRICS).
   * @param v Giá trị chuỗi mới do người dùng nhập vào ô.
   */
  const set = (id: string, k: string, v: string) =>
    setDraft((d) => ({ ...d, [id]: { ...d[id]!, [k]: v } as Draft }));

  return (
    <div>
      <SectionTitle text={t("Results")} className="font-display text-2xl" />
      <p className="mt-1 text-sm text-muted">
        {t("How much of the plan each student got through, and any numbers worth tracking. Leave a row blank to record nothing.")}
      </p>
      {cancelled ? (
        <p className="mt-3 text-sm text-muted">{t("This session was cancelled, so there is nothing to record.")}</p>
      ) : error ? (
        <div className="mt-3">
          <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
        </div>
      ) : !rows ? (
        <Skeleton className="mt-3 h-24" />
      ) : !rows.length ? (
        <p className="mt-3 text-sm text-muted">{t("Nobody is enrolled in this class yet.")}</p>
      ) : (
        <>
          {/* One row per student, columns shared: numbers line up so a column can be filled straight down. */}
          <Card className="mt-3 overflow-hidden p-0">
            <div className="hidden grid-cols-[minmax(0,1.4fr)_repeat(4,5.5rem)] gap-2 border-b border-line bg-wood/60 px-4 py-2 text-xs font-semibold text-muted md:grid">
              <span>{t("Student")}</span>
              <span>{t("Plan done %")}</span>
              {METRICS.map((m) => (
                <span key={m.key}>{t(m.label)}</span>
              ))}
            </div>
            <ul className="divide-y divide-line">
              {rows.map((r) => {
                const d = draft[r.user_id];
                if (!d) return null;
                return (
                  <li key={r.user_id} className="grid gap-2 px-4 py-3">
                    <div className="grid items-center gap-2 md:grid-cols-[minmax(0,1.4fr)_repeat(4,5.5rem)]">
                      <p className="flex min-w-0 flex-wrap items-center gap-x-2 font-medium">
                        {r.full_name}
                        {r.attendance ? (
                          <Badge tone={r.attendance === "absent" ? "danger" : "muted"}>{t(r.attendance)}</Badge>
                        ) : null}
                      </p>
                      <div className="grid grid-cols-2 gap-2 md:contents">
                        <label className="grid gap-1">
                          <span className="text-xs text-muted md:sr-only">{t("Plan done %")}</span>
                          <Input
                            inputMode="numeric"
                            placeholder="0-100"
                            value={d.pct}
                            onChange={(e) => set(r.user_id, "pct", e.target.value)}
                          />
                        </label>
                        {METRICS.map((m) => (
                          <label key={m.key} className="grid gap-1">
                            <span className="text-xs text-muted md:sr-only">{t(m.label)}</span>
                            <Input
                              inputMode="numeric"
                              placeholder={t(m.hint)}
                              value={d[m.key]}
                              onChange={(e) => set(r.user_id, m.key, e.target.value)}
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                    <Input
                      aria-label={t("Note")}
                      maxLength={1000}
                      placeholder={t("What stood out today")}
                      value={d.note}
                      onChange={(e) => set(r.user_id, "note", e.target.value)}
                    />
                  </li>
                );
              })}
            </ul>
          </Card>
          <div className="sticky bottom-24 z-10 mt-4 md:bottom-4">
            <Button size="lg" className="w-full shadow-[var(--shadow-soft)]" onClick={save} disabled={saving}>
              {saving ? t("Saving…") : t("Save results")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Plans — build, publish, copy last week (FR-TRN-04)                   *
 * Blocks carry intensity, a description, equipment and a target so a   *
 * plan can be run by someone other than its author (BR-49). A published *
 * plan that changes keeps its earlier versions (BR-48).                *
 * ------------------------------------------------------------------ */

type Block = {
  title: string;
  minutes: string;
  phase: string;
  intensity: string;
  description: string;
  equipment: string;
  target: string;
};
type PlanBlock = {
  title: string;
  minutes: number;
  phase?: string;
  intensity?: string;
  description?: string;
  equipment?: string;
  target?: string;
};
type PlanPayload = {
  blocks?: PlanBlock[];
  note?: string;
  goal?: string;
  sport?: string;
  level?: string;
};
type PlanRow = {
  id: string;
  title: string | null;
  published: boolean;
  source: string;
  version?: number;
  session_id: string | null;
  session_start: string | null;
  payload: PlanPayload;
};
type Template = { id: string; title: string | null; payload: PlanPayload };
type Version = { version: number; title: string | null; payload: PlanPayload; created_at: string };
type PlanWarning = { message: string; kind?: string };

const INTENSITIES = [tk("light"), tk("medium"), tk("hard")] as const;
// Giới hạn tối đa 12 khối bài tập trong một buổi để đảm bảo thời lượng và khối lượng vận động hợp lý
const MAX_BLOCKS = 12;

/**
 * Làm gì: Định dạng chuỗi hiển thị số lượng khối bài tập theo quy tắc số ít / số nhiều có dịch đa ngôn ngữ.
 * Được gọi ở: coach-training.tsx (PlanPanel: hiển thị số lượng block trên danh sách giáo án).
 * @param n Số lượng khối bài tập.
 * @returns Chuỗi hiển thị đã bản địa hóa (ví dụ: "1 block" hoặc "3 blocks").
 */
const blocksLabel = (n: number) => (n === 1 ? t("1 block") : t("{n} blocks", { n }));

/**
 * Làm gì: Khởi tạo một khối bài tập rỗng với các thông số mặc định (10 phút, phần kỹ thuật, cường độ trung bình).
 * Được gọi ở: coach-training.tsx (fromPlanBlocks, PlanPanel: state blocks, reset form, và nút thêm block mới).
 * @returns Đối tượng Block với các trường mặc định sẵn sàng để chỉnh sửa trên form.
 */
const blank = (): Block => ({
  title: "",
  minutes: "10",
  phase: "technique",
  intensity: "medium",
  description: "",
  equipment: "",
  target: "",
});

/**
 * Làm gì: Chuyển đổi danh sách khối bài tập từ định dạng lưu trữ của server (PlanBlock[]) sang cấu trúc form chỉnh sửa (Block[]), đồng thời lược bỏ hậu tố thời lượng trong tiêu đề.
 * Được gọi ở: coach-training.tsx (PlanPanel: suggest, loadTemplate, edit).
 * @param list Danh sách khối bài tập dạng PlanBlock từ API hoặc template.
 * @returns Mảng Block phục vụ hiển thị trên form; trả về 1 block mặc định nếu danh sách rỗng.
 */
const fromPlanBlocks = (list: PlanBlock[] | undefined): Block[] =>
  list?.length
    ? list.map((b) => ({
        title: b.title.replace(/\s*\d+\s*[′']$/, ""),
        minutes: String(b.minutes),
        phase: b.phase ?? "",
        intensity: b.intensity ?? "",
        description: b.description ?? "",
        equipment: b.equipment ?? "",
        target: b.target ?? "",
      }))
    : [blank()];

/** Only what the coach filled in goes to the server — empty strings would fail its checks. */
const toPlanBlocks = (list: Block[]): PlanBlock[] =>
  list.map((b) => ({
    title: b.title,
    minutes: Number(b.minutes),
    ...(b.phase ? { phase: b.phase } : {}),
    ...(b.intensity ? { intensity: b.intensity } : {}),
    ...(b.description.trim() ? { description: b.description.trim() } : {}),
    ...(b.equipment.trim() ? { equipment: b.equipment.trim() } : {}),
    ...(b.target.trim() ? { target: b.target.trim() } : {}),
  }));

/**
 * Làm gì: Tính tổng thời lượng (phút) của tất cả các khối bài tập trong giáo án đang soạn.
 * Được gọi ở: coach-training.tsx (PlanPanel: kiểm tra khớp thời lượng với lịch buổi tập).
 * @param list Danh sách các khối bài tập trên form.
 * @returns Tổng số phút của các block có thời lượng hợp lệ.
 */
const planMinutes = (list: Block[]) => list.reduce((n, b) => n + (Number.isFinite(Number(b.minutes)) ? Number(b.minutes) : 0), 0);

/** Monday of the week before the one holding `iso` (the centre's calendar). */
function lastWeekMonday(iso: string) {
  // Định dạng en-CA xuất ra YYYY-MM-DD theo múi giờ Việt Nam để tránh lệch ngày do chênh lệch timezone
  const day = new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
  const [y, m, d] = day.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  // Công thức chuẩn hóa thứ Hai: (dow + 6) % 7 đưa thứ Hai về 0, trừ thêm 7 ngày để lùi về thứ Hai tuần trước
  return addDaysISO(day, -((dow + 6) % 7) - 7);
}

/**
 * Làm gì: Panel quản lý giáo án huấn luyện: soạn thảo, gợi ý bài tập bằng AI, nạp mẫu (template), nhân bản từ tuần trước, lưu lịch sử phiên bản và xuất bản cho lớp (FR-TRN-04, BR-48, BR-49).
 * Được gọi ở: src/routes/coach.attendance.tsx (component Page).
 * @param session Dữ liệu buổi tập hiện tại (id, class_id, môn, trình độ, giờ bắt đầu/kết thúc).
 * @param f5 Cờ tính năng (feature flag) bật/tắt các tiện ích mở rộng của giáo án.
 * @returns JSX hiển thị form soạn thảo và danh sách các giáo án của lớp.
 */
export function PlanPanel({ session, f5 }: { session: TrainingSession; f5: boolean }) {
  const plansRead = useRead<{ items: PlanRow[] }>(`/training-plans?class_id=${session.class_id}`);
  const plans = plansRead.data?.items ?? null;
  // Templates are an extra: if they do not come, the coach simply builds the plan from scratch.
  const tplRead = useRead<{ items: Template[] }>(`/training-plans/templates?sport=${session.sport}&level=${session.level}`);
  const templates = tplRead.data?.items ?? [];
  const [blocks, setBlocks] = useState<Block[]>([blank()]);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [focus, setFocus] = useState("core technique");
  const [busy, setBusy] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  // Gợi ý cho cả khóa: mỗi buổi sắp tới chưa có giáo án nhận một bản nháp để HLV duyệt
  const [course, setCourse] = useState<CourseDraft[] | null>(null);
  const [courseBusy, setCourseBusy] = useState<string | null>(null);
  // The plan being changed. Its payload is carried so goal / sport / level survive an edit.
  const [editing, setEditing] = useState<PlanRow | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [open, setOpen] = useState<Record<number, boolean>>({ 0: true });
  const [history, setHistory] = useState<{ plan: PlanRow; items: Version[] } | null>(null);

  // Same rule as the server (FR-TRN-04): a hint, never a block on publishing.
  const sessionMinutes = session.end_at
    ? Math.round((new Date(session.end_at).getTime() - new Date(session.start_at).getTime()) / 60_000)
    : null;

  /**
   * Làm gì: Xóa sạch dữ liệu trên form soạn thảo giáo án và đưa về trạng thái một block trắng ban đầu.
   * Được gọi ở: coach-training.tsx (PlanPanel: sau khi submit thành công hoặc khi nhấn hủy chỉnh sửa).
   * @returns Không trả về dữ liệu.
   */
  function reset() {
    setBlocks([blank()]);
    setTitle("");
    setNote("");
    setEditing(null);
    setTemplateId("");
    setOpen({ 0: true });
  }

  /**
   * Làm gì: Lọc và hiển thị thông báo cảnh báo từ server qua toast (bỏ qua cảnh báo lệch thời lượng vì đã có UI cảnh báo riêng).
   * Được gọi ở: coach-training.tsx (PlanPanel: trong hàm submit sau khi lưu hoặc cập nhật giáo án).
   * @param warnings Danh sách cảnh báo trả về từ API.
   * @returns Không trả về dữ liệu.
   */
  function warn(warnings: PlanWarning[] | undefined) {
    // The length check is shown live under the blocks, so a toast after saving only repeats it.
    for (const w of warnings ?? []) if (w.kind !== "duration_mismatch") toast.warning(tServer(w.message));
  }

  /**
   * Làm gì: Gửi yêu cầu đến API để AI tạo gợi ý giáo án hoặc lấy bài tập mặc định theo môn thể thao, trình độ và mục tiêu buổi học.
   * Được gọi ở: coach-training.tsx (PlanPanel: sự kiện onClick của nút "Suggest with AI" / "Get suggestions").
   * @returns Không trả về dữ liệu (Promise<void>).
   */
  async function suggest() {
    // Bước 1: Bật trạng thái suggesting để hiển thị hiệu ứng chờ khi AI xử lý
    setSuggesting(true);
    try {
      // Bước 2: Gọi API gợi ý bài tập kèm môn thể thao, trình độ lớp và yêu cầu chi tiết (prompt) nếu có
      const r = await apiPost<{ payload: PlanPayload; ai?: boolean }>("/training-plans/suggest", {
        sport: session.sport,
        level: session.level,
        goal: focus,
        class_id: session.class_id,
        prompt: aiPrompt.trim() || undefined,
      });
      // The suggestion writes its length into the title ("Net shots 10′"); the minutes box already says it.
      // Bước 3: Đưa các khối bài tập và ghi chú gợi ý vào form để huấn luyện viên xem xét và tùy chỉnh
      const next = fromPlanBlocks(r.payload.blocks);
      if (r.payload.blocks?.length) setBlocks(next);
      if (r.payload.note) setNote(r.payload.note);
      if (aiPrompt.trim() && !r.ai) toast.warning(t("The AI is not reachable, so these are the standard drills for this level."));
      else toast.success(t("Suggestion added. Edit anything before you publish."));
    } catch (e) {
      toast.error(say(e));
    } finally {
      setSuggesting(false);
    }
  }

  /**
   * Làm gì: Nhờ AI gợi ý giáo án cho mọi buổi sắp tới chưa có giáo án của lớp (dựa trên hồ sơ học viên), hiện ra để HLV duyệt từng buổi.
   * Được gọi ở: coach-training.tsx (PlanPanel: nút "Suggest for all sessions").
   */
  async function suggestCourse() {
    setSuggesting(true);
    try {
      const r = await apiPost<{ sessions: CourseDraft[]; ai: boolean }>("/training-plans/suggest", {
        mode: "course",
        sport: session.sport,
        level: session.level,
        goal: focus,
        class_id: session.class_id,
        prompt: aiPrompt.trim() || undefined,
      });
      if (!r.sessions.length) {
        toast.info(t("Every upcoming session already has a plan."));
        setCourse(null);
        return;
      }
      setCourse(r.sessions);
      if (!r.ai) toast.warning(t("The AI is not reachable, so these are the standard drills for this level."));
      else toast.success(t("Drafts ready for {n} sessions. Review each one below.", { n: r.sessions.length }));
    } catch (e) {
      toast.error(say(e));
    } finally {
      setSuggesting(false);
    }
  }

  /**
   * Làm gì: Lưu một bản nháp của khóa thành giáo án cho đúng buổi đó (nháp hoặc công bố), rồi bỏ khỏi danh sách duyệt.
   */
  async function approveDraft(d: CourseDraft, published: boolean) {
    setCourseBusy(d.session_id);
    try {
      const r = await apiPost<{ warnings?: PlanWarning[] }>("/training-plans", {
        class_id: session.class_id,
        session_id: d.session_id,
        title: d.title,
        published,
        source: "ai",
        payload: { ...d.payload, goal: d.title || d.payload.goal },
      });
      warn(r.warnings);
      setCourse((l) => (l ?? []).filter((x) => x.session_id !== d.session_id));
      toast.success(published ? t("Plan published to the class") : t("Draft saved"));
      plansRead.reload();
    } catch (e) {
      toast.error(say(e));
    } finally {
      setCourseBusy(null);
    }
  }

  /** Bỏ một buổi khỏi danh sách duyệt mà không lưu gì. */
  const skipDraft = (d: CourseDraft) => setCourse((l) => (l ?? []).filter((x) => x.session_id !== d.session_id));

  /** Lưu tất cả bản nháp còn lại thành nháp (chưa công bố). */
  async function approveAll() {
    for (const d of course ?? []) await approveDraft(d, false);
  }

  /**
   * Làm gì: Đọc dữ liệu từ giáo án mẫu (template) đã chọn và điền vào form soạn thảo hiện tại.
   * Được gọi ở: coach-training.tsx (PlanPanel: sự kiện onClick của nút "Load template").
   * @returns Không trả về dữ liệu (Promise<void>).
   */
  async function loadTemplate() {
    // Bước 1: Kiểm tra template được chọn trong danh mục bài mẫu sẵn có
    if (!templateId) return;
    const tpl = templates.find((x) => x.id === templateId);
    if (!tpl) return;
    // Bước 2: Nạp các block bài tập vào form, giữ lại tiêu đề và ghi chú người dùng đã tự nhập trước đó
    setBlocks(fromPlanBlocks(tpl.payload.blocks));
    if (!title && tpl.title) setTitle(tpl.title);
    if (!note && tpl.payload.note) setNote(tpl.payload.note);
    setEditing(null);
    toast.success(t("Template loaded. Change anything, then save or publish."));
  }

  /**
   * Làm gì: Lưu giáo án thành bản nháp (draft) hoặc xuất bản chính thức (published) cho học viên xem; xử lý cả tạo mới và cập nhật.
   * Được gọi ở: coach-training.tsx (PlanPanel: nút "Save draft" và nút "Publish to class").
   * @param published true nếu công khai cho học viên và phụ huynh xem, false nếu chỉ lưu nháp nội bộ.
   * @returns Không trả về dữ liệu (Promise<void>).
   */
  async function submit(published: boolean) {
    // Bước 1: Khóa tương tác trên form để tránh bấm trùng lặp khi đang gửi request
    setBusy(true);
    try {
      // Bước 2: Chuẩn bị payload: kết hợp thông tin cũ, cập nhật mục tiêu, ghi chú và lọc sạch các block trống
      const payload = {
        ...(editing?.payload ?? {}),
        goal: title || editing?.payload.goal || focus,
        note,
        blocks: toPlanBlocks(blocks),
      };
      // Bước 3: Phân nhánh: gọi API PATCH nếu đang chỉnh sửa giáo án cũ, hoặc API POST nếu tạo giáo án mới
      if (editing) {
        const r = await apiPatch<{ warnings?: PlanWarning[] }>(`/training-plans/${editing.id}`, {
          title,
          payload,
          published,
        });
        toast.success(published ? t("Plan updated for the class") : t("Draft updated"));
        warn(r.warnings);
      } else {
        const r = await apiPost<{ warnings?: PlanWarning[] }>("/training-plans", {
          class_id: session.class_id,
          session_id: session.id,
          title,
          published,
          source: "coach",
          payload,
        });
        toast.success(published ? t("Plan published to the class") : t("Draft saved"));
        warn(r.warnings);
      }
      // Bước 4: Xóa sạch form nhập liệu và tải lại danh sách giáo án từ server để cập nhật giao diện
      reset();
      plansRead.reload();
    } catch (e) {
      toast.error(say(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Làm gì: Nạp toàn bộ dữ liệu của một giáo án vào form soạn thảo để chỉnh sửa và cuộn trang lên đầu.
   * Được gọi ở: coach-training.tsx (PlanPanel: nút "Edit" trên từng thẻ giáo án).
   * @param p Đối tượng PlanRow chứa thông tin giáo án được chọn để sửa.
   * @returns Không trả về dữ liệu.
   */
  function edit(p: PlanRow) {
    setEditing(p);
    setTitle(p.title ?? "");
    setNote(p.payload.note ?? "");
    setBlocks(fromPlanBlocks(p.payload.blocks));
    setOpen({ 0: true });
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
  }

  /**
   * Làm gì: Chuyển đổi trạng thái xuất bản của giáo án giữa bản nháp (draft) và đã công bố (published).
   * Được gọi ở: coach-training.tsx (PlanPanel: nút chuyển trạng thái xuất bản trên thẻ giáo án).
   * @param p Đối tượng PlanRow của giáo án cần đổi trạng thái.
   * @returns Không trả về dữ liệu (Promise<void>).
   */
  async function toggle(p: PlanRow) {
    try {
      await apiPatch(`/training-plans/${p.id}`, { published: !p.published });
    } catch (e) {
      toast.error(say(e));
    }
    // Either way the list shows what the server holds now, so a plan someone else changed does not linger.
    plansRead.reload();
  }

  /**
   * Làm gì: Lưu giáo án hiện tại vào kho mẫu giáo án (template) dùng chung cho môn thể thao và trình độ tương ứng.
   * Được gọi ở: coach-training.tsx (PlanPanel: nút "Save as template" trên từng thẻ giáo án).
   * @param p Đối tượng PlanRow của giáo án cần lưu làm mẫu.
   * @returns Không trả về dữ liệu (Promise<void>).
   */
  async function saveTemplate(p: PlanRow) {
    try {
      await apiPost(`/training-plans/${p.id}/save-template`, {
        title: p.title ?? undefined,
        sport: p.payload.sport ?? session.sport,
        level: p.payload.level ?? session.level,
      });
      toast.success(t("Saved as a template for this sport and level"));
      tplRead.reload();
    } catch (e) {
      toast.error(say(e));
    }
  }

  /**
   * Làm gì: Xem lịch sử các phiên bản đã lưu của một giáo án (BR-48); nếu đang mở xem giáo án đó thì đóng lại.
   * Được gọi ở: coach-training.tsx (PlanPanel: nút "History" trên từng thẻ giáo án).
   * @param p Đối tượng PlanRow của giáo án cần xem lịch sử sửa đổi.
   * @returns Không trả về dữ liệu (Promise<void>).
   */
  async function showHistory(p: PlanRow) {
    // Nhấn lại vào cùng một giáo án đang mở lịch sử thì đóng panel lịch sử lại (toggle)
    if (history?.plan.id === p.id) {
      setHistory(null);
      return;
    }
    // Bước 2: Gọi API lấy danh sách các phiên bản cũ của giáo án và lưu vào state history để hiển thị
    try {
      const r = await apiGet<{ items: Version[] }>(`/training-plans/${p.id}/versions`);
      setHistory({ plan: p, items: r.items });
    } catch (e) {
      toast.error(say(e));
    }
  }

  /**
   * Làm gì: Sao chép toàn bộ giáo án các buổi tập từ tuần trước sang tuần này cho lớp học dưới dạng bản nháp (draft).
   * Được gọi ở: src/client/components/coach-training.tsx trong PlanPanel (nút "Copy plans from last week").
   * @returns Promise<void>
   */
  async function copyLastWeek() {
    try {
      // Bước 1: Gửi request nhân bản giáo án của tuần trước (tính từ thứ Hai tuần trước buổi tập) sang tuần này
      const r = await apiPost<{ copied: number; skipped: unknown[] }>(
        `/classes/${session.class_id}/plans/duplicate-week`,
        { from: lastWeekMonday(session.start_at) },
      );
      // Bước 2: Đếm số buổi bị bỏ qua và hiển thị thông báo chi tiết số giáo án đã sao chép cho huấn luyện viên
      const skipped = r.skipped.length;
      toast.success(
        r.copied
          ? skipped
            ? r.copied === 1
              ? t("Copied 1 plan as a draft, skipped {s}.", { s: skipped })
              : t("Copied {n} plans as drafts, skipped {s}.", { n: r.copied, s: skipped })
            : r.copied === 1
              ? t("Copied 1 plan as a draft.")
              : t("Copied {n} plans as drafts.", { n: r.copied })
          : skipped
            ? skipped === 1
              ? t("Nothing copied: 1 session already planned, past or missing.")
              : t("Nothing copied: {n} sessions already planned, past or missing.", { n: skipped })
            : t("Last week had no plans to copy."),
      );
      // Bước 3: Tải lại danh sách giáo án của lớp để cập nhật các bản nháp vừa tạo
      plansRead.reload();
    } catch (e) {
      toast.error(say(e));
    }
  }

  /**
   * Làm gì: Cập nhật thông tin chi tiết (thời lượng, tên bài, giai đoạn...) của một block bài tập theo chỉ số index.
   * Được gọi ở: src/client/components/coach-training.tsx trong PlanPanel (sự kiện onChange của các ô nhập liệu block).
   * @param i Vị trí index của block trong mảng blocks.
   * @param patch Đối tượng chứa các trường dữ liệu cần cập nhật của block.
   * @returns void
   */
  const setBlock = (i: number, patch: Partial<Block>) =>
    setBlocks((l) => l.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  /**
   * Làm gì: Hoán đổi vị trí của một block bài tập lên trên (-1) hoặc xuống dưới (+1) trong danh sách giáo án.
   * Được gọi ở: src/client/components/coach-training.tsx trong PlanPanel (nút Up/Down của từng block).
   * @param i Vị trí index hiện tại của block trong danh sách blocks.
   * @param by Hướng dịch chuyển (-1 là lên trên, 1 là xuống dưới).
   * @returns void
   */
  const move = (i: number, by: -1 | 1) =>
    setBlocks((l) => {
      const j = i + by;
      // Bỏ qua nếu vị trí mới vượt ngoài biên mảng (đã ở đầu hoặc cuối danh sách)
      if (j < 0 || j >= l.length) return l;
      // Tạo bản sao mảng và hoán đổi vị trí của hai block liền kề
      const next = [...l];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  return (
    <div>
      <SectionTitle text={t("Session plan")} className="font-display text-2xl" />
      <p className="mt-1 text-sm text-muted">
        {t("Plan this session block by block: what to do, how hard, with what, and what good looks like.")}{" "}
        {f5 ? `${t("The AI only suggests. You decide what students see.")} ` : ""}
        {t("Published plans appear under My progress for everyone in the class.")}
      </p>
      <Reveal>
        <Card className="mt-3 grid gap-4">
          {editing ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-hold/10 px-3 py-2 text-sm">
              <span>
                {editing.published
                  ? t("Editing “{title}”. Students will be told it changed and the old version is kept.", {
                      title: editing.title || t("plan"),
                    })
                  : t("Editing “{title}”.", { title: editing.title || t("plan") })}
              </span>
              <Button size="sm" variant="ghost" onClick={reset}>
                {t("Cancel edit")}
              </Button>
            </div>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t("Title")}>
              <Input maxLength={120} placeholder={t("Footwork and net play")} value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            {f5 ? (
              <div className="grid items-end gap-2">
                <Field label={t("Focus")}>
                  <Select value={focus} onChange={(e) => setFocus(e.target.value)}>
                    <option value="core technique">{t("Core technique")}</option>
                    <option value="conditioning">{t("Conditioning")}</option>
                    <option value="match play">{t("Match play")}</option>
                  </Select>
                </Field>
              </div>
            ) : null}
          </div>
          {f5 ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" disabled={suggesting} onClick={() => void suggest()}>
                {suggesting ? t("Thinking…") : t("Suggest for this session")}
              </Button>
              <Button variant="outline" disabled={suggesting || !!editing} onClick={() => void suggestCourse()}>
                {suggesting ? t("Thinking…") : t("Suggest for all sessions")}
              </Button>
              <span className="text-xs text-muted">{t("Uses your students' levels, goals, results and health notes. Names are not sent.")}</span>
            </div>
          ) : null}
          {f5 ? (
            <Field label={t("Tell the AI what you want (optional)")}>
              <textarea
                className="min-h-[72px] w-full rounded-md border border-line bg-transparent px-3 py-2 text-sm placeholder:text-muted/70 focus:border-accent focus:outline-none"
                maxLength={500}
                placeholder={t("e.g. 60 minutes, focus on footwork, one student has a sore knee, end with a game")}
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !suggesting) void suggest();
                }}
              />
            </Field>
          ) : null}

          {course?.length ? (
            <div className="grid gap-2 rounded-md border border-accent/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  {t("Course drafts to review ({n})", { n: course.length })}
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={!!courseBusy} onClick={() => void approveAll()}>
                    {t("Save all as drafts")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setCourse(null)}>
                    {t("Discard all")}
                  </Button>
                </div>
              </div>
              {course.map((d) => (
                <details key={d.session_id} className="rounded-md border border-line p-3">
                  <summary className="cursor-pointer text-sm">
                    <span className="font-medium">{formatDate(d.start_at)} · {hhmm(d.start_at)}</span>
                    {d.title ? ` · ${d.title}` : ""} · {blocksLabel(d.payload.blocks?.length ?? 0)}
                    {d.ai ? null : <Badge className="ml-2">{t("Standard drills")}</Badge>}
                  </summary>
                  <ol className="mt-2 grid gap-1 text-sm">
                    {(d.payload.blocks ?? []).map((bl, i) => (
                      <li key={i}>
                        <span className="text-muted">{i + 1}.</span> {bl.title} · {bl.minutes}′
                        {bl.phase ? ` · ${bl.phase}` : ""}{bl.intensity ? ` · ${bl.intensity}` : ""}
                        {bl.description ? <p className="text-xs text-muted">{bl.description}</p> : null}
                      </li>
                    ))}
                  </ol>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" disabled={courseBusy === d.session_id} onClick={() => void approveDraft(d, true)}>
                      {t("Approve and publish")}
                    </Button>
                    <Button size="sm" variant="outline" disabled={courseBusy === d.session_id} onClick={() => void approveDraft(d, false)}>
                      {t("Save draft")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => skipDraft(d)}>
                      {t("Skip")}
                    </Button>
                  </div>
                </details>
              ))}
            </div>
          ) : null}

          {templates.length && !editing ? (
            <div className="grid grid-cols-[1fr_auto] items-end gap-2 md:max-w-md">
              <Field label={t("Start from a template")}>
                <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                  <option value="">{t("Choose…")}</option>
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.title || t("Untitled template")} · {blocksLabel((tpl.payload.blocks ?? []).length)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button variant="outline" disabled={!templateId} onClick={() => void loadTemplate()}>
                {t("Use")}
              </Button>
            </div>
          ) : null}

          <div className="grid gap-2">
            {blocks.map((b, i) => (
              <div key={i} className="grid gap-2 rounded-md border border-line p-3">
                <div className="grid grid-cols-[1fr_5rem] gap-2 md:grid-cols-[1fr_8rem_7rem_5rem]">
                  <Input
                    aria-label={t("Block {n} title", { n: i + 1 })}
                    maxLength={120}
                    placeholder={t("Block {n}", { n: i + 1 })}
                    value={b.title}
                    onChange={(e) => setBlock(i, { title: e.target.value })}
                  />
                  <Input
                    aria-label={t("Block {n} minutes", { n: i + 1 })}
                    inputMode="numeric"
                    className="md:order-4"
                    value={b.minutes}
                    onChange={(e) => setBlock(i, { minutes: e.target.value })}
                  />
                  <Select
                    aria-label={t("Block {n} phase", { n: i + 1 })}
                    className="md:order-2"
                    value={b.phase}
                    onChange={(e) => setBlock(i, { phase: e.target.value })}
                  >
                    <option value="">{t("Phase")}</option>
                    {PHASES.map((p) => (
                      <option key={p} value={p}>
                        {t(p)}
                      </option>
                    ))}
                  </Select>
                  <Select
                    aria-label={t("Block {n} intensity", { n: i + 1 })}
                    className="md:order-3"
                    value={b.intensity}
                    onChange={(e) => setBlock(i, { intensity: e.target.value })}
                  >
                    <option value="">{t("Intensity")}</option>
                    {INTENSITIES.map((p) => (
                      <option key={p} value={p}>
                        {t(p)}
                      </option>
                    ))}
                  </Select>
                </div>
                {open[i] ? (
                  <div className="grid gap-2">
                    <Textarea
                      rows={2}
                      maxLength={600}
                      aria-label={t("Block {n} description", { n: i + 1 })}
                      placeholder={t("How it runs: drill set-up, reps, rotation…")}
                      value={b.description}
                      onChange={(e) => setBlock(i, { description: e.target.value })}
                    />
                    <div className="grid gap-2 md:grid-cols-2">
                      <Input
                        aria-label={t("Block {n} equipment", { n: i + 1 })}
                        maxLength={200}
                        placeholder={t("Equipment: shuttles, cones, ladder…")}
                        value={b.equipment}
                        onChange={(e) => setBlock(i, { equipment: e.target.value })}
                      />
                      <Input
                        aria-label={t("Block {n} target", { n: i + 1 })}
                        maxLength={200}
                        placeholder={t("Target: 8 of 10 clears past the line…")}
                        value={b.target}
                        onChange={(e) => setBlock(i, { target: e.target.value })}
                      />
                    </div>
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setOpen((o) => ({ ...o, [i]: !o[i] }))}>
                    {open[i] ? t("Hide details") : t("Details")}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t("Move block {n} up", { n: i + 1 })}>
                    {t("Up")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={i === blocks.length - 1}
                    onClick={() => move(i, 1)}
                    aria-label={t("Move block {n} down", { n: i + 1 })}
                  >
                    {t("Down")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={blocks.length === 1}
                    onClick={() => setBlocks((l) => l.filter((_, j) => j !== i))}
                  >
                    {t("Remove")}
                  </Button>
                </div>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" size="sm" disabled={blocks.length >= MAX_BLOCKS} onClick={() => setBlocks((l) => [...l, blank()])}>
                {t("Add block")}
              </Button>
              <span className="text-xs text-muted">
                {t("{n} of {max} blocks · {min} min in total", { n: blocks.length, max: MAX_BLOCKS, min: planMinutes(blocks) })}
              </span>
              {sessionMinutes && Math.abs(planMinutes(blocks) - sessionMinutes) > 15 ? (
                <span className="text-xs text-hold">
                  {t("The session is {m} min. You can still publish.", { m: sessionMinutes })}
                </span>
              ) : null}
            </div>
          </div>

          <Field label={t("Note for students")}>
            <Input maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>

          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || session.status === "cancelled"} onClick={() => submit(true)}>
              {editing ? t("Save and publish") : t("Publish to the class")}
            </Button>
            <Button variant="outline" disabled={busy || session.status === "cancelled"} onClick={() => submit(false)}>
              {t("Save as draft")}
            </Button>
            {!editing ? (
              <Button variant="ghost" onClick={copyLastWeek}>
                {t("Copy plans from last week")}
              </Button>
            ) : null}
          </div>
        </Card>
      </Reveal>

      <div className="mt-4 grid gap-2">
        {plansRead.error ? (
          <LoadError
            message={plansRead.error.message}
            onRetry={plansRead.error.refused ? undefined : plansRead.reload}
          />
        ) : !plans ? (
          <Skeleton className="h-16" />
        ) : !plans.length ? (
          <EmptyState title={t("No plans for this class yet")} hint={t("Build one above, or copy last week's.")} />
        ) : (
          plans.map((p) => (
            <Card key={p.id} className="grid gap-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{p.title || (p.payload.blocks?.[0]?.title ?? t("Plan"))}</p>
                  <p className="text-xs text-muted">
                    {p.session_start ? `${sessionDay(p.session_start)} · ${hhmm(p.session_start)}` : t("Whole class")} ·{" "}
                    {blocksLabel((p.payload.blocks ?? []).length)} ·{" "}
                    {t("{n} min", { n: (p.payload.blocks ?? []).reduce((n, b) => n + b.minutes, 0) })}
                    {p.version && p.version > 1 ? ` · v${p.version}` : ""}
                    {p.source === "ai" ? ` · ${t("AI draft")}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={p.published ? "accent" : "muted"}>{p.published ? t("Published") : t("Draft")}</Badge>
                  <Button size="sm" variant="outline" onClick={() => edit(p)}>
                    {t("Edit")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => toggle(p)}>
                    {p.published ? t("Unpublish") : t("Publish")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void saveTemplate(p)}>
                    {t("Save as template")}
                  </Button>
                  {p.version && p.version > 1 ? (
                    <Button size="sm" variant="ghost" onClick={() => void showHistory(p)}>
                      {history?.plan.id === p.id ? t("Hide history") : t("History")}
                    </Button>
                  ) : null}
                </div>
              </div>
              {history?.plan.id === p.id ? (
                <ul className="grid gap-1 border-t border-line pt-2 text-xs text-muted">
                  {history.items.map((v) => (
                    <li key={v.version}>
                      v{v.version} · {formatDate(v.created_at)} · {blocksLabel((v.payload.blocks ?? []).length)},{" "}
                      {t("{n} min", { n: (v.payload.blocks ?? []).reduce((n, b) => n + b.minutes, 0) })}
                      {v.title ? ` · ${v.title}` : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Homework (FR-TRN-07)                                                 *
 * ------------------------------------------------------------------ */

// Kiểu dữ liệu đại diện cho một bài tập về nhà của lớp: tiêu đề, hạn nộp, checklist và tiến độ hoàn thành
type HwRow = {
  id: string;
  title: string;
  due_on: string | null;
  checklist: string[];
  recipients: number;
  completed: number;
  student_name: string | null;
};

/**
 * Làm gì: Hiển thị bảng điều khiển bài tập về nhà (FR-TRN-07) của lớp học, cho phép HLV tạo bài tập kèm checklist và theo dõi tiến độ nộp bài của học viên.
 * Được gọi ở: src/routes/coach.attendance.tsx trong component Page (khi HLV chọn tab "homework").
 * @param classId Mã định danh (UUID) của lớp học cần quản lý bài tập về nhà.
 * @returns Giao diện form tạo bài tập và danh sách bài tập đã giao của lớp học.
 */
export function HomeworkPanel({ classId }: { classId: string }) {
  // Tải danh sách bài tập về nhà của lớp theo classId từ API /homework
  const { data, error, reload } = useRead<{ items: HwRow[] }>(`/homework?class_id=${classId}`);
  const items = data?.items ?? null;
  // Các state lưu trữ dữ liệu form giao bài tập mới (tiêu đề, mô tả, checklist, hạn chót và cờ busy)
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [lines, setLines] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);

  /**
   * Làm gì: Tạo và giao bài tập về nhà cho toàn bộ học viên trong lớp qua API POST /homework, sau đó xóa form và tải lại danh sách.
   * Được gọi ở: src/client/components/coach-training.tsx trong HomeworkPanel (nút "Assign to the class").
   * @returns Promise<void>
   */
  async function assign() {
    // Bước 1: Khóa form bằng cờ busy để ngăn chặn bấm gửi trùng lặp (double submit)
    setBusy(true);
    try {
      // Bước 2: Tách từng dòng checklist, loại bỏ khoảng trắng và dòng trống rồi gọi API tạo bài tập
      const r = await apiPost<{ recipients: number }>("/homework", {
        class_id: classId,
        title,
        body,
        due_on: due || null,
        checklist: lines
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      });
      // Bước 3: Thông báo số lượng học sinh được giao bài tập thành công
      toast.success(
        r.recipients === 1 ? t("Homework sent to 1 student") : t("Homework sent to {n} students", { n: r.recipients }),
      );
      // Bước 4: Reset form về trạng thái ban đầu và tải lại danh sách bài tập từ server
      setTitle("");
      setBody("");
      setLines("");
      setDue("");
      reload();
    } catch (e) {
      toast.error(say(e));
    } finally {
      // Bước 5: Luôn mở lại khóa form sau khi hoàn tất hoặc gặp lỗi
      setBusy(false);
    }
  }

  return (
    <div>
      <SectionTitle text={t("Homework")} className="font-display text-2xl" />
      <p className="mt-1 text-sm text-muted">{t("Something to practise before the next class. Students tick items off as they go.")}</p>
      <Card className="mt-3 grid gap-3">
        <div className="grid gap-3 md:grid-cols-[1fr_12rem]">
          <Field label={t("Title")}>
            <Input maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label={t("Due")}>
            <DateField aria-label={t("Due date")} value={due} onChange={setDue} />
          </Field>
        </div>
        <Field label={t("Description")}>
          <Textarea rows={2} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <Field label={t("Checklist")} hint={t("One item per line, up to 20.")} tone="muted">
          <Textarea rows={3} value={lines} onChange={(e) => setLines(e.target.value)} placeholder={`${t("50 wall shots")}\n${t("10 minutes of footwork")}`} />
        </Field>
        <div>
          <Button onClick={assign} disabled={busy || !title.trim()}>
            {t("Assign to the class")}
          </Button>
        </div>
      </Card>
      <div className="mt-3 grid gap-2">
        {error ? (
          <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
        ) : !items ? (
          <Skeleton className="h-16" />
        ) : items.length === 0 ? (
          <EmptyState title={t("No homework assigned.")} />
        ) : (
          items.map((h) => (
            <Card key={h.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-medium">{h.title}</p>
                <p className="text-xs text-muted">
                  {h.due_on ? t("Due {date}", { date: formatDate(h.due_on) }) : t("No due date")} ·{" "}
                  {h.checklist.length === 1 ? t("1 item") : t("{n} items", { n: h.checklist.length })}
                </p>
              </div>
              <Badge tone={h.completed === h.recipients ? "accent" : "muted"}>
                {t("{done}/{total} done", { done: h.completed, total: h.recipients })}
              </Badge>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
