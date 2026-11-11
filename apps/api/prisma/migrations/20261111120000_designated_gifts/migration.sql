CREATE TABLE "project_gifts" (
  "project_id" UUID PRIMARY KEY REFERENCES "projects"("id"),
  "recipient_name" VARCHAR(32),
  "recipient_phone" VARCHAR(32),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "token" VARCHAR(43),
  "token_hash" CHAR(64) UNIQUE,
  "claimed_by_user_id" UUID REFERENCES "users"("id"),
  "claimed_at" TIMESTAMPTZ(3),
  "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "privacy_erased_columns" TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX "project_gifts_claimed_by_user_id_idx" ON "project_gifts"("claimed_by_user_id");

ALTER TABLE privacy_erasure_registry DISABLE TRIGGER immutable_erasure_registry;
INSERT INTO privacy_erasure_registry (table_name, category, columns, key_columns)
VALUES ('project_gifts', 'activeData', ARRAY['recipient_name','recipient_phone','token','token_hash','claimed_by_user_id'], ARRAY['project_id']);
ALTER TABLE privacy_erasure_registry ENABLE TRIGGER immutable_erasure_registry;
CREATE TRIGGER privacy_payload_guard BEFORE UPDATE OR DELETE ON project_gifts FOR EACH ROW EXECUTE FUNCTION privacy_payload_guard();
CREATE TRIGGER privacy_deny_new_payload BEFORE INSERT OR UPDATE ON project_gifts FOR EACH ROW EXECUTE FUNCTION privacy_deny_new_payload();
