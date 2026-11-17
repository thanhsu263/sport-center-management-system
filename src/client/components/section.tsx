/**
 * File: src/client/components/section.tsx
 * Vai trò: Định nghĩa các component hiển thị tiêu đề chuẩn hóa (SectionTitle, CardTitle) và từ điển metadata (icon, hint) cho toàn bộ ứng dụng Arena 3.
 * Vị trí trong app: Được dùng rộng rãi ở các trang giao diện client (app, desk, coach, manager) để hiển thị tiêu đề phân đoạn và thẻ thông tin nhất quán, tự động tra cứu icon và hỗ trợ đa ngôn ngữ i18n.
 */
import {
  Bell,
  BookOpenCheck,
  Building2,
  CalendarClock,
  ClipboardCheck,
  DoorOpen,
  Dumbbell,
  History,
  Inbox,
  Landmark,
  type LucideIcon,
  Map,
  MessageSquareText,
  NotebookPen,
  Receipt,
  ScrollText,
  StickyNote,
  Ticket,
  ToggleRight,
  TrendingUp,
  Undo2,
  UserPlus,
  Wallet,
  Zap,
} from "lucide-react";
import { cn } from "@/client/lib/cn";
import { t, tk } from "@/client/lib/i18n";

/**
 * Every section heading gets a small icon and, where the screen does not already explain the
 * section in a paragraph of its own, one plain line saying what is in it. Looked up by title so
 * the ~40 headings across the app stay consistent without each one restating its copy.
 * The keys are the English titles (what callers pass); the text shown is translated at render.
 */
const META: Record<string, { icon: LucideIcon; hint?: string }> = {
  "Quick actions": { icon: Zap, hint: tk("Shortcuts to the things you do most.") },
  Notifications: { icon: Bell, hint: tk("Latest receipts, booking changes and replies from reception.") },
  "Up next": { icon: CalendarClock, hint: tk("Your coming sessions, with the plan for each.") },
  Homework: { icon: BookOpenCheck },
  "Coach reviews": { icon: MessageSquareText, hint: tk("Written feedback your coach left for you.") },
  "Recent sessions": { icon: History, hint: tk("The sessions attended most recently.") },
  Level: { icon: TrendingUp, hint: tk("Where this student is now, per sport.") },
  "Progress review": { icon: ClipboardCheck },
  "Coach notes": { icon: StickyNote },
  "Through the gate today": { icon: DoorOpen, hint: tk("Everyone who has checked in today.") },
  "Out on loan": { icon: Dumbbell, hint: tk("Gear that is out right now. Returning it puts the stock back.") },
  "New member": { icon: UserPlus },
  "Requests from the app": { icon: Inbox, hint: tk("Messages members sent from the app that are waiting for an answer.") },
  "Sell another plan": { icon: Ticket, hint: tk("Pick a plan to add to this member's account.") },
  Payments: { icon: Wallet },
  Today: { icon: CalendarClock, hint: tk("Courts this member has booked for today.") },
  "Transfers to check": { icon: Landmark },
  "Waiting for payment": { icon: Wallet },
  "Refunds waiting for a manager": { icon: Undo2 },
  Receipts: { icon: Receipt },
  Activity: { icon: ScrollText, hint: tk("Every change made by staff: what, who and when.") },
  Features: { icon: ToggleRight, hint: tk("Switch parts of the app on or off for the whole centre.") },
  Courts: { icon: Map },
  "Centre details": { icon: Building2, hint: tk("The centre's legal name, address and tax code.") },
  Results: { icon: ClipboardCheck },
  "Session plan": { icon: NotebookPen },
};

/** META is keyed by the English title; a caller that already translated it still finds its entry. */
function metaFor(text: string) {
  // Bước 1: Tra cứu trực tiếp theo khóa tiếng Anh nếu text truyền vào chưa qua dịch
  if (META[text]) return META[text];
  // Bước 2: Dự phòng trường hợp caller đã gọi hàm dịch t(text), duyệt tìm key tiếng Anh tương ứng trong từ điển META
  const en = Object.keys(META).find((k) => t(k) === text);
  return en ? META[en] : undefined;
}

/**
 * Làm gì: Component React hiển thị tiêu đề cho một phân đoạn (section) trong trang, kèm icon đại diện và dòng mô tả phụ (hint). Tự động tra cứu icon và mô tả mặc định từ bảng META theo tên tiêu đề hoặc cho phép tùy biến qua props.
 * Được gọi ở: Hầu hết các trang và component giao diện của Arena 3:
 * - src/routes/app.index.tsx, src/routes/app.train.tsx, src/routes/app.points.tsx
 * - src/routes/desk.index.tsx, src/routes/desk.gate.tsx, src/routes/desk.gear.tsx, src/routes/desk.payments.tsx
 * - src/routes/coach.earnings.tsx, src/routes/coach.student.$id.tsx
 * - src/routes/manager.audit.tsx, src/routes/manager.prices.tsx, src/routes/manager.settings.tsx
 * - src/client/components/coach-training.tsx, src/client/components/menu-settings.tsx, src/client/components/report-panels.tsx
 * @param props Đối tượng thuộc tính cấu hình phân đoạn:
 *   - text: Tiêu đề phân đoạn (chuỗi tiếng Anh hoặc đã dịch qua t()), dùng hiển thị và tra cứu trong META
 *   - className: Lớp CSS tùy biến (Tailwind) cho container bên ngoài
 *   - icon: Biểu tượng LucideIcon tùy chọn, ghi đè icon mặc định tìm thấy từ META
 *   - hint: Dòng mô tả ngắn tùy chọn, ghi đè câu mô tả mặc định từ META
 *   - id: Mã định danh HTML id gắn vào thẻ h2 để làm neo liên kết hoặc phục vụ accessibility
 * @returns Phần tử JSX biểu diễn tiêu đề phân đoạn gồm icon, thẻ h2 và dòng mô tả phụ nếu có
 * @throws Không có
 */
export function SectionTitle({
  text,
  className,
  icon,
  hint,
  id,
}: {
  id?: string;
  text: string;
  className?: string;
  icon?: LucideIcon;
  hint?: string;
}) {
  // Bước 1: Tra cứu icon và hint mặc định từ từ điển META theo tiêu đề section
  const meta = metaFor(text);
  // Bước 2: Xác định icon và hint hiển thị, ưu tiên giá trị props truyền riêng trước khi dùng giá trị mặc định từ META
  const Icon = icon ?? meta?.icon;
  const line = hint ?? meta?.hint;
  // Bước 3: Render khối tiêu đề section gồm icon nền nhạt (accent), thẻ h2 tiêu đề và dòng mô tả phụ (muted)
  return (
    <div className={cn("flex items-center gap-3 font-display text-2xl", className)}>
      {Icon ? (
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-md)] bg-accent/10 text-accent-2"
        >
          <Icon className="size-5" strokeWidth={1.8} />
        </span>
      ) : null}
      <div className="min-w-0">
        <h2 id={id} className="text-balance">
          {t(text)}
        </h2>
        {line ? <p className="mt-0.5 font-sans text-sm font-normal text-muted">{t(line)}</p> : null}
      </div>
    </div>
  );
}

/** Title for a card or chart: icon, a readable name and one line on what it shows. */
export function CardTitle({
  icon: Icon,
  title,
  hint,
  className,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  className?: string;
}) {
  // Render tiêu đề card gồm icon kích thước nhỏ (size-4), tên thẻ và dòng mô tả phụ
  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      <span
        aria-hidden="true"
        className="grid size-8 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-accent/10 text-accent-2"
      >
        <Icon className="size-4" strokeWidth={1.9} />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold leading-tight">{t(title)}</p>
        {hint ? <p className="mt-0.5 text-xs leading-snug text-muted">{t(hint)}</p> : null}
      </div>
    </div>
  );
}
