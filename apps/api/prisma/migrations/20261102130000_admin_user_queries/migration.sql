CREATE TABLE admin_user_notes (
 id UUID PRIMARY KEY,
 user_id UUID NOT NULL REFERENCES users(id),
 operator_id UUID NOT NULL REFERENCES admin_accounts(id),
 key TEXT NOT NULL,
 content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 2000),
 request_hash CHAR(64) NOT NULL,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
 UNIQUE(user_id,operator_id,key)
);
CREATE INDEX admin_user_notes_user_created ON admin_user_notes(user_id,created_at);
CREATE TRIGGER immutable_admin_user_note BEFORE UPDATE ON admin_user_notes FOR EACH ROW EXECUTE FUNCTION protect_service_terms();
