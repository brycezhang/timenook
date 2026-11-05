CREATE TABLE "web_login_tickets" (
  "id" UUID PRIMARY KEY,
  "user_id" UUID NOT NULL REFERENCES "users"("id"),
  "token_hash" CHAR(64) NOT NULL UNIQUE CHECK ("token_hash" ~ '^[a-f0-9]{64}$'),
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumed_at" TIMESTAMPTZ(3),
  "revoked_at" TIMESTAMPTZ(3)
);
CREATE INDEX "web_login_tickets_user_id_idx" ON "web_login_tickets"("user_id");
CREATE INDEX "web_login_tickets_expires_at_idx" ON "web_login_tickets"("expires_at");
CREATE TABLE "web_sessions" (
  "session_id" UUID PRIMARY KEY REFERENCES "sessions"("id"),
  "key_hash" CHAR(64) NOT NULL CHECK ("key_hash" ~ '^[a-f0-9]{64}$')
);
