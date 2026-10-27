-- Preserve the actual assisted purpose used for this dedicated operational grant.
-- A legacy assisted grant without its source session must be explicitly renewed.
ALTER TABLE quality_grants ADD COLUMN assisted_session_id uuid REFERENCES assisted_sessions(id);
