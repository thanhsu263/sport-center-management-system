-- 0045_sell_classes.sql: sell classes directly. A class has a price, an enrollment can be a timed hold.

alter table classes add column if not exists price_vnd int null check (price_vnd >= 0);
alter table enrollments add column if not exists hold_until timestamptz null;
alter table enrollments add column if not exists price_vnd int null;
alter table enrollments add column if not exists transfer_requested_at timestamptz null;
alter table center_settings add column if not exists class_hold_minutes int not null default 15
  check (class_hold_minutes between 1 and 240);

create index if not exists enrollments_hold_until_idx on enrollments (hold_until) where status = 'hold';

create or replace function enrollment_hold(p_class uuid, p_user uuid, p_minutes int, p_price int) returns uuid
language plpgsql as $$
declare v_id uuid; v_status enroll_status;
begin
  perform 1 from classes where id = p_class for update;
  select id, status into v_id, v_status
    from enrollments where class_id = p_class and user_id = p_user;
  if v_status in ('confirmed', 'hold') then
    raise exception 'ALREADY_ENROLLED';
  end if;
  update classes set enrolled_count = enrolled_count + 1
   where id = p_class and enrolled_count < capacity and status = 'open';
  if not found then
    raise exception 'CLASS_FULL';
  end if;
  if v_id is not null then
    update enrollments
       set status = 'hold', waitlist_pos = null,
           hold_until = now() + p_minutes * interval '1 minute',
           price_vnd = p_price, transfer_requested_at = null
     where id = v_id;
    perform waitlist_compact(p_class);
    return v_id;
  end if;
  insert into enrollments (class_id, user_id, status, hold_until, price_vnd, transfer_requested_at)
  values (p_class, p_user, 'hold', now() + p_minutes * interval '1 minute', p_price, null)
  returning id into v_id;
  perform waitlist_compact(p_class);
  return v_id;
end $$;

create or replace function enrollment_waitlist(p_class uuid, p_user uuid) returns uuid
language plpgsql as $$
declare v_id uuid; v_pos int; v_status enroll_status;
begin
  perform 1 from classes where id = p_class for update;
  select id, status into v_id, v_status
    from enrollments where class_id = p_class and user_id = p_user;
  if v_status in ('confirmed', 'hold') then
    raise exception 'ALREADY_ENROLLED';
  end if;
  if v_status = 'waitlisted' and v_id is not null then
    perform waitlist_compact(p_class);
    return v_id;
  end if;
  select coalesce(max(waitlist_pos), 0) + 1 into v_pos
    from enrollments where class_id = p_class and status = 'waitlisted';
  if v_id is not null then
    update enrollments set status = 'waitlisted', waitlist_pos = v_pos where id = v_id;
    perform waitlist_compact(p_class);
    return v_id;
  end if;
  insert into enrollments (class_id, user_id, status, waitlist_pos)
  values (p_class, p_user, 'waitlisted', v_pos)
  returning id into v_id;
  perform waitlist_compact(p_class);
  return v_id;
end $$;

