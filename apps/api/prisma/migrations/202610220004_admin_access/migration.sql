CREATE TABLE "admin_accounts" (
  "id" UUID PRIMARY KEY,
  "username" TEXT NOT NULL,
  "realm" TEXT NOT NULL CHECK (realm IN ('local', 'production')),
  "password_hash" TEXT NOT NULL,
  "mfa_secret" TEXT NOT NULL,
  "mfa_enrolled" BOOLEAN NOT NULL DEFAULT false,
  "last_totp_step" INTEGER NOT NULL DEFAULT -1,
  "permissions" TEXT[] NOT NULL,
  "disabled" BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX "admin_accounts_realm_username_key" ON "admin_accounts" ("realm", "username");
CREATE TABLE "admin_sessions" (
  "id" UUID PRIMARY KEY,
  "token_hash" CHAR(64) NOT NULL UNIQUE,
  "admin_id" UUID REFERENCES "admin_accounts" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "realm" TEXT NOT NULL CHECK (realm IN ('local', 'production')),
  "phase" TEXT NOT NULL CHECK (phase IN ('anonymous', 'password', 'authenticated')),
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "revoked_at" TIMESTAMPTZ(3)
);
CREATE INDEX "admin_sessions_expires_at_idx" ON "admin_sessions" ("expires_at");
CREATE INDEX "admin_sessions_admin_id_idx" ON "admin_sessions" ("admin_id");
CREATE TABLE "admin_audit" (
  "id" UUID PRIMARY KEY,
  "operator_id" UUID,
  "action" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "result" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "admin_audit_created_at_idx" ON "admin_audit" ("created_at");
