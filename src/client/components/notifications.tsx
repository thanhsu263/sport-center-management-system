/**
 * File: src/client/components/notifications.tsx
 * Vai trò: Quản lý định dạng nội dung, điều hướng và hiển thị danh sách thông báo hệ thống (notifications).
 * Vị trí trong app: Chạy ở client, chuyển đổi các template và payload từ API (/me/notifications) thành giao diện thân thiện cho hội viên và nhân viên; cung cấp component NotificationList dùng trong shell (chuông thông báo) và các trang /app/notifications, /alerts.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Button, ButtonLink, Card, Modal } from "@/client/components/ui";
import { money, when } from "@/client/components/shell";
import { Stagger, StaggerItem } from "@/client/components/motion";
import { apiPost, openInvoice } from "@/client/arena3/client";
import { levelLabel, sportLabel } from "@/shared/arena3/labels";
import { locale, t, tServer } from "@/client/lib/i18n";

/**
 * Cấu trúc bản ghi thông báo hệ thống trả về từ API /me/notifications:
 * - id: Mã định danh duy nhất của thông báo.
 * - template: Tên mẫu thông báo (ví dụ: booking_confirmed, payment_receipt...).
 * - payload: Dữ liệu chi tiết đính kèm theo từng loại template.
 * - sent_at: Thời điểm gửi thông báo (chuỗi ISO).
 * - read_at: Thời điểm người dùng đọc thông báo, hoặc null nếu chưa đọc.
 */
export type Notification = {
  id: string;
  template: string;
  payload: unknown;
  sent_at: string;
  read_at: string | null;
};

// Cấu trúc nội dung thông báo hoàn chỉnh sau khi xử lý để hiển thị lên giao diện (tiêu đề, nội dung, link điều hướng, hóa đơn)
type Content = {
  title: string;
  body: string;
  /** Somewhere to go from here, when there is somewhere. */
  link?: { to: string; label: string };
  receipt?: { invoice_id: string };
};

/**
 * Làm gì: Ép kiểu an toàn dữ liệu payload từ unknown về Record<string, unknown>, tránh lỗi runtime khi truy cập thuộc tính nếu payload null/undefined.
 * Được gọi ở: src/client/components/notifications.tsx trong hàm notificationContent.
 * @param p Dữ liệu payload thô của thông báo chưa rõ cấu trúc.
 * @returns Đối tượng Record<string, unknown> chứa các thuộc tính của payload, hoặc object rỗng {} nếu không phải object.
 */
function asObj(p: unknown): Record<string, unknown> {
  // Kiểm tra p tồn tại và là object hợp lệ, nếu không trả về object rỗng để tránh lỗi truy cập thuộc tính
  return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
}

/**
 * Làm gì: Chuyển đổi mã phương thức thanh toán sang chuỗi nhãn hiển thị đa ngôn ngữ thân thiện với người dùng.
 * Được gọi ở: src/client/components/notifications.tsx trong hàm notificationContent (template payment_receipt).
 * @param m Mã phương thức thanh toán (cash, card, transfer, quota...).
 * @returns Nhãn hiển thị phương thức thanh toán đã được bản địa hóa qua hàm t().
 */
function methodLabel(m: unknown) {
  // Chuyển mã sang string và đối chiếu để lấy nhãn hiển thị tương ứng đã được dịch
  switch (String(m)) {
    case "cash":
      return t("cash");
    case "card":
      return t("card");
    case "transfer":
      return t("bank transfer");
    case "quota":
      return t("plan hours");
    default:
      return t("payment");
  }
}

/** Short date and time for a class session, in the language that is on. */
/**
 * Làm gì: Định dạng chuỗi ngày giờ ISO thành chuỗi ngắn gọn theo múi giờ Việt Nam (Asia/Ho_Chi_Minh) và ngôn ngữ hiển thị hiện tại.
 * Được gọi ở: src/client/components/notifications.tsx trong hàm notificationContent (xử lý các template shift_overdue, maintenance_session, class_changed).
 * @param iso Chuỗi thời gian định dạng ISO 8601 của buổi học hoặc sự kiện.
 * @returns Chuỗi ngày giờ rút gọn (thứ, ngày, tháng, giờ, phút) hiển thị trên giao diện.
 */
function sessionWhen(iso: string) {
  // Định dạng ngày giờ ngắn theo ngôn ngữ người dùng đang chọn và cố định múi giờ Asia/Ho_Chi_Minh
  return new Date(iso).toLocaleString(locale(), {
    timeZone: "Asia/Ho_Chi_Minh",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * What a notification says once it is opened. The row in the list only has room
 * for a headline; this is the sentence behind it, built from what was stored.
 */
/**
 * Làm gì: Biên dịch và chuẩn hóa nội dung hiển thị của thông báo (tiêu đề, nội dung chi tiết, nút liên kết, hóa đơn) từ template và payload thô.
 * Được gọi ở: src/client/components/notifications.tsx trong component NotificationList (khi render từng thẻ thông báo và khi mở modal chi tiết).
 * @param n Đối tượng thông báo rút gọn chỉ gồm trường template và payload (Pick<Notification, "template" | "payload">).
 * @returns Đối tượng Content chứa tiêu đề (title), nội dung (body), liên kết điều hướng (link) và hóa đơn (receipt) nếu có.
 */
export function notificationContent(n: Pick<Notification, "template" | "payload">): Content {
  // Bước 1: Trích xuất an toàn payload sang object và lấy mã code tham chiếu (nếu có)
  const p = asObj(n.payload);
  const code = typeof p.code === "string" ? p.code : null;
  // Bước 2: Phân loại theo mẫu thông báo (template) để tạo tiêu đề, nội dung và các liên kết hành động
  switch (n.template) {
    // Ca thu ngân mở quá 16 giờ: cảnh báo nhân viên/quản lý kiểm đếm tiền mặt thực tế và kết ca
    case "shift_overdue":
      return {
        title: t("Till shift open over 16 hours"),
        body: t("Shift {id}, opened {when}, is still open. Review the till and close the shift with a counted cash amount and a reason.", {
          id: String(p.shift_id), when: sessionWhen(String(p.opened_at)),
        }),
      };
    // Chênh lệch tiền két: số tiền thu ngân kiểm đếm thực tế lệch so với số tiền hệ thống ghi nhận
    case "shift_cash_difference":
      return {
        title: t("Till cash difference"),
        body: t("Shift {id} closed with {declared} counted cash; the recorded cash total is {actual}.", {
          id: String(p.shift_id), declared: money(Number(p.cash_declared_vnd)), actual: money(Number(p.cash_system_vnd)),
        }),
      };
    // Buổi học bị ảnh hưởng do bảo trì sân: nhắc quản lý/HLV dời lịch hoặc hủy buổi học
    case "maintenance_session":
      return {
        title: t("Class session needs attention"),
        body: t("The court for the session on {when} is closed for maintenance. Move or cancel this session; it is still scheduled.", {
          when: sessionWhen(String(p.start_at)),
        }),
      };
    // Lớp học không đủ số lượng tối thiểu trước 24 giờ: thông báo quản lý vào xem xét mở hay hủy lớp
    case "class_below_minimum":
      return {
        title: t("Class below minimum"),
        body: t("Class {code} starts within 24 hours with {count} confirmed seats; the minimum is {minimum}. Review the class and decide whether to run it or cancel it.", {
          code: String(p.code ?? ""), count: Number(p.confirmed_count), minimum: Number(p.min_enrolled),
        }),
        link: { to: "/manager/classes", label: t("Review classes") },
      };
    // Biên lai thanh toán: hiển thị số tiền, phương thức trả và kèm thông tin invoice_id để mở hóa đơn
    case "payment_receipt": {
      const amount = typeof p.amount_vnd === "number" ? money(p.amount_vnd) : null;
      const method = methodLabel(p.method);
      return {
        title: amount ? t("Receipt · {amount}", { amount }) : t("Payment receipt"),
        body: amount
          ? t("We took {amount} by {method}. The receipt is saved to your account.", { amount, method })
          : t("A payment was recorded by {method}. The receipt is saved to your account.", { method }),
        receipt: typeof p.invoice_id === "string" ? { invoice_id: p.invoice_id } : undefined,
      };
    }
    // Đặt sân thành công: nhắc hội viên xuất trình mã thành viên khi check-in tại quầy lễ tân
    case "booking_confirmed":
      return {
        title: t("Booking confirmed"),
        body: code
          ? t("Booking {code} is confirmed. Show your member code at the desk when you arrive.", { code })
          : t("Your booking is confirmed. Show your member code at the desk when you arrive."),
        link: { to: "/app/book", label: t("See my bookings") },
      };
    // Hủy đặt sân: nếu có hoàn tiền thì theo quy định trung tâm sẽ nhận tiền mặt trực tiếp tại quầy
    case "booking_cancelled":
      return {
        title: t("Booking cancelled"),
        body: Number(p.refund_vnd) > 0 ? t("Collect your refund in cash at the front desk.") : t("Nothing is refunded."),
        link: { to: "/app/book", label: t("Book another court") },
      };
    // Đổi giờ đặt sân: xác nhận khung giờ mới đã đổi và thông báo slot cũ đã được giải phóng
    case "booking_rescheduled":
      return {
        title: t("Booking moved"),
        body: code
          ? t("Booking {code} now has the new court time you picked. The old slot is free again.", { code })
          : t("Your booking now has the new court time you picked. The old slot is free again."),
        link: { to: "/app/book", label: t("See my bookings") },
      };
    // Đã ghi nhận chuyển khoản: giữ chỗ tạm thời trong thời gian chờ lễ tân kiểm tra và duyệt tiền vào tài khoản
    case "transfer_requested":
      return {
        title: t("Transfer noted"),
        body: t("Reception has been told you sent the bank transfer. They will confirm it when it reaches the account, and your booking is held until then."),
        link: { to: "/app/book", label: t("See my bookings") },
      };
    // Không tìm thấy giao dịch chuyển khoản: nhắc khách kiểm tra lại số tiền/nội dung hoặc đóng tiền mặt trước khi hết hạn hold
    case "transfer_rejected":
      return {
        title: t("We could not find your transfer"),
        body: t("The transfer did not reach the account. Check the amount and the reference, or pay at the desk. Your hold keeps running until it ends."),
        link: { to: "/app/book", label: t("See my bookings") },
      };
    // Giữ chỗ sắp hết hạn hoặc đã hết hạn: giải phóng slot sân về trạng thái trống nếu không thanh toán kịp
    case "hold_expiring":
    case "hold_expired":
      return {
        title: n.template === "hold_expired" ? t("Your hold ended") : t("Your hold is about to expire"),
        body:
          n.template === "hold_expired"
            ? t("The hold ran out before payment, so the court was released.")
            : t("Pay before the hold ends or the court goes back on sale."),
        link: { to: "/app/book", label: t("Open bookings") },
      };
    // Thay đổi thông tin lớp học: chuẩn bị lý do, đường dẫn xem lớp và phân loại theo loại biến động (kind)
    case "class_changed": {
      const reason =
        typeof p.reason === "string" && p.reason !== "conflict" ? ` ${t("Reason: {reason}.", { reason: p.reason })}` : "";
      const link = { to: "/app/classes", label: t("Open my classes") };
      // Phân loại chi tiết từng trường hợp biến động của buổi học hoặc khóa học
      switch (p.kind) {
        // Hủy một buổi học: nêu rõ thời gian buổi hủy và số tiền hoàn mặt tại quầy (nếu có)
        case "session_cancelled":
          return {
            title: t("A class session was cancelled"),
            body: `${typeof p.start === "string" ? t("The session on {when} will not run.", { when: sessionWhen(p.start) }) : t("A session will not run.")}${typeof p.refund_vnd === "number" && p.refund_vnd > 0 ? ` ${t("Collect your {amount} refund in cash at the front desk.", { amount: money(p.refund_vnd) })}` : ""}${reason}`,
            link,
          };
        // Dời lịch buổi học sang khung thời gian mới
        case "session_moved":
          return {
            title: t("A class session moved"),
            body: `${typeof p.start === "string" ? t("It now starts {when}.", { when: sessionWhen(p.start) }) : t("It has a new time.")}${reason}`,
            link,
          };
        // Đổi huấn luyện viên phụ trách cho các buổi học tiếp theo
        case "coach_changed":
          return {
            title: t("Your class has a new coach"),
            body: `${typeof p.coach_name === "string" ? t("{name} takes the sessions still to come.", { name: p.coach_name }) : t("A new coach takes the sessions still to come.")}${reason}`,
            link,
          };
        // Hủy toàn bộ khóa học: hướng dẫn học viên đến quầy lễ tân nhận lại tiền mặt
        case "class_cancelled":
          return {
            title: t("A class was cancelled"),
            body: `${typeof p.refund_vnd === "number" && p.refund_vnd > 0 ? t("The class has been cancelled. Collect your {amount} refund in cash at the front desk.", { amount: money(p.refund_vnd) }) : t("The class has been cancelled.")}${reason}`,
            link,
          };
        // Các trường hợp đổi lịch chung hoặc trùng lịch sân/huấn luyện viên (conflict)
        default:
          return {
            title: t("Class schedule changed"),
            body:
              p.reason === "conflict"
                ? t("A class could not be scheduled for one date because the court or coach was busy.")
                : t("A class you are in has changed. Open your classes to see the new time and court."),
            link,
          };
      }
    }
    // Gói tập hội viên sắp hết hạn trong vòng 7 ngày: nhắc gia hạn để giữ chính sách ưu đãi giá
    case "sub_expiring":
      return {
        title: t("Plan expiring soon"),
        body: t("Your plan ends within a week. Renew to keep your discount."),
        link: { to: "/app/plans", label: t("See plans") },
      };
    // Suất học trống từ danh sách chờ (waitlist): thông báo để hội viên vào xác nhận nhận chỗ trước khi hết hạn
    case "waitlist_offer":
      return {
        title: t("A class seat opened"),
        body: t("Claim it before the offer runs out. A paid class then holds the seat while you pay."),
        link: { to: "/app/classes", label: t("Claim the seat") },
      };
    // Ngoại lệ thanh toán lớp học: tiền đã vào nhưng chưa vào chỗ (trùng tiền, lớp hủy, hết hạn giữ chỗ); báo nhân viên xử lý thủ công
    case "class_payment_exception": {
      const name = typeof p.member_name === "string" ? p.member_name : t("A member");
      const cls =
        typeof p.sport === "string"
          ? `${sportLabel(p.sport)}${typeof p.level === "string" ? ` · ${levelLabel(p.level)}` : ""}`
          : t("a class");
      // Xác định nguyên nhân lỗi thanh toán: trùng lặp (duplicate), đã hủy chỗ (released), lớp đã hủy hoặc hết hạn giữ chỗ
      const why =
        p.reason === "duplicate"
          ? t("{name} paid twice for the same seat in {class}.", { name, class: cls })
          : p.reason === "released"
            ? t("{name} paid for a seat in {class} after releasing it.", { name, class: cls })
            : p.reason === "class_cancelled"
              ? t("{name} paid for a seat in {class}, which is cancelled.", { name, class: cls })
              : t("{name} paid for a seat in {class} after the hold ended, and the class is full.", { name, class: cls });
      return {
        title: t("Class payment to sort out"),
        body: `${why} ${t("The money is posted but bought no seat. Settle it with them by hand.")}`,
        link:
          typeof p.user_id === "string"
            ? { to: `/desk/member/${p.user_id}`, label: t("Open their profile") }
            : { to: "/desk/payments", label: t("Open payments") },
      };
    }
    // Suất chờ đã có người khác nhận: thông báo hội viên vẫn giữ vị trí ưu tiên số 1 khi có suất trống tiếp theo
    case "waitlist_seat_taken":
      return {
        title: t("Seat taken"),
        body: t("The open seat was taken. You are still first in line when another opens."),
        link: { to: "/app/classes", label: t("View class") },
      };
    // Thông báo hoàn tiền được chấp thuận: hiển thị số tiền mặt nhận tại quầy lễ tân và ghi chú đi kèm (nếu có).
    case "refund_approved": {
      const amount = typeof p.amount_vnd === "number" ? money(p.amount_vnd) : null;
      const subject = amount
        ? t("Your refund of {amount} was paid in cash at the front desk.", { amount })
        : t("Your refund was paid in cash at the front desk.");
      return {
        title: t("Refund approved"),
        body: `${subject}${typeof p.note === "string" ? ` ${t("Note: {note}", { note: p.note })}` : ""}`,
      };
    }
    // Thông báo từ chối hoàn tiền: hiển thị mã yêu cầu và lý do từ chối, hoặc nhắc liên hệ lễ tân để biết thêm chi tiết.
    case "refund_rejected":
      return {
        title: t("Refund declined"),
        body: `${code ? t("Your refund request {code} was declined.", { code }) : t("Your refund request was declined.")} ${
          typeof p.note === "string" ? t("Reason: {note}", { note: p.note }) : t("Ask reception if you want to know why.")
        }`,
      };
    // Thông báo bài tập về nhà mới: hiển thị tên bài tập, huấn luyện viên giao bài, hạn nộp và gắn liên kết sang /app/train.
    case "homework_assigned": {
      const coach = typeof p.coach_name === "string" ? p.coach_name : t("Your coach");
      const title = typeof p.title === "string" ? p.title : t("homework");
      return {
        title: t("New homework"),
        body:
          typeof p.due_on === "string"
            ? t("{coach} set “{title}”, due {date}.", { coach, title, date: p.due_on })
            : t("{coach} set “{title}”.", { coach, title }),
        link: { to: "/app/train", label: t("Open my progress") },
      };
    }
    // Đánh giá từ huấn luyện viên: hiển thị nhận xét về môn học và số tuần luyện tập gần nhất, kèm liên kết tới /app/train.
    case "review_added": {
      const coach = typeof p.coach_name === "string" ? p.coach_name : t("Your coach");
      const sport = typeof p.sport === "string" ? sportLabel(p.sport).toLowerCase() : null;
      const weeks = typeof p.period_weeks === "number" ? p.period_weeks : null;
      const body =
        weeks !== null
          ? sport
            ? t("{coach} reviewed your last {weeks} weeks of {sport}.", { coach, weeks, sport })
            : t("{coach} reviewed your last {weeks} weeks.", { coach, weeks })
          : sport
            ? t("{coach} reviewed your recent weeks of {sport}.", { coach, sport })
            : t("{coach} reviewed your recent weeks.", { coach });
      return {
        title: t("Your coach wrote a review"),
        body,
        link: { to: "/app/train", label: t("Read it") },
      };
    }
    // Cảnh báo học viên nghỉ liên tiếp: nhắc huấn luyện viên kiểm tra học viên vắng mặt nhiều buổi, dẫn tới hồ sơ học viên.
    case "absent_streak": {
      const name = typeof p.member_name === "string" ? p.member_name : t("A student");
      const streak = typeof p.streak === "number" ? p.streak : t("several");
      const sport = typeof p.sport === "string" ? sportLabel(p.sport).toLowerCase() : null;
      return {
        title: t("Three absences in a row"),
        body: sport
          ? t("{name} has missed {streak} sessions in a row of {sport}. Worth a check-in.", { name, streak, sport })
          : t("{name} has missed {streak} sessions in a row. Worth a check-in.", { name, streak }),
        link: typeof p.user_id === "string" ? { to: `/coach/student/${p.user_id}`, label: t("Open their profile") } : undefined,
      };
    }
    // Tin nhắn trò chuyện mới: hiển thị tên người gửi, trích đoạn tin nhắn và liên kết mở trực tiếp hội thoại chat.
    case "chat_message": {
      const senderName = typeof p.sender_name === "string" ? p.sender_name : t("Someone");
      const preview = typeof p.preview === "string" ? p.preview : "";
      const convId = typeof p.conversation_id === "string" ? p.conversation_id : "";
      return {
        title: t("New message from {name}", { name: senderName }),
        body: preview || t("You have a new message."),
        link: convId ? { to: `/chat?conv=${convId}`, label: t("Open chat") } : { to: "/chat", label: t("Open chat") },
      };
    }
    // Lễ tân phản hồi yêu cầu hỗ trợ: hiển thị nội dung trả lời từ lễ tân và dẫn về mục hỗ trợ trong trang /account.
    case "ticket_replied":
      return {
        title: t("Reception replied"),
        body: typeof p.reply === "string" && p.reply ? p.reply : t("Reception answered your message."),
        link: { to: "/account", label: t("Open Support") },
      };
    // Closed with no answer written. Without this case the default below would
    // show the member the words "ticket closed".
    case "ticket_closed":
      return {
        title: t("Reception closed your request"),
        body: t("The front desk has dealt with it. Send another note if it is still open for you."),
        link: { to: "/account", label: t("Open Support") },
      };
    // Trường hợp mặc định cho các template chưa định nghĩa riêng: chuyển dấu gạch dưới thành khoảng trắng làm tiêu đề.
    default:
      return { title: n.template.replace(/_/g, " "), body: t("Open your account for the details.") };
  }
}

/**
 * The member's notifications. A row opens its content and marks itself read;
 * unread ones carry a dot, so a glance at the list says what is new.
 */
/**
 * Làm gì: Hiển thị danh sách thông báo của người dùng với chỉ báo chưa đọc, hỗ trợ mở Modal xem chi tiết và đánh dấu đã đọc.
 * Được gọi ở:
 * - src/client/components/shell.tsx (menu chuông thông báo)
 * - src/routes/app.index.tsx (dashboard hội viên)
 * - src/routes/app.notifications.tsx (trang danh sách thông báo)
 * - src/routes/alerts.tsx (trang cảnh báo hệ thống)
 * @param items Danh sách các đối tượng thông báo Notification cần hiển thị.
 * @param onRead Callback nhận mảng ID thông báo vừa được đánh dấu đã đọc để component cha đồng bộ state.
 * @param limit Số lượng thông báo tối đa hiển thị ban đầu trước khi người dùng bấm xem thêm (mặc định 8).
 * @param hideRead Cờ ẩn các thông báo đã đọc, chỉ hiển thị thông báo chưa đọc (mặc định false).
 * @param hideMarkAll Cờ ẩn nút "Đánh dấu tất cả đã đọc" (mặc định false).
 * @returns Khối JSX danh sách thẻ thông báo kèm nút mở rộng và Modal xem chi tiết.
 */
export function NotificationList({
  items,
  onRead,
  limit = 8,
  hideRead = false,
  hideMarkAll = false,
}: {
  items: Notification[];
  /** Called with the ids just marked read, so the owner can update its copy. */
  onRead: (ids: string[]) => void;
  limit?: number;
  /** Tuck read notifications out of the list. Nothing is deleted. */
  hideRead?: boolean;
  /** The owner shows its own "Mark all as read". */
  hideMarkAll?: boolean;
}) {
  // Bước 1: Khởi tạo state lưu thông báo đang mở xem chi tiết trong Modal và cờ hiển thị tất cả.
  const [open, setOpen] = useState<Notification | null>(null);
  const [all, setAll] = useState(false);
  // Bước 2: Lọc danh sách thông báo chưa đọc và tính toán số lượng mục hiển thị dựa theo limit.
  const unread = items.filter((n) => !n.read_at);
  const visible = hideRead ? unread : items;
  const shown = all ? visible : visible.slice(0, limit);

  /**
   * Làm gì: Mở Modal hiển thị chi tiết một thông báo và đồng bộ trạng thái đã đọc với server.
   * Được gọi ở: src/client/components/notifications.tsx (sự kiện onClick của từng thẻ thông báo trong NotificationList).
   * @param n Đối tượng Notification được chọn để xem chi tiết.
   * @returns Promise không trả về giá trị (void).
   */
  async function openOne(n: Notification) {
    // Bước 1: Lưu thông báo vào state để mở Modal xem chi tiết.
    setOpen(n);
    // Bước 2: Bỏ qua nếu thông báo đã đọc; nếu chưa đọc, tiếp tục xử lý đánh dấu đã đọc.
    if (n.read_at) return;
    // Bước 3: Cập nhật lạc quan (optimistic update) lên component cha để xóa ngay chấm chưa đọc.
    onRead([n.id]);
    // Bước 4: Gọi API /me/notifications/read để lưu trạng thái đã đọc lên server; bỏ qua lỗi mạng để không chặn việc xem.
    try {
      await apiPost("/me/notifications/read", { id: n.id });
    } catch {
      // The flag is a convenience; failing to save it must not block reading.
    }
  }

  // Bước 3: Phân giải nội dung chi tiết (tiêu đề, nội dung, đường dẫn liên kết) của thông báo đang mở trong Modal.
  const c = open ? notificationContent(open) : null;

  // Bước 4: Render giao diện danh sách thông báo dạng thẻ có animation Stagger, nút xem thêm và Modal chi tiết.
  return (
    <>
      {unread.length && !hideMarkAll ? (
        <div className="mt-2 flex items-center justify-between text-sm text-muted">
          <span>{t("{n} unread", { n: unread.length })}</span>
          <button
            type="button"
            className="hit underline"
            onClick={async () => {
              const ids = unread.map((n) => n.id);
              try {
                await apiPost("/me/notifications/read", {});
                // Only once the server has them as read, so the list never claims more than is true.
                onRead(ids);
              } catch (e) {
                toast.error(e instanceof Error ? tServer(e.message) : t("Could not mark them read"));
              }
            }}
          >
            {t("Mark all read")}
          </button>
        </div>
      ) : null}
      {/* One card per message. The headline alone repeated ("Booking confirmed" twelve times), so
          each card also carries the first line of what it says: which court, when, how much. */}
      <Stagger className="mt-3 grid gap-2" gap={0.04}>
        {shown.map((n) => {
          const row = notificationContent(n);
          return (
            <StaggerItem key={n.id}>
              <button type="button" className="block w-full text-left" onClick={() => void openOne(n)}>
                <Card className="flex items-start gap-3 p-4 transition-colors duration-200 hover:bg-wood/40">
                  <span
                    aria-label={n.read_at ? t("Read") : t("Unread")}
                    className={`mt-1.5 size-2 shrink-0 rounded-full ${n.read_at ? "bg-transparent" : "bg-accent"}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className={`truncate text-sm text-fg ${n.read_at ? "" : "font-semibold"}`}>{row.title}</span>
                      <span className="shrink-0 text-xs tabular-nums text-subtle">{when(n.sent_at)}</span>
                    </span>
                    {row.body ? <span className="mt-0.5 line-clamp-1 block text-sm text-muted">{row.body}</span> : null}
                  </span>
                </Card>
              </button>
            </StaggerItem>
          );
        })}
      </Stagger>
      {visible.length > limit ? (
        <div className="mt-2 flex justify-center">
          <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
            {all ? t("Show fewer") : t("Show all {n}", { n: visible.length })}
          </Button>
        </div>
      ) : null}
      <Modal
        open={!!open}
        onClose={() => setOpen(null)}
        title={c?.title ?? t("Notification")}
        footer={
          <div className="flex justify-end gap-2">
            {c?.receipt ? (
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await openInvoice(c.receipt!.invoice_id);
                  } catch (e) {
                    toast.error(e instanceof Error ? tServer(e.message) : t("The receipt would not open"));
                  }
                }}
              >
                {t("Open receipt")}
              </Button>
            ) : null}
            {c?.link ? (
              <ButtonLink to={c.link.to} variant="outline" onClick={() => setOpen(null)}>
                {c.link.label}
              </ButtonLink>
            ) : null}
            <Button variant="ghost" onClick={() => setOpen(null)}>
              {t("Close")}
            </Button>
          </div>
        }
      >
        {open && c ? (
          <div className="grid gap-2 text-sm">
            <p>{c.body}</p>
            <p className="text-xs text-muted">{when(open.sent_at)}</p>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
