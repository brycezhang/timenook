ALTER TABLE quality_requests DROP CONSTRAINT quality_requests_state_check;
ALTER TABLE quality_requests ADD CONSTRAINT quality_requests_state_check CHECK(state IN ('requested','assigned','reviewed','reprinting','refund_requested','completed'));
ALTER TABLE quality_requests ADD COLUMN resolution text CHECK(resolution IN ('reprint','refund')),
 ADD COLUMN reprint_mode text CHECK(reprint_mode IN ('original','revised')),
 ADD COLUMN reviewed_at timestamptz(3), ADD COLUMN review_evidence_ref text,
 ADD COLUMN request_window_started_at timestamptz(3), ADD COLUMN request_window_ends_at timestamptz(3);
ALTER TABLE fulfillment_attempts ADD COLUMN quality_request_id uuid,
 ADD FOREIGN KEY(project_id,quality_request_id) REFERENCES quality_requests(project_id,id);
DROP INDEX one_live_fulfillment_attempt;
CREATE UNIQUE INDEX one_live_fulfillment_attempt ON fulfillment_attempts(order_id) WHERE state NOT IN ('cancelled','delivered');
CREATE UNIQUE INDEX one_reviewed_quality_reprint ON quality_requests(production_order_id) WHERE resolution='reprint' AND state IN ('reviewed','reprinting');
CREATE FUNCTION protect_quality_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.assigned_at IS NOT NULL AND (NEW.owner_admin_id,NEW.assigned_at,NEW.due_at) IS DISTINCT FROM (OLD.owner_admin_id,OLD.assigned_at,OLD.due_at) THEN RAISE EXCEPTION 'Quality owner and deadline are fixed'; END IF;
 IF OLD.reviewed_at IS NOT NULL AND (NEW.resolution,NEW.reprint_mode,NEW.reviewed_at,NEW.request_window_started_at,NEW.request_window_ends_at) IS DISTINCT FROM (OLD.resolution,OLD.reprint_mode,OLD.reviewed_at,OLD.request_window_started_at,OLD.request_window_ends_at) THEN RAISE EXCEPTION 'Quality review is fixed'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_quality_review BEFORE UPDATE ON quality_requests FOR EACH ROW EXECUTE FUNCTION protect_quality_review();
