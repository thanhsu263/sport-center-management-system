import type { Sql } from "@/server/data/db";
import { err } from "../errors";
import { requireFlag } from "../../services/flags";
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
 *
 * Anyone signed in can message any other active account: members, coaches,
 * the desk and the manager alike. Only yourself and closed accounts are refused.
 */
export async function assertCanChat(sql: Sql, user: PublicUser, otherUserId: string): Promise<void> {
  if (user.id === otherUserId) {
    throw err.validation("Cannot chat with yourself.");
  }
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
export async function searchContacts(sql: Sql, user: PublicUser, url: URL) {
  await requireFlag(sql, "F6");
  const q = (str(url.searchParams.get("q")) ?? "").trim().slice(0, 60);
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
export async function listConversations(sql: Sql, user: PublicUser) {
  await requireFlag(sql, "F6");
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
export async function createOrGetConversation(sql: Sql, user: PublicUser, request: Request) {
  await requireFlag(sql, "F6");
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
  await requireFlag(sql, "F6");
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
  await requireFlag(sql, "F6");
  limit(`chat:${user.id}`, RULES.chatMessage, "chat messages");

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
  await requireFlag(sql, "F6");
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
 * The relay's own ceiling, charged before anything is parsed or validated.
 *
 * It has to come first: the per-room budget below cannot be charged until the
 * room is known, so without this a request rejected for a missing room would
 * cost nothing and could be repeated without limit.
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
function rtcRoomQuota(userId: string, room: string): void {
  limit(`rtc:${userId}:${room}`, RULES.rtcSignal, "signaling calls");
}

/**
 * WebRTC Signaling GET relay /api/rtc?room=...&peer=...&name=...&since=...
 */
export async function rtcPollHandler(sql: Sql, user: PublicUser, request: Request) {
  rtcEndpointQuota(user.id);
  await requireFlag(sql, "F6");
  const url = new URL(request.url);
  const room = str(url.searchParams.get("room"));
  const peer = str(url.searchParams.get("peer"));
  const name = str(url.searchParams.get("name")) ?? user.full_name;
  const since = Number(url.searchParams.get("since") ?? 0);

  if (!room) throw err.validation("Room parameter is required.");
  if (!peer) throw err.validation("Peer parameter is required.");
  rtcRoomQuota(user.id, room);

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

  // Fetch incoming signals for this peer
  const signals = await sql.query<{ id: number; from: string; kind: string; payload: unknown }>(
    `select id, from_peer as "from", kind, payload
       from rtc_signals
      where room = $1 and to_peer = $2 and id > $3
      order by id asc`,
    [room, peer, since],
  );

  // Clean expired signals (> 60s), this room's only — same reason as above.
  await sql.query(`delete from rtc_signals where room = $1 and created_at < now() - interval '60 seconds'`, [room]);

  return { peers, signals };
}

/**
 * WebRTC Signaling POST relay /api/rtc
 */
export async function rtcSignalHandler(sql: Sql, user: PublicUser, request: Request) {
  rtcEndpointQuota(user.id);
  await requireFlag(sql, "F6");
  const body = await readJson(request);

  if (body.op === "leave") {
    const room = str(body.room);
    const peer = str(body.peer);
    // No per-room charge here: see `rtcRoomQuota` on why teardown is exempt.
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
  rtcRoomQuota(user.id, room);

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
