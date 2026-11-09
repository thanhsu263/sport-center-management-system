-- 0043_session_charges.sql: session attendance charging and prepaid sessions
create table if not exists session_charges (
  session_id uuid not null references sessions(id),
  user_id uuid not null references users(id),
  subscription_id uuid references subscriptions(id),
  charged boolean not null,
  at timestamptz not null default now(),
  primary key (session_id, user_id)
);

alter table enrollments add column if not exists prepaid_sessions int not null default 0;

-- Transition 4.5: set prepaid_sessions = 1 for confirmed enrollments with active session plans
-- covering the class sport and future scheduled sessions
update enrollments e
   set prepaid_sessions = 1
  from classes c
 where e.class_id = c.id
   and e.status = 'confirmed'
   and exists (
     select 1 from subscriptions s
      where s.user_id = e.user_id
        and s.status = 'active'
        and s.session_left is not null
        and (s.sport_scope = c.sport or s.sport_scope = 'all')
        and s.start_on <= current_date
        and s.end_on >= current_date
   )
   and exists (
     select 1 from sessions ss
      where ss.class_id = e.class_id
        and ss.status = 'scheduled'
        and ss.start_at > now()
   );
