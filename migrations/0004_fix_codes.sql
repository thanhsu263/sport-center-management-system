CREATE OR REPLACE FUNCTION next_member_code() RETURNS VARCHAR
LANGUAGE plpgsql AS $$
DECLARE y INT := EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Ho_Chi_Minh'));
DECLARE n INT;
BEGIN
  INSERT INTO code_counters(kind, yyyy, n) VALUES ('member', y, 1)
  ON CONFLICT (kind, yyyy) DO UPDATE SET n = code_counters.n + 1
  RETURNING code_counters.n INTO n;
  RETURN 'A3-' || y::text || '-' || lpad(n::text, 4, '0');
END $$;

CREATE OR REPLACE FUNCTION next_doc_code(p_kind VARCHAR) RETURNS VARCHAR
LANGUAGE plpgsql AS $$
DECLARE ymd INT;
DECLARE n INT;
BEGIN
  ymd := to_char((now() AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYYMMDD')::INT;
  INSERT INTO code_counters(kind, yyyy, n) VALUES (p_kind, ymd, 1)
  ON CONFLICT (kind, yyyy) DO UPDATE SET n = code_counters.n + 1
  RETURNING code_counters.n INTO n;
  RETURN p_kind || '-' || ymd::text || '-' || lpad(n::text, 4, '0');
END $$;
