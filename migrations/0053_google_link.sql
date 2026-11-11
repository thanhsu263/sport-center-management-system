-- Google sign-in works only for an account whose owner linked it from
-- Account settings. The link is Google's stable subject id, not the email, so
-- a changed Gmail address keeps working and a matching email alone never does.
alter table users add column if not exists google_sub text;
alter table users add column if not exists google_email text;
create unique index if not exists users_google_sub on users (google_sub) where google_sub is not null;
