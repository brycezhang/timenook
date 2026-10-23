ALTER TABLE consent_records DROP CONSTRAINT consent_records_method_check;
ALTER TABLE consent_records ADD CONSTRAINT consent_records_method_check CHECK(method IN ('self_wechat','assisted','care_verified'));
CREATE TABLE assisted_sessions (
 id UUID PRIMARY KEY, project_id UUID NOT NULL, subject_id UUID NOT NULL,
 operator_user_id UUID NOT NULL REFERENCES users(id), purpose TEXT NOT NULL CHECK(purpose IN ('collection','ai','sharing','story_confirmation','book_confirmation')),
 granted BOOLEAN NOT NULL, notice_version TEXT NOT NULL, evidence_ref TEXT NOT NULL,
 binding_version INTEGER NOT NULL CHECK(binding_version>=0), access_epoch INTEGER NOT NULL CHECK(access_epoch>=0),
 idempotency_key TEXT NOT NULL, request_hash CHAR(64) NOT NULL,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ(3) NOT NULL,
 FOREIGN KEY(project_id,subject_id) REFERENCES project_subjects(project_id,id),
 UNIQUE(project_id,operator_user_id,idempotency_key), UNIQUE(project_id,evidence_ref), CHECK(expires_at>created_at)
);
CREATE INDEX assisted_project_time ON assisted_sessions(project_id,created_at);
CREATE TRIGGER immutable_assisted_session BEFORE UPDATE ON assisted_sessions FOR EACH ROW EXECUTE FUNCTION protect_service_terms();

CREATE TABLE assisted_version_evidence (
 id UUID PRIMARY KEY, project_id UUID NOT NULL, subject_id UUID NOT NULL,
 operator_user_id UUID NOT NULL REFERENCES users(id), session_id UUID NOT NULL REFERENCES assisted_sessions(id),
 content_kind TEXT NOT NULL CHECK(content_kind IN ('story','book')), version_id UUID NOT NULL, content_hash CHAR(64) NOT NULL,
 notice_version TEXT NOT NULL, evidence_ref TEXT NOT NULL,
 binding_version INTEGER NOT NULL CHECK(binding_version>=0), access_epoch INTEGER NOT NULL CHECK(access_epoch>=0),
 idempotency_key TEXT NOT NULL, request_hash CHAR(64) NOT NULL, created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,subject_id) REFERENCES project_subjects(project_id,id),
 UNIQUE(project_id,idempotency_key), UNIQUE(project_id,evidence_ref)
);
CREATE TRIGGER immutable_assisted_version_evidence BEFORE UPDATE ON assisted_version_evidence FOR EACH ROW EXECUTE FUNCTION protect_service_terms();

ALTER TABLE care_requests ALTER COLUMN requester_id DROP NOT NULL;
ALTER TABLE care_requests ADD COLUMN requester_subject_id UUID, ADD COLUMN operator_id UUID, ADD COLUMN operator_realm TEXT NOT NULL DEFAULT 'product' CHECK(operator_realm IN ('product','admin'));
UPDATE care_requests SET operator_id=requester_id;
ALTER TABLE care_requests ALTER COLUMN operator_id SET NOT NULL;
ALTER TABLE care_requests ADD FOREIGN KEY(project_id,requester_subject_id) REFERENCES project_subjects(project_id,id);
ALTER TABLE care_requests DROP CONSTRAINT care_requests_project_id_requester_id_idempotency_key_key;
ALTER TABLE care_requests ADD UNIQUE(project_id,operator_id,operator_realm,idempotency_key);
ALTER TABLE care_requests DROP CONSTRAINT care_requests_source_binding_version_check;
ALTER TABLE care_requests ADD CHECK(source_binding_version>=0);

ALTER TABLE consent_records ALTER COLUMN operator_user_id DROP NOT NULL;
ALTER TABLE consent_records ADD COLUMN operator_admin_id UUID REFERENCES admin_accounts(id);
ALTER TABLE consent_records ADD CHECK((operator_user_id IS NULL) <> (operator_admin_id IS NULL));
ALTER TABLE care_requests ALTER COLUMN target_user_id DROP NOT NULL;
ALTER TABLE care_requests DROP CONSTRAINT care_requests_kind_check;
ALTER TABLE care_requests ADD CHECK(kind IN ('rebind','withdraw','export','delete'));
ALTER TABLE care_requests DROP CONSTRAINT care_requests_state_check;
ALTER TABLE care_requests ADD CHECK(state IN ('open','verified','completed'));
ALTER TABLE care_requests ADD COLUMN source_access_epoch INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN verification_key TEXT, ADD COLUMN verification_hash CHAR(64), ADD COLUMN verification_evidence TEXT, ADD COLUMN verification_notice TEXT,
 ADD COLUMN verified_by UUID REFERENCES admin_accounts(id), ADD COLUMN verified_at TIMESTAMPTZ(3), ADD COLUMN revoked_access_epoch INTEGER;
