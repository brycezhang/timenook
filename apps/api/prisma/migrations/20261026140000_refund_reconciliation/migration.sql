ALTER TABLE payment_orders ADD COLUMN production_frozen boolean NOT NULL DEFAULT false;
ALTER TABLE payment_orders ADD COLUMN first_copy_cancellation_required boolean NOT NULL DEFAULT false;
ALTER TABLE payment_orders ADD COLUMN creation_state text NOT NULL DEFAULT 'active'
 CHECK (creation_state IN ('active','suspended','terminated'));
CREATE OR REPLACE FUNCTION protect_order_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='paid' AND NEW.state <> 'paid' THEN RAISE EXCEPTION 'Verified payment cannot be erased'; END IF;
 IF (to_jsonb(NEW) - ARRAY['state','production_frozen','creation_state','first_copy_cancellation_required']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['state','production_frozen','creation_state','first_copy_cancellation_required']) THEN
  RAISE EXCEPTION 'Order snapshots are immutable';
 END IF;
 RETURN NEW;
END $$;
ALTER TABLE care_requests DROP CONSTRAINT care_requests_kind_check;
ALTER TABLE care_requests ADD CONSTRAINT care_requests_kind_check CHECK(kind IN ('rebind','withdraw','export','delete','correction','first_copy_expiry','production_handoff','refund'));
CREATE TABLE refunds (
 id uuid PRIMARY KEY,
 case_id uuid NOT NULL UNIQUE REFERENCES care_requests(id),
 order_id uuid NOT NULL REFERENCES payment_orders(id),
 project_id uuid NOT NULL REFERENCES projects(id),
 requester_id uuid NOT NULL REFERENCES users(id),
 request_key text NOT NULL,
 request_hash char(64) NOT NULL,
 reason text NOT NULL CHECK (reason IN ('notParticipated','usedNotProduced','inProduction','platformUnableDeliver','qualityDamaged','qualityMissingPages','qualityWrongVersion','qualityLayoutError')),
 state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','approved','unknown','processing','abnormal','succeeded','closed','rejected')),
 amount integer CHECK (amount > 0 AND amount <= 99900),
 out_refund_no text NOT NULL UNIQUE,
 provider_refund_id text UNIQUE,
 rule jsonb,
 evidence_ref text NOT NULL,
 approved_by uuid REFERENCES admin_accounts(id),
 approved_at timestamptz(3),
 due_at timestamptz(3),
 submitted_at timestamptz(3),
 completed_at timestamptz(3),
 production_evidence text,
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(order_id,requester_id,request_key), UNIQUE(order_id,id)
);
CREATE INDEX refunds_state_created_at_idx ON refunds(state,created_at);
CREATE TABLE refund_commands (
 refund_id uuid NOT NULL REFERENCES refunds(id), actor_id uuid NOT NULL REFERENCES admin_accounts(id),
 action text NOT NULL, key text NOT NULL, request_hash char(64) NOT NULL, payload jsonb NOT NULL,
 PRIMARY KEY(refund_id,actor_id,action,key)
);
CREATE TABLE refund_inbox (
 event_id text PRIMARY KEY, refund_id uuid NOT NULL REFERENCES refunds(id),
 payload_hash char(64) NOT NULL, verified_refund jsonb NOT NULL,
 verified_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, processed_at timestamptz(3)
);
CREATE INDEX refund_inbox_processed_at_idx ON refund_inbox(processed_at);
CREATE FUNCTION protect_refund_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'refund financial facts are retained'; END IF;
 IF (OLD.id,OLD.case_id,OLD.order_id,OLD.project_id,OLD.requester_id,OLD.request_key,OLD.request_hash,OLD.reason,OLD.out_refund_no,OLD.evidence_ref,OLD.created_at)
 IS DISTINCT FROM
 (NEW.id,NEW.case_id,NEW.order_id,NEW.project_id,NEW.requester_id,NEW.request_key,NEW.request_hash,NEW.reason,NEW.out_refund_no,NEW.evidence_ref,NEW.created_at)
 THEN RAISE EXCEPTION 'refund intent is immutable'; END IF;
 IF OLD.approved_at IS NOT NULL AND (OLD.amount,OLD.rule,OLD.approved_by,OLD.approved_at,OLD.due_at)
 IS DISTINCT FROM (NEW.amount,NEW.rule,NEW.approved_by,NEW.approved_at,NEW.due_at)
 THEN RAISE EXCEPTION 'approved refund is immutable'; END IF;
 IF OLD.state='succeeded' AND NEW.state<>'succeeded' THEN RAISE EXCEPTION 'refund success is permanent'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER refund_intent_immutable BEFORE UPDATE OR DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION protect_refund_intent();
ALTER TABLE refunds ADD FOREIGN KEY(order_id,project_id) REFERENCES projects(order_id,id);
CREATE TRIGGER refund_commands_immutable BEFORE UPDATE OR DELETE ON refund_commands FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
