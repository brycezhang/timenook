ALTER TABLE production_tasks ALTER COLUMN clip_id DROP NOT NULL, ALTER COLUMN asset_id DROP NOT NULL, ALTER COLUMN sealed_input_id DROP NOT NULL;
ALTER TABLE production_tasks ADD CONSTRAINT production_task_source_kind CHECK ((kind='transcribe_audio' AND clip_id IS NOT NULL AND asset_id IS NOT NULL AND sealed_input_id IS NOT NULL) OR (kind='compose_story' AND clip_id IS NULL AND asset_id IS NULL AND sealed_input_id IS NULL));
CREATE TABLE stories (
 id UUID PRIMARY KEY, project_id UUID NOT NULL, interview_id UUID NOT NULL UNIQUE,
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0), created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(project_id,id), FOREIGN KEY(project_id,interview_id) REFERENCES interviews(project_id,id)
);
CREATE TABLE story_generations (
 task_id UUID PRIMARY KEY, project_id UUID NOT NULL, story_id UUID NOT NULL,
 base_version INTEGER NOT NULL CHECK(base_version>=0), preferences JSONB NOT NULL,
 quota_kind TEXT NOT NULL CHECK(quota_kind IN ('organization','regeneration')),
 user_submitted_at TIMESTAMPTZ(3) NOT NULL, all_saved_at TIMESTAMPTZ(3) NOT NULL,
 UNIQUE(project_id,task_id), FOREIGN KEY(project_id,task_id) REFERENCES production_tasks(project_id,id),
 FOREIGN KEY(project_id,story_id) REFERENCES stories(project_id,id)
);
ALTER TABLE recording_clips ADD CONSTRAINT recording_clips_story_source_key UNIQUE(project_id,id,interview_id,actual_question_id,asset_id,sequence);
ALTER TABLE production_tasks ADD CONSTRAINT production_tasks_story_source_key UNIQUE(project_id,id,clip_id,input_hash);
CREATE TABLE story_sources (
 intent_id UUID NOT NULL, task_id UUID NOT NULL, project_id UUID NOT NULL, clip_id UUID NOT NULL, interview_id UUID NOT NULL,
 asset_id UUID NOT NULL, sealed_input_id UUID NOT NULL, input_hash CHAR(64) NOT NULL,
 transcription_task_id UUID NOT NULL, actual_question_id UUID NOT NULL, question JSONB NOT NULL, sequence INTEGER NOT NULL,
 PRIMARY KEY(task_id,clip_id), UNIQUE(task_id,sequence),
 FOREIGN KEY(project_id,task_id) REFERENCES story_generations(project_id,task_id),
 FOREIGN KEY(project_id,clip_id,intent_id) REFERENCES recording_clips(project_id,id,intent_id),
 FOREIGN KEY(project_id,clip_id,interview_id,actual_question_id,asset_id,sequence) REFERENCES recording_clips(project_id,id,interview_id,actual_question_id,asset_id,sequence),
 FOREIGN KEY(project_id,asset_id,input_hash) REFERENCES recording_assets(project_id,id,sha256),
 FOREIGN KEY(project_id,sealed_input_id,clip_id) REFERENCES sealed_inputs(project_id,id,clip_id),
 FOREIGN KEY(project_id,transcription_task_id,clip_id,input_hash) REFERENCES production_tasks(project_id,id,clip_id,input_hash),
 FOREIGN KEY(project_id,actual_question_id) REFERENCES actual_plan_questions(project_id,id)
);
CREATE TABLE story_commands (
 project_id UUID NOT NULL, actor_id UUID NOT NULL, key TEXT NOT NULL, request_hash CHAR(64) NOT NULL, task_id UUID NOT NULL,
 PRIMARY KEY(project_id,actor_id,key), FOREIGN KEY(project_id,task_id) REFERENCES story_generations(project_id,task_id)
);

ALTER TABLE story_generations ADD COLUMN dependencies_ready_at TIMESTAMPTZ(3), ADD COLUMN resolved_manifest JSONB;
ALTER TABLE story_generations ADD CONSTRAINT story_generation_revision_source_key UNIQUE(project_id,story_id,task_id);
CREATE TABLE story_revisions (
 id UUID PRIMARY KEY, project_id UUID NOT NULL, story_id UUID NOT NULL, version INTEGER NOT NULL CHECK(version>0),
 generation_task_id UUID NOT NULL, base_revision_id UUID, title TEXT NOT NULL CHECK(length(btrim(title))>0), theme TEXT NOT NULL,
 paragraphs JSONB NOT NULL, review_items JSONB NOT NULL, source_manifest JSONB NOT NULL,
 content_hash CHAR(64) NOT NULL, origin TEXT NOT NULL, created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(story_id,version), UNIQUE(project_id,story_id,id,version), UNIQUE(project_id,story_id,id),
 FOREIGN KEY(project_id,story_id) REFERENCES stories(project_id,id),
 FOREIGN KEY(project_id,story_id,generation_task_id) REFERENCES story_generations(project_id,story_id,task_id),
 FOREIGN KEY(project_id,story_id,base_revision_id) REFERENCES story_revisions(project_id,story_id,id)
);
ALTER TABLE stories ADD COLUMN current_revision_id UUID,
 ADD CONSTRAINT story_current_revision FOREIGN KEY(project_id,id,current_revision_id,version) REFERENCES story_revisions(project_id,story_id,id,version);
CREATE FUNCTION immutable_story_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Story source and revision content is immutable'; END $$;
CREATE TRIGGER immutable_story_revision BEFORE UPDATE ON story_revisions FOR EACH ROW EXECUTE FUNCTION immutable_story_content();
CREATE TRIGGER immutable_story_source BEFORE UPDATE ON story_sources FOR EACH ROW EXECUTE FUNCTION immutable_story_content();

ALTER TABLE task_attempts ADD COLUMN usage JSONB, ADD COLUMN model TEXT, ADD COLUMN failure TEXT;

CREATE UNIQUE INDEX one_ai_revision_per_generation ON story_revisions(generation_task_id) WHERE origin='ai';
