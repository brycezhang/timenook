-- Development refactor: existing projects are rebuilt, not backfilled.
ALTER TABLE privacy_erasure_registry DISABLE TRIGGER USER;
DELETE FROM privacy_erasure_registry WHERE table_name = 'plan_directory_versions';
ALTER TABLE privacy_erasure_registry ENABLE TRIGGER USER;
DROP TABLE plan_directory_versions;
ALTER TABLE plan_revisions ADD COLUMN directory_hash CHAR(64);
ALTER TABLE actual_plan_questions DROP CONSTRAINT actual_question_source_choice;
ALTER TABLE actual_plan_questions ADD CONSTRAINT actual_question_source_choice CHECK (
  privacy_erased_columns @> ARRAY['source']::text[] OR
  (question_key IS NOT NULL AND starter_kind IS NULL AND source->>'kind' = 'plan') OR
  (question_key IS NULL AND starter_kind IS NOT NULL AND source->>'kind' = starter_kind) OR
  (question_key IS NULL AND starter_kind IS NULL AND source->>'kind' IN ('self-written','follow-up'))
);
