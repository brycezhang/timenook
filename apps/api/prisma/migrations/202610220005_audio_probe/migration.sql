CREATE TABLE "probe_clips" (
  "id" UUID PRIMARY KEY,
  "owner_id" UUID NOT NULL,
  "client_clip_id" UUID NOT NULL,
  "bytes" INTEGER NOT NULL CHECK ("bytes" BETWEEN 1 AND 2097152),
  "sha256" CHAR(64) NOT NULL CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  "state" TEXT NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending', 'sealed')),
  "duration_ms" INTEGER,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "probe_clips_sealed_metadata" CHECK (
    ("state" = 'pending' AND "duration_ms" IS NULL) OR
    ("state" = 'sealed' AND "duration_ms" BETWEEN 1 AND 300000)
  )
);
CREATE UNIQUE INDEX "probe_clips_owner_id_client_clip_id_key" ON "probe_clips"("owner_id", "client_clip_id");
