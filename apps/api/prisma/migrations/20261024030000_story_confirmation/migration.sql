ALTER TABLE story_revisions ADD COLUMN review_resolutions JSONB NOT NULL DEFAULT '[]';
ALTER TABLE story_revisions ADD CONSTRAINT story_revision_hash_key UNIQUE(project_id,story_id,id,content_hash);
CREATE TABLE story_decisions (
 id UUID PRIMARY KEY, sequence SERIAL NOT NULL UNIQUE,
 project_id UUID NOT NULL, story_id UUID NOT NULL, revision_id UUID NOT NULL, content_hash CHAR(64) NOT NULL,
 subject_id UUID NOT NULL, operator_user_id UUID NOT NULL, binding_version INTEGER NOT NULL, access_epoch INTEGER NOT NULL,
 method TEXT NOT NULL CHECK(method IN ('self_wechat','assisted')), notice_version TEXT NOT NULL, evidence_ref TEXT NOT NULL,
 confirmed BOOLEAN NOT NULL, allow_in_book BOOLEAN NOT NULL, idempotency_key TEXT NOT NULL, request_hash CHAR(64) NOT NULL,
 assisted_evidence_id UUID REFERENCES assisted_version_evidence(id), created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(project_id,story_id,operator_user_id,idempotency_key), UNIQUE(project_id,evidence_ref),
 CHECK(confirmed OR NOT allow_in_book),
 FOREIGN KEY(project_id,story_id,revision_id,content_hash) REFERENCES story_revisions(project_id,story_id,id,content_hash),
 FOREIGN KEY(project_id,subject_id) REFERENCES project_subjects(project_id,id),
 FOREIGN KEY(operator_user_id) REFERENCES users(id)
);
CREATE TRIGGER immutable_story_decision BEFORE UPDATE ON story_decisions FOR EACH ROW EXECUTE FUNCTION immutable_story_content();
ALTER TABLE story_revisions ADD COLUMN operator_id TEXT, ADD COLUMN operator_realm TEXT,
 ADD COLUMN command_key TEXT, ADD COLUMN request_hash CHAR(64),
 ADD CONSTRAINT story_revision_command UNIQUE(project_id,story_id,operator_realm,operator_id,command_key);

ALTER TABLE story_revisions ADD COLUMN notes JSONB NOT NULL DEFAULT '[]', ADD COLUMN audio_manifest JSONB,
 ADD CONSTRAINT story_revision_generation_key UNIQUE(project_id,story_id,id,generation_task_id);
CREATE TABLE story_revision_audio (
 project_id UUID NOT NULL, story_id UUID NOT NULL, revision_id UUID NOT NULL, generation_task_id UUID NOT NULL, clip_id UUID NOT NULL,
 position INTEGER NOT NULL CHECK(position>=0), PRIMARY KEY(revision_id,position), UNIQUE(revision_id,clip_id),
 FOREIGN KEY(project_id,story_id,revision_id,generation_task_id) REFERENCES story_revisions(project_id,story_id,id,generation_task_id),
 FOREIGN KEY(generation_task_id,clip_id) REFERENCES story_sources(task_id,clip_id)
);
INSERT INTO story_revision_audio(project_id,story_id,revision_id,generation_task_id,clip_id,position)
 SELECT r.project_id,r.story_id,r.id,r.generation_task_id,s.clip_id,(row_number() OVER (PARTITION BY r.id ORDER BY s.sequence)-1)::int
 FROM story_revisions r JOIN story_sources s ON s.task_id=r.generation_task_id;
CREATE TRIGGER immutable_story_audio BEFORE UPDATE ON story_revision_audio FOR EACH ROW EXECUTE FUNCTION immutable_story_content();

ALTER TABLE story_revisions ADD COLUMN photo_snapshot_id UUID, ADD COLUMN photo_interview_id UUID, ADD COLUMN photo_snapshot JSONB;
ALTER TABLE stories ADD CONSTRAINT story_interview_key UNIQUE(project_id,id,interview_id);
ALTER TABLE story_revisions
 ADD CONSTRAINT story_photo_interview FOREIGN KEY(project_id,story_id,photo_interview_id) REFERENCES stories(project_id,id,interview_id),
 ADD CONSTRAINT story_photo_snapshot FOREIGN KEY(project_id,photo_interview_id,photo_snapshot_id) REFERENCES photo_snapshots(project_id,interview_id,id),
 ADD CONSTRAINT story_photo_pair CHECK((photo_snapshot_id IS NULL)=(photo_interview_id IS NULL));

ALTER TABLE projects ADD COLUMN book_title TEXT, ADD COLUMN metadata_version INTEGER NOT NULL DEFAULT 0 CHECK(metadata_version>=0);
CREATE TABLE project_metadata_commands (
 project_id UUID NOT NULL REFERENCES projects(id),actor_id UUID NOT NULL REFERENCES users(id),key TEXT NOT NULL,request_hash CHAR(64) NOT NULL,
 PRIMARY KEY(project_id,actor_id,key)
);

ALTER TABLE care_requests ADD CONSTRAINT care_project_key UNIQUE(project_id,id);
CREATE TABLE story_care_grants (
 case_id UUID PRIMARY KEY,project_id UUID NOT NULL,story_id UUID NOT NULL,revision_id UUID NOT NULL,subject_id UUID NOT NULL,operator_user_id UUID NOT NULL REFERENCES users(id),
 binding_version INTEGER NOT NULL,access_epoch INTEGER NOT NULL,expires_at TIMESTAMPTZ(3) NOT NULL,
 notice_version TEXT NOT NULL,evidence_ref TEXT NOT NULL,request_hash CHAR(64) NOT NULL,UNIQUE(project_id,evidence_ref),
 FOREIGN KEY(project_id,case_id) REFERENCES care_requests(project_id,id),
 FOREIGN KEY(project_id,story_id,revision_id) REFERENCES story_revisions(project_id,story_id,id),
 FOREIGN KEY(project_id,subject_id) REFERENCES project_subjects(project_id,id)
);
CREATE TRIGGER immutable_story_care_grant BEFORE UPDATE ON story_care_grants FOR EACH ROW EXECUTE FUNCTION immutable_story_content();
ALTER TABLE care_requests DROP CONSTRAINT care_requests_kind_check;
ALTER TABLE care_requests ADD CONSTRAINT care_requests_kind_check CHECK(kind IN ('rebind','withdraw','export','delete','correction'));

ALTER TABLE assisted_version_evidence ADD CONSTRAINT assisted_story_evidence_key
 UNIQUE(project_id,id,subject_id,operator_user_id,content_kind,version_id,content_hash);
ALTER TABLE story_decisions ADD COLUMN content_kind TEXT NOT NULL DEFAULT 'story' CHECK(content_kind='story'),
 ADD CONSTRAINT story_assisted_evidence_owner FOREIGN KEY(project_id,assisted_evidence_id,subject_id,operator_user_id,content_kind,revision_id,content_hash)
 REFERENCES assisted_version_evidence(project_id,id,subject_id,operator_user_id,content_kind,version_id,content_hash),
 ADD CONSTRAINT story_decision_evidence_method CHECK((method='assisted')=(assisted_evidence_id IS NOT NULL));
