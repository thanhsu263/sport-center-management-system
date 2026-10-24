-- 0038_chat.sql: Two-way chat between member and coach/staff, plus WebRTC signaling

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references users(id) on delete cascade,
  staff_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint uq_conversations_member_staff unique(member_id, staff_id)
);

create index if not exists idx_conversations_member on conversations(member_id);
create index if not exists idx_conversations_staff on conversations(staff_id);

create table if not exists messages (
  id uuid primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id uuid not null references users(id) on delete cascade,
  body text not null check (length(body) <= 2000),
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists idx_messages_conversation_created on messages(conversation_id, created_at);
create index if not exists idx_messages_unread on messages(conversation_id, read_at) where read_at is null;

create table if not exists rtc_peers (
  room text not null,
  peer_id text not null,
  name text not null default '',
  last_seen timestamptz not null default now(),
  primary key (room, peer_id)
);

create table if not exists rtc_signals (
  id bigserial primary key,
  room text not null,
  from_peer text not null,
  to_peer text not null,
  kind text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_rtc_signals_poll on rtc_signals(room, to_peer, id);
create index if not exists idx_rtc_signals_cleanup on rtc_signals(created_at);
