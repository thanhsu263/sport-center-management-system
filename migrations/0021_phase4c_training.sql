-- Phase 4C: the F4 training module (FR-TRN-03..08).
-- Forward-only. Every table here is touched only through the F4 feature flag (BR-62):
-- switching F4 off hides it, it never gates F1/F2/F3/F7.

-- A session plan can now be pinned to one session (FR-TRN-04: "HV thấy giáo án buổi kế").
ALTER TABLE training_plans ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES sessions(id);
ALTER TABLE training_plans ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
ALTER TABLE training_plans ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE training_plans ADD COLUMN IF NOT EXISTS title VARCHAR(120);
CREATE INDEX IF NOT EXISTS training_plans_session ON training_plans (session_id) WHERE session_id IS NOT NULL;

-- FR-TRN-05: what one student did in one session.
CREATE TABLE IF NOT EXISTS session_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id),
  user_id UUID NOT NULL REFERENCES users(id),
  plan_pct SMALLINT CHECK (plan_pct BETWEEN 0 AND 100),
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  note TEXT,
  recorded_by UUID REFERENCES users(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, user_id)
);
CREATE INDEX IF NOT EXISTS session_results_user ON session_results (user_id, recorded_at DESC);

-- FR-TRN-06: periodic review. Append-only: a new review is a new row, never an overwrite.
CREATE TABLE IF NOT EXISTS progress_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  sport sport_kind NOT NULL,
  coach_id UUID NOT NULL REFERENCES users(id),
  period_weeks SMALLINT NOT NULL CHECK (period_weeks IN (2, 4)),
  technique SMALLINT NOT NULL CHECK (technique BETWEEN 1 AND 5),
  fitness SMALLINT NOT NULL CHECK (fitness BETWEEN 1 AND 5),
  attitude SMALLINT NOT NULL CHECK (attitude BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS progress_reviews_user ON progress_reviews (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION progress_reviews_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'progress_reviews is append-only';
END $$;
DROP TRIGGER IF EXISTS progress_reviews_no_change ON progress_reviews;
CREATE TRIGGER progress_reviews_no_change BEFORE UPDATE OR DELETE ON progress_reviews
  FOR EACH ROW EXECUTE FUNCTION progress_reviews_append_only();

-- FR-TRN-03: goal (the member edits), level per sport (the coach edits), coach notes.
CREATE TABLE IF NOT EXISTS training_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  goal VARCHAR(16) CHECK (goal IN ('weight', 'technique', 'compete', 'fun')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS member_levels (
  user_id UUID NOT NULL REFERENCES users(id),
  sport sport_kind NOT NULL,
  level VARCHAR(16) NOT NULL CHECK (level IN ('beginner', 'intermediate', 'advanced')),
  assessed_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sport)
);

-- Staff-only: a member never reads these (the review is what a member sees).
CREATE TABLE IF NOT EXISTS coach_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  coach_id UUID NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coach_notes_user ON coach_notes (user_id, created_at DESC);

-- FR-TRN-07: homework for a class or one student. No money and no sessions move (BR-56).
CREATE TABLE IF NOT EXISTS homework (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id UUID NOT NULL REFERENCES users(id),
  class_id UUID REFERENCES classes(id),
  user_id UUID REFERENCES users(id),
  title VARCHAR(120) NOT NULL,
  body TEXT,
  checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
  due_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT homework_target CHECK ((class_id IS NOT NULL) <> (user_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS homework_recipients (
  homework_id UUID NOT NULL REFERENCES homework(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  done_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (homework_id, user_id)
);
CREATE INDEX IF NOT EXISTS homework_recipients_user ON homework_recipients (user_id);
