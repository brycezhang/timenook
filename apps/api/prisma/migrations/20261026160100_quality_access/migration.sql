ALTER TABLE quality_requests DROP CONSTRAINT quality_requests_state_check;
ALTER TABLE quality_requests ADD CONSTRAINT quality_requests_state_check CHECK(state IN ('requested','assigned'));
ALTER TABLE quality_requests ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0),
 ADD COLUMN owner_admin_id uuid REFERENCES admin_accounts(id), ADD COLUMN assigned_at timestamptz(3), ADD COLUMN due_at timestamptz(3), ADD COLUMN assignment_evidence_ref text;
CREATE TABLE quality_commands (
 request_id uuid NOT NULL REFERENCES quality_requests(id), actor_id uuid NOT NULL,
 action text NOT NULL, key text NOT NULL, request_hash char(64) NOT NULL,
 PRIMARY KEY(request_id,actor_id,action,key)
);
CREATE TABLE quality_grants (
 id uuid PRIMARY KEY, sequence serial NOT NULL UNIQUE,
 project_id uuid NOT NULL, request_id uuid NOT NULL, owner_admin_id uuid NOT NULL REFERENCES admin_accounts(id),
 actor_id uuid NOT NULL REFERENCES users(id), subject_id uuid NOT NULL REFERENCES project_subjects(id),
 binding_version integer NOT NULL, access_epoch integer NOT NULL,
 scopes text[] NOT NULL CHECK(cardinality(scopes)>0 AND scopes <@ ARRAY['pdf','evidence']::text[]),
 expires_at timestamptz(3) NOT NULL, notice_version text NOT NULL,
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(project_id,request_id) REFERENCES quality_requests(project_id,id)
);
CREATE INDEX quality_grants_request_id_sequence_idx ON quality_grants(request_id,sequence);
CREATE TRIGGER immutable_quality_command BEFORE UPDATE ON quality_commands FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
CREATE TRIGGER immutable_quality_grant BEFORE UPDATE ON quality_grants FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
