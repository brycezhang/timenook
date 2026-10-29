CREATE TABLE export_staff_grants (
 id uuid PRIMARY KEY, sequence bigserial UNIQUE,
 project_id uuid NOT NULL REFERENCES projects(id), case_id uuid NOT NULL,
 subject_id uuid NOT NULL, admin_id uuid NOT NULL REFERENCES admin_accounts(id),
 binding_version integer NOT NULL, access_epoch integer NOT NULL, access_sequence integer NOT NULL,
 key text NOT NULL, request_hash char(64) NOT NULL,
 source text NOT NULL CHECK(source IN ('case_verification','renewed_verification')),
 purpose text NOT NULL CHECK(purpose='complete_export_delivery'), notice_version text NOT NULL,
 identity_procedure_ref text NOT NULL, confirmation_channel_ref text NOT NULL,
 recipient_hash char(64) NOT NULL, evidence_hash char(64) NOT NULL,
 verified_at timestamptz(3) NOT NULL, expires_at timestamptz(3) NOT NULL,
 UNIQUE(case_id,key), UNIQUE(source,evidence_hash), FOREIGN KEY(project_id,case_id) REFERENCES care_exports(project_id,id),
 FOREIGN KEY(project_id,subject_id) REFERENCES project_subjects(project_id,id),
 CHECK(expires_at>verified_at AND expires_at<=verified_at+interval '30 minutes')
);
CREATE INDEX export_staff_grant_case_sequence ON export_staff_grants(case_id,sequence);
CREATE FUNCTION protect_export_staff_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Export staff authorization facts are immutable'; END $$;
CREATE TRIGGER immutable_export_staff_grant BEFORE UPDATE OR DELETE ON export_staff_grants FOR EACH ROW EXECUTE FUNCTION protect_export_staff_grant();
