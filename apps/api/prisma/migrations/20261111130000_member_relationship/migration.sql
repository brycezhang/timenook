ALTER TABLE project_members ADD COLUMN relationship VARCHAR(32);
ALTER TABLE project_members ADD COLUMN privacy_erased_columns TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE privacy_erasure_registry DISABLE TRIGGER immutable_erasure_registry;
INSERT INTO privacy_erasure_registry (table_name, category, columns, key_columns)
VALUES ('project_members', 'activeData', ARRAY['relationship'], ARRAY['project_id','user_id']);
ALTER TABLE privacy_erasure_registry ENABLE TRIGGER immutable_erasure_registry;
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON project_members FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON project_members FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
