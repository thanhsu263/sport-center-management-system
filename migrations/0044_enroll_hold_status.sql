-- 0044_enroll_hold_status.sql: a seat held while the member pays for a class
alter type enroll_status add value if not exists 'hold';
