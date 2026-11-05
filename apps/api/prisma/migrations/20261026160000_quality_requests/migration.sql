ALTER TABLE care_requests DROP CONSTRAINT care_requests_kind_check;
ALTER TABLE care_requests ADD CONSTRAINT care_requests_kind_check CHECK(kind IN ('rebind','withdraw','export','delete','correction','production_handoff','refund','quality'));
CREATE TABLE quality_requests (
 id uuid PRIMARY KEY, case_id uuid NOT NULL UNIQUE REFERENCES care_requests(id),
 order_id uuid NOT NULL REFERENCES payment_orders(id),
 production_order_id uuid NOT NULL REFERENCES first_copy_orders(id),
 project_id uuid NOT NULL REFERENCES projects(id), original_attempt_id uuid NOT NULL,
 requester_id uuid NOT NULL REFERENCES users(id),
 reason text NOT NULL CHECK(reason IN ('qualityDamaged','qualityMissingPages','qualityWrongVersion','qualityLayoutError')),
 state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested')),
 request_key text NOT NULL, request_hash char(64) NOT NULL,
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(order_id,requester_id,request_key), UNIQUE(project_id,id),
 FOREIGN KEY(project_id,production_order_id) REFERENCES first_copy_orders(project_id,id),
 FOREIGN KEY(production_order_id,original_attempt_id) REFERENCES fulfillment_attempts(order_id,id)
);
CREATE INDEX quality_requests_project_id_created_at_idx ON quality_requests(project_id,created_at);
CREATE TABLE quality_evidence (
 request_id uuid PRIMARY KEY, project_id uuid NOT NULL,
 category text NOT NULL DEFAULT 'quality_evidence' CHECK(category='quality_evidence'),
 description text CHECK(length(description)<=1500), erased_at timestamptz(3),
 FOREIGN KEY(project_id,request_id) REFERENCES quality_requests(project_id,id)
);
CREATE FUNCTION protect_quality_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id,NEW.case_id,NEW.order_id,NEW.production_order_id,NEW.project_id,NEW.original_attempt_id,NEW.requester_id,NEW.reason,NEW.request_key,NEW.request_hash,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.case_id,OLD.order_id,OLD.production_order_id,OLD.project_id,OLD.original_attempt_id,OLD.requester_id,OLD.reason,OLD.request_key,OLD.request_hash,OLD.created_at) THEN RAISE EXCEPTION 'Quality original identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_quality_identity BEFORE UPDATE ON quality_requests FOR EACH ROW EXECUTE FUNCTION protect_quality_identity();
