ALTER TABLE recording_assets ADD COLUMN storage TEXT NOT NULL CHECK(storage IN ('local-simulator','oss'));
ALTER TABLE recording_assets ADD COLUMN store TEXT NOT NULL;
