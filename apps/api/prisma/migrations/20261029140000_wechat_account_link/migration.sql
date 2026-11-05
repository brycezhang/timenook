CREATE TABLE "wechat_links" (
  "id" UUID PRIMARY KEY,
  "user_id" UUID NOT NULL REFERENCES "users"("id"),
  "session_id" UUID NOT NULL REFERENCES "sessions"("id"),
  "code_hash" CHAR(64) NOT NULL UNIQUE,
  "proof_hash" CHAR(64) UNIQUE,
  "verification_code" CHAR(6),
  "app_id" TEXT,
  "open_id" TEXT,
  "state" TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'paired', 'linked', 'cancelled')),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "web_confirmed" BOOLEAN NOT NULL DEFAULT false,
  "native_confirmed" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "wechat_links_session_id_idx" ON "wechat_links"("session_id");
CREATE INDEX "wechat_links_app_id_open_id_idx" ON "wechat_links"("app_id", "open_id");
CREATE INDEX "wechat_links_expires_at_idx" ON "wechat_links"("expires_at");
