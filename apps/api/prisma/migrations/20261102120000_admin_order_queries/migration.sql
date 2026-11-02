ALTER TABLE admin_audit ADD COLUMN resource_type TEXT, ADD COLUMN resource_id TEXT;
CREATE INDEX admin_audit_resource ON admin_audit(resource_type,resource_id,created_at);
CREATE TABLE admin_order_notes (
 id UUID PRIMARY KEY,
 order_id UUID NOT NULL REFERENCES payment_orders(id),
 operator_id UUID NOT NULL REFERENCES admin_accounts(id),
 key TEXT NOT NULL,
 content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 2000),
 request_hash CHAR(64) NOT NULL,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
 UNIQUE(order_id,operator_id,key)
);
CREATE INDEX admin_order_notes_order_created ON admin_order_notes(order_id,created_at);
CREATE TRIGGER immutable_admin_order_note BEFORE UPDATE ON admin_order_notes FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
