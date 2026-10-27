-- Monotonic committed revocation order, independent of wall-clock precision.
ALTER TABLE project_access_revocations
 ADD COLUMN sequence SERIAL NOT NULL,
 ADD COLUMN capture_version INTEGER NOT NULL DEFAULT 0 CHECK(capture_version IN (0,1)),
 ADD COLUMN task_fences JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(task_fences)='array'),
 ADD COLUMN source_session_id UUID,
 ADD COLUMN target_attempt_id UUID;
CREATE UNIQUE INDEX project_access_revocations_sequence_key ON project_access_revocations(sequence);
CREATE INDEX project_access_revocations_project_sequence ON project_access_revocations(project_id,sequence);
-- Existing records cannot safely infer which later same-epoch work they intended.
-- Leave old pending records visible for manual reconciliation, never retarget them.
ALTER TABLE project_access_revocations ALTER COLUMN capture_version SET DEFAULT 1;
CREATE OR REPLACE FUNCTION protect_project_access_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (NEW.id,NEW.sequence,NEW.project_id,NEW.access_epoch,NEW.purpose,NEW.reason,NEW.created_at,NEW.capture_version,NEW.task_fences,NEW.source_session_id,NEW.target_attempt_id) IS DISTINCT FROM (OLD.id,OLD.sequence,OLD.project_id,OLD.access_epoch,OLD.purpose,OLD.reason,OLD.created_at,OLD.capture_version,OLD.task_fences,OLD.source_session_id,OLD.target_attempt_id) OR (OLD.applied_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
  RAISE EXCEPTION 'access revocation is immutable';
 END IF;
 RETURN NEW;
END $$;
