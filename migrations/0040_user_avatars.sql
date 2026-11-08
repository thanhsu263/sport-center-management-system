-- 0040_user_avatars.sql: one profile photo per user, set by that user.
create table if not exists user_avatars (
  user_id    uuid primary key references users(id) on delete cascade,
  bytes      bytea not null,
  mime       text not null check (mime in ('image/jpeg','image/png','image/webp')),
  width      int not null check (width between 64 and 4096),
  height     int not null check (height between 64 and 4096),
  version    int not null default 1,
  updated_at timestamptz not null default now()
);
