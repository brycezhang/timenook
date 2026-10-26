CREATE TABLE project_access_revocations (
 id UUID PRIMARY KEY,
 project_id UUID NOT NULL REFERENCES projects(id),
 access_epoch INTEGER NOT NULL CHECK(access_epoch>=0),
 purpose TEXT NOT NULL CHECK(purpose IN ('collection','ai','sharing','all','binding')),
 reason TEXT NOT NULL CHECK(reason IN ('self_wechat','assisted','care_verified','rebind')),
 applied_at TIMESTAMPTZ(3),
 production_action TEXT CHECK(production_action IN ('not_required','not_started','stopped_before_handoff','supplier_pending','already_delivered')),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION protect_project_access_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (NEW.id,NEW.project_id,NEW.access_epoch,NEW.purpose,NEW.reason,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.project_id,OLD.access_epoch,OLD.purpose,OLD.reason,OLD.created_at) OR (OLD.applied_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
  RAISE EXCEPTION 'access revocation is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_project_access_revocation BEFORE UPDATE OR DELETE ON project_access_revocations FOR EACH ROW EXECUTE FUNCTION protect_project_access_revocation();

ALTER TABLE care_requests ADD COLUMN withdrawal_purpose TEXT CHECK(withdrawal_purpose IN ('collection','ai','sharing'));
ALTER TABLE care_requests ADD CHECK(withdrawal_purpose IS NULL OR kind='withdraw');

CREATE INDEX project_access_revocations_epoch ON project_access_revocations(project_id,access_epoch);
