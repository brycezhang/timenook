ALTER TABLE production_tasks DROP CONSTRAINT production_task_source_kind;
ALTER TABLE production_tasks ADD CONSTRAINT production_task_source_kind CHECK (
 (kind='transcribe_audio' AND clip_id IS NOT NULL AND asset_id IS NOT NULL AND sealed_input_id IS NOT NULL)
 OR (kind IN ('compose_story','ask_followup') AND clip_id IS NULL AND asset_id IS NULL AND sealed_input_id IS NULL));
ALTER TABLE formal_transcripts ADD CONSTRAINT formal_transcripts_followup_source UNIQUE(project_id,task_id,clip_id,input_hash,sha256);
CREATE TABLE followup_generations (
 followup_version INTEGER NOT NULL CHECK(followup_version>0),
 task_id UUID PRIMARY KEY, project_id UUID NOT NULL, interview_id UUID NOT NULL, actual_question_id UUID NOT NULL,
 question_version INTEGER NOT NULL CHECK(question_version>0), plan_revision INTEGER NOT NULL, preference_version INTEGER NOT NULL,
 input JSONB NOT NULL, result JSONB, finish_reason TEXT CHECK(finish_reason IN ('DECLINED','NOT_APPLICABLE','BLOCKED_TOPIC','REPEATED_QUESTION','USER_FINISHED')), charged BOOLEAN NOT NULL DEFAULT true CHECK(charged=(finish_reason IS NULL)), transcripts_ready_at TIMESTAMPTZ(3),
 UNIQUE(project_id,task_id), UNIQUE(project_id,interview_id,followup_version), FOREIGN KEY(project_id,task_id) REFERENCES production_tasks(project_id,id),
 FOREIGN KEY(project_id,interview_id,actual_question_id) REFERENCES interview_actual_questions(project_id,interview_id,actual_question_id),
 FOREIGN KEY(project_id,plan_revision) REFERENCES plan_revisions(project_id,revision)
);
CREATE TABLE followup_sources (
 task_id UUID NOT NULL, project_id UUID NOT NULL, clip_id UUID NOT NULL, interview_id UUID NOT NULL, actual_question_id UUID NOT NULL,
 asset_id UUID NOT NULL, sequence INTEGER NOT NULL, transcription_task_id UUID NOT NULL, input_hash CHAR(64) NOT NULL, transcript_hash CHAR(64) NOT NULL,
 PRIMARY KEY(task_id,clip_id), UNIQUE(task_id,sequence),
 FOREIGN KEY(project_id,task_id) REFERENCES followup_generations(project_id,task_id),
 FOREIGN KEY(project_id,clip_id,interview_id,actual_question_id,asset_id,sequence) REFERENCES recording_clips(project_id,id,interview_id,actual_question_id,asset_id,sequence),
 FOREIGN KEY(project_id,transcription_task_id,clip_id,input_hash,transcript_hash) REFERENCES formal_transcripts(project_id,task_id,clip_id,input_hash,sha256)
);
CREATE TRIGGER immutable_followup_source BEFORE UPDATE ON followup_sources FOR EACH ROW EXECUTE FUNCTION protect_service_terms();

CREATE TABLE followup_sessions (
 project_id UUID NOT NULL, interview_id UUID NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), ended BOOLEAN NOT NULL DEFAULT false,
 PRIMARY KEY(project_id,interview_id), FOREIGN KEY(project_id,interview_id) REFERENCES interviews(project_id,id)
);

ALTER TABLE followup_generations ADD CONSTRAINT followup_actual_source UNIQUE(project_id,interview_id,actual_question_id,task_id);
ALTER TABLE interview_actual_questions ADD COLUMN followup_task_id UUID, ADD COLUMN followup_source_question_id UUID,
 ADD CONSTRAINT followup_display_source_required CHECK ((followup_task_id IS NULL)=(followup_source_question_id IS NULL)),
 ADD CONSTRAINT displayed_followup_source FOREIGN KEY(project_id,interview_id,followup_source_question_id,followup_task_id)
 REFERENCES followup_generations(project_id,interview_id,actual_question_id,task_id);
CREATE FUNCTION protect_followup_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'result') IS DISTINCT FROM (to_jsonb(OLD)-'result')
    OR (OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result) THEN
   RAISE EXCEPTION 'Follow-up input, quota intent and accepted output are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_followup_generation BEFORE UPDATE ON followup_generations FOR EACH ROW EXECUTE FUNCTION protect_followup_generation();
