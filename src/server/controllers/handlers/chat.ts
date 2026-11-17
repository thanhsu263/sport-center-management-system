/**
 * File: src/server/controllers/handlers/chat.ts
 * Vai trò: Xử lý nghiệp vụ trò chuyện 2 chiều giữa hội viên và nhân viên, quản lý danh bạ, tin nhắn và báo hiệu WebRTC.
 * Vị trí trong app: Controller handler ở backend, được src/server/controllers/router.ts điều phối qua các route /v1/conversations/* và /v1/rtc.
 */
import type { Sql } from "@/server/data/db";
import { err } from "../errors";
import { requireFlag } from "../../services/flags";
import { enqueue, readJson, str } from "../helpers";
import { limit, RULES } from "../ratelimit";
import type { PublicUser } from "../session";
import { one } from "../tx";

// Cấu trúc bản ghi cuộc trò chuyện giữa hội viên và nhân viên trong bảng conversations.
export type ConversationRow = {
  id: string;
  member_id: string;
  staff_id: string;
  created_at: string;
};

// Cấu trúc bản ghi tin nhắn trao đổi trong cuộc hội thoại từ bảng messages.
export type MessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  read_at: string | null;
};

/**
 * Check whether two users are permitted to chat with each other.
 *
 * Anyone signed in can message any other active account: members, coaches,
 * the desk and the manager alike. Only yourself and closed accounts are refused.
 */
/**
 * Làm gì: Kiểm tra quyền bắt đầu hoặc gửi tin nhắn giữa hai người dùng. Bất kỳ tài khoản đang hoạt động nào (active) đều có thể nhắn tin cho nhau, ngoại trừ tự nhắn cho chính mình hoặc nhắn cho tài khoản đã bị khóa/ngưng hoạt động.
 * Được gọi ở: src/server/controllers/handlers/chat.ts (trong createOrGetConversation và rtcSignalHandler), test runner (src/server/controllers/tx.test.ts).
 * @param sql Kết nối database trong transaction.
 * @param user Người dùng đang đăng nhập thực hiện thao tác.
 * @param otherUserId Mã định danh (UUID) của người dùng đối phương cần nhắn tin.
 * @returns Promise<void> hoàn thành nếu hợp lệ.
 * @throws Lỗi 400 (VALIDATION) "Cannot chat with yourself." nếu ID đối phương trùng với user hiện tại; lỗi 404 (NOT_FOUND) nếu không tìm thấy đối phương; lỗi 403 (FORBIDDEN) nếu tài khoản đối phương không ở trạng thái "active".
 */
export async function assertCanChat(sql: Sql, user: PublicUser, otherUserId: string): Promise<void> {
  // Bước 1: Ngăn người dùng tự nhắn tin cho chính mình.
  if (user.id === otherUserId) {
    throw err.validation("Cannot chat with yourself.");
  }
  // Bước 2: Kiểm tra đối phương có tồn tại và tài khoản đang ở trạng thái active (không bị khóa/ngưng hoạt động).
  const other = await one<{ id: string; status: string }>(sql, `select id, status from users where id = $1`, [otherUserId]);
  if (!other) throw err.notFound("User not found.");
  if (other.status !== "active") {
    throw err.forbidden("You do not have permission to message this person.");
  }
}

/**
 * People the signed-in user can start a chat with, found by name or member code.
 * Only name, role and avatar are returned: no phone or email.
 */
/**
 * Làm gì: Tìm kiếm danh bạ những người dùng mà tài khoản hiện tại có thể nhắn tin cùng (tìm theo tên hoặc mã hội viên), ưu tiên hiển thị nhân viên trước rồi đến hội viên.
 * Được gọi ở: src/server/controllers/router.ts (route GET /v1/conversations/contacts), test runner (src/server/controllers/tx.test.ts).
 * @param sql Kết nối database trong transaction.
 * @param user Người dùng đang đăng nhập (để loại trừ chính mình khỏi kết quả tìm kiếm).
 * @param url Đối tượng URL chứa query parameter "q" (từ khóa tìm kiếm).
 * @returns Danh sách tối đa 20 liên hệ gồm id, full_name, role, member_code và avatar_url (không trả về email, phone để bảo mật).
 * @throws Lỗi 403 nếu tính năng F6 (Two-way Chat) đang bị tắt.
 */
export async function searchContacts(sql: Sql, user: PublicUser, url: URL) {
  // Bước 1: Kiểm tra cờ tính năng F6 (Two-way Chat) phải được bật.
  await requireFlag(sql, "F6");
  // Bước 2: Đọc từ khóa tìm kiếm q từ URL, cắt khoảng trắng và giới hạn tối đa 60 ký tự để tránh chuỗi truy vấn quá dài.
  const q = (str(url.searchParams.get("q")) ?? "").trim().slice(0, 60);
  // Bước 3: Truy vấn danh bạ người dùng đang active (loại trừ chính mình), sắp xếp ưu tiên manager -> receptionist -> coach -> member.
  const rows = await sql.query<{ id: string; full_name: string; role: string; member_code: string | null; v: number | null }>(
    `select u.id, u.full_name, u.role, u.member_code,
            (select version from user_avatars a where a.user_id = u.id) as v
       from users u
      where u.id <> $1 and u.status = 'active'
        and ($2 = '' or u.full_name ilike '%' || $2 || '%' or coalesce(u.member_code, '') ilike '%' || $2 || '%')
      order by case u.role when 'manager' then 0 when 'receptionist' then 1 when 'coach' then 2 else 3 end, u.full_name
      limit 20`,
    [user.id, q],
  );
  // Bước 4: Định dạng danh sách trả về, tạo đường dẫn ảnh đại diện avatar_url nếu người dùng đã tải ảnh.
  return {
    items: rows.map((r) => ({
      id: r.id,
      full_name: r.full_name,
      role: r.role,
      member_code: r.member_code,
      avatar_url: r.v != null ? `/v1/users/${r.id}/avatar?v=${r.v}` : null,
    })),
  };
}

/**
 * List all conversations for the authenticated user, with last message and unread count.
 */
/**
 * Làm gì: Lấy danh sách toàn bộ các cuộc hội thoại của người dùng đang đăng nhập, kèm thông tin người trò chuyện cùng (peer), tin nhắn mới nhất và số lượng tin nhắn chưa đọc.
 * Được gọi ở: src/server/controllers/router.ts (route GET /v1/conversations), test runner (src/server/controllers/tx.test.ts).
 * @param sql Kết nối database trong transaction.
 * @param user Thông tin tài khoản người dùng đang đăng nhập từ session.
 * @returns Đối tượng { items, conversations } chứa danh sách các cuộc hội thoại sắp xếp theo thời gian tin nhắn mới nhất giảm dần.
 * @throws Lỗi 403 nếu tính năng F6 (Two-way Chat) đang bị tắt.
 */
export async function listConversations(sql: Sql, user: PublicUser) {
  // Bước 1: Kiểm tra cờ tính năng F6 (Two-way Chat) trong hệ thống.
  await requireFlag(sql, "F6");
  // Bước 2: Chuẩn bị câu lệnh SQL truy vấn các cuộc trò chuyện mà người dùng tham gia (là member_id hoặc staff_id), dùng LATERAL JOIN lấy tin nhắn cuối cùng và gom nhóm đếm số tin nhắn chưa đọc.
  const query = `
    select c.id, c.member_id, c.staff_id, c.created_at,
           case when c.member_id = $1 then u_staff.id else u_member.id end as peer_id,
           case when c.member_id = $1 then u_staff.full_name else u_member.full_name end as peer_name,
           case when c.member_id = $1 then u_staff.role else u_member.role end as peer_role,
           case when c.member_id = $1 then u_staff.member_code else u_member.member_code end as peer_member_code,
           (select version from user_avatars a where a.user_id = case when c.member_id = $1 then u_staff.id else u_member.id end) as peer_avatar_version,
           lm.id as last_msg_id,
           lm.body as last_msg_body,
           lm.created_at as last_msg_created_at,
           lm.sender_id as last_msg_sender_id,
           coalesce(unr.count, 0)::int as unread_count
      from conversations c
      join users u_member on u_member.id = c.member_id
      join users u_staff on u_staff.id = c.staff_id
      left join lateral (
        select m.id, m.body, m.created_at, m.sender_id
          from messages m
         where m.conversation_id = c.id
         order by m.created_at desc
         limit 1
      ) lm on true
      left join (
        select conversation_id, count(*)::int as count
          from messages
         where read_at is null and sender_id <> $1
         group by conversation_id
      ) unr on unr.conversation_id = c.id
     where c.member_id = $1 or c.staff_id = $1
     order by coalesce(lm.created_at, c.created_at) desc
  `;

  // Bước 3: Thực thi truy vấn lấy danh sách cuộc hội thoại của người dùng.
  const rows = await sql.query<{
    id: string;
    member_id: string;
    staff_id: string;
    created_at: string;
    peer_id: string;
    peer_name: string;
    peer_role: string;
    peer_member_code: string | null;
    peer_avatar_version: number | null;
    last_msg_id: string | null;
    last_msg_body: string | null;
    last_msg_created_at: string | null;
    last_msg_sender_id: string | null;
    unread_count: number;
  }>(query, [user.id]);

  // Bước 4: Chuẩn hóa dữ liệu trả về, ánh xạ thông tin đối phương (peer), tin nhắn cuối cùng (last_message) và số tin chưa đọc (unread_count).
  const items = rows.map((r) => {
    const avatarUrl = r.peer_avatar_version != null ? `/v1/users/${r.peer_id}/avatar?v=${r.peer_avatar_version}` : null;
    return {
      id: r.id,
      member_id: r.member_id,
      staff_id: r.staff_id,
      created_at: r.created_at,
      peer_id: r.peer_id,
      peer_name: r.peer_name,
      peer_role: r.peer_role,
      peer_phone: null,
      peer_member_code: r.peer_member_code,
      peer_avatar_url: avatarUrl,
      peer: {
        id: r.peer_id,
        full_name: r.peer_name,
        role: r.peer_role,
        member_code: r.peer_member_code,
        avatar_url: avatarUrl,
      },
    last_message: r.last_msg_id
      ? {
          id: r.last_msg_id,
          body: r.last_msg_body,
          created_at: r.last_msg_created_at,
          sender_id: r.last_msg_sender_id,
        }
      : null,
      unread_count: r.unread_count,
    };
  });

  return { items, conversations: items };
}

/**
 * Open or retrieve an existing conversation with another user.
 */
/**
 * Làm gì: Mở cuộc hội thoại mới hoặc lấy cuộc hội thoại đã có với người dùng khác. Quy ước lưu member_id và staff_id theo vai trò hoặc theo thứ tự bảng chữ cái nếu cùng vai trò để đảm bảo tính duy nhất.
 * Được gọi ở: src/server/controllers/router.ts (route POST /v1/conversations), test runner (src/server/controllers/tx.test.ts).
 * @param sql Kết nối database trong transaction.
 * @param user Thông tin tài khoản người dùng đang đăng nhập từ session.
 * @param request HTTP request chứa body JSON gồm recipient_id (hoặc target_id, staff_id, member_id).
 * @returns Đối tượng { conversation: row } chứa thông tin bản ghi cuộc trò chuyện.
 * @throws Lỗi 403 nếu tính năng F6 bị tắt hoặc không có quyền nhắn tin; lỗi 400 nếu thiếu ID người nhận; lỗi 404 nếu không tìm thấy người nhận.
 */
export async function createOrGetConversation(sql: Sql, user: PublicUser, request: Request) {
  // Bước 1: Kiểm tra cờ tính năng F6 và đọc ID người nhận từ body (hỗ trợ nhiều tên trường: recipient_id, target_id, staff_id, member_id).
  await requireFlag(sql, "F6");
  const body = await readJson(request);
  const otherId = str(body.recipient_id ?? body.target_id ?? body.staff_id ?? body.member_id);
  if (!otherId) {
    throw err.validation("Recipient ID is required.");
  }

  // Bước 2: Kiểm tra điều kiện nhắn tin (không tự nhắn cho mình, tài khoản đối phương đang active).
  await assertCanChat(sql, user, otherId);

  // Bước 3: Lấy vai trò (role) của đối phương để phân bổ vào hai cột member_id và staff_id.
  const other = await one<{ id: string; role: string }>(
    sql,
    `select id, role from users where id = $1`,
    [otherId],
  );
  if (!other) throw err.notFound("User not found.");

  // Bước 4: Phân loại cặp ID: nếu một bên là member và một bên là staff thì gán đúng vai trò; nếu cùng vai trò thì sắp xếp theo thứ tự ID để luôn tạo cặp duy nhất.
  let memberId = "";
  let staffId = "";

  if (user.role === "member" && other.role !== "member") {
    memberId = user.id;
    staffId = other.id;
  } else if (other.role === "member" && user.role !== "member") {
    memberId = other.id;
    staffId = user.id;
  } else {
    // Both staff or both members: use deterministic sorting for member_id/staff_id columns
    if (user.id < other.id) {
      memberId = user.id;
      staffId = other.id;
    } else {
      memberId = other.id;
      staffId = user.id;
    }
  }

  // Bước 5: Thêm cuộc hội thoại mới vào bảng conversations; nếu đã tồn tại cặp (member_id, staff_id) thì giữ nguyên bản ghi cũ (ON CONFLICT DO UPDATE).
  const row = await one<ConversationRow>(
    sql,
    `insert into conversations (member_id, staff_id)
     values ($1, $2)
     on conflict (member_id, staff_id) do update
       set created_at = conversations.created_at
     returning id, member_id, staff_id, created_at`,
    [memberId, staffId],
  );

  return { conversation: row };
}

/**
 * List paginated messages in a conversation.
 */
/**
 * Làm gì: Lấy danh sách tin nhắn trong một cuộc hội thoại theo phân trang (mặc định 30 tin nhắn mỗi trang), hỗ trợ tải các tin nhắn cũ hơn qua mốc thời gian "before".
 * Được gọi ở: src/server/controllers/router.ts (route GET /v1/conversations/:id/messages), test runner (src/server/controllers/tx.test.ts).
 * @param sql Kết nối database trong transaction.
 * @param user Thông tin tài khoản người dùng đang đăng nhập từ session.
 * @param convId Mã định danh cuộc hội thoại (UUID của conversations).
 * @param url Đối tượng URL chứa query parameter "before" (mốc thời gian để lấy các tin nhắn trước thời điểm đó).
 * @returns Đối tượng { items, has_more } gồm danh sách tin nhắn xếp theo thứ tự thời gian tăng dần và cờ báo còn tin nhắn cũ hơn không.
 * @throws Lỗi 403 nếu tính năng F6 bị tắt; lỗi 404 nếu không tìm thấy cuộc hội thoại hoặc người dùng không phải thành viên tham gia.
 */
export async function listMessages(sql: Sql, user: PublicUser, convId: string, url: URL) {
  // Bước 1: Kiểm tra cờ tính năng F6 (Two-way Chat) phải được bật.
  await requireFlag(sql, "F6");
  // Bước 2: Kiểm tra cuộc hội thoại tồn tại và người dùng hiện tại phải là thành viên trong cuộc hội thoại (member_id hoặc staff_id).
  const conv = await one<ConversationRow>(
    sql,
    `select id, member_id, staff_id, created_at
       from conversations
      where id = $1 and (member_id = $2 or staff_id = $2)`,
    [convId, user.id],
  );
  if (!conv) {
    throw err.notFound("Conversation not found.");
  }

  // Bước 3: Đọc tham số phân trang before từ URL và đặt giới hạn limitCount = 30 tin nhắn mỗi trang.
  const before = str(url.searchParams.get("before"));
  const limitCount = 30;

  // Bước 4: Truy vấn tin nhắn trong bảng messages có created_at < before, lấy tối đa 30 tin nhắn mới nhất giảm dần.
  const rows = await sql.query<MessageRow>(
    `select id, conversation_id, sender_id, body, created_at, read_at
       from messages
      where conversation_id = $1
        and ($2::timestamptz is null or created_at < $2::timestamptz)
      order by created_at desc
      limit $3`,
    [convId, before ?? null, limitCount],
  );

  // Bước 5: Đảo ngược mảng (reverse) để hiển thị tin nhắn theo thứ tự thời gian tăng dần trên giao diện chat và xác định còn tin cũ hay không.
  return {
    items: rows.slice().reverse(),
    has_more: rows.length === limitCount,
  };
}

/**
 * Send a message into a conversation (Idempotent by client message ID).
 */
/**
 * Làm gì: Gửi tin nhắn mới vào cuộc hội thoại giữa hội viên và nhân viên. Đảm bảo tính lũy hành (idempotent) theo ID tin nhắn do client sinh ra, lưu tin nhắn vào bảng messages và tạo thông báo in-app cho người nhận.
 * Được gọi ở: src/server/controllers/router.ts (route POST /v1/conversations/:id/messages), test runner (src/server/controllers/tx.test.ts).
 * @param sql Kết nối database trong transaction.
 * @param user Thông tin người dùng đăng nhập đang gửi tin nhắn.
 * @param convId Mã định danh cuộc hội thoại (UUID của conversations).
 * @param request HTTP request chứa body JSON gồm id (msgId từ client) và body (nội dung tin nhắn).
 * @returns Đối tượng { message: msg } chứa thông tin tin nhắn đã lưu.
 * @throws Lỗi 403 nếu tính năng F6 bị tắt; lỗi 429 nếu vượt rate limit chatMessage; lỗi 400 nếu thiếu ID, body rỗng hoặc dài quá 2000 ký tự; lỗi 404 nếu không tìm thấy cuộc hội thoại.
 */
export async function sendMessage(sql: Sql, user: PublicUser, convId: string, request: Request) {
  // Bước 1: Kiểm tra cờ tính năng F6 (chat nội bộ) và áp dụng rate limit gửi tin nhắn của người dùng.
  await requireFlag(sql, "F6");
  limit(`chat:${user.id}`, RULES.chatMessage, "chat messages");

  // Bước 2: Đọc dữ liệu JSON từ request và kiểm tra tính hợp lệ của tin nhắn (ID bắt buộc, nội dung không rỗng và tối đa 2000 ký tự).
  const body = await readJson(request);
  const msgId = str(body.id);
  const text = str(body.body);

  if (!msgId) throw err.validation("Message ID is required.");
  if (!text || text.length === 0) throw err.validation("Message body cannot be empty.");
  if (text.length > 2000) throw err.validation("Message exceeds maximum length of 2000 characters.");

  // Bước 3: Xác thực cuộc trò chuyện tồn tại và người dùng hiện tại là thành viên (member_id hoặc staff_id).
  const conv = await one<ConversationRow>(
    sql,
    `select id, member_id, staff_id, created_at
       from conversations
      where id = $1 and (member_id = $2 or staff_id = $2)`,
    [convId, user.id],
  );
  if (!conv) {
    throw err.notFound("Conversation not found.");
  }

  // Xác định người nhận: nếu người gửi là hội viên thì chuyển cho nhân viên, và ngược lại.
  const recipientId = user.id === conv.member_id ? conv.staff_id : conv.member_id;

  // Bước 4: Lưu tin nhắn vào bảng messages theo cơ chế idempotent (trùng id thì bỏ qua nhờ ON CONFLICT DO NOTHING).
  // Idempotent insert
  let msg = await one<MessageRow>(
    sql,
    `insert into messages (id, conversation_id, sender_id, body, created_at)
     values ($1, $2, $3, $4, now())
     on conflict (id) do nothing
     returning id, conversation_id, sender_id, body, created_at, read_at`,
    [msgId, convId, user.id, text],
  );

  // Bước 5: Xử lý kết quả lưu: nếu trùng ID do gửi lại (replay) thì lấy lại tin nhắn cũ; nếu là tin nhắn mới thì đẩy thông báo in-app cho đối phương.
  if (!msg) {
    // Existing message on idempotent replay
    msg = await one<MessageRow>(
      sql,
      `select id, conversation_id, sender_id, body, created_at, read_at
         from messages where id = $1`,
      [msgId],
    );
  } else {
    // New message: enqueue in-app notification for the recipient
    await enqueue(
      sql,
      "inapp",
      "chat_message",
      recipientId,
      {
        conversation_id: convId,
        sender_id: user.id,
        sender_name: user.full_name,
        message_id: msgId,
        preview: text.slice(0, 100),
      },
      `chat_msg|${msgId}`,
    );
  }

  return { message: msg };
}

/**
 * Mark messages in a conversation as read.
 */
/**
 * Làm gì: Đánh dấu tất cả tin nhắn chưa đọc trong cuộc hội thoại là đã đọc (read_at = now()), chỉ cập nhật các tin nhắn do đối phương gửi đến.
 * Được gọi ở: src/server/controllers/router.ts (route POST /v1/conversations/:id/read), test runner (src/server/controllers/tx.test.ts).
 * @param sql Kết nối database trong transaction.
 * @param user Thông tin tài khoản người dùng hiện tại từ session.
 * @param convId Mã định danh cuộc hội thoại (UUID của conversations).
 * @returns Đối tượng { ok: true } xác nhận cập nhật thành công.
 * @throws Lỗi 403 nếu tính năng F6 bị tắt; lỗi 404 nếu cuộc hội thoại không tồn tại hoặc người dùng không tham gia.
 */
export async function markConversationRead(sql: Sql, user: PublicUser, convId: string) {
  // Bước 1: Kiểm tra cờ tính năng F6 và xác thực người dùng có quyền trong cuộc hội thoại này.
  await requireFlag(sql, "F6");
  const conv = await one<ConversationRow>(
    sql,
    `select id from conversations where id = $1 and (member_id = $2 or staff_id = $2)`,
    [convId, user.id],
  );
  if (!conv) {
    throw err.notFound("Conversation not found.");
  }

  // Bước 2: Cập nhật thời điểm đọc (read_at = now()) cho các tin nhắn do đối phương gửi (sender_id khác user hiện tại).
  await sql.query(
    `update messages
        set read_at = now()
      where conversation_id = $1
        and sender_id <> $2
        and read_at is null`,
    [convId, user.id],
  );

  return { ok: true };
}

/**
 * The relay's own ceiling, charged before anything is parsed or validated.
 *
 * It has to come first: the per-room budget below cannot be charged until the
 * room is known, so without this a request rejected for a missing room would
 * cost nothing and could be repeated without limit.
 */
/**
 * Làm gì: Áp dụng trần giới hạn tần suất (rate limit) toàn cục cho endpoint WebRTC signaling của người dùng, trước khi phân tích body hay kiểm tra phòng.
 * Được gọi ở: src/server/controllers/handlers/chat.ts (trong rtcPollHandler và rtcSignalHandler).
 * @param userId Mã định danh của người dùng thực hiện gọi signaling.
 * @returns void
 * @throws Lỗi 429 nếu người dùng gọi signaling vượt quá hạn ngạch RULES.rtcEndpoint.
 */
function rtcEndpointQuota(userId: string): void {
  limit(`rtc:${userId}`, RULES.rtcEndpoint, "signaling calls");
}

/**
 * The signalling budget for one conversation.
 *
 * Counted per room, not per person: `RULES.rtcSignal` is sized from a single
 * room's poll rate, so keying on the user alone meant somebody with three tabs
 * open tripped it and lost P2P in all three. Both endpoints charge it, because
 * a poll, an offer, an answer and an ICE candidate are all calls against the
 * same relay and limiting only the poll left the write side open.
 *
 * `leave` is deliberately exempt. It is teardown, the client fires it with
 * `keepalive` and ignores the result, so refusing it would strand the departing
 * peer in the roster until it ages out and leave everyone else dialling
 * somebody who has gone. It still pays the endpoint ceiling above.
 */
/**
 * Làm gì: Áp dụng hạn ngạch tín hiệu WebRTC signaling riêng cho từng phòng chat, tính theo cặp (userId, room).
 * Được gọi ở: src/server/controllers/handlers/chat.ts (trong rtcPollHandler và rtcSignalHandler).
 * @param userId Mã định danh người dùng gửi/nhận tín hiệu.
 * @param room Tên phòng hoặc mã cuộc hội thoại WebRTC.
 * @returns void
 * @throws Lỗi 429 nếu gọi signaling trong cùng phòng vượt quá hạn ngạch RULES.rtcSignal.
 */
function rtcRoomQuota(userId: string, room: string): void {
  limit(`rtc:${userId}:${room}`, RULES.rtcSignal, "signaling calls");
}

/**
 * WebRTC Signaling GET relay /api/rtc?room=...&peer=...&name=...&since=...
 */
/**
 * Làm gì: Endpoint polling HTTP GET phục vụ WebRTC signaling. Cập nhật nhịp tim (heartbeat) của peer, dọn dẹp các peer cũ (>20s), trả về danh sách peer đang online và các tín hiệu gửi tới peer này.
 * Được gọi ở: src/server/controllers/router.ts (route GET /v1/rtc hoặc GET /api/rtc), test runner (src/server/controllers/tx.test.ts).
 * @param sql Kết nối database trong transaction.
 * @param user Thông tin người dùng đăng nhập hiện tại từ session.
 * @param request HTTP request chứa query parameters: room, peer, name, since.
 * @returns Đối tượng { peers, signals } gồm danh sách peer trong phòng và mảng tín hiệu WebRTC mới.
 * @throws Lỗi 403 nếu F6 bị tắt, peer ID không khớp user.id, hoặc user không thuộc phòng; lỗi 429 nếu vượt rate limit; lỗi 400 nếu thiếu tham số room hoặc peer.
 */
export async function rtcPollHandler(sql: Sql, user: PublicUser, request: Request) {
  // Bước 1: Kiểm tra hạn ngạch signaling chung và cờ tính năng F6 trước khi đọc tham số.
  rtcEndpointQuota(user.id);
  await requireFlag(sql, "F6");
  // Bước 2: Đọc các tham số từ query string (room, peer, name, since) và áp dụng rate limit cho phòng chat.
  const url = new URL(request.url);
  const room = str(url.searchParams.get("room"));
  const peer = str(url.searchParams.get("peer"));
  const name = str(url.searchParams.get("name")) ?? user.full_name;
  const since = Number(url.searchParams.get("since") ?? 0);

  if (!room) throw err.validation("Room parameter is required.");
  if (!peer) throw err.validation("Peer parameter is required.");
  rtcRoomQuota(user.id, room);

  // Bước 3: Xác thực bảo mật: caller phải trùng với user đăng nhập và phải là thành viên trong cuộc hội thoại.
  // Caller must match authenticated user
  if (peer !== user.id) {
    throw err.forbidden("Peer ID mismatch.");
  }

  // Room check: verify user is part of the conversation
  const conv = await one<{ id: string }>(
    sql,
    `select id from conversations where id = $1 and (member_id = $2 or staff_id = $2)`,
    [room, user.id],
  );
  if (!conv) {
    throw err.forbidden("Not permitted in this chat room.");
  }

  // Bước 4: Cập nhật nhịp tim (heartbeat) của peer vào bảng rtc_peers để đánh dấu người dùng vẫn đang online.
  // Upsert peer heartbeat
  await sql.query(
    `insert into rtc_peers (room, peer_id, name, last_seen)
     values ($1, $2, $3, now())
     on conflict (room, peer_id) do update
       set name = excluded.name, last_seen = now()`,
    [room, peer, name],
  );

  // Bước 5: Xóa các peer không còn hoạt động (> 20 giây không gửi heartbeat) và lấy danh sách các peer còn online trong phòng.
  // Clean stale peers (> 20s) and fetch alive peers. Scoped to this room: the
  // unscoped version swept every room in the centre on every poll, so one busy
  // conversation was doing housekeeping for all the others several times a
  // second.
  //
  // The trade: a room nobody polls again keeps its last rows. That is a handful
  // per conversation, bounded and dormant, and the next poll on that room
  // clears them — but it does mean nothing sweeps rooms that go quiet for good.
  await sql.query(`delete from rtc_peers where room = $1 and last_seen < now() - interval '20 seconds'`, [room]);

  const peers = await sql.query<{ id: string; name: string }>(
    `select peer_id as id, name from rtc_peers where room = $1 and last_seen >= now() - interval '20 seconds'`,
    [room],
  );

  // Bước 6: Lấy các tín hiệu WebRTC mới được gửi tới peer này có ID lớn hơn mốc since (sắp xếp tăng dần).
  // Fetch incoming signals for this peer
  const signals = await sql.query<{ id: number; from: string; kind: string; payload: unknown }>(
    `select id, from_peer as "from", kind, payload
       from rtc_signals
      where room = $1 and to_peer = $2 and id > $3
      order by id asc`,
    [room, peer, since],
  );

  // Bước 7: Dọn dẹp các tín hiệu WebRTC cũ đã hết hạn (> 60 giây) trong phòng này để tránh phình dữ liệu bảng rtc_signals.
  // Clean expired signals (> 60s), this room's only — same reason as above.
  await sql.query(`delete from rtc_signals where room = $1 and created_at < now() - interval '60 seconds'`, [room]);

  return { peers, signals };
}

/**
 * WebRTC Signaling POST relay /api/rtc
 */
/**
 * Làm gì: Endpoint HTTP POST xử lý chuyển tiếp tín hiệu WebRTC (offer, answer, ICE candidate) hoặc xử lý khi peer rời phòng (op = "leave").
 * Được gọi ở: src/server/controllers/router.ts (route POST /v1/rtc hoặc POST /api/rtc), test runner (src/server/controllers/tx.test.ts).
 * @param sql Kết nối database trong transaction.
 * @param user Thông tin người dùng đăng nhập hiện tại từ session.
 * @param request HTTP request chứa body JSON với thông tin tín hiệu hoặc lệnh rời phòng.
 * @returns Đối tượng { ok: true } xác nhận đã lưu hoặc xử lý tín hiệu thành công.
 * @throws Lỗi 403 nếu F6 bị tắt, from không khớp user.id, hoặc user không thuộc phòng; lỗi 429 nếu vượt rate limit; lỗi 400 nếu thiếu trường bắt buộc.
 */
export async function rtcSignalHandler(sql: Sql, user: PublicUser, request: Request) {
  // Bước 1: Áp dụng trần rate limit endpoint và kiểm tra cờ tính năng F6 trước khi đọc body.
  rtcEndpointQuota(user.id);
  await requireFlag(sql, "F6");
  const body = await readJson(request);

  // Bước 2: Xử lý thao tác rời phòng (op = "leave"): xóa ngay peer khỏi bảng rtc_peers để đối phương không tiếp tục gọi.
  if (body.op === "leave") {
    const room = str(body.room);
    const peer = str(body.peer);
    // No per-room charge here: see `rtcRoomQuota` on why teardown is exempt.
    if (room && peer && peer === user.id) {
      await sql.query(`delete from rtc_peers where room = $1 and peer_id = $2`, [room, peer]);
    }
    return { ok: true };
  }

  // Bước 3: Đọc các trường tín hiệu WebRTC bắt buộc (room, from, to, kind) và áp dụng rate limit cho phòng.
  const room = str(body.room);
  const from = str(body.from);
  const to = str(body.to);
  const kind = str(body.kind);
  const payload = body.payload;

  if (!room || !from || !to || !kind) {
    throw err.validation("Missing required signaling fields.");
  }
  rtcRoomQuota(user.id, room);

  // Bước 4: Kiểm tra bảo mật: người gửi tín hiệu (from) phải là user đăng nhập và phải thuộc cuộc trò chuyện.
  if (from !== user.id) {
    throw err.forbidden("Sender ID mismatch.");
  }

  // Verify room membership
  const conv = await one<{ id: string }>(
    sql,
    `select id from conversations where id = $1 and (member_id = $2 or staff_id = $2)`,
    [room, user.id],
  );
  if (!conv) {
    throw err.forbidden("Not permitted in this chat room.");
  }

  // Bước 5: Lưu bản ghi tín hiệu vào bảng rtc_signals dưới dạng JSONB để peer nhận tải về trong lượt polling tiếp theo.
  await sql.query(
    `insert into rtc_signals (room, from_peer, to_peer, kind, payload)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [room, from, to, kind, JSON.stringify(payload)],
  );

  return { ok: true };
}
