-- Separate source identity from storage configuration; changing a provider never relabels a clip.
ALTER TABLE "probe_clips" ADD COLUMN "storage_scope" TEXT NOT NULL DEFAULT 'legacy-unscoped';
ALTER TABLE "probe_clips" ALTER COLUMN "storage_scope" DROP DEFAULT;
