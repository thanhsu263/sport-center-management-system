/**
 * File: src/routes/app.train.tsx
 * Vai trò: Route /app/train hiển thị trang tổng quan tiến độ tập luyện của hội viên (Member Training Progress).
 * Nằm trong phân hệ luyện tập F4 (SRS v1.4 §FR-TRN), kết nối dữ liệu từ API /me/training.
 * Cung cấp giao diện theo dõi mục tiêu, vòng hoạt động (ActivityRings), chuỗi ngày tập (WorkoutStreak),
 * các buổi học sắp tới kèm giáo án, bài tập về nhà tương tác, nhận xét của HLV và kết quả các buổi gần nhất.
 */
import { createFileRoute } from "@tanstack/react-router";
import { SectionTitle } from "@/client/components/section";
import { sessionDay } from "@/client/components/class-detail";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Shell, hhmm } from "@/client/components/shell";
import { Badge, Card, Check, EmptyState, LoadError, PageHero, Select, Skeleton } from "@/client/components/ui";
import { Lift, Stagger, StaggerItem, motion } from "@/client/components/motion";
import { SpotlightCard } from "@/client/components/fx";
import { ActivityRings, NextMilestoneCard, SessionCountdown, WorkoutStreak } from "@/client/components/training-progress";
import { apiPut } from "@/client/arena3/client";
import { addDaysISO, formatDate, levelLabel, sportLabel, todayISO } from "@/shared/arena3/labels";
import { t, tk } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";
import { AddToCalendar } from "@/client/components/class-extras";
import { CertificatesSection } from "@/client/components/member-certificates";

/**
 * Làm gì: Định nghĩa route /app/train trong TanStack Router cho trang theo dõi tiến độ luyện tập của hội viên.
 * Được gọi ở: TanStack Router khi người dùng truy cập URL /app/train.
 * @returns Route object cấu hình component hiển thị là Page.
 */
export const Route = createFileRoute("/app/train")({ component: Page });

// Danh mục các mục tiêu tập luyện mà hội viên có thể lựa chọn (giảm cân, nâng cao kỹ thuật, thi đấu, giải trí).
const GOALS: Record<string, string> = {
  weight: tk("Lose weight"),
  technique: tk("Improve technique"),
  compete: tk("Compete"),
  fun: tk("Have fun"),
};
// Bảng ánh xạ mã định danh chỉ số kỹ thuật buổi tập (smashes, free throws, serves in) sang nhãn hiển thị đa ngôn ngữ.
const METRIC_LABEL: Record<string, string> = {
  smash_count: tk("Smashes"),
  freethrow_pct: tk("Free throws"),
  serve_pct: tk("Serves in"),
};

type PlanBlock = { title: string; minutes: number; phase?: string };
type Plan = {
  id: string;
  title: string | null;
  payload: { goal?: string; blocks?: PlanBlock[]; note?: string };
};

// Kiểu dữ liệu phản hồi từ API GET /me/training chứa toàn bộ thông tin tiến độ của hội viên.
type Progress = {
  completed_sessions: number;
  goal: string | null;
  levels: Array<{ sport: string; level: string }>;
  next_sessions: Array<{
    id: string;
    start_at: string;
    end_at: string;
    sport: string;
    level: string;
    court_code: string;
    plans: Plan[];
  }>;
  results: Array<{
    session_id: string;
    plan_pct: number | null;
    metrics: Record<string, number> | null;
    note: string | null;
    start_at: string;
    sport: string;
  }>;
  reviews: Array<{
    id: string;
    sport: string;
    period_weeks: number;
    technique: number;
    fitness: number;
    attitude: number;
    comment: string | null;
    created_at: string;
    coach_name: string;
  }>;
  homework: Array<{
    id: string;
    title: string;
    body: string | null;
    checklist: string[];
    due_on: string | null;
    done_items: number[];
  }>;
};

/**
 * Làm gì: Trích xuất thông báo lỗi an toàn từ đối tượng error để hiển thị trên thông báo toast.
 * Được gọi ở: Page -> setGoal (dòng 97) và tick (dòng 114).
 * @param e Đối tượng lỗi bắt được từ khối catch (unknown).
 * @returns Chuỗi thông báo lỗi (Error.message hoặc câu thông báo lỗi mặc định).
 */
const say = (e: unknown) => (e instanceof Error ? e.message : t("Something went wrong"));

/**
 * Làm gì: Component trang chính hiển thị toàn bộ bảng điều khiển luyện tập của hội viên (tiến độ, mục tiêu, lịch học, bài tập về nhà, đánh giá của HLV).
 * Được gọi ở: Route (URL /app/train).
 * @returns Giao diện bảng điều khiển luyện tập của hội viên được bọc trong Shell.
 */
function Page() {
  // Bước 1: Tải dữ liệu tiến độ tập luyện của hội viên hiện tại từ endpoint GET /me/training.
  const { data, error, reload } = useRead<Progress>("/me/training");
  // The server's copy, with the member's ticks and goal shown here as soon as they are made.
  const [d, setD] = useState<Progress | null>(null);
  // Bước 2: Đồng bộ dữ liệu mới từ server vào state cục bộ d mỗi khi data thay đổi.
  useEffect(() => {
    setD(data);
  }, [data]);

  /**
   * Làm gì: Cập nhật mục tiêu tập luyện cá nhân của hội viên lên server và cập nhật state cục bộ.
   * Được gọi ở: Page -> sự kiện onChange của dropdown chọn mục tiêu Select.
   * @param goal Mã mục tiêu được chọn (nếu là chuỗi rỗng sẽ gửi null để xóa mục tiêu).
   * @returns Không trả về dữ liệu (Promise<void>).
   * @throws Bắt lỗi API và hiển thị thông báo toast lỗi cho người dùng.
   */
  async function setGoal(goal: string) {
    try {
      // Bước 1: Gửi request cập nhật mục tiêu vào bảng training_profiles (rỗng chuyển thành null).
      await apiPut("/me/training-goal", { goal: goal || null });
      // Bước 2: Cập nhật ngay state d tại client để dropdown hiển thị giá trị mới mà không cần đợi reload.
      setD((x) => (x ? { ...x, goal: goal || null } : x));
      // Bước 3: Thông báo lưu mục tiêu thành công cho người dùng.
      toast.success(t("Goal saved"));
    } catch (e) {
      // Bước 4: Xử lý lỗi nếu gọi API thất bại, hiển thị toast thông báo lỗi.
      toast.error(say(e));
    }
  }

  /**
   * Làm gì: Đánh dấu hoàn thành hoặc bỏ đánh dấu một mục checklist bài tập về nhà với cơ chế optimistic update.
   * Được gọi ở: Page -> component Check trong danh sách checklist bài tập về nhà.
   * @param hw Đối tượng bài tập về nhà chứa danh sách checklist và các mục đã hoàn thành.
   * @param index Vị trí (index) của mục vừa được bấm trong checklist.
   * @returns Không trả về dữ liệu (Promise<void>).
   * @throws Bắt lỗi API, hiển thị toast lỗi và gọi reload() để khôi phục dữ liệu ban đầu từ server.
   */
  async function tick(hw: Progress["homework"][number], index: number) {
    // Bước 1: Tính toán danh sách chỉ số done_items mới (bỏ mục nếu đã có, hoặc thêm vào và sắp xếp tăng dần).
    const done = hw.done_items.includes(index)
      ? hw.done_items.filter((i) => i !== index)
      : [...hw.done_items, index].sort((a, b) => a - b);
    // Show the tick at once; the server's answer says whether it finished the homework.
    setD((x) => x && { ...x, homework: x.homework.map((h) => (h.id === hw.id ? { ...h, done_items: done } : h)) });
    try {
      // Bước 2: Gửi danh sách các mục đã hoàn thành lên server qua endpoint PUT /me/homework/:id.
      const r = await apiPut<{ completed: boolean }>(`/me/homework/${hw.id}`, { done_items: done });
      // Bước 3: Nếu đã hoàn thành mọi mục (r.completed === true), chúc mừng và chờ 700ms để người dùng kịp nhìn hiệu ứng trước khi ẩn bài tập.
      if (r.completed) {
        toast.success(t("Homework done. Nice work!"));
        setTimeout(() => setD((x) => x && { ...x, homework: x.homework.filter((h) => h.id !== hw.id) }), 700);
      }
    } catch (e) {
      // Bước 4: Xử lý lỗi nếu gửi thất bại: hiển thị toast lỗi và gọi reload() để khôi phục trạng thái chuẩn từ server.
      toast.error(say(e));
      reload();
    }
  }

  return (
    <Shell role="member">
      <PageHero
        slot="banner.train"
        title={t("My progress")}
        subtitle={t("Your plans, homework and what your coach has noticed. AI only suggests; a coach approves what reaches you.")}
        fallbackSpot="chart"
        stats={[
          {
            label: t("Completed sessions"),
            value: d?.completed_sessions ?? 0,
          },
          {
            label: t("Upcoming sessions"),
            value: d?.next_sessions?.length ?? 0,
            live: Boolean(d?.next_sessions?.length),
          },
          {
            label: t("Homework left"),
            value: d?.homework?.length ?? 0,
          },
        ]}
      />
      {error ? (
        <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
      ) : !d ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="grid gap-8">
          <Card className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="kicker text-2xs text-muted">{t("Your goal")}</p>
              <Select className="mt-1.5" aria-label={t("Your goal")} value={d.goal ?? ""} onChange={(e) => void setGoal(e.target.value)}>
                <option value="">{t("Not set")}</option>
                {Object.entries(GOALS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {t(v)}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <p className="kicker text-2xs text-muted">{t("Your level")}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {d.levels.length ? (
                  d.levels.map((l) => (
                    <Badge key={l.sport} tone="accent">
                      {sportLabel(l.sport)} · {levelLabel(l.level)}
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-muted">{t("Your coach sets this after a few sessions.")}</span>
                )}
              </div>
            </div>
          </Card>

          {/* Activity Ring, Streak, Milestone */}
          {(() => {
            // Bước 1: Lấy số buổi tập đã hoàn thành và tập hợp danh sách các ngày tập vào Set (theo giờ Việt Nam en-CA dạng YYYY-MM-DD) để tra cứu O(1).
            const realDone = d.completed_sessions;
            const sessionDates = new Set(
              d.results.map((r) => {
                const dt = new Date(r.start_at);
                return new Intl.DateTimeFormat("en-CA", {
                  timeZone: "Asia/Ho_Chi_Minh",
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                }).format(dt);
              }),
            );
            // Bước 2: Xác định ngày thứ Hai đầu tuần hiện tại theo chuẩn ISO (Thứ Hai = 0) để tạo mốc thời gian tuần.
            const today = todayISO();
            const [y, m, dayNum] = today.split("-").map(Number);
            const todayDt = new Date(Date.UTC(y, (m ?? 1) - 1, dayNum ?? 1));
            // Chuyển đổi getUTCDay() (Chủ Nhật = 0) sang chuẩn ISO (Thứ Hai = 0) để tính ngày thứ Hai đầu tuần.
            const currentDayOfWeek = (todayDt.getUTCDay() + 6) % 7;
            const mondayISO = addDaysISO(today, -currentDayOfWeek);

            // Bước 3: Kiểm tra 7 ngày trong tuần từ thứ Hai đến Chủ Nhật xem ngày nào có buổi tập để hiển thị lên workout streak.
            const activeDays: boolean[] = [];
            for (let i = 0; i < 7; i++) {
              const dayStr = addDaysISO(mondayISO, i);
              activeDays.push(sessionDates.has(dayStr));
            }

            // Bước 4: Tính chuỗi ngày tập liên tục (streak); nếu hôm nay chưa tập thì lùi về hôm qua để tránh ngắt chuỗi trong ngày.
            let streak = 0;
            let checkDay = today;
            if (!sessionDates.has(checkDay)) {
              checkDay = addDaysISO(checkDay, -1);
            }
            while (sessionDates.has(checkDay)) {
              streak++;
              checkDay = addDaysISO(checkDay, -1);
            }

            // Bước 5: Xác định cấp độ mục tiêu tiếp theo dựa trên môn thể thao đầu tiên của hội viên.
            const milestoneTarget = d.levels.length > 0 ? levelLabel(d.levels[0].level) : null;

            return (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Card className="p-0 flex items-center justify-center">
                  <ActivityRings sessionsDone={realDone} />
                </Card>
                <WorkoutStreak days={streak} activeDays={activeDays} />
                <NextMilestoneCard target={milestoneTarget} />
              </div>
            );
          })()}

          <section>
            <SectionTitle text={t("Up next")} className="font-display text-2xl" />
            {d.next_sessions.length ? (
              <Stagger className="mt-3 grid gap-3 md:grid-cols-2" gap={0.07}>
                {d.next_sessions.map((s) => (
                  <StaggerItem key={s.id} className="h-full">
                    <Lift className="h-full">
                      <SpotlightCard className="h-full rounded-[var(--radius-xl)]" size={320} strength={0.1}>
                        <Card interactive className="relative z-[2] h-full">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-2xs text-muted">
                              {sessionDay(s.start_at)} · {hhmm(s.start_at)} · {sportLabel(s.sport)} · {s.court_code}
                            </p>
                            <SessionCountdown startAt={s.start_at} />
                          </div>
                          <AddToCalendar
                            className="mt-1"
                            event={{
                              title: `${sportLabel(s.sport)} · ${levelLabel(s.level)}`,
                              start: s.start_at,
                              end: s.end_at,
                              location: `Lê Long Sport · ${t("Court {court}", { court: s.court_code })}`,
                            }}
                          />
                          {s.plans.length ? (
                            s.plans.map((p) => (
                              <div key={p.id} className="mt-3">
                                <h3 className="font-display text-xl">{p.title || p.payload.goal || t("Session plan")}</h3>
                                <ol className="mt-2 grid gap-1 text-sm">
                                  {(p.payload.blocks ?? []).map((b, i) => (
                                    <motion.li
                                      key={i}
                                      initial={{ opacity: 0, x: -8 }}
                                      whileInView={{ opacity: 1, x: 0 }}
                                      viewport={{ once: true }}
                                      transition={{ duration: 0.3, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}
                                    >
                                      {i + 1}. {b.title} <span className="tabular-nums text-muted">{b.minutes}′</span>
                                      {b.phase ? <span className="text-muted"> · {b.phase}</span> : null}
                                    </motion.li>
                                  ))}
                                </ol>
                                {p.payload.note ? <p className="mt-2 text-xs text-muted">{p.payload.note}</p> : null}
                              </div>
                            ))
                          ) : (
                            <p className="mt-3 text-sm text-muted">{t("Your coach hasn't posted a plan for this one yet.")}</p>
                          )}
                        </Card>
                      </SpotlightCard>
                    </Lift>
                  </StaggerItem>
                ))}
              </Stagger>
            ) : (
              <div className="mt-3">
                <EmptyState title={t("No sessions coming up")} hint={t("Join a class and its plans show up here.")} />
              </div>
            )}
          </section>

          <section>
            <SectionTitle text={t("Homework")}className="font-display text-2xl" />
            {d.homework.length ? (
              <div className="mt-3 grid gap-3">
                {d.homework.map((h) => (
                  <Card key={h.id}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="font-medium">{h.title}</h3>
                      <span className="text-xs text-muted">{h.due_on ? t("Due {date}", { date: formatDate(h.due_on) }) : t("No due date")}</span>
                    </div>
                    {h.body ? <p className="mt-1 whitespace-pre-wrap text-sm text-muted [overflow-wrap:anywhere]">{h.body}</p> : null}
                    <ul className="mt-3 grid gap-1">
                      {h.checklist.map((item, i) => (
                        <li key={i}>
                          <Check
                            checked={h.done_items.includes(i)}
                            onChange={() => void tick(h, i)}
                            label={<span className={h.done_items.includes(i) ? "text-muted line-through" : ""}>{item}</span>}
                          />
                        </li>
                      ))}
                    </ul>
                  </Card>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted">{t("Nothing to do right now.")}</p>
            )}
          </section>

          <section>
            <SectionTitle text={t("Coach reviews")}className="font-display text-2xl" />
            <div className="mt-3 grid gap-2">
              {d.reviews.length ? (
                d.reviews.map((r) => (
                  <Card key={r.id} className="p-4">
                    <p className="text-xs text-muted">
                      {t("{date} · {sport} · last {n} weeks · {coach}", {
                        date: formatDate(r.created_at),
                        sport: sportLabel(r.sport),
                        n: r.period_weeks,
                        coach: r.coach_name,
                      })}
                    </p>
                    <p className="mt-1 text-sm">
                      {t("Technique {a}/5 · Fitness {b}/5 · Attitude {c}/5", {
                        a: r.technique,
                        b: r.fitness,
                        c: r.attitude,
                      })}
                    </p>
                    {r.comment ? <p className="mt-1 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{r.comment}</p> : null}
                  </Card>
                ))
              ) : (
                <p className="text-sm text-muted">{t("No reviews yet.")}</p>
              )}
            </div>
          </section>

          <CertificatesSection />

          <section>
            <SectionTitle text={t("Recent sessions")}className="font-display text-2xl" />
            <div className="mt-3 grid gap-2">
              {d.results.length ? (
                d.results.map((r) => (
                  <Card key={r.session_id} className="p-4">
                    <p className="text-xs text-muted">
                      {formatDate(r.start_at)} · {sportLabel(r.sport)}
                    </p>
                    <p className="mt-1 text-sm">
                      {r.plan_pct == null ? t("Session logged") : t("{n}% of the plan", { n: r.plan_pct })}
                      {Object.entries(r.metrics ?? {}).map(([k, v]) => ` · ${METRIC_LABEL[k] ? t(METRIC_LABEL[k]) : k} ${v}`)}
                    </p>
                    {r.note ? <p className="mt-1 text-sm text-muted">{r.note}</p> : null}
                  </Card>
                ))
              ) : (
                <p className="text-sm text-muted">{t("Your coach's notes from each session appear here.")}</p>
              )}
            </div>
          </section>
        </div>
      )}
    </Shell>
  );
}
