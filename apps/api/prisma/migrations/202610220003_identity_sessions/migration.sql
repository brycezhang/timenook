CREATE TABLE "users" (
  "id" UUID PRIMARY KEY,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "wechat_identities" (
  "app_id" TEXT NOT NULL,
  "open_id" TEXT NOT NULL,
  "user_id" UUID NOT NULL REFERENCES "users"("id"),
  PRIMARY KEY ("app_id", "open_id")
);
CREATE INDEX "wechat_identities_user_id_idx" ON "wechat_identities"("user_id");

CREATE TABLE "sessions" (
  "id" UUID PRIMARY KEY,
  "user_id" UUID NOT NULL REFERENCES "users"("id"),
  "token_hash" CHAR(64) NOT NULL UNIQUE,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "revoked_at" TIMESTAMPTZ(3),
  CONSTRAINT "session_hash_format" CHECK ("token_hash" ~ '^[a-f0-9]{64}$')
);
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

CREATE TABLE "wechat_code_redemptions" (
  "app_id" TEXT NOT NULL,
  "code_hash" CHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  PRIMARY KEY ("app_id", "code_hash"),
  CONSTRAINT "code_hash_format" CHECK ("code_hash" ~ '^[a-f0-9]{64}$')
);
CREATE INDEX "wechat_code_redemptions_expires_at_idx" ON "wechat_code_redemptions"("expires_at");
