CREATE TABLE invitations (
 id UUID PRIMARY KEY,
 project_id UUID NOT NULL REFERENCES projects(id),
 token_hash CHAR(64) NOT NULL UNIQUE,
 expires_at TIMESTAMPTZ(3) NOT NULL,
 consumed_at TIMESTAMPTZ(3)
);
CREATE INDEX invitation_project ON invitations(project_id);
CREATE UNIQUE INDEX one_active_invitation ON invitations(project_id) WHERE consumed_at IS NULL;
CREATE TABLE binding_requests (
 id UUID PRIMARY KEY,
 invitation_id UUID NOT NULL REFERENCES invitations(id),
 applicant_user_id UUID NOT NULL REFERENCES users(id),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected')),
 approved_by UUID REFERENCES users(id), notice_version TEXT NOT NULL, evidence_ref TEXT NOT NULL,
 UNIQUE(invitation_id,applicant_user_id)
);
ALTER TABLE projects ADD COLUMN access_epoch INTEGER NOT NULL DEFAULT 0 CHECK(access_epoch >= 0);
ALTER TABLE project_subjects ADD COLUMN bound_user_id UUID REFERENCES users(id), ADD COLUMN binding_version INTEGER NOT NULL DEFAULT 0 CHECK(binding_version >= 0);
CREATE TABLE participation_commands (
 project_id UUID NOT NULL REFERENCES projects(id), action TEXT NOT NULL, key TEXT NOT NULL,
 operator_id UUID NOT NULL, request_hash CHAR(64) NOT NULL, binding_version INTEGER NOT NULL, access_epoch INTEGER NOT NULL,
 PRIMARY KEY(project_id,action,key)
);
ALTER TABLE project_subjects ADD CONSTRAINT subject_project_identity UNIQUE(project_id,id);
CREATE TABLE consent_records (
 id UUID PRIMARY KEY, sequence SERIAL NOT NULL UNIQUE,
 project_id UUID NOT NULL, subject_id UUID NOT NULL,
 binding_version INTEGER NOT NULL, access_epoch INTEGER NOT NULL,
 operator_user_id UUID NOT NULL REFERENCES users(id), grantee_user_id UUID REFERENCES users(id),
 purpose TEXT NOT NULL CHECK(purpose IN ('collection','ai','sharing')), granted BOOLEAN NOT NULL,
 notice_version TEXT NOT NULL, method TEXT NOT NULL CHECK(method='self_wechat'), evidence_ref TEXT NOT NULL,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,subject_id) REFERENCES project_subjects(project_id,id)
);
CREATE INDEX consent_current_binding ON consent_records(project_id,binding_version);
CREATE TRIGGER immutable_consent_record BEFORE UPDATE ON consent_records FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
CREATE TABLE care_requests (
 id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES projects(id),
 requester_id UUID NOT NULL REFERENCES users(id), target_user_id UUID NOT NULL REFERENCES users(id),
 source_binding_version INTEGER NOT NULL CHECK(source_binding_version > 0),
 idempotency_key TEXT NOT NULL, request_hash CHAR(64) NOT NULL,
 kind TEXT NOT NULL CHECK(kind='rebind'), state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','completed')),
 completed_by UUID REFERENCES admin_accounts(id), created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
 UNIQUE(project_id,requester_id,idempotency_key)
);
CREATE INDEX care_project_time ON care_requests(project_id,created_at);
CREATE TABLE binding_changes (
 id UUID PRIMARY KEY, project_id UUID NOT NULL, subject_id UUID NOT NULL,
 from_user_id UUID REFERENCES users(id), to_user_id UUID NOT NULL REFERENCES users(id),
 source_binding_version INTEGER NOT NULL, binding_version INTEGER NOT NULL, access_epoch INTEGER NOT NULL,
 operator_id UUID NOT NULL, operator_realm TEXT NOT NULL CHECK(operator_realm IN ('product','admin')),
 support_case_id UUID REFERENCES care_requests(id), notice_version TEXT NOT NULL,
 method TEXT NOT NULL CHECK(method IN ('initiator_review','care_verified')),
 evidence_ref TEXT NOT NULL, request_id TEXT NOT NULL, created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
 UNIQUE(project_id,binding_version), FOREIGN KEY(project_id,subject_id) REFERENCES project_subjects(project_id,id),
 CHECK(binding_version=source_binding_version+1),
 CHECK((method='care_verified' AND operator_realm='admin' AND support_case_id IS NOT NULL) OR (method='initiator_review' AND operator_realm='product' AND support_case_id IS NULL))
);
CREATE TRIGGER immutable_binding_change BEFORE UPDATE ON binding_changes FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
