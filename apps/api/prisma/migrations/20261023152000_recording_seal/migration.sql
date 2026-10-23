CREATE TABLE recording_intents (
 id UUID PRIMARY KEY, project_id UUID NOT NULL, interview_id UUID NOT NULL, actual_question_id UUID NOT NULL,
 client_clip_id UUID NOT NULL, subject_id UUID NOT NULL, operator_user_id UUID NOT NULL REFERENCES users(id),
 binding_version INTEGER NOT NULL, access_epoch INTEGER NOT NULL,
 method TEXT NOT NULL CHECK(method IN ('self_wechat','assisted')), assisted_session_id UUID REFERENCES assisted_sessions(id),
 storage_scope TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 2097152), sha256 CHAR(64) NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sealed','released')),
 reserved_ms INTEGER NOT NULL CHECK(reserved_ms BETWEEN 0 AND 300000), consumed_ms INTEGER NOT NULL DEFAULT 0 CHECK(consumed_ms BETWEEN 0 AND 300000),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(project_id,interview_id,actual_question_id) REFERENCES interviews(project_id,id,actual_question_id),
 FOREIGN KEY(project_id,subject_id) REFERENCES project_subjects(project_id,id),
 UNIQUE(project_id,client_clip_id),UNIQUE(project_id,id),UNIQUE(project_id,interview_id,actual_question_id,id),
 CHECK((method='assisted')=(assisted_session_id IS NOT NULL)),
 CHECK((state='pending' AND consumed_ms=0 AND reserved_ms>0) OR (state='sealed' AND consumed_ms>0 AND reserved_ms=0) OR (state='released' AND consumed_ms=0 AND reserved_ms=0))
);
CREATE TABLE recording_assets (
 id UUID PRIMARY KEY,project_id UUID NOT NULL REFERENCES projects(id),storage_scope TEXT NOT NULL,object_key TEXT NOT NULL,
 bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 2097152),sha256 CHAR(64) NOT NULL,duration_ms INTEGER NOT NULL CHECK(duration_ms BETWEEN 1 AND 300000),mime TEXT NOT NULL DEFAULT 'audio/mpeg' CHECK(mime='audio/mpeg'),
 UNIQUE(project_id,id),UNIQUE(storage_scope,object_key)
);
CREATE TABLE recording_clips (
 id UUID PRIMARY KEY,project_id UUID NOT NULL,interview_id UUID NOT NULL,actual_question_id UUID NOT NULL,
 intent_id UUID NOT NULL UNIQUE,asset_id UUID NOT NULL UNIQUE,client_clip_id UUID NOT NULL,subject_id UUID NOT NULL,
 operator_user_id UUID NOT NULL REFERENCES users(id),binding_version INTEGER NOT NULL,access_epoch INTEGER NOT NULL,
 method TEXT NOT NULL CHECK(method IN ('self_wechat','assisted')),assisted_session_id UUID REFERENCES assisted_sessions(id),sequence INTEGER NOT NULL CHECK(sequence>0),
 FOREIGN KEY(project_id,interview_id,actual_question_id,intent_id) REFERENCES recording_intents(project_id,interview_id,actual_question_id,id),
 FOREIGN KEY(project_id,asset_id) REFERENCES recording_assets(project_id,id),FOREIGN KEY(project_id,subject_id) REFERENCES project_subjects(project_id,id),
 UNIQUE(project_id,id),UNIQUE(project_id,client_clip_id),UNIQUE(interview_id,sequence),CHECK((method='assisted')=(assisted_session_id IS NOT NULL))
);
CREATE TABLE sealed_inputs (
 id UUID PRIMARY KEY,project_id UUID NOT NULL,clip_id UUID NOT NULL UNIQUE,
 kind TEXT NOT NULL DEFAULT 'sealed-input' CHECK(kind='sealed-input'),created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(project_id,clip_id) REFERENCES recording_clips(project_id,id)
);
CREATE TRIGGER immutable_recording_asset BEFORE UPDATE ON recording_assets FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
CREATE TRIGGER immutable_recording_clip BEFORE UPDATE ON recording_clips FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
CREATE TRIGGER immutable_sealed_input BEFORE UPDATE ON sealed_inputs FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
