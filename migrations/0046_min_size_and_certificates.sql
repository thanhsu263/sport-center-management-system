-- 0046_min_size_and_certificates.sql: a class's minimum to run, coach certifications, member completion certificates.

-- The fewest confirmed members a class needs to run. It only warns: nothing is cancelled for it.
alter table classes add column if not exists min_enrolled int null check (min_enrolled >= 1);

-- A coach's qualifications, shown on the coach's profile.
create table if not exists coach_certifications (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references users(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  issuer text null check (length(issuer) <= 120),
  issued_on date null,
  expires_on date null check (expires_on is null or issued_on is null or expires_on >= issued_on),
  created_by uuid null references users(id),
  created_at timestamptz not null default now()
);
create index if not exists coach_certifications_coach_idx on coach_certifications (coach_id);

-- A member's certificate for finishing a class, issued once and checkable by its code.
create table if not exists class_certificates (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null unique references enrollments(id) on delete cascade,
  code text not null unique check (length(code) between 6 and 24),
  attended int not null check (attended >= 0),
  sessions int not null check (sessions >= 1),
  issued_at timestamptz not null default now()
);
