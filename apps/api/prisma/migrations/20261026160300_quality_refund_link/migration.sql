ALTER TABLE quality_requests ADD COLUMN refund_id uuid UNIQUE,
 ADD FOREIGN KEY(order_id,refund_id) REFERENCES refunds(order_id,id);
CREATE FUNCTION protect_quality_refund_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.refund_id IS NOT NULL AND NEW.refund_id IS DISTINCT FROM OLD.refund_id THEN RAISE EXCEPTION 'Quality refund link is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_quality_refund_link BEFORE UPDATE ON quality_requests FOR EACH ROW EXECUTE FUNCTION protect_quality_refund_link();
