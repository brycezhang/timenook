CREATE TABLE family_questions (
 id UUID PRIMARY KEY,
 removed BOOLEAN NOT NULL DEFAULT false,
 project_id UUID NOT NULL REFERENCES projects(id),
 version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
 text TEXT,
 chapter_key TEXT,
 author_id UUID REFERENCES users(id),
 author_nickname TEXT,
 author_relationship VARCHAR(32),
 state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','later','skipped')),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 privacy_erased_columns TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX family_questions_project_id_idx ON family_questions(project_id);
ALTER TABLE privacy_erasure_registry DISABLE TRIGGER immutable_erasure_registry;
INSERT INTO privacy_erasure_registry (table_name, category, columns, key_columns)
VALUES ('family_questions', 'activeData', ARRAY['text','chapter_key','author_id','author_nickname','author_relationship'], ARRAY['id']);
ALTER TABLE privacy_erasure_registry ENABLE TRIGGER immutable_erasure_registry;
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON family_questions FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON family_questions FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
ALTER TABLE actual_plan_questions DROP CONSTRAINT actual_question_source_choice;
ALTER TABLE actual_plan_questions ADD CONSTRAINT actual_question_source_choice CHECK (
  privacy_erased_columns @> ARRAY['source']::text[] OR
  (question_key IS NOT NULL AND starter_kind IS NULL AND source->>'kind' = 'plan') OR
  (question_key IS NULL AND starter_kind IS NOT NULL AND source->>'kind' = starter_kind) OR
  (question_key IS NULL AND starter_kind IS NULL AND source->>'kind' IN ('self-written','follow-up','family'))
);
