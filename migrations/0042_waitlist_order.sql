-- 0042_waitlist_order.sql: Compact waitlist positions to 1..n and ensure fair free seat assignment

create or replace function waitlist_compact(p_class uuid) returns void
language plpgsql as $$
begin
  update enrollments as e
  set waitlist_pos = s.new_pos
  from (
    select id, row_number() over (order by waitlist_pos asc nulls last, id asc) as new_pos
    from enrollments
    where class_id = p_class and status = 'waitlisted'
  ) as s
  where e.id = s.id and (e.waitlist_pos is distinct from s.new_pos);
end $$;

create or replace function enrollment_confirm(p_class uuid, p_user uuid) returns uuid
language plpgsql as $$
declare v_id uuid; v_status enroll_status;
begin
  perform 1 from classes where id = p_class for update;
  select id, status into v_id, v_status
    from enrollments where class_id = p_class and user_id = p_user;
  if v_status = 'confirmed' then
    raise exception 'ALREADY_ENROLLED';
  end if;
  update classes set enrolled_count = enrolled_count + 1
   where id = p_class and enrolled_count < capacity and status = 'open';
  if not found then
    raise exception 'CLASS_FULL';
  end if;
  if v_id is not null then
    update enrollments set status = 'confirmed', waitlist_pos = null where id = v_id;
    perform waitlist_compact(p_class);
    return v_id;
  end if;
  insert into enrollments (class_id, user_id, status)
  values (p_class, p_user, 'confirmed')
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
  if v_status = 'confirmed' then
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

select waitlist_compact(id) from classes;
