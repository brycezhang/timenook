ALTER TABLE production_tasks DROP CONSTRAINT production_task_source_kind;
ALTER TABLE production_tasks ADD CONSTRAINT production_task_source_kind CHECK (
 (kind='transcribe_audio' AND clip_id IS NOT NULL AND asset_id IS NOT NULL AND sealed_input_id IS NOT NULL) OR
 (kind IN ('compose_story','ask_followup','render_book') AND clip_id IS NULL AND asset_id IS NULL AND sealed_input_id IS NULL)
);
CREATE TABLE book_versions (
 id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES projects(id), version INTEGER NOT NULL CHECK(version>0),
 task_id UUID NOT NULL UNIQUE,subject_id UUID NOT NULL,operator_id UUID NOT NULL REFERENCES users(id),
 binding_version INTEGER NOT NULL,access_epoch INTEGER NOT NULL,input_hash CHAR(64) NOT NULL,snapshot_hash CHAR(64) NOT NULL,
 snapshot JSONB NOT NULL,created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(project_id,version),UNIQUE(project_id,id),
 FOREIGN KEY(project_id,task_id) REFERENCES production_tasks(project_id,id),
 FOREIGN KEY(project_id,subject_id) REFERENCES project_subjects(project_id,id)
);
CREATE TABLE book_outputs (
 book_id UUID PRIMARY KEY REFERENCES book_versions(id),object_key TEXT NOT NULL,sha256 CHAR(64) NOT NULL,
 bytes INTEGER NOT NULL CHECK(bytes>0 AND bytes<=33554432),page_count INTEGER NOT NULL CHECK(page_count>0 AND page_count<=128),
 manifest JSONB NOT NULL,inspection JSONB NOT NULL,created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE book_audio_entries (
 id TEXT PRIMARY KEY CHECK(id ~ '^[A-Za-z0-9_-]{22}$'),project_id UUID NOT NULL,story_id UUID NOT NULL,
 revision_id UUID NOT NULL,content_hash CHAR(64) NOT NULL,audio JSONB NOT NULL,
 UNIQUE(project_id,story_id,revision_id),
 FOREIGN KEY(project_id,story_id,revision_id,content_hash) REFERENCES story_revisions(project_id,story_id,id,content_hash)
);
CREATE TABLE book_story_references (
 project_id UUID NOT NULL,book_id UUID NOT NULL,story_id UUID NOT NULL,revision_id UUID NOT NULL,content_hash CHAR(64) NOT NULL,
 PRIMARY KEY(book_id,story_id),FOREIGN KEY(project_id,book_id) REFERENCES book_versions(project_id,id),
 FOREIGN KEY(project_id,story_id,revision_id,content_hash) REFERENCES story_revisions(project_id,story_id,id,content_hash)
);
CREATE TABLE book_commands (
 project_id UUID NOT NULL REFERENCES projects(id),actor_id UUID NOT NULL REFERENCES users(id),action TEXT NOT NULL,key TEXT NOT NULL,
 request_hash CHAR(64) NOT NULL,result_id TEXT NOT NULL,PRIMARY KEY(project_id,actor_id,action,key)
);
CREATE TRIGGER immutable_book_version BEFORE UPDATE ON book_versions FOR EACH ROW EXECUTE FUNCTION immutable_story_content();
CREATE TRIGGER immutable_book_output BEFORE UPDATE ON book_outputs FOR EACH ROW EXECUTE FUNCTION immutable_story_content();
CREATE TRIGGER immutable_book_entry BEFORE UPDATE ON book_audio_entries FOR EACH ROW EXECUTE FUNCTION immutable_story_content();
CREATE TRIGGER immutable_book_reference BEFORE UPDATE ON book_story_references FOR EACH ROW EXECUTE FUNCTION immutable_story_content();
CREATE TABLE book_cover_versions (
 project_id UUID NOT NULL REFERENCES projects(id),version INTEGER NOT NULL CHECK(version>0),
 salutation TEXT NOT NULL CHECK(length(salutation)<=120),photo_asset_id UUID,
 created_by UUID NOT NULL REFERENCES users(id),created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(project_id,version),FOREIGN KEY(project_id,photo_asset_id) REFERENCES photo_assets(project_id,id)
);
CREATE TRIGGER immutable_book_cover BEFORE UPDATE ON book_cover_versions FOR EACH ROW EXECUTE FUNCTION immutable_story_content();
