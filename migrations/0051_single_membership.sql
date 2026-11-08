-- 0051_single_membership.sql: one account, one membership. Plans differ only by length.
-- Old plans stop selling but stay readable, so history keeps its names and prices.
-- Old live plans become membership days: paid x share left / day rate, rounded up for the member.
-- The old columns (session_left, court_hours_left, court_discount_pct) stay for history; code stops using them.

alter table membership_plans add column if not exists duration_months int null check (duration_months between 1 and 120);

alter table center_settings add column if not exists member_court_fee_vnd int not null default 30000 check (member_court_fee_vnd >= 0);
alter table center_settings add column if not exists member_day_rate_vnd int not null default 16667 check (member_day_rate_vnd > 0);

alter table enrollments add column if not exists extension_vnd int not null default 0 check (extension_vnd >= 0);
alter table enrollments add column if not exists extension_to date null;

create table if not exists membership_extensions (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id),
  enrollment_id uuid not null references enrollments(id),
  from_on date not null,
  to_on date not null,
  amount_vnd int not null check (amount_vnd >= 0),
  status text not null default 'active' check (status in ('active','refunded')),
  created_at timestamptz not null default now(),
  check (to_on >= from_on)
);
create unique index if not exists one_active_extension_per_enrollment
  on membership_extensions (enrollment_id) where status = 'active';
create index if not exists membership_extensions_subscription on membership_extensions (subscription_id);

update membership_plans set is_on_sale = false;

insert into membership_plans (id, name, sport_scope, duration_days, duration_months, session_quota, court_hours, court_discount_pct, price_vnd, is_on_sale) values
  ('20000000-0000-0000-0000-000000000051', '1 month',   'all',  30,  1, null, 0, 0,  500000, true),
  ('20000000-0000-0000-0000-000000000052', '3 months',  'all',  90,  3, null, 0, 0, 1350000, true),
  ('20000000-0000-0000-0000-000000000053', '6 months',  'all', 180,  6, null, 0, 0, 2400000, true),
  ('20000000-0000-0000-0000-000000000054', '12 months', 'all', 365, 12, null, 0, 0, 4200000, true)
on conflict (id) do nothing;

-- An unpaid request for an old plan can no longer be sold.
update subscriptions s set status = 'expired'
  from membership_plans p
 where p.id = s.plan_id and s.status = 'pending' and p.duration_months is null;

create temporary table membership_credit as
with today as (
  select (now() at time zone 'Asia/Ho_Chi_Minh')::date as d
), live as (
  select s.id, s.user_id, s.end_on, p.session_quota, s.session_left,
         greatest(coalesce(s.price_vnd, p.price_vnd) - s.promo_discount_vnd, 0) as paid,
         greatest(s.end_on - t.d + 1, 0) as days_left,
         greatest(s.end_on - s.start_on + 1, 1) as total_days
    from subscriptions s
    join membership_plans p on p.id = s.plan_id
   cross join today t
   where s.status in ('active','frozen')
), valued as (
  select *,
         case
           when session_quota > 0 then least(coalesce(session_left, 0)::numeric / session_quota, 1)
           else least(days_left::numeric / total_days, 1)
         end as share
    from live
)
select id, user_id,
       case
         when paid = 0 and session_quota is null then days_left
         else ceil(paid * share / (select member_day_rate_vnd from center_settings where id = 1))::int
       end as credit_days,
       row_number() over (partition by user_id order by end_on desc, id) as keep_rank
  from valued;

drop index if exists one_live_sub_per_scope;
drop index if exists one_pending_sub_per_scope;

update subscriptions s set status = 'expired'
  from membership_credit c
 where c.id = s.id and c.keep_rank > 1;

with totals as (
  select user_id, sum(credit_days)::int as days from membership_credit group by user_id
)
update subscriptions s
   set plan_id = '20000000-0000-0000-0000-000000000051',
       sport_scope = 'all',
       status = case when t.days > 0 then 'active'::sub_status else 'expired'::sub_status end,
       end_on = case when t.days > 0
                     then (now() at time zone 'Asia/Ho_Chi_Minh')::date + t.days - 1
                     else s.end_on end,
       session_left = null,
       court_hours_left = 0
  from membership_credit c
  join totals t on t.user_id = c.user_id
 where c.id = s.id and c.keep_rank = 1;

create unique index if not exists one_live_sub_per_user on subscriptions (user_id)
  where status in ('active','frozen');
create unique index if not exists one_pending_sub_per_user on subscriptions (user_id)
  where status = 'pending';

insert into audit_logs (action, entity, entity_id, after)
select 'convert_membership', 'subscription', c.id, jsonb_build_object('credit_days', c.credit_days, 'kept', c.keep_rank = 1)
  from membership_credit c;

drop table membership_credit;

alter table enrollments
  add column if not exists promo_id uuid references promotions(id),
  add column if not exists promo_discount_vnd integer not null default 0;
