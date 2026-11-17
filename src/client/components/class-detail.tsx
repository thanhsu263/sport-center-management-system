/**
 * File: src/client/components/class-detail.tsx
 * Vai trò: Cung cấp modal chi tiết lớp học (ClassDetailModal), form quản lý lớp học (ActionForm) và modal chi tiết ca chiếm sân (OccupancyDetailModal).
 * Vị trí trong app: Được nhúng vào các màn hình quản lý lớp học (manager.classes.tsx), lịch sân lễ tân (desk.courts.tsx), danh sách lớp lễ tân (desk.classes.tsx) và lịch dạy HLV (coach.classes.tsx).
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { Badge, Button, Field, Input, LoadError, Modal, Select, Skeleton, StatusBadge, Textarea } from "@/client/components/ui";
import { hhmm, initials, money, useSessionUser, when } from "@/client/components/shell";
import { UserAvatar } from "@/client/components/user-avatar";
import { MinSizeBadge } from "@/client/components/class-extras";
import { Cover } from "@/client/components/media";
import { apiPatch, apiPost } from "@/client/arena3/client";
import { formatDate, kindLabel, levelLabel, rruleLabel, sportLabel } from "@/shared/arena3/labels";
import { scrollBehavior } from "@/client/lib/calm";
import { locale, t, tk, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";
import { HighlightBadge, useLive } from "@/client/lib/use-live";

/** "Tue 21 Oct" in the centre's timezone. */
/**
 * Làm gì: Chuyển đổi chuỗi thời gian ISO thành chuỗi thứ và ngày tháng ngắn gọn (ví dụ: 'Tue 21 Oct' hoặc 'Th 3, 21 thg 10') theo múi giờ trung tâm 'Asia/Ho_Chi_Minh' và ngôn ngữ hiện tại của người dùng.
 * Được gọi ở:
 *   - src/client/components/class-detail.tsx (danh sách buổi học và nhãn dời lịch)
 *   - src/client/components/coach-training.tsx (lịch tập của HLV)
 *   - src/routes/app.train.tsx (màn hình lịch tập hội viên)
 *   - src/routes/coach.attendance.tsx, src/routes/coach.index.tsx (màn hình điểm danh và trang chủ HLV)
 * @param iso Chuỗi thời gian chuẩn ISO của ca học hoặc buổi tập.
 * @returns Chuỗi hiển thị thứ, ngày và tháng đã được định dạng theo locale.
 */
export function sessionDay(iso: string) {
  return new Date(iso).toLocaleDateString(locale(), {
    timeZone: "Asia/Ho_Chi_Minh",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

type ClassDetail = {
  class: {
    id: string;
    code: string;
    sport: string;
    level: string;
    status: string;
    capacity: number;
    price_vnd?: number | null;
    min_enrolled?: number | null;
    description?: string | null;
    syllabus?: string | null;
    who_for?: string | null;
    bring?: string | null;
    enrolled_count: number;
    rrule: string;
    duration_min: number;
    start_on: string;
    end_on: string;
    court_code: string;
    coach_id: string;
    coach_name: string;
    assistant_name: string | null;
  };
  sessions: Array<{
    id: string;
    start_at: string;
    end_at: string;
    status: string;
    court_code: string;
    headcount: number;
  }>;
  roster: Array<{
    id: string;
    full_name: string;
    member_code: string | null;
    phone: string;
    status: string;
    waitlist_pos?: number | null;
    offer_pending?: boolean;
    offer_expires_at?: string | null;
    avatar_url?: string | null;
  }>;
};

/** What the manager is in the middle of doing to the class. */
type Action =
  | { kind: "cancel-session" | "move-session"; sessionId: string; label: string; startAt: string }
  | { kind: "coach" | "capacity" | "price" | "about" | "cancel-class" };

/** A `datetime-local` value is the centre's wall clock, which is always UTC+7. */
const toIctIso = (local: string) => `${local}:00+07:00`;
/**
 * Làm gì: Chuyển đổi chuỗi thời gian ISO sang định dạng 'YYYY-MM-DDTHH:mm' cho ô nhập <input type="datetime-local"> theo múi giờ Việt Nam (UTC+7).
 * Được gọi ở: src/client/components/class-detail.tsx (ActionForm khi chọn dời lịch buổi học).
 * @param iso Chuỗi thời gian chuẩn ISO UTC.
 * @returns Chuỗi 16 ký tự dạng 'YYYY-MM-DDTHH:mm' theo giờ địa phương Việt Nam.
 */
const toLocalInput = (iso: string) => new Date(new Date(iso).getTime() + 7 * 3600000).toISOString().slice(0, 16);

/**
 * One class opened up: when it meets, where, who teaches it and who is in it.
 * Shared by the manager's class list and the desk, which see the same thing.
 * With `manage` (the manager only) it also cancels or moves a session, changes
 * the coach, edits the capacity or cancels the class.
 */
/**
 * Làm gì: Modal hiển thị toàn bộ thông tin chi tiết của một lớp học (thời gian, sân tập, huấn luyện viên, danh sách buổi học, học viên đã đăng ký và danh sách chờ). Nếu bật cờ `manage`, quản lý có thể thao tác hủy/dời buổi học, đổi HLV, sửa sức chứa, giá tiền, mô tả hoặc hủy toàn bộ lớp.
 * Được gọi ở:
 *   - src/routes/manager.classes.tsx: màn hình quản lý lớp học (quản lý xem và chỉnh sửa lớp)
 *   - src/routes/desk.classes.tsx: màn hình danh sách lớp học ở quầy lễ tân
 *   - src/routes/desk.courts.tsx: màn hình sơ đồ sân lễ tân (bấm xem lớp đang chiếm sân)
 *   - src/routes/coach.classes.tsx: màn hình lớp học của huấn luyện viên
 * @param classId ID của lớp học cần hiển thị; null khi đóng modal.
 * @param onClose Hàm callback kích hoạt khi người dùng bấm đóng modal.
 * @param manage Cờ bật các tính năng quản lý lớp (hủy buổi, dời lịch, đổi HLV, đổi giá, đổi sức chứa, hủy lớp); chỉ dành cho Manager. Mặc định là false.
 * @param onChanged Hàm callback gọi sau khi thực hiện thao tác quản lý thành công để component cha tải lại dữ liệu.
 * @returns Modal giao diện chi tiết lớp học.
 */
export function ClassDetailModal({
  classId,
  onClose,
  manage = false,
  onChanged,
}: {
  classId: string | null;
  onClose: () => void;
  manage?: boolean;
  onChanged?: () => void;
}) {
  // Bước 1: Tải chi tiết lớp học qua API /classes/:id và đăng ký nhận sự kiện realtime (SSE) qua useLive để tự động đồng bộ khi có thay đổi.
  const { data, error, reload } = useRead<ClassDetail>(classId ? `/classes/${classId}` : null);
  useLive(classId ? `class:${classId}` : null, reload);
  useLive("classes", reload);
  const [action, setAction] = useState<Action | null>(null);

  // Another class never starts with a half-filled form from the last one.
  useEffect(() => {
    setAction(null);
  }, [classId]);

  // Xử lý sau khi hoàn tất một hành động quản lý: đóng form thao tác, nạp lại chi tiết lớp và thông báo cho component cha.
  const changed = useCallback(() => {
    setAction(null);
    reload();
    onChanged?.();
  }, [onChanged, reload]);

  const navigate = useNavigate();
  const user = useSessionUser();
  const [messagingCoach, setMessagingCoach] = useState(false);

  /**
   * Làm gì: Mở cuộc hội thoại chat trực tiếp với huấn luyện viên của lớp qua API POST /conversations, sau đó đóng modal và chuyển hướng tới màn hình chat.
   * Được gọi ở: ClassDetailModal (nút 'Message coach' cạnh thông tin HLV).
   * @returns Không trả về giá trị (Promise<void>).
   */
  async function handleMessageCoach() {
    // Chặn gọi trùng lặp khi đang xử lý (messagingCoach) hoặc khi lớp chưa có coach_id.
    if (!c?.coach_id || messagingCoach) return;
    setMessagingCoach(true);
    try {
      // Bước 1: Tạo hoặc lấy cuộc trò chuyện hiện có với HLV qua API /conversations.
      const res = await apiPost<{ conversation: { id: string } }>("/conversations", { recipient_id: c.coach_id });
      // Bước 2: Đóng modal chi tiết lớp và chuyển hướng sang trang chat với ID cuộc trò chuyện vừa lấy.
      onClose();
      navigate({ to: "/chat", search: { conv: res.conversation.id } });
    } catch (e: any) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Cannot message this coach"));
    } finally {
      setMessagingCoach(false);
    }
  }

  // Bước 2: Phân loại dữ liệu hiển thị: tách học viên chính thức (confirmed) và danh sách chờ (waitlisted); tách ca học sắp tới (scheduled) và ca học đã qua/đã hủy.
  const c = data?.class;
  const confirmed = data?.roster.filter((r) => r.status === "confirmed") ?? [];
  const waiting = data?.roster.filter((r) => r.status === "waitlisted") ?? [];
  const upcoming = data?.sessions.filter((s) => s.status === "scheduled") ?? [];
  const past = data?.sessions.filter((s) => s.status !== "scheduled") ?? [];

  // Bước 3: Render giao diện modal gồm thông tin chung lớp học, các ca học, danh sách học viên và khu vực thao tác dành cho quản lý (nếu có quyền manage).
  return (
    <Modal
      open={!!classId}
      onClose={onClose}
      title={c ? `${sportLabel(c.sport)} · ${levelLabel(c.level)}` : t("Class")}
      footer={
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {t("Close")}
          </Button>
        </div>
      }
    >
      {error ? (
        <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
      ) : !c || !data ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="grid gap-5">
          <div className="flex items-center gap-3">
            <Cover
              slot={"coach." + c.coach_id}
              fallbackInitials={initials(c.coach_name)}
              className="size-12 shrink-0 rounded-full border border-line"
              initialsClassName="text-sm font-bold"
              alt={c.coach_name}
            />
            <div className="min-w-0 flex-1 grid gap-1 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium tabular-nums">{c.code}</span>
                <StatusBadge status={c.status} />
                <Badge tone="muted">
                  <HighlightBadge value={c.enrolled_count}>
                    {t("{n}/{cap} enrolled", { n: c.enrolled_count, cap: c.capacity })}
                  </HighlightBadge>
                </Badge>
                <MinSizeBadge enrolled={c.enrolled_count} min={c.min_enrolled} status={c.status} />
              </div>
              <p className="text-muted">
                {t("Coach {name}", { name: c.coach_name })}
                {c.assistant_name ? ` · ${t("assisted by {name}", { name: c.assistant_name })}` : ""} · {c.court_code}
              </p>
              <p className="text-muted">
                {rruleLabel(c.rrule, c.duration_min)} · {formatDate(c.start_on)} - {formatDate(c.end_on)}
              </p>
            </div>
            {c.coach_id && user && user.id !== c.coach_id ? (
              <Button
                size="sm"
                variant="outline"
                disabled={messagingCoach}
                onClick={() => void handleMessageCoach()}
                className="shrink-0 flex items-center gap-1.5"
              >
                <MessageSquare className="size-4" />
                <span>{t("Message coach")}</span>
              </Button>
            ) : null}
          </div>

          <section>
            <h3 className="text-2xs font-medium text-muted">
              {t("Sessions · {n} to come", { n: upcoming.length })}
            </h3>
            {data.sessions.length ? (
              <ul className="mt-2 grid max-h-56 gap-1 overflow-y-auto text-sm">
                {[...upcoming, ...past].map((s) => (
                  <li
                    key={s.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] bg-wood/60 px-3 py-2"
                  >
                    <span className="tabular-nums">
                      {sessionDay(s.start_at)} · {hhmm(s.start_at)}-{hhmm(s.end_at)}
                    </span>
                    <span className="flex items-center gap-2 text-muted">
                      {s.court_code} · <span className="tabular-nums">{s.headcount}</span>/{c.capacity}
                      {s.status !== "scheduled" ? <StatusBadge status={s.status} /> : null}
                      {manage && s.status === "scheduled" && new Date(s.start_at) > new Date() && c.status !== "cancelled" ? (
                        <>
                          {(["move-session", "cancel-session"] as const).map((kind) => (
                            <Button
                              key={kind}
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setAction({
                                  kind,
                                  sessionId: s.id,
                                  startAt: s.start_at,
                                  label: `${sessionDay(s.start_at)} · ${hhmm(s.start_at)}`,
                                })
                              }
                            >
                              {kind === "move-session" ? t("Move") : t("Cancel")}
                            </Button>
                          ))}
                        </>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted">
                {c.status === "draft"
                  ? t("No sessions yet. They are created when the class is published.")
                  : t("No sessions on the calendar.")}
              </p>
            )}
          </section>

          <section>
            <h3 className="text-2xs font-medium text-muted">
              {t("Students · {n}", { n: confirmed.length })}
            </h3>
            {confirmed.length ? (
              <ul className="mt-2 grid max-h-48 gap-1 overflow-y-auto text-sm">
                {confirmed.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-1">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="size-8 shrink-0">
                        <UserAvatar name={r.full_name} url={r.avatar_url} />
                      </div>
                      <span className="font-medium">{r.full_name}</span>
                    </div>
                    <span className="tabular-nums text-muted">
                      {r.member_code ?? "-"} · {r.phone}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted">{t("Nobody has enrolled yet.")}</p>
            )}
            {waiting.length ? (
              <div className="mt-3 border-t border-line/60 pt-2.5">
                <h4 className="text-2xs font-medium text-muted">
                  {t("Waiting list · {n}", { n: waiting.length })}
                </h4>
                <ul className="mt-1.5 grid max-h-36 gap-1 overflow-y-auto text-sm">
                  {waiting.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="tabular-nums text-muted text-xs">#{r.waitlist_pos ?? "-"}</span>
                        <div className="size-8 shrink-0">
                          <UserAvatar name={r.full_name} url={r.avatar_url} />
                        </div>
                        <span className="font-medium">{r.full_name}</span>
                      </div>
                      <span className="flex items-center gap-2">
                        {r.offer_pending && r.offer_expires_at ? (
                          <Badge tone="accent" className="text-2xs">
                            {t("Offer sent, expires {time}", { time: hhmm(r.offer_expires_at) })}
                          </Badge>
                        ) : null}
                        <span className="tabular-nums text-muted">
                          {r.member_code ?? "-"} · {r.phone}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>

          {manage && c.status !== "cancelled" ? (
            <section className="grid gap-3 border-t border-line pt-4">
              <h3 className="text-2xs font-medium text-muted">{t("Manage this class")}</h3>
              {action ? (
                <ActionForm classData={c} action={action} onDone={changed} onBack={() => setAction(null)} />
              ) : (
                <div className="flex flex-wrap gap-2">
                  {c.status !== "draft" ? (
                    <>
                      <Button size="sm" variant="outline" onClick={() => setAction({ kind: "coach" })}>
                        {t("Change coach")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setAction({ kind: "capacity" })}>
                        {t("Edit capacity")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setAction({ kind: "price" })}>
                        {t("Edit price")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setAction({ kind: "about" })}>
                        {t("Edit description")}
                      </Button>
                    </>
                  ) : null}
                  <Button size="sm" variant="outline" onClick={() => setAction({ kind: "cancel-class" })}>
                    {t("Cancel class")}
                  </Button>
                </div>
              )}
            </section>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

/**
 * Làm gì: Bảng cấu hình tiêu đề form (title), nhãn nút hành động (go) và quy định có bắt buộc nhập lý do (needsReason) cho từng thao tác quản lý lớp.
 * Được gọi ở: src/client/components/class-detail.tsx (ActionForm).
 */
const ACTION_COPY = {
  "cancel-session": { title: tk("Cancel this session"), go: tk("Cancel session"), needsReason: true },
  "move-session": { title: tk("Move this session"), go: tk("Move session"), needsReason: false },
  coach: { title: tk("Change the coach for every session still to come"), go: tk("Change coach"), needsReason: false },
  capacity: { title: tk("Edit capacity and minimum"), go: tk("Save capacity"), needsReason: false },
  price: { title: tk("Edit price"), go: tk("Save price"), needsReason: false },
  about: { title: tk("Edit what members read about this class"), go: tk("Save description"), needsReason: false },
  "cancel-class": { title: tk("Cancel the whole class"), go: tk("Cancel class"), needsReason: true },
} as const;

/** The one form behind every manager action on a class: it asks only for what that action needs. */
/**
 * Làm gì: Form xử lý các thao tác quản lý lớp học của Manager (hủy buổi học, dời lịch buổi học, thay đổi HLV, sửa sức chứa, sửa giá học phí, cập nhật mô tả/giáo trình hoặc hủy toàn bộ lớp học). Tự động hiển thị các trường dữ liệu tương ứng theo từng hành động.
 * Được gọi ở: src/client/components/class-detail.tsx:ClassDetailModal (khi người quản lý nhấn nút chọn một hành động quản lý lớp).
 * @param classData Thông tin chi tiết của lớp học hiện tại (ID, môn, sức chứa, HLV, giá, mô tả...).
 * @param action Hành động quản lý đang được kích hoạt (chứa loại hành động kind và thông tin phụ trợ như sessionId, startAt).
 * @param onDone Callback gọi khi thực hiện thao tác thành công để đóng form và tải lại dữ liệu lớp học.
 * @param onBack Callback quay lại giao diện danh sách nút hành động ban đầu khi quản lý muốn đổi ý.
 * @returns Giao diện form nhập liệu phù hợp với thao tác đang thực hiện.
 */
function ActionForm({
  classData,
  action,
  onDone,
  onBack,
}: {
  classData: ClassDetail["class"];
  action: Action;
  onDone: () => void;
  onBack: () => void;
}) {
  // Bước 1: Khởi tạo state cho các trường nhập liệu tương ứng với từng hành động (lý do, giờ dời lịch, HLV, sức chứa, học phí, nội dung giới thiệu).
  const [reason, setReason] = useState("");
  const [start, setStart] = useState(action.kind === "move-session" ? toLocalInput(action.startAt) : "");
  // Chỉ gọi API tải danh sách huấn luyện viên đang hoạt động khi người dùng chọn hành động đổi HLV ("coach").
  const coachRead = useRead<{ items: Array<{ id: string; full_name: string; sports: string[] | null }> }>(
    action.kind === "coach" ? "/staff?role=coach&status=active" : null,
  );
  // Coaches who teach this class's sport come first, and every name carries its sports,
  // so the manager is not picking a stranger from a bare list of names.
  const teachesHere = (x: { sports: string[] | null }) =>
    (x.sports ?? []).some((s) => s === classData.sport || s === "all");
  // Lọc bỏ HLV hiện tại của lớp; ưu tiên HLV có chuyên môn dạy môn này lên đầu danh sách, sau đó sắp xếp theo tên tiếng Việt.
  const coaches = (coachRead.data?.items ?? [])
    .filter((x) => x.id !== classData.coach_id)
    .sort((a, b) => Number(teachesHere(b)) - Number(teachesHere(a)) || a.full_name.localeCompare(b.full_name, "vi"));
  /**
   * Làm gì: Định dạng danh sách các bộ môn thể thao của huấn luyện viên thành chuỗi văn bản thân thiện để hiển thị trong danh sách chọn.
   * Được gọi ở: ActionForm (tạo nhãn môn thể thao cho từng option HLV trong thẻ select).
   * @param x Đối tượng huấn luyện viên chứa mảng tên môn thể thao phụ trách.
   * @returns Chuỗi tên môn thể thao (ví dụ: 'All sports', 'Badminton, Basketball' hoặc 'No sport yet').
   */
  const coachSports = (x: { sports: string[] | null }) => {
    const list = x.sports ?? [];
    if (list.includes("all")) return t("All sports");
    return list.length ? list.map(sportLabel).join(", ") : t("No sport yet");
  };
  const [coachId, setCoachId] = useState("");
  const [capacity, setCapacity] = useState(String(classData.capacity));
  const [minEnrolled, setMinEnrolled] = useState(classData.min_enrolled == null ? "" : String(classData.min_enrolled));
  const [price, setPrice] = useState(classData.price_vnd == null ? "" : String(classData.price_vnd));
  const [about, setAbout] = useState({
    description: classData.description ?? "",
    syllabus: classData.syllabus ?? "",
    who_for: classData.who_for ?? "",
    bring: classData.bring ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);

  const copy = ACTION_COPY[action.kind];

  /**
   * Làm gì: Gửi yêu cầu thực hiện hành động quản lý lớp học lên API backend (hủy buổi, dời lịch, đổi HLV, sửa sức chứa, sửa giá, sửa mô tả hoặc hủy lớp), hiển thị thông báo toast và đóng form khi thành công.
   * Được gọi ở: ActionForm (sự kiện onClick của nút bấm xác nhận hành động).
   * @returns Không trả về giá trị (Promise<void>).
   */
  async function submit() {
    // Bước 1: Khóa nút bấm (busy = true) và xóa thông báo lỗi cũ trước khi gửi request.
    setBusy(true);
    setError(null);
    try {
      // Bước 2: Gọi API thực hiện hành động quản lý tương ứng:
      if (action.kind === "cancel-session") {
        // Hủy một ca học: gửi lý do hủy để hoàn lại buổi tập cho học viên và gửi thông báo.
        const r = await apiPost<{ notified: number; refunded: number }>(`/sessions/${action.sessionId}/cancel`, { reason });
        toast.success(t("Session cancelled: {told} told, {back} given a session back", { told: r.notified, back: r.refunded }));
      } else if (action.kind === "move-session") {
        // Dời lịch ca học: kiểm tra thời gian mới, đổi sang ISO giờ ICT (+07:00) và gửi thông báo cho học viên lẫn HLV.
        if (!start) throw Object.assign(new Error(t("Pick the new start time.")), { field: "start_at" });
        await apiPost(`/sessions/${action.sessionId}/reschedule`, {
          start_at: toIctIso(start),
          ...(reason ? { reason } : {}),
        });
        toast.success(t("Session moved: members and coaches were told"));
      } else if (action.kind === "coach") {
        // Thay đổi HLV: bắt buộc chọn HLV mới; cập nhật người phụ trách cho toàn bộ các ca học còn lại của lớp.
        if (!coachId) throw Object.assign(new Error(t("Choose the new coach.")), { field: "coach_id" });
        await apiPost(`/classes/${classData.id}/coach`, { coach_id: coachId, ...(reason ? { reason } : {}) });
        toast.success(t("Coach changed"));
      } else if (action.kind === "capacity") {
        // Sửa sức chứa: cập nhật sĩ số tối đa (capacity) và số lượng đăng ký tối thiểu để mở lớp (min_enrolled).
        await apiPatch(`/classes/${classData.id}`, {
          capacity: Number(capacity),
          min_enrolled: minEnrolled.trim() === "" ? null : Number(minEnrolled),
        });
        toast.success(t("Capacity saved"));
      } else if (action.kind === "price") {
        // Sửa giá: cập nhật học phí theo VNĐ; để trống nếu muốn tạm dừng nhận học viên mới.
        await apiPatch(`/classes/${classData.id}`, { price_vnd: price.trim() === "" ? null : Number(price) });
        toast.success(t("Price saved"));
      } else if (action.kind === "about") {
        // Sửa nội dung: cập nhật thông tin giới thiệu lớp (mô tả, giáo trình, đối tượng phù hợp và vật dụng cần mang).
        await apiPatch(`/classes/${classData.id}`, about);
        toast.success(t("Description saved"));
      } else {
        // Hủy toàn bộ lớp học: hủy các buổi chưa diễn ra, hoàn lại tiền mặt tại quầy cho học viên (nếu có) và thông báo cho người đăng ký.
        const res = await apiPatch<{ refunded?: number; refunded_vnd?: number }>(`/classes/${classData.id}`, { status: "cancelled", reason });
        toast.success(
          res.refunded
            ? t("Class cancelled. {n} members can collect {amount} in cash at the desk.", { n: res.refunded, amount: money(res.refunded_vnd ?? 0) })
            : t("Class cancelled: everyone enrolled was told"),
        );
      }
      // Bước 3: Đóng form thao tác và kích hoạt callback onDone để làm mới dữ liệu lớp học.
      onDone();
    } catch (e) {
      // Bước 4: Xử lý lỗi trả về từ API, ánh xạ lỗi vào trường nhập liệu cụ thể (field) để hiển thị thông báo cảnh báo.
      const x = e as { message?: string; field?: string; body?: { field?: string } };
      setError({ field: x.body?.field ?? x.field, message: x.message ? tServer(x.message) : t("That did not work") });
    } finally {
      // Hoàn tất thao tác: bỏ trạng thái bận (busy = false) để người dùng có thể tiếp tục tương tác.
      setBusy(false);
    }
  }

  // Nhãn ô lý do thay đổi theo hành động: bắt buộc nhập khi dời lịch trong vòng 12 giờ trước giờ bắt đầu; tùy chọn khi đổi HLV.
  const reasonLabel =
    action.kind === "move-session"
      ? t("Reason (needed if it starts within 12 hours)")
      : action.kind === "coach"
        ? t("Reason (optional)")
        : t("Reason");
  // Lấy thông báo lỗi của từng trường nhập liệu từ state error để truyền vào prop hint của Field component.
  const at = (field: string) => (error?.field === field ? error.message : undefined);
  // Bước 5: Render form thao tác tương ứng; tự động cuộn đến form và hiển thị các trường nhập theo loại hành động.
  return (
    <div
      className="grid gap-3 rounded-[var(--radius-sm)] bg-wood/60 p-3"
      ref={(el) => el?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() })}
    >
      <p className="text-sm font-medium">
        {t(copy.title)}
        {"label" in action ? <span className="text-muted"> · {action.label}</span> : null}
      </p>
      {action.kind === "move-session" ? (
        <Field label={t("New start")} hint={at("start_at")}>
          <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
      ) : null}
      {action.kind === "coach" ? (
        coachRead.error ? (
          <LoadError
            message={coachRead.error.message}
            onRetry={coachRead.error.refused ? undefined : coachRead.reload}
          />
        ) : (
          <Field label={t("New coach")} hint={at("coach_id")}>
            <Select value={coachId} onChange={(e) => setCoachId(e.target.value)}>
              <option value="">{t("Choose…")}</option>
              {coaches.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.full_name} · {coachSports(x)}
                </option>
              ))}
            </Select>
          </Field>
        )
      ) : null}
      {action.kind === "capacity" ? (
        <Field label={t("Capacity ({n} enrolled)", { n: classData.enrolled_count })} hint={at("capacity")}>
          <Input type="number" min={1} max={200} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
        </Field>
      ) : null}
      {action.kind === "capacity" ? (
        <Field label={t("Minimum to run")} hint={at("min_enrolled") ?? t("Leave empty for no minimum. Below it the class is only flagged.")}>
          <Input type="number" min={1} max={200} value={minEnrolled} onChange={(e) => setMinEnrolled(e.target.value)} />
        </Field>
      ) : action.kind === "price" ? (
        <Field label={t("Price (VND)")} hint={at("price_vnd") ?? t("Leave empty to close the class to new sign-ups.")}>
          <Input type="number" min={0} step={1000} inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
      ) : action.kind === "about" ? (
        <>
          <Field label={t("Description")} hint={at("description")}>
            <Textarea rows={4} maxLength={2000} value={about.description} onChange={(e) => setAbout({ ...about, description: e.target.value })} />
          </Field>
          <Field label={t("Syllabus")} hint={at("syllabus") ?? t("One line per session or topic.")}>
            <Textarea rows={5} maxLength={2000} value={about.syllabus} onChange={(e) => setAbout({ ...about, syllabus: e.target.value })} />
          </Field>
          <Field label={t("Who it is for")} hint={at("who_for")}>
            <Input maxLength={300} value={about.who_for} onChange={(e) => setAbout({ ...about, who_for: e.target.value })} />
          </Field>
          <Field label={t("What to bring")} hint={at("bring")}>
            <Input maxLength={300} value={about.bring} onChange={(e) => setAbout({ ...about, bring: e.target.value })} />
          </Field>
        </>
      ) : (
        <Field label={reasonLabel} hint={at("reason")}>
          <Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
        </Field>
      )}
      {error && !["start_at", "coach_id", "capacity", "min_enrolled", "price_vnd", "reason", "description", "syllabus", "who_for", "bring"].includes(error.field ?? "") ? (
        <p role="alert" className="text-sm text-danger">
          {error.message}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onBack} disabled={busy}>
          {t("Back")}
        </Button>
        <Button
          size="sm"
          variant={action.kind.startsWith("cancel") ? "danger" : "primary"}
          onClick={submit}
          disabled={busy || (copy.needsReason && !reason.trim()) || (action.kind === "coach" && !!coachRead.error)}
        >
          {t(copy.go)}
        </Button>
      </div>
    </div>
  );
}

type OccDetail =
  | {
      kind: "booking";
      booking: {
        id: string;
        code: string;
        status: string;
        channel: string;
        start_at: string;
        end_at: string;
        price_vnd: number;
        discount_pct: number;
        paid_vnd: number;
        hold_until: string | null;
        awaiting_transfer: boolean;
        court_code: string;
        sport: string;
      };
      customer: { type: "member" | "guest"; name: string | null; phone: string | null; member_code: string | null };
    }
  | {
      kind: "session";
      session: {
        id: string;
        class_id: string;
        start_at: string;
        end_at: string;
        status: string;
        court_code: string;
        sport: string;
        level: string;
        capacity: number;
        enrolled_count: number;
        coach_name: string;
      };
    }
  | { kind: "maintenance"; maintenance: { reason: string | null; court_code: string; start_at: string; end_at: string } };

/**
 * Whose hour is this? Opened from a taken cell on the court map.
 */
/**
 * Làm gì: Modal hiển thị thông tin chi tiết về đối tượng đang chiếm sân trong một khung giờ (đơn đặt sân của khách/hội viên, ca học của lớp thể thao hoặc lịch bảo trì sân). Cho phép mở nhanh chi tiết lớp học nếu ca chiếm sân là một buổi học.
 * Được gọi ở: src/routes/desk.courts.tsx (màn hình sơ đồ sân lễ tân, khi bấm vào một ô sân đã có lịch).
 * @param target Đối tượng chiếm sân được chọn ({ kind: "booking" | "session" | "maintenance", ref: string }); null khi modal đóng.
 * @param onClose Callback kích hoạt khi người dùng bấm đóng modal.
 * @param onOpenClass Callback tùy chọn để mở modal ClassDetailModal khi người dùng muốn xem chi tiết lớp học từ buổi học này.
 * @returns Modal hiển thị chi tiết ca chiếm sân tương ứng.
 */
export function OccupancyDetailModal({
  target,
  onClose,
  onOpenClass,
}: {
  target: { kind: string; ref: string } | null;
  onClose: () => void;
  onOpenClass?: (classId: string) => void;
}) {
  // Bước 1: Tải chi tiết ca chiếm sân từ API /occupancy/detail theo loại đối tượng (kind: booking | session | maintenance) và mã định danh (ref).
  const { data, error, reload } = useRead<OccDetail>(
    target ? `/occupancy/detail?kind=${encodeURIComponent(target.kind)}&ref=${encodeURIComponent(target.ref)}` : null,
  );

  // Bước 2: Xác định tiêu đề hiển thị cho modal tương ứng với từng loại ca chiếm sân (mã đặt sân, ca học hoặc bảo trì sân).
  const title =
    data?.kind === "booking"
      ? t("Booking {code}", { code: data.booking.code })
      : data?.kind === "session"
        ? t("Class session")
        : data?.kind === "maintenance"
          ? t("Court out of service")
          : target
            ? kindLabel(target.kind)
            : t("Details");

  // Bước 3: Render modal chi tiết; hiển thị nút 'Open the class' khi ca chiếm sân là một buổi học, cùng thông tin chi tiết của từng loại đối tượng (đặt sân, lớp học hoặc bảo trì).
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title={title}
      footer={
        <div className="flex justify-end gap-2">
          {data?.kind === "session" && onOpenClass ? (
            <Button variant="outline" onClick={() => onOpenClass(data.session.class_id)}>
              {t("Open the class")}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            {t("Close")}
          </Button>
        </div>
      }
    >
      {error ? (
        <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
      ) : !data ? (
        <Skeleton className="h-32" />
      ) : data.kind === "booking" ? (
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted">{t("Customer")}</dt>
          <dd className="font-medium">
            {data.customer.name ?? "-"}{" "}
            <Badge tone={data.customer.type === "member" ? "accent" : "muted"}>
              {data.customer.type === "member" ? t("Member") : t("Walk-in")}
            </Badge>
          </dd>
          <dt className="text-muted">{t("Phone")}</dt>
          <dd className="tabular-nums">
            {data.customer.phone ?? "-"}
            {data.customer.member_code ? ` · ${data.customer.member_code}` : ""}
          </dd>
          <dt className="text-muted">{t("Court")}</dt>
          <dd>
            {data.booking.court_code} · {sportLabel(data.booking.sport)}
          </dd>
          <dt className="text-muted">{t("Time")}</dt>
          <dd className="tabular-nums">
            {sessionDay(data.booking.start_at)} · {hhmm(data.booking.start_at)}-{hhmm(data.booking.end_at)}
          </dd>
          <dt className="text-muted">{t("Amount")}</dt>
          <dd className="tabular-nums">
            {money(data.booking.price_vnd)}
            {data.booking.discount_pct ? ` (−${data.booking.discount_pct}%)` : ""} ·{" "}
            {t("paid {amount}", { amount: money(data.booking.paid_vnd) })}
          </dd>
          <dt className="text-muted">{t("Status")}</dt>
          <dd>
            <StatusBadge status={data.booking.status} />
            {data.booking.status === "hold" && data.booking.hold_until ? (
              <span className="ml-2 text-muted">
                {data.booking.awaiting_transfer ? `${t("waiting for the bank transfer")} · ` : ""}
                {t("held until {time}", { time: hhmm(data.booking.hold_until) })}
              </span>
            ) : null}
          </dd>
          <dt className="text-muted">{t("Booked via")}</dt>
          <dd className="capitalize">{data.booking.channel}</dd>
        </dl>
      ) : data.kind === "session" ? (
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted">{t("Class")}</dt>
          <dd className="font-medium">
            {sportLabel(data.session.sport)} · {levelLabel(data.session.level)}
          </dd>
          <dt className="text-muted">{t("Coach")}</dt>
          <dd>{data.session.coach_name}</dd>
          <dt className="text-muted">{t("Court")}</dt>
          <dd>{data.session.court_code}</dd>
          <dt className="text-muted">{t("Time")}</dt>
          <dd className="tabular-nums">
            {sessionDay(data.session.start_at)} · {hhmm(data.session.start_at)}-{hhmm(data.session.end_at)}
          </dd>
          <dt className="text-muted">{t("Students")}</dt>
          <dd className="tabular-nums">
            {data.session.enrolled_count}/{data.session.capacity}
          </dd>
        </dl>
      ) : (
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted">{t("Court")}</dt>
          <dd>{data.maintenance.court_code}</dd>
          <dt className="text-muted">{t("Time")}</dt>
          <dd className="tabular-nums">
            {when(data.maintenance.start_at)} - {hhmm(data.maintenance.end_at)}
          </dd>
          <dt className="text-muted">{t("Reason")}</dt>
          <dd>{data.maintenance.reason ?? t("No reason recorded.")}</dd>
        </dl>
      )}
    </Modal>
  );
}
