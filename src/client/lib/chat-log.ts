/**
 * File: src/client/lib/chat-log.ts
 * Vai trò: Quản lý lịch sử hội thoại của trợ lý ảo AI (assistant) theo từng tài khoản người dùng (userId).
 * Vị trí trong app: Lưu trữ tin nhắn trong localStorage (tối đa 50 tin), tự động đồng bộ giữa widget nổi và trang /app/assistant qua CustomEvent cùng tab và storage event giữa các tab.
 */
import { useCallback, useEffect, useState } from "react";

/** One line of the assistant conversation as both the widget and the full page keep it. */
export type ChatMsg = { role: "me" | "bot"; text: string; source?: "gemini" | "xai" | "rules" };

/** Enough for a conversation to survive a reload without the key growing for ever. */
const LIMIT = 50;
/** Same-tab signal: the widget and /app/assistant can both be mounted at once. */
const EVENT = "arena3:chat-log";

/**
 * Làm gì: Tạo khóa lưu trữ (storage key) định danh cho lịch sử chat của người dùng trong localStorage.
 * Được gọi ở: Nội bộ file src/client/lib/chat-log.ts (hàm read, write và sự kiện onStorage trong hook useChatLog).
 * @param userId ID của người dùng hiện tại
 * @returns Khóa lưu trữ chuỗi dạng `arena3:chat:${userId}`
 */
const keyFor = (userId: string) => `arena3:chat:${userId}`;

/**
 * Làm gì: Đọc và parse lịch sử tin nhắn từ localStorage theo userId, lọc bỏ dữ liệu sai cấu trúc và lấy tối đa 50 tin gần nhất.
 * Được gọi ở: Nội bộ file src/client/lib/chat-log.ts (hook useChatLog trong useEffect khi khởi tạo state hoặc nhận sự kiện đồng bộ).
 * @param userId ID của người dùng cần lấy lịch sử trò chuyện
 * @returns Mảng các tin nhắn ChatMsg hợp lệ, trả về mảng rỗng nếu không có dữ liệu hoặc gặp lỗi parse
 */
function read(userId: string): ChatMsg[] {
  try {
    // Bước 1: Lấy chuỗi JSON lịch sử chat từ localStorage theo key của người dùng
    const raw = window.localStorage.getItem(keyFor(userId));
    if (!raw) return [];
    // Bước 2: Parse chuỗi JSON và kiểm tra tính hợp lệ của mảng dữ liệu
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Bước 3: Lọc các phần tử đúng kiểu ChatMsg (role là 'me'|'bot' và text là chuỗi), chỉ giữ lại tối đa 50 tin mới nhất
    return parsed
      .filter(
        (m): m is ChatMsg =>
          !!m && typeof m === "object" && (m.role === "me" || m.role === "bot") && typeof m.text === "string",
      )
      .slice(-LIMIT);
  } catch {
    // Trả về mảng rỗng nếu localStorage bị chặn (ví dụ chế độ ẩn danh) hoặc JSON lỗi cú pháp để tránh crash app
    return [];
  }
}

/**
 * Làm gì: Lưu mảng tin nhắn mới nhất vào localStorage và phát CustomEvent để các view khác trong cùng tab cập nhật tức thì.
 * Được gọi ở: Nội bộ file src/client/lib/chat-log.ts (hàm append và clear trong hook useChatLog).
 * @param userId ID của người dùng cần lưu lịch sử chat
 * @param log Danh sách tin nhắn ChatMsg cần lưu trữ
 */
function write(userId: string, log: ChatMsg[]) {
  // Bước 1: Ghi mảng tin nhắn (giới hạn tối đa 50 tin mới nhất) vào localStorage
  try {
    window.localStorage.setItem(keyFor(userId), JSON.stringify(log.slice(-LIMIT)));
  } catch {
    // Private mode or a full quota: the conversation still works, it just won't survive a reload.
  }
  // Bước 2: Bắn CustomEvent trên window mang theo userId để các component khác cùng tab (như widget góc màn hình và trang /app/assistant) cập nhật kịp thời
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: userId }));
  } catch {
    /* no window events */
  }
}

/**
 * The member's assistant conversation, kept in localStorage per user so a reload keeps it and the
 * corner widget and the full page share one thread. Starts empty on the server and on first render
 * (so hydration matches), then loads once the user is known.
 */
export function useChatLog(userId: string | null | undefined) {
  // Khởi tạo state rỗng trên server và lần render đầu tiên để tránh lỗi lệch khớp hydration giữa server và client
  const [log, setLogState] = useState<ChatMsg[]>([]);

  useEffect(() => {
    // Bước 1: Nếu chưa có userId (chưa đăng nhập hoặc session đang tải), reset log về mảng rỗng và không lắng nghe sự kiện
    if (!userId) {
      setLogState([]);
      return;
    }
    // Bước 2: Khi đã xác định được userId, đọc lịch sử chat đã lưu từ localStorage và nạp vào state
    setLogState(read(userId));
    // Bước 3: Định nghĩa hàm đọc lại dữ liệu mới nhất từ storage để cập nhật state
    const sync = () => setLogState(read(userId));
    // Lắng nghe CustomEvent để đồng bộ ngay khi có tin nhắn mới phát sinh từ component khác trong cùng tab
    const onLocal = (e: Event) => {
      if ((e as CustomEvent<string>).detail === userId) sync();
    };
    // Lắng nghe storage event để đồng bộ dữ liệu khi người dùng chat ở tab trình duyệt khác (key là null khi bị xóa toàn bộ)
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === keyFor(userId)) sync();
    };
    // Bước 4: Đăng ký các event listener vào window để đồng bộ tin nhắn cùng tab và khác tab
    window.addEventListener(EVENT, onLocal);
    window.addEventListener("storage", onStorage);
    // Dọn dẹp các event listener khi unmount hoặc khi userId thay đổi để tránh rò rỉ bộ nhớ
    return () => {
      window.removeEventListener(EVENT, onLocal);
      window.removeEventListener("storage", onStorage);
    };
  }, [userId]);

  /**
   * Appends to the thread. Other mounted views follow through the same-tab event, so each view's
   * state is current; writing from it (not a fresh read) keeps history alive when storage is off.
   */
  const append = useCallback(
    (msg: ChatMsg) => {
      setLogState((l) => {
        const next = [...l, msg].slice(-LIMIT);
        // Idempotent, so a doubled updater call in strict mode writes the same value twice.
        if (userId) queueMicrotask(() => write(userId, next));
        return next;
      });
    },
    [userId],
  );

  // Hàm xóa toàn bộ lịch sử trò chuyện cả trong state và localStorage cho người dùng hiện tại
  const clear = useCallback(() => {
    setLogState([]);
    if (userId) write(userId, []);
  }, [userId]);

  // Trả về danh sách tin nhắn hiện tại cùng các hàm append và clear cho component giao diện sử dụng
  return { log, append, clear };
}
