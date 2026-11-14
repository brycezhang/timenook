ALTER TABLE admin_accounts
  ADD COLUMN password_ciphertext TEXT,
  ADD COLUMN deleted_at TIMESTAMPTZ(3);

ALTER TABLE admin_accounts
  ADD CONSTRAINT admin_account_password_ciphertext_check
    CHECK (password_ciphertext IS NULL OR (role = 'partner' AND password_hash IS NOT NULL)),
  ADD CONSTRAINT admin_account_deleted_check
    CHECK (deleted_at IS NULL OR
      (role = 'partner' AND disabled AND password_hash IS NULL AND password_ciphertext IS NULL));
