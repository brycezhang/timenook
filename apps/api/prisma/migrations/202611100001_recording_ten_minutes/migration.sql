ALTER TABLE recording_intents
  DROP CONSTRAINT recording_intents_bytes_check,
  DROP CONSTRAINT recording_intents_reserved_ms_check,
  DROP CONSTRAINT recording_intents_consumed_ms_check,
  ADD CONSTRAINT recording_intents_bytes_check CHECK (bytes BETWEEN 1 AND 4194304),
  ADD CONSTRAINT recording_intents_reserved_ms_check CHECK (reserved_ms BETWEEN 0 AND 600000),
  ADD CONSTRAINT recording_intents_consumed_ms_check CHECK (consumed_ms BETWEEN 0 AND 600000);

ALTER TABLE recording_assets
  DROP CONSTRAINT recording_assets_bytes_check,
  DROP CONSTRAINT recording_assets_duration_ms_check,
  ADD CONSTRAINT recording_assets_bytes_check CHECK (bytes BETWEEN 1 AND 4194304),
  ADD CONSTRAINT recording_assets_duration_ms_check CHECK (duration_ms BETWEEN 1 AND 600000);
