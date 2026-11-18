/**
 * File: src/client/components/register-panel.tsx
 * Vai trò: Bảng điểm danh của một buổi học, dùng chung cho HLV (/coach/attendance) và quản lý (/manager/attendance).
 * Quản lý được sửa cả sổ đã khóa (BR-35), kèm lý do lưu vào nhật ký.
 */
import { Link } from "@tanstack/react-router";
import { Check, Clock, FileCheck2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckDraw } from "@/client/components/arena-icons";
import { sessionDay } from "@/client/components/class-detail";
import { hhmm } from "@/client/components/shell";
import { UserAvatar } from "@/client/components/user-avatar";
import { Button, Card, Field, Input, LoadError, Skeleton } from "@/client/components/ui";
import { apiPost } from "@/client/arena3/client";
import { cn } from "@/client/lib/cn";
import { t, tServer, tk, tData } from "@/client/lib/i18n";
import type { ReadError } from "@/client/lib/use-read";
import type { CoachSession } from "@/routes/coach.index.tsx";

export type SessionRow = CoachSession;

type AttRow = {
  id: string;
  full_name: string;
  member_code: string | null;
  health_notes: string | null;
  result: string | null;
  avatar_url?: string | null;
};

type AttMeta = { locked: boolean; lock_at: string | null; status: string };

/** What the register read brings back: the roll, and (attendance on) whether the register has closed. */
export type RegisterData = { items: AttRow[]; session?: AttMeta };

// Colour and icon say the answer before the word does: green tick, amber clock, red cross, grey note.
const RESULTS = [
  {
    v: "present",
    l: tk("Present"),
    Icon: Check,
    on: "border-green-800 bg-green-700 text-white",
    off: "border-green-300 bg-green-50 text-green-800 hover:bg-green-100",
    dot: "bg-green-700",
  },
  {
    v: "late",
    l: tk("Late"),
    Icon: Clock,
    on: "border-amber-600 bg-amber-400 text-black",
    off: "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100",
    dot: "bg-amber-400",
  },
  {
    v: "absent",
    l: tk("Absent"),
    Icon: X,
    on: "border-red-700 bg-red-600 text-white",
    off: "border-red-300 bg-red-50 text-red-800 hover:bg-red-100",
    dot: "bg-red-600",
  },
  {
    v: "excused",
    l: tk("Excused"),
    Icon: FileCheck2,
    on: "border-earth bg-earth text-earth-fg",
    off: "border-earth/40 bg-wood text-earth hover:bg-wood/80",
    dot: "bg-earth",
  },
];

/**
 * Làm gì: Component bảng điểm danh chi tiết của buổi học; hiển thị danh sách học viên, hỗ trợ chấm điểm danh (có mặt, đi muộn, vắng mặt, có phép), xem ghi chú sức khỏe và lưu kết quả lên server (kèm lý do điều chỉnh nếu đã khóa).
 * Được gọi ở: src/routes/coach.attendance.tsx trong component Page (khi tab hiện tại là "register").
 * @param session Thông tin buổi học đang chọn (id, sport, level, court_code, status, start_at, v.v.)
 * @param f4 Cờ tính năng (Feature flag F4) bật hoặc tắt chức năng điểm danh
 * @param read Đối tượng trạng thái đọc dữ liệu từ useRead (gồm danh sách học viên items, session meta, lỗi và hàm reload)
 * @param isManager Quyền hạn của người dùng hiện tại có phải là Manager hay không (xác định quyền sửa điểm danh khi đã bị khóa theo BR-35)
 * @returns JSX.Element giao diện bảng điểm danh học viên, thanh thống kê sĩ số và nút lưu
 */
export function RegisterPanel({
  session,
  f4,
  read,
  isManager,
  studentLinks = true,
}: {
  session: SessionRow;
  f4: boolean;
  read: { data: RegisterData | null; error: ReadError | null; reload: () => void };
  isManager: boolean;
  /** The student's coach profile only opens from the coach's own screen. */
  studentLinks?: boolean;
}) {
  // Bước 1: Khởi tạo state lưu các thay đổi điểm danh cục bộ (edits), lý do chỉnh sửa khi bị khóa (reason), trạng thái lưu (saving) và cờ hiển thị phản hồi đã lưu (justSaved).
  // Only what the coach changed; every other student shows what the server holds. A roll that has
  // not been marked yet starts with everyone present, as it always did.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const savingRef = useRef(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Dọn dẹp timer đếm ngược hiệu ứng 'Saved' khi component unmount để tránh rò rỉ bộ nhớ (memory leak).
  useEffect(() => () => clearTimeout(savedTimer.current), []);

  // Bước 2: Xử lý khi tải dữ liệu điểm danh gặp lỗi; cho phép HLV bấm thử lại nếu không bị máy chủ từ chối quyền truy cập (refused).
  if (read.error) {
    return (
      <LoadError
        message={read.error.message}
        onRetry={read.error.refused ? undefined : read.reload}
      />
    );
  }
  // Hiển thị khung chờ (Skeleton) trong khi chờ API trả về dữ liệu danh sách điểm danh.
  if (!read.data) return <Skeleton className="h-40" />;

  // Bước 3: Lấy danh sách học viên, kiểm tra quy tắc nghiệp vụ BR-35 (phiên bị khóa chỉ Manager mới được sửa) và xác định trạng thái chỉ đọc (readOnly).
  const rows = read.data.items;
  const meta = read.data.session ?? null;
  const locked = !!meta?.locked;
  const blocked = locked && !isManager;
  const cancelled = session.status === "cancelled" || meta?.status === "cancelled";
  // Nothing to mark: attendance is off, the session was cancelled, or the register has closed.
  const readOnly = !f4 || blocked || cancelled;
  /**
   * Làm gì: Xác định trạng thái điểm danh hiển thị của từng học viên: ưu tiên chỉnh sửa tạm thời của HLV, sau đó đến kết quả lưu trên server, mặc định ban đầu là 'present'.
   * Được gọi ở: RegisterPanel (tính số lượng học viên theo từng loại, hiển thị nút bấm trạng thái và chuẩn bị dữ liệu gửi lên API).
   * @param u Đối tượng thông tin học viên trong danh sách điểm danh
   * @returns Trạng thái điểm danh ('present' | 'late' | 'absent' | 'excused')
   */
  const mark = (u: AttRow) => edits[u.id] ?? u.result ?? "present";

  // Nếu buổi học chưa có học viên nào đăng ký, hiển thị thông báo không có danh sách điểm danh.
  if (!rows.length) {
    return (
      <p className="text-sm text-muted">
        {t("Nobody is enrolled in this session yet, so there is no register to take.")}
      </p>
    );
  }

  /**
   * Làm gì: Gửi kết quả điểm danh của toàn bộ học viên lên server qua API POST /sessions/:id/attendance; nếu phiên đã bị khóa thì gửi kèm lý do điều chỉnh theo quy tắc BR-35.
   * Được gọi ở: RegisterPanel khi HLV hoặc Manager nhấn nút lưu điểm danh ('Save register' hoặc 'Save correction').
   * @returns Promise<void>
   */
  async function save() {
    // Bước 1: Kiểm tra cờ savingRef để ngăn chặn gọi API trùng lặp khi người dùng bấm lưu liên tục (double-submit).
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      // Bước 2: Gọi API POST /sessions/:id/attendance gửi mảng kết quả điểm danh; nếu phiên đã bị khóa (locked) thì gửi kèm lý do điều chỉnh (reason).
      await apiPost(
        `/sessions/${session.id}/attendance`,
        {
          items: rows.map((u) => ({ user_id: u.id, result: mark(u) })),
          ...(locked ? { reason } : {}),
        },
      );
      // Bước 3: Thông báo lưu thành công, xóa trường lý do, kích hoạt icon hoàn tất CheckDraw và yêu cầu tải lại dữ liệu điểm danh mới nhất.
      toast.success(locked ? t("Register corrected") : t("Register saved"));
      setReason("");
      setJustSaved(true);
      clearTimeout(savedTimer.current);
      // Duy trì trạng thái vừa lưu trong 2200ms để người dùng kịp nhìn thấy animation CheckDraw hoàn tất trước khi nút trở về bình thường.
      savedTimer.current = setTimeout(() => setJustSaved(false), 2200);
      // The marks stay as they are: they are what the server now holds, so nothing flickers while
      // the fresh copy comes back.
      read.reload();
    // Bước 4: Bắt lỗi nếu gọi API thất bại, lưu thông báo lỗi để hiển thị ngay cạnh nút bấm mà vẫn giữ nguyên các lựa chọn điểm danh của HLV.
    } catch (e) {
      // Said next to the button, where the coach is looking, and the marks are kept so nothing is lost.
      setSaveError(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      // Bước 5: Đặt lại cờ savingRef và tắt trạng thái saving sau khi hoàn tất tiến trình lưu.
      savingRef.current = false;
      setSaving(false);
    }
  }

  // Bước 6: Render giao diện gồm cảnh báo (nếu cờ F4 tắt, buổi học bị hủy hoặc bị khóa), thanh tóm tắt số lượng, danh sách học viên, ô nhập lý do và nút lưu.
  return (
    <div>
      {!f4 ? (
        <p className="mb-3 rounded-[var(--radius-md)] bg-hold/10 px-3 py-2 text-sm">
          {t("Attendance is switched off (flag F4)")}
        </p>
      ) : null}
      {cancelled ? (
        <p className="mb-3 rounded-[var(--radius-md)] bg-hold/10 px-3 py-2 text-sm">
          {t("This session was cancelled, so there is nothing to record.")}
        </p>
      ) : null}
      {locked ? (
        <p className="mb-3 rounded-[var(--radius-md)] bg-hold/10 px-3 py-2 text-sm">
          {meta?.lock_at
            ? t("This register closed {day} at {time}.", {
                day: sessionDay(meta.lock_at),
                time: hhmm(meta.lock_at),
              })
            : t("This register closed after the session.")}{" "}
          {isManager
            ? t("You can still correct it: say why below.")
            : t("Ask a manager to correct it.")}
        </p>
      ) : null}
      {f4 ? (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p
            className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm tabular-nums"
            aria-live="polite"
          >
            {RESULTS.map((r) => (
              <span key={r.v} className="inline-flex items-center gap-1.5">
                <span aria-hidden className={cn("size-2.5 rounded-full", r.dot)} />
                {t(r.l)} <b>{rows.filter((u) => mark(u) === r.v).length}</b>
              </span>
            ))}
            <span className="text-muted">{t("of {n}", { n: rows.length })}</span>
          </p>
          {!readOnly ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEdits(Object.fromEntries(rows.map((u) => [u.id, "present"])))}
            >
              {t("Mark everyone present")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <Card className="overflow-hidden p-0">
        <ul className="divide-y divide-line">
          {rows.map((u) => (
            <li
              key={u.id}
              className={cn(
                "grid gap-2 px-4 py-3",
                f4 && "sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4",
              )}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="size-8 shrink-0">
                  <UserAvatar name={u.full_name} url={u.avatar_url} />
                </div>
                <div className="min-w-0">
                  <p className="font-medium">
                    {f4 && studentLinks ? (
                      <Link
                        to="/coach/student/$id"
                        params={{ id: u.id }}
                        className="tap underline-offset-4 hover:underline"
                      >
                        {u.full_name}
                      </Link>
                    ) : (
                      u.full_name
                    )}
                    <span className="ml-2 text-xs font-normal text-muted">{u.member_code}</span>
                  </p>
                  {u.health_notes ? (
                    <p className="mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm text-danger">
                      {tData(u.health_notes)}
                    </p>
                  ) : null}
                </div>
              </div>
              {f4 ? (
                // Named after the student, so a screen reader hears whose "Present" it is on.
                <div role="group" aria-label={u.full_name} className="grid grid-cols-4 gap-1 sm:w-[26rem]">
                  {RESULTS.map((r) => {
                    const on = mark(u) === r.v;
                    return (
                      <button
                        key={r.v}
                        type="button"
                        disabled={readOnly}
                        aria-pressed={on}
                        onClick={() => setEdits((m) => ({ ...m, [u.id]: r.v }))}
                        className={cn(
                          "inline-flex min-h-11 items-center justify-center gap-1 rounded-[var(--radius-sm)] border px-1 text-xs transition-colors duration-150 active:scale-95 disabled:opacity-60",
                          on ? cn(r.on, "font-bold shadow-sm") : cn(r.off, "font-medium"),
                        )}
                      >
                        <r.Icon
                          aria-hidden
                          className={cn("hidden size-3.5 shrink-0 sm:block", on && "ai-pop")}
                        />
                        <span className="truncate">{t(r.l)}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
      {locked && isManager ? (
        <div className="mt-3 max-w-md">
          <Field label={t("Reason for the correction")}>
            <Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      ) : null}
      {f4 ? (
        <div className="mt-4">
          <Button
            size="lg"
            className="w-full"
            disabled={readOnly || saving || (locked && reason.trim().length < 3)}
            onClick={save}
          >
            {justSaved ? <CheckDraw key="saved" className="size-5" /> : null}
            {justSaved ? t("Saved") : locked ? t("Save correction") : t("Save register")}
          </Button>
          {saveError ? (
            <p role="alert" className="mt-2 text-sm text-danger">
              {saveError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
