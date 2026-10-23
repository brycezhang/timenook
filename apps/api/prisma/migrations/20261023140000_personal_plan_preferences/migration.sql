ALTER TABLE "interview_preferences" ADD COLUMN "question_states" JSONB NOT NULL DEFAULT '[]';
CREATE TABLE "plan_preference_decisions" (
  "project_id" UUID NOT NULL REFERENCES "projects"("id"),
  "version" INTEGER NOT NULL CHECK ("version" > 1),
  "subject_id" UUID NOT NULL,
  "operator_user_id" UUID NOT NULL,
  "method" TEXT NOT NULL CHECK ("method" IN ('self_wechat', 'assisted')),
  "assisted_session_id" UUID REFERENCES "assisted_sessions"("id"),
  "blocked_topics" TEXT[] NOT NULL,
  "question_states" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("project_id", "version"),
  CHECK (("method" = 'assisted') = ("assisted_session_id" IS NOT NULL))
);

CREATE TRIGGER immutable_plan_preference_decision BEFORE UPDATE ON plan_preference_decisions FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
CREATE TABLE "actual_plan_questions" (
  "id" UUID PRIMARY KEY,
  "project_id" UUID NOT NULL,
  "plan_revision" INTEGER NOT NULL,
  "captured_by" TEXT NOT NULL,
  "question_key" TEXT,
  "starter_kind" TEXT CHECK ("starter_kind" IN ('photo', 'free-narration')),
  "snapshot" JSONB NOT NULL,
  "answer_ref" TEXT,
  FOREIGN KEY ("project_id", "plan_revision") REFERENCES "plan_revisions"("project_id", "revision"),
  CHECK (("question_key" IS NULL) <> ("starter_kind" IS NULL))
);
CREATE INDEX "actual_plan_questions_project_id_idx" ON "actual_plan_questions"("project_id");
CREATE FUNCTION protect_actual_plan_question() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'answer_ref') <> (to_jsonb(OLD) - 'answer_ref') OR (OLD.answer_ref IS NOT NULL AND NEW.answer_ref IS DISTINCT FROM OLD.answer_ref) THEN
    RAISE EXCEPTION 'Actual question snapshots and answered associations are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_actual_plan_question BEFORE UPDATE ON actual_plan_questions FOR EACH ROW EXECUTE FUNCTION protect_actual_plan_question();

CREATE TABLE "plan_directory_versions" (
  "project_id" UUID NOT NULL REFERENCES "projects"("id"),
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "chapters" JSONB NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "created_by" TEXT NOT NULL,
  PRIMARY KEY ("project_id", "version")
);
INSERT INTO plan_directory_versions (project_id, version, chapters, content_hash, created_by)
  SELECT id, 1, '[]', '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945', created_by FROM projects;
CREATE TRIGGER immutable_plan_directory_version BEFORE UPDATE ON plan_directory_versions FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
