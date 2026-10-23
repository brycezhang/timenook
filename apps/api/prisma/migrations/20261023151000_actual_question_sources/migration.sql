ALTER TABLE actual_plan_questions ADD COLUMN source JSONB;
ALTER TABLE actual_plan_questions DROP CONSTRAINT actual_plan_questions_check;
ALTER TABLE actual_plan_questions ADD CONSTRAINT actual_question_source_choice CHECK (
 (CASE WHEN question_key IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN starter_kind IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN source IS NOT NULL THEN 1 ELSE 0 END)=1
);
