-- Preserve the exact file/address/confirmations for every attempt while the
-- unique business order may acquire a newly confirmed reservation after cancellation.
ALTER TABLE first_copy_orders ADD COLUMN reservation_revision INTEGER NOT NULL DEFAULT 1 CHECK(reservation_revision>0);
ALTER TABLE fulfillment_attempts
 ADD COLUMN reservation_revision INTEGER,
 ADD COLUMN book_id UUID,
 ADD COLUMN snapshot_hash CHAR(64),
 ADD COLUMN pdf_hash CHAR(64),
 ADD COLUMN address_hash CHAR(64),
 ADD COLUMN address JSONB,
 ADD COLUMN narrator_confirmation_id UUID,
 ADD COLUMN initiator_confirmation_id UUID;
UPDATE fulfillment_attempts attempt SET
 reservation_revision=orders.reservation_revision,
 book_id=orders.book_id,
 snapshot_hash=orders.snapshot_hash,
 pdf_hash=orders.pdf_hash,
 address_hash=orders.address_hash,
 address=orders.address,
 narrator_confirmation_id=orders.narrator_confirmation_id,
 initiator_confirmation_id=orders.initiator_confirmation_id
 FROM first_copy_orders orders WHERE orders.id=attempt.order_id;
ALTER TABLE fulfillment_attempts
 ALTER COLUMN reservation_revision SET NOT NULL,
 ALTER COLUMN book_id SET NOT NULL,
 ALTER COLUMN snapshot_hash SET NOT NULL,
 ALTER COLUMN pdf_hash SET NOT NULL,
 ALTER COLUMN address_hash SET NOT NULL,
 ALTER COLUMN address SET NOT NULL,
 ALTER COLUMN narrator_confirmation_id SET NOT NULL,
 ALTER COLUMN initiator_confirmation_id SET NOT NULL,
 ADD CHECK(reservation_revision>0),
 ADD FOREIGN KEY(project_id,book_id) REFERENCES book_versions(project_id,id),
 ADD FOREIGN KEY(narrator_confirmation_id) REFERENCES book_confirmations(id),
 ADD FOREIGN KEY(initiator_confirmation_id) REFERENCES book_confirmations(id);

CREATE FUNCTION protect_fulfillment_attempt_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'state'-'receipt_ref'-'tracking'-'wechat'-'delivered_at') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'receipt_ref'-'tracking'-'wechat'-'delivered_at') THEN
  RAISE EXCEPTION 'Production attempt binding is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_fulfillment_attempt_binding BEFORE UPDATE ON fulfillment_attempts FOR EACH ROW EXECUTE FUNCTION protect_fulfillment_attempt_binding();

CREATE OR REPLACE FUNCTION protect_first_copy_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id,NEW.project_id,NEW.entitlement_id,NEW.payment_order_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.project_id,OLD.entitlement_id,OLD.payment_order_id,OLD.created_at) THEN
  RAISE EXCEPTION 'First copy identity is immutable';
 END IF;
 IF NEW.reservation_revision IS DISTINCT FROM OLD.reservation_revision OR
    (to_jsonb(NEW)-'state'-'approved_by'-'approved_at'-'reservation_revision') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'approved_by'-'approved_at'-'reservation_revision') THEN
  IF NEW.reservation_revision<>OLD.reservation_revision+1 OR NEW.state<>'reserved' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL OR
     NOT EXISTS (SELECT 1 FROM fulfillment_attempts WHERE order_id=OLD.id AND reservation_revision=OLD.reservation_revision AND state='cancelled') OR
     EXISTS (SELECT 1 FROM fulfillment_attempts WHERE order_id=OLD.id AND state<>'cancelled') THEN
   RAISE EXCEPTION 'A new reservation requires confirmed cancellation';
  END IF;
 ELSIF OLD.state='approved' AND NEW.state<>'approved' THEN
  RAISE EXCEPTION 'Approved reservation cannot regress';
 END IF;
 RETURN NEW;
END $$;
ALTER TABLE fulfillment_events DROP CONSTRAINT fulfillment_events_kind_check;
ALTER TABLE fulfillment_events ADD CONSTRAINT fulfillment_events_kind_check CHECK(kind ~ '^(reserved|approved)(:[1-9][0-9]*)?$');
