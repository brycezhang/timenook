ALTER TABLE admin_accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'super_admin', ADD COLUMN password_hash TEXT;
ALTER TABLE admin_accounts ADD CONSTRAINT admin_account_role CHECK (role IN ('super_admin', 'partner'));
ALTER TABLE admin_accounts DROP CONSTRAINT admin_accounts_active_feishu_binding_check;
ALTER TABLE admin_accounts ADD CONSTRAINT admin_accounts_active_identity_check CHECK (disabled OR
  (role = 'super_admin' AND feishu_app_id IS NOT NULL AND feishu_app_id <> '' AND feishu_open_id IS NOT NULL AND feishu_open_id <> '' AND tenant_key IS NOT NULL AND tenant_key <> '' AND password_hash IS NULL) OR
  (role = 'partner' AND password_hash IS NOT NULL AND feishu_app_id IS NULL AND feishu_open_id IS NULL AND tenant_key IS NULL));
UPDATE admin_accounts SET permissions = ARRAY['orders:read','orders:write','fulfillment:write','tasks:retry','care:write','ops:read','audit:read','catalog:read','catalog:write','catalog:freeze','channel-gifts:read','channel-gifts:write','partners:manage'] WHERE role='super_admin';
