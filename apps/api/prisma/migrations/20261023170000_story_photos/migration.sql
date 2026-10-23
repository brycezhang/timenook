CREATE TABLE photo_intents (
 id UUID PRIMARY KEY,project_id UUID NOT NULL,interview_id UUID NOT NULL,actual_question_id UUID NOT NULL,
 client_photo_id UUID NOT NULL,subject_id UUID NOT NULL,operator_user_id UUID NOT NULL REFERENCES users(id),
 binding_version INTEGER NOT NULL,access_epoch INTEGER NOT NULL,
 method TEXT NOT NULL CHECK(method IN ('self_wechat','assisted')),assisted_session_id UUID REFERENCES assisted_sessions(id),
 storage_scope TEXT NOT NULL,bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 16777216),sha256 CHAR(64) NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sealed','released')),
 reserved_count INTEGER NOT NULL DEFAULT 1,consumed_count INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(project_id,interview_id,actual_question_id) REFERENCES interviews(project_id,id,actual_question_id),
 FOREIGN KEY(project_id,subject_id) REFERENCES project_subjects(project_id,id),
 UNIQUE(project_id,client_photo_id),UNIQUE(project_id,id),UNIQUE(project_id,interview_id,id),
 CHECK((method='assisted')=(assisted_session_id IS NOT NULL)),
 CHECK((state='pending' AND reserved_count=1 AND consumed_count=0) OR (state='sealed' AND reserved_count=0 AND consumed_count=1) OR (state='released' AND reserved_count=0 AND consumed_count=0))
);

CREATE TABLE photo_assets (
 id UUID PRIMARY KEY,project_id UUID NOT NULL,intent_id UUID NOT NULL,parent_id UUID,kind TEXT NOT NULL CHECK(kind IN ('original','preview','print')),
 processing_version TEXT NOT NULL,storage TEXT NOT NULL,store TEXT NOT NULL,storage_scope TEXT NOT NULL,object_key TEXT NOT NULL,
 bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 67108864),sha256 CHAR(64) NOT NULL,mime TEXT NOT NULL,
 width INTEGER NOT NULL CHECK(width>0),height INTEGER NOT NULL CHECK(height>0),metadata JSONB NOT NULL,
 FOREIGN KEY(project_id,intent_id) REFERENCES photo_intents(project_id,id),
 UNIQUE(project_id,id),UNIQUE(project_id,intent_id,id),UNIQUE(intent_id,kind,processing_version),UNIQUE(storage_scope,object_key),
 FOREIGN KEY(project_id,intent_id,parent_id) REFERENCES photo_assets(project_id,intent_id,id),
 CHECK((kind='original')=(parent_id IS NULL)),CHECK(width::BIGINT*height<=16000000)
);
CREATE TRIGGER immutable_photo_asset BEFORE UPDATE ON photo_assets FOR EACH ROW EXECUTE FUNCTION protect_service_terms();


CREATE TABLE photo_snapshots (
 id UUID PRIMARY KEY,project_id UUID NOT NULL,interview_id UUID NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),hash CHAR(64) NOT NULL,
 operator_user_id UUID NOT NULL REFERENCES users(id),command_key TEXT,created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(project_id,interview_id) REFERENCES interviews(project_id,id),
 UNIQUE(project_id,operator_user_id,command_key),UNIQUE(project_id,interview_id,revision),UNIQUE(project_id,interview_id,id)
);
CREATE TABLE photo_references (
 snapshot_id UUID NOT NULL,project_id UUID NOT NULL,interview_id UUID NOT NULL,photo_id UUID NOT NULL,position INTEGER NOT NULL CHECK(position>=0),caption TEXT NOT NULL CHECK(length(caption)<=1000),
 original_id UUID NOT NULL,preview_id UUID NOT NULL,print_id UUID NOT NULL,
 PRIMARY KEY(snapshot_id,position),UNIQUE(snapshot_id,photo_id),
 FOREIGN KEY(project_id,interview_id,snapshot_id) REFERENCES photo_snapshots(project_id,interview_id,id),
 FOREIGN KEY(project_id,interview_id,photo_id) REFERENCES photo_intents(project_id,interview_id,id),
 FOREIGN KEY(project_id,photo_id,original_id) REFERENCES photo_assets(project_id,intent_id,id),
 FOREIGN KEY(project_id,photo_id,preview_id) REFERENCES photo_assets(project_id,intent_id,id),
 FOREIGN KEY(project_id,photo_id,print_id) REFERENCES photo_assets(project_id,intent_id,id)
);
CREATE TRIGGER immutable_photo_snapshot BEFORE UPDATE ON photo_snapshots FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
CREATE TRIGGER immutable_photo_reference BEFORE UPDATE ON photo_references FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
