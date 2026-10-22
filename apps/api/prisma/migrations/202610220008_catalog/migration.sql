CREATE TABLE "recipient_types" (
  "realm" TEXT NOT NULL CHECK ("realm" IN ('local', 'production')),
  "code" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "sort_order" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  PRIMARY KEY ("realm", "code")
);

CREATE TABLE "package_drafts" (
  "id" UUID PRIMARY KEY,
  "realm" TEXT NOT NULL CHECK ("realm" IN ('local', 'production')),
  "title" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "d01" JSONB NOT NULL,
  "admission" JSONB NOT NULL,
  "shipping_region_labels" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "package_versions" (
  "id" UUID PRIMARY KEY,
  "sequence" SERIAL NOT NULL UNIQUE,
  "realm" TEXT NOT NULL CHECK ("realm" = 'local'),
  "purpose" TEXT NOT NULL CHECK ("purpose" = 'local_preview'),
  "draft_id" UUID NOT NULL REFERENCES "package_drafts"("id"),
  "draft_revision" INTEGER NOT NULL CHECK ("draft_revision" > 0),
  "snapshot" JSONB NOT NULL,
  "public_offer" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("realm", "draft_id", "draft_revision")
);
CREATE FUNCTION reject_package_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Package versions are immutable'; END;
$$;
CREATE TRIGGER package_version_immutable BEFORE UPDATE OR DELETE ON "package_versions"
FOR EACH ROW EXECUTE FUNCTION reject_package_version_mutation();
