-- S0 mapping only; no product identity, book version, consent or production authorization.
CREATE TABLE "probe_print_entries" (
  "id" VARCHAR(22) PRIMARY KEY CHECK ("id" ~ '^[A-Za-z0-9_-]{22}$'),
  "clip_id" UUID NOT NULL UNIQUE REFERENCES "probe_clips"("id") ON DELETE CASCADE,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
