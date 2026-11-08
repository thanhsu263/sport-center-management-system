import type { Sql } from "@/lib/db";
import { err } from "../errors";
import { enqueue, readJson, str } from "../helpers";
import { limit, RULES } from "../ratelimit";
import type { PublicUser } from "../session";
import { one } from "../tx";

export type ConversationRow = {
  id: string;
  member_id: string;
  staff_id: string;
  created_at: string;
};

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
 * Rules:
 * - Receptionist and Manager can message anyone.
 * - Member can only message Coach if the member is enrolled (confirmed) in an active class taught by the coach.
 * - Coach can only message Member if the member is enrolled (confirmed) in an active class taught by the coach.
 * - Members cannot message other members directly.
 */
export async function assertCanChat(sql: Sql, user: PublicUser, otherUserId: string): Promise<void> {
  if (user.id === otherUserId) {
    throw err.validation("Cannot chat with yourself.");
  }

  // Manager and receptionist can chat with anyone
  if (user.role === "manager" || user.role === "receptionist") {
    const target = await one<{ id: string }>(sql, `select id from users where id = $1`, [otherUserId]);
    if (!target) throw err.notFound("User not found.");
    return;
  }

  const other = await one<{ id: string; role: string; status: string }>(
    sql,
    `select id, role, status from users where id = $1`,
    [otherUserId],
  );
  if (!other) throw err.notFound("User not found.");

  // If other user is receptionist or manager, any member/coach can message them
  if (other.role === "manager" || other.role === "receptionist") {
    return;
  }

  // Member <-> Coach relationship check
  const memberId = user.role === "member" ? user.id : other.role === "member" ? other.id : null;
  const coachId = user.role === "coach" ? user.id : other.role === "coach" ? other.id : null;

  if (memberId && coachId) {
    const row = await one<{ ok: number }>(
      sql,
      `select 1 as ok
         from enrollments e
         join classes c on c.id = e.class_id
        where e.user_id = $1
          and c.coach_id = $2
          and e.status = 'confirmed'
          and c.status <> 'cancelled'
        limit 1`,
      [memberId, coachId],
    );
    if (!row) {
      throw err.forbidden("You can only message coaches of classes you are enrolled in.");
    }
    return;
  }

  throw err.forbidden("You do not have permission to message this person.");
}

/**
 * List all conversations for the authenticated user, with last message and unread count.
 */
export async function listConversations(sql: Sql, user: PublicUser) {
  const query = `
    select c.id, c.member_id, c.staff_id, c.created_at,
           case when c.member_id = $1 then u_staff.id else u_member.id end as peer_id,
           case when c.member_id = $1 then u_staff.full_name else u_member.full_name end as peer_name,
           case when c.member_id = $1 then u_staff.role else u_member.role end as peer_role,
           case when c.member_id = $1 then u_staff.member_code else u_member.member_code end as peer_member_code,
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

  const rows = await sql.query<{
    id: string;
    member_id: string;
    staff_id: string;
    created_at: string;
    peer_id: string;
    peer_name: string;
    peer_role: string;
    peer_member_code: string | null;
    last_msg_id: string | null;
    last_msg_body: string | null;
    last_msg_created_at: string | null;
    last_msg_sender_id: string | null;
    unread_count: number;
  }>(query, [user.id]);

  const items = rows.map((r) => ({
    id: r.id,
    member_id: r.member_id,
    staff_id: r.staff_id,
    created_at: r.created_at,
    peer_id: r.peer_id,
    peer_name: r.peer_name,
    peer_role: r.peer_role,
    peer_phone: null,
    peer_member_code: r.peer_member_code,
    peer: {
      id: r.peer_id,
      full_name: r.peer_name,
      role: r.peer_role,
      member_code: r.peer_member_code,
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
  }));

  return { items, conversations: items };
}

/**
 * Open or retrieve an existing conversation with another user.
 */
export async function createOrGetConversation(sql: Sql, user: PublicUser, request: Request) {
  const body = await readJson(request);
  const otherId = str(body.recipient_id ?? body.target_id ?? body.staff_id ?? body.member_id);
  if (!otherId) {
    throw err.validation("Recipient ID is required.");
  }

  await assertCanChat(sql, user, otherId);

  const other = await one<{ id: string; role: string }>(
    sql,
    `select id, role from users where id = $1`,
    [otherId],
  );
  if (!other) throw err.notFound("User not found.");

  let memberId = "";
  let staffId = "";

  if (user.role === "member") {
    memberId = user.id;
    staffId = other.id;
  } else if (other.role === "member") {
    memberId = other.id;
    staffId = user.id;
  } else {
    // Both are staff: use deterministic sorting for member_id/staff_id columns
    if (user.id < other.id) {
      memberId = user.id;
      staffId = other.id;
    } else {
      memberId = other.id;
      staffId = user.id;
    }
  }

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
export async function listMessages(sql: Sql, user: PublicUser, convId: string, url: URL) {
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

  const before = str(url.searchParams.get("before"));
  const limitCount = 30;

  const rows = await sql.query<MessageRow>(
    `select id, conversation_id, sender_id, body, created_at, read_at
       from messages
      where conversation_id = $1
        and ($2::timestamptz is null or created_at < $2::timestamptz)
      order by created_at desc
      limit $3`,
    [convId, before ?? null, limitCount],
  );

  return {
    items: rows.slice().reverse(),
    has_more: rows.length === limitCount,
  };
}

/**
 * Send a message into a conversation (Idempotent by client message ID).
 */
export async function sendMessage(sql: Sql, user: PublicUser, convId: string, request: Request) {
  limit(`chat:${user.id}`, { windowMs: 10_000, limit: 25 }, "chat messages");

  const body = await readJson(request);
  const msgId = str(body.id);
  const text = str(body.body);

  if (!msgId) throw err.validation("Message ID is required.");
  if (!text || text.length === 0) throw err.validation("Message body cannot be empty.");
  if (text.length > 2000) throw err.validation("Message exceeds maximum length of 2000 characters.");

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

  const recipientId = user.id === conv.member_id ? conv.staff_id : conv.member_id;

  // Idempotent insert
  let msg = await one<MessageRow>(
    sql,
    `insert into messages (id, conversation_id, sender_id, body, created_at)
     values ($1, $2, $3, $4, now())
     on conflict (id) do nothing
     returning id, conversation_id, sender_id, body, created_at, read_at`,
    [msgId, convId, user.id, text],
  );

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
export async function markConversationRead(sql: Sql, user: PublicUser, convId: string) {
  const conv = await one<ConversationRow>(
    sql,
    `select id from conversations where id = $1 and (member_id = $2 or staff_id = $2)`,
    [convId, user.id],
  );
  if (!conv) {
    throw err.notFound("Conversation not found.");
  }

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
 * WebRTC Signaling GET relay /api/rtc?room=...&peer=...&name=...&since=...
 */
export async function rtcPollHandler(sql: Sql, user: PublicUser, request: Request) {
  const url = new URL(request.url);
  const room = str(url.searchParams.get("room"));
  const peer = str(url.searchParams.get("peer"));
  const name = str(url.searchParams.get("name")) ?? user.full_name;
  const since = Number(url.searchParams.get("since") ?? 0);

  if (!room) throw err.validation("Room parameter is required.");
  if (!peer) throw err.validation("Peer parameter is required.");

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

  // Upsert peer heartbeat
  await sql.query(
    `insert into rtc_peers (room, peer_id, name, last_seen)
     values ($1, $2, $3, now())
     on conflict (room, peer_id) do update
       set name = excluded.name, last_seen = now()`,
    [room, peer, name],
  );

  // Clean stale peers (> 20s) and fetch alive peers
  await sql.query(`delete from rtc_peers where last_seen < now() - interval '20 seconds'`);

  const peers = await sql.query<{ id: string; name: string }>(
    `select peer_id as id, name from rtc_peers where room = $1 and last_seen >= now() - interval '20 seconds'`,
    [room],
  );

  // Fetch incoming signals for this peer
  const signals = await sql.query<{ id: number; from: string; kind: string; payload: unknown }>(
    `select id, from_peer as "from", kind, payload
       from rtc_signals
      where room = $1 and to_peer = $2 and id > $3
      order by id asc`,
    [room, peer, since],
  );

  // Clean expired signals (> 60s)
  await sql.query(`delete from rtc_signals where created_at < now() - interval '60 seconds'`);

  return { peers, signals };
}

/**
 * WebRTC Signaling POST relay /api/rtc
 */
export async function rtcSignalHandler(sql: Sql, user: PublicUser, request: Request) {
  const body = await readJson(request);

  if (body.op === "leave") {
    const room = str(body.room);
    const peer = str(body.peer);
    if (room && peer && peer === user.id) {
      await sql.query(`delete from rtc_peers where room = $1 and peer_id = $2`, [room, peer]);
    }
    return { ok: true };
  }

  const room = str(body.room);
  const from = str(body.from);
  const to = str(body.to);
  const kind = str(body.kind);
  const payload = body.payload;

  if (!room || !from || !to || !kind) {
    throw err.validation("Missing required signaling fields.");
  }

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

  await sql.query(
    `insert into rtc_signals (room, from_peer, to_peer, kind, payload)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [room, from, to, kind, JSON.stringify(payload)],
  );

  return { ok: true };
}
