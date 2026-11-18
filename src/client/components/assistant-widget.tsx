/**
 * File: src/client/components/assistant-widget.tsx
 * Vai trò: Cung cấp widget trợ lý ảo AI (linh vật Shuttle) dạng cửa sổ nổi ở góc dưới màn hình.
 * Vị trí trong app: Được nhúng trong shell ứng dụng (src/client/components/shell.tsx) cho tài khoản hội viên khi bật cờ F6, giúp gửi tin nhắn hỏi đáp nhanh về lịch sân, học phí, giờ mở cửa hoặc chuyển tiếp sang trang đầy đủ /app/assistant.
 */
import { Link } from "@tanstack/react-router";
import { Maximize2, RotateCcw, Send, X } from "lucide-react";
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { useReducedMotionAfterMount } from "@/client/components/motion";
import { useSessionUser } from "@/client/components/shell";
import { apiPost } from "@/client/arena3/client";
import { historyFor, useChatLog } from "@/client/lib/chat-log";
import { cn } from "@/client/lib/cn";
import { scrollBehavior } from "@/client/lib/calm";
import { getLang, t, tk } from "@/client/lib/i18n";

/**
 * Shuttle, the centre's mascot: a shuttlecock with a face.
 *
 * Drawn in SVG with layered gradients so the cork reads as a lit sphere and the feathers as a cone,
 * then tilted in 3D towards the pointer. It blinks and bobs while idle, and bounces while the
 * assistant is answering, so the motion says "awake" or "thinking". Reduced motion keeps it still.
 */
/**
 * Làm gì: Hiển thị linh vật quả cầu lông 3D (Shuttle) tương tác theo con trỏ chuột, chớp mắt và nhún nhảy khi rảnh hoặc nảy nhanh khi AI đang suy nghĩ.
 * Được gọi ở:
 * - src/client/components/assistant-widget.tsx: trong AssistantWidget (thanh tiêu đề hộp thoại chat và nút tròn mở widget góc màn hình).
 * @param thinking Trạng thái AI đang xử lý câu trả lời (true: nảy nhanh và há miệng suy nghĩ; false: nhún chậm).
 * @param size Kích thước hiển thị theo pixel (mặc định 64px).
 * @param className Các class CSS bổ sung cho container bên ngoài.
 * @returns Khung div chứa đồ họa SVG 3D của linh vật quả cầu lông.
 */
export function Mascot({ thinking = false, size = 64, className }: { thinking?: boolean; size?: number; className?: string }) {
  // Bước 1: Khởi tạo cờ giảm chuyển động (reduced motion) và id ngẫu nhiên cho SVG defs để tránh xung đột gradient.
  const calm = useReducedMotionAfterMount();
  const uid = useId().replace(/:/g, "");
  const box = useRef<HTMLDivElement>(null);
  // Bước 2: Thiết lập MotionValue và hiệu ứng lò xo vật lý (spring) để tạo độ mượt khi xoay 3D và liếc mắt.
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  // Ánh xạ tọa độ chuột [-1, 1] sang góc xoay 3D (độ) quanh trục X và Y với lò xo giảm chấn.
  const rx = useSpring(useTransform(my, [-1, 1], [16, -16]), { stiffness: 160, damping: 14 });
  const ry = useSpring(useTransform(mx, [-1, 1], [-22, 22]), { stiffness: 160, damping: 14 });
  // Ánh xạ độ lệch mắt (pixel) theo hướng chuột để tròng mắt liếc nhìn theo con trỏ.
  const ex = useSpring(useTransform(mx, [-1, 1], [-3, 3]), { stiffness: 200, damping: 18 });
  const ey = useSpring(useTransform(my, [-1, 1], [-2, 2]), { stiffness: 200, damping: 18 });

  // Bước 3: Lắng nghe sự kiện di chuyển con trỏ trên toàn màn hình để tính toán góc nghiêng hướng về phía chuột.
  useEffect(() => {
    if (calm) return;
    const onMove = (e: PointerEvent) => {
      const el = box.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      // Chuẩn hóa khoảng cách từ tâm mascot đến con trỏ theo bán kính 320px về đoạn [-1, 1].
      mx.set(Math.max(-1, Math.min(1, (e.clientX - cx) / 320)));
      my.set(Math.max(-1, Math.min(1, (e.clientY - cy) / 320)));
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [calm, mx, my]);

  // Hàm tạo id duy nhất cho defs SVG theo uid, tránh xung đột id khi có nhiều linh vật trên cùng trang.
  const g = (n: string) => `${n}-${uid}`;

  return (
    <div ref={box} className={cn("[perspective:600px]", className)} style={{ width: size, height: size }} aria-hidden>
      <motion.div
        style={calm ? undefined : { rotateX: rx, rotateY: ry, transformStyle: "preserve-3d" }}
        animate={calm ? undefined : thinking ? { y: [0, -7, 0], scale: [1, 1.05, 1] } : { y: [0, -3, 0] }}
        transition={calm ? undefined : { duration: thinking ? 0.55 : 2.6, repeat: Infinity, ease: "easeInOut" }}
        className="size-full"
      >
        <svg viewBox="0 0 100 100" className="size-full overflow-visible drop-shadow-[0_10px_14px_rgba(10,14,8,0.45)]">
          <defs>
            <radialGradient id={g("cork")} cx="38%" cy="30%" r="75%">
              <stop offset="0%" stopColor="#fbffe0" />
              <stop offset="45%" stopColor="#d9f53a" />
              <stop offset="100%" stopColor="#6f8f0c" />
            </radialGradient>
            <linearGradient id={g("feather")} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#c9cfc2" />
              <stop offset="45%" stopColor="#ffffff" />
              <stop offset="100%" stopColor="#aab2a2" />
            </linearGradient>
            <linearGradient id={g("band")} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#1f3a12" />
              <stop offset="50%" stopColor="#3f7d20" />
              <stop offset="100%" stopColor="#1a2f0f" />
            </linearGradient>
            <radialGradient id={g("shade")} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#000" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#000" stopOpacity="0" />
            </radialGradient>
          </defs>
          {/* Ground shadow */}
          <ellipse cx="50" cy="97" rx="22" ry="3.5" fill={`url(#${g("shade")})`} />
          {/* Feather skirt: a cone with ribs */}
          <path d="M22 8 L78 8 L64 52 L36 52 Z" fill={`url(#${g("feather")})`} stroke="#8d977f" strokeWidth="0.8" />
          {[30, 40, 50, 60, 70].map((x) => (
            <path key={x} d={`M${x} 8 L${36 + (x - 22) * 0.5} 52`} stroke="#9aa38d" strokeWidth="0.7" fill="none" />
          ))}
          <path d="M22 8 Q50 14 78 8" stroke="#8d977f" strokeWidth="0.8" fill="none" />
          <path d="M28 26 Q50 31 72 26" stroke="#b5bcaa" strokeWidth="0.6" fill="none" />
          {/* Band where the feathers meet the cork */}
          <rect x="34" y="49" width="32" height="7" rx="3" fill={`url(#${g("band")})`} />
          {/* Cork head */}
          <circle cx="50" cy="72" r="21" fill={`url(#${g("cork")})`} />
          <ellipse cx="42" cy="62" rx="7" ry="4" fill="#fff" opacity="0.55" />
          {/* Face follows the pointer a little */}
          <motion.g style={calm ? undefined : { x: ex, y: ey }}>
            <motion.g
              style={{ transformOrigin: "50px 71px" }}
              animate={calm ? undefined : { scaleY: [1, 1, 0.1, 1] }}
              transition={calm ? undefined : { duration: 4.2, repeat: Infinity, times: [0, 0.9, 0.95, 1] }}
            >
              <ellipse cx="42.5" cy="71" rx="3" ry="4" fill="#14200c" />
              <ellipse cx="57.5" cy="71" rx="3" ry="4" fill="#14200c" />
              <circle cx="43.5" cy="69.5" r="1.1" fill="#fff" />
              <circle cx="58.5" cy="69.5" r="1.1" fill="#fff" />
            </motion.g>
            <circle cx="36" cy="78" r="3" fill="#ff8a6b" opacity="0.45" />
            <circle cx="64" cy="78" r="3" fill="#ff8a6b" opacity="0.45" />
            {thinking ? (
              <ellipse cx="50" cy="80" rx="2.6" ry="2.2" fill="#14200c" />
            ) : (
              <path d="M45 79 Q50 83.5 55 79" stroke="#14200c" strokeWidth="1.8" strokeLinecap="round" fill="none" />
            )}
          </motion.g>
        </svg>
      </motion.div>
    </div>
  );
}

// Giới hạn 800 ký tự cho mỗi câu hỏi, đồng bộ với ngưỡng cắt chuỗi tối đa của API /v1/assistant trên server.
const MAX_CHARS = 800;
// Danh sách các câu hỏi gợi ý nhanh dạng chip hiển thị khi hộp thoại chat chưa có tin nhắn nào.
const CHIPS = [tk("What are your opening hours?"), tk("How do I cancel a court?")];
// Lời chào mở đầu của linh vật Shuttle giới thiệu các chủ đề có thể hỗ trợ giải đáp.
const WELCOME = tk("Hi, I'm Shuttle. Ask me about the timetable, prices, coaches or cancelling.");

/**
 * The assistant as a corner widget: Shuttle sits bottom-right and opens a small chat in place, so a
 * member can ask something without leaving the page they are on. The full page stays at
 * /app/assistant for longer conversations.
 */
/**
 * Làm gì: Widget trợ lý ảo dạng cửa sổ nổi ở góc màn hình, cho phép hội viên nhắn tin hỏi đáp nhanh với AI về lịch mở cửa, giá sân, đặt/hủy sân mà không cần rời trang hiện tại.
 * Được gọi ở:
 * - src/client/components/shell.tsx: trong AppShell (chỉ hiển thị cho tài khoản member khi cờ tính năng F6 bật và không nằm trong trang /app/assistant).
 * @param docked Cờ xác định widget có cần nâng cao vị trí để tránh đè lên thanh điều hướng mobile dưới đáy màn hình hay không.
 * @returns Giao diện widget gồm nút tròn linh vật và hộp thoại chat thu nhỏ.
 */
export function AssistantWidget({ docked }: { docked: boolean }) {
  // Bước 1: Khởi tạo các state điều khiển giao diện (đóng/mở, câu hỏi, trạng thái chờ AI, lỗi) và hook nhật ký chat.
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const user = useSessionUser();
  // Quản lý nhật ký chat lưu trong localStorage theo user.id của hội viên đang đăng nhập, giữ ngữ cảnh qua các trang.
  const { log, append, clear } = useChatLog(user?.id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const thread = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // Bước 2: Tự động cuộn xuống đáy danh sách tin nhắn mỗi khi có tin mới, trạng thái bận hoặc có lỗi xuất hiện.
  useEffect(() => {
    const el = thread.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: scrollBehavior() });
  }, [log, busy, err]);

  // Bước 3: Tự động focus vào ô nhập liệu khi mở widget và lắng nghe phím Escape để đóng nhanh.
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  /**
   * Làm gì: Chuẩn hóa câu hỏi, cập nhật nhật ký chat và gọi API POST /v1/assistant để nhận câu trả lời từ AI.
   * Được gọi ở:
   * - Nội bộ component AssistantWidget (sự kiện onSubmit của form chat và onClick của các nút chip gợi ý CHIPS).
   * @param text Nội dung tin nhắn tùy chọn (nếu không truyền sẽ lấy từ state ô nhập liệu q).
   * @returns Không trả về dữ liệu (Promise<void>).
   */
  async function send(text?: string) {
    // Bước 1: Lấy nội dung tin nhắn, cắt khoảng trắng thừa và giới hạn tối đa 800 ký tự theo quy định server.
    const message = (text ?? q).trim().slice(0, MAX_CHARS);
    // Bỏ qua nếu tin nhắn quá ngắn (dưới 2 ký tự) hoặc hệ thống đang chờ API phản hồi.
    if (message.length < 2 || busy) return;
    // Bước 2: Xóa trắng ô nhập liệu và xóa thông báo lỗi cũ trước khi gửi request mới.
    setQ("");
    setErr(null);
    // Bước 3: Thu thập lịch sử hội thoại (câu của người dùng và câu trả lời đã ký của bot) và thêm tin nhắn mới vào nhật ký chat.
    const history = historyFor(log);
    append({ role: "me", text: message });
    // Bước 4: Đánh dấu trạng thái bận và gọi API /assistant (POST /v1/assistant) với câu hỏi cùng lịch sử.
    setBusy(true);
    try {
      const r = await apiPost<{ reply: string; source?: "gemini" | "xai" | "rules"; sig?: string }>("/assistant", { message, history, lang: getLang() });
      // Bước 5: Nhận câu trả lời và lưu vào nhật ký chat với role "bot" kèm nguồn xử lý (gemini, xai hoặc rules) và chữ ký sig.
      append({ role: "bot", text: r.reply, source: r.source, sig: r.sig });
    } catch (e) {
      // Bắt lỗi khi mất kết nối mạng hoặc tính năng trợ lý ảo bị tắt phía server.
      setErr(e instanceof Error ? e.message : t("The assistant is switched off"));
    } finally {
      // Giải phóng trạng thái bận để mở lại ô nhập và nút gửi cho câu hỏi tiếp theo.
      setBusy(false);
    }
  }

  return (
    <div
      className={cn(
        "fixed right-4 z-40 flex flex-col items-end gap-3 sm:right-6",
        docked ? "bottom-[calc(6rem+env(safe-area-inset-bottom))] lg:bottom-6" : "bottom-6",
      )}
    >
      <AnimatePresence>
        {open ? (
          <motion.div
            role="dialog"
            aria-label={t("Lê Long Sport assistant")}
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.96 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            style={{ transformOrigin: "bottom right" }}
            className="flex w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-[var(--radius-xl)] border border-line bg-surface shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)]"
          >
            <div className="flex items-center gap-2 border-b border-line/70 px-3 py-2.5">
              <Mascot size={36} thinking={busy} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-tight">Shuttle</p>
                <p className="text-2xs text-muted">{busy ? t("Typing") : t("Grounded in this centre's timetable and prices")}</p>
              </div>
              {log.length > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    clear();
                    setErr(null);
                  }}
                  disabled={busy}
                  aria-label={t("Clear")}
                  title={t("Clear")}
                  className="grid size-9 place-items-center rounded-full text-muted hover:bg-wood hover:text-fg disabled:opacity-50"
                >
                  <RotateCcw className="size-4" />
                </button>
              ) : null}
              <Link
                to="/app/assistant"
                onClick={() => setOpen(false)}
                aria-label={t("Open full assistant")}
                className="grid size-9 place-items-center rounded-full text-muted hover:bg-wood hover:text-fg"
              >
                <Maximize2 className="size-4" />
              </Link>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t("Close")}
                className="grid size-9 place-items-center rounded-full text-muted hover:bg-wood hover:text-fg"
              >
                <X className="size-4" />
              </button>
            </div>
            <div ref={thread} className="grid max-h-[min(50vh,22rem,calc(100dvh-17rem))] min-h-24 content-start gap-2 overflow-y-auto p-3">
              <p className="mr-auto max-w-[85%] rounded-[var(--radius-lg)] bg-wood px-3 py-2 text-sm">{t(WELCOME)}</p>
              {log.map((m, i) => (
                <motion.p
                  key={i}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={cn(
                    "max-w-[85%] whitespace-pre-wrap rounded-[var(--radius-lg)] px-3 py-2 text-sm [overflow-wrap:anywhere]",
                    m.role === "me" ? "ml-auto bg-accent text-accent-fg" : "mr-auto bg-wood",
                  )}
                >
                  {m.text}
                </motion.p>
              ))}
              {busy ? <p className="mr-auto px-3 py-2 text-sm text-muted">{t("Typing")}…</p> : null}
              {err && !busy ? <p className="rounded-[var(--radius-lg)] bg-danger/10 px-3 py-2 text-sm text-danger">{err}</p> : null}
              {log.length === 0 && !busy ? (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {CHIPS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => void send(c)}
                      className="rounded-full border border-line px-3 py-1.5 text-xs hover:border-accent hover:bg-wood"
                    >
                      {t(c)}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <form
              className="flex gap-2 border-t border-line/70 p-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <input
                ref={input}
                value={q}
                onChange={(e) => setQ(e.target.value.slice(0, MAX_CHARS))}
                maxLength={MAX_CHARS}
                disabled={busy}
                placeholder={t("Ask about prices, opening hours, coaches…")}
                className="h-10 min-w-0 flex-1 rounded-full border border-line bg-bg px-3.5 text-sm outline-none focus:border-accent/40 focus:ring-2 focus:ring-accent/25"
              />
              <button
                type="submit"
                disabled={busy || q.trim().length < 2}
                aria-label={t("Send")}
                className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-fg disabled:opacity-50"
              >
                <Send className="size-4" />
              </button>
            </form>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? t("Close assistant") : t("Ask the assistant")}
        className="group relative grid size-[4.5rem] place-items-center rounded-full bg-surface/90 shadow-[0_12px_30px_-10px_rgba(0,0,0,0.6)] ring-1 ring-line backdrop-blur transition-transform duration-200 hover:scale-105 active:scale-95"
      >
        <Mascot size={58} thinking={busy} />
        {!open ? (
          <span className="pointer-events-none absolute right-full mr-3 whitespace-nowrap rounded-full bg-surface px-3 py-1.5 text-xs font-medium opacity-0 shadow ring-1 ring-line transition-opacity duration-200 group-hover:opacity-100">
            {t("Ask the assistant")}
          </span>
        ) : null}
      </button>
    </div>
  );
}
