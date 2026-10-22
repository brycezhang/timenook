CREATE TABLE probe_ai_runs (
  id UUID PRIMARY KEY,
  clip_id UUID NOT NULL REFERENCES probe_clips(id) ON DELETE CASCADE,
  input JSONB NOT NULL,
  configuration JSONB NOT NULL,
  configuration_hash CHAR(64) NOT NULL,
  fence INTEGER NOT NULL DEFAULT 0,
  lease_until TIMESTAMPTZ(3),
  submitted_at TIMESTAMPTZ(3),
  completed_at TIMESTAMPTZ(3),
  provider_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'ready',
  original_transcript TEXT,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE probe_ai_generations (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES probe_ai_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('question','story')),
  state TEXT NOT NULL DEFAULT 'generating',
  transcript_hash CHAR(64) NOT NULL,
  output JSONB,
  usage JSONB,
  model TEXT,
  failure TEXT,
  started_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ(3)
);
CREATE INDEX probe_ai_generations_run_id_idx ON probe_ai_generations(run_id);
