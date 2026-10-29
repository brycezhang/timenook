-- Development identity model: password/MFA credentials are no longer accepted.
-- Existing bound administrator sessions must not survive the identity change.
UPDATE "admin_sessions" SET "revoked_at" = CURRENT_TIMESTAMP WHERE "revoked_at" IS NULL;
ALTER TABLE "admin_accounts"
  DROP COLUMN "password_hash", DROP COLUMN "mfa_secret",
  DROP COLUMN "mfa_enrolled", DROP COLUMN "last_totp_step",
  ADD COLUMN "feishu_app_id" TEXT,
  ADD COLUMN "feishu_open_id" TEXT,
  ADD COLUMN "tenant_key" TEXT;
-- Historical business records retain their operator IDs. Old credentials do not
-- identify a Feishu principal, so these actors stay disabled and unbound.
UPDATE "admin_accounts" SET "disabled" = true;
ALTER TABLE "admin_accounts" ADD CONSTRAINT "admin_accounts_active_feishu_binding_check"
  CHECK (disabled OR (feishu_app_id IS NOT NULL AND feishu_app_id <> ''
    AND feishu_open_id IS NOT NULL AND feishu_open_id <> ''
    AND tenant_key IS NOT NULL AND tenant_key <> ''));
ALTER TABLE "admin_sessions" ADD COLUMN "identity_hash" CHAR(64);
DELETE FROM "admin_sessions" WHERE "phase" = 'password';
ALTER TABLE "admin_sessions" DROP CONSTRAINT "admin_sessions_phase_check";
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_phase_check"
  CHECK (phase IN ('anonymous', 'authenticated'));
CREATE UNIQUE INDEX "admin_accounts_realm_feishu_app_id_tenant_key_feishu_open_id_key"
  ON "admin_accounts"("realm", "feishu_app_id", "tenant_key", "feishu_open_id");
