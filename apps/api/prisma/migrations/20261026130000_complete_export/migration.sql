CREATE TABLE care_exports (
 id uuid PRIMARY KEY REFERENCES care_requests(id), project_id uuid NOT NULL REFERENCES projects(id),
 subject_id uuid NOT NULL, binding_version integer NOT NULL CHECK(binding_version>=0), access_epoch integer NOT NULL CHECK(access_epoch>=0),
 recipient text NOT NULL CHECK(recipient IN ('self','initiator','verified_alternative')), recipient_user_id uuid REFERENCES users(id), recipient_ref text,
 evidence_ref text NOT NULL, state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','accepted','packing','ready','failed','expired','revoked','delivered')),
 owner_id uuid REFERENCES admin_accounts(id), requested_at timestamptz(3) NOT NULL DEFAULT now(), accepted_at timestamptz(3), due_at timestamptz(3),
 ready_at timestamptz(3), expires_at timestamptz(3), delivered_at timestamptz(3), delivery_evidence text,
 object_key text, sha256 char(64), bytes integer, manifest jsonb, missing_reason text,
 fence integer NOT NULL DEFAULT 0, lease_until timestamptz(3), review_hash char(64),
 UNIQUE(project_id,id), FOREIGN KEY(project_id,id) REFERENCES care_requests(project_id,id), FOREIGN KEY(project_id,subject_id) REFERENCES project_subjects(project_id,id),
 CHECK((recipient='verified_alternative' AND recipient_user_id IS NULL) OR (recipient<>'verified_alternative' AND recipient_user_id IS NOT NULL)),
 CHECK(expires_at IS NULL OR (ready_at IS NOT NULL AND expires_at>ready_at)),
 CHECK(bytes IS NULL OR bytes>0)
);
CREATE INDEX care_exports_project_state ON care_exports(project_id,state);
CREATE INDEX care_exports_expires_at ON care_exports(expires_at);

CREATE FUNCTION protect_complete_export() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id,NEW.project_id,NEW.subject_id,NEW.binding_version,NEW.access_epoch,NEW.recipient,NEW.recipient_user_id,NEW.recipient_ref,NEW.requested_at)
   IS DISTINCT FROM (OLD.id,OLD.project_id,OLD.subject_id,OLD.binding_version,OLD.access_epoch,OLD.recipient,OLD.recipient_user_id,OLD.recipient_ref,OLD.requested_at) THEN
   RAISE EXCEPTION 'Export request scope is immutable';
 END IF;
 IF OLD.ready_at IS NOT NULL AND (NEW.ready_at,NEW.expires_at,NEW.object_key,NEW.sha256,NEW.bytes)
   IS DISTINCT FROM (OLD.ready_at,OLD.expires_at,OLD.object_key,OLD.sha256,OLD.bytes) THEN
   RAISE EXCEPTION 'Export package and download window are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER care_exports_immutable BEFORE UPDATE ON care_exports FOR EACH ROW EXECUTE FUNCTION protect_complete_export();
