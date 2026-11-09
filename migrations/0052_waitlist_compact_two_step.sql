-- Renumber a class's waitlist in two steps. The single UPDATE in 0042 shifted
-- positions down (3 -> 2 while 2 still existed) and tripped the unique index
-- enrollments_waitlist_pos whenever Postgres visited the rows out of order:
-- "Claim seat" failed with "That already exists" and the freed seat went to
-- whoever enrolled next. Negative positions first, then flip, never collide.
create or replace function waitlist_compact(p_class uuid) returns void
language plpgsql as $$
begin
  update enrollments as e
  set waitlist_pos = -s.new_pos
  from (
    select id, row_number() over (order by waitlist_pos asc nulls last, id asc) as new_pos
    from enrollments
    where class_id = p_class and status = 'waitlisted'
  ) as s
  where e.id = s.id;

  update enrollments
  set waitlist_pos = -waitlist_pos
  where class_id = p_class and status = 'waitlisted' and waitlist_pos < 0;
end $$;
