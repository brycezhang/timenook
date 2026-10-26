ALTER TABLE refunds ADD COLUMN request_window_started_at timestamptz(3), ADD COLUMN request_window_ends_at timestamptz(3);
ALTER TABLE refunds ADD CHECK ((request_window_started_at IS NULL AND request_window_ends_at IS NULL) OR (request_window_started_at IS NOT NULL AND request_window_ends_at > request_window_started_at));
-- Preserve the original ledger and existing approvals; earlier approvals do
-- not acquire invented timing evidence. Newly verified requests record both
-- application eligibility facts alongside their independently fixed deadline.
CREATE OR REPLACE FUNCTION protect_refund_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'refund financial facts are retained'; END IF;
 IF (OLD.id,OLD.case_id,OLD.order_id,OLD.project_id,OLD.requester_id,OLD.request_key,OLD.request_hash,OLD.reason,OLD.out_refund_no,OLD.evidence_ref,OLD.created_at)
 IS DISTINCT FROM
 (NEW.id,NEW.case_id,NEW.order_id,NEW.project_id,NEW.requester_id,NEW.request_key,NEW.request_hash,NEW.reason,NEW.out_refund_no,NEW.evidence_ref,NEW.created_at)
 THEN RAISE EXCEPTION 'refund intent is immutable'; END IF;
 IF OLD.approved_at IS NOT NULL AND (OLD.amount,OLD.rule,OLD.approved_by,OLD.approved_at,OLD.due_at,OLD.request_window_started_at,OLD.request_window_ends_at)
 IS DISTINCT FROM (NEW.amount,NEW.rule,NEW.approved_by,NEW.approved_at,NEW.due_at,NEW.request_window_started_at,NEW.request_window_ends_at)
 THEN RAISE EXCEPTION 'approved refund is immutable'; END IF;
 IF OLD.state='succeeded' AND NEW.state<>'succeeded' THEN RAISE EXCEPTION 'refund success is permanent'; END IF;
 RETURN NEW;
END $$;
