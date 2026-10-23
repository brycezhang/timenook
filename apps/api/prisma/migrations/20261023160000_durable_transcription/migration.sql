ALTER TABLE sealed_inputs ADD CONSTRAINT sealed_inputs_project_id_id_clip_id_key UNIQUE(project_id,id,clip_id);
ALTER TABLE recording_assets ADD CONSTRAINT recording_assets_project_id_id_sha256_key UNIQUE(project_id,id,sha256);
ALTER TABLE recording_clips ADD CONSTRAINT recording_clips_task_input_key UNIQUE(project_id,id,asset_id,subject_id,binding_version,access_epoch);
CREATE TABLE production_tasks (
 id UUID PRIMARY KEY, project_id UUID NOT NULL, clip_id UUID NOT NULL, asset_id UUID NOT NULL,
 sealed_input_id UUID NOT NULL UNIQUE, subject_id UUID NOT NULL, binding_version INTEGER NOT NULL,
 access_epoch INTEGER NOT NULL, input_hash CHAR(64) NOT NULL, kind TEXT NOT NULL DEFAULT 'transcribe_audio',
 processing_grant JSONB, configuration JSONB NOT NULL, configuration_hash CHAR(64) NOT NULL,
 provider_request_id UUID NOT NULL UNIQUE, deadline TIMESTAMPTZ(3), provider_code TEXT, error_code TEXT, completed_at TIMESTAMPTZ(3), failed_at TIMESTAMPTZ(3), submitted_at TIMESTAMPTZ(3), lease_until TIMESTAMPTZ(3),
 fence INTEGER NOT NULL DEFAULT 0, next_run_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 state TEXT NOT NULL DEFAULT 'queued', created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(project_id,clip_id,kind), UNIQUE(project_id,id),
 FOREIGN KEY(project_id,sealed_input_id,clip_id) REFERENCES sealed_inputs(project_id,id,clip_id),
 FOREIGN KEY(project_id,asset_id,input_hash) REFERENCES recording_assets(project_id,id,sha256),
 FOREIGN KEY(project_id,clip_id,asset_id,subject_id,binding_version,access_epoch)
 REFERENCES recording_clips(project_id,id,asset_id,subject_id,binding_version,access_epoch)
);
ALTER TABLE production_tasks ADD CONSTRAINT production_tasks_quota_clip_key UNIQUE(project_id,id,clip_id);
ALTER TABLE recording_clips ADD CONSTRAINT recording_clips_quota_intent_key UNIQUE(project_id,id,intent_id);
CREATE TABLE task_quota_intents (
 clip_id UUID NOT NULL, task_id UUID PRIMARY KEY, project_id UUID NOT NULL, recording_intent_id UUID NOT NULL UNIQUE,
 consumed_ms INTEGER NOT NULL CHECK(consumed_ms > 0),
 FOREIGN KEY(project_id,task_id,clip_id) REFERENCES production_tasks(project_id,id,clip_id),
 FOREIGN KEY(project_id,clip_id,recording_intent_id) REFERENCES recording_clips(project_id,id,intent_id),
 FOREIGN KEY(project_id,recording_intent_id) REFERENCES recording_intents(project_id,id)
);
CREATE TABLE task_outbox (
 id UUID PRIMARY KEY, task_id UUID NOT NULL UNIQUE REFERENCES production_tasks(id),
 delivered_at TIMESTAMPTZ(3), created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE production_tasks ADD CONSTRAINT production_tasks_result_key UNIQUE(project_id,id,clip_id,input_hash,provider_request_id);
CREATE TABLE formal_transcripts (
 task_id UUID PRIMARY KEY, project_id UUID NOT NULL, clip_id UUID NOT NULL UNIQUE,
 input_hash CHAR(64) NOT NULL, text TEXT NOT NULL CHECK(length(btrim(text))>0),
 sha256 CHAR(64) NOT NULL CHECK(sha256=encode(sha256(convert_to(text,'UTF8')),'hex')),
 provider_request_id UUID NOT NULL,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(project_id,task_id,clip_id,input_hash,provider_request_id)
 REFERENCES production_tasks(project_id,id,clip_id,input_hash,provider_request_id)
);
CREATE FUNCTION immutable_formal_transcript() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Formal transcript is immutable'; END $$;
CREATE TRIGGER immutable_formal_transcript BEFORE UPDATE ON formal_transcripts
 FOR EACH ROW EXECUTE FUNCTION immutable_formal_transcript();
CREATE TABLE task_attempts (
 request_id UUID PRIMARY KEY, task_id UUID NOT NULL, project_id UUID NOT NULL,
 number INTEGER NOT NULL CHECK(number>0), configuration JSONB NOT NULL,
 configuration_hash CHAR(64) NOT NULL, state TEXT NOT NULL,
 submitted_at TIMESTAMPTZ(3) NOT NULL, polls INTEGER NOT NULL DEFAULT 0 CHECK(polls>=0),
 reserved_cost_fen INTEGER NOT NULL CHECK(reserved_cost_fen>=0), actual_cost_fen INTEGER CHECK(actual_cost_fen>=0),
 provider_code TEXT, UNIQUE(task_id,number),
 FOREIGN KEY(project_id,task_id) REFERENCES production_tasks(project_id,id)
);
CREATE TABLE task_retry_commands (
 project_id UUID NOT NULL, task_id UUID NOT NULL, actor_id UUID NOT NULL,
 actor_realm TEXT NOT NULL CHECK(actor_realm IN ('product','admin')), key TEXT NOT NULL,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(task_id,actor_realm,actor_id,key),
 FOREIGN KEY(project_id,task_id) REFERENCES production_tasks(project_id,id)
);
CREATE INDEX production_tasks_due ON production_tasks(next_run_at) WHERE state IN ('queued','waiting_provider','submitting');
CREATE TABLE task_attempt_observations (
 request_id UUID NOT NULL REFERENCES task_attempts(request_id), fence INTEGER NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('submit','query')), state TEXT NOT NULL,
 provider_code TEXT, superseded BOOLEAN NOT NULL,
 observed_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(request_id,fence)
);
