CREATE TABLE interview_actual_questions (
 project_id UUID NOT NULL, interview_id UUID NOT NULL, actual_question_id UUID NOT NULL UNIQUE,
 parent_actual_question_id UUID, sequence INTEGER NOT NULL CHECK(sequence>0),
 PRIMARY KEY(project_id,interview_id,actual_question_id),
 UNIQUE(project_id,interview_id,sequence),
 FOREIGN KEY(project_id,interview_id) REFERENCES interviews(project_id,id),
 FOREIGN KEY(project_id,actual_question_id) REFERENCES actual_plan_questions(project_id,id),
 FOREIGN KEY(project_id,interview_id,parent_actual_question_id)
 REFERENCES interview_actual_questions(project_id,interview_id,actual_question_id),
 CHECK((sequence=1)=(parent_actual_question_id IS NULL))
);
INSERT INTO interview_actual_questions(project_id,interview_id,actual_question_id,sequence)
 SELECT project_id,id,actual_question_id,1 FROM interviews;
ALTER TABLE recording_intents
 DROP CONSTRAINT recording_intents_project_id_interview_id_actual_question__fkey;
ALTER TABLE recording_intents ADD CONSTRAINT recording_intent_actual_question
 FOREIGN KEY(project_id,interview_id,actual_question_id)
 REFERENCES interview_actual_questions(project_id,interview_id,actual_question_id);
CREATE TRIGGER immutable_interview_actual_question BEFORE UPDATE ON interview_actual_questions
 FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
